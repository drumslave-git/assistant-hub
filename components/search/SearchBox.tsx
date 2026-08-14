"use client";

import { Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Input } from "@/components/ui";
import { cn } from "@/lib/cn";

/**
 * The dashboard's message search entry, shared by the top bar and the results
 * page so the two cannot drift apart.
 *
 * Submitting navigates to `/search?q=…` rather than fetching in place: the
 * results page is a Server Component, and a real URL is shareable, bookmarkable
 * and survives a refresh — the same reason the trace filters and pagination push
 * their state into the URL.
 */
export function SearchBox({
  defaultValue = "",
  placeholder = "Search messages…",
  className,
}: {
  defaultValue?: string;
  placeholder?: string;
  className?: string;
}) {
  const router = useRouter();
  const [value, setValue] = useState(defaultValue);

  // Reset to the incoming query when it changes, adjusting state during render
  // rather than in an effect (React's documented pattern for a prop-derived
  // reset — an effect would render the stale value once first). The top bar
  // lives in the layout and is never remounted by a navigation, so without this
  // it would keep showing what was typed two searches ago.
  const [seeded, setSeeded] = useState(defaultValue);
  if (seeded !== defaultValue) {
    setSeeded(defaultValue);
    setValue(defaultValue);
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const query = value.trim();
    router.push(query ? `/search?q=${encodeURIComponent(query)}` : "/search");
  }

  return (
    <form onSubmit={submit} role="search" className={cn("relative", className)}>
      <Search
        className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-faint"
        aria-hidden
      />
      <Input
        type="search"
        name="q"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={placeholder}
        aria-label="Search messages"
        className="h-9 pl-9"
      />
      {/* A form whose only control is a text field submits on Enter in most
          browsers, but not all of them, and never for a user driving it with
          assistive technology. The button is the actual submit; it is hidden
          because a magnifying glass already labels the field. */}
      <button type="submit" className="sr-only">
        Search
      </button>
    </form>
  );
}
