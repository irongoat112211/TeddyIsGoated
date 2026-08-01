const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const playfab = require("../lib/playfab");
const { db } = require("../lib/database");
const { sanitizestr } = require("../lib/validation");

const logDir = path.join(__dirname, "..", "logs");
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

function logPhoton(entry) {
  const date = new Date().toISOString().slice(0, 10);
  const logFile = path.join(logDir, `photon-${date}.log`);
  fs.appendFileSync(logFile, entry + "\n", "utf8");
}

router.post("/photon", async (req, res) => {
  const start = Date.now();
  let statusCode = 500;
  let resBody = null;

  try {
    const body = req.body || {};
    const ticket = sanitizestr(body.Ticket, 512);
    const platform = sanitizestr(body.Platform, 16);

    if (!ticket) {
      statusCode = 403;
      resBody = { resultCode: 2, message: "Invalid token", userId: null, nickname: null };
      return res.status(403).json(resBody);
    }

    const playfabid = ticket.split("-")[0];

    if (!playfabid || playfabid.length !== 16) {
      statusCode = 403;
      resBody = { resultCode: 2, message: "Invalid token", userId: null, nickname: null };
      return res.status(403).json(resBody);
    }

    let nickname = playfabid;
    try {
      const result = await playfab.getplayerprofile(playfabid);
      if (result.status === 200 && result.data && result.data.data) {
        const profile = result.data.data.PlayerProfile;
        if (profile && profile.DisplayName) {
          nickname = profile.DisplayName;
        }
      }
    } catch {
      try {
        const r = await playfab.getuseraccountinfo(playfabid);
        if (r.status === 200 && r.data && r.data.data && r.data.data.UserInfo && r.data.data.UserInfo.UserAccountInfo) {
          nickname = r.data.data.UserInfo.UserAccountInfo.Username || playfabid;
        }
      } catch {}
    }

    statusCode = 200;
    resBody = { resultCode: 1, message: "Authenticated", userId: playfabid, nickname: nickname };
    return res.status(200).json(resBody);
  } catch (err) {
    console.error("[photon] error:", err.message);
    statusCode = 500;
    resBody = { resultCode: 0, message: "Something went wrong" };
    return res.status(500).json(resBody);
  } finally {
    const elapsed = Date.now() - start;
    logPhoton(JSON.stringify({
      ts: new Date().toISOString(),
      ip: req.ip || req.connection?.remoteAddress,
      method: req.method,
      url: req.originalUrl,
      body: req.body,
      status: statusCode,
      response: resBody,
      ms: elapsed,
    }));
  }
});

module.exports = router;
