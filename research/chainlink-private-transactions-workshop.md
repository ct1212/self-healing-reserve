# Chainlink Private Transactions Workshop Transcript
**Source:** Chainlink Convergence Hackathon Workshop  
**Date:** February 2026  
**Presenters:** Harry and Frank  
**Topic:** Making Private Transactions with Confidential Compute

---

## Overview

This workshop covers the **Chainlink Confidential Compute** private transactions feature, specifically the sandbox/demo available for the hackathon. This is directly applicable to the self-healing-reserve project's dark pool and confidential PoR functionality.

---

## Key Concepts

### What is Chainlink Confidential Compute?

Two main aspects:
1. **Private Compute** - Actual computation in privacy-preserving manner (still being built)
2. **Private Transactions** - Private value/token movements (available for hackathon)

### Private Transactions Architecture

```
┌─────────────────────────────────────────────────────────────┐
│              PRIVATE TRANSACTIONS FLOW                      │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  PUBLIC REALM          PRIVATE REALM         PUBLIC REALM   │
│  ┌──────────┐         ┌──────────┐         ┌──────────┐    │
│  │ User A   │────────▶│  Vault   │────────▶│ User B   │    │
│  │ Wallet   │ deposit │ Contract │ transfer│ Wallet   │    │
│  └──────────┘         └────┬─────┘         └──────────┘    │
│                            │                                │
│                            ▼                                │
│                    ┌──────────────┐                         │
│                    │ Off-Chain    │                         │
│                    │ Secure       │                         │
│                    │ Enclave      │                         │
│                    └──────────────┘                         │
│                                                             │
│  - Balances maintained privately in enclave                 │
│  - Transfers happen off-chain                               │
│  - Only deposits/withdrawals touch public ledger            │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Key Components

#### 1. Vault Contract (On-Chain)
- Smart contract acting as entry/exit point
- **Functions:**
  - `deposit()` - Move tokens from public to private realm
  - `withdrawWithTicket()` - Move tokens back to public realm
  - `registerToken()` - Register ERC20 token with ACE policy
- **Events:**
  - `Deposit` - User deposited funds
  - `Withdrawal` - User withdrew funds
  - `TokenRegistered` - New token added to privacy pool

#### 2. Off-Chain Service (Secure Enclave)
- Chainlink Confidential Compute service
- Maintains private balances
- Processes private transfers
- **APIs:**
  - `retrieveBalances` - Check private balances
  - `listTransactions` - View transaction history
  - `privateTokenTransfer` - Transfer between addresses
  - `withdrawTokens` - Generate withdrawal ticket
  - `generateShieldedAddress` - Create privacy address

#### 3. ACE (Automated Compliance Engine)
- Policy layer attached to tokens
- Customizable compliance rules
- Example: Allow lists, rate limits, transfer restrictions

---

## Demo Walkthrough

### Prerequisites
```bash
# Install dependencies
forge install

# Build contracts
forge build --via-ir

# Set environment variables
export PRIVATE_KEY=your_key
export RPC_URL=your_sepolia_rpc
```

### Step 1: Deploy and Setup
**Script:** `SetupAll.s.sol`

Deploys in sequence:
1. **ERC20 Token** - Simple token inheriting ERC20 + ERC20Permit
2. **Policy Engine** - ACE policy (empty for demo)
3. **Mint tokens** - To deployer address
4. **Approve vault** - Allow vault to spend tokens
5. **Register token** - Link token + policy to vault
6. **Deposit tokens** - Move to private realm

**Result:** Token is ready for private transfers

### Step 2: Generate Shielded Address

```javascript
// API call to generate shielded address
POST /generateShieldedAddress
{
  "address": "0x...recipientRealAddress"
}

// Returns
{
  "address": "0x...shieldedAddress" // Looks like normal address
}
```

**Key Point:** Shielded address cannot be linked to real address until withdrawal

### Step 3: Private Transfer

```javascript
// Transfer to shielded address
POST /privateTokenTransfer
{
  "recipient": "0x...shieldedAddress",  // Shielded, not real
  "token": "0x...tokenAddress",
  "amount": "1000000000000000000"       // 1 token (18 decimals)
}

// Returns transaction ID (off-chain only)
```

**Privacy Guarantees:**
- No on-chain record of transfer
- No link between sender and recipient
- Amount remains private
- Only enclave knows true balances

### Step 4: Withdraw to Public

```javascript
// Step 4a: Generate withdrawal ticket
POST /withdrawTokens
{
  "token": "0x...tokenAddress",
  "amount": "1000000000000000000"
}

// Returns
{
  "ticket": "0x...cryptographicSignature",
  "amount": "1000000000000000000",
  "token": "0x...tokenAddress"
}
```

```solidity
// Step 4b: Submit ticket on-chain
vault.withdrawWithTicket(
  ticket,      // Cryptographic proof from enclave
  amount,      // Must match ticket
  token        // Must match ticket
);
```

**Verification:**
- Vault verifies ticket signature
- Ensures one-time use
- Releases tokens to caller
- Now visible on public ledger

---

## EIP-712 Signatures

All API calls require EIP-712 signatures for authentication:

```javascript
// Sign request with MetaMask
const signature = await signer.signTypedData(
  domain,
  types,
  message
);
```

This ensures:
- Request authenticity
- Non-repudiation
- Replay protection

---

## API Scripts for Automation

Location: `api-scripts/` folder

### Available Scripts
- `balances.ts` - Check private balances programmatically
- `private-transfer.ts` - Execute private transfers
- `shielded-address.ts` - Generate shielded addresses
- `transactions.ts` - List transaction history
- `withdraw.ts` - Generate withdrawal tickets

### Usage in CRE Workflows
```typescript
// Example: CRE workflow using private transactions
const result = await Functions.makeHttpRequest({
  url: "https://api.chainlink.../privateTokenTransfer",
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Signature": signature
  },
  data: {
    recipient: shieldedAddress,
    token: tokenAddress,
    amount: amount
  }
});
```

---

## Integration with Self-Healing Reserve

### Application: Dark Pool Recovery

```
┌─────────────────────────────────────────────────────────────┐
│           DARK POOL WITH PRIVATE TRANSACTIONS               │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. Reserve detects undercollateralization                  │
│                                                             │
│  2. Recovery agent creates shielded address                 │
│     (market makers don't know who needs funds)              │
│                                                             │
│  3. Market makers deposit to vault → shielded address       │
│     (private transfer, no public visibility)                │
│                                                             │
│  4. Agent withdraws using ticket                            │
│     (funds appear in reserve, source unknown)               │
│                                                             │
│  Result: Recovery happens without signaling distress        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Benefits for Self-Healing Reserve

1. **Confidential Matching** - Market makers don't see who needs funds
2. **No Front-Running** - Recovery transactions are private until settled
3. **MEV Protection** - No public mempool exposure
4. **Compliance** - ACE policies ensure regulatory requirements

---

## Key Technical Details

### ERC20 Permit
- Why used: Allows gasless approvals via signatures
- Implementation: Standard OpenZeppelin ERC20Permit
- Benefit: Better UX, no separate approve transaction

### Policy Engine
- Can enforce: Allow lists, rate limits, time locks
- Empty policy: No restrictions (demo mode)
- Custom policies: KYC checks, geographic restrictions

### Shielded Addresses
- Look like: Normal Ethereum addresses (0x...)
- Generation: Deterministic from real address + nonce
- Unlinkability: Cannot connect to real address without withdrawal

---

## Resources

### Links Shared in Workshop
- **Sandbox:** https://confidential.chain.link (testnet demo)
- **GitHub Repo:** Contains demo scripts and API examples
- **Documentation:** Chainlink Confidential Compute docs
- **ACE Info:** Automated Compliance Engine documentation

### Support Channels
- Discord: Chainlink Convergence Hackathon
- Office Hours: Scheduled during hackathon

---

## Action Items for Self-Healing Reserve

1. **Integrate private transactions API** into dark pool module
2. **Create shielded address generation** for confidential matching
3. **Implement withdrawal ticket flow** for settlement
4. **Add ACE policy** for compliance requirements
5. **Test on Sepolia** using provided sandbox

---

## Critical Insight

The private transaction layer sits **between** the public ledger and application logic:

```
Public Entry → Private Ledger → Application Logic → Private Ledger → Public Exit
     ↑                                                              ↓
  Deposit                                                    Withdrawal
  (visible)                                                  (visible)
```

This enables:
- **Private balance movements** within the system
- **Public auditability** at entry/exit points
- **Compliance** via ACE policies
- **Complete confidentiality** of intermediate transactions

Perfect for dark pool recovery where you need privacy + auditability.
