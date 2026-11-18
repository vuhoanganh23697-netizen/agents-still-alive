require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");

/**
 * StillAlive — Hardhat config.
 *
 * IMPORTANT (BscScan verify parity): the production deployment is done in
 * Remix with compiler 0.8.20 and the optimizer OFF. This config mirrors those
 * exact settings so bytecode compiled here matches a Remix build.
 *
 * @type import('hardhat/config').HardhatUserConfig
 */
module.exports = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: { enabled: false },
    },
  },
  networks: {
    bsc: {
      url: "https://bsc-dataseed.binance.org",
      chainId: 56,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
    bscTestnet: {
      url: "https://data-seed-prebsc-1-s1.binance.org:8545",
      chainId: 97,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
  },
};
