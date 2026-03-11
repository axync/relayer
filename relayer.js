/**
 * Axync Relayer - Submits block proofs to on-chain VerifierContracts
 *
 * Polls the sequencer API for new blocks and submits their proofs
 * to VerifierContracts on both Sepolia and Base Sepolia.
 * Also updates AxyncVault.withdrawalsRoot when blocks contain withdrawals.
 *
 * Usage: node relayer.js
 */

const { ethers } = require("ethers");
const fs = require("fs");
require("dotenv").config();

// --- Configuration ---
const API_URL = process.env.API_URL || "http://localhost:8080";
const POLL_INTERVAL = parseInt(process.env.RELAYER_POLL_INTERVAL || "5000"); // ms
const PRIVATE_KEY = process.env.PRIVATE_KEY;

// Load deployment addresses
let deployment;
try {
  deployment = JSON.parse(fs.readFileSync("deployment.json", "utf8"));
} catch (e) {
  console.error("❌ deployment.json not found. Copy it from contracts/deployment-mvp.json");
  process.exit(1);
}

// ABI fragments (only functions we need)
const VERIFIER_ABI = [
  "function submitBlockProof(uint256 blockId, bytes32 prevStateRoot, bytes32 newStateRoot, bytes32 withdrawalsRoot, bytes calldata proof) external",
  "function stateRoot() view returns (bytes32)",
  "function processedBlocks(uint256) view returns (bool)",
  "function sequencer() view returns (address)",
];

const VAULT_ABI = [
  "function updateWithdrawalsRoot(bytes32 newWithdrawalsRoot) external",
  "function withdrawalsRoot() view returns (bytes32)",
];

// --- Chain Connections ---
const chains = {};

function initChain(name, rpcUrl, verifierAddr, vaultAddr) {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const verifier = new ethers.Contract(verifierAddr, VERIFIER_ABI, wallet);
  const vault = new ethers.Contract(vaultAddr, VAULT_ABI, wallet);

  chains[name] = { provider, wallet, verifier, vault, name };
  return chains[name];
}

// --- State ---
let lastSubmittedBlockId = 0;
const STATE_FILE = "relayer-state.json";

function loadState() {
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    lastSubmittedBlockId = data.lastSubmittedBlockId || 0;
    console.log(`📂 Loaded state: lastSubmittedBlockId = ${lastSubmittedBlockId}`);
  } catch {
    console.log("📂 No saved state, starting from block 0");
  }
}

function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ lastSubmittedBlockId }, null, 2));
}

// --- API Helpers ---
async function fetchCurrentBlockId() {
  const resp = await fetch(`${API_URL}/api/v1/current_block`);
  if (!resp.ok) throw new Error(`API error: ${resp.status}`);
  const data = await resp.json();
  return data.current_block_id;
}

async function fetchBlock(blockId) {
  const resp = await fetch(`${API_URL}/api/v1/block/${blockId}`);
  if (!resp.ok) {
    if (resp.status === 404) return null;
    throw new Error(`API error fetching block ${blockId}: ${resp.status}`);
  }
  return await resp.json();
}

// --- Gas options with bumped fees for L2s ---
async function getGasOpts(provider, gasLimit = 500000) {
  const feeData = await provider.getFeeData();
  const opts = { gasLimit };
  if (feeData.maxFeePerGas) {
    opts.maxFeePerGas = feeData.maxFeePerGas * 3n;
    opts.maxPriorityFeePerGas = (feeData.maxPriorityFeePerGas || 1000000n) * 3n;
  }
  return opts;
}

// --- Submit block proof to a single chain ---
async function submitBlockProofToChain(chain, blockId, prevStateRoot, newStateRoot, withdrawalsRoot, proof) {
  try {
    // Check if already processed
    const isProcessed = await chain.verifier.processedBlocks(blockId);
    if (isProcessed) {
      console.log(`  [${chain.name}] Block ${blockId} already processed, skipping`);
      return true;
    }

    // Check stateRoot matches
    const currentStateRoot = await chain.verifier.stateRoot();
    if (currentStateRoot !== prevStateRoot) {
      console.log(`  [${chain.name}] ⚠️ State root mismatch!`);
      console.log(`    Contract: ${currentStateRoot}`);
      console.log(`    Expected: ${prevStateRoot}`);
      return false;
    }

    console.log(`  [${chain.name}] Submitting block ${blockId} proof...`);
    const gasOpts = await getGasOpts(chain.provider, 500000);
    const nonce = await chain.provider.getTransactionCount(chain.wallet.address);
    const tx = await chain.verifier.submitBlockProof(
      blockId,
      prevStateRoot,
      newStateRoot,
      withdrawalsRoot,
      proof,
      { ...gasOpts, nonce }
    );
    const receipt = await tx.wait();
    console.log(`  [${chain.name}] ✅ Block ${blockId} submitted (gas: ${receipt.gasUsed})`);

    // Update withdrawals root if non-zero
    const ZERO = "0x" + "0".repeat(64);
    if (withdrawalsRoot !== ZERO) {
      // Wait briefly and get fresh nonce to avoid "replacement fee too low"
      await new Promise(r => setTimeout(r, 2000));
      const wdGasOpts = await getGasOpts(chain.provider, 100000);
      const wdNonce = await chain.provider.getTransactionCount(chain.wallet.address);
      console.log(`  [${chain.name}] Updating withdrawalsRoot (nonce ${wdNonce})...`);
      const wdTx = await chain.vault.updateWithdrawalsRoot(withdrawalsRoot, { ...wdGasOpts, nonce: wdNonce });
      await wdTx.wait();
      console.log(`  [${chain.name}] ✅ WithdrawalsRoot updated`);
    }

    return true;
  } catch (err) {
    console.error(`  [${chain.name}] ❌ Error: ${err.message}`);
    return false;
  }
}

// --- Main Loop ---
async function processNewBlocks() {
  try {
    const currentBlockId = await fetchCurrentBlockId();

    if (currentBlockId <= lastSubmittedBlockId + 1) {
      return; // No new blocks
    }

    console.log(`\n🔄 New blocks detected: ${lastSubmittedBlockId + 1} → ${currentBlockId - 1}`);

    // Track prevStateRoot across blocks
    // For the very first block, prevStateRoot = bytes32(0)
    let prevStateRoot = "0x" + "0".repeat(64);

    // If we've already submitted blocks, get the last known state root
    if (lastSubmittedBlockId > 0) {
      const lastBlock = await fetchBlock(lastSubmittedBlockId);
      if (lastBlock) {
        prevStateRoot = lastBlock.state_root;
      }
    }

    for (let blockId = lastSubmittedBlockId + 1; blockId < currentBlockId; blockId++) {
      const block = await fetchBlock(blockId);
      if (!block) {
        console.log(`  Block ${blockId} not found in storage, skipping`);
        continue;
      }

      console.log(`\n📦 Block ${blockId}: ${block.transaction_count} txs`);
      console.log(`  state_root:       ${block.state_root}`);
      console.log(`  withdrawals_root: ${block.withdrawals_root}`);
      console.log(`  proof length:     ${block.block_proof ? (block.block_proof.length - 2) / 2 : 0} bytes`);

      // Prepare proof - ensure it's non-empty for placeholder verification
      let proof = block.block_proof;
      if (!proof || proof === "0x" || proof === "0x00") {
        proof = "0x" + "ab".repeat(32);
      }

      const newStateRoot = block.state_root;
      const withdrawalsRoot = block.withdrawals_root;

      // Submit to all chains
      let allSuccess = true;
      for (const chain of Object.values(chains)) {
        const success = await submitBlockProofToChain(
          chain,
          blockId,
          prevStateRoot,
          newStateRoot,
          withdrawalsRoot,
          proof
        );
        if (!success) allSuccess = false;
      }

      if (allSuccess) {
        lastSubmittedBlockId = blockId;
        prevStateRoot = newStateRoot;
        saveState();
      } else {
        console.log(`  ⚠️ Block ${blockId} failed on some chains, will retry`);
        break; // Stop and retry on next poll
      }
    }
  } catch (err) {
    console.error(`Error in processNewBlocks: ${err.message}`);
  }
}

// --- Init & Run ---
async function main() {
  console.log("🚀 Axync Relayer Starting...\n");
  console.log(`API URL: ${API_URL}`);
  console.log(`Poll interval: ${POLL_INTERVAL}ms`);

  // Init chains
  initChain(
    "Sepolia",
    process.env.SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com",
    deployment.sepolia.verifier,
    deployment.sepolia.vault
  );
  initChain(
    "Base Sepolia",
    process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org",
    deployment.baseSepolia.verifier,
    deployment.baseSepolia.vault
  );

  // Verify connections
  for (const chain of Object.values(chains)) {
    const sequencer = await chain.verifier.sequencer();
    const stateRoot = await chain.verifier.stateRoot();
    console.log(`\n${chain.name}:`);
    console.log(`  Sequencer: ${sequencer}`);
    console.log(`  StateRoot: ${stateRoot}`);
    console.log(`  Wallet:    ${chain.wallet.address}`);

    if (sequencer.toLowerCase() !== chain.wallet.address.toLowerCase()) {
      console.error(`  ⚠️ WARNING: Wallet is not the sequencer!`);
    }
  }

  loadState();

  console.log(`\n✅ Relayer running. Polling every ${POLL_INTERVAL / 1000}s...\n`);

  // Main loop
  while (true) {
    await processNewBlocks();
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
