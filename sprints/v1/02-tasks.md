# Tasks — Sprint v1

## Phase 1: Foundation
- [x] Root setup — package.json, .gitignore, .env.example
- [x] Smart contract — ReserveAttestation.sol + TypeScript ABI export
- [x] Mock API — Express server with /reserves, /toggle, /set-reserves, /state

## Phase 2: CRE Workflow
- [x] CRE workflow — main.ts following typescriptConfHTTP template pattern
- [x] Workflow config — config.json, secrets.yaml, tsconfig.json, package.json

## Phase 3: Agent
- [x] Agent config + wallet wrapper — config.ts, wallet.ts
- [x] Agent monitor — viem event watcher for ReserveStatusUpdated
- [x] Agent recovery — orchestration: balance → trade → send
- [x] Agent entry point — index.ts with graceful shutdown

## Phase 4: Demo
- [x] Contract deployment — compile with solc, deploy via viem
- [x] Workflow simulator — local CRE simulation calling mock API + contract
- [x] Demo orchestrator — full end-to-end loop

## Phase 5: Sprint docs
- [x] 00-goal.md, 01-prd.md, 02-tasks.md, 03-status.md
