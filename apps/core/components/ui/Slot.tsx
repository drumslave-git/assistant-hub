import {
  Children,
  cloneElement,
  isValidElement,
  type HTMLAttributes,
  type ReactElement,
} from "react";
import { cn } from "@/lib/cn";

/**
 * Minimal `asChild` slot: merges the component's props onto its single child
 * element instead of rendering a wrapper. Lets primitives like `Button` render
 * as a Next `<Link>` while keeping their styles. Class names are merged with
 * `cn`; other props from the slot are applied first so the child can override.
 */
export function Slot({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLElement>) {
  if (!isValidElement(children)) {
    return null;
  }
  const child = Children.only(children) as ReactElement<
    Record<string, unknown>
  >;
  const childProps = child.props;
  return cloneElement(child, {
    ...props,
    ...childProps,
    className: cn(className, childProps.className as string | undefined),
  });
}
