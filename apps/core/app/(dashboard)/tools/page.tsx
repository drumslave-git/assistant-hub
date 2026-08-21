import { Database } from "lucide-react";

import { EmptyState, PageHeader } from "@/components/ui";
import { getToolsView } from "@/features/mcp-tools/server/service";
import type { ToolsView } from "@/features/mcp-tools/server/schema";
import { ToolsManager } from "@/features/mcp-tools/ui/ToolsManager";

// The tool registry is code, but rendered at request time for consistency.
export const dynamic = "force-dynamic";

/**
 * Tools dashboard page. Server Component: lists every registered MCP tool the bot
 * can call while replying. All registered tools are always available to the model
 * (they run in a bounded tool-call loop and every call is traced on the reply
 * trace under Debug) — this page is read-only visibility.
 */
export default async function ToolsPage() {
  let view: ToolsView | null = null;
  let error: string | null = null;
  try {
    view = await getToolsView();
  } catch (err) {
    error = err instanceof Error ? err.message : "Could not load tools";
  }

  return (
    <>
      <PageHeader
        title="Tools"
        description="MCP tools the bot can call while replying. All registered tools are always available to the model; each call runs in a bounded tool-call loop and is traced on the reply."
      />

      {view ? (
        <ToolsManager tools={view.tools} />
      ) : (
        <EmptyState
          icon={Database}
          title="Tools unavailable"
          description={error ?? "The tool registry could not be loaded."}
        />
      )}
    </>
  );
}
