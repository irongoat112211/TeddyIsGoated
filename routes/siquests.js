const express = require("express");
const router = express.Router();
const { db, ensuresiquests } = require("../lib/database");
const { sanitizestr } = require("../lib/validation");
const webhook = require("../lib/webhook");

function getmid(body) {
  return sanitizestr(body.MothershipId || body.mothershipId || "", 256);
}

// helper to add/update a mothership inventory entitlement
function addentitlement(mid, ingame, name, eid, qty) {
  let invrow = db.prepare("SELECT * FROM mothershipinventory WHERE mothershipid = ?").get(mid);
  if (!invrow) {
    db.prepare("INSERT INTO mothershipinventory (mothershipid, inventoryjson, updatedat) VALUES (?, ?, datetime('now'))").run(mid, JSON.stringify([]));
    invrow = { inventoryjson: "[]" };
  }
  const inventory = JSON.parse(invrow.inventoryjson || "[]");
  const existing = inventory.find(e => e.in_game_id === ingame);
  if (existing) {
    existing.quantity = (existing.quantity || 0) + qty;
  } else {
    inventory.push({ entitlement_id: eid, in_game_id: ingame, name: name, quantity: qty });
  }
  db.prepare("UPDATE mothershipinventory SET inventoryjson = ?, updatedat = datetime('now') WHERE mothershipid = ?").run(JSON.stringify(inventory), mid);
}

router.post("/IncrementSIResource", (req, res) => {
  try {
    const mid = getmid(req.body);
    const resourcetype = sanitizestr(req.body.ResourceType, 64);
    if (!mid) return res.status(400).json({ error: "Missing MothershipId" });

    // map client resource types to entitlement IDs
    const entmap = {
      "TechPoint":       { id: "d4a0fad9-4602-435d-b379-cd5f69fb4321", name: "SI_TechPoints",        ingame: "SI_TECH_POINTS" },
      "StrangeWood":     { id: "078b85fb-c0d9-44d5-a3ca-e325819b13cd", name: "SI_StrangeWood",       ingame: "SI_STRANGE_WOOD" },
      "WeirdGear":       { id: "427839b6-58a4-4e8b-9cb4-3d48cb1fb513", name: "SI_WeirdGear",         ingame: "SI_WEIRD_GEAR" },
      "VibratingSpring": { id: "5150d276-db1a-4263-bff4-edbe7b55f841", name: "SI_VibratingSpring",   ingame: "SI_VIBRATING_SPRING" },
      "BouncySand":      { id: "8040ba58-afaa-44d3-bc0a-4d7864abf45d", name: "SI_BouncySand",        ingame: "SI_BOUNCY_SAND" },
      "FloppyMetal":     { id: "11844689-b2d0-4f02-923f-3bf49ba3aac6", name: "SI_FloppyMetal",       ingame: "SI_FLOPPY_METAL" },
    };

    // update mothership inventory
    let invrow = db.prepare("SELECT * FROM mothershipinventory WHERE mothershipid = ?").get(mid);
    if (!invrow) {
      db.prepare("INSERT INTO mothershipinventory (mothershipid, inventoryjson, updatedat) VALUES (?, ?, datetime('now'))").run(mid, JSON.stringify([]));
      invrow = { inventoryjson: "[]" };
    }
    const inventory = JSON.parse(invrow.inventoryjson || "[]");

    const mapping = entmap[resourcetype];
    if (mapping) {
      const existing = inventory.find(e => e.in_game_id === mapping.ingame);
      if (existing) {
        existing.quantity = (existing.quantity || 0) + 1;
      } else {
        inventory.push({
          entitlement_id: mapping.id,
          in_game_id: mapping.ingame,
          name: mapping.name,
          quantity: 1
        });
      }
      db.prepare("UPDATE mothershipinventory SET inventoryjson = ?, updatedat = datetime('now') WHERE mothershipid = ?").run(JSON.stringify(inventory), mid);
    }

    // also update si inventory for internal tracking
    ensuresiquests(mid);
    const row = db.prepare("SELECT * FROM siquests WHERE mothershipid = ?").get(mid);
    const siinv = JSON.parse(row.inventoryjson || "{}");
    siinv[resourcetype] = (siinv[resourcetype] || 0) + 1;
    db.prepare("UPDATE siquests SET inventoryjson = ? WHERE mothershipid = ?").run(JSON.stringify(siinv), mid);

    return res.status(200).json({
      Result: { Inventory: siinv },
      ResourceType: resourcetype,
    });
  } catch (err) {
    console.error("[siquests/incrementresource] error:", err.message);
    return res.status(500).send("Error");
  }
});

router.post("/SetSIQuestComplete", (req, res) => {
  try {
    const mid = getmid(req.body);
    if (!mid) return res.status(400).json({ error: "Missing MothershipId" });

    ensuresiquests(mid);
    const row = db.prepare("SELECT * FROM siquests WHERE mothershipid = ?").get(mid);

    const newclaimable = Math.max(0, (row.todayclaimablequests || 0) - 1);
    const inventory = JSON.parse(row.inventoryjson || "{}");
    inventory["SI_TechPoints"] = (inventory["SI_TechPoints"] || 0) + 1;
    db.prepare("UPDATE siquests SET todayclaimablequests = ?, inventoryjson = ? WHERE mothershipid = ?").run(newclaimable, JSON.stringify(inventory), mid);

    addentitlement(mid, "SI_TECH_POINTS", "SI_TechPoints", "d4a0fad9-4602-435d-b379-cd5f69fb4321", 1);

    return res.status(200).json({
      Result: {
        TodayClaimableQuests: newclaimable,
        TodayClaimableBonus: row.todayclaimablebonus || 0,
        TodayClaimableIdol: row.todayclaimableidol || 0,
      },
    });
  } catch (err) {
    console.error("[siquests/setquestcomplete] error:", err.message);
    return res.status(500).send("Error");
  }
});

router.post("/SetSIBonusComplete", (req, res) => {
  try {
    const mid = getmid(req.body);
    if (!mid) return res.status(400).json({ error: "Missing MothershipId" });

    ensuresiquests(mid);
    const row = db.prepare("SELECT * FROM siquests WHERE mothershipid = ?").get(mid);

    const newbonus = Math.max(0, (row.todayclaimablebonus || 0) - 1);
    const inventory = JSON.parse(row.inventoryjson || "{}");
    inventory["SI_TechPoints"] = (inventory["SI_TechPoints"] || 0) + 1;
    db.prepare("UPDATE siquests SET todayclaimablebonus = ?, inventoryjson = ? WHERE mothershipid = ?").run(newbonus, JSON.stringify(inventory), mid);

    addentitlement(mid, "SI_TECH_POINTS", "SI_TechPoints", "d4a0fad9-4602-435d-b379-cd5f69fb4321", 1);

    return res.status(200).json({
      Result: {
        TodayClaimableQuests: row.todayclaimablequests || 0,
        TodayClaimableBonus: newbonus,
        TodayClaimableIdol: row.todayclaimableidol || 0,
      },
    });
  } catch (err) {
    console.error("[siquests/setbonuscomplete] error:", err.message);
    return res.status(500).send("Error");
  }
});

router.post("/SetSIIdolCollect", (req, res) => {
  try {
    const mid = getmid(req.body);
    if (!mid) return res.status(400).json({ error: "Missing MothershipId" });

    ensuresiquests(mid);
    const row = db.prepare("SELECT * FROM siquests WHERE mothershipid = ?").get(mid);

    const newidol = Math.max(0, (row.todayclaimableidol || 0) - 1);
    const inventory = JSON.parse(row.inventoryjson || "{}");
    inventory["SI_TechPoints"] = (inventory["SI_TechPoints"] || 0) + 1;
    db.prepare("UPDATE siquests SET todayclaimableidol = ?, inventoryjson = ? WHERE mothershipid = ?").run(newidol, JSON.stringify(inventory), mid);

    addentitlement(mid, "SI_TECH_POINTS", "SI_TechPoints", "d4a0fad9-4602-435d-b379-cd5f69fb4321", 1);

    return res.status(200).json({
      Result: {
        TodayClaimableQuests: row.todayclaimablequests || 0,
        TodayClaimableBonus: row.todayclaimablebonus || 0,
        TodayClaimableIdol: newidol,
      },
    });
  } catch (err) {
    console.error("[siquests/setidolcollect] error:", err.message);
    return res.status(500).send("Error");
  }
});

router.post("/GetActiveSIQuests", (req, res) => {
  try {
    const mid = getmid(req.body);
    if (!mid) return res.status(400).json({ error: "Missing MothershipId" });

    ensuresiquests(mid);

    return res.status(200).json({
      result: {
        quests: [
          {"disable":false,"questID":35,"weight":1,"category":"NONE","questName":"COLLECT WEIRD GEARS","questType":"misc","questOccurenceFilter":"SISWeirdGearCollect","requiredOccurenceCount":5,"requiredZones":["none"]},
          {"disable":false,"questID":1,"weight":1,"category":"NONE","questName":"COLLECT VIBRATING SPRINGS","questType":"misc","questOccurenceFilter":"SIVibratingSpringCollect","requiredOccurenceCount":5,"requiredZones":["none"]},
          {"disable":false,"questID":2,"weight":1,"category":"NONE","questName":"COLLECT CLUMPS OF BOUNCY SAND","questType":"misc","questOccurenceFilter":"SIBouncySandCollect","requiredOccurenceCount":5,"requiredZones":["none"]},
          {"disable":false,"questID":3,"weight":1,"category":"NONE","questName":"COLLECT PIECES OF FLOPPY METAL","questType":"misc","questOccurenceFilter":"SIFloppyMetalCollect","requiredOccurenceCount":5,"requiredZones":["none"]},
          {"disable":false,"questID":4,"weight":1,"category":"NONE","questName":"COLLECT PIECES OF STRANGE WOOD","questType":"misc","questOccurenceFilter":"SIStrangeWoodCollect","requiredOccurenceCount":5,"requiredZones":["none"]},
          {"disable":false,"questID":5,"weight":1,"category":"NONE","questName":"CLIMB THE TALLEST TREE","questType":"enterLocation","questOccurenceFilter":"TallestTree","requiredOccurenceCount":1,"requiredZones":["forest"]},
          {"disable":false,"questID":6,"weight":1,"category":"NONE","questName":"SWIM UNDER A WATERFALL","questType":"enterLocation","questOccurenceFilter":"UnderWaterfall","requiredOccurenceCount":1,"requiredZones":["none"]},
          {"disable":false,"questID":7,"weight":1,"category":"NONE","questName":"CLIMB INTO THE CROW'S NEST","questType":"enterLocation","questOccurenceFilter":"CrowsNest","requiredOccurenceCount":1,"requiredZones":["none"]},
          {"disable":false,"questID":8,"weight":1,"category":"NONE","questName":"RIDE THE UPPER SLIDE","questType":"enterLocation","questOccurenceFilter":"UpperSlide","requiredOccurenceCount":1,"requiredZones":["none"]},
          {"disable":false,"questID":9,"weight":1,"category":"NONE","questName":"FIND THE TUNNEL TO FUN","questType":"enterLocation","questOccurenceFilter":"TunnelToFun","requiredOccurenceCount":1,"requiredZones":["none"]},
          {"disable":false,"questID":10,"weight":1,"category":"NONE","questName":"DISCOVER THE VOLCANO","questType":"enterLocation","questOccurenceFilter":"Volcano","requiredOccurenceCount":1,"requiredZones":["none"]},
        ],
        version: "4",
      },
      statusCode: 200,
      error: null,
    });
  } catch (err) {
    console.error("[siquests/getactivequests] error:", err.message);
    return res.status(500).send("Error");
  }
});

router.post("/GetSIQuestsStatus", (req, res) => {
  try {
    const mid = getmid(req.body);
    if (!mid) return res.status(400).json({ error: "Missing MothershipId" });

    ensuresiquests(mid);
    const row = db.prepare("SELECT * FROM siquests WHERE mothershipid = ?").get(mid);

    return res.status(200).json({
      Result: {
        TodayClaimableQuests: row.todayclaimablequests || 0,
        TodayClaimableBonus: row.todayclaimablebonus || 0,
        TodayClaimableIdol: row.todayclaimableidol || 0,
      },
    });
  } catch (err) {
    console.error("[siquests/getqueststatus] error:", err.message);
    return res.status(500).send("Error");
  }
});

router.post("/ResetSIQuestsStatus", (req, res) => {
  try {
    const mid = getmid(req.body);
    if (!mid) return res.status(400).json({ error: "Missing MothershipId" });

    ensuresiquests(mid);
    db.prepare("UPDATE siquests SET todayclaimablequests = 3, todayclaimablebonus = 1, todayclaimableidol = 1 WHERE mothershipid = ?").run(mid);

    return res.status(200).json({
      Result: {
        TodayClaimableQuests: 3,
        TodayClaimableBonus: 1,
        TodayClaimableIdol: 1,
      },
    });
  } catch (err) {
    console.error("[siquests/resetqueststatus] error:", err.message);
    return res.status(500).send("Error");
  }
});

router.post("/PurchaseTechPoints", (req, res) => {
  try {
    const mid = getmid(req.body);
    const amount = parseInt(req.body.TechPointsAmount, 10) || 0;
    if (!mid || amount <= 0) return res.status(400).json({ statusCode: 400, error: "Missing MothershipId or TechPointsAmount" });

    // update mothership inventory entitlement
    const invrow = db.prepare("SELECT * FROM mothershipinventory WHERE mothershipid = ?").get(mid);
    if (!invrow) {
      db.prepare("INSERT INTO mothershipinventory (mothershipid, inventoryjson, updatedat) VALUES (?, ?, datetime('now'))").run(mid, JSON.stringify([]));
    }
    const inventory = invrow ? JSON.parse(invrow.inventoryjson || "[]") : [];
    const existing = inventory.find(e => e.in_game_id === "SI_TECH_POINTS");
    if (existing) {
      existing.quantity = (existing.quantity || 0) + amount;
    } else {
      inventory.push({
        entitlement_id: "d4a0fad9-4602-435d-b379-cd5f69fb4321",
        in_game_id: "SI_TECH_POINTS",
        name: "SI_TechPoints",
        quantity: amount
      });
    }
    db.prepare("UPDATE mothershipinventory SET inventoryjson = ?, updatedat = datetime('now') WHERE mothershipid = ?").run(JSON.stringify(inventory), mid);

    webhook.purchase(mid, "SI_TechPoints x" + amount, (amount * 100) + " rocks");

    // also track in si inventory for consistency
    ensuresiquests(mid);
    const row = db.prepare("SELECT * FROM siquests WHERE mothershipid = ?").get(mid);
    const siinv = JSON.parse(row.inventoryjson || "{}");
    siinv["SI_TechPoints"] = (siinv["SI_TechPoints"] || 0) + amount;
    db.prepare("UPDATE siquests SET inventoryjson = ? WHERE mothershipid = ?").run(JSON.stringify(siinv), mid);

    return res.status(200).json({ statusCode: 200, error: null });
  } catch (err) {
    console.error("[siquests/purchasetechpoints] error:", err.message);
    return res.status(500).json({ statusCode: 500, error: "Internal error" });
  }
});

router.post("/PurchaseResources", (req, res) => {
  try {
    const mid = getmid(req.body);
    if (!mid) return res.status(400).json({ error: "Missing MothershipId" });

    const resmap = {
      "SI_STRANGE_WOOD":      { id: "078b85fb-c0d9-44d5-a3ca-e325819b13cd", name: "SI_StrangeWood" },
      "SI_WEIRD_GEAR":        { id: "427839b6-58a4-4e8b-9cb4-3d48cb1fb513", name: "SI_WeirdGear" },
      "SI_VIBRATING_SPRING":  { id: "5150d276-db1a-4263-bff4-edbe7b55f841", name: "SI_VibratingSpring" },
      "SI_BOUNCY_SAND":       { id: "8040ba58-afaa-44d3-bc0a-4d7864abf45d", name: "SI_BouncySand" },
      "SI_FLOPPY_METAL":      { id: "11844689-b2d0-4f02-923f-3bf49ba3aac6", name: "SI_FloppyMetal" },
    };

    let invrow = db.prepare("SELECT * FROM mothershipinventory WHERE mothershipid = ?").get(mid);
    if (!invrow) {
      db.prepare("INSERT INTO mothershipinventory (mothershipid, inventoryjson, updatedat) VALUES (?, ?, datetime('now'))").run(mid, JSON.stringify([]));
      invrow = { inventoryjson: "[]" };
    }
    const inventory = JSON.parse(invrow.inventoryjson || "[]");

    const resultInventory = {};
    for (const [ingame, info] of Object.entries(resmap)) {
      const existing = inventory.find(e => e.in_game_id === ingame);
      if (existing) {
        existing.quantity = 20;
      } else {
        inventory.push({
          entitlement_id: info.id,
          in_game_id: ingame,
          name: info.name,
          quantity: 20
        });
      }
      resultInventory[info.name] = 20;
    }

    db.prepare("UPDATE mothershipinventory SET inventoryjson = ?, updatedat = datetime('now') WHERE mothershipid = ?").run(JSON.stringify(inventory), mid);

    webhook.purchase(mid, "Resource Refill", "500 rocks");

    // also update si inventory
    ensuresiquests(mid);
    const row = db.prepare("SELECT * FROM siquests WHERE mothershipid = ?").get(mid);
    const siinv = JSON.parse(row.inventoryjson || "{}");
    siinv["StrangeWood"] = 20;
    siinv["WeirdGear"] = 20;
    siinv["VibratingSpring"] = 20;
    siinv["BouncySand"] = 20;
    siinv["FloppyMetal"] = 20;
    db.prepare("UPDATE siquests SET inventoryjson = ? WHERE mothershipid = ?").run(JSON.stringify(siinv), mid);

    return res.status(200).json({
      result: { inventory: resultInventory },
      statusCode: 200,
      error: null,
    });
  } catch (err) {
    console.error("[siquests/purchaseresources] error:", err.message);
    return res.status(500).send("Error");
  }
});

module.exports = router;
