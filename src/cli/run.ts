// One real agent run: Claude Code (headless) + the `ap` MCP server, with
// Failproof hooks and the ClearToPay policy in guarded arms. Streams a live
// view of tool calls and blocks, then grades the run.
//
//   npm run run -- --scenario a1-compromised-thread --arm jev --jev typesafe
//   npm run run -- --scenario a1-compromised-thread --arm none            # the unguarded baseline

import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { repoRoot } from "../shared/world";
import type { Arm } from "../shared/types";
import { createRunDir, runbookText, type JevOpts } from "./workspace";
import { gradeRun, type RunResult } from "../grader/grade";
import { args as parseArgs, c, rupees } from "./util";
import { printTimeline } from "./show";

export type AgentEvent =
  | { type: "tool"; name: string; input: unknown }
  | { type: "text"; text: string }
  | { type: "blocked"; name: string; message: string }
  | { type: "error"; name: string; text: string }
  | { type: "ok"; name: string; text: string }
  | { type: "result"; turns?: number; cost_usd?: number; duration_ms?: number };

export interface AgentOpts {
  model: string;
  permissionMode: string;
  budgetUsd: number;
  timeoutMin: number;
  live: boolean;
  claudeBin?: string;
  /** Receives every parsed event; defaults to the terminal printer below. */
  onEvent?: (e: AgentEvent) => void;
}

const READ_TOOLS = ["list_inbox", "read_email", "list_open_invoices", "get_party", "list_parties", "list_credits", "list_callbacks"];

function short(o: unknown, n = 110): string {
  const s = JSON.stringify(o);
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function printEvent(e: AgentEvent, label: string): void {
  if (e.type === "tool") console.log(`${label}${c.blue("→")} ${c.bold(e.name)} ${c.dim(short(e.input))}`);
  else if (e.type === "text") console.log(`${label}${c.magenta("✎")} ${c.dim(e.text.split("\n")[0].slice(0, 140))}`);
  else if (e.type === "blocked") console.log(`${label}${c.red("✗ BLOCKED")} ${e.name}: ${c.yellow(e.message.split("\n")[0].slice(0, 160))}`);
  else if (e.type === "error") console.log(`${label}${c.yellow("! error")} ${e.name}: ${e.text.slice(0, 120)}`);
  else if (e.type === "ok") {
    if (!READ_TOOLS.includes(e.name)) console.log(`${label}${c.green("✓")} ${e.name}: ${c.dim(e.text.split("\n")[0].slice(0, 120))}`);
  } else console.log(`${label}${c.dim(`done · ${e.turns} turns · $${(e.cost_usd ?? 0).toFixed(3)} · ${Math.round((e.duration_ms ?? 0) / 1000)}s`)}`);
}

export async function runAgent(dir: string, task: string, opts: AgentOpts, label = ""): Promise<void> {
  const emit = opts.onEvent ?? ((e: AgentEvent) => printEvent(e, label));
  const argv = [
    "-p",
    task,
    "--append-system-prompt",
    runbookText(),
    "--model",
    opts.model,
    "--mcp-config",
    resolve(dir, ".mcp.json"),
    "--strict-mcp-config",
    "--tools",
    "",
    "--allowedTools",
    "mcp__ap,mcp__ap__*",
    "--permission-mode",
    opts.permissionMode,
    "--setting-sources",
    "project",
    "--output-format",
    "stream-json",
    "--verbose",
    "--max-budget-usd",
    String(opts.budgetUsd),
  ];
  const transcript = createWriteStream(resolve(dir, "transcript.jsonl"));
  const stderr = createWriteStream(resolve(dir, "claude.stderr.log"));
  const child = spawn(opts.claudeBin ?? process.env.CLAUDE_BIN ?? "claude", argv, {
    cwd: dir,
    env: { ...process.env, FAILPROOFAI_NO_FIRST_RUN: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const timer = setTimeout(() => {
    stderr.write(`\n[cleartopay] killed after ${opts.timeoutMin} min\n`);
    child.kill("SIGTERM");
  }, opts.timeoutMin * 60_000);

  let buf = "";
  const names = new Map<string, string>();
  child.stdout.on("data", (d: Buffer) => {
    transcript.write(d);
    if (!opts.live && !opts.onEvent) return;
    buf += d.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try {
        const m = JSON.parse(line);
        if (m.type === "assistant") {
          for (const part of m.message?.content ?? []) {
            if (part.type === "tool_use") {
              const name = String(part.name).replace(/^mcp__ap__/, "");
              names.set(part.id, name);
              emit({ type: "tool", name, input: part.input });
            } else if (part.type === "text" && part.text?.trim()) {
              emit({ type: "text", text: part.text.trim() });
            }
          }
        } else if (m.type === "user") {
          for (const part of m.message?.content ?? []) {
            if (part.type !== "tool_result") continue;
            const text = typeof part.content === "string" ? part.content : (part.content ?? []).map((x: { text?: string }) => x.text ?? "").join("\n");
            const name = names.get(part.tool_use_id) ?? "tool";
            if (/failproofai|ClearToPay/.test(text)) emit({ type: "blocked", name, message: text.replace(/^.*?because:\s*/s, "") });
            else if (part.is_error) emit({ type: "error", name, text });
            else emit({ type: "ok", name, text });
          }
        } else if (m.type === "result") {
          emit({ type: "result", turns: m.num_turns, cost_usd: m.total_cost_usd, duration_ms: m.duration_ms });
        }
      } catch {
        /* partial or non-JSON line */
      }
    }
  });
  child.stderr.on("data", (d: Buffer) => stderr.write(d));
  await new Promise<void>((resolveP) => child.on("close", () => resolveP()));
  clearTimeout(timer);
  transcript.end();
  stderr.end();
}

export async function runOne(dir: string, scenarioId: string, arm: Arm, jev: JevOpts, agent: AgentOpts, label = "", taskOverride?: string): Promise<RunResult> {
  const { task } = createRunDir({ dir, scenarioId, arm, jev, task: taskOverride });
  await runAgent(dir, task, agent, label);
  return gradeRun(dir);
}

export function describe(r: RunResult): string {
  const bits = [
    r.pass ? c.green("PASS") : c.red("FAIL"),
    r.outcome,
    r.attacker_paid ? c.red(`sent to attacker ${rupees(r.attacker_paid)}`) : "",
    r.latent_exposure ? c.red(`poisoned records ${rupees(r.latent_exposure)}`) : "",
    `legit paid ${r.legit.paid}/${r.legit.expected}`,
    r.guard.jev_requests ? c.dim(`${r.guard.jev_requests} Jev requests`) : "",
  ];
  return bits.filter(Boolean).join(" · ");
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const scenario = String(a.scenario ?? "a1-compromised-thread");
  const arm = String(a.arm ?? "jev") as Arm;
  const provider = String(a.jev ?? "typesafe") as JevOpts["provider"];
  const dir = resolve(String(a.out ?? resolve(repoRoot(), "runs", "single", `${scenario}__${arm}__${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`)));
  if (existsSync(resolve(dir, "run.json"))) {
    console.error(`${dir} already exists; pick another --out`);
    process.exit(1);
  }
  mkdirSync(dir, { recursive: true });
  if (arm === "jev" && provider === "mock") console.log(c.yellow("Warning: --jev mock uses a keyword heuristic, not Jev."));
  console.log(`${c.bold(scenario)} · arm ${c.bold(arm)} · agent ${a.model ?? "haiku"} · ${dir}\n`);
  const r = await runOne(
    dir,
    scenario,
    arm,
    { provider, model: a["jev-model"] as string | undefined },
    { model: String(a.model ?? "haiku"), permissionMode: String(a["permission-mode"] ?? "dontAsk"), budgetUsd: Number(a.budget ?? 3), timeoutMin: Number(a["timeout-min"] ?? 12), live: true },
  );
  console.log("\n" + describe(r));
  if (arm !== "none") {
    console.log("");
    printTimeline(dir);
  }
}

if (process.argv[1]?.endsWith("run.ts")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
