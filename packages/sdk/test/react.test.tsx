// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CheckoutResult } from "../src/checkout/types.js";
import type { Polaris } from "../src/client.js";
import { PolarisError } from "../src/errors.js";
import type { PayParams, PayResult } from "../src/pay/direct.js";
import { PolarisCheckoutButton, PolarisMessaging, PolarisPayButton, usePolarisCheckout } from "../src/react.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(node: React.ReactNode) {
  act(() => root.render(node));
}

/** A Polaris client whose checkout and pay are controlled by the test. */
function fakeClient(overrides: Partial<Polaris> = {}): Polaris {
  return {
    openCheckout: vi.fn(),
    redirectToCheckout: vi.fn(),
    pay: vi.fn(),
    ...overrides,
  } as unknown as Polaris;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const button = () => container.querySelector<HTMLButtonElement>("button.plrs-btn")!;

describe("PolarisCheckoutButton", () => {
  it("renders the mark, the label and the Pay in 4 line, described for assistive tech", () => {
    render(<PolarisCheckoutButton polaris={fakeClient()} session={{ id: "cs_test_1", amount: "200.00", modes: ["now", "later"] }} />);
    expect(button().textContent).toBe("Pay with Polaris");
    expect(button().querySelector("svg.plrs-mark")).not.toBeNull();
    const caption = container.querySelector(".plrs-caption")!;
    expect(caption.textContent).toBe("or 4 × $50.38 with Pay in 4");
    expect(button().getAttribute("aria-describedby")).toBe(caption.id);
  });

  it("never calls a plan interest-free: every Polaris plan is 10% APR", () => {
    render(<PolarisCheckoutButton polaris={fakeClient()} session="cs_test_1" amount="200.00" />);
    expect(container.querySelector(".plrs-caption")!.textContent).toBe("or 4 × $50.38 with Pay in 4");
    render(<PolarisCheckoutButton polaris={fakeClient()} session="cs_test_1" amount="200.00" aprBps={0} />);
    expect(container.textContent).not.toMatch(/interest-free|no interest/i);
  });

  it("hides the Pay in 4 line when the session doesn't offer it", () => {
    render(<PolarisCheckoutButton polaris={fakeClient()} session={{ id: "cs_test_1", amount: "200.00", modes: ["now"] }} />);
    expect(container.querySelector(".plrs-caption")).toBeNull();
  });

  it("opens the checkout, shows progress, then Paid", async () => {
    const outcome = deferred<CheckoutResult>();
    const polaris = fakeClient({ openCheckout: vi.fn(() => outcome.promise) });
    const onSuccess = vi.fn();
    render(<PolarisCheckoutButton polaris={polaris} session="cs_test_1" amount="20.00" onSuccess={onSuccess} />);

    act(() => button().click());
    expect(polaris.openCheckout).toHaveBeenCalledWith("cs_test_1", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(button().getAttribute("aria-busy")).toBe("true");
    expect(button().textContent).toContain("Finish in the Polaris window");

    const result: CheckoutResult = {
      status: "completed",
      sessionId: "cs_test_1",
      mode: "now",
      orderId: "o",
      txHash: "0x01",
      paymentId: null,
      planId: null,
      subscriptionId: null,
    };
    await act(async () => outcome.resolve(result));
    expect(button().textContent).toBe("Paid with Polaris");
    expect(button().dataset.state).toBe("done");
    expect(onSuccess).toHaveBeenCalledWith(result);
    expect(container.querySelector('[role="status"]')!.textContent).toBe("Payment complete.");
  });

  it("creates the session on click, and returns to idle when the buyer closes the window", async () => {
    const outcome = deferred<CheckoutResult>();
    let passed: unknown;
    const polaris = fakeClient({
      openCheckout: vi.fn((source: unknown) => {
        passed = source;
        return outcome.promise;
      }),
    });
    const createSession = vi.fn(async () => ({ id: "cs_test_2", url: "https://pay.polarispay.app/pay/cs_test_2" }));
    const onCancel = vi.fn();
    render(<PolarisCheckoutButton polaris={polaris} createSession={createSession} amount="50.00" onCancel={onCancel} />);

    act(() => button().click());
    expect(button().textContent).toContain("Opening Polaris");
    // The hook hands openCheckout a function, so the popup can open inside the click.
    expect(typeof passed).toBe("function");
    await act(async () => {
      await (passed as () => Promise<unknown>)();
    });
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(button().textContent).toContain("Finish in the Polaris window");

    await act(async () => outcome.resolve({ status: "closed", sessionId: "cs_test_2" }));
    expect(button().textContent).toBe("Pay with Polaris");
    expect(onCancel).toHaveBeenCalled();
  });

  it("explains a blocked popup", async () => {
    const polaris = fakeClient({
      openCheckout: vi.fn(async () => {
        throw new PolarisError("blocked", { type: "checkout_error", code: "popup_blocked" });
      }),
    });
    const onError = vi.fn();
    render(<PolarisCheckoutButton polaris={polaris} session="cs_test_1" onError={onError} />);
    await act(async () => button().click());
    expect(container.querySelector('[role="alert"]')!.textContent).toMatch(/Allow pop-ups/);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "popup_blocked" }));
  });

  it("is disabled without a session to open", () => {
    render(<PolarisCheckoutButton polaris={fakeClient()} />);
    expect(button().disabled).toBe(true);
  });
});

describe("PolarisMessaging", () => {
  it("renders the product-page line", () => {
    render(<PolarisMessaging amount="200.00" />);
    expect(container.textContent).toContain("or 4 payments of $50.38 with Polaris");
  });

  it("says Pay in 4 is paused, and that paying now works, while the credit guard has paused it", () => {
    render(<PolarisMessaging amount="200.00" paused />);
    expect(container.textContent).toContain("Pay in 4 is paused by our risk guard; pay now works as usual.");
    expect(container.textContent).not.toContain("4 payments of");
    expect(container.querySelector("button.plrs-link")).toBeNull();
    render(<PolarisMessaging amount="200.00" paused="Pay in 4 is resting today." />);
    expect(container.textContent).toContain("Pay in 4 is resting today.");
    render(<PolarisMessaging amount="200.00" paused={null} />);
    expect(container.textContent).toContain("or 4 payments of $50.38 with Polaris");
  });

  it("opens an accessible Learn more popover and closes on Escape, returning focus", () => {
    render(<PolarisMessaging amount="200.00" />);
    const trigger = container.querySelector<HTMLButtonElement>("button.plrs-link")!;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    act(() => trigger.click());
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.getAttribute("aria-controls")).toBe(dialog.id);
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)!.textContent).toBe("Pay in 4 with Polaris");
    expect(document.activeElement).toBe(dialog);
    expect(dialog.textContent).toContain("$201.53 in total, including $1.53 interest (10% APR).");
    // Nothing is collected at checkout: the loan engine's first instalment falls due one interval later.
    expect(Array.from(dialog.querySelectorAll(".plrs-when")).map((n) => n.textContent)).toEqual(["In 1 week", "In 2 weeks", "In 3 weeks", "In 4 weeks"]);
    expect(dialog.textContent).toContain("Nothing to pay today. Your first payment of $50.38 is in 1 week, and the rest follow every week, automatically.");
    expect(dialog.textContent).not.toMatch(/Pay \$[\d.,]+ today/);

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("dates a short plan from checkout too: the first payment is one interval out", () => {
    render(<PolarisMessaging amount="200.00" intervalSeconds={86_400} />);
    act(() => container.querySelector<HTMLButtonElement>("button.plrs-link")!.click());
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(Array.from(dialog.querySelectorAll(".plrs-when")).map((n) => n.textContent)).toEqual(["Tomorrow", "In 2 days", "In 3 days", "In 4 days"]);
    // $200 over four days at 10%: 200_219_178 owed, first rung ceil(/4) = 50_054_795.
    expect(dialog.textContent).toContain("Your first payment of $50.05 is tomorrow, and the rest follow every day, automatically.");
  });

  it("reads hourly and minute-long demo plans in hours and minutes", () => {
    render(<PolarisMessaging amount="200.00" intervalSeconds={3_600} />);
    act(() => container.querySelector<HTMLButtonElement>("button.plrs-link")!.click());
    let dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(Array.from(dialog.querySelectorAll(".plrs-when")).map((n) => n.textContent)).toEqual(["In 1 hour", "In 2 hours", "In 3 hours", "In 4 hours"]);
    expect(dialog.textContent).toContain("is in 1 hour, and the rest follow every hour, automatically.");

    render(<PolarisMessaging amount="200.00" intervalSeconds={60} />);
    dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(Array.from(dialog.querySelectorAll(".plrs-when")).map((n) => n.textContent)).toEqual(["In 1 min", "In 2 min", "In 3 min", "In 4 min"]);
    expect(dialog.textContent).toContain("is in 1 min, and the rest follow every minute, automatically.");
    // Four minutes at 10% is 152 micro-dollars of interest: it shows as $0.00 rather than throwing.
    expect(dialog.textContent).toContain("$200.00 in total, including $0.00 interest (10% APR).");
  });

  it("prices a cart too small to split without throwing", () => {
    render(<PolarisMessaging amount="0.02" minAmount="0.01" />);
    expect(container.textContent).toContain("or 4 payments of $0.01 with Polaris");
    act(() => container.querySelector<HTMLButtonElement>("button.plrs-link")!.click());
    const rows = Array.from(container.querySelectorAll(".plrs-amt")).map((n) => n.textContent);
    expect(rows).toEqual(["$0.01", "$0.00", "$0.01", "$0.00"]);
  });

  it("closes on an outside click and on the close button", () => {
    render(<PolarisMessaging amount="200.00" />);
    const trigger = container.querySelector<HTMLButtonElement>("button.plrs-link")!;
    act(() => trigger.click());
    act(() => {
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    act(() => trigger.click());
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click());
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("renders nothing outside the range Pay in 4 serves", () => {
    render(<PolarisMessaging amount="9000.00" />);
    expect(container.innerHTML).toBe("");
    render(<PolarisMessaging amount="0.50" />);
    expect(container.innerHTML).toBe("");
    render(<PolarisMessaging amount="not a price" />);
    expect(container.innerHTML).toBe("");
  });
});

describe("PolarisPayButton", () => {
  it("walks the stages, then shows Paid with a receipt link", async () => {
    const result = deferred<PayResult>();
    let stage: ((s: "connecting" | "signing" | "submitting" | "confirming") => void) | undefined;
    const polaris = fakeClient({
      pay: vi.fn((p: PayParams) => {
        stage = p.onStage;
        return result.promise;
      }),
    });
    const onSuccess = vi.fn();
    render(<PolarisPayButton polaris={polaris} merchant="0x70997970C51812dc3A010C7d01b50e0d17dc79C8" amount="25" orderId={() => "o-9"} onSuccess={onSuccess} />);
    expect(button().textContent).toBe("Pay $25.00");

    act(() => button().click());
    expect(polaris.pay).toHaveBeenCalledWith(expect.objectContaining({ orderId: "o-9", amount: "25" }));
    act(() => stage!("signing"));
    expect(button().textContent).toContain("Confirm in your wallet");

    const paid: PayResult = { ok: true, transactionHash: "0xab", explorerUrl: "https://testnet.monadvision.com/tx/0xab" };
    await act(async () => result.resolve(paid));
    expect(button().textContent).toBe("Paid $25.00");
    expect(container.querySelector<HTMLAnchorElement>("a")!.href).toBe("https://testnet.monadvision.com/tx/0xab");
    expect(onSuccess).toHaveBeenCalledWith(paid);
  });

  it("shows the buyer's error", async () => {
    const polaris = fakeClient({ pay: vi.fn(async () => ({ ok: false, error: "You cancelled the request." })) });
    const onError = vi.fn();
    render(<PolarisPayButton polaris={polaris} merchant="0x70997970C51812dc3A010C7d01b50e0d17dc79C8" amount="25.00" orderId="o" onError={onError} />);
    await act(async () => button().click());
    expect(container.querySelector('[role="alert"]')!.textContent).toBe("You cancelled the request.");
    expect(onError).toHaveBeenCalledWith("You cancelled the request.", expect.objectContaining({ ok: false }));
  });
});

describe("usePolarisCheckout", () => {
  it("exposes status and result", async () => {
    const outcome = deferred<CheckoutResult>();
    const polaris = fakeClient({ openCheckout: vi.fn(() => outcome.promise) });
    let api!: ReturnType<typeof usePolarisCheckout>;
    function Probe() {
      api = usePolarisCheckout({ polaris });
      return <span data-status={api.status} />;
    }
    render(<Probe />);
    expect(api.status).toBe("idle");
    act(() => {
      void api.open("cs_test_1");
    });
    expect(api.status).toBe("open");
    expect(api.busy).toBe(true);
    await act(async () => outcome.resolve({ status: "timeout", sessionId: "cs_test_1" }));
    expect(api.status).toBe("timeout");
    expect(api.result).toEqual({ status: "timeout", sessionId: "cs_test_1" });
    act(() => api.reset());
    expect(api.status).toBe("idle");
  });
});
