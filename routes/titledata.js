const express = require("express");
const router = express.Router();
const playfab = require("../lib/playfab");

router.all("/TitleData", async (req, res) => {
  try {
    const result = await playfab.gettitledata();
    if (result.status === 200 && result.data && result.data.data) {
      return res.status(200).json(result.data.data.Data || {});
    }
    return res.status(result.status || 500).json({});
  } catch (err) {
    console.error("[titledata] error:", err.message);
    return res.status(500).json({});
  }
});

module.exports = router;
