"use client";

import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { Sidebar, type BotStatus } from "./Sidebar";
import { Topbar } from "./Topbar";

/**
 * Dashboard frame: a fixed sidebar rail on desktop and an off-canvas drawer on
 * mobile, with a sticky top bar and a scrolling content column. Content is
 * width-constrained and padded consistently so every page shares the same
 * rhythm.
 */
export function AppShell({
  children,
  botStatus,
}: {
  children: React.ReactNode;
  botStatus: BotStatus;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Close the drawer on Escape for keyboard users.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  return (
    <div className="min-h-screen bg-background">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-border bg-surface md:block">
        <Sidebar botStatus={botStatus} />
      </aside>

      {/* Mobile drawer */}
      <div
        className={cn(
          "fixed inset-0 z-40 md:hidden",
          drawerOpen ? "pointer-events-auto" : "pointer-events-none",
        )}
        aria-hidden={!drawerOpen}
      >
        <div
          className={cn(
            "absolute inset-0 bg-black/50 transition-opacity motion-reduce:transition-none",
            drawerOpen ? "opacity-100" : "opacity-0",
          )}
          onClick={() => setDrawerOpen(false)}
        />
        <div
          className={cn(
            "absolute inset-y-0 left-0 flex w-72 max-w-[85%] flex-col border-r border-border bg-surface shadow-xl transition-transform duration-200 motion-reduce:transition-none",
            drawerOpen ? "translate-x-0" : "-translate-x-full",
          )}
          role="dialog"
          aria-modal="true"
          aria-label="Navigation"
        >
          <Button
            variant="ghost"
            size="icon"
            className="absolute top-4 right-3"
            onClick={() => setDrawerOpen(false)}
            aria-label="Close navigation"
          >
            <X className="h-5 w-5" />
          </Button>
          <Sidebar botStatus={botStatus} onNavigate={() => setDrawerOpen(false)} />
        </div>
      </div>

      {/* Main column */}
      <div className="flex min-h-screen flex-col md:pl-64">
        <Topbar onMenuClick={() => setDrawerOpen(true)} />
        {/* The generous bottom padding is for the floating action button: it is
            `fixed`, so without room reserved here it would sit on top of the
            last row of a table or the final field of a form. Reserved for every
            page rather than only the ones with a Fab — the alternative is the
            layout knowing which pages have one, and a page that grows an action
            silently starting to cover its own content. */}
        <main className="flex-1 px-4 py-6 pb-28 md:px-8 md:py-8 md:pb-32">
          <div className="w-full space-y-6">{children}</div>
        </main>
      </div>
    </div>
  );
}
