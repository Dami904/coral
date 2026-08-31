// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../contracts/MockUSDC.sol";
import "../contracts/SpendGuard.sol";

// Base Sepolia deploy: MockUSDC + SpendGuard, policy set, guard funded.
// Run: forge script script/Deploy.s.sol:Deploy --rpc-url base_sepolia --broadcast
contract Deploy is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address agent = vm.envAddress("AGENT_ADDRESS");
        address payTo = vm.envAddress("VENDOR_PAYTO_ADDRESS");
        address owner = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);

        MockUSDC usdc = new MockUSDC();
        usdc.mint(owner, 1_000 * 1e6); // 1000 mUSDC to owner

        address[] memory allowlist = new address[](1);
        allowlist[0] = payTo;

        uint256 maxPerPayment = 500_000;          // $0.50 (6dp) — matches the priciest real endpoint
        uint256 humanApprovalThreshold = 150_000; // $0.15 (6dp) — demo value, deliberately low
        uint256 budgetAmount = 2_000_000;         // $2.00 rolling
        uint256 budgetSeconds = 3600;             // 1hr window
        uint256 rateMax = 10;                     // 10 payments
        uint256 rateSeconds = 3600;               // 1hr window

        // Ring-buffer capacities per SpendGuard's _checkCapacity formula:
        // rateLogCapacity >= rateMax; budgetLogCapacity >= rateMax *
        // (ceil(budgetSeconds/rateSeconds)+1). Headroomed above the minimum
        // so the policy can be tightened later without hitting the cap.
        uint256 rateLogCapacity = 20;
        uint256 budgetLogCapacity = 50;

        // Policy is set atomically at construction (not a separate post-deploy
        // call) so the guard is immediately usable without waiting out its own
        // timelock for its first configuration.
        SpendGuard guard = new SpendGuard(
            address(usdc), agent, 3600, // timelockDelaySeconds: 1hr, for setPolicy/withdraw only
            rateLogCapacity, budgetLogCapacity,
            allowlist, maxPerPayment, humanApprovalThreshold,
            budgetAmount, budgetSeconds, rateMax, rateSeconds
        );

        usdc.transfer(address(guard), 100 * 1e6); // fund guard with 100 mUSDC

        vm.stopBroadcast();

        console.log("MockUSDC   :", address(usdc));
        console.log("SpendGuard :", address(guard));
        console.log("Owner      :", owner);
        console.log("Agent      :", agent);
    }
}
