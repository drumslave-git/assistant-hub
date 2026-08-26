"use client";

import { Bug, Link2, Pencil, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

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
  useConfirm,
} from "@/components/ui";
import { useLiveRefresh } from "@/components/realtime/useLiveRefresh";
import type { ApiErrorBody } from "@/lib/api-error";
import { featureDebugHref } from "@/lib/features";
import { MAX_NOTE_LEN, MIN_MEMBERS, type PersonLink } from "../server/schema";

/**
 * Person-links manager. Client Component: declare that several identities are
 * the same human, note who they are, and break the link again. Memory reads
 * resolve through these links, so what the bot knows about someone follows
 * them across every identity they reach it by.
 *
 * The picker offers the aggregated directory and disables identities another
 * link already claims — one identity belongs to at most one person, and
 * saying so in the picker beats answering with a conflict after the fact.
 */

/** One pickable identity, from the aggregated directory. */
export interface DirectoryPerson {
  ref: string;
  label: string;
  sourceLabel: string;
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as ApiErrorBody;
    return body.error?.message ?? `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

type DialogState = { kind: "closed" } | { kind: "create" } | { kind: "edit"; link: PersonLink };

/**
 * The one link form. Mounted only while open and keyed by its target, so the
 * fields are seeded once per opening and never carry another link's state.
 * The note and the identity list are separate saves on the API (one curated
 * field per call), so an edit sends only what actually changed.
 */
function PersonLinkDialog({
  link,
  people,
  claimed,
  onClose,
}: {
  /** The link being edited, or null to create one. */
  link: PersonLink | null;
  people: DirectoryPerson[];
  /** Refs claimed by OTHER links — unpickable here. */
  claimed: Set<string>;
  onClose: () => void;
}) {
  const router = useRouter();
  const initialMembers = link?.members.map((member) => member.userRef) ?? [];
  const [members, setMembers] = useState<string[]>(initialMembers);
  const [note, setNote] = useState(link?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const editing = link !== null;
  const membersChanged =
    members.length !== initialMembers.length ||
    members.some((ref) => !initialMembers.includes(ref));
  const noteChanged = (link?.note ?? "") !== note;

  function toggle(ref: string) {
    setMembers((current) =>
      current.includes(ref) ? current.filter((r) => r !== ref) : [...current, ref],
    );
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (!editing) {
        const res = await fetch("/api/person-links", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ members, note }),
        });
        if (!res.ok) {
          setError(await readError(res));
          return;
        }
      } else {
        const url = `/api/person-links/${encodeURIComponent(link.id)}`;
        // One curated field per call, so an unchanged field is never rewritten.
        const patches: Array<Record<string, unknown>> = [];
        if (membersChanged) patches.push({ members });
        if (noteChanged) patches.push({ note });
        for (const body of patches) {
          const res = await fetch(url, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          if (!res.ok) {
            setError(await readError(res));
            return;
          }
        }
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
      title={editing ? "Edit person" : "Link identities"}
      description="Pick the identities that are the same human. The bot's memory of any of them becomes memory of all of them."
      footer={
        <>
          {error ? <p className="mr-auto text-sm text-danger">{error}</p> : null}
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={save}
            disabled={
              busy ||
              members.length < MIN_MEMBERS ||
              (editing && !membersChanged && !noteChanged)
            }
          >
            {busy ? "Saving…" : editing ? "Save changes" : "Link identities"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field id="person-link-note" label="Who is this?">
          {({ id }) => (
            <Input
              id={id}
              value={note}
              maxLength={MAX_NOTE_LEN}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. same person, work and personal accounts"
            />
          )}
        </Field>

        <div className="space-y-2">
          <p className="text-sm font-medium">Identities</p>
          {people.length === 0 ? (
            <p className="text-sm text-faint">
              No identities to link yet — people appear once they message the bot.
            </p>
          ) : (
            <ScrollArea className="max-h-64 space-y-1">
              {people.map((person) => {
                const taken = claimed.has(person.ref) && !members.includes(person.ref);
                return (
                  <div
                    key={person.ref}
                    className={`flex items-center gap-3 rounded-md px-2 py-1.5 text-sm ${
                      taken ? "opacity-50" : "hover:bg-subtle"
                    }`}
                  >
                    <Checkbox
                      checked={members.includes(person.ref)}
                      disabled={taken}
                      onChange={() => toggle(person.ref)}
                      aria-label={`Link ${person.label}`}
                    />
                    <span className="min-w-0 flex-1 truncate">{person.label}</span>
                    <Badge tone="neutral">{person.sourceLabel}</Badge>
                    {taken ? <span className="text-xs text-faint">already linked</span> : null}
                  </div>
                );
              })}
            </ScrollArea>
          )}
          <p className="text-xs text-faint">
            At least {MIN_MEMBERS} identities. Selected: {members.length}.
          </p>
        </div>
      </div>
    </Modal>
  );
}

function PersonLinkCard({
  link,
  onEdit,
  onDelete,
}: {
  link: PersonLink;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const title = link.note ?? link.members.map((member) => member.label ?? member.userRef).join(" = ");
  return (
    <Card>
      <CardHeader>
        <div className="flex min-w-0 items-center gap-2">
          <CardTitle className="truncate">{title}</CardTitle>
        </div>
        <CardAction>
          <Button size="icon" variant="ghost" onClick={onEdit} aria-label={`Edit ${title}`}>
            <Pencil className="h-4 w-4" />
          </Button>
          <Button size="icon" variant="ghost" onClick={onDelete} aria-label={`Unlink ${title}`}>
            <Trash2 className="h-4 w-4 text-danger" />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <ul className="space-y-1 text-sm">
          {link.members.map((member) => (
            <li key={member.userRef} className="flex items-center gap-2">
              <span className="text-foreground">
                {/* A ref no source knows any more is shown as itself: the link
                    still holds, and inventing a name would hide that. */}
                {member.label ?? <span className="font-mono text-xs">{member.userRef}</span>}
              </span>
              <Badge tone="neutral">{member.sourceLabel}</Badge>
              <span className="font-mono text-xs text-faint">{member.userRef}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

export function PersonLinksManager({
  links,
  people,
}: {
  links: PersonLink[];
  people: DirectoryPerson[];
}) {
  useLiveRefresh("users");
  const router = useRouter();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [state, setState] = useState<DialogState>({ kind: "closed" });
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const claimedBy = new Map<string, string>();
  for (const link of links) {
    for (const member of link.members) claimedBy.set(member.userRef, link.id);
  }

  async function remove(link: PersonLink) {
    const ok = await confirm({
      title: "Unlink these identities?",
      body:
        "They become separate people again: memory stored under one of them stops " +
        "surfacing for the others.",
      confirmLabel: "Unlink",
      tone: "danger",
    });
    if (!ok) return;
    setDeleteError(null);
    try {
      const res = await fetch(`/api/person-links/${encodeURIComponent(link.id)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        setDeleteError(await readError(res));
        return;
      }
      router.refresh();
    } catch {
      setDeleteError("Network error — could not reach the server");
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-muted">
          Identities the same human reaches the bot by. Memory reads resolve through these
          links, so what the bot knows about someone follows the person, not the account.
        </p>
        <Button asChild variant="outline" size="sm">
          <Link href={featureDebugHref("person-links")}>
            <Bug className="h-4 w-4" aria-hidden />
            Debug
          </Link>
        </Button>
      </div>

      {deleteError ? <p className="text-sm text-danger">{deleteError}</p> : null}

      {links.length === 0 ? (
        <EmptyState
          icon={Link2}
          title="No linked people yet"
          description="Link two identities when the same human reaches the bot by both — the bot's memory of them then follows the person, not the account."
        />
      ) : (
        <ScrollArea className="space-y-4">
          {links.map((link) => (
            <PersonLinkCard
              key={link.id}
              link={link}
              onEdit={() => setState({ kind: "edit", link })}
              onDelete={() => void remove(link)}
            />
          ))}
        </ScrollArea>
      )}

      <Fab
        label="Link identities"
        icon={<Plus className="h-4 w-4" />}
        onClick={() => setState({ kind: "create" })}
      />

      {state.kind !== "closed" ? (
        <PersonLinkDialog
          key={state.kind === "edit" ? state.link.id : "new"}
          link={state.kind === "edit" ? state.link : null}
          people={people}
          claimed={
            new Set(
              [...claimedBy]
                .filter(([, id]) => !(state.kind === "edit" && id === state.link.id))
                .map(([ref]) => ref),
            )
          }
          onClose={() => setState({ kind: "closed" })}
        />
      ) : null}

      {confirmDialog}
    </div>
  );
}
