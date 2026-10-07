import { Toaster } from "@polaris/ui";

import { AuthProvider } from "@/components/auth/auth-provider";
import { DataProvider } from "@/lib/session";

/**
 * The landing, /login and /dashboard: everything that needs to know who is
 * signed in. Privy mounts here and nowhere else.
 */
export default function PrivyLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <DataProvider>{children}</DataProvider>
      {/* Bottom right from 768px, clear of the phone's home indicator below it. */}
      <Toaster className="pb-[calc(16px+env(safe-area-inset-bottom))] md:pb-6" />
    </AuthProvider>
  );
}
