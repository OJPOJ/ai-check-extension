// Welcome page after installation (background.js, onInstalled). Download sizes from models.js,
// so that they are not maintained in two places.
for (const m of Object.values(AIVSAI_MODELS)) {
  if (!m.browser) continue;
  const name = document.createElement("b");
  name.textContent = `${m.title}: ${m.browser.download}`;
  const summary = document.createElement("span");
  summary.textContent = m.summary;
  document.getElementById("downloads").append(name, summary);
}
