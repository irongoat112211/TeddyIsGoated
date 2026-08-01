const express = require("express");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { v4: genuuid } = require("uuid");
const path = require("path");
const fs = require("fs");
const config = require("../lib/config");
const { privatekey } = require("../lib/mothership-keys");
const { db, ensureplayer } = require("../lib/database");
const { sanitizestr } = require("../lib/validation");
const { getrequest } = require("../lib/httpclient");
const { authlimiter } = require("../middleware/ratelimit");
const { requiremothershiptoken } = require("../middleware/auth");
const activeplayers = require("../lib/activeplayers");
const webhook = require("../lib/webhook");
const playfab = require("../lib/playfab");
const discordbot = require("../lib/discordbot");

const router = express.Router();

const pendingnonces = {};
const logdir = path.join(__dirname, "..");

function logfile(name, data) {
  const line = `[${new Date().toISOString()}] ${data}\n`;
  fs.appendFileSync(path.join(logdir, name), line);
}

function issuetoken(playerid, userid, platform) {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 7200;

  const payload = {
    sub: playerid,
    did: config.mothershipdeploymentid,
    env: config.mothershipenvid,
    externalService: platform,
    externalServiceId: userid,
    tid: config.mothershiptitleid,
    tags: null,
    orgScopedExternalServiceId: userid,
    nbf: now,
    exp: exp,
    iat: now,
  };

  const token = jwt.sign(payload, privatekey, { algorithm: "ES256", header: { alg: "ES256" } });
  return { token, exp: exp * 1000 };
}

function ensuremothershipplayer(userid, platform) {
  let row = db.prepare("SELECT * FROM mothershipplayers WHERE userid = ?").get(userid);
  if (!row) {
    const mothershipid = genuuid();
    db.prepare(
      "INSERT INTO mothershipplayers (userid, mothershipid, platform) VALUES (?, ?, ?)"
    ).run(userid, mothershipid, platform);
    row = db.prepare("SELECT * FROM mothershipplayers WHERE userid = ?").get(userid);
  }
  return row;
}

function buildauthresponse(player, token, expms) {
  return {
    ExternalProviderId: player.userid,
    ExternalProviderUsername: "",
    IsPrimaryId: true,
    PlayerId: player.mothershipid,
    Tags: null,
    Token: token,
    ServerTime: Date.now(),
    ExpirationTime: expms,
  };
}

// RIFT / PC auth (single-step)
router.post("/v1/client/player/auth/RIFT", authlimiter, (req, res) => {
  try {
    const body = req.body || {};
    const userid = sanitizestr(body.UserId, 64);

    if (!userid) {
      return res.status(400).json({ error: "Missing UserId" });
    }

    const player = ensuremothershipplayer(userid, "RIFT");

    // only reuse cached token if >30min remaining (avoids clock drift error)
    if (player.token && player.expirationtime > Date.now() + 1800000) {
      activeplayers.seen(player.mothershipid);
      return res.status(201).json(buildauthresponse(player, player.token, player.expirationtime));
    }

    const { token, exp } = issuetoken(player.mothershipid, userid, "RIFT");

    db.prepare(
      "UPDATE mothershipplayers SET token = ?, expirationtime = ?, lastlogin = datetime('now') WHERE userid = ?"
    ).run(token, exp, userid);

    activeplayers.seen(player.mothershipid);
    return res.status(201).json(buildauthresponse(player, token, exp));
  } catch (err) {
    console.error("[mothership/auth/rift] error:", err.message);
    return res.status(401).json({
      message: JSON.stringify({
        MothershipErrorCode: 10013,
        ClientMessage: "Client Authentication Failed",
        TraceId: genuuid(),
      }),
      statusCode: 401,
    });
  }
});

// Quest auth step 1 (two-step)
router.post("/v2/player/client/auth/begin/QUEST", authlimiter, (req, res) => {
  try {
    const body = req.body || {};
    const userid = sanitizestr(body.UserId, 64);

    if (!userid) {
      return res.status(400).json({ error: "Missing UserId" });
    }

    const noncebuf = crypto.randomBytes(64);
    const nonce = noncebuf.toString("base64url");
    pendingnonces[userid] = { nonce, created: Date.now() };

    logfile("auth-begin.log", JSON.stringify({ nonce: nonce, userId: userid }));

    const cutoff = Date.now() - 300000;
    for (const uid of Object.keys(pendingnonces)) {
      if (pendingnonces[uid].created < cutoff) {
        delete pendingnonces[uid];
      }
    }

    const resp = { AttestationNonce: nonce };
    logfile("auth-begin-resp.log", JSON.stringify(resp));
    return res.status(201).json(resp);
  } catch (err) {
    console.error("[mothership/auth/begin] error:", err.message);
    return res.status(500).json({ error: "Internal error" });
  }
});

// Quest auth step 2 (two-step)
router.post("/v2/player/client/auth/complete/QUEST", authlimiter, async (req, res) => {
  const successcode = 201;
  const statuscode = 401;
  try {
    const body = req.body || {};
    const userid = sanitizestr(body.UserId, 64);
    const attestationtoken = body.AttestationToken;
    const pending = pendingnonces[userid];

    logfile("auth-complete.log", JSON.stringify({ userId: userid, hasToken: !!attestationtoken, hasNonce: !!pending }));

    if (!userid || !attestationtoken || !pending) {
      logfile("auth-complete-resp.log", "FAIL: missing fields");
      return res.status(statuscode).json({
        message: JSON.stringify({
          MothershipErrorCode: 10013,
          ClientMessage: "Client Authentication Failed",
          TraceId: genuuid(),
        }),
        statusCode: statuscode,
      });
    }

    if (config.metaaccesstoken) {
      const verifyurl = `https://graph.oculus.com/platform_integrity/verify?token=${encodeURIComponent(attestationtoken)}&access_token=${encodeURIComponent(config.metaaccesstoken)}`;
      const result = await getrequest(verifyurl);

      if (result.status !== 200 || !result.data) {
        throw new Error("Meta integrity API returned non-200: " + result.status);
      }

      let parsed = result.data;
      if (typeof parsed === "string") parsed = JSON.parse(parsed);

      const entry = parsed.data && parsed.data[0];
      if (!entry || entry.message !== "success" || !entry.claims) {
        throw new Error("Invalid attestation token");
      }

      const claimspad = entry.claims + "=".repeat((4 - (entry.claims.length % 4)) % 4);
      const claimsjson = Buffer.from(claimspad, "base64url").toString("utf-8");
      const claims = JSON.parse(claimsjson);

      const tokennonce = claims.request_details && claims.request_details.nonce;
      if (tokennonce !== pending.nonce) {
        throw new Error("Nonce mismatch");
      }

      const appintegrity = claims.app_state && claims.app_state.app_integrity_state;
      logfile("auth-complete-resp.log", "app_integrity=" + appintegrity);
      // Block sideloaded versions (NotRecognized = sideloaded)
      if (appintegrity === "NotRecognized") {
        console.log("[quest-auth] BLOCKED sideloaded app — user=" + userid);
        delete pendingnonces[userid];
        discordbot.sendChannelMessage("1517537648414031962", null, {
          color: 15158332,
          description: "## 🚫 Sideloaded App Blocked\n**↓ Details ↓**\n```[User ID] : " + userid + "\n[Platform] : QUEST\n[Reason] : App integrity check failed (NotRecognized - sideloaded)\n```",
          timestamp: new Date().toISOString(),
        }).catch(() => {});
        return res.status(statuscode).json({
          message: JSON.stringify({
            MothershipErrorCode: 10013,
            ClientMessage: "Client Authentication Failed",
            TraceId: genuuid(),
          }),
          statusCode: statuscode,
        });
      }
      if (!appintegrity || appintegrity === "NotEvaluated") {
        console.log("[quest-auth] WARNING: app_integrity=" + (appintegrity || "missing") + " for user=" + userid);
      }
    }

    delete pendingnonces[userid];
    const player = ensuremothershipplayer(userid, "QUEST");

    if (player.token && player.expirationtime > Date.now() + 1800000) {
      activeplayers.seen(player.mothershipid);
      console.log("[quest-auth/complete] using cached token");
      return res.status(successcode).json(buildauthresponse(player, player.token, player.expirationtime));
    }

    const { token, exp } = issuetoken(player.mothershipid, userid, "QUEST");
    db.prepare(
      "UPDATE mothershipplayers SET token = ?, expirationtime = ?, lastlogin = datetime('now') WHERE userid = ?"
    ).run(token, exp, userid);

    activeplayers.seen(player.mothershipid);
    const resp = buildauthresponse(player, token, exp);
    logfile("auth-complete-resp.log", "200 new: " + JSON.stringify(resp));
    return res.status(successcode).json(resp);
  } catch (err) {
    console.error("[mothership/auth/quest] error:", err.message);
    logfile("auth-complete-resp.log", "ERROR: " + err.message);
    return res.status(statuscode).json({
      message: JSON.stringify({
        MothershipErrorCode: 10013,
        ClientMessage: "Client Authentication Failed",
        TraceId: genuuid(),
      }),
      statusCode: statuscode,
    });
  }
});

const titledatastatic = (() => {
  try {
    const raw = require("../data/titledata.json");
    const map = {};
    for (const entry of raw.Results || []) {
      map[entry.key] = entry.data;
    }
    return { results: raw.Results || [], map };
  } catch (e) {
    console.warn("[mothership] titledata.json not found, returning empty");
    return { results: [], map: {} };
  }
})();

// Analytics - accept and discard
router.post("/v1/client/analytics/event/batch", (req, res) => {
  res.status(200).json({});

  // Separate analytics event log
  try {
    const evtLogDir = config.event_log_dir || path.join(__dirname, "..", "eventlogs");
    if (!fs.existsSync(evtLogDir)) fs.mkdirSync(evtLogDir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const lf = path.join(evtLogDir, `analytics-events-${date}.log`);
    const logentry = {
      time: new Date().toISOString(),
      token: req.headers["x-mothership-token"] ? "present" : "missing",
      events: (req.body && req.body.Events) ? req.body.Events.map(e => ({
        name: e.EventName,
        tags: e.CustomTags || null,
        body: e.Body || {},
      })) : [],
    };
    fs.appendFileSync(lf, JSON.stringify(logentry) + "\n");
  } catch (_) {}

  // Extract mothershipid from JWT token
  let mothershipid = null;
  const token = req.headers["x-mothership-token"];
  if (token) {
    try {
      const decoded = jwt.decode(token, { complete: true });
      if (decoded && decoded.payload && decoded.payload.sub) {
        mothershipid = decoded.payload.sub;
      }
    } catch (_) {}
  }

  // Parse events
  try {
    const events = (req.body && req.body.Events) ? req.body.Events : [];
    for (const evt of events) {
      const name = evt.EventName;
      const body = evt.Body || {};
      const tags = evt.CustomTags || {};

      if (name === "ghost_game_end" && mothershipid) {
        const coresCollected = parseInt(body.total_cores_collected_by_player) || 0;
        const coresSpent = parseInt(body.total_cores_spent_by_player) || 0;
        const reason = body.reason || "unknown";

        db.prepare(`INSERT INTO ghostgames (
          mothershipid, ghost_game_id, event_timestamp,
          final_cores_balance, total_cores_collected_by_player, total_cores_collected_by_group,
          total_cores_spent_by_player, total_cores_spent_by_group,
          gates_unlocked, died, items_purchased, shift_cut_data, play_duration,
          started_late, time_started, reason, max_number_in_game, end_number_in_game,
          items_picked_up, revives, num_shifts_played, game_version, game_environment
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          mothershipid,
          body.ghost_game_id || null,
          body.event_timestamp || null,
          parseInt(body.final_cores_balance) || 0,
          coresCollected,
          parseInt(body.total_cores_collected_by_group) || 0,
          coresSpent,
          parseInt(body.total_cores_spent_by_group) || 0,
          parseInt(body.gates_unlocked) || 0,
          parseInt(body.died) || 0,
          body.items_purchased || "[]",
          body.shift_cut_data || "0",
          parseInt(body.play_duration) || 0,
          body.started_late || "False",
          body.time_started || "0",
          reason,
          parseInt(body.max_number_in_game) || 0,
          parseInt(body.end_number_in_game) || 1,
          body.items_picked_up || "{}",
          parseInt(body.revives) || 0,
          parseInt(body.num_shifts_played) || 0,
          tags.tag1 || null,
          tags.tag2 || null
        );

        // Complete any active shifts for this player
        const activeShifts = db.prepare("SELECT * FROM shifts WHERE mothershipid = ? AND completed = 0").all(mothershipid);
        for (const shift of activeShifts) {
          db.prepare("UPDATE shifts SET completed = 1 WHERE shiftid = ?").run(shift.shiftid);
          logfile("resdump.log", JSON.stringify({ event: "ghost_game_end_completed_shift", mothershipid, shiftid: shift.shiftid }));
        }

        // Discord webhook for ghost game end
        const playTime = parseInt(body.play_duration) || 0;
        const playMin = Math.round(playTime / 10000000 / 60 * 100) / 100;
        webhook.ghostGameEnd(
          mothershipid, reason,
          parseInt(body.final_cores_balance) || 0,
          coresCollected,
          parseInt(body.gates_unlocked) || 0,
          parseInt(body.died) || 0,
          parseInt(body.revives) || 0,
          playMin
        );
      }

      if (name === "game_mode_played_event" && mothershipid) {
        const gm = body.game_mode || "unknown";
        const type = body.EventType || "unknown";
        webhook.send("misc", {
          color: 3447003,
          description: "## Game Mode Event\n**↓ Details ↓**\n```[Mothership ID] : " + mothershipid.slice(0, 12) + "\n[Game Mode] : " + gm + "\n[Type] : " + type + "\n```",
        });
      }
    }
  } catch (e) {
    logfile("resdump.log", `[analytics-error] ${e.message}`);
  }
});

// Title Data
router.get("/v1/title-data/client", (req, res) => {
  try {
    const keys = req.query.keys;

    const merged = Object.assign({}, titledatastatic.map);
    const dbrows = db.prepare("SELECT * FROM mothershiptitledata").all();
    for (const r of dbrows) {
      merged[r.datakey] = r.datavalue;
    }

    if (keys) {
      const keylist = keys.split(",").map((k) => k.trim()).filter(Boolean);
      const results = keylist
        .filter((k) => k in merged)
        .map((k) => ({ key: k, data: merged[k] }));
      return res.status(200).json({ Results: results });
    }

    const allkeys = new Set([...Object.keys(titledatastatic.map), ...dbrows.map((r) => r.datakey)]);
    const results = Array.from(allkeys).map((k) => ({ key: k, data: merged[k] }));
    return res.status(200).json({ Results: results });
  } catch (err) {
    console.error("[mothership/titledata] error:", err.message);
    return res.status(500).json({ Results: [] });
  }
});

// User Data - Write
router.post("/v1/userdata/client", requiremothershiptoken, (req, res) => {
  try {
    const mothershipid = req.mothershipid;
    const body = req.body || {};
    const keyname = body.key_name || body.Key || "";
    const datavalue = body.value || body.Value || body.data || body.Data || "{}";

    if (!mothershipid || !keyname) {
      return res.status(200).json({ id: "", key_name: keyname, user_id: mothershipid, generation: 0 });
    }

    const jsonstr = typeof datavalue === "string" ? datavalue : JSON.stringify(datavalue);

    db.prepare(
      "INSERT INTO mothershipuserdata (mothershipid, keyname, datavalue, updatedat) VALUES (?, ?, ?, datetime('now')) ON CONFLICT(mothershipid, keyname) DO UPDATE SET datavalue = ?, updatedat = datetime('now')"
    ).run(mothershipid, keyname, jsonstr, jsonstr);

    // Get generation count
    const gen = db.prepare("SELECT COUNT(*) as c FROM mothershipuserdata WHERE mothershipid = ? AND keyname = ?").get(mothershipid, keyname);
    return res.status(200).json({
      id: keyname,
      key_name: keyname,
      user_id: mothershipid,
      generation: (gen?.c || 1),
    });
  } catch (err) {
    console.error("[mothership/userdata-write] error:", err.message);
    return res.status(200).json({ id: "", key_name: "", user_id: req.mothershipid || "", generation: 0 });
  }
});

// User Data - Read
router.get("/v1/userdata/client", requiremothershiptoken, (req, res) => {
  try {
    const mothershipid = req.mothershipid;
    const keyname = req.query.key_name;

    if (!mothershipid || !keyname) {
      return res.status(200).json({ id: "", key_name: keyname || "", user_id: mothershipid, value: "", generation: 0 });
    }

    const row = db.prepare(
      "SELECT * FROM mothershipuserdata WHERE mothershipid = ? AND keyname = ?"
    ).get(mothershipid, keyname);

    if (!row) {
      return res.status(200).json({ id: "", key_name: keyname, user_id: mothershipid, value: "", generation: 0 });
    }

    return res.status(200).json({
      id: keyname,
      metadata_id: "",
      key_name: keyname,
      user_id: mothershipid,
      value: row.datavalue || "",
      generation: 1,
      created_by: mothershipid,
      last_written_by: mothershipid,
      created_time: row.updatedat || new Date().toISOString(),
      last_updated_time: row.updatedat || new Date().toISOString(),
    });
  } catch (err) {
    console.error("[mothership/userdata] error:", err.message);
    return res.status(200).json({ id: "", key_name: "", user_id: req.mothershipid || "", value: "", generation: 0 });
  }
});

// Inventory
router.get("/v1/inventory/client", requiremothershiptoken, (req, res) => {
  try {
    const mothershipid = req.mothershipid || "";
    let platform = "QUEST";
    if (req.mothershippayload) {
      platform = req.mothershippayload.externalService || "QUEST";
    }

    if (!mothershipid) {
      return res.status(200).json({ Results: {} });
    }

    let row = db.prepare("SELECT * FROM mothershipinventory WHERE mothershipid = ?").get(mothershipid);
    if (!row) {
      // seed with Initialize transaction resources (8 each)
      const seed = [
        { entitlement_id: "d4a0fad9-4602-435d-b379-cd5f69fb4321", in_game_id: "SI_TECH_POINTS",       name: "SI_TechPoints",       quantity: 8 },
        { entitlement_id: "078b85fb-c0d9-44d5-a3ca-e325819b13cd", in_game_id: "SI_STRANGE_WOOD",      name: "SI_StrangeWood",      quantity: 8 },
        { entitlement_id: "427839b6-58a4-4e8b-9cb4-3d48cb1fb513", in_game_id: "SI_WEIRD_GEAR",        name: "SI_WeirdGear",        quantity: 8 },
        { entitlement_id: "5150d276-db1a-4263-bff4-edbe7b55f841", in_game_id: "SI_VIBRATING_SPRING",  name: "SI_VibratingSpring",  quantity: 8 },
      ];
      db.prepare("INSERT INTO mothershipinventory (mothershipid, inventoryjson, updatedat) VALUES (?, ?, datetime('now'))").run(mothershipid, JSON.stringify(seed));
      row = { inventoryjson: JSON.stringify(seed) };
    }

    const items = JSON.parse(row.inventoryjson || "[]");

    const result = {};
    result[mothershipid] = {
      platform: platform,
      isPrimary: true,
      entitlements: items,
    };

    return res.status(200).json({ Results: result });
  } catch (err) {
    console.error("[mothership/inventory] error:", err.message);
    return res.status(200).json({ Results: {} });
  }
});

// Progression Tree
const progtreedata = (() => {
  try {
    const raw = require("../data/progression-tree.json");
    return raw;
  } catch (e) {
    console.warn("[mothership] progression-tree.json not found, returning empty");
    return { Results: [] };
  }
})();

router.get("/v1/progression-tree/client", requiremothershiptoken, (req, res) => {
  try {
    const mothershipid = req.mothershipid || "";

    const results = JSON.parse(JSON.stringify(progtreedata));
    if (mothershipid && results.Results) {
      // get player's unlocked nodes
      const unlocked = db.prepare("SELECT treeid, nodeid FROM progressionnodes WHERE mothershipid = ?").all(mothershipid);
      const unlockedSet = new Set(unlocked.map(r => r.treeid + ":" + r.nodeid));

      for (const entry of results.Results) {
        entry.PlayerId = mothershipid;
        if (entry.NodeDefinitions) {
          for (const node of entry.NodeDefinitions) {
            if (unlockedSet.has(entry.Tree.id + ":" + node.id)) {
              node.unlocked = true;
            }
          }
        }
      }
    }

    return res.status(200).json(results);
  } catch (err) {
    console.error("[mothership/progtree] error:", err.message);
    return res.status(200).json({ Results: [] });
  }
});

// ─── RSLib Remote Logging ─────────────────────────────────────
router.post("/api/rslog", (req, res) => {
  try {
    const body = req.body || {};
    const messages = body.messages || [];
    const logDir = path.join(__dirname, "..", "rslib-logs");
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const lf = path.join(logDir, `rslib-${date}.log`);
    for (const msg of messages) {
      const entry = { time: new Date().toISOString(), tag: msg.tag || "RSTag", level: msg.level || "info", text: msg.text || "" };
      fs.appendFileSync(lf, JSON.stringify(entry) + "\n");
      console.log("[rslib][" + (msg.level || "info") + "][" + (msg.tag || "RSTag") + "] " + (msg.text || ""));
    }
    res.json({ ok: true, received: messages.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Dear Lemming ──────────────────────────────────────────────
const DEAR_LEMMING_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes between submissions

const BAD_WORDS = [
  "nigger", "nigga", "faggot", "fag", "kike", "spic", "chink", "gook", "raghead",
  "sandnigger", "beaner", "wetback", "coon", "jigaboo", "darkie", "cunt", "twat",
  "whore", "slut", "bitch", "piss", "shit", "fuck", "asshole", "dickhead",
  "cock", "dick", "pussy", "penis", "vagina", "ballsack", "bastard",
  "motherfucker", "motherfuck", "niglet", "tranny", "retard", "mongoloid", "@everyone", "slop", "diddy", "skid",
];

router.post("/api/CheckDearLemming", (req, res) => {
  try {
    const body = req.body || {};
    const token = body.MothershipToken || "";
    let mothershipid = body.MothershipId || "";

    // Try to verify JWT, but fall back to decoding if it's from another server
    if (token && !mothershipid) {
      try {
        const decoded = jwt.verify(token, publickey, { algorithms: ["ES256"] });
        mothershipid = decoded.sub || "";
      } catch {
        // Token might be signed by a different key — decode without verification
        try {
          const decoded = jwt.decode(token, { complete: true });
          if (decoded && decoded.payload && decoded.payload.sub) {
            mothershipid = decoded.payload.sub;
          }
        } catch {}
      }
    }

    if (!mothershipid) return res.status(200).json({ CanSubmit: false, NextSubmitTimeUtc: null, SecondsUntilNextSubmit: null, Error: "Missing ID", StatusCode: 400 });

    // Check cooldown
    const last = db.prepare("SELECT createdat FROM dear_lemmings WHERE mothershipid = ? ORDER BY createdat DESC LIMIT 1").get(mothershipid);
    if (last) {
      const lastTime = new Date(last.createdat + "Z").getTime();
      const elapsed = Date.now() - lastTime;
      if (elapsed < DEAR_LEMMING_COOLDOWN_MS) {
        const remaining = DEAR_LEMMING_COOLDOWN_MS - elapsed;
        const nextTime = new Date(Date.now() + remaining);
        return res.status(200).json({
          CanSubmit: false,
          NextSubmitTimeUtc: nextTime.toISOString(),
          SecondsUntilNextSubmit: Math.ceil(remaining / 1000),
          Error: null,
          StatusCode: 200,
        });
      }
    }

    return res.status(200).json({ CanSubmit: true, NextSubmitTimeUtc: null, SecondsUntilNextSubmit: null, Error: null, StatusCode: 200 });
  } catch (e) {
    return res.status(200).json({ CanSubmit: false, NextSubmitTimeUtc: null, SecondsUntilNextSubmit: null, Error: e.message, StatusCode: 500 });
  }
});

router.post("/api/SubmitDearLemming", (req, res) => {
  try {
    const body = req.body || {};
    const token = body.MothershipToken || "";
    let mothershipid = body.MothershipId || "";
    const messageText = (body.MessageText || "").trim().slice(0, 500);

    // Try verify, fall back to decode
    if (token && !mothershipid) {
      try {
        const decoded = jwt.verify(token, publickey, { algorithms: ["ES256"] });
        mothershipid = decoded.sub || "";
      } catch {
        try {
          const decoded = jwt.decode(token, { complete: true });
          if (decoded && decoded.payload && decoded.payload.sub) {
            mothershipid = decoded.payload.sub;
          }
        } catch {}
      }
    }

    if (!mothershipid) return res.status(200).json({ CanSubmit: false, NextSubmitTimeUtc: null, SecondsUntilNextSubmit: null, Error: "Missing ID", StatusCode: 400 });
    if (!messageText) return res.status(200).json({ CanSubmit: false, NextSubmitTimeUtc: null, SecondsUntilNextSubmit: null, Error: "Invalid message", StatusCode: 400 });

    // Bad word check
    const msgLower = messageText.toLowerCase();
    for (const word of BAD_WORDS) {
      if (msgLower.includes(word)) {
        // Auto-ban the player
        try {
          const ms = db.prepare("SELECT userid FROM mothershipplayers WHERE mothershipid = ?").get(mothershipid);
          let oculusId = ms ? ms.userid || "" : "";
          if (!oculusId) {
            try {
              const decoded = jwt.decode(token, { complete: true });
              if (decoded && decoded.payload) oculusId = decoded.payload.externalServiceId || "";
            } catch (_) {}
          }
          let playfabId = "";
          let oculusName = "";
          if (oculusId) {
            const pf = db.prepare("SELECT playfabid FROM players WHERE oculusid = ?").get(oculusId);
            if (pf) playfabId = pf.playfabid || "";
            const oc = db.prepare("SELECT username FROM oculus_profiles WHERE userid = ?").get(oculusId);
            if (oc) oculusName = oc.username || "";
          }
          const banReason = "INAPPPROPRIATE CONTENT SENT IN DEAR LEMMING MACHINE, ACC BANNED: " + (oculusName || oculusId || "unknown");
          if (playfabId) {
            playfab.banusers([playfabId], banReason, 0).catch(() => {});
          }
          // Log and send alert
          console.log("[dearlemming] BLOCKED + BANNED", mothershipid, "word:", word, "msg:", messageText);
          webhook.send("dearlemming", {
            color: 15158332,
            description: "## 🚫 BANNED - Inappropriate Dear Lemming\n**↓ Offender ↓**\n```[Mothership ID] : " + mothershipid + "\n[Oculus ID] : " + (oculusId || "N/A") + "\n[PlayFab ID] : " + (playfabId || "N/A") + "\n[Oculus Name] : " + (oculusName || "N/A") + "\n```\n**↓ Message ↓**\n```" + messageText + "\n```\n**↓ Triggered Word ↓**\n```" + word + "\n```",
          });
        } catch {}
        return res.status(200).json({ CanSubmit: false, NextSubmitTimeUtc: null, SecondsUntilNextSubmit: null, Error: "Inappropriate content", StatusCode: 400 });
      }
    }

    // Check cooldown
    const last = db.prepare("SELECT createdat FROM dear_lemmings WHERE mothershipid = ? ORDER BY createdat DESC LIMIT 1").get(mothershipid);
    if (last) {
      const elapsed = Date.now() - new Date(last.createdat + "Z").getTime();
      if (elapsed < DEAR_LEMMING_COOLDOWN_MS) {
        const remaining = DEAR_LEMMING_COOLDOWN_MS - elapsed;
        return res.status(200).json({ CanSubmit: false, NextSubmitTimeUtc: new Date(Date.now() + remaining).toISOString(), SecondsUntilNextSubmit: Math.ceil(remaining / 1000), Error: null, StatusCode: 200 });
      }
    }

    // Look up player details — try mothershipid, then fall back to JWT externalServiceId
    let displayName = null;
    let oculusId = "";
    let playfabId = "";
    let oculusName = "";
    try {
      const ms = db.prepare("SELECT userid FROM mothershipplayers WHERE mothershipid = ?").get(mothershipid);
      if (ms) {
        oculusId = ms.userid || "";
      }
    } catch (_) {}
    if (!oculusId) {
      try {
        const decoded = jwt.decode(token, { complete: true });
        if (decoded && decoded.payload) oculusId = decoded.payload.externalServiceId || "";
      } catch (_) {}
    }
    try {
      if (oculusId) {
        const pf = db.prepare("SELECT playfabid, displayname FROM players WHERE oculusid = ?").get(oculusId);
        if (pf) {
          playfabId = pf.playfabid || "";
          displayName = pf.displayname || null;
        }
        const oc = db.prepare("SELECT username FROM oculus_profiles WHERE userid = ?").get(oculusId);
        if (oc) oculusName = oc.username || "";
      }
    } catch (_) {}

    db.prepare("INSERT INTO dear_lemmings (mothershipid, message_text, display_name) VALUES (?,?,?)").run(mothershipid, messageText, displayName);

    // Discord webhook
    try {
      webhook.send("dearlemming", {
        color: 3447003,
        description: "## 📬 Dear Lemming\n**↓ Message ↓**\n```" + messageText + "\n```\n**↓ Player Details ↓**\n```[Mothership ID] : " + mothershipid + "\n[Oculus ID] : " + (oculusId || "N/A") + "\n[PlayFab ID] : " + (playfabId || "N/A") + "\n[PlayFab Name] : " + (displayName || "N/A") + "\n[Oculus Name] : " + (oculusName || "N/A") + "\n```",
      });
    } catch (_) {}

    return res.status(200).json({ CanSubmit: true, NextSubmitTimeUtc: null, SecondsUntilNextSubmit: null, Error: null, StatusCode: 200 });
  } catch (e) {
    console.log("[dearlemming] error:", e.message);
    return res.status(200).json({ CanSubmit: false, NextSubmitTimeUtc: null, SecondsUntilNextSubmit: null, Error: e.message, StatusCode: 500 });
  }
});

// Steam auth step 1 (two-step)
router.get("/v2/player/client/auth/begin/STEAM", (req, res) => {
  try {
    const noncebuf = crypto.randomBytes(64);
    const nonce = noncebuf.toString("base64url");
    // Store nonce keyed by "steam_" prefix since we don't have a userid yet
    const key = "steam_" + nonce.slice(0, 16);
    pendingnonces[key] = { nonce, created: Date.now() };
    res.status(200).json({ Nonce: nonce });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Steam auth step 2 (complete)
router.post("/v2/player/client/auth/complete/STEAM", authlimiter, async (req, res) => {
  try {
    const body = req.body || {};
    const nonce = sanitizestr(body.Nonce, 256);
    const steamTicket = sanitizestr(body.SteamTicket, 4096) || "";

    if (!nonce) {
      return res.status(400).json({ error: "Missing Nonce" });
    }
    if (!steamTicket) {
      return res.status(400).json({ error: "Missing SteamTicket" });
    }

    // Verify nonce
    const key = "steam_" + nonce.slice(0, 16);
    if (!pendingnonces[key] || pendingnonces[key].nonce !== nonce) {
      return res.status(401).json({ error: "Invalid nonce" });
    }
    delete pendingnonces[key];

    // Verify Steam ticket (optional — skip if no API key configured)
    let steamId = null;
    let steamName = "";
    const steamApiKey = process.env.STEAM_WEB_API_KEY || "";
    const steamAppId = process.env.STEAM_APP_ID || "1533390"; // Gorilla Tag's app ID

    if (steamApiKey && steamTicket) {
      try {
        const steamResult = await getrequest(
          "api.steampowered.com",
          `/ISteamUserAuth/AuthenticateUserTicket/v1/?key=${encodeURIComponent(steamApiKey)}&appid=${steamAppId}&ticket=${encodeURIComponent(steamTicket)}`,
        );
        if (steamResult.status === 200 && steamResult.data) {
          const resp = steamResult.data.response || steamResult.data;
          if (resp.params && resp.params.result === "OK") {
            steamId = resp.params.steamid;
            // Fetch Steam persona name
            try {
              const profileResult = await getrequest(
                "api.steampowered.com",
                `/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(steamApiKey)}&steamids=${steamId}`,
              );
              if (profileResult.status === 200 && profileResult.data) {
                const players = profileResult.data.response?.players || profileResult.data.players || [];
                if (players.length > 0) steamName = players[0].personaname || "";
              }
            } catch (_) {}
          }
        }
      } catch (_) {}
    }

    // Fallback: use steam ticket hash as userid if API key not configured
    const userid = steamId || ("S" + require("crypto").createHash("md5").update(steamTicket).digest("hex").slice(0, 16));

    const player = ensuremothershipplayer(userid, "STEAM");

    if (player.token && player.expirationtime > Date.now() + 1800000) {
      activeplayers.seen(player.mothershipid);
      const resp = buildauthresponse(player, player.token, player.expirationtime);
      if (steamName) resp.ExternalProviderUsername = steamName;
      return res.status(201).json(resp);
    }

    const { token, exp } = issuetoken(player.mothershipid, userid, "STEAM");

    db.prepare(
      "UPDATE mothershipplayers SET token = ?, expirationtime = ?, lastlogin = datetime('now') WHERE userid = ?"
    ).run(token, exp, userid);

    activeplayers.seen(player.mothershipid);
    const resp = buildauthresponse(player, token, exp);
    if (steamName) resp.ExternalProviderUsername = steamName;
    return res.status(201).json(resp);
  } catch (err) {
    console.error("[mothership/auth/steam] error:", err.message);
    return res.status(401).json({ error: "Authentication failed" });
  }
});

// PlayFab Client API: LoginWithSteam (fixed custom ID → same PlayFab ID every time)
router.post("/Client/LoginWithSteam", async (req, res) => {
  try {
    const body = req.body || {};
    const steamTicket = sanitizestr(body.SteamTicket, 4096) || "";
    if (!steamTicket) {
      return res.status(400).json({ code: 400, status: "BadRequest", error: "Missing SteamTicket", errorCode: 1007, errorMessage: "SteamTicket is required" });
    }

    const result = await playfab.serverlogin("STEAM_5fb116a26b1750663fc5e74f026a635a", true);
    if (result.status !== 200 || !result.data || !result.data.data) {
      return res.status(500).json({ code: 500, status: "InternalServerError", error: "LoginFailed", errorCode: 1124, errorMessage: "Failed to authenticate" });
    }

    const d = result.data.data;
    const playfabId = d.PlayFabId || "";
    const sessionTicket = d.SessionTicket || "";
    const entityToken = (d.EntityToken && d.EntityToken.EntityToken) || "";
    const entityId = (d.EntityToken && d.EntityToken.Entity && d.EntityToken.Entity.Id) || "";

    try {
      ensureplayer(playfabId);
      db.prepare("UPDATE players SET sessionticket = ?, entitytoken = ?, entityid = ?, lastlogin = datetime('now') WHERE playfabid = ?").run(sessionTicket, entityToken, entityId, playfabId);
    } catch {}

    return res.status(200).json({
      code: 200, status: "OK",
      data: {
        SessionTicket: sessionTicket,
        PlayFabId: playfabId,
        EntityToken: {
          EntityToken: entityToken,
          TokenExpiration: new Date(Date.now() + 86400000).toISOString(),
          Entity: { Id: entityId, Type: "title_player_account", TypeString: "title_player_account" },
        },
        SettingsForUser: null,
        InfoResultPayload: null,
      },
    });
  } catch (err) {
    console.error("[playfab/LoginWithSteam] error:", err.message);
    return res.status(500).json({ code: 500, status: "InternalServerError", error: "LoginFailed", errorCode: 1124, errorMessage: err.message });
  }
});

// ─── Subscriptions (VIM fan_club) ─────────────────────────────
// Native SDK: ClientGetMySubscriptions(mothershipId) → GET /v1/subscription/client
// May also be POST or pass callerId in query. Response parsed by rapidjson (lowercase).
router.all("/v1/subscription/client", (req, res) => {
  console.log("[subs/v1] hit —", req.method, req.originalUrl, "query:", JSON.stringify(req.query));
  const now = new Date().toISOString();
  const later = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  res.status(200).json({
    subscriptions: [{
      id: "sub_vim_fanclub",
      earliest_start_date: now,
      current_sub_start_date: now,
      most_recent_billing_cycle_start_date: now,
      most_recent_billing_cycle_end_date: later,
      total_lifetime_seconds: 0,
      total_lifetime_seconds_last_update_date: now,
      is_active: true,
      is_cancelling: false,
      sku: "fan_club",
      mothership_player_id: req.query.caller_id || req.query.player_id || "",
      trial_version: "",
      external_service_name: "rift",
      external_service_org_scoped_id: "",
      external_service_user_id: "",
      external_service_user_name: "",
      ref_id: "",
      title_id: "f3e9fb19",
      env_id: "7f3a99dd-5598-4725-98cf-6538d28feb9f",
      subscription_catalog_item_id: ""
    }],
    status_code: 200,
    error: null
  });
});

// ─── Mothership Client Data (hardcoded staff) ────────────────
const STAFF = [
  { userId: "EA1F059A3FC8F29F", username: "gorilla7516", role: 2 },
];

router.get("/v1/data/client", (req, res) => {
  res.status(200).json({ admins: STAFF });
});

module.exports = router;
