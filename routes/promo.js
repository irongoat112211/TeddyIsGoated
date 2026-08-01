const express = require("express");
const router = express.Router();
const { db } = require("../lib/database");
const { sanitizestr } = require("../lib/validation");
const playfab = require("../lib/playfab");
const webhook = require("../lib/webhook");
const discordbot = require("../lib/discordbot");

function respond(res, result, itemID, playFabItemName, startTime, endTime) {
  return res.json({ result, itemID, playFabItemName, startTime: startTime || null, endTime: endTime || null });
}

// Client-facing: POST /api/ConsumeCodeItem
// CodeRedemption.cs sends itemGUID as the promo code string
router.post("/ConsumeCodeItem", async (req, res) => {
  try {
    const body = req.body || {};
    const code = sanitizestr(body.itemGUID || "", 16).toUpperCase().trim();
    const playfabid = sanitizestr(body.playFabID || "", 64);
    const mothershipid = sanitizestr(body.mothershipId || "", 256);

    if (!code || code.length < 8) {
      return respond(res, "Invalid", null, null, null, null);
    }

    // Look up the code in redeemable_codes
    const row = db.prepare("SELECT * FROM redeemable_codes WHERE code = ? AND active = 1").get(code);
    if (!row) {
      return respond(res, "Invalid", null, null, null, null);
    }

    // Check time window
    const now = new Date();
    if (row.start_time) {
      const start = new Date(row.start_time);
      if (now < start) {
        return respond(res, "TooEarly", null, null, start.toISOString(), null);
      }
    }
    if (row.end_time) {
      const end = new Date(row.end_time);
      if (now > end) {
        return respond(res, "TooLate", null, null, null, end.toISOString());
      }
    }

    // Check usage limit
    if (row.max_uses >= 0 && row.use_count >= row.max_uses) {
      return respond(res, "AlreadyRedeemed", null, null, null, null);
    }

    // Check if this player already redeemed this code
    const already = db.prepare(
      "SELECT id FROM code_redemptions WHERE code = ? AND mothershipid = ?"
    ).get(code, mothershipid);
    if (already) {
      return respond(res, "AlreadyRedeemed", null, null, null, null);
    }

    // Record redemption
    db.prepare(
      "INSERT INTO code_redemptions (code_id, code, mothershipid, playfabid) VALUES (?, ?, ?, ?)"
    ).run(row.id, code, mothershipid, playfabid);

    db.prepare("UPDATE redeemable_codes SET use_count = use_count + 1 WHERE id = ?").run(row.id);

    // Grant item or link Discord account
    if (row.type === "discord_link") {
      // Link the Discord account to this game account
      if (row.discord_id) {
        db.prepare(
          "INSERT OR REPLACE INTO discord_links (discord_id, playfabid, mothershipid, linked_at) VALUES (?, ?, ?, datetime('now'))"
        ).run(row.discord_id, playfabid, mothershipid);
        console.log("[promo] Discord link: discord=" + row.discord_id + " playfab=" + playfabid + " mothership=" + mothershipid);
        // Audit log
        try {
          const pf = db.prepare("SELECT displayname FROM players WHERE playfabid = ?").get(playfabid);
          discordbot.sendChannelMessage("1513408264149274754", null, {
            color: 0x5865F2,
            description: "**Link Account**\n<@" + row.discord_id + "> (`" + row.discord_id + "`)\nLinked to: `" + playfabid + "` (" + (pf?.displayname || "?") + ")",
            timestamp: new Date().toISOString(),
          }).catch(() => {});
        } catch (_) {}
        // Notify Discord
        try {
          const pf = db.prepare("SELECT displayname FROM players WHERE playfabid = ?").get(playfabid);
          const oc = db.prepare("SELECT username FROM oculus_profiles WHERE userid = (SELECT userid FROM mothershipplayers WHERE mothershipid = ?)").get(mothershipid);
          webhook.send("misc", {
            color: 5763719,
            description: "## 🔗 Discord Account Linked\n<@" + row.discord_id + ">\n**↓ Details ↓**\n```[Discord ID] : " + row.discord_id + "\n[PlayFab ID] : " + (playfabid || "N/A") + "\n[PlayFab Name] : " + (pf?.displayname || "N/A") + "\n[Oculus Name] : " + (oc?.username || "N/A") + "\n```",
          });
        } catch (_) {}
        // Edit the original Discord link message to confirm
        if (row.discord_interaction_token) {
          discordbot.editInteractionResponse(row.discord_interaction_token, {
            content: "✅ <@" + row.discord_id + "> **Successfully linked!** Your Discord is now connected to your in-game account."
          }).catch(() => {});
        }
      }
    } else if (playfabid && row.playfab_item_name) {
      try {
        await playfab.grantitemstouser(playfabid, [row.playfab_item_name]);
      } catch (e) {
        console.log("[promo] grant item error:", e.message);
      }
    }

    return respond(res, "Success", row.item_id, row.playfab_item_name, null, null);
  } catch (err) {
    console.error("[promo/ConsumeCodeItem] Error:", err.message);
    return respond(res, "Error", null, null, null, null);
  }
});

// Client-facing: POST /api/ConsumeItem
// DeepLinkHandler.cs for cross-promo collab item consumption
router.post("/ConsumeItem", (req, res) => {
  try {
    const body = req.body || {};
    const itemguid = sanitizestr(body.itemGUID, 128);
    const mothershipid = sanitizestr(body.mothershipId, 256);
    const launchesource = sanitizestr(body.launchSource, 64);

    if (!itemguid || !mothershipid) {
      return res.status(400).send("InvalidRequest");
    }

    // Check for launch-source-specific validation
    const existing = db.prepare(
      "SELECT id FROM codeconsumptions WHERE mothershipid = ? AND itemguid = ?"
    ).get(mothershipid, itemguid);

    if (existing) {
      return res.send("AlreadyRedeemed");
    }

    db.prepare(
      "INSERT INTO codeconsumptions (mothershipid, playfabid, itemguid) VALUES (?, ?, ?)"
    ).run(mothershipid, body.playFabID || "", itemguid);

    return res.send("Success");
  } catch (err) {
    console.error("[promo/ConsumeItem] Error:", err.message);
    return res.status(500).send("Error");
  }
});

module.exports = router;
