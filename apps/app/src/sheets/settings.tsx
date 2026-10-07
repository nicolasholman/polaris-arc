"use client";

import { AdaptiveSheet, Button, Input, ListGroup, ListRow, Select, Sheet } from "@polaris/ui";
import { LockKeyhole, LogOut, Trash2 } from "lucide-react";
import { useState } from "react";
import { ReceiptsPrivacyRow } from "@/components/receipts-privacy";
import { RouteSheet, useCloseSheet } from "@/components/shell/sheet-host";
import { SettingsDesktop } from "@/desktop/profile";
import { signOut } from "@/lib/account";
import { useAccountState, useOwner } from "@/lib/account/hooks";
import { getProfile } from "@/lib/data";
import { useData } from "@/lib/data/hooks";
import { currencyForLocale, localCurrencyHint, localCurrencyOptions } from "@/lib/money";
import { setPrefs, useLocale, usePrefs } from "@/lib/prefs";

/** Settings and account actions (half, drags to full). */
export function SettingsSheet() {
  const close = useCloseSheet();
  const state = useAccountState();
  const owner = useOwner();
  const profile = useData(() => getProfile(owner), [owner]);
  const prefs = usePrefs();
  const locale = useLocale();
  const [forgetting, setForgetting] = useState(false);
  const auto = locale ? currencyForLocale(locale) : "USD";
  const hasAccount = state.status === "ready" || state.status === "locked";
  const email = hasAccount && state.source === "privy";

  return (
    <>
      <Sheet.Body className="flex flex-col [&>*]:shrink-0 gap-5 pt-1">
        <Input
          label="Your name on links"
          hint="People see it when you send them dollars."
          value={prefs.name}
          placeholder={profile.value?.name ?? "Your name"}
          maxLength={40}
          autoComplete="name"
          onChange={(e) => setPrefs({ name: e.target.value })}
        />
        <Select
          variant="filled"
          label="Local currency"
          hint={localCurrencyHint(prefs.currency ?? auto)}
          value={prefs.currency ?? "auto"}
          onValueChange={(v) => setPrefs({ currency: v === "auto" ? null : v })}
          options={localCurrencyOptions(auto, prefs.currency)}
        />
        {hasAccount ? (
          <ListGroup label="Privacy">
            <ReceiptsPrivacyRow source={state.source} icon={<LockKeyhole />} />
          </ListGroup>
        ) : null}
        {hasAccount ? (
          <ListGroup label="Account">
            {state.status === "ready" ? (
              <ListRow
                icon={<LogOut />}
                title="Log out"
                description={email ? "Your email signs you back in." : "Face ID opens it again."}
                chevron={false}
                onClick={() => {
                  signOut();
                  close();
                }}
              />
            ) : null}
            <ListRow
              icon={<Trash2 />}
              tone="down"
              title="Remove from this device"
              description="Your account and money stay safe."
              chevron={false}
              onClick={() => setForgetting(true)}
            />
          </ListGroup>
        ) : null}
      </Sheet.Body>

      <AdaptiveSheet open={forgetting} onOpenChange={setForgetting} snapPoints={["fit"]} title="Remove from this device?" maxWidth={440}>
        <Sheet.Body className="flex flex-col [&>*]:shrink-0 gap-3 pt-1 text-center">
          <p className="text-[15px] leading-[1.45] text-ui-muted">
            Your account and your money stay safe.{" "}
            {email ? "To come back, continue with the same email." : "To come back, tap I already use Polaris and use Face ID."}
          </p>
          <Button
            variant="dark"
            size="lg"
            block
            className="mt-2 bg-ui-down text-[#0f1011] hover:bg-ui-down/90"
            onClick={() => {
              signOut({ forget: true });
              setForgetting(false);
              close();
            }}
          >
            Remove
          </Button>
          <Button variant="ghost" size="lg" block onClick={() => setForgetting(false)}>
            Keep it
          </Button>
        </Sheet.Body>
      </AdaptiveSheet>
    </>
  );
}

/** The route: the intercepting page in app/@sheet (over the current tab), or the page itself (cold, over its tab). */
export function SettingsRoute({ cold }: { cold?: boolean }) {
  return (
    <RouteSheet
      label="Settings"
      title="Settings"
      snapPoints={["half", "full"]}
      cold={cold}
      fallback="/profile"
      desktop={{ as: "page", content: <SettingsDesktop /> }}
    >
      <SettingsSheet />
    </RouteSheet>
  );
}
