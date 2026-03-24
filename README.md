# Axync Relayer

Node.js service that submits block proofs from the Axync sequencer to on-chain contracts.

## What It Does

The relayer polls the sequencer API for new blocks and submits their state roots and withdrawals roots to AxyncVerifier contracts on each chain. This bridges the off-chain sequencer state to on-chain contracts, enabling users to claim assets and withdraw funds.

```
Sequencer API ──> Relayer ──> AxyncVerifier.submitBlockProof()
                                    │
                              AxyncVault.updateWithdrawalsRoot()
                              AxyncEscrow.updateWithdrawalsRoot()
```

## Quick Start

```bash
npm install
cp .env.example .env
# Edit .env with API URL, private key, RPC URLs, contract addresses

node relayer.js
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `API_URL` | Sequencer API URL |
| `PRIVATE_KEY` | Relayer wallet private key |
| `RELAYER_POLL_INTERVAL` | Polling interval in ms (default: 15000) |
| `SEPOLIA_RPC` | Ethereum Sepolia RPC |
| `BASE_SEPOLIA_RPC` | Base Sepolia RPC |
| `SEPOLIA_VERIFIER` | AxyncVerifier address on Sepolia |
| `SEPOLIA_VAULT` | AxyncVault address on Sepolia |
| `SEPOLIA_ESCROW` | AxyncEscrow address on Sepolia |
| `BASE_VERIFIER` | AxyncVerifier address on Base |
| `BASE_VAULT` | AxyncVault address on Base |
| `BASE_ESCROW` | AxyncEscrow address on Base |

Contract addresses can also be provided via `deployment.json` and `deployment-escrow.json` files (env vars take precedence in Docker).

## Docker

```bash
docker build -t axync/relayer:latest .
docker run --env-file .env axync/relayer:latest
```

## License

MIT
