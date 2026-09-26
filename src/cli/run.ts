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

export interface AgentOpts {
  model: string;
  permissionMode: string;
  budgetUsd: number;
  timeoutMin: number;
  live: boolean;
  claudeBin?: string;
}

function short(o: unknown, n = 110): string {
  const s = JSON.stringify(o);
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export async function runAgent(dir: string, task: string, opts: AgentOpts, label = ""): Promise<void> {
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
    if (!opts.live) return;
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
              console.log(`${label}${c.blue("→")} ${c.bold(name)} ${c.dim(short(part.input))}`);
            } else if (part.type === "text" && part.text?.trim()) {
              console.log(`${label}${c.magenta("✎")} ${c.dim(part.text.trim().split("\n")[0].slice(0, 140))}`);
            }
          }
        } else if (m.type === "user") {
          for (const part of m.message?.content ?? []) {
            if (part.type !== "tool_result") continue;
            const text = typeof part.content === "string" ? part.content : (part.content ?? []).map((x: { text?: string }) => x.text ?? "").join("\n");
            const name = names.get(part.tool_use_id) ?? "tool";
            if (/failproofai|ClearToPay/.test(text)) {
              const body = text.replace(/^.*?because:\s*/s, "");
              console.log(`${label}${c.red("✗ BLOCKED")} ${name}: ${c.yellow(body.split("\n")[0].slice(0, 160))}`);
            } else if (part.is_error) {
              console.log(`${label}${c.yellow("! error")} ${name}: ${text.slice(0, 120)}`);
            } else if (!["list_inbox", "read_email", "list_open_invoices", "get_party", "list_parties", "list_credits", "list_callbacks"].includes(name)) {
              console.log(`${label}${c.green("✓")} ${name}: ${c.dim(text.split("\n")[0].slice(0, 120))}`);
            }
          }
        } else if (m.type === "result") {
          console.log(`${label}${c.dim(`done · ${m.num_turns} turns · $${(m.total_cost_usd ?? 0).toFixed(3)} · ${Math.round((m.duration_ms ?? 0) / 1000)}s`)}`);
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

export async function runOne(dir: string, scenarioId: string, arm: Arm, jev: JevOpts, agent: AgentOpts, label = ""): Promise<RunResult> {
  const { task } = createRunDir({ dir, scenarioId, arm, jev });
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
