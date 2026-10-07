// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";

/**
 * @title MerchantRegistry
 * @notice On-chain merchant directory. The registry entry is the merchant's
 *         identity for settlement and the source of truth the checkout SDK
 *         reads before letting a buyer split a purchase.
 *
 * @dev Merchants register themselves, or the platform registers them with the
 *      merchant's signature, and either way they are activated by the
 *      protocol. Per-merchant caps exist because BNPL exposure is a function
 *      of who is selling as much as who is buying -- a merchant with a high
 *      refund or dispute rate should be able to originate less, and that lever
 *      has to live on chain where the LoanEngine can see it.
 *
 *      Anything that decides where a merchant is paid carries the merchant's
 *      own signature, whoever sends the transaction. The platform relays; it
 *      never chooses.
 */
contract MerchantRegistry is Ownable, EIP712, Nonces {
    struct Merchant {
        address payoutAddress;
        string name;
        string metadataURI;
        uint128 maxOrderValue;
        uint128 totalSettled;
        uint64 registeredAt;
        bool active;
    }

    /// Conservative default until the protocol raises it; a brand new merchant
    /// should not be able to originate unlimited credit.
    uint128 public constant DEFAULT_MAX_ORDER_VALUE = 500e6;

    /// What a merchant signs to be registered by the platform.
    bytes32 public constant REGISTRATION_TYPEHASH = keccak256(
        "Registration(address merchant,string name,address payoutAddress,string metadataURI,uint256 nonce,uint256 deadline)"
    );
    /// What a merchant signs to move their payouts without holding gas.
    bytes32 public constant PAYOUT_UPDATE_TYPEHASH = keccak256(
        "PayoutUpdate(address merchant,address payoutAddress,uint256 nonce,uint256 deadline)"
    );

    mapping(address => Merchant) private _merchants;
    address[] private _merchantList;

    /// Platform accounts allowed to relay a merchant's signed registration.
    /// They can register and nothing else: activation and caps stay with the
    /// owner, and what is registered is what the merchant signed.
    mapping(address => bool) public isOperator;

    event MerchantRegistered(address indexed merchant, string name, address payoutAddress);
    /// Alongside MerchantRegistered when the platform relayed it, so every
    /// registration can be attributed to the account that sent it.
    event MerchantRegisteredBy(address indexed merchant, address indexed operator);
    event MerchantActivated(address indexed merchant, bool active);
    event MerchantUpdated(address indexed merchant, address payoutAddress, uint128 maxOrderValue);
    event SettlementRecorded(address indexed merchant, uint256 amount);
    event OperatorSet(address indexed operator, bool allowed);
    /// A merchant cancelled their next signature without using it.
    event NonceInvalidated(address indexed merchant, uint256 nonce);

    error AlreadyRegistered();
    error NotRegistered();
    error NotMerchantOwner();
    error NotOperator();
    error ZeroAddress();
    error SignatureExpired();
    error InvalidSignature();

    constructor(address initialOwner) Ownable(initialOwner) EIP712("MerchantRegistry", "1") {}

    function setOperator(address operator, bool allowed) external onlyOwner {
        isOperator[operator] = allowed;
        emit OperatorSet(operator, allowed);
    }

    /// @notice Register the caller as a merchant. Starts inactive, at the
    ///         default cap.
    function register(
        string calldata name,
        address payoutAddress,
        string calldata metadataURI
    ) external {
        _register(msg.sender, name, payoutAddress, metadataURI);
    }

    /**
     * @notice Register `merchant` on their behalf, with their signature. Owner
     *         or operator only.
     * @dev Merchants sign up with Privy embedded wallets that never hold MON,
     *      so they cannot send `register` themselves; the platform sends it for
     *      them. The entry is identical to a self-registration -- inactive, at
     *      the default cap, keyed to the merchant's own address.
     *
     *      The merchant signs the name, payout address and metadata. Without
     *      that, an operator chose all three for a wallet that never agreed:
     *      it could point a merchant's automatic payouts at itself, or squat an
     *      address so the real owner's `register` failed for good, and the
     *      only fix was a transaction from the one key that holds no gas. Now
     *      an operator can deliver a registration but not write one, and
     *      revoking it has nothing to undo.
     *
     *      The nonce is shared with `updatePayoutAddressWithSig`, so a
     *      registration signed and then superseded cannot be replayed.
     */
    function registerFor(
        address merchant,
        string calldata name,
        address payoutAddress,
        string calldata metadataURI,
        uint256 deadline,
        bytes calldata signature
    ) external {
        if (msg.sender != owner() && !isOperator[msg.sender]) revert NotOperator();
        // A zero key is an entry nobody can ever sign for, and a merchant list
        // the SDK walks should not contain one.
        if (merchant == address(0)) revert ZeroAddress();
        if (block.timestamp > deadline) revert SignatureExpired();

        bytes32 structHash = keccak256(
            abi.encode(
                REGISTRATION_TYPEHASH,
                merchant,
                keccak256(bytes(name)),
                payoutAddress,
                keccak256(bytes(metadataURI)),
                _useNonce(merchant),
                deadline
            )
        );
        _requireSignedBy(merchant, structHash, signature);

        _register(merchant, name, payoutAddress, metadataURI);
        emit MerchantRegisteredBy(merchant, msg.sender);
    }

    /**
     * @notice Move a merchant's payouts with their signature. Anyone may relay.
     * @dev The gasless twin of `updatePayoutAddress`. Payout routing is the one
     *      field money follows, so it is the one a merchant who holds no gas
     *      must still be able to change, and the signature is the only thing
     *      that may change it.
     */
    function updatePayoutAddressWithSig(
        address merchant,
        address payoutAddress,
        uint256 deadline,
        bytes calldata signature
    ) external {
        Merchant storage m = _merchants[merchant];
        if (m.registeredAt == 0) revert NotRegistered();
        if (block.timestamp > deadline) revert SignatureExpired();

        _requireSignedBy(
            merchant,
            keccak256(
                abi.encode(PAYOUT_UPDATE_TYPEHASH, merchant, payoutAddress, _useNonce(merchant), deadline)
            ),
            signature
        );

        m.payoutAddress = payoutAddress;
        emit MerchantUpdated(merchant, payoutAddress, m.maxOrderValue);
    }

    function _requireSignedBy(address merchant, bytes32 structHash, bytes calldata signature)
        private
        view
    {
        (address signer, ECDSA.RecoverError err, ) = ECDSA.tryRecover(
            _hashTypedDataV4(structHash),
            signature
        );
        if (err != ECDSA.RecoverError.NoError || signer != merchant) revert InvalidSignature();
    }

    function _register(
        address merchant,
        string calldata name,
        address payoutAddress,
        string calldata metadataURI
    ) private {
        if (_merchants[merchant].registeredAt != 0) revert AlreadyRegistered();
        _merchants[merchant] = Merchant({
            payoutAddress: payoutAddress,
            name: name,
            metadataURI: metadataURI,
            maxOrderValue: DEFAULT_MAX_ORDER_VALUE,
            totalSettled: 0,
            registeredAt: uint64(block.timestamp),
            active: false
        });
        _merchantList.push(merchant);
        emit MerchantRegistered(merchant, name, payoutAddress);
    }

    function setActive(address merchant, bool active) external onlyOwner {
        if (_merchants[merchant].registeredAt == 0) revert NotRegistered();
        _merchants[merchant].active = active;
        emit MerchantActivated(merchant, active);
    }

    function setMaxOrderValue(address merchant, uint128 maxOrderValue) external onlyOwner {
        if (_merchants[merchant].registeredAt == 0) revert NotRegistered();
        _merchants[merchant].maxOrderValue = maxOrderValue;
        emit MerchantUpdated(merchant, _merchants[merchant].payoutAddress, maxOrderValue);
    }

    /**
     * @notice Move the caller's payouts.
     * @dev Consumes the merchant's nonce, the same one their signed updates
     *      use. A merchant who signed a PayoutUpdate and then changed their
     *      mind here used to leave that signature live: whoever held it could
     *      relay it before its deadline and move payouts back to an address
     *      the merchant had just abandoned, perhaps because it was
     *      compromised. The latest decision now wins, whichever path made it.
     */
    function updatePayoutAddress(address payoutAddress) external {
        Merchant storage m = _merchants[msg.sender];
        if (m.registeredAt == 0) revert NotRegistered();
        _useNonce(msg.sender);
        m.payoutAddress = payoutAddress;
        emit MerchantUpdated(msg.sender, payoutAddress, m.maxOrderValue);
    }

    /**
     * @notice Cancel the caller's next signature without using it.
     * @dev For a merchant who holds gas. A merchant who does not cancels the
     *      same way through a relayer: a fresh PayoutUpdate to the address
     *      payouts already go to consumes the same nonce and changes nothing.
     */
    function invalidateNonce() external returns (uint256 nonce) {
        nonce = _useNonce(msg.sender);
        emit NonceInvalidated(msg.sender, nonce);
    }

    function recordSettlement(address merchant, uint256 amount) external onlyOwner {
        _merchants[merchant].totalSettled += uint128(amount);
        emit SettlementRecorded(merchant, amount);
    }

    function merchantOf(address merchant) external view returns (Merchant memory) {
        return _merchants[merchant];
    }

    /// @notice Whether this merchant may originate a plan of this size.
    function canOriginate(address merchant, uint256 orderValue) external view returns (bool) {
        Merchant storage m = _merchants[merchant];
        return m.active && orderValue <= m.maxOrderValue;
    }

    function merchantCount() external view returns (uint256) {
        return _merchantList.length;
    }

    function merchantAt(uint256 index) external view returns (address) {
        return _merchantList[index];
    }
}
