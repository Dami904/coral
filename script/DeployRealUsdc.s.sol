// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../contracts/SpendGuard.sol";

// Base SEPOLIA deploy: SpendGuard wired to Circle's real testnet USDC
// (0x036CbD53842c5426634e7929541eC2318f3dCF7e — confirmed via Circle's own
// docs, not the project's own MockUSDC) instead of Deploy.s.sol's mock
// token. Same demo policy thresholds as Deploy.s.sol; the only difference
// is which ERC20 the guard custodies. Funds the guard from the deployer's
// own real-USDC balance in the same broadcast (safe here, unlike
// DeployMainnet.s.sol's deliberately-separate funding step, because this
// is still testnet money).
//
// Run: forge script script/DeployRealUsdc.s.sol:DeployRealUsdc --rpc-url base_sepolia --broadcast
contract DeployRealUsdc is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address agent = vm.envAddress("AGENT_ADDRESS");
        address payTo = vm.envAddress("VENDOR_PAYTO_ADDRESS");
        // Defaults to Circle's published Base Sepolia USDC so this doesn't
        // need a new required .env entry unless overriding it.
        address usdcAddr = vm.envOr("USDC_ADDRESS", address(0x036CbD53842c5426634e7929541eC2318f3dCF7e));
        address owner = vm.addr(deployerKey);
        IERC20 usdc = IERC20(usdcAddr);

        address[] memory allowlist = new address[](1);
        allowlist[0] = payTo;

        // Same demo-tuned thresholds as Deploy.s.sol — only the USDC token
        // changes here, not the policy shape.
        uint256 maxPerPayment = 500_000;          // $0.50 (6dp)
        uint256 humanApprovalThreshold = 150_000; // $0.15 (6dp) — demo value, deliberately low
        uint256 budgetAmount = 2_000_000;         // $2.00 rolling
        uint256 budgetSeconds = 3600;             // 1hr window
        uint256 rateMax = 10;                     // 10 payments
        uint256 rateSeconds = 3600;               // 1hr window

        uint256 rateLogCapacity = 20;
        uint256 budgetLogCapacity = 50;

        // Real testnet USDC is faucet-limited, not mintable — fund the
        // guard with most of the deployer's balance, keeping a small
        // buffer with the owner for any later manual top-up.
        uint256 guardFunding = 15_000_000; // $15.00 (6dp)

        vm.startBroadcast(deployerKey);

        SpendGuard guard = new SpendGuard(
            usdcAddr, agent, 3600, // timelockDelaySeconds: 1hr, for setPolicy/withdraw only
            rateLogCapacity, budgetLogCapacity,
            allowlist, maxPerPayment, humanApprovalThreshold,
            budgetAmount, budgetSeconds, rateMax, rateSeconds
        );

        require(usdc.transfer(address(guard), guardFunding), "guard funding transfer failed");

        vm.stopBroadcast();

        console.log("USDC (real, Circle) :", usdcAddr);
        console.log("SpendGuard           :", address(guard));
        console.log("Owner                :", owner);
        console.log("Agent                :", agent);
        console.log("Vendor payTo         :", payTo);
        console.log("Guard funded with    : 15.00 USDC (6dp: 15000000)");
    }
}
