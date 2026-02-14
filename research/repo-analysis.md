# Repo Analysis — CRE CLI + Agentic Wallet Skills

## Repo 1: CRE CLI (Chainlink)
- **Repo:** https://github.com/smartcontractkit/cre-cli
- **What:** Go/Cobra CLI for building, simulating, and deploying Chainlink Runtime Environment (CRE) workflows
- **Stack:** Go 1.25.5, Cobra, WASM, EVM, Chainlink DON

### Key Capabilities
- **Initialize projects** — Go and TypeScript templates (PoR, HelloWorld, Blank, ConfidentialHTTP)
- **Workflow simulate** — Run workflows locally against Anvil (local EVM)
- **Workflow deploy** — Compile to WASM, upload (Brotli compressed + base64), register in WorkflowRegistry V2 contract
- **Secrets management** — Store/manage secrets in Chainlink's Vault DON with time-limited allowlists
- **Account management** — Link Ethereum addresses with proof-of-ownership signatures
- **Contract bindings** — Auto-generate Go bindings from contract ABIs
- **Auth** — OAuth2 PKCE flow via Auth0

### Architecture
```
cre (root)
├── Account: link-key, unlink-key, list-key
├── Workflow: deploy, simulate, test, activate, pause, delete
├── Secrets: create, update, delete, list, execute
├── Auth: login, logout
├── Init: project scaffolding with templates
└── Tools: generate-bindings, version, whoami, update
```

### Key Dependencies
- go-ethereum, chainlink-evm, chainlink-common, chainlink-testing-framework/seth
- wasmtime (WASM runtime), chain-selectors
- TDH2 (threshold decrypt hash), Ledger hardware wallet support
- graphql, gRPC, zerolog

---

## Repo 2: Agentic Wallet Skills (Coinbase)
- **Repo:** https://github.com/coinbase/agentic-wallet-skills
- **What:** Agent skills framework giving AI agents autonomous crypto wallet operations on Base
- **Stack:** Node.js, awal CLI, USDC on Base, x402 protocol, Vercel Skills spec

### Skills (8 total)
| Skill | Purpose |
|---|---|
| **authenticate-wallet** | Email OTP two-step auth |
| **fund** | Fiat on-ramp via Coinbase Onramp (Apple Pay, debit, bank, Coinbase account) |
| **send-usdc** | Transfer USDC to addresses or ENS names |
| **trade** | Swap tokens on Base (USDC, ETH, WETH, custom contracts) |
| **search-for-service** | Discover paid APIs on x402 bazaar |
| **pay-for-service** | Make paid API requests with automatic USDC payment |
| **monetize-service** | Build and deploy paid APIs with x402 middleware |
| **query-onchain-data** | Query Base blockchain via CoinbaseQL (ClickHouse-based SQL) |

### Key Details
- **Primary network:** Base (Coinbase L2)
- **Token contracts:** USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, 6 decimals), ETH, WETH
- **x402 protocol:** HTTP 402 Payment Required for machine-to-machine payments
- **Security:** Email OTP auth, spending limits, session caps
- **CLI:** `npx awal@latest <command>`
- **Install:** `npx skills add coinbase/agentic-wallet-skills`
