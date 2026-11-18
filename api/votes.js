/* GET /api/votes?day=<utcDayIndex>&voter=<address?>
 * Returns { day, tallies: { candidate: count }, myVote: candidate | null }.
 */
const { ADDR_RE, kv } = require("./_lib");

module.exports = async (req, res) => {
  if (req.method !== "GET") return res.status(405).json({ error: "method" });
  if (!kv.configured()) return res.status(501).json({ error: "not_configured" });

  const day = parseInt((req.query || {}).day, 10);
  const voter = ((req.query || {}).voter || "").toLowerCase();
  if (!Number.isInteger(day)) return res.status(400).json({ error: "bad_request" });

  try {
    const flat = (await kv.cmd(["HGETALL", "votes:" + day])) || [];
    const tallies = {};
    for (let i = 0; i + 1 < flat.length; i += 2) tallies[flat[i]] = Number(flat[i + 1]);
    let myVote = null;
    if (ADDR_RE.test(voter)) {
      myVote = (await kv.cmd(["HGET", "voted:" + day, voter])) || null;
    }
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ day, tallies, myVote });
  } catch (_) {
    return res.status(500).json({ error: "storage" });
  }
};
