/* POST /api/vote — cast today's vote for the best agent report on the wall.
 * Body: { voter, candidate, day, signature }
 * The signature is the voter's wallet signing voteMessage(day, candidate).
 * Any connected wallet may vote — holding an Agent ID is NOT required.
 */
const { verifyMessage } = require("ethers");
const { ADDR_RE, kv, hasSignedOn, voteMessage } = require("./_lib");

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

  // Any wallet may vote (product decision 2026-11-19) — no Agent ID needed.
  // The remaining gates: valid signature, no self-vote, the candidate must
  // have signed that day, and up to 3 votes per wallet per day — each for a
  // different agent (product decision 2026-11-20). The voter's picks live in
  // voted:<day> as a comma-separated list (older 1-vote values read as a
  // one-item list, so the change is backward compatible).
  if (!(await hasSignedOn(candidate, day))) return res.status(403).json({ error: "not_signed" });

  const voterLc = voter.toLowerCase();
  const candidateLc = candidate.toLowerCase();
  try {
    const raw = await kv.cmd(["HGET", "voted:" + day, voterLc]);
    const mine = raw ? String(raw).split(",").filter(Boolean) : [];
    if (mine.includes(candidateLc)) return res.status(409).json({ error: "already_voted" });
    if (mine.length >= 3) return res.status(409).json({ error: "vote_limit" });
    mine.push(candidateLc);
    await kv.cmd(["HSET", "voted:" + day, voterLc, mine.join(",")]);
    const count = await kv.cmd(["HINCRBY", "votes:" + day, candidateLc, 1]);
    // Lifetime tally for the Top Report NFT (10 total votes) — never expires.
    await kv.cmd(["HINCRBY", "votes_total", candidateLc, 1]).catch(() => {});
    // Best-effort tidy-up: tallies only matter for their own day.
    kv.cmd(["EXPIRE", "votes:" + day, 60 * 60 * 24 * 4]).catch(() => {});
    kv.cmd(["EXPIRE", "voted:" + day, 60 * 60 * 24 * 4]).catch(() => {});
    return res.status(200).json({ ok: true, candidate: candidateLc, votes: count, votesLeft: 3 - mine.length });
  } catch (_) {
    return res.status(500).json({ error: "storage" });
  }
};
