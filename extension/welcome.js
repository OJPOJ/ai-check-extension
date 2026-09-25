// Begrüßung nach der Installation (background.js, onInstalled). Download-Größen aus models.js,
// damit sie nicht an zwei Stellen gepflegt werden.
for (const m of Object.values(AIVSAI_MODELS)) {
  if (!m.browser) continue;
  const name = document.createElement("b");
  name.textContent = `${m.title}: ${m.browser.download}`;
  const summary = document.createElement("span");
  summary.textContent = m.summary;
  document.getElementById("downloads").append(name, summary);
}
