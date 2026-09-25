// Icon-Badge: Anzahl roter (sonst gelber) Absätze pro Tab, "AUS" wenn deaktiviert
import { getConfig } from "./scoring.js";

const BADGE_COLORS = { red: "#dc2626", yellow: "#a16207", green: "#16a34a", error: "#6b7280", off: "#6b7280" };

function badgeFor(enabled, stats) {
  if (!enabled) return { text: "AUS", color: BADGE_COLORS.off };
  if (stats?.error) return { text: "!", color: BADGE_COLORS.error };
  if (stats?.red) return { text: String(stats.red), color: BADGE_COLORS.red };
  if (stats?.yellow) return { text: String(stats.yellow), color: BADGE_COLORS.yellow };
  if (stats?.green) return { text: "✓", color: BADGE_COLORS.green };
  return { text: "", color: BADGE_COLORS.off };
}

export async function updateBadge(tabId, stats) {
  const { enabled } = await getConfig();
  const { text, color } = badgeFor(enabled, stats);
  const target = tabId === undefined ? {} : { tabId };
  try {
    await chrome.action.setBadgeText({ ...target, text });
    await chrome.action.setBadgeBackgroundColor({ ...target, color });
  } catch {
    // Tab wurde inzwischen geschlossen
  }
}
