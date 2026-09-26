// Version direkt aus dem Manifest, damit sie nicht doppelt gepflegt werden muss.
document.getElementById("version").textContent = chrome.runtime.getManifest().version;
