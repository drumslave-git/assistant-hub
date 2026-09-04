"use client";

import { Brain, Link2, Unlink, UserRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { useLiveRefresh } from "@/components/realtime/useLiveRefresh";
import { ChangePasswordSection } from "@/features/settings/ui/ChangePasswordSection";
import { Timestamp } from "@/components/time/Timestamp";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Field,
  Input,
  useConfirm,
} from "@/components/ui";
import type { ApiErrorBody } from "@/lib/api-error";

import type { ProfileIdentity, ProfileMemoryDoc } from "../server/profile";

/**
 * The profile page body (Phase 8): every account's own surface — display
 * name, password, the identities linked to this person, and the memory the
 * assistant holds about them (view + delete; no self-authoring, PLAN.md).
 */

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as ApiErrorBody;
    return body.error?.message ?? `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

function DisplayNameCard({
  username,
  initialDisplayName,
}: {
  username: string;
  initialDisplayName: string | null;
}) {
  const router = useRouter();
  const [displayName, setDisplayName] = useState(initialDisplayName ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName }),
      });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      setSaved(true);
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
        <CardTitle>Who you are</CardTitle>
        <CardDescription>
          Signed in as <span className="font-mono">{username}</span>. The display name is how
          you appear in chats.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Field id="profile-display-name" label="Display name" hint="Leave empty to use the username.">
          {({ id, describedBy }) => (
            <div className="flex gap-2">
              <Input
                id={id}
                aria-describedby={describedBy}
                value={displayName}
                onChange={(e) => {
                  setDisplayName(e.target.value);
                  setSaved(false);
                }}
              />
              <Button onClick={save} disabled={busy || displayName === (initialDisplayName ?? "")}>
                {busy ? "Saving…" : "Save"}
              </Button>
            </div>
          )}
        </Field>
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        {saved ? <p className="text-sm text-muted">Saved.</p> : null}
      </CardContent>
    </Card>
  );
}

function IdentitiesCard({ identities }: { identities: ProfileIdentity[] }) {
  const [minted, setMinted] = useState<{ code: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [unlinking, setUnlinking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { confirm, dialog: confirmDialog } = useConfirm();
  const router = useRouter();

  /**
   * The undo for redeeming a link code. Worth confirming: memory and owner
   * rights follow these links, so removing one changes what the assistant
   * knows about you on that platform.
   */
  async function unlink(identity: ProfileIdentity) {
    const label = identity.label ?? identity.ref;
    const ok = await confirm({
      title: `Unlink ${label}?`,
      body:
        `This ${identity.sourceLabel} identity stops being you. The assistant no longer ` +
        "carries your memory or owner rights there, and messages from it are treated as a " +
        "stranger's until you link it again.",
      confirmLabel: "Unlink",
      tone: "danger",
    });
    if (!ok) return;
    setUnlinking(identity.ref);
    setError(null);
    try {
      const res = await fetch(`/api/profile/identities?ref=${encodeURIComponent(identity.ref)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      router.refresh();
    } catch {
      setError("Network error — could not reach the server");
    } finally {
      setUnlinking(null);
    }
  }

  async function mint() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/profile/link-code", { method: "POST" });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      const body = (await res.json()) as { data: { code: string; expiresAt: string } };
      setMinted(body.data);
    } catch {
      setError("Network error — could not reach the server");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Your identities</CardTitle>
        <CardDescription>
          The platform identities linked to you. Memory and owner rights follow these links.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {identities.length <= 1 ? (
          <p className="text-sm text-muted">
            Only your web identity so far — nothing else is linked to you yet.
          </p>
        ) : null}
        <ul className="space-y-2">
          {identities.map((identity) => (
            <li key={identity.ref} className="flex items-center gap-2 text-sm">
              <Link2 className="h-3.5 w-3.5 text-faint" aria-hidden />
              <span className="min-w-0 truncate">
                {identity.label ?? <span className="font-mono text-xs">{identity.ref}</span>}
              </span>
              <Badge tone="neutral">{identity.sourceLabel}</Badge>
              {identity.self ? <Badge tone="info">this account</Badge> : null}
              {/* The web identity is not a link — it is what links are made to. */}
              {identity.self ? null : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto"
                  onClick={() => void unlink(identity)}
                  disabled={unlinking !== null}
                  // The same person usually carries the same handle on every
                  // platform, so the label alone names two buttons identically.
                  aria-label={`Unlink ${identity.label ?? identity.ref} on ${identity.sourceLabel}`}
                >
                  <Unlink className="h-3.5 w-3.5" aria-hidden />
                  {unlinking === identity.ref ? "Unlinking…" : "Unlink"}
                </Button>
              )}
            </li>
          ))}
        </ul>

        <div className="space-y-2 border-t border-border pt-4">
          {minted ? (
            <div className="space-y-1">
              <p className="text-sm">
                Send this code to any connected bot from the identity you want to link.
                It has to be the whole message, though mentioning the bot in front of it
                is fine — that is the only way to address one in a shared channel:
              </p>
              <p className="font-mono text-lg font-semibold tracking-wide">{minted.code}</p>
              <p className="text-xs text-faint">
                One-time, valid until <Timestamp iso={minted.expiresAt} />. Minting again
                replaces it.
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted">
              To link a messenger identity (e.g. your Telegram), mint a one-time code and send
              it to a bot from there.
            </p>
          )}
          {error ? <p className="text-sm text-danger">{error}</p> : null}
          <Button variant="outline" onClick={mint} disabled={busy}>
            {busy ? "Minting…" : minted ? "Mint a new code" : "Link another identity"}
          </Button>
        </div>
      </CardContent>
      {confirmDialog}
    </Card>
  );
}

function MemoryCard({ memory }: { memory: ProfileMemoryDoc[] }) {
  const router = useRouter();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [error, setError] = useState<string | null>(null);

  async function forget(doc: ProfileMemoryDoc) {
    const ok = await confirm({
      title: "Forget this?",
      body:
        "The whole memory document under this identity is deleted. The assistant may " +
        "re-learn facts from future conversations.",
      confirmLabel: "Forget",
      tone: "danger",
    });
    if (!ok) return;
    setError(null);
    try {
      const res = await fetch(`/api/profile/memory?userId=${encodeURIComponent(doc.userId)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      router.refresh();
    } catch {
      setError("Network error — could not reach the server");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>What the assistant remembers about you</CardTitle>
        <CardDescription>
          One document per identity. You can read everything and delete any of it — there is
          no way to write memory by hand.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        {memory.length === 0 ? (
          <EmptyState
            icon={Brain}
            title="Nothing remembered yet"
            description="Durable facts you share in conversations end up here after the nightly consolidation."
          />
        ) : (
          memory.map((doc) => (
            <div key={doc.userId} className="rounded-lg border border-border p-4">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-faint">{doc.ref}</span>
                <span className="text-xs text-faint">
                  updated <Timestamp iso={doc.updatedAt} />
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto text-danger"
                  onClick={() => void forget(doc)}
                >
                  Forget
                </Button>
              </div>
              <p className="text-sm whitespace-pre-wrap text-muted">{doc.content}</p>
            </div>
          ))
        )}
      </CardContent>
      {confirmDialog}
    </Card>
  );
}

export function ProfileManager({
  account,
  identities,
  memory,
}: {
  account: { username: string; displayName: string | null; role: "admin" | "user" };
  identities: ProfileIdentity[];
  memory: ProfileMemoryDoc[];
}) {
  // Linking happens somewhere else entirely — a code sent to a bot on another
  // platform — so this page has to hear about it rather than wait for a
  // reload. `users` covers the link graph, `accounts` the profile itself, and
  // `memory` the documents below, which arrive with a newly linked identity.
  useLiveRefresh(["users", "accounts", "memory"]);
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-muted">
        <UserRound className="h-4 w-4" aria-hidden />
        <span>
          Role: <Badge tone={account.role === "admin" ? "info" : "neutral"}>{account.role}</Badge>
        </span>
      </div>
      <DisplayNameCard username={account.username} initialDisplayName={account.displayName} />
      <IdentitiesCard identities={identities} />
      <MemoryCard memory={memory} />
      <Card>
        <CardHeader>
          <CardTitle>Password</CardTitle>
        </CardHeader>
        <CardContent>
          <ChangePasswordSection />
        </CardContent>
      </Card>
    </div>
  );
}
