# Self-Healing Reserve

Autonomous proof-of-reserve system combining **Chainlink CRE confidential compute** with **Coinbase agentic wallets**. A CRE workflow privately verifies reserves inside a TEE, publishes only a boolean attestation on-chain, and when reserves are undercollateralized, a recovery agent autonomously rebalances via the awal wallet CLI.

Built for **Chainlink Convergence Hackathon 2026**.

## Architecture

```
┌─────────────┐       ┌──────────────────┐       ┌─────────────────────────┐
│  Reserve API │──HTTP──▶  CRE Workflow   │──tx──▶│ ReserveAttestation.sol  │
│  (mock-api)  │       │  (TEE / sim)     │       │  isSolvent: bool        │
└─────────────┘       └──────────────────┘       │  ReserveStatusUpdated() │
                       Fetches reserves,          └───────────┬─────────────┘
                       compares privately,                    │ event
                       emits only bool                        ▼
                                                  ┌─────────────────────────┐
                                                  │   Recovery Agent        │
                                                  │   watches events        │
                                                  │   ┌─ check balance      │
                                                  │   ├─ trade ETH → USDC   │
                                                  │   └─ send to reserve    │
                                                  └──────────┬──────────────┘
                                                             │ CLI
                                                             ▼
                                                  ┌─────────────────────────┐
                                                  │  npx awal@latest        │
                                                  │  (Coinbase wallet)      │
                                                  └─────────────────────────┘
```

**Key insight:** The exact reserve balances never leave the TEE — only a boolean `isSolvent` attestation is published on-chain. This preserves confidentiality while enabling trustless verification and autonomous recovery.

## Quick Start

```bash
# Install all dependencies
npm run setup

# Run the full end-to-end demo
npm run demo
```

The demo will:
1. Start a local Hardhat node
2. Compile and deploy the `ReserveAttestation` contract
3. Start the mock reserve API
4. Start the recovery agent (dry-run mode)
5. Simulate a **healthy** reserve check → attestation `true` → agent idle
6. Toggle to **undercollateralized** → attestation `false` → agent executes recovery
7. Toggle back to **healthy** → attestation `true` → agent confirms

## Project Structure

```
contracts/
  src/ReserveAttestation.sol        Solidity contract (bool attestation + events)
  abi/ReserveAttestation.ts         TypeScript ABI (as const)

workflow/
  main.ts                           CRE workflow (ConfidentialHTTP pattern)
  config.json                       Schedule, URL, threshold
  secrets.yaml                      Secret mappings for DON vault

mock-api/
  server.ts                         Express server on :3001

agent/
  index.ts                          Entry point + graceful shutdown
  monitor.ts                        viem event watcher (ReserveStatusUpdated)
  recovery.ts                       Recovery orchestration
  wallet.ts                         awal CLI wrapper (dry-run capable)
  config.ts                         Env-based config loader

demo/
  run.ts                            End-to-end orchestrator
  deploy-contract.ts                Compile (solc) + deploy via viem
  simulate-workflow.ts              Local CRE workflow simulation
```

## Running Individual Modules

```bash
# Mock API (port 3001)
npm run mock-api

# Recovery agent (requires CONTRACT_ADDRESS env var)
CONTRACT_ADDRESS=0x... npm run agent

# Deploy contract to a running Hardhat node
npx hardhat node &
npx tsx demo/deploy-contract.ts
```

## API Endpoints (Mock)

| Endpoint | Method | Description |
|---|---|---|
| `/reserves` | GET | Returns `{totalReserve, totalLiabilities, isSolvent}` |
| `/toggle` | POST | Flip between solvent and undercollateralized |
| `/set-reserves` | POST | Set exact values `{totalReserve, totalLiabilities}` |
| `/state` | GET | Raw state for debugging |

## Smart Contract

`ReserveAttestation.sol` exposes:

- **`updateAttestation(bool)`** — Called by the CRE workflow simulator to write the attestation
- **`onReport(bytes, bytes)`** — CRE-compatible callback for production DON integration
- **`ReserveStatusUpdated(bool isSolvent, uint256 timestamp)`** — Event the agent monitors

## CRE Workflow

`workflow/main.ts` follows the `typescriptConfHTTP` template pattern from the CRE SDK:

- Uses `ConfidentialHTTPClient` to fetch reserve data
- Applies `consensusIdenticalAggregation` across DON nodes
- Compares reserves vs liabilities **inside the TEE**
- Returns only `{isSolvent: boolean}` — balances never leave the enclave

For the demo, `demo/simulate-workflow.ts` replicates this logic locally.

## Recovery Agent

When `ReserveStatusUpdated(false, ...)` is detected:

1. **Check balance** — `npx awal@latest balance --json`
2. **Trade ETH → USDC** — `npx awal@latest trade 0.01 eth usdc --json`
3. **Send USDC to reserve** — `npx awal@latest send 10 <reserve-address> --json`

In dry-run mode (default), commands are logged but not executed.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `RPC_URL` | `http://127.0.0.1:8545` | Ethereum JSON-RPC endpoint |
| `MOCK_API_URL` | `http://127.0.0.1:3001` | Mock reserve API |
| `CONTRACT_ADDRESS` | — | Deployed contract address |
| `RESERVE_ADDRESS` | `0x000...000` | Where recovery USDC is sent |
| `AWAL_DRY_RUN` | `true` | Set `false` to execute real wallet transactions |

## Stack

- **Solidity 0.8.19** + solc — smart contract
- **TypeScript** + tsx — all runtime code
- **viem** — Ethereum client (deploy, write, watch events)
- **Express** — mock reserve API
- **Hardhat** — local EVM node
- **@chainlink/cre-sdk** — workflow (CRE runtime dependency)
- **awal** — Coinbase agentic wallet CLI
