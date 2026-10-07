// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC5267} from "@openzeppelin/contracts/interfaces/IERC5267.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/**
 * @title CollateralVault
 * @notice Optional collateral that raises a borrower's credit limit.
 *
 * @dev Polaris is a credit-score protocol first: a borrower with no collateral
 *      still gets a limit from their repayment history. Collateral is the lever
 *      for someone who has no history yet, or who wants more than their score
 *      allows.
 *
 *      The rule is deliberately simple and legible to a borrower: locked
 *      collateral adds its face value times a multiplier to the limit. At the
 *      default 150% a borrower locking 100 USDC gains 150 USDC of headroom,
 *      which is still undercollateralized overall and preserves the point of
 *      the product.
 *
 *      Withdrawal is blocked while a loan is outstanding. That is enforced by
 *      asking the LoanEngine for live debt rather than mirroring it here --
 *      two copies of the same number is how a vault ends up releasing
 *      collateral that is still securing a loan.
 *
 *      Taking collateral out by signature. A Polaris account holds no MON,
 *      so it can't call `withdraw` itself. `withdrawWithSig` carries the
 *      borrower's EIP-712 `Withdraw` instead: anyone may submit it (the
 *      relayer does), the dollars go to the borrower and nowhere else, and
 *      the rules are `withdraw`'s own (one internal path for both). Each
 *      borrower has one sequential nonce here, so a signature is spent once
 *      and a newer one retires every older one still unspent; a deadline may
 *      be at most MAX_SIGNATURE_WINDOW past the block it lands in.
 *        EIP-712 domain: name "CollateralVault", version "1", the chain id
 *        and this contract's address (`eip712Domain()`, ERC-5267).
 *        Withdraw(address borrower,uint256 amount,uint256 nonce,uint256 deadline)
 *      Signatures are checked as PolarisCheckout checks them: the
 *      borrower's own key first, then ERC-1271 for an account with code.
 *
 *      The domain is built here from immutables rather than inherited from
 *      OpenZeppelin's EIP712, whose two fallback strings are storage: this
 *      way every slot of the vault deployed before this change keeps its
 *      place, and the only new state (`nonces`) comes after it.
 */
interface ILoanEngineDebt {
    function activeDebtOf(address user) external view returns (uint256);
}

contract CollateralVault is Ownable, ReentrancyGuard, IERC5267 {
    using SafeERC20 for IERC20;

    /// What a borrower signs to take collateral out through a relayer.
    bytes32 public constant WITHDRAW_TYPEHASH =
        keccak256("Withdraw(address borrower,uint256 amount,uint256 nonce,uint256 deadline)");

    /// Longest a Withdraw may still have to run when it lands. Apps sign a few
    /// minutes; the hour is headroom for slow relaying and clock drift.
    uint64 public constant MAX_SIGNATURE_WINDOW = 1 hours;

    string private constant DOMAIN_NAME = "CollateralVault";
    string private constant DOMAIN_VERSION = "1";
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    /// Basis points of credit granted per unit of collateral. 15000 = 150%.
    uint256 public creditMultiplierBps = 15_000;
    uint256 public constant MAX_MULTIPLIER_BPS = 30_000;

    IERC20 public immutable collateralToken;
    ILoanEngineDebt public loanEngine;

    mapping(address => uint256) public lockedOf;
    /// Set when a liquidation seizes collateral, so it cannot be double-seized.
    mapping(address => uint256) public seizedOf;
    uint256 public totalLocked;

    /// Contracts allowed to seize on default. The LoanEngine, in practice.
    mapping(address => bool) public isSeizer;

    /// Each borrower's next `Withdraw` nonce. Declared after everything above
    /// so their storage slots are those of the vault before signed withdrawal.
    mapping(address => uint256) public nonces;

    bytes32 private immutable _cachedDomainSeparator;
    uint256 private immutable _cachedChainId;

    event CollateralLocked(address indexed user, uint256 amount, uint256 newTotal);
    event CollateralWithdrawn(address indexed user, uint256 amount, uint256 newTotal);
    event CollateralSeized(address indexed user, uint256 amount, address indexed to);
    event SeizerSet(address indexed seizer, bool allowed);
    event MultiplierChanged(uint256 bps);
    event LoanEngineSet(address indexed engine);
    event NonceInvalidated(address indexed borrower, uint256 nonce);

    error ZeroAmount();
    error InsufficientCollateral();
    error DebtOutstanding(uint256 debt);
    error NotSeizer();
    error InvalidMultiplier();
    error InvalidSignature();
    error SignatureExpired();
    error SignatureWindowTooLong();

    constructor(address initialOwner, IERC20 _collateralToken) Ownable(initialOwner) {
        collateralToken = _collateralToken;
        _cachedChainId = block.chainid;
        _cachedDomainSeparator = _buildDomainSeparator();
    }

    // -----------------------------------------------------------------
    // Admin
    // -----------------------------------------------------------------

    function setLoanEngine(ILoanEngineDebt engine) external onlyOwner {
        loanEngine = engine;
        emit LoanEngineSet(address(engine));
    }

    function setSeizer(address seizer, bool allowed) external onlyOwner {
        isSeizer[seizer] = allowed;
        emit SeizerSet(seizer, allowed);
    }

    function setCreditMultiplierBps(uint256 bps) external onlyOwner {
        if (bps == 0 || bps > MAX_MULTIPLIER_BPS) revert InvalidMultiplier();
        creditMultiplierBps = bps;
        emit MultiplierChanged(bps);
    }

    // -----------------------------------------------------------------
    // Borrower
    // -----------------------------------------------------------------

    /// @notice Lock collateral to raise your credit limit.
    function lock(uint256 amount) external nonReentrant {
        _lock(msg.sender, amount);
    }

    /**
     * @notice Lock collateral for `borrower` with their ERC-2612 permit, so a
     *         relayer can carry it and the borrower never needs gas.
     * @dev The permit is the borrower's consent: its spender is this vault and
     *      its value is exactly `amount`, and the vault only ever moves the
     *      tokens into the borrower's own position, never anywhere else. Anyone
     *      may submit it.
     *
     *      The permit is deliberately not wrapped in try/catch (PolarisCheckout
     *      wraps its permits because a separate intent signature carries the
     *      consent there). A fallback to the standing allowance would let
     *      anyone lock a borrower's tokens without asking whenever they had
     *      approved the vault for more than they locked. So a permit that
     *      someone else submitted first makes this revert and the borrower signs
     *      again: a nuisance, never a loss.
     */
    function lockWithPermit(address borrower, uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        nonReentrant
    {
        if (amount == 0) revert ZeroAmount();
        IERC20Permit(address(collateralToken)).permit(borrower, address(this), amount, deadline, v, r, s);
        _lock(borrower, amount);
    }

    function _lock(address borrower, uint256 amount) private {
        if (amount == 0) revert ZeroAmount();
        collateralToken.safeTransferFrom(borrower, address(this), amount);
        lockedOf[borrower] += amount;
        totalLocked += amount;
        emit CollateralLocked(borrower, amount, lockedOf[borrower]);
    }

    /**
     * @notice Withdraw collateral. Blocked while any debt is outstanding.
     * @dev Debt is read live from the LoanEngine. An all-or-nothing block
     *      rather than a partial release: releasing "the unused portion" needs
     *      a solvency calculation that is wrong the moment the borrower's score
     *      changes, and a borrower who wants their collateral back can repay.
     */
    function withdraw(uint256 amount) external nonReentrant {
        _withdraw(msg.sender, amount);
    }

    /**
     * @notice Withdraw `borrower`'s collateral with their EIP-712 `Withdraw`
     *         signature, so a relayer can carry it and the borrower never
     *         needs gas. The dollars go to `borrower`, never to the caller.
     * @dev Exactly `withdraw`'s rules (`_withdraw`): nothing while any debt is
     *      outstanding, never more than is locked, never zero. The signature
     *      names the amount, the borrower's current `nonces(borrower)` and a
     *      deadline at most MAX_SIGNATURE_WINDOW ahead, so it is spent once,
     *      can't be held back for later, and can't be replayed on another
     *      vault or chain (the domain names both). A failed withdrawal reverts
     *      whole, nonce included, so the borrower can sign again.
     */
    function withdrawWithSig(address borrower, uint256 amount, uint256 deadline, bytes calldata signature)
        external
        nonReentrant
    {
        if (block.timestamp > deadline) revert SignatureExpired();
        if (deadline > block.timestamp + MAX_SIGNATURE_WINDOW) revert SignatureWindowTooLong();
        uint256 nonce = nonces[borrower]++;
        _requireSigned(borrower, withdrawDigest(borrower, amount, nonce, deadline), signature);
        _withdraw(borrower, amount);
    }

    /**
     * @notice Retire the caller's next `Withdraw` without using it.
     * @dev For a borrower who holds gas. One who does not lets the deadline
     *      pass, at most MAX_SIGNATURE_WINDOW away, or signs a newer one,
     *      which spends the same nonce.
     */
    function invalidateNonce() external returns (uint256 nonce) {
        nonce = nonces[msg.sender]++;
        emit NonceInvalidated(msg.sender, nonce);
    }

    /// What `withdraw` and `withdrawWithSig` share once the borrower's consent
    /// is established: the checks, the books, and the payment to the borrower.
    function _withdraw(address borrower, uint256 amount) private {
        if (amount == 0) revert ZeroAmount();
        if (lockedOf[borrower] < amount) revert InsufficientCollateral();

        if (address(loanEngine) != address(0)) {
            uint256 debt = loanEngine.activeDebtOf(borrower);
            if (debt > 0) revert DebtOutstanding(debt);
        }

        lockedOf[borrower] -= amount;
        totalLocked -= amount;
        collateralToken.safeTransfer(borrower, amount);
        emit CollateralWithdrawn(borrower, amount, lockedOf[borrower]);
    }

    /// The borrower's own key first, then ERC-1271 for an account with code. In
    /// that order so an EOA that has since delegated its code (EIP-7702) still
    /// signs with its key, as PolarisCheckout and AUSD itself accept.
    function _requireSigned(address borrower, bytes32 digest, bytes calldata signature) private view {
        (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecoverCalldata(digest, signature);
        if (err == ECDSA.RecoverError.NoError && recovered == borrower) return;
        if (borrower.code.length != 0 && SignatureChecker.isValidERC1271SignatureNowCalldata(borrower, digest, signature)) {
            return;
        }
        revert InvalidSignature();
    }

    // -----------------------------------------------------------------
    // EIP-712
    // -----------------------------------------------------------------

    /// @notice The digest a borrower signs for `withdrawWithSig`.
    function withdrawDigest(address borrower, uint256 amount, uint256 nonce, uint256 deadline) public view returns (bytes32) {
        return MessageHashUtils.toTypedDataHash(
            DOMAIN_SEPARATOR(),
            keccak256(abi.encode(WITHDRAW_TYPEHASH, borrower, amount, nonce, deadline))
        );
    }

    /// @notice The EIP-712 domain separator for this chain.
    // solhint-disable-next-line func-name-mixedcase
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return block.chainid == _cachedChainId ? _cachedDomainSeparator : _buildDomainSeparator();
    }

    /// @inheritdoc IERC5267
    function eip712Domain()
        external
        view
        returns (
            bytes1 fields,
            string memory name,
            string memory version,
            uint256 chainId,
            address verifyingContract,
            bytes32 salt,
            uint256[] memory extensions
        )
    {
        return (hex"0f", DOMAIN_NAME, DOMAIN_VERSION, block.chainid, address(this), bytes32(0), new uint256[](0));
    }

    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(DOMAIN_NAME)), keccak256(bytes(DOMAIN_VERSION)), block.chainid, address(this))
        );
    }

    // -----------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------

    /// @notice Extra credit this borrower's collateral is worth, in base units.
    function creditBoostOf(address user) external view returns (uint256) {
        return (lockedOf[user] * creditMultiplierBps) / 10_000;
    }

    /// @notice What the borrower can withdraw now (by `withdraw` or
    ///         `withdrawWithSig`): everything locked, or nothing while any
    ///         debt is outstanding.
    function withdrawable(address user) external view returns (uint256) {
        if (address(loanEngine) != address(0) && loanEngine.activeDebtOf(user) > 0) {
            return 0;
        }
        return lockedOf[user];
    }

    // -----------------------------------------------------------------
    // Seizure
    // -----------------------------------------------------------------

    /**
     * @notice Seize collateral on default. Callable only by a registered seizer.
     * @dev Capped at what the borrower actually has, so a shortfall is a
     *      partial recovery rather than a revert that would block the
     *      liquidation entirely. Returns what was actually taken.
     */
    function seize(address user, uint256 amount, address to)
        external
        nonReentrant
        returns (uint256 taken)
    {
        if (!isSeizer[msg.sender]) revert NotSeizer();

        taken = amount > lockedOf[user] ? lockedOf[user] : amount;
        if (taken == 0) {
            return 0;
        }

        lockedOf[user] -= taken;
        totalLocked -= taken;
        seizedOf[user] += taken;
        collateralToken.safeTransfer(to, taken);
        emit CollateralSeized(user, taken, to);
    }
}
