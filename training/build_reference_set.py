"""
Erzeugt das Referenzset für „Modell prüfen“ (extension/bg/reference-set.js): Mensch- und KI-Texte
aus zwei weiterverteilbaren Quellen, kurze (40..119 Wörter) und lange (ab 120 Wörter) Absätze
getrennt gebucketed - damit "Modell prüfen" daraus ggf. eine eigene Kurztext-Schwelle
(reliableWords/shortRedFrom, wie config.js RELIABLE_WORDS/models.js) vorschlagen kann.

Lizenzprüfung (Details: orchestration/LOG.md WP-11, ENTSCHEIDUNG-Einträge; im Zweifel weggelassen):
  - HC3 (Hello-SimpleAI/HC3), CC BY-SA 4.0 - wie bisher, fünf Domänen, Generator ChatGPT (2023).
  - Jinyan1/COLING_2025_MGT_en - die Zusammenstellung selbst hat keine eingetragene Lizenz
    (siehe EVAL_RESULTS.md "Breitere Eval-Suite"), NUR die Teilquelle "wikipedia" wird hier
    verwendet: Herkunft MAGE (yaful/MAGE, Apache-2.0), menschliche Texte darin sind
    Wikipedia-Passagen (SQuAD-Kontext) - mit CC BY-SA kompatibel. Generatoren: die aktuellsten in
    diesem Datensatz für diese Domäne verfügbaren (gpt4, gpt4o, gpt-3.5-turbo, llama3-70b,
    mixtral-8x7b, gemma2-9b-it, cohere).
  Bewusst NICHT verwendet (andere Domänen desselben Datensatzes):
  - reviews (Yelp/IMDb): Yelp Open Dataset ausdrücklich nur akademisch, keine Weiterverteilung an
    Dritte; IMDb-Datensatz ohne klare Weiterverteilungs-Lizenz.
  - news (XSum/CNN/TLDR/DialogSum): Presseartikel-Text (BBC/CNN), XSum-Lizenz auf Hugging Face
    "unknown"; der Apache-2.0-Tag am CNN/DailyMail-Ladeskript deckt nicht den Copyright-Status
    der eigentlichen Nachrichtentexte ab.
  - sci_abstract (arXiv/PeerRead/SciGen/PubMed): Lizenz je Paper bzw. Verlag, arXivs Standard-
    Lizenz erlaubt nur arXiv selbst die Weiterverteilung; nicht im großen Stil prüfbar.
  - howto (WikiHow): Inhalte von wikihow.com stehen unter CC BY-NC-SA 3.0 - NonCommercial passt
    nicht zu einem weiterverteilten Datenset.
  - forum-Anteile außerhalb HC3 (reddit, cmv, eli5): uneinheitliche/ungeklärte Herkunft
    (u.a. Pushshift.io, dessen rechtlicher Status selbst umstritten ist); anders als bei HC3 keine
    vom Autor:innen-Team explizit gewählte Weiterverteilungs-Lizenz gefunden.

Extraktion wie build_eval_suite.py (extract_excerpt, von dort importiert statt dupliziert):
Whitespace/Tokenisierungs-Artefakte normalisiert ("Leerzeichen vor Satzzeichen", u.a. aus
reddit_eli5-Anteilen bekannt), an einer Satzgrenze auf 40..400 Wörter gekürzt. Buckets nach
natürlicher Länge des Ergebnisses (kein künstliches Kürzen auf eine Ziellänge). Bei HC3 bleibt das
Prinzip aus der bisherigen Fassung erhalten: menschliche und KI-Antwort je aus derselben Frage
(gleiches Thema - das Modell muss am Stil unterscheiden, nicht am Inhalt), und beide in derselben
Längenklasse (sonst wäre die Textlänge selbst ein Hinweis auf das Label).

Nutzung (aus diesem Ordner):
    .venv/Scripts/python.exe build_reference_set.py
    .venv/Scripts/python.exe build_reference_set.py --check tmr desklib   # AUROC der Modelle auf dem neuen Set
"""

import argparse
import json
import random
from pathlib import Path

from build_eval_suite import extract_excerpt
from evaluate_length import auroc

OUT = Path(__file__).resolve().parent.parent / "extension" / "bg" / "reference-set.js"

RELIABLE_WORDS = 120  # wie extension/models.js reliableWords / config.js RELIABLE_WORDS

HC3_DOMAINS = ["reddit_eli5", "finance", "medicine", "open_qa", "wiki_csai"]
HC3_PAIRS = {"short": 4, "long": 4}  # Frage-Paare (Mensch+KI) je Domäne und Längenklasse

WIKI_GENERATORS = ["gpt4", "gpt4o", "gpt-3.5-turbo", "llama3-70b", "mixtral-8x7b", "gemma2-9b-it", "cohere"]
WIKI_PER_GEN = {"short": 2, "long": 2}  # Texte je Generator und Längenklasse


def bucket(words: int) -> str:
    return "short" if words < RELIABLE_WORDS else "long"


def pick_hc3() -> list[dict]:
    from datasets import load_dataset

    ds = load_dataset("Hello-SimpleAI/HC3", revision="refs/convert/parquet")
    split = ds["train"] if "train" in ds else next(iter(ds.values()))
    rng = random.Random(0)
    rows = []
    for domain in HC3_DOMAINS:
        candidates = {"short": [], "long": []}
        for r in split.filter(lambda r: r["source"] == domain):
            human = next((t for t in map(extract_excerpt, r.get("human_answers") or []) if t), None)
            ai = next((t for t in map(extract_excerpt, r.get("chatgpt_answers") or []) if t), None)
            if not human or not ai:
                continue
            wh, wa = len(human.split()), len(ai.split())
            b = bucket(wh)
            if b == bucket(wa):  # gleiche Längenklasse, sonst verrät die Länge das Label
                candidates[b].append((human, wh, ai, wa))
        for key, target in HC3_PAIRS.items():
            pool = candidates[key]
            n = min(target, len(pool))
            if n < target:
                print(f"WARNUNG: HC3 {domain}/{key}: nur {n} von {target} Paaren verfügbar")
            for human, wh, ai, wa in rng.sample(pool, n):
                rows.append({"ai": False, "domain": domain, "generator": "human", "words": wh, "text": human})
                rows.append({"ai": True, "domain": domain, "generator": "chatgpt-2023", "words": wa, "text": ai})
    return rows


def pick_wikipedia() -> list[dict]:
    from datasets import concatenate_datasets, load_dataset

    ds = load_dataset("Jinyan1/COLING_2025_MGT_en")
    full = concatenate_datasets([ds["train"], ds["dev"]])
    wanted = {"human", *WIKI_GENERATORS}
    sub = full.filter(lambda r: r["sub_source"] == "wikipedia" and r["model"] in wanted, desc="Filtere Wikipedia-Domäne")

    pool: dict[str, dict[str, list]] = {}
    for r in sub:
        ex = extract_excerpt(r["text"])
        if ex is None:
            continue
        w = len(ex.split())
        pool.setdefault(r["model"], {"short": [], "long": []})[bucket(w)].append((ex, w))

    rng = random.Random(1)
    ai_rows = []
    achieved = {"short": 0, "long": 0}  # tatsächlich gezogene KI-Texte je Bucket (manche Generatoren liefern
    # kaum kurze Wikipedia-Texte, z.B. gpt4/gpt4o) - Mensch-Texte unten in gleicher Zahl ziehen, sonst
    # entsteht eine Schieflage Mensch/KI
    for gen in WIKI_GENERATORS:
        gen_pool = pool.get(gen, {"short": [], "long": []})
        for key, target in WIKI_PER_GEN.items():
            n = min(target, len(gen_pool[key]))
            if n < target:
                print(f"WARNUNG: wikipedia {gen}/{key}: nur {n} von {target}")
            achieved[key] += n
            for text, w in rng.sample(gen_pool[key], n):
                ai_rows.append({"ai": True, "domain": "wikipedia", "generator": gen, "words": w, "text": text})

    human_pool = pool.get("human", {"short": [], "long": []})
    human_rows = []
    for key, target in achieved.items():  # genauso viele Mensch- wie KI-Texte je Bucket
        n = min(target, len(human_pool[key]))
        if n < target:
            print(f"WARNUNG: wikipedia human/{key}: nur {n} von {target}")
        for text, w in rng.sample(human_pool[key], n):
            human_rows.append({"ai": False, "domain": "wikipedia", "generator": "human", "words": w, "text": text})
    return human_rows + ai_rows


def write(rows: list[dict]) -> None:
    def item(r):
        return (
            f'  {{ ai: {str(r["ai"]).lower()}, domain: {json.dumps(r["domain"])}, '
            f'generator: {json.dumps(r["generator"])}, words: {r["words"]}, text: {json.dumps(r["text"], ensure_ascii=False)} }}'
        )

    items = ",\n".join(item(r) for r in rows)
    n_human, n_ai = sum(1 for r in rows if not r["ai"]), sum(1 for r in rows if r["ai"])
    OUT.write_text(
        "// Referenzset für „Modell prüfen“ (bg/model-check.js): "
        f"{n_human} menschliche und {n_ai} KI-Texte, Englisch, kurze\n"
        "// (< 120 Wörter) und lange Absätze getrennt gebucketed (Feld `words`, siehe RELIABLE_WORDS in\n"
        "// model-check.js). Domänen/Generatoren: fünf aus HC3 (Hello-SimpleAI/HC3, CC BY-SA 4.0, Generator\n"
        "// ChatGPT 2023) plus „wikipedia“ aus Jinyan1/COLING_2025_MGT_en (Herkunft MAGE, Apache-2.0,\n"
        "// menschliche Texte sind Wikipedia-Passagen; Generatoren gpt4/gpt4o/gpt-3.5-turbo/llama3-70b/\n"
        "// mixtral-8x7b/gemma2-9b-it/cohere). Lizenzabwägung je Teilquelle: Kommentar am Kopf von\n"
        "// training/build_reference_set.py. Erzeugt von training/build_reference_set.py - nicht von Hand ändern.\n"
        f"export const REFERENCE_SET = [\n{items}\n];\n",
        encoding="utf-8",
        newline="\n",
    )


def check(rows: list[dict], backends: list[str]) -> None:
    import evaluate_backends as eb

    texts = [r["text"] for r in rows]
    labels = [r["ai"] for r in rows]
    for name in backends:
        scores = (eb.score_tmr if name == "tmr" else eb.score_desklib)(texts)
        human = sorted(s for s, l in zip(scores, labels) if not l)
        ai = sorted(s for s, l in zip(scores, labels) if l)
        print(f"\n{name}: AUROC gesamt {auroc(labels, scores):.3f} (n={len(rows)}), Mittel Mensch {sum(human) / len(human):.3f}, KI {sum(ai) / len(ai):.3f}")

        for key, label in (("short", f"kurz (< {RELIABLE_WORDS} Wörter)"), ("long", f"lang (>= {RELIABLE_WORDS} Wörter)")):
            idx = [i for i, r in enumerate(rows) if bucket(r["words"]) == key]
            if not idx:
                continue
            l2, s2 = [labels[i] for i in idx], [scores[i] for i in idx]
            print(f"  {label}: AUROC {auroc(l2, s2):.3f} (n={len(idx)})")

        for domain in sorted(set(r["domain"] for r in rows)):
            idx = [i for i, r in enumerate(rows) if r["domain"] == domain]
            l2, s2 = [labels[i] for i in idx], [scores[i] for i in idx]
            print(f"  {domain}: AUROC {auroc(l2, s2):.3f} (n={len(idx)})")

        print("  Mensch:", " ".join(f"{s:.2f}" for s in human))
        print("  KI:    ", " ".join(f"{s:.2f}" for s in ai))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", nargs="*", choices=["tmr", "desklib"], default=[])
    args = ap.parse_args()
    rows = pick_hc3() + pick_wikipedia()
    write(rows)
    n_human, n_ai = sum(1 for r in rows if not r["ai"]), sum(1 for r in rows if r["ai"])
    n_short, n_long = sum(1 for r in rows if bucket(r["words"]) == "short"), sum(1 for r in rows if bucket(r["words"]) == "long")
    print(f"{len(rows)} Texte ({n_human} Mensch/{n_ai} KI, {n_short} kurz/{n_long} lang) -> {OUT}")
    if args.check:
        check(rows, args.check)


if __name__ == "__main__":
    main()
