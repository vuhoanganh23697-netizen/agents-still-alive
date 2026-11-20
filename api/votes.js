/* GET /api/votes?day=<utcDayIndex>&voter=<address?>
 * Returns { day, tallies: { candidate: count }, myVote: candidate | null }.
 */
const { ADDR_RE, kv } = require("./_lib");

module.exports = async (req, res) => {
  if (req.method !== "GET") return res.status(405).json({ error: "method" });
  if (!kv.configured()) return res.status(501).json({ error: "not_configured" });

  // Lifetime total for one address (Top Report NFT progress): GET ?total=<addr>
  const totalAddr = ((req.query || {}).total || "").toLowerCase();
  if (ADDR_RE.test(totalAddr)) {
    try {
      let total = await kv.cmd(["HGET", "votes_total", totalAddr]);
      if (total === null || total === undefined) {
        // First read: seed the lifetime counter from the daily tallies still
        // inside their 4-day window (covers every vote cast since launch).
        const today = Math.floor(Date.now() / 86400000);
        let sum = 0;
        for (const d of [today, today - 1, today - 2, today - 3]) {
          const v = await kv.cmd(["HGET", "votes:" + d, totalAddr]);
          if (v) sum += Number(v);
        }
        await kv.cmd(["HSET", "votes_total", totalAddr, sum]);
        total = sum;
      }
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ address: totalAddr, total: Number(total) });
    } catch (_) {
      return res.status(500).json({ error: "storage" });
    }
  }

  // Full lifetime table — used at the end of the event to rank every agent
  // by total votes received and award the Top Vote prize: GET ?totals=1
  if ((req.query || {}).totals) {
    try {
      const flat = (await kv.cmd(["HGETALL", "votes_total"])) || [];
      const totals = {};
      for (let i = 0; i + 1 < flat.length; i += 2) totals[flat[i]] = Number(flat[i + 1]);
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ totals });
    } catch (_) {
      return res.status(500).json({ error: "storage" });
    }
  }

  const day = parseInt((req.query || {}).day, 10);
  const voter = ((req.query || {}).voter || "").toLowerCase();
  if (!Number.isInteger(day)) return res.status(400).json({ error: "bad_request" });

  try {
    const flat = (await kv.cmd(["HGETALL", "votes:" + day])) || [];
    const tallies = {};
    for (let i = 0; i + 1 < flat.length; i += 2) tallies[flat[i]] = Number(flat[i + 1]);
    let myVote = null;
    let myVotes = [];
    if (ADDR_RE.test(voter)) {
      const raw = (await kv.cmd(["HGET", "voted:" + day, voter])) || null;
      if (raw) {
        myVotes = String(raw).split(",").filter(Boolean);
        myVote = myVotes[0] || null;
      }
    }
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ day, tallies, myVote, myVotes });
  } catch (_) {
    return res.status(500).json({ error: "storage" });
  }
};
