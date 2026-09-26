"""
WP-07: desklib-Scores auf die volle Eval-Suite (1200 Texte) auffuellen. evaluate_suite.py
--backend desklib misst immer nur eine frische Stichprobe (--desklib-n); dieses Skript nutzt
die vorhandenen 480 Scores (data/eval_scores_desklib_suite.jsonl, aus der "Breitere Eval-Suite"
WP-01) weiter und bewertet nur die restlichen ~720 Texte neu (Text selbst als Schluessel - die
Suite hat keine eigene ID, Texte sind in dieser Suite de-facto eindeutig).

Schreibt den Fortschritt laufend nach data/eval_scores_desklib_suite.jsonl.part (crash-sicher)
und am Ende die vollstaendigen 1200 Zeilen nach data/eval_scores_desklib_suite.jsonl (gleiche
Reihenfolge wie eval_suite.jsonl).

Nutzung (aus training/):
    .venv/Scripts/python.exe desklib_fill_suite.py --suite data/eval_suite.jsonl
"""
import argparse
import json
import time
from pathlib import Path

import evaluate_backends as eb


def load_jsonl(path):
    return [json.loads(l) for l in open(path, encoding="utf-8")]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--suite", default="data/eval_suite.jsonl")
    ap.add_argument("--scores", default="data/eval_scores_desklib_suite.jsonl")
    ap.add_argument("--batch-log", type=int, default=40, help="alle N Texte Fortschritt melden")
    args = ap.parse_args()

    suite_path = Path(args.suite)
    scores_path = Path(args.scores)
    part_path = scores_path.with_suffix(scores_path.suffix + ".part")

    suite = load_jsonl(suite_path)
    existing = load_jsonl(scores_path) if scores_path.exists() else []
    done_texts = {r["text"] for r in existing}
    print(f"Suite: {len(suite)} Texte, bereits gescort: {len(existing)}")

    missing = [r for r in suite if r["text"] not in done_texts]
    print(f"Fehlend: {len(missing)} Texte -> jetzt bewerten (desklib, CPU)")

    t0 = time.time()
    new_scored = []
    CHUNK = 8  # score_desklib batcht selbst mit 8, aber wir wollen zwischendurch loggen/sichern
    for i in range(0, len(missing), CHUNK):
        chunk = missing[i : i + CHUNK]
        scores = eb.score_desklib([r["text"] for r in chunk])
        for r, s in zip(chunk, scores):
            new_scored.append({**r, "score": s})
        done_n = len(new_scored)
        if done_n % args.batch_log < CHUNK:
            elapsed = time.time() - t0
            rate = elapsed / done_n
            eta_min = rate * (len(missing) - done_n) / 60
            print(f"  {done_n}/{len(missing)}  ({elapsed:.0f}s, ~{rate:.2f}s/Text, ETA {eta_min:.1f} min)", flush=True)
        # laufend sichern
        with part_path.open("w", encoding="utf-8") as f:
            for r in new_scored:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")

    all_scored = existing + new_scored
    by_text = {r["text"]: r for r in all_scored}
    full = [by_text[r["text"]] for r in suite if r["text"] in by_text]
    assert len(full) == len(suite), f"{len(full)} von {len(suite)} - fehlt noch etwas?"

    with scores_path.open("w", encoding="utf-8") as f:
        for r in full:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    part_path.unlink(missing_ok=True)
    print(f"\nFertig: {len(full)} Scores -> {scores_path} ({time.time() - t0:.0f}s fuer die {len(missing)} neuen)")


if __name__ == "__main__":
    main()
