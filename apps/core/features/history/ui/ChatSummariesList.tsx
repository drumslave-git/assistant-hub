import { Sparkles } from "lucide-react";

import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  EmptyState,
  ScrollArea,
} from "@/components/ui";
import type { ChatSummaryRecord } from "../server/summaries-repository";

/**
 * A chat's stored topic summaries, grouped by day (newest first). Server
 * Component — read-only display.
 *
 * The message ids are shown, not hidden: they are what the bot follows back to
 * the original messages, so an operator debugging a bad recall can see exactly
 * which messages a topic claims to summarize and check it against the mirror
 * in the Messages tab.
 */
export function ChatSummariesList({
  summaries,
}: {
  summaries: ChatSummaryRecord[];
}) {
  if (summaries.length === 0) {
    return (
      <Card>
        <CardContent>
          <EmptyState
            icon={Sparkles}
            title="No summaries yet"
            description="Finished days are summarized by the daily job. A day that is still in progress is never summarized — it is already injected into every reply in full."
          />
        </CardContent>
      </Card>
    );
  }

  // Group by day, preserving the newest-first order the query returned.
  const byDate = new Map<string, ChatSummaryRecord[]>();
  for (const summary of summaries) {
    const list = byDate.get(summary.summaryDate);
    if (list) list.push(summary);
    else byDate.set(summary.summaryDate, [summary]);
  }

  return (
    <Card>
      <CardHeader>
        <CardDescription>
          What the bot searches to recall this conversation beyond the last 24
          hours. Each topic links back to the messages it came from.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ScrollArea className="space-y-6">
          {[...byDate.entries()].map(([date, topics]) => (
            <section key={date} className="space-y-3">
              <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
                {/* A summary date is a wall-clock day, not an instant — rendering it
                  through <Timestamp> would shift it by the viewer's zone offset. */}
                <span>{date}</span>
                <span className="text-xs font-normal text-muted">
                  {topics.length} {topics.length === 1 ? "topic" : "topics"}
                </span>
              </h3>
              <ul className="space-y-3">
                {topics.map((topic) => (
                  <li
                    key={topic.id}
                    className="rounded-md border border-border p-3"
                  >
                    <p className="whitespace-pre-wrap text-sm text-foreground">
                      {topic.content}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {topic.embedded ? null : (
                        <Badge tone="warning">
                          Not embedded — keyword search only
                        </Badge>
                      )}
                      <span className="text-xs text-muted">
                        {topic.messageIds.length > 0
                          ? `Messages: ${topic.messageIds.map((id) => `#${id}`).join(", ")}`
                          : "No message ids"}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
