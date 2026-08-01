const Database = require("better-sqlite3");
const path = require("path");
const db = new Database(path.join(__dirname, "gamedata.db"));

const existing = db.prepare("SELECT datavalue FROM mothershiptitledata WHERE datakey = 'DeployFeatureFlags'").get();
if (!existing) {
  console.log("No DB override — the file is served from titledata.json. Edit it directly.");
  const fs = require("fs");
  const raw = require("./data/titledata.json");
  for (const entry of raw.Results) {
    if (entry.key === "DeployFeatureFlags") {
      const d = JSON.parse(entry.data);
      d.flags.forEach(f => {
        if (f.name.includes("CosmeticsAuthenticationV2")) { f.value = 0; console.log("Set", f.name, "to 0"); }
      });
      entry.data = JSON.stringify(d);
      console.log("Updated in memory");
    }
  }
  fs.writeFileSync("./data/titledata.json", JSON.stringify(raw));
  console.log("Wrote titledata.json");
} else {
  const d = JSON.parse(existing.datavalue);
  d.flags.forEach(f => {
    if (f.name.includes("CosmeticsAuthenticationV2")) { f.value = 0; console.log("Set", f.name, "to 0"); }
  });
  db.prepare("INSERT OR REPLACE INTO mothershiptitledata (datakey, datavalue, updatedat) VALUES ('DeployFeatureFlags', ?, datetime('now'))").run(JSON.stringify(d));
  console.log("Updated DB override");
}
console.log("Done — restart backend");
