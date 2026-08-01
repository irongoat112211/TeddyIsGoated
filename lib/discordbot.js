const https = require("https");
const config = require("./config");

function discordApi(path, method, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "discord.com",
      port: 443,
      path: `/api/v10${path}`,
      method: method || "GET",
      headers: {
        "Authorization": `Bot ${config.discord_bot_token}`,
        "Content-Type": "application/json",
      },
    };
    if (body) {
      const d = JSON.stringify(body);
      opts.headers["Content-Length"] = Buffer.byteLength(d);
    }
    const req = https.request(opts, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, data: d }); }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy());
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── Guild Member/Role checking ──────────────────────────────────

async function getMemberRoles(userId) {
  if (!config.discord_bot_token || !config.discord_guild_id) throw new Error("Bot token or guild ID not configured");
  const r = await discordApi(`/guilds/${config.discord_guild_id}/members/${userId}`);
  if (r.status === 200 && r.data && r.data.roles) return r.data.roles;
  if (r.status === 404) return [];
  if (r.status === 401) throw new Error("Invalid bot token (401). Get a bot token from the Bot page, not the application ID.");
  if (r.status === 403) throw new Error("Bot lacks permissions (403). Invite with 'Server Members Intent' enabled.");
  throw new Error(`Discord API returned ${r.status}`);
}

function checkPermission(userId, roleConfigKey) {
  const roleId = config[roleConfigKey];
  if (!roleId) return false;
  if (checkPermission._cache && checkPermission._cache.has(userId)) {
    const roles = checkPermission._cache.get(userId);
    if (Date.now() - roles.t > 300000) { checkPermission._cache.delete(userId); return false; }
    return roles.r.includes(roleId);
  }
  return false;
}

async function checkPermissionAsync(userId, roleConfigKey) {
  const roles = await getMemberRoles(userId);
  checkPermission._cache = checkPermission._cache || new Map();
  checkPermission._cache.set(userId, { r: roles, t: Date.now() });
  const roleId = config[roleConfigKey];
  return roleId ? roles.includes(roleId) : false;
}

async function getUserRoles(userId) {
  const roles = await getMemberRoles(userId);
  checkPermission._cache = checkPermission._cache || new Map();
  checkPermission._cache.set(userId, { r: roles, t: Date.now() });
  return roles;
}

// ─── Player Count Bot Features ───────────────────────────────────

// Send a message to a Discord channel
async function sendChannelMessage(channelId, content, embed) {
  if (!config.discord_bot_token) return;
  const body = {};
  if (content) body.content = content;
  if (embed) body.embeds = [embed];
  return discordApi(`/channels/${channelId}/messages`, "POST", body);
}

// Rename a voice channel to show player count
async function renameChannel(channelId, name) {
  if (!config.discord_bot_token || !channelId) return;
  return discordApi(`/channels/${channelId}`, "PATCH", { name: String(name).slice(0, 100) });
}

// Get approximate member count for a guild
async function getGuildMemberCount(guildId) {
  if (!guildId) guildId = config.discord_guild_id;
  if (!guildId || !config.discord_bot_token) return 0;
  const r = await discordApi(`/guilds/${guildId}?with_counts=true`);
  if (r.status === 200 && r.data) return r.data.approximate_member_count || 0;
  return 0;
}

// Register a slash command
async function registerSlashCommand(command) {
  if (!config.discord_bot_token || !config.discord_client_id) return;
  return discordApi(`/applications/${config.discord_client_id}/commands`, "POST", command);
}

// Get all slash commands
async function getSlashCommands() {
  if (!config.discord_bot_token || !config.discord_client_id) return [];
  const r = await discordApi(`/applications/${config.discord_client_id}/commands`);
  return r.status === 200 ? (r.data || []) : [];
}

// Delete a slash command
async function deleteSlashCommand(commandId) {
  if (!config.discord_bot_token || !config.discord_client_id) return;
  return discordApi(`/applications/${config.discord_client_id}/commands/${commandId}`, "DELETE");
}

// Build a webhook URL from ID + token
function webhookUrl(id, token) {
  return `https://discord.com/api/webhooks/${id}/${token}`;
}

// ─── Interaction helpers ──────────────────────────────────────────

// Edit an interaction follow-up message (for deferred responses)
async function editInteractionResponse(interactionToken, data) {
  if (!config.discord_client_id) return;
  return discordApi(`/webhooks/${config.discord_client_id}/${interactionToken}/messages/@original`, "PATCH", data);
}

module.exports = {
  getMemberRoles, getUserRoles, checkPermission, checkPermissionAsync, discordApi,
  sendChannelMessage, renameChannel, getGuildMemberCount,
  registerSlashCommand, getSlashCommands, deleteSlashCommand,
  editInteractionResponse,
};
