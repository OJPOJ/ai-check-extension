// Version straight from the manifest, so that it does not have to be maintained twice.
document.getElementById("version").textContent = chrome.runtime.getManifest().version;
