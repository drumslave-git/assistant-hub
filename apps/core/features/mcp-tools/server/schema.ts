/**
 * MCP-tools feature contract. The registry of available tools is code (each
 * tool-owning feature contributes registrars). All registered tools are always
 * available to the model during a reply; there is no per-tool on/off switch.
 */

/** A registered MCP tool as shown on the Tools dashboard. */
export interface ToolView {
  /** Unique tool name (the identifier the model calls). */
  name: string;
  /** Human description shown to the operator (and given to the model). */
  description: string;
  /** The feature that contributes the tool. */
  feature: string;
}

/** The Tools dashboard view: every registered tool. */
export interface ToolsView {
  tools: ToolView[];
}
