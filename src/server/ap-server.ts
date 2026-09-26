// MCP stdio server exposing the mock ERP to the agent as the `ap` server.
// Claude Code sees these tools as mcp__ap__<tool>.
//
// Usage: CLEARTOPAY_WORLD=/abs/path/world.json node dist/ap-server.mjs

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync } from "node:fs";
import { loadWorld, saveWorld } from "../shared/world";
import { TOOLS, runTool } from "./tools";

const worldPath = process.env.CLEARTOPAY_WORLD ?? process.argv[2];
if (!worldPath || !existsSync(worldPath)) {
  process.stderr.write(`ap-server: set CLEARTOPAY_WORLD to an existing world.json (got ${worldPath})\n`);
  process.exit(1);
}

const server = new McpServer({ name: "ap", version: "0.1.0" });

for (const [name, impl] of Object.entries(TOOLS)) {
  server.registerTool(
    name,
    { description: impl.description, inputSchema: impl.schema },
    async (args: Record<string, unknown>) => {
      // Re-read on every call: the world file is the single source of truth and
      // the grader reads it after the run.
      const world = loadWorld(worldPath);
      const result = runTool(world, name, args ?? {});
      saveWorld(worldPath, world);
      return { content: [{ type: "text" as const, text: result.text }], isError: !result.ok };
    },
  );
}

await server.connect(new StdioServerTransport());
