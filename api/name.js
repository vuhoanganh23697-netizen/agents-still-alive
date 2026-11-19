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
 *
 * On a GET miss, the endpoint also auto-scans an NFT indexer for the
 * address's Agent ID transfer — the mint shows up there as a transfer
 * from 0x000...000 — takes its tokenId, resolves the label via
 * tokenURI(), re-verifies ownerOf(), and caches the pair in KV forever.
 * Two providers are supported, tried in order:
 *   1. Moralis (MORALIS_API_KEY) — free tier covers BSC.
 *   2. Etherscan v2 / BscScan (BSCSCAN_API_KEY) — note: BSC is behind a
 *      paid plan there since 2025, so free keys return NOTOK and this
 *      path simply stays unavailable.
 * Without any key, misses simply stay misses. A definitive "not a
 * holder" answer is negative-cached for 24h.
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

const EXPLORER_KEY = process.env.BSCSCAN_API_KEY || process.env.ETHERSCAN_API_KEY || "";
const EXPLORER_BASE = process.env.BSCSCAN_API_BASE || "https://api.etherscan.io/v2/api";

async function labelFromTokenId(tokenId) {
  const c = new Contract(
    AGENTID_ADDRESS,
    ["function tokenURI(uint256) view returns (string)"],
    provider()
  );
  const uri = await c.tokenURI(tokenId);
  const m = String(uri).match(/\/([^/]+)\.json(?:\?.*)?$/);
  if (!m) return null;
  const label = decodeURIComponent(m[1]);
  let image = null;
  try {
    const r = await fetch(uri);
    if (r.ok) {
      const meta = await r.json();
      if (meta && meta.image) image = meta.image;
    }
  } catch (_) {}
  return { name: label + ".ai", image };
}

/* Auto-scan one address on BscScan. Returns:
 *   { name, image }  found and owner-verified
 *   null             definitively not an Agent ID holder
 *   undefined        scan unavailable (no key / API error) — do not cache */
async function scanViaExplorer(address) {
  if (!EXPLORER_KEY) return undefined;
  const url =
    EXPLORER_BASE +
    "?chainid=56&module=account&action=tokennfttx&contractaddress=" +
    AGENTID_ADDRESS +
    "&address=" +
    address +
    "&page=1&offset=10&sort=asc&apikey=" +
    EXPLORER_KEY;
  let data;
  try {
    const r = await fetch(url);
    data = await r.json();
  } catch (_) {
    return undefined;
  }
  if (!data || !Array.isArray(data.result)) {
    if (data && data.message === "No transactions found") return null;
    return undefined;
  }
  const hit = data.result.find((t) => String(t.to || "").toLowerCase() === address.toLowerCase());
  if (!hit) return null;
  try {
    const info = await labelFromTokenId(BigInt(hit.tokenID));
    if (!info) return null;
    const c = new Contract(
      AGENTID_ADDRESS,
      ["function ownerOf(uint256) view returns (address)"],
      provider()
    );
    const owner = await c.ownerOf(BigInt(hit.tokenID));
    if (!owner || owner.toLowerCase() !== address.toLowerCase()) return null;
    return info;
  } catch (_) {
    return undefined;
  }
}

const MORALIS_KEY = process.env.MORALIS_API_KEY || "";
const MORALIS_BASE = process.env.MORALIS_API_BASE || "https://deep-index.moralis.io/api/v2.2";

/* Same tri-state contract as scanViaExplorer. */
async function scanViaMoralis(address) {
  if (!MORALIS_KEY) return undefined;
  let data;
  try {
    const r = await fetch(
      MORALIS_BASE + "/" + address + "/nft/transfers?chain=bsc&format=decimal&limit=100",
      { headers: { "X-API-Key": MORALIS_KEY, accept: "application/json" } }
    );
    if (r.status === 401 || r.status === 403) return undefined;
    data = await r.json();
  } catch (_) {
    return undefined;
  }
  if (!data || !Array.isArray(data.result)) return undefined;
  const hit = data.result.find(
    (t) =>
      String(t.token_address || "").toLowerCase() === AGENTID_ADDRESS.toLowerCase() &&
      String(t.to_address || "").toLowerCase() === address.toLowerCase()
  );
  if (!hit) {
    // Moralis returns the wallet's transfers across all contracts; an
    // empty page is a definitive "no transfers at all". A page without
    // an Agent ID hit may just be truncated — treat as inconclusive
    // unless the wallet has no transfers whatsoever.
    return data.result.length === 0 ? null : undefined;
  }
  try {
    const info = await labelFromTokenId(BigInt(hit.token_id));
    if (!info) return null;
    const c = new Contract(
      AGENTID_ADDRESS,
      ["function ownerOf(uint256) view returns (address)"],
      provider()
    );
    const owner = await c.ownerOf(BigInt(hit.token_id));
    if (!owner || owner.toLowerCase() !== address.toLowerCase()) return null;
    return info;
  } catch (_) {
    return undefined;
  }
}

/* Try each indexer in order; first conclusive answer wins. */
async function scanAddress(address) {
  const viaMoralis = await scanViaMoralis(address).catch(() => undefined);
  if (viaMoralis !== undefined) return viaMoralis;
  return scanViaExplorer(address).catch(() => undefined);
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
      const missing = [];
      addrs.forEach((a, i) => {
        let entry = null;
        if (values && values[i]) {
          try {
            entry = JSON.parse(values[i]);
          } catch (_) {}
        }
        if (entry && entry.name) {
          names[a] = { name: entry.name, image: entry.image || null };
        } else if (!(entry && entry.ts && Date.now() - entry.ts < 86400000)) {
          missing.push(a);
        }
      });
      // Auto-scan a few unknown addresses per call; results are cached in
      // KV forever, so each address is scanned at most once, ever.
      let scans = 0;
      for (const a of missing) {
        if (scans >= 3) break;
        scans++;
        const found = await scanAddress(a);
        if (found && found.name) {
          names[a] = found;
          await kv.cmd(["HSET", "names", a, JSON.stringify(found)]);
        } else if (found === null) {
          await kv.cmd(["HSET", "names", a, JSON.stringify({ name: null, ts: Date.now() })]);
        }
      }
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
