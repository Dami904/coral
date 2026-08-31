// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../contracts/SpendGuard.sol";
import "../contracts/MockUSDC.sol";

contract SpendGuardTest is Test {
    // Mirror the contract's events so vm.expectEmit can match them by signature.
    event PaymentSent(address indexed payTo, uint256 amount);
    event PaymentBlocked(address indexed payTo, uint256 amount, string reason);
    event PaymentPending(uint256 indexed requestId, address indexed payTo, uint256 amount);
    event PaymentApproved(uint256 indexed requestId);
    event PaymentRejected(uint256 indexed requestId);
    event PolicyQueued(uint256 eligibleAt);
    event PolicyExecuted();
    event PolicyCancelled();
    event WithdrawQueued(uint256 amount, uint256 eligibleAt);
    event WithdrawExecuted(uint256 amount);
    event WithdrawCancelled();
    event OwnershipTransferStarted(address indexed newOwner);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);

    // Fixed start time: real timestamps are always >> any budget/rate window, but
    // block.timestamp starts near 0 on a fresh anvil/test chain, and
    // `block.timestamp - budgetSeconds` underflows (reverts) if it doesn't. Warping
    // forward first is what makes these tests representative of a real chain.
    uint256 constant START = 1_800_000_000;
    uint256 constant GUARD_FUNDING = 100_000e6;

    // Main test guard uses a zero timelock delay so every pre-existing,
    // exact-timestamp-dependent test keeps working unchanged: queue+execute
    // happens at the same block.timestamp, no time moves. Dedicated
    // delay-mechanics tests below deploy their own guard via
    // _deployWithDelay(...) instead. Capacities are generous (well above
    // anything these tests' policies need) so the new capacity check never
    // trips incidentally — dedicated capacity tests use small, explicit caps.
    uint256 constant TIMELOCK_DELAY = 0;
    uint256 constant RATE_CAP = 1_000;
    uint256 constant BUDGET_CAP = 1_000;

    MockUSDC usdc;
    SpendGuard guard;
    address agentAddr;
    address vendor;
    address outsider;
    address nonOwner;

    function setUp() public {
        vm.warp(START);
        agentAddr = makeAddr("agent");
        vendor = makeAddr("vendor");
        outsider = makeAddr("outsider");
        nonOwner = makeAddr("nonOwner");

        usdc = new MockUSDC();
        guard = new SpendGuard(
            address(usdc), agentAddr, TIMELOCK_DELAY, RATE_CAP, BUDGET_CAP,
            _allow(vendor), 0, 0, 0, 3600, 0, 3600 // bootstrap policy; every test overrides via _setPolicy
        ); // test contract == owner
        usdc.mint(address(guard), GUARD_FUNDING);
    }

    function _allow(address a) internal pure returns (address[] memory arr) {
        arr = new address[](1);
        arr[0] = a;
    }

    function _setPolicy(
        uint256 maxPerPayment,
        uint256 humanApprovalThreshold,
        uint256 budgetAmount,
        uint256 budgetSeconds,
        uint256 rateMax,
        uint256 rateSeconds
    ) internal {
        guard.queueSetPolicy(_allow(vendor), maxPerPayment, humanApprovalThreshold, budgetAmount, budgetSeconds, rateMax, rateSeconds);
        guard.executeSetPolicy(); // TIMELOCK_DELAY == 0 on the main guard: immediately eligible, no time moves
    }

    function _deployWithDelay(uint256 delay) internal returns (SpendGuard g) {
        g = new SpendGuard(
            address(usdc), agentAddr, delay, RATE_CAP, BUDGET_CAP,
            _allow(vendor), 100e6, 50e6, 200e6, 3600, 10, 3600
        );
        usdc.mint(address(g), GUARD_FUNDING);
    }

    // ─── constructor / access control ───────────────────────────────────────

    function test_Constructor_SetsState() public view {
        assertEq(guard.owner(), address(this));
        assertEq(guard.agent(), agentAddr);
        assertEq(address(guard.usdc()), address(usdc));
    }

    function test_QueueSetPolicy_RevertsIfNotOwner() public {
        vm.prank(nonOwner);
        vm.expectRevert("not owner");
        guard.queueSetPolicy(_allow(vendor), 100e6, 50e6, 200e6, 3600, 3, 3600);
    }

    function test_QueueSetPolicy_RevertsIfThresholdAboveCeiling() public {
        vm.expectRevert("threshold above ceiling");
        guard.queueSetPolicy(_allow(vendor), 100e6, 100e6 + 1, 200e6, 3600, 3, 3600);
    }

    function test_QueueSetPolicy_RevertsIfRateMaxExceedsCapacity() public {
        vm.expectRevert("rateMax exceeds fixed capacity");
        guard.queueSetPolicy(_allow(vendor), 100e6, 100e6, 200e6, 3600, RATE_CAP + 1, 3600);
    }

    // ─── timelock: setPolicy queue / execute / cancel ────────────────────────

    function test_QueueSetPolicy_ExecuteRevertsBeforeDelayElapsed() public {
        SpendGuard g = _deployWithDelay(1000);
        g.queueSetPolicy(_allow(vendor), 200e6, 100e6, 400e6, 3600, 20, 3600);

        vm.warp(block.timestamp + 999);
        vm.expectRevert("timelock not elapsed");
        g.executeSetPolicy();
    }

    function test_QueueSetPolicy_ExecuteSucceedsAtDelayBoundary() public {
        SpendGuard g = _deployWithDelay(1000);
        g.queueSetPolicy(_allow(vendor), 200e6, 100e6, 400e6, 3600, 20, 3600);

        vm.warp(block.timestamp + 1000); // exactly eligible
        g.executeSetPolicy();

        assertEq(g.maxPerPayment(), 200e6);
        assertEq(g.rateMax(), 20);
        assertFalse(g.queuedPolicyExists());
    }

    function test_CancelSetPolicy_PreventsExecute() public {
        SpendGuard g = _deployWithDelay(1000);
        g.queueSetPolicy(_allow(vendor), 200e6, 100e6, 400e6, 3600, 20, 3600);
        g.cancelSetPolicy();

        vm.warp(block.timestamp + 1000);
        vm.expectRevert("no policy queued");
        g.executeSetPolicy();
    }

    function test_CancelSetPolicy_RevertsIfNotOwner() public {
        SpendGuard g = _deployWithDelay(1000);
        g.queueSetPolicy(_allow(vendor), 200e6, 100e6, 400e6, 3600, 20, 3600);

        vm.prank(nonOwner);
        vm.expectRevert("not owner");
        g.cancelSetPolicy();
    }

    // ─── ownerApprove has no added delay (regression) ────────────────────────

    function test_OwnerApprove_HasNoTimelockDelay() public {
        SpendGuard g = _deployWithDelay(1000); // real delay on setPolicy/withdraw
        vm.prank(agentAddr);
        (, uint256 id) = g.requestPayment(vendor, 60e6); // above threshold (50e6) -> pending

        // No warp at all: approval executes immediately, unlike setPolicy/withdraw.
        uint256 before = usdc.balanceOf(vendor);
        g.ownerApprove(id);
        assertEq(usdc.balanceOf(vendor), before + 60e6);
    }

    // ─── withdraw: queue / execute / cancel ──────────────────────────────────

    function test_QueueWithdraw_RevertsIfNotOwner() public {
        vm.prank(nonOwner);
        vm.expectRevert("not owner");
        guard.queueWithdraw(1e6);
    }

    function test_QueueWithdraw_ExecuteRevertsBeforeDelayElapsed() public {
        SpendGuard g = _deployWithDelay(1000);
        g.queueWithdraw(10e6);
        vm.warp(block.timestamp + 999);
        vm.expectRevert("timelock not elapsed");
        g.executeWithdraw();
    }

    function test_QueueWithdraw_ExecuteSucceedsAtDelayBoundary() public {
        SpendGuard g = _deployWithDelay(1000);
        uint256 before = usdc.balanceOf(address(this));
        g.queueWithdraw(10e6);
        vm.warp(block.timestamp + 1000);

        vm.expectEmit(false, false, false, true);
        emit WithdrawExecuted(10e6);
        g.executeWithdraw();

        assertEq(usdc.balanceOf(address(this)), before + 10e6);
    }

    function test_CancelWithdraw_PreventsExecute() public {
        SpendGuard g = _deployWithDelay(1000);
        g.queueWithdraw(10e6);
        g.cancelWithdraw();

        vm.warp(block.timestamp + 1000);
        vm.expectRevert("no withdraw queued");
        g.executeWithdraw();
    }

    // ─── two-step ownership transfer ──────────────────────────────────────────

    function test_TransferOwnership_RevertsIfNotOwner() public {
        vm.prank(nonOwner);
        vm.expectRevert("not owner");
        guard.transferOwnership(nonOwner);
    }

    function test_TransferOwnership_RevertsForZeroAddress() public {
        vm.expectRevert("new owner is zero address");
        guard.transferOwnership(address(0));
    }

    function test_TransferOwnership_DoesNotChangeOwnerUntilAccepted() public {
        guard.transferOwnership(nonOwner);
        assertEq(guard.owner(), address(this));
        assertEq(guard.pendingOwner(), nonOwner);
    }

    function test_AcceptOwnership_RevertsIfNotPendingOwner() public {
        guard.transferOwnership(nonOwner);
        vm.prank(outsider);
        vm.expectRevert("not pending owner");
        guard.acceptOwnership();
    }

    function test_AcceptOwnership_TransfersControlAndOldOwnerLosesAccess() public {
        guard.transferOwnership(nonOwner);
        vm.prank(nonOwner);
        guard.acceptOwnership();

        assertEq(guard.owner(), nonOwner);
        assertEq(guard.pendingOwner(), address(0));

        vm.expectRevert("not owner");
        guard.queueSetPolicy(_allow(vendor), 1e6, 1e6, 1e6, 3600, 1, 3600);
    }

    // ─── ring-buffer capacity: bounded budget/rate logs ──────────────────────

    function test_RingBuffer_RateLogEvictsOldestBeyondCapacity() public {
        // Capacity exactly matches rateMax so eviction timing is precise.
        uint256 cap = 3;
        SpendGuard g = new SpendGuard(
            address(usdc), agentAddr, 0, cap, cap * 10,
            _allow(vendor), 100e6, 100e6, 1000e6, 3600, cap, 3600
        );
        usdc.mint(address(g), GUARD_FUNDING);

        vm.startPrank(agentAddr);
        for (uint256 i = 0; i < cap; i++) {
            (bool sent,) = g.requestPayment(vendor, 1e6);
            assertTrue(sent);
        }
        vm.expectEmit(true, false, false, true);
        emit PaymentBlocked(vendor, 1e6, "rate-limit");
        g.requestPayment(vendor, 1e6);
        vm.stopPrank();

        // Once every entry expires, the ring buffer's already-reused slots
        // still correctly re-admit a fresh payment — proves the buffer isn't
        // silently losing capacity over time.
        vm.warp(block.timestamp + 3600 + 1);
        vm.prank(agentAddr);
        (bool sentAfterExpiry,) = g.requestPayment(vendor, 1e6);
        assertTrue(sentAfterExpiry);
    }

    function test_RingBuffer_BudgetLog_TightCapacityStillEnforcesWindow() public {
        // rateMax=2, rateSeconds=3600, budgetSeconds=3600 -> required
        // budgetLogCapacity = 2 * (ceil(3600/3600)+1) = 4, the exact minimum
        // this policy needs. Every payment here writes into an
        // already-once-used slot.
        uint256 cap = 4;
        SpendGuard g = new SpendGuard(
            address(usdc), agentAddr, 0, 10, cap,
            _allow(vendor), 100e6, 100e6, 100e6, 3600, 2, 3600
        );
        usdc.mint(address(g), GUARD_FUNDING);

        vm.startPrank(agentAddr);
        (bool s1,) = g.requestPayment(vendor, 50e6);
        assertTrue(s1);
        (bool s2,) = g.requestPayment(vendor, 50e6); // sum == 100e6 budget, inclusive
        assertTrue(s2);

        vm.expectEmit(true, false, false, true);
        emit PaymentBlocked(vendor, 1e6, "budget-window");
        (bool s3,) = g.requestPayment(vendor, 1e6);
        assertFalse(s3);
        vm.stopPrank();

        vm.warp(block.timestamp + 3600 + 1); // both entries now expired
        vm.prank(agentAddr);
        (bool s4,) = g.requestPayment(vendor, 100e6); // full budget available again
        assertTrue(s4);
    }

    function test_Constructor_RevertsIfBudgetCapacityBelowFormulaMinimum() public {
        // Same policy as the previous test (minimum capacity 4), one slot short.
        vm.expectRevert("budget/rate window exceeds fixed capacity");
        new SpendGuard(
            address(usdc), agentAddr, 0, 10, 3,
            _allow(vendor), 100e6, 100e6, 100e6, 3600, 2, 3600
        );
    }

    function test_RequestPayment_RevertsIfNotAgent() public {
        _setPolicy(100e6, 50e6, 200e6, 3600, 3, 3600);
        vm.prank(outsider);
        vm.expectRevert("not agent");
        guard.requestPayment(vendor, 10e6);
    }

    // ─── rule blocking + fixed evaluation order ─────────────────────────────

    function test_RequestPayment_BlocksNonAllowlistedVendor() public {
        _setPolicy(100e6, 50e6, 200e6, 3600, 3, 3600);
        vm.expectEmit(true, false, false, true);
        emit PaymentBlocked(outsider, 10e6, "vendor-allowlist");
        vm.prank(agentAddr);
        (bool sent, uint256 id) = guard.requestPayment(outsider, 10e6);
        assertFalse(sent);
        assertEq(id, 0);
    }

    function test_RequestPayment_AllowlistCheckedBeforeMaxPerPayment() public {
        // outsider is not allowlisted AND the amount also exceeds maxPerPayment;
        // the reported reason must still be the allowlist check, since it runs first.
        _setPolicy(100e6, 50e6, 200e6, 3600, 3, 3600);
        vm.expectEmit(true, false, false, true);
        emit PaymentBlocked(outsider, 150e6, "vendor-allowlist");
        vm.prank(agentAddr);
        guard.requestPayment(outsider, 150e6);
    }

    function test_RequestPayment_MaxPerPaymentBoundary() public {
        _setPolicy(100e6, 100e6, 1000e6, 3600, 100, 3600); // threshold == max so in-range amounts auto-exec
        vm.prank(agentAddr);
        (bool sentAtBoundary,) = guard.requestPayment(vendor, 100e6); // == maxPerPayment, inclusive
        assertTrue(sentAtBoundary);

        vm.expectEmit(true, false, false, true);
        emit PaymentBlocked(vendor, 100e6 + 1, "max-per-payment");
        vm.prank(agentAddr);
        (bool sentOverBoundary,) = guard.requestPayment(vendor, 100e6 + 1);
        assertFalse(sentOverBoundary);
    }

    function test_RequestPayment_MaxPerPaymentCheckedBeforeBudgetWindow() public {
        // budgetAmount is far too small for this payment too, but the reported
        // reason must be max-per-payment since that check runs first.
        _setPolicy(100e6, 100e6, 1e6, 3600, 100, 3600);
        vm.expectEmit(true, false, false, true);
        emit PaymentBlocked(vendor, 150e6, "max-per-payment");
        vm.prank(agentAddr);
        guard.requestPayment(vendor, 150e6);
    }

    function test_RequestPayment_BudgetWindow_InclusiveBoundaryThenBlocks() public {
        _setPolicy(200e6, 200e6, 150e6, 3600, 100, 3600); // threshold high: everything below auto-execs
        vm.startPrank(agentAddr);
        (bool sent1,) = guard.requestPayment(vendor, 100e6);
        assertTrue(sent1);

        (bool sent2,) = guard.requestPayment(vendor, 50e6); // sum == budgetAmount exactly, inclusive
        assertTrue(sent2);

        vm.expectEmit(true, false, false, true);
        emit PaymentBlocked(vendor, 1e6, "budget-window");
        (bool sent3,) = guard.requestPayment(vendor, 1e6); // sum would exceed budgetAmount by 1
        assertFalse(sent3);
        vm.stopPrank();
    }

    function test_RequestPayment_BudgetWindowCheckedBeforeRateLimit() public {
        // rateMax = 0 means the rate check would also fail, but budget-window
        // must be reported since it is evaluated first.
        _setPolicy(100e6, 100e6, 10e6, 3600, 0, 3600);
        vm.expectEmit(true, false, false, true);
        emit PaymentBlocked(vendor, 50e6, "budget-window");
        vm.prank(agentAddr);
        guard.requestPayment(vendor, 50e6);
    }

    function test_RequestPayment_RateLimit_InclusiveBoundaryThenBlocks() public {
        _setPolicy(100e6, 100e6, 1000e6, 3600, 2, 3600); // budget generous, threshold == max so in-range amounts auto-exec
        vm.startPrank(agentAddr);
        (bool sent1,) = guard.requestPayment(vendor, 10e6);
        assertTrue(sent1);
        (bool sent2,) = guard.requestPayment(vendor, 10e6); // count == rateMax exactly, inclusive
        assertTrue(sent2);

        vm.expectEmit(true, false, false, true);
        emit PaymentBlocked(vendor, 10e6, "rate-limit");
        (bool sent3,) = guard.requestPayment(vendor, 10e6); // would be the 3rd payment, exceeds rateMax
        assertFalse(sent3);
        vm.stopPrank();
    }

    // ─── auto-execute vs. human-approval escalation ─────────────────────────

    function test_RequestPayment_AutoExecutesBelowThreshold_TransfersAndEmits() public {
        _setPolicy(100e6, 50e6, 200e6, 3600, 10, 3600);
        uint256 before = usdc.balanceOf(vendor);

        vm.expectEmit(true, false, false, true);
        emit PaymentSent(vendor, 10e6);
        vm.prank(agentAddr);
        (bool sent, uint256 id) = guard.requestPayment(vendor, 10e6);

        assertTrue(sent);
        assertEq(id, 0);
        assertEq(usdc.balanceOf(vendor), before + 10e6);
    }

    function test_RequestPayment_AutoExecutesAtThresholdBoundary() public {
        _setPolicy(100e6, 50e6, 200e6, 3600, 10, 3600);
        vm.prank(agentAddr);
        (bool sent,) = guard.requestPayment(vendor, 50e6); // == humanApprovalThreshold, inclusive -> auto-exec
        assertTrue(sent);
    }

    function test_RequestPayment_EscalatesAboveThreshold_NoTransferYet() public {
        _setPolicy(100e6, 50e6, 200e6, 3600, 10, 3600);
        uint256 before = usdc.balanceOf(vendor);

        vm.expectEmit(true, true, false, true);
        emit PaymentPending(0, vendor, 60e6);
        vm.prank(agentAddr);
        (bool sent, uint256 id) = guard.requestPayment(vendor, 60e6);

        assertFalse(sent);
        assertEq(id, 0); // first pending request id
        assertEq(usdc.balanceOf(vendor), before); // no funds moved yet

        (address payTo, uint256 amount, bool exists, bool approved) = guard.pending(0);
        assertEq(payTo, vendor);
        assertEq(amount, 60e6);
        assertTrue(exists);
        assertFalse(approved);
    }

    function test_RequestPayment_PendingDoesNotConsumeBudgetOrRateUntilApproved() public {
        // budgetAmount/rateMax are sized so a second escalated request would be
        // blocked if the first (still-pending, unapproved) request counted.
        _setPolicy(100e6, 50e6, 100e6, 3600, 1, 3600);
        vm.startPrank(agentAddr);
        (bool sent1, uint256 id1) = guard.requestPayment(vendor, 60e6);
        assertFalse(sent1);
        assertEq(id1, 0);

        (bool sent2, uint256 id2) = guard.requestPayment(vendor, 60e6);
        assertFalse(sent2); // still just pending (above threshold), not blocked
        assertEq(id2, 1);
        vm.stopPrank();
    }

    // ─── rolling time windows ────────────────────────────────────────────────

    function test_BudgetWindow_ExpiredEntriesExcluded() public {
        _setPolicy(100e6, 100e6, 100e6, 3600, 100, 3600);
        vm.prank(agentAddr);
        guard.requestPayment(vendor, 100e6); // fully consumes the budget window

        vm.warp(START + 3600 + 1); // fully past the window
        vm.prank(agentAddr);
        (bool sent,) = guard.requestPayment(vendor, 100e6);
        assertTrue(sent);
    }

    function test_BudgetWindow_ExactCutoffExcluded() public {
        _setPolicy(100e6, 100e6, 100e6, 3600, 100, 3600);
        vm.prank(agentAddr);
        guard.requestPayment(vendor, 100e6); // ts = START, fully consumes budget

        vm.warp(START + 3600 - 1); // cutoff = ts - 1, old entry (ts) still > cutoff: still counted
        vm.expectEmit(true, false, false, true);
        emit PaymentBlocked(vendor, 1e6, "budget-window");
        vm.prank(agentAddr);
        (bool sentBefore,) = guard.requestPayment(vendor, 1e6);
        assertFalse(sentBefore);

        vm.warp(START + 3600); // cutoff == ts exactly: strict '>' excludes it now
        vm.prank(agentAddr);
        (bool sentAtCutoff,) = guard.requestPayment(vendor, 1e6);
        assertTrue(sentAtCutoff);
    }

    function test_RateWindow_ExpiredEntriesExcluded() public {
        _setPolicy(100e6, 100e6, 1000e6, 3600, 1, 3600);
        vm.prank(agentAddr);
        guard.requestPayment(vendor, 1e6); // consumes the single rate slot

        vm.warp(START + 3600 + 1);
        vm.prank(agentAddr);
        (bool sent,) = guard.requestPayment(vendor, 1e6);
        assertTrue(sent);
    }

    // ─── ownerApprove ────────────────────────────────────────────────────────

    function test_OwnerApprove_RevertsIfNotOwner() public {
        _setPolicy(100e6, 50e6, 200e6, 3600, 10, 3600);
        vm.prank(agentAddr);
        (, uint256 id) = guard.requestPayment(vendor, 60e6);

        vm.prank(nonOwner);
        vm.expectRevert("not owner");
        guard.ownerApprove(id);
    }

    function test_OwnerApprove_RevertsForNonexistentRequest() public {
        vm.expectRevert("invalid request");
        guard.ownerApprove(999);
    }

    function test_OwnerApprove_RevertsIfAlreadyApproved() public {
        _setPolicy(100e6, 50e6, 200e6, 3600, 10, 3600);
        vm.prank(agentAddr);
        (, uint256 id) = guard.requestPayment(vendor, 60e6);
        guard.ownerApprove(id);

        vm.expectRevert("invalid request");
        guard.ownerApprove(id);
    }

    function test_OwnerApprove_TransfersAndEmitsEvents() public {
        _setPolicy(100e6, 50e6, 200e6, 3600, 10, 3600);
        vm.prank(agentAddr);
        (, uint256 id) = guard.requestPayment(vendor, 60e6);
        uint256 before = usdc.balanceOf(vendor);

        vm.expectEmit(true, false, false, true);
        emit PaymentApproved(id);
        vm.expectEmit(true, false, false, true);
        emit PaymentSent(vendor, 60e6);
        guard.ownerApprove(id);

        assertEq(usdc.balanceOf(vendor), before + 60e6);
        (, , , bool approved) = guard.pending(id);
        assertTrue(approved);
    }

    function test_OwnerApprove_RevertsIfBudgetExceededAtApprovalTime() public {
        // Escalate a request, then spend down the budget in the meantime so
        // approval-time re-check (not just request-time) catches the overrun.
        _setPolicy(100e6, 50e6, 100e6, 3600, 10, 3600);
        vm.prank(agentAddr);
        (, uint256 id) = guard.requestPayment(vendor, 60e6); // pending, does not consume budget yet

        vm.prank(agentAddr);
        guard.requestPayment(vendor, 50e6); // auto-exec, consumes 50 of the 100e6 budget

        vm.expectRevert("budget-window at approval");
        guard.ownerApprove(id); // 50 + 60 > 100e6 budget
    }

    function test_OwnerApprove_RevertsIfRateLimitExceededAtApprovalTime() public {
        _setPolicy(100e6, 50e6, 1000e6, 3600, 1, 3600);
        vm.prank(agentAddr);
        (, uint256 id) = guard.requestPayment(vendor, 60e6); // pending, does not consume rate slot yet

        vm.prank(agentAddr);
        guard.requestPayment(vendor, 10e6); // auto-exec, consumes the single rate slot

        vm.expectRevert("rate-limit at approval");
        guard.ownerApprove(id);
    }

    // ─── ownerReject ─────────────────────────────────────────────────────────

    function test_OwnerReject_RevertsIfNotOwner() public {
        _setPolicy(100e6, 50e6, 200e6, 3600, 10, 3600);
        vm.prank(agentAddr);
        (, uint256 id) = guard.requestPayment(vendor, 60e6);

        vm.prank(nonOwner);
        vm.expectRevert("not owner");
        guard.ownerReject(id);
    }

    function test_OwnerReject_RevertsForNonexistentRequest() public {
        vm.expectRevert("invalid request");
        guard.ownerReject(999);
    }

    function test_OwnerReject_DeletesPendingAndBlocksLaterApprove() public {
        _setPolicy(100e6, 50e6, 200e6, 3600, 10, 3600);
        vm.prank(agentAddr);
        (, uint256 id) = guard.requestPayment(vendor, 60e6);

        vm.expectEmit(true, false, false, true);
        emit PaymentRejected(id);
        guard.ownerReject(id);

        (, , bool exists,) = guard.pending(id);
        assertFalse(exists);

        vm.expectRevert("invalid request");
        guard.ownerApprove(id);
    }

    // ─── withdraw ────────────────────────────────────────────────────────────

    function test_Withdraw_RevertsIfNotOwner() public {
        vm.prank(nonOwner);
        vm.expectRevert("not owner");
        guard.queueWithdraw(1e6);
    }

    function test_Withdraw_TransfersToOwner() public {
        uint256 before = usdc.balanceOf(address(this));
        guard.queueWithdraw(10e6);
        guard.executeWithdraw(); // TIMELOCK_DELAY == 0 on the main guard
        assertEq(usdc.balanceOf(address(this)), before + 10e6);
        assertEq(usdc.balanceOf(address(guard)), GUARD_FUNDING - 10e6);
    }

    // ─── settlement failure ──────────────────────────────────────────────────

    function test_RequestPayment_RevertsIfGuardHasInsufficientBalance() public {
        guard.queueWithdraw(GUARD_FUNDING); // drain the guard
        guard.executeWithdraw();
        _setPolicy(100e6, 50e6, 200e6, 3600, 10, 3600);

        vm.prank(agentAddr);
        vm.expectRevert("insufficient balance"); // MockUSDC's own require, bubbled up
        guard.requestPayment(vendor, 10e6);
    }
}
