"use client";

import { Bug, CalendarClock, Pencil, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import {
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  EmptyState,
  Fab,
  Field,
  Input,
  Modal,
  ScrollArea,
  Select,
  Switch,
  Textarea,
  useConfirm,
} from "@/components/ui";
import { useLiveRefresh } from "@/components/realtime/useLiveRefresh";
import { Timestamp } from "@/components/time/Timestamp";
import { useTimezone } from "@/components/time/TimezoneProvider";
import type { ApiErrorBody } from "@/lib/api-error";
import { debugFilterHref } from "@/lib/trace";

import { sameTargets } from "../format";
import { describeTrigger, scheduleKindOf } from "../schedule";
import { MAX_TASK_TARGETS } from "../server/schema";
import {
  isPromptTask,
  isTimedTask,
  MAX_ONE_SHOT_ATTEMPTS,
  type ScheduleKind,
  type Task,
  type TriggerKind,
} from "../types";
import type { TaskSchedulerJobInfo } from "../server/scheduler";
import { TaskSchedulerCard } from "./TaskSchedulerCard";

/**
 * Tasks manager. Client Component for the unified tasks feature: create, edit,
 * enable/disable, and delete tasks of every trigger kind, pick who a group
 * standing rule applies to, and trigger "run due now". Each mutation calls the
 * tasks API, then `router.refresh()` re-reads the server-rendered list (also
 * kept fresh live over the `tasks` SSE topic).
 *
 * One list for everything, with a scope filter on top: the operator's question
 * is "what will the bot do, and where" — splitting standing rules from timed
 * jobs into separate pages made that two questions.
 */

/** Someone a group task can be limited to (they have spoken there). */
export interface TaskChatMember {
  userId: string;
  label: string;
}

/** A chat a task can live in (known groups + DM chats). */
export interface TaskChat {
  chatId: string;
  label: string;
  kind: "group" | "dm";
  /** The group's roster; empty for a DM, which is one person by definition. */
  members: TaskChatMember[];
}

/** The global scope's sentinel in selects (a chat id is never empty). */
const GLOBAL = "";
/** The "show everything" sentinel of the filter select. */
const ALL = "*";

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const TRIGGER_OPTIONS: { value: TriggerKind; label: string }[] = [
  { value: "message", label: "On matching messages" },
  { value: "on-reply", label: "Reply shaping" },
  { value: "interval", label: "Every N minutes" },
  { value: "timeout", label: "Once, after a delay" },
  { value: "schedule", label: "Calendar" },
];

const TRIGGER_HINTS: Record<TriggerKind, string> = {
  message:
    "A standing rule that acts on messages people post — even ones not addressed to the bot. Costs one classification call per unaddressed message in the chat.",
  "on-reply":
    "A standing rule that only shapes how the bot answers when someone talks to it. Free — no extra calls.",
  interval: "Fires on a fixed period, e.g. every 10 minutes. The model decides what, if anything, to send.",
  timeout: "Fires once, a fixed delay after you save it, then the task is gone.",
  schedule: "Fires at a wall-clock time — once on a date, daily, or on chosen weekdays.",
};

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as ApiErrorBody;
    return body.error?.message ?? `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

/* ------------------------------ trigger inputs ----------------------------- */

/** Everything the trigger sub-form edits, across all kinds. */
interface TriggerFields {
  triggerKind: TriggerKind;
  everyMinutes: string;
  delayMinutes: string;
  scheduleKind: ScheduleKind;
  timeOfDay: string;
  weekdays: number[];
  runDate: string;
}

const EMPTY_TRIGGER: TriggerFields = {
  triggerKind: "message",
  everyMinutes: "60",
  delayMinutes: "60",
  scheduleKind: "daily",
  timeOfDay: "09:00",
  weekdays: [],
  runDate: "",
};

/** The trigger fields of an existing task, for the edit form. */
function triggerFieldsOf(task: Task): TriggerFields {
  return {
    triggerKind: task.triggerKind,
    everyMinutes: String(task.everyMinutes ?? 60),
    delayMinutes: String(task.delayMinutes ?? 60),
    scheduleKind: scheduleKindOf(task),
    timeOfDay: task.timeOfDay ?? "09:00",
    weekdays: task.weekdays ?? [],
    runDate: task.runDate ?? "",
  };
}

/** Only send the fields the trigger kind needs. */
function triggerPayload(t: TriggerFields) {
  switch (t.triggerKind) {
    case "interval":
      return { triggerKind: t.triggerKind, everyMinutes: Number(t.everyMinutes) };
    case "timeout":
      return { triggerKind: t.triggerKind, delayMinutes: Number(t.delayMinutes) };
    case "schedule":
      return {
        triggerKind: t.triggerKind,
        scheduleKind: t.scheduleKind,
        timeOfDay: t.timeOfDay,
        weekdays: t.scheduleKind === "weekly" ? t.weekdays : null,
        runDate: t.scheduleKind === "once" ? t.runDate : null,
      };
    default:
      return { triggerKind: t.triggerKind };
  }
}

function TriggerInputs({
  value,
  onChange,
  idPrefix,
  disabled,
}: {
  value: TriggerFields;
  onChange: (next: TriggerFields) => void;
  idPrefix: string;
  disabled?: boolean;
}) {
  const toggleDay = (day: number) => {
    const has = value.weekdays.includes(day);
    onChange({
      ...value,
      weekdays: has ? value.weekdays.filter((d) => d !== day) : [...value.weekdays, day].sort(),
    });
  };

  return (
    <div className="space-y-3">
      <Field id={`${idPrefix}-trigger`} label="Trigger" hint={TRIGGER_HINTS[value.triggerKind]}>
        {({ id, describedBy }) => (
          <Select
            id={id}
            aria-describedby={describedBy}
            value={value.triggerKind}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, triggerKind: e.target.value as TriggerKind })}
          >
            {TRIGGER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {value.triggerKind === "interval" ? (
        <Field id={`${idPrefix}-every`} label="Every (minutes)">
          {({ id }) => (
            <Input
              id={id}
              type="number"
              min={1}
              value={value.everyMinutes}
              disabled={disabled}
              onChange={(e) => onChange({ ...value, everyMinutes: e.target.value })}
            />
          )}
        </Field>
      ) : null}
      {value.triggerKind === "timeout" ? (
        <Field
          id={`${idPrefix}-delay`}
          label="Delay (minutes)"
          hint="Counted from when you save — saving again restarts it."
        >
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              type="number"
              min={1}
              value={value.delayMinutes}
              disabled={disabled}
              onChange={(e) => onChange({ ...value, delayMinutes: e.target.value })}
            />
          )}
        </Field>
      ) : null}
      {value.triggerKind === "schedule" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id={`${idPrefix}-kind`} label="Repeat">
            {({ id }) => (
              <Select
                id={id}
                value={value.scheduleKind}
                disabled={disabled}
                onChange={(e) => onChange({ ...value, scheduleKind: e.target.value as ScheduleKind })}
              >
                <option value="once">Once</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </Select>
            )}
          </Field>
          <Field id={`${idPrefix}-time`} label="Time (HH:MM)">
            {({ id }) => (
              <Input
                id={id}
                type="time"
                value={value.timeOfDay}
                disabled={disabled}
                onChange={(e) => onChange({ ...value, timeOfDay: e.target.value })}
              />
            )}
          </Field>
          {value.scheduleKind === "once" ? (
            <Field id={`${idPrefix}-date`} label="Date">
              {({ id }) => (
                <Input
                  id={id}
                  type="date"
                  value={value.runDate}
                  disabled={disabled}
                  onChange={(e) => onChange({ ...value, runDate: e.target.value })}
                />
              )}
            </Field>
          ) : null}
          {value.scheduleKind === "weekly" ? (
            <Field id={`${idPrefix}-weekdays`} label="Weekdays" className="sm:col-span-2">
              {() => (
                <div className="flex flex-wrap gap-1.5">
                  {WEEKDAY_LABELS.map((label, day) => (
                    <Button
                      key={day}
                      type="button"
                      size="sm"
                      variant={value.weekdays.includes(day) ? "primary" : "outline"}
                      disabled={disabled}
                      onClick={() => toggleDay(day)}
                    >
                      {label}
                    </Button>
                  ))}
                </div>
              )}
            </Field>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------ audience picker ---------------------------- */

/**
 * Who a standing rule applies to, as one list rather than a mode switch plus a
 * list: "Everyone" is the first row and simply means an empty selection, so
 * there is no way to land in the half-set state of "specific people" with
 * nobody picked. Renders nothing when there is no roster to choose from (a DM,
 * the global scope, a timed kind, or a group where nobody has spoken yet) —
 * there the task is for everyone and the server refuses anything else.
 */
function AudienceField({
  idPrefix,
  members,
  value,
  onChange,
  disabled,
}: {
  idPrefix: string;
  members: TaskChatMember[];
  value: string[];
  onChange: (userIds: string[]) => void;
  disabled?: boolean;
}) {
  if (members.length === 0) return null;
  const everyone = value.length === 0;
  const atLimit = value.length >= MAX_TASK_TARGETS;

  return (
    <Field
      id={`${idPrefix}-audience`}
      label="Applies to"
      hint={
        everyone
          ? "Every message in this group. Pick people instead to limit the rule to their messages."
          : "Only messages from the people ticked below — for everyone else the rule does not exist."
      }
    >
      {({ id, describedBy }) => (
        <div
          id={id}
          role="group"
          aria-describedby={describedBy}
          className="max-h-56 space-y-2 overflow-y-auto rounded-lg border border-border p-3"
        >
          <div className="flex items-center gap-2">
            <Checkbox
              id={`${idPrefix}-audience-all`}
              checked={everyone}
              disabled={disabled}
              onChange={() => onChange([])}
            />
            <label htmlFor={`${idPrefix}-audience-all`} className="cursor-pointer text-sm">
              Everyone in this group
            </label>
          </div>
          {members.map((member) => {
            const checked = value.includes(member.userId);
            const boxId = `${idPrefix}-audience-${member.userId}`;
            return (
              <div key={member.userId} className="flex items-center gap-2">
                <Checkbox
                  id={boxId}
                  checked={checked}
                  disabled={disabled || (atLimit && !checked)}
                  onChange={(e) =>
                    onChange(
                      e.target.checked
                        ? [...value, member.userId]
                        : value.filter((id) => id !== member.userId),
                    )
                  }
                />
                <label htmlFor={boxId} className="cursor-pointer text-sm">
                  {member.label}
                </label>
              </div>
            );
          })}
          {atLimit ? (
            <p className="text-xs text-muted">A task can name at most {MAX_TASK_TARGETS} people.</p>
          ) : null}
        </div>
      )}
    </Field>
  );
}

/* ---------------------------------- dialog --------------------------------- */

function isPromptKind(kind: TriggerKind): boolean {
  return isPromptTask({ triggerKind: kind });
}

/** Which task the dialog is editing, or that it is closed. */
type DialogState = { kind: "closed" } | { kind: "create" } | { kind: "edit"; task: Task };

/**
 * The one task form. Mounted only while open and keyed by its target, so the
 * fields are seeded once per opening and never carry a previous task's trigger.
 *
 * Create and edit differ in exactly one place, and it is a real difference: the
 * **chat** is chosen when creating and fixed afterwards. Moving a task between
 * chats is a delete plus a create, so a task's chat can never change under the
 * people who agreed to it — which is why the field simply is not rendered here.
 */
function TaskDialog({
  task,
  chats,
  onClose,
}: {
  /** The task being edited, or null to create one. */
  task: Task | null;
  chats: TaskChat[];
  onClose: () => void;
}) {
  const router = useRouter();
  const editing = task !== null;
  const [scope, setScope] = useState<string>(
    editing ? (task.chatId ?? GLOBAL) : (chats[0]?.chatId ?? GLOBAL),
  );
  const [instruction, setInstruction] = useState(task?.instruction ?? "");
  const [context, setContext] = useState(task?.context ?? "");
  const [trigger, setTrigger] = useState<TriggerFields>(
    task ? triggerFieldsOf(task) : EMPTY_TRIGGER,
  );
  const [targetUserIds, setTargetUserIds] = useState<string[]>(task?.targetUserIds ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const promptKind = isPromptKind(trigger.triggerKind);
  const scopeChat = scope === GLOBAL ? null : chats.find((c) => c.chatId === scope);
  const members = promptKind && scopeChat?.kind === "group" ? scopeChat.members : [];

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = editing
        ? await fetch(`/api/tasks/${encodeURIComponent(task.id)}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              instruction: instruction.trim(),
              ...(promptKind ? {} : { context: context.trim() ? context.trim() : null }),
              // Only when it changed: a task with no audience control (global,
              // DM, timed) must not send its empty list back as a change.
              ...(sameTargets(targetUserIds, task.targetUserIds) ? {} : { targetUserIds }),
              ...triggerPayload(trigger),
            }),
          })
        : await fetch("/api/tasks", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              chatId: scope === GLOBAL ? null : scope,
              instruction: instruction.trim(),
              context: !promptKind && context.trim() ? context.trim() : null,
              targetUserIds: members.length > 0 ? targetUserIds : [],
              ...triggerPayload(trigger),
            }),
          });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      onClose();
      router.refresh();
    } catch {
      setError("Network error — could not reach the server");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      busy={busy}
      size="lg"
      title={editing ? "Edit task" : "New task"}
      description={
        promptKind
          ? "A standing rule the bot applies to messages in the chat."
          : "A timed task. The model decides what, if anything, it sends when it fires."
      }
      footer={
        <>
          {error ? <p className="mr-auto text-sm text-danger">{error}</p> : null}
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={save}
            disabled={
              busy || instruction.trim().length < 2 || (!promptKind && scope === GLOBAL)
            }
          >
            {busy ? "Saving…" : editing ? "Save changes" : "Create task"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {editing ? null : (
          <Field
            id="task-chat"
            label="Chat"
            hint={
              promptKind
                ? "The chat the rule holds in. Global rules apply in every chat, on top of that chat's own."
                : "The chat the task fires into. A timed task needs a concrete chat."
            }
          >
            {({ id, describedBy }) => (
              <Select
                id={id}
                aria-describedby={describedBy}
                value={scope}
                onChange={(e) => setScope(e.target.value)}
              >
                {promptKind ? <option value={GLOBAL}>Every chat (global)</option> : null}
                {chats.map((chat) => (
                  <option key={chat.chatId} value={chat.chatId}>
                    {chat.kind === "group" ? "Group" : "DM"} · {chat.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <Field
          id="task-instruction"
          label="Instruction"
          hint="Write it as a complete instruction to the bot, naming both what triggers it and what to do."
        >
          {({ id, describedBy }) => (
            <Textarea
              id={id}
              aria-describedby={describedBy}
              rows={3}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="e.g. When someone posts a link to a social network video, download it and send the file to the chat."
              autoFocus
            />
          )}
        </Field>
        <TriggerInputs idPrefix="task" value={trigger} onChange={setTrigger} />
        <AudienceField
          idPrefix="task"
          members={members}
          value={targetUserIds}
          onChange={setTargetUserIds}
        />
        {!promptKind ? (
          <Field
            id="task-context"
            label="Context (optional)"
            hint="Background the fire relies on — a fire sees no chat transcript, only this."
          >
            {({ id, describedBy }) => (
              <Textarea
                id={id}
                aria-describedby={describedBy}
                value={context}
                onChange={(e) => setContext(e.target.value)}
                rows={3}
                placeholder="e.g. topic X is the deployment checklist discussed on Monday"
              />
            )}
          </Field>
        ) : null}
      </div>
    </Modal>
  );
}

/* --------------------------------- task card ------------------------------- */

function TaskCard({
  task,
  chatLabel,
  authorLabel,
  members,
  overdue,
  paused,
  onEdit,
  onDelete,
}: {
  task: Task;
  chatLabel: string;
  authorLabel: string;
  /** The roster of the task's group, for the audience badge. */
  members: TaskChatMember[];
  /** The task's run instant has passed and it still has not fired. */
  overdue: boolean;
  /** Firing is paused for every task (maintenance mode) — the likely reason. */
  paused: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Someone who has left the roster still has to be readable here, or the task
  // would show fewer people than it actually applies to.
  const audience = task.targetUserIds.map(
    (userId) => members.find((m) => m.userId === userId)?.label ?? `User ${userId}`,
  );

  async function toggleEnabled() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(task.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !task.enabled }),
      });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      router.refresh();
    } catch {
      setError("Network error — could not reach the server");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <CardTitle className="truncate">{task.instruction}</CardTitle>
            {task.enabled ? (
              <Badge tone="success" dot>
                Enabled
              </Badge>
            ) : task.attempts >= MAX_ONE_SHOT_ATTEMPTS ? (
              <Badge tone="danger">Failed — gave up after {task.attempts} attempts</Badge>
            ) : (
              <Badge tone="neutral">Disabled</Badge>
            )}
            {task.enabled && task.attempts > 0 ? (
              <Badge tone="warning">
                Retrying — {task.attempts} failed attempt{task.attempts === 1 ? "" : "s"}
              </Badge>
            ) : null}
            {overdue ? (
              <Badge tone={paused ? "danger" : "warning"}>
                {paused ? "Overdue — firing paused" : "Overdue"}
              </Badge>
            ) : null}
            {audience.length > 0 ? <Badge tone="info">Only {audience.join(", ")}</Badge> : null}
            {task.source === "chat" ? <Badge tone="neutral">Set from chat</Badge> : null}
          </div>
          <p className="text-sm text-muted">
            {describeTrigger(task)} · {chatLabel} · {authorLabel}
          </p>
        </div>
        <CardAction>
          <Switch
            checked={task.enabled}
            onChange={toggleEnabled}
            disabled={busy}
            aria-label={task.enabled ? "Disable task" : "Enable task"}
          />
          {/* Everything traced about this task: fires, matched replies, edits. */}
          <Button size="icon" variant="ghost" asChild>
            <Link
              href={debugFilterHref({ relatedId: task.id })}
              aria-label="Show this task's traces"
              title="Show this task's traces"
            >
              <Bug className="h-4 w-4" />
            </Link>
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={onEdit}
            disabled={busy}
            aria-label="Edit task"
          >
            <Pencil className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={onDelete}
            disabled={busy}
            aria-label="Delete task"
          >
            <Trash2 className="h-4 w-4 text-danger" />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {task.context ? (
          <p className="mb-2 whitespace-pre-wrap text-sm text-muted">{task.context}</p>
        ) : null}
        {isTimedTask(task) ? (
          <p className="text-sm text-muted">
            {task.nextRunAt ? (
              overdue ? (
                <span className={paused ? "text-danger" : "text-warning"}>
                  Was due: <Timestamp iso={task.nextRunAt} /> — not fired
                </span>
              ) : (
                <>
                  Next run: <Timestamp iso={task.nextRunAt} />
                </>
              )
            ) : (
              <span className="text-faint">No upcoming run.</span>
            )}
            {task.lastRunAt ? (
              <>
                {" "}
                · Last run: <Timestamp iso={task.lastRunAt} />
              </>
            ) : null}
          </p>
        ) : null}
        {error ? <p className="mt-2 text-sm text-danger">{error}</p> : null}
      </CardContent>
    </Card>
  );
}

/* --------------------------------- manager --------------------------------- */

export function TasksManager({
  tasks,
  chats,
  authors,
  job,
}: {
  tasks: Task[];
  chats: TaskChat[];
  /** Map of creator user id → display label, for showing each task's author. */
  authors: Record<string, string>;
  /** Poller status — including whether firing is currently paused. */
  job: TaskSchedulerJobInfo;
}) {
  useLiveRefresh("tasks");
  const timezone = useTimezone();
  const router = useRouter();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [filter, setFilter] = useState<string>(ALL);
  const [dialog, setDialog] = useState<DialogState>({ kind: "closed" });
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function remove(task: Task) {
    const ok = await confirm({
      title: "Delete this task?",
      // The instruction is the only thing that identifies a task to a reader,
      // so the confirmation has to quote it rather than say "this task".
      body: `"${task.instruction}" — the bot stops acting on it immediately. This cannot be undone.`,
      confirmLabel: "Delete task",
      tone: "danger",
    });
    if (!ok) return;
    setDeleteError(null);
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(task.id)}`, { method: "DELETE" });
      if (!res.ok) {
        setDeleteError(await readError(res));
        return;
      }
      router.refresh();
    } catch {
      setDeleteError("Network error — could not reach the server");
    }
  }

  const chatOf = (chatId: string | null) =>
    chatId === null ? null : chats.find((c) => c.chatId === chatId);
  const chatLabelOf = (chatId: string | null) =>
    chatId === null ? "every chat" : (chatOf(chatId)?.label ?? `Chat ${chatId}`);
  const authorLabelOf = (task: Task) =>
    task.createdByUserId
      ? `by ${authors[task.createdByUserId] ?? `user ${task.createdByUserId}`}`
      : "via dashboard";

  const visible = useMemo(() => {
    if (filter === ALL) return tasks;
    if (filter === GLOBAL) return tasks.filter((task) => task.chatId === null);
    return tasks.filter((task) => task.chatId === filter);
  }, [tasks, filter]);

  // "Overdue" is measured against the server's snapshot instant, not the browser
  // clock, so the flag matches the count on the card and never differs between
  // the server render and hydration.
  const isOverdue = (task: Task) =>
    task.enabled && task.nextRunAt != null && Date.parse(task.nextRunAt) <= Date.parse(job.asOf);

  return (
    <div className="space-y-6">
      <TaskSchedulerCard initial={job} />

      <p className="text-sm text-muted">Operator timezone: {timezone}</p>

      {deleteError ? <p className="text-sm text-danger">{deleteError}</p> : null}

      <Field
        id="tasks-filter"
        label="Show"
        hint="A chat's tasks are its own plus the global ones."
      >
        {({ id, describedBy }) => (
          <Select
            id={id}
            aria-describedby={describedBy}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="max-w-96"
          >
            <option value={ALL}>All chats</option>
            <option value={GLOBAL}>Every chat (global)</option>
            {chats.map((chat) => (
              <option key={chat.chatId} value={chat.chatId}>
                {chat.kind === "group" ? "Group" : "DM"} · {chat.label}
              </option>
            ))}
          </Select>
        )}
      </Field>

      {visible.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title="No tasks here yet"
          description="Create one, or let the people in a chat set one by telling the bot."
        />
      ) : (
        <ScrollArea className="space-y-4">
          {visible.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              chatLabel={chatLabelOf(task.chatId)}
              authorLabel={authorLabelOf(task)}
              members={
                task.chatId !== null && chatOf(task.chatId)?.kind === "group"
                  ? (chatOf(task.chatId)?.members ?? [])
                  : []
              }
              overdue={isOverdue(task)}
              paused={job.paused}
              onEdit={() => setDialog({ kind: "edit", task })}
              onDelete={() => void remove(task)}
            />
          ))}
        </ScrollArea>
      )}

      <Fab
        label="New task"
        icon={<Plus className="h-4 w-4" />}
        onClick={() => setDialog({ kind: "create" })}
      />

      {dialog.kind !== "closed" ? (
        <TaskDialog
          key={dialog.kind === "edit" ? dialog.task.id : "new"}
          task={dialog.kind === "edit" ? dialog.task : null}
          chats={chats}
          onClose={() => setDialog({ kind: "closed" })}
        />
      ) : null}

      {confirmDialog}
    </div>
  );
}
