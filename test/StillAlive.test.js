const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const DAY = 86400;
// Noon UTC of a UTC day-index keeps every tx safely inside that day.
const atDay = (d) => d * DAY + 12 * 3600;

// Per-test calendar anchors (UTC day indexes, days since 1970-01-01).
// The Hardhat network starts at the host's current time and time only moves
// forward across tests in a file, so beforeEach picks a fresh month ~2 months
// ahead of the current chain time: JAN_15 = the 15th of that month,
// FEB_01 = the 1st of the month after it.
let JAN_15;
let FEB_01;

async function gotoDay(d) {
  await time.setNextBlockTimestamp(atDay(d));
}

describe("StillAlive", function () {
  let mock, sa;
  let deployer, alice, bob, carol, dave;

  beforeEach(async function () {
    [deployer, alice, bob, carol, dave] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockAgentID");
    mock = await Mock.deploy();

    const StillAlive = await ethers.getContractFactory("StillAlive");
    sa = await StillAlive.deploy(await mock.getAddress());

    // alice, bob and dave hold an Agent ID; carol does not.
    await mock.mint(alice.address);
    await mock.mint(bob.address);
    await mock.mint(dave.address);

    // Start every test on the 15th of a fresh future month so day/month
    // math (streaks, freeze refill on the 1st) is deterministic.
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
    await gotoDay(JAN_15);
  });

  // ---------------------------------------------------------------- gate
  describe("Agent ID gate", function () {
    it("rejects sign from a non-holder", async function () {
      await expect(sa.connect(carol).sign("hello")).to.be.revertedWith(
        "StillAlive: Agent ID required"
      );
    });

    it("rejects poke from a non-holder", async function () {
      await expect(sa.connect(carol).poke(alice.address)).to.be.revertedWith(
        "StillAlive: Agent ID required"
      );
    });

    it("rejects claimBadge from a non-holder", async function () {
      await expect(sa.connect(carol).claimBadge(1)).to.be.revertedWith(
        "StillAlive: Agent ID required"
      );
    });

    it("rejects a zero Agent ID address in the constructor", async function () {
      const StillAlive = await ethers.getContractFactory("StillAlive");
      await expect(StillAlive.deploy(ethers.ZeroAddress)).to.be.revertedWith(
        "StillAlive: zero address"
      );
    });
  });

  // ---------------------------------------------------------------- sign
  describe("sign & status", function () {
    it("signs, emits Signed and updates the wall", async function () {
      await expect(sa.connect(alice).sign("first day"))
        .to.emit(sa, "Signed")
        .withArgs(alice.address, JAN_15, 1, "first day");

      expect(await sa.isAliveToday(alice.address)).to.equal(true);
      expect(await sa.lastSeenDay(alice.address)).to.equal(JAN_15);
      expect(await sa.aliveCountToday()).to.equal(1);
      expect(await sa.statusOf(JAN_15, alice.address)).to.equal("first day");
      expect(await sa.hasSignedOn(alice.address, JAN_15)).to.equal(true);

      const [current, best, freezes] = await sa.getStreak(alice.address);
      expect(current).to.equal(1);
      expect(best).to.equal(1);
      expect(freezes).to.equal(1); // untouched freeze of January
    });

    it("allows an empty status", async function () {
      await sa.connect(alice).sign("");
      expect(await sa.isAliveToday(alice.address)).to.equal(true);
      expect(await sa.statusOf(JAN_15, alice.address)).to.equal("");
    });

    it("reverts on a second sign the same day", async function () {
      await sa.connect(alice).sign("one");
      await expect(sa.connect(alice).sign("two")).to.be.revertedWith(
        "StillAlive: already signed today"
      );
    });

    it("enforces the 140-BYTE status limit (bytes, not characters)", async function () {
      await sa.connect(alice).sign("a".repeat(140)); // exactly 140 bytes: OK

      await gotoDay(JAN_15 + 1);
      await expect(sa.connect(alice).sign("a".repeat(141))).to.be.revertedWith(
        "StillAlive: status over 140 bytes"
      );

      // 35 fire emoji = 140 bytes exactly: OK. 36 = 144 bytes: reverts.
      await sa.connect(alice).sign("\u{1F525}".repeat(35));
      await gotoDay(JAN_15 + 2);
      await expect(
        sa.connect(alice).sign("\u{1F525}".repeat(36))
      ).to.be.revertedWith("StillAlive: status over 140 bytes");
    });
  });

  // ------------------------------------------------------- streak & freeze
  describe("streaks & Streak Freeze", function () {
    it("increments the streak on consecutive days", async function () {
      await sa.connect(alice).sign("d1");
      await gotoDay(JAN_15 + 1);
      await sa.connect(alice).sign("d2");
      await gotoDay(JAN_15 + 2);
      await expect(sa.connect(alice).sign("d3"))
        .to.emit(sa, "Signed")
        .withArgs(alice.address, JAN_15 + 2, 3, "d3");

      const [current, best] = await sa.getStreak(alice.address);
      expect(current).to.equal(3);
      expect(best).to.equal(3);
    });

    it("auto-consumes the freeze when exactly one day is missed", async function () {
      await sa.connect(alice).sign("jan 15");
      await gotoDay(JAN_15 + 2); // Jan 16 missed entirely
      await expect(sa.connect(alice).sign("jan 17"))
        .to.emit(sa, "FreezeUsed")
        .withArgs(alice.address, JAN_15 + 2);

      const [current, best, freezes] = await sa.getStreak(alice.address);
      expect(current).to.equal(2); // streak survived and grew
      expect(best).to.equal(2);
      expect(freezes).to.equal(0); // January freeze is spent
    });

    it("does not let a spent freeze save the streak twice in one month", async function () {
      await sa.connect(alice).sign("jan 15");
      await gotoDay(JAN_15 + 2);
      await sa.connect(alice).sign("jan 17"); // freeze spent here
      await gotoDay(JAN_15 + 4); // Jan 18 missed too
      await expect(sa.connect(alice).sign("jan 19"))
        .to.not.emit(sa, "FreezeUsed");

      const [current, best] = await sa.getStreak(alice.address);
      expect(current).to.equal(1); // reset
      expect(best).to.equal(2); // best is kept
    });

    it("refills the freeze on the 1st of the next month (lazy)", async function () {
      await sa.connect(alice).sign("jan 15");
      await gotoDay(JAN_15 + 2);
      await sa.connect(alice).sign("jan 17"); // January freeze spent
      expect((await sa.getStreak(alice.address))[2]).to.equal(0);

      // Jump to Feb 1: streak is long broken, but the freeze must be back.
      await gotoDay(FEB_01);
      await sa.connect(alice).sign("feb 1");
      expect((await sa.getStreak(alice.address))[2]).to.equal(1);

      // Miss Feb 2, sign Feb 3: the refilled freeze saves the streak again.
      await gotoDay(FEB_01 + 2);
      await expect(sa.connect(alice).sign("feb 3"))
        .to.emit(sa, "FreezeUsed")
        .withArgs(alice.address, FEB_01 + 2);
      expect((await sa.getStreak(alice.address))[0]).to.equal(2);
    });

    it("resets the streak when 2+ days are missed (freeze cannot help)", async function () {
      await sa.connect(bob).sign("d1");
      await gotoDay(JAN_15 + 3); // two full days missed
      await expect(sa.connect(bob).sign("d4")).to.not.emit(sa, "FreezeUsed");

      const [current, best, freezes] = await sa.getStreak(bob.address);
      expect(current).to.equal(1);
      expect(best).to.equal(1);
      expect(freezes).to.equal(1); // freeze was NOT consumed by a hopeless gap
    });

    it("reports an effective streak of 0 once a streak is beyond saving", async function () {
      await sa.connect(alice).sign("d1");
      await gotoDay(JAN_15 + 5); // no sign for days; read-only check
      // Mine one empty block so the view reads at the new time.
      await ethers.provider.send("evm_mine", []);
      const [current, best] = await sa.getStreak(alice.address);
      expect(current).to.equal(0);
      expect(best).to.equal(1);
      expect(await sa.isAliveToday(alice.address)).to.equal(false);
    });
  });

  // ---------------------------------------------------------------- badges
  describe("soulbound badges", function () {
    async function signDays(user, startDay, count) {
      for (let i = 0; i < count; i++) {
        await gotoDay(startDay + i);
        await sa.connect(user).sign("day " + (i + 1));
      }
    }

    it("claims Week Alive at a 7-day best streak, exactly once", async function () {
      await signDays(alice, JAN_15, 7);
      expect((await sa.getStreak(alice.address))[1]).to.equal(7);

      await expect(sa.connect(alice).claimBadge(1))
        .to.emit(sa, "BadgeClaimed")
        .withArgs(alice.address, 1, 1)
        .and.to.emit(sa, "Transfer")
        .withArgs(ethers.ZeroAddress, alice.address, 1);

      expect(await sa.hasBadge(alice.address, 1)).to.equal(true);
      expect(await sa.ownerOf(1)).to.equal(alice.address);
      expect(await sa.balanceOf(alice.address)).to.equal(1);
      expect(await sa.tokenTier(1)).to.equal(1);
      expect(await sa.tokenURI(1)).to.contain("Week Alive");

      await expect(sa.connect(alice).claimBadge(1)).to.be.revertedWith(
        "StillAlive: badge already claimed"
      );
    });

    it("refuses a badge before the streak milestone is reached", async function () {
      await signDays(alice, JAN_15, 6);
      await expect(sa.connect(alice).claimBadge(1)).to.be.revertedWith(
        "StillAlive: streak too low"
      );
    });

    it("refuses invalid tiers", async function () {
      await expect(sa.connect(alice).claimBadge(0)).to.be.revertedWith(
        "StillAlive: invalid tier"
      );
      await expect(sa.connect(alice).claimBadge(4)).to.be.revertedWith(
        "StillAlive: invalid tier"
      );
    });

    it("is soulbound: every transfer / approval path reverts", async function () {
      await signDays(alice, JAN_15, 7);
      await sa.connect(alice).claimBadge(1);

      await expect(
        sa.connect(alice).transferFrom(alice.address, bob.address, 1)
      ).to.be.revertedWith("StillAlive: badges are soulbound");
      await expect(
        sa
          .connect(alice)
          ["safeTransferFrom(address,address,uint256)"](
            alice.address,
            bob.address,
            1
          )
      ).to.be.revertedWith("StillAlive: badges are soulbound");
      await expect(
        sa
          .connect(alice)
          ["safeTransferFrom(address,address,uint256,bytes)"](
            alice.address,
            bob.address,
            1,
            "0x"
          )
      ).to.be.revertedWith("StillAlive: badges are soulbound");
      await expect(sa.connect(alice).approve(bob.address, 1)).to.be.revertedWith(
        "StillAlive: badges are soulbound"
      );
      await expect(
        sa.connect(alice).setApprovalForAll(bob.address, true)
      ).to.be.revertedWith("StillAlive: badges are soulbound");

      expect(await sa.ownerOf(1)).to.equal(alice.address); // unmoved
    });

    it("unlocks Month Alive at 30 and Immortal at 100 days", async function () {
      this.timeout(120000);
      await signDays(alice, JAN_15, 30);
      await sa.connect(alice).claimBadge(2);
      expect(await sa.hasBadge(alice.address, 2)).to.equal(true);
      await expect(sa.connect(alice).claimBadge(3)).to.be.revertedWith(
        "StillAlive: streak too low"
      );

      await signDays(alice, JAN_15 + 30, 70); // 100 consecutive days total
      expect((await sa.getStreak(alice.address))[1]).to.equal(100);
      await sa.connect(alice).claimBadge(3);
      expect(await sa.hasBadge(alice.address, 3)).to.equal(true);
      expect(await sa.balanceOf(alice.address)).to.equal(2);
    });
  });

  // ------------------------------------------------------------------ poke
  describe("poke", function () {
    it("pokes once per pair per day and counts received pokes", async function () {
      await expect(sa.connect(alice).poke(bob.address))
        .to.emit(sa, "Poked")
        .withArgs(alice.address, bob.address, JAN_15);
      expect(await sa.pokesReceived(bob.address)).to.equal(1);

      await expect(sa.connect(alice).poke(bob.address)).to.be.revertedWith(
        "StillAlive: already poked today"
      );

      // A different pair is a different poke.
      await sa.connect(bob).poke(alice.address);
      expect(await sa.pokesReceived(alice.address)).to.equal(1);

      // Next day the same pair may poke again.
      await gotoDay(JAN_15 + 1);
      await sa.connect(alice).poke(bob.address);
      expect(await sa.pokesReceived(bob.address)).to.equal(2);
    });

    it("rejects self-pokes, zero address and non-holder targets", async function () {
      await expect(sa.connect(alice).poke(alice.address)).to.be.revertedWith(
        "StillAlive: invalid target"
      );
      await expect(sa.connect(alice).poke(ethers.ZeroAddress)).to.be.revertedWith(
        "StillAlive: invalid target"
      );
      await expect(sa.connect(alice).poke(carol.address)).to.be.revertedWith(
        "StillAlive: target has no Agent ID"
      );
    });
  });

  // ------------------------------------------------------------- wall reads
  describe("wall reads & pagination", function () {
    it("returns today's signers paginated, in sign order", async function () {
      await sa.connect(alice).sign("a");
      await sa.connect(bob).sign("b");
      await sa.connect(dave).sign("d");

      expect(await sa.aliveCountToday()).to.equal(3);

      const [page1, total1] = await sa.getSignersToday(0, 2);
      expect(total1).to.equal(3);
      expect(page1).to.deep.equal([alice.address, bob.address]);

      const [page2, total2] = await sa.getSignersToday(2, 2);
      expect(total2).to.equal(3);
      expect(page2).to.deep.equal([dave.address]);

      const [page3] = await sa.getSignersToday(3, 2);
      expect(page3).to.deep.equal([]);

      // Archive read for a past day works the same way.
      await gotoDay(JAN_15 + 1);
      await ethers.provider.send("evm_mine", []);
      const [past, pastTotal] = await sa.getSignersOfDay(JAN_15, 0, 10);
      expect(pastTotal).to.equal(3);
      expect(past).to.deep.equal([alice.address, bob.address, dave.address]);
      expect(await sa.aliveCountToday()).to.equal(0); // new day, empty wall
    });

    it("exposes the summary a profile page needs", async function () {
      // Poke first: poking someone who already signed today reverts by design.
      await sa.connect(bob).poke(alice.address);
      await sa.connect(alice).sign("gm");

      const s = await sa.getUserSummary(alice.address);
      expect(s.lastSignDay_).to.equal(JAN_15);
      expect(s.currentStreak).to.equal(1);
      expect(s.bestStreak).to.equal(1);
      expect(s.freezesLeft).to.equal(1);
      expect(s.totalSigns).to.equal(1);
      expect(s.pokesReceived_).to.equal(1);
      expect(s.signedToday).to.equal(true);
    });
  });
});
