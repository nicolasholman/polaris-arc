'use client';

/**
 * Drop-in BNPL checkout for the Polaris LoanEngine.
 *
 * The buyer does exactly one on-chain action: a single ERC-20 approval for the
 * full repayment amount. That approval is what every later instalment is drawn
 * against, and it is the reason a keeper can collect on schedule without the
 * buyer ever coming back. Nothing is escrowed and no funds move at checkout --
 * the buyer keeps their balance and can revoke the approval at any time.
 *
 * Opening the plan is a server call, because `createLoan` is originator-gated:
 * the merchant's backend signs it, not the buyer. The buyer therefore pays no
 * gas to start a plan.
 *
 * This file is presentation only. Every chain interaction goes through
 * `createPolaris`, so the widget and a hand-rolled checkout cannot drift apart
 * on decimals, allowance headroom, or error copy -- which they had, at 105% here
 * against 110% there.
 *
 * Theming: colours come from CSS custom properties with dark defaults. Set
 * `--polaris-bg`, `--polaris-fg`, `--polaris-accent` and friends on any
 * ancestor to make it match the surrounding page. No stylesheet to import.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { SEPOLIA, type PolarisChain, type PolarisContracts } from '../chains.js';
import { createPolaris } from '../client.js';
import type { CreditProfile } from '../legacy.js';

/** Public Sepolia deployment (0.2). Override for your own. */
export const POLARIS_SEPOLIA = SEPOLIA;

export interface PayWithPolarisBNPLProps {
  /** Merchant API key, forwarded to your backend to authorise the plan. */
  apiKey: string;
  /** Your endpoint that calls createLoan. Defaults to /api/checkout. */
  endpoint?: string;
  /** Order total in human units, e.g. "200.00". */
  amount: string;
  orderId: string;
  installments?: number;
  intervalSeconds?: number;
  contracts?: PolarisChain | PolarisContracts;
  /** Read-only RPC, so eligibility can be shown before the buyer connects. */
  rpcUrl?: string;
  onSuccess?: (result: { loanId?: string; transactionHash?: string }) => void;
  onError?: (message: string) => void;
}

type Phase = 'idle' | 'connecting' | 'working' | 'done' | 'error';

type EthereumLike = {
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
};

export function PayWithPolarisBNPL({
  apiKey,
  endpoint = '/api/checkout',
  amount,
  orderId,
  installments = 4,
  intervalSeconds = 14 * 24 * 60 * 60,
  contracts = SEPOLIA,
  rpcUrl,
  onSuccess,
  onError,
}: PayWithPolarisBNPLProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState('');
  const [account, setAccount] = useState<string>();
  const [credit, setCredit] = useState<CreditProfile>();

  const polaris = useMemo(
    () => createPolaris({ apiKey, endpoint, contracts, rpcUrl }),
    [apiKey, endpoint, contracts, rpcUrl]
  );

  const total = Number.parseFloat(amount);
  const perInstallment = Number.isFinite(total) ? (total / installments).toFixed(2) : '--';

  /*
   * Eligibility is a fact about (buyer, amount). Deriving it on render rather
   * than freezing it into state at connect time is what stops a cart update
   * from leaving the button disabled against a total that no longer applies.
   */
  const overLimit =
    credit !== undefined &&
    Number.isFinite(total) &&
    Number.parseFloat(credit.limit) < total;

  const schedule = useMemo(() => {
    if (!Number.isFinite(total)) return [];
    const fmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
    // The loan engine collects nothing at checkout: instalment i falls due at
    // startedAt + (i + 1) * interval (PolarisLoanEngine.installmentDueAt).
    return Array.from({ length: installments }, (_, i) => ({
      key: i,
      when: fmt.format(new Date(Date.now() + (i + 1) * intervalSeconds * 1000)),
      amount: (total / installments).toFixed(2),
    }));
  }, [total, installments, intervalSeconds]);

  const fail = useCallback(
    (msg: string) => {
      setPhase('error');
      setMessage(msg);
      onError?.(msg);
    },
    [onError]
  );

  /*
   * A wallet can change account or network while this component is mounted. The
   * previous version cached the address once and kept using it, so after a
   * switch it checked one account's allowance and asked a different account to
   * sign. Drop everything and make the buyer reconnect.
   */
  useEffect(() => {
    const eth = (globalThis as { ethereum?: EthereumLike }).ethereum;
    if (!eth?.on) return;
    const reset = () => {
      setAccount(undefined);
      setCredit(undefined);
      setPhase('idle');
      setMessage('');
    };
    eth.on('accountsChanged', reset);
    eth.on('chainChanged', reset);
    return () => {
      eth.removeListener?.('accountsChanged', reset);
      eth.removeListener?.('chainChanged', reset);
    };
  }, []);

  const connect = useCallback(async () => {
    setPhase('connecting');
    setMessage('Checking your credit line...');
    try {
      const profile = await polaris.getCredit();
      setCredit(profile);
      setAccount(profile.address);
      setPhase('idle');
      setMessage('');
    } catch (err) {
      fail(readableError(err));
    }
  }, [polaris, fail]);

  const start = useCallback(async () => {
    setPhase('working');
    setMessage('Approve the repayment allowance in your wallet...');
    const result = await polaris.payLater({ amount, orderId, installments, intervalSeconds });
    if (!result.ok) {
      fail(result.error ?? 'Could not open the plan.');
      return;
    }
    setPhase('done');
    setMessage(`Plan open. ${installments} instalments of ${perInstallment} collect automatically.`);
    onSuccess?.({ loanId: result.loanId, transactionHash: result.transactionHash });
  }, [polaris, amount, orderId, installments, intervalSeconds, perInstallment, onSuccess, fail]);

  const busy = phase === 'connecting' || phase === 'working';

  const label = phase === 'done'
    ? 'Plan open'
    : busy
      ? 'Working...'
      : overLimit
        ? 'Over your limit'
        : account
          ? 'Set up plan'
          : 'Continue with Polaris';

  return (
    <div style={S.root}>
      <div style={S.head}>
        <span style={S.label}>Pay in {installments}</span>
        <span style={S.total}>
          {perInstallment}
          <span style={S.per}> x {installments}</span>
        </span>
      </div>

      <p style={S.sub}>
        {amount} total. Nothing is taken today -- instalments are collected from your wallet on
        schedule, and you can revoke the allowance at any time.
      </p>

      {schedule.length > 0 && (
        <ol style={S.schedule}>
          {schedule.map((row) => (
            <li key={row.key} style={S.row}>
              <span style={S.when}>{row.when}</span>
              <span style={S.rail} aria-hidden="true" />
              <span style={S.amount}>{row.amount}</span>
            </li>
          ))}
        </ol>
      )}

      {credit && (
        <div style={S.credit}>
          Polaris score {credit.score}
          <span style={S.dot}>&middot;</span>
          {credit.limit} {credit.symbol} limit
        </div>
      )}

      <button
        type="button"
        onClick={account ? start : connect}
        disabled={busy || phase === 'done' || overLimit}
        aria-busy={busy}
        style={{ ...S.button, opacity: busy || overLimit ? 0.55 : 1 }}
      >
        {label}
      </button>

      <p role="status" aria-live="polite" style={statusStyle(phase, overLimit)}>
        {overLimit && !busy
          ? `This order is above your ${credit?.limit} ${credit?.symbol} limit. Paying instalments on time raises it.`
          : message}
      </p>
    </div>
  );
}

function statusStyle(phase: Phase, overLimit: boolean): React.CSSProperties {
  if (phase === 'error' || overLimit) return S.error;
  if (phase === 'done') return S.success;
  return S.status;
}

/** Turn wallet and RPC noise into something a buyer can act on. */
function readableError(err: unknown): string {
  const raw =
    (err as { shortMessage?: string })?.shortMessage ?? (err as Error)?.message ?? String(err);
  if (/user rejected|user denied/i.test(raw)) return 'You cancelled the request.';
  if (/insufficient funds/i.test(raw)) return 'Not enough ETH to cover the network fee.';
  if (/unrecognized chain/i.test(raw)) return 'Add the network to your wallet, then try again.';
  return raw.length > 160 ? `${raw.slice(0, 157)}...` : raw;
}

const v = (name: string, fallback: string) => `var(--polaris-${name}, ${fallback})`;

const S: Record<string, React.CSSProperties> = {
  root: {
    border: `1px solid ${v('border', 'rgba(255,255,255,0.12)')}`,
    borderRadius: v('radius', '12px'),
    padding: 20,
    background: v('bg', 'rgba(255,255,255,0.02)'),
    color: v('fg', '#fff'),
    fontFamily: v('font', 'system-ui, sans-serif'),
    maxWidth: 380,
  },
  head: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' },
  label: {
    fontSize: 11,
    letterSpacing: '0.14em',
    textTransform: 'uppercase',
    color: v('muted', 'rgba(255,255,255,0.5)'),
  },
  total: { fontSize: 28, fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.02em' },
  per: { fontSize: 14, color: v('muted', 'rgba(255,255,255,0.45)') },
  sub: { marginTop: 10, fontSize: 13, lineHeight: 1.5, color: v('muted', 'rgba(255,255,255,0.5)') },
  schedule: {
    listStyle: 'none',
    margin: '16px 0 0',
    padding: 0,
    display: 'grid',
    gap: 6,
  },
  row: {
    display: 'grid',
    gridTemplateColumns: 'auto 1fr auto',
    alignItems: 'center',
    gap: 10,
    fontSize: 12,
    fontVariantNumeric: 'tabular-nums',
  },
  when: { color: v('muted', 'rgba(255,255,255,0.5)') },
  rail: { height: 1, background: v('border', 'rgba(255,255,255,0.10)') },
  amount: { color: v('fg', '#fff') },
  credit: {
    marginTop: 14,
    fontSize: 12,
    color: v('muted', 'rgba(255,255,255,0.55)'),
    fontVariantNumeric: 'tabular-nums',
  },
  dot: { margin: '0 8px', color: v('border', 'rgba(255,255,255,0.25)') },
  button: {
    marginTop: 18,
    width: '100%',
    padding: '12px 16px',
    borderRadius: v('radius-sm', '8px'),
    border: 'none',
    background: v('accent', '#A6F24A'),
    color: v('accent-fg', '#000'),
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
  },
  status: { marginTop: 12, fontSize: 12, minHeight: 16, color: v('muted', 'rgba(255,255,255,0.55)') },
  error: { marginTop: 12, fontSize: 12, minHeight: 16, color: v('danger', '#fda4af') },
  success: { marginTop: 12, fontSize: 12, minHeight: 16, color: v('accent', '#A6F24A') },
};

export default PayWithPolarisBNPL;
