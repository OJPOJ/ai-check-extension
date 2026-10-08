# Checklist before publication

What WP-03 could prepare is in `LISTING.md`, `PERMISSIONS.md` and `screenshots/`. What is still
missing and can only be supplied by the user/operator:

## Legal (blocks publication)

- [x] **Contact in `extension/privacy.html`**: reference to the GitHub issues (the developers receive
      no data). For the store, add an email address if needed.
- [ ] **Host the privacy policy publicly** (e.g. GitHub Pages, generated from `extension/privacy.html`
      or copied 1:1) – both stores require a publicly reachable URL in the
      form for this, a link to a file in the unpacked package is not enough.
- [ ] **Legal notice (Impressum)**, if required under your own law (e.g. § 5 DDG in Germany for a commercial
      offering) – depends on the provider's place of residence/legal form, cannot be answered
      generally here.

## Developer accounts

- [ ] Chrome Web Store Developer Dashboard: one-time $5 fee, Google account required.
- [ ] Microsoft Partner Center (Edge Add-ons): free, Microsoft account required.
- [ ] For both: contact email for the form (may differ from the one in `privacy.html`).

## Store form

- [ ] Paste the texts from `LISTING.md` (name, short/long description, category).
- [ ] Transfer the permission justifications from `PERMISSIONS.md` into the respective form fields
      (Chrome asks for each permission individually in the "Privacy practices" tab, "Data usage" separately).
- [ ] Remote code question: "No" + explanation from `PERMISSIONS.md` ("Remote code explanation").
- [ ] Enter the privacy URL (see above).
- [ ] Icons are done (`extension/icons/`, via `npm run build:icons`), entered in the manifest -
      nothing more to do.

## Screenshots and promo graphic

`npm run screenshots` generates (Playwright, `scripts/screenshot.mjs`):

- `store/screenshots/1-scan.png` – `test/harness.html` with paragraphs marked in color (1280×800).
- `store/screenshots/2-settings.png` – settings, "Detection" section (1280×800).
- `store/screenshots/promo-tile-440x280.png` – simple promo tile (icon + name + tagline).

Check before uploading:

- [ ] **The scores in `1-scan.png` are not real** – for speed the script uses a
      fake backend that assigns scores deterministically from the text length (like the E2E tests), not a
      real model. The traffic-light colors thus only show the UI, not whether the sample texts
      would be scored "correctly". For an honest store presence either: (a) re-take the screenshot with a real
      browser model (TMR) on a real page, or (b) state in the text
      that it is a UI demo. Recommendation: (a).
- [ ] **`test/harness.html` is a test page**, not a polished demo website (heading "only for
      manual testing", "meta" labels of the examples). For the store probably better:
      a screenshot on a real, appealing article page (e.g. a blog post, Wikipedia article)
      with `scanMode: "all"` or a manual scan, so the markers can be seen in a realistic context.
- [ ] **Popup not included** – Chrome/Edge require exactly 1280×800 or 640×400; the popup, at
      320 px width, is too narrow for that. If a popup screenshot is wanted: compose it into a 1280×800 image
      (e.g. popup screenshot over a page screenshot).
- [ ] **Promo tile is a placeholder** (indigo area, icon, two lines of text from
      `scripts/screenshot.mjs`) – no graphic design. For the real presence, better to design by hand
      or at least proofread.
- [ ] Optionally further screenshots (up to 5 in Chrome): popup with counters, blocklist, "Check
      model" result, welcome page (`welcome.html`) – `scripts/screenshot.mjs` can be extended for this
      (further `ext.options.click(...)`/`ext.open(...)` steps plus screenshot).

## Already done (WP-03)

- Icons 16/32/48/128 (SVG source + build script, `npm run build:icons`), entered in the manifest.
  `npm run package` no longer shows the icon warning.
- "About / licenses" in the extension (`extension/about.html`, linked from the settings at the bottom under
  Privacy): version, MIT license, CC-BY-SA notice for blocklist and reference set,
  third-party components, link to the privacy policy.
- `store/LISTING.md`, `store/PERMISSIONS.md` (this file).
- Screenshot/promo graphic script (`scripts/screenshot.mjs`, `npm run screenshots`) – see the limitations above.
