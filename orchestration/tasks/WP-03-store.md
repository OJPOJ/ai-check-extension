# WP-03 · Store preparation (TODO item 4)

## Goal
Everything that can be prepared for the Chrome Web Store / Edge Add-ons without user data (name/address,
developer account).

## Scope
1. **Icons:** plain, clear icon (motif e.g. traffic light/magnifying glass + "AI", matching `extension/ui.css`),
   SVG source under `extension/icons/` plus PNG 16/32/48/128. Generate the PNGs by script
   (`scripts/build-icons.mjs`, e.g. render the SVG with Playwright/Chromium – Playwright is a devDependency),
   npm script `build:icons`. Enter `icons` and `action.default_icon` in `manifest.json`.
   `npm run package` must not show an icon warning afterwards (`scripts/package.mjs`).
2. **"About"/licences in the extension:** reachable from the options page: version, licence (MIT),
   CC BY-SA notice for blocklist and reference set, third-party components (`THIRD_PARTY_NOTICES.md`),
   link to the privacy policy. New page `extension/about.html` or a section in `options.html`.
   Make sure `scripts/package.mjs` packs new files as well.
3. **Store texts** in `store/` (new):
   - `store/LISTING.md`: name, short description (≤ 132 characters), detailed description with honest
     limits (English only, false alarms possible, score is no proof), category. German and English.
   - `store/PERMISSIONS.md`: justification of every permission from `manifest.json` (actually read it, among others
     `<all_urls>` in the content script, optional host permissions `https://*/*`, `wasm-unsafe-eval`, `activeTab`,
     offscreen, storage …) in the style of the store form fields; statements on data use (website content,
     processed locally); remote-code declaration (transformers.js shipped, only model weights are
     downloaded later).
   - `store/CHECKLIST.md`: what is still missing and has to come from the user (contact in `privacy.html` line 88,
     legal notice, hosting of the privacy policy e.g. GitHub Pages, developer accounts, screenshots).
4. **Screenshots/promo graphic (optional):** script that loads the extension on
   `test/harness.html` with Playwright and produces 1280×800 screenshots, plus a 440×280 promo tile. If too
   much effort: only a plan in `CHECKLIST.md`.

## Allowed files
`extension/manifest.json`, `extension/icons/**`, `extension/about.*`, `extension/options.html`,
`extension/options.js`, `extension/ui.css`, `store/**`, `scripts/**`, `package.json`, `test/unit/**`
(new tests only). Not: `extension/content*`, `extension/config.js`, `extension/models.js`,
`extension/privacy.html` (read only), `training/**`.

## Acceptance
- `npm test` green, `npm run package` without icon warning.
- Manifest valid (the extension still loads in the E2E tests).
