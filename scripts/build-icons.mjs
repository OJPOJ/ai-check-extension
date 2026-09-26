// Rendert extension/icons/icon.svg per Chromium (Playwright, bereits devDependency für die E2E-Tests)
// zu PNGs in den vom Store bzw. der Toolbar gebrauchten Größen. npm run build:icons.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const iconsDir = path.join(root, "extension", "icons");
const svgPath = path.join(iconsDir, "icon.svg");
const SIZES = [16, 32, 48, 128];

const svg = fs.readFileSync(svgPath, "utf8");
const html = `<!DOCTYPE html><html><head><style>
  html,body{margin:0;padding:0;background:transparent}
  svg{display:block}
</style></head><body>${svg}</body></html>`;

const browser = await chromium.launch({ channel: "chromium" });
try {
  for (const size of SIZES) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(html);
    await page.locator("svg").evaluate((el, s) => {
      el.setAttribute("width", String(s));
      el.setAttribute("height", String(s));
    }, size);
    const out = path.join(iconsDir, `icon-${size}.png`);
    await page.screenshot({ path: out, omitBackground: true });
    await page.close();
    console.log(`extension/icons/icon-${size}.png`);
  }
} finally {
  await browser.close();
}
