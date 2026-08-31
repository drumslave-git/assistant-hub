import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { ForcedPasswordChangeForm } from "@/components/auth/ForcedPasswordChangeForm";
import { SESSION_COOKIE } from "@/lib/auth";
import { judgeSessionToken, MIN_PASSWORD_LENGTH } from "@/server/auth";

export const dynamic = "force-dynamic";

/**
 * The temporary-password gate. An account flagged `must_change_password`
 * (admin-created, handed a temporary password) is redirected here by the
 * dashboard layout and can go nowhere else until the password is replaced.
 * Visitors who don't belong here are bounced to where they do.
 */
export default async function ForcedPasswordChangePage() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  const verdict = await judgeSessionToken(token).catch(() => ({ kind: "invalid" }) as const);
  if (verdict.kind === "unconfigured") redirect("/setup");
  if (verdict.kind === "invalid") redirect("/login");
  if (!verdict.account.mustChangePassword) redirect("/");

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-1 text-center">
          <h1 className="text-xl font-semibold">Choose your password</h1>
          <p className="text-sm text-muted">
            Hi {verdict.account.displayName} — the password you signed in with is temporary.
            Replace it to continue. At least {MIN_PASSWORD_LENGTH} characters.
          </p>
        </div>
        <ForcedPasswordChangeForm />
      </div>
    </main>
  );
}
