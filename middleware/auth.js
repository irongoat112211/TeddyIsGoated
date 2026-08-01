const jwt = require("jsonwebtoken");
const { publickey } = require("../lib/mothership-keys");

function requiremothershiptoken(req, res, next) {
  const token = req.headers["x-mothership-token"];
  if (!token) {
    req.mothershipid = "";
    req.mothershippayload = null;
    return next();
  }
  try {
    const decoded = jwt.verify(token, publickey, { algorithms: ["ES256"] });
    req.mothershipid = decoded.sub || "";
    req.mothershippayload = decoded;
    require("../lib/activeplayers").seen(req.mothershipid);
  } catch {
    req.mothershipid = "";
    req.mothershippayload = null;
  }
  next();
}

function requireauth(req, res, next) {
  const token = req.headers["x-mothership-token"];
  if (!token) {
    return res.status(401).json({ error: "Missing auth token" });
  }
  try {
    const decoded = jwt.verify(token, publickey, { algorithms: ["ES256"] });
    req.mothershipid = decoded.sub || "";
    req.mothershippayload = decoded;
    require("../lib/activeplayers").seen(req.mothershipid);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid auth token" });
  }
}

module.exports = { requiremothershiptoken, requireauth };
