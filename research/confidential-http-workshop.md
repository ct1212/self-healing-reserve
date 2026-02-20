# Confidential HTTP Workshop Research (Feb 18, 2026)

Source: Chainlink Harry workshop on Confidential HTTP requests for CRA

## Core Technology

- **Vault DON** + Threshold Encryption: Secrets split across node operators, only reconstructed inside enclave
- **Confidential HTTP vs Regular HTTP:**
  - Only ONE API call total (vs one per node in regular HTTP)
  - Secrets never visible to Chainlink nodes
  - Request body kept private
  - Response can be encrypted with AES-GCM

## Technical Implementation

1. **Secret Storage:** API credentials stored in Vault DON via threshold encryption
2. **Request Flow:** Secrets decrypted ONLY inside TEE enclave
3. **Response Encryption:** Set `encryptResponse: true` + use reserved key `SANMARINO_AES_GCM_ENCRYPTION_KEY`
4. **Response Format:** 12-byte nonce || ciphertext || auth tag
5. **Decryption:** Split nonce (first 12 bytes) from ciphertext+tag, decrypt with AES key

## Application to Dark Pool Recovery

- Store dark pool API key in Vault DON (nodes can't see it, can't front-run)
- Recovery request params (amount, asset, wallet) stay private in request body
- Match results encrypted with AES key — only our settlement backend can decrypt
- Encrypted response passed through workflow to ZK prover

## Hackathon Requirements

- Simulated workflows acceptable (don't need production deployment)
- Focus on USE CASE and workflow demonstration
- Office hours available Feb 20+ for support/validation
- Discord support channels active

## Resources

- Docs: docs.chain.link → Capabilities → Confidential HTTP
- Demo repo available with working implementation
- AES key generation: can use command line or online tool
- API Ninjas for testing (free API key)
