// Erzeugt Store-Screenshots (1280x800) aus test/harness.html und eine Werbekachel (440x280).
// Nutzt dieselbe Playwright-Infrastruktur wie die E2E-Tests (test/e2e/helpers.mjs) mit einem
// Fake-Backend, das Scores deterministisch nach Textlänge vergibt (wie in den Tests) - schnell,
// ohne Modell-Download, zeigt aber nur die Oberfläche, keine echten Bewertungen. Vor der
// Veröffentlichung durch echte Screenshots ersetzen bzw. gegenlesen (siehe store/CHECKLIST.md).
// npm run screenshots
import fs from "fs";
import path from "path";
import { chromium } from "playwright";
import { launchExtension, ROOT, sleep, startBackend } from "../test/e2e/helpers.mjs";

const outDir = path.join(ROOT, "store", "screenshots");
fs.mkdirSync(outDir, { recursive: true });

const harness = fs.readFileSync(path.join(ROOT, "test", "harness.html"), "utf8");

const backend = await startBackend();
const ext = await launchExtension({
  pages: { "harness.test": harness },
  viewport: { width: 1280, height: 800 }
});

try {
  await ext.configure({ provider: "local", localUrl: backend.url, sites: ["harness.test"], scanMode: "sites", lazyScan: false });
  const page = await ext.open("http://harness.test/");
  // wie in test/e2e/scan.test.mjs: warten, bis auch der nachgeladene Absatz bewertet und nichts mehr "pending" ist
  await page.waitForFunction(() => document.querySelector("#dynamic-slot p")?.dataset.aivsaiLevel, null, { timeout: 20_000 });
  await page.waitForFunction(() => !document.querySelector(".aivsai-pending"));
  await sleep(300); // Markierungen/Badges fertig zeichnen lassen
  await page.screenshot({ path: path.join(outDir, "1-scan.png") });

  await ext.options.bringToFront();
  // Panel des konfigurierten Providers zeigen, nicht das unbenutzte "Im Browser" (dessen
  // Download-Status hier ohnehin fehlschlägt, weil kein Offscreen-Dokument mit echtem Modell läuft).
  await ext.options.click('input[name="provider"][value="local"]');
  await ext.options.click("#save");
  await ext.options.waitForFunction(() => document.getElementById("status")?.textContent === "Gespeichert.");
  await ext.options.evaluate(() => document.getElementById("detection")?.scrollIntoView());
  await ext.options.screenshot({ path: path.join(outDir, "2-settings.png") });
} finally {
  await ext.close();
  await backend.close();
}

// Werbekachel 440x280: Icon + Name + Claim auf Marken-Indigo (--accent aus ui.css). Bewusst schlicht -
// echtes Grafikdesign müsste ein Mensch machen, das hier ist ein brauchbarer Platzhalter.
const icon = fs.readFileSync(path.join(ROOT, "extension", "icons", "icon-128.png")).toString("base64");
const tileHtml = `<!DOCTYPE html><html><head><style>
  html, body { margin: 0; width: 440px; height: 280px; background: #4f46e5;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: #fff;
    display: flex; flex-direction: column; align-items: center; justify-content: center; }
  img { width: 96px; height: 96px; border-radius: 20px; margin-bottom: 16px; }
  h1 { font-size: 26px; margin: 0; }
  p { font-size: 14px; margin: 6px 0 0; opacity: 0.85; }
</style></head><body>
  <img src="data:image/png;base64,${icon}" />
  <h1>AI Content Flag</h1>
  <p>Erkennt KI-Text, während du liest</p>
</body></html>`;

const browser = await chromium.launch({ channel: "chromium" });
try {
  const page = await browser.newPage({ viewport: { width: 440, height: 280 } });
  await page.setContent(tileHtml);
  await page.screenshot({ path: path.join(outDir, "promo-tile-440x280.png") });
} finally {
  await browser.close();
}

console.log(`store/screenshots/ geschrieben: ${outDir}`);
