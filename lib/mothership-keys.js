const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const keydir = path.join(__dirname, "..");
const privatepath = path.join(keydir, "mothership-private.pem");
const publicpath = path.join(keydir, "mothership-public.pem");

function ensurekeys() {
  if (fs.existsSync(privatepath) && fs.existsSync(publicpath)) {
    return;
  }
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    privateKeyEncoding: { type: "sec1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  fs.writeFileSync(privatepath, privateKey);
  fs.writeFileSync(publicpath, publicKey);
  console.log("[mothership] generated new ES256 keypair");
}

ensurekeys();

const privatekey = fs.readFileSync(privatepath, "utf-8");
const publickey = fs.readFileSync(publicpath, "utf-8");

module.exports = { privatekey, publickey };
