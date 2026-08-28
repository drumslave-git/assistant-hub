import { Database } from "lucide-react";

import { EmptyState, PageHeader } from "@/components/ui";
import { getAssistants } from "@/features/assistants/server/service";
import { getToolsView } from "@/features/mcp-tools/server/service";
import type { ToolsView } from "@/features/mcp-tools/server/schema";
import { ToolsManager } from "@/features/mcp-tools/ui/ToolsManager";
import { getToolConnections } from "@/features/tool-connections/server/service";
import type { ToolConnection } from "@/features/tool-connections/server/schema";

// Connections are DB-backed and a discovery can change them at any moment.
export const dynamic = "force-dynamic";

/**
 * Tools dashboard page. Server Component: what the assistants can call, and
 * the connections those tools come from. Feature tools are code and always
 * offered; a connection's tools are offered where its scope says, and change
 * only when an operator applies a discovery.
 */
export default async function ToolsPage() {
  let view: ToolsView | null = null;
  let connections: ToolConnection[] = [];
  let assistants: { id: string; name: string }[] = [];
  let error: string | null = null;
  try {
    [view, connections, assistants] = await Promise.all([
      getToolsView(),
      getToolConnections(),
      getAssistants(),
    ]);
  } catch (err) {
    error = err instanceof Error ? err.message : "Could not load tools";
  }

  return (
    <>
      <PageHeader
        title="Tools"
        description="What the assistants can call while replying: the tools this hub ships with, and the MCP servers you connect. Every call runs in a bounded tool-call loop and is traced on the reply."
      />

      {view ? (
        <ToolsManager
          tools={view.tools}
          connections={connections}
          assistants={assistants.map((assistant) => ({
            id: assistant.id,
            name: assistant.name,
          }))}
        />
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
