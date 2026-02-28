# CRE Powered Self-Healing Reserve

**When a wrapped-asset reserve drops below 100% collateralization, the world finds out. Panic selling, depegs, and bank runs follow — not because the reserve can't be fixed, but because the fix is visible.**

CRE Powered Self-Healing Reserve solves this with **Chainlink CRE** (Chainlink Runtime Environment). A CRE workflow verifies reserves inside a TEE, publishes only a boolean attestation on-chain, and when reserves are undercollateralized, a recovery agent autonomously rebalances — without ever revealing the deficit size, counterparties, or recovery strategy to the public.

**[Live Demo](https://self-healing-reserve.vercel.app)** | Built for **Chainlink Convergence Hackathon 2026**

---

## The Problem

Proof-of-reserve systems today are transparent by design. That's good for trust — but dangerous during a crisis:

1. **A reserve dips to 98%** — Chainlink PoR reports this publicly
2. **Arbitrageurs front-run** the rebalancing trade, driving up costs
3. **The market interprets the deficit as distress** — panic begins before any recovery can execute
4. **Large rebalancing orders on DEXs signal the exact deficit size** — MEV bots extract value

The reserve manager is stuck: they need to fix the problem, but the act of fixing it makes it worse.

## The Solution: Confidential Verification + Autonomous Recovery

Self-Healing Reserve keeps reserve balances confidential while still providing trustless on-chain proof of solvency.

```
Reserve API ──▶ CRE Workflow (inside TEE) ──▶ On-chain: isSolvent = true/false
                    │                                         │
                    │ Balances NEVER leave                    │ Agent watches
                    │ the enclave                             │ this event
                    │                                         ▼
                    │                              Recovery Agent
                    │                              (autonomous wallet)
                    │                                         │
                    ▼                                         ▼
              Only a boolean                     Selects recovery mechanism
              reaches the blockchain             based on deficit size
```

**The key insight:** Exact reserve balances never leave the TEE. The public only sees `isSolvent: true` or `isSolvent: false`. No ratio, no dollar amount, no deficit size.

## Why CRE Changes Everything

Without CRE, proof-of-reserve is a tradeoff between transparency and stability. With CRE:

- **Verification is trustless** — the TEE ensures the comparison is honest, even though the inputs are hidden
- **Recovery is private** — no one knows how much is being rebalanced, or through which venue
- **Market impact is zero** — competitors, traders, and MEV bots can't front-run what they can't see
- **Confidence is maintained** — the public sees "solvent" or "insolvent" without the noise of partial ratios

## Dual Recovery: Direct Swap vs Confidential Dark Pool

The agent intelligently selects the optimal recovery method based on deficit size:

| Mechanism | When | How | Visibility |
|-----------|------|-----|------------|
| **Direct Wallet Swap** | Small deficits (<$50M) | Agent swaps USDC → wBTC on Uniswap | Public on-chain txs |
| **Confidential Dark Pool** | Large deficits (>$50M) | TEE-matched OTC fills via CREDarkPool.sol | Only boolean result public |

### Why two mechanisms?

A $500K deficit can be swapped on Uniswap without moving the market — just do it fast. But a $50M+ deficit on a DEX would crater the price, signal distress, and attract MEV. For large deficits, the dark pool matches with institutional market makers inside a TEE. No one sees the order size, the counterparties, or the fill price. Only the settlement proof hits the chain.

### Dark Pool Architecture (CRE-based)

```
Agent encrypts deficit amount with TEE public key
    │
    ▼
CREDarkPool.sol receives encrypted request
    │
    ▼
TEE Enclave (Chainlink Confidential Compute)
    ├── Decrypts order
    ├── Matches with market makers privately
    ├── No order details revealed to any party
    └── Generates ZK proof of valid fill
    │
    ▼
Settlement on-chain with ZK proof
    PUBLIC:  "Recovery executed successfully"
    PRIVATE: How much, from whom, at what price
```

### Dark Pool Liquidity: How Capital Is Ready When Needed

The dark pool only works if there's liquidity sitting on the other side of the trade when a crisis hits. This doesn't happen by accident — institutional market makers pre-commit capital into the CREDarkPool contract ahead of time:

1. **Market makers deposit wBTC (or USDC) into the dark pool** — these are institutional desks (OTC firms, large funds, custodians) who earn a premium for providing standby liquidity. Think of it like an insurance float: capital sits idle most of the time, but earns yield for being available.

2. **Commitments are encrypted and private** — thanks to the TEE, no market maker knows the total pool depth, and no one outside the TEE knows who has committed or how much. This prevents front-running of the pool itself.

3. **When a deficit occurs, the TEE matching engine pairs the recovery order against committed liquidity** — it fills the order across multiple market makers, splitting the size so no single counterparty sees the full deficit. Each fill is at a fair price (TWAP ± basis points), verified inside the enclave.

4. **Market makers are incentivized** — they earn a spread on every fill (negotiated at commitment time), plus they get priority access to large OTC flow they'd never see on public DEXs. For institutional desks, this is attractive deal flow, not charity.

5. **If liquidity is insufficient, the dark pool fails gracefully** — the TEE matching engine times out, and the system reports the failure without revealing the order size or the pool's capacity. The reserve stays undercollateralized until manual intervention or a retry with different parameters. This is demonstrated in the "Dark Pool Failure" simulation.

The key tradeoff: the dark pool requires pre-positioned capital, which means ongoing relationships with institutional liquidity providers. In exchange, when a crisis hits, recovery executes in seconds with zero market visibility — no front-running, no panic, no MEV extraction.

## Live Dashboard

The **[live demo dashboard](https://self-healing-reserve.vercel.app)** uses real **Chainlink wBTC Proof of Reserve** data from Ethereum mainnet.

Three simulation scenarios demonstrate the system end-to-end:

- **Small Deficit → Direct Swap**: Reserve drops to 99.9%. Agent swaps USDC → wBTC via Uniswap, restores to 100%. Remaining 5% buffer replenished via scheduled OTC.
- **Large Deficit → Dark Pool**: Reserve drops to 95%. Agent routes through confidential dark pool — TEE encrypts, matches, and settles with ZK proof. Restored to 105%.
- **Dark Pool Failure**: TEE matching times out. System stays undercollateralized until manual intervention — demonstrates graceful failure handling.

Each scenario shows a live step-by-step execution panel with timing, status, and a comparison of what's public vs what stays private.

## Quick Start

```bash
npm run setup    # Install dependencies
npm run demo     # Full end-to-end demo
```

The demo starts a local Hardhat node, deploys contracts, and runs the dashboard with live Chainlink data at `http://localhost:3002`.

## Smart Contracts

**ReserveAttestation.sol** — On-chain boolean attestation. The CRE workflow calls `onReport()` to write `isSolvent`. The agent monitors `ReserveStatusUpdated(bool, uint256)` events.

**CREDarkPool.sol** — Proof-of-concept confidential dark pool. `requestCollateral()` accepts encrypted orders; `confidentialFill()` settles with ZK proof and TEE attestation. Runs in simulation mode pending full CRE availability.

## CRE Workflow

`workflow/main.ts` follows the CRE SDK `typescriptConfHTTP` pattern:

1. `ConfidentialHTTPClient` fetches reserve data (encrypted end-to-end)
2. Compares reserves vs liabilities **inside the TEE**
3. `consensusIdenticalAggregation` across DON nodes
4. Returns only `{isSolvent: boolean}` — balances never leave the enclave

## Recovery Agent

Monitors `ReserveStatusUpdated` events and selects recovery mechanism:

- **Small deficits**: Check wallet balance → Swap USDC → wBTC on Uniswap → Send to reserve
- **Large deficits**: Encrypt order → Submit to dark pool → TEE matching → ZK settlement

Uses an MPC wallet (no raw private keys exposed to the agent). Dry-run mode by default.

## Security

See [SECURITY.md](./SECURITY.md) for the full security architecture, including what runs inside the TEE in production vs what is simulated in the demo.

## Stack

- **Chainlink CRE** — Chainlink Runtime Environment (TEE-based verification)
- **Chainlink Proof of Reserve** — live wBTC PoR feed on Ethereum mainnet
- **MPC wallet** — autonomous agent wallet (no raw private keys)
- **Solidity 0.8.19** — ReserveAttestation + CREDarkPool contracts
- **TypeScript + viem** — all runtime code, Ethereum client
- **Express** — dashboard backend + mock API
- **Hardhat** — local EVM for demo
