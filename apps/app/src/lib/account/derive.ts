import { HDKey } from "@scure/bip32";
import { entropyToMnemonic, mnemonicToSeedSync } from "@scure/bip39";
// The ".js" is required: @scure/bip39 2.x only exports the path with it.
import { wordlist } from "@scure/bip39/wordlists/english.js";

/**
 * PRF output → BIP-39 entropy (24 words) → BIP-32 seed → m/44'/60'/0'/0/{index}.
 *
 * FROZEN. The path, the wordlist and the BIP-39 step decide every account's
 * address. Changing any of them moves every user's money out of reach. It is
 * the standard Ethereum path, so the same 24 words restore the account in any
 * common wallet (verified against viem's mnemonicToAccount in the research).
 *
 * Polaris uses index 0 only: one Face ID, one account.
 */
export function deriveEvmKey(prfOutput: Uint8Array, index = 0): Uint8Array {
  const seed = mnemonicToSeedSync(entropyToMnemonic(prfOutput, wordlist));
  const root = HDKey.fromMasterSeed(seed);
  const node = root.derive(`m/44'/60'/0'/0/${index}`);
  try {
    const key = node.privateKey; // a copy
    if (key === null) throw new Error("derivation produced no key");
    return key;
  } finally {
    seed.fill(0);
    node.wipePrivateData();
    root.wipePrivateData();
  }
}
