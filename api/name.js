/* StillAlive shared Agent ID name index.
 *
 * Why this exists: the Agent ID contract is not enumerable and public BSC
 * RPC endpoints refuse the eth_getLogs ranges needed to scan mint events,
 * so a browser cannot reliably resolve wallet -> .ai name on its own.
 * This endpoint keeps a shared, permanent index in KV (hash "names":
 * lowercase address -> JSON {name, image}). Browsers read it in one call;
 * anyone may contribute a pair, but a pair is only stored after an
 * on-chain proof: the SPACE ID metadata for the label embeds its tokenId,
 * and ownerOf(tokenId) must equal the claimed address. A name can
 * therefore never be attached to a wallet that does not own it.
 *
 * GET  /api/name?addresses=0x..,0x..   -> { names: { addr: {name, image} } }
 * POST /api/name { address, name }     -> { ok: true } after verification
 */
const { JsonRpcProvider, Contract } = require("ethers");
const { ADDR_RE, kv } = require("./_lib");

const AGENTID_ADDRESS =
  process.env.AGENTID_ADDRESS || "0x60b9262456de011f7d15a54cdd8c48baaa8b022f";
const RPC_URL = process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org";
const NAME_RE = /^[a-z0-9][a-z0-9-_]*\.ai$/;

let _provider = null;
function provider() {
  if (!_provider) _provider = new JsonRpcProvider(RPC_URL);
  return _provider;
}

/* Verify on-chain that `address` owns the Agent ID `name` (label + ".ai").
 * Returns { ok, image } — ok=false means the pair is provably wrong;
 * throws on network/RPC failure so the caller can fail closed. */
async function verifyOwnership(address, name) {
  const label = name.slice(0, -3); // strip ".ai"
  const res = await fetch(
    "https://agentid.prd.space.id/metadata/" + encodeURIComponent(label) + ".json"
  );
  if (res.status === 404) return { ok: false };
  if (!res.ok) throw new Error("metadata_http_" + res.status);
  const meta = await res.json();
  const m = String((meta && meta.image) || "").match(/\/(\d{10,})\//);
  if (!m) return { ok: false };
  const c = new Contract(
    AGENTID_ADDRESS,
    ["function ownerOf(uint256) view returns (address)"],
    provider()
  );
  const owner = await c.ownerOf(BigInt(m[1]));
  return { ok: owner && owner.toLowerCase() === address.toLowerCase(), image: meta.image || null };
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (!kv.configured()) {
    res.status(501).json({ error: "not_configured" });
    return;
  }
  try {
    if (req.method === "GET") {
      const raw = String((req.query && req.query.addresses) || "");
      const addrs = raw
        .split(",")
        .map((a) => a.trim().toLowerCase())
        .filter((a) => ADDR_RE.test(a))
        .slice(0, 25);
      if (!addrs.length) {
        res.status(400).json({ error: "bad_addresses" });
        return;
      }
      const values = await kv.cmd(["HMGET", "names", ...addrs]);
      const names = {};
      addrs.forEach((a, i) => {
        if (values && values[i]) {
          try {
            const v = JSON.parse(values[i]);
            if (v && v.name) names[a] = { name: v.name, image: v.image || null };
          } catch (_) {}
        }
      });
      res.status(200).json({ names });
      return;
    }
    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      const address = String(body.address || "").trim().toLowerCase();
      const name = String(body.name || "").trim().toLowerCase();
      if (!ADDR_RE.test(address) || !NAME_RE.test(name)) {
        res.status(400).json({ error: "bad_input" });
        return;
      }
      // Idempotent fast path: already indexed with the same name.
      const existing = await kv.cmd(["HGET", "names", address]);
      if (existing) {
        try {
          if (JSON.parse(existing).name === name) {
            res.status(200).json({ ok: true, cached: true });
            return;
          }
        } catch (_) {}
      }
      let verdict;
      try {
        verdict = await verifyOwnership(address, name);
      } catch (_) {
        res.status(502).json({ error: "verify_failed" });
        return;
      }
      if (!verdict.ok) {
        res.status(403).json({ error: "owner_mismatch" });
        return;
      }
      await kv.cmd(["HSET", "names", address, JSON.stringify({ name, image: verdict.image })]);
      res.status(200).json({ ok: true });
      return;
    }
    res.status(405).json({ error: "method_not_allowed" });
  } catch (_) {
    res.status(500).json({ error: "server_error" });
  }
};
