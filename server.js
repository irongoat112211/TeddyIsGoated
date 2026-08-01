const express = require("express");
const http = require("http");
const https = require("https");
const helmet = require("helmet");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const config = require("./lib/config");
const { globallimiter } = require("./middleware/ratelimit");
const wsserver = require("./lib/wsserver");
const dnsserver = require("./lib/dnsserver");

const { db } = require("./lib/database");

const authroutes = require("./routes/auth");
const photonroutes = require("./routes/photon");
const titledataroutes = require("./routes/titledata");
const iaproutes = require("./routes/iap");
const mmrroutes = require("./routes/mmr");
const friendsroutes = require("./routes/friends");
const votingroutes = require("./routes/voting");
const questsroutes = require("./routes/quests");
const progressionroutes = require("./routes/progression");
const siquestsroutes = require("./routes/siquests");
const promoroutes = require("./routes/promo");
const kidroutes = require("./routes/kid");
const modioroutes = require("./routes/modio");
const sharedblocksroutes = require("./routes/sharedblocks");
const moderationroutes = require("./routes/moderation");
const mothershiproutes = require("./routes/mothership");
const playfabcloudroutes = require("./routes/playfabcloud");
const adminroutes = require("./routes/admin");
const { adminApi, requireAdmin } = adminroutes;
const qaroutes = require("./routes/qa");
const { router: purchaseroutes, setClient: setPurchaseClient } = require("./routes/purchase");
const playfab = require("./lib/playfab");
const webhook = require("./lib/webhook");
const { ROLE_MAP, ALL_ROLE_ITEMS } = require("./lib/rolemap");

// ─── Cosmetics autocomplete data ─────────────────────────────
let cosmeticsData = null;
function loadCosmetics() {
  const filePath = path.join(__dirname, "CosmeticsExport.txt");
  if (!fs.existsSync(filePath)) { cosmeticsData = []; return; }
  const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
  const items = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split("\t");
    if (cols.length >= 5) {
      const itemId = cols[2].trim();
      const displayName = cols[3].trim();
      const overrideName = cols[4].trim();
      items.push({
        item_id: itemId,
        display_name: displayName,
        override_display_name: overrideName || displayName,
        label: (overrideName || displayName) + " (" + itemId + ")",
      });
    }
  }
  cosmeticsData = items;
}
loadCosmetics();

const app = express();
app.set("trust proxy", 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://unpkg.com", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", "data:", "https:"],
    },
  },
}));
app.use(cors());

app.use((req, res, next) => {
  if (req.url.startsWith("//")) {
    req.url = req.url.replace(/\/{2,}/g, "/");
  }
  next();
});

app.use(express.json({ limit: "5mb", type: ["application/json", "application/octet-stream", "text/plain"] }));
app.use(express.text({ limit: "5mb" }));
app.use(globallimiter);

app.use((req, res, next) => {
  const rpath = req.url.replace(/\/{2,}/g, "/");
  if (rpath.startsWith("/api") || rpath.startsWith("/v1") || rpath.startsWith("/v2") || rpath.startsWith("/CloudScript")) {
    const noisy = rpath.includes("/analytics/event/batch") || rpath.includes("/api/rslog") || rpath.includes("/api/photon") || rpath.includes("TryDistributeCurrencyV2");
    if (!noisy) console.log(`[${req.method}] ${req.hostname}${req.originalUrl}`);
    try {
      if (!fs.existsSync(config.event_log_dir)) fs.mkdirSync(config.event_log_dir, { recursive: true });
      const date = new Date().toISOString().slice(0, 10);
      const lf = path.join(config.event_log_dir, `requests-${date}.log`);
      const logentry = {
        time: new Date().toISOString(),
        method: req.method,
        host: req.hostname,
        url: req.originalUrl,
        headers: req.headers,
        body: req.body,
      };
      fs.appendFileSync(lf, JSON.stringify(logentry) + "\n");
    } catch (_) {}
  }
  next();
});

app.use((req, res, next) => {
  const rpath = req.url.replace(/\/{2,}/g, "/");
  if (rpath.startsWith("/api") || rpath.startsWith("/v1") || rpath.startsWith("/v2") || rpath.startsWith("/CloudScript")) {
    const orig = res.json.bind(res);
    res.json = function (body) {
      const ts = new Date().toISOString();
      try {
        if (!fs.existsSync(config.event_log_dir)) fs.mkdirSync(config.event_log_dir, { recursive: true });
        const date = ts.slice(0, 10);
        const lf = path.join(config.event_log_dir, `responses-${date}.log`);
        const logentry = { time: ts, method: req.method, url: req.originalUrl, status: res.statusCode, response: body };
        fs.appendFileSync(lf, JSON.stringify(logentry) + "\n");
      } catch (_) {}
      return orig(body);
    };
    const origsend = res.send.bind(res);
    res.send = function (body) {
      const ts = new Date().toISOString();
      try {
        if (!fs.existsSync(config.event_log_dir)) fs.mkdirSync(config.event_log_dir, { recursive: true });
        const date = ts.slice(0, 10);
        const lf = path.join(config.event_log_dir, `responses-${date}.log`);
        const logentry = { time: ts, method: req.method, url: req.originalUrl, status: res.statusCode, response: typeof body === 'string' ? body : String(body) };
        fs.appendFileSync(lf, JSON.stringify(logentry) + "\n");
      } catch (_) {}
      return origsend(body);
    };
  }
  next();
});

app.use((req, res, next) => {
  if (req.headers["content-type"] && req.headers["content-type"].includes("application/json") && !req.body) {
    req.body = {};
  }
  next();
});

app.use("/api", authroutes);
app.use("/api", photonroutes);
app.use("/api", titledataroutes);
app.use("/api", iaproutes);
app.use("/api", mmrroutes);
app.use("/api", friendsroutes);
app.use("/api", votingroutes);
app.use("/api", questsroutes);
app.use("/api", progressionroutes);
app.use("/api", siquestsroutes);
app.use("/api", promoroutes);
app.use("/api", kidroutes);
app.use("/api", modioroutes);
app.use("/api", sharedblocksroutes);
app.use("/api", moderationroutes);

app.use("/api", playfabcloudroutes);

app.use("/", playfabcloudroutes);

app.use("/", mothershiproutes);

app.use("/api/purchase", purchaseroutes);
app.use("/api", qaroutes);
app.use("/qa", express.static(path.join(__dirname, "public")));
app.get("/qa", (req, res) => res.sendFile(path.join(__dirname, "public", "qa.html")));

// simple cookie parser for admin panel
app.use((req, res, next) => {
  req.cookies = {};
  const h = req.headers.cookie;
  if (h) h.split(";").forEach(c => { const p = c.trim().split("="); req.cookies[p[0]] = p[1]; });
  next();
});
app.get("/", (req, res) => {
  res.status(200).send("ok");
});
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

// TitleData editor page + API (admin auth via cookie)
app.get("/titledata", requireAdmin, (req, res) =>
  res.sendFile(path.join(__dirname, "public", "titledata-editor.html"))
);

// AppLab page + API (public page, admin-only update)
app.get("/builds", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "builds.html"))
);
app.get("/api/applab", (req, res) => {
  try {
    const raw = fs.readFileSync(path.join(__dirname, "data", "applab.json"), "utf8");
    res.json(JSON.parse(raw));
  } catch (e) { res.json({ link: "" }); }
});
app.post("/api/applab", adminApi, async (req, res) => {
  try {
    const link = (req.body.link || "").trim();
    if (!link || !link.startsWith("https://")) return res.status(400).json({ error: "Invalid link" });
    // Fetch meta tags from AppLab page
    let title = "", image = "", desc = "";
    try {
      const meta = await new Promise((resolve, reject) => {
        const u = new URL(link);
        https.get({ hostname: u.hostname, path: u.pathname + u.search, headers: { "User-Agent": "ProjectRS/1.0" }, timeout: 8000 }, (r) => {
          let body = ""; r.on("data", c => body += c); r.on("end", () => resolve(body));
        }).on("error", reject).on("timeout", function() { this.destroy(); resolve(""); });
      });
      const ogTitle = meta.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
      const ogImage = meta.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
      const ogDesc  = meta.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i);
      const twTitle = meta.match(/<meta\s+name="twitter:title"\s+content="([^"]+)"/i);
      const twImage = meta.match(/<meta\s+name="twitter:image"\s+content="([^"]+)"/i);
      const twDesc  = meta.match(/<meta\s+name="twitter:description"\s+content="([^"]+)"/i);
      const pageTitle = meta.match(/<title>([^<]+)<\/title>/i);
      title = (ogTitle || twTitle || pageTitle || [])[1] || "";
      image = (ogImage || twImage || [])[1] || "";
      desc  = (ogDesc  || twDesc  || [])[1] || "";
      if (image && !image.startsWith("http")) image = u.origin + (image.startsWith("/") ? "" : "/") + image;
    } catch (e) { console.log("[applab] meta fetch failed:", e.message); }

    // Download & save image locally (bypasses Oculus CDN hotlink blocking)
    let localImage = "";
    if (image) {
      try {
        const imgData = await new Promise((resolve, reject) => {
          const iu = new URL(image);
          const chunks = [];
          https.get({ hostname: iu.hostname, path: iu.pathname + iu.search, headers: { "User-Agent": "Mozilla/5.0" }, timeout: 15000 }, (r) => {
            if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
              // Follow redirect
              const ru = new URL(r.headers.location, image);
              https.get({ hostname: ru.hostname, path: ru.pathname + ru.search, headers: { "User-Agent": "Mozilla/5.0" }, timeout: 15000 }, (r2) => {
                r2.on("data", c => chunks.push(c));
                r2.on("end", () => resolve(Buffer.concat(chunks)));
                r2.on("error", reject);
              }).on("timeout", function() { this.destroy(); reject(new Error("timeout")); });
            } else {
              r.on("data", c => chunks.push(c));
              r.on("end", () => resolve(Buffer.concat(chunks)));
              r.on("error", reject);
            }
          }).on("error", reject).on("timeout", function() { this.destroy(); reject(new Error("timeout")); });
        });
        const ext = image.match(/\.(webp|png|jpg|jpeg|gif)(\?|$)/i)?.[1] || "webp";
        fs.writeFileSync(path.join(__dirname, "public", "applab-icon." + ext), imgData);
        // Delete old icon files
        for (const old of ["applab-icon.webp","applab-icon.png","applab-icon.jpg","applab-icon.jpeg","applab-icon.gif"]) {
          if (old !== "applab-icon." + ext) {
            try { fs.unlinkSync(path.join(__dirname, "public", old)); } catch (_) {}
          }
        }
        localImage = "/applab-icon." + ext;
      } catch (e) { console.log("[applab] image download failed:", e.message); }
    }

    const data = { link, title, image: localImage || image, desc };
    fs.writeFileSync(path.join(__dirname, "data", "applab.json"), JSON.stringify(data, null, 2), "utf8");
    res.json({ ok: true, ...data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/titledata-editor", adminApi, (req, res) => {
  try {
    const raw = fs.readFileSync(path.join(__dirname, "data", "titledata.json"), "utf8");
    const obj = JSON.parse(raw);
    const map = {};
    if (obj && obj.Results) {
      for (const item of obj.Results) {
        map[item.key] = item.data;
      }
    }
    res.json(map);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/titledata-editor", adminApi, (req, res) => {
  try {
    const map = req.body;
    if (!map || typeof map !== "object") return res.status(400).send("Invalid body");
    const results = [];
    for (const key of Object.keys(map).sort()) {
      results.push({ key, data: map[key] });
    }
    const output = JSON.stringify({ Results: results });
    fs.writeFileSync(path.join(__dirname, "data", "titledata.json"), output, "utf8");
    res.json({ ok: true, count: results.length });
  } catch (e) {
    console.error("[titledata-editor] save error:", e.message);
    res.status(500).send(e.message);
  }
});
app.get("/privacy", (req, res) => {
  res.status(200).send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Project RS — Privacy Policy</title><style>body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;line-height:1.7;color:#e0e0e0;background:#0d1117}h1,h2{color:#58a6ff}a{color:#58a6ff}hr{border:none;border-top:1px solid #30363d}</style></head><body><h1>Project RS Privacy Policy</h1><p><strong>Last updated:</strong> June 2026</p><hr><h2>Data Collected</h2><p>Discord user IDs are stored in a local database to link Discord accounts to in-game accounts for account management, friend requests, and moderation purposes. No messages, channel content, or personal communications are stored or read outside of explicitly invoked commands.</p><h2>Data Retention</h2><p>Data is retained until the user requests deletion via the <code>/unlink</code> command or by contacting the bot owner.</p><h2>Data Deletion</h2><p>Users can unlink their account at any time using <code>/unlink</code> in the designated channel, which removes all stored Discord ID associations from the database. For full data deletion, contact the email below.</p><h2>Third-Party Sharing</h2><p>No data is shared with third parties.</p><h2>Contact</h2><p><a href="mailto:eli@rowstonsoftware.com">eli@rowstonsoftware.com</a></p></body></html>`);
});
app.head("/", (req, res) => {
  res.status(200).end();
});

// ─── Monke Graph Data API ──────────────────────────────────
app.get("/api/monke/graph", (req, res) => {
  try {
    const hours = req.query.hours;
    let snapshots;
    if (hours === "all" || hours === "0" || hours === undefined || hours === null || hours === "") {
      snapshots = db.prepare("SELECT online, createdat FROM player_count_snapshots ORDER BY createdat ASC").all();
    } else {
      const h = parseFloat(hours) || 24;
      const cutoff = toSqliteDate(new Date(Date.now() - h * 3600000));
      snapshots = db.prepare(
        "SELECT online, createdat FROM player_count_snapshots WHERE createdat > ? ORDER BY createdat ASC"
      ).all(cutoff);
    }

    // Filter out noise (±10 from previous value, like the Python bot)
    const filtered = [];
    for (let i = 0; i < snapshots.length; i++) {
      if (i === 0) { filtered.push(snapshots[i]); continue; }
      const prev = filtered[filtered.length - 1];
      if (Math.abs(snapshots[i].online - prev.online) <= 10) {
        filtered.push(snapshots[i]);
      }
    }

    // Subsample to max 256 points
    const step = Math.max(1, Math.floor(filtered.length / 256));
    const sampled = filtered.filter((_, i) => i % step === 0);

    res.json(sampled.map(s => ({
      timestamp: s.createdat,
      player_count: s.online,
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Latest monke count ────────────────────────────────────
app.get("/api/monke/latest", (req, res) => {
  try {
    const online = db.prepare("SELECT COUNT(*) as c FROM friendpresence WHERE roomid != ''").get();
    const total = db.prepare("SELECT COUNT(*) as c FROM players").get();
    res.json({ player_count: online?.c || 0, total_players: total?.c || 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.use((req, res) => {
  if (req.originalUrl.startsWith("/api") || req.originalUrl.startsWith("/v1") || req.originalUrl.startsWith("/v2")) {
    console.warn(`[404] ${req.method} ${req.hostname}${req.originalUrl}`);
  }
  res.status(404).send("Not found");
});

app.use((err, req, res, next) => {
  console.error("[uncaught]", err.message);
  res.status(500).send("Internal error");
});

const server = http.createServer(app);
wsserver.attachto(server);
server.listen(config.port, config.host, () => {
  console.log(`[server] listening on ${config.host}:${config.port}`);
  console.log(`[server] endpoints mounted under /api, /v1, /v2`);
  dnsserver.start(config.dnsredirectip);
});

// Also start HTTPS/WSS for local testing with self-signed cert
const wssPort = 3068;
const keyPath = path.join(__dirname, "server.key");
const certPath = path.join(__dirname, "server.cert");
if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
  const httpsOptions = {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  };
  const wssServer = https.createServer(httpsOptions, app);
  wsserver.attachto(wssServer);
  wssServer.listen(wssPort, "0.0.0.0", () => {
    console.log(`[wss] WSS server listening on 0.0.0.0:${wssPort}`);
        });
      }

// ─── Discord Bot Features ────────────────────────────────────
const discordbot = require("./lib/discordbot");

function toSqliteDate(date) {
  const d = date || new Date();
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth()+1).padStart(2,'0') + '-' + String(d.getUTCDate()).padStart(2,'0') + ' ' + String(d.getUTCHours()).padStart(2,'0') + ':' + String(d.getUTCMinutes()).padStart(2,'0') + ':' + String(d.getUTCSeconds()).padStart(2,'0');
}

function fuzzyScore(a, b) {
  a = a.toLowerCase(); b = b.toLowerCase();
  let matches = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] === b[i]) matches++;
  }
  return matches / Math.max(a.length, b.length);
}

function getHistory(hours) {
  try {
    const cutoff = toSqliteDate(new Date(Date.now() - hours * 3600000));
    return db.prepare(
      "SELECT online, total, createdat FROM player_count_snapshots WHERE createdat > ? ORDER BY createdat ASC"
    ).all(cutoff);
  } catch { return []; }
}

async function updatePlayerCountChannel(client) {
  try {
    const count = wsserver.ccu ? wsserver.ccu() : 0;
    const total = db.prepare("SELECT COUNT(*) as c FROM players").get();
    const totalC = total?.c || 0;

    // Save snapshot
    db.prepare("INSERT INTO player_count_snapshots (online, total) VALUES (?,?)").run(count, totalC);

    // Rename voice channel via REST
    if (config.discord_count_channel) {
      try { await discordbot.renameChannel(config.discord_count_channel, `Online: ${count}`); } catch (_) {}
    }

    // Update bot status
    if (client && client.user) {
      client.user.setActivity(`${count} players`, { type: 3 }).catch(() => {});
    }
  } catch (_) {}
}

// ─── Room List Auto-Updating Message ─────────────────────────
let roomListLastHash = "";
async function updateRoomListMessage(client) {
  try {
    const channel = await client.channels.fetch("1513753897372483725").catch(() => null);
    if (!channel) return;
    const rows = db.prepare("SELECT fp.playfabid, fp.roomid, fp.zone, fp.region, fp.nickname, p.displayname FROM friendpresence fp LEFT JOIN players p ON p.playfabid = fp.playfabid LEFT JOIN privacystates ps ON ps.playfabid = fp.playfabid WHERE fp.roomid != '' AND (ps.state IS NULL OR ps.state != 'HIDDEN') ORDER BY fp.region, fp.nickname").all();
    const hash = JSON.stringify(rows);
    if (hash === roomListLastHash) return;
    roomListLastHash = hash;
    const groups = {};
    for (const r of rows) {
      const key = r.region || "Unknown";
      if (!groups[key]) groups[key] = [];
      groups[key].push("`" + (r.displayname || r.nickname || r.playfabid) + "` in **" + r.roomid + "**" + (r.zone ? " (" + r.zone + ")" : ""));
    }
    const desc = rows.length ? Object.entries(groups).map(([region, list]) => "**" + region + "** (" + list.length + ")\n" + list.join("\n")).join("\n\n") : "No one is currently in a room.";
    const embed = { color: 3447003, title: "👥 Players In Rooms (" + rows.length + ")", description: desc.slice(0, 4000), timestamp: new Date().toISOString() };
    const savedId = db.prepare("SELECT datavalue FROM mothershiptitledata WHERE datakey = 'room_list_msg_id'").pluck().get();
    if (savedId) {
      const msg = await channel.messages.fetch(savedId).catch(() => null);
      if (msg) { await msg.edit({ embeds: [embed] }).catch(() => {}); return; }
    }
    const msg = await channel.send({ embeds: [embed] }).catch(() => null);
    if (msg) db.prepare("INSERT OR REPLACE INTO mothershiptitledata (datakey, datavalue) VALUES ('room_list_msg_id', ?)").run(msg.id);
  } catch (_) {}
}

// ─── Audit Links Auto-Updating Message ────────────────────────
let auditLinksLastHash = "";
async function updateAuditLinksMessage(client) {
  try {
    const channel = await client.channels.fetch("1514039171843625130").catch(() => null);
    if (!channel) return;
    const adminMembers = [];
    let lastId = "";
    while (true) {
      const r = await discordbot.discordApi(`/guilds/${config.discord_guild_id}/members?limit=1000${lastId ? "&after=" + lastId : ""}`);
      if (r.status !== 200 || !r.data?.length) break;
      for (const m of r.data) {
        if (m.roles && m.roles.includes("1412161751020998666")) adminMembers.push(m);
      }
      lastId = r.data[r.data.length - 1].user?.id;
      if (!lastId || r.data.length < 1000) break;
    }
    const hash = JSON.stringify(adminMembers.map(m => m.user.id));
    if (hash === auditLinksLastHash) return;
    auditLinksLastHash = hash;
    let linked = 0, unlinked = 0;
    const lines = [];
    for (const m of adminMembers) {
      const dl = db.prepare("SELECT playfabid FROM discord_links WHERE discord_id = ?").get(m.user.id);
      if (dl) { linked++; lines.push("✅ <@" + m.user.id + "> → `" + dl.playfabid + "`"); }
      else { unlinked++; lines.push("❌ <@" + m.user.id + "> → **NOT LINKED**"); }
    }
    const desc = "## 🔗 Admin Link Audit\n**" + linked + " linked / " + unlinked + " unlinked**\n" + lines.join("\n");
    const embed = { color: 0x5865F2, description: desc.slice(0, 4000), footer: { text: "🔄 Updates every 5 minutes" } };
    const savedId = db.prepare("SELECT datavalue FROM mothershiptitledata WHERE datakey = 'audit_links_msg_id'").pluck().get();
    if (savedId) {
      const msg = await channel.messages.fetch(savedId).catch(() => null);
      if (msg) { await msg.edit({ embeds: [embed] }).catch(() => {}); return; }
    }
    const msg = await channel.send({ embeds: [embed] }).catch(() => null);
    if (msg) db.prepare("INSERT OR REPLACE INTO mothershiptitledata (datakey, datavalue) VALUES ('audit_links_msg_id', ?)").run(msg.id);
  } catch (_) {}
}

// ─── Community Helper (module-level, shared across functions) ──
const CH_ITEM_ID = "LBAOT.";
const CH_ROLE_ID = "1521038734450102344";
const BOOSTER_ROLE_ID = "1411936252495925291";
const CH_PLAYTIME_GAIN_MIN = 600;
const CH_PLAYTIME_KEEP_MIN = 420;
const CH_PLAYTIME_GAIN_BOOSTER = 420;
const CH_PLAYTIME_KEEP_BOOSTER = 300;
const CH_MSG_GAIN = 500;
const CH_MSG_KEEP = 200;
const CH_MSG_GAIN_BOOSTER = 300;
const CH_MSG_KEEP_BOOSTER = 150;
let chClient = null; // set by startDiscordGateway

function chProgressBar(current, max, length) {
  const filled = Math.min(length, Math.round((current / max) * length));
  return "█".repeat(filled) + "░".repeat(length - filled);
}

async function chTryGrant(discordId, playfabid) {
  const guild = chClient?.guilds?.cache?.first();
  if (guild) {
    const member = await guild.members.fetch(discordId).catch(() => null);
    if (member && !member.roles.cache.has(CH_ROLE_ID)) await member.roles.add(CH_ROLE_ID);
  }
  const inv = await playfab.getuserinventory(playfabid);
  const hasItem = inv?.data?.data?.Inventory?.some(i => i.ItemId === CH_ITEM_ID);
  if (!hasItem) await playfab.grantitemstouser(playfabid, [CH_ITEM_ID], "DLC");
  db.prepare("UPDATE community_helpers SET status = 'active' WHERE discord_id = ?").run(discordId);
  // DM the user
  try {
    const user = await chClient?.users?.fetch(discordId);
      if (user) await user.send("🙌 **You're now a Community Helper!**\n\nYou've been given the **@Community Helper** role and the **MONKE MAYHEM STAFF SHIRT** to show your status.\n\nTo keep it you need **7 hours** of playtime and **" + CH_MSG_KEEP + " Discord messages** (rolling 30d).");
  } catch (_) {}
  // Audit log
  try { db.prepare("INSERT INTO admin_audit_log (discordid, username, action, details) VALUES (?, '', 'ch_grant', ?)").run(discordId, playfabid); } catch (_) {}
  console.log("[ch] granted active to", discordId, playfabid);
}

async function chTryRevoke(discordId, playfabid) {
  const guild = chClient?.guilds?.cache?.first();
  if (guild) {
    const member = await guild.members.fetch(discordId).catch(() => null);
    if (member && member.roles.cache.has(CH_ROLE_ID)) await member.roles.remove(CH_ROLE_ID);
  }
  // Revoke PlayFab item
  try {
    const inv = await playfab.getuserinventory(playfabid);
    const instances = inv?.data?.data?.Inventory?.filter(i => i.ItemId === CH_ITEM_ID).map(i => i.ItemInstanceId);
    if (instances?.length) {
      for (let j = 0; j < instances.length; j += 10) {
        await playfab.adminRevokeInventoryItems(playfabid, instances.slice(j, j + 10)).catch(() => {});
      }
    }
  } catch (_) {}
  db.prepare("UPDATE community_helpers SET status = 'inactive' WHERE discord_id = ?").run(discordId);
  // DM the user
  try {
    const user = await chClient?.users?.fetch(discordId);
      if (user) await user.send("⚠️ **Your Community Helper status has been paused** due to low activity.\n\nYou need **10 hours** of playtime and **" + CH_MSG_GAIN + " Discord messages** (rolling 30d) to regain it. Once you have the role back you only need **7 hours** and **" + CH_MSG_KEEP + " messages** to keep it.\n\nUse `/communityhelper` to check your progress.");
  } catch (_) {}
  // Audit log
  try { db.prepare("INSERT INTO admin_audit_log (discordid, username, action, details) VALUES (?, '', 'ch_revoke', ?)").run(discordId, playfabid); } catch (_) {}
  console.log("[ch] revoked inactive from", discordId, playfabid);
}

async function buildCommunityHelperEmbed(discordId, playfabid, member) {
  const pt = db.prepare("SELECT minutes FROM player_playtime WHERE playfabid = ?").get(playfabid);
  const mc = db.prepare("SELECT message_count FROM discord_message_counts WHERE discord_id = ?").get(discordId);

  const ch = db.prepare("SELECT * FROM community_helpers WHERE discord_id = ?").get(discordId);
  const booster = member?.roles?.cache?.has(BOOSTER_ROLE_ID) || false;

  const playtimeMin = Math.round((pt?.minutes || 0) * 10) / 10;
  const playtimeHrs = Math.round(playtimeMin / 60 * 10) / 10;
  const msgCount = mc?.message_count || 0;
  const isActive = ch?.status === "active";
  const needPlaytime = isActive ? (booster ? CH_PLAYTIME_KEEP_BOOSTER : CH_PLAYTIME_KEEP_MIN) : (booster ? CH_PLAYTIME_GAIN_BOOSTER : CH_PLAYTIME_GAIN_MIN);
  const needPlaytimeHrs = Math.round(needPlaytime / 60 * 10) / 10;
  const needMessages = isActive ? (booster ? CH_MSG_KEEP_BOOSTER : CH_MSG_KEEP) : (booster ? CH_MSG_GAIN_BOOSTER : CH_MSG_GAIN);
  const playtimeOk = playtimeMin >= needPlaytime;
  const msgOk = msgCount >= needMessages;
  const passed = playtimeOk && msgOk;

  let statusStr, color;
  if (!ch) { statusStr = "Not opted in"; color = 0x808080; }
  else if (isActive) { statusStr = passed ? "✅ Active" : "⚠️ Active (below maintenance — will lose role)"; color = passed ? 0x3FB950 : 0xE040FB; }
  else if (ch.status === "inactive") { statusStr = "❌ Inactive" + (passed ? " (qualifying again)" : ""); color = passed ? 0x3FB950 : 0xE040FB; }
  else { statusStr = "⏳ Pending"; color = 0xE040FB; }

  const thresholdLabel = isActive ? `/${needPlaytimeHrs}` : ` / ${needPlaytimeHrs}`;
  const msgThresholdLabel = isActive ? `/${needMessages}` : ` / ${needMessages}`;
  const playtimeBar = chProgressBar(playtimeMin, needPlaytime, 20);
  const msgBar = chProgressBar(msgCount, needMessages, 20);
  const playtimePct = Math.min(100, Math.round(playtimeMin / needPlaytime * 100));
  const msgPct = Math.min(100, Math.round(msgCount / needMessages * 100));

  const embed = new EmbedBuilder().setColor(color).setTitle("🏠 Community Helper")
    .setDescription(
      "**Status:** " + statusStr + "\n\n" +
      (isActive
        ? "✨ **You're recognized as a Community Helper!** To stay recognized:\n" +
          "▸ **" + Math.round(needPlaytime / 60 * 10) / 10 + "h** playtime (rolling 30d)" + (booster ? " *(boosted)*" : "") + "\n" +
          "▸ **" + needMessages + "** Discord messages (rolling 30d)\n\n"
        : "**Criteria to be recognized:**\n" +
          "▸ **" + Math.round(needPlaytime / 60 * 10) / 10 + "h** playtime (rolling 30d)" + (booster ? " *(boosted)*" : "") + "\n" +
          "▸ **" + needMessages + "** Discord messages (rolling 30d)\n\n") +
      "**Playtime:** " + playtimeHrs + thresholdLabel + "h (" + playtimePct + "%)\n" +
      "`" + playtimeBar + "`\n\n" +
      "**Messages:** " + msgCount + msgThresholdLabel + " (" + msgPct + "%)\n" +
      "`" + msgBar + "`\n\n" +
      (isActive
        ? "🏅 **@Community Helper** role ✅\n👕 Monke Mayhem Staff Shirt ✅"
        : "Opt in below to be recognized:\n" +
          "🏅 **@Community Helper** role\n" +
          "👕 Monke Mayhem Staff Shirt\n\n" +
          "*The role is pingable — only for actively contributing members.*")
    ).setTimestamp();

  const row = new ActionRowBuilder()
    .addComponents(new ButtonBuilder().setCustomId("ch_optin:" + playfabid).setLabel("Opt In").setStyle(ButtonStyle.Success))
    .addComponents(new ButtonBuilder().setCustomId("ch_optout:" + playfabid).setLabel("Opt Out").setStyle(ButtonStyle.Danger))
    .addComponents(new ButtonBuilder().setCustomId("ch_refresh:" + playfabid).setLabel("Refresh").setStyle(ButtonStyle.Secondary));

  // Auto-grant if opted in and meeting thresholds
  if (ch && passed && ch.status !== "active") {
    await chTryGrant(discordId, playfabid);
    // Rebuild embed with updated status
    const updated = db.prepare("SELECT * FROM community_helpers WHERE discord_id = ?").get(discordId);
    embed.setDescription(
      "**Status:** ✅ **Active**\n\n" +
      "🎉 **You're now recognized as a Community Helper!**\n\n" +
      "To stay recognized:\n" +
      "▸ " + Math.round(CH_PLAYTIME_KEEP_MIN / 60 * 10) / 10 + "h playtime (rolling 30d)\n" +
      "▸ " + CH_MSG_KEEP + " Discord messages (rolling 30d)\n\n" +
      "**Playtime:** " + playtimeHrs + thresholdLabel + "h (" + playtimePct + "%)\n" +
      "`" + playtimeBar + "`\n\n" +
      "**Messages:** " + msgCount + msgThresholdLabel + " (" + msgPct + "%)\n" +
      "`" + msgBar + "`\n\n" +
      "🏅 **@Community Helper** role ✅\n👕 Monke Mayhem Staff Shirt ✅"
    ).setColor(0x3FB950);
  }

  return { embeds: [embed], components: row.components.length ? [row] : [], ephemeral: false };
}

async function initBotCommands() {
  if (!config.discord_bot_token || !config.discord_client_id) return;
  try { db.prepare("DELETE FROM redeemable_codes WHERE type = 'discord_link' AND end_time < datetime('now')").run(); } catch (_) {}
  try {
    const existing = await discordbot.getSlashCommands();
    const desired = [
      { name: "playercount", desc: "Show current online player count" },
      { name: "stats", desc: "Show server statistics" },
      { name: "link", desc: "Link your Discord to your in-game account" },
      { name: "cancellink", desc: "Cancel your pending link code so you can generate a new one" },
      { name: "unlink", desc: "Unlink your Discord from your in-game account" },
      { name: "playerinfo", desc: "Look up a player by ID or name", options: [{ type: 3, name: "identifier", description: "PlayFab ID, Oculus ID, Mothership ID, Display Name, or @mention", required: true }] },
      { name: "ban", desc: "Ban a player from the game", options: [{ type: 3, name: "identifier", description: "PlayFab ID, Oculus ID, Mothership ID, Display Name, or @mention", required: true }, { type: 3, name: "reason", description: "Ban reason", required: true }, { type: 3, name: "duration", description: "Duration (e.g. 30m, 2h, 7d, 30d) or perm for permanent", required: false }] },
      { name: "unban", desc: "Unban a player", options: [{ type: 3, name: "identifier", description: "PlayFab ID, Oculus ID, Mothership ID, Display Name, or @mention", required: true }] },
      { name: "grant", desc: "Grant item(s) to a player", options: [{ type: 3, name: "identifier", description: "PlayFab ID, Oculus ID, Mothership ID, Display Name, or @mention", required: true }, { type: 3, name: "item", description: "PlayFab item ID", required: true, autocomplete: true }, { type: 3, name: "item2", description: "Second item (optional)", required: false, autocomplete: true }, { type: 3, name: "item3", description: "Third item (optional)", required: false, autocomplete: true }] },
      { name: "linkstatus", desc: "Check if a player is linked", options: [{ type: 3, name: "identifier", description: "PlayFab ID, Oculus ID, Mothership ID, Display Name, or @mention", required: true }] },
      { name: "findpeople", desc: "List all players currently in rooms" },
      { name: "auditlinks", desc: "Check which admin role members have linked their Discord" },
      { name: "remove", desc: "Remove item(s) from a player", options: [{ type: 3, name: "identifier", description: "PlayFab ID, Oculus ID, Mothership ID, Display Name, or @mention", required: true }, { type: 3, name: "item", description: "PlayFab item ID", required: true, autocomplete: true }, { type: 3, name: "item2", description: "Second item (optional)", required: false, autocomplete: true }, { type: 3, name: "item3", description: "Third item (optional)", required: false, autocomplete: true }] },
      { name: "removeall", desc: "Remove an item from ALL players", options: [{ type: 3, name: "item", description: "PlayFab item ID to remove", required: true, autocomplete: true }] },
      { name: "friendadd", desc: "Send a friend request or add directly (owner bypass)", options: [{ type: 3, name: "identifier", description: "Discord @mention (or any ID if you're the bot owner)", required: true }] },
      { name: "friendremove", desc: "Remove a friend from your linked in-game account", options: [{ type: 3, name: "identifier", description: "Discord @mention (or any ID if you're the bot owner)", required: true }] },
      { name: "friendaccept", desc: "Accept a pending friend request", options: [{ type: 3, name: "identifier", description: "Discord @mention of the person who sent the request", required: true }] },
      { name: "frienddeny", desc: "Deny a pending friend request", options: [{ type: 3, name: "identifier", description: "Discord @mention of the person who sent the request", required: true }] },
      { name: "privacy", desc: "Set your in-game privacy state", options: [{ type: 3, name: "state", description: "Privacy state", required: true, choices: [{ name: "VISIBLE (0) — Show in rooms", value: "0" }, { name: "PUBLIC_ONLY (1) — Show in public rooms only", value: "1" }, { name: "HIDDEN (2) — Appear offline", value: "2" }] }] },
      { name: "events", desc: "View or manage in-game events (TitleDataActivation)", options: [
        { type: 1, name: "list", description: "View current event configuration" },
        { type: 1, name: "start", description: "Enable an object now for a duration", options: [
          { type: 3, name: "key", description: "Event key", required: true,
            choices: [{ name: "Pride — Pride decorations", value: "Pride" }, { name: "EventWarnings — Countdown warnings", value: "EventWarnings" }, { name: "HBD2L — Birthday intro event", value: "HBD2L" }] },
          { type: 3, name: "object", description: "Object ID to activate", required: true,
            choices: [{ name: "NormalObjects", value: "NormalObjects" }, { name: "PrideObjects", value: "PrideObjects" }, { name: "1min", value: "1min" }, { name: "2min", value: "2min" }, { name: "3min", value: "3min" }, { name: "4min", value: "4min" }, { name: "5min", value: "5min" }, { name: "intro-event", value: "intro-event" }] },
          { type: 4, name: "duration", description: "Hours to keep it active (default: 24, 0 = forever)", required: false }
        ] },
        { type: 1, name: "stop", description: "Disable an object immediately", options: [
          { type: 3, name: "key", description: "Event key", required: true,
            choices: [{ name: "Pride — Pride decorations", value: "Pride" }, { name: "EventWarnings — Countdown warnings", value: "EventWarnings" }, { name: "HBD2L — Birthday intro event", value: "HBD2L" }] },
          { type: 3, name: "object", description: "Object ID to deactivate", required: true,
            choices: [{ name: "NormalObjects", value: "NormalObjects" }, { name: "PrideObjects", value: "PrideObjects" }, { name: "1min", value: "1min" }, { name: "2min", value: "2min" }, { name: "3min", value: "3min" }, { name: "4min", value: "4min" }, { name: "5min", value: "5min" }, { name: "intro-event", value: "intro-event" }] }
        ] },
        { type: 1, name: "window", description: "Set exact start/end for a specific window", options: [
          { type: 3, name: "key", description: "Event key", required: true,
            choices: [{ name: "Pride — Pride decorations", value: "Pride" }, { name: "EventWarnings — Countdown warnings", value: "EventWarnings" }, { name: "HBD2L — Birthday intro event", value: "HBD2L" }] },
          { type: 3, name: "object", description: "Object ID", required: true,
            choices: [{ name: "NormalObjects", value: "NormalObjects" }, { name: "PrideObjects", value: "PrideObjects" }, { name: "1min", value: "1min" }, { name: "2min", value: "2min" }, { name: "3min", value: "3min" }, { name: "4min", value: "4min" }, { name: "5min", value: "5min" }, { name: "intro-event", value: "intro-event" }] },
          { type: 4, name: "index", description: "Window index (0 = first)", required: true },
          { type: 3, name: "start", description: "Start time as UTC (e.g. 2026-06-15 14:00)", required: false },
          { type: 3, name: "end", description: "End time as UTC (e.g. 2026-06-16 14:00)", required: false }
        ] }
      ] },
      { name: "motd", desc: "View or set the Message of the Day", options: [
        { type: 1, name: "view", description: "Show current MOTD" },
        { type: 1, name: "set", description: "Set the MOTD", options: [
          { type: 3, name: "message", description: "The new message of the day", required: true }
        ] }
      ] },
      { name: "warn", desc: "Send a warning notification to a player", options: [{ type: 3, name: "identifier", description: "PlayFab ID, Oculus ID, Mothership ID, Display Name, or @mention", required: true }, { type: 3, name: "reason", description: "Warning reason", required: true, choices: [{ name: "Toxicity", value: "toxicity" }, { name: "Hate Speech", value: "hate speech" }, { name: "Harassment", value: "harassment" }, { name: "Cheating", value: "cheating" }, { name: "Trolling", value: "trolling" }, { name: "Inappropriate Name", value: "inappropriate name" }, { name: "Other", value: "other" }] }, { type: 3, name: "subreason", description: "Additional details (optional)", required: false }] },
      { name: "announce", desc: "Send an announcement to all connected players", options: [{ type: 3, name: "message", description: "The announcement text", required: true }] },
       { name: "catalog", desc: "Search for cosmetic item IDs by name", options: [{ type: 3, name: "query", description: "Search by display name or item ID", required: true, autocomplete: true }] },
       { name: "setapplab", desc: "Update the AppLab link (Admin)", options: [{ type: 3, name: "link", description: "The new AppLab / Meta Store URL", required: true }] },
       { name: "room", desc: "View and moderate players in a room (Admin)", options: [{ type: 3, name: "code", description: "Room code", required: true }] },
       { name: "claimcosmetics", desc: "Claim your role-based cosmetics (requires linked account)" },
       { name: "resynccosmetics", desc: "Remove ALL role cosmetics from everyone then re-grant (Owner)", options: [{ type: 5, name: "confirm", description: "Type true to confirm — this affects ALL linked users", required: true }] },
       { name: "regrant", desc: "Re-grant any new items from the on-login bundle you're missing" },
      { name: "mute", desc: "Mute a player's voice", options: [{ type: 3, name: "identifier", description: "PlayFab ID, Oculus ID, Mothership ID, Display Name, or @mention", required: true }, { type: 4, name: "minutes", description: "Duration in minutes (0 = forever)", required: true }] },
      { name: "unmute", desc: "Unmute a player's voice", options: [{ type: 3, name: "identifier", description: "PlayFab ID, Oculus ID, Mothership ID, Display Name, or @mention", required: true }] },
      { name: "qa", desc: "Submit a question or check answers", options: [
        { type: 1, name: "ask", description: "Submit a question to the Q&A board", options: [{ type: 3, name: "question", description: "Your question (max 500 chars)", required: true }] },
        { type: 1, name: "my", description: "View your submitted questions and their answers" },
        { type: 1, name: "check", description: "Check answers for a specific question", options: [{ type: 4, name: "id", description: "Question ID number", required: true }] },
        { type: 1, name: "recent", description: "Show recently answered questions" },
      ] },
      { name: "communityhelper", desc: "Community Helper program — check progress, opt in/out" },
      { name: "polls", desc: "Create and manage polls (owner only)" },
      { name: "me", desc: "Show your in-game account info" },
      { name: "grantloa", desc: "Grant Leave of Absence to a Community Helper (Staff+)", options: [
        { type: 6, name: "user", description: "The Discord user to grant LOA", required: true },
        { type: 3, name: "duration", description: "LOA duration (e.g. 7d, 14d, 30d)", required: true }
      ] },
      { name: "editplaytime", desc: "Set a player's playtime (owner only)", options: [
        { type: 6, name: "user", description: "The Discord user", required: true },
        { type: 10, name: "minutes", description: "Playtime in minutes", required: true },
        { type: 3, name: "month", description: "Month (YYYY-MM, defaults to current)", required: false, autocomplete: true }
      ] },
      { name: "chleaderboard", desc: "Top 10 users closest to qualifying for Community Helper (owner only)" },
    ];

    // Delete stale commands (exist on Discord but not in desired)
    for (const ex of existing) {
      if (!desired.find(c => c.name === ex.name)) {
        await discordbot.discordApi(`/applications/${config.discord_client_id}/commands/${ex.id}`, "DELETE");
        console.log(`[bot] deleted stale /${ex.name}`);
      }
    }

    // Helper to strip Discord's extra fields for comparison
    function cmdFingerprint(cmd) {
      return JSON.stringify({ name: cmd.name, description: cmd.description || cmd.desc, options: (cmd.options || []).map(o => ({ type: o.type, name: o.name, description: o.description, required: !!o.required, autocomplete: !!o.autocomplete })) });
    }
    const existingFingerprints = {};
    for (const ex of existing) existingFingerprints[ex.name] = cmdFingerprint(ex);

    // Only register if fingerprint changed or command doesn't exist
    for (const cmd of desired) {
      if (existingFingerprints[cmd.name] === cmdFingerprint(cmd)) {
        continue; // unchanged, skip
      }
      // Delete old version first if it exists
      const match = existing.find(c => c.name === cmd.name);
      if (match) {
        await discordbot.discordApi(`/applications/${config.discord_client_id}/commands/${match.id}`, "DELETE");
      }
      const r = await discordbot.registerSlashCommand({ name: cmd.name, description: cmd.desc, options: cmd.options || [] });
      if (r && r.status >= 200 && r.status < 300) {
        console.log(`[bot] registered /${cmd.name} (${r.status})`);
      } else {
        console.warn(`[bot] failed to register /${cmd.name}:`, r ? `${r.status} ${JSON.stringify(r.data)}` : "no response");
      }
      await new Promise(r => setTimeout(r, 500)); // small delay to avoid rate limits
    }
  } catch (e) { console.warn("[bot] cmd reg failed:", e.message); }
}

// ─── Duration Parser ────────────────────────────────────────────
function parseDuration(str) {
  if (!str || str.toLowerCase() === "perm") return { hours: 0, label: "Permanent" };
  const m = str.match(/^(\d+)\s*(m|min|h|hr|d|day)s?$/i);
  if (!m) return null;
  const num = parseInt(m[1]);
  const unit = m[2].toLowerCase();
  if (unit.startsWith("m")) return { hours: Math.round(num / 60), label: num + "m" };
  if (unit.startsWith("h")) return { hours: num, label: num + "h" };
  if (unit.startsWith("d")) return { hours: Math.round(num * 24), label: num + "d" };
}

async function notifyBan(discordId, reason, durLabel) {
  try {
    const user = await chClient?.users?.fetch(discordId);
    if (!user) return;
    await user.send("🚫 **You have been banned from the game.**\nReason: " + reason + "\nDuration: " + durLabel + "\n\nIf you believe this is a mistake, please contact staff.");
  } catch (_) {}
  try {
    const guild = chClient?.guilds?.cache?.get(config.discord_guild_id);
    if (!guild) return;
    const member = await guild.members.fetch(discordId).catch(() => null);
    if (member) await member.roles.add("1521355524572971059").catch(() => {});
  } catch (_) {}
}

// ─── Player Resolver ────────────────────────────────────────────
function resolvePlayer(identifier) {
  const clean = identifier.trim().replace(/<@!?(\d+)>/, "$1");

  // Try Discord mention → discord_links
  if (/^\d{17,20}$/.test(clean)) {
    const dl = db.prepare("SELECT * FROM discord_links WHERE discord_id = ?").get(clean);
    if (dl) {
      const p = db.prepare("SELECT playfabid, oculusid, displayname FROM players WHERE playfabid = ?").get(dl.playfabid);
      if (p) { p._source = "discord"; return p; }
      return dl;
    }
  }

  // Try PlayFab ID
  let row = db.prepare("SELECT playfabid, oculusid, displayname FROM players WHERE playfabid = ?").get(clean);
  if (row) { row._source = "playfabid"; return row; }

  // Try Oculus ID
  row = db.prepare("SELECT playfabid, oculusid, displayname FROM players WHERE oculusid = ?").get(clean);
  if (row) { row._source = "oculusid"; return row; }

  // Try Mothership ID → mothershipplayers → players
  const ms = db.prepare("SELECT userid FROM mothershipplayers WHERE mothershipid = ?").get(clean);
  if (ms) {
    row = db.prepare("SELECT playfabid, oculusid, displayname FROM players WHERE oculusid = ?").get(ms.userid);
    if (row) { row._source = "mothershipid"; return row; }
  }

  // Try Display Name (case-insensitive)
  row = db.prepare("SELECT playfabid, oculusid, displayname FROM players WHERE LOWER(displayname) = LOWER(?)").get(clean);
  if (row) { row._source = "displayname"; return row; }

  return null;
}

// Check if a Discord user has a specific role
async function hasDiscordRole(discordId, roleId) {
  if (!roleId) return false;
  try {
    const roles = await discordbot.getMemberRoles(discordId);
    return roles.includes(roleId);
  } catch { return false; }
}

// Discord Interactions endpoint (for slash commands)
app.post("/api/discord/interactions", async (req, res) => {
  try {
    const body = req.body;
    if (body.type === 1) return res.json({ type: 1 });
    // Autocomplete for item options (grant, remove, removeall)
    if (body.type === 4) {
      const focused = body.data?.options?.find(o => o.focused);
      if (focused && focused.name.startsWith("item") && ["grant", "remove", "removeall"].includes(body.data?.name)) {
        const value = (focused.value || "").toLowerCase();
        const matches = cosmeticsData.filter(c =>
          !value || c.item_id.toLowerCase().includes(value) || c.override_display_name.toLowerCase().includes(value)
        ).slice(0, 25);
        return res.json({
          type: 8,
          data: { choices: matches.map(c => ({ name: c.label.slice(0, 100), value: c.item_id })) }
        });
      }
      if (focused && focused.name === "query" && body.data?.name === "catalog") {
        const value = (focused.value || "").toLowerCase();
        const matches = cosmeticsData.filter(c =>
          !value || c.item_id.toLowerCase().includes(value) || c.override_display_name.toLowerCase().includes(value) || c.display_name.toLowerCase().includes(value)
        ).slice(0, 25);
        return res.json({
          type: 8,
          data: { choices: matches.map(c => ({ name: c.label.slice(0, 100), value: c.item_id })) }
        });
      }
      return res.json({ type: 8, data: { choices: [] } });
    }
    if (body.type === 2) {
      const cmd = body.data?.name;
      const discordId = body.member?.user?.id || body.user?.id;
      const count = wsserver.ccu ? wsserver.ccu() : 0;
      const total = db.prepare("SELECT COUNT(*) as c FROM players").get().total || 0;

      if (cmd === "playercount") {
        return res.json({ type: 4, data: { embeds: [{ color: 3447003, description: "## 🦍 Player Count\n**↓ Stats ↓**\n```[Online] : " + count + "\n[Total Registered] : " + total + "\n```" }] } });
      }
      if (cmd === "stats") {
        const maps = db.prepare("SELECT COUNT(*) as c FROM sharedmaps").get();
        const bans = db.prepare("SELECT COUNT(*) as c FROM bans").get();
        const shifts = db.prepare("SELECT COUNT(*) as c FROM shifts WHERE completed = 1").get();
        return res.json({ type: 4, data: { embeds: [{ color: 5763719, description: "## 📊 Server Stats\n**↓ Stats ↓**\n```[Online] : " + count + "\n[Total Players] : " + total + "\n[Shifts Done] : " + (shifts?.c || 0) + "\n[Shared Maps] : " + (maps?.c || 0) + "\n[Bans] : " + (bans?.c || 0) + "\n```" }] } });
      }
      if (cmd === "link") {
        if (!discordId) return res.json({ type: 4, data: { content: "Could not identify you.", flags: 64 } });
        if (body.channel_id !== "1513875402890678324")
          return res.json({ type: 4, data: { content: "Please use <#1513875402890678324> to link your account.", flags: 64 } });

        const linked = db.prepare("SELECT * FROM discord_links WHERE discord_id = ?").get(discordId);
        if (linked) {
          const pfName = linked.playfabid ? db.prepare("SELECT displayname FROM players WHERE playfabid = ?").get(linked.playfabid) : null;
          return res.json({ type: 4, data: { content: "✅ <@" + discordId + "> is already linked to `" + linked.playfabid + "`" + (pfName?.displayname ? " (" + pfName.displayname + ")" : "") + ". Use `/unlink` to unlink." } });
        }

        db.prepare("UPDATE redeemable_codes SET active = 0 WHERE type = 'discord_link' AND end_time < datetime('now')").run();

        const existing = db.prepare("SELECT code FROM redeemable_codes WHERE type = 'discord_link' AND discord_id = ? AND active = 1 AND (end_time IS NULL OR end_time > datetime('now'))").get(discordId);
        if (existing) {
          return res.json({ type: 4, data: { content: "<@" + discordId + "> already has a pending link code! Type this in the **Redemption Computer** in-game:\n\n`" + existing.code + "`\n\nThis code expires in **15 minutes**." } });
        }

        const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        let code = "";
        for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];

        const endTime = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        db.prepare(
          "INSERT INTO redeemable_codes (code, type, discord_id, max_uses, end_time, created_by, discord_interaction_token, discord_channel_id) VALUES (?, 'discord_link', ?, 1, ?, ?, ?, ?)"
        ).run(code, discordId, endTime, discordId, body.token || "", body.channel_id || "");

        const responseMsg = { type: 4, data: { content: "<@" + discordId + "> | " + member.username + " Type this code in the **Redemption Computer** in-game:\n\n`" + code + "`\n\nThis code expires in **15 minutes**." } };

        if (body.token) {
          setTimeout(() => {
            discordbot.editInteractionResponse(body.token, {
              content: "⌛ <@" + discordId + "> Your link code (`" + code + "`) **has expired.** Please run `/link` again to generate a new one."
            }).catch(() => {});
          }, 14.5 * 60 * 1000);
        }

        return res.json(responseMsg);
      }
      if (cmd === "unlink") {
        if (!discordId) return res.json({ type: 4, data: { content: "Could not identify you." } });

        const linked = db.prepare("SELECT * FROM discord_links WHERE discord_id = ?").get(discordId);
        if (!linked) return res.json({ type: 4, data: { content: "You don't have a linked account." } });

        db.prepare("DELETE FROM discord_links WHERE discord_id = ?").run(discordId);
        try { discordbot.sendChannelMessage("1513408264149274754", null, { color: 0x5865F2, description: "**Unlink Account**\n<@" + discordId + "> (`" + discordId + "`)\nUnlinked from: `" + linked.playfabid + "`\n", timestamp: new Date().toISOString() }); } catch (_) {}
        return res.json({ type: 4, data: { content: "Your Discord has been unlinked from your in-game account." } });
      }
      if (cmd === "cancellink") {
        if (body.channel_id !== "1513875402890678324")
          return res.json({ type: 4, data: { content: "Please use <#1513875402890678324> to cancel a link code.", flags: 64 } });
        const updated = db.prepare("UPDATE redeemable_codes SET active = 0 WHERE type = 'discord_link' AND discord_id = ? AND active = 1").run(discordId);
        if (updated.changes > 0) return res.json({ type: 4, data: { content: "Cancelled your pending link code. You can now use `/link` to get a new one." } });
        return res.json({ type: 4, data: { content: "You don't have any pending link code." } });
      }

      // ─── Friend Commands (require link, only in link channel) ──
      const BOT_OWNER_ID = "898859607391354891";
      const friendIdentifier = body.data?.options?.find(o => o.name === "identifier")?.value || "";
      function parseMention(raw) {
        const m = raw.trim().match(/^<@!?(\d{17,20})>$/);
        return m ? m[1] : null;
      }
      const isOwner = discordId === BOT_OWNER_ID;

      if (cmd === "friendadd") {
        if (body.channel_id !== "1481428446935777333")
          return res.json({ type: 4, data: { content: "Please use <#1481428446935777333> for friend commands.", flags: 64 } });
        const linked = db.prepare("SELECT * FROM discord_links WHERE discord_id = ?").get(discordId);
        if (!linked || !linked.playfabid) return res.json({ type: 4, data: { content: "You must link your Discord using `/link` first." } });

        if (isOwner) {
          const target = resolvePlayer(friendIdentifier);
          if (!target) return res.json({ type: 4, data: { content: "Player not found." } });
          if (target.playfabid === linked.playfabid) return res.json({ type: 4, data: { content: "You can't friend yourself." } });
          const existing = db.prepare("SELECT 1 FROM friendlinks WHERE playerid = ? AND friendid = ?").get(linked.playfabid, target.playfabid);
          if (existing) return res.json({ type: 4, data: { content: "They're already your friend." } });
          db.prepare("INSERT INTO friendlinks (playerid, friendid) VALUES (?, ?)").run(linked.playfabid, target.playfabid);
          return res.json({ type: 4, data: { content: "✅ <@" + discordId + "> added **" + (target.displayname || target.playfabid) + "** as a friend!" } });
        }

        const targetDiscordId = parseMention(friendIdentifier);
        if (!targetDiscordId) return res.json({ type: 4, data: { content: "Please mention the person you want to add (@username)." } });
        const targetLink = db.prepare("SELECT * FROM discord_links WHERE discord_id = ?").get(targetDiscordId);
        if (!targetLink || !targetLink.playfabid) return res.json({ type: 4, data: { content: "That user hasn't linked their Discord yet." } });
        if (targetLink.playfabid === linked.playfabid) return res.json({ type: 4, data: { content: "You can't friend yourself." } });
        const existing = db.prepare("SELECT 1 FROM friendlinks WHERE playerid = ? AND friendid = ?").get(linked.playfabid, targetLink.playfabid);
        if (existing) return res.json({ type: 4, data: { content: "They're already your friend." } });
        const pending = db.prepare("SELECT 1 FROM friend_requests WHERE from_playfabid = ? AND to_discord_id = ? AND status = 'pending'").get(linked.playfabid, targetDiscordId);
        if (pending) return res.json({ type: 4, data: { content: "You already have a pending request to that user." } });
        db.prepare("INSERT OR REPLACE INTO friend_requests (from_playfabid, to_discord_id, status) VALUES (?, ?, 'pending')").run(linked.playfabid, targetDiscordId);
        return res.json({ type: 4, data: { content: "📨 <@" + discordId + "> sent a friend request to <@" + targetDiscordId + ">! They can accept with `/friendaccept`." } });
      }

      if (cmd === "friendremove") {
        if (body.channel_id !== "1481428446935777333")
          return res.json({ type: 4, data: { content: "Please use <#1481428446935777333> for friend commands.", flags: 64 } });
        const linked = db.prepare("SELECT * FROM discord_links WHERE discord_id = ?").get(discordId);
        if (!linked || !linked.playfabid) return res.json({ type: 4, data: { content: "You must link your Discord using `/link` first." } });
        const target = isOwner ? resolvePlayer(friendIdentifier) : null;
        const targetPfId = target ? target.playfabid : null;
        if (!targetPfId) {
          const tdId = parseMention(friendIdentifier);
          if (!tdId) return res.json({ type: 4, data: { content: "Please mention the person you want to remove (@username)." } });
          const tl = db.prepare("SELECT playfabid FROM discord_links WHERE discord_id = ?").get(tdId);
          if (!tl) return res.json({ type: 4, data: { content: "That user hasn't linked their Discord." } });
          const existing = db.prepare("SELECT 1 FROM friendlinks WHERE playerid = ? AND friendid = ?").get(linked.playfabid, tl.playfabid);
          if (!existing) return res.json({ type: 4, data: { content: "They're not in your friend list." } });
          db.prepare("DELETE FROM friendlinks WHERE playerid = ? AND friendid = ?").run(linked.playfabid, tl.playfabid);
          return res.json({ type: 4, data: { content: "✅ <@" + discordId + "> removed <@" + tdId + "> from friends!" } });
        }
        if (target.playfabid === linked.playfabid) return res.json({ type: 4, data: { content: "You can't unfriend yourself." } });
        const existing = db.prepare("SELECT 1 FROM friendlinks WHERE playerid = ? AND friendid = ?").get(linked.playfabid, target.playfabid);
        if (!existing) return res.json({ type: 4, data: { content: "They're not in your friend list." } });
        db.prepare("DELETE FROM friendlinks WHERE playerid = ? AND friendid = ?").run(linked.playfabid, target.playfabid);
        return res.json({ type: 4, data: { content: "✅ <@" + discordId + "> removed **" + (target.displayname || target.playfabid) + "** from friends!" } });
      }

      if (cmd === "friendaccept" || cmd === "frienddeny") {
        if (body.channel_id !== "1481428446935777333")
          return res.json({ type: 4, data: { content: "Please use <#1481428446935777333> for friend commands.", flags: 64 } });
        const myLink = db.prepare("SELECT * FROM discord_links WHERE discord_id = ?").get(discordId);
        if (!myLink || !myLink.playfabid) return res.json({ type: 4, data: { content: "You must link your Discord using `/link` first." } });
        const fromDiscordId = parseMention(friendIdentifier);
        if (!fromDiscordId) return res.json({ type: 4, data: { content: "Please @mention the person who sent the request." } });
        const fromLink = db.prepare("SELECT * FROM discord_links WHERE discord_id = ?").get(fromDiscordId);
        if (!fromLink || !fromLink.playfabid) return res.json({ type: 4, data: { content: "That user hasn't linked their Discord." } });
        const request = db.prepare("SELECT * FROM friend_requests WHERE from_playfabid = ? AND to_discord_id = ? AND status = 'pending'").get(fromLink.playfabid, discordId);
        if (!request) return res.json({ type: 4, data: { content: "No pending request from that user." } });
        if (cmd === "friendaccept") {
          db.prepare("UPDATE friend_requests SET status = 'accepted' WHERE id = ?").run(request.id);
          db.prepare("INSERT OR IGNORE INTO friendlinks (playerid, friendid) VALUES (?, ?)").run(fromLink.playfabid, myLink.playfabid);
          db.prepare("INSERT OR IGNORE INTO friendlinks (playerid, friendid) VALUES (?, ?)").run(myLink.playfabid, fromLink.playfabid);
          return res.json({ type: 4, data: { content: "✅ <@" + discordId + "> accepted <@" + fromDiscordId + ">'s friend request! You are now friends." } });
        } else {
          db.prepare("UPDATE friend_requests SET status = 'denied' WHERE id = ?").run(request.id);
          return res.json({ type: 4, data: { content: "❌ <@" + discordId + "> denied <@" + fromDiscordId + ">'s friend request." } });
        }
      }

      // ─── Admin Commands (role-gated, require linked account) ───
      const ADMIN_ROLE = "1412161751020998666";
      const GRANT_ROLE = "1513426812359671808";
      const AUDIT_CHANNEL = "1513408264149274754";

      const identifier = body.data?.options?.find(o => o.name === "identifier")?.value || "";
      const token = body.token; // interaction token for follow-up

      // Build user info for audit log
      const member = body.member?.user || body.user || {};
      const auditUser = { id: discordId, name: member.username || "Unknown", avatar: member.avatar || "" };
      const avatarUrl = auditUser.avatar ? "https://cdn.discordapp.com/avatars/" + auditUser.id + "/" + auditUser.avatar + "." + (auditUser.avatar.startsWith("a_") ? "gif" : "png") : "";

      function sendAuditLog(action, target, detail) {
        try {
          discordbot.sendChannelMessage(AUDIT_CHANNEL, null, {
            color: 0x5865F2,
            author: { name: auditUser.name, icon_url: avatarUrl },
            description: "**" + action + "**\nBy: <@" + auditUser.id + "> (`" + auditUser.id + "`)\nTarget: `" + target + "`\n" + detail,
            timestamp: new Date().toISOString(),
          }).catch(() => {});
        } catch (_) {}
      }

      function isLinked() {
        return !!db.prepare("SELECT 1 FROM discord_links WHERE discord_id = ?").get(discordId);
      }

      if (cmd === "findpeople") {
        const rows = db.prepare("SELECT fp.playfabid, fp.roomid, fp.zone, fp.region, fp.nickname, p.displayname FROM friendpresence fp LEFT JOIN players p ON p.playfabid = fp.playfabid LEFT JOIN privacystates ps ON ps.playfabid = fp.playfabid WHERE fp.roomid != '' AND (ps.state IS NULL OR ps.state != 'HIDDEN') ORDER BY fp.region, fp.nickname").all();
        if (!rows.length) return res.json({ type: 4, data: { content: "No one is currently in a room." } });
        const groups = {};
        for (const r of rows) {
          const key = r.region || "Unknown";
          if (!groups[key]) groups[key] = [];
          groups[key].push("`" + (r.displayname || r.nickname || r.playfabid) + "` in **" + r.roomid + "**" + (r.zone ? " (" + r.zone + ")" : ""));
        }
        const desc = Object.entries(groups).map(([region, list]) => "**" + region + "** (" + list.length + ")\n" + list.join("\n")).join("\n\n");
        return res.json({ type: 4, data: { content: "## 👥 Players Online\n" + desc.slice(0, 1900) } });
      }

      // Fast commands (no PlayFab API calls)
      if (cmd === "auditlinks") {
        if (!await hasDiscordRole(discordId, ADMIN_ROLE))
          return res.json({ type: 4, data: { content: "You don't have permission." } });
        // Paginate through all guild members
        const adminMembers = [];
        let lastId = "";
        while (true) {
          const r = await discordbot.discordApi(`/guilds/${config.discord_guild_id}/members?limit=1000${lastId ? "&after=" + lastId : ""}`);
          if (r.status !== 200 || !r.data?.length) break;
          for (const m of r.data) {
            if (m.roles && m.roles.includes(ADMIN_ROLE)) adminMembers.push(m);
          }
          lastId = r.data[r.data.length - 1].user?.id;
          if (!lastId || r.data.length < 1000) break;
        }
        if (!adminMembers.length) return res.json({ type: 4, data: { content: "No members with admin role found." } });
        let linked = 0, unlinked = 0;
        const lines = [];
        for (const m of adminMembers) {
          const dl = db.prepare("SELECT playfabid FROM discord_links WHERE discord_id = ?").get(m.user.id);
          if (dl) { linked++; lines.push("✅ <@" + m.user.id + "> → `" + dl.playfabid + "`"); }
          else { unlinked++; lines.push("❌ <@" + m.user.id + "> → **NOT LINKED**"); }
        }
        const desc = "## 🔗 Admin Link Audit\n**" + linked + " linked / " + unlinked + " unlinked**\n" + lines.join("\n");
        return res.json({ type: 4, data: { content: desc.slice(0, 1900) } });
      }
      if (cmd === "linkstatus") {
        if (!isLinked()) return res.json({ type: 4, data: { content: "You must link your Discord using `/link` first." } });
        if (!await hasDiscordRole(discordId, ADMIN_ROLE))
          return res.json({ type: 4, data: { content: "You don't have permission." } });
        const player = resolvePlayer(identifier);
        if (!player) return res.json({ type: 4, data: { content: "Player not found." } });
        const dl = db.prepare("SELECT * FROM discord_links WHERE playfabid = ? OR mothershipid = (SELECT mothershipid FROM mothershipplayers WHERE userid = ?)").get(player.playfabid, player.oculusid || "");
        if (!dl) return res.json({ type: 4, data: { content: "This player is not linked to any Discord account." } });
        return res.json({ type: 4, data: { content: "## 🔗 Link Status\n**↓ Details ↓**\n```[PlayFab ID] : " + player.playfabid + "\n[Discord] : " + "<@" + dl.discord_id + ">\n[Discord ID] : " + dl.discord_id + "\n[Linked At] : " + (dl.linked_at || "N/A") + "\n```" } });
      }
      if (cmd === "playerinfo") {
        if (!isLinked()) return res.json({ type: 4, data: { content: "You must link your Discord using `/link` first." } });
        if (!await hasDiscordRole(discordId, ADMIN_ROLE))
          return res.json({ type: 4, data: { content: "You don't have permission." } });
        const player = resolvePlayer(identifier);
        if (!player) return res.json({ type: 4, data: { content: "Player not found. Try PlayFab ID, Oculus ID, Mothership ID, Display Name, or Discord @mention." } });

        const dl = db.prepare("SELECT * FROM discord_links WHERE playfabid = ? OR mothershipid = (SELECT mothershipid FROM mothershipplayers WHERE userid = ?)").get(player.playfabid, player.oculusid || "");
        const bans = db.prepare("SELECT * FROM bans WHERE playfabid = ?").all(player.playfabid);
        const ms = player.oculusid ? db.prepare("SELECT mothershipid FROM mothershipplayers WHERE userid = ?").get(player.oculusid) : null;
        const inv = await playfab.getuserinventory(player.playfabid).catch(() => null);
        const invCount = inv?.data?.data?.Inventory?.length || 0;
        const ptTotal = (db.prepare("SELECT COALESCE(minutes,0) as m FROM player_playtime WHERE playfabid = ?").get(player.playfabid) || {}).m || 0;
        const ptMonth = (db.prepare("SELECT minutes FROM player_playtime WHERE playfabid = ?").get(player.playfabid) || {}).minutes || 0;
        const dmCount = dl ? (db.prepare("SELECT COALESCE(message_count,0) as m FROM discord_message_counts WHERE discord_id = ?").get(dl.discord_id) || {}).m || 0 : 0;
        const desc = "## 📋 Player Info\n**↓ IDs ↓**\n```[PlayFab ID] : " + (player.playfabid || "N/A") + "\n[Oculus ID] : " + (player.oculusid || "N/A") + "\n[Mothership ID] : " + (ms?.mothershipid || "N/A") + "\n[Display Name] : " + (player.displayname || "N/A") + "\n[Discord] : " + (dl ? "<@" + dl.discord_id + ">" : "Not linked") + "\n```\n**↓ Activity ↓**\n```[Playtime (Total)] : " + (ptTotal / 60).toFixed(1) + "h\n[Playtime (Rolling)] : " + (ptMonth / 60).toFixed(1) + "h\n[Discord Messages] : " + dmCount + "\n```\n**↓ Account ↓**\n```[Bans] : " + (bans?.length || 0) + "\n[Inventory Items] : " + invCount + "\n```";
        return res.json({ type: 4, data: { embeds: [{ color: 3447003, description: desc }] } });
      }

      // /me — own account info
      if (cmd === "me") {
        if (body.channel_id !== "1481428446935777333") return res.json({ type: 4, data: { content: "Please use <#1481428446935777333> for this command.", ephemeral: true } });
        if (!isLinked()) return res.json({ type: 4, data: { content: "You must link your Discord using `/link` first." } });
        const link = db.prepare("SELECT * FROM discord_links WHERE discord_id = ?").get(discordId);
        if (!link) return res.json({ type: 4, data: { content: "No linked in-game account found. Use `/link` first." } });
        const month = new Date().toISOString().slice(0, 7);
        const ptTotal = (db.prepare("SELECT COALESCE(minutes,0) as m FROM player_playtime WHERE playfabid = ?").get(link.playfabid) || {}).m || 0;
        const ptMonth = (db.prepare("SELECT minutes FROM player_playtime WHERE playfabid = ?").get(link.playfabid) || {}).minutes || 0;
        const ch = db.prepare("SELECT status FROM community_helpers WHERE discord_id = ?").get(discordId);
        const chStatus = ch ? ch.status : "none";
        const memberRoles = await discordbot.getMemberRoles(discordId);
        const foundRoles = memberRoles.filter(r => ROLE_MAP[r]);
        const roleLabel = foundRoles.length ? foundRoles.map(r => `<@&${r}>`).join("\n") : (link ? "Member" : "Not Linked");
        const desc = "## 👤 <@" + discordId + ">'s Account\n**↓ Info ↓**\n```[PlayFab ID] : " + link.playfabid + "\n```\n**↓ Activity (30d rolling) ↓**\n```[Playtime] : " + (ptMonth / 60).toFixed(1) + "h\n[Playtime (Total)] : " + (ptTotal / 60).toFixed(1) + "h\n```\n**↓ Community Helper ↓**\n```[Status] : " + chStatus + "\n```\n**↓ Discord Roles ↓**\n" + roleLabel;
        return res.json({ type: 4, data: { embeds: [{ color: 0xE040FB, description: desc }] } });
      }

      // Slow commands — defer first, then run async
      const slowCmds = { ban: "ban", unban: "unban", grant: "grant", remove: "remove", removeall: "removeall" };
      if (slowCmds[cmd]) {
        res.json({ type: 5 }); // Defer immediately
        // All follow-up runs asynchronously
        (async () => {
          if (!isLinked()) {
            await discordbot.editInteractionResponse(token, { content: "You must link your Discord using `/link` first." }).catch(() => {});
            return;
          }
        const requiredRole = (cmd === "grant" || cmd === "remove") ? GRANT_ROLE : ADMIN_ROLE;
          if (!await hasDiscordRole(discordId, requiredRole)) {
            await discordbot.editInteractionResponse(token, { content: "You don't have permission." }).catch(() => {});
            return;
          }
          const player = cmd === "removeall" ? null : resolvePlayer(identifier);
          if (cmd !== "removeall" && !player) {
            await discordbot.editInteractionResponse(token, { content: "Player not found." }).catch(() => {});
            return;
          }

          if (cmd === "ban") {
            const reason = body.data?.options?.find(o => o.name === "reason")?.value || "No reason provided";
            const durStr = body.data?.options?.find(o => o.name === "duration")?.value;
            const dur = parseDuration(durStr);
            if (!dur) {
              await discordbot.editInteractionResponse(token, { content: "Invalid duration. Use e.g. `30m`, `2h`, `7d`, `30d`, or `perm`." }).catch(() => {});
              return;
            }
            const banResult = await playfab.banusers([player.playfabid], "[Discord Ban] " + reason, dur.hours).catch(e => ({ error: e.message }));
            if (banResult?.error) {
              await discordbot.editInteractionResponse(token, { content: "Ban failed: " + banResult.error }).catch(() => {});
            } else {
            sendAuditLog("Ban", player.playfabid + " (" + (player.displayname || "?") + ")", "Reason: " + reason + " | Duration: " + dur.label);
              await discordbot.editInteractionResponse(token, { content: "✅ **Banned** `" + player.playfabid + "` (" + (player.displayname || "?") + ")\nReason: " + reason + "\nDuration: " + dur.label }).catch(() => {});
              const link = db.prepare("SELECT discord_id FROM discord_links WHERE playfabid = ?").get(player.playfabid);
              if (link) notifyBan(link.discord_id, reason, dur.label);
            }
          } else if (cmd === "unban") {
            const ubResult = await playfab.revokeallbans(player.playfabid).catch(e => ({ error: e.message }));
            if (ubResult?.error) {
              await discordbot.editInteractionResponse(token, { content: "Unban failed: " + ubResult.error }).catch(() => {});
            } else {
              sendAuditLog("Unban", player.playfabid + " (" + (player.displayname || "?") + ")", "");
              await discordbot.editInteractionResponse(token, { content: "✅ **Unbanned** `" + player.playfabid + "` (" + (player.displayname || "?") + ")" }).catch(() => {});
            }
          } else if (cmd === "grant") {
            const items = [];
            for (const name of ["item", "item2", "item3"]) {
              const v = (body.data?.options?.find(o => o.name === name)?.value || "").trim();
              if (v) items.push(v);
            }
            if (!items.length) {
              await discordbot.editInteractionResponse(token, { content: "No item specified." }).catch(() => {});
              return;
            }
            const grantResult = await playfab.grantitemstouser(player.playfabid, items).catch(e => ({ error: e.message }));
            if (grantResult?.error) {
              await discordbot.editInteractionResponse(token, { content: "Grant failed: " + grantResult.error }).catch(() => {});
            } else {
              sendAuditLog("Grant Item", player.playfabid + " (" + (player.displayname || "?") + ")", "Items: `" + items.join("`, `") + "`");
              await discordbot.editInteractionResponse(token, { content: "✅ **Granted** " + items.length + " item(s) to `" + player.playfabid + "` (" + (player.displayname || "?") + ")\n`" + items.join("`, `") + "`" }).catch(() => {});
            }
          } else if (cmd === "remove") {
            const items = [];
            for (const name of ["item", "item2", "item3"]) {
              const v = (body.data?.options?.find(o => o.name === name)?.value || "").trim();
              if (v) items.push(v);
            }
            if (!items.length) {
              await discordbot.editInteractionResponse(token, { content: "No item specified." }).catch(() => {});
              return;
            }
            const inv = await playfab.getuserinventory(player.playfabid).catch(() => null);
            if (!inv?.data?.data?.Inventory) {
              await discordbot.editInteractionResponse(token, { content: "Failed to get inventory or player has no items." }).catch(() => {});
              return;
            }
            const instances = [];
            for (const itemId of items) {
              const found = inv.data.data.Inventory.filter(i => i.ItemId === itemId).map(i => i.ItemInstanceId);
              instances.push(...found);
            }
            if (!instances.length) {
              await discordbot.editInteractionResponse(token, { content: "Player does not have any of the specified item(s)." }).catch(() => {});
              return;
            }
            const revokeResult = await playfab.revokeinventoryitems(player.playfabid, instances).catch(e => ({ error: e.message }));
            if (revokeResult?.error) {
              await discordbot.editInteractionResponse(token, { content: "Remove failed: " + revokeResult.error }).catch(() => {});
            } else {
              sendAuditLog("Remove Item", player.playfabid + " (" + (player.displayname || "?") + ")", "Items: `" + items.join("`, `") + "` (" + instances.length + " instances)");
              await discordbot.editInteractionResponse(token, { content: "✅ **Removed** " + instances.length + " instance(s) from `" + player.playfabid + "` (" + (player.displayname || "?") + ")\n`" + items.join("`, `") + "`" }).catch(() => {});
            }
          } else if (cmd === "removeall") {
            const items = [];
            for (const name of ["item", "item2", "item3"]) {
              const v = (body.data?.options?.find(o => o.name === name)?.value || "").trim();
              if (v) items.push(v);
            }
            if (!items.length) {
              await discordbot.editInteractionResponse(token, { content: "No item specified." }).catch(() => {});
              return;
            }
            await discordbot.editInteractionResponse(token, { content: "⏳ Removing `" + items.join("`, `") + "` from all players... This may take a while." }).catch(() => {});
            const allPlayers = db.prepare("SELECT playfabid FROM players").all();
            let totalRevoked = 0, totalChecked = 0, totalPlayers = allPlayers.length;
            for (const p of allPlayers) {
              totalChecked++;
              if (totalChecked % 50 === 0) {
                const progress = ((totalChecked / totalPlayers) * 100).toFixed(1);
                try { await discordbot.editInteractionResponse(token, { content: "⏳ Removing `" + items.join("`, `") + "` from all players... " + totalChecked + "/" + totalPlayers + " (" + progress + "%) — revoked: " + totalRevoked }); } catch (_) {}
              }
              const inv = await playfab.getuserinventory(p.playfabid).catch(() => null);
              if (!inv?.data?.data?.Inventory) continue;
              const instances = [];
              for (const itemId of items) {
                const found = inv.data.data.Inventory.filter(i => i.ItemId === itemId).map(i => i.ItemInstanceId);
                instances.push(...found);
              }
              if (!instances.length) continue;
              await playfab.revokeinventoryitems(p.playfabid, instances).catch(() => {});
              totalRevoked += instances.length;
            }
            sendAuditLog("Remove All", "All players", "Items: `" + items.join("`, `") + "` (" + totalRevoked + " instances)");
            await discordbot.editInteractionResponse(token, { content: "✅ **Done.** Removed " + totalRevoked + " instance(s) of `" + items.join("`, `") + "` across " + totalPlayers + " players." }).catch(() => {});
          }
        })();
        return;
      }

      return res.json({ type: 4, data: { content: "Unknown command." } });
    }
    res.json({ type: 1 });
  } catch (e) { console.error("[interactions] error:", e.message); res.status(500).json({ error: e.message }); }
});

// ─── WebSocket Bot (monke commands, status, channel rename) ──
function startDiscordGateway() {
  if (!config.discord_bot_token) return;

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers],
  });
  chClient = client;

  client.once("clientReady", () => {
    console.log(`[bot] Logged in as ${client.user.tag}`);
    setPurchaseClient(client);
    updatePlayerCountChannel(client);
    updateRoomListMessage(client);
    updateAuditLinksMessage(client);
    initBotCommands();
    setInterval(() => {
      updatePlayerCountChannel(client);
      try { db.prepare("DELETE FROM redeemable_codes WHERE type = 'discord_link' AND end_time < datetime('now')").run(); } catch (_) {}
    }, 60000);
    setInterval(() => updateRoomListMessage(client), 10000);
    setInterval(() => updateAuditLinksMessage(client), 300000);
  });

  client.on("messageCreate", async (message) => {
    if (message.author.bot) return;
    try {
      db.prepare(
        "INSERT INTO discord_message_counts (discord_id, message_count, last_updated) VALUES (?, 1, datetime('now')) ON CONFLICT(discord_id) DO UPDATE SET message_count = message_count + 1, last_updated = datetime('now')"
      ).run(message.author.id);
    } catch (_) {}
    const content = message.content.toLowerCase().trim();
    const count = wsserver.ccu ? wsserver.ccu() : 0;
    const total = db.prepare("SELECT COUNT(*) as c FROM players").get();
    const totalC = total?.c || 0;

    const monkeCommands = { shortshortshortshortmonke: 0.17, shortshortshortmonke: 0.25, shortshortmonke: 0.5, shortmonke: 6, howmanymonke: 24, longmonke: 96, longlongmonke: 168, longlonglongmonke: 336, longlonglonglongmonke: 720, longlonglonglonglongmonke: 8760 };

    let matchedMonke = null;
    for (const [cmd, hours] of Object.entries(monkeCommands)) {
      if (fuzzyScore(cmd, content.replace(/[^a-z]/g, "")) > 0.65 || content.includes(cmd)) {
        matchedMonke = { cmd, hours }; break;
      }
    }

    if (matchedMonke) {
      if (config.discord_monke_channel && message.channel.id !== config.discord_monke_channel) return;
      const { cmd, hours } = matchedMonke;
      const labels = { shortshortshortshortmonke: "10 min", shortshortshortmonke: "15 min", shortshortmonke: "30 min", shortmonke: "6h", howmanymonke: "24h", longmonke: "4 days", longlongmonke: "7 days", longlonglongmonke: "14 days", longlonglonglongmonke: "30 days", longlonglonglonglongmonke: "1 year" };
      const label = labels[cmd] || `${hours}h`;
      await message.channel.sendTyping();

      const snapshots = getHistory(hours);
      if (!snapshots.length) return message.reply(`No monke data for the last ${label} :(`);

      // Generate graph via Python/matplotlib (exact match to Python bot)
      const { spawn } = require("child_process");
      const pythonScript = path.join(__dirname, "monke_graph.py");
      const py = spawn("python", [pythonScript], { stdio: ["pipe", "pipe", "ignore"] });
      const chunks = [];
      py.stdout.on("data", c => chunks.push(c));
      const exitCode = await new Promise(resolve => {
        py.on("close", resolve);
        py.stdin.write(JSON.stringify({ snapshots: snapshots.map(s => ({ createdat: s.createdat, online: s.online })) }));
        py.stdin.end();
      });

      if (exitCode !== 0 || chunks.length === 0) {
        return message.reply(`Player Count: **${count.toLocaleString()}**\n${label} (graph generation failed)`);
      }

      const buf = Buffer.concat(chunks);

      return message.reply({
        content: `Player Count: **${count.toLocaleString()}**\n${label}`,
        files: [{ attachment: buf, name: "graph.png" }],
      });
    }

    if (content === "!playercount" || content === "!pc") {
      return message.reply(`🦍 **${count}** players online / **${totalC}** total registered`);
    }

    if (content === "!stats") {
      try {
        const maps = db.prepare("SELECT COUNT(*) as c FROM sharedmaps").get();
        const bans = db.prepare("SELECT COUNT(*) as c FROM bans").get();
        const shifts = db.prepare("SELECT COUNT(*) as c FROM shifts WHERE completed = 1").get();
        return message.reply({ embeds: [new EmbedBuilder().setColor(0x5865F2).setDescription("## 📊 Server Stats\n**↓ Stats ↓**\n```[Online] : " + count + "\n[Total Players] : " + totalC + "\n[Shifts Done] : " + (shifts?.c || 0) + "\n[Shared Maps] : " + (maps?.c || 0) + "\n[Bans] : " + (bans?.c || 0) + "\n```")] });
      } catch { return message.reply("Error fetching stats."); }
    }
  });

  // ─── Boost Announce + Gateway Interaction Handler ──
  client.on("guildMemberUpdate", async (oldMember, newMember) => {
    try {
      const BOOST_ANNOUNCE_CHANNEL = "1521397889275007057";
      const hadBooster = oldMember.roles.cache.has(BOOSTER_ROLE_ID);
      const hasBooster = newMember.roles.cache.has(BOOSTER_ROLE_ID);
      if (hadBooster === hasBooster) return;
      const isCH = db.prepare("SELECT 1 FROM community_helpers WHERE discord_id = ?").get(newMember.id);
      if (hasBooster && !hadBooster) {
        const boostEmbed = new EmbedBuilder()
          .setAuthor({ name: "🎉 New Booster!", iconURL: newMember.guild.iconURL({ size: 1024 }) })
          .setDescription(">>> **" + newMember.user.tag + "** just boosted the server!\nThank you for your support " + newMember + " 💜")
          .addFields({ name: "💎 Total Boosts", value: String(newMember.guild.premiumSubscriptionCount || 0), inline: true })
          .addFields({ name: "📈 Boost Level", value: ["None", "Level 1", "Level 2", "Level 3"][newMember.guild.premiumTier] || "None", inline: true })
          .setColor(0xF47FFF).setTimestamp()
          .setFooter({ text: "Monke Mayhem", iconURL: newMember.guild.iconURL({ size: 1024 }) });
        try {
          const channel = client.channels.cache.get(BOOST_ANNOUNCE_CHANNEL);
          if (channel) {
            const msg = await channel.send({ content: newMember.toString(), embeds: [boostEmbed] });
            msg.react("🥳").catch(() => {});
          }
        } catch (_) {}
        try {
          const user = await chClient?.users?.fetch(newMember.id);
          if (user) {
            await user.send("🌟 **Thank you for boosting the server!** 🌟\n\nWe really appreciate your support!" +
              "\n\nAs a **Server Booster**, you get reduced **Community Helper** activity requirements:\n▸ **" + (CH_PLAYTIME_GAIN_BOOSTER/60).toFixed(1) + "h** playtime (rolling 30d) *(normally " + (CH_PLAYTIME_GAIN_MIN/60).toFixed(1) + "h)*\n▸ **" + CH_MSG_GAIN_BOOSTER + "** Discord messages (rolling 30d) *(normally " + CH_MSG_GAIN + ")*\n\nCheck your progress with `/communityhelper` in <#1521354100703236267> and opt in! 🎉");
          }
        } catch (_) {}
      } else if (!hasBooster && hadBooster && isCH) {
        try {
          const user = await chClient?.users?.fetch(newMember.id);
          if (user) await user.send("Your server boost has ended, so your Community Helper requirements are back to normal:\n▸ **" + (CH_PLAYTIME_GAIN_MIN/60).toFixed(1) + "h** playtime (rolling 30d)\n▸ **" + CH_MSG_GAIN + "** Discord messages (rolling 30d)\n\nThank you for boosting while it lasted! 💪");
        } catch (_) {}
      }
    } catch (_) {}
  });

  client.on("interactionCreate", async (interaction) => {
    try {
      // ─── Shared helpers ───
      const member = interaction.member;
      const AUDIT_CHANNEL = "1513408264149274754";
      function sendAuditLog(action, target, detail) {
        try {
          const avatarUrl = member?.user?.avatar ? "https://cdn.discordapp.com/avatars/" + member.user.id + "/" + member.user.avatar + "." + (member.user.avatar.startsWith("a_") ? "gif" : "png") : "";
          discordbot.sendChannelMessage(AUDIT_CHANNEL, null, {
            color: 0x5865F2,
            author: member?.user ? { name: member.user.username, icon_url: avatarUrl } : { name: "System" },
            description: "**" + action + "**\nBy: <@" + (member?.user?.id || "0") + ">\nTarget: `" + (target || "-") + "`\n" + (detail || ""),
            timestamp: new Date().toISOString(),
          }).catch(() => {});
        } catch (_) {}
      }

      // Autocomplete
      if (interaction.isAutocomplete()) {
        const focused = interaction.options.getFocused(true);
        if (focused.name.startsWith("item") && ["grant", "remove", "removeall"].includes(interaction.commandName)) {
          const value = interaction.options.getFocused().toLowerCase();
          const matches = cosmeticsData.filter(c =>
            !value || c.item_id.toLowerCase().includes(value) || c.override_display_name.toLowerCase().includes(value)
          ).slice(0, 25);
          await interaction.respond(matches.map(c => ({ name: c.label.slice(0, 100), value: c.item_id })));
        }
        if (focused.name === "query" && interaction.commandName === "catalog") {
          const value = interaction.options.getFocused().toLowerCase();
          const matches = cosmeticsData.filter(c =>
            !value || c.item_id.toLowerCase().includes(value) || c.override_display_name.toLowerCase().includes(value) || c.display_name.toLowerCase().includes(value)
          ).slice(0, 25);
          await interaction.respond(matches.map(c => ({ name: c.label.slice(0, 100), value: c.item_id })));
        }
        if (focused.name === "month" && interaction.commandName === "editplaytime") {
          const now = new Date();
          const months = [];
          for (let i = 0; i < 12; i++) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            months.push(d.toISOString().slice(0, 7));
          }
          const value = interaction.options.getFocused().toLowerCase();
          await interaction.respond(months.filter(m => !value || m.includes(value)).map(m => ({ name: m, value: m })));
        }
        return;
      }

      // ─── Polls buttons ──
      if (interaction.isButton() && interaction.customId.startsWith("polls_")) {
        if (interaction.user.id !== "898859607391354891")
          return interaction.reply({ content: "Only the bot owner can use this.", ephemeral: true });

        if (interaction.customId === "polls_create") {
          const modal = new ModalBuilder()
            .setCustomId("polls_modal")
            .setTitle("Create a Poll")
            .addComponents(
              new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("question").setLabel("Question").setStyle(1).setMaxLength(500).setRequired(true).setPlaceholder("What do you want to ask?")),
              new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("options").setLabel("Options (one per line, max 10)").setStyle(2).setMaxLength(1000).setRequired(true).setPlaceholder("Option 1\nOption 2\nOption 3")),
              new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("duration").setLabel("Duration (hours, 0 = no expiry)").setStyle(1).setMaxLength(3).setRequired(true).setValue("24"))
            );
          return interaction.showModal(modal);
        }

        if (interaction.customId === "polls_view") {
          const polls = db.prepare("SELECT * FROM polls ORDER BY created_at DESC LIMIT 25").all();
          if (!polls.length) return interaction.reply({ content: "No polls have been created yet.", ephemeral: true });
          const desc = polls.map(p => {
            const opts = JSON.parse(p.options_json || "[]");
            const totalVotes = db.prepare("SELECT COUNT(*) as c FROM poll_votes WHERE poll_id = ?").get(p.id).c;
            const expired = p.expires_at && p.expires_at < new Date().toISOString();
            return "**#" + p.id + "** " + p.question.slice(0, 100) + (expired ? " (expired)" : "") + "\n▸ " + opts.length + " options, " + totalVotes + " vote" + (totalVotes !== 1 ? "s" : "");
          }).join("\n\n");
          const embed2 = new EmbedBuilder().setColor(0x5865F2).setTitle("📊 Past Polls").setDescription(desc || "None").setTimestamp();
          return interaction.reply({ embeds: [embed2], ephemeral: true });
        }
      }

      // ─── Community Helper buttons (must come before generic button handler) ──
      if (interaction.isButton() && interaction.customId.startsWith("ch_")) {
        const action = interaction.customId.split(":")[0];
        const chPfId = interaction.customId.split(":")[1] || "";
        const chDiscordId = interaction.user.id;

        const cmdUser = interaction.message.interaction?.user?.id;
        if (cmdUser && cmdUser !== chDiscordId) {
          return interaction.reply({ content: "These buttons are only for the person who ran `/communityhelper`.", ephemeral: true });
        }

        await interaction.deferUpdate();

        if (action === "ch_optin") {
          const existing = db.prepare("SELECT * FROM community_helpers WHERE discord_id = ?").get(chDiscordId);
          if (!existing) {
            db.prepare("INSERT INTO community_helpers (discord_id, playfabid, status) VALUES (?, ?, 'pending')").run(chDiscordId, chPfId);
          }
          await interaction.editReply(await buildCommunityHelperEmbed(chDiscordId, chPfId, interaction.member));
          return;
        }

        if (action === "ch_optout") {
          const result = db.prepare("DELETE FROM community_helpers WHERE discord_id = ?").run(chDiscordId);
          if (result.changes > 0) {
            try {
              const member = await interaction.guild.members.fetch(chDiscordId);
              if (member.roles.cache.has(CH_ROLE_ID)) await member.roles.remove(CH_ROLE_ID);
            } catch (_) {}
          }
          await interaction.editReply(await buildCommunityHelperEmbed(chDiscordId, chPfId, interaction.member));
          return;
        }

        if (action === "ch_refresh") {
          await interaction.editReply(await buildCommunityHelperEmbed(chDiscordId, chPfId, interaction.member));
          return;
        }
      }

      // Button interactions (friend accept/deny)
      if (interaction.isButton()) {
        const [action, fromPfId] = interaction.customId.split(":");
        if ((action === "friend_accept" || action === "friend_deny") && fromPfId) {
        await interaction.deferReply();
          const myLink = db.prepare("SELECT * FROM discord_links WHERE discord_id = ?").get(interaction.user.id);
          if (!myLink || !myLink.playfabid) return interaction.editReply({ content: "You must link your Discord using `/link` first." });
          const fromLink = db.prepare("SELECT * FROM discord_links WHERE playfabid = ?").get(fromPfId);
          if (!fromLink) return interaction.editReply({ content: "That user no longer has a linked account." });
          const request = db.prepare("SELECT * FROM friend_requests WHERE from_playfabid = ? AND to_discord_id = ? AND status = 'pending'").get(fromPfId, interaction.user.id);
          if (!request) return interaction.editReply({ content: "This request is no longer pending." });
          if (action === "friend_accept") {
            db.prepare("UPDATE friend_requests SET status = 'accepted' WHERE id = ?").run(request.id);
            db.prepare("INSERT OR IGNORE INTO friendlinks (playerid, friendid) VALUES (?, ?)").run(fromPfId, myLink.playfabid);
            db.prepare("INSERT OR IGNORE INTO friendlinks (playerid, friendid) VALUES (?, ?)").run(myLink.playfabid, fromPfId);
            await interaction.editReply({ content: "✅ You accepted the friend request!" });
          } else {
            db.prepare("UPDATE friend_requests SET status = 'denied' WHERE id = ?").run(request.id);
            await interaction.editReply({ content: "❌ You denied the friend request." });
          }
          try { await interaction.message.edit({ components: [] }); } catch (_) {}
          return;
        }
        return;
      }

      // Room moderation select menu / button / modal handlers
      if (interaction.isStringSelectMenu() && interaction.customId.startsWith("room_region:")) {
        const code = interaction.customId.split(":")[1];
        const region = interaction.values[0];
        const rows = db.prepare(
          "SELECT p.playfabid, p.roomid, p.region, p.nickname, pl.displayname " +
          "FROM friendpresence p LEFT JOIN players pl ON pl.playfabid = p.playfabid " +
          "WHERE p.roomid LIKE ? AND p.region = ? AND p.roomid != ''"
        ).all("%" + code + "%", region);

        const players = rows.map(r => ({
          pfid: r.playfabid, name: r.displayname || r.nickname || r.playfabid,
        }));

        const sel = new StringSelectMenuBuilder()
          .setCustomId("room_player:" + code)
          .setPlaceholder("Select player to moderate...")
          .addOptions(players.slice(0, 25).map((p, i) => ({
            label: (i + 1) + ". " + p.name.slice(0, 80),
            value: p.pfid, description: p.pfid,
          })));

        await interaction.update({ content: "Room: `" + code + "` (" + region + ") — " + players.length + " players", components: [new ActionRowBuilder().addComponents(sel)] });
        return;
      }

      if (interaction.isStringSelectMenu() && interaction.customId.startsWith("room_player:")) {
        const pfid = interaction.values[0];
        const player = db.prepare("SELECT playfabid, displayname FROM players WHERE playfabid = ?").get(pfid);
        const name = player?.displayname || pfid;

        const warnBtn = new ButtonBuilder().setCustomId("room_warn:" + pfid).setLabel("Warn").setStyle(ButtonStyle.Danger);
        const banBtn  = new ButtonBuilder().setCustomId("room_ban:" + pfid).setLabel("Ban").setStyle(ButtonStyle.Danger);

        await interaction.update({
          content: "Selected: **" + name + "** (`" + pfid + "`)",
          components: [new ActionRowBuilder().addComponents(warnBtn, banBtn)],
        });
        return;
      }

      if (interaction.isButton() && interaction.customId.startsWith("room_warn:")) {
        const pfid = interaction.customId.split(":")[1];
        await interaction.showModal(
          new ModalBuilder()
            .setCustomId("room_warn_modal:" + pfid)
            .setTitle("Warn Player")
            .addComponents(new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId("reason").setLabel("Reason").setStyle(1).setRequired(true)
            ))
        );
        return;
      }

      if (interaction.isButton() && interaction.customId.startsWith("room_ban:")) {
        const pfid = interaction.customId.split(":")[1];
        await interaction.showModal(
          new ModalBuilder()
            .setCustomId("room_ban_modal:" + pfid)
            .setTitle("Ban Player")
            .addComponents(
              new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("reason").setLabel("Reason").setStyle(1).setRequired(true)),
              new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("hours").setLabel("Hours (0 = permanent)").setStyle(2).setValue("0").setRequired(false))
            )
        );
        return;
      }

      if (interaction.isModalSubmit() && interaction.customId === "polls_modal") {
        if (interaction.user.id !== "898859607391354891")
          return interaction.reply({ content: "Only the bot owner can use this.", ephemeral: true });
        const question = interaction.fields.getTextInputValue("question");
        const optsRaw = interaction.fields.getTextInputValue("options");
        const duration = parseInt(interaction.fields.getTextInputValue("duration")) || 0;
        const options = optsRaw.split("\n").map(s => s.trim()).filter(s => s.length > 0).slice(0, 10);
        if (options.length < 2) return interaction.reply({ content: "You need at least 2 options.", ephemeral: true });
        const expiresAt = duration > 0 ? new Date(Date.now() + duration * 60 * 60 * 1000).toISOString() : null;
        const result = db.prepare("INSERT INTO polls (question, options_json, created_by) VALUES (?, ?, ?)").run(question, JSON.stringify(options), interaction.user.id);
        const pollId = result.lastInsertRowid;
        await interaction.reply({ content: "✅ **Poll #" + pollId + " created!**\nQuestion: " + question + "\nOptions: " + options.join(", ") + (expiresAt ? "\nExpires: <t:" + Math.floor(new Date(expiresAt).getTime() / 1000) + ":R>" : "\nNo expiry"), ephemeral: true });
        return;
      }

      if (interaction.isModalSubmit() && interaction.customId.startsWith("room_warn_modal:")) {
        const pfid = interaction.customId.split(":")[1];
        const reason = interaction.fields.getTextInputValue("reason");
        const player = db.prepare("SELECT displayname, oculusid FROM players WHERE playfabid = ?").get(pfid);
        const ms = player?.oculusid ? db.prepare("SELECT mothershipid FROM mothershipplayers WHERE userid = ?").get(player.oculusid) : null;
        const mid = ms?.mothershipid || "";
        if (mid) {
          wsserver.sendNotification(mid, "Warning", "Community Standards|" + reason);
        }
        sendAuditLog("Room Warn", player?.displayname || pfid, reason);
        await interaction.reply({ content: "Warned **" + (player?.displayname || pfid) + "**: " + reason, ephemeral: true });
        return;
      }

      if (interaction.isModalSubmit() && interaction.customId.startsWith("room_ban_modal:")) {
        const pfid = interaction.customId.split(":")[1];
        const reason = interaction.fields.getTextInputValue("reason");
        const hours = parseInt(interaction.fields.getTextInputValue("hours")) || 0;
        const player = db.prepare("SELECT displayname, oculusid FROM players WHERE playfabid = ?").get(pfid);
        try {
          await playfab.banusers([{ PlayFabId: pfid }], reason, hours || 0);
        } catch (e) { console.log("[room ban] PlayFab ban failed:", e.message); }
        const ms = player?.oculusid ? db.prepare("SELECT mothershipid FROM mothershipplayers WHERE userid = ?").get(player.oculusid) : null;
        const mid = ms?.mothershipid || "";
        if (mid) {
          wsserver.sendNotification(mid, "Warning", "Community Standards|You have been banned: " + reason);
        }
        sendAuditLog("Room Ban", player?.displayname || pfid, reason + " (" + (hours || "permanent") + ")");
        await interaction.reply({ content: "Banned **" + (player?.displayname || pfid) + "**: " + reason, ephemeral: true });
        return;
      }

      // Slash commands
      if (!interaction.isChatInputCommand()) return;
      const cmd = interaction.commandName;
      const discordId = interaction.user.id;
      const count = wsserver.ccu ? wsserver.ccu() : 0;
      const total = db.prepare("SELECT COUNT(*) as c FROM players").get().total || 0;

      // Public commands
      if (cmd === "playercount") {
        return interaction.reply({ embeds: [{ color: 3447003, description: "## 🦍 Player Count\n**↓ Stats ↓**\n```[Online] : " + count + "\n[Total Registered] : " + total + "\n```" }] });
      }

      if (cmd === "stats") {
        const maps = db.prepare("SELECT COUNT(*) as c FROM sharedmaps").get();
        const bans = db.prepare("SELECT COUNT(*) as c FROM bans").get();
        const shifts = db.prepare("SELECT COUNT(*) as c FROM shifts WHERE completed = 1").get();
        return interaction.reply({ embeds: [{ color: 5763719, description: "## 📊 Server Stats\n**↓ Stats ↓**\n```[Online] : " + count + "\n[Total Players] : " + total + "\n[Shifts Done] : " + (shifts?.c || 0) + "\n[Shared Maps] : " + (maps?.c || 0) + "\n[Bans] : " + (bans?.c || 0) + "\n```" }] });
      }

      if (cmd === "link") {
        if (interaction.channelId !== "1513875402890678324")
          return interaction.reply({ content: "Please use <#1513875402890678324> to link your account.", ephemeral: true });

        const linked = db.prepare("SELECT * FROM discord_links WHERE discord_id = ?").get(discordId);
        if (linked) {
          const pfName = linked.playfabid ? db.prepare("SELECT displayname FROM players WHERE playfabid = ?").get(linked.playfabid) : null;
          return interaction.reply({ content: "✅ <@" + discordId + "> is already linked to `" + linked.playfabid + "`" + (pfName?.displayname ? " (" + pfName.displayname + ")" : "") + ". Use `/unlink` to unlink." });
        }

        db.prepare("UPDATE redeemable_codes SET active = 0 WHERE type = 'discord_link' AND end_time < datetime('now')").run();

        const existing = db.prepare("SELECT code FROM redeemable_codes WHERE type = 'discord_link' AND discord_id = ? AND active = 1 AND (end_time IS NULL OR end_time > datetime('now'))").get(discordId);
        if (existing) {
          return interaction.reply({ content: "<@" + discordId + "> already has a pending link code! Type this in the **Redemption Computer** in-game:\n\n`" + existing.code + "`\n\nThis code expires in **15 minutes**." });
        }

        const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        let code = "";
        for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];

        const endTime = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        db.prepare("INSERT INTO redeemable_codes (code, type, discord_id, max_uses, end_time, created_by, discord_interaction_token, discord_channel_id) VALUES (?, 'discord_link', ?, 1, ?, ?, ?, ?)").run(code, discordId, endTime, discordId, interaction.token || "", interaction.channelId || "");

        if (interaction.token) {
          setTimeout(() => {
            interaction.editReply({ content: "⌛ <@" + discordId + "> Your link code (`" + code + "`) **has expired.** Please run `/link` again to generate a new one." }).catch(() => {});
          }, 14.5 * 60 * 1000);
        }

        return interaction.reply({ content: "<@" + discordId + "> | " + interaction.user.username + " Type this code in the **Redemption Computer** in-game:\n\n`" + code + "`\n\nThis code expires in **15 minutes**." });
      }

      if (cmd === "unlink") {
        const linked = db.prepare("SELECT * FROM discord_links WHERE discord_id = ?").get(discordId);
        if (!linked) return interaction.reply({ content: "You don't have a linked account." });
        db.prepare("DELETE FROM discord_links WHERE discord_id = ?").run(discordId);
        try { discordbot.sendChannelMessage("1513408264149274754", null, { color: 0x5865F2, description: "**Unlink Account**\n<@" + discordId + "> (`" + discordId + "`)\nUnlinked from: `" + linked.playfabid + "`\n", timestamp: new Date().toISOString() }); } catch (_) {}
        return interaction.reply({ content: "Your Discord has been unlinked from your in-game account." });
      }

      if (cmd === "cancellink") {
        if (interaction.channelId !== "1513875402890678324")
          return interaction.reply({ content: "Please use <#1513875402890678324> to cancel a link code.", ephemeral: true });
        const updated = db.prepare("UPDATE redeemable_codes SET active = 0 WHERE type = 'discord_link' AND discord_id = ? AND active = 1").run(discordId);
        if (updated.changes > 0) return interaction.reply({ content: "Cancelled your pending link code. You can now use `/link` to get a new one." });
        return interaction.reply({ content: "You don't have any pending link code." });
      }

      // ─── Friend Commands (require link, only in link channel) ──
      const BOT_OWNER_ID = "898859607391354891";
      const friendIdentifier = interaction.options.getString("identifier") || "";
      function parseMention(raw) {
        const m = raw.trim().match(/^<@!?(\d{17,20})>$/);
        return m ? m[1] : null;
      }
      const isOwner = discordId === BOT_OWNER_ID;

      if (cmd === "friendadd") {
        if (interaction.channelId !== "1481428446935777333")
          return interaction.reply({ content: "Please use <#1481428446935777333> for friend commands.", ephemeral: true });
        const linked = db.prepare("SELECT * FROM discord_links WHERE discord_id = ?").get(discordId);
        if (!linked || !linked.playfabid) return interaction.reply({ content: "You must link your Discord using `/link` first." });

        if (isOwner) {
          await interaction.deferReply().catch(() => {});
          const target = resolvePlayer(friendIdentifier);
          if (!target) return interaction.editReply({ content: "Player not found." });
          if (target.playfabid === linked.playfabid) return interaction.editReply({ content: "You can't friend yourself." });
          const existing = db.prepare("SELECT 1 FROM friendlinks WHERE playerid = ? AND friendid = ?").get(linked.playfabid, target.playfabid);
          if (existing) return interaction.editReply({ content: "They're already your friend." });
          db.prepare("INSERT INTO friendlinks (playerid, friendid) VALUES (?, ?)").run(linked.playfabid, target.playfabid);
          return interaction.editReply({ content: "✅ <@" + discordId + "> added **" + (target.displayname || target.playfabid) + "** as a friend!" });
        }

        const targetDiscordId = parseMention(friendIdentifier);
        if (!targetDiscordId) return interaction.reply({ content: "Please mention the person you want to add (@username)." });
        const targetLink = db.prepare("SELECT * FROM discord_links WHERE discord_id = ?").get(targetDiscordId);
        if (!targetLink || !targetLink.playfabid) return interaction.reply({ content: "That user hasn't linked their Discord yet." });
        if (targetLink.playfabid === linked.playfabid) return interaction.reply({ content: "You can't friend yourself." });
        const existing = db.prepare("SELECT 1 FROM friendlinks WHERE playerid = ? AND friendid = ?").get(linked.playfabid, targetLink.playfabid);
        if (existing) return interaction.reply({ content: "They're already your friend." });
        const pending = db.prepare("SELECT 1 FROM friend_requests WHERE from_playfabid = ? AND to_discord_id = ? AND status = 'pending'").get(linked.playfabid, targetDiscordId);
        if (pending) return interaction.reply({ content: "You already have a pending request to that user." });
        await interaction.deferReply().catch(() => {});
        db.prepare("INSERT OR REPLACE INTO friend_requests (from_playfabid, to_discord_id, status) VALUES (?, ?, 'pending')").run(linked.playfabid, targetDiscordId);
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("friend_accept:" + linked.playfabid).setLabel("Accept").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId("friend_deny:" + linked.playfabid).setLabel("Deny").setStyle(ButtonStyle.Danger),
        );
        try {
          const targetUser = await client.users.fetch(targetDiscordId);
          await targetUser.send({ content: "📨 <@" + discordId + "> sent you a friend request!", components: [row] });
          return interaction.editReply({ content: "📨 Friend request sent to <@" + targetDiscordId + ">! Check your DMs." });
        } catch {
          return interaction.editReply({ content: "📨 <@" + discordId + "> sent a friend request to <@" + targetDiscordId + ">! (DMs disabled, use buttons below or `/friendaccept` / `/frienddeny`)", components: [row] });
        }
      }

      if (cmd === "friendremove") {
        if (interaction.channelId !== "1481428446935777333")
          return interaction.reply({ content: "Please use <#1481428446935777333> for friend commands.", ephemeral: true });
        const linked = db.prepare("SELECT * FROM discord_links WHERE discord_id = ?").get(discordId);
        if (!linked || !linked.playfabid) return interaction.reply({ content: "You must link your Discord using `/link` first." });
        const target = isOwner ? resolvePlayer(friendIdentifier) : null;
        const targetPfId = target ? target.playfabid : null;
        if (!targetPfId) {
          const tdId = parseMention(friendIdentifier);
          if (!tdId) return interaction.reply({ content: "Please mention the person you want to remove (@username)." });
          const tl = db.prepare("SELECT playfabid FROM discord_links WHERE discord_id = ?").get(tdId);
          if (!tl) return interaction.reply({ content: "That user hasn't linked their Discord." });
          const existing = db.prepare("SELECT 1 FROM friendlinks WHERE playerid = ? AND friendid = ?").get(linked.playfabid, tl.playfabid);
          if (!existing) return interaction.reply({ content: "They're not in your friend list." });
          db.prepare("DELETE FROM friendlinks WHERE playerid = ? AND friendid = ?").run(linked.playfabid, tl.playfabid);
          return interaction.reply({ content: "✅ <@" + discordId + "> removed <@" + tdId + "> from friends!" });
        }
        if (target.playfabid === linked.playfabid) return interaction.reply({ content: "You can't unfriend yourself." });
        const existing = db.prepare("SELECT 1 FROM friendlinks WHERE playerid = ? AND friendid = ?").get(linked.playfabid, target.playfabid);
        if (!existing) return interaction.reply({ content: "They're not in your friend list." });
        db.prepare("DELETE FROM friendlinks WHERE playerid = ? AND friendid = ?").run(linked.playfabid, target.playfabid);
        return interaction.reply({ content: "✅ <@" + discordId + "> removed **" + (target.displayname || target.playfabid) + "** from friends!" });
      }

      if (cmd === "friendaccept" || cmd === "frienddeny") {
        if (interaction.channelId !== "1481428446935777333")
          return interaction.reply({ content: "Please use <#1481428446935777333> for friend commands.", ephemeral: true });
        const myLink = db.prepare("SELECT * FROM discord_links WHERE discord_id = ?").get(discordId);
        if (!myLink || !myLink.playfabid) return interaction.reply({ content: "You must link your Discord using `/link` first." });
        const fromDiscordId = parseMention(friendIdentifier);
        if (!fromDiscordId) return interaction.reply({ content: "Please @mention the person who sent the request." });
        const fromLink = db.prepare("SELECT * FROM discord_links WHERE discord_id = ?").get(fromDiscordId);
        if (!fromLink || !fromLink.playfabid) return interaction.reply({ content: "That user hasn't linked their Discord." });
        const request = db.prepare("SELECT * FROM friend_requests WHERE from_playfabid = ? AND to_discord_id = ? AND status = 'pending'").get(fromLink.playfabid, discordId);
        if (!request) return interaction.reply({ content: "No pending request from that user." });
        if (cmd === "friendaccept") {
          db.prepare("UPDATE friend_requests SET status = 'accepted' WHERE id = ?").run(request.id);
          db.prepare("INSERT OR IGNORE INTO friendlinks (playerid, friendid) VALUES (?, ?)").run(fromLink.playfabid, myLink.playfabid);
          db.prepare("INSERT OR IGNORE INTO friendlinks (playerid, friendid) VALUES (?, ?)").run(myLink.playfabid, fromLink.playfabid);
          return interaction.reply({ content: "✅ <@" + discordId + "> accepted <@" + fromDiscordId + ">'s friend request! You are now friends." });
        } else {
          db.prepare("UPDATE friend_requests SET status = 'denied' WHERE id = ?").run(request.id);
          return interaction.reply({ content: "❌ <@" + discordId + "> denied <@" + fromDiscordId + ">'s friend request." });
        }
      }

      if (cmd === "privacy") {
        if (interaction.channelId !== "1481428446935777333")
          return interaction.reply({ content: "Please use <#1481428446935777333> to set your privacy state.", ephemeral: true });
        const linked = db.prepare("SELECT * FROM discord_links WHERE discord_id = ?").get(discordId);
        if (!linked || !linked.playfabid) return interaction.reply({ content: "You must link your Discord using `/link` first." });

        const stateVal = interaction.options.getString("state");
        const labels = { "0": "VISIBLE", "1": "PUBLIC_ONLY", "2": "HIDDEN" };
        db.prepare("INSERT OR REPLACE INTO privacystates (playfabid, state) VALUES (?, ?)").run(linked.playfabid, labels[stateVal]);
        return interaction.reply({ content: "✅ Your privacy state is now **" + labels[stateVal] + "** (" + stateVal + ")." });
      }

      if (cmd === "findpeople") {
        const bypassPrivacy = interaction.channelId === "1488422467058794516";
        let sql;
        if (bypassPrivacy) {
          sql = "SELECT fp.playfabid, fp.roomid, fp.zone, fp.region, fp.nickname, p.displayname FROM friendpresence fp LEFT JOIN players p ON p.playfabid = fp.playfabid WHERE fp.roomid != '' ORDER BY fp.region, fp.nickname";
        } else {
          sql = "SELECT fp.playfabid, fp.roomid, fp.zone, fp.region, fp.nickname, p.displayname FROM friendpresence fp LEFT JOIN players p ON p.playfabid = fp.playfabid LEFT JOIN privacystates ps ON ps.playfabid = fp.playfabid WHERE fp.roomid != '' AND (ps.state IS NULL OR ps.state != 'HIDDEN') ORDER BY fp.region, fp.nickname";
        }
        const rows = db.prepare(sql).all();
        if (!rows.length) return interaction.reply({ content: "No one is currently in a room." });
        const groups = {};
        for (const r of rows) {
          const key = r.region || "Unknown";
          if (!groups[key]) groups[key] = [];
          groups[key].push("`" + (r.displayname || r.nickname || r.playfabid) + "` in **" + r.roomid + "**" + (r.zone ? " (" + r.zone + ")" : ""));
        }
        const desc = Object.entries(groups).map(([region, list]) => "**" + region + "** (" + list.length + ")\n" + list.join("\n")).join("\n\n");
        return interaction.reply({ content: "## 👥 Players Online\n" + desc.slice(0, 1900) });
      }

      if (cmd === "auditlinks") {
        const roles = interaction.member?.roles?.cache?.map(r => r.id) || [];
        if (!roles.includes("1412161751020998666")) return interaction.reply({ content: "You don't have permission." });
        await interaction.deferReply();
        const adminMembers = [];
        let lastId = "";
        while (true) {
          const r = await discordbot.discordApi(`/guilds/${config.discord_guild_id}/members?limit=1000${lastId ? "&after=" + lastId : ""}`);
          if (r.status !== 200 || !r.data?.length) break;
          for (const m of r.data) {
            if (m.roles && m.roles.includes("1412161751020998666")) adminMembers.push(m);
          }
          lastId = r.data[r.data.length - 1].user?.id;
          if (!lastId || r.data.length < 1000) break;
        }
        if (!adminMembers.length) return interaction.editReply({ content: "No members with admin role found." });
        let linked = 0, unlinked = 0;
        const lines = [];
        for (const m of adminMembers) {
          const dl = db.prepare("SELECT playfabid FROM discord_links WHERE discord_id = ?").get(m.user.id);
          if (dl) { linked++; lines.push("✅ <@" + m.user.id + "> → `" + dl.playfabid + "`"); }
          else { unlinked++; lines.push("❌ <@" + m.user.id + "> → **NOT LINKED**"); }
        }
        const desc = "## 🔗 Admin Link Audit\n**" + linked + " linked / " + unlinked + " unlinked**\n" + lines.join("\n");
        return interaction.editReply({ content: desc.slice(0, 1900) });
      }

      // ─── Admin Commands ───
      const ADMIN_ROLE = "1412161751020998666";
      const GRANT_ROLE = "1513426812359671808";

      const identifier = interaction.options.getString("identifier") || "";

      function isLinked() {
        return !!db.prepare("SELECT 1 FROM discord_links WHERE discord_id = ?").get(discordId);
      }

      // Fast: linkstatus
      if (cmd === "linkstatus") {
        if (!isLinked()) return interaction.reply({ content: "You must link your Discord using `/link` first." });
        const roles = member.roles?.cache?.map(r => r.id) || [];
        if (!roles.includes(ADMIN_ROLE)) return interaction.reply({ content: "You don't have permission." });
        const player = resolvePlayer(identifier);
        if (!player) return interaction.reply({ content: "Player not found." });
        const dl = db.prepare("SELECT * FROM discord_links WHERE playfabid = ? OR mothershipid = (SELECT mothershipid FROM mothershipplayers WHERE userid = ?)").get(player.playfabid, player.oculusid || "");
        if (!dl) return interaction.reply({ content: "This player is not linked to any Discord account." });
        return interaction.reply({ content: "## 🔗 Link Status\n**↓ Details ↓**\n```[PlayFab ID] : " + player.playfabid + "\n[Discord] : " + "<@" + dl.discord_id + ">\n[Discord ID] : " + dl.discord_id + "\n[Linked At] : " + (dl.linked_at || "N/A") + "\n```" });
      }

      // Fast: playerinfo
      if (cmd === "playerinfo") {
        if (!isLinked()) return interaction.reply({ content: "You must link your Discord using `/link` first." });
        const roles = member.roles?.cache?.map(r => r.id) || [];
        if (!roles.includes(ADMIN_ROLE)) return interaction.reply({ content: "You don't have permission." });

        const player = resolvePlayer(identifier);
        if (!player) return interaction.reply({ content: "Player not found. Try PlayFab ID, Oculus ID, Mothership ID, Display Name, or Discord @mention." });

        const dl = db.prepare("SELECT * FROM discord_links WHERE playfabid = ? OR mothershipid = (SELECT mothershipid FROM mothershipplayers WHERE userid = ?)").get(player.playfabid, player.oculusid || "");
        const bans = db.prepare("SELECT * FROM bans WHERE playfabid = ?").all(player.playfabid);
        const ms = player.oculusid ? db.prepare("SELECT mothershipid FROM mothershipplayers WHERE userid = ?").get(player.oculusid) : null;
        const inv = await playfab.getuserinventory(player.playfabid).catch(() => null);
        const invCount = inv?.data?.data?.Inventory?.length || 0;
        const ptTotal = (db.prepare("SELECT COALESCE(minutes,0) as m FROM player_playtime WHERE playfabid = ?").get(player.playfabid) || {}).m || 0;
        const ptMonth = (db.prepare("SELECT minutes FROM player_playtime WHERE playfabid = ?").get(player.playfabid) || {}).minutes || 0;
        const dmCount = dl ? (db.prepare("SELECT COALESCE(message_count,0) as m FROM discord_message_counts WHERE discord_id = ?").get(dl.discord_id) || {}).m || 0 : 0;
        const desc = "## 📋 Player Info\n**↓ IDs ↓**\n```[PlayFab ID] : " + (player.playfabid || "N/A") + "\n[Oculus ID] : " + (player.oculusid || "N/A") + "\n[Mothership ID] : " + (ms?.mothershipid || "N/A") + "\n[Display Name] : " + (player.displayname || "N/A") + "\n[Discord] : " + (dl ? "<@" + dl.discord_id + ">" : "Not linked") + "\n```\n**↓ Activity ↓**\n```[Playtime (Total)] : " + (ptTotal / 60).toFixed(1) + "h\n[Playtime (Rolling)] : " + (ptMonth / 60).toFixed(1) + "h\n[Discord Messages] : " + dmCount + "\n```\n**↓ Account ↓**\n```[Bans] : " + (bans?.length || 0) + "\n[Inventory Items] : " + invCount + "\n```";
        return interaction.reply({ embeds: [{ color: 3447003, description: desc }] });
      }

      // /me — own account info
      if (cmd === "me") {
        if (interaction.channelId !== "1481428446935777333") return interaction.reply({ content: "Please use <#1481428446935777333> for this command.", ephemeral: true });
        if (!isLinked()) return interaction.reply({ content: "You must link your Discord using `/link` first." });

        const link = db.prepare("SELECT * FROM discord_links WHERE discord_id = ?").get(discordId);
        if (!link) return interaction.reply({ content: "No linked in-game account found. Use `/link` first." });

        const month = new Date().toISOString().slice(0, 7);
        const ptTotal = (db.prepare("SELECT COALESCE(minutes,0) as m FROM player_playtime WHERE playfabid = ?").get(link.playfabid) || {}).m || 0;
        const ptMonth = (db.prepare("SELECT minutes FROM player_playtime WHERE playfabid = ?").get(link.playfabid) || {}).minutes || 0;
        const ch = db.prepare("SELECT status FROM community_helpers WHERE discord_id = ?").get(discordId);
        const chStatus = ch ? ch.status : "none";

        const memberRoles = member.roles?.cache?.map(r => r.id) || [];
        const foundRoles = memberRoles.filter(r => ROLE_MAP[r]);
        foundRoles.sort((a, b) => Object.keys(ROLE_MAP).indexOf(a) - Object.keys(ROLE_MAP).indexOf(b));
        const roleLabel = foundRoles.length ? foundRoles.map(r => `<@&${r}>`).join("\n") : (link ? "Member" : "Not Linked");
        const desc = "## 👤 <@" + discordId + ">'s Account\n**↓ Info ↓**\n```[PlayFab ID] : " + link.playfabid + "\n```\n**↓ Activity (30d rolling) ↓**\n```[Playtime] : " + (ptMonth / 60).toFixed(1) + "h\n[Playtime (Total)] : " + (ptTotal / 60).toFixed(1) + "h\n```\n**↓ Community Helper ↓**\n```[Status] : " + chStatus + "\n```\n**↓ Discord Roles ↓**\n" + roleLabel;
        return interaction.reply({ embeds: [{ color: 0xE040FB, description: desc }] });
      }

      // /grantloa — grant Leave of Absence to a CH
      if (cmd === "grantloa") {
        if (!isLinked()) return interaction.reply({ content: "You must link your Discord using `/link` first." });
        const grantRolePos = interaction.guild?.roles?.cache?.get("1513426812359671808")?.position || 0;
        const hasPerm = member.roles?.cache?.some(r => r.position >= grantRolePos);
        if (!hasPerm) return interaction.reply({ content: "You don't have permission." });

        const targetUser = interaction.options.getUser("user");
        if (!targetUser) return interaction.reply({ content: "Invalid user." });

        const durStr = interaction.options.getString("duration");
        const dur = parseDuration(durStr);
        if (!dur || dur.hours === 0) return interaction.reply({ content: "Invalid duration. Use e.g. `7d`, `14d`, `30d`." });

        const ch = db.prepare("SELECT * FROM community_helpers WHERE discord_id = ?").get(targetUser.id);
        if (!ch) return interaction.reply({ content: "That user is not a Community Helper." });

        const now = new Date();
        const loaEnd = new Date(now.getTime() + dur.hours * 60 * 60 * 1000);
        const graceEnd = new Date(loaEnd.getTime() + 14 * 24 * 60 * 60 * 1000);
        const fmt = d => d.toISOString();

        db.prepare("INSERT OR REPLACE INTO ch_loa (discord_id, loa_start, loa_end, grace_end, granted_by) VALUES (?, ?, ?, ?, ?)")
          .run(targetUser.id, fmt(now), fmt(loaEnd), fmt(graceEnd), discordId);
        db.prepare("INSERT INTO ch_loa_log (discord_id, action, loa_start, loa_end, grace_end, granted_by) VALUES (?, 'grant', ?, ?, ?, ?)")
          .run(targetUser.id, fmt(now), fmt(loaEnd), fmt(graceEnd), discordId);

        try {
          const user = await chClient?.users?.fetch(targetUser.id);
          if (user) await user.send("📋 **You've been granted a Leave of Absence.**\n\nYour LOA ends: <t:" + Math.floor(loaEnd.getTime()/1000) + ":F>\nYou have a 2-week grace period after that to rebuild your activity.\n\nYou won't lose your Community Helper status during this time.");
        } catch (_) {}

        sendAuditLog("LOA Grant", targetUser.id + " (" + dur.label + ")", "LOA end: " + fmt(loaEnd) + " | Grace end: " + fmt(graceEnd));
        return interaction.reply({ embeds: [{ color: 0xE040FB, description: "✅ **LOA Granted**\n**User:** <@" + targetUser.id + ">\n**Granted by:** <@" + discordId + ">\n**Duration:** " + dur.label + "\n**LOA ends:** <t:" + Math.floor(loaEnd.getTime()/1000) + ":F>\n**Grace ends:** <t:" + Math.floor(graceEnd.getTime()/1000) + ":F>" }] });
      }

      // /editplaytime — owner only
      if (cmd === "editplaytime") {
        if (discordId !== "898859607391354891") return interaction.reply({ content: "Only the bot owner can use this command.", ephemeral: true });
        const targetUser = interaction.options.getUser("user");
        const link = db.prepare("SELECT playfabid FROM discord_links WHERE discord_id = ?").get(targetUser.id);
        if (!link) return interaction.reply({ content: "That user is not linked to any PlayFab account.", ephemeral: true });
        const minutes = interaction.options.getNumber("minutes");
        db.prepare("INSERT INTO player_playtime (playfabid, minutes, last_updated) VALUES (?, ?, datetime('now')) ON CONFLICT(playfabid) DO UPDATE SET minutes = ?, last_updated = datetime('now')").run(link.playfabid, minutes, minutes);
        return interaction.reply({ content: "✅ Set <@" + targetUser.id + ">'s playtime to **" + minutes + " min**." });
      }

      // Slow commands — ban, unban, grant, remove, removeall
      if (cmd === "ban" || cmd === "unban" || cmd === "grant" || cmd === "remove" || cmd === "removeall") {
        const requiredRole = (cmd === "grant" || cmd === "remove") ? GRANT_ROLE : ADMIN_ROLE;
        const roles = member.roles?.cache?.map(r => r.id) || [];

        if (!isLinked()) return interaction.reply({ content: "You must link your Discord using `/link` first." });
        if (!roles.includes(requiredRole)) return interaction.reply({ content: "You don't have permission." });

        const player = cmd === "removeall" ? null : resolvePlayer(identifier);
        if (cmd !== "removeall" && !player) return interaction.reply({ content: "Player not found." });

        await interaction.deferReply();

        if (cmd === "ban") {
          const reason = interaction.options.getString("reason") || "No reason provided";
          const durStr = interaction.options.getString("duration");
          const dur = parseDuration(durStr);
          if (!dur) {
            await interaction.editReply({ content: "Invalid duration. Use e.g. `30m`, `2h`, `7d`, `30d`, or `perm`." });
            return;
          }
          const banResult = await playfab.banusers([player.playfabid], "[Discord Ban] " + reason, dur.hours).catch(e => ({ error: e.message }));
          if (banResult?.error) {
            await interaction.editReply({ content: "Ban failed: " + banResult.error });
          } else {
            sendAuditLog("Ban", player.playfabid + " (" + (player.displayname || "?") + ")", "Reason: " + reason + " | Duration: " + dur.label);
            await interaction.editReply({ content: "✅ **Banned** `" + player.playfabid + "` (" + (player.displayname || "?") + ")\nReason: " + reason + "\nDuration: " + dur.label });
            const link = db.prepare("SELECT discord_id FROM discord_links WHERE playfabid = ?").get(player.playfabid);
            if (link) notifyBan(link.discord_id, reason, dur.label);
          }
        } else if (cmd === "unban") {
          const ubResult = await playfab.revokeallbans(player.playfabid).catch(e => ({ error: e.message }));
          if (ubResult?.error) {
            await interaction.editReply({ content: "Unban failed: " + ubResult.error });
          } else {
            sendAuditLog("Unban", player.playfabid + " (" + (player.displayname || "?") + ")", "");
            await interaction.editReply({ content: "✅ **Unbanned** `" + player.playfabid + "` (" + (player.displayname || "?") + ")" });
          }
        } else if (cmd === "grant") {
          const items = [];
          for (const name of ["item", "item2", "item3"]) {
            const v = (interaction.options.getString(name) || "").trim();
            if (v) items.push(v);
          }
          if (!items.length) {
            await interaction.editReply({ content: "No item specified." });
            return;
          }
          const grantResult = await playfab.grantitemstouser(player.playfabid, items).catch(e => ({ error: e.message }));
          if (grantResult?.error) {
            await interaction.editReply({ content: "Grant failed: " + grantResult.error });
          } else {
            sendAuditLog("Grant Item", player.playfabid + " (" + (player.displayname || "?") + ")", "Items: `" + items.join("`, `") + "`");
            await interaction.editReply({ content: "✅ **Granted** " + items.length + " item(s) to `" + player.playfabid + "` (" + (player.displayname || "?") + ")\n`" + items.join("`, `") + "`" });
          }
        } else if (cmd === "remove") {
          const items = [];
          for (const name of ["item", "item2", "item3"]) {
            const v = (interaction.options.getString(name) || "").trim();
            if (v) items.push(v);
          }
          if (!items.length) {
            await interaction.editReply({ content: "No item specified." });
            return;
          }
          const inv = await playfab.getuserinventory(player.playfabid).catch(() => null);
          if (!inv?.data?.data?.Inventory) {
            await interaction.editReply({ content: "Failed to get inventory or player has no items." });
            return;
          }
          const instances = [];
          for (const itemId of items) {
            const found = inv.data.data.Inventory.filter(i => i.ItemId === itemId).map(i => i.ItemInstanceId);
            instances.push(...found);
          }
          if (!instances.length) {
            await interaction.editReply({ content: "Player does not have any of the specified item(s)." });
            return;
          }
          const revokeResult = await playfab.revokeinventoryitems(player.playfabid, instances).catch(e => ({ error: e.message }));
          if (revokeResult?.error) {
            await interaction.editReply({ content: "Remove failed: " + revokeResult.error });
          } else {
            sendAuditLog("Remove Item", player.playfabid + " (" + (player.displayname || "?") + ")", "Items: `" + items.join("`, `") + "` (" + instances.length + " instances)");
            await interaction.editReply({ content: "✅ **Removed** " + instances.length + " instance(s) from `" + player.playfabid + "` (" + (player.displayname || "?") + ")\n`" + items.join("`, `") + "`" });
          }
        } else if (cmd === "removeall") {
          const items = [];
          for (const name of ["item", "item2", "item3"]) {
            const v = (interaction.options.getString(name) || "").trim();
            if (v) items.push(v);
          }
          if (!items.length) {
            await interaction.editReply({ content: "No item specified." });
            return;
          }
          await interaction.editReply({ content: "⏳ Removing `" + items.join("`, `") + "` from all players... This may take a while." });
          const allPlayers = db.prepare("SELECT playfabid FROM players").all();
          let totalRevoked = 0, totalChecked = 0, totalPlayers = allPlayers.length;
          for (const p of allPlayers) {
            totalChecked++;
            if (totalChecked % 50 === 0) {
              const progress = ((totalChecked / totalPlayers) * 100).toFixed(1);
              try { await interaction.editReply({ content: "⏳ Removing `" + items.join("`, `") + "` from all players... " + totalChecked + "/" + totalPlayers + " (" + progress + "%) — revoked: " + totalRevoked }); } catch (_) {}
            }
            const inv = await playfab.getuserinventory(p.playfabid).catch(() => null);
            if (!inv?.data?.data?.Inventory) continue;
            const instances = [];
            for (const itemId of items) {
              const found = inv.data.data.Inventory.filter(i => i.ItemId === itemId).map(i => i.ItemInstanceId);
              instances.push(...found);
            }
            if (!instances.length) continue;
            await playfab.revokeinventoryitems(p.playfabid, instances).catch(() => {});
            totalRevoked += instances.length;
          }
          sendAuditLog("Remove All", "All players", "Items: `" + items.join("`, `") + "` (" + totalRevoked + " instances)");
          await interaction.editReply({ content: "✅ **Done.** Removed " + totalRevoked + " instance(s) of `" + items.join("`, `") + "` across " + totalPlayers + " players." });
        }
      }

      // ─── Event Control Commands ─────────────────────────────
      const EVENT_ROLE = "1514749341330313377";

      if (cmd === "events") {
        const roles = member.roles?.cache?.map(r => r.id) || [];
        if (!roles.includes(EVENT_ROLE)) return interaction.reply({ content: "You don't have permission. Requires the Event Manager role.", ephemeral: true });
        const sub = interaction.options.getSubcommand();

        async function getEventData() {
          const td = await playfab.gettitledata();
          return td?.data?.data?.Data || {};
        }

        async function saveAndReply(key, data, msg) {
          await playfab.setitledata(key, JSON.stringify(data, null, 2));
          sendAuditLog("Event Update", key, msg);
          await interaction.editReply({ content: "✅ " + msg });
        }

        function findObject(parsed, objId) {
          if (!parsed?.Data) return null;
          return parsed.Data.find(o => o.TitleDataObjectID === objId) || null;
        }

        function ensureWindows(obj) {
          if (!obj.AbsoluteDateTimeWindow) obj.AbsoluteDateTimeWindow = [];
          return obj.AbsoluteDateTimeWindow;
        }

        if (sub === "list") {
          await interaction.deferReply();
          try {
            const data = await getEventData();
            const lines = [];
            // Dynamically detect all TitleDataActivation keys
            for (const [ek, raw] of Object.entries(data)) {
              if (typeof raw !== "string") continue;
              let parsed = null;
              try { parsed = JSON.parse(raw); } catch {}
              if (!parsed?.Data?.length || !parsed.Data[0].TitleDataObjectID) continue;
              const objLines = parsed.Data.map(o => {
                const wins = (o.AbsoluteDateTimeWindow || []).map((w, i) => "  `[" + i + "]` " + w.StartDateTime + " → " + w.EndDateTime).join("\n") || "  *no windows*";
                return "`" + o.TitleDataObjectID + "`\n" + wins;
              }).join("\n");
              lines.push("**" + ek + "** (" + parsed.Data.length + " objects)\n" + objLines + "\n");
            }
            const refKey = Object.keys(data).find(k => k.toLowerCase().includes("reference"));
            if (refKey) lines.push("**Reference Date** (`" + refKey + "`): " + data[refKey]);
            await interaction.editReply({ content: "## ⚡ Event Config\n" + lines.join("\n").slice(0, 1900) });
          } catch (e) {
            await interaction.editReply({ content: "Error: " + e.message });
          }
          return;
        }

        if (sub === "start") {
          const key = interaction.options.getString("key");
          const objId = interaction.options.getString("object");
          const dur = interaction.options.getInteger("duration");
          const durationHours = dur !== null && dur !== undefined ? dur : 24;
          await interaction.deferReply();
          try {
            const data = await getEventData();
            let parsed;
            try { parsed = JSON.parse(data[key] || "{}"); } catch { parsed = { Data: [] }; }
            if (!parsed.Data) parsed.Data = [];
            let obj = findObject(parsed, objId);
            if (!obj) {
              obj = { TitleDataObjectID: objId, AbsoluteDateTimeWindow: [] };
              parsed.Data.push(obj);
            }
            const now = new Date();
            const nowStr = now.toLocaleString("en-US", { month: "numeric", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true }).replace(",", "");
            let endStr;
            if (durationHours === 0) {
              endStr = "6/8/3333 12:00:00 AM";
            } else {
              const end = new Date(now.getTime() + durationHours * 3600000);
              endStr = end.toLocaleString("en-US", { month: "numeric", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true }).replace(",", "");
            }
            // Replace the first existing window, or push a new one
            const wins = ensureWindows(obj);
            if (wins.length > 0) {
              wins[0].StartDateTime = nowStr;
              wins[0].EndDateTime = endStr;
            } else {
              wins.push({ StartDateTime: nowStr, EndDateTime: endStr });
            }
            await saveAndReply(key, parsed, "**" + key + " / " + objId + "** activated from now" + (durationHours > 0 ? " for " + durationHours + "h" : " (permanent)") + ".");
          } catch (e) {
            await interaction.editReply({ content: "Error: " + e.message });
          }
          return;
        }

        if (sub === "stop") {
          const key = interaction.options.getString("key");
          const objId = interaction.options.getString("object");
          await interaction.deferReply();
          try {
            const data = await getEventData();
            let parsed;
            try { parsed = JSON.parse(data[key] || "{}"); } catch { parsed = { Data: [] }; }
            const obj = findObject(parsed, objId);
            if (!obj) {
              await interaction.editReply({ content: "Object `" + objId + "` not found in " + key + "." });
              return;
            }
            const now = new Date();
            const nowStr = now.toLocaleString("en-US", { month: "numeric", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true }).replace(",", "");
            const wins = ensureWindows(obj);
            // Set the end of the first active window to now
            if (wins.length > 0) {
              wins[0].EndDateTime = nowStr;
            } else {
              wins.push({ StartDateTime: nowStr, EndDateTime: nowStr });
            }
            await saveAndReply(key, parsed, "**" + key + " / " + objId + "** deactivated (window ended now).");
          } catch (e) {
            await interaction.editReply({ content: "Error: " + e.message });
          }
          return;
        }

        if (sub === "window") {
          const key = interaction.options.getString("key");
          const objId = interaction.options.getString("object");
          const idx = interaction.options.getInteger("index");
          const startRaw = interaction.options.getString("start");
          const endRaw = interaction.options.getString("end");
          await interaction.deferReply();
          try {
            const data = await getEventData();
            let parsed;
            try { parsed = JSON.parse(data[key] || "{}"); } catch { parsed = { Data: [] }; }
            if (!parsed.Data) parsed.Data = [];
            let obj = findObject(parsed, objId);
            if (!obj) {
              obj = { TitleDataObjectID: objId, AbsoluteDateTimeWindow: [] };
              parsed.Data.push(obj);
            }
            const wins = ensureWindows(obj);
            while (wins.length <= idx) wins.push({ StartDateTime: "", EndDateTime: "" });
            if (startRaw) wins[idx].StartDateTime = startRaw;
            if (endRaw) wins[idx].EndDateTime = endRaw;
            const msg = "**" + key + " / " + objId + "** window [" + idx + "] updated.";
            const winDetail = "Set start=" + (startRaw || wins[idx].StartDateTime) + " end=" + (endRaw || wins[idx].EndDateTime);
            await saveAndReply(key, parsed, msg + " `" + winDetail + "`");
          } catch (e) {
            await interaction.editReply({ content: "Error: " + e.message });
          }
          return;
        }
      }

      // ─── MOTD Commands ──────────────────────────────────────
      if (cmd === "motd") {
        const roles = member.roles?.cache?.map(r => r.id) || [];
        if (!roles.includes(EVENT_ROLE)) return interaction.reply({ content: "You don't have permission. Requires the Event Manager role.", ephemeral: true });
        const sub = interaction.options.getSubcommand();
        if (sub === "view") {
          try {
            const td = await playfab.gettitledata();
            const motd = td?.data?.data?.Data?.MOTD || "(not set)";
            await interaction.reply({ content: "## 📢 Message of the Day\n```" + motd.slice(0, 1900) + "```" });
          } catch (e) {
            await interaction.reply({ content: "Error: " + e.message });
          }
          return;
        }
        if (sub === "set") {
          const msg = interaction.options.getString("message");
          await interaction.deferReply();
          try {
            await playfab.setitledata("MOTD", msg);
            sendAuditLog("MOTD Update", "", "MOTD changed via Discord");
            await interaction.editReply({ content: "✅ MOTD updated!\n```" + msg.slice(0, 1900) + "```" });
          } catch (e) {
            await interaction.editReply({ content: "Error: " + e.message });
          }
          return;
        }
      }

      // ─── Q&A Commands ────────────────────────────────────────
      if (cmd === "qa") {
        const sub = interaction.options.getSubcommand();
        if (sub === "ask") {
          // Require in-game account linking
          const link = db.prepare("SELECT playfabid FROM discord_links WHERE discord_id = ?").get(discordId);
          if (!link || !link.playfabid) {
            return interaction.reply({ content: "You must link your Discord to an in-game account first. Use `/link` in <#1513875402890678324> to generate a link code.", ephemeral: true });
          }
          const text = interaction.options.getString("question").trim();
          if (text.length < 5) return interaction.reply({ content: "Question must be at least 5 characters." });
          if (text.length > 500) return interaction.reply({ content: "Question must be under 500 characters." });
          // Map to mothership ID via playfab → oculus → mothership
          const player = db.prepare("SELECT oculusid, displayname FROM players WHERE playfabid = ?").get(link.playfabid);
          let mothershipid = "";
          let oculusId = "";
          let displayName = interaction.user.username;
          if (player) {
            displayName = player.displayname || displayName;
            oculusId = player.oculusid || "";
            if (oculusId) {
              const ms = db.prepare("SELECT mothershipid FROM mothershipplayers WHERE userid = ?").get(oculusId);
              if (ms) mothershipid = ms.mothershipid;
            }
          }
          try {
            db.prepare("INSERT INTO dear_lemmings (mothershipid, message_text, display_name, status) VALUES (?,?,?,'pending')").run(mothershipid || "discord:" + discordId, text, displayName);
            webhook.send("dearlemming", {
              color: 3447003,
              description: "## 📬 Dear Lemming\n**↓ Message ↓**\n```\n" + text + "\n```\n**↓ Player Details ↓**\n```\n[Discord ID] : " + discordId + "\n[PlayFab ID] : " + (link?.playfabid || "N/A") + "\n[Mothership ID] : " + (mothershipid || "N/A") + "\n[Display Name] : " + (displayName || "N/A") + "\n```",
            });
            await interaction.reply({ content: "✅ Your question has been submitted to the team! They'll review it and respond soon." });
          } catch (e) {
            await interaction.reply({ content: "Error submitting question: " + e.message });
          }
          return;
        }
        if (sub === "my") {
          const rows = db.prepare("SELECT id, message_text, display_name, status, answer_text, createdat FROM dear_lemmings WHERE mothershipid = ? ORDER BY createdat DESC LIMIT 20").all("discord:" + discordId);
          if (!rows.length) return interaction.reply({ content: "You haven't submitted any questions yet. Use `/qa ask` to submit one!" });
          const lines = rows.map(q => "**#" + q.id + "** [" + q.status.toUpperCase() + "] " + q.message_text.slice(0, 100) + (q.answer_text ? " *(Answered!)*" : ""));
          await interaction.reply({ content: "## Your Q&A Questions\n" + lines.join("\n").slice(0, 1900) });
          return;
        }
        if (sub === "check") {
          const id = interaction.options.getInteger("id");
          const q = db.prepare("SELECT * FROM dear_lemmings WHERE id = ?").get(id);
          if (!q) return interaction.reply({ content: "Question #" + id + " not found." });
          let msg = "## Q&A #" + id + "\n**" + q.message_text + "**\n*By " + (q.display_name || "Anonymous") + " — " + (q.status || "pending").toUpperCase() + "*\n";
          if (q.answer_text) {
            msg += "\n### Answer:\n**" + (q.answered_by || "Admin") + "**: " + q.answer_text;
          } else {
            msg += "\nNo answers yet. Check back later!";
          }
          await interaction.reply({ content: msg.slice(0, 1900) });
          return;
        }
        if (sub === "recent") {
          const rows = db.prepare("SELECT id, message_text, answer_text, answered_by, createdat FROM dear_lemmings WHERE status = 'answered' ORDER BY createdat DESC LIMIT 10").all();
          if (!rows.length) return interaction.reply({ content: "No answered questions yet." });
          const lines = rows.map(q => "**#" + q.id + "** " + q.message_text.slice(0, 80) + (q.answer_text ? "\n> " + q.answer_text.slice(0, 80) : ""));
          await interaction.reply({ content: "## Recently Answered\n" + lines.join("\n").slice(0, 1900) });
          return;
        }
      }

      // ─── Moderation Notification Commands (warn / mute / unmute) ──
      if (cmd === "warn" || cmd === "mute" || cmd === "unmute") {
        const roles = member.roles?.cache?.map(r => r.id) || [];
        if (!roles.includes(ADMIN_ROLE)) return interaction.reply({ content: "You don't have permission." });

        const player = resolvePlayer(identifier);
        if (!player) return interaction.reply({ content: "Player not found." });

        const ms = db.prepare("SELECT mothershipid FROM mothershipplayers WHERE userid = ?").get(player.oculusid || "");
        const mothershipId = ms?.mothershipid || "";
        if (!mothershipId) return interaction.reply({ content: "Player has no Mothership account." });

        let title, body;
        if (cmd === "warn") {
          const reason = interaction.options.getString("reason") || "other";
          const subreason = interaction.options.getString("subreason") || "";
          title = "Warning";
          body = "Community Standards|" + reason + (subreason ? "," + subreason : "");
        } else if (cmd === "mute") {
          const minutes = interaction.options.getInteger("minutes") || 0;
          title = "Mute";
          body = "voice|" + minutes + "|" + (minutes > 0 ? minutes * 60 : "");
        } else {
          title = "Unmute";
          body = "";
        }

        const sent = wsserver.sendNotification(mothershipId, title, body);
        if (sent) {
          sendAuditLog(title, player.playfabid + " (" + (player.displayname || "?") + ")", body ? "Details: " + body : "");
          await interaction.reply({ content: "✅ **" + title + "** sent to `" + player.playfabid + "` (" + (player.displayname || "?") + ")" + (body ? "\nBody: " + body : "") });
        } else {
          await interaction.reply({ content: "⚠️ **" + title + "** — player is not connected via WebSocket." });
        }
      }

      // ─── Announce Command (owner only — broadcast to all connected players) ──
      if (cmd === "announce") {
        if (interaction.user.id !== "898859607391354891") return interaction.reply({ content: "Only the bot owner can use this command." });

        const message = interaction.options.getString("message") || "";
        if (!message) return interaction.reply({ content: "Message cannot be empty." });

        const title = "Warning";
        const body = "Community Announcement|" + message;

        let sent = 0;
        let failed = 0;
        for (const [pid, socket] of wsserver.playerSockets) {
          if (socket.readyState === 1) {
            wsserver.sendNotification(pid, title, body);
            sent++;
          } else {
            failed++;
          }
        }

        sendAuditLog("Announcement", sent + " players", message.slice(0, 200));
        await interaction.reply({ content: "✅ **Announcement** sent to **" + sent + "** player" + (sent !== 1 ? "s" : "") + (failed ? " (" + failed + " disconnected)" : "") + "\n> " + message.slice(0, 500) });
      }

      // ─── Catalog Command (search cosmetics by name/id) ──
      if (cmd === "catalog") {
        const query = (interaction.options.getString("query") || "").toLowerCase();
        if (!query) return interaction.reply({ content: "Please provide a search query." });

        const matches = cosmeticsData.filter(c =>
          c.display_name.toLowerCase().includes(query) ||
          c.override_display_name.toLowerCase().includes(query) ||
          c.item_id.toLowerCase().includes(query)
        ).slice(0, 20);

        if (!matches.length) return interaction.reply({ content: "No cosmetics found matching `" + query + "`." });

        const lines = matches.map(c => "`" + c.item_id + "` — " + c.override_display_name);
        await interaction.reply({ content: "## Catalog results for `" + query + "`\n" + lines.join("\n").slice(0, 1900) });
      }

      // ─── Set AppLab Command (admin) ──
      if (cmd === "setapplab") {
        const roles = member.roles?.cache?.map(r => r.id) || [];
        if (!roles.includes("1434689042943049872") && interaction.user.id !== "898859607391354891")
          return interaction.reply({ content: "You don't have permission to use this command." });

        await interaction.deferReply();
        const link = (interaction.options.getString("link") || "").trim();
        if (!link || !link.startsWith("https://")) return interaction.editReply({ content: "Invalid link. Must start with https://" });

        let title = "", image = "", desc = "";
        try {
          const meta = await new Promise((resolve, reject) => {
            const u = new URL(link);
            https.get({ hostname: u.hostname, path: u.pathname + u.search, headers: { "User-Agent": "ProjectRS/1.0" }, timeout: 8000 }, (r) => {
              let body = ""; r.on("data", c => body += c); r.on("end", () => resolve(body));
            }).on("error", reject).on("timeout", function() { this.destroy(); resolve(""); });
          });
          const ogTitle = meta.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
          const ogImage = meta.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
          const ogDesc  = meta.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i);
          const twTitle = meta.match(/<meta\s+name="twitter:title"\s+content="([^"]+)"/i);
          const twImage = meta.match(/<meta\s+name="twitter:image"\s+content="([^"]+)"/i);
          const pageTitle = meta.match(/<title>([^<]+)<\/title>/i);
          title = (ogTitle || twTitle || pageTitle || [])[1] || "";
          image = (ogImage || twImage || [])[1] || "";
          desc  = (ogDesc  || [])[1] || "";
          if (image && !image.startsWith("http")) image = u.origin + (image.startsWith("/") ? "" : "/") + image;
        } catch (e) { console.log("[applab] meta fetch failed:", e.message); }

        const data = { link, title, image, desc };

        // Download & save image locally
        let localImage = image;
        if (image) {
          try {
            const imgData = await new Promise((resolve, reject) => {
              const iu = new URL(image);
              const chunks = [];
              https.get({ hostname: iu.hostname, path: iu.pathname + iu.search, headers: { "User-Agent": "Mozilla/5.0" }, timeout: 15000 }, (r) => {
                if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
                  const ru = new URL(r.headers.location, image);
                  https.get({ hostname: ru.hostname, path: ru.pathname + ru.search, headers: { "User-Agent": "Mozilla/5.0" }, timeout: 15000 }, (r2) => {
                    r2.on("data", c => chunks.push(c));
                    r2.on("end", () => resolve(Buffer.concat(chunks)));
                    r2.on("error", reject);
                  }).on("timeout", function() { this.destroy(); reject(new Error("timeout")); });
                } else {
                  r.on("data", c => chunks.push(c));
                  r.on("end", () => resolve(Buffer.concat(chunks)));
                  r.on("error", reject);
                }
              }).on("error", reject).on("timeout", function() { this.destroy(); reject(new Error("timeout")); });
            });
            const ext = image.match(/\.(webp|png|jpg|jpeg|gif)(\?|$)/i)?.[1] || "webp";
            fs.writeFileSync(path.join(__dirname, "public", "applab-icon." + ext), imgData);
            for (const old of ["applab-icon.webp","applab-icon.png","applab-icon.jpg","applab-icon.jpeg","applab-icon.gif"]) {
              if (old !== "applab-icon." + ext) { try { fs.unlinkSync(path.join(__dirname, "public", old)); } catch (_) {} }
            }
            localImage = "/applab-icon." + ext;
          } catch (e) { console.log("[applab] image download failed:", e.message); }
        }

        data.image = localImage;
        fs.writeFileSync(path.join(__dirname, "data", "applab.json"), JSON.stringify(data, null, 2), "utf8");

        const embed = new EmbedBuilder()
          .setColor(0xE040FB)
          .setTitle("AppLab Updated")
          .setDescription(`[${title || "AppLab"}](${link})` + (desc ? `\n${desc}` : ""))
          .setTimestamp();
        if (localImage) embed.setThumbnail("https://ctag-cf.com" + localImage);

        await interaction.editReply({ embeds: [embed] });
      }

      // ─── Room command (admin) ──
      if (cmd === "room") {
        const roles = member.roles?.cache?.map(r => r.id) || [];
        if (!roles.includes("1412161751020998666") && interaction.user.id !== "898859607391354891")
          return interaction.reply({ content: "You don't have permission.", ephemeral: true });

        await interaction.deferReply();
        const code = (interaction.options.getString("code") || "").trim().toUpperCase();
        const rows = db.prepare(
          "SELECT p.playfabid, p.roomid, p.region, p.nickname, pl.displayname " +
          "FROM friendpresence p LEFT JOIN players pl ON pl.playfabid = p.playfabid " +
          "WHERE p.roomid LIKE ? AND p.roomid != ''"
        ).all("%" + code + "%");

        if (!rows.length) return interaction.editReply({ content: "No players found in room `" + code + "`." });

        const regions = [...new Set(rows.map(r => r.region || "?"))];
        if (regions.length > 1) {
          const sel = new StringSelectMenuBuilder()
            .setCustomId("room_region:" + code)
            .setPlaceholder("Select region...")
            .addOptions(regions.map(r => ({ label: r, value: r })));
          return interaction.editReply({ content: "Room `" + code + "` found in " + regions.length + " regions:", components: [new ActionRowBuilder().addComponents(sel)] });
        }

        const players = rows.map(r => ({
          pfid: r.playfabid, name: r.displayname || r.nickname || r.playfabid,
        }));

        const desc = "## Room: " + code + " (" + regions[0] + ")\n**" + players.length + " players**\n\n" +
          players.map((p, i) => (i + 1) + ". `" + p.pfid + "` — " + p.name).join("\n").slice(0, 3800);

        const sel = new StringSelectMenuBuilder()
          .setCustomId("room_player:" + code)
          .setPlaceholder("Select player to moderate...")
          .addOptions(players.slice(0, 25).map((p, i) => ({
            label: (i + 1) + ". " + p.name.slice(0, 80),
            value: p.pfid, description: p.pfid,
          })));

        await interaction.editReply({ content: desc.slice(0, 2000), components: [new ActionRowBuilder().addComponents(sel)] });
      }

      // ─── Claim Cosmetics command ──
      if (cmd === "claimcosmetics") {
        const linked = db.prepare("SELECT * FROM discord_links WHERE discord_id = ?").get(discordId);
        if (!linked || !linked.playfabid) return interaction.reply({ content: "You must link your account first! Use `/link` in <#1513875402890678324>.", ephemeral: true });

        const roles = member.roles?.cache?.map(r => r.id) || [];

        // Collect all earned items
        const earned = new Set();
        let matchedRoles = [];
        for (const roleId of roles) {
          const items = ROLE_MAP[roleId];
          if (items) {
            matchedRoles.push(roleId);
            for (const item of items) earned.add(item);
          }
        }
        if (discordId === "898859607391354891") {
          earned.add("LMBAO.");
          if (!matchedRoles.length) matchedRoles.push("owner");
        }

        if (!earned.size) return interaction.reply({ content: "You don't have any roles that grant cosmetics.", ephemeral: true });

        await interaction.deferReply({ ephemeral: true });

        // Grant items via PlayFab
        const items = [...earned];
        let granted = [];
        try {
          await playfab.grantitemstouser(linked.playfabid, items, "DLC");
          granted = items;
        } catch (e) {
          console.log("[claimcosmetics] grant failed:", e.message);
          return interaction.editReply({ content: "Failed to grant cosmetics: " + e.message });
        }

        await interaction.editReply({
          embeds: [new EmbedBuilder()
            .setColor(0x576371)
            .setTitle("Cosmetics Claimed")
            .setDescription("**Player:** " + (linked.playfabid) + "\n\n**Granted:**\n" + granted.map(i => "`" + i + "`").join("\n"))
            .setFooter({ text: "Project RS" })
          ]
        });

        sendAuditLog("Claim Cosmetics", linked.playfabid, "Granted: " + granted.join(", "));
      }

      // ─── Resync Cosmetics command (Owner) ──
      if (cmd === "resynccosmetics") {
        if (interaction.user.id !== "898859607391354891")
          return interaction.reply({ content: "Owner only.", ephemeral: true });
        if (!interaction.options.getBoolean("confirm"))
          return interaction.reply({ content: "Set confirm to true.", ephemeral: true });

        await interaction.deferReply({ ephemeral: true });

        const { ALL_ROLE_ITEMS: ROLE_ITEMS } = require("./lib/rolemap");

        const progressEmbed = (phase, done, total, extra) =>
          new EmbedBuilder().setColor(0xE040FB).setTitle("Resync in progress...")
            .setDescription(
              "**Phase " + phase + "/2**\n" +
              "Progress: " + done + "/" + total + "\n" +
              "```" + "█".repeat(Math.round(done/total*20)) + "░".repeat(20-Math.round(done/total*20)) + "```\n" +
              (extra || "")
            ).setTimestamp();

        async function runBatch(arr, fn, concurrency) {
          let i = 0;
          while (i < arr.length) {
            const batch = arr.slice(i, i + concurrency);
            await Promise.allSettled(batch.map(fn));
            i += concurrency;
          }
        }

        // Phase 1: Revoke from all players (in parallel batches)
        const allPlayers = db.prepare("SELECT playfabid FROM players").all();
        let revoked = 0, lastUpdate = 0;
        await interaction.editReply({ embeds: [progressEmbed(1, 0, allPlayers.length, "Revoking role cosmetics...")] });
        await runBatch(allPlayers, async (player) => {
          try {
            const inv = await playfab.getuserinventory(player.playfabid);
            const items = inv?.data?.data?.Inventory || [];
            const instIds = items.filter(it => ROLE_ITEMS.includes(it.ItemId)).map(it => it.ItemInstanceId);
            if (instIds.length) {
              for (let j = 0; j < instIds.length; j += 10) {
                try {
                  await playfab.adminRevokeInventoryItems(player.playfabid, instIds.slice(j, j + 10));
                  revoked += instIds.slice(j, j + 10).length;
                } catch (e) {}
              }
            }
          } catch (e) {}
        }, 5);

        // Phase 2: Re-grant to linked users (in parallel batches)
        const linked = db.prepare("SELECT * FROM discord_links WHERE active = 1").all();
        let granted = 0, skipped = 0;
        lastUpdate = 0;
        await interaction.editReply({ embeds: [progressEmbed(2, 0, linked.length, "Re-granting to linked users...")] });
        await runBatch(linked, async (user) => {
          try {
            const memberRoles = await discordbot.getMemberRoles(user.discord_id);
            const earned = new Set();
            for (const r of memberRoles) {
              const items = ROLE_MAP[r];
              if (items) for (const item of items) earned.add(item);
            }
            if (user.discord_id === "898859607391354891") earned.add("LMBAO.");
            if (earned.size) {
              await playfab.grantitemstouser(user.playfabid, [...earned], "DLC");
              granted += earned.size;
            } else { skipped++; }
          } catch (e) { skipped++; }
        }, 5);

        await interaction.editReply({
          embeds: [new EmbedBuilder().setColor(0x3FB950).setTitle("Resync Complete")
            .setDescription(
              "**All players checked:** " + allPlayers.length +
              "\n**Items revoked:** " + revoked +
              "\n**Linked users:** " + linked.length +
              "\n**Items granted:** " + granted +
              "\n**Skipped (no roles):** " + skipped
            ).setTimestamp()]
        });
      }

      // ─── Regrant command ──
      if (cmd === "regrant") {
        if (interaction.channelId !== "1481428446935777333")
          return interaction.reply({ content: "Please use <#1481428446935777333> for this command.", ephemeral: true });
        const linked = db.prepare("SELECT * FROM discord_links WHERE discord_id = ?").get(discordId);
        if (!linked || !linked.playfabid) return interaction.reply({ content: "You must link your account first! Use `/link` in <#1513875402890678324>.", ephemeral: true });

        await interaction.deferReply();
        try {
        const ROLE_ITEMS = ALL_ROLE_ITEMS;

          const RESTRICTED_ITEMS = ["LBAAA.","LBAAB.","LBAAC.","LBAAF.","LBAAG.","LBAAH.","LBAAI.","LBAAJ.","LBAAL.","LBAAM.","LBAAO."];

          // Phase 1: Remove role items the user shouldn't have
          const memberRoles = await discordbot.getMemberRoles(discordId);
          const earned = new Set();
          for (const r of memberRoles) {
            const items = ROLE_MAP[r];
            if (items) for (const item of items) earned.add(item);
          }
          if (discordId === "898859607391354891") earned.add("LMBAO.");
          const inv = await playfab.getuserinventory(linked.playfabid);
          const inventory = inv?.data?.data?.Inventory || [];
          const roleItemsInInv = inventory.filter(i => ROLE_ITEMS.includes(i.ItemId));
          const removeItems = roleItemsInInv.filter(i => !earned.has(i.ItemId));
          let removed = 0, removedNames = [];
          if (removeItems.length) {
            removedNames = [...new Set(removeItems.map(i => i.ItemId))];
            const instIds = removeItems.map(i => i.ItemInstanceId);
            for (let i = 0; i < instIds.length; i += 10) {
              const batch = instIds.slice(i, i + 10);
              try {
                const r = await playfab.adminRevokeInventoryItems(linked.playfabid, batch);
                if (r.status !== 200) console.log("[regrant] revoke failed:", r.status, JSON.stringify(r.data).slice(0, 200));
                else removed += batch.length;
              } catch (e) { console.log("[regrant] revoke error:", e.message); }
            }
          }

          // Phase 2: Grant missing role items (exclude removed ones from owned check)
          const removedItemIds = new Set(removedNames);
          const ownedIds = new Set(inventory.filter(i => !removedItemIds.has(i.ItemId)).map(i => i.ItemId));
          const missingRole = [...earned].filter(id => !ownedIds.has(id));

          // Phase 3: Grant missing bundle items (exclude role-gated + restricted GT1 items)
          const bundleItems = await playfab.getBundleItems("LBATSafw");
          const missingBundle = bundleItems.filter(id => !ownedIds.has(id) && !missingRole.includes(id) && !ROLE_ITEMS.includes(id) && !RESTRICTED_ITEMS.includes(id));

          const allGrant = [...missingRole, ...missingBundle];
          if (allGrant.length) {
            await playfab.grantitemstouser(linked.playfabid, allGrant, "DLC");
          }

          await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x576371)
            .setTitle("Regrant Complete")
            .setDescription(
              (removed ? "**Removed (" + removed + "):** " + removedNames.map(i => "`" + i + "`").join(" ") + "\n" : "") +
              (missingRole.length ? "**Role items granted:** " + missingRole.map(i => "`" + i + "`").join(" ") + "\n" : "") +
              (missingBundle.length ? "**Bundle items granted:** " + missingBundle.length + " items" : "") +
              (!removed && !allGrant.length ? "You're all caught up — nothing to change." : "")
            ).setTimestamp()] });
        sendAuditLog("Regrant", linked.playfabid,
          (removed ? "Removed:" + removed + " " : "") +
          (missingRole.length ? "RoleGrant:" + missingRole.join(",") + " " : "") +
          (missingBundle.length ? "BundleGrant:" + missingBundle.length : ""));
      } catch (e) {
          await interaction.editReply({ content: "Failed: " + e.message });
        }
      }

      // ─── Polls ──
      if (cmd === "polls") {
        if (discordId !== "898859607391354891")
          return interaction.reply({ content: "Only the bot owner can use this command.", ephemeral: true });

        const totalPolls = db.prepare("SELECT COUNT(*) as c FROM polls").get().c;
        const activePolls = db.prepare("SELECT COUNT(*) as c FROM polls WHERE expires_at IS NULL OR expires_at > datetime('now')").get().c;
        const embed = new EmbedBuilder()
          .setColor(0x5865F2).setTitle("📊 Polls")
          .setDescription(
            "**Total polls created:** " + totalPolls + "\n" +
            "**Active polls:** " + activePolls + "\n\n" +
            "Use the buttons below to create a new poll or view past results."
          ).setTimestamp();

        const row = new ActionRowBuilder()
          .addComponents(new ButtonBuilder().setCustomId("polls_create").setLabel("Create Poll").setStyle(ButtonStyle.Primary))
          .addComponents(new ButtonBuilder().setCustomId("polls_view").setLabel("View Past Polls").setStyle(ButtonStyle.Secondary));

        return interaction.reply({ embeds: [embed], components: [row] });
      }

      // ─── Community Helper ──
      if (cmd === "communityhelper") {
        if (interaction.channelId !== "1521354100703236267")
          return interaction.reply({ content: "Please use <#1521354100703236267> for this command.", ephemeral: true });
        const linked = db.prepare("SELECT * FROM discord_links WHERE discord_id = ?").get(discordId);
        if (!linked || !linked.playfabid) {
          return interaction.reply({ content: "You must link your account first! Use `/link` in <#1513875402890678324>.", ephemeral: true });
        }
        await interaction.reply(await buildCommunityHelperEmbed(discordId, linked.playfabid, interaction.member));
      }

      // /chleaderboard — owner only
      if (cmd === "chleaderboard") {
        if (discordId !== "898859607391354891") return interaction.reply({ content: "Only the bot owner can use this command.", ephemeral: true });
        const links = db.prepare("SELECT dl.discord_id, dl.playfabid FROM discord_links dl WHERE dl.active = 1 AND dl.discord_id NOT IN (SELECT discord_id FROM community_helpers)").all();
        const scored = [];
        for (const link of links) {
          const pt = db.prepare("SELECT minutes FROM player_playtime WHERE playfabid = ?").get(link.playfabid);
          const mc = db.prepare("SELECT message_count FROM discord_message_counts WHERE discord_id = ?").get(link.discord_id);
          const playMins = pt?.minutes || 0;
          const msgs = mc?.message_count || 0;
          const pct = Math.min(100, Math.round((playMins / CH_PLAYTIME_GAIN_MIN + msgs / CH_MSG_GAIN) / 2 * 100));
          scored.push({ discordId: link.discord_id, playMins, msgs, pct });
        }
        scored.sort((a, b) => b.pct - a.pct);
        const top = scored.slice(0, 10);
        if (!top.length) return interaction.reply({ content: "No linked users found." });
        const lines = top.map((u, i) =>
          "**" + (i + 1) + ".** <@" + u.discordId + "> — " + (u.playMins / 60).toFixed(1) + "h / " + u.msgs + " msgs (" + u.pct + "%)"
        );
        return interaction.reply({ embeds: [{ color: 0xE040FB, title: "🏆 CH Leaderboard", description: "Top 10 closest to qualifying:\n" + lines.join("\n"), footer: { text: "Threshold: " + (CH_PLAYTIME_GAIN_MIN / 60).toFixed(1) + "h + " + CH_MSG_GAIN + " msgs" } }] });
      }
    } catch (e) {
      console.error("[bot] interaction error:", e.message);
      try {
        if (interaction.deferred) await interaction.editReply({ content: "Error: " + e.message });
        else if (!interaction.replied) await interaction.reply({ content: "Error: " + e.message });
      } catch (_) {}
    }
  });

  client.login(config.discord_bot_token).catch(e => console.error("[bot] Login failed:", e.message));

  // ─── Community Helper background checker (every 30 min) ──
  setInterval(async () => {
    try {

      // 1. Grant/revoke opted-in users
      const helpers = db.prepare("SELECT * FROM community_helpers").all();
      for (const ch of helpers) {
        try {
          const loa = db.prepare("SELECT * FROM ch_loa WHERE discord_id = ?").get(ch.discord_id);
          if (loa) {
            const now = new Date().toISOString();
            if (now < loa.loa_end) continue; // still on LOA — skip completely
            if (now < loa.grace_end) {
              // Grace period — evaluate with keep thresholds
              const guild = chClient?.guilds?.cache?.first();
              const m = guild ? await guild.members.fetch(ch.discord_id).catch(() => null) : null;
              const booster = m?.roles?.cache?.has(BOOSTER_ROLE_ID) || false;
              const pt = db.prepare("SELECT minutes FROM player_playtime WHERE playfabid = ?").get(ch.playfabid);
              const mc = db.prepare("SELECT message_count FROM discord_message_counts WHERE discord_id = ?").get(ch.discord_id);
              const playtimeOk = (pt?.minutes || 0) >= (booster ? CH_PLAYTIME_KEEP_BOOSTER : CH_PLAYTIME_KEEP_MIN);
              const msgOk = (mc?.message_count || 0) >= (booster ? CH_MSG_KEEP_BOOSTER : CH_MSG_KEEP);
              if (playtimeOk && msgOk) {
                if (ch.status !== "active") await chTryGrant(ch.discord_id, ch.playfabid);
              } else if (ch.status === "active") {
                await chTryRevoke(ch.discord_id, ch.playfabid);
              }
              continue;
            }
            // Grace expired — log and clean up, fall through to normal check
            db.prepare("INSERT INTO ch_loa_log (discord_id, action, loa_start, loa_end, grace_end) VALUES (?, 'expired', ?, ?, ?)")
              .run(ch.discord_id, loa.loa_start, loa.loa_end, loa.grace_end);
            db.prepare("DELETE FROM ch_loa WHERE discord_id = ?").run(ch.discord_id);
          }
          const guild = chClient?.guilds?.cache?.first();
          const m = guild ? await guild.members.fetch(ch.discord_id).catch(() => null) : null;
          const booster = m?.roles?.cache?.has(BOOSTER_ROLE_ID) || false;
          if (booster && !db.prepare("SELECT 1 FROM ch_booster_notified WHERE discord_id = ?").get(ch.discord_id)) {
            try {
              const user = await chClient?.users?.fetch(ch.discord_id);
              if (user) await user.send("🌟 **Thank you for boosting the server!** 🌟\n\nAs a **Server Booster** and **Community Helper**, you get reduced activity requirements:\n▸ **" + (CH_PLAYTIME_GAIN_BOOSTER/60).toFixed(1) + "h** playtime (rolling 30d) *(normally " + (CH_PLAYTIME_GAIN_MIN/60).toFixed(1) + "h)*\n▸ **" + CH_MSG_GAIN_BOOSTER + "** Discord messages (rolling 30d) *(normally " + CH_MSG_GAIN + ")*\n\nKeep up the great work! 🎉");
            } catch (_) {}
            db.prepare("INSERT OR IGNORE INTO ch_booster_notified (discord_id) VALUES (?)").run(ch.discord_id);
          }
          const pt = db.prepare("SELECT minutes FROM player_playtime WHERE playfabid = ?").get(ch.playfabid);
          const mc = db.prepare("SELECT message_count FROM discord_message_counts WHERE discord_id = ?").get(ch.discord_id);
          const isActive = ch.status === "active";
          const needPlaytime = isActive ? (booster ? CH_PLAYTIME_KEEP_BOOSTER : CH_PLAYTIME_KEEP_MIN) : (booster ? CH_PLAYTIME_GAIN_BOOSTER : CH_PLAYTIME_GAIN_MIN);
          const needMessages = isActive ? (booster ? CH_MSG_KEEP_BOOSTER : CH_MSG_KEEP) : (booster ? CH_MSG_GAIN_BOOSTER : CH_MSG_GAIN);
          const playtimeOk = (pt?.minutes || 0) >= needPlaytime;
          const msgOk = (mc?.message_count || 0) >= needMessages;

          if (playtimeOk && msgOk) {
            if (ch.status !== "active") await chTryGrant(ch.discord_id, ch.playfabid);
          } else if (ch.status === "active") {
            await chTryRevoke(ch.discord_id, ch.playfabid);
          }
        } catch (_) {}
      }

      // 2. DM invite to linked users who qualify but haven't opted in
      const links = db.prepare("SELECT dl.discord_id, dl.playfabid FROM discord_links dl WHERE dl.active = 1 AND dl.discord_id NOT IN (SELECT discord_id FROM community_helpers) AND dl.discord_id NOT IN (SELECT discord_id FROM ch_notified)").all();
      for (const link of links) {
        try {
          const guild = chClient?.guilds?.cache?.first();
          const m = guild ? await guild.members.fetch(link.discord_id).catch(() => null) : null;
          const booster = m?.roles?.cache?.has(BOOSTER_ROLE_ID) || false;
          const pt = db.prepare("SELECT minutes FROM player_playtime WHERE playfabid = ?").get(link.playfabid);
          const mc = db.prepare("SELECT message_count FROM discord_message_counts WHERE discord_id = ?").get(link.discord_id);
          const playtimeMin = pt?.minutes || 0;
          const msgCount = mc?.message_count || 0;
          const gainPlaytime = booster ? CH_PLAYTIME_GAIN_BOOSTER : CH_PLAYTIME_GAIN_MIN;
          const keepPlaytime = booster ? CH_PLAYTIME_KEEP_BOOSTER : CH_PLAYTIME_KEEP_MIN;
          const gainMsgs = booster ? CH_MSG_GAIN_BOOSTER : CH_MSG_GAIN;
          const keepMsgs = booster ? CH_MSG_KEEP_BOOSTER : CH_MSG_KEEP;
          if (playtimeMin >= gainPlaytime && msgCount >= gainMsgs) {
            try {
              const user = await chClient?.users?.fetch(link.discord_id);
              if (user) {
                await user.send("👋 **You're active in the community!**\n\nYou have **" + (playtimeMin / 60).toFixed(1) + "h** of playtime and **" + msgCount + " Discord messages** — that's awesome!\n\nUse `/communityhelper` and click **Opt In** to be recognized as a **Community Helper** with a special role and shirt.\n\nOnce recognized, you only need **" + (keepPlaytime / 60).toFixed(1) + "h" + (booster ? "*" : "") + "** and **" + keepMsgs + " messages** per month to stay on the list.");
              }
            } catch (_) {}
            db.prepare("INSERT OR IGNORE INTO ch_notified (discord_id) VALUES (?)").run(link.discord_id);
          }
        } catch (_) {}
      }
    } catch (_) {}
  }, 30 * 60 * 1000);
}

// Don't die on unhandled promise rejections (Discord timeouts, etc.)
process.on("unhandledRejection", (reason, promise) => {
  console.error("[uncaught] unhandled rejection:", reason?.message || reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaught] exception:", err.message);
  if (err.code === "EADDRINUSE") process.exit(1);
});

startDiscordGateway();
