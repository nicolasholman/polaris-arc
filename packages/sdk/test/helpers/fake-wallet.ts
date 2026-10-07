import { AbiCoder, type BaseWallet, Interface, Wallet, getAddress, keccak256, toUtf8Bytes } from "ethers";

import { PAYMENTS_ABI, TOKEN_ABI } from "../../src/pay/eip3009.js";
import type { Eip1193Provider } from "../../src/types.js";

/**
 * An EIP-1193 wallet over a scripted chain: an ethers Wallet signs, and the
 * token and PolarisPayments answer `eth_call` from plain state. Every request
 * is recorded so a test can assert exactly what the SDK asked the wallet for.
 */

const token = new Interface(TOKEN_ABI);
const payments = new Interface(PAYMENTS_ABI);

export type ChainState = {
  chainId: number;
  decimals: number;
  balance: bigint;
  paid: { payer: string; merchant: string; amount: bigint; paidAt: bigint } | null;
  quoted: bigint;
  /** ERC-5267 domain the token reports; null makes eip712Domain() revert. */
  domain: { fields: string; name: string; version: string; salt: string } | null;
  /** For the pre-5267 fallback. */
  legacyName: string;
  domainSeparator: string;
  receiptStatus: "0x1" | "0x0";
};

export type FakeWalletOptions = Partial<ChainState> & {
  wallet?: BaseWallet;
  /** Sign with this key instead of the account's (a lying wallet). */
  signWith?: BaseWallet;
  rejectSignature?: boolean;
  /** The buyer declines the network switch (4001). */
  rejectSwitch?: boolean;
  /** The buyer declines adding the network (4001). */
  rejectAddChain?: boolean;
  /** The wallet accepts the switch but stays where it was. */
  ignoreSwitch?: boolean;
  knownChains?: number[];
};

export function createFakeWallet(tokenAddress: string, paymentsAddress: string, options: FakeWalletOptions = {}) {
  const wallet = options.wallet ?? Wallet.createRandom();
  const state: ChainState = {
    chainId: options.chainId ?? 10143,
    decimals: options.decimals ?? 6,
    balance: options.balance ?? 1_000_000_000n,
    paid: options.paid ?? null,
    quoted: options.quoted ?? 0n,
    domain: options.domain === undefined ? { fields: "0x0f", name: "Agora Dollar", version: "1", salt: `0x${"00".repeat(32)}` } : options.domain,
    legacyName: options.legacyName ?? "AUSD",
    domainSeparator: options.domainSeparator ?? `0x${"11".repeat(32)}`,
    receiptStatus: options.receiptStatus ?? "0x1",
  };
  const knownChains = new Set(options.knownChains ?? [10143, 143, 11155111, 31337]);
  const calls: Array<{ method: string; params?: unknown }> = [];
  const signed: Array<{ domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, string> }> = [];
  const sent: Array<{ from: string; to: string; data: string; gas: string; value: string }> = [];

  function answer(to: string, data: string): string {
    const addr = getAddress(to);
    if (addr === getAddress(tokenAddress)) {
      const fn = token.parseTransaction({ data });
      switch (fn?.name) {
        case "decimals":
          return token.encodeFunctionResult("decimals", [state.decimals]);
        case "balanceOf":
          return token.encodeFunctionResult("balanceOf", [state.balance]);
        case "eip712Domain":
          if (!state.domain) throw Object.assign(new Error("execution reverted"), { code: 3 });
          return token.encodeFunctionResult("eip712Domain", [
            state.domain.fields,
            state.domain.name,
            state.domain.version,
            state.chainId,
            tokenAddress,
            state.domain.salt,
            [],
          ]);
        case "name":
          return token.encodeFunctionResult("name", [state.legacyName]);
        case "version":
          return token.encodeFunctionResult("version", ["1"]);
        case "DOMAIN_SEPARATOR":
          return token.encodeFunctionResult("DOMAIN_SEPARATOR", [state.domainSeparator]);
      }
    }
    if (addr === getAddress(paymentsAddress)) {
      const fn = payments.parseTransaction({ data });
      if (fn?.name === "paymentFor") {
        const p = state.paid ?? { payer: `0x${"00".repeat(20)}`, merchant: `0x${"00".repeat(20)}`, amount: 0n, paidAt: 0n };
        return payments.encodeFunctionResult("paymentFor", [[p.payer, p.merchant, p.amount, p.paidAt]]);
      }
      if (fn?.name === "quotedAmount") return payments.encodeFunctionResult("quotedAmount", [state.quoted]);
    }
    throw new Error(`unexpected eth_call to ${to}: ${data.slice(0, 10)}`);
  }

  const provider: Eip1193Provider = {
    async request({ method, params }) {
      calls.push({ method, params });
      const p = (params ?? []) as unknown[];
      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          return [wallet.address];
        case "eth_chainId":
          return `0x${state.chainId.toString(16)}`;
        case "wallet_switchEthereumChain": {
          const id = Number.parseInt((p[0] as { chainId: string }).chainId, 16);
          if (!knownChains.has(id)) throw Object.assign(new Error("Unrecognized chain ID"), { code: 4902 });
          if (options.rejectSwitch) throw Object.assign(new Error("User rejected the request."), { code: 4001 });
          if (!options.ignoreSwitch) state.chainId = id;
          return null;
        }
        case "wallet_addEthereumChain": {
          if (options.rejectAddChain) throw Object.assign(new Error("User rejected the request."), { code: 4001 });
          const id = Number.parseInt((p[0] as { chainId: string }).chainId, 16);
          knownChains.add(id);
          state.chainId = id;
          return null;
        }
        case "eth_call": {
          const tx = p[0] as { to: string; data: string };
          return answer(tx.to, tx.data);
        }
        case "eth_signTypedData_v4": {
          if (options.rejectSignature) throw Object.assign(new Error("User rejected the request."), { code: 4001 });
          const [account, json] = p as [string, string];
          if (getAddress(account) !== wallet.address) throw new Error("unknown account");
          const typed = JSON.parse(json);
          signed.push(typed);
          const { EIP712Domain: _domainType, ...types } = typed.types;
          return (options.signWith ?? wallet).signTypedData(typed.domain, types, typed.message);
        }
        case "eth_estimateGas":
          return "0x186a0"; // 100 000
        case "eth_sendTransaction": {
          const tx = p[0] as (typeof sent)[number];
          sent.push(tx);
          return keccak256(toUtf8Bytes(`tx-${sent.length}`));
        }
        case "eth_getTransactionReceipt":
          return { status: state.receiptStatus, transactionHash: p[0], blockNumber: "0x10" };
        default:
          throw new Error(`unsupported method ${method}`);
      }
    },
  };

  return { provider, wallet, state, calls, signed, sent, methods: () => calls.map((c) => c.method) };
}

export const abi = AbiCoder.defaultAbiCoder();
