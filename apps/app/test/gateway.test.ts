import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decodeFunctionData, encodeFunctionData, getAddress, type Hex, pad, recoverTypedDataAddress, toFunctionSelector } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { ccipFeeWithMargin, ccipMessageUrl, eurosInDollars, freshRate, parseCcip, parseGateway, parseRates, payOnArcCall, rateText } from "../src/lib/cross-chain.ts";
import {
  type BurnIntentTypedData,
  checkBurnIntent,
  covers,
  depositChains,
  finalityHint,
  gatewayDepositCalls,
  gatewayFeeHint,
  gatewayMaxFee,
  knownExplorer,
  pickGatewaySource,
  preciseUsd,
  signTypedDataV4Params,
  signTypedDataV4Payload,
  topUpAmount,
} from "../src/lib/gateway.ts";

/**
 * Pay from any chain: Circle Gateway's burn intent as the buyer's wallet
 * signs it, the deposit calls, the fee and source choice, the network's
 * new blocks read defensively, and the CCIP order call.
 */

// A throwaway key, used only to prove the payload signs and recovers.
const BUYER_WALLET = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const POLARIS_ACCOUNT = getAddress("0x00000000000000000000000000000000000a11ce");
const GATEWAY_WALLET = getAddress("0x0077777d7EBA4688BDeF3E311b846F25870A19B9");
const GATEWAY_MINTER = getAddress("0x0022222ABE238Cc2C7Bb1f21003F0a260052475B");
const USDC_BASE_SEPOLIA = getAddress("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
const USDC_ARC = getAddress("0x3600000000000000000000000000000000000000");
const b32 = (a: string) => pad(getAddress(a), { size: 32 }).toLowerCase() as Hex;

const TYPES = {
  TransferSpec: [
    { name: "version", type: "uint32" },
    { name: "sourceDomain", type: "uint32" },
    { name: "destinationDomain", type: "uint32" },
    { name: "sourceContract", type: "bytes32" },
    { name: "destinationContract", type: "bytes32" },
    { name: "sourceToken", type: "bytes32" },
    { name: "destinationToken", type: "bytes32" },
    { name: "sourceDepositor", type: "bytes32" },
    { name: "destinationRecipient", type: "bytes32" },
    { name: "sourceSigner", type: "bytes32" },
    { name: "destinationCaller", type: "bytes32" },
    { name: "value", type: "uint256" },
    { name: "salt", type: "bytes32" },
    { name: "hookData", type: "bytes" },
  ],
  BurnIntent: [
    { name: "maxBlockHeight", type: "uint256" },
    { name: "maxFee", type: "uint256" },
    { name: "spec", type: "TransferSpec" },
  ],
};

/** What `POST /api/public/gateway/intent` answers, for 10 USDC from Base Sepolia (domain 6) to Arc (26). */
function intent(overrides: { recipient?: string; depositor?: string; value?: string; maxFee?: string; sourceDomain?: number } = {}): BurnIntentTypedData {
  const depositor = overrides.depositor ?? BUYER_WALLET.address;
  return {
    domain: { name: "GatewayWallet", version: "1" },
    types: TYPES,
    primaryType: "BurnIntent",
    message: {
      maxBlockHeight: ((1n << 256n) - 1n).toString(),
      maxFee: overrides.maxFee ?? gatewayMaxFee(6, 10_000_000n).toString(),
      spec: {
        version: 1,
        sourceDomain: overrides.sourceDomain ?? 6,
        destinationDomain: 26,
        sourceContract: b32(GATEWAY_WALLET),
        destinationContract: b32(GATEWAY_MINTER),
        sourceToken: b32(USDC_BASE_SEPOLIA),
        destinationToken: b32(USDC_ARC),
        sourceDepositor: b32(depositor),
        destinationRecipient: b32(overrides.recipient ?? POLARIS_ACCOUNT),
        sourceSigner: b32(depositor),
        destinationCaller: `0x${"0".repeat(64)}`,
        value: overrides.value ?? "10000000",
        salt: `0x${"ab".repeat(32)}`,
        hookData: "0x",
      },
    },
  };
}

const expected = { depositor: BUYER_WALLET.address, recipient: POLARIS_ACCOUNT, amount: 10_000_000n, sourceDomain: 6 };

describe("the Gateway burn intent the wallet signs", () => {
  it("adds EIP712Domain (name and version, no chainId) for eth_signTypedData_v4", () => {
    const payload = JSON.parse(signTypedDataV4Payload(intent()));
    assert.deepEqual(payload.types.EIP712Domain, [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
    ]);
    assert.deepEqual(Object.keys(payload.types), ["EIP712Domain", "TransferSpec", "BurnIntent"]);
    assert.deepEqual(payload.domain, { name: "GatewayWallet", version: "1" });
    assert.equal(payload.primaryType, "BurnIntent");
    // uint256 stay decimal strings, as wallets take them.
    assert.equal(payload.message.spec.value, "10000000");
  });

  it("replaces an EIP712Domain the server sent rather than listing it twice", () => {
    const withDomain = { ...intent(), types: { EIP712Domain: [{ name: "name", type: "string" }], ...TYPES } };
    const payload = JSON.parse(signTypedDataV4Payload(withDomain));
    assert.equal(payload.types.EIP712Domain.length, 2);
  });

  it("asks the wallet with the signer first", () => {
    const [signer, json] = signTypedDataV4Params(BUYER_WALLET.address, intent());
    assert.equal(signer, BUYER_WALLET.address);
    assert.equal(typeof json, "string");
  });

  it("signs under Gateway's domain and recovers to the depositor (what the mint endpoint checks)", async () => {
    const payload = JSON.parse(signTypedDataV4Payload(intent()));
    const { EIP712Domain: _domain, ...types } = payload.types;
    void _domain;
    const message = {
      ...payload.message,
      maxBlockHeight: BigInt(payload.message.maxBlockHeight),
      maxFee: BigInt(payload.message.maxFee),
      spec: { ...payload.message.spec, value: BigInt(payload.message.spec.value) },
    };
    const signature = await BUYER_WALLET.signTypedData({ domain: payload.domain, types, primaryType: "BurnIntent", message });
    const signer = await recoverTypedDataAddress({ domain: payload.domain, types, primaryType: "BurnIntent", message, signature });
    assert.equal(signer, BUYER_WALLET.address);
  });

  it("passes the intent Polaris should have built", () => {
    assert.equal(checkBurnIntent(intent(), expected), null);
  });

  it("refuses an intent that pays someone else, spends another wallet, or moves another amount", () => {
    assert.match(checkBurnIntent(intent({ recipient: "0x000000000000000000000000000000000000dEaD" }), expected) ?? "", /your Polaris account/);
    assert.match(checkBurnIntent(intent({ depositor: "0x000000000000000000000000000000000000dEaD" }), expected) ?? "", /your wallet/);
    assert.match(checkBurnIntent(intent({ value: "10000001" }), expected) ?? "", /another amount/);
    assert.match(checkBurnIntent(intent({ sourceDomain: 0 }), expected) ?? "", /another chain/);
  });

  it("refuses a fee above Polaris's ceiling, or another domain", () => {
    assert.match(checkBurnIntent(intent({ maxFee: (gatewayMaxFee(6, 10_000_000n) + 1n).toString() }), expected) ?? "", /fee/);
    assert.match(checkBurnIntent({ ...intent(), domain: { name: "Other", version: "1" } }, expected) ?? "", /Gateway/);
  });
});

describe("a deposit into Gateway", () => {
  const calls = gatewayDepositCalls({ usdc: USDC_BASE_SEPOLIA, wallet: GATEWAY_WALLET, amount: 25_000_000n });

  it("approves the GatewayWallet for the amount", () => {
    const data = encodeFunctionData(calls.approve);
    assert.equal(calls.approve.address, USDC_BASE_SEPOLIA);
    assert.equal(data.slice(0, 10), toFunctionSelector("approve(address,uint256)"));
    const { args } = decodeFunctionData({ abi: calls.approve.abi, data });
    assert.deepEqual(args, [GATEWAY_WALLET, 25_000_000n]);
  });

  it("then calls GatewayWallet.deposit(token, value)", () => {
    const data = encodeFunctionData(calls.deposit);
    assert.equal(calls.deposit.address, GATEWAY_WALLET);
    assert.equal(data.slice(0, 10), toFunctionSelector("deposit(address,uint256)"));
    const { args } = decodeFunctionData({ abi: calls.deposit.abi, data });
    assert.deepEqual(args, [USDC_BASE_SEPOLIA, 25_000_000n]);
  });

  it("says how long until it is spendable: that chain's finality", () => {
    assert.match(finalityHint(0), /15 to 20 minutes/);
    assert.match(finalityHint(6), /minutes/);
    assert.match(finalityHint(26), /under a second/);
  });

  it("deposits on Gateway's chains other than Arc, with Polaris's CCTP endpoints first", () => {
    const sources = [
      { domain: 6, name: "Base Sepolia", usdc: USDC_BASE_SEPOLIA },
      { domain: 0, name: "Ethereum Sepolia", usdc: getAddress("0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238") },
      { domain: 26, name: "Arc Testnet", usdc: USDC_ARC },
      { domain: 99, name: "Unknown", usdc: USDC_ARC },
    ];
    const known = [{ domain: 6, chainId: 84532, rpcUrl: "https://base-sepolia.example/rpc", explorerUrl: "https://base.example/" }];
    const chains = depositChains(sources, { arcDomain: 26, testnet: true, known });
    assert.deepEqual(
      chains.map((c) => [c.domain, c.chainId]),
      [
        [6, 84532],
        [0, 11155111],
      ],
    );
    assert.equal(chains[0]?.rpcUrl, "https://base-sepolia.example/rpc");
    assert.equal(chains[0]?.explorerUrl, "https://base.example");
    assert.equal(depositChains(sources, { arcDomain: 26, testnet: false })[0]?.chainId, 8453);
    assert.equal(knownExplorer(84532), "https://sepolia.basescan.org");
    assert.equal(knownExplorer(1234), null);
  });
});

describe("Gateway fees and the chain to spend from", () => {
  it("hints Circle's fee: the source's gas fee plus 0.005%", () => {
    assert.equal(gatewayFeeHint(6, 10_000_000n), 10_000n + 500n);
    assert.equal(gatewayFeeHint(0, 100_000_000n), 1_000_000n + 5_000n);
    assert.equal(gatewayFeeHint(26, 1_000_000n), 3_500n + 50n);
  });

  it("caps the fee as the server does: a quarter of headroom, the transfer fee, a cent", () => {
    assert.equal(gatewayMaxFee(6, 10_000_000n), 12_500n + 500n + 10_000n);
    assert.equal(gatewayMaxFee(0, 10_000_000n), 1_250_000n + 500n + 10_000n);
  });

  it("spends from the cheapest chain that covers the amount and its fee", () => {
    const balances = [
      { domain: 0, balanceUnits: 50_000_000n },
      { domain: 6, balanceUnits: 20_000_000n },
    ];
    assert.equal(pickGatewaySource(balances, 10_000_000n), 6);
    // Base can't cover 20 USDC plus its fee; Ethereum can.
    assert.equal(pickGatewaySource(balances, 20_000_000n), 0);
    assert.equal(pickGatewaySource(balances, 60_000_000n), null);
    assert.equal(covers(10_000_000n, 6, 10_000_000n), false);
    assert.equal(covers(10_023_000n, 6, 10_000_000n), true);
  });

  it("moves only the shortfall when the Polaris balance has some", () => {
    assert.equal(topUpAmount(25_000_000n, 10_000_000n), 15_000_000n);
    assert.equal(topUpAmount(25_000_000n, 30_000_000n), 25_000_000n);
    assert.equal(topUpAmount(25_000_000n, undefined), 25_000_000n);
  });

  it("writes a small fee with the decimals it needs", () => {
    assert.equal(preciseUsd(3_500n), "$0.0035");
    assert.equal(preciseUsd(10_500n), "$0.0105");
    assert.equal(preciseUsd(1_010_000n), "$1.01");
    assert.equal(preciseUsd(5_000_000n), "$5.00");
    assert.equal(preciseUsd(1_234_567_890n), "$1,234.56789");
  });
});

describe("the network's cross-chain blocks, read defensively", () => {
  it("is null for an older API without them", () => {
    assert.equal(parseGateway(undefined), null);
    assert.equal(parseCcip(null), null);
    assert.equal(parseRates(undefined), null);
  });

  it("reads Gateway, dropping malformed sources", () => {
    const g = parseGateway({
      wallet: GATEWAY_WALLET.toLowerCase(),
      minter: GATEWAY_MINTER,
      sources: [{ domain: 6, name: "Base Sepolia", usdc: USDC_BASE_SEPOLIA }, { domain: "x", usdc: "nope" }, null],
      intentPath: "/api/public/gateway/intent",
    });
    assert.ok(g);
    assert.equal(g.wallet, GATEWAY_WALLET);
    assert.equal(g.sources.length, 1);
    assert.equal(g.mintPath, "/api/public/gateway/mint");
    assert.equal(parseGateway({ wallet: GATEWAY_WALLET, minter: GATEWAY_MINTER, sources: [] }), null);
  });

  it("reads CCIP, keeping only sources with a deployed sender", () => {
    const source = {
      name: "Base Sepolia",
      chainId: 84532,
      selector: "10344971235874465080",
      router: "0xD3b06cEbF099CE7DA4AcCf578aaebFDBd6e88a93",
      usdc: USDC_BASE_SEPOLIA,
      tokenMessengerV2: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
      cctpDomain: 6,
      rpcUrl: "https://sepolia.base.org",
    };
    const c = parseCcip({
      chainSelector: "1",
      router: "0x0000000000000000000000000000000000000001",
      receiver: "0x0000000000000000000000000000000000000002",
      explorer: "https://ccip.chain.link/",
      sources: [source, { ...source, chainId: 11155111, sender: "0x0000000000000000000000000000000000000003" }],
    });
    assert.ok(c);
    assert.equal(c.explorer, "https://ccip.chain.link");
    assert.deepEqual(
      c.sources.map((s) => s.chainId),
      [11155111],
    );
  });

  it("reads Chainlink rates, and shows only fresh ones", () => {
    const rates = parseRates({
      source: "Chainlink Data Feeds on Arc mainnet",
      eurcUsd: { pair: "EURC / USD", feed: "0x361b95c10b76Ca3f35C686d423e43A951755Bf23", price: "1.084200", updatedAt: "2026-10-07T10:00:00.000Z", stale: false },
      eurUsd: { pair: "EUR / USD", feed: "0xDd5B15443cd733D3966a50a3E48cB7DF9Fb5DE0D", price: "1.085", updatedAt: "2026-10-01T10:00:00.000Z", stale: true },
      usdcUsd: null,
    });
    assert.ok(rates);
    assert.equal(rates.eurcUsd?.price, 1.0842);
    assert.equal(rateText(rates.eurcUsd!), "$1.0842");
    assert.equal(freshRate(rates.eurUsd), null);
    assert.equal(freshRate(rates.usdcUsd), null);
    // €100 at 1.0842 is $108.42, for display.
    assert.equal(eurosInDollars(100_000_000n, rates.eurcUsd!), 108_420_000n);
    assert.equal(parseRates({ eurcUsd: null, eurUsd: { price: "abc" } }), null);
  });
});

describe("paying the order over Chainlink CCIP", () => {
  const SENDER = getAddress("0x0000000000000000000000000000000000000c1b");
  const MERCHANT = getAddress("0x000000000000000000000000000000000000beef");

  it("sends the quoted CCIP fee with a tenth of margin", () => {
    assert.equal(ccipFeeWithMargin(1_000_000_000_000_000n), 1_100_000_000_000_000n);
    const call = payOnArcCall({ sender: SENDER, merchant: MERCHANT, amount: 32_020_000n, orderId: "HC-39073", arcRefundTo: POLARIS_ACCOUNT, fee: 500n });
    assert.equal(call.value, 550n);
    assert.equal(call.address, SENDER);
    const data = encodeFunctionData(call);
    assert.equal(data.slice(0, 10), toFunctionSelector("payOnArc(address,uint256,string,address)"));
    const { args } = decodeFunctionData({ abi: call.abi, data });
    assert.deepEqual(args, [MERCHANT, 32_020_000n, "HC-39073", POLARIS_ACCOUNT]);
  });

  it("links the message on the CCIP Explorer", () => {
    const id = `0x${"12".repeat(32)}` as Hex;
    assert.equal(ccipMessageUrl("https://ccip.chain.link/", id), `https://ccip.chain.link/msg/${id}`);
  });
});
