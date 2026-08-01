const express = require("express");
const router = express.Router();
const wsserver = require("../lib/wsserver");

router.post("/CCU", (req, res) => {
  try {
    return res.status(200).json({ ccount: wsserver.ccu(), errorMessage: null });
  } catch (err) {
    console.error("[mod/ccu] error:", err.message);
    return res.status(500).json({ ccount: 0, errorMessage: "Error" });
  }
});

module.exports = router;
