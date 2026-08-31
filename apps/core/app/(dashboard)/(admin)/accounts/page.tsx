import { cookies } from "next/headers";

import { PageHeader } from "@/components/ui";
import { LiveIndicator } from "@/components/realtime/LiveIndicator";
import { listAccountViews } from "@/features/accounts/server/service";
import { AccountsManager } from "@/features/accounts/ui/AccountsManager";
import { SESSION_COOKIE } from "@/lib/auth";
import { judgeSessionToken } from "@/server/auth";

export const dynamic = "force-dynamic";

/**
 * Account management (redesign Phase 8). Server Component: the admin group's
 * layout already gated the role; this page reads the roster and hands the
 * client manager the acting account's id so it can pin the self-lockout
 * guards in the UI (the service enforces them regardless).
 */
export default async function AccountsPage() {
  const accounts = await listAccountViews();
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  const verdict = await judgeSessionToken(token).catch(() => ({ kind: "invalid" }) as const);
  const selfId = verdict.kind === "ok" ? verdict.account.id : "";

  return (
    <>
      <PageHeader
        title="Accounts"
        description="Who signs in to this dashboard, and as what."
        actions={<LiveIndicator topic="accounts" />}
      />
      <AccountsManager accounts={accounts} selfId={selfId} />
    </>
  );
}
