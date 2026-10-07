/**
 * Read-only live check of Monad testnet for the Polaris money path.
 *
 *   cd packages/contracts && node scripts/check-monad.js
 *   MONAD_RPC=https://... node scripts/check-monad.js     # optional RPC override
 *   ETHERSCAN_API_KEY=... node scripts/check-monad.js     # optional: also pull the faucet ABI from
 *                                                          # Monadscan through the Etherscan V2 API
 *
 * Needs no funded key and sends no transaction. Everything is eth_call,
 * eth_getCode, eth_getStorageAt and eth_estimateGas.
 *
 * The signature checks sign typed data with a throwaway random key generated in
 * memory, then eth_call the token with value 0. A zero-value call from an empty
 * account exercises the whole signature path (domain, typehash, v/r/s packing,
 * payee check) without moving money, so a success proves the EIP-712 domain the
 * app must sign with. A deliberately wrong domain is signed as a negative control.
 *
 * Findings are written up in docs/research/ausd.md.
 */

"use strict";

const { ethers } = require("ethers");

const RPC = process.env.MONAD_RPC || "https://testnet-rpc.monad.xyz";
const EXPECTED_CHAIN_ID = 10143n;

const ADDR = {
  AUSD: "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC",
  AUSD_FAUCET: "0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C",
  USDC: "0x534b2f3A21130d7a60830c2Df862319e593943A3",
  MULTICALL3: "0xcA11bde05977b3631167028862bE2a173976CA11",
  PERMIT2: "0x000000000022d473030f116ddee9f6b43ac78ba3",
  CRE_MOCK_FORWARDER: "0xB9F79d863261869B234c481D1f9A7af84AeAd192",
  CRE_KEYSTONE_FORWARDER: "0xF8344CFd5c43616a4366C34E3EEE75af79a74482",
};

// EIP-1967 slots (https://eips.ethereum.org/EIPS/eip-1967)
const SLOT = {
  eip1967Implementation: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  eip1967Admin: "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
  eip1967Beacon: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
  // Circle FiatTokenProxy (ZeppelinOS AdminUpgradeabilityProxy):
  // https://github.com/circlefin/stablecoin-evm/blob/master/contracts/upgradeability/UpgradeabilityProxy.sol
  zosImplementation: "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3",
  zosAdmin: "0x10d6a54a4754c8869d6886b5f5d7fbfa5b4522237ea5c60d11bc4e7a1ff9390b",
};

// Agora packs pause/upgrade flags into the high bits of the EIP-1967
// implementation slot. Bit positions from StorageLib.sol:
// https://github.com/agora-finance/agora-dollar-evm/blob/main/src/contracts/proxy/StorageLib.sol
const AGORA_FLAG_BITS = {
  isMsgSenderFrozenCheckEnabled: 255 - 95,
  isMintPaused: 255 - 94,
  isBurnFromPaused: 255 - 93,
  isFreezingPaused: 255 - 92,
  isTransferPaused: 255 - 91,
  isSignatureVerificationPaused: 255 - 90,
  isTransferUpgraded: 255 - 89,
  isTransferFromUpgraded: 255 - 88,
  isTransferWithAuthorizationUpgraded: 255 - 87,
  isReceiveWithAuthorizationUpgraded: 255 - 86,
  isBridgingPaused: 255 - 85,
};

const SIGS_3009_2612 = [
  "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)",
  "permit(address,address,uint256,uint256,bytes)",
  "nonces(address)",
  "DOMAIN_SEPARATOR()",
  "eip712Domain()",
  "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)",
  "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)",
  "receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)",
  "receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)",
  "cancelAuthorization(address,bytes32,uint8,bytes32,bytes32)",
  "cancelAuthorization(address,bytes32,bytes)",
  "authorizationState(address,bytes32)",
];

const TYPEHASH = {
  "EIP712Domain(name,version,chainId,verifyingContract)": ethers.id(
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
  ),
  Permit: ethers.id("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
  TransferWithAuthorization: ethers.id(
    "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)",
  ),
  ReceiveWithAuthorization: ethers.id(
    "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)",
  ),
  CancelAuthorization: ethers.id("CancelAuthorization(address authorizer,bytes32 nonce)"),
};

// Custom errors from agora-dollar-evm and the AgoraFaucet, so reverts print by name.
const ERRORS = new ethers.Interface([
  "error InvalidPayee(address caller, address payee)",
  "error InvalidAuthorization()",
  "error ExpiredAuthorization()",
  "error InvalidSignature()",
  "error UsedOrCanceledAuthorization()",
  "error Erc2612ExpiredSignature(uint256 deadline)",
  "error Erc2612InvalidSignature()",
  "error AccountIsFrozen(address frozenAccount)",
  "error TransferPaused()",
  "error SignatureVerificationPaused()",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error InsufficientFunds()",
  "error MaxAllowedExceeded()",
  "error MaxFrequencyExceeded()",
]);

const provider = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true, batchMaxCount: 1 });

// ---------------------------------------------------------------- helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** provider.send with a small retry for the public RPC's rate limit. */
async function rpc(method, params) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await provider.send(method, params);
    } catch (e) {
      const msg = String(e && (e.shortMessage || e.message));
      const revert = e && (e.code === "CALL_EXCEPTION" || /revert/i.test(msg));
      if (revert || attempt >= 4) throw e;
      if (!/429|rate|limit|timeout|ECONNRESET|socket/i.test(msg) && attempt >= 1) throw e;
      await sleep(400 * (attempt + 1));
    }
  }
}

function revertData(e) {
  let x = e;
  for (let i = 0; i < 6 && x; i++) {
    if (typeof x.data === "string" && x.data.startsWith("0x")) return x.data;
    if (x.info && x.info.error && typeof x.info.error.data === "string") return x.info.error.data;
    if (x.error && typeof x.error.data === "string") return x.error.data;
    x = x.error || x.info;
  }
  return null;
}

function describeRevert(e) {
  const data = revertData(e);
  if (data && data !== "0x") {
    try {
      const parsed = ERRORS.parseError(data);
      if (parsed) return `revert ${parsed.name}(${parsed.args.map(String).join(", ")})`;
    } catch (_) {}
    if (data.startsWith("0x08c379a0")) {
      try {
        return `revert "${ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + data.slice(10))[0]}"`;
      } catch (_) {}
    }
    return `revert data ${data.slice(0, 74)}${data.length > 74 ? "..." : ""}`;
  }
  return `error: ${String((e && (e.shortMessage || e.message)) || e).split("\n")[0].slice(0, 160)}`;
}

/** eth_call a human-readable function; returns { ok, value } or { ok: false, why }. */
async function read(address, fragment, args = [], from, blockTag = "latest") {
  const iface = new ethers.Interface([`function ${fragment}`]);
  const fn = iface.fragments[0];
  const data = iface.encodeFunctionData(fn, args);
  try {
    const tx = { to: address, data };
    if (from) tx.from = from;
    const raw = await rpc("eth_call", [tx, blockTag]);
    if (raw === "0x") return { ok: false, why: "empty return (no such function / fallback)" };
    const decoded = iface.decodeFunctionResult(fn, raw);
    return { ok: true, value: decoded.length === 1 ? decoded[0] : decoded, raw };
  } catch (e) {
    return { ok: false, why: describeRevert(e) };
  }
}

async function simulate(address, fragment, args, from) {
  const iface = new ethers.Interface([`function ${fragment}`]);
  const data = iface.encodeFunctionData(iface.fragments[0], args);
  try {
    await rpc("eth_call", [{ from, to: address, data }, "latest"]);
    let gas = null;
    try {
      gas = BigInt(await rpc("eth_estimateGas", [{ from, to: address, data }]));
    } catch (_) {}
    return { ok: true, gas };
  } catch (e) {
    return { ok: false, why: describeRevert(e) };
  }
}

/**
 * Runtime code for a 56-byte forwarder: CALLs `target` with its own calldata and
 * bubbles the result. Put at an address with an eth_call state override, it lets
 * a contract (not an EOA) be msg.sender, which is how PolarisPayments will call.
 */
function forwarderCode(target) {
  return (
    "0x36600060003760006000366000600073" + target.slice(2).toLowerCase() + "5af13d600060003e6033573d6000fd5b3d6000f3"
  );
}

async function simulateFromContract(token, fragment, args, contractAddress) {
  const iface = new ethers.Interface([`function ${fragment}`]);
  const data = iface.encodeFunctionData(iface.fragments[0], args);
  const caller = ethers.Wallet.createRandom().address;
  try {
    await rpc("eth_call", [
      { from: caller, to: contractAddress, data },
      "latest",
      { [contractAddress]: { code: forwarderCode(token) } },
    ]);
    return { ok: true };
  } catch (e) {
    return { ok: false, why: describeRevert(e) };
  }
}

function fmt(v) {
  if (v === undefined || v === null) return String(v);
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v) || (v && typeof v.toArray === "function")) {
    const arr = typeof v.toArray === "function" ? v.toArray() : v;
    return "[" + arr.map(fmt).join(", ") + "]";
  }
  return String(v);
}

function show(label, r) {
  console.log(`  ${label.padEnd(42)} ${r.ok ? fmt(r.value) : "n/a (" + r.why + ")"}`);
}

/** Every PUSH1..PUSH4 and PUSH32 immediate, walking opcodes so push data is never read as code. */
function scanPushes(hex) {
  const code = ethers.getBytes(hex);
  const push4 = new Set();
  const push32 = new Set();
  for (let i = 0; i < code.length; i++) {
    const op = code[i];
    if (op >= 0x60 && op <= 0x7f) {
      const n = op - 0x5f;
      const imm = code.slice(i + 1, i + 1 + n);
      if (n <= 4) {
        // A selector with leading zero bytes is emitted as a shorter PUSH; left-pad to 4 bytes.
        push4.add(ethers.zeroPadValue(ethers.hexlify(imm), 4).toLowerCase());
      } else if (n === 32 && imm.length === 32) {
        push32.add(ethers.hexlify(imm).toLowerCase());
      }
      i += n;
    }
  }
  return { push4, push32 };
}

const selectorOf = (sig) => ethers.id(sig).slice(0, 10);
const slotAddress = (word) => ethers.getAddress("0x" + word.slice(-40));
const isZeroWord = (word) => BigInt(word) === 0n;

async function codeOf(address) {
  return rpc("eth_getCode", [address, "latest"]);
}

async function proxyInfo(address) {
  const out = {};
  for (const [k, slot] of Object.entries(SLOT)) out[k] = await rpc("eth_getStorageAt", [address, slot, "latest"]);
  return out;
}

function printSelectorTable(targets, sigs) {
  const header = "  " + "function".padEnd(104) + targets.map((t) => t.label.padEnd(10)).join("");
  console.log(header);
  for (const sig of sigs) {
    const sel = selectorOf(sig);
    const cols = targets.map((t) => (t.scan.push4.has(sel) ? "yes" : "-").padEnd(10)).join("");
    console.log(`  ${(sel + " " + sig).padEnd(104)}${cols}`);
  }
}

function printTypehashTable(targets) {
  for (const [name, h] of Object.entries(TYPEHASH)) {
    const cols = targets.map((t) => (t.scan.push32.has(h.toLowerCase()) ? "yes" : "-").padEnd(10)).join("");
    console.log(`  ${(name + " " + h.slice(0, 18) + "...").padEnd(104)}${cols}`);
  }
}

// ---------------------------------------------------------------- sections

async function network() {
  console.log("== Network");
  const chainIdHex = await rpc("eth_chainId", []);
  const chainId = BigInt(chainIdHex);
  const block = await rpc("eth_getBlockByNumber", ["latest", false]);
  console.log(`  rpc                                        ${RPC}`);
  console.log(`  eth_chainId                                ${chainIdHex} (${chainId})${chainId === EXPECTED_CHAIN_ID ? "" : "  <-- NOT 10143"}`);
  console.log(`  latest block                               ${BigInt(block.number)}`);
  console.log(
    `  latest block timestamp                     ${BigInt(block.timestamp)} (${new Date(Number(BigInt(block.timestamp)) * 1000).toISOString()})`,
  );
  console.log(`  block gasLimit                             ${BigInt(block.gasLimit)}`);
  if (block.baseFeePerGas) console.log(`  block baseFeePerGas                        ${BigInt(block.baseFeePerGas)} wei (${ethers.formatUnits(BigInt(block.baseFeePerGas), "gwei")} gwei)`);
  // Average block time over the last 100,000 blocks (timestamps have 1 s resolution, so use a wide window).
  const SPAN = 100000n;
  const old = await rpc("eth_getBlockByNumber", ["0x" + (BigInt(block.number) - SPAN).toString(16), false]);
  const avgBlockMs = (Number(BigInt(block.timestamp) - BigInt(old.timestamp)) * 1000) / Number(SPAN);
  console.log(`  avg block time, last ${SPAN} blocks         ${avgBlockMs.toFixed(1)} ms`);
  return { chainId, block, avgBlockMs };
}

async function tokenChecks(label, address, chainId, opts) {
  console.log(`\n== ${label} ${address}`);
  const code = await codeOf(address);
  console.log(`  code bytes                                 ${(code.length - 2) / 2}`);
  if (code === "0x") return null;

  const slots = await proxyInfo(address);
  for (const [k, v] of Object.entries(slots)) {
    console.log(`  slot ${k.padEnd(37)} ${isZeroWord(v) ? "0 (empty)" : v}`);
  }
  let implAddress = null;
  if (!isZeroWord(slots.eip1967Implementation)) implAddress = slotAddress(slots.eip1967Implementation);
  else if (!isZeroWord(slots.zosImplementation)) implAddress = slotAddress(slots.zosImplementation);

  if (!isZeroWord(slots.eip1967Implementation)) {
    const word = BigInt(slots.eip1967Implementation);
    const high = word >> 160n;
    console.log(`  EIP-1967 impl slot high 96 bits            ${high === 0n ? "0 (no packed flags set)" : "0x" + high.toString(16)}`);
    if (opts.agoraFlags) {
      for (const [name, bit] of Object.entries(AGORA_FLAG_BITS)) {
        console.log(`    flag ${name.padEnd(38)} ${((word >> BigInt(bit)) & 1n) === 1n}`);
      }
    }
  }

  let implCode = "0x";
  if (implAddress) {
    implCode = await codeOf(implAddress);
    console.log(`  implementation                             ${implAddress} (${(implCode.length - 2) / 2} bytes, keccak ${ethers.keccak256(implCode).slice(0, 18)}...)`);
  }

  const r = {};
  for (const f of [
    "name() view returns (string)",
    "symbol() view returns (string)",
    "decimals() view returns (uint8)",
    "totalSupply() view returns (uint256)",
    "DOMAIN_SEPARATOR() view returns (bytes32)",
    "PERMIT_TYPEHASH() view returns (bytes32)",
    "TRANSFER_WITH_AUTHORIZATION_TYPEHASH() view returns (bytes32)",
    "RECEIVE_WITH_AUTHORIZATION_TYPEHASH() view returns (bytes32)",
    "CANCEL_AUTHORIZATION_TYPEHASH() view returns (bytes32)",
    ...(opts.extraReads || []),
  ]) {
    const key = f.split("(")[0];
    r[key] = await read(address, f);
    show(key + "()", r[key]);
  }

  // version(): string on Circle FiatToken; a (major,minor,patch) struct on newer AgoraDollar.
  const vString = await read(address, "version() view returns (string)");
  const vStruct = vString.ok ? { ok: false } : await read(address, "version() view returns (uint256,uint256,uint256)");
  if (vString.ok) show("version() as string", vString);
  else if (vStruct.ok) show("version() as (major,minor,patch)", vStruct);
  else show("version()", vString);

  const dom = await read(
    address,
    "eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)",
  );
  if (dom.ok) {
    const [fields, name, version, cid, vc, salt, ext] = dom.value;
    console.log(`  eip712Domain() (ERC-5267)                  fields=${fields} name="${name}" version="${version}" chainId=${cid} verifyingContract=${vc} salt=${salt} extensions=${fmt(ext)}`);
  } else show("eip712Domain() (ERC-5267)", dom);

  // Recompute the domain separator from the candidates and match it against DOMAIN_SEPARATOR().
  const candidates = [];
  if (dom.ok) candidates.push({ source: "eip712Domain()", name: dom.value[1], version: dom.value[2] });
  if (r.name.ok && vString.ok) candidates.push({ source: "name() + version()", name: r.name.value, version: vString.value });
  for (const c of opts.domainGuesses || []) candidates.push({ source: "guess", ...c });
  let domain = null;
  console.log("  EIP-712 domain recomputation (chainId from eth_chainId, verifyingContract = token):");
  for (const c of candidates) {
    const d = { name: c.name, version: c.version, chainId, verifyingContract: address };
    const sep = ethers.TypedDataEncoder.hashDomain(d);
    const match = r.DOMAIN_SEPARATOR.ok && sep.toLowerCase() === r.DOMAIN_SEPARATOR.value.toLowerCase();
    console.log(`    ${c.source.padEnd(20)} name="${c.name}" version="${c.version}" -> ${sep} ${match ? "MATCHES DOMAIN_SEPARATOR()" : "no match"}`);
    if (match && !domain) domain = d;
  }

  // Bytecode scan. For proxies that implement functions in the proxy itself (AgoraDollarErc1967Proxy)
  // the proxy column matters as much as the implementation column.
  const targets = [{ label: "proxy", scan: scanPushes(code) }];
  if (implCode !== "0x") targets.push({ label: "impl", scan: scanPushes(implCode) });
  console.log("  Selectors present as PUSH immediates (opcode walk):");
  printSelectorTable(targets, SIGS_3009_2612);
  console.log("  Typehash constants present as PUSH32 immediates:");
  printTypehashTable(targets);

  return { address, code, implAddress, implCode, reads: r, domain, dom, vString };
}

/**
 * Sign with a throwaway key and eth_call the token with value 0. Proves the domain,
 * the struct layout and the v/r/s entry points without funds.
 */
async function signatureChecks(label, token, info, wrongDomain) {
  console.log(`\n== ${label}: signature checks by eth_call (throwaway key, value 0, nothing sent)`);
  if (!info || !info.domain) {
    console.log("  skipped: no EIP-712 domain matched DOMAIN_SEPARATOR()");
    return {};
  }
  const payer = ethers.Wallet.createRandom();
  const payee = ethers.Wallet.createRandom(); // stands in for our contract (msg.sender == to)
  const stranger = ethers.Wallet.createRandom();
  const now = BigInt((await rpc("eth_getBlockByNumber", ["latest", false])).timestamp);
  const out = {};

  const auth = (to) => ({
    from: payer.address,
    to,
    value: 0n,
    validAfter: 0n,
    validBefore: now + 3600n,
    nonce: ethers.hexlify(ethers.randomBytes(32)),
  });
  const T = (primary) => ({
    [primary]: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  });
  const RWA_VRS =
    "receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)";
  const RWA_BYTES = "receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)";
  const TWA_VRS =
    "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)";
  const argsOf = (m, sig) => [m.from, m.to, m.value, m.validAfter, m.validBefore, m.nonce, sig.v, sig.r, sig.s];

  // 1. receiveWithAuthorization(v,r,s), called by the payee
  {
    const m = auth(payee.address);
    const sig = ethers.Signature.from(await payer.signTypedData(info.domain, T("ReceiveWithAuthorization"), m));
    out.rwaVrs = await simulate(token, RWA_VRS, argsOf(m, sig), payee.address);
    console.log(`  receiveWithAuthorization (v,r,s), msg.sender == to        ${out.rwaVrs.ok ? "OK" + (out.rwaVrs.gas ? `, eth_estimateGas ${out.rwaVrs.gas}` : "") : out.rwaVrs.why}`);

    // 2. same authorization, bytes variant (r || s || v, 65 bytes)
    out.rwaBytes = await simulate(
      token,
      RWA_BYTES,
      [m.from, m.to, m.value, m.validAfter, m.validBefore, m.nonce, sig.serialized],
      payee.address,
    );
    console.log(`  receiveWithAuthorization (bytes r||s||v), same auth       ${out.rwaBytes.ok ? "OK" : out.rwaBytes.why}`);

    // 3. negative control: a stranger submits the payee's authorization
    out.rwaStranger = await simulate(token, RWA_VRS, argsOf(m, sig), stranger.address);
    console.log(`  receiveWithAuthorization submitted by a stranger          ${out.rwaStranger.ok ? "OK  <-- front-run protection missing!" : out.rwaStranger.why}`);
  }

  // 3b. a CONTRACT as msg.sender and payee (state-override forwarder), as PolarisPayments will call it
  {
    const contract = ethers.getAddress(ethers.hexlify(ethers.randomBytes(20)));
    const m = auth(contract);
    const sig = ethers.Signature.from(await payer.signTypedData(info.domain, T("ReceiveWithAuthorization"), m));
    out.rwaFromContract = await simulateFromContract(token, RWA_VRS, argsOf(m, sig), contract);
    console.log(`  receiveWithAuthorization (v,r,s) called by a contract     ${out.rwaFromContract.ok ? "OK" : out.rwaFromContract.why}`);
  }

  // 4. negative control: wrong EIP-712 domain
  {
    const m = auth(payee.address);
    const bad = { ...info.domain, ...wrongDomain };
    const sig = ethers.Signature.from(await payer.signTypedData(bad, T("ReceiveWithAuthorization"), m));
    out.rwaWrongDomain = await simulate(token, RWA_VRS, argsOf(m, sig), payee.address);
    console.log(`  receiveWithAuthorization signed with ${JSON.stringify(wrongDomain)} ${out.rwaWrongDomain.ok ? "OK  <-- domain not enforced?!" : out.rwaWrongDomain.why}`);
  }

  // 5. negative control: TransferWithAuthorization typehash submitted to receiveWithAuthorization
  {
    const m = auth(payee.address);
    const sig = ethers.Signature.from(await payer.signTypedData(info.domain, T("TransferWithAuthorization"), m));
    out.rwaWrongType = await simulate(token, RWA_VRS, argsOf(m, sig), payee.address);
    console.log(`  receiveWithAuthorization with a Transfer-typed signature  ${out.rwaWrongType.ok ? "OK  <-- typehash not enforced?!" : out.rwaWrongType.why}`);

    // 6. transferWithAuthorization(v,r,s), relayed by anyone
    out.twaVrs = await simulate(token, TWA_VRS, argsOf(m, sig), stranger.address);
    console.log(`  transferWithAuthorization (v,r,s), relayed by anyone      ${out.twaVrs.ok ? "OK" + (out.twaVrs.gas ? `, eth_estimateGas ${out.twaVrs.gas}` : "") : out.twaVrs.why}`);
  }

  // 7. permit(v,r,s)
  {
    const nonce = await read(token, "nonces(address) view returns (uint256)", [payer.address]);
    const p = { owner: payer.address, spender: payee.address, value: 1n, nonce: nonce.ok ? nonce.value : 0n, deadline: now + 3600n };
    const types = {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    };
    const sig = ethers.Signature.from(await payer.signTypedData(info.domain, types, p));
    out.permitVrs = await simulate(
      token,
      "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)",
      [p.owner, p.spender, p.value, p.deadline, sig.v, sig.r, sig.s],
      stranger.address,
    );
    console.log(`  permit (v,r,s), relayed by anyone                         ${out.permitVrs.ok ? "OK" + (out.permitVrs.gas ? `, eth_estimateGas ${out.permitVrs.gas}` : "") : out.permitVrs.why}`);
  }

  const st = await read(token, "authorizationState(address,bytes32) view returns (bool)", [payer.address, ethers.ZeroHash]);
  show("authorizationState(random, 0x0)", st);
  return out;
}

/**
 * Realistic gas for a funded AUSD receiveWithAuthorization: give a throwaway payer 1,000 AUSD
 * with an eth_estimateGas state override, then move 200 AUSD to a fresh payee.
 * Balance layout from StorageLib.sol: accountData mapping at ERC20_CORE_STORAGE_SLOT,
 * struct { bool isFrozen; uint248 balance; } packed into one word (balance << 8 | isFrozen).
 */
async function ausdFundedEstimate(domain) {
  const ERC20_CORE_STORAGE_SLOT = "0x455730fed596673e69db1907be2e521374ba893f1a04cc5f5dd931616cd6b700";
  const payer = ethers.Wallet.createRandom();
  const payee = ethers.Wallet.createRandom().address;
  const slot = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["address", "bytes32"], [payer.address, ERC20_CORE_STORAGE_SLOT]),
  );
  const word = ethers.zeroPadValue(ethers.toBeHex((1000n * 10n ** 6n) << 8n), 32);
  const override = { [ADDR.AUSD]: { stateDiff: { [slot]: word } } };
  const now = BigInt((await rpc("eth_getBlockByNumber", ["latest", false])).timestamp);
  const m = { from: payer.address, to: payee, value: 200n * 10n ** 6n, validAfter: 0n, validBefore: now + 3600n, nonce: ethers.hexlify(ethers.randomBytes(32)) };
  const types = {
    ReceiveWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  };
  const sig = ethers.Signature.from(await payer.signTypedData(domain, types, m));
  const iface = new ethers.Interface([
    "function receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)",
  ]);
  const data = iface.encodeFunctionData("receiveWithAuthorization", [m.from, m.to, m.value, m.validAfter, m.validBefore, m.nonce, sig.v, sig.r, sig.s]);
  try {
    return BigInt(await rpc("eth_estimateGas", [{ from: payee, to: ADDR.AUSD, data }, "latest", override]));
  } catch (e) {
    console.log(`  funded AUSD estimate failed: ${describeRevert(e)}`);
    return null;
  }
}

/**
 * Optional: the verified ABI from Monadscan through the Etherscan V2 API (free key; Monad testnet 10143
 * is on the free tier per https://docs.etherscan.io/supported-chains). Without a key the endpoint
 * answers "Missing/Invalid API Key", so this is skipped.
 */
async function etherscanAbi(address) {
  const key = process.env.ETHERSCAN_API_KEY;
  if (!key) return { ok: false, why: "ETHERSCAN_API_KEY not set" };
  const url = `https://api.etherscan.io/v2/api?chainid=10143&module=contract&action=getabi&address=${address}&apikey=${key}`;
  try {
    const j = await (await fetch(url)).json();
    if (j.status !== "1") return { ok: false, why: `${j.message}: ${j.result}` };
    return { ok: true, value: JSON.parse(j.result) };
  } catch (e) {
    return { ok: false, why: String(e && e.message) };
  }
}

async function faucetChecks(ausd, avgBlockMs) {
  const F = ADDR.AUSD_FAUCET;
  console.log(`\n== AUSD faucet ${F}`);
  const code = await codeOf(F);
  console.log(`  code bytes                                 ${(code.length - 2) / 2}`);
  if (code === "0x") return;
  const slots = await proxyInfo(F);
  for (const k of ["eip1967Implementation", "eip1967Admin", "eip1967Beacon"]) {
    console.log(`  slot ${k.padEnd(37)} ${isZeroWord(slots[k]) ? "0 (empty)" : slots[k]}`);
  }
  let implCode = "0x";
  if (!isZeroWord(slots.eip1967Implementation)) {
    const impl = slotAddress(slots.eip1967Implementation);
    implCode = await codeOf(impl);
    console.log(`  implementation                             ${impl} (${(implCode.length - 2) / 2} bytes, keccak ${ethers.keccak256(implCode).slice(0, 18)}...)`);
    const abi = await etherscanAbi(impl);
    if (abi.ok) {
      const fns = abi.value.filter((x) => x.type === "function").map((x) => `${x.name}(${x.inputs.map((i) => i.type).join(",")})`);
      console.log(`  Monadscan verified ABI (Etherscan V2)      ${fns.join(" ")}`);
    } else console.log(`  Monadscan verified ABI (Etherscan V2)      n/a (${abi.why})`);
  }
  const targets = [{ label: "proxy", scan: scanPushes(code) }];
  if (implCode !== "0x") targets.push({ label: "impl", scan: scanPushes(implCode) });
  console.log("  Selector scan (AgoraFaucet ABI as verified on Monadscan, plus common faucet names):");
  printSelectorTable(targets, [
    "requestFunds(address)",
    "token()",
    "faucetDripAmount()",
    "maxAmountToOwn()",
    "maxDripFrequency()",
    "lastDripTimestamp()",
    "initialize((address,uint256,uint256,uint256))",
    "AGORA_FAUCET_STORAGE_SLOT()",
    "version()",
    "claim()",
    "faucet()",
    "mint(address)",
    "drip(address)",
    "requestTokens()",
  ]);

  show("version() as (major,minor,patch)", await read(F, "version() view returns (uint256,uint256,uint256)"));
  const token = await read(F, "token() view returns (address)");
  const drip = await read(F, "faucetDripAmount() view returns (uint256)");
  const maxOwn = await read(F, "maxAmountToOwn() view returns (uint256)");
  const freq = await read(F, "maxDripFrequency() view returns (uint256)");
  const last = await read(F, "lastDripTimestamp() view returns (uint256)");
  const decimals = ausd && ausd.reads.decimals.ok ? Number(ausd.reads.decimals.value) : 6;
  show("token()", token);
  show("faucetDripAmount() (base units)", drip);
  if (drip.ok) console.log(`    = ${ethers.formatUnits(drip.value, decimals)} AUSD`);
  show("maxAmountToOwn() (base units)", maxOwn);
  if (maxOwn.ok) console.log(`    = ${ethers.formatUnits(maxOwn.value, decimals)} AUSD`);
  show("maxDripFrequency() (seconds, GLOBAL)", freq);
  show("lastDripTimestamp()", last);
  const bal = await read(ADDR.AUSD, "balanceOf(address) view returns (uint256)", [F]);
  show("AUSD.balanceOf(faucet)", bal);
  if (bal.ok) console.log(`    = ${ethers.formatUnits(bal.value, decimals)} AUSD`);
  if (bal.ok && drip.ok) {
    // AgoraFaucet.requestFunds: `if (balanceOf(this) <= faucetDripAmount) revert InsufficientFunds();`
    console.log(`  faucet can pay a drip (balance > drip)?    ${bal.value > drip.value}`);
  }
  const now = BigInt((await rpc("eth_getBlockByNumber", ["latest", false])).timestamp);
  if (freq.ok && last.ok) {
    const wait = last.value + freq.value > now ? last.value + freq.value - now : 0n;
    console.log(`  last drip                                  ${new Date(Number(last.value) * 1000).toISOString()} (${((Number(now) - Number(last.value)) / 3600).toFixed(1)} h ago)`);
    console.log(`  next drip allowed by the rate limit in     ${wait}s (global rate limit shared by every caller)`);
  }
  const who = ethers.Wallet.createRandom().address;
  const sim = await simulate(F, "requestFunds(address)", [who], who);
  console.log(`  eth_call requestFunds(fresh address) now   ${sim.ok ? "would succeed" + (sim.gas ? `, eth_estimateGas ${sim.gas}` : "") : sim.why}`);

  // Faucet balance history. The public RPC serves recent historical state, so eth_call at older blocks
  // shows whether anyone refills it. Block numbers are derived from the measured block time.
  console.log("  faucet history (eth_call at past blocks):");
  const head = BigInt(await rpc("eth_blockNumber", []));
  const perDay = BigInt(Math.round(86400000 / avgBlockMs));
  for (const days of [1, 2, 3, 5, 7, 10, 14]) {
    const n = head - BigInt(days) * perDay;
    if (n <= 0n) break;
    const tag = "0x" + n.toString(16);
    try {
      const blk = await rpc("eth_getBlockByNumber", [tag, false]);
      const b = await read(ADDR.AUSD, "balanceOf(address) view returns (uint256)", [F], undefined, tag);
      const l = await read(F, "lastDripTimestamp() view returns (uint256)", [], undefined, tag);
      const when = new Date(Number(BigInt(blk.timestamp)) * 1000).toISOString();
      const lastAt = l.ok ? new Date(Number(l.value) * 1000).toISOString() : "n/a";
      console.log(
        `    ~${String(days).padStart(2)} d ago  block ${n}  ${when}  balance ${b.ok ? ethers.formatUnits(b.value, decimals) : "n/a (" + b.why + ")"} AUSD  lastDrip ${lastAt}`,
      );
    } catch (e) {
      console.log(`    ~${days} d ago  n/a (${describeRevert(e)})`);
    }
  }
}

async function infraChecks(chainId) {
  console.log("\n== Infrastructure contracts");
  for (const [label, a] of [
    ["Multicall3", ADDR.MULTICALL3],
    ["Permit2", ADDR.PERMIT2],
    ["CRE MockKeystoneForwarder (simulate)", ADDR.CRE_MOCK_FORWARDER],
    ["CRE KeystoneForwarder (deployed)", ADDR.CRE_KEYSTONE_FORWARDER],
  ]) {
    const code = await codeOf(a);
    console.log(`  ${label.padEnd(40)} ${a} code bytes ${(code.length - 2) / 2}`);
  }
  show("Multicall3.getChainId()", await read(ADDR.MULTICALL3, "getChainId() view returns (uint256)"));
  show("Multicall3.getBlockNumber()", await read(ADDR.MULTICALL3, "getBlockNumber() view returns (uint256)"));
  const p2 = await read(ADDR.PERMIT2, "DOMAIN_SEPARATOR() view returns (bytes32)");
  show("Permit2.DOMAIN_SEPARATOR()", p2);
  // https://github.com/Uniswap/permit2/blob/main/src/EIP712.sol : EIP712Domain(string name,uint256 chainId,address verifyingContract), name "Permit2"
  const p2Expected = ethers.TypedDataEncoder.hashDomain({ name: "Permit2", chainId, verifyingContract: ADDR.PERMIT2 });
  console.log(`  Permit2 expected (name "Permit2", no version) ${p2Expected} ${p2.ok && p2.value === p2Expected ? "MATCH" : "no match"}`);
  show("MockKeystoneForwarder.typeAndVersion()", await read(ADDR.CRE_MOCK_FORWARDER, "typeAndVersion() view returns (string)"));
  show("KeystoneForwarder.typeAndVersion()", await read(ADDR.CRE_KEYSTONE_FORWARDER, "typeAndVersion() view returns (string)"));
}

async function gasChecks(estimates) {
  console.log("\n== Gas");
  const gasPrice = BigInt(await rpc("eth_gasPrice", []));
  let tip = null;
  try {
    tip = BigInt(await rpc("eth_maxPriorityFeePerGas", []));
  } catch (e) {
    console.log(`  eth_maxPriorityFeePerGas                   n/a (${describeRevert(e)})`);
  }
  const block = await rpc("eth_getBlockByNumber", ["latest", false]);
  const base = block.baseFeePerGas ? BigInt(block.baseFeePerGas) : null;
  console.log(`  eth_gasPrice                               ${gasPrice} wei (${ethers.formatUnits(gasPrice, "gwei")} gwei)`);
  if (tip !== null) console.log(`  eth_maxPriorityFeePerGas                   ${tip} wei (${ethers.formatUnits(tip, "gwei")} gwei)`);
  if (base !== null) console.log(`  latest baseFeePerGas                       ${base} wei (${ethers.formatUnits(base, "gwei")} gwei)`);
  const LIMIT = 150000n;
  console.log(`  Monad charges gas_limit * price (https://docs.monad.xyz/developer-essentials/gas-pricing)`);
  console.log(`  150,000 gas limit x eth_gasPrice           ${ethers.formatEther(LIMIT * gasPrice)} MON`);
  if (base !== null && tip !== null) console.log(`  150,000 gas limit x (baseFee + tip)        ${ethers.formatEther(LIMIT * (base + tip))} MON`);
  console.log(`  150,000 gas limit x 100 gwei floor         ${ethers.formatEther(LIMIT * 100n * 10n ** 9n)} MON`);
  for (const [label, g] of estimates) {
    if (g) console.log(`  ${label.padEnd(42)} est ${g}, limit at +15% ${(g * 115n) / 100n} -> ${ethers.formatEther(((g * 115n) / 100n) * gasPrice)} MON`);
  }
}

async function main() {
  const { chainId, avgBlockMs } = await network();

  const ausd = await tokenChecks("AUSD", ADDR.AUSD, chainId, {
    agoraFlags: true,
    extraReads: [
      "implementation() view returns (address)",
      "proxyAdminAddress() view returns (address)",
      "isTransferPaused() view returns (bool)",
      "isSignatureVerificationPaused() view returns (bool)",
      "isReceiveWithAuthorizationUpgraded() view returns (bool)",
      "isTransferWithAuthorizationUpgraded() view returns (bool)",
      "isMsgSenderFrozenCheckEnabled() view returns (bool)",
      "domainSeparatorV4() view returns (bytes32)",
      "getMinterRoleMembers() view returns (address[])",
      "getBridgeMinterRoleMembers() view returns (address[])",
    ],
    domainGuesses: [
      { name: "Agora Dollar", version: "1" },
      { name: "AUSD", version: "1" },
    ],
  });
  const ausdSig = await signatureChecks("AUSD", ADDR.AUSD, ausd, { version: "2" });

  await faucetChecks(ausd, avgBlockMs);

  const usdc = await tokenChecks("Circle USDC", ADDR.USDC, chainId, {
    extraReads: ["paused() view returns (bool)", "currency() view returns (string)"],
    domainGuesses: [
      { name: "USDC", version: "2" },
      { name: "USD Coin", version: "2" },
    ],
  });
  const usdcSig = await signatureChecks("Circle USDC", ADDR.USDC, usdc, { version: "1" });

  await infraChecks(chainId);

  const funded = ausd && ausd.domain ? await ausdFundedEstimate(ausd.domain) : null;

  await gasChecks([
    ["AUSD receiveWithAuthorization (value 0)", ausdSig.rwaVrs && ausdSig.rwaVrs.gas],
    ["AUSD receiveWithAuthorization 200 AUSD, fresh payee", funded],
    ["AUSD permit", ausdSig.permitVrs && ausdSig.permitVrs.gas],
    ["USDC receiveWithAuthorization (value 0)", usdcSig.rwaVrs && usdcSig.rwaVrs.gas],
  ]);

  console.log("\n== Summary");
  console.log(`  AUSD EIP-712 domain: ${ausd && ausd.domain ? JSON.stringify({ ...ausd.domain, chainId: String(ausd.domain.chainId) }) : "UNRESOLVED"}`);
  console.log(`  AUSD receiveWithAuthorization(v,r,s) by the payee: ${ausdSig.rwaVrs && ausdSig.rwaVrs.ok ? "works" : "FAILS"}`);
  console.log(`  AUSD receiveWithAuthorization(v,r,s) by a contract payee: ${ausdSig.rwaFromContract && ausdSig.rwaFromContract.ok ? "works" : "FAILS"}`);
  console.log(`  USDC EIP-712 domain: ${usdc && usdc.domain ? JSON.stringify({ ...usdc.domain, chainId: String(usdc.domain.chainId) }) : "UNRESOLVED"}`);
  console.log(`  USDC receiveWithAuthorization(v,r,s) by the payee: ${usdcSig.rwaVrs && usdcSig.rwaVrs.ok ? "works" : "FAILS"}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
