import Link from "next/link";
import { ExternalLink, SearchX } from "lucide-react";

import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@/components/ui";
import { Timestamp } from "@/components/time/Timestamp";
import { cn } from "@/lib/cn";
import type { MessageSearchHit } from "../server/search";

/**
 * Ranked message hits across every chat. Server Component — no interactivity.
 *
 * Columns mirror the single-chat mirror (`ChatHistoryTable`) so a row reads the
 * same in both places, plus the chat the hit came from, which is the column the
 * mirror cannot have and a cross-chat search cannot do without.
 */
export function MessageSearchResults({
  query,
  hits,
}: {
  query: string;
  hits: MessageSearchHit[];
}) {
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Results</CardTitle>
          <CardDescription>
            {hits.length === 0
              ? "No stored message matches."
              : `The ${hits.length} closest message${hits.length === 1 ? "" : "s"} to “${query}”, best first. ` +
                "Ranking mixes meaning with literal text, so the tail can be only loosely related."}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        {hits.length === 0 ? (
          <EmptyState
            icon={SearchX}
            title="Nothing found"
            description="No message matches this search. Messages sent in the last few minutes and media still awaiting description may not be indexed yet."
          />
        ) : (
          <Table minWidth={960}>
            <TableHead>
              <TableRow header>
                <TableHeaderCell>Sent</TableHeaderCell>
                <TableHeaderCell>Chat</TableHeaderCell>
                <TableHeaderCell>Msg</TableHeaderCell>
                <TableHeaderCell>Role</TableHeaderCell>
                <TableHeaderCell>Sender</TableHeaderCell>
                <TableHeaderCell>Content</TableHeaderCell>
                <TableHeaderCell>Trace</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {hits.map((hit) => (
                <TableRow key={`${hit.chatId}:${hit.telegramMessageId}`}>
                  <TableCell className="whitespace-nowrap text-xs text-faint">
                    <Timestamp iso={hit.sentAt} />
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    <Link
                      href={`/history/${encodeURIComponent(hit.chatId)}`}
                      className="text-primary hover:underline"
                    >
                      {hit.chatId}
                    </Link>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-faint">
                    {hit.telegramMessageId}
                  </TableCell>
                  <TableCell>
                    <Badge tone={hit.role === "assistant" ? "primary" : "neutral"}>
                      {hit.role}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted">
                    {hit.senderLabel ?? (hit.userId ? hit.userId : "—")}
                  </TableCell>
                  <TableCell className="max-w-[36rem] align-top">
                    <HitContent hit={hit} />
                    {hit.mediaKind ? (
                      <span className="ml-2 align-middle">
                        <Badge tone="neutral">{hit.mediaKind}</Badge>
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {hit.traceId ? (
                      <Link
                        href={`/debug/${hit.traceId}`}
                        className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                      >
                        <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                        Trace
                      </Link>
                    ) : (
                      <span className="text-xs text-faint">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * What the row shows as the message.
 *
 * A message's own text when it has any; otherwise the indexed projection, which
 * for an uncaptioned photo is its vision description — the whole reason such a
 * message is findable at all. Rendering the stored empty string instead would
 * answer a search with a blank row.
 */
function HitContent({ hit }: { hit: MessageSearchHit }) {
  const own = hit.content.trim();
  const indexed = hit.indexedContent?.trim();
  const [text, tone] = own
    ? ([own, "text-foreground"] as const)
    : indexed
      ? ([indexed, "text-muted italic"] as const)
      : ([null, ""] as const);
  if (!text) return <span className="text-faint">—</span>;
  // Clamped for scanning, not trimmed: a vision description runs to a paragraph
  // and would push every other hit off the screen. Nothing is cut server-side.
  return <span className={cn("line-clamp-3", tone)}>{text}</span>;
}
