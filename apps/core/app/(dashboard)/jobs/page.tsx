import { PageHeader } from "@/components/ui";
import { getAllJobs } from "@/features/jobs/server/registry";
import { JobsBoard } from "@/features/jobs/ui/JobsBoard";

// The board reflects live in-process scheduler state (phase, backlog, progress),
// so it must be read per request, never cached.
export const dynamic = "force-dynamic";

/**
 * Background Jobs — a consolidated view of every background job (running,
 * scheduled, idle, paused). A running job shows what it is doing right now and how
 * far along it is, live over SSE. Each job's "Run now" and details link reuse the
 * owning feature's existing endpoint and page.
 */
export default async function JobsPage() {
  const jobs = await getAllJobs();

  return (
    <>
      <PageHeader
        title="Background jobs"
        description="Every scheduled and background job in one place — with live progress for whatever is running now."
      />
      <JobsBoard jobs={jobs} />
    </>
  );
}
