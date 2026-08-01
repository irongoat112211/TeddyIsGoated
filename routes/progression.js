const express = require("express");
const router = express.Router();
const {
  db,
  ensureshiftcredits,
  ensurejuicerstatus,
  ensuredockwrist,
  ensurereactorstats,
  ensurereactorinventory,
} = require("../lib/database");
const { sanitizestr } = require("../lib/validation");
const webhook = require("../lib/webhook");

function getmid(body) {
  return sanitizestr(body.MothershipId || body.mothershipId || "", 256);
}

router.post("/GetProgression", (req, res) => {
  try {
    const mid = getmid(req.body);
    const trackid = sanitizestr(req.body.TrackId, 128);
    if (!mid || !trackid) return res.status(400).send("0");

    const row = db.prepare("SELECT progress FROM progression WHERE mothershipid = ? AND trackid = ?").get(mid, trackid);
    return res.status(200).send(String(row ? row.progress : 0));
  } catch (err) {
    console.error("[prog/getprogression] error:", err.message);
    return res.status(500).send("0");
  }
});

router.post("/SetProgression", (req, res) => {
  try {
    const mid = getmid(req.body);
    const trackid = sanitizestr(req.body.TrackId, 128);
    const progress = parseInt(req.body.Progress, 10) || 0;
    if (!mid || !trackid) return res.status(400).json({ statusCode: 400, error: "Missing fields" });

    db.prepare(
      "INSERT OR REPLACE INTO progression (mothershipid, trackid, progress) VALUES (?, ?, ?)"
    ).run(mid, trackid, progress);

    return res.status(200).json({ trackId: trackid, progress: progress, statusCode: 200, error: null });
  } catch (err) {
    console.error("[prog/setprogression] error:", err.message);
    return res.status(500).json({ statusCode: 500, error: "Internal error" });
  }
});

router.post("/UnlockProgressionTreeNode", (req, res) => {
  try {
    const mid = getmid(req.body);
    const treeid = sanitizestr(req.body.TreeId, 128);
    const nodeid = sanitizestr(req.body.NodeId, 128);
    if (!mid || !treeid || !nodeid) return res.status(400).send("Missing fields");

    db.prepare(
      "INSERT OR REPLACE INTO progressionnodes (mothershipid, treeid, nodeid, unlockedat) VALUES (?, ?, ?, datetime('now'))"
    ).run(mid, treeid, nodeid);

    return res.status(200).send("OK");
  } catch (err) {
    console.error("[prog/unlocknode] error:", err.message);
    return res.status(500).send("Error");
  }
});

router.post("/PurchaseShiftCreditCapIncrease", (req, res) => {
  try {
    const mid = getmid(req.body);
    if (!mid) return res.status(400).send("Missing MothershipId");

    ensureshiftcredits(mid);
    const row = db.prepare("SELECT * FROM shiftcredits WHERE mothershipid = ?").get(mid);

    if (row.capincreases >= row.capincreasesmax) {
      return res.status(400).send("User Already Has Purchased Max Shift Credit Cap");
    }

    db.prepare("UPDATE shiftcredits SET capincreases = capincreases + 1 WHERE mothershipid = ?").run(mid);
    const updated = db.prepare("SELECT * FROM shiftcredits WHERE mothershipid = ?").get(mid);

    return res.status(200).json({
      currentShiftCreditCapIncreases: updated.capincreases,
      currentShiftCreditCapIncreasesMax: 25,
      targetMothershipId: mid,
      statusCode: 200,
      error: null,
    });
  } catch (err) {
    console.error("[prog/purchasescreditcap] error:", err.message);
    return res.status(500).json({ statusCode: 500, error: "Internal error" });
  }
});

router.post("/PurchaseShiftCredit", (req, res) => {
  try {
    const mid = getmid(req.body);
    if (!mid) return res.status(400).send("Missing MothershipId");

    ensureshiftcredits(mid);
    const row = db.prepare("SELECT * FROM shiftcredits WHERE mothershipid = ?").get(mid);
    const maxcredits = 1000 + row.capincreases * 50;

    if (row.currentcredits >= maxcredits) {
      return res.status(400).send("User Already at Max Shift Credit");
    }

    const newcredits = Math.min(row.currentcredits + 100, maxcredits);
    db.prepare("UPDATE shiftcredits SET currentcredits = ? WHERE mothershipid = ?").run(newcredits, mid);

    return res.status(200).json({
      currentShiftCredits: newcredits,
      targetMothershipId: mid,
      statusCode: 200,
      error: null,
    });
  } catch (err) {
    console.error("[prog/purchasescredit] error:", err.message);
    return res.status(500).json({ statusCode: 500, error: "Internal error" });
  }
});

router.post("/GetShiftCredit", (req, res) => {
  try {
    const mid = getmid(req.body);
    const targetmid = sanitizestr(req.body.TargetMothershipId, 256) || mid;
    if (!targetmid) return res.status(400).json({ statusCode: 400, error: "Missing id" });

    ensureshiftcredits(targetmid);
    const row = db.prepare("SELECT * FROM shiftcredits WHERE mothershipid = ?").get(targetmid);

    return res.status(200).json({
      currentShiftCredits: row.currentcredits,
      currentShiftCreditCapIncreases: row.capincreases,
      currentShiftCreditCapIncreasesMax: 25,
      targetMothershipId: targetmid,
      statusCode: 200,
      error: null,
    });
  } catch (err) {
    console.error("[prog/getshiftcredit] error:", err.message);
    return res.status(500).json({ statusCode: 500, error: "Internal error" });
  }
});

router.post("/GetJuicerStatus", (req, res) => {
  try {
    const mid = getmid(req.body);
    if (!mid) return res.status(400).send("Missing MothershipId");

    ensurejuicerstatus(mid);
    const row = db.prepare("SELECT * FROM juicerstatus WHERE mothershipid = ?").get(mid);

    return res.status(200).json({
      mothershipId: mid,
      currentCoreCount: row.corecount,
      coreProcessingTimeSec: 10800,
      coreProcessingPercent: row.processingpercent,
      overdriveSupply: row.overdrivesupply,
      overdriveCap: row.overdrivecap,
      coresProcessedByOverdrive: row.coresbyoverdrive,
      refreshJuice: row.refreshjuice === 1,
      statusCode: 200,
      error: null,
    });
  } catch (err) {
    console.error("[prog/getjuicerstatus] error:", err.message);
    return res.status(500).send("Error");
  }
});

router.post("/DepositGRCore", (req, res) => {
  try {
    const mid = getmid(req.body);
    const coretype = parseInt(req.body.CoreBeingDeposited, 10) || 0;
    if (!mid) return res.status(400).json({ statusCode: 400, error: "Missing MothershipId" });

    ensureshiftcredits(mid);
    ensurejuicerstatus(mid);

    if (coretype === 3) {
      // ChaosSeed: reset credits to 0, trigger juicer
      db.prepare("UPDATE shiftcredits SET currentcredits = 0 WHERE mothershipid = ?").run(mid);
      return res.status(200).json({ currentShiftCredits: 0, statusCode: 200, error: null });
    }

    const creditgain = coretype === 2 ? 15 : 5;
    db.prepare("UPDATE shiftcredits SET currentcredits = currentcredits + ? WHERE mothershipid = ?").run(creditgain, mid);
    const row = db.prepare("SELECT currentcredits FROM shiftcredits WHERE mothershipid = ?").get(mid);

    return res.status(200).json({
      currentShiftCredits: row.currentcredits,
      statusCode: 200,
      error: null,
    });
  } catch (err) {
    console.error("[prog/depositcore] error:", err.message);
    return res.status(500).json({ statusCode: 500, error: "Internal error" });
  }
});

router.post("/PurchaseOverdrive", (req, res) => {
  try {
    const mid = getmid(req.body);
    if (!mid) return res.status(400).json({ statusCode: 400, error: "Missing MothershipId" });

    ensurejuicerstatus(mid);
    const row = db.prepare("SELECT * FROM juicerstatus WHERE mothershipid = ?").get(mid);

    if (row.overdrivesupply >= row.overdrivecap) {
      return res.status(400).send("User Already At Overdrive Cap");
    }

    db.prepare("UPDATE juicerstatus SET overdrivesupply = overdrivecap WHERE mothershipid = ?").run(mid);
    webhook.grOverdrive(mid);
    return res.status(200).json({ statusCode: 200, error: null });
  } catch (err) {
    console.error("[prog/purchaseoverdrive] error:", err.message);
    return res.status(500).send("Error");
  }
});

router.post("/SubtractShiftCredit", (req, res) => {
  try {
    const mid = getmid(req.body);
    const amount = parseInt(req.body.ShiftCreditToRemove, 10) || 0;
    if (!mid) return res.status(400).json({ statusCode: 400, error: "Missing MothershipId" });

    ensureshiftcredits(mid);
    db.prepare("UPDATE shiftcredits SET currentcredits = MAX(0, currentcredits - ?) WHERE mothershipid = ?").run(amount, mid);
    const row = db.prepare("SELECT * FROM shiftcredits WHERE mothershipid = ?").get(mid);

    return res.status(200).json({
      currentShiftCredits: row.currentcredits,
      currentShiftCreditCapIncreases: row.capincreases,
      currentShiftCreditCapIncreasesMax: 25,
      targetMothershipId: null,
      statusCode: 200,
      error: null,
    });
  } catch (err) {
    console.error("[prog/subtractcredit] error:", err.message);
    return res.status(500).json({ statusCode: 500, error: "Internal error" });
  }
});

router.post("/RecycleTool", (req, res) => {
  try {
    const mid = getmid(req.body);
    const tooltype = parseInt(req.body.ToolBeingRecycled, 10) || 0;
    if (!mid) return res.status(400).json({ statusCode: 400, error: "Missing MothershipId" });

    // ToolBeingRecycled: 1=Club, 2=Collector, 3=Flash, 4=Lantern, 5=Revive, 6=ShieldGun, 7=DirectionalShield, 8=DockWrist, 9=EnergyEfficiency, 10=DropPod, 11=HockeyStick, 12=StatusWatch, 13=RattyBackpack
    const recyclevalues = { 11: 10, 1: 5, 2: 5, 3: 5, 4: 5, 5: 5, 6: 10, 7: 10, 8: 15, 9: 10, 10: 15, 12: 10, 13: 15 };
    const creditgain = recyclevalues[tooltype] || 5;

    ensureshiftcredits(mid);
    db.prepare("UPDATE shiftcredits SET currentcredits = currentcredits + ? WHERE mothershipid = ?").run(creditgain, mid);

    const row = db.prepare("SELECT * FROM shiftcredits WHERE mothershipid = ?").get(mid);
    return res.status(200).json({
      currentShiftCredits: row.currentcredits,
      currentShiftCreditCapIncreases: row.capincreases,
      currentShiftCreditCapIncreasesMax: 25,
      targetMothershipId: mid,
      statusCode: 200,
      error: null,
    });
  } catch (err) {
    console.error("[prog/recycletool] error:", err.message);
    return res.status(500).json({ statusCode: 500, error: "Internal error" });
  }
});

router.post("/AdvanceDockWristUpgrade", (req, res) => {
  try {
    const mid = getmid(req.body);
    const upgrade = parseInt(req.body.Upgrade, 10) || 0;
    if (!mid) return res.status(400).send("Missing MothershipId");

    ensuredockwrist(mid);

    const col = upgrade === 1 ? "upgrade1level" : upgrade === 2 ? "upgrade2level" : "upgrade3level";
    db.prepare(`UPDATE dockwrist SET ${col} = ${col} + 1 WHERE mothershipid = ?`).run(mid);

    const row = db.prepare("SELECT * FROM dockwrist WHERE mothershipid = ?").get(mid);
    return res.status(200).json({
      CurrentUpgrade1Level: row.upgrade1level,
      CurrentUpgrade2Level: row.upgrade2level,
      CurrentUpgrade3Level: row.upgrade3level,
      Upgrade1LevelMax: row.upgrade1max,
      Upgrade2LevelMax: row.upgrade2max,
      Upgrade3LevelMax: row.upgrade3max,
    });
  } catch (err) {
    console.error("[prog/advancedock] error:", err.message);
    return res.status(500).send("Error");
  }
});

router.post("/GetDockWristUpgradeStatus", (req, res) => {
  try {
    const mid = getmid(req.body);
    if (!mid) return res.status(400).send("Missing MothershipId");

    ensuredockwrist(mid);
    const row = db.prepare("SELECT * FROM dockwrist WHERE mothershipid = ?").get(mid);

    return res.status(200).json({
      CurrentUpgrade1Level: row.upgrade1level,
      CurrentUpgrade2Level: row.upgrade2level,
      CurrentUpgrade3Level: row.upgrade3level,
      Upgrade1LevelMax: row.upgrade1max,
      Upgrade2LevelMax: row.upgrade2max,
      Upgrade3LevelMax: row.upgrade3max,
    });
  } catch (err) {
    console.error("[prog/getdockstatus] error:", err.message);
    return res.status(500).send("Error");
  }
});

router.post("/PurchaseDrillUpgrade", (req, res) => {
  try {
    const mid = getmid(req.body);
    const upgrade = sanitizestr(req.body.Upgrade, 32) || "Base";
    if (!mid) return res.status(400).send("Missing MothershipId");

    const row = db.prepare("SELECT * FROM drillupgrades WHERE mothershipid = ?").get(mid);
    if (!row) {
      db.prepare("INSERT INTO drillupgrades (mothershipid, upgradelevel, basepurchased) VALUES (?, 0, 1)").run(mid);
    } else {
      db.prepare("UPDATE drillupgrades SET upgradelevel = upgradelevel + 1 WHERE mothershipid = ?").run(mid);
    }

    const updated = db.prepare("SELECT * FROM drillupgrades WHERE mothershipid = ?").get(mid);
    return res.status(200).json({
      StatusCode: 200,
      Error: null,
      UpgradeLevel: updated.upgradelevel,
      BasePurchased: updated.basepurchased === 1,
    });
  } catch (err) {
    console.error("[prog/purchasedrill] error:", err.message);
    return res.status(500).send("Error");
  }
});

router.post("/RecycleTool", (req, res) => {
  try {
    const mid = getmid(req.body);
    if (!mid) return res.status(400).send("Missing MothershipId");

    ensureshiftcredits(mid);
    const creditgain = 5;
    db.prepare("UPDATE shiftcredits SET currentcredits = currentcredits + ? WHERE mothershipid = ?").run(creditgain, mid);

    const row = db.prepare("SELECT * FROM shiftcredits WHERE mothershipid = ?").get(mid);
    return res.status(200).json({
      StatusCode: 200,
      Error: null,
      CurrentShiftCredits: row.currentcredits,
      CurrentShiftCreditCapIncreases: row.capincreases,
      CurrentShiftCreditCapIncreasesMax: row.capincreasesmax,
      TargetMothershipId: mid,
    });
  } catch (err) {
    console.error("[prog/recycletool] error:", err.message);
    return res.status(500).send("Error");
  }
});

router.post("/StartOfShift", (req, res) => {
  try {
    const mid = getmid(req.body);
    const shiftid = sanitizestr(req.body.ShiftId, 128);
    const cores = parseInt(req.body.CoresRequired, 10) || 0;
    const players = parseInt(req.body.NumberOfPlayers, 10) || 0;
    const depth = parseInt(req.body.Depth, 10) || 0;
    if (!mid || !shiftid) return res.status(400).json({ statusCode: 400, error: "Missing fields" });

    db.prepare(
      "INSERT OR REPLACE INTO shifts (shiftid, mothershipid, coresrequired, numberofplayers, depth, startedat, completed) VALUES (?, ?, ?, ?, ?, datetime('now'), 0)"
    ).run(shiftid, mid, cores, players, depth);

    webhook.grShift(mid, shiftid, depth, cores, players);

    return res.status(200).json({ statusCode: 200, error: null });
  } catch (err) {
    console.error("[prog/startofshift] error:", err.message);
    return res.status(500).json({ statusCode: 500, error: "Internal error" });
  }
});

router.post("/EndOfShiftReward", (req, res) => {
  try {
    const mid = getmid(req.body);
    const shiftid = sanitizestr(req.body.ShiftId, 128);
    if (!mid) return res.status(400).json({ statusCode: 400, error: "Missing MothershipId" });

    if (shiftid) {
      const shift = db.prepare("SELECT * FROM shifts WHERE shiftid = ?").get(shiftid);
      if (shift) {
        db.prepare("UPDATE shifts SET completed = 1 WHERE shiftid = ?").run(shiftid);
      }
    }

    ensureshiftcredits(mid);
    db.prepare("UPDATE shiftcredits SET currentcredits = currentcredits + 25 WHERE mothershipid = ?").run(mid);

    const row = db.prepare("SELECT * FROM shiftcredits WHERE mothershipid = ?").get(mid);
    webhook.grShiftEnd(mid, shiftid, row.currentcredits);
    return res.status(200).json({
      currentShiftCredits: row.currentcredits,
      currentShiftCreditCapIncreases: row.capincreases,
      currentShiftCreditCapIncreasesMax: 25,
      targetMothershipId: mid,
      statusCode: 200,
      error: null,
    });
  } catch (err) {
    console.error("[prog/endofshift] error:", err.message);
    return res.status(500).json({ statusCode: 500, error: "Internal error" });
  }
});

router.post("/GetGhostReactorStats", (req, res) => {
  try {
    const mid = getmid(req.body);
    if (!mid) return res.status(400).send("Missing MothershipId");

    ensurereactorstats(mid);
    const row = db.prepare("SELECT * FROM reactorstats WHERE mothershipid = ?").get(mid);

    return res.status(200).json({
      MothershipId: mid,
      MaxDepthReached: row.maxdepthreached,
    });
  } catch (err) {
    console.error("[prog/getreactorstats] error:", err.message);
    return res.status(500).send("Error");
  }
});

router.post("/GetGhostReactorInventory", (req, res) => {
  try {
    const mid = getmid(req.body);
    if (!mid) return res.status(400).send("Missing MothershipId");

    ensurereactorinventory(mid);
    const row = db.prepare("SELECT * FROM reactorinventory WHERE mothershipid = ?").get(mid);

    return res.status(200).json({
      MothershipId: mid,
      InventoryJson: row.inventoryjson || "{}",
    });
  } catch (err) {
    console.error("[prog/getreactorinv] error:", err.message);
    return res.status(500).send("Error");
  }
});

router.post("/SetGhostReactorInventory", (req, res) => {
  try {
    const mid = getmid(req.body);
    const inventoryjson = req.body.InventoryJson;
    if (!mid) return res.status(400).send("Missing MothershipId");

    let parsed;
    try {
      parsed = typeof inventoryjson === "string" ? JSON.parse(inventoryjson) : inventoryjson;
    } catch {
      return res.status(400).send("Invalid JSON");
    }

    const jsonstr = typeof inventoryjson === "string" ? inventoryjson : JSON.stringify(inventoryjson);

    ensurereactorinventory(mid);
    db.prepare("UPDATE reactorinventory SET inventoryjson = ? WHERE mothershipid = ?").run(jsonstr, mid);

    return res.status(200).json({ MothershipId: mid });
  } catch (err) {
    console.error("[prog/setreactorinv] error:", err.message);
    return res.status(500).send("Error");
  }
});

module.exports = router;
