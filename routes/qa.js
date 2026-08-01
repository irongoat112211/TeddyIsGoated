const express = require("express");
const path = require("path");
const { db } = require("../lib/database");

const router = express.Router();

const RATE_LIMIT_MS = 30000;
const rateLimit = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of rateLimit) {
    if (now - ts > RATE_LIMIT_MS) rateLimit.delete(key);
  }
}, 60000);

function checkRateLimit(ip) {
  const now = Date.now();
  const last = rateLimit.get(ip);
  if (last && now - last < RATE_LIMIT_MS) return false;
  rateLimit.set(ip, now);
  return true;
}

router.get("/qa/questions", (req, res) => {
  const pg = Math.max(1, parseInt(req.query.page) || 1);
  const lim = Math.min(parseInt(req.query.limit) || 20, 50);
  const off = (pg - 1) * lim;
  const statusFilter = req.query.status || "";
  let where = "";
  if (statusFilter === "answered") {
    where = " WHERE status = 'answered'";
  } else if (statusFilter === "open") {
    where = " WHERE status IN ('pending','answered')";
  }
  const total = db.prepare("SELECT COUNT(*) as c FROM dear_lemmings" + where).get();
  const rows = db.prepare(`
    SELECT id, message_text as question_text, display_name as author_name, status,
           answer_text as latest_answer, answered_by, answered_at,
           CASE WHEN answer_text != '' THEN 1 ELSE 0 END as answer_count,
           createdat
    FROM dear_lemmings${where} ORDER BY createdat DESC LIMIT ? OFFSET ?
  `).all(lim, off);
  res.json({ questions: rows, total: total.c, page: pg, limit: lim });
});

router.get("/qa/questions/:id", (req, res) => {
  const q = db.prepare("SELECT * FROM dear_lemmings WHERE id = ?").get(req.params.id);
  if (!q) return res.status(404).json({ error: "Question not found" });
  res.json({
    question: {
      id: q.id,
      question_text: q.message_text,
      author_name: q.display_name,
      status: q.status,
      createdat: q.createdat,
    },
    answers: q.answer_text ? [{
      answer_text: q.answer_text,
      answered_by: q.answered_by,
      createdat: q.answered_at,
    }] : [],
  });
});

router.post("/qa/questions", (req, res) => {
  const clientIp = req.ip || req.connection?.remoteAddress || "unknown";
  if (!checkRateLimit(clientIp)) {
    return res.status(429).json({ error: "Please wait 30 seconds before submitting another question" });
  }
  const text = (req.body.question || "").trim();
  if (!text || text.length < 5) return res.status(400).json({ error: "Question must be at least 5 characters" });
  if (text.length > 500) return res.status(400).json({ error: "Question must be under 500 characters" });
  const name = (req.body.author || "").trim().slice(0, 30) || "Anonymous";
  try {
    const r = db.prepare("INSERT INTO dear_lemmings (mothershipid, message_text, display_name) VALUES (?,?,?)").run("web:" + clientIp, text, name);
    res.status(201).json({ id: r.lastInsertRowid, message: "Question submitted!" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/qa/search", (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.json({ results: [] });
  const rows = db.prepare(`
    SELECT id, message_text as question_text, display_name as author_name, status,
           answer_text as latest_answer,
           CASE WHEN answer_text != '' THEN 1 ELSE 0 END as answer_count,
           createdat
    FROM dear_lemmings WHERE message_text LIKE ? ORDER BY createdat DESC LIMIT 20
  `).all("%" + q + "%");
  res.json({ results: rows });
});

module.exports = router;
