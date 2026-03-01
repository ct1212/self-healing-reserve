# CRE Powered Self-Healing Reserve

**A confidential alternative to transparent Proof of Reserve.** Reserve balances flow from the custodian's private API directly into a Chainlink CRE Trusted Execution Environment — they never touch a public feed. The TEE verifies solvency and publishes only a boolean attestation on-chain. When undercollateralization is detected, an AI agent autonomously recovers — via direct Uniswap swaps for small deficits, or confidential dark pool execution with CCC private token transfers for large ones. No human intervention required.

**[Live Demo](https://self-healing-reserve.vercel.app)** | Built for **Chainlink Convergence Hackathon 2026**

---

## The Problem

Proof-of-reserve systems today are transparent by design. That's good for trust — but dangerous during a crisis:

1. **A reserve dips to 98%** — Chainlink PoR reports this publicly
2. **Arbitrageurs front-run** the rebalancing trade, driving up costs
3. **The market interprets the deficit as distress** — panic begins before any recovery can execute
4. **Large rebalancing orders on DEXs signal the exact deficit size** — MEV bots extract value

The reserve manager is stuck: they need to fix the problem, but the act of fixing it makes it worse.

## Why Not Just Use Transparent PoR?

Existing Chainlink Proof of Reserve feeds publish exact reserve ratios on a public chain. Under normal conditions, this transparency builds trust. But during a crisis, it becomes the attack surface.

When a reserve drops below 100%, the exact shortfall is immediately visible. Competitors see the deficit. Traders front-run the recovery. MEV bots extract value from every rebalancing swap. The market reads the ratio as a distress signal and panic selling begins — all before the reserve manager can fix the problem.

This project proposes a **replacement architecture** for Proof of Reserve, not a layer on top of the existing transparent model. In production, the custodian's reserve API feeds directly into the CRE TEE. No public feed is ever involved. The live demo uses real Chainlink wBTC PoR data as a realistic simulation anchor, but in a production deployment, that data path would be entirely private.

The tradeoff is explicit: less granularity for the public (boolean instead of ratio), but the same trustless verification (TEE attestation), with dramatically better crisis resilience.

## The Solution: Confidential Verification + Autonomous Recovery

Self-Healing Reserve keeps reserve balances confidential while still providing trustless on-chain proof of solvency.

```
Custodian API ──▶ CRE Workflow (inside TEE) ──▶ On-chain: isSolvent = true/false
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

**The key insight:** No sensitive data ever reaches the public chain. Reserve balances stay inside the CRE TEE during verification. Dark pool order amounts, counterparties, and fill prices stay inside the CCC enclave during recovery. Token transfers use CCC private token transfers during settlement. The only public artifacts are a boolean solvency attestation and an encrypted balance hash.

## Why CRE + CCC Changes Everything

Without CRE and CCC, proof-of-reserve is a tradeoff between transparency and stability. With them:

- **Verification is trustless** — the TEE ensures the comparison is honest, even though the inputs are hidden
- **Recovery is private** — no one knows how much is being rebalanced, or through which venue
- **Settlement is confidential** — CCC private token transfers mean the actual wBTC movements are encrypted on-chain, not just the computation
- **Market impact is zero** — competitors, traders, and MEV bots can't front-run what they can't see
- **Confidence is maintained** — the public sees "solvent" or "insolvent" without the noise of partial ratios

## Dual Recovery: Direct Swap vs CCC Confidential Dark Pool

The agent intelligently selects the optimal recovery method based on deficit size:

| Mechanism | When | How | Visibility |
| --- | --- | --- | --- |
| **Direct Wallet Swap** | Small deficits (<$50M) | Agent swaps USDC → wBTC on Uniswap | Public on-chain txs |
| **CCC Confidential Dark Pool** | Large deficits (>$50M) | CCC threshold-encrypted matching + private token settlement | Only boolean result + encrypted hash public |

### Why two mechanisms?

A $500K deficit can be swapped on Uniswap without moving the market — just do it fast. But a $50M+ deficit on a DEX would crater the price, signal distress, and attract MEV. For large deficits, the dark pool matches with institutional market makers inside a CCC compute enclave. No one sees the order size, the counterparties, or the fill price. Token transfers happen via CCC private token transfers — balances are stored encrypted and updated inside the enclave. Only an encrypted balance hash and a boolean success flag reach the chain.

### Dark Pool Architecture (CCC-based)

```
Agent encrypts deficit amount with CCC master public key (threshold encryption)
    │
    ▼
CREDarkPool.sol receives encrypted request
    │
    ▼
Vault DON re-encrypts inputs for assigned compute enclave
    │
    ▼
CCC Compute Enclave
    ├── Decrypts order amount + market maker balances
    ├── Matches with market makers privately
    ├── Applies transfers to encrypted balance table
    ├── Re-encrypts updated state
    └── Produces attestation over result
    │
    ▼
On-chain: encrypted balance hash + boolean success + CCC attestation
    PUBLIC:  "Recovery executed successfully" + encrypted state hash
    PRIVATE: How much, from whom, at what price, which balances changed
```

Key difference from the previous architecture: the encryption uses CCC **threshold encryption** via the Vault DON, not a single TEE public key. The master decryption key is secret-shared across decryption nodes — no single node can ever decrypt alone. This means even if a single enclave or node is compromised, the private data remains secure.

### Dark Pool Liquidity: How Capital Is Ready When Needed

The dark pool only works if there's liquidity sitting on the other side of the trade when a crisis hits. This doesn't happen by accident — institutional market makers pre-commit capital into the CREDarkPool contract ahead of time:

1. **Market makers deposit wBTC (or USDC) into the dark pool** — these are institutional desks (OTC firms, large funds, custodians) who earn a premium for providing standby liquidity. Think of it like an insurance float: capital sits idle most of the time, but earns yield for being available.

2. **Commitments are encrypted and private** — thanks to CCC threshold encryption, no market maker knows the total pool depth, and no one outside the CCC enclave knows who has committed or how much. This prevents front-running of the pool itself.

3. **When a deficit occurs, the CCC enclave pairs the recovery order against committed liquidity** — it fills the order across multiple market makers, splitting the size so no single counterparty sees the full deficit. Each fill is at a fair price (TWAP ± basis points), verified inside the enclave. Token transfers are applied to the encrypted balance table and re-encrypted before leaving the enclave.

4. **Market makers are incentivized** — they earn a spread on every fill (negotiated at commitment time), plus they get priority access to large OTC flow they'd never see on public DEXs. For institutional desks, this is attractive deal flow, not charity.

5. **If liquidity is insufficient, the dark pool fails gracefully** — the CCC enclave times out, and the system reports the failure without revealing the order size or the pool's capacity. The reserve stays undercollateralized until manual intervention or a retry with different parameters. This is demonstrated in the "Dark Pool Failure" simulation.

The key tradeoff: the dark pool requires pre-positioned capital, which means ongoing relationships with institutional liquidity providers. In exchange, when a crisis hits, recovery executes in seconds with zero market visibility — no front-running, no panic, no MEV extraction.

## Recovery Mechanism Comparison

| | Direct Wallet Swap | CCC Confidential Dark Pool |
| --- | --- | --- |
| **Use Case** | Deficits < $50M | Deficits > $50M |
| **Execution Venue** | Uniswap (Public DEX) | CCC Compute Enclave |
| **Transaction Visibility** | Fully Public | Boolean + Encrypted Hash |
| **Market Impact** | Moderate Slippage | Zero |
| **MEV Protection** | None | Full (CCC + Threshold Encryption) |
| **Amount Privacy** | Exposed On-Chain | CCC Threshold Encrypted |
| **Token Transfer Privacy** | None (Public ERC-20 Transfers) | Full (CCC Private Token Transfer) |
| **Speed** | ~300ms | ~2.2s |
| **Complexity** | Low (3 steps) | High (4 steps + CCC) — fully automated |

## Live Dashboard

The **[live demo dashboard](https://self-healing-reserve.vercel.app)** uses real **Chainlink wBTC Proof of Reserve** data from Ethereum mainnet as a simulation anchor. In production, this data would flow from the custodian's private API directly into the CRE TEE — never via a public feed.

Three simulation scenarios demonstrate the system end-to-end:

- **Small Deficit → Direct Swap**: Reserve drops to 99.9%. Agent swaps USDC → wBTC via Uniswap, restores to 100%. Remaining 5% buffer replenished via scheduled OTC.
- **Large Deficit → CCC Dark Pool**: Reserve drops to 95%. Agent routes through CCC confidential dark pool — threshold-encrypted order, CCC enclave matching, private token settlement. Restored to 105%.
- **Dark Pool Failure**: CCC enclave matching times out. System stays undercollateralized until manual intervention — demonstrates graceful failure handling.

Each scenario shows a live step-by-step execution panel with timing, status, and a comparison of what's public vs what stays private.

## Quick Start

```
npm run setup    # Install dependencies
npm run demo     # Full end-to-end demo
```

The demo starts a local Hardhat node, deploys contracts, and runs the dashboard with live Chainlink data at `http://localhost:3002`.

## Smart Contracts

**ReserveAttestation.sol** — On-chain boolean attestation. The CRE workflow calls `onReport()` to write `isSolvent`. The agent monitors `ReserveStatusUpdated(bool, uint256)` events.

**CREDarkPool.sol** — Confidential dark pool with CCC private token settlement. `requestCollateral()` accepts orders encrypted with the CCC master public key (threshold encryption). `confidentialFill()` settles with a CCC-attested encrypted balance table update — no plaintext amounts ever touch the chain. Runs in simulation mode pending full CCC General Access availability.

## CRE Workflow

`workflow/main.ts` follows the CRE SDK `typescriptConfHTTP` pattern:

1. `ConfidentialHTTPClient` fetches reserve data from the custodian's private API (encrypted end-to-end)
2. Compares reserves vs liabilities **inside the TEE**
3. `consensusIdenticalAggregation` across DON nodes
4. Returns only `{isSolvent: boolean}` — balances never leave the enclave

## CCC Settlement Workflow

The dark pool settlement uses Chainlink Confidential Compute for end-to-end private token transfers:

1. Agent encrypts deficit amount with CCC master public key (threshold encryption via Vault DON)
2. CREDarkPool.sol receives the encrypted request
3. Vault DON re-encrypts inputs for the assigned CCC compute enclave
4. Enclave decrypts order + market maker balances, matches fills, applies transfers
5. Enclave re-encrypts updated balance table, returns encrypted state + boolean + attestation
6. On-chain: only the encrypted balance hash, boolean success, and CCC attestation are stored

In simulation mode, the CCC operations are simulated with the correct interfaces and data flows. The workflow is designed to be a drop-in upgrade when CCC General Access launches.

## Recovery Agent

Monitors `ReserveStatusUpdated` events and selects recovery mechanism:

- **Small deficits**: Check wallet balance → Swap USDC → wBTC on Uniswap → Send to reserve
- **Large deficits**: Encrypt order with CCC master public key → Submit to dark pool → CCC enclave matching → Private token settlement → Encrypted state on-chain

Uses an MPC wallet (no raw private keys exposed to the agent). Dry-run mode by default.

## Security

See [SECURITY.md](SECURITY.md) for the full security architecture, including what runs inside the TEE/CCC enclave in production vs what is simulated in the demo.

### Privacy Model

| Data | Visibility |
| --- | --- |
| `isSolvent` boolean | Public on-chain |
| Reserve amounts | Never on-chain (CRE TEE only) |
| Dark pool order amount | Never on-chain (CCC threshold encrypted) |
| Market maker identities | Never on-chain (CCC enclave only) |
| Fill prices | Never on-chain (CCC enclave only) |
| Token transfer amounts | Never on-chain (CCC private token transfer) |
| Updated balance table | On-chain as encrypted hash only |
| Recovery succeeded | Public on-chain (boolean) |
| CCC attestation | Public on-chain (proves computation was correct) |

### Simulation vs Production

The demo uses real Chainlink wBTC PoR data as a simulation anchor and simulates CCC operations with the correct interfaces. In production:

- Reserve data flows from the custodian's private API into the CRE TEE — never via a public PoR feed
- CCC threshold encryption replaces simulated encryption — the Vault DON manages the master key
- Dark pool settlement uses real CCC private token transfers — encrypted balance tables, enclave attestation
- ZK proofs provide additional settlement verification (optional, layered on CCC attestation)

## Stack

- **Chainlink CRE** — Chainlink Runtime Environment (TEE-based workflow orchestration)
- **Chainlink Confidential Compute (CCC)** — Threshold encryption + private token transfers for dark pool settlement
- **Chainlink Proof of Reserve** — Live wBTC PoR feed on Ethereum mainnet (simulation anchor)
- **MPC wallet** — Autonomous agent wallet (no raw private keys)
- **Solidity 0.8.19** — ReserveAttestation + CREDarkPool contracts
- **TypeScript + viem** — All runtime code, Ethereum client
- **Express** — Dashboard backend + mock API
- **Hardhat** — Local EVM for demo
