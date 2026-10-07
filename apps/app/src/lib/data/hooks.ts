"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { data } from "./index";

export type Loadable<T> =
  | { status: "loading"; value?: undefined; error?: undefined }
  | { status: "ready"; value: T; error?: undefined }
  | { status: "error"; value?: T; error: unknown };

/**
 * Runs a read, and runs it again whenever the data source reports a change
 * (a payment settled, a link was claimed). Keeps the last value on screen
 * while a refresh is in flight, so nothing flickers back to a skeleton.
 */
export function useData<T>(read: () => Promise<T>, deps: readonly unknown[]): Loadable<T> & { reload: () => void } {
  const [state, setState] = useState<Loadable<T>>({ status: "loading" });
  const readRef = useRef(read);
  useEffect(() => {
    readRef.current = read;
  });
  const generation = useRef(0);

  const load = useCallback(() => {
    const id = ++generation.current;
    readRef
      .current()
      .then((value) => {
        if (id === generation.current) setState({ status: "ready", value });
      })
      .catch((error: unknown) => {
        if (id === generation.current) setState((prev) => ({ status: "error", error, value: prev.value }));
      });
  }, []);

  useEffect(() => {
    load();
    return data.subscribe(load);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- callers pass the read's inputs as deps
  }, deps);

  return { ...state, reload: load };
}
