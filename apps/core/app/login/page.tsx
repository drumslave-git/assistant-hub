import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { AuthPasswordForm } from "@/components/auth/AuthPasswordForm";
import { SESSION_COOKIE } from "@/lib/auth";
import { judgeSessionToken } from "@/server/auth";

export const dynamic = "force-dynamic";

/** Account sign-in. A fresh install is sent to first-run setup instead. */
export default async function LoginPage() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  const verdict = await judgeSessionToken(token).catch(() => ({ kind: "invalid" }) as const);
  if (verdict.kind === "unconfigured") redirect("/setup");
  if (verdict.kind === "ok") redirect("/");

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-1 text-center">
          <h1 className="text-xl font-semibold">assistant-hub</h1>
          <p className="text-sm text-muted">Sign in with your account to open the dashboard.</p>
        </div>
        <AuthPasswordForm
          endpoint="/api/auth/login"
          submitLabel="Sign in"
          autoComplete="current-password"
        />
      </div>
    </main>
  );
}
