# Arc mainnet recording support

The recording can use the production buyer UI with a loopback business API backed by SQLite when hosted persistence is unavailable. All balances, guards, signatures and receipts still use Arc mainnet; no chain response is fabricated.

`POLARIS_LOCAL_MAINNET_RECORDING=1` enables the existing merchant development session only with `NODE_ENV=development`, a loopback `POLARIS_PUBLIC_URL`, the Privy relayer, a random token, and no public merchant signing key. Mainnet session requests must also target loopback and have a loopback Origin when present. Production builds reject this session. Bind the development server to `127.0.0.1`; do not expose it through a tunnel. The local merchant session is a recording convenience, not evidence of a production Privy login.

`NEXT_PUBLIC_PAY_IN_4_MIN_CENTS` sets the product's minimum principal (default 2000 cents, minimum 100 cents). The lean mainnet recording uses 100 cents. Contract credit, oracle and liquidity checks still apply; this does not increase lending capacity.

Payment links now load their public checkout session in the browser and retry API failures in place. Metadata does not open sessions. Desktop checkout renders directly so switching the sheet host does not remount the session loader repeatedly.

The recording also caught a repayment mismatch: the confirmation named one instalment but the signing action requested the entire outstanding balance. Every desktop/mobile repayment entry point now passes the displayed amount explicitly. The action rejects nonpositive or stale oversized amounts before signing; the contract still binds `expectedRepaid`. Sub-day repayment intervals now read as hours/minutes, and browser-loaded closed links retain the closed-checkout screen.
