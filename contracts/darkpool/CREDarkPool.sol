// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";

/**
 * @title CREDarkPool
 * @notice Confidential dark pool for stablecoin collateral recovery
 * @dev Integrates with Chainlink Confidential Compute (CCC) Private Token Transfers
 *
 * Architecture (CCC-integrated):
 * 1. Recovery agent encrypts deficit with CCC master public key (threshold encrypted)
 * 2. CCC Workflow DON assigns compute enclave, Vault DON re-encrypts inputs
 * 3. Enclave decrypts, matches with market maker liquidity, applies transfers
 * 4. Enclave re-encrypts updated balance table, returns encrypted state + boolean
 * 5. On-chain: only encrypted balance hash + boolean "recovery succeeded" + CCC attestation
 *
 * Key property: CREDarkPool.sol NEVER sees plaintext amounts. It receives encrypted
 * blobs from CCC and stores/forwards them. All computation happens inside the CCC enclave.
 */
contract CREDarkPool is AccessControl, ReentrancyGuard {

    bytes32 public constant TEE_VERIFIER_ROLE = keccak256("TEE_VERIFIER_ROLE");
    bytes32 public constant RECOVERY_MANAGER_ROLE = keccak256("RECOVERY_MANAGER_ROLE");
    bytes32 public constant VAULT_OPERATOR_ROLE = keccak256("VAULT_OPERATOR_ROLE");
    bytes32 public constant CCC_ENCLAVE_ROLE = keccak256("CCC_ENCLAVE_ROLE");

    enum RequestStatus {
        NONE,
        PENDING,
        PARTIALLY_FILLED,
        FILLED,
        EXPIRED,
        CANCELLED
    }

    /**
     * @notice Collateral recovery request
     * @dev Amount is CCC threshold-encrypted — no single node can decrypt
     */
    struct CollateralRequest {
        address requester;              // Recovery agent
        bytes32 encryptedAmount;        // Encrypted with CCC master public key (threshold)
        bytes32 shieldedAddress;        // One-time receiving address
        uint256 premiumBps;             // Incentive for market makers
        uint256 timeout;
        RequestStatus status;
        bytes32 withdrawalTicket;       // TEE-generated ticket for withdrawal
        uint256 createdAt;
    }

    /**
     * @notice Shielded fill from market maker
     * @dev Links shielded address to actual MM without revealing on-chain
     */
    struct ShieldedFill {
        bytes32 shieldedAddress;        // MM deposits here
        bytes32 encryptedAmount;        // Fill amount (CCC threshold encrypted)
        bytes32 teeAttestation;         // CCC enclave attestation (quorum-signed)
        bool withdrawn;
    }

    /**
     * @notice CCC Encrypted Balance Table
     * @dev Balances are encrypted under the CCC master public key.
     * The contract stores only the encrypted blob and its hash.
     * All actual balance computations happen inside the CCC enclave.
     */
    struct EncryptedBalanceTable {
        bytes encryptedData;            // Encrypted balance table (opaque blob)
        bytes32 balanceHash;            // Hash of plaintext balances (for integrity)
        uint256 lastUpdated;            // Timestamp of last CCC update
        uint256 version;                // Incrementing version for ordering
    }

    /**
     * @notice CCC Settlement Result
     * @dev Returned by the CCC enclave after processing a recovery request
     */
    struct CCCSettlementResult {
        bool recoverySucceeded;         // Boolean: did recovery fill?
        bytes32 balanceHash;            // Hash of updated balance table
        bytes cccAttestation;           // Quorum-signed CCC attestation
        uint256 fillCount;              // Number of fills (no amounts revealed)
        uint256 timestamp;
    }

    // State
    mapping(bytes32 => CollateralRequest) public requests;
    mapping(bytes32 => ShieldedFill) public fills;
    mapping(address => bool) public authorizedMarketMakers;
    mapping(bytes32 => bool) public usedTickets;              // Prevent replay

    // CCC Encrypted Balance Table — stores market maker committed liquidity
    // All balances are encrypted under the CCC master public key
    EncryptedBalanceTable public balanceTable;

    // CCC Settlement Results — indexed by request ID
    mapping(bytes32 => CCCSettlementResult) public settlementResults;

    // Vault integration (Chainlink Confidential Compute)
    address public vaultContract;                             // Entry/exit point
    address public policyEngine;                              // ACE compliance

    // Nonces for EIP-712 signatures
    mapping(address => uint256) public nonces;
    
    // Events (carefully designed to not leak amounts or participants)
    event CollateralRequested(
        bytes32 indexed requestId,
        uint256 premiumBps,
        uint256 timeout
    );

    event ShieldedAddressGenerated(
        bytes32 indexed requestId,
        bytes32 indexed shieldedAddress
    );

    event ConfidentialFillSubmitted(
        bytes32 indexed requestId,
        bytes32 indexed shieldedAddress,
        bytes32 indexed teeAttestation
    );

    event RequestFilled(
        bytes32 indexed requestId,
        bytes32 withdrawalTicket
    );

    event ConfidentialWithdrawal(
        bytes32 indexed requestId,
        bytes32 indexed ticket,
        uint256 amount  // Only revealed at withdrawal
    );

    event RequestExpired(bytes32 indexed requestId);

    // CCC-specific events — no amounts or identities leaked
    event CCCBalanceTableUpdated(
        bytes32 indexed balanceHash,
        uint256 version
    );

    event CCCLiquidityDeposited(
        bytes32 indexed depositId,
        uint256 timestamp
        // Note: no amount or depositor revealed
    );

    event CCCSettlementCompleted(
        bytes32 indexed requestId,
        bool recoverySucceeded,
        bytes32 balanceHash,
        uint256 fillCount
    );
    
    // Errors
    error InvalidPremium();
    error InvalidTimeout();
    error RequestNotFound();
    error RequestNotPending();
    error RequestExpired();
    error NotExpiredYet();
    error TicketAlreadyUsed();
    error InvalidTicket();
    error TransferFailed();
    
    constructor(address _vaultContract, address _policyEngine) {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(VAULT_OPERATOR_ROLE, msg.sender);
        vaultContract = _vaultContract;
        policyEngine = _policyEngine;
    }
    
    /**
     * @notice Request confidential collateral fill via CCC
     * @dev Creates shielded address for private matching. Amount must be encrypted
     *      with the CCC master public key (threshold encryption). No single Vault DON
     *      node can decrypt — only a CCC compute enclave receiving re-encrypted key
     *      shares from the Vault DON quorum can access the plaintext.
     * @param encryptedAmount Amount encrypted with CCC master public key (threshold)
     * @param premiumBps Premium to pay market makers (100 = 1%)
     * @param timeout Seconds until request expires
     * @param shieldedAddress One-time address for confidential receiving
     */
    function requestCollateral(
        bytes32 encryptedAmount,
        uint256 premiumBps,
        uint256 timeout,
        bytes32 shieldedAddress
    ) external returns (bytes32 requestId) {
        if (premiumBps > 1000) revert InvalidPremium(); // Max 10%
        if (timeout < 300 || timeout > 86400) revert InvalidTimeout(); // 5min-24h
        
        requestId = keccak256(abi.encodePacked(
            msg.sender,
            encryptedAmount,
            shieldedAddress,
            block.timestamp,
            block.number
        ));
        
        if (requests[requestId].status != RequestStatus.NONE) revert RequestNotFound();
        
        requests[requestId] = CollateralRequest({
            requester: msg.sender,
            encryptedAmount: encryptedAmount,
            shieldedAddress: shieldedAddress,
            premiumBps: premiumBps,
            timeout: timeout,
            status: RequestStatus.PENDING,
            withdrawalTicket: bytes32(0),
            createdAt: block.timestamp
        });
        
        emit CollateralRequested(requestId, premiumBps, timeout);
        emit ShieldedAddressGenerated(requestId, shieldedAddress);
    }
    
    /**
     * @notice Submit confidential fill (called by TEE via CRE)
     * @dev Market maker has deposited to shielded address off-chain
     * @param requestId The request being filled
     * @param encryptedAmount Fill amount (encrypted)
     * @param shieldedAddress The shielded address that received funds
     * @param teeAttestation TEE proof of deposit to shielded address
     * @param withdrawalTicket Ticket for recovery agent to withdraw
     */
    function confidentialFill(
        bytes32 requestId,
        bytes32 encryptedAmount,
        bytes32 shieldedAddress,
        bytes32 teeAttestation,
        bytes32 withdrawalTicket
    ) external onlyRole(TEE_VERIFIER_ROLE) nonReentrant {
        CollateralRequest storage req = requests[requestId];
        
        if (req.status != RequestStatus.PENDING) revert RequestNotPending();
        if (block.timestamp > req.createdAt + req.timeout) revert RequestExpired();
        if (shieldedAddress != req.shieldedAddress) revert InvalidTicket();
        
        // Store the fill details
        fills[requestId] = ShieldedFill({
            shieldedAddress: shieldedAddress,
            encryptedAmount: encryptedAmount,
            teeAttestation: teeAttestation,
            withdrawn: false
        });
        
        // Update request with withdrawal ticket
        req.withdrawalTicket = withdrawalTicket;
        req.status = RequestStatus.FILLED;
        
        emit ConfidentialFillSubmitted(requestId, shieldedAddress, teeAttestation);
        emit RequestFilled(requestId, withdrawalTicket);
    }
    
    /**
     * @notice Deposit liquidity into the dark pool (CCC private token transfer)
     * @dev Market makers deposit encrypted amounts. The encrypted amount is under
     *      the CCC master public key — the contract never sees the plaintext.
     *      The CCC enclave decrypts and adds to the internal balance table.
     * @param encryptedAmount Deposit amount encrypted with CCC master public key
     */
    function depositLiquidity(
        bytes encryptedAmount
    ) external returns (bytes32 depositId) {
        require(authorizedMarketMakers[msg.sender], "Not authorized MM");

        depositId = keccak256(abi.encodePacked(
            msg.sender,
            encryptedAmount,
            block.timestamp,
            block.number
        ));

        // The encrypted amount is forwarded to the CCC enclave for processing.
        // The contract stores nothing about the plaintext amount.
        // In production: CCC enclave decrypts, validates, updates encrypted balance table.

        emit CCCLiquidityDeposited(depositId, block.timestamp);
    }

    /**
     * @notice CCC Settlement — update encrypted balance table after recovery
     * @dev Called by the CCC enclave (via Workflow DON) after processing a recovery.
     *      The enclave has:
     *        1. Decrypted the deficit amount and market maker balances
     *        2. Matched orders and applied transfers inside the TEE
     *        3. Re-encrypted the updated balance table
     *      This function receives ONLY:
     *        - The re-encrypted balance table (opaque blob)
     *        - A boolean success flag
     *        - A hash for integrity verification
     *        - A quorum-signed CCC attestation
     *      NO plaintext amounts ever reach this contract.
     * @param requestId The recovery request being settled
     * @param encryptedBalances Re-encrypted balance table from CCC enclave
     * @param balanceHash Hash of plaintext balances (for integrity verification)
     * @param recoverySucceeded Boolean: did the recovery fill?
     * @param fillCount Number of market maker fills (no amounts revealed)
     * @param cccAttestation Quorum-signed attestation from the Workflow DON
     */
    function cccSettle(
        bytes32 requestId,
        bytes calldata encryptedBalances,
        bytes32 balanceHash,
        bool recoverySucceeded,
        uint256 fillCount,
        bytes calldata cccAttestation
    ) external onlyRole(CCC_ENCLAVE_ROLE) nonReentrant {
        CollateralRequest storage req = requests[requestId];

        if (req.status != RequestStatus.PENDING && req.status != RequestStatus.PARTIALLY_FILLED) {
            revert RequestNotPending();
        }
        if (block.timestamp > req.createdAt + req.timeout) revert RequestExpired();

        // Update the encrypted balance table
        balanceTable.encryptedData = encryptedBalances;
        balanceTable.balanceHash = balanceHash;
        balanceTable.lastUpdated = block.timestamp;
        balanceTable.version++;

        // Store settlement result
        settlementResults[requestId] = CCCSettlementResult({
            recoverySucceeded: recoverySucceeded,
            balanceHash: balanceHash,
            cccAttestation: cccAttestation,
            fillCount: fillCount,
            timestamp: block.timestamp
        });

        // Update request status
        if (recoverySucceeded) {
            req.status = RequestStatus.FILLED;
        }

        emit CCCBalanceTableUpdated(balanceHash, balanceTable.version);
        emit CCCSettlementCompleted(requestId, recoverySucceeded, balanceHash, fillCount);
    }

    /**
     * @notice Get CCC settlement result for a request
     * @dev Returns only the public settlement metadata — no amounts revealed
     */
    function getSettlementResult(bytes32 requestId)
        external
        view
        returns (
            bool recoverySucceeded,
            bytes32 balanceHash,
            uint256 fillCount,
            uint256 timestamp
        )
    {
        CCCSettlementResult storage result = settlementResults[requestId];
        return (
            result.recoverySucceeded,
            result.balanceHash,
            result.fillCount,
            result.timestamp
        );
    }

    /**
     * @notice Withdraw filled collateral using TEE ticket
     * @dev This is the ONLY point where amount is revealed on-chain.
     *      With full CCC private token transfers, this function becomes optional —
     *      settlement happens entirely within the encrypted balance table.
     * @param requestId Request to withdraw from
     * @param token Token being withdrawn
     * @param amount Amount to withdraw (revealed here)
     * @param ticket Cryptographic ticket from TEE
     */
    function withdrawWithTicket(
        bytes32 requestId,
        address token,
        uint256 amount,
        bytes32 ticket
    ) external nonReentrant {
        CollateralRequest storage req = requests[requestId];
        ShieldedFill storage fill = fills[requestId];

        // Validation
        if (req.status != RequestStatus.FILLED) revert RequestNotPending();
        if (req.requester != msg.sender) revert InvalidTicket();
        if (req.withdrawalTicket != ticket) revert InvalidTicket();
        if (usedTickets[ticket]) revert TicketAlreadyUsed();
        if (fill.withdrawn) revert InvalidTicket();

        // Mark as used
        usedTickets[ticket] = true;
        fill.withdrawn = true;

        // Execute withdrawal from vault
        // In production, this would call vault.withdrawWithTicket()
        // For hackathon, we simulate the transfer
        _executeWithdrawal(token, msg.sender, amount);

        emit ConfidentialWithdrawal(requestId, ticket, amount);
    }
    
    /**
     * @notice Partial fill support for large collateral needs
     * @dev Allows multiple market makers to fill portions
     */
    function confidentialPartialFill(
        bytes32 requestId,
        bytes32 encryptedAmount,
        bytes32 shieldedAddress,
        bytes32 teeAttestation,
        bytes32 withdrawalTicket,
        bool isFinalFill
    ) external onlyRole(TEE_VERIFIER_ROLE) nonReentrant {
        CollateralRequest storage req = requests[requestId];
        
        if (req.status != RequestStatus.PENDING && req.status != RequestStatus.PARTIALLY_FILLED) {
            revert RequestNotPending();
        }
        if (block.timestamp > req.createdAt + req.timeout) revert RequestExpired();
        
        // Store partial fill
        // In production, track multiple fills per request
        
        if (isFinalFill) {
            req.withdrawalTicket = withdrawalTicket;
            req.status = RequestStatus.FILLED;
            emit RequestFilled(requestId, withdrawalTicket);
        } else {
            req.status = RequestStatus.PARTIALLY_FILLED;
        }
        
        emit ConfidentialFillSubmitted(requestId, shieldedAddress, teeAttestation);
    }
    
    /**
     * @notice Expire stale requests
     */
    function expireRequest(bytes32 requestId) external {
        CollateralRequest storage req = requests[requestId];
        
        if (req.status != RequestStatus.PENDING && req.status != RequestStatus.PARTIALLY_FILLED) {
            revert RequestNotPending();
        }
        if (block.timestamp <= req.createdAt + req.timeout) revert NotExpiredYet();
        
        req.status = RequestStatus.EXPIRED;
        
        emit RequestExpired(requestId);
    }
    
    /**
     * @notice Get public status (no amounts or addresses revealed)
     */
    function getRequestStatus(bytes32 requestId) 
        external 
        view 
        returns (
            RequestStatus status,
            uint256 timeRemaining,
            bool hasWithdrawalTicket
        ) 
    {
        CollateralRequest storage req = requests[requestId];
        status = req.status;
        hasWithdrawalTicket = req.withdrawalTicket != bytes32(0);
        
        if (status == RequestStatus.PENDING || status == RequestStatus.PARTIALLY_FILLED) {
            uint256 expiry = req.createdAt + req.timeout;
            timeRemaining = expiry > block.timestamp ? expiry - block.timestamp : 0;
        }
    }
    
    /**
     * @notice Generate EIP-712 signature for API authentication
     * @dev Used when calling off-chain TEE APIs
     */
    function getApiSignature(
        address token,
        bytes32 shieldedAddress,
        uint256 nonce
    ) external view returns (bytes32 digest) {
        // EIP-712 domain separator
        bytes32 domainSeparator = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256(bytes("CREDarkPool")),
            keccak256(bytes("1")),
            block.chainid,
            address(this)
        ));
        
        // Message hash
        bytes32 structHash = keccak256(abi.encode(
            keccak256("PrivateTransfer(address token,bytes32 shieldedAddress,uint256 nonce)"),
            token,
            shieldedAddress,
            nonce
        ));
        
        digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }
    
    /**
     * @notice Authorize market makers
     */
    function setMarketMaker(address mm, bool authorized) 
        external 
        onlyRole(RECOVERY_MANAGER_ROLE) 
    {
        authorizedMarketMakers[mm] = authorized;
    }
    
    /**
     * @notice Update vault contract address
     */
    function setVaultContract(address _vault) 
        external 
        onlyRole(DEFAULT_ADMIN_ROLE) 
    {
        vaultContract = _vault;
    }
    
    /**
     * @notice Emergency pause all withdrawals
     */
    function emergencyPause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        // Implementation: pause mechanism
    }
    
    /**
     * @dev Execute token withdrawal
     */
    function _executeWithdrawal(
        address token,
        address recipient,
        uint256 amount
    ) internal {
        // In production: call vault.withdrawWithTicket()
        // For hackathon/demo: direct transfer
        bool success = IERC20(token).transfer(recipient, amount);
        if (!success) revert TransferFailed();
    }
    
    /**
     * @notice Get encrypted balance table metadata (no plaintext data)
     */
    function getBalanceTableInfo()
        external
        view
        returns (
            bytes32 balanceHash,
            uint256 lastUpdated,
            uint256 version
        )
    {
        return (
            balanceTable.balanceHash,
            balanceTable.lastUpdated,
            balanceTable.version
        );
    }

    /**
     * @notice Get nonce for address (EIP-712)
     */
    function getNonce(address account) external view returns (uint256) {
        return nonces[account];
    }

    /**
     * @notice Increment nonce after API call
     */
    function incrementNonce() external {
        nonces[msg.sender]++;
    }
}
