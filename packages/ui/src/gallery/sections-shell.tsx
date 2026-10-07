"use client";

import {
  ArrowLeftRight,
  CalendarClock,
  CodeXml,
  Copy,
  House,
  Landmark,
  Link2,
  LogOut,
  Plus,
  Settings2,
} from "lucide-react";
import { useMemo, useState, type AnchorHTMLAttributes } from "react";

import { CodeBlock } from "../composites/CodeBlock";
import { BottomNav } from "../composites/Navigation";
import { PageHeader } from "../composites/PageHeader";
import { PhoneFrame } from "../composites/PhoneFrame";
import { SideNav } from "../composites/SideNav";
import { KeyValueGrid } from "../composites/Stats";
import { ScreenHeader } from "../composites/Navigation";
import { Avatar } from "../primitives/Avatar";
import { Button } from "../primitives/Button";
import { Card } from "../primitives/Card";
import { CopyButton } from "../primitives/CopyButton";
import { Logo, LogoMark } from "../primitives/Logo";
import { Menu } from "../primitives/Menu";
import { ErrorState, Notice } from "../primitives/Notice";
import { Badge } from "../primitives/Pill";
import { SegmentedControl } from "../primitives/Segmented";
import { Ticks } from "../primitives/Ticks";
import { Section, Specimen } from "./frame";

const NAV = [
  { key: "overview", label: "Overview", icon: <House />, href: "#nav-overview" },
  { key: "payments", label: "Payments", icon: <ArrowLeftRight />, href: "#nav-payments" },
  { key: "links", label: "Links", icon: <Link2 />, href: "#nav-links" },
  { key: "plans", label: "Pay in 4", icon: <CalendarClock />, href: "#nav-plans" },
  { key: "payouts", label: "Payouts", icon: <Landmark />, href: "#nav-payouts" },
  { key: "developers", label: "Developers", icon: <CodeXml />, href: "#nav-developers" },
];

const SNIPPET = `import { createPolarisServer } from "polarispay-sdk/server";

const polaris = createPolarisServer({ secretKey: process.env.POLARIS_SECRET_KEY! });

// Create a checkout session and send the buyer to it
const session = await polaris.checkout.sessions.create(
  { amount: "200.00", description: "Brand identity package", modes: ["now", "later"] },
  { idempotencyKey: order.id },
);`;

/** The dark web shell's own pieces: sidebar, page header, menu, notices, code. */
export function SectionShell() {
  const [page, setPage] = useState("payments");
  const [mode, setMode] = useState("later");
  // The gallery has no routes: its nav links switch the active item in place.
  const NavLink = useMemo(
    () =>
      function GalleryNavLink({ href, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement>) {
        return (
          <a
            href={href}
            {...rest}
            onClick={(e) => {
              onClick?.(e);
              const key = href?.replace("#nav-", "");
              if (key && NAV.some((n) => n.key === key)) {
                e.preventDefault();
                setPage(key);
              }
            }}
          />
        );
      },
    [],
  );
  return (
    <Section
      id="shell"
      eyebrow="Web shell"
      title="The sidebar shell and shared pieces"
      description="The earlier dashboard shell, kept in the library: the sidebar (full from 1280px, an icon rail from 768px, the floating BottomNav below) and the page header. The merchant web app now uses ref E's frame and top nav (above). Its notices, error states, instalment ticks, copy buttons, the tabbed code panel and the phone frame are still used everywhere."
    >
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[264px_minmax(0,1fr)]">
        <SideNav
          items={NAV}
          value={page}
          brand={
            <span className="flex items-center gap-2.5">
              <Logo height={30} />
              <Badge tone="lime" size="sm">
                Business
              </Badge>
            </span>
          }
          brandCompact={<LogoMark size={30} />}
          brandHref="#shell"
          linkAs={NavLink}
          footer={
            <Card variant="raised" radius="tile" padding="sm" className="text-[13px] text-ui-muted">
              <span className="flex items-center gap-2 text-ui-text">
                <span className="size-2 rounded-full bg-ui-lime" /> Test mode
              </span>
              <span className="mt-1 block">Monad testnet</span>
            </Card>
          }
          className="static block h-[620px] md:block md:w-[264px] xl:w-[264px]"
        />

        <div className="flex min-w-0 flex-col gap-6">
          <Card padding="lg">
            <PageHeader
              eyebrow="Good morning, Oat & Ember"
              title="Overview"
              actions={
                <>
                  <Button variant="outline" icon={<Landmark />}>
                    Withdraw
                  </Button>
                  <Button variant="lime" icon={<Plus />}>
                    New link
                  </Button>
                </>
              }
              trailing={
                <Menu
                  label="Account"
                  align="end"
                  trigger={<Avatar name="Oat & Ember" tone="honey" size="md" decorative />}
                >
                  <Menu.Header>
                    <p className="text-[15px] font-medium">Oat & Ember</p>
                    <p className="text-[13px] text-ui-muted">ana@oatandember.studio</p>
                  </Menu.Header>
                  <Menu.Separator />
                  <Menu.Item icon={<Copy />} description="0x7a3f…91c2">
                    Copy payout address
                  </Menu.Item>
                  <Menu.Item icon={<Settings2 />}>Business settings</Menu.Item>
                  <Menu.Separator />
                  <Menu.Item icon={<LogOut />} tone="danger">
                    Sign out
                  </Menu.Item>
                </Menu>
              }
            />
          </Card>

          <div className="grid gap-3">
            <Notice tone="info" title="Checkout goes live with the shared link store">
              Links you create show here, but buyers can&apos;t open them yet.
            </Notice>
            <Notice tone="warn" title="Showing data from 2 minutes ago" action={<Button size="sm" variant="outline">Retry</Button>}>
              The last refresh failed.
            </Notice>
            <Notice tone="lime" title="Sample data is on">
              Every card and row that shows it carries a Sample chip.
            </Notice>
            <Notice tone="down" size="sm">
              Check the address: its capitalisation doesn&apos;t match its checksum.
            </Notice>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card padding="none">
              <ErrorState
                title="We couldn't reach our sign-in service"
                description="Check your connection, or turn off blockers for this site."
                onRetry={() => {}}
              />
            </Card>
            <Card padding="lg" className="flex flex-col gap-5">
              <Specimen label="Ticks: 2 of 4, 1 retrying, small">
                <Ticks done={2} total={4} className="w-40" />
                <Ticks done={1} late={1} total={4} className="w-40" />
                <Ticks done={3} total={4} size="sm" className="w-28" />
              </Specimen>
              <Specimen label="CopyButton: icon and button">
                <CopyButton value="0x7a3f00000000000000000000000000000091c2" label="payout address" />
                <CopyButton value="pk_test_5e8Tq" label="publishable key" variant="button" />
              </Specimen>
              <Specimen label="BottomNav, size sm (six items on a phone)">
                <BottomNav
                  size="sm"
                  items={NAV.map((n) => ({ key: n.key, label: n.label, icon: n.icon }))}
                  value={page}
                  onValueChange={setPage}
                />
              </Specimen>
            </Card>
          </div>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_auto]">
        <CodeBlock
          note="Preview · polarispay-sdk 0.3"
          samples={[
            { key: "node", label: "Node", filename: "app/api/checkout/route.ts", code: SNIPPET },
            {
              key: "html",
              label: "HTML",
              filename: "index.html",
              code: `<!-- A payment link needs no code at all -->\n<a href="YOUR_PAYMENT_LINK">Pay with Polaris</a>`,
            },
          ]}
        />
        <PhoneFrame width={300} className="mx-auto">
          <div className="flex h-full flex-col px-4 pb-8">
            <ScreenHeader variant="arrow" title="Oat & Ember" subtitle="Order #4821" />
            <KeyValueGrid
              className="mt-2"
              items={[
                { label: "Amount", value: "$200.00" },
                { label: "Pay in 4", value: "$50.38 × 4" },
              ]}
            />
            <SegmentedControl
              aria-label="Pay"
              className="mt-4"
              block
              value={mode}
              onValueChange={setMode}
              options={[
                { value: "now", label: "Pay now" },
                { value: "later", label: "Pay in 4" },
              ]}
            />
            <div className="mt-auto grid grid-cols-2 gap-2">
              <Button variant="purple">Pay in 4</Button>
              <Button variant="lime-bright">Pay now</Button>
            </div>
          </div>
        </PhoneFrame>
      </div>
    </Section>
  );
}
