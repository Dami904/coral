// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../contracts/SpendGuard.sol";

// Base MAINNET deploy: real SpendGuard against the real Base USDC token.
// Deliberately a separate script from Deploy.s.sol (not a flag/branch) so
// the free testnet path (`pnpm deploy:testnet`) can never accidentally
// broadcast here. Real gas, real irreversible transaction — only ever run
// this deliberately, after the funding checklist in PLAN.md/README.md is
// understood, never from an autonomous agent session (see CLAUDE.md).
//
// Does NOT fund the deployed guard with USDC — that is a separate, later,
// manually-run transfer so the deployed address can be verified on
// Basescan first (see README's mainnet funding checklist).
//
// Run: forge script script/DeployMainnet.s.sol:DeployMainnet --rpc-url base_mainnet --broadcast --verify
contract DeployMainnet is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address agent = vm.envAddress("AGENT_ADDRESS");
        address payTo = vm.envAddress("MAINNET_VENDOR_PAYTO_ADDRESS");
        address usdc = vm.envAddress("MAINNET_USDC_ADDRESS");
        address owner = vm.addr(deployerKey);

        address[] memory allowlist = new address[](1);
        allowlist[0] = payTo;

        // The one real price point confirmed live (docs/API_NOTES.md):
        // /api/evaluate costs $0.25 (250_000, 6dp). Policy below is sized
        // against that, not an arbitrary demo value — see PLAN.md's Item 6
        // section for the full reasoning.
        uint256 maxPerPayment = 500_000;          // $0.50 — headroom above the one real price
        // Deliberately BELOW the real $0.25 price: every real query
        // escalates, so the human-approval + auto-resume path (item 5) gets
        // exercised live on real money instead of silently auto-paying.
        // Raise to >= 250_000 instead if frictionless auto-pay is preferred
        // for the recorded demo.
        uint256 humanApprovalThreshold = 200_000; // $0.20
        uint256 budgetAmount = 3_000_000;         // $3.00 rolling — matches the funding plan
        uint256 budgetSeconds = 3600;
        uint256 rateMax = 12;
        uint256 rateSeconds = 3600;

        // Ring-buffer capacities per SpendGuard's _checkCapacity formula:
        // rateLogCapacity >= rateMax; budgetLogCapacity >= rateMax *
        // (ceil(budgetSeconds/rateSeconds)+1) = 12*2 = 24. Headroomed above
        // that minimum.
        uint256 rateLogCapacity = 20;
        uint256 budgetLogCapacity = 50;

        // 1 hour: proportionate to the few-dollar balance this guard will
        // ever hold, without blocking same-day policy tuning. See
        // docs/THREAT_MODEL.md.
        uint256 timelockDelaySeconds = 3600;

        vm.startBroadcast(deployerKey);

        SpendGuard guard = new SpendGuard(
            usdc, agent, timelockDelaySeconds,
            rateLogCapacity, budgetLogCapacity,
            allowlist, maxPerPayment, humanApprovalThreshold,
            budgetAmount, budgetSeconds, rateMax, rateSeconds
        );

        vm.stopBroadcast();

        console.log("=== MAINNET DEPLOY - verify on Basescan before funding ===");
        console.log("USDC (real)  :", usdc);
        console.log("SpendGuard   :", address(guard));
        console.log("Owner        :", owner);
        console.log("Agent        :", agent);
        console.log("Vendor payTo :", payTo);
        console.log("NOT funded with USDC yet - fund manually after verifying the address above.");
    }
}
