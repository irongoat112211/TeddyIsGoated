const express = require("express");
const router = express.Router();
const { sanitizestr } = require("../lib/validation");

router.get("/GetPlayerData", (req, res) => {
  try {
    return res.status(200).json({
      Status: "active",
      Session: {
        AgeStatus: "adult",
        AgeCategory: "adult",
        Jurisdiction: "US",
        IsMinor: false,
        IsConsentRequired: false,
      },
      DefaultSession: {
        AgeStatus: "adult",
        AgeCategory: "adult",
        Jurisdiction: "US",
        IsMinor: false,
        IsConsentRequired: false,
      },
      Permissions: ["social", "ugc", "communication"],
      HasConfirmedSetup: true,
    });
  } catch (err) {
    console.error("[kid/getplayerdata] error:", err.message);
    return res.status(500).json({ error: "Internal error" });
  }
});

router.post("/VerifyAge", (req, res) => {
  try {
    return res.status(200).json({
      Status: "active",
      Session: {
        AgeStatus: "adult",
        AgeCategory: "adult",
        Jurisdiction: "US",
        IsMinor: false,
        IsConsentRequired: false,
      },
      DefaultSession: {
        AgeStatus: "adult",
        AgeCategory: "adult",
        Jurisdiction: "US",
        IsMinor: false,
        IsConsentRequired: false,
      },
    });
  } catch (err) {
    console.error("[kid/verifyage] error:", err.message);
    return res.status(500).json({ error: "Internal error" });
  }
});

router.post("/UpgradeSession", (req, res) => {
  try {
    return res.status(200).json({
      status: "active",
      session: {
        AgeStatus: "adult",
        AgeCategory: "adult",
        Jurisdiction: "US",
        IsMinor: false,
        IsConsentRequired: false,
      },
    });
  } catch (err) {
    console.error("[kid/upgradesession] error:", err.message);
    return res.status(500).json({ error: "Internal error" });
  }
});

router.post("/SendChallengeEmail", (req, res) => {
  try {
    return res.status(200).send("OK");
  } catch (err) {
    console.error("[kid/sendchallengeemail] error:", err.message);
    return res.status(500).send("Error");
  }
});

router.post("/AttemptAgeUpdate", (req, res) => {
  try {
    return res.status(200).json({
      Status: "active",
    });
  } catch (err) {
    console.error("[kid/attemptageupdate] error:", err.message);
    return res.status(500).json({ error: "Internal error" });
  }
});

router.post("/AppealAge", (req, res) => {
  try {
    return res.status(200).send("OK");
  } catch (err) {
    console.error("[kid/appealage] error:", err.message);
    return res.status(500).send("Error");
  }
});

router.post("/OptIn", (req, res) => {
  try {
    return res.status(200).send("OK");
  } catch (err) {
    console.error("[kid/optin] error:", err.message);
    return res.status(500).send("Error");
  }
});

router.get("/GetRequirements", (req, res) => {
  try {
    return res.status(200).json({
      AgeGateRequirements: {
        PlatformMinimumAge: 13,
        DigitalConsentAge: 13,
        CivilAge: 18,
      },
    });
  } catch (err) {
    console.error("[kid/getrequirements] error:", err.message);
    return res.status(500).json({ error: "Internal error" });
  }
});

router.post("/SetConfirmedStatus", (req, res) => {
  try {
    return res.status(200).send("OK");
  } catch (err) {
    console.error("[kid/setconfirmedstatus] error:", err.message);
    return res.status(500).send("Error");
  }
});

router.post("/SetOptInPermissions", (req, res) => {
  try {
    return res.status(200).send("OK");
  } catch (err) {
    console.error("[kid/setoptinpermissions] error:", err.message);
    return res.status(500).send("Error");
  }
});

module.exports = router;
