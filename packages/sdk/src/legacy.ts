/**
 * The 0.2 wallet methods, unchanged in behaviour: approve-then-call flows
 * where the buyer holds gas. `createPolaris` loads this module on first use,
 * so a page that only opens the hosted checkout never downloads ethers.
 *
 * On Monad, `pay()` doesn't come here: it's a signature through
 * PolarisPayments.payWithAuthorization (see pay/direct.ts). The approve-then-
 * pay path below is what `pay()` does on the 0.2 Sepolia deployment, whose
 * PolarisPayments predates it.
 *
 * Decimals are read from the token, never assumed. The 0.1 component
 * hardcoded 18 against a 6-decimal stablecoin, which overcharged by 10^12.
 */

import { BrowserProvider, Contract, JsonRpcProvider, formatUnits, parseUnits } from "ethers";

import { assertDeployed, explorerTxUrl, type PolarisChain } from "./chains.js";
import type { Result } from "./pay/direct.js";
import { buyerMessage, ensureChain, findProvider } from "./pay/wallet.js";
import type { ContractName } from "./types.js";

const ERC20 = [
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];
const PAYMENTS = [
  "function pay(address,uint256,string) returns (bytes32)",
  "function subscribe(uint256) returns (uint256)",
  "function cancel(uint256)",
  "function getPlan(uint256) view returns (tuple(address merchant,uint128 pricePerPeriod,uint64 periodSeconds,bool active,string name))",
];
const SCORES = [
  "function scoreOf(address) view returns (uint16)",
  "function creditLimitOf(address) view returns (uint256)",
  "function baseLimitOf(address) view returns (uint256)",
];
const VAULT = [
  "function lock(uint256)",
  "function withdraw(uint256)",
  "function lockedOf(address) view returns (uint256)",
  "function withdrawable(address) view returns (uint256)",
  "function creditBoostOf(address) view returns (uint256)",
];

export type CreditProfile = {
  address: string;
  score: number;
  limit: string;
  baseLimit: string;
  collateralLocked: string;
  collateralBoost: string;
  withdrawable: string;
  symbol: string;
};

export type LegacyOptions = {
  chain: PolarisChain;
  provider?: unknown;
  rpcUrl?: string;
  apiKey?: string;
  endpoint?: string;
};

export function createLegacyMethods(options: LegacyOptions) {
  const c = options.chain;
  const endpoint = options.endpoint ?? "/api/checkout";

  async function connect(needs: ContractName[] = []) {
    assertDeployed(c, ["stablecoin", ...needs]);
    const eth = findProvider(options.provider);

    let provider = new BrowserProvider(eth as never);
    const [address] = (await provider.send("eth_requestAccounts", [])) as string[];
    if (!address) throw new Error("Your wallet returned no account.");

    const net = await provider.getNetwork();
    if (net.chainId !== BigInt(c.chainId)) {
      // The same switch as pay(): add the chain if the wallet has never seen
      // it (4902), and a declined switch asks the buyer to change network
      // (`wrong_chain`) rather than reading "You cancelled the request."
      await ensureChain(eth, c);
      /*
       * A BrowserProvider caches the network it detected on construction, so
       * the instance that just switched still reports the old chain and will
       * happily sign against it. Everything after this point must go through a
       * provider built after the switch.
       */
      provider = new BrowserProvider(eth as never);
    }
    return { provider, signer: await provider.getSigner(), address };
  }

  /**
   * Read decimals from the token rather than assuming them, then hold onto the
   * answer. It cannot change, and re-reading it made every priced call pay for
   * an extra round trip.
   */
  let decimalsCache: Promise<number> | undefined;
  function tokenDecimals(provider: BrowserProvider | JsonRpcProvider): Promise<number> {
    decimalsCache ??= (async () => Number(await new Contract(c.stablecoin, ERC20, provider).decimals()))();
    return decimalsCache;
  }

  async function scale(provider: BrowserProvider, amount: string): Promise<bigint> {
    return parseUnits(amount, await tokenDecimals(provider));
  }

  /** A provider for reads: the configured RPC if there is one, else the wallet. */
  async function reader(): Promise<{ provider: BrowserProvider | JsonRpcProvider; address?: string }> {
    if (options.rpcUrl) {
      return { provider: new JsonRpcProvider(options.rpcUrl, c.chainId) };
    }
    const { provider, address } = await connect();
    return { provider, address };
  }

  /** Approve only when the current allowance is short. */
  async function ensureAllowance(signer: never, spender: string, need: bigint, owner: string) {
    const token = new Contract(c.stablecoin, ERC20, signer);
    const current: bigint = await token.allowance(owner, spender);
    if (current >= need) return;
    await (await token.approve(spender, need)).wait();
  }

  function ok(hash?: string): Result {
    return { ok: true, transactionHash: hash, explorerUrl: hash ? explorerTxUrl(c, hash) : undefined };
  }

  function fail(err: unknown): Result {
    return { ok: false, error: buyerMessage(err, c), cause: err };
  }

  const api = {
    /** Pay a merchant in full, now: approve, then PolarisPayments.pay. The 0.2 flow. */
    async payWithApproval(p: { merchant: string; amount: string; orderId: string }): Promise<Result> {
      try {
        const { provider, signer, address } = await connect(["payments"]);
        const value = await scale(provider, p.amount);
        await ensureAllowance(signer as never, c.payments, value, address);
        const tx = await new Contract(c.payments, PAYMENTS, signer).pay(p.merchant, value, p.orderId);
        await tx.wait();
        return ok(tx.hash);
      } catch (err) {
        return fail(err);
      }
    },

    /** Start a subscription. The first period is charged immediately. */
    async subscribe(p: { planId: number | bigint }): Promise<Result> {
      try {
        const { signer, address } = await connect(["payments"]);
        const payments = new Contract(c.payments, PAYMENTS, signer);
        const plan = await payments.getPlan(p.planId);
        if (!plan.active) return { ok: false, error: "This plan is no longer available." };

        // Approve a year of periods so the keeper can collect unattended, and
        // no more -- the subscriber can revoke at any time, and this bounds
        // what a compromised contract could ever draw.
        const period = Number(plan.periodSeconds);
        if (!Number.isFinite(period) || period <= 0) {
          return { ok: false, error: "This plan is misconfigured and cannot be started." };
        }
        const periodsPerYear = BigInt(Math.max(1, Math.ceil(31_536_000 / period)));
        await ensureAllowance(signer as never, c.payments, BigInt(plan.pricePerPeriod) * periodsPerYear, address);

        const tx = await payments.subscribe(p.planId);
        await tx.wait();
        return ok(tx.hash);
      } catch (err) {
        return fail(err);
      }
    },

    /** Cancel a subscription. Unilateral -- no merchant cooperation needed. */
    async cancelSubscription(p: { subscriptionId: number | bigint }): Promise<Result> {
      try {
        const { signer } = await connect(["payments"]);
        const tx = await new Contract(c.payments, PAYMENTS, signer).cancel(p.subscriptionId);
        await tx.wait();
        return ok(tx.hash);
      } catch (err) {
        return fail(err);
      }
    },

    /**
     * Split a purchase into instalments, the 0.2 way: the buyer approves the
     * loan engine and your backend opens the plan. On Monad, prefer the hosted
     * checkout's Pay in 4 (a signed intent, no approval transaction).
     */
    async payLater(p: {
      amount: string;
      orderId: string;
      installments?: number;
      intervalSeconds?: number;
    }): Promise<Result & { loanId?: string }> {
      try {
        const { provider, signer, address } = await connect(["loanEngine"]);
        const value = await scale(provider, p.amount);
        // Headroom for interest accrued over the term.
        await ensureAllowance(signer as never, c.loanEngine, (value * 110n) / 100n, address);

        const res = await fetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(options.apiKey ? { "x-api-key": options.apiKey } : {}),
          },
          body: JSON.stringify({
            borrower: address,
            amount: p.amount,
            orderId: p.orderId,
            installments: p.installments ?? 4,
            intervalSeconds: p.intervalSeconds ?? 14 * 86_400,
            chainId: c.chainId,
          }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) return { ok: false, error: body.error ?? `Could not open the plan (${res.status})` };

        return { ...ok(body.transactionHash), loanId: body.loanId };
      } catch (err) {
        return fail(err);
      }
    },

    /** Lock collateral to raise the credit limit. */
    async lockCollateral(p: { amount: string }): Promise<Result> {
      try {
        const { provider, signer, address } = await connect(["collateralVault"]);
        const value = await scale(provider, p.amount);
        await ensureAllowance(signer as never, c.collateralVault, value, address);
        const tx = await new Contract(c.collateralVault, VAULT, signer).lock(value);
        await tx.wait();
        return ok(tx.hash);
      } catch (err) {
        return fail(err);
      }
    },

    async withdrawCollateral(p: { amount: string }): Promise<Result> {
      try {
        const { provider, signer } = await connect(["collateralVault"]);
        const tx = await new Contract(c.collateralVault, VAULT, signer).withdraw(await scale(provider, p.amount));
        await tx.wait();
        return ok(tx.hash);
      } catch (err) {
        return fail(err);
      }
    },

    /**
     * Read-only. Safe to call before the buyer commits to anything.
     *
     * With `rpcUrl` set this touches no wallet at all, which is what makes an
     * eligibility badge renderable on a product page. Without one it has to
     * borrow the wallet's provider, and connecting is the price of that.
     */
    async getCredit(address?: string): Promise<CreditProfile> {
      assertDeployed(c, ["stablecoin", "scoreManager", "collateralVault"]);
      const { provider, address: connected } = address
        ? await (async () => {
            const r = await reader();
            return { provider: r.provider, address: r.address };
          })()
        : await connect();
      const who = address ?? connected;
      if (!who) throw new Error("No address to read credit for.");

      const token = new Contract(c.stablecoin, ERC20, provider);
      const scores = new Contract(c.scoreManager, SCORES, provider);
      const vault = new Contract(c.collateralVault, VAULT, provider);

      const [decimals, symbol, score, limit, base, locked, boost, free] = await Promise.all([
        tokenDecimals(provider),
        token.symbol(),
        scores.scoreOf(who),
        scores.creditLimitOf(who),
        scores.baseLimitOf(who),
        vault.lockedOf(who),
        vault.creditBoostOf(who),
        vault.withdrawable(who),
      ]);

      const fmt = (v: bigint) => formatUnits(v, decimals);
      return {
        address: who,
        score: Number(score),
        limit: fmt(limit),
        baseLimit: fmt(base),
        collateralLocked: fmt(locked),
        collateralBoost: fmt(boost),
        withdrawable: fmt(free),
        symbol,
      };
    },

    /** Whether this buyer can afford a given order on credit. */
    async canPayLater(amount: string): Promise<{ eligible: boolean; limit: string; symbol: string }> {
      const credit = await api.getCredit();
      return {
        eligible: Number.parseFloat(credit.limit) >= Number.parseFloat(amount),
        limit: credit.limit,
        symbol: credit.symbol,
      };
    },
  };

  return api;
}

export type LegacyMethods = ReturnType<typeof createLegacyMethods>;
