// Enables the static "analytics" ruleset (rules/analytics.json: GameAnalytics, Unity Analytics/UGS, only requests
// from catanuniverse.com) while a community server is selected; the official servers are never affected (Privacy.cs).
// Enabled rulesets reset on extension update, hence the sync on install/startup as well as on every selection change.
const api = globalThis.browser ?? globalThis.chrome;

async function sync() {
  const { communitan } = await api.storage.local.get("communitan");
  const custom = !!communitan?.servers?.some((s) => s.Name === communitan.selected);
  await api.declarativeNetRequest.updateEnabledRulesets(
    custom ? { enableRulesetIds: ["analytics"] } : { disableRulesetIds: ["analytics"] },
  );
}

api.runtime.onInstalled.addListener(sync);
api.runtime.onStartup.addListener(sync);
api.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.communitan) sync();
});
