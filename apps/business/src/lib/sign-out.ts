"use client";

/**
 * An explicit sign-out goes to /login with no `next`: the next person to sign
 * in on this browser shouldn't land on the previous merchant's page. The
 * dashboard's gate, which otherwise sends a signed-out visitor to
 * /login?next=<this page>, checks this flag first.
 */
let explicit = false;

export function markExplicitSignOut() {
  explicit = true;
}

export function consumeExplicitSignOut(): boolean {
  const was = explicit;
  explicit = false;
  return was;
}
