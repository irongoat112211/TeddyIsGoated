const https = require("https");

function postrequest(hostname, path, body, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const opts = {
      hostname,
      port: 443,
      path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
        ...headers,
      },
    };
    const req = https.request(opts, (res) => {
      let chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        let parsed = null;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = raw;
        }
        resolve({ status: res.statusCode, data: parsed, raw });
      });
    });
    req.on("error", reject);
    req.setTimeout(300000, () => {
      req.destroy(new Error("request timeout"));
    });
    req.write(data);
    req.end();
  });
}

function getrequest(hostname, path, headers) {
  if (typeof path !== "string") {
    const parsed = new URL(hostname);
    return getrequest(parsed.hostname, parsed.pathname + parsed.search);
  }
  return new Promise((resolve, reject) => {
    const opts = {
      hostname,
      port: 443,
      path,
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
    };
    const req = https.request(opts, (res) => {
      let chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        let parsed = null;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = raw;
        }
        resolve({ status: res.statusCode, data: parsed, raw });
      });
    });
    req.on("error", reject);
    req.setTimeout(300000, () => {
      req.destroy(new Error("request timeout"));
    });
    req.end();
  });
}

module.exports = { postrequest, getrequest };
