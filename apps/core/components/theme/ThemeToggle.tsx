"use client";

import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useIsDark } from "./useIsDark";

/**
 * Toggles the `.dark` class on <html> and persists the choice. Pairs with
 * ThemeScript, which applies the stored value before hydration. The current
 * theme is read from the DOM via {@link useIsDark} so the icon stays in sync
 * without effect-driven state.
 */
export function ThemeToggle() {
  // Dark-first: the server and pre-hydration script both assume dark.
  const dark = useIsDark();

  function toggle() {
    const next = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("theme", next ? "dark" : "light");
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggle}
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      title="Toggle theme"
    >
      {dark ? <Moon className="h-4.5 w-4.5" /> : <Sun className="h-4.5 w-4.5" />}
    </Button>
  );
}
