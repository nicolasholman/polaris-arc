import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodeAbiParameters, keccak256, parseAbi, zeroAddress, type Abi, type Address, type Hex, type LocalAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it } from "vitest";

import { polarisSplitAbi } from "@polarispay/contracts/abi";
import { GET as buyerGet } from "@/app/api/public/buyers/[address]/route";
import { GET as splitGet } from "@/app/api/public/splits/[id]/route";
import { POST as relayRoute } from "@/app/api/relay/route";
import { syncChain } from "@/server/ingest/sync";
import { shareNonce, splitIdOf } from "@/server/split";
import { TYPES } from "@/server/relayer/typed-data";

import { ADDR, DEPLOYMENT, json, params, request, setupServer, type TestEnv } from "./helpers/env";
import { makeLog, type LogSpec, type SentTx } from "./helpers/fake-chain";
import { inSeconds, stablecoinDomain } from "./helpers/flows";

/**
 * Split-the-bill links through Polaris for Business: the relayer carries the
 * organiser's CreateSplit and CloseSplit and each friend's share, checking
 * every signature against what PolarisSplit will check, and refusing before
 * any gas what the contract would refuse; the chain sync keeps who paid which
 * share and when; the public API and the organiser's book serve it without
 * ever holding the split's words.
 */

const splitDomain = { name: "PolarisSplit", version: "1", chainId: 31337, verifyingContract: ADDR.split } as const;
const erc20 = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]) as unknown as Abi;
const SPLIT = polarisSplitAbi as unknown as Abi;
const USD = (n: number) => BigInt(Math.round(n * 1e6));

let env: TestEnv;
let ipCounter = 0;
const relay = async (body: unknown) =>
  json(await relayRoute(request("POST", "/api/relay", { body, headers: { "x-forwarded-for": `203.0.113.${(ipCounter++ % 250) + 1}` } }), params({})));
const fresh = () => privateKeyToAccount(generatePrivateKey());
const memoHash = keccak256(encodeAbiParameters([{ type: "string" }, { type: "string" }, { type: "uint256" }, { type: "string[]" }], ["Dinner at Lucia", "Maya", USD(120), ["Sam", "Priya", "Jon"]]));

/** The split the fake chain holds: what splitOf and sharesOf answer. */
type ChainSplit = { organiser: Address; amounts: bigint[]; payers: Address[]; expiresAt: bigint; closed: boolean; memoHash: Hex };
let splits: Map<string, ChainSplit>;

function chainReads() {
  env.chain.reads.splitOf = ([id]) => {
    const s = splits.get(String(id).toLowerCase());
    if (!s) return { organiser: zeroAddress, expiresAt: 0n, shareCount: 0, paidCount: 0, closed: false, total: 0n, paidTotal: 0n, memoHash: `0x${"00".repeat(32)}` };
    const paid = s.payers.map((p, i) => (p === zeroAddress ? 0n : (s.amounts[i] as bigint)));
    return {
      organiser: s.organiser,
      expiresAt: s.expiresAt,
      shareCount: s.amounts.length,
      paidCount: s.payers.filter((p) => p !== zeroAddress).length,
      closed: s.closed,
      total: s.amounts.reduce((a, b) => a + b, 0n),
      paidTotal: paid.reduce((a, b) => a + b, 0n),
      memoHash: s.memoHash,
    };
  };
  env.chain.reads.sharesOf = ([id]) => {
    const s = splits.get(String(id).toLowerCase());
    return s ? [s.amounts, s.payers] : [[], []];
  };
}

/** What PolarisSplit does and emits for each relayed call, on the fake chain. */
function behaveLikePolarisSplit() {
  env.chain.onSend = (_tx: SentTx, fn): LogSpec[] => {
    if (fn.functionName === "createSplit") {
      const [c] = fn.args as [{ organiser: Address; salt: Hex; amounts: readonly bigint[]; memoHash: Hex; expiresAt: bigint }];
      const splitId = splitIdOf(c.organiser, c.salt);
      splits.set(splitId.toLowerCase(), { organiser: c.organiser, amounts: [...c.amounts], payers: c.amounts.map(() => zeroAddress), expiresAt: c.expiresAt, closed: false, memoHash: c.memoHash });
      return [{ address: ADDR.split, abi: SPLIT, eventName: "SplitCreated", args: { splitId, organiser: c.organiser, total: c.amounts.reduce((a, b) => a + b, 0n), amounts: c.amounts, expiresAt: c.expiresAt, memoHash: c.memoHash } }];
    }
    if (fn.functionName === "payShare") {
      const [splitId, index, payer] = fn.args as [Hex, bigint, Address];
      const s = splits.get(splitId.toLowerCase()) as ChainSplit;
      s.payers[Number(index)] = payer;
      const amount = s.amounts[Number(index)] as bigint;
      return [
        { address: ADDR.stablecoin, abi: erc20, eventName: "Transfer", args: { from: payer, to: ADDR.split, value: amount } },
        { address: ADDR.stablecoin, abi: erc20, eventName: "Transfer", args: { from: ADDR.split, to: s.organiser, value: amount } },
        { address: ADDR.split, abi: SPLIT, eventName: "SharePaid", args: { splitId, index, payer, amount, paidCount: BigInt(s.payers.filter((p) => p !== zeroAddress).length), shareCount: BigInt(s.amounts.length) } },
      ];
    }
    if (fn.functionName === "closeSplit") {
      const [splitId] = fn.args as [Hex];
      const s = splits.get(splitId.toLowerCase()) as ChainSplit;
      s.closed = true;
      const paidCount = BigInt(s.payers.filter((p) => p !== zeroAddress).length);
      return [{ address: ADDR.split, abi: SPLIT, eventName: "SplitClosed", args: { splitId, organiser: s.organiser, paidCount, shareCount: BigInt(s.amounts.length) } }];
    }
    return [];
  };
}

beforeEach(() => {
  env = setupServer();
  splits = new Map();
  chainReads();
  behaveLikePolarisSplit();
});

async function signCreate(organiser: LocalAccount, over: Partial<{ amounts: bigint[]; expiresAt: bigint; deadline: bigint; salt: Hex }> = {}, signer: LocalAccount = organiser) {
  const creation = {
    organiser: organiser.address,
    salt: over.salt ?? (generatePrivateKey() as Hex),
    amounts: over.amounts ?? [USD(30), USD(30), USD(30)],
    memoHash,
    expiresAt: over.expiresAt ?? BigInt(inSeconds(14 * 86_400)),
    deadline: over.deadline ?? BigInt(inSeconds(600)),
  };
  const signature = await signer.signTypedData({ domain: splitDomain, types: TYPES.CreateSplit, primaryType: "CreateSplit", message: creation });
  return {
    body: {
      type: "createSplit",
      creation: { ...creation, amounts: creation.amounts.map(String), expiresAt: String(creation.expiresAt), deadline: String(creation.deadline) },
      signature,
    },
    splitId: splitIdOf(organiser.address, creation.salt),
  };
}

async function signShare(friend: LocalAccount, splitId: Hex, index: number, value: bigint, signer: LocalAccount = friend) {
  const validBefore = BigInt(inSeconds(600));
  const signature = await signer.signTypedData({
    domain: stablecoinDomain,
    types: TYPES.ReceiveWithAuthorization,
    primaryType: "ReceiveWithAuthorization",
    message: { from: friend.address, to: ADDR.split, value, validAfter: 0n, validBefore, nonce: shareNonce(splitId, BigInt(index)) },
  });
  return { type: "payShare", splitId, index: String(index), payer: friend.address, validAfter: "0", validBefore: String(validBefore), signature };
}

async function signClose(organiser: LocalAccount, splitId: Hex, ahead = 600) {
  const deadline = BigInt(inSeconds(ahead));
  const signature = await organiser.signTypedData({ domain: splitDomain, types: TYPES.CloseSplit, primaryType: "CloseSplit", message: { splitId, deadline } });
  return { type: "closeSplit", splitId, deadline: String(deadline), signature };
}

const status = async (id: string) => json(await splitGet(request("GET", `/api/public/splits/${id}`), params({ id })));
const book = async (address: string) => (await json(await buyerGet(request("GET", `/api/public/buyers/${address}`), params({ address })))).body.data;

describe("POST /api/relay: split the bill", () => {
  it("carries the organiser's split, each friend's share, and the organiser's close, and the API tells who paid what and when", async () => {
    const maya = fresh();
    const [sam, priya] = [fresh(), fresh()];
    const create = await signCreate(maya);
    const created = await relay(create.body);
    expect(created.status).toBe(200);
    expect(created.body.data).toMatchObject({ type: "createSplit", splitId: create.splitId });
    expect(env.chain.sent.at(-1)).toMatchObject({ to: ADDR.split, functionName: "createSplit", value: 0n });

    const open = await status(create.splitId);
    expect(open.status).toBe(200);
    expect(open.body.data).toMatchObject({ organiser: maya.address, status: "open", shareCount: 3, paidCount: 0, totalUnits: "90000000", memoHash });
    expect(open.body.data.createdTxHash).toMatch(/^0x[0-9a-f]{64}$/);

    const paid = await relay(await signShare(sam, create.splitId, 0, USD(30)));
    expect(paid.status).toBe(200);
    expect(paid.body.data).toMatchObject({ type: "payShare", splitId: create.splitId, shareIndex: "0" });
    const sent = env.chain.sent.at(-1) as SentTx;
    expect(sent.functionName).toBe("payShare");
    expect(sent.args.slice(0, 3)).toEqual([create.splitId, 0n, sam.address]);

    await relay(await signShare(priya, create.splitId, 1, USD(30)));
    const after = (await status(create.splitId)).body.data;
    expect(after).toMatchObject({ status: "open", paidCount: 2, paidUnits: "60000000" });
    expect(after.shares[0]).toMatchObject({ index: 0, amountUnits: "30000000", paid: true, payer: sam.address });
    expect(after.shares[0].paidAt).toEqual(expect.any(String));
    expect(after.shares[0].txHash).toBe(sent.hash);
    expect(after.shares[2]).toMatchObject({ paid: false, payer: null, paidAt: null, txHash: null });

    const closed = await relay(await signClose(maya, create.splitId));
    expect(closed.status).toBe(200);
    const final = (await status(create.splitId)).body.data;
    expect(final.status).toBe("closed");
    expect(final.closedAt).toEqual(expect.any(String));

    // The organiser's book lists the split; its words were never sent here.
    const mine = await book(maya.address);
    expect(mine.splits).toHaveLength(1);
    expect(mine.splits[0]).toMatchObject({ id: create.splitId, status: "closed", paidCount: 2, shareCount: 3 });
    const text = JSON.stringify(mine);
    for (const word of ["Dinner", "Lucia", "Sam", "Priya"]) expect(text).not.toContain(word);
  });

  it("refuses a split the organiser didn't sign, dust shares, too many shares and an expiry out of range, sending nothing", async () => {
    const maya = fresh();
    const cases = [
      [(await signCreate(maya, {}, fresh())).body, 400, "invalid_signature"],
      [(await signCreate(maya, { amounts: [USD(30), 99_999n] })).body, 400, "invalid_request"],
      [(await signCreate(maya, { amounts: Array(51).fill(USD(1)) })).body, 400, "invalid_request"],
      [(await signCreate(maya, { expiresAt: BigInt(inSeconds(61 * 86_400)) })).body, 400, "invalid_request"],
      [(await signCreate(maya, { expiresAt: BigInt(inSeconds(60)) })).body, 400, "invalid_request"],
      [(await signCreate(maya, { deadline: BigInt(inSeconds(3 * 3600)) })).body, 400, "invalid_request"],
    ] as const;
    for (const [body, code, error] of cases) {
      const res = await relay(body);
      expect(res.status, JSON.stringify(res.body)).toBe(code);
      expect(res.body.error.code).toBe(error);
    }
    expect(env.chain.sent).toHaveLength(0);
  });

  it("answers a retried create with the first transaction, and refuses a different request for a split that is already open", async () => {
    const maya = fresh();
    const salt = generatePrivateKey() as Hex;
    const create = await signCreate(maya, { salt });
    const first = await relay(create.body);
    const again = await relay(create.body);
    expect(again.body.data.txHash).toBe(first.body.data.txHash);
    const other = await signCreate(maya, { salt, amounts: [USD(10)] });
    const clash = await relay(other.body);
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe("split_exists");
    expect(env.chain.sent.filter((t) => t.functionName === "createSplit")).toHaveLength(1);
  });

  it("refuses a share for the wrong amount, from the wrong signer, already paid, closed or expired, before any gas", async () => {
    const maya = fresh();
    const [sam, priya] = [fresh(), fresh()];
    const create = await signCreate(maya, { amounts: [USD(30), USD(20)] });
    await relay(create.body);
    const before = env.chain.sent.length;

    const overpay = await relay(await signShare(sam, create.splitId, 0, USD(31)));
    expect([overpay.status, overpay.body.error.code]).toEqual([400, "invalid_signature"]);
    const wrongSigner = await relay(await signShare(sam, create.splitId, 0, USD(30), priya));
    expect([wrongSigner.status, wrongSigner.body.error.code]).toEqual([400, "invalid_signature"]);
    // A signature for share 0 offered as share 1: the nonce names the share.
    const moved = { ...(await signShare(sam, create.splitId, 0, USD(20))), index: "1" };
    expect((await relay(moved)).body.error.code).toBe("invalid_signature");
    const unknown = await relay(await signShare(sam, `0x${"12".repeat(32)}`, 0, USD(30)));
    expect([unknown.status, unknown.body.error.code]).toEqual([404, "split_not_found"]);
    expect(env.chain.sent.length).toBe(before);

    await relay(await signShare(sam, create.splitId, 0, USD(30)));
    const twice = await relay(await signShare(priya, create.splitId, 0, USD(30)));
    expect([twice.status, twice.body.error.code]).toEqual([409, "already_paid"]);

    (splits.get(create.splitId.toLowerCase()) as ChainSplit).closed = true;
    const closed = await relay(await signShare(priya, create.splitId, 1, USD(20)));
    expect([closed.status, closed.body.error.code]).toEqual([409, "split_closed"]);
    (splits.get(create.splitId.toLowerCase()) as ChainSplit).closed = false;
    (splits.get(create.splitId.toLowerCase()) as ChainSplit).expiresAt = BigInt(inSeconds(-1));
    const expired = await relay(await signShare(priya, create.splitId, 1, USD(20)));
    expect([expired.status, expired.body.error.code]).toEqual([410, "split_expired"]);
    expect(env.chain.sent.filter((t) => t.functionName === "payShare")).toHaveLength(1);
  });

  it("lets only the organiser close a split, once", async () => {
    const maya = fresh();
    const create = await signCreate(maya);
    await relay(create.body);
    const stranger = await relay(await signClose(fresh(), create.splitId));
    expect([stranger.status, stranger.body.error.code]).toEqual([400, "invalid_signature"]);
    const first = await signClose(maya, create.splitId);
    expect((await relay(first)).status).toBe(200);
    // The same signature again is a retry: it answers with the first transaction.
    expect((await relay(first)).status).toBe(200);
    // A fresh close for a closed split is refused before any gas.
    const again = await relay(await signClose(maya, create.splitId, 700));
    expect([again.status, again.body.error.code]).toEqual([409, "split_closed"]);
  });

  it("says split links aren't on this network when the deployment predates PolarisSplit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polaris-split-"));
    const file = join(dir, "deployment.json");
    copyFileSync(DEPLOYMENT, file);
    const record = JSON.parse(readFileSync(file, "utf8"));
    delete record.contracts.PolarisSplit;
    writeFileSync(file, JSON.stringify(record));
    env = setupServer({ POLARIS_DEPLOYMENT_FILE: file });
    const res = await relay((await signCreate(fresh())).body);
    expect([res.status, res.body.error.code]).toEqual([503, "split_unavailable"]);
    expect(env.chain.sent).toHaveLength(0);
  });
});

describe("the chain sync and the activity it feeds", () => {
  it("records a split it never saw relayed (from the chain's logs), and each share as it lands", async () => {
    process.env.POLARIS_SYNC_FROM_BLOCK = "0";
    try {
      const organiser = fresh().address;
      const payer = fresh().address;
      const splitId = `0x${"ab".repeat(32)}` as Hex;
      splits.set(splitId, { organiser, amounts: [USD(12), USD(8)], payers: [zeroAddress, zeroAddress], expiresAt: BigInt(inSeconds(86_400)), closed: false, memoHash });
      const push = (block: number, tx: Hex, specs: LogSpec[]) => specs.forEach((spec, i) => env.chain.logs.push(makeLog(spec, { txHash: tx, logIndex: i, blockNumber: BigInt(block) })));
      push(101, `0x${"01".repeat(32)}`, [{ address: ADDR.split, abi: SPLIT, eventName: "SplitCreated", args: { splitId, organiser, total: USD(20), amounts: [USD(12), USD(8)], expiresAt: BigInt(inSeconds(86_400)), memoHash } }]);
      (splits.get(splitId) as ChainSplit).payers[1] = payer;
      push(102, `0x${"02".repeat(32)}`, [{ address: ADDR.split, abi: SPLIT, eventName: "SharePaid", args: { splitId, index: 1n, payer, amount: USD(8), paidCount: 1n, shareCount: 2n } }]);
      env.chain.blockNumber = 110n;
      await syncChain();
      const view = (await status(splitId)).body.data;
      expect(view).toMatchObject({ organiser, paidCount: 1, createdTxHash: `0x${"01".repeat(32)}` });
      expect(view.shares[1]).toMatchObject({ paid: true, payer, txHash: `0x${"02".repeat(32)}` });
      expect((await book(organiser)).splits.map((s: { id: string }) => s.id)).toEqual([splitId]);
    } finally {
      delete process.env.POLARIS_SYNC_FROM_BLOCK;
    }
  });

  it("names a share in both books: split-paid for the friend, split-received for the organiser, with the split and the share", async () => {
    const maya = fresh();
    const sam = fresh();
    const create = await signCreate(maya, { amounts: [USD(25)] });
    await relay(create.body);
    await relay(await signShare(sam, create.splitId, 0, USD(25)));

    const friend = await book(sam.address);
    expect(friend.moves.map((m: { kind: string; direction: string; amountUnits: string }) => [m.kind, m.direction, m.amountUnits])).toEqual([["split-paid", "out", "25000000"]]);
    expect(friend.moves[0]).toMatchObject({ splitId: create.splitId.toLowerCase(), shareIndex: 0 });
    const organiser = await book(maya.address);
    expect(organiser.moves.map((m: { kind: string; direction: string }) => [m.kind, m.direction])).toEqual([["split-received", "in"]]);
    expect(organiser.moves[0]).toMatchObject({ splitId: create.splitId.toLowerCase(), shareIndex: 0 });
  });

  it("answers 400 for a malformed id and 404 for an unknown split", async () => {
    expect((await status("0x1234")).status).toBe(400);
    const missing = await status(`0x${"cd".repeat(32)}`);
    expect([missing.status, missing.body.error.code]).toEqual([404, "split_not_found"]);
  });
});
