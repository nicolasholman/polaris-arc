import assert from "node:assert/strict";
import { test } from "node:test";
import { createInstallStore } from "../src/lib/install.ts";

test("holds an early install event until the profile subscribes and consumes it once", () => {
  const store = createInstallStore();
  const browser = new EventTarget();
  const stop = store.capture(browser);
  const event = new Event("beforeinstallprompt", { cancelable: true });
  browser.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(store.snapshot().prompt, event);
  let changes = 0;
  const unsubscribe = store.subscribe(() => changes++);
  store.consume();
  assert.equal(store.snapshot().prompt, null);
  assert.equal(changes, 1);
  unsubscribe();
  stop();
});

test("installation clears the prompt and removes the guide; cleanup releases browser listeners", () => {
  const store = createInstallStore();
  const browser = new EventTarget();
  const stop = store.capture(browser);
  browser.dispatchEvent(new Event("beforeinstallprompt"));
  browser.dispatchEvent(new Event("appinstalled"));
  assert.deepEqual(store.snapshot(), { prompt: null, installed: true });
  stop();
  browser.dispatchEvent(new Event("beforeinstallprompt"));
  assert.deepEqual(store.snapshot(), { prompt: null, installed: true });
});
