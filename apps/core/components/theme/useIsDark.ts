"use client";

import { useSyncExternalStore } from "react";

/**
 * Reactive read of the app's current theme from the DOM (`.dark` on <html>).
 * Shared by any client component that must restyle when the theme toggles
 * (e.g. the JSON viewer). Uses `useSyncExternalStore` over a class MutationObserver
 * so there's no effect-driven flicker and it stays in sync with `ThemeToggle`.
 */
function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => observer.disconnect();
}

const isDark = () => document.documentElement.classList.contains("dark");

/** `true` when the dark theme is active. Dark-first: assumes dark before hydration. */
export function useIsDark(): boolean {
  return useSyncExternalStore(subscribe, isDark, () => true);
}
