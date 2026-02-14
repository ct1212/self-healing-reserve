# Hackathon Use Case Proposals

Three proposals combining CRE CLI + Agentic Wallet Skills + Confidential Compute.

**Selected: #3 — Self-Healing Reserve**

---

## 1. Confidential AI Agent Treasury — "Blind Rebalancer"

**Concept:** CRE workflow in confidential compute ingests private market signals and computes optimal rebalancing — without exposing strategy or holdings. Output triggers Agentic Wallet to execute trades/transfers on Base.

- **CRE:** ConfidentialHTTP for private data, TEE for strategy logic, signed instruction output
- **Wallet:** trade (swaps), send-usdc (vault moves), query-onchain-data (verify execution)
- **Confidential Compute:** Strategy IP, position sizes, data sources stay private
- **Complexity:** Medium

---

## 2. x402 Oracle Data Marketplace — "Pay-Per-Query Confidential Oracle"

**Concept:** CRE workflow as premium data oracle (RWA valuations, risk scores). Confidential compute protects aggregation logic. Monetized via x402 — agents discover on bazaar and pay USDC per query.

- **CRE:** ConfidentialHTTP for source data, TEE for aggregation, contract write for results
- **Wallet:** monetize-service (x402 wrapper), search/pay-for-service, query-onchain-data
- **Confidential Compute:** Source weights and aggregation logic sealed in TEE
- **Complexity:** Medium-High

---

## 3. Confidential PoR with Autonomous Recovery — "Self-Healing Reserve" (SELECTED)

**Concept:** CRE Proof-of-Reserve workflow verifies reserves in confidential compute (exact holdings stay private), publishes boolean attestation on-chain. When reserves dip below threshold, Agentic Wallet autonomously restores the peg.

- **CRE:** PoR template, ConfidentialHTTP for custodian APIs, TEE verification, boolean attestation
- **Wallet:** fund (fiat on-ramp), trade (rebalance tokens), send-usdc (move to reserve contract), query-onchain-data (confirm execution)
- **Confidential Compute:** Reserve balances, custodian details, treasury structure stay private
- **Complexity:** High

### Why This One
- Genuinely novel (nothing combines all three pieces)
- Spans Privacy Track ($16K/$10K/$6K) AND DeFi Track ($20K/$12K/$8K)
- Clear narrative: "detect and halt" → "detect and heal"
- Natural use of both repos
- Confidential Compute early access drops Feb 16
