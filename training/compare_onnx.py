"""
WP-09: Vergleicht das fertige Dritt-ONNX von MedAliFarhat/ai-text-detector-onnx (fuer transformers.js
gebaut, Revision gepinnt) mit dem PyTorch-Original fakespot-ai/roberta-base-ai-text-detection-v1 -
auf derselben Eval-Suite (data/eval_suite.jsonl, 1200 Texte, WP-01/WP-06) und mit derselben
Vorverarbeitung, die die Extension tatsaechlich anwendet: `content.js` `clipText` (auf 2000 Zeichen,
Satzende bevorzugt - wie beim TMR-Eintrag in models.js) gefolgt von Tokenizer-Truncation auf 512
Tokens (offscreen.js, `m.maxTokens`).

Wichtig: Die bereits vorhandenen Rohscores unter
data/eval_scores_fakespot-ai_roberta-base-ai-text-detection-v1_suite.jsonl (WP-06) wurden OHNE
clipText erzeugt (evaluate_suite.py/score_hf schneidet nur per Tokenizer auf 512 Tokens, nicht per
Zeichen). 31% der Suite-Texte sind laenger als 2000 Zeichen (siehe unten) - ein direkter Vergleich
dieses Skripts gegen die alten Rohscores wuerde also auch den clipText-Effekt mitmessen, nicht nur
die ONNX-vs-PyTorch-Abweichung. Deshalb rechnet dieses Skript BEIDE Seiten frisch mit identischer
Vorverarbeitung: PyTorch-Referenz hier neu (mit clipText) UND ONNX (mit clipText) - sauberer
Vergleich ONNX vs. PyTorch, isoliert von der Zeichen-Kuerzung.

Nutzung (aus training/, Daten liegen im geteilten Haupt-Checkout):
    .venv/Scripts/python.exe compare_onnx.py --suite C:/_programme/DS/aivsai/training/data/eval_suite.jsonl --out-dir C:/_programme/DS/aivsai/training/data
"""
import argparse
import json
import re
from pathlib import Path

import numpy as np

REVISION = "0c809a8de6e600ec2fd0fcdeb595a5461d93e8dc"  # onnx/model_quantized.onnx, "fuer transformers.js" laut Karte
ONNX_REPO = "MedAliFarhat/ai-text-detector-onnx"
PT_REPO = "fakespot-ai/roberta-base-ai-text-detection-v1"

MAX_CHARS = 2000  # wie TMR in models.js - fakespot bekommt denselben Wert (gleiche Architektur/Groessenklasse)
MAX_TOKENS = 512

# Nachbau von content.js clipText() - Python-Aequivalent des JS-Regex
# `^[\s\S]*[.!?…]["'"'»)\]]?(?=\s)` (greedy -> findet das LETZTE Satzende gefolgt von Whitespace).
SENTENCE_END_RE = re.compile(r"^[\s\S]*[.!?…][\"'\u201d\u2019\u00bb)\]]?(?=\s)")


def clip_text(text, max_chars=MAX_CHARS):
    if len(text) <= max_chars:
        return text
    cut = text[:max_chars]
    min_length = max_chars * 0.6
    m = SENTENCE_END_RE.match(cut)
    if m and len(m.group(0)) >= min_length:
        return m.group(0)
    space = cut.rfind(" ")
    return cut[:space] if space >= min_length else cut


def load_jsonl(path):
    return [json.loads(l) for l in open(path, encoding="utf-8")]


def auroc(labels, scores):
    pairs = sorted(zip(scores, labels))
    n_pos = sum(labels)
    n_neg = len(labels) - n_pos
    if n_pos == 0 or n_neg == 0:
        return float("nan")
    rank_sum = 0.0
    i = 0
    n = len(pairs)
    while i < n:
        j = i
        while j < n and pairs[j][0] == pairs[i][0]:
            j += 1
        avg_rank = (i + 1 + j) / 2.0
        for k in range(i, j):
            if pairs[k][1] == 1:
                rank_sum += avg_rank
        i = j
    return (rank_sum - n_pos * (n_pos + 1) / 2.0) / (n_pos * n_neg)


def score_onnx(texts, batch_size=16):
    """Wie offscreen.js: Tokenizer + onnxruntime, id2label-Heuristik (ai|machine|generated), Softmax."""
    import onnxruntime as ort
    from huggingface_hub import hf_hub_download
    from transformers import AutoConfig, AutoTokenizer

    tok = AutoTokenizer.from_pretrained(ONNX_REPO, revision=REVISION)
    config = AutoConfig.from_pretrained(ONNX_REPO, revision=REVISION)
    print(f"[onnx] id2label = {config.id2label}")
    ai_index = next((int(k) for k, v in config.id2label.items() if re.match(r"^(ai|machine|generated)$", str(v), re.I)), 1)
    print(f"[onnx] genutzter AI-Index = {ai_index}")

    onnx_path = hf_hub_download(ONNX_REPO, "onnx/model_quantized.onnx", revision=REVISION)
    sess = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])

    scores = []
    for i in range(0, len(texts), batch_size):
        batch = texts[i : i + batch_size]
        enc = tok(batch, return_tensors="np", truncation=True, padding=True, max_length=MAX_TOKENS)
        feed = {"input_ids": enc["input_ids"].astype(np.int64), "attention_mask": enc["attention_mask"].astype(np.int64)}
        (logits,) = sess.run(["logits"], feed)
        # Softmax wie toScores() in offscreen.js (classes > 1)
        m = logits.max(axis=1, keepdims=True)
        exp = np.exp(logits - m)
        probs = exp / exp.sum(axis=1, keepdims=True)
        scores.extend(probs[:, ai_index].tolist())
    return scores


def score_pytorch_ref(texts, batch_size=16):
    """PyTorch-Original, dieselbe Vorverarbeitung (clipText + 512-Token-Truncation) wie score_onnx -
    fuer einen sauberen ONNX-vs-PyTorch-Vergleich (isoliert vom clipText-Effekt)."""
    import torch
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    tok = AutoTokenizer.from_pretrained(PT_REPO)
    model = AutoModelForSequenceClassification.from_pretrained(PT_REPO)
    model.eval()
    print(f"[pytorch] id2label = {model.config.id2label}")
    ai_index = next((int(k) for k, v in model.config.id2label.items() if re.match(r"^(ai|machine|generated)$", str(v), re.I)), 1)
    print(f"[pytorch] genutzter AI-Index = {ai_index}")

    scores = []
    with torch.no_grad():
        for i in range(0, len(texts), batch_size):
            batch = texts[i : i + batch_size]
            enc = tok(batch, return_tensors="pt", truncation=True, padding=True, max_length=MAX_TOKENS)
            logits = model(**enc).logits
            probs = torch.softmax(logits, dim=-1)
            scores.extend(probs[:, ai_index].tolist())
    return scores


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


RELIABLE_WORDS = 120


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--suite", default="data/eval_suite.jsonl")
    ap.add_argument("--out-dir", default="data")
    ap.add_argument("--candidate-thresholds", nargs="*", type=float, default=[0.999, 0.9994, 0.9988, 0.9966])
    args = ap.parse_args()

    rows = load_jsonl(args.suite)
    print(f"Eval-Suite: {len(rows)} Texte aus {args.suite}")

    clipped = [clip_text(r["text"]) for r in rows]
    n_clipped = sum(1 for r, c in zip(rows, clipped) if len(c) < len(r["text"]))
    print(f"clipText (max {MAX_CHARS} Zeichen) kuerzt {n_clipped}/{len(rows)} Texte ({n_clipped/len(rows)*100:.1f}%)")

    print("\n== ONNX (MedAliFarhat/ai-text-detector-onnx, onnxruntime) ==")
    onnx_scores = score_onnx(clipped)

    print("\n== PyTorch-Referenz (fakespot-ai/roberta-base-ai-text-detection-v1), gleiche Vorverarbeitung ==")
    pt_scores = score_pytorch_ref(clipped)

    labels = [r["label"] for r in rows]

    out_dir = Path(args.out_dir)
    out_path = out_dir / "eval_scores_fakespot-ai_onnx_clipped_suite.jsonl"
    with out_path.open("w", encoding="utf-8") as f:
        for r, onnx_s, pt_s in zip(rows, onnx_scores, pt_scores):
            f.write(json.dumps({**{k: r[k] for k in ("domain", "generator", "label", "words")}, "score": onnx_s, "score_pytorch_clipped": pt_s}, ensure_ascii=False) + "\n")
    print(f"\nRohscores (ONNX + PyTorch-Referenz mit clipText) -> {out_path}")

    print(f"\n{'=' * 70}\nONNX vs. PyTorch (gleiche Vorverarbeitung, n={len(rows)})\n{'=' * 70}")
    diffs = [abs(o - p) for o, p in zip(onnx_scores, pt_scores)]
    print(f"AUROC ONNX:              {auroc(labels, onnx_scores):.4f}")
    print(f"AUROC PyTorch (clipped): {auroc(labels, pt_scores):.4f}")
    corr = np.corrcoef(onnx_scores, pt_scores)[0, 1]
    print(f"Pearson-Korrelation:     {corr:.6f}")
    print(f"Max. Abweichung:         {max(diffs):.6f}")
    print(f"Mittlere Abweichung:     {sum(diffs)/len(diffs):.6f}")
    print(f"Median Abweichung:       {percentile(diffs, 0.5):.6f}")
    print(f"Abweichung > 0.01:       {sum(1 for d in diffs if d > 0.01)} Texte ({sum(1 for d in diffs if d > 0.01)/len(diffs)*100:.2f}%)")
    print(f"Abweichung > 0.05:       {sum(1 for d in diffs if d > 0.05)} Texte")

    # Vergleich zu den alten Rohscores (WP-06, ohne clipText) - zeigt den clipText-Effekt separat
    old_path = out_dir / "eval_scores_fakespot-ai_roberta-base-ai-text-detection-v1_suite.jsonl"
    if old_path.exists():
        old_rows = load_jsonl(old_path)
        old_scores = [r["score"] for r in old_rows]
        diffs_clip = [abs(p - o) for p, o in zip(pt_scores, old_scores)]
        print(f"\nZum Vergleich: clipText-Effekt allein (PyTorch mit vs. ohne clipText, gleiches Modell):")
        print(f"  Mittlere Abweichung: {sum(diffs_clip)/len(diffs_clip):.6f}  Max: {max(diffs_clip):.6f}")

    # Ampel wie angezeigt: ändert sich das Bild an Kandidaten-Schwellen?
    print(f"\n{'=' * 70}\nAmpel-Vergleich an Kandidaten-Schwellen (>=120 Woerter, reliableWords={RELIABLE_WORDS})\n{'=' * 70}")
    scored_rows = [{**r, "onnx": o, "pt": p} for r, o, p in zip(rows, onnx_scores, pt_scores)]
    long_rows = [r for r in scored_rows if r["words"] >= RELIABLE_WORDS]

    for red in args.candidate_thresholds:
        def rate(rows_, key, red_t):
            human = [r for r in rows_ if r["label"] == 0]
            ai = [r for r in rows_ if r["label"] == 1]
            fa = share([r[key] for r in human], red_t)
            det = share([r[key] for r in ai], red_t)
            return fa, det

        fa_onnx_long, det_onnx_long = rate(long_rows, "onnx", red)
        fa_pt_long, det_pt_long = rate(long_rows, "pt", red)
        print(
            f"redFrom={red:.4f}  >=120W  ONNX: FA={fa_onnx_long:.3f} erkannt={det_onnx_long:.3f}  |  "
            f"PyTorch: FA={fa_pt_long:.3f} erkannt={det_pt_long:.3f}  |  "
            f"Delta FA={abs(fa_onnx_long-fa_pt_long):.3f} Delta erkannt={abs(det_onnx_long-det_pt_long):.3f}"
        )


if __name__ == "__main__":
    main()
