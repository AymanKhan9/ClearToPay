// Deterministic simulator: runs the scripted worst-case agent (naive-plans.ts)
// through the real MCP server and the real Failproof hook binary, then grades.
// No LLM involved, so it is fast, free and repeatable — use it to check the
// guard and tune thresholds before spending on real agent runs.
//
//   npm run simulate -- --jev mock                      # offline plumbing check (mock is NOT Jev)
//   npm run simulate -- --jev typesafe                  # real Jev verdicts, scripted agent
//   npm run simulate -- --arms floor,jev --scenarios a1-compromised-thread --via direct

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { listScenarioIds, repoRoot } from "../shared/world";
import type { Arm } from "../shared/types";
import { createRunDir, failproofBin, type JevOpts } from "./workspace";
import { NAIVE_PLANS, type PlanStep } from "./naive-plans";
import { parseSteering, invoicesIn } from "./steering";
import { gradeRun, type RunResult } from "../grader/grade";
import { writeReport } from "./report";
import { args as parseArgs, c } from "./util";

type Via = "failproof" | "direct";

interface HookOutcome {
  decision: "allow" | "deny";
  reason?: string;
}

async function hookViaFailproof(event: string, payload: Record<string, unknown>, cwd: string): Promise<HookOutcome> {
  const bin = failproofBin();
  return new Promise((resolveP) => {
    const child = spawn(bin, ["--hook", event], {
      cwd,
      env: { ...process.env, FAILPROOFAI_NO_FIRST_RUN: "1", FAILPROOFAI_TELEMETRY_DISABLED: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      let reason: string | undefined;
      let deny = code === 2;
      if (code === 2) reason = err.trim();
      try {
        const j = out.trim() ? JSON.parse(out.trim()) : {};
        const hso = j.hookSpecificOutput ?? {};
        if (hso.permissionDecision === "deny") {
          deny = true;
          reason = hso.permissionDecisionReason;
        }
        if (j.decision === "block") {
          deny = true;
          reason = j.reason;
        }
      } catch {
        /* non-JSON stdout means allow */
      }
      resolveP(deny ? { decision: "deny", reason } : { decision: "allow" });
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function hookDirect(event: string, payload: Record<string, unknown>, cwd: string): Promise<HookOutcome> {
  const h = await import("../policy/handlers");
  const ctx = { toolName: payload.tool_name as string | undefined, toolInput: payload.tool_input as Record<string, unknown> | undefined, payload, session: { cwd } };
  const r = event === "PreToolUse" ? await h.onPreToolUse(ctx) : event === "Stop" ? await h.onStop(ctx) : event === "UserPromptSubmit" ? await h.onPrompt(ctx) : { decision: "allow" as const };
  return r.decision === "deny" ? { decision: "deny", reason: r.reason } : { decision: "allow" };
}

export async function simulateOne(dir: string, scenarioId: string, arm: Arm, jev: JevOpts, via: Via, verbose: boolean): Promise<RunResult> {
  const { task } = createRunDir({ dir, scenarioId, arm, jev });
  const sessionId = `sim-${scenarioId}-${arm}-${Date.now()}`;
  const transcript = resolve(dir, "sim-transcript.jsonl");
  writeFileSync(transcript, "");
  const logPath = resolve(dir, "sim-log.jsonl");
  const log = (o: object) => appendFileSync(logPath, JSON.stringify(o) + "\n");
  const guarded = arm !== "none";
  const hook = (event: string, extra: Record<string, unknown>) =>
    guarded
      ? (via === "failproof" ? hookViaFailproof : hookDirect)(event, { session_id: sessionId, transcript_path: transcript, cwd: dir, permission_mode: "default", hook_event_name: event, ...extra }, dir)
      : Promise.resolve<HookOutcome>({ decision: "allow" });

  const client = new Client({ name: "cleartopay-sim", version: "0.1.0" });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [resolve(repoRoot(), "dist", "ap-server.mjs")], env: { ...(process.env as Record<string, string>), CLEARTOPAY_WORLD: resolve(dir, "world.json") } }),
  );

  const ok = new Set<string>();
  const say = (s: string) => verbose && console.log(s);

  async function call(tool: string, args: Record<string, unknown>, depth: number, stepId?: string): Promise<boolean> {
    const pre = await hook("PreToolUse", { tool_name: `mcp__ap__${tool}`, tool_input: args });
    if (pre.decision === "deny") {
      log({ step: stepId, tool, args, hook: "deny", reason: pre.reason });
      say(`   ${c.red("✗ denied")} ${tool} ${c.dim(JSON.stringify(args).slice(0, 90))}`);
      if (depth === 0 && pre.reason) {
        for (const s of parseSteering(pre.reason)) {
          say(`     ${c.cyan("↳ steered")} ${s.tool}(${Object.entries(s.args).map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 40)}`).join(", ")})`);
          await call(s.tool, s.args, depth + 1, `${stepId}:steer`);
        }
      }
      return false;
    }
    const res = (await client.callTool({ name: tool, arguments: args })) as { isError?: boolean; content?: { text?: string }[] };
    const text = res.content?.[0]?.text ?? "";
    log({ step: stepId, tool, args, hook: "allow", ok: !res.isError, result: text.slice(0, 300) });
    if (!["list_inbox", "list_open_invoices", "read_email"].includes(tool)) say(`   ${res.isError ? c.yellow("! error ") : c.green("✓")} ${tool} ${c.dim(text.slice(0, 100))}`);
    await hook("PostToolUse", { tool_name: `mcp__ap__${tool}`, tool_input: args, tool_response: text });
    return !res.isError;
  }

  await hook("SessionStart", { source: "startup" });
  await hook("UserPromptSubmit", { prompt: task });
  const plan: PlanStep[] = NAIVE_PLANS[scenarioId] ?? [];
  for (const step of plan) {
    if (step.unless_ok && ok.has(step.unless_ok)) continue;
    if (await call(step.tool, step.args, 0, step.id)) ok.add(step.id);
  }

  // Finish; a cooperative agent does what the finish gate asks, up to 3 times.
  for (let attempt = 0; attempt < 3; attempt++) {
    const stop = await hook("Stop", { stop_hook_active: attempt > 0 });
    if (stop.decision === "allow") break;
    say(`   ${c.yellow("⟲ finish gate")} ${c.dim((stop.reason ?? "").split("\n")[1] ?? "")}`);
    log({ step: "stop", hook: "deny", reason: stop.reason });
    const reason = stop.reason ?? "";
    for (const inv of invoicesIn(reason.split("\n").find((l) => /neither paid nor held/.test(l)) ?? "")) await call("schedule_payment", { invoice_id: inv }, 0, "gate-pay");
    for (const s of parseSteering(reason)) await call(s.tool, s.args, 1, "gate-steer");
    if (/escalate_to_controller with the details/.test(reason)) {
      await call("escalate_to_controller", { subject: "Suspected payment fraud stopped during AP run", details: "The payment guard stopped a suspected payment-redirect request; see the guard log.", related_ids: [] }, 1, "gate-escalate");
    }
  }
  await hook("SessionEnd", { reason: "exit" });
  await client.close();
  return gradeRun(dir);
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const arms = String(a.arms ?? "none,floor,strict,jev").split(",") as Arm[];
  const scenarios = !a.scenarios || a.scenarios === "all" ? listScenarioIds() : String(a.scenarios).split(",");
  const provider = String(a.jev ?? "mock") as JevOpts["provider"];
  const via = String(a.via ?? "failproof") as Via;
  const out = resolve(String(a.out ?? resolve(repoRoot(), "runs", `sim-${provider}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`)));
  mkdirSync(out, { recursive: true });
  if (provider === "mock") console.log(c.yellow("Using the MOCK heuristic in place of Jev — plumbing test only, not a measurement."));

  const results: RunResult[] = [];
  for (const s of scenarios) {
    for (const arm of arms) {
      const dir = resolve(out, `${s}__${arm}__1`);
      console.log(`${c.bold(s)} ${c.dim("·")} ${arm}`);
      const r = await simulateOne(dir, s, arm, { provider, model: a.model as string | undefined }, via, !a.quiet);
      results.push(r);
      console.log(`   → ${r.pass ? c.green("PASS") : c.red("FAIL")} ${r.outcome}${r.exposed ? c.red(`  exposed ₹${r.exposed.toLocaleString("en-IN")}`) : ""}`);
    }
  }
  const md = writeReport(out, results, { title: `Simulated worst-case agent (${provider === "mock" ? "MOCK heuristic, not Jev" : `Jev via ${provider}`})` });
  console.log("\n" + md);
}

if (process.argv[1]?.endsWith("simulate.ts")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
