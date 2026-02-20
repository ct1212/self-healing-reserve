// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";

/**
 * @title CREDarkPool
 * @notice Confidential dark pool for stablecoin collateral recovery
 * @dev Integrates with Chainlink Confidential Compute Private Transactions
 * 
 * Architecture:
 * 1. Recovery agent deposits collateral need (encrypted) into Vault
 * 2. Market makers fill via private transactions to shielded addresses
 * 3. Recovery agent withdraws using cryptographic tickets
 * 4. No on-chain visibility of amounts or participants until withdrawal
 */
contract CREDarkPool is AccessControl, ReentrancyGuard {
    
    bytes32 public constant TEE_VERIFIER_ROLE = keccak256("TEE_VERIFIER_ROLE");
    bytes32 public constant RECOVERY_MANAGER_ROLE = keccak256("RECOVERY_MANAGER_ROLE");
    bytes32 public constant VAULT_OPERATOR_ROLE = keccak256("VAULT_OPERATOR_ROLE");
    
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
     * @dev Amount is NEVER stored on-chain - only in TEE enclave
     */
    struct CollateralRequest {
        address requester;              // Recovery agent
        bytes32 encryptedAmount;        // Encrypted with TEE public key
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
        bytes32 encryptedAmount;        // Fill amount (encrypted)
        bytes32 teeAttestation;         // Proof of fill
        bool withdrawn;
    }
    
    // State
    mapping(bytes32 => CollateralRequest) public requests;
    mapping(bytes32 => ShieldedFill) public fills;
    mapping(address => bool) public authorizedMarketMakers;
    mapping(bytes32 => bool) public usedTickets;              // Prevent replay
    
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
     * @notice Request confidential collateral fill
     * @dev Creates shielded address for private matching
     * @param encryptedAmount Amount encrypted with TEE public key
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
     * @notice Withdraw filled collateral using TEE ticket
     * @dev This is the ONLY point where amount is revealed on-chain
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
