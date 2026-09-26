"""
WP-07: Kreuzvalidierung der Ampel-Schwellen (redFrom, shortRedFrom) auf der breiten Eval-Suite
(data/eval_suite.jsonl + die Rohscores aus evaluate_suite.py/desklib_fill_suite.py).

Methode (ENTSCHEIDUNG, siehe orchestration/LOG.md): wiederholte zufaellige Haelfte/Haelfte-Splits,
stratifiziert nach (domain, label), damit jede Haelfte dieselbe Domain-/Klassenmischung hat wie die
Gesamtsuite - dieselbe Methode wie schon EVAL_RESULTS.md "Konfidenz fuer kurze Absaetze" (200x
Wikipedia-Haelften). Pro Wiederholung:
  1. Haelfte A: Schwelle so waehlen, dass ~1% der MENSCH-Scores "wie angezeigt" (Regel 9 im
     orchestration/README.md - config.js level(): unter reliableWords zaehlt shortRedFrom statt
     redFrom, ohne shortRedFrom bleibt es "unsicher") darueberliegen (99. Perzentil).
  2. Haelfte B (ungesehen): mit dieser Schwelle tatsaechliche Fehlalarm-/Erkennungsrate messen.
Getrennt fuer die "lange" Gruppe (>= reliableWords, regelt redFrom) und die "kurze" Gruppe
(< reliableWords, regelt shortRedFrom, nur wenn das Modell eins hat).

Zusaetzlich: dieselben 200 Test-Haelften auch mit den AKTUELLEN Werten aus models.js ausgewertet,
um eine Fehlerspanne (5.-95. Perzentil) der heutigen Zahlen zu bekommen (Aufgabe: "Konfidenzintervall
der aktuellen Werte").

Nutzung (aus training/):
    .venv/Scripts/python.exe crossval_thresholds.py --backend tmr
    .venv/Scripts/python.exe crossval_thresholds.py --backend desklib
    .venv/Scripts/python.exe crossval_thresholds.py --backend both --reps 200
"""
import argparse
import json
import random
import statistics
from collections import defaultdict
from pathlib import Path

RELIABLE_WORDS = 120
TARGET_FA = 0.01

# Aktuelle Ampel-Startwerte aus extension/models.js (nur gelesen) - wie in evaluate_suite.py
CURRENT = {
    "tmr": {"redFrom": 0.98, "shortRedFrom": None},
    "desklib": {"redFrom": 0.87, "shortRedFrom": 0.98},
}


def load_jsonl(path):
    return [json.loads(l) for l in open(path, encoding="utf-8")]


def percentile(values, p):
    if not values:
        return float("nan")
    s = sorted(values)
    idx = p * (len(s) - 1)
    lo, hi = int(idx), min(int(idx) + 1, len(s) - 1)
    frac = idx - lo
    return s[lo] * (1 - frac) + s[hi] * frac


def share(scores, thresh):
    return sum(s >= thresh for s in scores) / len(scores) if scores else float("nan")


def stratified_half_split(rows, rnd):
    """Zwei etwa gleich grosse Haelften, je (domain,label) moeglichst gleich aufgeteilt."""
    by_key = defaultdict(list)
    for r in rows:
        by_key[(r["domain"], r["label"])].append(r)
    a, b = [], []
    for key, items in by_key.items():
        items = items[:]
        rnd.shuffle(items)
        half = len(items) // 2
        a.extend(items[:half])
        b.extend(items[half:])
    return a, b


def select_threshold(train_human_scores, target_fa=TARGET_FA):
    return percentile(train_human_scores, 1 - target_fa)


def crossval(rows, reps, seed, bucket_name, in_bucket):
    """rows: alle Zeilen des Backends (mit 'score'). in_bucket(r)->bool waehlt die Wort-Gruppe.
    Gibt Liste von dicts je Wiederholung zurueck: gewaehlte Schwelle, FA/Erkennung auf Haelfte B."""
    sub = [r for r in rows if in_bucket(r)]
    n_human = sum(1 for r in sub if r["label"] == 0)
    n_ai = sum(1 for r in sub if r["label"] == 1)
    print(f"  Bucket {bucket_name}: n={len(sub)} (human={n_human}, KI={n_ai})")
    if n_human < 10 or n_ai < 10:
        print(f"    -> zu wenig Daten fuer Kreuzvalidierung, uebersprungen")
        return []
    rnd = random.Random(seed)
    out = []
    for i in range(reps):
        a, b = stratified_half_split(sub, rnd)
        a_human = [r["score"] for r in a if r["label"] == 0]
        b_human = [r["score"] for r in b if r["label"] == 0]
        b_ai = [r["score"] for r in b if r["label"] == 1]
        if len(a_human) < 5 or len(b_human) < 5 or len(b_ai) < 5:
            continue
        t = select_threshold(a_human)
        out.append({
            "threshold": t,
            "fa_test": share(b_human, t),
            "det_test": share(b_ai, t),
        })
    return out


def current_on_testhalves(rows, reps, seed, bucket_name, in_bucket, current_t):
    """Dieselbe Art Splits, aber statt einer gewaehlten Schwelle die heutige feste Schwelle -
    liefert die Verteilung der FA-/Erkennungsrate auf (unabhaengigen) Test-Haelften -> CI."""
    if current_t is None:
        return []
    sub = [r for r in rows if in_bucket(r)]
    if sum(1 for r in sub if r["label"] == 0) < 10:
        return []
    rnd = random.Random(seed + 1)  # andere Ziehung als crossval(), aber gleiche Methode
    out = []
    for i in range(reps):
        a, b = stratified_half_split(sub, rnd)
        b_human = [r["score"] for r in b if r["label"] == 0]
        b_ai = [r["score"] for r in b if r["label"] == 1]
        if len(b_human) < 5 or len(b_ai) < 5:
            continue
        out.append({"fa_test": share(b_human, current_t), "det_test": share(b_ai, current_t)})
    return out


def summarize(vals, key):
    xs = sorted(v[key] for v in vals if v[key] == v[key])  # NaN raus
    if not xs:
        return None
    return {
        "median": statistics.median(xs),
        "p5": percentile(xs, 0.05),
        "p95": percentile(xs, 0.95),
        "min": xs[0],
        "max": xs[-1],
        "n": len(xs),
    }


def fmt(s):
    if s is None:
        return "n/a"
    return f"median {s['median']:.4f} (5-95%: {s['p5']:.4f}-{s['p95']:.4f}, n={s['n']})"


def run_backend(backend, scores_path, reps, seed):
    rows = load_jsonl(scores_path)
    print(f"\n{'=' * 70}\n{backend.upper()}  (n={len(rows)})  {reps}x stratifizierte Haelfte/Haelfte-Splits\n{'=' * 70}")

    buckets = [
        ("lang (>=120 Woerter, regelt redFrom)", lambda r: r["words"] >= RELIABLE_WORDS),
        ("kurz (<120 Woerter, regelt shortRedFrom)", lambda r: r["words"] < RELIABLE_WORDS),
    ]
    cur = CURRENT[backend]
    current_vals = [cur["redFrom"], cur["shortRedFrom"]]

    results = {}
    for (label, pred), cur_t in zip(buckets, current_vals):
        print(f"\n-- {label} --")
        cv = crossval(rows, reps, seed, label, pred)
        if not cv:
            results[label] = None
            continue
        t_summary = summarize(cv, "threshold")
        fa_summary = summarize(cv, "fa_test")
        det_summary = summarize(cv, "det_test")
        print(f"  Kreuzvalidierte Schwelle (Ziel {TARGET_FA*100:.0f}% FA auf Trainhaelfte): {fmt(t_summary)}")
        print(f"  -> Fehlalarme auf (ungesehener) Testhaelfte:                            {fmt(fa_summary)}")
        print(f"  -> KI erkannt auf Testhaelfte:                                          {fmt(det_summary)}")

        if cur_t is not None:
            cv_cur = current_on_testhalves(rows, reps, seed, label, pred, cur_t)
            fa_cur = summarize(cv_cur, "fa_test")
            det_cur = summarize(cv_cur, "det_test")
            print(f"  Aktuelle Schwelle {cur_t}: Fehlalarme auf Testhaelften (CI):                {fmt(fa_cur)}")
            print(f"  Aktuelle Schwelle {cur_t}: KI erkannt auf Testhaelften (CI):                {fmt(det_cur)}")
        else:
            fa_cur = det_cur = None
            print(f"  (kein aktueller Wert fuer diesen Bucket - z.B. TMR ohne shortRedFrom)")

        results[label] = {
            "threshold": t_summary, "fa_test": fa_summary, "det_test": det_summary,
            "current_fa": fa_cur, "current_det": det_cur, "current_t": cur_t,
        }
    return results


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--backend", choices=["tmr", "desklib", "both"], default="both")
    ap.add_argument("--reps", type=int, default=200)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--data-dir", default="data")
    args = ap.parse_args()

    data_dir = Path(args.data_dir)
    backends = ["tmr", "desklib"] if args.backend == "both" else [args.backend]
    for b in backends:
        path = data_dir / f"eval_scores_{b}_suite.jsonl"
        run_backend(b, path, args.reps, args.seed)


if __name__ == "__main__":
    main()
