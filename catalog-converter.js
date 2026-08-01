// catalog-converter.js — converts PlayFab GetCatalogItems response to admin upload format
// Usage: node catalog-converter.js <input.json> [output.json]
// Default output: catalog-upload.json

const fs = require("fs");
const path = require("path");

const inputFile = process.argv[2];
const outputFile = process.argv[3] || path.join(__dirname, "catalog-upload.json");

if (!inputFile) {
  console.log("Usage: node catalog-converter.js <input.json> [output.json]");
  console.log("Converts PlayFab GetCatalogItems API response to admin upload format.");
  process.exit(1);
}

let raw;
try {
  const data = fs.readFileSync(inputFile, "utf8");
  // Handle the curl output format (just the JSON, possibly with HTTP headers)
  const jsonStart = data.indexOf("{");
  const jsonEnd = data.lastIndexOf("}") + 1;
  const jsonStr = jsonStart >= 0 ? data.slice(jsonStart, jsonEnd) : data;
  raw = JSON.parse(jsonStr);
  console.log("Loaded:", inputFile);
} catch (e) {
  console.error("Failed to parse:", e.message);
  process.exit(1);
}

// Detect format
let catalog = [];
let version = "DLC";

if (raw.data && raw.data.Catalog) {
  // PlayFab API response: {code:200, data:{Catalog:[...]}}
  catalog = raw.data.Catalog;
  console.log("Detected: PlayFab GetCatalogItems response");
} else if (raw.Catalog) {
  // Already has Catalog wrapper
  catalog = raw.Catalog;
  version = raw.CatalogVersion || "DLC";
  console.log("Detected: Catalog wrapper format");
} else if (Array.isArray(raw)) {
  catalog = raw;
  console.log("Detected: raw array of items");
}

console.log(`Converting ${catalog.length} items...`);

const output = {
  CatalogVersion: version,
  Catalog: catalog.map(item => ({
    ItemId: item.ItemId || "",
    ItemClass: item.ItemClass || null,
    CatalogVersion: item.CatalogVersion || version,
    DisplayName: item.DisplayName || "",
    Description: item.Description || null,
    VirtualCurrencyPrices: item.VirtualCurrencyPrices || {},
    RealCurrencyPrices: item.RealCurrencyPrices || {},
    Tags: item.Tags || [],
    CustomData: item.CustomData || null,
    Consumable: item.Consumable
      ? {
          UsageCount: item.Consumable.UsageCount || null,
          UsagePeriod: item.Consumable.UsagePeriod || null,
          UsagePeriodGroup: item.Consumable.UsagePeriodGroup || null,
        }
      : { UsageCount: null, UsagePeriod: null, UsagePeriodGroup: null },
    Container: item.Container
      ? {
          ItemId: item.Container.ItemId || null,
          ItemClass: item.Container.ItemClass || null,
          CatalogVersion: item.Container.CatalogVersion || null,
          DisplayName: item.Container.DisplayName || null,
          VirtualCurrencyPrices: item.Container.VirtualCurrencyPrices || null,
          RealCurrencyPrices: item.Container.RealCurrencyPrices || null,
          Tags: item.Container.Tags || null,
          CustomData: item.Container.CustomData || null,
        }
      : null,
    Bundle: item.Bundle && item.Bundle.BundledItems
      ? {
          BundledItems: item.Bundle.BundledItems || [],
          BundledResultTables: item.Bundle.BundledResultTables || [],
          BundledVirtualCurrencies: item.Bundle.BundledVirtualCurrencies || {},
        }
      : null,
    CanBecomeCharacter: item.CanBecomeCharacter || false,
    IsStackable: item.IsStackable || false,
    IsTradable: item.IsTradable || false,
    ItemImageUrl: item.ItemImageUrl || null,
    IsLimitedEdition: item.IsLimitedEdition || false,
    InitialLimitedEditionCount: item.InitialLimitedEditionCount || 0,
    ActivatedMembership: item.ActivatedMembership || null,
  })),
};

fs.writeFileSync(outputFile, JSON.stringify(output, null, 2), "utf8");
console.log(`Wrote ${output.Catalog.length} items to: ${outputFile}`);
