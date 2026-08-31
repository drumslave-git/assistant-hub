import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { TraceDetail } from "@/components/debug";
import { Button } from "@/components/ui";
import { isApiError } from "@/lib/api-error";
import { actingAccount } from "@/server/auth/acting";
import { requireTraceVisible } from "@/server/ownership";
import { getTraceDetail } from "@/server/trace";
import type { Trace } from "@/lib/trace";

// The trace is read from the database at request time.
export const dynamic = "force-dynamic";

/** Shared trace detail page — the single detail route for every feature's traces. */
export default async function TraceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let trace: Trace;
  try {
    trace = await getTraceDetail(id);
    // Phase 9: a user sees only their own assistants' turns.
    await requireTraceVisible(await actingAccount(), trace);
  } catch (err) {
    if (isApiError(err) && err.code === "not_found") notFound();
    throw err;
  }

  return (
    <div className="space-y-4">
      <Button asChild variant="ghost" size="sm">
        <Link href="/debug">
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Back to traces
        </Link>
      </Button>
      <TraceDetail trace={trace} />
    </div>
  );
}
