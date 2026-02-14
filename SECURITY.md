# Security Architecture

This document explains the security model of the Self-Healing Reserve system, distinguishing between what runs inside a Trusted Execution Environment (TEE) in production and what is simulated in the demo.

## Overview

```
┌─────────────────────────────────────────────────┐
│  TEE (Chainlink DON)                            │
│                                                 │
│  ┌───────────────┐    ┌──────────────────────┐  │
│  │ ConfidentialHTTP│──▶│  Reserve comparison  │  │
│  │ fetch reserves │    │  ratio >= threshold? │  │
│  └───────────────┘    └──────────┬───────────┘  │
│                                  │              │
│            Only boolean leaves   │              │
└──────────────────────────────────┼──────────────┘
                                   ▼
                        ┌────────────────────┐
                        │  On-chain:         │
                        │  isSolvent = bool  │    ◀── public
                        │  ReserveStatusUpdated()│
                        └────────┬───────────┘
                                 │ event
                                 ▼
                        ┌────────────────────┐
                        │  Recovery Agent    │    ◀── off-chain, dry-run in demo
                        │  awal wallet CLI   │
                        └────────────────────┘
```

**Key principle:** Exact reserve balances are confidential. Only a boolean `isSolvent` attestation is published on-chain. The architecture ensures no sensitive financial data leaks, even when the attestation is publicly verifiable.

## What Runs in the TEE (Production)

In a production deployment using Chainlink CRE (Compute Runtime Environment):

- **ConfidentialHTTP** fetches reserve data from the custodian API. The HTTP request and response are encrypted end-to-end — only visible inside the TEE enclave.
- **Secret API keys** are stored in the DON vault, referenced via `{{.SECRET_HEADER}}` template syntax. Keys are never present in source code or workflow configuration.
- **Reserve comparison** (`totalReserve / totalLiabilities >= threshold`) executes entirely inside the enclave. No DON node operator can observe the intermediate values.
- **Consensus** uses `consensusIdenticalAggregation` — multiple DON nodes independently compute the same result inside their respective TEEs and reach agreement.
- **Output:** Only the boolean `isSolvent` result leaves the TEE, encoded into an on-chain transaction via `onReport()`.

## What's Simulated in the Demo

The demo (`npm run demo`) replicates the full architecture locally without a real TEE:

- **`demo/simulate-workflow.ts`** performs the same fetch-compare-attest logic that the CRE workflow would, but runs as a regular Node.js process. There is no enclave isolation.
- **Hardhat node** uses the well-known test mnemonic (`test test test ... junk`). These are deterministic test accounts with no real value.
- **Mock API** (`mock-api/server.ts`) runs on `localhost:3001` with no authentication. In production, the API would require credentials stored in the DON vault.
- **Recovery agent** runs with `AWAL_DRY_RUN=true` — wallet commands are logged but never executed. No real funds are involved.

## Demo vs Production Comparison

| Component | Demo | Production |
|---|---|---|
| Reserve data fetch | Plain HTTP to localhost mock | ConfidentialHTTP inside TEE |
| API authentication | None | DON vault secret (`{{.SECRET_HEADER}}`) |
| Reserve comparison | Local Node.js process | Inside TEE enclave |
| Consensus | Single process, no consensus | Multi-node DON consensus |
| Blockchain | Hardhat (test mnemonic) | Ethereum mainnet/L2 |
| Attestation write | `updateAttestation()` direct call | `onReport()` via DON |
| Wallet operations | `AWAL_DRY_RUN=true` (logged only) | Coinbase MPC wallet (real tx) |
| Private keys | Hardhat test accounts | No raw keys (MPC wallet) |

## Wallet Security

The recovery agent uses `awal` (Coinbase agentic wallet CLI) for wallet operations:

- **Dry-run mode** (`AWAL_DRY_RUN=true`) is the default. All wallet commands are logged but not executed. This is always enabled in the demo.
- **MPC wallet** — when authenticated in production, `awal` uses Coinbase's MPC (Multi-Party Computation) wallet infrastructure. No raw private keys are ever exposed to the agent process.
- **Constrained actions** — the agent only executes three predefined recovery steps:
  1. `balance` — check available funds
  2. `trade` — swap ETH to USDC
  3. `send` — transfer USDC to the reserve address
- **No arbitrary execution** — the agent does not accept or execute arbitrary commands. Recovery logic is hardcoded in `agent/recovery.ts`.

## Threat Model Considerations

- **Mock API manipulation**: In the demo, anyone on localhost can call `/toggle` or `/set-reserves` to change the reported reserve state. In production, the custodian API is authenticated and the TEE prevents MITM attacks on the data path.
- **Contract ownership**: The `ReserveAttestation` contract restricts `updateAttestation()` to the deployer. In production, only the DON's `onReport()` callback can update the attestation.
- **Agent autonomy**: The agent acts only on verified on-chain events (not on API data directly). An undercollateralized API response alone does not trigger recovery — it must first be attested on-chain by the CRE workflow.
