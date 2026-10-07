"use client";

import { Button, Input, ScanFrame, ScreenHeader, SecondaryButton, Sheet, useIsDesktop } from "@polaris/ui";
import { ClipboardPaste, ScanLine, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { RouteSheet, useCloseSheet } from "@/components/shell/sheet-host";
import { toAppPath } from "@/lib/links";

type Detector = { detect: (source: CanvasImageSource) => Promise<Array<{ rawValue: string }>> };
type DetectorCtor = new (options: { formats: string[] }) => Detector;

const detectorCtor = (): DetectorCtor | null =>
  typeof window !== "undefined" && "BarcodeDetector" in window
    ? (window as unknown as { BarcodeDetector: DetectorCtor }).BarcodeDetector
    : null;

/** Whether this browser can read QR codes from the camera (Chrome on Android can; Safari can't). */
function useCanScan(): boolean | null {
  return useSyncExternalStore(
    () => () => undefined,
    () => detectorCtor() !== null && !!navigator.mediaDevices?.getUserMedia,
    () => null,
  );
}

/**
 * Where a link found here opens. Over a tab, the checkout or claim takes this
 * sheet's place in history, so its Back or Done returns to the tab, not here.
 * Opened cold there is no tab behind, so it stacks and Back comes here.
 */
function useOpenLink(cold: boolean): (path: string) => void {
  const router = useRouter();
  return useCallback((path: string) => (cold ? router.push(path, { scroll: false }) : router.replace(path, { scroll: false })), [cold, router]);
}

/** Pay or claim a link (full): scan a Polaris code or paste a link. */
export function PaySheet({ cold = false }: { cold?: boolean }) {
  const go = useOpenLink(cold);
  const close = useCloseSheet();
  const canScan = useCanScan();
  const desktop = useIsDesktop();
  const [scanning, setScanning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [text, setText] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const open = useCallback(
    (value: string) => {
      const path = toAppPath(value, window.location.origin);
      if (!path) {
        setMessage("That isn't a Polaris link. Check it and try again.");
        return false;
      }
      go(path);
      return true;
    },
    [go],
  );

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setScanning(false);
  }, []);

  useEffect(() => stop, [stop]);

  async function start() {
    setMessage(null);
    const Ctor = detectorCtor();
    if (!Ctor) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      streamRef.current = stream;
      setScanning(true);
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      await video.play();
      const detector = new Ctor({ formats: ["qr_code"] });
      const loop = async () => {
        if (!streamRef.current) return;
        try {
          const hit = (await detector.detect(video))[0]?.rawValue;
          if (hit && open(hit)) {
            stop();
            return;
          }
        } catch {
          /* keep looking */
        }
        setTimeout(() => void loop(), 250);
      };
      void loop();
    } catch {
      setMessage("Polaris needs your camera to scan. You can paste the link instead.");
      stop();
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    open(text);
  }

  const pasteForm = <PasteForm text={text} setText={setText} message={message} setMessage={setMessage} submit={submit} open={open} />;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScreenHeader title="Pay or claim" onBack={close} className="-mt-2 shrink-0 px-5 lg:hidden" />
      <Sheet.Body className="flex flex-col [&>*]:shrink-0 gap-4 pt-1">
        {/* A computer rarely scans: from 1024px the paste field comes first,
            and the viewfinder only opens when you ask for the camera. */}
        {desktop ? pasteForm : null}
        {desktop && canScan && !scanning ? (
          <SecondaryButton size="lg" block icon={<ScanLine />} className="bg-ui-surface-2 hover:bg-ui-surface-3" onClick={() => void start()}>
            Scan with this computer&apos;s camera
          </SecondaryButton>
        ) : null}
        <ScanFrame className={desktop && !scanning ? "hidden" : undefined}>
          <video
            ref={videoRef}
            muted
            playsInline
            aria-label="Camera preview"
            className={scanning ? "absolute inset-0 size-full object-cover" : "hidden"}
          />
          {!scanning ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-8 text-center">
              {canScan === null ? null : canScan ? (
                <>
                  <p className="max-w-[26ch] text-[15px] text-ui-muted">Point your camera at a Polaris code to pay or claim.</p>
                  <Button variant="lime" size="md" icon={<ScanLine />} onClick={() => void start()}>
                    Scan a code
                  </Button>
                </>
              ) : (
                <p className="max-w-[28ch] text-[15px] leading-[1.45] text-ui-muted">
                  Open your phone&apos;s camera and point it at the code. It brings you straight here.
                </p>
              )}
            </div>
          ) : (
            <Button variant="dark" size="sm" icon={<X />} onClick={stop} className="absolute bottom-4 left-1/2 -translate-x-1/2">
              Stop
            </Button>
          )}
        </ScanFrame>

        {desktop ? null : pasteForm}
      </Sheet.Body>
    </div>
  );
}

/** Paste a link: the field, and Paste (Open once something is in it). */
function PasteForm({
  text,
  setText,
  message,
  setMessage,
  submit,
  open,
}: {
  text: string;
  setText: (v: string) => void;
  message: string | null;
  setMessage: (v: string | null) => void;
  submit: (e: FormEvent) => void;
  open: (value: string) => boolean;
}) {
  return (
    <form onSubmit={submit} className="flex items-end gap-2">
      <Input
        hideLabel
        label="Payment or claim link"
        inputMode="url"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        placeholder="Paste a Polaris link"
        value={text}
        onChange={(e) => setText(e.target.value)}
        wrapperClassName="min-w-0 flex-1"
        error={message ?? undefined}
      />
      {text ? (
        <Button type="submit" variant="lime" size="lg" className="h-12 px-5">
          Open
        </Button>
      ) : (
        <Button
          type="button"
          variant="dark"
          size="lg"
          icon={<ClipboardPaste />}
          className="h-12 px-5 lg:bg-ui-surface-2 lg:hover:bg-ui-surface-3"
          onClick={async () => {
            try {
              const clip = await navigator.clipboard.readText();
              setText(clip);
              open(clip);
            } catch {
              setMessage("Paste the link into the box.");
            }
          }}
        >
          Paste
        </Button>
      )}
    </form>
  );
}

/** The route: the intercepting page in app/@sheet (over the current tab), or the page itself (cold, over its tab). */
export function PayRoute({ cold }: { cold?: boolean }) {
  return (
    <RouteSheet
      label="Pay or claim a link"
      snapPoints={["full"]}
      cold={cold}
      desktop={{ as: "dialog", size: "md", title: "Pay or claim", description: "Paste a Polaris link. On your phone, point the camera at the code." }}
    >
      <PaySheet cold={cold} />
    </RouteSheet>
  );
}
