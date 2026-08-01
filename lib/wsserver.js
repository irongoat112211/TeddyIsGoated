const { WebSocketServer } = require("ws");
const { db } = require("./database");
const jwt = require("jsonwebtoken");
const { publickey } = require("./mothership-keys");
const fs = require("fs");
const path = require("path");

const servers = [];
const playerSockets = new Map();
const sessionStarts = new Map();
let pingInterval = null;

// ── Logging ──
const LOG_DIR = path.join(__dirname, "..", "logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function getLogFile() {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(LOG_DIR, `ws_${date}.log`);
}

function wsLog(line) {
  const ts = new Date().toISOString();
  const entry = `[${ts}] ${line}`;
  console.log(`[ws] ${line}`);
  try { fs.appendFileSync(getLogFile(), entry + "\n"); } catch {}
}

// ── Discord webhook for WS traffic ──
let WS_WEBHOOK = ""; // set via setWebhook() from server.js to log WS messages to Discord
let webhookQueue = [];
let webhookTimer = null;

function sendWebhook(lines) {
  if (!WS_WEBHOOK) return;
  const https = require("https");
  const url = new URL(WS_WEBHOOK);
  const body = JSON.stringify({ content: lines.slice(0, 1900) });
  const req = https.request({ hostname: url.hostname, path: url.pathname, method: "POST", headers: { "Content-Type": "application/json" } });
  req.write(body);
  req.end();
}

function queueWebhook(line) {
  if (!WS_WEBHOOK) return;
  webhookQueue.push(line);
  if (!webhookTimer) {
    webhookTimer = setTimeout(() => {
      const batch = webhookQueue.splice(0, 10);
      webhookTimer = null;
      sendWebhook(batch);
    }, 2000);
  }
}

// ── WebSocket logic ──

function setupSocket(socket, req) {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  let playerId = "";
  let decodedToken = null;

  const token = req.headers["x-mothership-token"];
  if (token) {
    try {
      decodedToken = jwt.verify(token, publickey, { algorithms: ["ES256"] });
      playerId = decodedToken.sub || "";
      if (playerId) {
        playerSockets.set(playerId, socket);
      }
    } catch {
      // invalid token
    }
  }

  wsLog(`client connected — ip=${ip} player=${playerId || "unknown"} ccu=${ccu()} token_sub=${playerId || "none"}`);
  if (decodedToken) {
    wsLog(`  JWT: sub=${decodedToken.sub} iss=${decodedToken.iss || "?"} exp=${decodedToken.exp || "?"}`);
  }

  if (playerId) {
    sessionStarts.set(playerId, Date.now());
  }

  socket.isalive = true;
  socket.on("pong", () => { socket.isalive = true; });

  socket.on("message", (data, isBinary) => {
    const playerLabel = playerId || "unknown";
    if (isBinary) {
      const hex = Buffer.from(data).toString("hex");
      wsLog(`← BINARY from player=${playerLabel} (${data.length} bytes): ${hex.slice(0, 300)}`);
      queueWebhook(`BINARY from ${playerLabel}: ${hex.slice(0, 200)}`);
    } else {
      const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
      wsLog(`← TEXT from player=${playerLabel}: ${text.slice(0, 1000)}`);
      queueWebhook(`TEXT from ${playerLabel}: ${text.slice(0, 500)}`);
    }
  });

  socket.on("close", () => {
    if (playerId) {
      playerSockets.delete(playerId);
      const start = sessionStarts.get(playerId);
      if (start) {
        sessionStarts.delete(playerId);
        const elapsedMin = (Date.now() - start) / 60000;
        if (elapsedMin >= 0.5) {
          try {
            const ms = db.prepare("SELECT userid FROM mothershipplayers WHERE mothershipid = ?").get(playerId);
            let playfabid = "";
            if (ms) {
              const pf = db.prepare("SELECT playfabid FROM players WHERE oculusid = ?").get(ms.userid);
              if (pf) playfabid = pf.playfabid;
            }
            if (playfabid) {
              const existing = db.prepare("SELECT minutes, last_updated FROM player_playtime WHERE playfabid = ?").get(playfabid);
              const now = new Date();
              if (existing) {
                const lastUpd = new Date(existing.last_updated);
                const daysSince = (now - lastUpd) / 86400000;
                if (daysSince >= 30) {
                  db.prepare("UPDATE player_playtime SET minutes = ?, last_updated = datetime('now') WHERE playfabid = ?").run(elapsedMin, playfabid);
                } else {
                  db.prepare("UPDATE player_playtime SET minutes = minutes + ?, last_updated = datetime('now') WHERE playfabid = ?").run(elapsedMin, playfabid);
                }
              } else {
                db.prepare("INSERT INTO player_playtime (playfabid, minutes, last_updated) VALUES (?, ?, datetime('now'))").run(playfabid, elapsedMin);
              }
            }
          } catch (_) {}
        }
      }
    }
    wsLog(`client disconnected — player=${playerId || "unknown"} ccu=${ccu()}`);
  });

  socket.on("error", (err) => {
    wsLog(`socket error — player=${playerId || "unknown"}: ${err.message}`);
  });

  const greet = JSON.stringify({ type: "connected" });
  wsLog(`→ greeting to player=${playerId || "unknown"}`);
  socket.send(greet);
}

function attachto(httpserver) {
  const wss = new WebSocketServer({ server: httpserver, path: "/prod-GT-ws-stage/" });

  wss.on("connection", setupSocket);

  if (!pingInterval) {
    pingInterval = setInterval(() => {
      for (const [id, s] of playerSockets) {
        if (!s.isalive) {
          wsLog(`ping timeout — terminating player=${id}`);
          s.terminate();
          continue;
        }
        s.isalive = false;
        s.ping();
      }
    }, 30_000);
  }

  servers.push(wss);
  wsLog("WebSocket server attached at /prod-GT-ws-stage/");
}

function sendNotification(playerId, title, body) {
  const socket = playerSockets.get(playerId);
  if (!socket || socket.readyState !== 1) {
    wsLog(`✗ sendNotification FAILED — player=${playerId} not connected`);
    return false;
  }
  const msg = JSON.stringify({ Title: title, Body: body, RecipientId: playerId });
  wsLog(`→ NOTIFICATION to player=${playerId}: ${msg}`);
  socket.send(msg);
  return true;
}

function ccu() {
  return playerSockets.size;
}

function setWebhook(url) {
  WS_WEBHOOK = url;
  wsLog(`Discord webhook logging ${url ? "enabled" : "disabled"}`);
}

module.exports = { attachto, ccu, sendNotification, playerSockets, setWebhook };
