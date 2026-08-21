import Link from "next/link";
import { Users } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  EmptyState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@/components/ui";
import { formatKnownUserLabel } from "@/features/known-users/format";
import { Timestamp } from "@/components/time/Timestamp";
import type { GroupMember } from "../server/schema";

/**
 * Read-only roster of a group's known members: the people who have messaged in
 * it, with the aliases the operator has curated on the Users page. Server
 * Component — aliases are edited on `/users`, not here.
 */
export function GroupMembersCard({ members }: { members: GroupMember[] }) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>
          Known users seen in this group. This roster is injected into the model&apos;s context so
          it can recognize who is who.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {members.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No members yet"
            description="Members appear here once users send messages in this group."
          />
        ) : (
          <Table minWidth={640}>
            <TableHead>
              <TableRow header>
                <TableHeaderCell>Member</TableHeaderCell>
                <TableHeaderCell>Aliases</TableHeaderCell>
                <TableHeaderCell>Last seen</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {members.map((member) => (
                <TableRow key={member.userId}>
                  <TableCell className="font-medium text-foreground">
                    <Link
                      href={`/users`}
                      className="text-primary hover:underline"
                      title="Edit on the Users page"
                    >
                      {formatKnownUserLabel(member)}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted">
                    {member.aliases.length > 0 ? member.aliases.join(", ") : "—"}
                  </TableCell>
                  <TableCell className="text-muted">
                    <Timestamp iso={member.lastSeenAt} />
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
