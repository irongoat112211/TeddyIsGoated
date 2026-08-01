const express = require("express");
const router = express.Router();
const { sanitizestr } = require("../lib/validation");
const { db } = require("../lib/database");
const playfab = require("../lib/playfab");
const webhook = require("../lib/webhook");

router.post("/ConsumeOculusIAP", async (req, res) => {
  try {
    const body = req.body || {};
    const sku = sanitizestr(body.sku, 128);
    const mid = sanitizestr(body.mothershipId || body.MothershipId, 256);
    if (!sku) return res.status(400).json({ error: true });
    webhook.purchase(mid, sku, "IAP");
    return res.status(200).json({ result: true });
  } catch (err) {
    console.error("[iap] error:", err.message);
    return res.status(500).json({ error: true });
  }
});

function getPlayFabId(mothershipid) {
  if (!mothershipid) return null;
  const row = db.prepare(
    "SELECT p.playfabid FROM mothershipplayers m JOIN players p ON p.oculusid = m.userid WHERE m.mothershipid = ?"
  ).get(mothershipid);
  return row ? row.playfabid : null;
}

router.post("/GetMySubscriptionsAndTheirBenefits", async (req, res) => {
  try {
    const body = req.body || {};
    const mothershipid = sanitizestr(body.MothershipId, 256);
    const nowOff = new Date().toISOString();
    const monthLater = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    // Write subscription to PlayFab Shared Group so other players see it
    let sharedGroupOk = false;
    const playfabid = getPlayFabId(mothershipid);
    if (playfabid) {
      try {
        const sharedGroupId = playfabid + "Inventory";
        const subData = JSON.stringify({
          Sku: "fan_club",
          ExpirationTime: monthLater,
          TotalLifetimeSeconds: 0,
        });
        // Ensure shared group exists, then update
        await playfab.createsharedgroup(sharedGroupId).catch(() => {});
        const r = await playfab.updatesharedgroupdata(sharedGroupId, {
          "subscriptions.fan_club": subData,
        }, "Public");
        sharedGroupOk = r.status === 200;
        if (!sharedGroupOk) console.log("[iap/subs] shared group update failed:", r.status);
      } catch (e) {
        console.log("[iap/subs] shared group error:", e.message);
      }
    }

    return res.status(200).json({
      Subscriptions: [{
        SubscriptionId: "sub_" + Math.random().toString(36).substring(2, 10),
        EarliestStartDate: nowOff,
        CurrentStartDate: nowOff,
        MostRecentBillingCycleStartDate: nowOff,
        MostRecentBillingCycleEndDate: monthLater,
        TotalLifetimeSeconds: 0,
        IsActive: true,
        IsCancelling: false,
        Sku: "fan_club",
        PlayerId: mothershipid || "unknown",
        TrialType: "none",
        ExternalServiceName: "oculus",
        ExternalSubscriptionId: "",
        SubscriptionCatalogItemId: "",
      }],
      PreviouslyGrantedBenefitsBySubscriptionSku: null,
      NewlyGrantedBenefitsBySubscriptionSku: null,
      SharedGroupDataUpdateSucceeded: sharedGroupOk,
      CacheForOtherFunctionsSucceeded: true,
    });
  } catch (err) {
    console.error("[iap/subs] error:", err.message);
    return res.status(500).json({ Subscriptions: [] });
  }
});

module.exports = router;
