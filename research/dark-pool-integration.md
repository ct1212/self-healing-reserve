# Decentralized Dark Pools + CRE Integration Research

## Objective
Design a dark pool system that can simulate filling undercollateralization gaps for stablecoins, integrated with Chainlink Runtime Environment (CRE) and Confidential Compute.

## Current Status
- ⏳ Waiting on Chainlink Confidential Compute (early access: Feb 16, 2026)
- 🔍 Researching dark pool mechanics and CRE integration
- 🏗️ Architecture design in progress

---

## What Are Decentralized Dark Pools?

Traditional dark pools are private exchanges where institutional investors trade large blocks without revealing order book data. Decentralized dark pools bring this on-chain with:

- **Privacy**: Orders not visible on public mempool
- **MEV protection**: Transactions hidden until execution
- **Large block trades**: Minimize slippage for big orders
- **Confidential settlement**: Amounts/parties revealed only to counterparties

### Key Mechanisms

1. **Commit-Reveal Schemes**
   - Traders commit to orders (hashed)
   - Orders revealed and matched in batches
   - Prevents front-running

2. **TEE-Based Order Matching**
   - Orders sent to TEE (Trusted Execution Environment)
   - Matching happens inside enclave
   - Only matched orders revealed on-chain

3. **ZK-Proof Settlement**
   - Prove valid trade without revealing amounts
   - Settlement via ZK rollups or private chains

---

## Dark Pool + Undercollateralization Recovery

### The Problem
When a stablecoin becomes undercollateralized:
- Current systems: HALT (circuit breakers)
- Reserve Protocol: Rebalance basket (different mechanism)
- **Gap**: No discreet way to acquire collateral without market panic

### The Solution
**Confidential Dark Pool Recovery (CDPR)**

1. **Detection** (Confidential Compute TEE)
   - Monitor reserve ratio privately
   - Detect: `reserves < threshold`
   - Publish boolean: `undercollateralized: true` (no amounts)

2. **Liquidity Request** (CRE Workflow)
   - Trigger dark pool liquidity request
   - Request: "Need $X collateral, will pay Y premium, confidential"
   - No public panic, no bank run

3. **Dark Pool Fill** (Private Matching)
   - Market makers provide liquidity privately
   - Match inside TEE
   - Execute collateral acquisition without revealing deficit size

4. **Recovery Confirmation** (Public Attestation)
   - TEE publishes: `recovered: true`
   - New ratio attested (still private amount)
   - Stablecoin resumes normal operation

---

## CRE Integration Architecture

### CRE Workflow: Dark Pool Recovery

```yaml
workflow:
  name: confidential-recovery-darkpool
  
  triggers:
    - type: cron
      schedule: "*/5 * * * *"  # Check every 5 min
    
  steps:
    # 1. Confidential Reserve Check
    - id: check-reserves
      type: confidential_compute
      spec:
        image: chainlink/confidential-por:latest
        inputs:
          - oracle_feed: "USDC_RESERVES"
          - threshold: 1.02  # 102% collateralization
        outputs:
          - status: boolean  # backed: true/false
          - deficit: encrypted  # only TEE sees this
          
    # 2. Conditional Dark Pool Trigger
    - id: trigger-recovery
      type: conditional
      condition: "check-reserves.status == false"
      steps:
        
        # 2a. Create Dark Pool Request
        - id: create-request
          type: dark_pool
          spec:
            pool: "CRE_COLLATERAL_DARKPOOL"
            request:
              asset: "USDC_COLLATERAL"
              amount_encrypted: "check-reserves.deficit"
              premium: "0.5%"  # incentive for market makers
              timeout: "1h"
              
        # 2b. Monitor Fill
        - id: monitor-fill
          type: wait
          for: "dark_pool.fill_event"
          timeout: "1h"
          
        # 2c. Execute Settlement
        - id: settle
          type: onchain_tx
          contract: "DARKPOOL_SETTLEMENT"
          function: "confidentialFill"
          args:
            - request_id: "create-request.id"
            - proof: "dark_pool.zk_proof"
            
    # 3. Verify Recovery
    - id: verify-recovery
      type: confidential_compute
      spec:
        image: chainlink/confidential-por:latest
        inputs:
          - oracle_feed: "USDC_RESERVES"
        outputs:
          - status: boolean  # backed: true
          
    # 4. Publish Attestation
    - id: publish-attestation
      type: onchain_tx
      contract: "CONFIDENTIAL_POR"
      function: "attestRecovery"
      args:
        - recovered: "verify-recovery.status"
        - timestamp: "now()"
```

---

## Technical Components Needed

### 1. Dark Pool Smart Contract

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

interface ICREDarkPool {
    // Confidential request
    function requestCollateral(
        bytes32 encryptedAmount,
        uint256 premiumBps,
        uint256 timeout
    ) external returns (bytes32 requestId);
    
    // Market maker fills (TEE-verified)
    function confidentialFill(
        bytes32 requestId,
        bytes calldata zkProof,
        bytes calldata teeAttestation
    ) external;
    
    // Get public status only
    function getRequestStatus(bytes32 requestId) 
        external 
        view 
        returns (RequestStatus status);
}

enum RequestStatus {
    PENDING,
    PARTIALLY_FILLED,
    FILLED,
    EXPIRED,
    CANCELLED
}
```

### 2. TEE Order Matcher

Inside Chainlink Confidential Compute enclave:

```python
# Pseudocode for TEE matcher
def match_orders():
    # 1. Receive encrypted orders
    buy_orders = fetch_encrypted_requests()
    sell_orders = fetch_mm_liquidity()
    
    # 2. Match inside TEE (private)
    matches = []
    for buy in buy_orders:
        for sell in sell_orders:
            if match_compatible(buy, sell):
                matches.append((buy, sell))
                
    # 3. Generate ZK proof of valid matching
    proof = generate_zk_proof(matches)
    
    # 4. Return only what's needed for settlement
    return {
        'matched': True,
        'proof': proof,
        'attestation': tee_attestation()
    }
```

### 3. CRE Custom Capability

Need to build a custom CRE capability for dark pool interaction:

```go
// pkg/capabilities/darkpool/darkpool.go
type DarkPoolCapability struct {
    PoolAddress string
    TEEEndpoint string
}

func (d *DarkPoolCapability) RequestCollateral(
    ctx context.Context,
    req CollateralRequest,
) (*RequestResponse, error) {
    // 1. Encrypt amount with TEE public key
    encryptedAmount := encryptForTEE(req.Amount, d.TEEEndpoint)
    
    // 2. Submit to dark pool contract
    tx, err := d.submitRequest(ctx, encryptedAmount, req.Premium)
    
    // 3. Wait for TEE attestation
    attestation := d.awaitTEEConfirmation(ctx, tx.Hash())
    
    return &RequestResponse{
        RequestID:   tx.Hash(),
        Status:      PENDING,
        ExpiresAt:   time.Now().Add(req.Timeout),
    }, nil
}
```

---

## Open Questions (Research Needed)

### For Confidential Compute Release:
1. **TEE Communication**: How do CRE workflows send/receive from TEE?
2. **Encryption**: What key management for encrypting amounts to TEE?
3. **Attestation Format**: What does TEE attestation look like on-chain?
4. **Gas Costs**: How expensive is confidential compute per workflow run?

### For Dark Pool Design:
1. **Market Maker Incentives**: What premium attracts MMs during stress?
2. **Partial Fills**: Allow multiple MMs to fill pieces?
3. **Failed Recovery**: What happens if dark pool doesn't fill in time?
4. **Privacy Leakage**: Can amounts be inferred from on-chain traces?

### For Stablecoin Integration:
1. **Emergency vs Normal**: Separate dark pool for emergency recovery?
2. **Governance**: Who approves dark pool parameters?
3. **Circuit Breaker**: Still halt if recovery fails after X attempts?

---

## Competitor Landscape

| Project | Dark Pool | TEE/Private | Autonomous Recovery | Notes |
|---------|-----------|-------------|---------------------|-------|
| Renegade | ✅ | ✅ ZK + TEE | ❌ | Newest dark pool, Rust-based |
| Panther Protocol | ✅ | ✅ ZK | ❌ | DeFi privacy, no recovery |
| Aleph Zero | ✅ | ✅ ZK + TEE | ❌ | Substrate chain |
| RAILGUN | ✅ | ✅ ZK | ❌ | Privacy DeFi |
| **Our Project** | ✅ | ✅ TEE (CC) | ✅ | **Only one with recovery** |

---

## Next Steps (Pending CC Release)

1. **Today**: Research dark pool AMM formulas, order matching algos
2. **Tomorrow (Feb 16)**: Get Confidential Compute access, start building
3. **This Week**: 
   - Build CRE custom capability for dark pools
   - Deploy test dark pool contract
   - Integrate with confidential PoR workflow
4. **Hackathon**: Demo confidential detection → dark pool fill → recovery attestation

---

## Resources

- [Renegade Dark Pool Docs](https://renegade.fi/)
- [Chainlink Confidential Compute Announcement](https://blog.chain.link/)
- [CRE Documentation](https://docs.chain.link/cre)
- [Coinbase Agentic Wallets](https://www.coinbase.com/developer-platform/products/agentkit)

---

*Last updated: Feb 17, 2026*  
*Status: Awaiting Confidential Compute Early Access*
