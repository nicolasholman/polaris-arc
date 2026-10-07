// @vitest-environment node
import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CSS } from "../src/react/styles.js";
import {
  PayWithPolarisBNPL,
  PolarisCheckoutButton,
  PolarisMark,
  PolarisMessaging,
  PolarisPayButton,
  PolarisProvider,
} from "../src/react.js";

describe("server rendering", () => {
  it("renders every component without a window", () => {
    expect(typeof (globalThis as { window?: unknown }).window).toBe("undefined");
    const raw = renderToString(
      <PolarisProvider publishableKey="pk_test_51Hx8yQfT3sLk2Pz">
        <PolarisMessaging amount="200.00" />
        <PolarisCheckoutButton session="cs_test_a1B2c3D4e5F6g7H8" amount="200.00" />
        <PolarisPayButton merchant="0x70997970C51812dc3A010C7d01b50e0d17dc79C8" amount="25.00" orderId="o-1" />
        <PolarisMark title="Polaris" />
        <PayWithPolarisBNPL apiKey="k" amount="200.00" orderId="o-2" />
      </PolarisProvider>,
    );
    // React separates adjacent text nodes with <!-- --> in server output.
    const html = raw.split("<!-- -->").join("");
    expect(html).toContain("or 4 payments of <strong>$50.38</strong> with");
    expect(html).toContain("Pay with <span class=\"plrs-btn__word\">Polaris</span>");
    expect(html).toContain(`<span class="plrs-dim">or 4 × </span><strong>$50.38</strong><span class="plrs-dim"> with Pay in 4</span>`);
    expect(html).toContain("Pay $25.00");
    expect(html).toContain('aria-label="Polaris"');
    // Styles ship with the components: nothing to import.
    expect(html).toContain(".plrs-btn{");
  });

  it("never lists a legacy Pay in 4 instalment as due today: the loan engine collects nothing at checkout", () => {
    const legacy = renderToString(<PayWithPolarisBNPL apiKey="k" amount="200.00" orderId="o-2" />).split("<!-- -->").join("");
    expect(legacy).toContain("Nothing is taken today");
    expect(legacy).not.toContain(">Today<");
  });

  it("ships CSS that React 18 won't escape inside <style> (no quotes, brackets or ampersands)", () => {
    expect(CSS).not.toMatch(/["'<>&]/);
  });

  it("is deterministic, so hydration matches", () => {
    const render = () => renderToString(<PolarisCheckoutButton session="cs_test_a1B2c3D4e5F6g7H8" amount="99.99" theme="lime" />);
    expect(render()).toBe(render());
  });
});
