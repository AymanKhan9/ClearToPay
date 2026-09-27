// Creates one self-contained run directory: the world, the MCP config, the
// Claude Code project settings (Failproof hooks for guarded arms), the
// Failproof policy bundle and the guard config.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import { buildWorld, loadScenario, repoRoot, saveWorld } from "../shared/world";
import { DEFAULT_THRESHOLDS, type Arm, type RunConfig, type Scenario, type Thresholds } from "../shared/types";

export const ARMS: Arm[] = ["none", "floor", "strict", "jev"];

export interface JevOpts {
  provider: "typesafe" | "openrouter" | "mock";
  model?: string;
  timeout_ms?: number;
}

export function defaultModelFor(provider: JevOpts["provider"]): string {
  if (provider === "openrouter") return "typesafe/jev-1.13";
  if (provider === "mock") return "mock";
  return "jev-1.13.0";
}

export function failproofBin(): string {
  if (process.env.FAILPROOFAI_BIN) return process.env.FAILPROOFAI_BIN;
  const local = resolve(repoRoot(), "node_modules", ".bin", "failproofai");
  if (existsSync(local)) return local;
  try {
    return execSync("command -v failproofai", { encoding: "utf8" }).trim() || "failproofai";
  } catch {
    return "failproofai";
  }
}

export function taskText(s: Scenario): string {
  const base = readFileSync(resolve(repoRoot(), "prompts", "task.md"), "utf8").trim();
  return s.operator_note ? `${base}\n\nAlso: ${s.operator_note}` : base;
}

export function runbookText(): string {
  return readFileSync(resolve(repoRoot(), "prompts", "runbook.md"), "utf8").trim();
}

export function loadThresholds(): Thresholds {
  const p = resolve(repoRoot(), "data", "calibration", "thresholds.json");
  if (!existsSync(p)) return DEFAULT_THRESHOLDS;
  try {
    return { ...DEFAULT_THRESHOLDS, ...(JSON.parse(readFileSync(p, "utf8")) as Partial<Thresholds>) };
  } catch {
    return DEFAULT_THRESHOLDS;
  }
}

const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"];

export function createRunDir(opts: { dir: string; scenarioId: string; arm: Arm; jev: JevOpts; task?: string }): { dir: string; scenario: Scenario; config: RunConfig; task: string } {
  const root = repoRoot();
  const dir = resolve(opts.dir);
  const scenario = loadScenario(opts.scenarioId);
  mkdirSync(resolve(dir, ".cleartopay"), { recursive: true });
  mkdirSync(resolve(dir, ".claude"), { recursive: true });

  const worldPath = resolve(dir, "world.json");
  saveWorld(worldPath, buildWorld(scenario));

  const config: RunConfig = {
    scenario: scenario.id,
    arm: opts.arm,
    world_path: worldPath,
    jev: { provider: opts.jev.provider, model: opts.jev.model ?? defaultModelFor(opts.jev.provider), timeout_ms: opts.jev.timeout_ms ?? 4000 },
    thresholds: loadThresholds(),
    fail_closed: true,
  };
  writeFileSync(resolve(dir, ".cleartopay", "config.json"), JSON.stringify(config, null, 2));

  // The runner is a trusted channel: record the operator's task up front so the
  // guard has it even if a harness does not fire UserPromptSubmit.
  const task = opts.task ?? taskText(scenario);
  writeFileSync(resolve(dir, ".cleartopay", "operator.json"), JSON.stringify({ prompts: [{ at: new Date().toISOString(), source: "runner", text: task }] }, null, 2));
  writeFileSync(resolve(dir, "task.txt"), task + "\n");

  const serverPath = resolve(root, "dist", "ap-server.mjs");
  if (!existsSync(serverPath)) throw new Error("dist/ap-server.mjs missing — run `npm run build` first");
  writeFileSync(
    resolve(dir, ".mcp.json"),
    JSON.stringify({ mcpServers: { ap: { command: process.execPath, args: [serverPath], env: { CLEARTOPAY_WORLD: worldPath } } } }, null, 2),
  );

  const settings: Record<string, unknown> = {
    permissions: { allow: ["mcp__ap", "mcp__ap__*"], deny: ["Bash", "Read", "Write", "Edit", "WebFetch", "WebSearch"] },
  };
  if (opts.arm !== "none") {
    const policy = resolve(root, "dist", "cleartopay-policies.mjs");
    if (!existsSync(policy)) throw new Error("dist/cleartopay-policies.mjs missing — run `npm run build` first");
    mkdirSync(resolve(dir, ".failproofai", "policies"), { recursive: true });
    copyFileSync(policy, resolve(dir, ".failproofai", "policies", "cleartopay-policies.mjs"));
    const bin = failproofBin();
    const hooks: Record<string, unknown[]> = {};
    for (const ev of HOOK_EVENTS) {
      hooks[ev] = [{ hooks: [{ type: "command", command: `FAILPROOFAI_NO_FIRST_RUN=1 "${bin}" --hook ${ev}`, timeout: 60, __failproofai_hook__: true }] }];
    }
    settings.hooks = hooks;
  }
  writeFileSync(resolve(dir, ".claude", "settings.json"), JSON.stringify(settings, null, 2));
  writeFileSync(resolve(dir, "run.json"), JSON.stringify({ scenario: scenario.id, arm: opts.arm, jev: config.jev, created: new Date().toISOString() }, null, 2));
  return { dir, scenario, config, task };
}
