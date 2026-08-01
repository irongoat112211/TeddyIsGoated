const dns2 = require("dns2");
const { Packet } = dns2;

const REDIRECT_DOMAINS = [
  "ctag-cf.com",
  "playfabapi.com",
  "playfab.com",
  "exitgames.com",
  "photonengine.com",
];

function matches(name) {
  const n = name.toLowerCase().replace(/\.$/, "");
  return REDIRECT_DOMAINS.some((d) => n === d || n.endsWith("." + d));
}

async function forward(name, type) {
  try {
    const client = new dns2({ nameServers: ["8.8.8.8"] });
    const typestr = Object.keys(Packet.TYPE).find((k) => Packet.TYPE[k] === type) || "A";
    const res = await client.resolve(name, typestr);
    return res.answers || [];
  } catch {
    return [];
  }
}

function start(redirectip) {
  if (!redirectip) {
    console.warn("[dns] DNS_REDIRECT_IP not set — dns server disabled");
    return;
  }

  const server = dns2.createServer({
    udp: true,
    handle: async (request, send, rinfo) => {
      const response = Packet.createResponseFromRequest(request);
      const [q] = request.questions;
      if (!q) return send(response);

      const name = q.name;

      if (matches(name)) {
        console.log(`[dns] ${name} -> ${redirectip}`);
        response.answers.push({
          name,
          type: Packet.TYPE.A,
          class: Packet.CLASS.IN,
          ttl: 30,
          address: redirectip,
        });
        send(response);
      } else {
        response.answers = await forward(name, q.type);
        send(response);
      }
    },
  });

  server.on("error", (err) => {
    if (err.code === "EACCES") {
      console.error("[dns] port 53 requires admin/root — run server as Administrator");
    } else if (err.code === "EADDRINUSE") {
      console.error("[dns] port 53 already in use — disable system DNS or use a different port");
    } else {
      console.error("[dns] error:", err.message);
    }
  });

  server.listen({ udp: 53 });
  console.log(`[dns] listening on udp:53 — game domains -> ${redirectip}`);
}

module.exports = { start };
