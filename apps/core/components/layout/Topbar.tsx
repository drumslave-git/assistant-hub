"use client";

import { LogOut, Menu } from "lucide-react";
import { useRouter, useSearchParams, useSelectedLayoutSegment } from "next/navigation";
import { Suspense } from "react";
import { Button } from "@/components/ui/Button";
import { SearchBox } from "@/components/search/SearchBox";
import { ThemeToggle } from "@/components/theme/ThemeToggle";

/**
 * Sticky dashboard top bar: mobile menu trigger, message search, and actions.
 *
 * Everything here does something. It previously also carried a notification bell
 * and an operator avatar, both inert — the bell had nothing to show (failures
 * that matter reach `SystemAlerts`, which is deliberately the only global alert
 * surface) and there are no user accounts to have a profile for, only the one
 * password-holding operator whose sign-out is already its own button.
 */
export function Topbar({ onMenuClick }: { onMenuClick: () => void }) {
  return (
    <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-border bg-background/80 px-4 backdrop-blur-md md:px-6">
      <Button
        variant="ghost"
        size="icon"
        className="md:hidden"
        onClick={onMenuClick}
        aria-label="Open navigation"
      >
        <Menu className="h-5 w-5" />
      </Button>

      {/* `useSearchParams` inside the boundary: this bar is rendered by the
          dashboard layout, so without it every statically rendered page under
          that layout would fail the production build. The fallback is the same
          box, merely unseeded. */}
      <Suspense fallback={<SearchBox className={SEARCH_BOX_CLASS} />}>
        <TopbarSearch />
      </Suspense>

      <div className="flex flex-1 items-center justify-end gap-1">
        <ThemeToggle />
        <SignOutButton />
      </div>
    </header>
  );
}

const SEARCH_BOX_CLASS = "hidden max-w-sm flex-1 sm:block";

/**
 * The search box, seeded from the URL while the results page is open so the bar
 * shows the search you are looking at rather than an empty box over its results.
 */
function TopbarSearch() {
  const onResults = useSelectedLayoutSegment() === "search";
  const params = useSearchParams();
  return (
    <SearchBox
      defaultValue={onResults ? (params.get("q") ?? "") : ""}
      className={SEARCH_BOX_CLASS}
    />
  );
}

/** Ends the operator session (expires the cookie) and returns to /login. */
function SignOutButton() {
  const router = useRouter();
  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    router.push("/login");
    router.refresh();
  }
  return (
    <Button variant="ghost" size="icon" onClick={signOut} aria-label="Sign out">
      <LogOut className="h-4.5 w-4.5" />
    </Button>
  );
}
