const express = require("express");
const router = express.Router();
const { db } = require("../lib/database");
const { votelimiter } = require("../middleware/ratelimit");

router.post("/FetchPoll", (req, res) => {
  try {
    const now = new Date().toISOString();

    function fmtDate(d) {
      return new Date(d).toISOString().replace(/\.\d{3}Z$/, "");
    }
    const rows = db.prepare("SELECT * FROM polls ORDER BY created_at DESC LIMIT 25").all();

    const results = rows.map((row) => {
      const options = JSON.parse(row.options_json || "[]");
      const endTime = row.expires_at;

      const isActive = !endTime || endTime > now;

      const voteCounts = options.map((_, i) => {
        return (db.prepare("SELECT COUNT(*) as c FROM poll_votes WHERE poll_id = ? AND option_index = ? AND is_prediction = 0").get(row.id, i) || {}).c || 0;
      });
      const predCounts = options.map((_, i) => {
        return (db.prepare("SELECT COUNT(*) as c FROM poll_votes WHERE poll_id = ? AND option_index = ? AND is_prediction = 1").get(row.id, i) || {}).c || 0;
      });

      return {
        pollId: row.id,
        question: row.question,
        voteOptions: options,
        voteCount: isActive ? [] : voteCounts,
        predictionCount: isActive ? [] : predCounts,
        startTime: fmtDate(row.created_at),
        endTime: endTime ? fmtDate(endTime) : fmtDate(Date.now() + 365 * 24 * 60 * 60 * 1000),
        isActive,
      };
    });

    return res.status(200).json(results);
  } catch (err) {
    console.error("[voting/fetchpoll] error:", err.message);
    return res.status(500).json([]);
  }
});

router.post("/Vote", votelimiter, (req, res) => {
  try {
    const body = req.body || {};
    const pollId = parseInt(body.PollId, 10);
    const playfabid = (body.PlayFabId || "").toString().trim();
    const optionIndex = parseInt(body.OptionIndex, 10);
    const isPrediction = body.IsPrediction === true;
    const oculusid = (body.OculusId || "").toString().replace(/^OCULUS/, "").trim();

    if (isNaN(pollId) || !playfabid || isNaN(optionIndex)) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const poll = db.prepare("SELECT * FROM polls WHERE id = ?").get(pollId);
    if (!poll) {
      return res.status(404).json({ error: "Poll not found" });
    }

    const options = JSON.parse(poll.options_json || "[]");
    if (optionIndex < 0 || optionIndex >= options.length) {
      return res.status(400).json({ error: "Invalid option" });
    }

    if (isPrediction) {
      const existingVote = db.prepare("SELECT id FROM poll_votes WHERE poll_id = ? AND playfabid = ? AND is_prediction = 0").get(pollId, playfabid);
      if (!existingVote) {
        return res.status(400).json({ error: "Must vote first" });
      }
      const existingPred = db.prepare("SELECT id FROM poll_votes WHERE poll_id = ? AND playfabid = ? AND is_prediction = 1").get(pollId, playfabid);
      if (existingPred) {
        return res.status(429).json({ error: "Already predicted" });
      }
      db.prepare("INSERT INTO poll_votes (poll_id, discord_id, playfabid, oculusid, option_index, is_prediction) VALUES (?, ?, ?, ?, ?, 1)").run(pollId, playfabid, playfabid, oculusid, optionIndex);
    } else {
      const existing = db.prepare("SELECT id FROM poll_votes WHERE poll_id = ? AND playfabid = ? AND is_prediction = 0").get(pollId, playfabid);
      if (existing) {
        return res.status(429).json({ error: "Already voted" });
      }
      db.prepare("INSERT INTO poll_votes (poll_id, discord_id, playfabid, oculusid, option_index, is_prediction) VALUES (?, ?, ?, ?, ?, 0)").run(pollId, playfabid, playfabid, oculusid, optionIndex);
    }

    const voteCounts = options.map((_, i) => {
      return (db.prepare("SELECT COUNT(*) as c FROM poll_votes WHERE poll_id = ? AND option_index = ? AND is_prediction = 0").get(pollId, i) || {}).c || 0;
    });
    const predCounts = options.map((_, i) => {
      return (db.prepare("SELECT COUNT(*) as c FROM poll_votes WHERE poll_id = ? AND option_index = ? AND is_prediction = 1").get(pollId, i) || {}).c || 0;
    });

    return res.status(201).json({
      pollId,
      titleId: body.TitleId || "",
      voteOptions: options,
      voteCount: voteCounts.some((v) => v > 0) ? voteCounts : [],
      predictionCount: predCounts.some((v) => v > 0) ? predCounts : [],
    });
  } catch (err) {
    console.error("[voting/vote] error:", err.message);
    return res.status(500).json({ error: "Internal error" });
  }
});

module.exports = router;
