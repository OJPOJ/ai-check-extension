# Orchestrierung

Parallele Arbeit mehrerer Agenten an diesem Repo. Ein Orchestrator (Opus) plant, verteilt, prüft und
merged; Worker-Agenten (Sonnet) bearbeiten je ein Arbeitspaket (WP) in einem eigenen Git-Worktree.

## Rollen

| Rolle | Wer | Aufgaben |
|---|---|---|
| Auftraggeber | Nutzer | Prioritäten, Entscheidungen, Freigaben (Push, Veröffentlichung, Zugangsdaten) |
| Orchestrator | Claude Opus | WPs schneiden, Briefs schreiben, Agenten starten, Ergebnisse prüfen, mergen, `TODO.md`/`README.md` pflegen |
| Worker | Claude Sonnet | genau ein WP umsetzen, testen, auf eigenem Branch committen, berichten |

## Dateien

- `BOARD.md` – Übersicht aller WPs mit Status. Pflegt nur der Orchestrator.
- `LOG.md` – gemeinsames Kommunikations-Log, nur anhängen (append-only).
- `tasks/WP-xx-*.md` – Brief pro Arbeitspaket: Ziel, Umfang, erlaubte Dateien, Abnahmekriterien.

## Regeln für Worker

1. **Nur die im Brief erlaubten Dateien ändern.** Braucht es mehr, im Log mit `BLOCKER`/`FRAGE` melden
   und eine Lösung ohne die Datei suchen oder die Änderung minimal halten und begründen.
2. **`TODO.md`, `README.md` (Roadmap) und `orchestration/*` nicht ändern** – außer dem Anhängen an
   `LOG.md`. Vorschläge für TODO/README gehören in den Abschlussbericht.
3. **Log über den absoluten Pfad** `C:\_programme\DS\aivsai\orchestration\LOG.md` (liegt im Haupt-Checkout,
   nicht im Worktree). Nur anhängen, nie umschreiben, z.B.:
   `printf '%s\n' "- 2026-09-26 14:05 · WP-02 · INFO · Gruppierung in content.js steht, Tests laufen" >> /c/_programme/DS/aivsai/orchestration/LOG.md`
4. **Log-Typen:** `START`, `INFO` (Zwischenstand), `ENTSCHEIDUNG` (Designwahl mit Grund), `FRAGE`
   (an Orchestrator/Nutzer), `BLOCKER`, `FERTIG` (mit Branch, Commit, Testergebnis).
   Eine Zeile pro Eintrag, knapp. Mindestens START, eine ENTSCHEIDUNG pro nicht-trivialer Wahl, FERTIG.
5. **Worktree-Setup:** `node_modules/`, `extension/vendor/` und `training/.venv/` sind gitignored und fehlen
   im Worktree. Node: im Worktree-Root `cmd //c mklink //J node_modules C:\_programme\DS\aivsai\node_modules`
   (danach erzeugt `npm test` über `pretest` den Vendor-Ordner selbst). Python:
   `C:/_programme/DS/aivsai/training/.venv/Scripts/python.exe`. Große Downloads/Daten nach
   `C:/_programme/DS/aivsai/training/data/` (gitignored, geteilt) statt in den Worktree.
6. **Tests:** Wer Extension-Code ändert, lässt `npm test` laufen; alle Tests müssen grün sein.
7. **Abschluss:** auf dem eigenen Branch committen (deutsche Commit-Message im Stil des Repos, mit
   `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`), nicht pushen, nicht mergen.
   Dann `FERTIG` ins Log und als Antwort einen Bericht: Branch, Commits, was/warum, Tests,
   offene Punkte, Vorschläge für `TODO.md`/`README.md`.
8. Code und Kommentare im Stil der Umgebung (Deutsch, knapp). Keine Geheimnisse/Tokens committen.
9. **Messungen wie im Produkt:** Fehlalarm-/Erkennungsraten immer auch mit der Ampel-Logik der
   Extension angeben (`reliableWords`, `shortRedFrom`, Gruppierung), nicht nur auf Rohscores – sonst
   entstehen Zahlen, die Nutzer so nie sehen (WP-01: 34 % statt 3 % auf News).

## Ablauf für den Orchestrator

1. WP in `BOARD.md` anlegen, Brief in `tasks/` schreiben, Agent im Worktree starten, `START` ins Log.
2. Nach Rückmeldung: Diff prüfen, Tests im Haupt-Checkout nach dem Merge laufen lassen, mergen
   (`--no-ff`), Board/TODO/README aktualisieren, Ergebnis ins Log.
3. Konflikte zwischen WPs vermeiden, indem sich die erlaubten Dateien nicht überschneiden.
