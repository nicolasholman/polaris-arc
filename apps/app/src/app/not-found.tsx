import { Adaptive, AppFrame, Button, EmptyState, Logo, PrimaryButton } from "@polaris/ui";
import { Link2Off } from "lucide-react";
import Link from "next/link";

const TITLE = "This link doesn't go anywhere";
const BODY = "It may have expired, or part of it went missing. Ask whoever sent it for a new one.";

/**
 * The 404. On a phone, the way back in the middle of the dark screen; from
 * 1024px, in ref E's frame like the merchant web's: the panel on the lime
 * canvas under the wordmark, a lime "404" and the lime button.
 */
export default function NotFound() {
  return (
    <Adaptive
      phone={
        <main id="main" className="mx-auto flex min-h-dvh w-full max-w-[440px] flex-col items-center justify-center px-5">
          <EmptyState
            icon={<Link2Off />}
            title={TITLE}
            description={BODY}
            action={
              <Button asChild variant="white" size="lg" shape="rounded">
                <Link href="/">Go to Polaris</Link>
              </Button>
            }
          />
        </main>
      }
      desktop={
        <AppFrame panelClassName="flex flex-col">
          <header className="flex h-[104px] items-center px-10 xl:h-[112px] xl:px-14">
            <Link href="/" aria-label="Polaris, home" className="rounded-[8px] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ui-focus">
              <Logo height={30} />
            </Link>
          </header>
          <main id="main" className="grid flex-1 place-items-center px-10 pb-20">
            <div className="grid max-w-[520px] justify-items-center gap-6 text-center">
              <p className="ui-figure text-[120px] leading-none font-medium tracking-[-0.06em] text-ui-lime-active">404</p>
              <div className="grid gap-2">
                <h1 className="text-[28px] leading-tight font-medium tracking-[-0.03em]">{TITLE}</h1>
                <p className="text-[16px] leading-relaxed text-ui-muted">{BODY}</p>
              </div>
              <PrimaryButton asChild size="md">
                <Link href="/">Go to Polaris</Link>
              </PrimaryButton>
            </div>
          </main>
        </AppFrame>
      }
    />
  );
}
