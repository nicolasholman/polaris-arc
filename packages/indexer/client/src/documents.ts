/**
 * Every GraphQL document the dashboard, the webhook dispatcher, the CRE
 * collections workflow and the Polaris app send to the indexer.
 *
 * The API is Envio's Hasura: one root field per entity, named as in
 * schema.graphql, with `where` / `order_by` / `limit` / `offset`. BigInt
 * columns are Hasura `numeric` (variables are strings); timestamps are Int.
 * Rows are per chain, so single rows are read with `where` + `limit: 1`
 * rather than `_by_pk`. The client's test validates every document against
 * a Hasura-shaped schema built from ../../schema.graphql.
 */

/* ── Fragments: the fields each consumer reads ─────────────────────────── */

export const MERCHANT_FIELDS = /* GraphQL */ `
  fragment MerchantFields on Merchant {
    id registered name payoutAddress active maxOrderValue registeredAt registeredBy
    paymentCount grossVolume feeVolume netVolume payNowCount payNowVolume planCount planVolume
    subscriptionChargeCount subscriptionVolume customerCount
    activePlanCount outstanding dunningPlanCount atRiskOutstanding repaidPlanCount liquidatedPlanCount
    activeSubscriptionCount mrr balance payoutCount payoutVolume firstSeenAt lastPaymentAt updatedAt
  }
`;

export const PAYMENT_FIELDS = /* GraphQL */ `
  fragment PaymentFields on Payment {
    id merchant_id buyer_id mode amount fee net orderId orderKey quotedAmount plan_id subscription_id
    period viaCheckout relayer timestamp blockNumber logIndex txHash
  }
`;

export const INSTALLMENT_FIELDS = /* GraphQL */ `
  fragment InstallmentFields on Installment {
    id index dueAt amount paid status paidAt onTime paidBy paidTxHash failedAttempts lastFailureReason lastFailureAt
  }
`;

export const PLAN_FIELDS = /* GraphQL */ `
  fragment PlanFields on Plan {
    id loanId merchant_id buyer_id orderId orderKey principal totalOwed interest installmentCount installmentAmount
    interval startedAt firstDueAt totalRepaid outstanding installmentsPaid nextDueAt liquidatableAt nextAttemptAt
    status dunning failedAttempts lastFailureReason lastFailureAction lastFailureAt recovered loss closedAt
    openedTxHash relayer updatedAt
    installments(order_by: { index: asc }) { ...InstallmentFields }
  }
  ${INSTALLMENT_FIELDS}
`;

export const REPAYMENT_FIELDS = /* GraphQL */ `
  fragment RepaymentFields on Repayment {
    id amount installmentIndex installmentsCompleted onTime source bonusWithheld relayer timestamp txHash
  }
`;

export const SUBSCRIPTION_FIELDS = /* GraphQL */ `
  fragment SubscriptionFields on Subscription {
    id subId plan_id merchant_id buyer_id orderId orderKey pricePerPeriod periodSeconds startedAt nextChargeAt
    nextAttemptAt periodsCharged missedCharges status totalCharged failedAttempts lastFailureReason lastFailureAt
    cancelledBy endedAt updatedAt
  }
`;

export const PAYOUT_FIELDS = /* GraphQL */ `
  fragment PayoutFields on Payout {
    id merchant_id amount destination toPayoutAddress relayer timestamp blockNumber txHash
  }
`;

export const CUSTOMER_FIELDS = /* GraphQL */ `
  fragment CustomerFields on Customer {
    id buyer_id firstPaidAt lastPaidAt paymentCount volume
  }
`;

export const MERCHANT_DAY_FIELDS = /* GraphQL */ `
  fragment MerchantDayFields on MerchantDay {
    id day date paymentCount grossVolume feeVolume netVolume payNowCount payNowVolume planCount planVolume
    subscriptionChargeCount subscriptionVolume installmentsCompleted repaidVolume failedCollections newCustomers
    payoutCount payoutVolume open high low close balanceOpen balanceHigh balanceLow balanceClose
  }
`;

export const ORDER_FIELDS = /* GraphQL */ `
  fragment OrderFields on Order {
    id merchant_id orderId status kind quotedAmount quotedAt amount quoteMatched buyer payment_id plan_id
    subscription_id settledAt settledBlock txHash
  }
`;

export const ACTIVITY_FIELDS = /* GraphQL */ `
  fragment ActivityFields on Activity {
    id cursor kind merchant_id buyer orderId orderKey mode amount fee refId installmentIndex installmentCount
    principal interval firstDueAt remaining recovered attempt nextAttemptAt failureReason subscriptionPlanId period
    nextChargeAt canceledBy reason reasonAction destination timestamp blockNumber logIndex txHash
  }
`;

export const BUYER_FIELDS = /* GraphQL */ `
  fragment BuyerFields on Buyer {
    id score hasRecord underwritten declined baseLimit collateral creditLimit activeDebt available linkedWallet
    underwrittenAt lastUnderwritingRefusal onTimeInstallments lateInstallments liquidations planCount activePlanCount
    paymentCount spent activeSubscriptionCount sentCount sentVolume claimedCount claimedVolume firstSeenAt updatedAt
  }
`;

export const SCORE_EVENT_FIELDS = /* GraphQL */ `
  fragment ScoreEventFields on ScoreEvent {
    id oldScore newScore delta reason timestamp txHash
  }
`;

export const BUYER_DAY_FIELDS = /* GraphQL */ `
  fragment BuyerDayFields on BuyerDay {
    id day date scoreOpen scoreHigh scoreLow scoreClose spent repaid
  }
`;

export const SEND_FIELDS = /* GraphQL */ `
  fragment SendFields on Send {
    id sender amount expiresAt status recipient sentAt closedAt sentTxHash closedTxHash relayer
  }
`;

export const PROTOCOL_FIELDS = /* GraphQL */ `
  fragment ProtocolFields on Protocol {
    id feeBps requireUnderwriting collateralMultiplierBps collateralCountsTowardLimits checkoutPaused
    merchantCount registeredMerchantCount buyerCount paymentCount grossVolume feeVolume payNowCount payNowVolume
    planCount activePlanCount principalOriginated outstanding repaidVolume installmentsCompleted creCollections
    liquidationCount lossVolume subscriptionCount activeSubscriptionCount subscriptionVolume sendCount sendVolume
    claimCount claimVolume payoutCount payoutVolume collectionsRuns lastCollectionsRunAt lastCollectionsRunBlock
    creReports creReportsFailed underwritings updatedAt
  }
`;

export const PROTOCOL_DAY_FIELDS = /* GraphQL */ `
  fragment ProtocolDayFields on ProtocolDay {
    id day date paymentCount grossVolume feeVolume planCount principalOriginated installmentsCompleted repaidVolume
    liquidations subscriptionCharges subscriptionVolume sendCount sendVolume claimCount payoutCount payoutVolume
    collectionsRuns creReports newBuyers newMerchants open high low close
  }
`;

export const COLLECTION_RUN_FIELDS = /* GraphQL */ `
  fragment CollectionRunFields on CollectionRun {
    id tasks executed skipped transmitter timestamp blockNumber txHash
  }
`;

export const COLLECTION_TASK_FIELDS = /* GraphQL */ `
  fragment CollectionTaskFields on CollectionTask {
    id action actionName targetId executed amount reason reasonAction have need plan_id subscription_id
    timestamp blockNumber txHash
  }
`;

export const CRE_REPORT_FIELDS = /* GraphQL */ `
  fragment CreReportFields on CreReport {
    id workflow receiver forwarder workflowExecutionId reportId result transmitter timestamp blockNumber txHash
  }
`;

/* ── Dashboard (Polaris for Business) ──────────────────────────────────── */

/** Home: the merchant's totals, today's payments, and the days behind the charts. */
export const MERCHANT_OVERVIEW = /* GraphQL */ `
  query MerchantOverview($merchant: String!, $fromDay: Int!, $recent: Int!) {
    Merchant(where: { id: { _eq: $merchant } }, limit: 1) { ...MerchantFields }
    recentPayments: Payment(
      where: { merchant_id: { _eq: $merchant } }
      order_by: [{ blockNumber: desc }, { logIndex: desc }]
      limit: $recent
    ) { ...PaymentFields }
    days: MerchantDay(where: { merchant_id: { _eq: $merchant }, day: { _gte: $fromDay } }, order_by: { day: asc }) {
      ...MerchantDayFields
    }
  }
  ${MERCHANT_FIELDS}
  ${PAYMENT_FIELDS}
  ${MERCHANT_DAY_FIELDS}
`;

/** Payments, newest first. `$where` narrows further (mode, buyer, time). */
export const MERCHANT_PAYMENTS = /* GraphQL */ `
  query MerchantPayments($where: Payment_bool_exp!, $limit: Int!, $offset: Int!) {
    Payment(where: $where, order_by: [{ blockNumber: desc }, { logIndex: desc }], limit: $limit, offset: $offset) {
      ...PaymentFields
    }
  }
  ${PAYMENT_FIELDS}
`;

/** The Pay in 4 ledger with each plan's instalment tick marks. */
export const MERCHANT_PLANS = /* GraphQL */ `
  query MerchantPlans($where: Plan_bool_exp!, $limit: Int!, $offset: Int!) {
    Plan(where: $where, order_by: [{ startedAt: desc }, { loanId: desc }], limit: $limit, offset: $offset) {
      ...PlanFields
    }
  }
  ${PLAN_FIELDS}
`;

/** One plan: schedule, every repayment, and every collection attempt. */
export const PLAN_DETAIL = /* GraphQL */ `
  query PlanDetail($loanId: String!, $loanIdNumeric: numeric!) {
    Plan(where: { id: { _eq: $loanId } }, limit: 1) {
      ...PlanFields
      repayments(order_by: { timestamp: asc }) { ...RepaymentFields }
    }
    CollectionTask(where: { targetId: { _eq: $loanIdNumeric }, action: { _in: [1, 3] } }, order_by: { timestamp: asc }) {
      ...CollectionTaskFields
    }
  }
  ${PLAN_FIELDS}
  ${REPAYMENT_FIELDS}
  ${COLLECTION_TASK_FIELDS}
`;

export const MERCHANT_SUBSCRIPTIONS = /* GraphQL */ `
  query MerchantSubscriptions($where: Subscription_bool_exp!, $limit: Int!, $offset: Int!) {
    Subscription(where: $where, order_by: [{ startedAt: desc }, { subId: desc }], limit: $limit, offset: $offset) {
      ...SubscriptionFields
    }
  }
  ${SUBSCRIPTION_FIELDS}
`;

export const MERCHANT_PAYOUTS = /* GraphQL */ `
  query MerchantPayouts($merchant: String!, $limit: Int!, $offset: Int!) {
    Payout(where: { merchant_id: { _eq: $merchant } }, order_by: { timestamp: desc }, limit: $limit, offset: $offset) {
      ...PayoutFields
    }
  }
  ${PAYOUT_FIELDS}
`;

export const MERCHANT_CUSTOMERS = /* GraphQL */ `
  query MerchantCustomers($merchant: String!, $limit: Int!, $offset: Int!) {
    Customer(where: { merchant_id: { _eq: $merchant } }, order_by: { volume: desc }, limit: $limit, offset: $offset) {
      ...CustomerFields
    }
  }
  ${CUSTOMER_FIELDS}
`;

/** The bar and candlestick charts: one row per day that had activity. */
export const MERCHANT_DAYS = /* GraphQL */ `
  query MerchantDays($merchant: String!, $fromDay: Int!, $toDay: Int!) {
    MerchantDay(
      where: { merchant_id: { _eq: $merchant }, day: { _gte: $fromDay, _lte: $toDay } }
      order_by: { day: asc }
    ) { ...MerchantDayFields }
  }
  ${MERCHANT_DAY_FIELDS}
`;

/** "Paid" for a checkout session: the order key's settlement, from indexed events only. */
export const ORDER_STATUS = /* GraphQL */ `
  query OrderStatus($orderKey: String!) {
    Order(where: { id: { _eq: $orderKey } }, limit: 1) { ...OrderFields }
  }
  ${ORDER_FIELDS}
`;

/** The collector card: when CRE last ran, what it did, and whether reports land. */
export const COLLECTOR_STATUS = /* GraphQL */ `
  query CollectorStatus($runs: Int!) {
    Protocol(limit: 1) { ...ProtocolFields }
    CollectionRun(order_by: { blockNumber: desc }, limit: $runs) { ...CollectionRunFields }
    CreReport(order_by: { timestamp: desc }, limit: $runs) { ...CreReportFields }
  }
  ${PROTOCOL_FIELDS}
  ${COLLECTION_RUN_FIELDS}
  ${CRE_REPORT_FIELDS}
`;

/** Protocol totals and daily rows, for the landing page and the judges' panel. */
export const PROTOCOL_STATS = /* GraphQL */ `
  query ProtocolStats($fromDay: Int!) {
    Protocol(limit: 1) { ...ProtocolFields }
    ProtocolDay(where: { day: { _gte: $fromDay } }, order_by: { day: asc }) { ...ProtocolDayFields }
  }
  ${PROTOCOL_FIELDS}
  ${PROTOCOL_DAY_FIELDS}
`;

/** How far the indexer has got (Envio's `_meta`). */
export const INDEXER_STATUS = /* GraphQL */ `
  query IndexerStatus {
    _meta { chainId progressBlock sourceBlock eventsProcessed isReady readyAt startBlock }
  }
`;

/* ── Webhooks ───────────────────────────────────────────────────────────── */

/**
 * The outbox, oldest first, after a cursor. The dispatcher stores the last
 * cursor it sent and asks for what follows.
 */
export const ACTIVITY_AFTER = /* GraphQL */ `
  query ActivityAfter($after: numeric!, $limit: Int!) {
    Activity(where: { cursor: { _gt: $after } }, order_by: { cursor: asc }, limit: $limit) { ...ActivityFields }
    _meta { chainId progressBlock }
  }
  ${ACTIVITY_FIELDS}
`;

/** One merchant's outbox (the dashboard's event log). */
export const MERCHANT_ACTIVITY = /* GraphQL */ `
  query MerchantActivity($merchant: String!, $before: numeric!, $limit: Int!) {
    Activity(
      where: { merchant_id: { _eq: $merchant }, cursor: { _lt: $before } }
      order_by: { cursor: desc }
      limit: $limit
    ) { ...ActivityFields }
  }
  ${ACTIVITY_FIELDS}
`;

/* ── The CRE collections workflow ──────────────────────────────────────── */

/**
 * What might be actionable at `$now`: plans whose next attempt has come
 * (the due date, or the next rung of the dunning ladder, never later than the
 * moment the plan turns liquidatable) and subscriptions likewise. Ids only,
 * so the response stays small and identical across DON nodes; the workflow
 * then asks CollectionsReceiver.checkTasks which are actionable on chain.
 *
 * The lists are aliased `Loan` and `Subscription`, the shape the
 * polaris-collections workflow's parser reads (its `candidates.indexerQuery`),
 * and `liquidatableAt` lets a caller tell a collection from a liquidation.
 */
export const DUE_CANDIDATES = /* GraphQL */ `
  query DueCandidates($now: Int!, $limit: Int!) {
    Loan: Plan(
      where: { status: { _eq: "ACTIVE" }, nextAttemptAt: { _lte: $now } }
      order_by: [{ nextAttemptAt: asc }, { loanId: asc }]
      limit: $limit
    ) { loanId liquidatableAt }
    Subscription(
      where: { status: { _eq: "ACTIVE" }, nextAttemptAt: { _lte: $now } }
      order_by: [{ nextAttemptAt: asc }, { subId: asc }]
      limit: $limit
    ) { subId }
  }
`;

/* ── The Polaris app (buyers and senders) ──────────────────────────────── */

/** Home: the credit line and why, open plans with their next payment, subscriptions. */
export const BUYER_HOME = /* GraphQL */ `
  query BuyerHome($buyer: String!, $fromDay: Int!) {
    Buyer(where: { id: { _eq: $buyer } }, limit: 1) {
      ...BuyerFields
      scoreEvents(order_by: { timestamp: desc }, limit: 20) { ...ScoreEventFields }
      days(where: { day: { _gte: $fromDay } }, order_by: { day: asc }) { ...BuyerDayFields }
    }
    Plan(where: { buyer_id: { _eq: $buyer }, status: { _eq: "ACTIVE" } }, order_by: { nextDueAt: asc }) { ...PlanFields }
    Subscription(where: { buyer_id: { _eq: $buyer }, status: { _eq: "ACTIVE" } }, order_by: { nextChargeAt: asc }) {
      ...SubscriptionFields
    }
    Protocol(limit: 1) { requireUnderwriting collateralMultiplierBps collateralCountsTowardLimits }
  }
  ${BUYER_FIELDS}
  ${SCORE_EVENT_FIELDS}
  ${BUYER_DAY_FIELDS}
  ${PLAN_FIELDS}
  ${SUBSCRIPTION_FIELDS}
`;

/** Activity: receipts and links, newest first. */
export const BUYER_ACTIVITY = /* GraphQL */ `
  query BuyerActivity($buyer: String!, $limit: Int!) {
    Payment(where: { buyer_id: { _eq: $buyer } }, order_by: [{ blockNumber: desc }, { logIndex: desc }], limit: $limit) {
      ...PaymentFields
    }
    sent: Send(where: { sender: { _eq: $buyer } }, order_by: { sentAt: desc }, limit: $limit) { ...SendFields }
    received: Send(where: { recipient: { _eq: $buyer } }, order_by: { closedAt: desc }, limit: $limit) { ...SendFields }
  }
  ${PAYMENT_FIELDS}
  ${SEND_FIELDS}
`;

/** A send link's state, for the claim screen ("Arrived" only from an indexed Claimed). */
export const SEND_BY_KEY = /* GraphQL */ `
  query SendByKey($linkKey: String!) {
    Send(where: { id: { _eq: $linkKey } }, limit: 1) { ...SendFields }
  }
  ${SEND_FIELDS}
`;

/** Every document, by name: what the schema test validates. */
export const DOCUMENTS = {
  MERCHANT_OVERVIEW,
  MERCHANT_PAYMENTS,
  MERCHANT_PLANS,
  PLAN_DETAIL,
  MERCHANT_SUBSCRIPTIONS,
  MERCHANT_PAYOUTS,
  MERCHANT_CUSTOMERS,
  MERCHANT_DAYS,
  ORDER_STATUS,
  COLLECTOR_STATUS,
  PROTOCOL_STATS,
  INDEXER_STATUS,
  ACTIVITY_AFTER,
  MERCHANT_ACTIVITY,
  DUE_CANDIDATES,
  BUYER_HOME,
  BUYER_ACTIVITY,
  SEND_BY_KEY,
} as const;
