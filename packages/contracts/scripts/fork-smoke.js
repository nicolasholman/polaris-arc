/**
 * The money paths against Agora's real AUSD, on a local fork of Monad
 * testnet, against deployments/monad-fork.json:
 *
 *   pnpm --filter @polarispay/contracts fork:smoke
 *
 * after `deploy:fork` and `fund-pool:fork` (README, "Rehearse real AUSD on a
 * fork"). Prints one PASS or FAIL line per step, and exits 1 on a failure;
 * the steps after a failure are skipped, since each builds on the last.
 *
 * Every buyer, sender, friend and recipient is a fresh wallet that never
 * holds MON; their AUSD comes from Agora's faucet. Each signs with the domain
 * AUSD itself reports (eip712Domain: "Agora Dollar", version "1", chain
 * 10143), and a relayer account submits. The two CRE reports (underwriting,
 * collections) are hand-built, as in e2e:local, and delivered through
 * Chainlink's own MockKeystoneForwarder as it stands on testnet, by the
 * recorded simulation transmitter. No CRE workflow, DON or Nansen call runs.
 *
 * A report's gas limit is the gas a traced delivery uses when the receiver
 * succeeds, plus 15% (`deliveryGas`). Not eth_estimateGas: Chainlink's mock
 * forwarder catches the receiver's revert, and its catch costs little, so an
 * estimate settles where the receiver runs out of gas inside the catch and
 * the delivery still "succeeds" (ReportProcessed with result false). The
 * collections report here was refused that way at estimate + 15%.
 *
 * Fork only: lib/fork.js refuses any node that is not a local fork, since
 * this moves the fork's clock and asks the faucet freely.
 */

"use strict";

const hre = require("hardhat");
const { ethers } = hre;
const { Wallet, Signature, AbiCoder, hexlify, randomBytes, keccak256, formatUnits, getAddress, toQuantity } = require("ethers");

const { TYPES, AUSD_DOMAIN_NAME, readDomain } = require("../lib/eip712");
const { MONAD_TESTNET } = require("../lib/deploy");
const { requireForkNode, travel, dripUntil } = require("../lib/fork");
const cre = require("../lib/cre");
const tx = require("../lib/tx");
const { deploymentFile, FORK_NETWORKS } = require("./deploy-monad");

const USD = (n) => ethers.parseUnits(String(n), 6);
const $ = (v) => `$${Number(formatUnits(v, 6)).toFixed(2)}`;
const WEEK = 7n * 24n * 3600n;

let failed = 0;
let skipped = 0;
let passed = 0;

/** Run one step: PASS with its detail, or FAIL with why; once one fails, skip the rest. */
async function step(name, fn) {
  if (failed) {
    skipped += 1;
    console.log(`SKIP  ${name}`);
    return;
  }
  try {
    const detail = await fn();
    passed += 1;
    console.log(`PASS  ${name}${detail ? `: ${detail}` : ""}`);
  } catch (e) {
    failed += 1;
    console.log(`FAIL  ${name}: ${e.shortMessage ?? e.message ?? e}`);
  }
}

function expect(ok, why) {
  if (!ok) throw new Error(why);
}

function events(receipt, contract, name) {
  return receipt.logs
    .filter((l) => l.address.toLowerCase() === contract.target.toLowerCase())
    .map((l) => {
      try {
        return contract.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .filter((e) => e && e.name === name);
}

async function now() {
  return BigInt((await ethers.provider.getBlock("latest")).timestamp);
}

/**
 * Gas for `forwarder.report(...args)` from `from`, measured on the path where
 * the receiver succeeds: a traced call with room to spare, plus 15%. Throws
 * if the receiver refuses the report even then.
 */
async function deliveryGas(forwarder, from, args) {
  const data = forwarder.interface.encodeFunctionData("report", args);
  const trace = await ethers.provider.send("debug_traceCall", [
    { from, to: forwarder.target, data, gas: toQuantity(5_000_000) },
    "latest",
    { tracer: "callTracer" },
  ]);
  const processed = forwarder.interface.getEvent("ReportProcessed").topicHash;
  const delivered = (trace.logs ?? []).some((l) => l.topics?.[0] === processed && BigInt(l.data) === 1n);
  const route = (trace.calls ?? []).find((c) => c.to?.toLowerCase() === forwarder.target.toLowerCase());
  if (route && BigInt(route.output ?? "0x0") !== 1n && !delivered) throw new Error("the receiver refuses this report at any gas");
  return tx.withHeadroom(BigInt(trace.gasUsed));
}

async function main() {
  if (!FORK_NETWORKS.has(hre.network.name)) throw new Error("fork:smoke runs on --network monadFork only.");
  const d = require(`../deployments/${deploymentFile(hre.network.name)}`);
  const at = (name) => ethers.getContractAt(name, d.contracts[name].address);
  const [deployer, , relayer] = await ethers.getSigners();

  const token = await ethers.getContractAt("MockAUSD", d.contracts.Stablecoin.address); // same 2612/3009/5267 surface
  const checkout = (await at("PolarisCheckout")).connect(relayer);
  const engine = await at("PolarisLoanEngine");
  const payments = await at("PolarisPayments");
  const send = (await at("PolarisSend")).connect(relayer);
  const split = (await at("PolarisSplit")).connect(relayer);
  const scores = await at("ScoreManager");
  const collections = await at("CollectionsReceiver");
  const underwriting = await at("UnderwritingReceiver");
  const merchant = d.demo.merchant;
  const treasury = d.config.treasury;
  const feeBps = BigInt(d.config.feeBps);

  // Fresh, gasless people.
  const buyer = Wallet.createRandom().connect(ethers.provider);
  const history = Wallet.createRandom();
  const sender = Wallet.createRandom().connect(ethers.provider);
  const organiser = Wallet.createRandom();
  const claimant = Wallet.createRandom();
  const people = [buyer, sender, organiser, claimant];

  let tokenDomain;
  let loanId;
  let quote;
  let linkKey;
  const sendAmount = USD(50);

  console.log(`Polaris on real AUSD, local fork of Monad testnet (${d.network}, chain ${d.chainId})`);
  console.log(`  record     ${deploymentFile(hre.network.name)}`);
  console.log(`  buyer      ${buyer.address}`);
  console.log(`  merchant   ${merchant}`);
  console.log(`  relayer    ${relayer.address}\n`);

  let transmitter;
  let forwarder;
  const report = async (receiver, body, workflowName) => {
    const raw = cre.encodeRawReport({
      body,
      workflowName,
      workflowOwner: transmitter.address,
      executionId: hexlify(randomBytes(32)),
      timestamp: Number(await now()),
    });
    const args = [receiver, raw, "0x", []];
    const gasLimit = await deliveryGas(forwarder, transmitter.address, args);
    const receipt = await (await forwarder.report(...args, { gasLimit })).wait();
    const [processed] = events(receipt, forwarder, "ReportProcessed");
    expect(processed, "the forwarder emitted no ReportProcessed");
    expect(processed.args.result, `the receiver refused the report (gas ${receipt.gasUsed} of ${gasLimit})`);
    return receipt;
  };

  await step("the node is a local fork of Monad testnet", async () => {
    const info = await requireForkNode(ethers.provider);
    return `${info.kind}, forked from ${info.forkUrl} at block ${info.forkBlock}, chain 10143`;
  });

  await step(`the stablecoin is Agora's AUSD: 6 decimals, EIP-712 domain "Agora Dollar" v1 on chain 10143`, async () => {
    expect(d.contracts.Stablecoin.kind === "AUSD", `the record's stablecoin is ${d.contracts.Stablecoin.kind}, not AUSD`);
    expect(getAddress(token.target) === getAddress(MONAD_TESTNET.AUSD), `the stablecoin is ${token.target}, not ${MONAD_TESTNET.AUSD}`);
    tokenDomain = await readDomain(token);
    expect(tokenDomain.name === AUSD_DOMAIN_NAME.name && tokenDomain.version === AUSD_DOMAIN_NAME.version, `domain ${tokenDomain.name} v${tokenDomain.version}`);
    expect(Number(tokenDomain.chainId) === 10143 && tokenDomain.salt === undefined, "domain chain id or salt");
    expect(Number(await token.decimals()) === 6, "decimals");
    return `${await token.name()} at ${token.target}`;
  });

  await step("the credit pool holds real AUSD from Agora's faucet", async () => {
    const pool = await token.balanceOf(engine.target);
    expect(pool >= USD(1_000), `the pool holds ${$(pool)}; run fund-pool:fork`);
    return `${$(pool)} in PolarisLoanEngine`;
  });

  await step("Agora's faucet pays a fresh buyer and a fresh sender (the fork's clock moved past its cooldown)", async () => {
    let drips = 0;
    for (const w of [buyer, sender]) {
      drips += await dripUntil({ provider: ethers.provider, signer: deployer, token, to: w.address, target: USD(1_000) });
    }
    return `${drips} drips; buyer ${$(await token.balanceOf(buyer.address))}, sender ${$(await token.balanceOf(sender.address))}`;
  });

  await step("an underwriting report through Chainlink's MockKeystoneForwarder (on the fork) opens the buyer's credit line", async () => {
    forwarder = await ethers.getContractAt("MockKeystoneForwarder", d.cre.forwarder);
    expect((await forwarder.typeAndVersion()) === "MockKeystoneForwarder 1.0.0", "the recorded forwarder is not Chainlink's mock");
    await ethers.provider.send("anvil_impersonateAccount", [d.cre.simulationTransmitter]);
    transmitter = await ethers.getSigner(d.cre.simulationTransmitter);
    forwarder = forwarder.connect(transmitter);
    const facts = {
      walletAgeDays: 730,
      txCount: 1_200,
      stableBalance: USD(2_500),
      defiTenureDays: 400,
      priorLiquidations: 0,
      relatedWallets: 1,
      exchangeFunded: true,
      observedAt: await now(),
    };
    const receipt = await report(
      underwriting.target,
      cre.encodeUnderwritingReport([{ user: buyer.address, linkedWallet: history.address, facts }]),
      cre.WORKFLOW_NAMES.UNDERWRITING
    );
    const [applied] = events(receipt, underwriting, "UnderwritingApplied");
    expect(applied, "no UnderwritingApplied");
    return `score ${applied.args.score}, line ${$(await scores.creditLimitOf(buyer.address))}`;
  });

  await step("Pay now: an AUSD ReceiveWithAuthorization relayed through PolarisCheckout.pay pays the merchant $25 less the 0.5% fee", async () => {
    const amount = USD(25);
    const order = `fork-now-${hexlify(randomBytes(6))}`;
    const t = await now();
    const auth = Signature.from(
      await buyer.signTypedData(tokenDomain, { ReceiveWithAuthorization: TYPES.Stablecoin.ReceiveWithAuthorization }, {
        from: buyer.address,
        to: payments.target,
        value: amount,
        validAfter: 0,
        validBefore: t + 1800n,
        nonce: await checkout.orderKeyOf(merchant, order),
      })
    );
    const before = await Promise.all([buyer.address, merchant, treasury].map((a) => token.balanceOf(a)));
    await tx.send(checkout, "pay", [buyer.address, merchant, amount, order, 0, t + 1800n, auth.v, auth.r, auth.s]);
    const after = await Promise.all([buyer.address, merchant, treasury].map((a) => token.balanceOf(a)));
    const fee = (amount * feeBps) / 10_000n;
    expect(before[0] - after[0] === amount, `buyer paid ${$(before[0] - after[0])}`);
    expect(after[1] - before[1] === amount - fee, `merchant got ${$(after[1] - before[1])}`);
    expect(after[2] - before[2] === fee, `treasury got ${$(after[2] - before[2])}`);
    return `buyer -${$(amount)}, merchant +${formatUnits(amount - fee, 6)}, treasury +${formatUnits(fee, 6)}`;
  });

  await step(`AUSD refuses the same authorization signed for domain version "2"`, async () => {
    const amount = USD(5);
    const order = `fork-wrong-domain-${hexlify(randomBytes(6))}`;
    const t = await now();
    const auth = Signature.from(
      await buyer.signTypedData({ ...tokenDomain, version: "2" }, { ReceiveWithAuthorization: TYPES.Stablecoin.ReceiveWithAuthorization }, {
        from: buyer.address,
        to: payments.target,
        value: amount,
        validAfter: 0,
        validBefore: t + 1800n,
        nonce: await checkout.orderKeyOf(merchant, order),
      })
    );
    const outcome = await checkout.pay
      .staticCall(buyer.address, merchant, amount, order, 0, t + 1800n, auth.v, auth.r, auth.s)
      .then(() => "accepted", (e) => e.shortMessage ?? e.message);
    expect(outcome !== "accepted", "AUSD accepted a signature for the wrong domain");
    return "reverted";
  });

  await step("Pay in 4: an AUSD ERC-2612 permit to PolarisLoanEngine and a PlanIntent open a $200 plan; the merchant gets $200 from the pool", async () => {
    const principal = USD(200);
    quote = await checkout.quotePlan(buyer.address, principal, 4, WEEK);
    const t = await now();
    const permit = Signature.from(
      await buyer.signTypedData(tokenDomain, { Permit: TYPES.Stablecoin.Permit }, {
        owner: buyer.address,
        spender: engine.target,
        value: quote.permitValue,
        nonce: await token.nonces(buyer.address),
        deadline: t + 1800n,
      })
    );
    const intent = {
      buyer: buyer.address,
      merchant,
      principal,
      installments: 4,
      interval: WEEK,
      orderId: `fork-plan-${hexlify(randomBytes(6))}`,
      nonce: await checkout.nonces(buyer.address),
      deadline: t + 600n,
    };
    const intentSig = await buyer.signTypedData(await readDomain(checkout), { PlanIntent: TYPES.PolarisCheckout.PlanIntent }, intent);
    const merchantBefore = await token.balanceOf(merchant);
    const poolBefore = await token.balanceOf(engine.target);
    const receipt = await tx.send(checkout, "openPlan", [
      intent,
      intentSig,
      { value: quote.permitValue, deadline: t + 1800n, v: permit.v, r: permit.r, s: permit.s },
    ]);
    [{ args: { loanId } }] = events(receipt, checkout, "PlanOpened");
    expect((await token.balanceOf(merchant)) - merchantBefore === principal, "merchant not paid in full");
    expect(poolBefore - (await token.balanceOf(engine.target)) === principal, "the pool did not pay");
    const allowance = await token.allowance(buyer.address, engine.target);
    expect(allowance === quote.permitValue, `AUSD allowance ${allowance}, permit ${quote.permitValue}`);
    return `loan #${loanId}, 4 x ${$(quote.installmentAmount)} weekly, AUSD allowance ${$(allowance)} set by the permit`;
  });

  await step("a collections report through Chainlink's MockKeystoneForwarder collects instalment 1 in AUSD when due", async () => {
    await travel(ethers.provider, WEEK + 1n);
    const tasks = [{ action: cre.ACTION.COLLECT_INSTALLMENT, id: loanId }];
    expect((await collections.checkTasks(tasks))[0], "instalment 1 not due");
    const before = await token.balanceOf(buyer.address);
    const receipt = await report(collections.target, cre.encodeCollectionsReport(tasks), cre.WORKFLOW_NAMES.COLLECTIONS);
    const [done] = events(receipt, collections, "TaskExecuted");
    expect(done, `not collected: ${events(receipt, collections, "TaskSkipped").map((e) => e.args.reason).join(", ")}`);
    expect(before - (await token.balanceOf(buyer.address)) === quote.installmentAmount, "the buyer was not charged one instalment");
    return `${$(done.args.amount)} taken by transferFrom, ${(await engine.getLoan(loanId)).installmentsPaid}/4 paid`;
  });

  await step("Subscribe: an AUSD permit to PolarisPayments and a SubscribeIntent charge period 1", async () => {
    const plan = d.demo.subscriptionPlans[1];
    const price = BigInt(plan.pricePerPeriod);
    const t = await now();
    const permit = Signature.from(
      await buyer.signTypedData(tokenDomain, { Permit: TYPES.Stablecoin.Permit }, {
        owner: buyer.address,
        spender: payments.target,
        value: price * 12n,
        nonce: await token.nonces(buyer.address),
        deadline: t + 1800n,
      })
    );
    const intent = {
      buyer: buyer.address,
      merchant,
      planId: BigInt(plan.planId),
      pricePerPeriod: price,
      periodSeconds: BigInt(plan.periodSeconds),
      orderId: `fork-sub-${hexlify(randomBytes(6))}`,
      nonce: await checkout.nonces(buyer.address),
      deadline: t + 600n,
    };
    const sig = await buyer.signTypedData(await readDomain(checkout), { SubscribeIntent: TYPES.PolarisCheckout.SubscribeIntent }, intent);
    const before = await token.balanceOf(merchant);
    const receipt = await tx.send(checkout, "subscribe", [
      intent,
      sig,
      { value: price * 12n, deadline: t + 1800n, v: permit.v, r: permit.r, s: permit.s },
    ]);
    const [started] = events(receipt, checkout, "SubscriptionStarted");
    const got = (await token.balanceOf(merchant)) - before;
    expect(got === price - (price * feeBps) / 10_000n, `merchant got ${got}`);
    return `subscription #${started.args.subId}, merchant +${formatUnits(got, 6)}`;
  });

  await step("Send by link: an AUSD ReceiveWithAuthorization moves $50 into PolarisSend", async () => {
    linkKey = Wallet.createRandom();
    const sendDomain = await readDomain(send);
    const t = await now();
    const expiresAt = t + WEEK;
    const auth = Signature.from(
      await sender.signTypedData(tokenDomain, { ReceiveWithAuthorization: TYPES.Stablecoin.ReceiveWithAuthorization }, {
        from: sender.address,
        to: send.target,
        value: sendAmount,
        validAfter: 0,
        validBefore: t + 1800n,
        nonce: await send.sendNonce(linkKey.address, expiresAt),
      })
    );
    const open = Signature.from(
      await linkKey.signTypedData(sendDomain, { Open: TYPES.PolarisSend.Open }, { sender: sender.address, amount: sendAmount, expiresAt })
    );
    const held = await token.balanceOf(send.target);
    await tx.send(send, "send", [
      sender.address, linkKey.address, sendAmount, expiresAt, 0, t + 1800n,
      auth.v, auth.r, auth.s, open.v, open.r, open.s,
    ]);
    expect((await token.balanceOf(send.target)) - held === sendAmount, "PolarisSend did not receive the AUSD");
    return `PolarisSend holds the ${$(sendAmount)}`;
  });

  await step("Claim: the link key's signature pays the $50 to a fresh wallet", async () => {
    const t = await now();
    const claim = Signature.from(
      await linkKey.signTypedData(await readDomain(send), { Claim: TYPES.PolarisSend.Claim }, { to: claimant.address, deadline: t + 600n })
    );
    await tx.send(send, "claim", [linkKey.address, claimant.address, t + 600n, claim.v, claim.r, claim.s]);
    const got = await token.balanceOf(claimant.address);
    expect(got === sendAmount, `the claimant holds ${$(got)}`);
    return `claimant holds ${$(got)} AUSD`;
  });

  await step("Split: the organiser opens a split of two $30 shares; a friend pays one by AUSD ReceiveWithAuthorization, straight on to the organiser", async () => {
    const coder = AbiCoder.defaultAbiCoder();
    const t = await now();
    const amounts = [USD(30), USD(30)];
    const creation = {
      organiser: organiser.address,
      salt: hexlify(randomBytes(32)),
      amounts,
      memoHash: keccak256(coder.encode(["string", "string", "uint256", "string[]"], ["Dinner", "Organiser", USD(60), ["Friend", "Organiser"]])),
      expiresAt: t + 24n * 3600n,
      deadline: t + 600n,
    };
    const createSig = await organiser.signTypedData(await readDomain(split), { CreateSplit: TYPES.PolarisSplit.CreateSplit }, creation);
    await tx.send(split, "createSplit", [creation, createSig]);
    const splitId = await split.splitIdOf(organiser.address, creation.salt);
    const auth = Signature.from(
      await sender.signTypedData(tokenDomain, { ReceiveWithAuthorization: TYPES.Stablecoin.ReceiveWithAuthorization }, {
        from: sender.address,
        to: split.target,
        value: amounts[0],
        validAfter: 0,
        validBefore: t + 1800n,
        nonce: await split.shareNonce(splitId, 0),
      })
    );
    await tx.send(split, "payShare", [splitId, 0, sender.address, 0, t + 1800n, auth.v, auth.r, auth.s]);
    expect((await token.balanceOf(organiser.address)) === amounts[0], "the organiser did not receive the share");
    expect((await token.balanceOf(split.target)) === 0n, "PolarisSplit kept AUSD");
    expect(getAddress(await split.paidBy(splitId, 0)) === sender.address, "the share is not recorded as paid");
    return `organiser holds ${$(amounts[0])}, PolarisSplit holds $0.00`;
  });

  await step("no buyer, sender, organiser or claimant sent a transaction or held MON", async () => {
    for (const w of people) {
      expect((await ethers.provider.getBalance(w.address)) === 0n, `${w.address} holds MON`);
      expect((await ethers.provider.getTransactionCount(w.address)) === 0, `${w.address} sent a transaction`);
    }
    return `${people.length} wallets, 0 MON, 0 transactions`;
  });

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped.`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e.shortMessage ?? e.message ?? e);
  process.exitCode = 1;
});
