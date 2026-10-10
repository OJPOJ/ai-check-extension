# Third-Party Notices

## Shipped software (`vendor/`, via `npm run vendor`)

- **transformers.js** (`@huggingface/transformers` 4.3.0) – Apache License 2.0,
  © Hugging Face. License text: `vendor/LICENSE.transformers.js.txt`.
- **ONNX Runtime Web** (`onnxruntime-web`) – MIT License, © Microsoft Corporation.
- **pdf.js** (`pdfjs-dist` 6.4.299) – Apache License 2.0, © Mozilla and individual contributors. Used by the PDF
  viewer (`viewer.html`): rendering, text layer, character maps, standard fonts and the JBIG2/JPEG 2000/ICC
  decoders in `vendor/pdfjs/`. License texts: `vendor/pdfjs/LICENSE.pdfjs.txt` and `vendor/pdfjs/wasm/LICENSE_*`.
  The PDF scripting sandbox is not shipped.

## Shipped data (`generated/blocklist.js`, via `npm run build:blocklist`)

The bundled blocklist is compiled from the following sources and as a whole is under
**CC BY-SA 4.0** (https://creativecommons.org/licenses/by-sa/4.0/):

- **UT1 blacklists**, categories `bank` and `webmail` – © Université Toulouse Capitole, maintained by
  Fabrice Prigent, CC BY-SA 4.0. https://dsi.ut-capitole.fr/blacklists/ – adopted after
  normalization (lowercase, without `www.`, without entries whose parent domain is included) and
  without individual portals with predominantly editorial content (list `NEVER_BLOCK` in the build script).
- **FDIC BankFind Suite** – web addresses of all active US banks, work of the US federal government
  (public domain). https://api.fdic.gov/banks/docs/
- **NCUA Call Report Data** – web addresses of US credit unions (quarterly data, field `Acct_891`),
  National Credit Union Administration, work of the US federal government (public domain).
  https://ncua.gov/analysis/credit-union-corporate-call-report-data/quarterly-data
- **Wikidata** – official websites (P856) of banks in Germany, Austria, Switzerland, the
  United Kingdom and the USA, CC0 1.0. https://www.wikidata.org/
- Hand-picked additions (`scripts/build-blocklist.mjs`, `CURATED`).

## Shipped data (`bg/reference-set.js`, via `training/build_reference_set.py`)

The reference set for "Check model" (114 texts, 57 human and 57 AI texts, short and long
paragraphs) comes from two sources:

- **HC3** ("Human ChatGPT Comparison Corpus", `Hello-SimpleAI/HC3`) – © Biyang Guo et al.,
  **CC BY-SA 4.0** (https://creativecommons.org/licenses/by-sa/4.0/).
  https://huggingface.co/datasets/Hello-SimpleAI/HC3 – five domains (reddit_eli5, finance, medicine,
  open_qa, wiki_csai), generator ChatGPT (2023). Adopted with normalized whitespace (removed before
  punctuation) and truncated at a sentence boundary.
- **RAID** (`liamdugan/raid`, https://github.com/liamdugan/raid) – © Liam Dugan et al., **MIT License**.
  Domain "wiki" (human texts: Wikipedia articles, CC BY-SA), generators llama-chat, mistral,
  mistral-chat, mpt, mpt-chat, gpt2; only unmodified text (`attack == "none"`, `decoding == "greedy"`).

Reviewed and rejected (own or unclear terms of use): Yelp/IMDb reviews,
press articles (XSum, CNN/DailyMail), arXiv/PubMed abstracts, WikiHow (CC BY-NC-SA), Reddit outside
HC3, the "wikipedia" domain of `Jinyan1/COLING_2025_MGT_en` (comes from M4GT-Bench, without a license).
License weighing per sub-source: header of `training/build_reference_set.py`.
The reference set as a whole is under CC BY-SA 4.0.

## Models loaded at runtime (not included in the package)

- **TMR AI Text Detector** – `Oxidane/tmr-ai-text-detector`, MIT License, © Oxidane.
  ONNX conversion: `onnx-community/tmr-ai-text-detector-ONNX` (MIT), revision
  `b9aa251e5bcda7e429fcc936767d921435945b60`.
  Base model RoBERTa-base (MIT, © Facebook AI), training data RAID (MIT, © Liam Dugan).
- **desklib AI Text Detector** – `desklib/ai-text-detector-v1.01`, MIT License, © desklib.
  Revision `5fdea974cd4287c61674951ec78803aa274e2fb7`. The weights are not shipped,
  but loaded from Hugging Face at runtime and quantized to 8 bits in the browser.
  Only the compute graph exported from it, without weights, is shipped (`models/desklib/`,
  generated with `scripts/build_desklib_skeleton.py`). Base model DeBERTa-v3-large (MIT, © Microsoft).
- **fakespot AI Text Detector** – `fakespot-ai/roberta-base-ai-text-detection-v1`, Apache License 2.0
  (https://www.apache.org/licenses/LICENSE-2.0), © Fakespot/Mozilla. ONNX conversion by a
  third party (not the model's creator): `MedAliFarhat/ai-text-detector-onnx` (also Apache-2.0),
  revision `0c809a8de6e600ec2fd0fcdeb595a5461d93e8dc` – checked against the PyTorch original
  (`training/compare_onnx.py`, results in `training/MODEL_SEARCH.md`). Base model RoBERTa-base
  (MIT, © Facebook AI); training data not disclosed in detail (reference to
  github.com/FakespotAILabs/ApolloDFT).

## MIT License (applies to the components marked as MIT above)

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
