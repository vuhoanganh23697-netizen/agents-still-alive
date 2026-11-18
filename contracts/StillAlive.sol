// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal interface for the Binance Agent ID NFT.
/// @dev The Agent ID contract (BSC mainnet 0x60b9262456de011f7d15a54cdd8c48baaa8b022f)
///      is an ERC-721-style, non-transferable identity NFT. StillAlive only needs
///      `balanceOf` to gate sign / poke / claimBadge to Agent ID holders.
interface IAgentID {
    function balanceOf(address owner) external view returns (uint256);
}

/// @title StillAlive — the daily proof-of-liveness wall for Binance Agent ID holders
/// @notice Every day, each Agent ID holder signs the wall once with a short status.
///         Signing keeps a streak alive. One free Streak Freeze per month saves a
///         streak when exactly one day is missed. Best streaks earn soulbound NFT
///         badges (7 / 30 / 100 days) that double as a public whitelist gate.
/// @dev Single-file, dependency-free contract so it can be deployed and verified
///      on BscScan straight from Remix. The badge NFT is a minimal in-contract
///      ERC-721 implementation with all transfers disabled (soulbound).
contract StillAlive {
    // ------------------------------------------------------------------
    // Constants
    // ------------------------------------------------------------------
    uint256 public constant MAX_STATUS_BYTES = 140;
    uint256 public constant SECONDS_PER_DAY = 86400;
    /// @notice Hard cap on wall pagination — a single view call can never be
    ///         forced into an unbounded loop over a day's signers.
    uint256 public constant MAX_PAGE_SIZE = 100;

    uint8 public constant TIER_WEEK = 1; //    7-day best streak  -> "Week Alive"
    uint8 public constant TIER_MONTH = 2; //  30-day best streak  -> "Month Alive"
    uint8 public constant TIER_IMMORTAL = 3; // 100-day best streak -> "Immortal"

    /// @notice The Binance Agent ID contract this wall is gated by.
    IAgentID public immutable agentID;

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------
    event Signed(address indexed user, uint256 indexed day, uint256 streak, string status);
    event FreezeUsed(address indexed user, uint256 indexed day);
    event Poked(address indexed from, address indexed to, uint256 indexed day);
    event BadgeClaimed(address indexed user, uint8 tier, uint256 tokenId);

    // ERC-721 events (badge mints)
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    // ------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------
    struct UserState {
        uint256 lastSignDay; // UTC day index of the most recent sign (0 = epoch, see `initialized`)
        uint256 currentStreak; // stored streak; read the *effective* streak via getStreak()
        uint256 bestStreak; // never decreases; drives badges + leaderboard
        uint256 totalSigns;
        uint256 pokesReceived;
        uint256 freezeMonthId; // calendar month (year * 12 + month - 1) the freeze flag belongs to
        bool hasFreeze; // freeze still unused inside `freezeMonthId`
        bool initialized; // false until the first ever sign
    }

    mapping(address => UserState) private _users;

    /// @dev The wall itself: who signed on a given UTC day, in sign order.
    mapping(uint256 => address[]) private _signersOfDay;
    mapping(uint256 => mapping(address => string)) private _statusOfDay;
    mapping(uint256 => mapping(address => bool)) private _signedOn;

    /// @dev One poke per (from, to, day) — key = keccak256(abi.encode(from, to, day)).
    mapping(bytes32 => bool) private _pokeUsed;

    // Badge NFT storage (minimal ERC-721, soulbound)
    mapping(address => mapping(uint8 => bool)) private _badgeClaimed;
    mapping(uint256 => address) private _tokenOwner;
    mapping(uint256 => uint8) private _tokenTier;
    mapping(address => uint256) private _badgeBalance;
    uint256 private _nextTokenId = 1;

    // ------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------
    /// @param agentID_ Address of the Binance Agent ID contract
    ///        (BSC mainnet: 0x60b9262456de011f7d15a54cdd8c48baaa8b022f).
    constructor(address agentID_) {
        require(agentID_ != address(0), "StillAlive: zero address");
        agentID = IAgentID(agentID_);
    }

    // ------------------------------------------------------------------
    // Modifiers / gates
    // ------------------------------------------------------------------
    modifier onlyHolder() {
        require(agentID.balanceOf(msg.sender) > 0, "StillAlive: Agent ID required");
        _;
    }

    // ------------------------------------------------------------------
    // Core write functions
    // ------------------------------------------------------------------

    /// @notice Sign today's wall with a free-form status (max 140 bytes, may be empty).
    /// @dev One sign per address per UTC day. Streak rules:
    ///      signed yesterday -> streak + 1; missed exactly one day and a Streak
    ///      Freeze is available -> freeze is consumed, streak + 1, `FreezeUsed`
    ///      is emitted; missed 2+ days -> streak restarts at 1.
    function sign(string calldata status) external onlyHolder {
        require(bytes(status).length <= MAX_STATUS_BYTES, "StillAlive: status over 140 bytes");
        uint256 dayNow = _today();
        UserState storage u = _users[msg.sender];
        require(!u.initialized || u.lastSignDay != dayNow, "StillAlive: already signed today");

        _syncFreeze(u, dayNow);

        bool usedFreeze = false;
        if (!u.initialized) {
            u.currentStreak = 1;
            u.initialized = true;
        } else if (u.lastSignDay == dayNow - 1) {
            u.currentStreak += 1;
        } else if (u.lastSignDay == dayNow - 2 && u.hasFreeze) {
            u.hasFreeze = false;
            u.currentStreak += 1;
            usedFreeze = true;
        } else {
            u.currentStreak = 1;
        }

        u.lastSignDay = dayNow;
        u.totalSigns += 1;
        if (u.currentStreak > u.bestStreak) u.bestStreak = u.currentStreak;

        _signersOfDay[dayNow].push(msg.sender);
        _statusOfDay[dayNow][msg.sender] = status;
        _signedOn[dayNow][msg.sender] = true;

        emit Signed(msg.sender, dayNow, u.currentStreak, status);
        if (usedFreeze) emit FreezeUsed(msg.sender, dayNow);
    }

    /// @notice Poke another Agent ID holder to remind them to sign today.
    /// @dev At most one poke per (sender, target) pair per UTC day, and only
    ///      while the target has NOT signed yet today — a poke is a "sign or
    ///      your streak dies" nudge, so poking someone who already signed is
    ///      meaningless and is rejected (spec §4.5 intent, enforced on-chain).
    ///      Ordering follows checks-effects-interactions: all local checks and
    ///      state writes happen before the one external view call (the target's
    ///      Agent ID balance on the immutable gate contract); if that call's
    ///      check fails, the whole transaction — writes included — reverts.
    function poke(address target) external onlyHolder {
        require(target != address(0) && target != msg.sender, "StillAlive: invalid target");
        uint256 dayNow = _today();
        require(!_signedOn[dayNow][target], "StillAlive: target already signed today");
        bytes32 key = keccak256(abi.encode(msg.sender, target, dayNow));
        require(!_pokeUsed[key], "StillAlive: already poked today");

        // Effects first.
        _pokeUsed[key] = true;
        _users[target].pokesReceived += 1;

        // Interaction last (read-only call to the fixed, immutable gate contract).
        require(agentID.balanceOf(target) > 0, "StillAlive: target has no Agent ID");

        emit Poked(msg.sender, target, dayNow);
    }

    /// @notice Claim the soulbound NFT badge for a reached best-streak milestone.
    /// @param tier 1 = Week Alive (7), 2 = Month Alive (30), 3 = Immortal (100).
    function claimBadge(uint8 tier) external onlyHolder {
        uint256 threshold = badgeThreshold(tier);
        require(threshold > 0, "StillAlive: invalid tier");
        require(!_badgeClaimed[msg.sender][tier], "StillAlive: badge already claimed");
        require(_users[msg.sender].bestStreak >= threshold, "StillAlive: streak too low");

        _badgeClaimed[msg.sender][tier] = true;
        uint256 tokenId = _nextTokenId++;
        _tokenOwner[tokenId] = msg.sender;
        _tokenTier[tokenId] = tier;
        _badgeBalance[msg.sender] += 1;

        emit Transfer(address(0), msg.sender, tokenId);
        emit BadgeClaimed(msg.sender, tier, tokenId);
    }

    // ------------------------------------------------------------------
    // Public views — the "proof" API any third party can read
    // ------------------------------------------------------------------

    /// @notice Current UTC day index (days since 1970-01-01).
    function today() public view returns (uint256) {
        return _today();
    }

    /// @notice Has this address signed the wall today?
    function isAliveToday(address user) external view returns (bool) {
        UserState storage u = _users[user];
        return u.initialized && u.lastSignDay == _today();
    }

    /// @notice UTC day index of the user's most recent sign (0 if never signed).
    function lastSeenDay(address user) external view returns (uint256) {
        return _users[user].lastSignDay;
    }

    /// @notice Effective streak data for a user.
    /// @return current Streak still alive right now (0 if already broken beyond saving)
    /// @return best Best streak ever (never decreases)
    /// @return freezesLeft Streak Freezes available right now (0 or 1)
    function getStreak(address user)
        external
        view
        returns (uint256 current, uint256 best, uint256 freezesLeft)
    {
        return (_effectiveStreak(user), _users[user].bestStreak, _freezesLeft(user));
    }

    /// @notice Everything a profile page needs in one call.
    function getUserSummary(address user)
        external
        view
        returns (
            uint256 lastSignDay_,
            uint256 currentStreak,
            uint256 bestStreak,
            uint256 freezesLeft,
            uint256 totalSigns,
            uint256 pokesReceived_,
            bool signedToday
        )
    {
        UserState storage u = _users[user];
        return (
            u.lastSignDay,
            _effectiveStreak(user),
            u.bestStreak,
            _freezesLeft(user),
            u.totalSigns,
            u.pokesReceived,
            u.initialized && u.lastSignDay == _today()
        );
    }

    /// @notice How many agents have signed the wall today.
    function aliveCountToday() external view returns (uint256) {
        return _signersOfDay[_today()].length;
    }

    /// @notice How many agents signed the wall on a given UTC day.
    function aliveCountOn(uint256 day) external view returns (uint256) {
        return _signersOfDay[day].length;
    }

    /// @notice Paginated list of today's signers, in sign order.
    function getSignersToday(uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory page, uint256 total)
    {
        return getSignersOfDay(_today(), offset, limit);
    }

    /// @notice Paginated list of a given day's signers, in sign order (wall archive).
    function getSignersOfDay(uint256 day, uint256 offset, uint256 limit)
        public
        view
        returns (address[] memory page, uint256 total)
    {
        address[] storage all = _signersOfDay[day];
        total = all.length;
        if (limit > MAX_PAGE_SIZE) limit = MAX_PAGE_SIZE; // DoS guard
        if (offset >= total || limit == 0) {
            return (new address[](0), total);
        }
        uint256 end = offset + limit;
        if (end > total) end = total;
        page = new address[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            page[i - offset] = all[i];
        }
    }

    /// @notice The status a user signed with on a given day ("" if none / empty).
    function statusOf(uint256 day, address user) external view returns (string memory) {
        return _statusOfDay[day][user];
    }

    /// @notice Did this user sign on this exact UTC day? (heatmap / archive reads)
    function hasSignedOn(address user, uint256 day) external view returns (bool) {
        return _signedOn[day][user];
    }

    /// @notice Total pokes a user has ever received.
    function pokesReceived(address user) external view returns (uint256) {
        return _users[user].pokesReceived;
    }

    /// @notice Has this user claimed the badge of this tier? (shared whitelist gate)
    function hasBadge(address user, uint8 tier) external view returns (bool) {
        return _badgeClaimed[user][tier];
    }

    /// @notice Best-streak threshold of a badge tier (0 for an invalid tier).
    function badgeThreshold(uint8 tier) public pure returns (uint256) {
        if (tier == TIER_WEEK) return 7;
        if (tier == TIER_MONTH) return 30;
        if (tier == TIER_IMMORTAL) return 100;
        return 0;
    }

    /// @notice Display name of a badge tier.
    function badgeName(uint8 tier) public pure returns (string memory) {
        if (tier == TIER_WEEK) return "Week Alive";
        if (tier == TIER_MONTH) return "Month Alive";
        if (tier == TIER_IMMORTAL) return "Immortal";
        return "";
    }

    // ------------------------------------------------------------------
    // Minimal ERC-721 for the badges — soulbound (all transfers revert)
    // ------------------------------------------------------------------

    function name() external pure returns (string memory) {
        return "StillAlive Badge";
    }

    function symbol() external pure returns (string memory) {
        return "ALIVE";
    }

    /// @notice Number of badge NFTs owned (0–3). NOTE: this is the badge balance,
    ///         not an Agent ID balance.
    function balanceOf(address owner) external view returns (uint256) {
        require(owner != address(0), "StillAlive: zero address");
        return _badgeBalance[owner];
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        address owner = _tokenOwner[tokenId];
        require(owner != address(0), "StillAlive: nonexistent token");
        return owner;
    }

    /// @notice Which tier (1/2/3) a badge token belongs to.
    function tokenTier(uint256 tokenId) external view returns (uint8) {
        require(_tokenOwner[tokenId] != address(0), "StillAlive: nonexistent token");
        return _tokenTier[tokenId];
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        require(_tokenOwner[tokenId] != address(0), "StillAlive: nonexistent token");
        uint8 tier = _tokenTier[tokenId];
        return
            string(
                abi.encodePacked(
                    "data:application/json;utf8,",
                    '{"name":"StillAlive - ',
                    badgeName(tier),
                    '","description":"Soulbound proof-of-liveness badge earned on StillAlive, the daily check-in wall for Binance Agent ID holders. Non-transferable.",',
                    '"attributes":[{"trait_type":"Badge","value":"',
                    badgeName(tier),
                    '"},{"trait_type":"Best streak (days)","value":"',
                    _toString(badgeThreshold(tier)),
                    '"}]}'
                )
            );
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        require(_tokenOwner[tokenId] != address(0), "StillAlive: nonexistent token");
        return address(0); // soulbound: approvals are meaningless and always empty
    }

    function isApprovedForAll(address, address) external pure returns (bool) {
        return false;
    }

    function approve(address, uint256) external pure {
        revert("StillAlive: badges are soulbound");
    }

    function setApprovalForAll(address, bool) external pure {
        revert("StillAlive: badges are soulbound");
    }

    function transferFrom(address, address, uint256) external pure {
        revert("StillAlive: badges are soulbound");
    }

    function safeTransferFrom(address, address, uint256) external pure {
        revert("StillAlive: badges are soulbound");
    }

    function safeTransferFrom(address, address, uint256, bytes calldata) external pure {
        revert("StillAlive: badges are soulbound");
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return
            interfaceId == 0x01ffc9a7 || // ERC165
            interfaceId == 0x80ac58cd || // ERC721
            interfaceId == 0x5b5e139f; // ERC721Metadata
    }

    // ------------------------------------------------------------------
    // Internals: day / month math, freeze logic, streak decay
    // ------------------------------------------------------------------

    function _today() internal view returns (uint256) {
        return block.timestamp / SECONDS_PER_DAY;
    }

    /// @dev Calendar-month id (year * 12 + month - 1) for a UTC day index,
    ///      via Howard Hinnant's civil-from-days algorithm. Used only to know
    ///      when a new month starts so the Streak Freeze can refill — lazily,
    ///      inside the user's next sign, with no keeper and no cron.
    function _monthId(uint256 dayNumber) internal pure returns (uint256) {
        uint256 z = dayNumber + 719468;
        uint256 era = z / 146097;
        uint256 doe = z - era * 146097; // day of era, [0, 146096]
        uint256 yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // year of era, [0, 399]
        uint256 y = yoe + era * 400;
        uint256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // day of year, [0, 365]
        uint256 mp = (5 * doy + 2) / 153; // month index from March, [0, 11]
        uint256 m = mp < 10 ? mp + 3 : mp - 9; // calendar month, [1, 12]
        if (m <= 2) y += 1; // Jan/Feb belong to the next civil year in this scheme
        return y * 12 + (m - 1);
    }

    /// @dev Lazy monthly freeze refill: the first time a user is touched in a
    ///      new calendar month, their freeze is (re)set to 1. Never stacks.
    function _syncFreeze(UserState storage u, uint256 dayNow) internal {
        uint256 mid = _monthId(dayNow);
        if (u.freezeMonthId != mid) {
            u.freezeMonthId = mid;
            u.hasFreeze = true;
        }
    }

    /// @dev Freeze availability as a view (mirrors what _syncFreeze would do).
    function _freezesLeft(address user) internal view returns (uint256) {
        UserState storage u = _users[user];
        if (u.freezeMonthId != _monthId(_today())) return 1; // new month: refilled
        return u.hasFreeze ? 1 : 0;
    }

    /// @dev The streak as it stands *right now*: the stored value while it can
    ///      still be continued (signed today/yesterday, or one missed day with
    ///      a freeze standing by), otherwise 0.
    function _effectiveStreak(address user) internal view returns (uint256) {
        UserState storage u = _users[user];
        if (!u.initialized) return 0;
        uint256 gap = _today() - u.lastSignDay;
        if (gap <= 1) return u.currentStreak;
        if (gap == 2 && _freezesLeft(user) == 1) return u.currentStreak;
        return 0;
    }

    function _toString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }
}
