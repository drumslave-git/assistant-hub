"use client";

import { EarOff, MessageSquareHeart, SlidersHorizontal, Trash2, Wand2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  Badge,
  Button,
  Card,
  CardAction,
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
  Tabs,
  type BadgeTone,
  type TabItem,
} from "@/components/ui";
import { useLiveRefresh } from "@/components/realtime/useLiveRefresh";
import { Timestamp } from "@/components/time/Timestamp";
import type {
  AddressingExclusionView,
  SelfImprovementView,
  UserFeedbackView,
} from "@/features/self-improvement/server/service";
import type { FeedbackStatus } from "@/features/self-improvement/types";
import type { ApiErrorBody } from "@/lib/api-error";

const STATUS_LABEL: Record<FeedbackStatus, string> = {
  pending: "Awaiting choice",
  awaiting_text: "Awaiting reply",
  completed: "Completed",
};

const STATUS_TONE: Record<FeedbackStatus, BadgeTone> = {
  pending: "warning",
  awaiting_text: "info",
  completed: "success",
};

/**
 * The bot's own account of why the exchange went the way it did, shown under the
 * words the user actually said. Absent until the reflection lands — it is written
 * outside the answer, and the daily job retries any that failed.
 */
function Reflection({ feedback }: { feedback: UserFeedbackView }) {
  if (!feedback.reflection) return null;
  return (
    <p className="whitespace-pre-wrap text-xs text-muted">
      <span className="font-medium">Reflection: </span>
      {feedback.reflection}
    </p>
  );
}

function IncorporationBadges({ feedback }: { feedback: UserFeedbackView }) {
  // An addressing report is never folded (it is a routing complaint, fixed by an
  // exclusion) — saying so beats an endless "—" the operator reads as "pending".
  if (feedback.topic === "addressing") {
    return <Badge tone="neutral">Addressing fix</Badge>;
  }
  if (feedback.prefsVersion == null && feedback.correctionsVersion == null) {
    return <span className="text-muted">—</span>;
  }
  return (
    <span className="flex flex-wrap gap-1">
      {feedback.prefsVersion != null ? (
        <Badge tone="primary">prefs v{feedback.prefsVersion}</Badge>
      ) : null}
      {feedback.correctionsVersion != null ? (
        <Badge tone="info">corr v{feedback.correctionsVersion}</Badge>
      ) : null}
    </span>
  );
}

/**
 * The addressing exclusions table: words someone reported with 👎 → "Wasn't
 * talking to you", which the analyzer must stop reading as the bot's display
 * name. Removable, because an exclusion is a learned fact and learned facts can
 * be wrong — deleting one makes the word matchable again.
 */
function ExclusionsTable({ exclusions }: { exclusions: AddressingExclusionView[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function remove(id: string) {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/self-improvement/exclusions/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as ApiErrorBody;
        setError(body.error?.message ?? `Request failed (${res.status})`);
        return;
      }
      router.refresh();
    } catch {
      setError("Network error — could not reach the server");
    } finally {
      setBusyId(null);
    }
  }

  if (exclusions.length === 0) {
    return (
      <EmptyState
        icon={EarOff}
        title="No exclusions yet"
        description="When someone answers 👎 with “Wasn't talking to you”, the word that made the bot think it was being called by name is listed here and stops summoning it."
      />
    );
  }
  return (
    <div className="space-y-3">
      <Table>
        <TableHead>
          <TableRow>
            <TableHeaderCell>Word</TableHeaderCell>
            <TableHeaderCell>Confused with</TableHeaderCell>
            <TableHeaderCell>Reported by</TableHeaderCell>
            <TableHeaderCell>When</TableHeaderCell>
            <TableHeaderCell>{""}</TableHeaderCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {exclusions.map((exclusion) => (
            <TableRow key={exclusion.id}>
              <TableCell className="font-medium">{exclusion.term}</TableCell>
              <TableCell className="text-muted">{exclusion.botDisplayName}</TableCell>
              <TableCell>{exclusion.userLabel}</TableCell>
              <TableCell className="whitespace-nowrap text-muted">
                <Timestamp iso={exclusion.createdAt} />
              </TableCell>
              <TableCell>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busyId === exclusion.id}
                  onClick={() => void remove(exclusion.id)}
                  leftIcon={<Trash2 className="h-4 w-4" />}
                >
                  Remove
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
    </div>
  );
}

/**
 * The self-improvement dashboard body: collected feedbacks, the latest learned
 * preferences per user, the latest global self-correction, and the addressing
 * exclusions reported from chats. Client Component only for the live SSE refresh
 * and the exclusion delete — all data arrives server-rendered via props.
 */
export function SelfImprovementPanel({ view }: { view: SelfImprovementView }) {
  useLiveRefresh("feedback");
  const { feedbacks, preferences, correction, exclusions, feedbacksError } = view;

  const feedbackTab = (
    <Card>
      <CardHeader>
        <CardDescription>
          Answers collected from 👍/👎 reactions on the bot&apos;s replies, each with the
          bot&apos;s own reflection on what went right or wrong and why.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {feedbacksError ? (
          // The rows live in the telegram service's store — an unreachable
          // service is an outage to surface, never an empty listing.
          <p className="text-sm text-danger">
            Feedback could not be loaded: {feedbacksError}
          </p>
        ) : feedbacks.length === 0 ? (
          <EmptyState
            icon={MessageSquareHeart}
            title="No feedback yet"
            description="When someone reacts to a bot reply with 👍 or 👎, their answer shows up here. In groups, Telegram only delivers reactions when the bot is an admin."
          />
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell>When</TableHeaderCell>
                <TableHeaderCell>User</TableHeaderCell>
                <TableHeaderCell>Reaction</TableHeaderCell>
                <TableHeaderCell>Feedback</TableHeaderCell>
                <TableHeaderCell>Model</TableHeaderCell>
                <TableHeaderCell>Incorporated</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {feedbacks.map((feedback) => (
                <TableRow key={feedback.id}>
                  <TableCell className="whitespace-nowrap text-muted">
                    <Timestamp iso={feedback.createdAt} />
                  </TableCell>
                  <TableCell>{feedback.userLabel}</TableCell>
                  <TableCell>
                    <Badge tone={feedback.reaction === "up" ? "success" : "danger"}>
                      {feedback.reaction === "up" ? "👍" : "👎"}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-md">
                    {feedback.feedback ? (
                      <div className="space-y-1">
                        <span className="whitespace-pre-wrap">{feedback.feedback}</span>
                        <Reflection feedback={feedback} />
                      </div>
                    ) : (
                      <Badge tone={STATUS_TONE[feedback.status]}>
                        {STATUS_LABEL[feedback.status]}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted">{feedback.model}</TableCell>
                  <TableCell>
                    <IncorporationBadges feedback={feedback} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );

  const preferencesTab = (
    <Card>
      <CardHeader>
        <CardDescription>
          The latest learned likes/dislikes per user — injected into every reply to that
          person.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {preferences.length === 0 ? (
          <EmptyState
            icon={SlidersHorizontal}
            title="No preferences yet"
            description="The daily job distills completed feedback into per-user preferences."
          />
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell>User</TableHeaderCell>
                <TableHeaderCell>Likes</TableHeaderCell>
                <TableHeaderCell>Dislikes</TableHeaderCell>
                <TableHeaderCell>Version</TableHeaderCell>
                <TableHeaderCell>Model</TableHeaderCell>
                <TableHeaderCell>Updated</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {preferences.map((preference) => (
                <TableRow key={preference.id}>
                  <TableCell className="whitespace-nowrap">{preference.userLabel}</TableCell>
                  <TableCell className="max-w-sm whitespace-pre-wrap">
                    {preference.likes || <span className="text-muted">—</span>}
                  </TableCell>
                  <TableCell className="max-w-sm whitespace-pre-wrap">
                    {preference.dislikes || <span className="text-muted">—</span>}
                  </TableCell>
                  <TableCell>
                    <Badge tone="primary">v{preference.version}</Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted">
                    {preference.model}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted">
                    <Timestamp iso={preference.createdAt} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );

  const correctionsTab = (
    <Card>
      <CardHeader>
        <CardDescription>
          Global guidelines distilled from feedback across all users — composed into the
          system prompt on every reply.
        </CardDescription>
        <CardAction>
          {correction ? <Badge tone="primary">v{correction.version}</Badge> : null}
        </CardAction>
      </CardHeader>
      <CardContent>
        {correction ? (
          <div className="space-y-2">
            <p className="whitespace-pre-wrap text-sm">{correction.correction}</p>
            <p className="text-xs text-muted">
              {correction.model} · <Timestamp iso={correction.createdAt} />
            </p>
          </div>
        ) : (
          <EmptyState
            icon={Wand2}
            title="No corrections yet"
            description="The daily job distills common complaints and praise into correction guidelines."
          />
        )}
      </CardContent>
    </Card>
  );

  const exclusionsTab = (
    <Card>
      <CardHeader>
        <CardDescription>
          Words the bot must not read as its own name. The addressing analyzer is shown
          this list on every undecided group message, and a word matching one of these
          entries never counts as being called by name.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ExclusionsTable exclusions={exclusions} />
      </CardContent>
    </Card>
  );

  const tabs: TabItem[] = [
    { id: "feedback", label: `Feedback (${feedbacks.length})`, content: feedbackTab },
    { id: "preferences", label: `Preferences (${preferences.length})`, content: preferencesTab },
    { id: "corrections", label: "Self-corrections", content: correctionsTab },
    {
      id: "exclusions",
      label: `Addressing exclusions (${exclusions.length})`,
      content: exclusionsTab,
    },
  ];

  return <Tabs tabs={tabs} />;
}
