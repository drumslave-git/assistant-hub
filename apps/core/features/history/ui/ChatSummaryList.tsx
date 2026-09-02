import Link from "next/link";
import { MessageSquare } from "lucide-react";

import {
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
import type { ChatSummaryView } from "../server/schema";

/**
 * Read-only list of chats with stored history. Each row links to that chat's
 * full mirror. Server Component — no interactivity.
 */
export function ChatSummaryList({ chats }: { chats: ChatSummaryView[] }) {
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Conversations</CardTitle>
          <CardDescription>
            Every chat the bot has stored messages for. History mirrors sends and edits 1:1.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        {chats.length === 0 ? (
          <EmptyState
            icon={MessageSquare}
            title="No history yet"
            description="Messages appear here once the bot receives them. Start the bot and send it a message."
          />
        ) : (
          <Table minWidth={560}>
            <TableHead>
              <TableRow header>
                <TableHeaderCell>Chat</TableHeaderCell>
                <TableHeaderCell>Transport</TableHeaderCell>
                <TableHeaderCell>Ref</TableHeaderCell>
                <TableHeaderCell>Messages</TableHeaderCell>
                <TableHeaderCell>Last activity</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {chats.map((chat) => (
                <TableRow key={chat.chatRef}>
                  <TableCell>
                    <Link
                      href={`/history/${encodeURIComponent(chat.chatRef)}`}
                      className="text-primary hover:underline"
                    >
                      {chat.label}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted">{chat.sourceLabel}</TableCell>
                  <TableCell className="font-mono text-xs text-faint">{chat.chatRef}</TableCell>
                  <TableCell className="text-muted">{chat.messageCount}</TableCell>
                  <TableCell className="text-muted">
                    <Timestamp iso={chat.lastSentAt} />
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
