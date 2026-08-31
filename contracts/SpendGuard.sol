// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
}

contract SpendGuard {
    address public owner;
    address public pendingOwner;
    address public agent;
    IERC20 public immutable usdc;

    // Owner actions that can change future behavior or move funds unilaterally
    // (setPolicy, withdraw) go through a queue -> wait -> execute delay.
    // ownerApprove/ownerReject deliberately do NOT get this delay: they already
    // gate one specific, previously-capped (maxPerPayment) pending payment and
    // are themselves the human-in-the-loop control this system is built
    // around — a second delay on top would double-gate the same escalation and
    // defeat the "propose -> owner approves -> funds move" demo beat.
    uint256 public immutable timelockDelaySeconds;

    // Fixed-capacity ring buffers replace what used to be unbounded, forever-
    // growing arrays scanned in full on every call. Capacities are immutable
    // and validated against every future policy (see _checkCapacity): a
    // policy can be tightened freely post-deploy but cannot be loosened past
    // the capacity fixed here without a new deployment.
    uint256 public immutable rateLogCapacity;
    uint256 public immutable budgetLogCapacity;

    address[] public vendorAllowlist;
    uint256 public maxPerPayment;          // absolute ceiling — never approvable past this
    uint256 public humanApprovalThreshold; // above this, auto-exec becomes pending-approval
    uint256 public budgetAmount;
    uint256 public budgetSeconds;
    uint256 public rateMax;
    uint256 public rateSeconds;

    struct Entry { uint256 amount; uint256 ts; }
    // Both arrays are pre-filled to full capacity at construction and only
    // ever written via ring-buffer overwrite (see _issueAndSend) — length
    // never changes after construction, so every scan below is a fixed,
    // constant-bounded loop, not "every payment ever."
    Entry[] private budgetLog;
    uint256 private budgetHead;
    uint256[] private rateLog;
    uint256 private rateHead;

    struct PendingRequest { address payTo; uint256 amount; bool exists; bool approved; }
    mapping(uint256 => PendingRequest) public pending;
    uint256 public nextRequestId;

    struct QueuedPolicy {
        address[] allowlist;
        uint256 maxPerPayment;
        uint256 humanApprovalThreshold;
        uint256 budgetAmount;
        uint256 budgetSeconds;
        uint256 rateMax;
        uint256 rateSeconds;
        uint256 eligibleAt;
        bool exists;
    }
    QueuedPolicy private queuedPolicy;

    uint256 public queuedWithdrawAmount;
    uint256 public queuedWithdrawEligibleAt;
    bool public queuedWithdrawExists;

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

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }
    modifier onlyAgent() { require(msg.sender == agent, "not agent"); _; }
    modifier onlyPendingOwner() { require(msg.sender == pendingOwner, "not pending owner"); _; }

    constructor(
        address _usdc,
        address _agent,
        uint256 _timelockDelaySeconds,
        uint256 _rateLogCapacity,
        uint256 _budgetLogCapacity,
        address[] memory _allowlist,
        uint256 _maxPerPayment,
        uint256 _humanApprovalThreshold,
        uint256 _budgetAmount,
        uint256 _budgetSeconds,
        uint256 _rateMax,
        uint256 _rateSeconds
    ) {
        require(_agent != address(0), "agent is zero address");
        require(_rateLogCapacity > 0 && _budgetLogCapacity > 0, "capacity must be nonzero");

        owner = msg.sender;
        agent = _agent;
        usdc = IERC20(_usdc);
        timelockDelaySeconds = _timelockDelaySeconds;
        rateLogCapacity = _rateLogCapacity;
        budgetLogCapacity = _budgetLogCapacity;

        // Pre-fill both ring buffers to full capacity. Unwritten slots carry
        // ts=0, which every real deployment's window-cutoff math (block.timestamp
        // far exceeds budgetSeconds/rateSeconds on Base) naturally excludes as
        // already-expired, same as the underflow-avoidance assumption already
        // documented for this contract.
        for (uint256 i = 0; i < _rateLogCapacity; i++) rateLog.push(0);
        for (uint256 i = 0; i < _budgetLogCapacity; i++) budgetLog.push(Entry(0, 0));

        _applyPolicy(
            _allowlist, _maxPerPayment, _humanApprovalThreshold,
            _budgetAmount, _budgetSeconds, _rateMax, _rateSeconds
        );
    }

    // ─── policy: hand-rolled timelock (queue -> wait -> execute) ────────────

    function queueSetPolicy(
        address[] calldata _allowlist,
        uint256 _maxPerPayment,
        uint256 _humanApprovalThreshold,
        uint256 _budgetAmount,
        uint256 _budgetSeconds,
        uint256 _rateMax,
        uint256 _rateSeconds
    ) external onlyOwner {
        require(_humanApprovalThreshold <= _maxPerPayment, "threshold above ceiling");
        _checkCapacity(_budgetSeconds, _rateMax, _rateSeconds);

        delete queuedPolicy.allowlist;
        for (uint256 i = 0; i < _allowlist.length; i++) queuedPolicy.allowlist.push(_allowlist[i]);
        queuedPolicy.maxPerPayment = _maxPerPayment;
        queuedPolicy.humanApprovalThreshold = _humanApprovalThreshold;
        queuedPolicy.budgetAmount = _budgetAmount;
        queuedPolicy.budgetSeconds = _budgetSeconds;
        queuedPolicy.rateMax = _rateMax;
        queuedPolicy.rateSeconds = _rateSeconds;
        queuedPolicy.eligibleAt = block.timestamp + timelockDelaySeconds;
        queuedPolicy.exists = true;

        emit PolicyQueued(queuedPolicy.eligibleAt);
    }

    function executeSetPolicy() external onlyOwner {
        require(queuedPolicy.exists, "no policy queued");
        require(block.timestamp >= queuedPolicy.eligibleAt, "timelock not elapsed");

        _applyPolicy(
            queuedPolicy.allowlist,
            queuedPolicy.maxPerPayment,
            queuedPolicy.humanApprovalThreshold,
            queuedPolicy.budgetAmount,
            queuedPolicy.budgetSeconds,
            queuedPolicy.rateMax,
            queuedPolicy.rateSeconds
        );

        delete queuedPolicy;
        emit PolicyExecuted();
    }

    function cancelSetPolicy() external onlyOwner {
        require(queuedPolicy.exists, "no policy queued");
        delete queuedPolicy;
        emit PolicyCancelled();
    }

    function queuedPolicyEligibleAt() external view returns (uint256) {
        return queuedPolicy.eligibleAt;
    }

    function queuedPolicyExists() external view returns (bool) {
        return queuedPolicy.exists;
    }

    function _applyPolicy(
        address[] memory _allowlist,
        uint256 _maxPerPayment,
        uint256 _humanApprovalThreshold,
        uint256 _budgetAmount,
        uint256 _budgetSeconds,
        uint256 _rateMax,
        uint256 _rateSeconds
    ) private {
        require(_humanApprovalThreshold <= _maxPerPayment, "threshold above ceiling");
        _checkCapacity(_budgetSeconds, _rateMax, _rateSeconds);

        vendorAllowlist = _allowlist;
        maxPerPayment = _maxPerPayment;
        humanApprovalThreshold = _humanApprovalThreshold;
        budgetAmount = _budgetAmount;
        budgetSeconds = _budgetSeconds;
        rateMax = _rateMax;
        rateSeconds = _rateSeconds;
    }

    // Worst-case live entries in the rate window is rateMax (requestPayment
    // never lets a push happen once _windowCount()+1 > rateMax). Worst-case
    // live entries in the budget window is bounded by how many rate-limited
    // pushes can occur across a budgetSeconds-long span: rateMax per
    // rateSeconds, times the number of rateSeconds windows spanning
    // budgetSeconds (rounded up, plus one for partial-window overlap).
    function _checkCapacity(uint256 _budgetSeconds, uint256 _rateMax, uint256 _rateSeconds) private view {
        require(_rateMax <= rateLogCapacity, "rateMax exceeds fixed capacity");
        require(_rateSeconds > 0, "rateSeconds must be nonzero");

        uint256 windows = (_budgetSeconds + _rateSeconds - 1) / _rateSeconds + 1;
        uint256 worstCaseBudgetEntries = _rateMax * windows;
        require(worstCaseBudgetEntries <= budgetLogCapacity, "budget/rate window exceeds fixed capacity");
    }

    // ─── withdraw: same queue -> wait -> execute delay as policy changes ────

    function queueWithdraw(uint256 amount) external onlyOwner {
        require(amount > 0, "amount is zero");
        queuedWithdrawAmount = amount;
        queuedWithdrawEligibleAt = block.timestamp + timelockDelaySeconds;
        queuedWithdrawExists = true;
        emit WithdrawQueued(amount, queuedWithdrawEligibleAt);
    }

    function executeWithdraw() external onlyOwner {
        require(queuedWithdrawExists, "no withdraw queued");
        require(block.timestamp >= queuedWithdrawEligibleAt, "timelock not elapsed");

        uint256 amount = queuedWithdrawAmount;
        queuedWithdrawExists = false;
        queuedWithdrawAmount = 0;
        queuedWithdrawEligibleAt = 0;

        require(usdc.transfer(owner, amount), "transfer failed");
        emit WithdrawExecuted(amount);
    }

    function cancelWithdraw() external onlyOwner {
        require(queuedWithdrawExists, "no withdraw queued");
        queuedWithdrawExists = false;
        queuedWithdrawAmount = 0;
        queuedWithdrawEligibleAt = 0;
        emit WithdrawCancelled();
    }

    // ─── two-step ownership transfer ─────────────────────────────────────────
    // No delay needed here beyond the new owner actively accepting — that
    // acceptance step is itself the safety property (a typo'd or malicious
    // transferOwnership call can't silently take effect).

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "new owner is zero address");
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(newOwner);
    }

    function acceptOwnership() external onlyPendingOwner {
        address old = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipTransferred(old, owner);
    }

    // ─── payment request / escalation (unchanged behavior + ABI) ────────────

    function requestPayment(address payTo, uint256 amount)
        external
        onlyAgent
        returns (bool sentImmediately, uint256 requestId)
    {
        if (!_isAllowlisted(payTo)) { emit PaymentBlocked(payTo, amount, "vendor-allowlist"); return (false, 0); }
        if (amount > maxPerPayment) { emit PaymentBlocked(payTo, amount, "max-per-payment"); return (false, 0); }
        if (_windowSum() + amount > budgetAmount) { emit PaymentBlocked(payTo, amount, "budget-window"); return (false, 0); }
        if (_windowCount() + 1 > rateMax) { emit PaymentBlocked(payTo, amount, "rate-limit"); return (false, 0); }

        if (amount > humanApprovalThreshold) {
            uint256 id = nextRequestId++;
            pending[id] = PendingRequest(payTo, amount, true, false);
            emit PaymentPending(id, payTo, amount);
            return (false, id); // agent proposed, did NOT execute
        }

        _issueAndSend(payTo, amount);
        return (true, 0);
    }

    // Deliberately no timelock here — see the note on timelockDelaySeconds above.
    function ownerApprove(uint256 requestId) external onlyOwner {
        PendingRequest storage r = pending[requestId];
        require(r.exists && !r.approved, "invalid request");
        require(_windowSum() + r.amount <= budgetAmount, "budget-window at approval");
        require(_windowCount() + 1 <= rateMax, "rate-limit at approval");
        r.approved = true;
        emit PaymentApproved(requestId);
        _issueAndSend(r.payTo, r.amount);
    }

    function ownerReject(uint256 requestId) external onlyOwner {
        require(pending[requestId].exists, "invalid request");
        delete pending[requestId];
        emit PaymentRejected(requestId);
    }

    function _issueAndSend(address payTo, uint256 amount) internal {
        budgetLog[budgetHead] = Entry(amount, block.timestamp);
        budgetHead = (budgetHead + 1) % budgetLogCapacity;

        rateLog[rateHead] = block.timestamp;
        rateHead = (rateHead + 1) % rateLogCapacity;

        require(usdc.transfer(payTo, amount), "transfer failed");
        emit PaymentSent(payTo, amount);
    }

    function _isAllowlisted(address a) internal view returns (bool) {
        for (uint256 i = 0; i < vendorAllowlist.length; i++) {
            if (vendorAllowlist[i] == a) return true;
        }
        return false;
    }

    // Fixed-length scan (== budgetLogCapacity, set at deploy) instead of the
    // full-history scan this used to be — see _checkCapacity for why this
    // capacity is always large enough to hold every currently-live entry.
    function _windowSum() internal view returns (uint256 sum) {
        uint256 cutoff = block.timestamp - budgetSeconds;
        uint256 cap = budgetLogCapacity;
        for (uint256 i = 0; i < cap; i++) {
            if (budgetLog[i].ts > cutoff) sum += budgetLog[i].amount;
        }
    }

    function _windowCount() internal view returns (uint256 count) {
        uint256 cutoff = block.timestamp - rateSeconds;
        uint256 cap = rateLogCapacity;
        for (uint256 i = 0; i < cap; i++) {
            if (rateLog[i] > cutoff) count++;
        }
    }
}
