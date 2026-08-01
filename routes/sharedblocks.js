const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const { db, genmapid } = require("../lib/database");
const { sanitizestr } = require("../lib/validation");

const logDir = path.join(__dirname, "..", "logs");
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

// Wrap route handlers to log full req/res
function wrap(name, handler) {
  return (req, res) => {
    const start = Date.now();
    const date = new Date().toISOString().slice(0, 10);
    const lf = path.join(logDir, `sharedblocks-${date}.log`);
    const ts = new Date().toISOString();

    // Patch res to capture
    let resBody = null;
    const origJson = res.json.bind(res);
    const origSend = res.send.bind(res);
    const origEnd = res.end.bind(res);
    res.json = function (body) { resBody = body; return origJson(body); };
    res.send = function (body) { if (resBody === null) resBody = body; return origSend(body); };
    res.end = function (chunk) {
      const elapsed = Date.now() - start;
      const entry = [
        `=== ${name} [${ts}] ===`,
        `--- REQUEST ---`,
        `${req.method} ${req.originalUrl}`,
        `IP: ${req.ip}`,
        `Headers: ${JSON.stringify(req.headers, null, 2)}`,
        `Body: ${JSON.stringify(req.body, null, 2)}`.slice(0, 5000),
        `--- RESPONSE (${elapsed}ms) ---`,
        `Status: ${res.statusCode}`,
        `Headers: ${JSON.stringify(res.getHeaders(), null, 2)}`,
        `Body: ${typeof resBody === "string" ? resBody.slice(0, 2000) : JSON.stringify(resBody, null, 2).slice(0, 2000)}`,
        `========================================\n`,
      ].join("\n");
      fs.appendFileSync(lf, entry, "utf8");
      return origEnd(chunk);
    };

    handler(req, res);
  };
}

router.post("/MapVote", wrap("MapVote", (req, res) => {
  try {
    const body = req.body || {};
    const mothershipid = sanitizestr(body.mothershipId || "", 256);
    const mapid = sanitizestr(body.mapId || "", 32);
    const vote = parseInt(body.vote, 10) || 0;

    if (!mothershipid || !mapid) {
      return res.status(400).send("Missing fields");
    }

    const existing = db.prepare(
      "SELECT id FROM mapvotes WHERE mothershipid = ? AND mapid = ?"
    ).get(mothershipid, mapid);

    if (existing) {
      db.prepare("UPDATE mapvotes SET vote = ? WHERE mothershipid = ? AND mapid = ?").run(vote, mothershipid, mapid);
    } else {
      db.prepare("INSERT INTO mapvotes (mothershipid, mapid, vote) VALUES (?, ?, ?)").run(mothershipid, mapid, vote);
    }

    const countrow = db.prepare("SELECT COALESCE(SUM(vote), 0) AS total FROM mapvotes WHERE mapid = ?").get(mapid);
    db.prepare("UPDATE sharedmaps SET votecount = ? WHERE mapid = ?").run(countrow.total, mapid);

    return res.status(200).send("OK");
  } catch (err) {
    return res.status(500).send("Error");
  }
}));

router.post("/Publish", wrap("Publish", (req, res) => {
  try {
    const body = req.body || {};
    const mothershipid = sanitizestr(body.mothershipId || "", 256);
    const metadatakey = sanitizestr(body.userdataMetadataKey || "", 256);
    const nickname = sanitizestr(body.playerNickname || "", 64);

    if (!mothershipid || !metadatakey) {
      return res.status(400).send("Missing fields");
    }

    const mapid = genmapid();

    // Lookup the saved userdata for the actual build data
    const udRow = db.prepare("SELECT datavalue FROM mothershipuserdata WHERE mothershipid = ? AND keyname = ?").get(mothershipid, metadatakey);
    const mapdata = udRow ? (udRow.datavalue || "") : "";

    db.prepare(
      "INSERT INTO sharedmaps (mapid, mothershipid, userdatametadatakey, nickname, mapdata, isactive) VALUES (?, ?, ?, ?, ?, 1)"
    ).run(mapid, mothershipid, metadatakey, nickname || "", mapdata);

    return res.status(200).send(mapid);
  } catch (err) {
    return res.status(500).send("Error");
  }
}));

router.post("/GetMapData", wrap("GetMapData", (req, res) => {
  try {
    const body = req.body || {};
    const mapid = sanitizestr(body.mapId || "", 32);

    if (!mapid) {
      return res.status(400).send("");
    }

    const row = db.prepare("SELECT mapdata FROM sharedmaps WHERE mapid = ?").get(mapid);
    return res.status(200).send(row ? (row.mapdata || "") : "");
  } catch (err) {
    return res.status(500).send("");
  }
}));

// Decoded map data endpoint (server-side decompression)
router.post("/GetMapDataDecoded", (req, res) => {
  try {
    const body = req.body || {};
    const mapid = sanitizestr(body.mapId || "", 32);
    if (!mapid) return res.status(400).json({ error: "Missing mapId" });

    const row = db.prepare("SELECT mapdata FROM sharedmaps WHERE mapid = ?").get(mapid);
    if (!row || !row.mapdata) return res.json(null);

    const raw = row.mapdata;
    const zlib = require("zlib");
    try {
      const buf = Buffer.from(raw, "base64");
      if (buf[0] === 0x1f && buf[1] === 0x8b) {
        const decompressed = zlib.gunzipSync(buf);
        const json = JSON.parse(decompressed.toString("utf8"));
        return res.json(json);
      }
    } catch (e) {}
    try { return res.json(JSON.parse(raw)); } catch (_) {}
    try { return res.json(JSON.parse(Buffer.from(raw, "base64").toString("utf8"))); } catch (_) {}
    return res.json(null);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post("/GetMaps", wrap("GetMaps", (req, res) => {
  try {
    const body = req.body || {};
    const page = parseInt(body.page, 10) || 0;
    const pagesize = Math.min(parseInt(body.pageSize, 10) || 20, 100);
    const sort = sanitizestr(body.sort || "", 32) || "recent";
    const showinactive = body.ShowInactive === true;

    let query = "SELECT * FROM sharedmaps";
    const params = [];

    if (!showinactive) {
      query += " WHERE isactive = 1";
    }

    if (sort === "Top") query += " ORDER BY votecount DESC";
    else if (sort === "NewlyCreated") query += " ORDER BY createdat DESC";
    else if (sort === "RecentlyUpdated") query += " ORDER BY updatedat DESC";
    else query += " ORDER BY createdat DESC";

    query += " LIMIT ? OFFSET ?";
    params.push(pagesize, page * pagesize);

    const rows = db.prepare(query).all(...params);

    const results = rows.map((row) => ({
      mapId: row.mapid,
      mothershipId: row.mothershipid,
      userDataMetadataKey: row.userdatametadatakey,
      nickname: row.nickname,
      createdTime: row.createdat,
      updatedTime: row.updatedat,
      voteCount: row.votecount,
      isActive: row.isactive === 1,
    }));

    return res.status(200).json(results);
  } catch (err) {
    return res.status(500).json([]);
  }
}));

router.post("/UpdateMapActive", wrap("UpdateMapActive", (req, res) => {
  try {
    const body = req.body || {};
    const mothershipid = sanitizestr(body.mothershipId || "", 256);
    const metadatakey = sanitizestr(body.userdataMetadataKey || "", 256);
    const setactive = body.setActive === true ? 1 : 0;

    if (!mothershipid || !metadatakey) {
      return res.status(400).send("Missing fields");
    }

    db.prepare(
      "UPDATE sharedmaps SET isactive = ?, updatedat = datetime('now') WHERE mothershipid = ? AND userdatametadatakey = ?"
    ).run(setactive, mothershipid, metadatakey);

    return res.status(200).send("OK");
  } catch (err) {
    return res.status(500).send("Error");
  }
}));

module.exports = router;
