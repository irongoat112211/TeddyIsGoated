const express = require("express");
const router = express.Router();
const { db } = require("../lib/database");
const { sanitizestr } = require("../lib/validation");

router.post("/GetQuestStatus", (req, res) => {
  try {
    const body = req.body || {};
    const playfabid = sanitizestr(body.PlayFabId, 16);

    if (!playfabid) {
      return res.status(400).json({ error: "Missing PlayFabId" });
    }

    let row = db.prepare("SELECT * FROM queststatus WHERE playfabid = ?").get(playfabid);
    if (!row) {
      db.prepare("INSERT INTO queststatus (playfabid) VALUES (?)").run(playfabid);
      row = { dailypoints: "{}", weeklypoints: "{}", userpointstotal: 0 };
    }

    return res.status(200).json({
      result: {
        dailyPoints: JSON.parse(row.dailypoints || "{}"),
        weeklyPoints: JSON.parse(row.weeklypoints || "{}"),
        userPointsTotal: row.userpointstotal || 0,
      },
    });
  } catch (err) {
    console.error("[quests/getstatus] error:", err.message);
    return res.status(500).json({ error: "Internal error" });
  }
});

router.post("/SetQuestComplete", (req, res) => {
  try {
    const body = req.body || {};
    const playfabid = sanitizestr(body.PlayFabId, 16);
    const questid = parseInt(body.QuestId, 10);

    if (!playfabid || isNaN(questid)) {
      return res.status(400).json({ error: "Missing fields" });
    }

    let row = db.prepare("SELECT * FROM queststatus WHERE playfabid = ?").get(playfabid);
    if (!row) {
      db.prepare("INSERT INTO queststatus (playfabid) VALUES (?)").run(playfabid);
      row = { dailypoints: "{}", weeklypoints: "{}", userpointstotal: 0 };
    }

    const daily = JSON.parse(row.dailypoints || "{}");
    const weekly = JSON.parse(row.weeklypoints || "{}");
    let total = row.userpointstotal || 0;

    let weeklysum = 0;
    for (const v of Object.values(daily)) weeklysum += v;
    for (const v of Object.values(weekly)) weeklysum += v;

    const weeklycap = 25;
    if (weeklysum >= weeklycap) {
      return res.status(403).json({ error: "Weekly cap reached" });
    }

    const questkey = String(questid);
    const points = 1;
    daily[questkey] = (daily[questkey] || 0) + points;
    total += points;

    db.prepare(
      "UPDATE queststatus SET dailypoints = ?, weeklypoints = ?, userpointstotal = ?, updatedat = datetime('now') WHERE playfabid = ?"
    ).run(JSON.stringify(daily), JSON.stringify(weekly), total, playfabid);

    return res.status(200).json({
      result: {
        dailyPoints: daily,
        weeklyPoints: weekly,
        userPointsTotal: total,
      },
    });
  } catch (err) {
    console.error("[quests/setcomplete] error:", err.message);
    return res.status(500).json({ error: "Internal error" });
  }
});

module.exports = router;
