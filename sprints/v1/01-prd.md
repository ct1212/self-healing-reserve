# PRD — Sprint v1

## Problem

Proof-of-reserve systems today are either fully public (leaking exact balances) or fully opaque (requiring trust). No existing system combines confidential compute verification with autonomous recovery.

## Solution

A three-part system:

1. **CRE Workflow** — Runs inside a TEE. Fetches reserve data via ConfidentialHTTP, compares reserves vs liabilities privately, and publishes only a boolean `isSolvent` attestation on-chain.

2. **ReserveAttestation Contract** — Stores the latest boolean attestation and emits `ReserveStatusUpdated(bool, uint256)` events that downstream consumers can react to.

3. **Recovery Agent** — Watches for `ReserveStatusUpdated` events. When `isSolvent=false`, autonomously executes recovery: checks wallet balance, trades ETH→USDC, sends USDC to the reserve address via the Coinbase agentic wallet CLI.

## Architecture

```
Mock API  →(HTTP)→  CRE Workflow  →(tx)→  ReserveAttestation Contract
                    (TEE)                         │
                                            (event emitted)
                                                  │
                                           Recovery Agent  →(CLI)→  awal
```

## User Flows

### Demo Flow (automated)
1. Hardhat node starts
2. Contract deploys
3. Mock API starts reporting healthy reserves
4. Agent begins watching for events
5. CRE simulator checks reserves → writes `isSolvent=true` → agent does nothing
6. Mock API toggled to undercollateralized
7. CRE simulator checks again → writes `isSolvent=false` → agent detects and executes recovery
8. Mock API toggled back → CRE simulator confirms → agent logs healthy

### Production Flow (future)
- CRE workflow runs on-schedule via DON
- Contract receives reports via `onReport` callback
- Agent runs as persistent service watching mainnet events
- awal CLI authenticated with real wallet

## Non-goals

- Production-grade error handling
- Multi-chain support
- Real DeFi integrations
- Authentication/authorization on the mock API
