function sanitizestr(val, maxlen) {
  if (typeof val !== "string") return "";
  return val.slice(0, maxlen || 512).replace(/[^\x20-\x7E]/g, "");
}

function requirefields(body, fields) {
  const missing = [];
  for (const f of fields) {
    if (body[f] === undefined || body[f] === null || body[f] === "") {
      missing.push(f);
    }
  }
  return missing;
}

function validateplayfabid(id) {
  if (typeof id !== "string") return false;
  return /^[A-F0-9]{16}$/i.test(id);
}

function validatemothershiptoken(token) {
  if (typeof token !== "string") return false;
  return token.length > 0 && token.length <= 4096;
}

function validateplatform(platform) {
  return platform === "Quest" || platform === "PC";
}

module.exports = {
  sanitizestr,
  requirefields,
  validateplayfabid,
  validatemothershiptoken,
  validateplatform,
};
