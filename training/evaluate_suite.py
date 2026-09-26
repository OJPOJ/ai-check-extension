"""
Wertet die breitere Eval-Suite (build_eval_suite.py, training/data/eval_suite.jsonl) für TMR und
desklib aus: AUROC gesamt/je Domäne/je Generator/je Längen-Bucket, Fehlalarmrate an den aktuellen
Schwellen (extension/models.js - nur gelesen, nicht verändert) und eine Schwellen-Empfehlung für
~1% Fehlalarme. Ergänzt training/EVAL_RESULTS.md nicht automatisch (Zahlen von Hand übernommen,
wie bei den bisherigen Läufen in diesem Ordner) - druckt stattdessen alle Tabellen auf stdout und
schreibt Rohscores nach data/eval_scores_<backend>_suite.jsonl.

desklib ist langsam (CPU, ~2-3 s/Text) - standardmäßig nur eine Stichprobe (--desklib-n, Default
400, stratifiziert über Domäne x Mensch/KI). TMR läuft immer auf der vollen Suite.

WP-06: `--backend hf:<repo>` wertet ein beliebiges HF-Sequenzklassifikations-Repo (Kandidat
zwischen TMR und desklib) genauso aus - AUROC, wie angezeigt (reliableWords/shortRedFrom), Perzentil-
Schwellen. Da es dafür keine "aktuelle" Produktions-Schwelle gibt, wird die 99%-Perzentil-Schwelle
(getrennt nach < 120 / >= 120 Wörtern) automatisch als redFrom/shortRedFrom fuer die "wie angezeigt"-
Sektion verwendet - macht die Sektionen unten vergleichbar, ist aber aus denselben Daten abgeleitet
(kein Train/Test-Split, siehe EVAL_RESULTS.md "Korrektur"-Hinweis zur Stichproben-Unsicherheit).
--candidate-n begrenzt die Stichprobe fuer hf:-Kandidaten (Default: volle Suite, stratifiziert wenn
kleiner).

Nutzung (aus diesem Ordner):
    python evaluate_suite.py --backend tmr
    python evaluate_suite.py --backend desklib --desklib-n 400
    python evaluate_suite.py --backend both --desklib-n 400
    python evaluate_suite.py --backend hf:fakespot-ai/roberta-base-ai-text-detection-v1
"""
import argparse
import json
import random
from collections import defaultdict
from pathlib import Path

import evaluate_backends as eb

SUITE_PATH = Path("data/eval_suite.jsonl")  # per --suite überschreibbar (Worktree hat data/ nicht verlinkt)

# Aktuelle Ampel-Startwerte, nur gelesen aus extension/models.js (Stand siehe dortigen Kommentaren) -
# dieses Skript ändert die Extension nicht, sondern misst nur gegen diese Werte.
CURRENT = {
    "tmr": {"yellowFrom": 0.95, "redFrom": 0.98, "reliableWords": 120, "shortRedFrom": None},
    "desklib": {"yellowFrom": 0.5, "redFrom": 0.87, "reliableWords": 120, "shortRedFrom": 0.98},
}

BUCKETS = [(40, 79), (80, 119), (120, 149), (150, 10_000)]


def bucket_of(words):
    return next((b for b in BUCKETS if b[0] <= words <= b[1]), None)


def bucket_label(b):
    lo, hi = b
    return f"{lo}-{hi}" if hi < 10_000 else f"{lo}+"


def load_suite(path):
    return [json.loads(l) for l in open(path, encoding="utf-8")]


def stratified_subsample(rows, n, seed):
    """n Texte, gleichmäßig über (domain, label) verteilt (Mensch/KI je Domäne gleich stark)."""
    by_key = defaultdict(list)
    for r in rows:
        by_key[(r["domain"], r["label"])].append(r)
    rnd = random.Random(seed)
    for v in by_key.values():
        rnd.shuffle(v)
    keys = sorted(by_key)
    per_key = max(1, n // len(keys))
    out = []
    for k in keys:
        out.extend(by_key[k][:per_key])
    rnd.shuffle(out)
    return out[:n]


def score_rows(rows, backend):
    texts = [r["text"] for r in rows]
    if backend == "tmr":
        scores = eb.score_tmr(texts)
    elif backend == "desklib":
        scores = eb.score_desklib(texts)
    elif backend.startswith("hf:"):
        scores = eb.score_hf(texts, backend[len("hf:") :])
    else:
        raise ValueError(f"unbekanntes Backend: {backend}")
    return [{**r, "score": s} for r, s in zip(rows, scores)]


def share(scores, thresh):
    # thresh=None (z.B. yellowFrom bei WP-06-Kandidaten ohne Produktions-Schwelle) -> nicht auswertbar
    if not scores or thresh is None:
        return float("nan")
    return sum(s >= thresh for s in scores) / len(scores)


def percentile(values, p):
    """p in [0,1]. Einfache lineare Interpolation, keine Zusatz-Abhängigkeit (numpy wäre ok, aber
    unnötig für diese Größenordnung)."""
    if not values:
        return float("nan")
    s = sorted(values)
    idx = p * (len(s) - 1)
    lo, hi = int(idx), min(int(idx) + 1, len(s) - 1)
    frac = idx - lo
    return s[lo] * (1 - frac) + s[hi] * frac


def report(backend, scored, out_dir: Path):
    labels = [r["label"] for r in scored]
    scores = [r["score"] for r in scored]
    a = eb.auroc(labels, scores)
    n_human = sum(1 for l in labels if l == 0)
    n_ai = sum(1 for l in labels if l == 1)
    print(f"\n{'=' * 70}\n{backend.upper()}  (n={len(scored)}, human={n_human}, KI={n_ai})\n{'=' * 70}")
    print(f"AUROC gesamt: {a:.4f}")

    human_scores = [r["score"] for r in scored if r["label"] == 0]
    ai_scores = [r["score"] for r in scored if r["label"] == 1]

    if backend in CURRENT:
        cur = CURRENT[backend]
    else:
        # WP-06-Kandidat ohne Produktions-Schwelle: 99%-Perzentil der Mensch-Scores (getrennt nach
        # reliableWords=120) als redFrom/shortRedFrom benutzen, damit die Sektionen unten (wie
        # angezeigt, je Domäne/Generator/Bucket) trotzdem gegen eine realistische ~1%-FA-Schwelle
        # rechnen statt gegen einen willkuerlichen Default. Aus denselben Daten abgeleitet wie die
        # Perzentil-Empfehlung weiter unten - keine unabhaengige Bestaetigung, siehe Docstring.
        reliable_words = 120
        long_h = [r["score"] for r in scored if r["label"] == 0 and r["words"] >= reliable_words]
        short_h = [r["score"] for r in scored if r["label"] == 0 and r["words"] < reliable_words]
        cur = {
            "yellowFrom": None,
            "redFrom": percentile(long_h, 0.99) if long_h else percentile(human_scores, 0.99),
            "reliableWords": reliable_words,
            "shortRedFrom": percentile(short_h, 0.99) if short_h else None,
        }
        print(
            f"(Kein Produktions-Wert fuer {backend} - genutzte Schwellen aus 99%-Perzentil dieser "
            f"Messung: redFrom={cur['redFrom']:.4f} shortRedFrom={cur['shortRedFrom']})"
        )

    fa_yellow = share(human_scores, cur["yellowFrom"])
    fa_red = share(human_scores, cur["redFrom"])
    det_red = share(ai_scores, cur["redFrom"])
    print(
        f"Aktuelle Schwellen yellowFrom={cur['yellowFrom']} redFrom={cur['redFrom']}: "
        f"Fehlalarme (Mensch) >=yellow {fa_yellow:.3f}, >=red {fa_red:.3f}; KI erkannt >=red {det_red:.3f}"
    )

    # Rot wie in der Extension (config.js, levelOf): unter reliableWords erst ab shortRedFrom, ohne
    # shortRedFrom nie rot ("unsicher"). Das ist die Fehlalarmrate, die Nutzer tatsächlich sehen.
    def shown_red(r):
        if r["words"] >= cur["reliableWords"]:
            return r["score"] >= cur["redFrom"]
        return cur["shortRedFrom"] is not None and r["score"] >= cur["shortRedFrom"]

    def rate(rs):
        return sum(map(shown_red, rs)) / len(rs) if rs else float("nan")

    print(
        f"Wie angezeigt (kurze Absätze nach shortRedFrom): Fehlalarme rot "
        f"{rate([r for r in scored if r['label'] == 0]):.3f}; KI rot {rate([r for r in scored if r['label'] == 1]):.3f}"
    )

    print("\nAUROC je Domäne:")
    by_domain = defaultdict(list)
    for r in scored:
        by_domain[r["domain"]].append(r)
    for dom in sorted(by_domain):
        rs = by_domain[dom]
        a_d = eb.auroc([r["label"] for r in rs], [r["score"] for r in rs])
        fa_d = share([r["score"] for r in rs if r["label"] == 0], cur["redFrom"])
        det_d = share([r["score"] for r in rs if r["label"] == 1], cur["redFrom"])
        fa_shown = rate([r for r in rs if r["label"] == 0])
        det_shown = rate([r for r in rs if r["label"] == 1])
        print(
            f"  {dom:14} n={len(rs):4d}  AUROC={a_d:.3f}  FA@red={fa_d:.3f}  erkannt@red={det_d:.3f}  "
            f"wie angezeigt: FA={fa_shown:.3f} erkannt={det_shown:.3f}"
        )

    print("\nErkennung je Generator (Anteil >= redFrom, nur KI-Zeilen):")
    by_gen = defaultdict(list)
    for r in scored:
        if r["label"] == 1:
            by_gen[r["generator"]].append(r["score"])
    for gen in sorted(by_gen):
        print(f"  {gen:16} n={len(by_gen[gen]):4d}  erkannt@red={share(by_gen[gen], cur['redFrom']):.3f}  mean={sum(by_gen[gen]) / len(by_gen[gen]):.3f}")

    print("\nFehlalarme je Längen-Bucket (nur Mensch-Zeilen):")
    by_bucket_human = defaultdict(list)
    by_bucket_ai = defaultdict(list)
    for r in scored:
        b = bucket_of(r["words"])
        if b is None:
            continue
        (by_bucket_human if r["label"] == 0 else by_bucket_ai)[b].append(r["score"])
    for b in BUCKETS:
        hs = by_bucket_human.get(b, [])
        ais = by_bucket_ai.get(b, [])
        if not hs and not ais:
            continue
        print(
            f"  {bucket_label(b):8} n_human={len(hs):4d} FA@yellow={share(hs, cur['yellowFrom']):.3f} "
            f"FA@red={share(hs, cur['redFrom']):.3f}  n_ki={len(ais):4d} erkannt@red={share(ais, cur['redFrom']):.3f}"
        )

    print("\nSchwellen-Empfehlung für ~1% Fehlalarme auf dieser Suite (Perzentil der Mensch-Scores):")
    t_all = percentile(human_scores, 0.99)
    print(f"  gesamt (alle Längen): Schwelle {t_all:.4f} -> FA {share(human_scores, t_all):.3f}, KI erkannt {share(ai_scores, t_all):.3f}")
    short_human = [r["score"] for r in scored if r["label"] == 0 and r["words"] < cur["reliableWords"]]
    long_human = [r["score"] for r in scored if r["label"] == 0 and r["words"] >= cur["reliableWords"]]
    short_ai = [r["score"] for r in scored if r["label"] == 1 and r["words"] < cur["reliableWords"]]
    long_ai = [r["score"] for r in scored if r["label"] == 1 and r["words"] >= cur["reliableWords"]]
    if short_human:
        t_short = percentile(short_human, 0.99)
        print(f"  < {cur['reliableWords']} Wörter: Schwelle {t_short:.4f} -> FA {share(short_human, t_short):.3f}, KI erkannt {share(short_ai, t_short):.3f}")
    if long_human:
        t_long = percentile(long_human, 0.99)
        print(f"  >= {cur['reliableWords']} Wörter: Schwelle {t_long:.4f} -> FA {share(long_human, t_long):.3f}, KI erkannt {share(long_ai, t_long):.3f}")

    backend_safe = backend.replace("hf:", "").replace("/", "_")
    out_path = out_dir / f"eval_scores_{backend_safe}_suite.jsonl"
    with out_path.open("w", encoding="utf-8") as f:
        for r in scored:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"\nRohscores -> {out_path}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--backend", default="both", help="tmr | desklib | both | hf:<repo> (WP-06-Kandidat)")
    ap.add_argument("--desklib-n", type=int, default=400, help="Stichprobengröße für desklib (langsam)")
    ap.add_argument("--candidate-n", type=int, default=None, help="Stichprobengröße für hf:-Kandidaten (Default: volle Suite)")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--suite", default=str(SUITE_PATH), help="Pfad zu eval_suite.jsonl")
    args = ap.parse_args()
    if args.backend not in ("tmr", "desklib", "both") and not args.backend.startswith("hf:"):
        ap.error("--backend muss tmr, desklib, both oder hf:<repo> sein")

    suite_path = Path(args.suite)
    out_dir = suite_path.parent

    rows = load_suite(suite_path)
    print(f"Eval-Suite: {len(rows)} Texte aus {suite_path}")

    if args.backend in ("tmr", "both"):
        scored = score_rows(rows, "tmr")
        report("tmr", scored, out_dir)

    if args.backend in ("desklib", "both"):
        sub = stratified_subsample(rows, args.desklib_n, args.seed)
        print(f"\ndesklib: Stichprobe {len(sub)}/{len(rows)} (stratifiziert nach Domäne x Mensch/KI)")
        scored = score_rows(sub, "desklib")
        report("desklib", scored, out_dir)

    if args.backend.startswith("hf:"):
        if args.candidate_n and args.candidate_n < len(rows):
            sub = stratified_subsample(rows, args.candidate_n, args.seed)
            print(f"\n{args.backend}: Stichprobe {len(sub)}/{len(rows)} (stratifiziert nach Domäne x Mensch/KI)")
        else:
            sub = rows
        scored = score_rows(sub, args.backend)
        report(args.backend, scored, out_dir)


if __name__ == "__main__":
    main()
