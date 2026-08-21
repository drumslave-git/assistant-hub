import { Database, Search } from "lucide-react";

import { SearchBox } from "@/components/search/SearchBox";
import { EmptyState, PageHeader } from "@/components/ui";
import {
  MESSAGE_SEARCH_LIMIT,
  searchHistoryMessages,
  type MessageSearchHit,
} from "@/features/history/server/search";
import { MessageSearchResults } from "@/features/history/ui/MessageSearchResults";

// Searches the mirror at request time.
export const dynamic = "force-dynamic";

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/**
 * Message search results — where the top bar's search box lands.
 *
 * The query lives in the URL, so a search is shareable and survives a refresh.
 * Deliberately not live-refreshing, unlike the dashboard's status views: a
 * result set is the answer to a question asked once, and re-running it on every
 * incoming message would spend an embedding call each time to reshuffle rows
 * under the reader.
 */
export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = (first((await searchParams).q) ?? "").trim();

  let hits: MessageSearchHit[] | null = null;
  let searchError: string | null = null;
  if (query) {
    try {
      hits = await searchHistoryMessages({ query, limit: MESSAGE_SEARCH_LIMIT });
    } catch (err) {
      searchError = err instanceof Error ? err.message : "The search could not be run";
    }
  }

  return (
    <>
      <PageHeader
        title="Message search"
        description="Search every stored conversation — the message text and, for pictures and clips, what the bot saw in them."
      />

      {/* The top bar's box is hidden on narrow screens, so the page carries its
          own. It is also where you refine a search without reaching back up. */}
      <SearchBox defaultValue={query} className="max-w-xl sm:hidden" />

      {searchError ? (
        <EmptyState icon={Database} title="Search unavailable" description={searchError} />
      ) : hits ? (
        <MessageSearchResults query={query} hits={hits} />
      ) : (
        <EmptyState
          icon={Search}
          title="Search the conversations"
          description="Type what you are looking for. Searching combines meaning, whole words and literal text, across every chat the bot has stored."
        />
      )}
    </>
  );
}
