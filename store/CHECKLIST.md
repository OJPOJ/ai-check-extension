# Checkliste vor der Veröffentlichung

Was WP-03 vorbereiten konnte, steht in `LISTING.md`, `PERMISSIONS.md` und `screenshots/`. Was noch
fehlt und nur der Nutzer/Betreiber liefern kann:

## Rechtliches (blockiert die Veröffentlichung)

- [ ] **Kontakt in `extension/privacy.html`** eintragen (Zeile 88, aktuell Platzhalter
      `[Name und Kontaktadresse des Anbieters vor der Veröffentlichung eintragen]`). `npm run package`
      warnt, solange das offen ist.
- [ ] **Datenschutzerklärung öffentlich hosten** (z.B. GitHub Pages, aus `extension/privacy.html`
      generiert oder 1:1 kopiert) – beide Stores verlangen dafür eine öffentlich erreichbare URL im
      Formular, ein Link auf eine Datei im ungepackten Paket reicht nicht.
- [ ] **Impressum**, falls nach eigenem Recht nötig (z.B. § 5 DDG in Deutschland bei geschäftsmäßigem
      Angebot) – abhängig vom Wohnsitz/Rechtsform des Anbieters, kann hier nicht pauschal beantwortet
      werden.

## Entwicklerkonten

- [ ] Chrome Web Store Developer Dashboard: einmalig 5 $ Gebühr, Google-Konto nötig.
- [ ] Microsoft Partner Center (Edge Add-ons): kostenlos, Microsoft-Konto nötig.
- [ ] Bei beiden: Kontakt-E-Mail fürs Formular (kann von der in `privacy.html` abweichen).

## Store-Formular

- [ ] Texte aus `LISTING.md` (Name, Kurz-/Langbeschreibung DE+EN, Kategorie) einfügen.
- [ ] Berechtigungs-Begründungen aus `PERMISSIONS.md` in die jeweiligen Formularfelder übertragen
      (Chrome fragt das einzeln pro Berechtigung im „Privacy practices“-Tab, „Data usage“ separat).
- [ ] Remote-Code-Frage: „Nein“ + Erklärung aus `PERMISSIONS.md` („Remote-Code-Erklärung“).
- [ ] Datenschutz-URL (siehe oben) eintragen.
- [ ] Icons sind fertig (`extension/icons/`, per `npm run build:icons`), im Manifest eingetragen -
      nichts mehr zu tun.

## Screenshots und Werbegrafik

`npm run screenshots` erzeugt (Playwright, `scripts/screenshot.mjs`):

- `store/screenshots/1-scan.png` – `test/harness.html` mit farbig markierten Absätzen (1280×800).
- `store/screenshots/2-settings.png` – Einstellungen, Abschnitt „Erkennung“ (1280×800).
- `store/screenshots/promo-tile-440x280.png` – einfache Werbekachel (Icon + Name + Claim).

Vor dem Hochladen prüfen:

- [ ] **Die Scores in `1-scan.png` sind nicht echt** – das Skript nutzt zur Geschwindigkeit ein
      Fake-Backend, das Scores deterministisch aus der Textlänge vergibt (wie die E2E-Tests), kein
      echtes Modell. Die Ampel-Farben zeigen also nur die Oberfläche, nicht ob die Beispieltexte
      "richtig" bewertet würden. Für einen ehrlichen Store-Auftritt entweder: (a) mit echtem
      Browser-Modell (TMR) auf einer echten Seite neu screenshotten, oder (b) im Text darauf
      hinweisen, dass es sich um eine UI-Demo handelt. Empfehlung: (a).
- [ ] **`test/harness.html` ist eine Testseite**, keine polierte Demo-Webseite (Überschrift „nur zum
      manuellen Testen“, „meta“-Beschriftungen der Beispiele). Für den Store wahrscheinlich besser:
      Screenshot auf einer echten, ansprechenden Artikel-Seite (z.B. ein Blogpost, Wikipedia-Artikel)
      mit `scanMode: "all"` oder manuellem Scan, damit die Markierungen in einem realistischen Kontext
      zu sehen sind.
- [ ] **Popup nicht enthalten** – Chrome/Edge verlangen exakt 1280×800 oder 640×400; das Popup ist mit
      320 px Breite dafür zu schmal. Falls ein Popup-Screenshot gewünscht ist: in ein 1280×800-Bild
      montieren (z.B. Popup-Screenshot über einem Seiten-Screenshot).
- [ ] **Werbekachel ist ein Platzhalter** (Indigo-Fläche, Icon, zwei Zeilen Text aus
      `scripts/screenshot.mjs`) – kein Grafikdesign. Für den echten Auftritt eher von Hand gestalten
      oder zumindest gegenlesen.
- [ ] Optional weitere Screenshots (bis zu 5 bei Chrome): Popup mit Zählern, Sperrliste, „Modell
      prüfen“-Ergebnis, Begrüßungsseite (`welcome.html`) – `scripts/screenshot.mjs` lässt sich dafür
      erweitern (weitere `ext.options.click(...)`/`ext.open(...)`-Schritte plus Screenshot).

## Bereits erledigt (WP-03)

- Icons 16/32/48/128 (SVG-Quelle + Build-Skript, `npm run build:icons`), im Manifest eingetragen.
  `npm run package` zeigt die Icon-Warnung nicht mehr.
- „Über / Lizenzen“ in der Extension (`extension/about.html`, verlinkt aus den Einstellungen unten bei
  Datenschutz): Version, MIT-Lizenz, CC-BY-SA-Hinweis für Sperrliste und Referenzset,
  Drittkomponenten, Link zur Datenschutzerklärung.
- `store/LISTING.md`, `store/PERMISSIONS.md` (diese Datei).
- Screenshot-/Werbegrafik-Skript (`scripts/screenshot.mjs`, `npm run screenshots`) – siehe Einschränkungen oben.
