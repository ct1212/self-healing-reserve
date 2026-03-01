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
                        │  MPC wallet        │
                        └────────────────────┘
```

**Key principle:** This system is an **alternative** to transparent Proof of Reserve, not a layer on top of it. Reserve balances flow from the custodian's private API directly into the CRE TEE — they never touch a public feed. Only a boolean `isSolvent` attestation is published on-chain. For dark pool recovery, CCC private token transfers ensure that settlement amounts, counterparties, and transfer details also remain confidential — on-chain state contains only an encrypted balance hash + boolean + quorum-signed CCC attestation.

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
- **Recovery agent** runs in dry-run mode — wallet commands are logged but never executed. No real funds are involved.

## Demo vs Production Comparison

| Component | Demo | Production |
|---|---|---|
| Reserve data source | Public wBTC PoR feed (simulation anchor) | Private custodian API (confidential end-to-end) |
| Reserve data fetch | Plain HTTP to localhost mock | ConfidentialHTTP inside TEE |
| API authentication | None | DON vault secret (`{{.SECRET_HEADER}}`) |
| Reserve comparison | Local Node.js process | Inside TEE enclave |
| Consensus | Single process, no consensus | Multi-node DON consensus |
| Blockchain | Hardhat (test mnemonic) | Ethereum mainnet/L2 |
| Attestation write | `updateAttestation()` direct call | `onReport()` via DON |
| Wallet operations | Dry-run (logged only) | MPC wallet (real tx) |
| Private keys | Hardhat test accounts | No raw keys (MPC wallet) |

## Wallet Security

The recovery agent uses an MPC wallet for wallet operations:

- **Dry-run mode** is the default. All wallet commands are logged but not executed. This is always enabled in the demo.
- **MPC custody** — in production, the wallet uses Multi-Party Computation so no raw private keys are ever exposed to the agent process.
- **Constrained actions** — the agent only executes three predefined recovery steps:
  1. `balance` — check available funds
  2. `trade` — swap ETH to USDC
  3. `send` — transfer USDC to the reserve address
- **No arbitrary execution** — the agent does not accept or execute arbitrary commands. Recovery logic is hardcoded in `agent/recovery.ts`.

## CCC Security Model (Dark Pool Settlement)

The dark pool settlement uses Chainlink Confidential Compute (CCC), which provides stronger privacy guarantees than CRE alone:

### Threshold Encryption
- Deficit amounts are encrypted under the CCC **master public key**, which is threshold-shared across the Vault DON
- **No single Vault DON node** can decrypt the data — a quorum of nodes must cooperate to provide re-encrypted key shares to the assigned compute enclave
- Even if individual Vault DON nodes are compromised, the encrypted data remains secure as long as the threshold is maintained

### Vault DON (Decryption Nodes)
- The Vault DON holds threshold-shared fragments of the master secret key
- When a computation is needed, the Vault DON **re-encrypts** inputs for the specific assigned compute enclave
- Re-encryption is done without ever reconstructing the full master secret key
- Key shares are rotated periodically (proactive secret sharing)

### Compute Enclaves
- CCC computations run inside TEE (Trusted Execution Environment) enclaves
- The enclave receives re-encrypted inputs from the Vault DON, decrypts locally, performs computation
- The enclave produces an **attestation** proving the computation was performed correctly inside a genuine TEE
- The Workflow DON verifies the attestation and **quorum-signs** the result before writing to chain

### Private Token Transfers
- CCC private token transfers use an **account-based** model (more efficient than UTXO-based privacy)
- The contract stores an **encrypted balance table** — balances encrypted under the CCC master public key
- Transfers happen entirely inside the CCC enclave: decrypt balances → apply debits/credits → re-encrypt
- On-chain, only the encrypted balance table blob and a hash are stored
- No plaintext amounts, sender/receiver identities, or transfer details are ever visible on-chain

### Data Visibility After CCC Integration

| Data | Visibility |
|---|---|
| `isSolvent` boolean | Public on-chain (ReserveAttestation.sol) |
| Reserve amounts | Never on-chain (stays in CRE TEE) |
| Dark pool order amount | Never on-chain (CCC threshold encrypted) |
| Market maker identities | Never on-chain (inside CCC enclave only) |
| Fill prices | Never on-chain (inside CCC enclave only) |
| Token transfer amounts | Never on-chain (CCC private token transfer) |
| Updated balance table | On-chain as encrypted blob + hash only |
| Recovery succeeded | Public on-chain (boolean) |
| CCC attestation | Public on-chain (proves computation was correct) |

### Simulation Note
CCC is in Early Access (launched early 2026). The CCC private token transfer operations in this project are simulated with the same interface patterns. The ConfidentialHTTPClient for reserve verification is already live. Full CCC GA with decrypt/encrypt primitives is planned for later in 2026.

## Threat Model Considerations

- **Mock API manipulation**: In the demo, anyone on localhost can call `/toggle` or `/set-reserves` to change the reported reserve state. In production, the custodian API is authenticated and the TEE prevents MITM attacks on the data path.
- **Contract ownership**: The `ReserveAttestation` contract restricts `updateAttestation()` to the deployer. In production, only the DON's `onReport()` callback can update the attestation.
- **Agent autonomy**: The agent acts only on verified on-chain events (not on API data directly). An undercollateralized API response alone does not trigger recovery — it must first be attested on-chain by the CRE workflow.
