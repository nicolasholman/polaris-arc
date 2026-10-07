import type { Metadata } from "next";
import { Suspense } from "react";

import { LoginFrame, LoginView } from "./login-view";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to Polaris for Business: payment links, Pay in 4 and payouts, settled in dollars in under a second.",
};

export default function LoginPage() {
  return (
    <Suspense fallback={<LoginFrame>{null}</LoginFrame>}>
      <LoginView />
    </Suspense>
  );
}
