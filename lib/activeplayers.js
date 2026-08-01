const lastSeen = new Map();

function seen(mothershipid) {
  if (mothershipid) lastSeen.set(mothershipid, Date.now());
}

function count(windowMinutes = 5) {
  const cutoff = Date.now() - windowMinutes * 60 * 1000;
  let n = 0;
  for (const ts of lastSeen.values()) {
    if (ts >= cutoff) n++;
  }
  return n;
}

setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, ts] of lastSeen.entries()) {
    if (ts < cutoff) lastSeen.delete(id);
  }
}, 10 * 60 * 1000);

module.exports = { seen, count };
