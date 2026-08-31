import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { SESSION_COOKIE } from "@/lib/auth";
import { judgeSessionToken } from "@/server/auth";

/**
 * The admin half of the dashboard (redesign Phase 8): every operator page
 * lives in this route group — URLs unchanged — and this layout is the
 * page-side role gate on all of them at once. A signed-in user-role account
 * is sent to its own surface (the web chat); the API side enforces the same
 * boundary per route (`defineRoute` access levels), so this is UX, not the
 * only lock.
 */
export default async function AdminLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  const verdict = await judgeSessionToken(token).catch(
    // A DB outage must not lock the operator out of the status shell; the
    // outer dashboard layout already made this call and the pages render
    // their own "database unavailable" states.
    () => ({ kind: "db-down" }) as const,
  );
  if (verdict.kind === "ok" && verdict.account.role !== "admin") redirect("/chat");

  return children;
}
