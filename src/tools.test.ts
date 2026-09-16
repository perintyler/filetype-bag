import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AnyToolDefinition } from "@barry-rocks/tools";
import * as tools from "./tools.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function exportedTools(): AnyToolDefinition[] {
  return (Object.values(tools) as unknown[]).filter(
    (v): v is AnyToolDefinition =>
      typeof v === "object" && v !== null && "name" in v && "namespace" in v && "handler" in v,
  );
}

describe("tool exports", () => {
  it("exports at least one tool", () => {
    expect(exportedTools().length).toBeGreaterThan(0);
  });

  for (const tool of exportedTools()) {
    describe(tool.name, () => {
      it("has required fields", () => {
        expect(tool.name).toBeTruthy();
        expect(tool.namespace).toBeTruthy();
        expect(typeof tool.handler).toBe("function");
        expect(tool.description).toBeTruthy();
      });
    });
  }

  // The MCP client prefixes the namespace, so `filetype_convert` would surface
  // as mcp__filetype__filetype_convert.
  it("no tool repeats the namespace in its name", () => {
    for (const tool of exportedTools()) expect(tool.name).not.toMatch(/^filetype[_-]/);
  });

  // A stale build that grants the wrong namespace makes tools silently vanish
  // from a session, so the manifest and the code must agree exactly.
  it("bag.yaml tool-metadata matches the exported tools exactly", () => {
    const manifest = readFileSync(join(HERE, "..", "bag.yaml"), "utf8");
    const declared = [...manifest.matchAll(/toolName:\s*(\w+),\s*namespace:\s*(\w+),\s*access:\s*(\w+)/g)].map(
      (m) => ({ name: m[1], namespace: m[2], access: m[3] }),
    );
    const actual = exportedTools().map((t) => ({
      name: t.name,
      namespace: t.namespace,
      access: t.access,
    }));
    const key = (t: { name: string; namespace: string; access: string }) =>
      `${t.namespace}/${t.name}:${t.access}`;
    expect(declared.map(key).sort()).toEqual(actual.map(key).sort());
  });

  it("declares every tool in the manifest", () => {
    const manifest = readFileSync(join(HERE, "..", "bag.yaml"), "utf8");
    const declaredCount = [...manifest.matchAll(/toolName:/g)].length;
    expect(declaredCount).toBe(exportedTools().length);
  });
});
