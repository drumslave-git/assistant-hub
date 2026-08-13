"use client";

import { Check, Pencil, Plus, Scale, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { useLiveRefresh } from "@/components/realtime/useLiveRefresh";
import { Timestamp } from "@/components/time/Timestamp";
import {
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  Checkbox,
  EmptyState,
  Field,
  ScrollArea,
  Select,
  Textarea,
} from "@/components/ui";
import type { ApiErrorBody } from "@/lib/api-error";

import { sameTargets, triggerLabel } from "../format";
import {
  MAX_RULE_TARGETS,
  MAX_RULE_TEXT_LEN,
  MAX_RULES_PER_SCOPE,
  RULE_TRIGGERS,
  type ChatRule,
  type RuleTrigger,
} from "../server/schema";

/**
 * Chat-rules manager. Client Component: a scope picker (one chat, or the global
 * set) over a create form and the rules in that scope. Each mutation calls the
 * chat-rules API, then `router.refresh()` re-reads the server-rendered props;
 * the page live-updates over the shared SSE stream (`rules` topic).
 *
 * Scope is a filter *and* the create target — the one control that decides both,
 * so a rule can never be created into a scope other than the one on screen. Who
 * a rule applies to is the second axis, offered only where there is a roster to
 * choose from (a group), and defaulting to everyone.
 */

/** Someone a group's rule can be limited to (they have spoken there). */
export interface RuleChatMember {
  userId: string;
  label: string;
}

/** A chat rules can be scoped to (known groups + DM chats). */
export interface RuleChat {
  chatId: string;
  label: string;
  kind: "group" | "dm";
  /** The group's roster; empty for a DM, which is one person by definition. */
  members: RuleChatMember[];
}

/** The global scope's sentinel value in the picker (a chat id is never empty). */
const GLOBAL = "";

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as ApiErrorBody;
    return body.error?.message ?? `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

const TRIGGER_HINTS: Record<RuleTrigger, string> = {
  "on-reply": "Applies when the bot answers — every DM message, and group messages that address it.",
  always:
    "Also acts on group messages nobody addressed to the bot. Costs one extra classification call per unaddressed message in this chat.",
};

function TriggerSelect({
  value,
  onChange,
  idPrefix,
  disabled,
}: {
  value: RuleTrigger;
  onChange: (v: RuleTrigger) => void;
  idPrefix: string;
  disabled?: boolean;
}) {
  return (
    <Field id={`${idPrefix}-trigger`} label="Trigger" hint={TRIGGER_HINTS[value]}>
      {({ id, describedBy }) => (
        <Select
          id={id}
          aria-describedby={describedBy}
          value={value}
          onChange={(e) => onChange(e.target.value as RuleTrigger)}
          disabled={disabled}
        >
          {RULE_TRIGGERS.map((trigger) => (
            <option key={trigger} value={trigger}>
              {triggerLabel(trigger)}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}

/**
 * Who a rule applies to, as one list rather than a mode switch plus a list:
 * "Everyone" is the first row and simply means an empty selection, so there is no
 * way to land in the half-set state of "specific people" with nobody picked.
 * Renders nothing when the chat has no roster to choose from (a DM, a global
 * rule, or a group where nobody has spoken yet) — there the rule is for everyone
 * and the server refuses anything else.
 */
function AudienceField({
  idPrefix,
  members,
  value,
  onChange,
  disabled,
}: {
  idPrefix: string;
  members: RuleChatMember[];
  value: string[];
  onChange: (userIds: string[]) => void;
  disabled?: boolean;
}) {
  if (members.length === 0) return null;
  const everyone = value.length === 0;
  const atLimit = value.length >= MAX_RULE_TARGETS;

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
            <p className="text-xs text-muted">
              A rule can name at most {MAX_RULE_TARGETS} people.
            </p>
          ) : null}
        </div>
      )}
    </Field>
  );
}

function CreateForm({
  scope,
  scopeLabel,
  members,
  atLimit,
}: {
  scope: string | null;
  scopeLabel: string;
  members: RuleChatMember[];
  atLimit: boolean;
}) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [trigger, setTrigger] = useState<RuleTrigger>("on-reply");
  const [targetUserIds, setTargetUserIds] = useState<string[]>([]);
  const [state, setState] = useState<"idle" | "saving" | { error: string }>("idle");

  async function create() {
    setState("saving");
    try {
      const res = await fetch("/api/chat-rules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chatId: scope, text: text.trim(), trigger, targetUserIds }),
      });
      if (!res.ok) {
        setState({ error: await readError(res) });
        return;
      }
      setText("");
      setTrigger("on-reply");
      setTargetUserIds([]);
      setState("idle");
      router.refresh();
    } catch {
      setState({ error: "Network error — could not reach the server" });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>New rule for {scopeLabel}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Field
          id="new-rule-text"
          label="Rule"
          hint={`Write it as an instruction to the bot, naming both what triggers it and what to do. At most ${MAX_RULE_TEXT_LEN} characters.`}
        >
          {({ id, describedBy }) => (
            <Textarea
              id={id}
              aria-describedby={describedBy}
              rows={3}
              maxLength={MAX_RULE_TEXT_LEN}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setState("idle");
              }}
              placeholder="e.g. When someone posts a link to a social network video, download it and send the file to the chat."
              disabled={atLimit}
            />
          )}
        </Field>
        <TriggerSelect
          idPrefix="new-rule"
          value={trigger}
          onChange={setTrigger}
          disabled={atLimit}
        />
        <AudienceField
          idPrefix="new-rule"
          members={members}
          value={targetUserIds}
          onChange={setTargetUserIds}
          disabled={atLimit}
        />
        <div className="flex items-center gap-3">
          <Button
            onClick={create}
            disabled={atLimit || text.trim() === "" || state === "saving"}
            leftIcon={<Plus className="h-4 w-4" />}
          >
            {state === "saving" ? "Creating…" : "Create rule"}
          </Button>
          {atLimit ? (
            <span className="text-sm text-muted">
              Limit of {MAX_RULES_PER_SCOPE} rules reached for {scopeLabel}.
            </span>
          ) : null}
          {typeof state === "object" ? (
            <span className="text-sm text-danger">{state.error}</span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function RuleCard({ rule, members }: { rule: ChatRule; members: RuleChatMember[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(rule.text);
  const [trigger, setTrigger] = useState<RuleTrigger>(rule.trigger);
  const [targetUserIds, setTargetUserIds] = useState<string[]>(rule.targetUserIds);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Someone who has left the roster still has to be readable here, or the rule
  // would show fewer people than it actually applies to.
  const audience = rule.targetUserIds.map(
    (userId) => members.find((m) => m.userId === userId)?.label ?? `User ${userId}`,
  );

  function resetEdit() {
    setText(rule.text);
    setTrigger(rule.trigger);
    setTargetUserIds(rule.targetUserIds);
    setError(null);
    setEditing(false);
  }

  async function mutate(run: () => Promise<Response>, after?: () => void) {
    setBusy(true);
    setError(null);
    try {
      const res = await run();
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      after?.();
      router.refresh();
    } catch {
      setError("Network error — could not reach the server");
    } finally {
      setBusy(false);
    }
  }

  const patch = (body: Record<string, unknown>, after?: () => void) =>
    mutate(
      () =>
        fetch(`/api/chat-rules/${encodeURIComponent(rule.id)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      after,
    );

  const remove = () => {
    if (!confirm(`Delete this rule? It stops applying immediately. This cannot be undone.`)) return;
    return mutate(() =>
      fetch(`/api/chat-rules/${encodeURIComponent(rule.id)}`, { method: "DELETE" }),
    );
  };

  if (editing) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Edit rule</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Field id={`edit-rule-text-${rule.id}`} label="Rule">
            {({ id }) => (
              <Textarea
                id={id}
                rows={3}
                maxLength={MAX_RULE_TEXT_LEN}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            )}
          </Field>
          <TriggerSelect idPrefix={`edit-rule-${rule.id}`} value={trigger} onChange={setTrigger} />
          <AudienceField
            idPrefix={`edit-rule-${rule.id}`}
            members={members}
            value={targetUserIds}
            onChange={setTargetUserIds}
          />
          {error ? <p className="text-sm text-danger">{error}</p> : null}
        </CardContent>
        <CardFooter>
          <Button
            size="sm"
            onClick={() =>
              patch(
                {
                  text: text.trim(),
                  trigger,
                  // Only when it changed: a global rule has no audience control
                  // at all, and sending its (empty) list back would be rejected
                  // for a scope that may not name anyone.
                  ...(sameTargets(targetUserIds, rule.targetUserIds) ? {} : { targetUserIds }),
                },
                () => setEditing(false),
              )
            }
            disabled={busy || text.trim() === ""}
            leftIcon={<Check className="h-4 w-4" />}
          >
            {busy ? "Saving…" : "Save"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={resetEdit}
            disabled={busy}
            leftIcon={<X className="h-4 w-4" />}
          >
            Cancel
          </Button>
        </CardFooter>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Badge tone={rule.trigger === "always" ? "info" : "neutral"}>
            {triggerLabel(rule.trigger)}
          </Badge>
          <Badge tone={rule.enabled ? "success" : "warning"} dot>
            {rule.enabled ? "Active" : "Paused"}
          </Badge>
          {audience.length > 0 ? (
            <Badge tone="info">Only {audience.join(", ")}</Badge>
          ) : null}
          {rule.source === "chat" ? <Badge tone="neutral">Set from chat</Badge> : null}
          <span className="text-xs text-faint">
            <Timestamp iso={rule.createdAt} />
          </span>
        </div>
        <CardAction>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => patch({ enabled: !rule.enabled })}
            disabled={busy}
          >
            {rule.enabled ? "Pause" : "Resume"}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => setEditing(true)}
            disabled={busy}
            aria-label="Edit rule"
          >
            <Pencil className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={remove}
            disabled={busy}
            aria-label="Delete rule"
          >
            <Trash2 className="h-4 w-4 text-danger" />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <p className="whitespace-pre-wrap text-sm text-foreground">{rule.text}</p>
        {error ? <p className="mt-2 text-sm text-danger">{error}</p> : null}
      </CardContent>
    </Card>
  );
}

export function ChatRulesManager({ rules, chats }: { rules: ChatRule[]; chats: RuleChat[] }) {
  useLiveRefresh("rules");
  const [scope, setScope] = useState<string>(GLOBAL);

  const scopeChatId = scope === GLOBAL ? null : scope;
  const scopeChat = scopeChatId === null ? null : chats.find((c) => c.chatId === scopeChatId);
  const scopeLabel = scopeChatId === null ? "every chat" : (scopeChat?.label ?? `chat ${scopeChatId}`);
  // Only a group rule may name people, so only a group offers a roster to pick from.
  const scopeMembers = scopeChat?.kind === "group" ? scopeChat.members : [];
  const inScope = useMemo(
    () => rules.filter((rule) => rule.chatId === scopeChatId),
    [rules, scopeChatId],
  );
  // A chat's rules are its own plus the global ones — shown as context so the
  // operator sees everything that actually governs the chat they picked.
  const inherited = useMemo(
    () => (scopeChatId === null ? [] : rules.filter((rule) => rule.chatId === null)),
    [rules, scopeChatId],
  );

  return (
    <div className="space-y-6">
      <Field
        id="rules-scope"
        label="Scope"
        hint="Rules apply to the chat they belong to. Global rules apply in every chat, on top of that chat's own."
      >
        {({ id, describedBy }) => (
          <Select
            id={id}
            aria-describedby={describedBy}
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            className="max-w-96"
          >
            <option value={GLOBAL}>Every chat (global)</option>
            {chats.map((chat) => (
              <option key={chat.chatId} value={chat.chatId}>
                {chat.kind === "group" ? "Group" : "DM"} · {chat.label}
              </option>
            ))}
          </Select>
        )}
      </Field>

      <CreateForm
        scope={scopeChatId}
        scopeLabel={scopeLabel}
        members={scopeMembers}
        atLimit={inScope.length >= MAX_RULES_PER_SCOPE}
      />

      {inScope.length === 0 ? (
        <EmptyState
          icon={Scale}
          title={`No rules for ${scopeLabel}`}
          description="Create one above, or let the people in the chat set one by telling the bot a new rule."
        />
      ) : (
        <ScrollArea className="space-y-4">
          {inScope.map((rule) => (
            <RuleCard key={rule.id} rule={rule} members={scopeMembers} />
          ))}
        </ScrollArea>
      )}

      {inherited.length > 0 ? (
        <div className="space-y-4">
          <h2 className="text-sm font-medium text-muted">
            Also in force here — {inherited.length} global{" "}
            {inherited.length === 1 ? "rule" : "rules"}
          </h2>
          <ScrollArea className="space-y-4">
            {/* Global rules apply to everyone everywhere: no roster, no picker. */}
            {inherited.map((rule) => (
              <RuleCard key={rule.id} rule={rule} members={[]} />
            ))}
          </ScrollArea>
        </div>
      ) : null}
    </div>
  );
}
