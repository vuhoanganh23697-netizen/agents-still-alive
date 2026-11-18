# StillAlive — Security Review

**Scope:** `contracts/StillAlive.sol` (Solidity 0.8.20, single file, no imports).
**Method:** manual code review + adversarial Hardhat tests (`test/Security.test.js`, plus the
functional suite in `test/StillAlive.test.js`). Result at review time: **37/37 tests passing**,
clean compile, deployed bytecode 16,420 bytes.
**Verdict per item:** PASS = already safe as designed · FIXED = a weakness was found and changed.

---

## 1. Reentrancy — sign / poke / claimBadge — **PASS** (poke ordering hardened)

- The only external call reachable from any write function is `agentID.balanceOf(...)` —
  a read-only call to the **fixed, immutable** Agent ID contract set once in the constructor.
  It is not user-supplied and cannot be swapped after deployment.
- StillAlive calls it through a `view` interface, i.e. via **STATICCALL**: any state write
  attempted by a hostile callee runs in a static frame and reverts. This is proven by an
  adversarial test (`contracts/ReentrantAgentID.sol`, test-only): its `balanceOf` tries to
  reenter `sign()` mid-gate; the reentrant sign leaves zero trace, and the outer user's sign
  completes normally with correct state.
- `claimBadge`'s mint is **purely internal** (storage writes + events). No external call of
  any kind happens after — or before — its state changes, other than the gate above.
- `poke` was restructured to strict checks → effects → interactions order: all local checks
  and both state writes complete before the one external view call (target's Agent ID
  balance); if that check fails, the transaction reverts and the writes roll back with it.
- In `sign`, the "already signed today" check reads storage *after* the gate call returns,
  so even a hypothetical reentrant sign could not double-sign an account in one day.

## 2. Soulbound completeness — **PASS**

All five ERC-721 transfer/approval entry points revert with `"StillAlive: badges are soulbound"`:
`transferFrom`, `safeTransferFrom` (3-arg), `safeTransferFrom` (4-arg, with data),
`approve`, `setApprovalForAll`. `getApproved` always returns the zero address and
`isApprovedForAll` always returns `false`, so no approval can ever be manufactured.
Badges can only come into existence through `claimBadge` (mint from the zero address).
All paths are covered by tests, including a post-attempt `ownerOf` check that the token
did not move.

## 3. Agent ID gate — **PASS**

- `sign`, `poke`, and `claimBadge` all carry `onlyHolder`, requiring
  `agentID.balanceOf(msg.sender) > 0`.
- `poke` additionally requires the *target* to hold an Agent ID on the **same fixed
  contract** — there is no parameter, storage slot, or function anywhere that lets a caller
  point the gate at a different token contract. `agentID` is `immutable`, assigned once
  from the constructor argument, and the constructor rejects the zero address (tested).
- Because the real Agent ID is itself non-transferable and one-per-verified-Binance-account,
  the gate is also the sybil-resistance story of the whole product.

## 4. Streak Freeze abuse — **PASS**

- **Max 1, ever.** Freeze state is a single boolean plus the month it belongs to; the lazy
  refill (`_syncFreeze`) can only set it to `true` when the calendar month changes, and it
  is already `true` if unused — so it can never stack. Test: skipping entire months still
  leaves exactly 1 freeze.
- **Refill timing.** Refill happens only when `_monthId(today)` differs from the stored
  month — i.e. on/after the 1st of a new UTC month — evaluated lazily inside the user's
  next sign. No keeper, no early refill, no manual trigger.
- **Gap discipline.** A freeze is consumed only when the gap is *exactly* one missed day
  (`lastSignDay == today - 2`). A 2+-day gap resets the streak **without** consuming the
  freeze (tested: the intact freeze still saves the streak later).
- **No proxy abuse.** `sign` acts exclusively on `msg.sender`; there is no sign-for,
  poke-for, or claim-for function. Test: one user's sign leaves another user's streak,
  freeze, and last-seen state untouched.

## 5. Day-boundary math — **PASS**

`day = block.timestamp / 86400` (UTC) is the single source of "today" for signs, pokes,
the wall, and freeze months (`_monthId` uses Howard Hinnant's civil-from-days algorithm,
verified against real calendar dates in tests). Boundary tests cover:

- sign at 23:59:59 UTC, next sign at 00:00:01 UTC → different days, streak +1;
- sign at exactly 00:00:00 UTC → counts as the new day;
- sign at 23:59:59 on the last day of a month, next sign 00:00:01 on the 1st →
  consecutive-day streak continues across the month edge, no freeze spent.

Residual note: BSC validators can nudge block timestamps by seconds. At day granularity
this only matters within seconds of midnight UTC and can at worst shift which side of
midnight a sign lands on — it cannot forge a streak, a freeze, or a badge.

## 6. Status length — **PASS**

Enforced as `bytes(status).length <= 140` — raw UTF-8 **bytes**, not characters — in the
contract itself (the UI's byte counter mirrors it so the two never disagree on emoji).
Tests: 140 ASCII bytes pass, 141 revert; 35 🔥 (140 bytes) pass, 36 🔥 (144 bytes) revert;
and an explicit trap case — 111 characters / 144 bytes — reverts.

## 7. Poké limits — **FIXED** (one rule tightened)

- 1 poke per (sender, target) pair per UTC day: enforced via a `keccak256(from, to, day)`
  key — **PASS**, tested (same pair reverts same-day, works next day; other pairs unaffected).
- Self-poke and zero-address target revert — **PASS**, tested.
- Non-holder target reverts — **PASS**, tested.
- **FIXED:** poking an address that has *already signed today* now reverts
  (`"StillAlive: target already signed today"`). Spec §4.5 defines the poke purely as a
  "sign before your streak dies" nudge ("Poké chỉ có ý nghĩa khi target hôm nay chưa ký")
  but did not state an on-chain enforcement; the stricter reading was implemented so the
  contract matches the product intent and pokes can't be wasted/spammed on people who
  are already safe. A poke sent *before* the target signs still counts normally (tested).
  This is the one deliberate interpretation beyond the spec's letter — flagged for the
  project owner; removing it is a one-line change if unwanted.

## 8. Badge claiming — **PASS**

- Double-claim of the same tier reverts (`badgeClaimed` mapping) — tested.
- Thresholds are checked against `bestStreak` (never decreases), per tier, with **no
  forced claim order**: exact-boundary tests revert at best streak 6 / 29 / 99 and succeed
  at exactly 7 / 30 / 100; a separate test claims tier 2 *before* tier 1 at 30 days.
- Invalid tiers (0, 4, …) revert; thresholds come from a single pure function also used
  by `tokenURI`, so the displayed requirement can never drift from the enforced one.

## 9. View-function DoS — **FIXED**

`getSignersOfDay` / `getSignersToday` copied the requested slice with no bound. A hard cap
was added: `MAX_PAGE_SIZE = 100` — any larger `limit` is clamped, so no caller can force
an unbounded loop/copy. The returned `total` stays truthful, and a test with **105 signers
on one day** verifies: `aliveCountToday() == 105 == total`, page 1 returns exactly 100,
page 2 returns the remaining 5. All other views are O(1) mapping reads.

## 10. Sign twice in one day — **PASS** (matches spec exactly)

Spec §4.1: "Mỗi địa chỉ ký tối đa 1 lần/ngày (chặn cứng trong contract)" — one sign per
address per day, hard cap. The contract reverts the second sign
(`"StillAlive: already signed today"`); the spec does **not** allow a status edit via a
second sign, so none was implemented. Tested.

## 11. No backdoors / no upgradeability / no dependencies — **PASS**

- No `owner`, admin, pauser, upgrader, `selfdestruct`, or `delegatecall` anywhere; the
  test suite asserts the ABI exposes no `owner()` / `setAgentID()` / `upgradeTo()` /
  `pause()`. There is nothing to rug with: no funds are ever held, no fees exist, and no
  function can move or mint anything except a user's own badge claim.
- Zero imports: the file defines its own minimal `IAgentID` interface and badge ERC-721,
  so the deployed bytecode is exactly what is in this repository — which is also what
  makes single-file BscScan verification (see `DEPLOY_GUIDE.md`) byte-for-byte meaningful.
- Compiler: Solidity 0.8.20 (checked arithmetic throughout — no `unchecked` blocks),
  optimizer off, matching the Remix/BscScan verification settings.

## Known non-issues & residual risks (accepted, documented for the owner)

- **Status content is public and permanent.** Statuses live on-chain; the frontend may
  choose to hide abusive content in its own UI, but the data itself cannot be deleted.
  This is stated in the README.
- **Event-scan freshness in the frontend.** Leaderboard/directory data is rebuilt from
  `Signed`/`Poked`/`BadgeClaimed` logs; it is a read model, never a source of truth —
  every number that matters (streaks, badges, eligibility) is re-read from contract
  state before any transaction is sent.
- **`.ai` name resolution** follows spec §12 (on-chain mint events → `tokenURI` → SPACE ID
  metadata; never the SPACE ID API). An address whose mint event is outside the scanned
  window simply displays as a shortened address — the UI never invents a name.

## Addendum (2026-11-18) — V2 prototype (NOT deployed) + the off-chain vote API

Changes vs V1 (minimal diff, everything else byte-identical in behaviour):
- Badge tiers are now 3 / 7 / 10 / 30 days (Spark / Week Alive / Blaze / Month Alive).
  Same claim path, same soulbound implementation, same per-tier threshold check.
- New `vote(address)` — one vote per Agent ID holder per UTC day for the day's
  best agent report. Checks: holder gate (modifier), candidate ≠ 0 and ≠ voter,
  candidate has signed today (`_signedOn` — which itself proves the candidate
  is a holder, since `sign()` is gated), voter has not voted today. Effects
  (choice + tally) are written before the event; there are no external calls
  after the gate's `balanceOf` view, so no reentrancy surface is added.
  No vote switching: a day's choice is final, which keeps tallies monotone
  and prevents last-minute tally manipulation games.
- New views `votesOf` / `votesToday` / `voteChoiceOn` / `myVoteToday` — pure
  mapping reads, no loops, no DoS surface.
- Test suite: 45 passing (37 V1 tests ported to the new ladder + 8 vote tests
  covering holder gate, self-vote, zero address, unsigned candidate, one-vote
  finality, next-day reset with history preserved, and voting without signing).
- **Decision: V2 was NOT deployed.** The live contract remains V1. The badge
  ladder ships as UI milestones derived from the on-chain best streak (the
  streak is the verifiable proof; the 7/30/100 NFT claims are unchanged), and
  votes ship as an off-chain API instead — see below. The V2 source is kept in
  the project archive in case on-chain votes are ever justified by real usage.

## The vote API (`api/`) — security model

- Auth: every vote carries an EIP-191 wallet signature over a fixed message
  binding (day, candidate); the server recovers the signer and requires it to
  equal the claimed voter. Forged or replayed-for-another-day votes fail.
- Rules are re-checked server-side against the chain on every vote: voter
  holds an Agent ID, candidate signed that day, one vote per voter per day
  (atomic HSETNX), no self-votes. Chain-read failures fail closed.
- Residual risks, accepted by design: tallies live in the project's KV store
  (off-chain, not BscScan-verifiable, lost if the store is wiped — impact is
  bounded to one day's bragging rights); a determined attacker with many
  funded Agent ID wallets can still multiply votes, exactly as with any
  free-identity system — the same limit the on-chain design had.
