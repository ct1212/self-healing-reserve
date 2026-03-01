# CREDarkPool Integration Guide

Chainlink Confidential Compute (CCC) Private Token Transfer integration for the Self-Healing Reserve dark pool.

## Overview

This integration enables **end-to-end confidential collateral recovery** where:
- Recovery need is CCC threshold-encrypted (no single node can decrypt)
- Market makers deposit encrypted liquidity via `depositLiquidity()`
- CCC enclave matches orders and settles via private token transfer
- On-chain: only encrypted balance hash + boolean + CCC attestation

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│              CCC CONFIDENTIAL DARK POOL FLOW                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  1. REQUEST                                                         │
│     Recovery Agent → DarkPool.requestCollateral()                   │
│     - Amount encrypted with CCC master public key (threshold)       │
│     - Shielded address (one-time use)                               │
│     - Premium incentive + timeout                                   │
│                                                                     │
│  2. CCC PROCESSING                                                  │
│     Workflow DON → assigns CCC compute enclave                      │
│     Vault DON → re-encrypts inputs for assigned enclave             │
│     - No single node can decrypt (threshold key shares)             │
│                                                                     │
│  3. ENCLAVE MATCH + PRIVATE TOKEN TRANSFER                          │
│     CCC Enclave (inside TEE):                                       │
│     - Decrypts deficit amount + market maker balances               │
│     - Matches orders across multiple market makers                  │
│     - Applies transfers (debit MMs, credit reserve)                 │
│     - Re-encrypts updated balance table                             │
│     - Returns: encrypted balances + boolean + hash + attestation    │
│                                                                     │
│  4. ON-CHAIN SETTLEMENT                                             │
│     CCC Enclave → DarkPool.cccSettle()                              │
│     - Encrypted balance table stored (opaque blob)                  │
│     - Boolean recoverySucceeded written                             │
│     - Balance hash for integrity verification                       │
│     - Quorum-signed CCC attestation                                 │
│     - NO plaintext amounts ever reach the contract                  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Files

### Smart Contracts
- `CREDarkPool.sol` - Main dark pool contract with private transaction support

### Integration Scripts
- `DarkPoolPrivateTransactions.ts` - TypeScript SDK for the complete flow

### Research
- `confidential-http-workshop.md` - Workshop notes on Confidential HTTP
- `chainlink-private-transactions-workshop.md` - Private transactions workshop transcript

## Key Features

### 1. CCC Threshold Encrypted Amounts
Amounts are encrypted with the CCC master public key (threshold-shared across Vault DON):
```solidity
bytes32 encryptedAmount;  // CCC threshold encrypted, no single node can decrypt
```

### 2. CCC Encrypted Balance Table
Market maker liquidity stored as an encrypted blob. All balance operations happen inside the CCC enclave:
```solidity
struct EncryptedBalanceTable {
    bytes encryptedData;    // Opaque blob (CCC master key encrypted)
    bytes32 balanceHash;    // Hash for integrity verification
    uint256 version;        // Incrementing version
}
```

### 3. CCC Settlement
Settlement via `cccSettle()` receives only encrypted outputs from the CCC enclave:
```solidity
function cccSettle(
    bytes32 requestId,
    bytes calldata encryptedBalances,   // Re-encrypted by enclave
    bytes32 balanceHash,                // Integrity hash
    bool recoverySucceeded,             // Boolean result
    uint256 fillCount,                  // Number of fills (no amounts)
    bytes calldata cccAttestation       // Quorum-signed by Workflow DON
) external onlyRole(CCC_ENCLAVE_ROLE)
```

### 4. Privacy Guarantees (CCC-enhanced)
| Information | Visibility |
|-------------|------------|
| Request amount | CCC threshold encrypted (never on-chain) |
| Market maker identity | Hidden inside CCC enclave |
| Fill amount | CCC threshold encrypted (never on-chain) |
| Fill price | Hidden inside CCC enclave |
| Token transfers | CCC private token transfer (encrypted balance updates) |
| Settlement result | Boolean + encrypted balance hash + CCC attestation |

## Usage

### Creating a Recovery Request (CCC Threshold Encrypted)

```typescript
// 1. Encrypt deficit amount with CCC master public key (threshold encryption)
// No single Vault DON node can decrypt. Only a CCC compute enclave can
const encryptedAmount = await cccThresholdEncrypt(deficitAmount);

// 2. Generate shielded address
const shieldedAddress = generateShieldedAddress();

// 3. Submit to CREDarkPool
const requestId = await darkPool.requestCollateral(
  encryptedAmount,
  200,          // 2% premium
  3600,         // 1 hour timeout
  shieldedAddress
);
```

### Market Maker Liquidity Deposit

```typescript
// Market makers deposit encrypted liquidity
// The contract never sees the plaintext amount
const encryptedDeposit = await cccThresholdEncrypt(depositAmount);
const depositId = await darkPool.depositLiquidity(encryptedDeposit);
```

### CCC Settlement (Automated by CCC Enclave)

```typescript
// This is called by the CCC enclave after processing, not by users directly.
// The enclave has:
//   1. Decrypted deficit + market maker balances
//   2. Matched orders and applied private token transfers
//   3. Re-encrypted the updated balance table
await darkPool.cccSettle(
  requestId,
  reencryptedBalanceTable,  // Opaque blob
  balanceHash,              // Integrity hash
  true,                     // recoverySucceeded
  3,                        // fillCount (no amounts revealed)
  cccAttestation            // Quorum-signed
);
```

## Integration with Self-Healing Reserve

The dark pool is called by the `RecoveryAgent` when:
1. Reserve is undercollateralized (`isSolvent = false`)
2. Deficit exceeds $50M (threshold for dark pool vs. direct wallet)
3. Privacy is critical (avoid market signaling)

```typescript
// In agent/recovery.ts
if (deficitAmount > 50_000_000) {
    // Use CCC confidential dark pool
    // 1. CCC threshold encrypt the deficit amount
    // 2. Submit to CREDarkPool contract
    // 3. CCC enclave matches + settles via private token transfer
    // 4. On-chain: only encrypted hash + boolean + attestation
    await executeDarkPoolRecovery(deficitAmount, config);
} else {
    // Use direct wallet for small amounts
    await executeDirectRecovery(config);
}
```

## Deployment

### Prerequisites
1. Deploy `CREDarkPool.sol`
2. Set Vault contract address (Chainlink CCC)
3. Set Policy Engine address (ACE compliance)
4. Grant `CCC_ENCLAVE_ROLE` to Chainlink CCC compute enclave
5. Grant `TEE_VERIFIER_ROLE` to Chainlink CRE oracle

### Configuration
```bash
export DARK_POOL_ADDRESS=0x...
export VAULT_ADDRESS=0x...
export CCC_MASTER_PUBLIC_KEY=0x...  # CCC threshold master public key
```

## Testing

Run the example flow:
```bash
cd contracts/darkpool
npx ts-node DarkPoolPrivateTransactions.ts
```

## Security Considerations

1. **Threshold Encryption**: CCC master public key is threshold-shared. No single node can decrypt
2. **Vault DON Quorum**: Re-encryption requires quorum of Vault DON nodes, protecting against individual node compromise
3. **Enclave Attestation**: CCC enclave produces TEE attestation, verified by Workflow DON before quorum-signing
4. **Replay Protection**: Settlement results indexed by request ID, tickets are one-time use
5. **Expiration**: Requests timeout to prevent stale orders
6. **Compliance**: ACE policy engine enforces regulatory rules

## Simulation Note

CCC is in Early Access (launched early 2026 via CRE). The CCC private token transfer operations are simulated with the same interface patterns. The ConfidentialHTTPClient for reserve verification is already live in production. Full CCC GA with decrypt/encrypt primitives is planned for later in 2026.

## References

- [CCC Whitepaper](https://research.chain.link/confidential-compute.pdf)
- [CCC Blog Post](https://blog.chain.link/chainlink-confidential-compute/)
- [CRE SDK Reference](https://docs.chain.link/cre/reference/sdk/overview-ts)
- [CRE Getting Started](https://docs.chain.link/cre/getting-started/overview)
- [EIP-712 Standard](https://eips.ethereum.org/EIPS/eip-712)
