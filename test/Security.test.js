const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// Security-focused suite: day/month boundary math, byte-length enforcement,
// poke rules, badge threshold boundaries, pagination DoS cap, freeze abuse,
// and a reentrancy probe against the Agent ID gate.
const DAY = 86400;
const atDay = (d) => d * DAY + 12 * 3600; // noon UTC of a day index

let JAN_15; // 15th of a fresh future month (set in beforeEach)
let FEB_01; // 1st of the month after it
let LAST_OF_MONTH; // FEB_01 - 1

async function gotoTs(ts) {
  await time.setNextBlockTimestamp(ts);
}
async function gotoDay(d) {
  await gotoTs(atDay(d));
}

describe("StillAlive — security & boundaries", function () {
  let mock, sa;
  let deployer, alice, bob, carol;

  beforeEach(async function () {
    [deployer, alice, bob, carol] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockAgentID");
    mock = await Mock.deploy();
    const StillAlive = await ethers.getContractFactory("StillAlive");
    sa = await StillAlive.deploy(await mock.getAddress());

    await mock.mint(alice.address);
    await mock.mint(bob.address);

    const now = await time.latest();
    const nowDate = new Date(now * 1000);
    let y = nowDate.getUTCFullYear();
    let m = nowDate.getUTCMonth() + 2;
    if (m > 11) {
      y += Math.floor(m / 12);
      m = m % 12;
    }
    JAN_15 = Date.UTC(y, m, 15) / 86400000;
    let fy = y;
    let fm = m + 1;
    if (fm > 11) {
      fy += 1;
      fm = 0;
    }
    FEB_01 = Date.UTC(fy, fm, 1) / 86400000;
    LAST_OF_MONTH = FEB_01 - 1;
    await gotoDay(JAN_15);
  });

  // ------------------------------------------------------------ day boundary
  describe("day-boundary math (UTC)", function () {
    it("treats 23:59:59 and 00:00:01 as different days; streak continues", async function () {
      await gotoTs(JAN_15 * DAY + 86399); // Jan 15, 23:59:59 UTC
      await sa.connect(alice).sign("just in time");
      expect(await sa.lastSeenDay(alice.address)).to.equal(JAN_15);

      await gotoTs((JAN_15 + 1) * DAY + 1); // Jan 16, 00:00:01 UTC
      await expect(sa.connect(alice).sign("just after midnight"))
        .to.emit(sa, "Signed")
        .withArgs(alice.address, JAN_15 + 1, 2, "just after midnight");
    });

    it("counts a sign at exactly 00:00:00 as the new day", async function () {
      await gotoTs((JAN_15 + 1) * DAY); // exactly midnight
      await sa.connect(alice).sign("midnight sharp");
      expect(await sa.lastSeenDay(alice.address)).to.equal(JAN_15 + 1);
      expect(await sa.hasSignedOn(alice.address, JAN_15)).to.equal(false);
      expect(await sa.hasSignedOn(alice.address, JAN_15 + 1)).to.equal(true);
    });

    it("keeps the streak across a month boundary (last day -> 1st)", async function () {
      await gotoTs(LAST_OF_MONTH * DAY + 86399); // last day of month, 23:59:59
      await sa.connect(alice).sign("end of month");
      await gotoTs(FEB_01 * DAY + 1); // 1st of next month, 00:00:01
      await expect(sa.connect(alice).sign("new month"))
        .to.emit(sa, "Signed")
        .withArgs(alice.address, FEB_01, 2, "new month")
        .and.to.not.emit(sa, "FreezeUsed"); // consecutive days: no freeze spent
      expect((await sa.getStreak(alice.address))[2]).to.equal(1);
    });
  });

  // ------------------------------------------------------------- status bytes
  describe("status byte-length enforcement", function () {
    it("rejects <140 characters that are >140 BYTES (multibyte UTF-8)", async function () {
      // 111 characters but 144 bytes: 100 ASCII + 11 fire emoji (4 bytes each)
      const sneaky = "a".repeat(100) + "\u{1F525}".repeat(11);
      expect([...sneaky].length).to.equal(111);
      await expect(sa.connect(alice).sign(sneaky)).to.be.revertedWith(
        "StillAlive: status over 140 bytes"
      );
      // 110 characters and exactly 140 bytes passes.
      const exact = "a".repeat(100) + "\u{1F525}".repeat(10);
      await sa.connect(alice).sign(exact);
      expect(await sa.statusOf(JAN_15, alice.address)).to.equal(exact);
    });
  });

  // ------------------------------------------------------------------- poke
  describe("poke hardening", function () {
    it("reverts when the target has ALREADY signed today", async function () {
      await sa.connect(alice).sign("done for today");
      await expect(sa.connect(bob).poke(alice.address)).to.be.revertedWith(
        "StillAlive: target already signed today"
      );
      expect(await sa.pokesReceived(alice.address)).to.equal(0);
    });

    it("still counts a poke sent BEFORE the target signs", async function () {
      await sa.connect(bob).poke(alice.address); // alice has not signed yet
      await sa.connect(alice).sign("thanks for the poke");
      expect(await sa.pokesReceived(alice.address)).to.equal(1);
    });
  });

  // -------------------------------------------------------- badge thresholds
  describe("badge threshold boundaries (exact)", function () {
    it("reverts at 6/29/99 and succeeds at exactly 7/30/100, in any claim order", async function () {
      this.timeout(180000);
      const signDays = async (start, count) => {
        for (let i = 0; i < count; i++) {
          await gotoDay(start + i);
          await sa.connect(alice).sign("s");
        }
      };

      await signDays(JAN_15, 6); // best = 6
      await expect(sa.connect(alice).claimBadge(1)).to.be.revertedWith(
        "StillAlive: streak too low"
      );
      await signDays(JAN_15 + 6, 1); // best = 7 exactly
      await sa.connect(alice).claimBadge(1);

      await signDays(JAN_15 + 7, 22); // best = 29
      await expect(sa.connect(alice).claimBadge(2)).to.be.revertedWith(
        "StillAlive: streak too low"
      );
      await signDays(JAN_15 + 29, 1); // best = 30 exactly
      // Claim tier 2 while tier order is irrelevant (tier 1 already held here;
      // the point is thresholds are per-tier, best-streak based).
      await sa.connect(alice).claimBadge(2);

      await signDays(JAN_15 + 30, 69); // best = 99
      await expect(sa.connect(alice).claimBadge(3)).to.be.revertedWith(
        "StillAlive: streak too low"
      );
      await signDays(JAN_15 + 99, 1); // best = 100 exactly
      await sa.connect(alice).claimBadge(3);
      expect(await sa.balanceOf(alice.address)).to.equal(3);
    });

    it("lets a fresh 30-day user claim tier 2 BEFORE tier 1 (no forced order)", async function () {
      this.timeout(120000);
      for (let i = 0; i < 30; i++) {
        await gotoDay(JAN_15 + i);
        await sa.connect(bob).sign("s");
      }
      await sa.connect(bob).claimBadge(2); // tier 2 first
      await sa.connect(bob).claimBadge(1); // tier 1 after: still fine
      expect(await sa.hasBadge(bob.address, 2)).to.equal(true);
      expect(await sa.hasBadge(bob.address, 1)).to.equal(true);
    });
  });

  // ------------------------------------------------------------ view DoS cap
  describe("pagination DoS cap", function () {
    it("caps a page at MAX_PAGE_SIZE (100) no matter what limit is requested", async function () {
      this.timeout(300000);
      const N = 105;
      const wallets = [];
      for (let i = 0; i < N; i++) {
        const w = ethers.Wallet.createRandom().connect(ethers.provider);
        wallets.push(w);
        await deployer.sendTransaction({
          to: w.address,
          value: ethers.parseEther("0.05"),
        });
        await mock.mint(w.address);
      }
      for (const w of wallets) {
        await sa.connect(w).sign("cap test");
      }

      expect(await sa.aliveCountToday()).to.equal(N);

      const [page, total] = await sa.getSignersToday(0, 1000); // absurd limit
      expect(total).to.equal(N); // total stays truthful
      expect(page.length).to.equal(100); // page is capped

      const [rest] = await sa.getSignersToday(100, 1000);
      expect(rest.length).to.equal(5);

      // aliveCountToday is consistent with the paginated total.
      const [, total2] = await sa.getSignersToday(0, 1);
      expect(total2).to.equal(await sa.aliveCountToday());
    });
  });

  // -------------------------------------------------------------- freeze abuse
  describe("freeze abuse resistance", function () {
    it("never stacks: skipping whole months still leaves exactly 1 freeze", async function () {
      await sa.connect(alice).sign("month M");
      const later = FEB_01 + 45; // safely inside month M+2
      await gotoDay(later);
      await sa.connect(alice).sign("month M+2");
      const [, , freezes] = await sa.getStreak(alice.address);
      expect(freezes).to.equal(1); // not 2, not 3
    });

    it("one user's sign can never touch another user's streak or freeze", async function () {
      await sa.connect(alice).sign("alice only");
      const [cur, best, freezes] = await sa.getStreak(bob.address);
      expect(cur).to.equal(0);
      expect(best).to.equal(0);
      expect(freezes).to.equal(1); // bob's own untouched freeze for this month
      expect(await sa.lastSeenDay(bob.address)).to.equal(0);
      expect(await sa.isAliveToday(bob.address)).to.equal(false);
    });

    it("a freeze is not consumed by a hopeless 2+ day gap, and stays usable after", async function () {
      await sa.connect(alice).sign("d1");
      await gotoDay(JAN_15 + 3); // 2 full days missed: freeze must NOT burn
      await sa.connect(alice).sign("d4");
      expect((await sa.getStreak(alice.address))[2]).to.equal(1);
      // Now miss exactly one day: the still-intact freeze does its job.
      await gotoDay(JAN_15 + 5);
      await expect(sa.connect(alice).sign("d6"))
        .to.emit(sa, "FreezeUsed")
        .withArgs(alice.address, JAN_15 + 5);
      expect((await sa.getStreak(alice.address))[0]).to.equal(2);
    });
  });

  // --------------------------------------------------------------- reentrancy
  describe("reentrancy probe (hostile Agent ID stand-in)", function () {
    it("a reentrant sign() from inside balanceOf cannot corrupt state", async function () {
      const Reentrant = await ethers.getContractFactory("ReentrantAgentID");
      const evil = await Reentrant.deploy();
      const StillAlive = await ethers.getContractFactory("StillAlive");
      const sa2 = await StillAlive.deploy(await evil.getAddress());

      await evil.mint(alice.address);
      await evil.mint(await evil.getAddress()); // the mock itself "holds" an ID
      await evil.arm(await sa2.getAddress());

      // Alice signs; during the gate's balanceOf call the mock tries to
      // reenter sign() as itself. StillAlive calls balanceOf through a view
      // interface (STATICCALL), so the reentrant state writes run in a
      // static frame and must fail; alice's own sign must succeed cleanly.
      await sa2.connect(alice).sign("alice is fine");
      expect(await sa2.isAliveToday(alice.address)).to.equal(true);
      expect((await sa2.getStreak(alice.address))[0]).to.equal(1);

      // The reentrant sign left no trace.
      expect(await sa2.lastSeenDay(await evil.getAddress())).to.equal(0);
      expect(await sa2.aliveCountToday()).to.equal(1);
    });
  });

  // --------------------------------------------------------------- no backdoor
  describe("no admin surface", function () {
    it("exposes no owner() and the Agent ID gate is the constructor-set address", async function () {
      expect(sa.interface.hasFunction("owner")).to.equal(false);
      expect(sa.interface.hasFunction("setAgentID")).to.equal(false);
      expect(sa.interface.hasFunction("upgradeTo")).to.equal(false);
      expect(sa.interface.hasFunction("pause")).to.equal(false);
      expect(await sa.agentID()).to.equal(await mock.getAddress());
    });
  });
});
