import Link from "next/link";
import { UsersRound } from "lucide-react";

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
import type { DirectoryChat } from "@/server/source/directory";
import { formatKnownGroupLabel } from "../format";

/**
 * Read-only list of the shared conversations the bot takes part in, across
 * every source. Each row links to that chat's detail (members + notes) by its
 * scoped ref. Server Component — no interactivity.
 */
export function KnownGroupsList({ groups }: { groups: DirectoryChat[] }) {
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Groups</CardTitle>
          <CardDescription>
            Captured automatically on each group message by the source that carries the chat.
            Members feed the roster injected into the model&apos;s context for that group.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        {groups.length === 0 ? (
          <EmptyState
            icon={UsersRound}
            title="No groups yet"
            description="Groups appear here once the bot receives a message in one. Add the bot to a group and send it a message."
          />
        ) : (
          <Table minWidth={780}>
            <TableHead>
              <TableRow header>
                <TableHeaderCell>Group</TableHeaderCell>
                <TableHeaderCell>Source</TableHeaderCell>
                <TableHeaderCell>Type</TableHeaderCell>
                <TableHeaderCell>Members</TableHeaderCell>
                <TableHeaderCell>Messages</TableHeaderCell>
                <TableHeaderCell>Last activity</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {groups.map((group) => (
                <TableRow key={group.ref}>
                  <TableCell className="font-medium text-foreground">
                    <Link
                      href={`/groups/${encodeURIComponent(group.ref)}`}
                      className="text-primary hover:underline"
                    >
                      {formatKnownGroupLabel({ title: group.title, chatId: group.id })}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted">{group.sourceLabel}</TableCell>
                  <TableCell className="text-muted">{group.type ?? "—"}</TableCell>
                  <TableCell className="text-muted">{group.memberCount}</TableCell>
                  <TableCell className="text-muted">{group.messageCount}</TableCell>
                  <TableCell className="text-muted">
                    {group.lastMessageAt ? <Timestamp iso={group.lastMessageAt} /> : "—"}
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
