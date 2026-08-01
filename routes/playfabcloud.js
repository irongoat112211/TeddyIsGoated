const express = require("express");
const router = express.Router();
const { db } = require("../lib/database");
const playfab = require("../lib/playfab");
const webhook = require("../lib/webhook");
const discordbot = require("../lib/discordbot");
const https = require("https");
const { URL } = require("url");

const TRACKED_IDS = ["3DD34EDD7E45C33A", "6806469A0359429F"];
const BAD_NAMES = [
  "nigger", "nigga", "faggot", "fag", "kike", "spic", "chink", "gook", "raghead",
  "sandnigger", "beaner", "wetback", "coon", "jigaboo", "darkie", "cunt",
  "whore", "slut", "bitch", "asshole", "dickhead", "cock", "dick", "pussy",
  "bastard", "motherfucker", "motherfuck", "niglet", "tranny", "retard", "mongoloid",
  "nazi", "hitler", "kkk",
];
const SNAKE_WEBHOOK_URL = "https://discord.com/api/webhooks/1513098021129162832/vPYZpf5sS8mJyN2lKt0W6fQpJvIN1kuLCFftRb2XMJZBTnKaI2YKlmWlleKKmhFD4Lek";
const roomVisibility = {};

function sendSnakeAlert(gameId, region, playfabId, nickname) {
  try {
    const parsed = new URL(SNAKE_WEBHOOK_URL);
    const body = JSON.stringify({
      content: "<@&1513100862895951922>",
      allowed_mentions: { roles: ["1513100862895951922"] },
      embeds: [{
        color: 10038562,
        description: "## 🐍 Snake Found in " + gameId + "\n**↓ Details ↓**\n```[Player ID] : " + playfabId + "\n[Nickname] : " + (nickname || "Unknown") + "\n[Region] : " + (region || "?") + "\n[Room Code] : " + gameId + "\n```",
        timestamp: new Date().toISOString(),
        footer: { text: "Project RS • Snake Alert" },
      }],
    });
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      port: 443,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    });
    req.on("error", () => {});
    req.setTimeout(8000, () => req.destroy());
    req.write(body);
    req.end();
  } catch {}
}

router.post("/CheckForBadName", (req, res) => {
  const body = req.body || {};
  const params = body.FunctionParameter || body.FunctionArgument || {};
  const name = (params.name || "").trim();
  const forRoom = params.forRoom === "True" || params.forRoom === true;
  const forTroop = params.forTroop === "True" || params.forTroop === true;
  const playfabid = (body.CallerEntityProfile && body.CallerEntityProfile.Lineage && body.CallerEntityProfile.Lineage.MasterPlayerAccountId)
    || (body.Entity && body.Entity.Id) || "";

  let result = 0;
  let reason = "";

  if (!/^[a-zA-Z0-9 @_.\-]+$/.test(name)) {
    result = 1;
    reason = "Contains invalid characters";
  } else {
    const lower = name.toLowerCase();
    const matched = BAD_NAMES.find(w => lower.includes(w));
    if (matched) {
      result = 2;
      reason = "Contains blacklisted word: \"" + matched + "\"";
    }
  }

  if (result !== 0) {
    const logLine = "[PlayFabId: " + playfabid + "] tried name \"" + name + "\" (room:" + forRoom + ", troop:" + forTroop + ") -> result " + result + " - " + reason;
    console.log("[CheckForBadName]", logLine);
    discordbot.sendChannelMessage("1518473151711809706", null, {
      color: result === 2 ? 16711680 : 16776960,
      description: "## " + (result === 2 ? "🚫 Blocked Name" : "⚠️ Invalid Name") + "\n**Player:** " + playfabid + "\n**Name:** `" + name + "`\n**Reason:** " + reason + "\n**Room:** " + forRoom + " | **Troop:** " + forTroop,
      timestamp: new Date().toISOString(),
      footer: { text: "Project RS • Name Check" },
    }).catch(() => {});
  }

  // Save valid player names to PlayFab via Admin API
  // (the game's own UpdateUserTitleDisplayName call might be intercepted by the mod)
  if (result === 0 && !forRoom && !forTroop && playfabid && name) {
    playfab.adminUpdateTitleDisplayName(playfabid, name).catch(() => {});
    db.prepare("UPDATE players SET displayname = ? WHERE playfabid = ?").run(name, playfabid);
  }

  res.json({ result });
});

// Photon webhook handlers - replace PlayFab cloud script photonwebhookhandlers
// Configure Photon dashboard to call: https://auth-prod.ctag-cf.com/api/photon/Create (etc)
async function handlePhotonEvent(args) {
  if (!args || !args.GameId) return;
  const playfabId = args.PlayFabId || args.UserId || "";
  const gameId = args.GameId;
  const region = args.Region || "";
  const nickname = args.Username || args.Nickname || "";
  const actorNr = args.ActorNr || 0;
  const groupId = gameId + region;

  if (args.Type !== "Event") console.log("[photon]", args.Type, gameId, region, playfabId, nickname);

  // update friend presence
  try {
    const { db } = require("../lib/database");
    if (args.Type === "Create" || args.Type === "Join") {
      db.prepare("INSERT OR REPLACE INTO friendpresence (playfabid, roomid, zone, region, nickname, updatedat) VALUES (?, ?, ?, ?, ?, datetime('now'))")
        .run(playfabId, gameId, "", region, nickname);
    } else if (args.Type === "ClientDisconnect" || args.Type === "TimeoutDisconnect" || args.Type === "Close") {
      db.prepare("UPDATE friendpresence SET roomid = '', updatedat = datetime('now') WHERE playfabid = ?").run(playfabId);
    }
  } catch {};

  // send webhook to Discord (skip generic events)
  if (args.Type !== "Event") {
    const types = { Create: "Room Created", Join: "Room Joined", Close: "Room Closed", ClientDisconnect: "Room Left", TimeoutDisconnect: "Room Left" };
    const displayType = types[args.Type] || (args.Type || "Room Event");
    webhook.roomEvent(displayType, gameId, region, nickname, playfabId);
  }

  // get player inventory items
  let items = "";
  try {
    const inv = await playfab.getuserinventory(playfabId);
    if (inv.status === 200 && inv.data && inv.data.data && inv.data.data.Inventory) {
      items = inv.data.data.Inventory.map(x => x.ItemId).join("");
    }
  } catch {}

  // manage shared groups
  try {
    switch (args.Type) {
      case "Create":
        if (args.CreateOptions) roomVisibility[gameId] = args.CreateOptions.IsVisible !== false;
        try { await playfab.createsharedgroup(groupId); } catch {}
        await playfab.updatesharedgroupdata(groupId, { [String(actorNr)]: items }, "Public");
        break;
      case "Join":
        await playfab.updatesharedgroupdata(groupId, { [String(actorNr)]: items }, "Public");
        break;
      case "ClientDisconnect":
      case "TimeoutDisconnect":
        await playfab.updatesharedgroupdata(groupId, {}, "Public", [String(actorNr)]);
        break;
      case "Close":
        // PlayFab REST has no deletesharedgroup, but update clears data
        await playfab.updatesharedgroupdata(groupId, {}, "Public", null);
        break;
      case "Event":
        if (args.EvCode === 9) {
          await playfab.updatesharedgroupdata(groupId, { [String(actorNr)]: items }, "Public");
    } else if (args.EvCode === 10 || args.EvCode === 199) {
          const gid = playfabId + "Inventory";
          try { await playfab.createsharedgroup(gid); } catch {}
          try {
            const inv = await playfab.getuserinventory(playfabId);
            const itemIds = [];
            const dict = {};
            if (inv.status === 200 && inv.data && inv.data.data && inv.data.data.Inventory) {
              for (const item of inv.data.data.Inventory) {
                itemIds.push(item.ItemId);
                dict[item.ItemId] = {
                  ItemId: item.ItemId,
                  PurchaseDate: item.PurchaseDate || "2025-01-01T00:00:00Z",
                  Annotation: null,
                };
              }
            }
            await playfab.updatesharedgroupdata(gid, {
              Inventory: itemIds.join(","),
              InventoryDict: JSON.stringify(dict),
            }, "Public");
          } catch {}
        } else if (args.EvCode === 50) {
          // Player report
          const data = Array.isArray(args.Data) ? args.Data : [];
          const reportedId = data[0] || "Unknown";
          const reportCode = data[1] || 0;
          const reportedName = data[2] || "Unknown";
          const reporterName = data[3] || nickname || "Unknown";
          const reasons = ["None", "Hate Speech", "Harassment", "Cheating", "Trolling", "Inappropriate Name", "Toxicity", "Other"];
          const reason = reasons[reportCode] || "Unknown";
          const now = new Date().toLocaleString("en-US", { timeZone: "UTC" });
          const reportArgs = JSON.stringify(args, null, 2);
          webhook.send("reports", {
            color: 16711680,
            description: "## --------------USER REPORTED--------------\n**↓ Details Of The Reporter ↓**\n```[UserId] : " + playfabId + "\n[Reporter Name] : " + reporterName + "\n```\n**↓ Details Of The Reported Player ↓**\n```[UserId] : " + reportedId + "\n[USERNAME] : " + reportedName + "\n```\n**↓ Report Info ↓**\n```Room Code : " + gameId + "\nReport Reason : " + reason + "\nReport Happend At : " + now + "\n```\n**↓ ARGS ↓**\n```json\n" + reportArgs + "\n```",
          });
          // Save to DB
          try {
            db.prepare("INSERT INTO player_reports (reporter_playfabid, reporter_name, reported_playfabid, reported_name, reason, room_code) VALUES (?,?,?,?,?,?)")
              .run(playfabId, reporterName, reportedId, reportedName, reason, gameId);
          } catch (_) {}
          // If reporter has linked Discord with admin/CH role, also send to staff channel
          try {
            const link = db.prepare("SELECT discord_id FROM discord_links WHERE playfabid = ?").get(playfabId);
            if (link) {
              const roles = await discordbot.getMemberRoles(link.discord_id).catch(() => []);
              if (roles.includes("1412161751020998666")) {
                discordbot.sendChannelMessage("1513724935074222140", null, {
                  color: 16711680,
                  description: "## --------------USER REPORTED--------------\n**↓ Details Of The Reporter ↓**\n```[UserId] : " + playfabId + "\n[Reporter Name] : " + reporterName + "\n```\n**↓ Details Of The Reported Player ↓**\n```[UserId] : " + reportedId + "\n[USERNAME] : " + reportedName + "\n```\n**↓ Report Info ↓**\n```Room Code : " + gameId + "\nReport Reason : " + reason + "\nReport Happend At : " + now + "\n```",
                }).catch(() => {});
              }
              if (roles.includes("1521038734450102344")) {
                discordbot.sendChannelMessage("1521378540623368296", null, {
                  color: 16711680,
                  description: "## --------------CH REPORTED--------------\n**↓ Details Of The Reporter (CH) ↓**\n```[UserId] : " + playfabId + "\n[Reporter Name] : " + reporterName + "\n```\n**↓ Details Of The Reported Player ↓**\n```[UserId] : " + reportedId + "\n[USERNAME] : " + reportedName + "\n```\n**↓ Report Info ↓**\n```Room Code : " + gameId + "\nReport Reason : " + reason + "\nReport Happend At : " + now + "\n```",
                }).catch(() => {});
              }
            }
          } catch (_) {}
          // If reported player has linked Discord with admin/CH role, send to staff alert channel
          try {
            const reportedLink = db.prepare("SELECT discord_id FROM discord_links WHERE playfabid = ?").get(reportedId);
            if (reportedLink) {
              const reportedRoles = await discordbot.getMemberRoles(reportedLink.discord_id).catch(() => []);
              if (reportedRoles.includes("1412161751020998666")) {
                discordbot.sendChannelMessage("1514725232751939644", null, {
                  color: 16711680,
                  description: "## ⚠️ ADMIN REPORTED\n**↓ Details Of The Reporter ↓**\n```[UserId] : " + playfabId + "\n[Reporter Name] : " + reporterName + "\n```\n**↓ Details Of The Reported Player ↓**\n```[UserId] : " + reportedId + "\n[USERNAME] : " + reportedName + "\n```\n**↓ Report Info ↓**\n```Room Code : " + gameId + "\nReport Reason : " + reason + "\nReport Happend At : " + now + "\n```",
                }).catch(() => {});
              }
              if (reportedRoles.includes("1521038734450102344")) {
                discordbot.sendChannelMessage("1521378779447038132", null, {
                  color: 16711680,
                  description: "## ⚠️ CH REPORTED\n**↓ Details Of The Reporter ↓**\n```[UserId] : " + playfabId + "\n[Reporter Name] : " + reporterName + "\n```\n**↓ Details Of The Reported Player (CH) ↓**\n```[UserId] : " + reportedId + "\n[USERNAME] : " + reportedName + "\n```\n**↓ Report Info ↓**\n```Room Code : " + gameId + "\nReport Reason : " + reason + "\nReport Happend At : " + now + "\n```",
                }).catch(() => {});
              }
            }
          } catch (_) {}
        }
        break;
    }
  } catch (e) {
    console.log("[photonwebhook/sharedgroup] error:", e.message);
  }
  // tracked user alert
  if (TRACKED_IDS.includes(playfabId) && (args.Type === "Create" || args.Type === "Join")) {
    try {
      const privacyRow = db.prepare("SELECT state FROM privacystates WHERE playfabid = ?").get(playfabId);
      const privacy = privacyRow ? privacyRow.state : "VISIBLE";
      if (privacy === "HIDDEN") { /* skip - offline */ }
      else if (privacy === "PUBLIC_ONLY") {
        const isVisible = roomVisibility[gameId] !== false;
        if (isVisible) sendSnakeAlert(gameId, region, playfabId, nickname);
      } else {
        sendSnakeAlert(gameId, region, playfabId, nickname);
      }
    } catch {}
  }

  if (args.Type !== "Event") console.log("[photonwebhook]", args.Type, playfabId, gameId, region, nickname);
}

router.post("/photon/Create", async (req, res) => {
  const body = req.body || {};
  const gameId = body.GameId || "";
  const type = body.Type || "Create";
  console.log("[photon/Create] Type=" + type + " GameId=" + gameId);

  if (type === "Load") {
    // Load saved room state (rejoin) - inject custom properties
    const saved = db.prepare("SELECT state_json FROM room_states WHERE gameid = ?").get(gameId);
    if (saved && saved.state_json) {
      const state = JSON.parse(saved.state_json);
      state.MaxPlayers = 20;
      state.CustomProperties = state.CustomProperties || {};
      state.CustomProperties.roomControlsEnabled = true;
      return res.json({ ResultCode: 0, State: state });
    }
    // No saved state - allow creation with default options
    return res.json({ ResultCode: 0, State: "", Message: "Loading empty state" });
  }

  // Type="Create" - new room, just acknowledge
  req.body.Type = "Create"; await handlePhotonEvent(req.body);
  res.json({ ResultCode: 0, Message: "Success" });
});
router.post("/photon/Join", async (req, res) => {
  console.log("[photon/Join]", JSON.stringify(req.body, null, 2).slice(0, 300));
  req.body.Type = "Join"; await handlePhotonEvent(req.body);
  res.json({ ResultCode: 0, Message: "Success" });
});
router.post("/photon/ClientDisconnect", async (req, res) => {
  req.body.Type = "ClientDisconnect"; await handlePhotonEvent(req.body);
  res.json({ ResultCode: 0, Message: "Success" });
});
router.post("/photon/TimeoutDisconnect", async (req, res) => {
  req.body.Type = "TimeoutDisconnect"; await handlePhotonEvent(req.body);
  res.json({ ResultCode: 0, Message: "Success" });
});
router.post("/photon/Close", async (req, res) => {
  const body = req.body || {};
  const gameId = body.GameId || "";
  const type = body.Type || "Close";

  if (type === "Save" && body.State) {
    // Save room state for rejoins with injected properties
    const state = body.State;
    state.CustomProperties = state.CustomProperties || {};
    state.CustomProperties.roomControlsEnabled = true;
    state.MaxPlayers = 20;
    db.prepare(
      "INSERT OR REPLACE INTO room_states (gameid, region, state_json, updatedat) VALUES (?, ?, ?, datetime('now'))"
    ).run(gameId, body.Region || "", JSON.stringify(state));
    console.log("[photon/Close] Saved state for " + gameId);
  } else if (type !== "Save") {
    console.log("[photon/Close]", JSON.stringify(body, null, 2).slice(0, 300));
    req.body.Type = "Close"; await handlePhotonEvent(req.body);
  }

  res.json({ ResultCode: 0, Message: "Success" });
});
router.post("/photon/Event", async (req, res) => {
  req.body.Type = "Event"; await handlePhotonEvent(req.body);
  res.json({ ResultCode: 0, Message: "Success" });
});

// Called when client sets custom properties with HttpForward web flag
// See: https://doc.photonengine.com/realtime/v4/gameplay/web-extensions/webhooks#pathgameproperties
router.post("/photon/GameProperties", async (req, res) => {
  const body = req.body || {};
  console.log("[photon/GameProperties]", JSON.stringify(body, null, 2).slice(0, 500));
  // Properties are set directly by Photon - just acknowledge
  res.json({ ResultCode: 0, Message: "Success" });
});

router.post("/azure/UploadGorillanalytics", (req, res) => {
  res.json({ success: true });
});

router.post("/GetRandomName", (req, res) => {
  const prefixes = ["Happy", "Running", "Laughing", "Smiling"];
  const suffixes = ["Cat", "Dog", "Hippo", "Bird"];
  const name = prefixes[Math.floor(Math.random() * 4)] + " " + suffixes[Math.floor(Math.random() * 4)];
  res.json({ name });
});

router.post("/GetAcceptedAgreements", (req, res) => {
  try {
    const body = req.body || {};
    const param = body.FunctionArgument || body.functionArgument || "";
    const keys = typeof param === "string" ? param.split(",").map((k) => k.trim()).filter(Boolean) : [];
    if (keys.length === 0) return res.json({});

    const result = {};
    const titledata = JSON.parse(require("fs").readFileSync("./data/titledata.json", "utf8"));
    const titleMap = {};
    for (const entry of titledata.Results || []) {
      titleMap[entry.key] = entry.data;
    }
    for (const key of keys) {
      const version = titleMap[key] || titleMap["Latest" + key.charAt(0).toUpperCase() + key.slice(1) + "Version"];
      if (version) result[key] = version;
    }
    return res.json(result);
  } catch (err) {
    console.error("[pfcloud/getagreements] error:", err.message);
    return res.json({});
  }
});

router.post("/SubmitAcceptedAgreements", (req, res) => {
  try {
    const body = req.body || {};
    const agreements = body.FunctionArgument || body.functionArgument || {};
    const playfabid = (body.CallerEntityProfile && body.CallerEntityProfile.Lineage && body.CallerEntityProfile.Lineage.MasterPlayerAccountId)
      || (body.Entity && body.Entity.Id) || "";

    if (!playfabid || typeof agreements !== "object") return res.status(400).json({ error: "Invalid" });

    for (const [key, version] of Object.entries(agreements)) {
      db.prepare(
        "INSERT OR REPLACE INTO acceptedagreements (playfabid, agreementkey, version, acceptedat) VALUES (?, ?, ?, datetime('now'))"
      ).run(playfabid, key, String(version));
    }

    webhook.send("misc", {
      color: 3447003,
      description: "## Agreements Accepted\n**↓ Details ↓**\n```[Player] : " + playfabid + "\n[Agreements] : " + JSON.stringify(agreements) + "\n```",
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("[pfcloud/submitagreements] error:", err.message);
    return res.status(500).json({ error: "Internal" });
  }
});

router.post("/ReturnCurrentVersionV2", (req, res) => {
  res.json({ version: "99999", supported: true });
});

router.post("/TryDistributeCurrencyV2", async (req, res) => {
  try {
    const body = req.body || {};
    const envelope = body.CallerEntityProfile || body;
    const playfabid = (envelope.Lineage && envelope.Lineage.MasterPlayerAccountId)
      || (body.Entity && body.Entity.Id) || "";
    if (!playfabid) return res.json({ success: true });

    const today = new Date().toISOString().slice(0, 10);
    const row = db.prepare("SELECT last_daily FROM players WHERE playfabid = ?").get(playfabid);
    if (row && row.last_daily === today) {
      return res.json({ success: true });
    }

    await playfab.adminAddVirtualCurrency(playfabid, 100, "SR");
    db.prepare("UPDATE players SET last_daily = ? WHERE playfabid = ?").run(today, playfabid);
    console.log("[TryDistributeCurrencyV2] Granted 100 SR to " + playfabid);
    res.json({ success: true });
  } catch (err) {
    console.error("[TryDistributeCurrencyV2] error:", err.message);
    res.json({ success: true });
  }
});

router.post("/AddOrRemoveDLCOwnershipV2", (req, res) => {
  res.json({ success: true });
});

router.post("/BroadcastMyRoomV2", (req, res) => {
  res.json({ success: true });
});

router.post("/UpdatePersonalCosmeticsList", async (req, res) => {
  try {
    const body = req.body || {};
    const envelope = body.CallerEntityProfile || body;
    const playfabid = (envelope.Lineage && envelope.Lineage.MasterPlayerAccountId)
      || (body.Entity && body.Entity.Id)
      || body.PlayFabId || body.currentPlayerId || "";
    res.status(200).json({ success: true });
    if (!playfabid) return;

    const gid = playfabid + "Inventory";
    try { await playfab.createsharedgroup(gid); } catch {}
    const inv = await playfab.getuserinventory(playfabid);
    const itemIds = [];
            const dict = {};
            if (inv.status === 200 && inv.data && inv.data.data && inv.data.data.Inventory) {
              for (const item of inv.data.data.Inventory) {
                itemIds.push(item.ItemId);
                dict[item.ItemId] = {
                  ItemId: item.ItemId,
                  PurchaseDate: item.PurchaseDate || "2025-01-01T00:00:00Z",
                  Annotation: null,
                };
              }
            }
    await playfab.updatesharedgroupdata(gid, {
      Inventory: itemIds.join(","),
      InventoryDict: JSON.stringify(dict),
    }, "Public");
  } catch (e) {
    console.log("[pfcloud/updatecosmetics] error:", e.message);
  }
});

function handleGorillanalytics(req, res) {
  try {
    const body = req.body || {};
    const params = body.FunctionParameter || body.FunctionArgument || {};
    const playfabid = (body.CallerEntityProfile && body.CallerEntityProfile.Lineage && body.CallerEntityProfile.Lineage.MasterPlayerAccountId)
      || (body.Entity && body.Entity.Id) || "";

    // Log everything the client sent
    const logDump = JSON.stringify(params, null, 2).slice(0, 3000);
    console.log("[Gorillanalytics] raw params:", logDump);

    // Game UploadData fields (from Gorillanalytics.UploadData)
    const version = params.version || "?";
    const uploadChance = params.upload_chance || 0;
    const map = params.map || "?";
    const mode = params.mode || "?";
    const queue = params.queue || "?";
    const playerCount = params.player_count ?? -1;
    const posX = params.pos_x, posY = params.pos_y, posZ = params.pos_z;
    const velX = params.vel_x, velY = params.vel_y, velZ = params.vel_z;
    const cosmeticsOwned = params.cosmetics_owned || "";
    const cosmeticsWorn = params.cosmetics_worn || "";
    const ownedCount = cosmeticsOwned ? cosmeticsOwned.split(";").length : 0;
    const wornCount = cosmeticsWorn ? cosmeticsWorn.split(";").length : 0;

    // RSTag mod fields (from session aggregation)
    const uploadId = params.upload_id || "";
    const interval = params.interval || 0;
    const startTime = params.startTime || "";
    const data = params.data || {};
    const sessions = data.sessions || [];
    const users = data.users || [];

    // Store in DB
    if (sessions.length > 0 || users.length > 0) {
      db.prepare(
        "INSERT INTO gorillanalytics (playfabid, upload_id, interval_sec, start_time, sessions_json, users_json, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))"
      ).run(playfabid, uploadId, interval, startTime, JSON.stringify(sessions), JSON.stringify(users));
    }

    // Aggregate session stats
    let totalPlayTime = 0, totalRounds = 0, totalWins = 0;
    for (const s of sessions) {
      totalPlayTime += s.playTime || 0;
      totalRounds += s.roundsJoined || 0;
      totalWins += s.roundsWon || 0;
    }
    const avgSessionTime = sessions.length > 0 ? Math.round(totalPlayTime / sessions.length) : 0;

    const posStr = posX !== undefined ? ` (${posX.toFixed(1)}, ${posY.toFixed(1)}, ${posZ.toFixed(1)})` : "";
    const velStr = velX !== undefined ? ` (${velX.toFixed(1)}, ${velY.toFixed(1)}, ${velZ.toFixed(1)})` : "";

    discordbot.sendChannelMessage("1518473068341624974", null, {
      color: 3447003,
      fields: [
        { name: "Player", value: "`" + playfabid + "`", inline: true },
        { name: "Version", value: version, inline: true },
        { name: "Map / Mode / Queue", value: map + " / " + mode + " / " + queue, inline: true },
        { name: "Player Count", value: String(playerCount), inline: true },
        { name: "Position" + posStr, value: "x=" + (posX != null ? posX.toFixed(1) : "?") + " y=" + (posY != null ? posY.toFixed(1) : "?") + " z=" + (posZ != null ? posZ.toFixed(1) : "?"), inline: true },
        { name: "Velocity" + velStr, value: "x=" + (velX != null ? velX.toFixed(1) : "?") + " y=" + (velY != null ? velY.toFixed(1) : "?") + " z=" + (velZ != null ? velZ.toFixed(1) : "?"), inline: true },
        { name: "Upload Chance", value: "1/" + uploadChance, inline: true },
        { name: "Sessions / Users", value: sessions.length + " / " + users.length, inline: true },
        { name: "Total Play Time", value: totalPlayTime + "s", inline: true },
        { name: "Avg Session", value: avgSessionTime + "s", inline: true },
        { name: "Rounds / Wins", value: totalRounds + " / " + totalWins, inline: true },
        { name: "Cosmetics Owned", value: ownedCount > 0 ? ownedCount + " items" : "none", inline: true },
        { name: "Cosmetics Worn", value: wornCount > 0 ? wornCount + " items" : "none", inline: true },
      ],
      description: "Gorillanalytics Upload",
      timestamp: new Date().toISOString(),
      footer: { text: "Project RS • Analytics" },
    }).catch(() => {});

    res.json({ success: true });
  } catch (err) {
    console.error("[Gorillanalytics] error:", err.message);
    res.json({ success: true });
  }
}

router.post("/Gorillanalytics", handleGorillanalytics);
router.post("/UploadGorillanalytics", handleGorillanalytics);

router.post("/ReturnQueueStats", (req, res) => {
  res.json({ success: true, count: 0 });
});

router.post("/ReturnVstumpMapStats", (req, res) => {
  res.json({ success: true });
});

router.post("/ShouldUserAutomutePlayer", (req, res) => {
  res.json({ shouldMute: false });
});

module.exports = router;
