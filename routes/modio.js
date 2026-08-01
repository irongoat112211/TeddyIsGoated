const express = require("express");
const router = express.Router();
const { sanitizestr } = require("../lib/validation");

router.post("/AssociatePlayFabAndModIO", (req, res) => {
  try {
    const body = req.body || {};
    const mothershipplayerid = sanitizestr(body.MothershipPlayerId, 256);
    const modioid = sanitizestr(body.ModIOId, 128);

    if (!mothershipplayerid) {
      return res.status(400).json({ Results: [] });
    }

    return res.status(200).json({
      Results: [
        {
          MothershipPlayerId: mothershipplayerid,
          AssociationId: modioid || "modio-assoc",
          ExternalServiceName: "mod.io",
          ExternalServiceUserId: modioid || "",
          ExternalServiceOrgScopedId: "",
          ExternalServiceUserName: "",
          TitleId: "",
          EnvId: "",
        },
      ],
    });
  } catch (err) {
    console.error("[modio/associate] error:", err.message);
    return res.status(500).json({ Results: [] });
  }
});

module.exports = router;
