import type { SourceId } from "@assistant-hub-swarm/contracts";

/**
 * MCP-tools feature contract. The toolset has two halves: the in-process
 * feature tools (code — each tool-owning feature contributes a registrar) and
 * the operator's tool connections (DB-backed, Phase 5). Feature tools are
 * always offered; a connection's are offered where its scope says.
 */

/** Where a connection tool's scope lets it be called. */
export interface ToolScopeView {
  /** Null = every source app; else the only source whose turns may call it. */
  appScope: SourceId | null;
  allAssistants: boolean;
  /** How many assistants may call it when `allAssistants` is false. */
  assistantCount: number;
}

/** A tool as shown on the Tools dashboard, from either half. */
export interface ToolView {
  /** The name the model calls — slug-prefixed for a connection's tools. */
  name: string;
  /** Human description shown to the operator (and given to the model). */
  description: string;
  /** Trace scope: the owning feature, or `connections` for a hosted tool. */
  feature: string;
  /** The connection this tool comes from, absent for in-process tools. */
  connection?: {
    id: string;
    slug: string;
    name: string;
    /** Managed connections are the source apps' own servers. */
    managed: boolean;
    enabled: boolean;
    scope: ToolScopeView;
  };
}

/** The Tools dashboard view: every tool either half offers. */
export interface ToolsView {
  tools: ToolView[];
}
