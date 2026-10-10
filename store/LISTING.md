# Store listing

Texts for the store form (Chrome Web Store / Edge Add-ons), in English. Character counts
for the short description apply to Chrome (limit 132 characters); Edge allows more, the same
shortening fits anyway.

## Name

AI Content Flag

## Category

"Productivity" (Chrome Web Store and Edge Add-ons). Both stores occasionally change their
category taxonomies – check the currently available options when submitting; if
"Productivity" no longer fits, "Tools" is the next best choice.

## Short description (English, ≤132 characters, 124 counted)

Flags AI-suspicious paragraphs green/yellow/red with a score – runs locally in your browser or via
a cloud backend you pick.

## Detailed description (English)

AI Content Flag scores longer paragraphs on web pages with an AI-text classifier and flags them
green (unremarkable), yellow (unclear) or red (flagged, resembles AI-generated text), together with
a 0–100 score.

**How it runs:** By default the model runs directly in your browser via WebAssembly – text never
leaves your machine. If you prefer, you can instead use a local server, your own server/cloud service,
or the Hugging Face Inference API; the extension clearly shows where text would be sent before it is.

**When it scans:** Only on pages you explicitly allow (or only on demand, per click) – no text is
sent without your action. A bundled blocklist (online banking, webmail, government login portals)
and detection of password/payment fields additionally prevent scanning of sensitive pages, regardless
of this setting.

**PDFs:** PDFs are never scanned automatically. On request, the extension opens a PDF in its own viewer
(bundled pdf.js), scores it paragraph by paragraph and marks it in color; a copy with the markings as highlight annotations can be saved locally. By default this happens locally;
online backends are blocked for PDFs unless you switch them on and confirm per document. In Chrome's own
PDF viewer, which cannot be marked, you can check selected text via right-click.

**Honest limits:**
- The bundled models are trained on **English only**. Paragraphs in other languages are detected and
  **not scored**, rather than guessed at.
- **False positives happen** – human-written text is occasionally flagged red too, especially short,
  translated, or heavily edited text (e.g. encyclopedia entries, press releases).
- The score is a **hint, not proof**, and not a calibrated probability. Please don't accuse anyone of
  using AI based solely on this flag.
- PDFs: scanned documents without a text layer are not read (no OCR). Academic text with citations,
  formulas and tables may be split or scored less reliably than ordinary prose.
- Very short paragraphs are marked "uncertain" instead of colored, because the model is unreliable
  there.

**Open source:** The code is MIT-licensed. License and data-provenance details (including a
CC BY-SA 4.0 blocklist and a CC BY-SA 4.0 reference set used for "Check model") are available via
"About / licenses" in the extension's settings.
