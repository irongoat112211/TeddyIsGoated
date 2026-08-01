const config = require("./config");
const { postrequest } = require("./httpclient");

const pfhost = `${config.playfabtitleid}.playfabapi.com`;

function authheaders() {
  return { "X-SecretKey": config.playfabsecretkey };
}

// ─── Generic helpers ──────────────────────────────────────────
async function adminApi(method, body) {
  return postrequest(pfhost, `/Admin/${method}`, body, authheaders());
}
async function serverApi(method, body) {
  return postrequest(pfhost, `/Server/${method}`, body, authheaders());
}

// ─── Server APIs ──────────────────────────────────────────────
async function serverlogin(customid, createaccount) {
  return postrequest(pfhost, "/Server/LoginWithServerCustomId", {
    ServerCustomId: customid,
    CreateAccount: createaccount !== false,
  }, authheaders());
}

async function getuseraccountinfo(playfabid) {
  return postrequest(pfhost, "/Server/GetUserAccountInfo", { PlayFabId: playfabid }, authheaders());
}

async function gettitledata() {
  return postrequest(pfhost, "/Server/GetTitleData", {}, authheaders());
}

async function getplayerprofile(playfabid) {
  return postrequest(pfhost, "/Server/GetPlayerProfile", {
    PlayFabId: playfabid,
    ProfileConstraints: { ShowDisplayName: true, ShowAvatarUrl: true, ShowContactEmailAddresses: true },
  }, authheaders());
}

async function getuserinventory(playfabid) {
  return postrequest(pfhost, "/Server/GetUserInventory", { PlayFabId: playfabid }, authheaders());
}

async function getplayercombinedinfo(playfabid, infos) {
  return postrequest(pfhost, "/Server/GetPlayerCombinedInfo", {
    PlayFabId: playfabid,
    InfoRequestParameters: infos || {
      GetUserAccountInfo: true,
      GetUserInventory: true,
      GetUserVirtualCurrency: true,
      GetPlayerProfile: true,
      GetPlayerStatistics: true,
      GetUserData: true,
      GetUserReadOnlyData: true,
      GetUserInternalData: true,
    },
  }, authheaders());
}

async function addvirtualcurrency(playfabid, amount, currency) {
  return serverApi("AddUserVirtualCurrency", {
    PlayFabId: playfabid, Amount: amount, VirtualCurrency: currency || "SI",
  });
}

async function subtractvirtualcurrency(playfabid, amount, currency) {
  return serverApi("SubtractUserVirtualCurrency", {
    PlayFabId: playfabid, Amount: amount, VirtualCurrency: currency || "SI",
  });
}

async function getuserbans(playfabid) {
  return serverApi("GetUserBans", { PlayFabId: playfabid });
}

async function banusers(players, reason, durationHours) {
  const bans = players.map(id => ({ PlayFabId: id, Reason: reason, DurationInHours: durationHours || 0 }));
  return serverApi("BanUsers", { Bans: bans });
}

async function revokeallbans(userid) {
  return serverApi("RevokeAllBansForUser", { PlayFabId: userid });
}

async function revokeinventoryitem(playfabid, instanceid) {
  return serverApi("RevokeInventoryItem", { PlayFabId: playfabid, ItemInstanceId: instanceid });
}

async function revokeinventoryitems(playfabid, instanceids) {
  return serverApi("RevokeInventoryItems", { PlayFabId: playfabid, ItemInstanceIds: instanceids });
}

async function getuserdata(playfabid, keys) {
  return serverApi("GetUserData", { PlayFabId: playfabid, Keys: keys || null });
}

async function getuserinternaldata(playfabid, keys) {
  return serverApi("GetUserInternalData", { PlayFabId: playfabid, Keys: keys || null });
}

async function getuserreadonlydata(playfabid, keys) {
  return serverApi("GetUserReadOnlyData", { PlayFabId: playfabid, Keys: keys || null });
}

async function updateuserdata(playfabid, data, permission) {
  return serverApi("UpdateUserData", {
    PlayFabId: playfabid, Data: data || {}, Permission: permission || "Public",
  });
}

async function updateuserinternaldata(playfabid, data) {
  return serverApi("UpdateUserInternalData", { PlayFabId: playfabid, Data: data || {} });
}

async function getplayerstatistics(playfabid) {
  return serverApi("GetPlayerStatistics", { PlayFabId: playfabid });
}

async function updateplayerstatistics(playfabid, stats) {
  return serverApi("UpdatePlayerStatistics", { PlayFabId: playfabid, Statistics: stats });
}

async function getcatalogitems(catalogversion) {
  return serverApi("GetCatalogItems", { CatalogVersion: catalogversion || "DLC" });
}

// Cached bundle items fetch (avoids rate limits)
let _bundleCache = { items: null, at: 0 };
async function getBundleItems(bundleName) {
  const now = Date.now();
  if (_bundleCache.items && now - _bundleCache.at < 300000) return _bundleCache.items;
  try {
    const cat = await getcatalogitems("DLC");
    const items = cat?.data?.data?.Catalog || [];
    const bundle = items.find(i => i.ItemId === bundleName);
    _bundleCache = { items: bundle?.Bundle?.BundledItems || [], at: now };
  } catch (e) { /* stale cache */ }
  return _bundleCache.items || [];
}

async function getstoreitems(storeid, catalogversion) {
  return serverApi("GetStoreItems", { StoreId: storeid, CatalogVersion: catalogversion || "DLC" });
}

async function gettitleinternaldata() {
  return serverApi("GetTitleInternalData", {});
}

async function getpublisherdata() {
  return serverApi("GetPublisherData", { Keys: null });
}

async function setpublisherdata(data) {
  return serverApi("SetPublisherData", { Data: data || {} });
}

async function gettime() {
  return serverApi("GetTime", {});
}

// ─── Admin APIs ───────────────────────────────────────────────
async function adminGetUserAccountInfo(playfabid) {
  return adminApi("GetUserAccountInfo", { PlayFabId: playfabid });
}

async function adminGetPlayerProfile(playfabid) {
  return adminApi("GetPlayerProfile", {
    PlayFabId: playfabid,
    ProfileConstraints: { ShowDisplayName: true, ShowAvatarUrl: true, ShowContactEmailAddresses: true },
  });
}

async function adminGetUserInventory(playfabid) {
  return adminApi("GetUserInventory", { PlayFabId: playfabid });
}

async function adminGetUserBans(playfabid) {
  return adminApi("GetUserBans", { PlayFabId: playfabid });
}

async function adminBanUsers(players, reason, durationHours) {
  const bans = players.map(id => ({ PlayFabId: id, Reason: reason || "Banned by admin", DurationInHours: durationHours || 0 }));
  return adminApi("BanUsers", { Bans: bans });
}

async function adminRevokeAllBans(userid) {
  return adminApi("RevokeAllBansForUser", { PlayFabId: userid });
}

async function adminRevokeBans(banIds) {
  return adminApi("RevokeBans", { Bans: banIds });
}

async function adminUpdateBans(bans) {
  return adminApi("UpdateBans", { Bans: bans });
}

async function adminAddVirtualCurrency(playfabid, amount, currency) {
  return adminApi("AddUserVirtualCurrency", {
    PlayFabId: playfabid, Amount: amount, VirtualCurrency: currency || "SI",
  });
}

async function adminSubtractVirtualCurrency(playfabid, amount, currency) {
  return adminApi("SubtractUserVirtualCurrency", {
    PlayFabId: playfabid, Amount: amount, VirtualCurrency: currency || "SI",
  });
}

async function adminGrantItemsToUsers(playfabids, itemids, catalogversion) {
  const grants = playfabids.map(id => ({ PlayFabId: id, ItemIds: itemids }));
  return adminApi("GrantItemsToUsers", { CatalogVersion: catalogversion || "DLC", ItemGrants: grants });
}

async function adminRevokeInventoryItems(playfabid, instanceids) {
  const r = await adminApi("RevokeInventoryItems", {
    Items: instanceids.map(id => ({ PlayFabId: playfabid, ItemInstanceId: id })),
  });
  return r;
}

async function adminRevokeInventoryItem(playfabid, instanceid) {
  return adminRevokeInventoryItems(playfabid, [instanceid]);
}

async function adminDeletePlayer(playfabid) {
  return adminApi("DeletePlayer", { PlayFabId: playfabid });
}

async function adminResetPassword(playfabid, password) {
  return adminApi("ResetPassword", { PlayFabId: playfabid, Password: password });
}

async function adminGetUserData(playfabid, keys) {
  return adminApi("GetUserData", { PlayFabId: playfabid, Keys: keys || null });
}

async function adminUpdateUserData(playfabid, data, permission) {
  return adminApi("UpdateUserData", {
    PlayFabId: playfabid, Data: data || {}, Permission: permission || "Public",
  });
}

async function adminGetUserInternalData(playfabid, keys) {
  return adminApi("GetUserInternalData", { PlayFabId: playfabid, Keys: keys || null });
}

async function adminUpdateUserInternalData(playfabid, data) {
  return adminApi("UpdateUserInternalData", { PlayFabId: playfabid, Data: data || {} });
}

async function adminGetPlayedTitleList(playfabid) {
  return adminApi("GetPlayedTitleList", { PlayFabId: playfabid });
}

async function adminUpdateTitleDisplayName(playfabid, displayname) {
  return adminApi("UpdateUserTitleDisplayName", { PlayFabId: playfabid, DisplayName: displayname });
}

async function adminExportMasterPlayerData(playfabid) {
  return adminApi("ExportMasterPlayerData", { PlayFabId: playfabid });
}

// ─── Shared Group Data (existing, keep for compat) ───────────
async function getsharedgroupdata(sharedgroupid, keys) {
  return serverApi("GetSharedGroupData", {
    SharedGroupId: sharedgroupid, Keys: keys || null,
  });
}

async function createsharedgroup(sharedgroupid) {
  return serverApi("CreateSharedGroup", { SharedGroupId: sharedgroupid });
}

async function updatesharedgroupdata(sharedgroupid, data, permission, keysToRemove) {
  return serverApi("UpdateSharedGroupData", {
    SharedGroupId: sharedgroupid,
    Data: data || {},
    Permission: permission || "Public",
    KeysToRemove: keysToRemove || null,
  });
}

async function addsharedgroupmembers(sharedgroupid, playfabids) {
  return serverApi("AddSharedGroupMembers", {
    SharedGroupId: sharedgroupid, PlayFabIds: playfabids,
  });
}

async function removesaredgroupmembers(sharedgroupid, playfabids) {
  return serverApi("RemoveSharedGroupMembers", {
    SharedGroupId: sharedgroupid, PlayFabIds: playfabids,
  });
}

async function deletesharedgroup(sharedgroupid) {
  return serverApi("DeleteSharedGroup", { SharedGroupId: sharedgroupid });
}

async function setitledata(key, value) {
  return serverApi("SetTitleData", { Key: key, Value: value });
}

async function settitleinternaldata(key, value) {
  return serverApi("SetTitleInternalData", { Key: key, Value: value });
}

async function grantitemstouser(playfabid, itemids, catalogversion) {
  return serverApi("GrantItemsToUser", {
    PlayFabId: playfabid, ItemIds: itemids, CatalogVersion: catalogversion || "DLC",
  });
}

async function grantitemstousers(playfabids, itemids, catalogversion) {
  const grants = playfabids.map(id => ({ PlayFabId: id, ItemIds: itemids }));
  return serverApi("GrantItemsToUsers", { CatalogVersion: catalogversion || "DLC", ItemGrants: grants });
}

async function evaluateRandomResultTable(playfabid, tableid, catalogversion) {
  return serverApi("EvaluateRandomResultTable", {
    PlayFabId: playfabid, TableId: tableid, CatalogVersion: catalogversion || "DLC",
  });
}

module.exports = {
  serverlogin,
  getuseraccountinfo,
  gettitledata,
  getplayerprofile,
  getuserinventory,
  getplayercombinedinfo,
  addvirtualcurrency,
  subtractvirtualcurrency,
  getuserbans,
  banusers,
  revokeallbans,
  revokeinventoryitem,
  revokeinventoryitems,
  getuserdata,
  getuserinternaldata,
  getuserreadonlydata,
  updateuserdata,
  updateuserinternaldata,
  getplayerstatistics,
  updateplayerstatistics,
  getcatalogitems,
  getstoreitems,
  gettitleinternaldata,
  getpublisherdata,
  setpublisherdata,
  gettime,
  setitledata,
  settitleinternaldata,
  grantitemstouser,
  grantitemstousers,
  evaluateRandomResultTable,
  getsharedgroupdata,
  createsharedgroup,
  updatesharedgroupdata,
  addsharedgroupmembers,
  removesaredgroupmembers,
  deletesharedgroup,
  // Admin APIs
  adminGetUserAccountInfo,
  adminGetPlayerProfile,
  adminGetUserInventory,
  adminGetUserBans,
  adminBanUsers,
  adminRevokeAllBans,
  adminRevokeBans,
  adminUpdateBans,
  adminAddVirtualCurrency,
  adminSubtractVirtualCurrency,
  adminGrantItemsToUsers,
  adminRevokeInventoryItems,
  adminRevokeInventoryItem,
  adminDeletePlayer,
  adminResetPassword,
  adminGetUserData,
  adminUpdateUserData,
  adminGetUserInternalData,
  adminUpdateUserInternalData,
  adminGetPlayedTitleList,
  adminUpdateTitleDisplayName,
  adminExportMasterPlayerData,
  getBundleItems,
};
