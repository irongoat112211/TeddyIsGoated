const path = require("path");
const fs = require("fs");

function loadenv() {
  const envpath = path.join(__dirname, "..", ".env");
  if (fs.existsSync(envpath)) {
    const lines = fs.readFileSync(envpath, "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqidx = trimmed.indexOf("=");
      if (eqidx === -1) continue;
      const key = trimmed.slice(0, eqidx).trim();
      const val = trimmed.slice(eqidx + 1).trim();
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

loadenv();

const config = {
  playfabtitleid: process.env.PLAYFAB_TITLE_ID || "",
  playfabsecretkey: process.env.PLAYFAB_SECRET_KEY || "",
  metaaccesstoken: process.env.META_ACCESS_TOKEN || "",
  mothershiptitleid: process.env.MOTHERSHIP_TITLE_ID || "f3e9fb19",
  mothershipenvid: process.env.MOTHERSHIP_ENV_ID || "7f3a99dd-5598-4725-98cf-6538d28feb9f",
  mothershipdeploymentid: process.env.MOTHERSHIP_DEPLOYMENT_ID || "837c4e80-a36c-49aa-bbde-18a5fa32bb3d",
  port: parseInt(process.env.PORT, 10) || 3067,
  host: process.env.HOST || "0.0.0.0",
  ratelimitwindow: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60000,
  ratelimitmax: parseInt(process.env.RATE_LIMIT_MAX, 10) || 300,
  dnsredirectip: process.env.DNS_REDIRECT_IP || "",
  discordwebhook: process.env.DISCORD_WEBHOOK || "",
  discord_login: process.env.DISCORD_LOGIN || "",
  discord_rooms: process.env.DISCORD_ROOMS || "",
  discord_ghostreactor: process.env.DISCORD_GHOSTREACTOR || "",
  discord_purchases: process.env.DISCORD_PURCHASES || "",
  discord_reports: process.env.DISCORD_REPORTS || "",
  discord_misc: process.env.DISCORD_MISC || "",
  discord_dearlemming: process.env.DISCORD_DEARLEMMING || "",
  admin_discord_ids: (process.env.ADMIN_DISCORD_IDS || "").split(",").map(s => s.trim()).filter(Boolean),
  discord_client_id: process.env.DISCORD_CLIENT_ID || "",
  discord_client_secret: process.env.DISCORD_CLIENT_SECRET || "",
  discord_bot_token: process.env.DISCORD_BOT_TOKEN || "",
  discord_guild_id: process.env.DISCORD_GUILD_ID || "",
  discord_role_panel: process.env.DISCORD_ROLE_PANEL || "",
  discord_role_ban: process.env.DISCORD_ROLE_BAN || "",
  discord_role_playfab: process.env.DISCORD_ROLE_PLAYFAB || "",
  discord_count_channel: process.env.DISCORD_COUNT_CHANNEL || "",
  discord_count_msg_channel: process.env.DISCORD_COUNT_MSG_CHANNEL || "",
  discord_monke_channel: process.env.DISCORD_MONKE_CHANNEL || "",
  event_log_dir: process.env.EVENT_LOG_DIR || path.join(__dirname, "..", "eventlogs"),
  session_secret: process.env.SESSION_SECRET || require("crypto").randomBytes(32).toString("hex"),
};

module.exports = config;
