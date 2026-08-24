import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge conditional class names, resolving conflicting Tailwind utilities so the
 * last one wins (e.g. `cn("p-2", condition && "p-4")` → `p-4`). Use everywhere a
 * component composes a base style with caller-provided `className`.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
