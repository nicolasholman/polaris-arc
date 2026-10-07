"use client";

import { useEffect, useState } from "react";
import type { Address } from "viem";
import { BridgeError, connectWallet, injectedProvider, switchToSource, walletChainId } from "@/lib/cctp";
import type { CctpSource } from "@/lib/network";

export type InjectedWallet = { address: Address; chainId: number };

/**
 * The buyer's browser wallet while a cross-chain sheet is open: connect it,
 * follow its account and network, switch it to a source chain. Errors come
 * back as the wallet's plain message for the sheet to show.
 */
export function useInjectedWallet(open: boolean) {
  const [wallet, setWallet] = useState<InjectedWallet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hasWallet = typeof window !== "undefined" && injectedProvider() !== null;

  useEffect(() => {
    const provider = injectedProvider();
    if (!open || !provider?.on) return;
    const onChain = (id: string) => setWallet((w) => (w ? { ...w, chainId: Number(id) } : w));
    const onAccounts = (accounts: string[]) => setWallet((w) => (accounts[0] && w ? { ...w, address: accounts[0] as Address } : null));
    provider.on("chainChanged", onChain);
    provider.on("accountsChanged", onAccounts);
    return () => {
      provider.removeListener?.("chainChanged", onChain);
      provider.removeListener?.("accountsChanged", onAccounts);
    };
  }, [open]);

  const message = (e: unknown) => (e instanceof BridgeError ? e.message : "Something went wrong in the wallet. Nothing was moved.");

  async function connect(): Promise<InjectedWallet | null> {
    setError(null);
    try {
      const w = await connectWallet();
      setWallet(w);
      return w;
    } catch (e) {
      setError(message(e));
      return null;
    }
  }

  async function switchTo(source: CctpSource): Promise<boolean> {
    setError(null);
    try {
      await switchToSource(source);
      const id = await walletChainId().catch(() => source.chainId);
      setWallet((w) => (w ? { ...w, chainId: id } : w));
      return id === source.chainId;
    } catch (e) {
      setError(message(e));
      return false;
    }
  }

  return { wallet, hasWallet, error, setError, fail: (e: unknown) => setError(message(e)), connect, switchTo };
}
