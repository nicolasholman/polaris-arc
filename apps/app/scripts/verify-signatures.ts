/**
 * Checks src/lib/sign against the contracts' own definitions, with no chain.
 *
 *   pnpm --filter @polaris/app check:signatures
 *
 * For every struct it verifies that:
 *   1. the typehash preimage in the contract's Solidity source (read from the
 *      file, e.g. `keccak256("Claim(address to,uint256 deadline)")`) equals
 *      the app's string, and the app's field list encodes to exactly it;
 *   2. the digest viem signs equals the one the contract computes by hand,
 *      keccak256(0x1901 ‖ domainSeparator ‖ keccak256(abi.encode(TYPEHASH, ...fields)));
 *   3. a signature from the builder recovers to its signer.
 * It also pins the nonce derivations (a payment, a send link, a split's
 * share), the split id, and the ERC-5267 field filtering.
 *
 * The sources come from packages/contracts/contracts. A contract that isn't in
 * this checkout yet (PolarisCheckout lives on its own branch until it merges)
 * is read from git: the refs in POLARIS_CONTRACTS_REFS (comma separated),
 * metropolis/checkout and then metropolis/api by default. A contract found
 * nowhere fails the check.
 *
 * Runs on Node 22.18+ (built-in TypeScript type stripping).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  type Address,
  concat,
  encodeAbiParameters,
  getAddress,
  hashTypedData,
  type Hex,
  keccak256,
  numberToHex,
  pad,
  recoverTypedDataAddress,
  stringToBytes,
  toHex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  buildCancel,
  buildCancelSubscription,
  buildClaim,
  buildCloseSplit,
  buildCreateSplit,
  buildOpen,
  buildPermit,
  buildPlanIntent,
  buildReceiveWithAuthorization,
  buildRepayIntent,
  buildSubscribeIntent,
  buildTransferWithAuthorization,
  buildWithdraw,
  domainFromErc5267,
  type Eip712Domain,
  paymentNonce,
  sendNonce,
  shareNonce,
  splitIdOf,
  TYPE_REGISTRY,
} from "../src/lib/sign/index.ts";

let passed = 0;
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  ok  ${name}`);
    });
}

const merchant: Address = getAddress("0x1111111111111111111111111111111111111111");
const buyer = privateKeyToAccount(generatePrivateKey());
const domain: Eip712Domain = {
  name: "Polaris Test",
  version: "1",
  chainId: 10143,
  verifyingContract: getAddress("0x2222222222222222222222222222222222222222"),
};

/** OpenZeppelin EIP712._buildDomainSeparator, written out independently of viem. */
const ozDomainSeparator = keccak256(
  encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
    [
      keccak256(
        stringToBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
      ),
      keccak256(stringToBytes(domain.name!)),
      keccak256(stringToBytes(domain.version!)),
      BigInt(domain.chainId!),
      domain.verifyingContract!,
    ],
  ),
);

/* ── The contracts' own typehash strings ─────────────────────────────────── */

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const contractsDir = resolve(repo, "packages/contracts/contracts");
const REFS = (process.env.POLARIS_CONTRACTS_REFS ?? "metropolis/checkout,metropolis/api")
  .split(",")
  .map((r) => r.trim())
  .filter(Boolean);

type Source = { text: string; from: string };
const sources = new Map<string, Source>();

/** A Solidity file's text: this checkout first, then the git refs above. */
function solidity(file: string): Source {
  const cached = sources.get(file);
  if (cached) return cached;
  let found: Source | null = null;
  if (file.startsWith("@openzeppelin/")) {
    const path = resolve(repo, "packages/contracts/node_modules", file);
    if (existsSync(path)) found = { text: readFileSync(path, "utf8"), from: "packages/contracts/node_modules" };
  } else {
    const path = resolve(contractsDir, file);
    if (existsSync(path)) found = { text: readFileSync(path, "utf8"), from: "this checkout" };
    for (const ref of found ? [] : REFS) {
      try {
        const text = execFileSync("git", ["show", `${ref}:packages/contracts/contracts/${file}`], {
          cwd: repo,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
        found = { text, from: `git ${ref}` };
        break;
      } catch {
        /* not on this ref */
      }
    }
  }
  assert.ok(found, `${file} wasn't found in packages/contracts or on ${REFS.join(", ")}`);
  sources.set(file, found);
  return found;
}

/** The string inside `bytes32 ... NAME = keccak256("...")`, across line breaks. */
function typehashPreimage(file: string, constant: string): { preimage: string; from: string } {
  const { text, from } = solidity(file);
  const pattern = new RegExp(
    String.raw`bytes32\s+(?:(?:public|private|internal)\s+)?constant\s+` + constant + String.raw`\s*=\s*keccak256\(\s*"([^"]+)"\s*\)`,
  );
  const match = pattern.exec(text);
  assert.ok(match, `${constant} isn't declared as keccak256("...") in ${file}`);
  return { preimage: match[1]!, from };
}

// 1. encodeType strings, against the Solidity source
for (const entry of TYPE_REGISTRY) {
  await check(`${entry.primaryType} matches ${entry.contract.split("/").pop()} ${entry.constant}`, () => {
    const { preimage, from } = typehashPreimage(entry.contract, entry.constant);
    assert.equal(entry.solidity, preimage, `the app's ${entry.primaryType} differs from the contract (read from ${from})`);
    const fields = (entry.types as Record<string, readonly { name: string; type: string }[]>)[entry.primaryType];
    assert.ok(fields, "field list present");
    const encoded = `${entry.primaryType}(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`;
    assert.equal(encoded, preimage);
  });
}

/**
 * EIP-712 encodeData for one field: dynamic `string` and `bytes` are
 * hashed, and an array of atoms is the hash of its elements, each padded to a
 * word (Solidity's keccak256(abi.encodePacked(array))).
 */
function encodeField(type: string, value: unknown): { type: string; value: unknown } {
  if (type === "string") return { type: "bytes32", value: keccak256(stringToBytes(value as string)) };
  if (type === "bytes") return { type: "bytes32", value: keccak256(value as Hex) };
  if (/^u?int\d*\[\]$/.test(type)) return { type: "bytes32", value: keccak256(concat((value as bigint[]).map((v) => pad(numberToHex(v))))) };
  return { type, value };
}

// 2 + 3. digests and recovery for every builder
const now = 1_790_000_000n;
const cases = [
  buildPlanIntent(domain, {
    buyer: buyer.address,
    merchant,
    principal: 200_000_000n,
    installments: 4,
    interval: 604_800n,
    orderId: "SOL-2026-0142",
    nonce: 0n,
    deadline: now + 900n,
  }),
  buildSubscribeIntent(domain, {
    buyer: buyer.address,
    merchant,
    planId: 7n,
    pricePerPeriod: 29_000_000n,
    periodSeconds: 2_592_000n,
    orderId: "KIN-M-5512",
    nonce: 1n,
    deadline: now + 900n,
  }),
  buildReceiveWithAuthorization(domain, {
    from: buyer.address,
    to: merchant,
    value: 200_000_000n,
    validAfter: 0n,
    validBefore: now + 600n,
    nonce: paymentNonce(merchant, "SOL-2026-0142"),
  }),
  buildTransferWithAuthorization(domain, {
    from: buyer.address,
    to: merchant,
    value: 5_000_000n,
    validAfter: 0n,
    validBefore: now + 600n,
    nonce: keccak256(toHex("transfer")),
  }),
  buildPermit(domain, { owner: buyer.address, spender: merchant, value: 201_534_246n, nonce: 3n, deadline: now }),
  buildOpen(domain, { sender: buyer.address, amount: 50_000_000n, expiresAt: now + 604_800n }),
  buildClaim(domain, { to: buyer.address, deadline: now + 600n }),
  buildCancel(domain, { linkKey: merchant, deadline: now }),
  buildCancelSubscription(domain, { subId: 12n, deadline: now }),
  buildRepayIntent(domain, { loanId: 3n, amount: 151_150_684n, expectedRepaid: 50_383_562n, nonce: 0n, deadline: now + 600n }),
  buildCreateSplit(domain, {
    organiser: buyer.address,
    salt: keccak256(toHex("salt")),
    amounts: [30_000_000n, 30_000_000n, 30_000_001n],
    memoHash: keccak256(toHex("Dinner at Lucia")),
    expiresAt: now + 1_209_600n,
    deadline: now + 600n,
  }),
  buildCloseSplit(domain, { splitId: keccak256(toHex("split")), deadline: now + 600n }),
  buildWithdraw(domain, { borrower: buyer.address, amount: 25_000_000n, nonce: 2n, deadline: now + 600n }),
] as const;

for (const typed of cases) {
  await check(`${typed.primaryType} digest equals the contract's _hashTypedDataV4`, () => {
    const entry = TYPE_REGISTRY.find((e) => e.primaryType === typed.primaryType);
    assert.ok(entry);
    const fields = (entry.types as Record<string, readonly { name: string; type: string }[]>)[entry.primaryType]!;
    const message = typed.message as Record<string, unknown>;
    const encoded = fields.map((f) => encodeField(f.type, message[f.name]));
    const structHash = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, ...encoded.map((e) => ({ type: e.type }))],
        [keccak256(stringToBytes(entry.solidity)), ...encoded.map((e) => e.value)],
      ),
    );
    const expected = keccak256(concat(["0x1901", ozDomainSeparator, structHash]));
    assert.equal(hashTypedData(typed as Parameters<typeof hashTypedData>[0]), expected);
  });
  await check(`${typed.primaryType} signature recovers to the signer`, async () => {
    const signature = await buyer.signTypedData(typed as Parameters<typeof buyer.signTypedData>[0]);
    const recovered = await recoverTypedDataAddress({
      ...(typed as Parameters<typeof hashTypedData>[0]),
      signature,
    });
    assert.equal(recovered, buyer.address);
  });
}

// Nonces
await check("payment nonce is keccak256(abi.encodePacked(merchant, orderId))", () => {
  const packed: Hex = concat([merchant, toHex(stringToBytes("ORD-1"))]);
  assert.equal(paymentNonce(merchant, "ORD-1"), keccak256(packed));
});

await check("send nonce is keccak256(abi.encode(linkKey, uint64 expiresAt))", () => {
  const expiresAt = 1_790_604_800n;
  const encoded: Hex = concat([pad(merchant), pad(numberToHex(expiresAt))]);
  assert.equal(sendNonce(merchant, expiresAt), keccak256(encoded));
});

await check("share nonce is keccak256(abi.encode(bytes32 splitId, uint256 index))", () => {
  const splitId = keccak256(toHex("split"));
  assert.equal(shareNonce(splitId, 2n), keccak256(concat([splitId, pad(numberToHex(2n))])));
});

await check("split id is keccak256(abi.encode(organiser, bytes32 salt))", () => {
  const salt = keccak256(toHex("salt"));
  assert.equal(splitIdOf(merchant, salt), keccak256(concat([pad(merchant), salt])));
});

await check("ERC-5267 fields 0x0f drop the unused salt", () => {
  const d = domainFromErc5267(
    { name: "AUSD", version: "1", chainId: 10143, verifyingContract: merchant, salt: pad("0x0") },
    "0x0f",
  );
  assert.deepEqual(Object.keys(d).sort(), ["chainId", "name", "verifyingContract", "version"]);
});

// The contracts' own struct list, which their suite checks against every typehash on chain.
const contracts = createRequire(import.meta.url)("../../../packages/contracts/lib/eip712.js") as {
  TYPES: Record<string, Record<string, { name: string; type: string }[]>>;
  typeString: (primary: string, fields: { name: string; type: string }[]) => string;
};
const onChain: Record<string, { name: string; type: string }[]> = Object.assign({}, ...Object.values(contracts.TYPES));
for (const entry of TYPE_REGISTRY) {
  await check(`${entry.primaryType} is the struct packages/contracts signs`, () => {
    const fields = onChain[entry.primaryType];
    assert.ok(fields, `packages/contracts/lib/eip712.js defines ${entry.primaryType}`);
    assert.equal(entry.solidity, contracts.typeString(entry.primaryType, fields));
  });
}

console.log(`\n${passed} checks passed`);
