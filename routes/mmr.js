const express = require("express");
const router = express.Router();
const { db, genuuid, ensurerankeddata } = require("../lib/database");
const { sanitizestr } = require("../lib/validation");

router.all("/GetTier", (req, res) => {
  try {
    const body = req.body || {};
    const playfabids = body.playfabIds || [];

    if (!Array.isArray(playfabids) || playfabids.length === 0) {
      return res.status(200).json([]);
    }

    const results = [];
    for (const pid of playfabids) {
      const safeid = sanitizestr(pid, 16);
      if (!safeid) continue;

      ensurerankeddata(safeid, "PC");
      ensurerankeddata(safeid, "Quest");

      const rows = db.prepare("SELECT * FROM rankeddata WHERE playfabid = ?").all(safeid);

      const platformdata = rows.map((r) => ({
        platform: r.platform,
        elo: r.elo,
        majorTier: r.majortier,
        minorTier: r.minortier,
        rankProgress: r.rankprogress,
      }));

      while (platformdata.length < 2) {
        platformdata.push({
          platform: platformdata.length === 0 ? "PC" : "Quest",
          elo: 1000.0,
          majorTier: 0,
          minorTier: 0,
          rankProgress: 0.0,
        });
      }

      results.push({
        playfabID: safeid,
        platformData: platformdata,
      });
    }

    return res.status(200).json(results);
  } catch (err) {
    console.error("[mmr/gettier] error:", err.message);
    return res.status(500).json([]);
  }
});

router.post("/CreateMatchId", (req, res) => {
  try {
    const body = req.body || {};
    const mothershipid = sanitizestr(body.mothershipId, 256);
    const platform = sanitizestr(body.platform, 16) || "PC";
    const matchid = genuuid();

    db.prepare(
      "INSERT INTO matchids (matchid, createdby, platform) VALUES (?, ?, ?)"
    ).run(matchid, mothershipid, platform);

    return res.status(200).send(matchid);
  } catch (err) {
    console.error("[mmr/creatematch] error:", err.message);
    return res.status(500).send("");
  }
});

router.post("/ValidateMatchJoin", (req, res) => {
  try {
    const body = req.body || {};
    const matchid = sanitizestr(body.matchId, 64);
    const mothershipid = sanitizestr(body.mothershipId, 256);

    if (!matchid) {
      return res.status(200).json({ validJoin: false });
    }

    const match = db.prepare("SELECT * FROM matchids WHERE matchid = ? AND isactive = 1").get(matchid);

    if (match) {
      try {
        db.prepare("INSERT OR IGNORE INTO matchparticipants (matchid, playfabid) VALUES (?, ?)").run(matchid, mothershipid);
      } catch {}
      return res.status(200).json({ validJoin: true });
    }

    return res.status(200).json({ validJoin: false });
  } catch (err) {
    console.error("[mmr/validatematch] error:", err.message);
    return res.status(500).json({ validJoin: false });
  }
});

router.post("/SubmitMatchScores", (req, res) => {
  try {
    const body = req.body || {};
    const matchid = sanitizestr(body.matchId, 64);
    const scores = body.playerScores || [];

    if (!matchid || !Array.isArray(scores)) {
      return res.status(400).send("Bad request");
    }

    const playercount = scores.length;
    if (playercount < 2) {
      return res.status(200).send("OK");
    }

    const sorted = [...scores].sort((a, b) => (b.gameScore || 0) - (a.gameScore || 0));

    for (let i = 0; i < sorted.length; i++) {
      const pid = sanitizestr(sorted[i].playfabId, 16);
      if (!pid) continue;

      ensurerankeddata(pid, "PC");
      ensurerankeddata(pid, "Quest");

      const placement = i / (playercount - 1);
      const elochange = (1 - placement) * 20 - 10;

      db.prepare(
        "UPDATE rankeddata SET elo = MAX(0, elo + ?) WHERE playfabid = ?"
      ).run(elochange, pid);

      const rows = db.prepare("SELECT * FROM rankeddata WHERE playfabid = ?").all(pid);
      for (const row of rows) {
        const elo = row.elo;
        let major = 0;
        let minor = 0;
        let progress = 0;

        if (elo >= 2000) { major = 5; minor = 0; progress = 1.0; }
        else if (elo >= 1600) { major = 4; minor = Math.floor((elo - 1600) / 133); progress = ((elo - 1600) % 133) / 133; }
        else if (elo >= 1200) { major = 3; minor = Math.floor((elo - 1200) / 133); progress = ((elo - 1200) % 133) / 133; }
        else if (elo >= 800) { major = 2; minor = Math.floor((elo - 800) / 133); progress = ((elo - 800) % 133) / 133; }
        else if (elo >= 400) { major = 1; minor = Math.floor((elo - 400) / 133); progress = ((elo - 400) % 133) / 133; }
        else { major = 0; minor = Math.floor(elo / 133); progress = (elo % 133) / 133; }

        db.prepare(
          "UPDATE rankeddata SET majortier = ?, minortier = ?, rankprogress = ? WHERE playfabid = ? AND platform = ?"
        ).run(major, Math.min(minor, 2), progress, pid, row.platform);
      }
    }

    db.prepare("UPDATE matchids SET isactive = 0 WHERE matchid = ?").run(matchid);

    return res.status(200).send("OK");
  } catch (err) {
    console.error("[mmr/submitscores] error:", err.message);
    return res.status(500).send("Error");
  }
});

router.post("/PingRoom", (req, res) => {
  try {
    const body = req.body || {};
    const matchid = sanitizestr(body.matchId, 64);

    if (matchid) {
      db.prepare("UPDATE matchids SET lastping = datetime('now') WHERE matchid = ?").run(matchid);
    }

    return res.status(200).send("OK");
  } catch (err) {
    console.error("[mmr/pingroom] error:", err.message);
    return res.status(500).send("Error");
  }
});

router.post("/UnlockCompetitiveQueue", (req, res) => {
  try {
    const body = req.body || {};
    const mothershipid = sanitizestr(body.mothershipId, 256);
    const platform = sanitizestr(body.platform, 16) || "PC";
    const unlocked = body.unlocked === true ? 1 : 0;

    if (mothershipid) {
      db.prepare(
        "INSERT OR REPLACE INTO competitiveunlocks (mothershipid, unlocked, platform) VALUES (?, ?, ?)"
      ).run(mothershipid, unlocked, platform);
    }

    return res.status(200).send("OK");
  } catch (err) {
    console.error("[mmr/unlockqueue] error:", err.message);
    return res.status(500).send("Error");
  }
});

module.exports = router;
