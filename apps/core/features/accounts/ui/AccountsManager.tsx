"use client";

import { Bug, KeyRound, Plus, ShieldCheck, UserRound } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { useLiveRefresh } from "@/components/realtime/useLiveRefresh";
import { Timestamp } from "@/components/time/Timestamp";
import {
  Badge,
  Button,
  EmptyState,
  Fab,
  Field,
  Input,
  Modal,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  useConfirm,
} from "@/components/ui";
import type { ApiErrorBody } from "@/lib/api-error";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth";
import { featureDebugHref } from "@/lib/features";

import type { AccountView } from "../schema";

/**
 * The `/accounts` admin page body (redesign Phase 8): every account with its
 * role and state, a create dialog that issues a temporary password, and the
 * per-row actions (activate/deactivate, role, fresh temporary password).
 * There is no open registration — this page is where accounts come from.
 */

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as ApiErrorBody;
    return body.error?.message ?? `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

/** A readable random temporary password (the admin hands it over out of band). */
function suggestPassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  const bytes = new Uint8Array(14);
  crypto.getRandomValues(bytes);
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

type DialogState =
  | { kind: "closed" }
  | { kind: "create" }
  | { kind: "reset"; account: AccountView };

function AccountDialog({
  account,
  selfId,
  onClose,
}: {
  /** Null creates a new account; set hands this one a fresh temp password. */
  account: AccountView | null;
  selfId: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<"admin" | "user">("user");
  const [password, setPassword] = useState(suggestPassword);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const creating = account === null;
  void selfId;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = creating
        ? await fetch("/api/accounts", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              username,
              displayName: displayName || undefined,
              role,
              temporaryPassword: password,
            }),
          })
        : await fetch(`/api/accounts/${encodeURIComponent(account.id)}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ temporaryPassword: password }),
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
      title={creating ? "Create account" : `New temporary password for ${account.username}`}
      description={
        creating
          ? "Hand the temporary password over out of band; they must replace it at first sign-in."
          : "Their current password stops working and every session is signed out. Hand the new temporary password over out of band."
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
              busy ||
              password.length < MIN_PASSWORD_LENGTH ||
              (creating && username.trim().length === 0)
            }
          >
            {busy ? "Saving…" : creating ? "Create account" : "Issue password"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {creating ? (
          <>
            <Field id="account-username" label="Username">
              {({ id }) => (
                <Input
                  id={id}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="off"
                  placeholder="e.g. sam"
                />
              )}
            </Field>
            <Field id="account-display-name" label="Display name" hint="Optional; shown in chats.">
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  autoComplete="off"
                />
              )}
            </Field>
            <Field id="account-role" label="Role">
              {({ id }) => (
                <Select
                  id={id}
                  value={role}
                  onChange={(e) => setRole(e.target.value as "admin" | "user")}
                >
                  <option value="user">User — web chat and their own data</option>
                  <option value="admin">Admin — everything</option>
                </Select>
              )}
            </Field>
          </>
        ) : null}
        <Field
          id="account-temp-password"
          label="Temporary password"
          hint={`At least ${MIN_PASSWORD_LENGTH} characters. Shown only here — copy it before saving.`}
        >
          {({ id, describedBy }) => (
            <div className="flex gap-2">
              <Input
                id={id}
                aria-describedby={describedBy}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="off"
                className="font-mono"
              />
              <Button variant="outline" onClick={() => setPassword(suggestPassword())}>
                Regenerate
              </Button>
            </div>
          )}
        </Field>
      </div>
    </Modal>
  );
}

export function AccountsManager({
  accounts,
  selfId,
}: {
  accounts: AccountView[];
  selfId: string;
}) {
  useLiveRefresh("accounts");
  const router = useRouter();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [dialog, setDialog] = useState<DialogState>({ kind: "closed" });
  const [actionError, setActionError] = useState<string | null>(null);

  async function patch(account: AccountView, body: Record<string, unknown>): Promise<void> {
    setActionError(null);
    try {
      const res = await fetch(`/api/accounts/${encodeURIComponent(account.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setActionError(await readError(res));
        return;
      }
      router.refresh();
    } catch {
      setActionError("Network error — could not reach the server");
    }
  }

  async function toggleActive(account: AccountView) {
    if (account.active) {
      const ok = await confirm({
        title: `Deactivate ${account.username}?`,
        body:
          "They can no longer sign in and their sessions stop working. " +
          "Everything they own stays — reactivate any time.",
        confirmLabel: "Deactivate",
        tone: "danger",
      });
      if (!ok) return;
    }
    await patch(account, { active: !account.active });
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-muted">
          Who can sign in, and as what. There is no open registration: accounts are created
          here, with a temporary password their holder replaces at first sign-in.
        </p>
        <Button asChild variant="outline" size="sm">
          <Link href={featureDebugHref("accounts")}>
            <Bug className="h-4 w-4" aria-hidden />
            Debug
          </Link>
        </Button>
      </div>

      {actionError ? <p className="text-sm text-danger">{actionError}</p> : null}

      {accounts.length === 0 ? (
        <EmptyState
          icon={UserRound}
          title="No accounts"
          description="First-run setup creates the first admin; further accounts are created here."
        />
      ) : (
        <Table>
          <TableHead>
            <TableRow>
              <TableHeaderCell>Account</TableHeaderCell>
              <TableHeaderCell>Role</TableHeaderCell>
              <TableHeaderCell>State</TableHeaderCell>
              <TableHeaderCell>Created</TableHeaderCell>
              <TableHeaderCell aria-label="Actions" />
            </TableRow>
          </TableHead>
          <TableBody>
            {accounts.map((account) => (
              <TableRow key={account.id}>
                <TableCell>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">
                        {account.displayName ?? account.username}
                      </span>
                      {account.id === selfId ? <Badge tone="neutral">you</Badge> : null}
                    </div>
                    <div className="truncate font-mono text-xs text-faint">{account.username}</div>
                  </div>
                </TableCell>
                <TableCell>
                  <Badge tone={account.role === "admin" ? "info" : "neutral"} className="gap-1">
                    {account.role === "admin" ? <ShieldCheck className="h-3 w-3" /> : null}
                    {account.role}
                  </Badge>
                </TableCell>
                <TableCell>
                  {!account.active ? (
                    <Badge tone="danger" dot>
                      Deactivated
                    </Badge>
                  ) : account.mustChangePassword ? (
                    <Badge tone="warning" dot>
                      Temporary password
                    </Badge>
                  ) : (
                    <Badge tone="success" dot>
                      Active
                    </Badge>
                  )}
                </TableCell>
                <TableCell>
                  <Timestamp iso={account.createdAt} />
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap justify-end gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setDialog({ kind: "reset", account })}
                      disabled={!account.active}
                    >
                      <KeyRound className="h-3.5 w-3.5" />
                      Password
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        void patch(account, {
                          role: account.role === "admin" ? "user" : "admin",
                        })
                      }
                      disabled={account.id === selfId}
                    >
                      {account.role === "admin" ? "Make user" : "Make admin"}
                    </Button>
                    <Button
                      size="sm"
                      variant={account.active ? "ghost" : "outline"}
                      onClick={() => void toggleActive(account)}
                      disabled={account.id === selfId}
                    >
                      {account.active ? "Deactivate" : "Reactivate"}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Fab
        label="Create account"
        icon={<Plus className="h-4 w-4" />}
        onClick={() => setDialog({ kind: "create" })}
      />

      {dialog.kind !== "closed" ? (
        <AccountDialog
          key={dialog.kind === "reset" ? dialog.account.id : "new"}
          account={dialog.kind === "reset" ? dialog.account : null}
          selfId={selfId}
          onClose={() => setDialog({ kind: "closed" })}
        />
      ) : null}

      {confirmDialog}
    </div>
  );
}
