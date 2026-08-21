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
import { formatKnownGroupLabel } from "../format";
import type { KnownGroupSummary } from "../server/schema";

/**
 * Read-only list of groups the bot participates in. Each row links to that
 * group's detail (members + notes). Server Component — no interactivity.
 */
export function KnownGroupsList({ groups }: { groups: KnownGroupSummary[] }) {
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Groups</CardTitle>
          <CardDescription>
            Captured automatically on each group message. Members feed the roster injected into the
            model&apos;s context for that group.
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
          <Table minWidth={640}>
            <TableHead>
              <TableRow header>
                <TableHeaderCell>Group</TableHeaderCell>
                <TableHeaderCell>Type</TableHeaderCell>
                <TableHeaderCell>Members</TableHeaderCell>
                <TableHeaderCell>Last activity</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {groups.map((group) => (
                <TableRow key={group.chatId}>
                  <TableCell className="font-medium text-foreground">
                    <Link
                      href={`/groups/${encodeURIComponent(group.chatId)}`}
                      className="text-primary hover:underline"
                    >
                      {formatKnownGroupLabel(group)}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted">{group.type ?? "—"}</TableCell>
                  <TableCell className="text-muted">{group.memberCount}</TableCell>
                  <TableCell className="text-muted">
                    <Timestamp iso={group.updatedAt} />
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
