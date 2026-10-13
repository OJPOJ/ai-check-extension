"""
Work package 6 of issue #46: the tables for EVAL_RESULTS.md from the browser measurement
(`npm run measure:latency` -> data/latency/results.json) and the list of exported graphs
(export_candidates.py -> data/latency/manifest.json).

Usage (from training/):
    .venv/Scripts/python.exe model/latency_report.py                  # 8-bit graphs
    .venv/Scripts/python.exe model/latency_report.py --precision fp32
"""

import argparse
import json
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data" / "latency"

# Share of paragraphs that leave at the first, second and last exit. The real shares come out of
# calibration (work package 8); these only show what an exit is worth. The middle one follows the
# indication in MODEL_CONCEPT.md (about half of the human texts never reach the expensive model).
SCENARIOS = {"nothing leaves early": (0.0, 0.0, 1.0), "50/20/30": (0.5, 0.2, 0.3), "70/15/15": (0.7, 0.15, 0.15)}


def cumulative(stage_ms):
    """Time until each exit has its score: the stages up to it."""
    total, out = 0.0, []
    for ms in stage_ms:
        total += ms
        out.append(total)
    return out


def expected(stage_ms, shares):
    """Mean time per paragraph when `shares[i]` of the paragraphs stop after stage i."""
    if len(shares) != len(stage_ms) or abs(sum(shares) - 1) > 1e-9:
        raise ValueError(f"need one share per stage, summing to 1: {shares}")
    return sum(share * until for share, until in zip(shares, cumulative(stage_ms)))


def spread(shares, stages):
    """Shares given for three exits, for a model with fewer: what would leave at a missing exit leaves at the last."""
    if stages >= len(shares):
        return shares
    return (*shares[: stages - 1], sum(shares[stages - 1:]))


def table(header, rows):
    lines = ["| " + " | ".join(header) + " |", "|" + "---|" * len(header)]
    return "\n".join(lines + ["| " + " | ".join(str(c) for c in row) + " |" for row in rows])


def ms(value):
    return "–" if value is None else f"{value:.0f}"


def mb(size):
    return f"{size / 1e6:.0f} MB"


def chain(results, name, precision, which):
    entry = results["candidates"].get(name, {}).get(precision, {}).get(which)
    return entry if entry and "error" not in entry else None


def total(entry, length):
    return sum(s["ms"] for s in entry["lengths"][str(length)]) if entry else None


def stage_ms(entry, length):
    return [s["ms"] for s in entry["lengths"][str(length)]] if entry else None


def until_exits(stages):
    return "–" if stages is None else " / ".join(ms(c) for c in cumulative(stages))


def label(name, spec):
    return f"{name} (anchor: {spec['anchor']})" if "anchor" in spec else name


def report(manifest, results, precision):
    env = results["environment"]
    lengths = env["lengths"]
    specs = manifest["candidates"]
    measured = [n for n in results["candidates"] if n in specs]
    out = [
        f"Measured {env['date']}: {env['browser']}, onnxruntime-web {env['onnxruntimeWeb']} ({', '.join(env['wasm'])}), "
        f"backend {env['backend']}, {env.get('threads', '?')} threads, {env['cpu']} ({env['logicalCores']} logical cores). "
        f"One text per call, median of 7 to 25 runs after 2 warm-up runs, the fastest of {env.get('passes', 1)} passes "
        f"(each in a new page), weights {precision}.",
        "",
        table(
            ["Candidate", "Repository", "Layers × width", "Parameters (of which embeddings)", "fp32", "q8", "Licence", "Multilingual"],
            [
                [
                    label(n, s), f"`{s['repo']}`", f"{s['layers']} × {s['hidden']}",
                    f"{s['parameters'] / 1e6:.0f} M ({s['embedding_parameters'] / 1e6:.0f} M)",
                    mb(s["graphs"]["full"]["files"]["fp32"]["bytes"]), mb(s["graphs"]["full"]["files"]["q8"]["bytes"]),
                    s["licence"], f"`{s['sibling']}`" if s["sibling"] else "–" if "anchor" in s else "itself",
                ]
                for n, s in specs.items()
            ],
        ),
        "",
        "Whole model, ms per paragraph by number of tokens:",
        "",
        table(
            ["Candidate", *[str(n) for n in lengths]],
            [[label(n, specs.get(n, results_spec(n))), *[ms(total(chain(results, n, precision, "full"), length)) for length in lengths]]
             for n in results["candidates"]],
        ),
    ]

    staged = [n for n in measured if chain(results, n, precision, "stages")]
    if staged:
        long, mid = lengths[-1], lengths[len(lengths) // 2]
        out += [
            "",
            f"Token reduction (2:1 after the first exit), whole model, ms at {mid} and {long} tokens:",
            "",
            table(
                ["Candidate", "Reduced after layer", f"{mid}: without", f"{mid}: with", f"{long}: without", f"{long}: with", f"Saved at {long}"],
                [
                    [
                        n, specs[n]["reduce_after"],
                        *[ms(total(chain(results, n, precision, c), length)) for length in (mid, long) for c in ("full", "full-tr")],
                        saved(total(chain(results, n, precision, "full"), long), total(chain(results, n, precision, "full-tr"), long)),
                    ]
                    for n in staged
                ],
            ),
        ]
        for length in (mid, long):
            rows = []
            for n in staged:
                plain = stage_ms(chain(results, n, precision, "stages"), length)
                reduced = stage_ms(chain(results, n, precision, "stages-tr"), length)  # None if that chain failed
                whole = total(chain(results, n, precision, "full"), length)
                rows.append([
                    n, "/".join(str(e) for e in specs[n]["exits"]), until_exits(plain), ms(whole), until_exits(reduced),
                    *[ms(reduced and expected(reduced, spread(shares, len(reduced)))) for shares in SCENARIOS.values()],
                ])
            out += [
                "",
                f"Early exit at {length} tokens: ms until each exit has its score (stages added up), and the mean per paragraph "
                "with token reduction when a share of the paragraphs leaves at the first/second/last exit:",
                "",
                table(
                    ["Candidate", "Exits after layer", "Until exit, without reduction", "One graph", "Until exit, with reduction",
                     *[f"Mean, {name}" for name in SCENARIOS]],
                    rows,
                ),
            ]
    failed = [(n, p, c, e["error"]) for n, per in results["candidates"].items() for p, chains in per.items()
              for c, e in chains.items() if "error" in e]
    if failed:
        out += ["", "Not measured:", ""] + [f"- {n}, {p}, {c}: {e}" for n, p, c, e in failed]
    return "\n".join(out)


def results_spec(name):
    """Entries the measurement adds itself (the real TMR file) have no line in the manifest."""
    return {"anchor": "TMR as the extension runs it, real weights"} if name == "tmr-real" else {}


def saved(without, with_):
    return "–" if not without or with_ is None else f"{(1 - with_ / without) * 100:.0f}%"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--precision", default="q8", choices=["q8", "fp32"])
    ap.add_argument("--data", type=Path, default=DATA)
    args = ap.parse_args()
    manifest = json.loads((args.data / "manifest.json").read_text())
    results = json.loads((args.data / "results.json").read_text())
    print(report(manifest, results, args.precision))


if __name__ == "__main__":
    main()
