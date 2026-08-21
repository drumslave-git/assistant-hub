import { Slot } from "./Slot";
import { cn } from "@/lib/cn";
import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "outline"
  | "ghost"
  | "danger";
export type ButtonSize = "sm" | "md" | "lg" | "icon";

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-primary text-primary-foreground hover:bg-primary-hover shadow-sm shadow-primary/20",
  secondary:
    "bg-surface-2 text-foreground hover:bg-surface-hover border border-border",
  outline:
    "border border-border text-foreground hover:bg-surface-2 hover:border-border-strong",
  ghost: "text-muted hover:bg-surface-2 hover:text-foreground",
  danger: "bg-danger text-white hover:brightness-110",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-xs gap-1.5",
  md: "h-9 px-4 text-sm gap-2",
  lg: "h-11 px-5 text-sm gap-2",
  icon: "h-9 w-9 justify-center",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Render onto the child element (e.g. a Next `<Link>`) instead of a `<button>`. */
  asChild?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
}

export function Button({
  className,
  variant = "primary",
  size = "md",
  asChild = false,
  leftIcon,
  rightIcon,
  children,
  type,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      className={cn(
        "inline-flex items-center rounded-lg font-medium whitespace-nowrap transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "disabled:pointer-events-none disabled:opacity-50",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      // `asChild` forwards to an element (like <a>) that has no `type`.
      {...(asChild ? {} : { type: type ?? "button" })}
      {...props}
    >
      {asChild ? (
        children
      ) : (
        <>
          {leftIcon}
          {children}
          {rightIcon}
        </>
      )}
    </Comp>
  );
}
