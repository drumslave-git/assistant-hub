import { describe, expect, it } from "vitest";

import { loadMcpRegistry } from "./runtime";

/**
 * Compatibility lint over every registered tool's serialized OpenAI
 * `parameters` schema. Local servers (llama.cpp, vLLM, Ollama) template tool
 * JSON without validating it, but strict providers reject whole chat requests
 * over one bad declaration — Google's OpenAI-compat layer (reached via
 * OpenRouter) 400s the entire reply call, naming violations like
 * `enum[3]: cannot be empty` and `items: missing field`. These rules pin the
 * constructs it rejected on 2026-08-12 so no future tool reintroduces them:
 *
 * - no empty string as an enum member ("optional" is modeled by omitting the
 *   field, not by an "" sentinel)
 * - no positional/tuple `items` arrays (Google wants one schema object)
 */

/** Collect rule violations across a JSON Schema tree, labeled by path. */
function scan(node: unknown, path: string, problems: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => scan(item, `${path}[${i}]`, problems));
    return;
  }
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  if (Array.isArray(obj.enum) && obj.enum.some((value) => value === "")) {
    problems.push(`${path}.enum contains an empty string`);
  }
  if (Array.isArray(obj.items)) {
    problems.push(`${path}.items is a positional tuple, not a schema object`);
  }
  for (const [key, value] of Object.entries(obj)) {
    if (key === "enum") continue;
    scan(value, `${path}.${key}`, problems);
  }
}

describe("MCP tool schemas vs strict providers", () => {
  it("every registered tool's parameters pass the Google-compat rules", async () => {
    const registry = await loadMcpRegistry();
    const tools = await registry.listOpenAiTools();
    // A wrong import or empty registry must not vacuously pass.
    expect(tools.length).toBeGreaterThan(10);

    const problems: string[] = [];
    for (const tool of tools) {
      scan(tool.function.parameters, tool.function.name, problems);
    }
    expect(problems).toEqual([]);
  });
});
