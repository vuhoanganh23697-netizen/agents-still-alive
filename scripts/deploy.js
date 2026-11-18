// StillAlive deployment script (Hardhat route).
//
// NOTE: the canonical production deploy for this project is done in Remix
// (see DEPLOY_GUIDE.md). This script is the equivalent automated route and is
// also what you would use for a scripted testnet rehearsal.
//
// Usage:
//   PRIVATE_KEY=0x... npx hardhat run scripts/deploy.js --network bsc
//   PRIVATE_KEY=0x... npx hardhat run scripts/deploy.js --network bscTestnet
//
// Env overrides:
//   AGENT_ID_ADDRESS — Agent ID contract to gate on
//                      (default: the real Binance Agent ID on BSC mainnet).
//                      For a testnet rehearsal, deploy MockAgentID first and
//                      pass its address here.

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const DEFAULT_AGENT_ID = "0x60b9262456de011f7d15a54cdd8c48baaa8b022f";

async function main() {
  const agentID = process.env.AGENT_ID_ADDRESS || DEFAULT_AGENT_ID;
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();

  console.log("Network:      ", network.name, "(chainId " + network.chainId + ")");
  console.log("Deployer:     ", deployer.address);
  console.log("Agent ID gate:", agentID);

  const StillAlive = await ethers.getContractFactory("StillAlive");
  const contract = await StillAlive.deploy(agentID);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  const receipt = await contract.deploymentTransaction().wait();

  const out = {
    contract: "StillAlive",
    contractAddress: address,
    agentID: agentID,
    chainId: Number(network.chainId),
    blockNumber: receipt.blockNumber,
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
  };
  const file = path.join(__dirname, "..", "deployment.json");
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");

  console.log("StillAlive deployed to:", address);
  console.log("Deployment block:      ", receipt.blockNumber);
  console.log("Wrote:", file);
  console.log("");
  console.log("Next steps:");
  console.log("  1. Verify the contract on BscScan (see DEPLOY_GUIDE.md).");
  console.log("  2. Paste " + address + " into CONFIG.contractAddress in app.js.");
  console.log("  3. Optionally set CONFIG.startBlock = " + receipt.blockNumber + " in app.js.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
