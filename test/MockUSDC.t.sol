// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../contracts/MockUSDC.sol";

contract MockUSDCTest is Test {
    MockUSDC usdc;
    address alice;
    address bob;

    function setUp() public {
        alice = makeAddr("alice");
        bob = makeAddr("bob");
        usdc = new MockUSDC();
    }

    function test_Metadata() public view {
        assertEq(usdc.name(), "Mock USD Coin");
        assertEq(usdc.symbol(), "mUSDC");
        assertEq(usdc.decimals(), 6);
    }

    function test_Mint_IncreasesBalanceAndSupply() public {
        usdc.mint(alice, 100e6);
        assertEq(usdc.balanceOf(alice), 100e6);
        assertEq(usdc.totalSupply(), 100e6);
    }

    function test_Transfer_MovesBalance() public {
        usdc.mint(address(this), 100e6);
        assertTrue(usdc.transfer(alice, 40e6));
        assertEq(usdc.balanceOf(address(this)), 60e6);
        assertEq(usdc.balanceOf(alice), 40e6);
    }

    function test_Transfer_RevertsOnInsufficientBalance() public {
        vm.expectRevert("insufficient balance");
        usdc.transfer(alice, 1e6);
    }

    function test_Approve_SetsAllowance() public {
        usdc.approve(alice, 50e6);
        assertEq(usdc.allowance(address(this), alice), 50e6);
    }

    function test_TransferFrom_MovesBalanceAndDecreasesAllowance() public {
        usdc.mint(address(this), 100e6);
        usdc.approve(alice, 50e6);

        vm.prank(alice);
        assertTrue(usdc.transferFrom(address(this), bob, 30e6));

        assertEq(usdc.balanceOf(address(this)), 70e6);
        assertEq(usdc.balanceOf(bob), 30e6);
        assertEq(usdc.allowance(address(this), alice), 20e6);
    }

    function test_TransferFrom_RevertsOnInsufficientAllowance() public {
        usdc.mint(address(this), 100e6);
        usdc.approve(alice, 10e6);

        vm.prank(alice);
        vm.expectRevert("insufficient allowance");
        usdc.transferFrom(address(this), bob, 20e6);
    }

    function test_TransferFrom_RevertsOnInsufficientBalance() public {
        usdc.approve(alice, 100e6);

        vm.prank(alice);
        vm.expectRevert("insufficient balance");
        usdc.transferFrom(address(this), bob, 10e6);
    }
}
