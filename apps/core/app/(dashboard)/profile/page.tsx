import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { PageHeader } from "@/components/ui";
import {
  getProfileIdentities,
  getProfileMemory,
} from "@/features/accounts/server/profile";
import { ProfileManager } from "@/features/accounts/ui/ProfileManager";
import { SESSION_COOKIE } from "@/lib/auth";
import { judgeSessionToken } from "@/server/auth";

export const dynamic = "force-dynamic";

/**
 * The acting account's profile (Phase 8) — every role has one: display name
 * and password, the identities linked to this person, and the memory the
 * assistant holds about them (view + delete). Lives OUTSIDE the (admin)
 * group: this is each account's own page, not an operator surface.
 */
export default async function ProfilePage() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  const verdict = await judgeSessionToken(token).catch(() => ({ kind: "invalid" }) as const);
  if (verdict.kind !== "ok") redirect("/login");
  const account = verdict.account;

  const [identities, memory] = await Promise.all([
    getProfileIdentities(account.id),
    getProfileMemory(account.id).catch(() => []),
  ]);

  return (
    <>
      <PageHeader
        title="Profile"
        description="Your account, your identities, and what the assistant remembers about you."
      />
      <ProfileManager
        account={{
          username: account.username,
          displayName:
            account.displayName === account.username ? null : account.displayName,
          role: account.role,
        }}
        identities={identities}
        memory={memory}
      />
    </>
  );
}
