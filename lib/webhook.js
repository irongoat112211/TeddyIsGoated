const config = require("./config");
const https = require("https");
const { URL } = require("url");

const webhooks = {
  login: config.discord_login || "",
  rooms: config.discord_rooms || "",
  ghostreactor: config.discord_ghostreactor || "",
  purchases: config.discord_purchases || "",
  reports: config.discord_reports || config.discord_misc || "",
  misc: config.discord_misc || "",
  dearlemming: config.discord_dearlemming || "",
};

function send(channel, embed) {
  const url = webhooks[channel] || webhooks.misc;
  if (!url) return;
  try {
    const parsed = new URL(url);
    const body = JSON.stringify({
      embeds: [{
        ...embed,
        color: embed.color || 3618621,
        timestamp: embed.timestamp || new Date().toISOString(),
        footer: embed.footer || { text: "Project RS • Mothership" },
      }],
    });
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      port: 443,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        if (res.statusCode !== 204) console.log("[webhook] failed:", channel, res.statusCode, d.slice(0, 200));
      });
    });
    req.on("error", () => {});
    req.setTimeout(8000, () => req.destroy());
    req.write(body);
    req.end();
  } catch {}
}

function login(playFabId, platform) {
  let pfName = "";
  let oculusId = "";
  let oculusName = "";
  let mothershipId = "";
  try {
    const db = require("./database").db;
    const player = db.prepare("SELECT displayname, oculusid FROM players WHERE playfabid = ?").get(playFabId);
    if (player) {
      pfName = player.displayname || "";
      oculusId = player.oculusid || "";
      if (oculusId) {
        const profile = db.prepare("SELECT username FROM oculus_profiles WHERE userid = ?").get(oculusId);
        if (profile) oculusName = profile.username || "";
        const ms = db.prepare("SELECT mothershipid FROM mothershipplayers WHERE userid = ?").get(oculusId);
        if (ms) mothershipId = ms.mothershipid || "";
      }
    }
  } catch (_) {}
  send("login", {
    color: 5763719,
    description: "## Player Login\n**↓ Details ↓**\n```[PlayFab ID] : " + playFabId + "\n[PlayFab Name] : " + (pfName || "Unknown") + "\n[Oculus ID] : " + (oculusId || "N/A") + "\n[Oculus Name] : " + (oculusName || "N/A") + "\n[Mothership ID] : " + (mothershipId || "N/A") + "\n[Platform] : " + (platform || "Unknown") + "\n```",
  });
}

function roomEvent(type, gameId, region, nickname, playfabId) {
  let displayName = nickname;
  if (!displayName || displayName === "Unknown") {
    try {
      const db = require("./database").db;
      const row = db.prepare("SELECT displayname FROM players WHERE playfabid = ?").get(playfabId);
      if (row && row.displayname) displayName = row.displayname;
      if (!displayName) {
        const nick = db.prepare("SELECT nickname FROM friendpresence WHERE playfabid = ?").get(playfabId);
        if (nick && nick.nickname) displayName = nick.nickname;
      }
    } catch (_) {}
  }
  if (!displayName) displayName = "Unknown";

  const colors = { "Room Created": 5763719, "Room Joined": 3447003, "Room Left": 15158332, "Room Closed": 12370112 };
  const emojis = { "Room Created": "🎉", "Room Joined": "📥", "Room Left": "📤", "Room Closed": "🔒" };
  send("rooms", {
    color: colors[type] || 3618621,
    description: "## " + (emojis[type] || "") + " " + type + "\n**↓ Room Event ↓**\n```[Player] : " + displayName + "\n[Player ID] : " + playfabId + "\n[Region] : " + (region || "?") + "\n[Room] : " + gameId + "\n```",
  });
}

function playerReport(reporterId, reporterName, reportedId, reportedName, reason, roomCode, time) {
  send("reports", {
    color: 16711680,
    description: "## --------------USER REPORTED--------------\n**↓ Details Of The Reporter ↓**\n```[UserId] : " + reporterId + "\n[Reporter Name] : " + reporterName + "\n```\n**↓ Details Of The Reported Player ↓**\n```[UserId] : " + reportedId + "\n[USERNAME] : " + reportedName + "\n```\n**↓ Report Info ↓**\n```Room Code : " + (roomCode || "?") + "\nReport Reason : " + reason + "\nReport Happend At : " + (time || new Date().toLocaleString("en-US", { timeZone: "UTC" })) + "\n```",
  });
}

function ghostGameEnd(mothershipId, reason, coresBalance, coresCollected, gatesUnlocked, died, revives, playMin) {
  send("ghostreactor", {
    color: reason === "complete" ? 5763719 : 15158332,
    description: "## 🎮 Ghost Game Ended\n**↓ Game Details ↓**\n```[Player] : " + mothershipId + "\n[Reason] : " + (reason || "?") + "\n[Cores Balance] : " + (coresBalance || 0) + "\n[Cores Collected] : " + (coresCollected || 0) + "\n[Gates Unlocked] : " + (gatesUnlocked || 0) + "\n[Deaths] : " + (died || 0) + "\n[Revives] : " + (revives || 0) + "\n[Duration] : " + (playMin || 0) + " min\n```",
  });
}

function grShift(mid, shiftId, depth, cores, players) {
  send("ghostreactor", {
    color: 3447003,
    description: "## ⚡ Shift Started\n**↓ Shift ↓**\n```[Player] : " + mid + "\n[Shift ID] : " + shiftId + "\n[Depth] : " + (depth || 0) + "\n[Cores] : " + (cores || 0) + "\n[Players] : " + (players || 0) + "\n```",
  });
}

function grShiftEnd(mid, shiftId, credits) {
  send("ghostreactor", {
    color: 15844367,
    description: "## ✅ Shift Ended\n**↓ Shift ↓**\n```[Player] : " + mid + "\n[Shift ID] : " + shiftId + "\n[Credits] : " + (credits || 0) + "\n```",
  });
}

function grOverdrive(mid) {
  send("ghostreactor", {
    color: 10181046,
    description: "## 🔋 Overdrive Purchased\n**↓ Details ↓**\n```[Player] : " + mid + "\n```",
  });
}

function purchase(playfabId, item, cost) {
  send("purchases", {
    color: 15844367,
    description: "## 🛒 Purchase\n**↓ Purchase ↓**\n```[Player] : " + playfabId + "\n[Item] : " + item + "\n[Cost] : " + cost + "\n```",
  });
}

function error(endpoint, msg) {
  send("misc", {
    color: 15158332,
    description: "## ❌ Server Error\n**↓ Error ↓**\n```[Endpoint] : " + endpoint + "\n[Message] : " + (msg || "").slice(0, 200) + "\n```",
  });
}

function dearLemming(mothershipId, displayName, message) {
  send("dearlemming", {
    color: 3447003,
    description: "## 📬 Dear Lemming\n**↓ Message ↓**\n```[Player] : " + (displayName || mothershipId.slice(0, 12)) + "\n[Message] : " + message.slice(0, 500) + "\n```",
  });
}

module.exports = { send, login, roomEvent, playerReport, ghostGameEnd, grShift, grShiftEnd, grOverdrive, purchase, error, dearLemming };
