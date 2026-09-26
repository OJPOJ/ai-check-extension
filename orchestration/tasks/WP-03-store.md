# WP-03 · Store-Vorbereitung (TODO Punkt 4)

## Ziel
Alles, was ohne Nutzerdaten (Name/Adresse, Entwicklerkonto) für Chrome Web Store / Edge Add-ons
vorbereitet werden kann.

## Umfang
1. **Icons:** schlichtes, klares Icon (Motiv z.B. Ampel/Lupe + „AI“, passend zu `extension/ui.css`),
   SVG-Quelle unter `extension/icons/` plus PNG 16/32/48/128. PNGs per Skript erzeugen
   (`scripts/build-icons.mjs`, z.B. SVG mit Playwright/Chromium rendern – Playwright ist devDependency),
   npm-Script `build:icons`. In `manifest.json` `icons` und `action.default_icon` eintragen.
   `npm run package` darf danach keine Icon-Warnung mehr zeigen (`scripts/package.mjs`).
2. **„Über“/Lizenzen in der Extension:** von der Optionsseite erreichbar: Version, Lizenz (MIT),
   CC-BY-SA-Hinweis für Sperrliste und Referenzset, Drittkomponenten (`THIRD_PARTY_NOTICES.md`),
   Link zur Datenschutzerklärung. Neue Seite `extension/about.html` oder Abschnitt in `options.html`.
   Sicherstellen, dass `scripts/package.mjs` neue Dateien mitpackt.
3. **Store-Texte** in `store/` (neu):
   - `store/LISTING.md`: Name, Kurzbeschreibung (≤ 132 Zeichen), ausführliche Beschreibung mit ehrlichen
     Grenzen (nur Englisch, Fehlalarme möglich, Score ist kein Beweis), Kategorie. Deutsch und Englisch.
   - `store/PERMISSIONS.md`: Begründung jeder Berechtigung aus `manifest.json` (tatsächlich lesen, u.a.
     `<all_urls>` im Content-Script, optionale Host-Rechte `https://*/*`, `wasm-unsafe-eval`, `activeTab`,
     Offscreen, Storage …) im Stil der Store-Formularfelder; Angaben zur Datennutzung (Website-Inhalte,
     lokal verarbeitet); Remote-Code-Erklärung (transformers.js mitgeliefert, nur Modellgewichte werden
     nachgeladen).
   - `store/CHECKLIST.md`: was noch fehlt und vom Nutzer kommen muss (Kontakt in `privacy.html` Zeile 88,
     Impressum, Hosting der Datenschutzerklärung z.B. GitHub Pages, Entwicklerkonten, Screenshots).
4. **Screenshots/Werbegrafik (optional):** Skript, das mit Playwright die Extension auf
   `test/harness.html` lädt und Screenshots 1280×800 erzeugt, dazu eine Werbekachel 440×280. Wenn zu
   aufwendig: nur Plan in `CHECKLIST.md`.

## Erlaubte Dateien
`extension/manifest.json`, `extension/icons/**`, `extension/about.*`, `extension/options.html`,
`extension/options.js`, `extension/ui.css`, `store/**`, `scripts/**`, `package.json`, `test/unit/**`
(nur neue Tests). Nicht: `extension/content*`, `extension/config.js`, `extension/models.js`,
`extension/privacy.html` (nur lesen), `training/**`.

## Abnahme
- `npm test` grün, `npm run package` ohne Icon-Warnung.
- Manifest valide (Extension lädt in den E2E-Tests weiterhin).
