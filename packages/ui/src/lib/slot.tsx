import { Children, cloneElement, isValidElement, type ReactElement, type Ref } from "react";

import { cn } from "./cn";

type AnyProps = Record<string, unknown> & { className?: string; ref?: Ref<unknown> };

/**
 * Render the single child in place of the component's own element, merging
 * props onto it. How `asChild` lets a Button be a Next.js <Link>.
 */
export function Slot({ children, ...props }: AnyProps & { children?: React.ReactNode }) {
  const child = Children.only(children);
  if (!isValidElement(child)) return null;
  const el = child as ReactElement<AnyProps>;
  const childProps = el.props;
  const merged: AnyProps = { ...props, ...childProps };
  for (const key of Object.keys(props)) {
    const ours = props[key];
    const theirs = childProps[key];
    if (key.startsWith("on") && typeof ours === "function" && typeof theirs === "function") {
      merged[key] = (...args: unknown[]) => {
        (theirs as (...a: unknown[]) => void)(...args);
        (ours as (...a: unknown[]) => void)(...args);
      };
    }
  }
  merged.className = cn(props.className, childProps.className);
  if (props.style && childProps.style) {
    merged.style = { ...(props.style as object), ...(childProps.style as object) };
  }
  return cloneElement(el, merged);
}
