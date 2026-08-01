const express = require("express");
const crypto = require("crypto");
const https = require("https");
const path = require("path");
const fs = require("fs");
const config = require("../lib/config");
const { db } = require("../lib/database");
const { getrequest } = require("../lib/httpclient");
const pf = require("../lib/playfab");
const discord = require("../lib/discordbot");
const wsserver = require("../lib/wsserver");
const { sanitizestr } = require("../lib/validation");

const router = express.Router();
const sessions = new Map();
const COOKIE_NAME = "admin_token";
const CSRF_COOKIE = "admin_csrf";
const ADMIN_SECRET = process.env.ADMIN_API_SECRET || crypto.randomBytes(32).toString("hex");
// Simple rate limiter: ip → { count, reset }
const rateLimitMap = new Map();

function checkRateLimit(ip, maxReqs = 30, windowSec = 60) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.reset) {
    rateLimitMap.set(ip, { count: 1, reset: now + windowSec * 1000 });
    return true;
  }
  if (entry.count >= maxReqs) return false;
  entry.count++;
  return true;
}

// Clean rate limit map every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now > entry.reset) rateLimitMap.delete(ip);
  }
}, 300000);

// Load persisted sessions from DB on startup
try {
  const rows = db.prepare("SELECT * FROM admin_sessions WHERE createdat > datetime('now', '-1 day')").all();
  for (const r of rows) {
    sessions.set(r.token, {
      discordId: r.discordid,
      username: r.username,
      discriminator: r.discriminator,
      avatarUrl: r.avatarurl,
      loginTime: new Date(r.createdat).getTime(),
      roles: JSON.parse(r.roles_json || "[]"),
      permissions: JSON.parse(r.permissions_json || "{}"),
      ip: r.ip || "",
    });
  }
  if (rows.length) console.log(`[admin] loaded ${rows.length} persisted sessions`);
} catch (e) { console.warn("[admin] session load error:", e.message); }

function saveSession(token, user) {
  try {
    db.prepare(`INSERT OR REPLACE INTO admin_sessions (token, discordid, username, discriminator, avatarurl, roles_json, permissions_json, ip)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      token,
      user.discordId,
      user.username,
      user.discriminator || "0",
      user.avatarUrl || null,
      JSON.stringify(user.roles || []),
      JSON.stringify(user.permissions || {}),
      user.ip || "",
    );
  } catch (_) {}
}

function deleteSession(token) {
  try { db.prepare("DELETE FROM admin_sessions WHERE token = ?").run(token); } catch (_) {}
}

function requireAdmin(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) {
    if (req.path === "/login" || req.path === "/callback") return next();
    return res.redirect("/admin/login");
  }
  // Check memory cache first
  if (sessions.has(token)) {
    req.adminUser = sessions.get(token);
    return next();
  }
  // Try DB for persisted sessions
  try {
    const r = db.prepare("SELECT * FROM admin_sessions WHERE token = ? AND createdat > datetime('now', '-1 day')").get(token);
    if (r) {
      const user = {
        discordId: r.discordid,
        username: r.username,
        discriminator: r.discriminator,
        avatarUrl: r.avatarurl,
        loginTime: new Date(r.createdat).getTime(),
        roles: JSON.parse(r.roles_json || "[]"),
        permissions: JSON.parse(r.permissions_json || "{}"),
      };
      sessions.set(token, user); // restore to cache
      req.adminUser = user;
      return next();
    }
  } catch (_) {}
  if (req.path === "/login" || req.path === "/callback") return next();
  return res.redirect("/admin/login");
}

function makeToken() { return crypto.randomBytes(32).toString("hex"); }

function postForm(hostname, path, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, port: 443, path, method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) },
    }, (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => { try { resolve({ status: res.statusCode, data: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, data: d }); } }); });
    req.on("error", reject); req.setTimeout(15000, () => req.destroy()); req.write(body); req.end();
  });
}

// Login
router.get("/admin/login", (req, res) => {
  if (!config.discord_client_id) return res.send("Set DISCORD_CLIENT_ID + DISCORD_CLIENT_SECRET in .env");
  const redir = encodeURIComponent("https://" + (req.get("host") || "localhost") + "/admin/callback");
  res.send(`<!DOCTYPE html><html><head><title>Project RS Mothership</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{background:#0b0b18;color:#fff;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}a{background:#7289da;color:#fff;padding:16px 32px;border-radius:10px;text-decoration:none;font-size:18px;font-weight:600;transition:all .2s}a:hover{transform:translateY(-2px);box-shadow:0 4px 20px rgba(114,137,218,.3)}</style></head><body><a href="https://discord.com/api/oauth2/authorize?client_id=${config.discord_client_id}&redirect_uri=${redir}&response_type=code&scope=identify">Login with Discord</a></body></html>`);
});

// Callback
router.get("/admin/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.redirect("/admin/login");
  try {
    const redir = "https://" + (req.get("host") || "localhost") + "/admin/callback";
    const tokenRes = await postForm("discord.com", "/api/oauth2/token",
      "client_id=" + config.discord_client_id + "&client_secret=" + config.discord_client_secret +
      "&grant_type=authorization_code&code=" + code + "&redirect_uri=" + encodeURIComponent(redir));
    if (!tokenRes.data || !tokenRes.data.access_token) return res.status(401).send("Auth failed");
    const userRes = await getrequest("discord.com", "/api/users/@me", { "Authorization": "Bearer " + tokenRes.data.access_token });
    const user = typeof userRes.data === "string" ? JSON.parse(userRes.data) : userRes.data;

    const isHardcoded = config.admin_discord_ids.includes(user.id);
    let discordRoles = [];
    let roleFetchError = false;

    // Fetch guild roles if configured
    if (config.discord_bot_token && config.discord_guild_id) {
      try {
        discordRoles = await discord.getUserRoles(user.id);
      } catch {
        roleFetchError = true;
      }
    }

    // Determine access: hardcoded always gets panel, otherwise needs panel role
    const hasPanelRole = config.discord_role_panel ? discordRoles.includes(config.discord_role_panel) : false;
    const hasPanelAccess = isHardcoded || hasPanelRole;

    if (!hasPanelAccess) {
      const msg = roleFetchError
        ? "Access denied. Bot failed to check roles."
        : "Access denied. You need the Panel role to access the admin panel. Your Discord ID: " + user.id;
      return res.status(403).send(msg);
    }

    const avatarUrl = user.avatar
      ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${user.avatar.startsWith("a_") ? "gif" : "png"}?size=128`
      : `https://cdn.discordapp.com/embed/avatars/${(user.discriminator || "0") % 5}.png`;

    // Check custom role mappings from admin_roles table
    let customPerms = { ban: false, playfab: false };
    if (discordRoles.length > 0) {
      try {
        const customRoles = db.prepare("SELECT * FROM admin_roles WHERE role_id IN (" + discordRoles.map(() => "?").join(",") + ")").all(...discordRoles);
        for (const cr of customRoles) {
          if (cr.perm_panel) { if (!hasPanelAccess) return res.status(403).send("denied"); /* panel already checked */ }
          if (cr.perm_ban) customPerms.ban = true;
          if (cr.perm_playfab) customPerms.playfab = true;
        }
      } catch (_) {}
    }

    // Merge env-based + custom role perms
    const hasBanRole = config.discord_role_ban ? discordRoles.includes(config.discord_role_ban) : false;
    const hasPfRole = config.discord_role_playfab ? discordRoles.includes(config.discord_role_playfab) : false;

    const perms = {
      panel: true,
      owner: isHardcoded,
      ban: isHardcoded || hasBanRole || customPerms.ban,
      playfab: isHardcoded || hasPfRole || customPerms.playfab,
      roles: discordRoles,
      hasBanRole,
      hasPfRole,
    };

    const t = makeToken();
    const csrfToken = crypto.randomBytes(16).toString("hex");
    const clientIp = req.ip || req.connection?.remoteAddress || "";
    const sess = {
      discordId: user.id, username: user.username, discriminator: user.discriminator,
      avatarUrl, loginTime: Date.now(), roles: discordRoles, permissions: perms, ip: clientIp,
    };
    sessions.set(t, sess);
    saveSession(t, sess);
    res.cookie(COOKIE_NAME, t, { httpOnly: true, maxAge: 86400000, sameSite: "lax", secure: true });
    res.cookie(CSRF_COOKIE, csrfToken, { httpOnly: true, maxAge: 3600000, sameSite: "strict", secure: true });
    res.redirect("/admin");
  } catch (e) { res.status(500).send("Error: " + e.message); }
});

router.get("/admin/logout", (req, res) => {
  const t = req.cookies && req.cookies[COOKIE_NAME];
  if (t) { sessions.delete(t); deleteSession(t); }
  res.clearCookie(COOKIE_NAME);
  res.clearCookie(CSRF_COOKIE);
  res.redirect("/admin/login");
});

// API middleware — cookie-only auth with IP binding
function adminApi(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  // Rate limit per IP
  const clientIp = req.ip || req.connection?.remoteAddress || "unknown";
  if (!checkRateLimit(clientIp, 60, 60)) {
    return res.status(429).json({ error: "Too many requests" });
  }
  if (sessions.has(token)) {
    const sess = sessions.get(token);
    if (sess.ip && sess.ip !== clientIp) {
      console.warn(`[admin] IP mismatch for token: session=${sess.ip} request=${clientIp} user=${sess.discordId}`);
      return res.status(401).json({ error: "Session IP mismatch" });
    }
    req.adminUser = sess;
    req.adminToken = token;
    return next();
  }
  // Try DB for persisted sessions
  try {
    const r = db.prepare("SELECT * FROM admin_sessions WHERE token = ? AND createdat > datetime('now', '-1 day')").get(token);
    if (r) {
      if (r.ip && r.ip !== clientIp) {
        console.warn(`[admin] DB session IP mismatch: session=${r.ip} request=${clientIp} user=${r.discordid}`);
        return res.status(401).json({ error: "Session IP mismatch" });
      }
      const user = {
        discordId: r.discordid, username: r.username, discriminator: r.discriminator,
        avatarUrl: r.avatarurl, loginTime: new Date(r.createdat).getTime(),
        roles: JSON.parse(r.roles_json || "[]"), permissions: JSON.parse(r.permissions_json || "{}"),
        ip: r.ip || "",
      };
      sessions.set(token, user);
      req.adminUser = user;
      req.adminToken = token;
      return next();
    }
  } catch (_) {}
  return res.status(401).json({ error: "Unauthorized" });
}

// CSRF validation for state-changing requests
function csrfProtect(req, res, next) {
  if (req.method === "GET" || req.method === "HEAD") return next();
  const csrfCookie = req.cookies && req.cookies[CSRF_COOKIE];
  const csrfHeader = req.headers["x-csrf-token"];
  if (!csrfCookie || !csrfHeader || csrfCookie !== csrfHeader) {
    console.warn(`[admin] CSRF mismatch for user=${req.adminUser?.discordId}`);
    return res.status(403).json({ error: "CSRF validation failed" });
  }
  next();
}

// Require API secret for sensitive PlayFab operations
function requireApiSecret(req, res, next) {
  const secret = req.headers["x-api-secret"];
  if (!secret || secret !== ADMIN_SECRET) {
    console.warn(`[admin] API secret mismatch for user=${req.adminUser?.discordId} endpoint=${req.path}`);
    return res.status(403).json({ error: "Invalid API secret" });
  }
  next();
}

// Admin action audit log
function auditLog(discordId, username, action, details, ip) {
  try {
    db.prepare("INSERT INTO admin_audit_log (discordid, username, action, details, ip) VALUES (?,?,?,?,?)").run(
      discordId || "", username || "", action, details || "", ip || ""
    );
  } catch (_) {}
}

// Requires ban permission role
function requireBanPerm(req, res, next) {
  if (!req.adminUser) return res.status(401).json({ error: "Unauthorized" });
  if (!req.adminUser.permissions || !req.adminUser.permissions.ban) return res.status(403).json({ error: "Forbidden: need ban permission" });
  next();
}

// Requires owner permission
function requireOwner(req, res, next) {
  if (!req.adminUser) return res.status(401).json({ error: "Unauthorized" });
  if (!req.adminUser.permissions || !req.adminUser.permissions.owner) return res.status(403).json({ error: "Forbidden: owner only" });
  next();
}

// Requires playfab admin role
function requirePlayFabPerm(req, res, next) {
  if (!req.adminUser) return res.status(401).json({ error: "Unauthorized" });
  if (!req.adminUser.permissions || !req.adminUser.permissions.playfab) return res.status(403).json({ error: "Forbidden: need PlayFab admin permission" });
  next();
}

// API routes
router.get("/admin/api/me", adminApi, (req, res) => {
  const csrfToken = req.cookies && req.cookies[CSRF_COOKIE] || "";
  res.json({
    username: req.adminUser ? req.adminUser.username : "Admin",
    discriminator: req.adminUser ? req.adminUser.discriminator : "0",
    avatarUrl: req.adminUser ? req.adminUser.avatarUrl : null,
    permissions: req.adminUser ? req.adminUser.permissions : {},
    csrfToken,
  });
});

function auditMiddleware(action) {
  return (req, res, next) => {
    const origJson = res.json.bind(res);
    res.json = function (body) {
      auditLog(req.adminUser?.discordId, req.adminUser?.username, action, JSON.stringify(body), req.ip || "");
      return origJson(body);
    };
    next();
  };
}

router.get("/admin/api/stats", adminApi, (req, res) => {
  const p = db.prepare("SELECT COUNT(*) as c FROM players").get();
  const m = db.prepare("SELECT COUNT(*) as c FROM mothershipplayers").get();
  const f = db.prepare("SELECT COUNT(*) as c FROM friendlinks").get();
  const s = db.prepare("SELECT COUNT(*) as c FROM shifts WHERE completed=1").get();
  const mp = db.prepare("SELECT COUNT(*) as c FROM sharedmaps").get();
  const po = db.prepare("SELECT COUNT(*) as c FROM polls WHERE isactive=1").get();
  const b = db.prepare("SELECT COUNT(*) as c FROM bans").get();
  const o = wsserver.ccu ? wsserver.ccu() : 0;
  res.json({ players:p.c, mothership:m.c, friends:Math.floor(f.c/2), shifts:s.c, maps:mp.c, polls:po.c, bans:b.c, online:o });
});

router.get("/admin/api/players", adminApi, (req, res) => {
  const pg = Math.max(1, parseInt(req.query.page) || 1);
  const lim = Math.min(parseInt(req.query.limit) || 50, 200);
  const q = req.query.search || "";
  const off = (pg - 1) * lim;
  let w = "", p = [];
  if (q) { w = " WHERE playfabid LIKE ? OR displayname LIKE ? OR oculusid LIKE ?"; p.push("%"+q+"%","%"+q+"%","%"+q+"%"); }
  const c = db.prepare("SELECT COUNT(*) as c FROM players" + w).all(...p);
  p.push(lim, off);
  const rows = db.prepare("SELECT *, (SELECT COUNT(*) FROM friendlinks WHERE playerid=players.playfabid) as fc FROM players" + w + " ORDER BY lastlogin DESC LIMIT ? OFFSET ?").all(...p);
  res.json({ players: rows, total: c[0]?.c || 0, page: pg, limit: lim });
});

router.post("/admin/api/players/:id/ban", adminApi, csrfProtect, requireBanPerm, (req, res) => {
  db.exec("CREATE TABLE IF NOT EXISTS bans (playfabid TEXT PRIMARY KEY, reason TEXT, bannedat TEXT DEFAULT (datetime('now')))");
  db.prepare("INSERT OR REPLACE INTO bans (playfabid, reason) VALUES (?,?)").run(req.params.id, req.body.reason||"Banned");
  db.prepare("DELETE FROM friendpresence WHERE playfabid=?").run(req.params.id);
  auditLog(req.adminUser?.discordId, req.adminUser?.username, "ban", `Banned ${req.params.id}: ${req.body.reason||"Banned"}`, req.ip || "");
  res.json({ success: true });
});
router.post("/admin/api/players/:id/unban", adminApi, csrfProtect, requireBanPerm, (req, res) => {
  db.prepare("DELETE FROM bans WHERE playfabid=?").run(req.params.id);
  auditLog(req.adminUser?.discordId, req.adminUser?.username, "unban", `Unbanned ${req.params.id}`, req.ip || "");
  res.json({ success: true });
});

router.get("/admin/api/shifts", adminApi, (req, res) => {
  res.json(db.prepare("SELECT s.*, sc.currentcredits FROM shifts s LEFT JOIN shiftcredits sc ON s.mothershipid=sc.mothershipid ORDER BY s.startedat DESC LIMIT 100").all());
});
router.post("/admin/api/shifts/:id/complete", adminApi, csrfProtect, (req, res) => {
  try {
    db.prepare("UPDATE shifts SET completed = 1 WHERE shiftid = ?").run(req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post("/admin/api/shifts/complete-all", adminApi, csrfProtect, (req, res) => {
  try {
    const r = db.prepare("UPDATE shifts SET completed = 1 WHERE completed = 0").run();
    res.json({ success: true, completed: r.changes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.get("/admin/api/maps", adminApi, (req, res) => {
  res.json(db.prepare("SELECT * FROM sharedmaps ORDER BY createdat DESC LIMIT 100").all());
});
router.get("/admin/api/polls", adminApi, (req, res) => {
  const rows = db.prepare("SELECT * FROM polls ORDER BY starttime DESC LIMIT 50").all();
  res.json(rows.map(r=>({...r,voteoptions:JSON.parse(r.voteoptions||"[]"),votecount:JSON.parse(r.votecount||"[]")})));
});
router.post("/admin/api/polls", adminApi, csrfProtect, (req, res) => {
  const { question, options, hours } = req.body;
  if (!question||!options||options.length<2) return res.status(400).json({error:"Invalid"});
  const e = new Date(Date.now()+(hours||24)*3600000).toISOString();
  const s = new Date().toISOString();
  const r = db.prepare("INSERT INTO polls (question,voteoptions,votecount,predictioncount,starttime,endtime,isactive,titleid) VALUES (?,?,?,?,?,?,1,?)").run(question,JSON.stringify(options),JSON.stringify(options.map(()=>0)),JSON.stringify(options.map(()=>0)),s,e,"15AD4");
  res.json({id:r.lastInsertRowid});
});
router.post("/admin/api/polls/:id/close", adminApi, csrfProtect, (req, res) => {
  db.prepare("UPDATE polls SET isactive=0 WHERE pollid=?").run(req.params.id); res.json({success:true});
});
router.get("/admin/api/titledata", adminApi, (req, res) => {
  res.json(db.prepare("SELECT * FROM mothershiptitledata ORDER BY datakey").all());
});
router.post("/admin/api/titledata", adminApi, csrfProtect, (req, res) => {
  if (!req.body.key) return res.status(400).json({error:"Missing key"});
  db.prepare("INSERT OR REPLACE INTO mothershiptitledata (datakey,datavalue,updatedat) VALUES (?,?,datetime('now'))").run(req.body.key,req.body.value||""); res.json({success:true});
});
router.delete("/admin/api/titledata/:key", adminApi, csrfProtect, (req, res) => {
  db.prepare("DELETE FROM mothershiptitledata WHERE datakey=?").run(req.params.key); res.json({success:true});
});
router.get("/admin/api/recent", adminApi, (req, res) => {
  res.json({
    players: db.prepare("SELECT playfabid,displayname,platform,lastlogin FROM players ORDER BY lastlogin DESC LIMIT 15").all(),
    grants: db.prepare("SELECT playfabid,grantedat FROM onlogin_grants ORDER BY grantedat DESC LIMIT 10").all(),
    bans: db.prepare("SELECT * FROM bans ORDER BY bannedat DESC LIMIT 20").all(),
  });
});

// ─── Ghost Game Sessions ─────────────────────────────────────
router.get("/admin/api/ghostgames", adminApi, (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const ms = req.query.mothershipid;
    let rows;
    if (ms) {
      rows = db.prepare("SELECT * FROM ghostgames WHERE mothershipid = ? ORDER BY createdat DESC LIMIT ?").all(ms, limit);
    } else {
      rows = db.prepare("SELECT * FROM ghostgames ORDER BY createdat DESC LIMIT ?").all(limit);
    }
    // Aggregate stats
    const total = db.prepare("SELECT COUNT(*) as c FROM ghostgames").get();
    const avgCores = db.prepare("SELECT AVG(final_cores_balance) as avg FROM ghostgames").get();
    const totalDeaths = db.prepare("SELECT SUM(died) as s FROM ghostgames").get();
    const totalCollected = db.prepare("SELECT SUM(total_cores_collected_by_player) as s FROM ghostgames").get();
    const uniquePlayers = db.prepare("SELECT COUNT(DISTINCT mothershipid) as c FROM ghostgames").get();
    res.json({
      sessions: rows,
      stats: {
        total: total.c || 0,
        avgCores: Math.round(avgCores.avg || 0),
        totalDeaths: totalDeaths.s || 0,
        totalCollected: totalCollected.s || 0,
        uniquePlayers: uniquePlayers.c || 0,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Oculus Username Lookup ───────────────────────────────────
router.get("/admin/api/oculus/:id", adminApi, async (req, res) => {
  try {
    const uid = req.params.id;

    // Check cache first
    const cached = db.prepare("SELECT * FROM oculus_profiles WHERE userid = ? AND updatedat > datetime('now', '-7 days')").get(uid);
    if (cached && cached.username) {
      return res.json({ username: cached.username, alias: cached.username, displayName: cached.username, avatarUrl: cached.avatar_url || null });
    }

    // Try Meta Graph API — only alias + display_name available with app token
    let username = null, displayName = null;
    if (config.metaaccesstoken) {
      try {
        const result = await getrequest(
          "graph.oculus.com",
          `/${uid}?access_token=${encodeURIComponent(config.metaaccesstoken)}&fields=alias,display_name`,
        );
        if (result.status === 200 && result.data) {
          username = result.data.alias || null;
          displayName = result.data.display_name || null;
        }
      } catch (_) {}
    }

    // DB fallbacks
    if (!username) {
      const dbPf = db.prepare("SELECT displayname FROM players WHERE oculusid = ?").get(uid);
      const nick = db.prepare("SELECT nickname FROM friendpresence WHERE playfabid = ?").get(dbPf?.playfabid || "");
      username = dbPf?.displayname || nick?.nickname || null;
    }

    // Cache result
    try {
      db.prepare("INSERT OR REPLACE INTO oculus_profiles (userid, username, updatedat) VALUES (?,?,datetime('now'))").run(uid, username || "");
    } catch (_) {}

    res.json({ username: username || displayName, alias: username, displayName: displayName || username, avatarUrl: null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Discord Bot Controls ──────────────────────────────────────
router.post("/admin/api/bot/playercount", adminApi, csrfProtect, requireOwner, async (req, res) => {
  try {
    const online = db.prepare("SELECT COUNT(*) as c FROM friendpresence WHERE roomid != ''").get();
    const total = db.prepare("SELECT COUNT(*) as c FROM players").get();
    const shifts = db.prepare("SELECT COUNT(*) as c FROM shifts WHERE completed = 1").get();
    const maps = db.prepare("SELECT COUNT(*) as c FROM sharedmaps").get();

    const embed = {
      title: "Gorilla Tag Server Stats",
      color: 3447003,
      fields: [
        { name: "Players Online", value: String(online?.c || 0), inline: true },
        { name: "Total Players", value: String(total?.c || 0), inline: true },
        { name: "Shifts Completed", value: String(shifts?.c || 0), inline: true },
        { name: "Shared Maps", value: String(maps?.c || 0), inline: true },
      ],
      timestamp: new Date().toISOString(),
    };

    if (config.discord_count_msg_channel) {
      await discordbot.sendChannelMessage(config.discord_count_msg_channel, null, embed);
    }
    res.json({ success: true, online: online?.c || 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Game Updates ─────────────────────────────────────────
router.post("/admin/api/updates", adminApi, csrfProtect, requireOwner, async (req, res) => {
  try {
    const { updated, bugged } = req.body;
    if (!updated && !bugged) return res.status(400).json({ error: "Provide at least updated or bugged text" });

    const description = [];
    if (updated) description.push("**# __UPDATED__**\n=========================\n" + updated);
    if (bugged) description.push("==========================================\n**# BUGGED:**\n=============\n" + bugged);

    const embed = {
      title: "Project RS Updates",
      color: 0x00f0ff,
      description: description.join("\n\n").slice(0, 4000),
      timestamp: new Date().toISOString(),
      footer: { text: "Project RS • Updates" },
    };

    const result = await discord.sendChannelMessage("1514135908763303987", null, embed);
    if (result && result.status >= 200 && result.status < 300) {
      res.json({ success: true });
    } else {
      console.error("[updates] Discord API error:", result?.status, JSON.stringify(result?.data));
      res.status(500).json({ error: "Discord API returned " + (result?.status || "?") + ": " + JSON.stringify(result?.data) });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Reports ───────────────────────────────────────────────
router.get("/admin/api/reports", adminApi, (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 200, 500);
    const rows = db.prepare("SELECT * FROM player_reports ORDER BY createdat DESC LIMIT ?").all(limit);
    const total = db.prepare("SELECT COUNT(*) as c FROM player_reports").get();
    res.json({ reports: rows, total: total?.c || 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/admin/api/reports/:id", adminApi, csrfProtect, requireOwner, (req, res) => {
  try {
    db.prepare("DELETE FROM player_reports WHERE id = ?").run(req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Dear Lemming ─────────────────────────────────────────────
router.get("/admin/api/dearlemmings", adminApi, (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const rows = db.prepare("SELECT dl.*, mp.userid as oculusid FROM dear_lemmings dl LEFT JOIN mothershipplayers mp ON dl.mothershipid = mp.mothershipid ORDER BY dl.createdat DESC LIMIT ?").all(limit);
    const total = db.prepare("SELECT COUNT(*) as c FROM dear_lemmings").get();
    res.json({ messages: rows, total: total?.c || 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/admin/api/dearlemmings/:id", adminApi, csrfProtect, requireOwner, (req, res) => {
  try {
    db.prepare("DELETE FROM dear_lemmings WHERE id = ?").run(req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Friends ──────────────────────────────────────────────────
router.get("/admin/api/player/:id/friends", adminApi, (req, res) => {
  try {
    const pid = req.params.id;
    const friends = db.prepare(`
      SELECT p.playfabid, p.displayname, p.platform, p.lastlogin, fp.roomid, fp.zone, fp.nickname
      FROM friendlinks fl
      JOIN players p ON (fl.friendid = p.playfabid OR fl.playerid = p.playfabid)
      LEFT JOIN friendpresence fp ON fp.playfabid = p.playfabid
      WHERE (fl.playerid = ? OR fl.friendid = ?) AND p.playfabid != ?
      ORDER BY p.displayname
    `).all(pid, pid, pid);

    res.json({
      count: friends.length,
      friends: friends.map(f => ({
        playfabid: f.playfabid,
        displayname: f.displayname || "Unknown",
        platform: f.platform || "Quest",
        lastlogin: f.lastlogin,
        online: !!f.roomid,
        roomid: f.roomid || null,
        zone: f.zone || null,
        nickname: f.nickname || null,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Admin Role Management (Owner only) ──────────────────────
router.get("/admin/api/roles", adminApi, requireOwner, (req, res) => {
  const roles = db.prepare("SELECT * FROM admin_roles ORDER BY createdat DESC").all();
  res.json({ roles });
});

router.post("/admin/api/roles", adminApi, csrfProtect, requireOwner, (req, res) => {
  const { role_id, name, perm_panel, perm_ban, perm_playfab } = req.body;
  if (!role_id || !name) return res.status(400).json({ error: "role_id and name required" });
  try {
    db.prepare(`INSERT OR REPLACE INTO admin_roles (role_id, name, perm_panel, perm_ban, perm_playfab)
      VALUES (?,?,?,?,?)`).run(
      role_id,
      name.trim(),
      perm_panel ? 1 : 0,
      perm_ban ? 1 : 0,
      perm_playfab ? 1 : 0,
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/admin/api/roles/:id", adminApi, csrfProtect, requireOwner, (req, res) => {
  try {
    db.prepare("DELETE FROM admin_roles WHERE role_id = ?").run(req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PlayFab Management APIs ──────────────────────────────────

// Combined player info
router.get("/admin/api/pf/player/:id", adminApi, async (req, res) => {
  try {
    const r = await pf.getplayercombinedinfo(req.params.id);
    res.json(r.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/admin/api/pf/player/:id/account", adminApi, async (req, res) => {
  try { const r = await pf.adminGetUserAccountInfo(req.params.id); res.json(r.data); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/admin/api/pf/player/:id/profile", adminApi, async (req, res) => {
  try { const r = await pf.adminGetPlayerProfile(req.params.id); res.json(r.data); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/admin/api/pf/player/:id/inventory", adminApi, async (req, res) => {
  try { const r = await pf.adminGetUserInventory(req.params.id); res.json(r.data); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/admin/api/pf/player/:id/bans", adminApi, async (req, res) => {
  try { const r = await pf.adminGetUserBans(req.params.id); res.json(r.data); } catch (e) { res.status(500).json({ error: e.message }); }
});

// User data (public / read-only / internal)
router.get("/admin/api/pf/player/:id/data", adminApi, async (req, res) => {
  try {
    const [pub, ro, internal] = await Promise.all([
      pf.getuserdata(req.params.id),
      pf.getuserreadonlydata(req.params.id),
      pf.getuserinternaldata(req.params.id),
    ]);
    res.json({ public: pub.data, readOnly: ro.data, internal: internal.data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/admin/api/pf/player/:id/data", adminApi, csrfProtect, async (req, res) => {
  try {
    const { key, value, permission } = req.body;
    const data = {};
    data[key] = value || "";
    const r = await pf.updateuserdata(req.params.id, data, permission || "Public");
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/admin/api/pf/player/:id/internal-data", adminApi, csrfProtect, async (req, res) => {
  try {
    const { key, value } = req.body;
    const data = {};
    data[key] = value || "";
    const r = await pf.updateuserinternaldata(req.params.id, data);
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/admin/api/pf/player/:id/statistics", adminApi, async (req, res) => {
  try { const r = await pf.getplayerstatistics(req.params.id); res.json(r.data); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/admin/api/pf/player/:id/statistics", adminApi, csrfProtect, async (req, res) => {
  try {
    const { name, value } = req.body;
    const r = await pf.updateplayerstatistics(req.params.id, [{ StatisticName: name, Value: parseInt(value) || 0 }]);
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Currency
router.post("/admin/api/pf/player/:id/add-vc", adminApi, csrfProtect, async (req, res) => {
  try {
    const { amount, currency } = req.body;
    const r = await pf.adminAddVirtualCurrency(req.params.id, parseInt(amount) || 0, currency || "SI");
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/admin/api/pf/player/:id/sub-vc", adminApi, csrfProtect, async (req, res) => {
  try {
    const { amount, currency } = req.body;
    const r = await pf.adminSubtractVirtualCurrency(req.params.id, parseInt(amount) || 0, currency || "SI");
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Grant items
router.post("/admin/api/pf/player/:id/grant-items", adminApi, csrfProtect, requirePlayFabPerm, requireApiSecret, async (req, res) => {
  try {
    const { itemIds, catalogVersion } = req.body;
    const ids = Array.isArray(itemIds) ? itemIds : (itemIds || "").split(",").map(s => s.trim()).filter(Boolean);
    const r = await pf.grantitemstouser(req.params.id, ids, catalogVersion);
    auditLog(req.adminUser?.discordId, req.adminUser?.username, "grant-items", `Granted ${ids.join(",")} to ${req.params.id}`, req.ip || "");
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Revoke items
router.post("/admin/api/pf/player/:id/revoke-items", adminApi, csrfProtect, requirePlayFabPerm, requireApiSecret, async (req, res) => {
  try {
    const { instanceIds } = req.body;
    const ids = Array.isArray(instanceIds) ? instanceIds : (instanceIds || "").split(",").map(s => s.trim()).filter(Boolean);
    const r = await pf.adminRevokeInventoryItems(req.params.id, ids);
    auditLog(req.adminUser?.discordId, req.adminUser?.username, "revoke-items", `Revoked from ${req.params.id}`, req.ip || "");
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Ban / Unban (PlayFab)
router.post("/admin/api/pf/player/:id/ban", adminApi, csrfProtect, requirePlayFabPerm, requireApiSecret, async (req, res) => {
  try {
    const { reason, hours } = req.body;
    const r = await pf.adminBanUsers([req.params.id], reason || "Banned by admin", hours || 0);
    auditLog(req.adminUser?.discordId, req.adminUser?.username, "pf-ban", `PF banned ${req.params.id}: ${reason}`, req.ip || "");
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/admin/api/pf/player/:id/unban", adminApi, csrfProtect, requirePlayFabPerm, requireApiSecret, async (req, res) => {
  try {
    const r = await pf.adminRevokeAllBans(req.params.id);
    auditLog(req.adminUser?.discordId, req.adminUser?.username, "pf-unban", `PF unbanned ${req.params.id}`, req.ip || "");
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete player (careful!)
router.delete("/admin/api/pf/player/:id", adminApi, csrfProtect, requirePlayFabPerm, requireApiSecret, async (req, res) => {
  try {
    const r = await pf.adminDeletePlayer(req.params.id);
    auditLog(req.adminUser?.discordId, req.adminUser?.username, "pf-delete", `Deleted player ${req.params.id}`, req.ip || "");
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Display name
router.post("/admin/api/pf/player/:id/display-name", adminApi, csrfProtect, async (req, res) => {
  try {
    const r = await pf.adminUpdateTitleDisplayName(req.params.id, req.body.displayName || "");
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Shared groups
router.get("/admin/api/pf/sharedgroup/:id", adminApi, async (req, res) => {
  try {
    const r = await pf.getsharedgroupdata(req.params.id, req.query.keys ? req.query.keys.split(",") : null);
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/admin/api/pf/sharedgroup/:id/data", adminApi, csrfProtect, async (req, res) => {
  try {
    const { data, permission, keysToRemove } = req.body;
    const r = await pf.updatesharedgroupdata(req.params.id, data || {}, permission || "Public", keysToRemove || null);
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/admin/api/pf/sharedgroup/:id/members", adminApi, csrfProtect, async (req, res) => {
  try {
    const { playfabIds } = req.body;
    const r = await pf.addsharedgroupmembers(req.params.id, playfabIds || []);
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Catalog & Stores
router.get("/admin/api/pf/catalog", adminApi, async (req, res) => {
  try {
    const ver = req.query.version || "DLC";
    const r = await pf.getcatalogitems(ver);
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/admin/api/pf/store/:id", adminApi, async (req, res) => {
  try {
    const r = await pf.getstoreitems(req.params.id, req.query.version || "DLC");
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Title data
router.get("/admin/api/pf/title/data", adminApi, async (req, res) => {
  try { const r = await pf.gettitledata(); res.json(r.data); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/admin/api/pf/title/internal", adminApi, async (req, res) => {
  try { const r = await pf.gettitleinternaldata(); res.json(r.data); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/admin/api/pf/title/publisher", adminApi, async (req, res) => {
  try { const r = await pf.getpublisherdata(); res.json(r.data); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/admin/api/pf/title/data", adminApi, csrfProtect, async (req, res) => {
  try {
    const { key, value } = req.body;
    const r = await pf.setitledata(key, value || "");
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/admin/api/pf/title/internal-data", adminApi, csrfProtect, async (req, res) => {
  try {
    const { key, value } = req.body;
    const r = await pf.settitleinternaldata(key, value || "");
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/admin/api/pf/time", adminApi, async (req, res) => {
  try { const r = await pf.gettime(); res.json(r.data); } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Event Control (TitleDataActivation) ──────────────────────
function isTitleDataActivationJson(raw) {
  try {
    const p = JSON.parse(raw);
    return !!(p && Array.isArray(p.Data) && p.Data.length > 0 && p.Data[0].TitleDataObjectID);
  } catch { return false; }
}

function detectEventKeys(tdData) {
  const events = {};
  for (const [key, raw] of Object.entries(tdData)) {
    if (typeof raw !== "string") continue;
    if (isTitleDataActivationJson(raw)) {
      try {
        const parsed = JSON.parse(raw);
        const objects = parsed.Data.map(o => o.TitleDataObjectID);
        events[key] = { desc: `${key} (${objects.length} objects)`, objects, raw, parsed };
      } catch { continue; }
    }
  }
  return events;
}

router.get("/admin/api/events", adminApi, async (req, res) => {
  try {
    const td = await pf.gettitledata();
    const data = td?.data?.data?.Data || {};
    const result = detectEventKeys(data);
    // Reference date
    const refDateKey = Object.keys(data).find(k => k.toLowerCase().includes("reference")) || null;
    result._referenceDate = { desc: "Base date for RelativeDateTimeWindow calculations", raw: refDateKey ? data[refDateKey] : "", keyFound: refDateKey };
    // Simple date keys (TimedStoreEvent, GoTime, etc.)
    result._simpleDates = {};
    for (const k of Object.keys(data)) {
      if (k === "MOTD") continue;
      const v = data[k];
      if (typeof v === "string" && /^\d{1,2}\/\d{1,2}\/\d{4}/.test(v.trim())) {
        result._simpleDates[k] = v;
      }
    }
    res.json({ current: result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/admin/api/events/save", adminApi, csrfProtect, async (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ error: "Missing key" });
    await pf.setitledata(key, value || "");
    auditLog(req.adminUser?.discordId, req.adminUser?.username, "event-save", `Saved event key ${key}`, req.ip || "");
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── MOTD ──────────────────────────────────────────────────────
router.get("/admin/api/motd", adminApi, async (req, res) => {
  try {
    const td = await pf.gettitledata();
    res.json({ motd: td?.data?.data?.Data?.MOTD || "" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/admin/api/motd", adminApi, csrfProtect, async (req, res) => {
  try {
    await pf.setitledata("MOTD", req.body.message || "");
    auditLog(req.adminUser?.discordId, req.adminUser?.username, "motd-set", `Set MOTD: ${(req.body.message||"").slice(0,100)}`, req.ip || "");
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Export master player data
router.post("/admin/api/pf/player/:id/export", adminApi, csrfProtect, async (req, res) => {
  try {
    const r = await pf.adminExportMasterPlayerData(req.params.id);
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Unified Search + Full Player Data ──────────────────────

// Search by any ID type: PlayFab ID, Oculus ID, Mothership ID, or Display Name
router.get("/admin/api/pf/search", adminApi, (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    if (!q) return res.json({ hits: [] });
    const like = "%" + q + "%";

    // Search players table (PlayFab identity)
    const pfPlayers = db.prepare(
      "SELECT playfabid, oculusid, displayname, platform, lastlogin FROM players WHERE playfabid LIKE ? OR oculusid LIKE ? OR displayname LIKE ? LIMIT 20"
    ).all(like, like, like);

    // Search mothershipplayers table
    const msPlayers = db.prepare(
      "SELECT userid, mothershipid, platform, lastlogin FROM mothershipplayers WHERE mothershipid LIKE ? OR userid LIKE ? LIMIT 20"
    ).all(like, like);

    // Build unified results: key by playfabid and merge where oculusid matches userid
    const results = [];
    const seenPf = new Set();

    for (const p of pfPlayers) {
      const nick = db.prepare("SELECT nickname FROM friendpresence WHERE playfabid = ?").get(p.playfabid);
      const entry = {
        playfabid: p.playfabid,
        displayname: p.displayname || nick?.nickname || "Unknown",
        oculusid: p.oculusid || null,
        mothershipid: null,
        platform: p.platform || "Quest",
        lastlogin: p.lastlogin,
        source: "PlayFab",
        mothershipPlayer: null,
      };
      if (p.oculusid) {
        const ms = db.prepare("SELECT * FROM mothershipplayers WHERE userid = ?").get(p.oculusid);
        if (ms) {
          entry.mothershipid = ms.mothershipid;
          entry.mothershipPlayer = ms;
        }
      }
      results.push(entry);
      seenPf.add(p.playfabid);
    }

    for (const m of msPlayers) {
      // Check if we already have this via a PlayFab match
      const existing = results.find(r => r.oculusid === m.userid);
      if (existing && !existing.mothershipid) {
        existing.mothershipid = m.mothershipid;
        existing.mothershipPlayer = m;
        continue;
      }
      // Not matched to a PlayFab player - add standalone
      if (!results.find(r => r.oculusid === m.userid)) {
        const linkedPf = db.prepare("SELECT playfabid, displayname, platform FROM players WHERE oculusid = ?").get(m.userid);
        const nick = linkedPf?.playfabid ? db.prepare("SELECT nickname FROM friendpresence WHERE playfabid = ?").get(linkedPf.playfabid) : null;
        results.push({
          playfabid: linkedPf ? linkedPf.playfabid : null,
          displayname: linkedPf ? (linkedPf.displayname || nick?.nickname || "Mothership Player") : "Mothership Player",
          oculusid: m.userid,
          mothershipid: m.mothershipid,
          platform: linkedPf ? linkedPf.platform : (m.platform || "RIFT"),
          lastlogin: m.lastlogin,
          source: "Mothership",
          mothershipPlayer: m,
        });
      }
    }

    res.json({ hits: results.slice(0, 30) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Full combined player data (PlayFab + Mothership)
router.get("/admin/api/pf/player/:id/full", adminApi, async (req, res) => {
  try {
    const id = req.params.id;
    const result = { playfab: null, mothership: null, identity: null };

    // Try PlayFab lookup
    try {
      const pfData = await pf.getplayercombinedinfo(id);
      result.playfab = pfData.data || pfData;
    } catch (e) { result.playfab = { error: e.message }; }

    // Determine oculusid from PlayFab response or DB
    let oculusid = null;
    if (result.playfab && !result.playfab.error) {
      oculusid = result.playfab.data?.InfoResultPayload?.AccountInfo?.TitleInfo?.DisplayName || null;
    }
    if (!oculusid) {
      const dbPlayer = db.prepare("SELECT oculusid FROM players WHERE playfabid = ?").get(id);
      oculusid = dbPlayer ? dbPlayer.oculusid : null;
    }

    // Look up Mothership data
    let mothershipid = null;
    if (oculusid) {
      const ms = db.prepare("SELECT * FROM mothershipplayers WHERE userid = ?").get(oculusid);
      if (ms) mothershipid = ms.mothershipid;
    }
    // Also try mothershipplayers by mothershipid directly (in case id is a mothershipid)
    if (!mothershipid) {
      const ms = db.prepare("SELECT * FROM mothershipplayers WHERE mothershipid = ?").get(id);
      if (ms) { mothershipid = ms.mothershipid; oculusid = ms.userid; }
    }

    result.identity = { oculusid, mothershipid, playfabid: id };
    result.mothership = { mothershipid };

    if (mothershipid) {
      const tables = ["progression", "shiftcredits", "juicerstatus", "dockwrist", "reactorstats", "reactorinventory", "siquests", "progressionnodes", "drillupgrades", "codeconsumptions", "code_redemptions", "mothershipinventory", "mothershipuserdata", "mothershipplayers"];
      for (const t of tables) {
        try {
          if (t === "progressionnodes") {
            result.mothership[t] = db.prepare("SELECT * FROM progressionnodes WHERE mothershipid = ?").all(mothershipid);
          } else if (t === "codeconsumptions") {
            result.mothership[t] = db.prepare("SELECT * FROM codeconsumptions WHERE mothershipid = ? LIMIT 50").all(mothershipid);
          } else if (t === "code_redemptions") {
            result.mothership[t] = db.prepare("SELECT * FROM code_redemptions WHERE mothershipid = ? LIMIT 50").all(mothershipid);
          } else if (t === "mothershipuserdata") {
            result.mothership[t] = db.prepare("SELECT * FROM mothershipuserdata WHERE mothershipid = ?").all(mothershipid);
          } else {
            const row = db.prepare("SELECT * FROM " + t + " WHERE mothershipid = ?").get(mothershipid);
            result.mothership[t] = row || null;
          }
        } catch (_) { result.mothership[t] = null; }
      }
      // Discord link
      try { result.discord_link = db.prepare("SELECT * FROM discord_links WHERE mothershipid = ? OR playfabid = ?").get(mothershipid, id) || null; } catch (_) {}
    }

    // Add friends count
    const fc = db.prepare("SELECT COUNT(*) as c FROM friendlinks WHERE playerid = ?").get(id);
    result.friendsCount = fc ? fc.c : 0;

    // Add bans
    const bans = db.prepare("SELECT * FROM bans WHERE playfabid = ?").all(id);
    result.bans = bans;

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Server static files ─────────────────────────────────────
const distDir = path.join(__dirname, "..", "admin-dist");
const hasBuild = fs.existsSync(distDir);

if (hasBuild) {
  router.use("/admin", express.static(distDir));
  // fallback index.html for SPA routing
  router.get("/admin", requireAdmin, (req, res) => {
    res.sendFile(path.join(distDir, "index.html"));
  });
}

// ─── Admin: Redeemable Codes ─────────────────────────────────────
router.get("/admin/api/redeemable-codes", adminApi, (req, res) => {
  try {
    const rows = db.prepare("SELECT * FROM redeemable_codes ORDER BY created_at DESC").all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/admin/api/redeemable-codes", adminApi, csrfProtect, (req, res) => {
  try {
    const body = req.body || {};
    const code = sanitizestr(body.code || "", 16).toUpperCase().trim();
    const item_id = sanitizestr(body.item_id || "", 64);
    const playfab_item_name = sanitizestr(body.playfab_item_name || "", 128);
    const start_time = body.start_time || null;
    const end_time = body.end_time || null;
    const max_uses = typeof body.max_uses === "number" ? body.max_uses : -1;
    const created_by = sanitizestr(body.created_by || "", 64);

    if (!code || code.length < 4 || !item_id) {
      return res.status(400).json({ error: "Code (4+ chars) and item_id required" });
    }
    const existing = db.prepare("SELECT id FROM redeemable_codes WHERE code = ?").get(code);
    if (existing) return res.status(409).json({ error: "Code already exists" });

    db.prepare(
      "INSERT INTO redeemable_codes (code, item_id, playfab_item_name, start_time, end_time, max_uses, created_by) VALUES (?,?,?,?,?,?,?)"
    ).run(code, item_id, playfab_item_name, start_time, end_time, max_uses, created_by);

    const row = db.prepare("SELECT * FROM redeemable_codes WHERE code = ?").get(code);
    auditLog(req.adminUser?.discordId, req.adminUser?.username, "redeemable-create", `Created code ${code} for item ${item_id}`, req.ip || "");
    res.status(201).json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/admin/api/redeemable-codes/:id/deactivate", adminApi, csrfProtect, (req, res) => {
  try {
    db.prepare("UPDATE redeemable_codes SET active = 0 WHERE id = ?").run(req.params.id);
    auditLog(req.adminUser?.discordId, req.adminUser?.username, "redeemable-deactivate", `Deactivated code id ${req.params.id}`, req.ip || "");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/admin/api/redeemable-codes/:id/redemptions", adminApi, (req, res) => {
  try {
    const rows = db.prepare(
      "SELECT cr.*, mp.userid as oculusid FROM code_redemptions cr LEFT JOIN mothershipplayers mp ON cr.mothershipid = mp.mothershipid WHERE cr.code_id = ? ORDER BY cr.redeemed_at DESC"
    ).all(req.params.id);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Q&A Management (backed by dear_lemmings) ───────────────────
router.get("/admin/api/qa/questions", adminApi, (req, res) => {
  try {
    const pg = Math.max(1, parseInt(req.query.page) || 1);
    const lim = Math.min(parseInt(req.query.limit) || 50, 200);
    const off = (pg - 1) * lim;
    const statusFilter = req.query.status || "";
    let where = "";
    if (statusFilter === "pending") { where = " WHERE status = 'pending'"; }
    else if (statusFilter === "answered") { where = " WHERE status = 'answered'"; }
    else if (statusFilter === "closed") { where = " WHERE status = 'closed'"; }
    const total = db.prepare("SELECT COUNT(*) as c FROM dear_lemmings" + where).get();
    const rows = db.prepare(`
      SELECT id, mothershipid, message_text as question_text, display_name as author_name,
             status, answer_text, answered_by, answered_at, createdat,
             CASE WHEN answer_text != '' THEN 1 ELSE 0 END as answer_count
      FROM dear_lemmings${where} ORDER BY createdat DESC LIMIT ? OFFSET ?
    `).all(lim, off);
    res.json({ questions: rows, total: total.c, page: pg, limit: lim });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/admin/api/qa/questions/:id", adminApi, (req, res) => {
  try {
    const q = db.prepare("SELECT * FROM dear_lemmings WHERE id = ?").get(req.params.id);
    if (!q) return res.status(404).json({ error: "Not found" });
    res.json({
      question: { id: q.id, question_text: q.message_text, author_name: q.display_name, status: q.status, createdat: q.createdat },
      answers: q.answer_text ? [{ id: 1, answer_text: q.answer_text, answered_by: q.answered_by, createdat: q.answered_at }] : [],
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/admin/api/qa/questions/:id/answer", adminApi, csrfProtect, (req, res) => {
  try {
    const text = (req.body.answer || "").trim();
    if (!text) return res.status(400).json({ error: "Answer text required" });
    const name = req.adminUser?.username || "Admin";
    db.prepare("UPDATE dear_lemmings SET answer_text = ?, answered_by = ?, answered_at = datetime('now'), status = 'answered' WHERE id = ? AND status != 'closed'").run(text, name, req.params.id);
    auditLog(req.adminUser?.discordId, req.adminUser?.username, "qa-answer", `Answered Q ${req.params.id}`, req.ip || "");
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/admin/api/qa/questions/:id/status", adminApi, csrfProtect, (req, res) => {
  try {
    const status = req.body.status;
    if (!["pending","answered","closed"].includes(status)) return res.status(400).json({ error: "Invalid status" });
    db.prepare("UPDATE dear_lemmings SET status = ? WHERE id = ?").run(status, req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/admin/api/qa/questions/:id", adminApi, csrfProtect, requireOwner, (req, res) => {
  try {
    db.prepare("DELETE FROM dear_lemmings WHERE id = ?").run(req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.adminApi = adminApi;
module.exports.requireAdmin = requireAdmin;
