const express = require("express");
const router = express.Router();
const config = require("../lib/config");
const playfab = require("../lib/playfab");
const { db, ensureplayer } = require("../lib/database");
const { sanitizestr } = require("../lib/validation");
const { authlimiter } = require("../middleware/ratelimit");
const activeplayers = require("../lib/activeplayers");
const webhook = require("../lib/webhook");
const discordbot = require("../lib/discordbot");

// ensure onlogin_grants table — tracks grant count for periodic re-grants
db.exec("CREATE TABLE IF NOT EXISTS onlogin_grants (playfabid TEXT PRIMARY KEY, count INTEGER DEFAULT 0, lastgrantat TEXT DEFAULT (datetime('now')))");
try { db.exec("ALTER TABLE onlogin_grants ADD COLUMN count INTEGER DEFAULT 0"); } catch (_) {}
try { db.exec("ALTER TABLE onlogin_grants ADD COLUMN lastgrantat TEXT DEFAULT ''"); } catch (_) {}
try { db.exec("UPDATE onlogin_grants SET count = 1 WHERE count = 0"); } catch (_) {}

const { ROLE_MAP: ROLE_ITEMS_MAP, OWNER_ITEMS, OWNER_DISCORD_ID, ALL_ROLE_ITEMS } = require("../lib/rolemap");
// Items that should never be auto-granted via bundle (pre-order, GT1, etc.)
const RESTRICTED_BUNDLE_ITEMS = ["LBAAA.","LBAAB.","LBAAC.","LBAAF.","LBAAG.","LBAAH.","LBAAI.","LBAAJ.","LBAAL.","LBAAM.","LBAAO."];

router.post("/PlayFabAuthentication", authlimiter, async (req, res) => {
  try {
    const body = req.body || {};
    const oculusid = sanitizestr(String(body.OculusId || "").replace(/^OCULUS/, ""), 64);
    const platform = sanitizestr(body.Platform, 16) || "Quest";
    const mothershipid = sanitizestr(body.MothershipId, 256);

    if (!oculusid) {
      return res.status(400).json({ Message: "Missing OculusId" });
    }

    const customid = "OCULUS" + oculusid;
    const result = await playfab.serverlogin(customid, true);

    if (result.status === 200 && result.data && result.data.data) {
      const d = result.data.data;
      const sessionticket = d.SessionTicket || "";
      const entitytoken = (d.EntityToken && d.EntityToken.EntityToken) || "";
      const playfabid = d.PlayFabId || "";
      const entityid = (d.EntityToken && d.EntityToken.Entity && d.EntityToken.Entity.Id) || "";
      const entitytype = (d.EntityToken && d.EntityToken.Entity && d.EntityToken.Entity.Type) || "";

      ensureplayer(playfabid);
      db.prepare(
        "UPDATE players SET oculusid = ?, platform = ?, sessionticket = ?, entitytoken = ?, entityid = ?, entitytype = ?, lastlogin = datetime('now') WHERE playfabid = ?"
      ).run(oculusid, platform, sessionticket, entitytoken, entityid, entitytype, playfabid);

      if (mothershipid) activeplayers.seen(mothershipid);

      let creationiso = new Date().toISOString();
      const row = db.prepare("SELECT createdat FROM players WHERE playfabid = ?").get(playfabid);
      if (row && row.createdat) {
        creationiso = new Date(row.createdat).toISOString();
      }

      return res.status(200).json({
        SessionTicket: sessionticket,
        EntityToken: entitytoken,
        PlayFabId: playfabid,
        EntityId: entityid,
        EntityType: entitytype,
        AccountCreationIsoTimestamp: creationiso,
      });
    }

    if (result.data && result.data.errorCode === 1002) {
      const errmsg = result.data.errorMessage || "Banned";
      const errdetails = result.data.errorDetails || {};
      const bankey = Object.keys(errdetails)[0] || errmsg;
      const banlist = errdetails[bankey] || [];
      const banexpiry = banlist.length > 0 ? banlist[0] : "Indefinite";
      return res.status(403).json({
        BanMessage: bankey,
        BanExpirationTime: banexpiry,
      });
    }

    console.error("[auth] playfab login failed:", result.status, typeof result.data === "string" ? result.data : JSON.stringify(result.data));
    return res.status(500).json({ Message: "Authentication failed" });
  } catch (err) {
    console.error("[auth] error:", err.message);
    return res.status(500).json({ Message: "Internal server error" });
  }
});

router.post("/CachePlayFabId", authlimiter, async (req, res) => {
  try {
    const body = req.body || {};
    const sessionticket = sanitizestr(body.SessionTicket, 512);
    const playfabid = sanitizestr(body.PlayFabId, 16);
    const platform = sanitizestr(body.Platform, 16);
    const mothershipid = sanitizestr(body.MothershipId, 256);

    if (!sessionticket) {
      return res.status(400).json({ Message: "Missing SessionTicket" });
    }

    const ticketid = sessionticket.split("-")[0];
    const resolvedid = playfabid || ticketid;

    if (!resolvedid || resolvedid.length !== 16) {
      return res.status(404).json({ Message: "Try Again Later." });
    }

    ensureplayer(resolvedid);
    db.prepare(
      "UPDATE players SET sessionticket = ?, platform = ?, lastlogin = datetime('now') WHERE playfabid = ?"
    ).run(sessionticket, platform || "Quest", resolvedid);

    if (mothershipid) activeplayers.seen(mothershipid);

    const row = db.prepare("SELECT createdat FROM players WHERE playfabid = ?").get(resolvedid);
    const creationiso = row && row.createdat ? new Date(row.createdat).toISOString() : new Date().toISOString();

    return res.status(200).json({
      PlayFabId: resolvedid,
      SteamAuthIdForPhoton: "",
      AccountCreationIsoTimestamp: creationiso,
    });
  } catch (err) {
    console.error("[cache] error:", err.message);
    return res.status(500).json({ Message: "Internal server error" });
  }
});

const recentgrants = new Map();

router.post("/OnLogin", async (req, res) => {
  const body = req.body || {};
  const envelope = body.PlayStreamEventEnvelope || {};
  const playfabid = sanitizestr(envelope.EntityId, 16);
  const profile = body.PlayerProfile || {};
  const displayName = sanitizestr(profile.DisplayName, 64) || "";
  const platform = envelope.Platform || "Quest";

  console.log("[auth/onlogin] playfabid=" + playfabid + " displayName=" + displayName + " platform=" + platform + " body=" + JSON.stringify({ hasProfile: !!body.PlayerProfile, envelopeKeys: Object.keys(envelope) }).slice(0, 300));

  // Extract user id from linked accounts or event data
  let oculusId = "";
  let steamId = "";
  try {
    // Try PlayerProfile linked accounts first
    const accounts = profile.LinkedAccounts || [];
    for (const acc of accounts) {
      if (acc.Platform === "CustomServer" && acc.PlatformUserId) {
        if (acc.PlatformUserId.startsWith("OCULUS")) {
          oculusId = acc.PlatformUserId.replace("OCULUS", "");
        } else if (acc.PlatformUserId.startsWith("STEAM_")) {
          steamId = acc.PlatformUserId;
        }
        break;
      }
    }
    // Fallback: parse from EventData
    if (!oculusId && !steamId) {
      try {
        const evtData = JSON.parse(envelope.EventData || "{}");
        const puid = evtData.PlatformUserId || "";
        if (puid.startsWith("OCULUS")) oculusId = puid.replace("OCULUS", "");
        else if (puid.startsWith("STEAM_")) steamId = puid;
      } catch {}
    }
  } catch {}

  // Resolve display name from PlayFab if not in event
  let resolvedDisplayName = displayName;
  if (!resolvedDisplayName) {
    try {
      const existing = db.prepare("SELECT displayname FROM players WHERE playfabid = ?").get(playfabid);
      if (existing && existing.displayname) resolvedDisplayName = existing.displayname;
    } catch {}
  }
  if (!resolvedDisplayName) {
    try {
      const pfResult = await playfab.getplayerprofile(playfabid);
      if (pfResult.status === 200 && pfResult.data && pfResult.data.data && pfResult.data.data.PlayerProfile && pfResult.data.data.PlayerProfile.DisplayName) {
        resolvedDisplayName = pfResult.data.data.PlayerProfile.DisplayName;
      }
    } catch {}
  }

  // Update player record with resolved data
  if (playfabid) {
    try {
      ensureplayer(playfabid);
      const updateFields = [];
      const updateVals = [];
      if (resolvedDisplayName) { updateFields.push("displayname = ?"); updateVals.push(resolvedDisplayName); }
      if (oculusId) { updateFields.push("oculusid = ?"); updateVals.push(oculusId); }
      if (updateFields.length > 0) {
        updateFields.push("lastlogin = datetime('now')");
        updateVals.push(playfabid);
        db.prepare("UPDATE players SET " + updateFields.join(", ") + " WHERE playfabid = ?").run(...updateVals);
      }

      // Cache oculus profile
      if (oculusId) {
        try {
          const existing = db.prepare("SELECT username FROM oculus_profiles WHERE userid = ?").get(oculusId);
          if (!existing) {
            db.prepare("INSERT OR REPLACE INTO oculus_profiles (userid, username, updatedat) VALUES (?,?,datetime('now'))").run(oculusId, resolvedDisplayName || "");
          }
        } catch {}
      }
    } catch (e) {
      console.log("[auth/onlogin] db update error:", e.message);
    }

    // Re-grant missing bundle items every ~10 logins
    const grantRow = db.prepare("SELECT count FROM onlogin_grants WHERE playfabid = ?").get(playfabid);
    if (!grantRow || grantRow.count % 10 === 0) {
      db.prepare("INSERT OR REPLACE INTO onlogin_grants (playfabid, count, lastgrantat) VALUES (?, COALESCE((SELECT count FROM onlogin_grants WHERE playfabid = ?), 0) + 1, datetime('now'))").run(playfabid, playfabid);
      // Get bundle contents and diff against inventory
      (async () => {
        try {
          const bundleItems = await playfab.getBundleItems("LBATSafw");
          const inv = await playfab.getuserinventory(playfabid);
          const owned = new Set((inv?.data?.data?.Inventory || []).map(i => i.ItemId));
          const missing = bundleItems.filter(id => !owned.has(id) && !ALL_ROLE_ITEMS.includes(id) && !RESTRICTED_BUNDLE_ITEMS.includes(id));
          if (missing.length) {
            await playfab.grantitemstouser(playfabid, missing, "DLC");
            console.log("[auth/onlogin] regrant OK count=" + ((grantRow?.count || 0) + 1) + " granted=" + missing.length);
          }
        } catch (e) { console.log("[auth/onlogin] regrant FAIL:", e.message); }
      })();
    } else {
      db.prepare("UPDATE onlogin_grants SET count = count + 1 WHERE playfabid = ?").run(playfabid);
    }

    // ─── Role item enforcement (every login) ─────────────────
    (async () => {
      try {
        const dl = db.prepare("SELECT discord_id FROM discord_links WHERE playfabid = ?").get(playfabid);
        if (!dl) return;
        const discordRoles = await discordbot.getMemberRoles(dl.discord_id);
        const earned = new Set();
        for (const roleId of discordRoles) {
          const items = ROLE_ITEMS_MAP[roleId];
          if (items) for (const item of items) earned.add(item);
        }
        if (dl.discord_id === OWNER_DISCORD_ID) {
          for (const item of OWNER_ITEMS) earned.add(item);
        }
        const inv = await playfab.getuserinventory(playfabid);
        const owned = new Map((inv?.data?.data?.Inventory || []).map(i => [i.ItemId, i.ItemInstanceId]));
        const toRevoke = ALL_ROLE_ITEMS.filter(id => owned.has(id) && !earned.has(id));
        if (toRevoke.length) {
          const instances = toRevoke.map(id => owned.get(id)).filter(Boolean);
          if (instances.length) {
            await playfab.adminRevokeInventoryItems(playfabid, instances);
            console.log("[auth/onlogin] revoked " + instances.length + " role items from " + playfabid);
          }
        }
        const toGrant = ALL_ROLE_ITEMS.filter(id => !owned.has(id) && earned.has(id));
        if (toGrant.length) {
          await playfab.grantitemstouser(playfabid, toGrant, "DLC");
          console.log("[auth/onlogin] granted " + toGrant.length + " role items to " + playfabid);
        }
      } catch (e) {
        console.log("[auth/onlogin] role enforce error:", e.message);
      }
    })();
  }

  webhook.login(playfabid, platform);
  res.status(200).json({ success: true });
});

module.exports = router;
