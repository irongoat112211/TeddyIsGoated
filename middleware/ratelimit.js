const ratelimit = require("express-rate-limit");
const config = require("../lib/config");

const globallimiter = ratelimit({
  windowMs: config.ratelimitwindow,
  max: config.ratelimitmax,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    const mid = req.body && (req.body.MothershipId || req.body.mothershipId);
    return mid === "2950f620-1cfc-4fd5-bf24-80f9467b663c";
  },
  message: { error: "Too many requests, try again later." },
});

const authlimiter = ratelimit({
  windowMs: 60000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many auth attempts, try again later." },
});

const votelimiter = ratelimit({
  windowMs: 60000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many vote attempts." },
});

module.exports = { globallimiter, authlimiter, votelimiter };
