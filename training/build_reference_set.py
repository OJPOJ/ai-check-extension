"""
Erzeugt das Referenzset für „Modell prüfen“ (extension/bg/reference-set.js): Mensch- und KI-Texte
aus zwei weiterverteilbaren Quellen, kurze (40..119 Wörter) und lange (ab 120 Wörter) Absätze
getrennt gebucketed - damit "Modell prüfen" daraus ggf. eine eigene Kurztext-Schwelle
(reliableWords/shortRedFrom, wie config.js RELIABLE_WORDS/models.js) vorschlagen kann.

Lizenzprüfung (Details: orchestration/LOG.md WP-11, ENTSCHEIDUNG-Einträge; im Zweifel weggelassen):
  - HC3 (Hello-SimpleAI/HC3), CC BY-SA 4.0 - wie bisher, fünf Domänen, Generator ChatGPT (2023).
  - RAID (liamdugan/raid), MIT-Lizenz - Domäne "wiki" (menschliche Texte aus Wikipedia, CC BY-SA-
    kompatibel), Generatoren llama-chat/mistral/mistral-chat/mpt/mpt-chat/gpt2 (offene Modelle,
    im MIT-lizenzierten train-Split enthalten). Nur `attack == "none"` (unverfälschter Text, keine
    RAID-Adversarial-Variante wie z.B. "synonym"/"paraphrase") und `decoding == "greedy"`
    (deterministisch, gängiger Standardwert - "sampling" wäre laufzeitgleich verfügbar, aber ohne
    Vorteil für einen einmalig erzeugten, festen Referenztext). RAID enthält im train-Split für die
    Wiki-Domäne vereinzelt auch gpt4/gpt3/chatgpt/cohere/cohere-chat - bewusst NICHT verwendet, um
    beim vom Orchestrator vorgegebenen Rahmen (offene Modelle) zu bleiben; siehe Bericht für Details.
  Zuvor fälschlich als Quelle angenommen und jetzt entfernt: die Teilquelle "wikipedia" aus
  Jinyan1/COLING_2025_MGT_en - per Spalte "source" verifiziert stammt sie aus M4GT-Bench/M4
  (source == "m4gt"), nicht aus MAGE wie zunächst angenommen. M4GT-Bench/M4 haben auf GitHub keine
  Lizenz ("license": null) - nicht weiterverteilbar, "im Zweifel weglassen".
  Bewusst NICHT verwendet (andere Domänen von Jinyan1/COLING_2025_MGT_en bzw. RAID):
  - reviews (Yelp/IMDb): Yelp Open Dataset ausdrücklich nur akademisch, keine Weiterverteilung an
    Dritte; IMDb-Datensatz ohne klare Weiterverteilungs-Lizenz.
  - news (XSum/CNN/TLDR/DialogSum): Presseartikel-Text (BBC/CNN), XSum-Lizenz auf Hugging Face
    "unknown"; der Apache-2.0-Tag am CNN/DailyMail-Ladeskript deckt nicht den Copyright-Status
    der eigentlichen Nachrichtentexte ab. Ebenso RAID-Domänen "news"/"reviews"/"reddit"/"books"/
    "abstracts"/"recipes"/"poetry": menschliche Ursprungstexte dort sind Presseartikel, Amazon-/
    Goodreads-Rezensionen, Reddit-Posts, Buchauszüge, wissenschaftliche Abstracts, Rezepte bzw.
    Gedichte mit eigenen, ungeklärten bzw. bekannt einschränkenden Rechten - nicht verwendet.
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
Längenklasse (sonst wäre die Textlänge selbst ein Hinweis auf das Label). Bei RAID/wiki gibt es
diese Themenpaarung nicht (Datensatz nicht so strukturiert) - Limitation, aber geringeres Risiko
bei einer stilistisch homogenen Domäne (Sachtext) als bei den persönlichen HC3-Antworten.

RAID/train.csv ist eine 11,8-GB-CSV (nicht über die HF-`datasets`-Bibliothek als Ganzes ladbar,
ohne alle Domänen/Angriffe herunterzuladen). `pick_raid_wiki()` streamt die Datei daher direkt
per HTTP und CSV-Reader, verwirft alles vor/nach dem "wiki"-Datenblock und bricht danach ab -
das dauert trotzdem einige Minuten und lädt mehrere GB (die Domänen vor "wiki" müssen erst
durchlaufen werden). Netzwerk-Timeouts sind möglich, dann einfach erneut laufen lassen.

Nutzung (aus diesem Ordner):
    .venv/Scripts/python.exe build_reference_set.py
    .venv/Scripts/python.exe build_reference_set.py --check tmr desklib   # AUROC der Modelle auf dem neuen Set
"""

import argparse
import csv
import io
import json
import random
from pathlib import Path

from build_eval_suite import extract_excerpt
from evaluate_length import auroc

OUT = Path(__file__).resolve().parent.parent / "extension" / "bg" / "reference-set.js"

RELIABLE_WORDS = 120  # wie extension/models.js reliableWords / config.js RELIABLE_WORDS

HC3_DOMAINS = ["reddit_eli5", "finance", "medicine", "open_qa", "wiki_csai"]
HC3_PAIRS = {"short": 4, "long": 4}  # Frage-Paare (Mensch+KI) je Domäne und Längenklasse

RAID_URL = "https://huggingface.co/datasets/liamdugan/raid/resolve/main/train.csv"
RAID_GENERATORS = ["llama-chat", "mistral", "mistral-chat", "mpt", "mpt-chat", "gpt2"]
RAID_DECODING = "greedy"  # deterministisch, gängiger Standardwert (Begründung: Kopf dieser Datei)
# Nur "long": die menschlichen RAID/wiki-Texte sind (Ausschnitte aus) ganzen Wikipedia-Artikeln und
# daher nach extract_excerpt praktisch nie unter RELIABLE_WORDS - kurze Absätze liefert weiter allein
# HC3 (s.o.). Ohne kurze Mensch-Texte hier wäre eine "short"-Zielvorgabe für die KI-Seite unbalanciert.
WIKI_PER_GEN = {"long": 3}  # Texte je Generator


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


def _raid_wiki_rows():
    """Streamt RAID train.csv (11,8 GB, kein anderer Weg an nur die "wiki"-Domäne heranzukommen)
    per HTTP und liefert Zeilen der Domäne "wiki", sobald sie im (nach Domäne gruppierten) Datensatz
    auftauchen; bricht ab, sobald die Domäne wieder wechselt. Große Textfelder in dieser CSV
    (Code-Domäne) brauchen ein angehobenes csv-Feldlimit."""
    import requests

    csv.field_size_limit(2**31 - 1)  # sys.maxsize überläuft auf Windows (32-bit C long)
    resp = requests.get(RAID_URL, stream=True, timeout=120)
    resp.raw.decode_content = True
    reader = csv.reader(io.TextIOWrapper(resp.raw, encoding="utf-8", newline=""))
    header = next(reader)
    idx = {name: i for i, name in enumerate(header)}
    seen_wiki = False
    for row in reader:
        if row[idx["domain"]] != "wiki":
            if seen_wiki:
                return
            continue
        seen_wiki = True
        yield row, idx


CAP = {"human": 20, **{g: 10 for g in RAID_GENERATORS}}  # Kandidaten je Bucket, dann erst zufällig auswählen
# (mehr als der Zielwert, für echte Zufallsauswahl statt "die ersten n gefundenen")
RAID_ROW_LIMIT = 300_000  # Sicherheitsnetz, falls ein Bucket/Modell in der Datei extrem selten vorkommt


def _pool_full(pool: dict) -> bool:
    wanted = {"human", *RAID_GENERATORS}
    return all(len(pool.get(m, {}).get(k, [])) >= CAP[m] for m in wanted for k in ("short", "long"))


def pick_raid_wiki() -> list[dict]:
    wanted = {"human", *RAID_GENERATORS}
    pool: dict[str, dict[str, list]] = {}
    n = 0
    attempts = 3  # die Verbindung zu RAID/train.csv (11,8 GB) bricht gelegentlich vorzeitig ab - neu
    # verbinden reicht (dieselben Zeilen kommen erneut, `pool` bleibt über Versuche hinweg erhalten)
    for attempt in range(1, attempts + 1):
        try:
            for row, idx in _raid_wiki_rows():
                n += 1
                model = row[idx["model"]]
                if model not in wanted or row[idx["attack"]] != "none":
                    continue
                if model != "human" and row[idx["decoding"]] != RAID_DECODING:
                    continue
                ex = extract_excerpt(row[idx["generation"]])
                if ex is None:
                    continue
                w = len(ex.split())
                b = bucket(w)
                bucket_list = pool.setdefault(model, {"short": [], "long": []})[b]
                if len(bucket_list) < CAP[model]:  # danach für dieses (Modell, Bucket) genug Kandidaten
                    bucket_list.append((ex, w))
                if n % 20_000 == 0:
                    print(f"  ... {n} RAID-wiki-Zeilen gelesen (Kandidaten bislang: { {m: {k: len(v) for k, v in bs.items()} for m, bs in pool.items()} })")
                if n >= RAID_ROW_LIMIT or _pool_full(pool):
                    break
            break  # Stream normal zu Ende gelesen (oder Sicherheitsnetz/genug Kandidaten) - kein Retry nötig
        except Exception as err:
            print(f"WARNUNG: RAID-Stream abgebrochen ({err}) - Versuch {attempt}/{attempts}")
            if attempt == attempts or _pool_full(pool):
                break
    print(f'RAID: {n} Zeilen der Domäne "wiki" gelesen (genug Kandidaten gefunden oder Sicherheitsnetz erreicht)')

    rng = random.Random(1)
    ai_rows = []
    achieved = {"short": 0, "long": 0}  # tatsächlich gezogene KI-Texte je Bucket - Mensch-Texte unten in
    # gleicher Zahl ziehen, sonst entsteht eine Schieflage Mensch/KI
    for gen in RAID_GENERATORS:
        gen_pool = pool.get(gen, {"short": [], "long": []})
        for key, target in WIKI_PER_GEN.items():
            n = min(target, len(gen_pool[key]))
            if n < target:
                print(f"WARNUNG: raid wiki {gen}/{key}: nur {n} von {target}")
            achieved[key] += n
            for text, w in rng.sample(gen_pool[key], n):
                ai_rows.append({"ai": True, "domain": "wikipedia", "generator": gen, "words": w, "text": text})

    human_pool = pool.get("human", {"short": [], "long": []})
    human_rows = []
    for key, target in achieved.items():  # genauso viele Mensch- wie KI-Texte je Bucket
        n = min(target, len(human_pool[key]))
        if n < target:
            print(f"WARNUNG: raid wiki human/{key}: nur {n} von {target}")
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
        "// ChatGPT 2023) plus „wikipedia“ aus RAID (liamdugan/raid, MIT-Lizenz, Domäne \"wiki\"; menschliche\n"
        "// Texte sind Wikipedia-Artikel; Generatoren llama-chat/mistral/mistral-chat/mpt/mpt-chat/gpt2).\n"
        "// Lizenzabwägung je Teilquelle: Kommentar am Kopf von training/build_reference_set.py.\n"
        "// Erzeugt von training/build_reference_set.py - nicht von Hand ändern.\n"
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
    rows = pick_hc3() + pick_raid_wiki()
    write(rows)
    n_human, n_ai = sum(1 for r in rows if not r["ai"]), sum(1 for r in rows if r["ai"])
    n_short, n_long = sum(1 for r in rows if bucket(r["words"]) == "short"), sum(1 for r in rows if bucket(r["words"]) == "long")
    print(f"{len(rows)} Texte ({n_human} Mensch/{n_ai} KI, {n_short} kurz/{n_long} lang) -> {OUT}")
    if args.check:
        check(rows, args.check)


if __name__ == "__main__":
    main()
