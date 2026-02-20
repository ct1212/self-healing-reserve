# Self-Healing Reserve

Autonomous proof-of-reserve system combining **Chainlink CRE confidential compute** with **Coinbase agentic wallets**. A CRE workflow privately verifies reserves inside a TEE, publishes only a boolean attestation on-chain, and when reserves are undercollateralized, a recovery agent autonomously rebalances via the awal wallet CLI. Live reserve data is sourced from the **Chainlink wBTC Proof of Reserve** feed on Ethereum mainnet.

Built for **Chainlink Convergence Hackathon 2026**.

**[Live Demo Dashboard](http://76.13.177.213/cre/)** — running with real Chainlink wBTC PoR data on Ethereum mainnet.

## Architecture

### Core Flow

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
                                                  │   ┌─ check USDC balance │
                                                  │   ├─ swap USDC → wBTC   │
                                                  │   └─ send wBTC to PoR   │
                                                  └──────────┬──────────────┘
                                                             │ CLI
                                                             ▼
                                                  ┌─────────────────────────┐
                                                  │  npx awal@latest        │
                                                  │  (Coinbase wallet)      │
                                                  └─────────────────────────┘
```

**Key insight:** The exact reserve balances never leave the TEE. Only a boolean `isSolvent` attestation is published on-chain. This preserves confidentiality while enabling trustless verification and autonomous recovery.

### Dual Recovery Mechanisms

The agent intelligently selects the optimal recovery method based on deficit size:

| Mechanism | Best For | Privacy | Speed | Complexity |
|-----------|----------|---------|-------|------------|
| **Direct Wallet** | Small deficits (<$50M) | Public txs | Fast (seconds) | Simple |
| **Dark Pool** | Large deficits (>$50M) | Confidential | Moderate (minutes) | TEE-based |

### Dark Pool Recovery (Proof of Concept)

For large collateral deficits where market impact and confidentiality are critical. This module demonstrates the architecture for TEE-based confidential matching. The contract and agent run in simulation mode, with full implementation pending Chainlink Confidential Compute availability.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    CONFIDENTIAL DARK POOL RECOVERY                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Step 1: Encrypt Request                                                    │
│  ┌──────────┐    TEE Public Key    ┌─────────────────┐                     │
│  │ Deficit  │ ───────────────────▶ │ Encrypted       │                     │
│  │ (hidden) │                      │ Request         │                     │
│  └──────────┘                      └─────────────────┘                     │
│                                                                             │
│  Step 2: Submit to Dark Pool                                                │
│  ┌─────────────────┐    requestCollateral()    ┌──────────────────────┐    │
│  │ Encrypted       │ ────────────────────────▶ │ CREDarkPool.sol      │    │
│  │ Request         │                           │ (on-chain)           │    │
│  └─────────────────┘                           └──────────────────────┘    │
│                                                                             │
│  Step 3: TEE Matching (Private)                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  TEE Enclave (Chainlink Confidential Compute)                       │   │
│  │                                                                     │   │
│  │  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐          │   │
│  │  │ Market Maker │    │ Market Maker │    │ Market Maker │          │   │
│  │  │ A: $20K      │    │ B: $15K      │    │ C: $20K      │          │   │
│  │  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘          │   │
│  │         │                   │                   │                   │   │
│  │         └───────────────────┴───────────────────┘                   │   │
│  │                         │                                          │   │
│  │                         ▼                                          │   │
│  │              ┌─────────────────────┐                               │   │
│  │              │ Match: A+B+C = $55K │                               │   │
│  │              │ Fill deficit        │                               │   │
│  │              └──────────┬──────────┘                               │   │
│  │                         │                                          │   │
│  │              ┌──────────▼──────────┐                               │   │
│  │              │ ZK-Proof Generated  │                               │   │
│  │              │ TEE Attestation     │                               │   │
│  │              └─────────────────────┘                               │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  Step 4: Settlement                                                         │
│  ┌─────────────────┐    confidentialFill()    ┌──────────────────────┐     │
│  │ TEE Attestation │ ───────────────────────▶ │ Collateral sent to   │     │
│  │ + ZK Proof      │                          │ reserve (proven      │     │
│  └─────────────────┘                          │ but amounts hidden)  │     │
│                                               └──────────────────────┘     │
│                                                                             │
│  ✅ PUBLIC: "Recovery executed" | ❌ PRIVATE: How much, from whom          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Dark Pool Benefits:**
- **Confidential**: Deficit amount never revealed
- **No Market Impact**: Large fills don't move public markets
- **MEV Protected**: Orders matched privately in TEE
- **Discreet**: No signaling of reserve distress to competitors

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
4. Start the live dashboard at `http://localhost:3002`
5. Start the recovery agent (dry-run mode)
6. Simulate a **healthy** reserve check → attestation `true` → agent idle
7. Toggle to **undercollateralized** → attestation `false` → agent executes recovery
8. Toggle back to **healthy** → attestation `true` → agent confirms

## Project Structure

```
contracts/
  src/ReserveAttestation.sol        Solidity contract (bool attestation + events)
  darkpool/CREDarkPool.sol          Dark pool contract (proof of concept)
  abi/ReserveAttestation.ts         TypeScript ABI (as const)
  abi/ChainlinkAggregator.ts        Chainlink EACAggregatorProxy ABI

workflow/
  main.ts                           CRE workflow (ConfidentialHTTP pattern)
  config.json                       Schedule, URL, threshold
  secrets.yaml                      Secret mappings for DON vault

mock-api/
  server.ts                         Express server on :3001

dashboard/
  server.ts                         Express backend on :3002 (Chainlink PoR + chain data)
  alerts.ts                         Alert system (email, Slack, Discord)
  public/index.html                 Single-page live dashboard (no build step)

agent/
  index.ts                          Entry point + graceful shutdown
  monitor.ts                        viem event watcher (ReserveStatusUpdated)
  recovery.ts                       Recovery orchestration (selects mechanism)
  wallet.ts                         awal CLI wrapper (dry-run capable)
  darkpool.ts                       Dark pool recovery (simulation mode)
  metrics.ts                        Recovery metrics tracking
  config.ts                         Env-based config loader

demo/
  run.ts                            End-to-end orchestrator
  deploy-contract.ts                Compile (solc) + deploy via viem
  simulate-workflow.ts              Local CRE workflow simulation

deployment/
  nginx-cre.conf                    Nginx reverse proxy config
  self-healing-reserve.service      systemd service file
  deploy.sh                         VPS deployment script
```

## Dashboard

A live web dashboard provides real-time visibility into the system. **[View the live demo](http://76.13.177.213/cre/)**.

- **Chainlink PoR data**: live wBTC Proof of Reserve from Ethereum mainnet (feed address, round ID, last updated)
- **Attestation status**: large green/red indicator showing current solvency
- **Reserve data**: total reserves, liabilities, and collateralization ratio sourced from Chainlink
- **Simulate recovery**: three scenarios using real Chainlink data:
  - *Small deficit*: agent computes the wBTC shortfall, swaps USDC via direct Uniswap swap, restores to 100% — remaining 5% buffer replenished via scheduled OTC (3 steps)
  - *Large deficit*: agent routes wBTC through a confidential dark pool with TEE matching and ZK settlement (4 steps)
  - *Failed recovery*: dark pool TEE matching times out — system stays undercollateralized until manual reset
- **Recovery history**: step-by-step breakdown with mechanism badges (Direct Wallet Swap / Confidential Dark Pool)
- **Event timeline**: scrollable history of on-chain `ReserveStatusUpdated` events

The dashboard auto-starts with `npm run demo`, or run standalone:

```bash
CONTRACT_ADDRESS=0x... npm run dashboard
```

## Security

See [SECURITY.md](./SECURITY.md) for a detailed breakdown of the security architecture, including what runs inside the TEE in production vs what is simulated in the demo.

## Running Individual Modules

```bash
# Mock API (port 3001)
npm run mock-api

# Live dashboard (port 3002)
CONTRACT_ADDRESS=0x... npm run dashboard

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

## Smart Contracts

### ReserveAttestation.sol
Main attestation contract:
- **`updateAttestation(bool)`**: Called by the CRE workflow simulator to write the attestation
- **`onReport(bytes, bytes)`**: CRE-compatible callback for production DON integration
- **`ReserveStatusUpdated(bool isSolvent, uint256 timestamp)`**: Event the agent monitors

### CREDarkPool.sol (Proof of Concept)
Confidential dark pool design for large collateral fills. Runs in simulation mode. ZK proof verification and TEE attestation validation are stubbed, pending Chainlink Confidential Compute availability.
- **`requestCollateral(bytes32 encryptedAmount, uint256 premiumBps, uint256 timeout)`**: Submit confidential request
- **`confidentialFill(bytes32 requestId, bytes calldata zkProof, bytes32 teeAttestation)`**: TEE-verified fill
- **Private matching**: Orders matched inside TEE, only boolean status revealed

See `contracts/darkpool/` for implementation and `research/dark-pool-integration.md` for full architecture.

## CRE Workflow

`workflow/main.ts` follows the `typescriptConfHTTP` template pattern from the CRE SDK:

- Uses `ConfidentialHTTPClient` to fetch reserve data
- Applies `consensusIdenticalAggregation` across DON nodes
- Compares reserves vs liabilities **inside the TEE**
- Returns only `{isSolvent: boolean}`. Balances never leave the enclave.

For the demo, `demo/simulate-workflow.ts` replicates this logic locally.

## Recovery Agent

When `ReserveStatusUpdated(false, ...)` is detected, the agent intelligently selects the recovery mechanism based on deficit size:

### Small Deficits (<$50M): Direct Wallet Swap
Fast, simple recovery via Coinbase agentic wallet. The agent swaps USDC into wBTC and sends it directly to the reserve:
1. **Check USDC balance**: verify wallet has funds available
2. **Swap USDC → wBTC**: Uniswap DEX swap at current market rate
3. **Send wBTC to PoR reserve**: transfer wBTC back into the reserve fund

### Large Deficits (>$50M): Confidential Dark Pool
For deficits too large for a direct swap without market impact, the agent routes through a confidential dark pool:
1. **Encrypt order**: deficit amount encrypted with TEE public key (AES-256-GCM)
2. **Submit to dark pool**: `CREDarkPool.requestCollateral()` with encrypted order
3. **TEE matching**: market makers fill privately inside Chainlink Confidential Compute, no order details revealed
4. **ZK settlement**: matched trade settled on-chain with ZK proof; amounts remain private

In dry-run mode (default), commands are logged but not executed.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `RPC_URL` | `http://127.0.0.1:8545` | Ethereum JSON-RPC endpoint |
| `MOCK_API_URL` | `http://127.0.0.1:3001` | Mock reserve API |
| `CONTRACT_ADDRESS` | *(none)* | Deployed ReserveAttestation contract address |
| `RESERVE_ADDRESS` | `0x000...000` | Where recovery wBTC is sent |
| `CHAINLINK_FEED_ADDRESS` | `0xa81F...4e` | Chainlink wBTC PoR feed (Ethereum mainnet) |
| `DASHBOARD_PORT` | `3002` | Dashboard server port |
| `AWAL_DRY_RUN` | `true` | Set `false` to execute real wallet transactions |

## Stack

- **Solidity 0.8.19** + solc: smart contracts
- **TypeScript** + tsx: all runtime code
- **viem**: Ethereum client (deploy, write, watch events, read Chainlink feeds)
- **Chainlink Proof of Reserve**: live wBTC PoR feed on Ethereum mainnet
- **@chainlink/cre-sdk**: CRE workflow (confidential compute runtime)
- **Express**: dashboard backend + mock reserve API
- **Hardhat**: local EVM node for demo
- **awal**: Coinbase agentic wallet CLI
