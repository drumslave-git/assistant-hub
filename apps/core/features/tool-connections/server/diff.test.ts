import { describe, expect, it } from "vitest";

import { describeDiff, diffToolsets, hasDrift, sameTool } from "./diff";

/**
 * The comparison the operator reviews before applying. Its one job is to be
 * quiet about differences that are not differences — a server that reorders
 * its schema keys must not read as drift, or every discovery would ask for
 * an apply that changes nothing.
 */

const tool = (name: string, description = "", inputSchema: Record<string, unknown> = {}) => ({
  name,
  description,
  inputSchema,
});

describe("diffToolsets", () => {
  it("classifies added, changed, removed and unchanged", () => {
    const applied = [tool("a", "first"), tool("b", "second"), tool("c", "third")];
    const discovered = [tool("a", "first"), tool("b", "second, reworded"), tool("d", "new")];

    expect(diffToolsets(applied, discovered)).toEqual({
      added: ["d"],
      changed: ["b"],
      removed: ["c"],
      unchanged: ["a"],
    });
  });

  it("treats a reordered schema as unchanged", () => {
    const applied = [
      tool("a", "x", { type: "object", properties: { q: { type: "string" }, n: { type: "number" } } }),
    ];
    const discovered = [
      tool("a", "x", { properties: { n: { type: "number" }, q: { type: "string" } }, type: "object" }),
    ];
    expect(diffToolsets(applied, discovered).unchanged).toEqual(["a"]);
    expect(hasDrift(diffToolsets(applied, discovered))).toBe(false);
  });

  it("notices a schema that really changed", () => {
    const applied = [tool("a", "x", { type: "object", properties: { q: { type: "string" } } })];
    const discovered = [tool("a", "x", { type: "object", properties: { q: { type: "number" } } })];
    expect(diffToolsets(applied, discovered).changed).toEqual(["a"]);
    expect(sameTool(applied[0], discovered[0])).toBe(false);
  });

  it("reads a first discovery as all-added and an empty server as all-gone", () => {
    expect(diffToolsets([], [tool("a"), tool("b")]).added).toEqual(["a", "b"]);
    expect(diffToolsets([tool("a")], []).removed).toEqual(["a"]);
  });
});

describe("describeDiff", () => {
  it("says nothing changed, or exactly what did", () => {
    expect(describeDiff(diffToolsets([tool("a")], [tool("a")]))).toBe("1 tools, unchanged");
    expect(describeDiff(diffToolsets([tool("a"), tool("b")], [tool("a", "new"), tool("c")]))).toBe(
      "1 added, 1 changed, 1 gone",
    );
  });
});
