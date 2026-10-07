import { Card } from "@polaris/ui";
import Link from "next/link";

import { BusinessLogo } from "./brand";

const STEPS: { title: string; body: React.ReactNode }[] = [
  {
    title: "Create a Privy app",
    body: (
      <>
        At <span className="font-mono text-ui-text">dashboard.privy.io</span>, create an app. Email login is enough;
        whatever methods you turn on there (email, wallets, Google) appear in the sign-in modal by themselves.
      </>
    ),
  },
  {
    title: "Add its keys to apps/business/.env.local",
    body: (
      <pre className="mt-1 overflow-x-auto rounded-[14px] bg-ui-canvas p-4 font-mono text-[12.5px] leading-[1.7] text-ui-text">
        {`NEXT_PUBLIC_PRIVY_APP_ID=your-app-id
PRIVY_APP_SECRET=your-app-secret`}
      </pre>
    ),
  },
  {
    title: "Restart the dev server",
    body: (
      <>
        <span className="font-mono text-ui-text">pnpm --filter @polaris/business dev</span>. Public variables are read at
        build time, so a deployed build needs a rebuild instead.
      </>
    ),
  },
];

/**
 * Shown by /login and /dashboard when this build has no Privy app id. In
 * development it says exactly what to configure; in production it tells a
 * visitor only that sign-in is unavailable (no variable names or file paths).
 */
export function SetupScreen() {
  const development = process.env.NODE_ENV === "development";
  return (
    <main className="relative mx-auto grid min-h-dvh max-w-[1080px] content-center gap-10 px-4 py-12 sm:px-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-16">
      <div className="grid content-start gap-5">
        <Link href="/" aria-label="Polaris for Business">
          <BusinessLogo height={32} />
        </Link>
        <h1 className="max-w-[16ch] text-[36px] leading-[1.08] font-medium tracking-[-0.035em]">
          {development ? "Connect Privy to open the dashboard" : "Sign-in is unavailable right now"}
        </h1>
        <p className="max-w-[46ch] text-[16px] leading-relaxed text-ui-muted">
          {development
            ? "Merchants sign in with Privy and each gets an embedded payout wallet on Monad. This build has no Privy app id yet, so there is nothing to sign in with."
            : "We can't sign anyone in at the moment. Your account and your money are unaffected. Please try again a little later."}
        </p>
      </div>

      {development ? (
        <Card padding="sm" className="grid gap-0">
          <ol>
            {STEPS.map((step, i) => (
              <li key={step.title} className="grid grid-cols-[32px_minmax(0,1fr)] gap-3 rounded-ui-tile p-4">
                <span aria-hidden className="ui-figure grid size-7 place-items-center rounded-full bg-ui-lime text-[13px] font-semibold text-ui-on-lime">
                  {i + 1}
                </span>
                <div className="grid min-w-0 gap-1.5">
                  <h2 className="text-[15px] font-medium tracking-[-0.01em]">{step.title}</h2>
                  <div className="text-[14px] leading-relaxed text-ui-muted">{step.body}</div>
                </div>
              </li>
            ))}
          </ol>
        </Card>
      ) : null}
    </main>
  );
}
