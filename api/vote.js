/* POST /api/vote — cast today's vote for the best agent report on the wall.
 * Body: { voter, candidate, day, signature }
 * The signature is the voter's wallet signing voteMessage(day, candidate).
 */
const { verifyMessage } = require("ethers");
const { ADDR_RE, kv, isHolder, hasSignedOn, voteMessage } = require("./_lib");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "method" });
  if (!kv.configured()) return res.status(501).json({ error: "not_configured" });

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (_) {
      body = null;
    }
  }
  const { voter, candidate, day, signature } = body || {};
  if (
    !ADDR_RE.test(voter || "") ||
    !ADDR_RE.test(candidate || "") ||
    !Number.isInteger(day) ||
    typeof signature !== "string"
  ) {
    return res.status(400).json({ error: "bad_request" });
  }

  // Accept votes for today, and for yesterday if they were signed just
  // before the UTC midnight boundary and landed just after it.
  const serverToday = Math.floor(Date.now() / 86400000);
  if (day !== serverToday && day !== serverToday - 1) {
    return res.status(400).json({ error: "wrong_day" });
  }
  if (voter.toLowerCase() === candidate.toLowerCase()) {
    return res.status(400).json({ error: "self_vote" });
  }

  let recovered;
  try {
    recovered = verifyMessage(voteMessage(day, candidate), signature);
  } catch (_) {
    return res.status(401).json({ error: "bad_signature" });
  }
  if (!recovered || recovered.toLowerCase() !== voter.toLowerCase()) {
    return res.status(401).json({ error: "bad_signature" });
  }

  if (!(await isHolder(voter))) return res.status(403).json({ error: "not_holder" });
  if (!(await hasSignedOn(candidate, day))) return res.status(403).json({ error: "not_signed" });

  const voterLc = voter.toLowerCase();
  const candidateLc = candidate.toLowerCase();
  try {
    const first = await kv.cmd(["HSETNX", "voted:" + day, voterLc, candidateLc]);
    if (first !== 1) return res.status(409).json({ error: "already_voted" });
    const count = await kv.cmd(["HINCRBY", "votes:" + day, candidateLc, 1]);
    // Best-effort tidy-up: tallies only matter for their own day.
    kv.cmd(["EXPIRE", "votes:" + day, 60 * 60 * 24 * 4]).catch(() => {});
    kv.cmd(["EXPIRE", "voted:" + day, 60 * 60 * 24 * 4]).catch(() => {});
    return res.status(200).json({ ok: true, candidate: candidateLc, votes: count });
  } catch (_) {
    return res.status(500).json({ error: "storage" });
  }
};
