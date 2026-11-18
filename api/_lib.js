/* Shared helpers for the StillAlive vote API (Vercel serverless functions).
 *
 * Votes are the one part of StillAlive that cannot live in the V1 contract
 * (it has no vote function), so they live here instead — with the same rules
 * the contract would have enforced, checked against the chain on every call:
 *   - the voter must hold a Binance Agent ID (balanceOf on the gate contract)
 *   - the candidate must have signed the wall that day (hasSignedOn)
 *   - one vote per voter per day, no self-votes, no switching
 * Authentication is a wallet signature (EIP-191) over a fixed message, so a
 * vote costs no gas and can only come from the wallet's owner.
 *
 * Storage is a Redis KV (Vercel KV / Upstash) over its REST API — no driver
 * dependency, just fetch. Keys are per UTC day and expire after 4 days:
 *   votes:<day>  hash  candidate -> tally
 *   voted:<day>  hash  voter     -> candidate
 */
const { JsonRpcProvider, Contract } = require("ethers");

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

const RPC_URL = process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org";
const STILLALIVE_ADDRESS =
  process.env.STILLALIVE_ADDRESS || "0x2f4dE45A01c4C9240C16c789A0F6a7dA77CB5635";
const AGENTID_ADDRESS =
  process.env.AGENTID_ADDRESS || "0x60b9262456de011f7d15a54cdd8c48baaa8b022f";

let _provider = null;
function provider() {
  if (!_provider) _provider = new JsonRpcProvider(RPC_URL);
  return _provider;
}

async function isHolder(addr) {
  try {
    const c = new Contract(AGENTID_ADDRESS, ["function balanceOf(address) view returns (uint256)"], provider());
    return (await c.balanceOf(addr)) > 0n;
  } catch (_) {
    return false; // fail closed
  }
}

async function hasSignedOn(addr, day) {
  try {
    const c = new Contract(
      STILLALIVE_ADDRESS,
      ["function hasSignedOn(address user, uint256 day) view returns (bool)"],
      provider()
    );
    return await c.hasSignedOn(addr, day);
  } catch (_) {
    return false; // fail closed
  }
}

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";

const kv = {
  configured() {
    return !!(KV_URL && KV_TOKEN);
  },
  async cmd(args) {
    const r = await fetch(KV_URL, {
      method: "POST",
      headers: { Authorization: "Bearer " + KV_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    const data = await r.json();
    if (data.error) throw new Error("kv_error");
    return data.result;
  },
};

function voteMessage(day, candidate) {
  return "StillAlive vote\nDay: " + day + "\nCandidate: " + candidate;
}

module.exports = { ADDR_RE, kv, isHolder, hasSignedOn, voteMessage };
