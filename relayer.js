/**
 * Axync Relayer - Submits block proofs to on-chain AxyncVerifier contracts
 *
 * Polls the sequencer API for new blocks and submits their proofs
 * to AxyncVerifier contracts on both Sepolia and Base Sepolia.
 * Also updates withdrawalsRoot on AxyncVault and AxyncEscrow.
 */

const { ethers } = require("ethers");
const fs = require("fs");
require("dotenv").config();

const API_URL = process.env.API_URL || "http://localhost:8080";
const POLL_INTERVAL = parseInt(process.env.RELAYER_POLL_INTERVAL || "15000");
const PRIVATE_KEY = process.env.PRIVATE_KEY;

let deployment;
try {
  deployment = JSON.parse(fs.readFileSync("deployment.json", "utf8"));
} catch {
  console.error("❌ deployment.json not found");
  process.exit(1);
}

let escrowDeployment = null;
try {
  escrowDeployment = JSON.parse(fs.readFileSync("deployment-escrow.json", "utf8"));
} catch {}

const VERIFIER_ABI = [
  "function submitBlockProof(uint256 blockId, bytes32 prevStateRoot, bytes32 newStateRoot, bytes32 withdrawalsRoot, bytes calldata proof) external",
  "function stateRoot() view returns (bytes32)",
  "function processedBlocks(uint256) view returns (bool)",
  "function sequencer() view returns (address)",
];

const VAULT_ABI = [
  "function updateWithdrawalsRoot(bytes32) external",
  "function withdrawalsRoot() view returns (bytes32)",
];

const ESCROW_ABI = [
  "function updateWithdrawalsRoot(bytes32) external",
  "function withdrawalsRoot() view returns (bytes32)",
];

const ZERO_ROOT = "0x" + "0".repeat(64);

// --- Chain setup with static network (avoids eth_chainId auto-detection failures) ---
const chains = {};

function initChain(name, rpcUrl, chainId, verifierAddr, vaultAddr, escrowAddr) {
  const network = new ethers.Network(name, chainId);
  const provider = new ethers.JsonRpcProvider(rpcUrl, network, { staticNetwork: network });
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  chains[name] = {
    name,
    provider,
    wallet,
    verifier: new ethers.Contract(verifierAddr, VERIFIER_ABI, wallet),
    vault: new ethers.Contract(vaultAddr, VAULT_ABI, wallet),
    escrow: escrowAddr ? new ethers.Contract(escrowAddr, ESCROW_ABI, wallet) : null,
  };
}

// --- State ---
let lastSubmittedBlockId = 0;
const STATE_FILE = "relayer-state.json";

function loadState() {
  try {
    lastSubmittedBlockId = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")).lastSubmittedBlockId || 0;
    console.log(`📂 State: lastSubmittedBlockId = ${lastSubmittedBlockId}`);
  } catch {
    console.log("📂 No saved state, starting from block 0");
  }
}

function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ lastSubmittedBlockId }, null, 2));
}

// --- API ---
async function fetchCurrentBlockId() {
  const resp = await fetch(`${API_URL}/api/v1/current_block`);
  if (!resp.ok) throw new Error(`API ${resp.status}`);
  return (await resp.json()).current_block_id;
}

async function fetchBlock(blockId) {
  const resp = await fetch(`${API_URL}/api/v1/block/${blockId}`);
  if (!resp.ok) return null;
  return await resp.json();
}

// --- Gas ---
async function getGasOpts(provider, gasLimit = 500000) {
  const fee = await provider.getFeeData();
  const opts = { gasLimit };
  if (fee.maxFeePerGas) {
    opts.maxFeePerGas = fee.maxFeePerGas * 3n;
    opts.maxPriorityFeePerGas = (fee.maxPriorityFeePerGas || 1000000n) * 3n;
  }
  return opts;
}

// --- Submit to one chain ---
async function submitToChain(chain, blockId, prevStateRoot, newStateRoot, withdrawalsRoot, proof) {
  try {
    const isProcessed = await chain.verifier.processedBlocks(blockId);
    if (isProcessed) {
      console.log(`  [${chain.name}] Block ${blockId} already processed`);
      return true;
    }

    const onChainRoot = await chain.verifier.stateRoot();
    if (onChainRoot !== prevStateRoot) {
      console.log(`  [${chain.name}] ⚠️ stateRoot mismatch: on-chain=${onChainRoot.slice(0, 18)}... expected=${prevStateRoot.slice(0, 18)}...`);
      return false;
    }

    // Submit block proof
    console.log(`  [${chain.name}] Submitting block ${blockId}...`);
    const gas = await getGasOpts(chain.provider);
    const nonce = await chain.provider.getTransactionCount(chain.wallet.address);
    const tx = await chain.verifier.submitBlockProof(blockId, prevStateRoot, newStateRoot, withdrawalsRoot, proof, { ...gas, nonce });
    const receipt = await tx.wait();
    console.log(`  [${chain.name}] ✅ Block ${blockId} submitted (gas: ${receipt.gasUsed})`);

    // Update withdrawalsRoot on Vault and Escrow
    if (withdrawalsRoot !== ZERO_ROOT) {
      await updateWithdrawalsRoot(chain, withdrawalsRoot);
    }

    return true;
  } catch (err) {
    console.error(`  [${chain.name}] ❌ ${err.shortMessage || err.message}`);
    return false;
  }
}

async function updateWithdrawalsRoot(chain, root) {
  // Vault
  try {
    await new Promise(r => setTimeout(r, 2000));
    const gas = await getGasOpts(chain.provider, 100000);
    const nonce = await chain.provider.getTransactionCount(chain.wallet.address);
    const tx = await chain.vault.updateWithdrawalsRoot(root, { ...gas, nonce });
    await tx.wait();
    console.log(`  [${chain.name}] ✅ Vault withdrawalsRoot updated`);
  } catch (err) {
    console.error(`  [${chain.name}] ❌ Vault update failed: ${err.shortMessage || err.message}`);
  }

  // Escrow
  if (chain.escrow) {
    try {
      await new Promise(r => setTimeout(r, 2000));
      const gas = await getGasOpts(chain.provider, 100000);
      const nonce = await chain.provider.getTransactionCount(chain.wallet.address);
      const tx = await chain.escrow.updateWithdrawalsRoot(root, { ...gas, nonce });
      await tx.wait();
      console.log(`  [${chain.name}] ✅ Escrow withdrawalsRoot updated`);
    } catch (err) {
      console.error(`  [${chain.name}] ❌ Escrow update failed: ${err.shortMessage || err.message}`);
    }
  }
}

// --- Main loop ---
async function processNewBlocks() {
  try {
    const currentBlockId = await fetchCurrentBlockId();
    if (currentBlockId <= lastSubmittedBlockId + 1) return;

    console.log(`\n🔄 Blocks ${lastSubmittedBlockId + 1} → ${currentBlockId - 1}`);

    let prevStateRoot = ZERO_ROOT;
    if (lastSubmittedBlockId > 0) {
      const last = await fetchBlock(lastSubmittedBlockId);
      if (last) prevStateRoot = last.state_root;
    }

    for (let bid = lastSubmittedBlockId + 1; bid < currentBlockId; bid++) {
      const block = await fetchBlock(bid);
      if (!block) { console.log(`  Block ${bid} not found`); continue; }

      console.log(`\n📦 Block ${bid}: ${block.transaction_count} txs, wr=${block.withdrawals_root.slice(0, 18)}...`);

      let proof = block.block_proof;
      if (!proof || proof === "0x" || proof === "0x00") proof = "0x" + "ab".repeat(32);

      let ok = true;
      for (const chain of Object.values(chains)) {
        if (!(await submitToChain(chain, bid, prevStateRoot, block.state_root, block.withdrawals_root, proof))) ok = false;
      }

      if (ok) {
        lastSubmittedBlockId = bid;
        prevStateRoot = block.state_root;
        saveState();
      } else {
        console.log(`  ⚠️ Block ${bid} failed, will retry`);
        break;
      }
    }
  } catch (err) {
    console.error(`Poll error: ${err.message}`);
  }
}

// --- Start ---
async function main() {
  console.log("🚀 Axync Relayer\n");
  console.log(`API: ${API_URL}`);
  console.log(`Poll: ${POLL_INTERVAL / 1000}s`);

  initChain("Sepolia",
    process.env.SEPOLIA_RPC || "https://sepolia.drpc.org",
    11155111,
    deployment.sepolia.verifier, deployment.sepolia.vault,
    escrowDeployment?.sepolia?.escrow || null
  );

  initChain("Base Sepolia",
    process.env.BASE_SEPOLIA_RPC || "https://base-sepolia-rpc.publicnode.com",
    84532,
    deployment.baseSepolia.verifier, deployment.baseSepolia.vault,
    escrowDeployment?.baseSepolia?.escrow || null
  );

  // Print config
  for (const c of Object.values(chains)) {
    console.log(`\n${c.name}:`);
    console.log(`  Verifier: ${await c.verifier.getAddress()}`);
    console.log(`  Vault:    ${await c.vault.getAddress()}`);
    console.log(`  Escrow:   ${c.escrow ? await c.escrow.getAddress() : "none"}`);
    console.log(`  Wallet:   ${c.wallet.address}`);
  }

  loadState();
  console.log(`\n✅ Running\n`);

  while (true) {
    await processNewBlocks();
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
}

main().catch(err => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
