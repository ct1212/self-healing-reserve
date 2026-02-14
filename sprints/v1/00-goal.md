# Goal

Build a "Self-Healing Reserve" system that combines Chainlink CRE confidential compute with Coinbase agentic wallets. A CRE workflow privately verifies reserves inside a TEE, publishes only a boolean attestation on-chain, and when reserves are undercollateralized, an autonomous agent executes recovery via the awal wallet CLI.

# Constraints

- Hackathon scope — keep it demo-ready, not production
- Local Hardhat node for on-chain interactions
- No global installs, no sudo
- Node 22, tsx, hardhat
- Agentic wallet runs in dry-run mode unless authenticated

# Done when

- `npm run setup` installs all dependencies
- `npm run demo` runs the full end-to-end loop:
  - Healthy check → attestation=true → agent does nothing
  - Toggle undercollateralized → attestation=false → agent detects + logs recovery
  - Toggle back → attestation=true → agent confirms recovery
- Each module can run independently (`npm run mock-api`, `npm run agent`)
- CRE workflow file follows SDK template patterns exactly

# Stack

- Solidity 0.8.19 — ReserveAttestation contract
- TypeScript + tsx — all runtime code
- viem — Ethereum client
- Express — mock reserve API
- Hardhat — local EVM node
- @chainlink/cre-sdk — workflow (CRE runtime dependency)
- awal CLI — Coinbase agentic wallet
