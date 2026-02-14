// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

contract ReserveAttestation {
    bool public isSolvent;
    address public owner;
    uint256 public lastUpdated;

    event ReserveStatusUpdated(bool isSolvent, uint256 timestamp);

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner can call");
        _;
    }

    constructor() {
        owner = msg.sender;
        isSolvent = true;
    }

    /// @notice Called by CRE workflow (or simulator) to update attestation
    function updateAttestation(bool _isSolvent) external onlyOwner {
        isSolvent = _isSolvent;
        lastUpdated = block.timestamp;
        emit ReserveStatusUpdated(_isSolvent, block.timestamp);
    }

    /// @notice CRE-compatible onReport callback
    function onReport(bytes calldata, bytes calldata report) external {
        bool solvent = abi.decode(report, (bool));
        isSolvent = solvent;
        lastUpdated = block.timestamp;
        emit ReserveStatusUpdated(solvent, block.timestamp);
    }
}
