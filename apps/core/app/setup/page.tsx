import { redirect } from "next/navigation";

import { AuthPasswordForm } from "@/components/auth/AuthPasswordForm";
import { isAuthConfigured, MIN_PASSWORD_LENGTH } from "@/server/auth";

export const dynamic = "force-dynamic";

/**
 * First-run setup: create the first admin account. Exists only while no
 * account exists — afterwards it permanently redirects to `/login` (further
 * accounts are created by admins in the dashboard).
 */
export default async function SetupPage() {
  const configured = await isAuthConfigured().catch(() => false);
  if (configured) redirect("/login");

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-1 text-center">
          <h1 className="text-xl font-semibold">Welcome to llm-tg-bot</h1>
          <p className="text-sm text-muted">
            Create the first admin account that will own this dashboard. Password at least{" "}
            {MIN_PASSWORD_LENGTH} characters.
          </p>
        </div>
        <AuthPasswordForm
          endpoint="/api/auth/setup"
          submitLabel="Create admin and continue"
          autoComplete="new-password"
        />
      </div>
    </main>
  );
}
