# Third-Party Notices

## Mitgelieferte Software (`vendor/`, per `npm run vendor`)

- **transformers.js** (`@huggingface/transformers` 4.3.0) – Apache License 2.0,
  © Hugging Face. Lizenztext: `vendor/LICENSE.transformers.js.txt`.
- **ONNX Runtime Web** (`onnxruntime-web`) – MIT License, © Microsoft Corporation.

## Mitgelieferte Daten (`generated/blocklist.js`, per `npm run build:blocklist`)

Die mitgelieferte Sperrliste ist aus folgenden Quellen zusammengestellt und steht als Ganzes unter
**CC BY-SA 4.0** (https://creativecommons.org/licenses/by-sa/4.0/):

- **UT1-Blacklists**, Kategorien `bank` und `webmail` – © Université Toulouse Capitole, gepflegt von
  Fabrice Prigent, CC BY-SA 4.0. https://dsi.ut-capitole.fr/blacklists/ – übernommen nach
  Normalisierung (Kleinschreibung, ohne `www.`, ohne Einträge, deren Eltern-Domain enthalten ist) und
  ohne einzelne Portale mit überwiegend redaktionellem Inhalt (Liste `NEVER_BLOCK` im Build-Skript).
- **FDIC BankFind Suite** – Web-Adressen aller aktiven US-Banken, Werk der US-Bundesregierung
  (gemeinfrei). https://api.fdic.gov/banks/docs/
- **NCUA Call Report Data** – Web-Adressen der US-Credit-Unions (Quartalsdaten, Feld `Acct_891`),
  National Credit Union Administration, Werk der US-Bundesregierung (gemeinfrei).
  https://ncua.gov/analysis/credit-union-corporate-call-report-data/quarterly-data
- **Wikidata** – offizielle Websites (P856) von Banken in Deutschland, Österreich, der Schweiz, dem
  Vereinigten Königreich und den USA, CC0 1.0. https://www.wikidata.org/
- Handverlesene Ergänzungen (`scripts/build-blocklist.mjs`, `CURATED`).

## Zur Laufzeit geladene Modelle (nicht im Paket enthalten)

- **TMR AI Text Detector** – `Oxidane/tmr-ai-text-detector`, MIT License, © Oxidane.
  ONNX-Konvertierung: `onnx-community/tmr-ai-text-detector-ONNX` (MIT), Revision
  `b9aa251e5bcda7e429fcc936767d921435945b60`.
  Basismodell RoBERTa-base (MIT, © Facebook AI), Trainingsdaten RAID (MIT, © Liam Dugan).
- **desklib AI Text Detector** – `desklib/ai-text-detector-v1.01`, MIT License, © desklib.
  Revision `5fdea974cd4287c61674951ec78803aa274e2fb7`. Die Gewichte werden nicht mitgeliefert,
  sondern zur Laufzeit von Hugging Face geladen und im Browser auf 8 Bit quantisiert.
  Mitgeliefert wird nur der daraus exportierte Rechengraph ohne Gewichte (`models/desklib/`,
  erzeugt mit `scripts/build_desklib_skeleton.py`). Basismodell DeBERTa-v3-large (MIT, © Microsoft).

## MIT License (gilt für die oben als MIT gekennzeichneten Komponenten)

Permission is hereby granted, free of charge, to any person obtaining a copy of this
software and associated documentation files (the "Software"), to deal in the Software
without restriction, including without limitation the rights to use, copy, modify, merge,
publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons
to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE
FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.
