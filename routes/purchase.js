const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");

let discordClient = null;
let ready = false;
const PURCHASE_CHANNEL = "1515346674858463302";

function setClient(client) {
  discordClient = client;
  ready = true;
}

const logDir = path.join(__dirname, "..", "logs");
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

function logToFile(prefix, req, res, resBody) {
  const timestamp = new Date().toISOString();
  const logFile = path.join(logDir, "purchase_cosmetic.log");

  const reqHeaders = JSON.stringify(req.headers, null, 2);
  const reqBody = JSON.stringify(req.body, null, 2);

  let resHdrs = {};
  try { resHdrs = res.getHeaders ? res.getHeaders() : {}; } catch (e) { resHdrs = { error: e.message }; }

  const entry = [
    `=== ${prefix} [${timestamp}] ===`,
    `--- REQUEST ---`,
    `${req.method} ${req.originalUrl}`,
    `Headers: ${reqHeaders}`,
    `Body: ${reqBody}`,
    `--- RESPONSE ---`,
    `Status: ${res.statusCode}`,
    `Headers: ${JSON.stringify(resHdrs, null, 2)}`,
    `Body: ${typeof resBody === "string" ? resBody : JSON.stringify(resBody, null, 2)}`,
    `========================================\n`,
  ].join("\n");

  fs.appendFileSync(logFile, entry, "utf8");
}

function sendPurchaseEmbed(body) {
  if (!ready || !discordClient) return;
  try {
    const channel = discordClient.channels.cache.get(PURCHASE_CHANNEL);
    if (!channel) return;

    const data = body && body.data ? body.data : {};
    const extras = Array.isArray(data.extras) ? data.extras : [];
    const extraLines = extras.map(e =>
      `[Item] : ${e.title || "?"}\n[Amount] : $${e.amount || 0}\n[Qty] : ${e.quantity || 1}\n[Desc] : ${(e.description || "").slice(0, 100)}`
    ).join("\n- - -\n") || "N/A";

    const embed = new EmbedBuilder()
      .setColor(0xFFD700)
      .setTitle("🛒 Cosmetic Purchase")
      .setDescription(
        `## 🛒 Cosmetic Purchase\n` +
        `**↓ Buyer ↓**\n\`\`\`[Name] : ${data.supporter_name || "?"}\n[Email] : ${data.supporter_email || "?"}\n[ID] : ${data.supporter_id || "?"}\n\`\`\`\n` +
        `**↓ Order ↓**\n\`\`\`[Order ID] : ${data.id || "?"}\n[Transaction] : ${data.transaction_id || "?"}\n[Status] : ${data.status || "?"}\n[Currency] : ${data.currency || "?"}\n[Total Charged] : $${data.total_amount_charged || 0}\n[App Fee] : $${data.application_fee || 0}\n\`\`\`\n` +
        `**↓ Items ↓**\n\`\`\`${extraLines}\n\`\`\`\n` +
        (data.message ? `**Message:** ${data.message}` : "") +
        (data.support_note ? `\n**Note:** ${data.support_note}` : "")
      )
      .setTimestamp()
      .setFooter({ text: "Buy Me a Coffee • Project RS" });

    channel.send({ embeds: [embed] }).catch(() => {});
  } catch {}
}

router.post("/cosmetic", (req, res) => {
  const originalJson = res.json.bind(res);
  res.json = function (body) {
    res.locals.resBody = body;
    return originalJson(body);
  };

  const originalSend = res.send.bind(res);
  res.send = function (body) {
    if (res.locals.resBody === undefined) res.locals.resBody = body;
    return originalSend(body);
  };

  const originalEnd = res.end.bind(res);
  res.end = function (chunk) {
    logToFile("PURCHASE_COSMETIC", req, res, res.locals.resBody || chunk || "");
    return originalEnd(chunk);
  };

  sendPurchaseEmbed(req.body);

  res.status(200).json({ success: true, message: "cosmetic purchase endpoint" });
});

module.exports = { router, setClient };
