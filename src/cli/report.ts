// Aggregates graded runs into report.md + report.json.
//
//   npm run report -- runs/<batch>

import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gradeRun, type RunResult } from "../grader/grade";
import { readVerdicts } from "../policy/state";
import { args, pct, quantile, rupees } from "./util";

const JEV_USD_PER_M_INPUT = 0.042; // TypeSafe list price for jev-1.13, input tokens; output tokens are free

interface ArmSummary {
  arm: string;
  runs: number;
  pass: number;
  attack_runs: number;
  attacks_stopped: number; // exposed == 0
  attacks_passed: number; // stopped + legit work done + protective action
  attacker_paid: number;
  exposed: number;
  benign_runs: number;
  benign_passed: number;
  false_blocks: number;
  legit_paid: number;
  legit_expected: number;
  jev_requests: number;
  jev_p50: number;
  jev_p95: number;
  jev_tokens: number;
  jev_cost_usd: number;
  agent_cost_usd: number;
}

export function summarize(results: RunResult[]): { arms: ArmSummary[]; byScenario: Record<string, Record<string, { runs: number; pass: number; outcomes: string[] }>> } {
  const arms = [...new Set(results.map((r) => r.arm))];
  const order = ["none", "floor", "strict", "jev"];
  arms.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const out: ArmSummary[] = arms.map((arm) => {
    const rs = results.filter((r) => r.arm === arm);
    const att = rs.filter((r) => r.kind === "attack");
    const ben = rs.filter((r) => r.kind === "benign");
    const lat = rs.flatMap((r) => r.guard.jev_latency_ms);
    const tokens = rs.reduce((s, r) => s + r.guard.jev_input_tokens, 0);
    return {
      arm,
      runs: rs.length,
      pass: rs.filter((r) => r.pass).length,
      attack_runs: att.length,
      attacks_stopped: att.filter((r) => r.exposed === 0).length,
      attacks_passed: att.filter((r) => r.pass).length,
      attacker_paid: att.reduce((s, r) => s + r.attacker_paid, 0),
      exposed: att.reduce((s, r) => s + r.exposed, 0),
      benign_runs: ben.length,
      benign_passed: ben.filter((r) => r.pass).length,
      false_blocks: ben.reduce((s, r) => s + r.false_blocks, 0),
      legit_paid: rs.reduce((s, r) => s + r.legit.paid, 0),
      legit_expected: rs.reduce((s, r) => s + r.legit.expected, 0),
      jev_requests: rs.reduce((s, r) => s + r.guard.jev_requests, 0),
      jev_p50: quantile(lat, 0.5),
      jev_p95: quantile(lat, 0.95),
      jev_tokens: tokens,
      jev_cost_usd: (tokens / 1e6) * JEV_USD_PER_M_INPUT,
      agent_cost_usd: rs.reduce((s, r) => s + (r.agent.cost_usd ?? 0), 0),
    };
  });
  const byScenario: Record<string, Record<string, { runs: number; pass: number; outcomes: string[] }>> = {};
  for (const r of results) {
    byScenario[r.scenario] ??= {};
    const cell = (byScenario[r.scenario][r.arm] ??= { runs: 0, pass: 0, outcomes: [] });
    cell.runs++;
    if (r.pass) cell.pass++;
    cell.outcomes.push(r.outcome);
  }
  return { arms: out, byScenario };
}

function savesSection(results: RunResult[]): string[] {
  const lines: string[] = [];
  for (const r of results.filter((x) => x.arm === "jev")) {
    const red = readVerdicts(r.run_dir).find((v) => v.decision === "deny" && (v.level === "red" || v.tier === "jev"));
    if (!red) continue;
    const ev = red.jev?.find((j) => j.purpose === "evidence")?.call;
    const probs = ev
      ? Object.entries(ev.answers)
          .map(([k, a]) => (a.type === "noul" ? `${k} ${a.noul.toFixed(2)}` : a.type === "choice" ? `${k}=${a.choice} ${a.probabilities[a.choice].toFixed(2)}` : `${k} ${a.score.toFixed(2)}`))
          .join(", ")
      : "";
    lines.push(`- **${r.scenario}** — \`${red.tool}\` → **${red.level.toUpperCase()} deny** (${red.summary}). ${probs ? `Jev: ${probs}.` : ""} Outcome: ${r.outcome}.`);
  }
  return lines;
}

export function writeReport(dir: string, results: RunResult[], opts: { title?: string } = {}): string {
  const { arms, byScenario } = summarize(results);
  const armNames = arms.map((a) => a.arm);
  const k = Math.max(...Object.values(byScenario).flatMap((x) => Object.values(x).map((c) => c.runs)), 1);
  const L: string[] = [];
  L.push(`# ClearToPay results — ${opts.title ?? "agent runs"}`, "");
  L.push(`${results.length} runs · ${Object.keys(byScenario).length} scenarios · arms: ${armNames.join(", ")} · up to k=${k} runs per cell`, "");
  L.push("## By arm", "");
  L.push("| arm | attacks stopped | attacks fully handled | ₹ sent to attacker | ₹ exposed (sent + poisoned records) | benign runs with no false block | legit invoices paid | pass rate | Jev requests | Jev p50 / p95 | Jev cost |");
  L.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const a of arms) {
    L.push(
      `| ${a.arm} | ${a.attacks_stopped}/${a.attack_runs} | ${a.attacks_passed}/${a.attack_runs} | ${rupees(a.attacker_paid)} | ${rupees(a.exposed)} | ${a.benign_passed}/${a.benign_runs} | ${a.legit_paid}/${a.legit_expected} (${pct(a.legit_paid, a.legit_expected)}) | ${pct(a.pass, a.runs)} | ${a.jev_requests} | ${a.jev_requests ? `${a.jev_p50} / ${a.jev_p95} ms` : "–"} | ${a.jev_requests ? `$${a.jev_cost_usd.toFixed(5)}` : "–"} |`,
    );
  }
  L.push("");
  L.push(`## pass^k by scenario (a cell passes only if every one of its runs passed)`, "");
  L.push(`| scenario | ${armNames.join(" | ")} |`);
  L.push(`|---|${armNames.map(() => "---").join("|")}|`);
  for (const [s, cells] of Object.entries(byScenario).sort()) {
    L.push(`| ${s} | ${armNames.map((a) => (cells[a] ? `${cells[a].pass === cells[a].runs ? "✅" : "❌"} ${cells[a].pass}/${cells[a].runs}` : "–")).join(" | ")} |`);
  }
  L.push("");
  L.push("## Outcomes", "");
  for (const [s, cells] of Object.entries(byScenario).sort()) {
    L.push(`- **${s}**: ${armNames.map((a) => (cells[a] ? `${a} → ${[...new Set(cells[a].outcomes)].join("; ")}` : "")).filter(Boolean).join(" · ")}`);
  }
  const saves = savesSection(results);
  if (saves.length) {
    L.push("", "## Where the Jev arm changed the outcome (first Jev deny per run)", "", ...saves);
  }
  const agentCost = arms.reduce((s, a) => s + a.agent_cost_usd, 0);
  if (agentCost) L.push("", `Agent (Claude) spend across all runs: $${agentCost.toFixed(2)}.`);
  const md = L.join("\n") + "\n";
  writeFileSync(resolve(dir, "report.md"), md);
  writeFileSync(resolve(dir, "report.json"), JSON.stringify({ arms, byScenario, results }, null, 2));
  return md;
}

function main() {
  const a = args(process.argv.slice(2));
  const dir = resolve(String(a._ ?? a.dir ?? ""));
  if (!dir || !existsSync(dir)) {
    console.error("usage: npm run report -- runs/<batch>");
    process.exit(1);
  }
  const runs = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(resolve(dir, d.name, "run.json")))
    .map((d) => resolve(dir, d.name));
  const results = runs.map((r) => gradeRun(r));
  console.log(writeReport(dir, results));
}

if (process.argv[1]?.endsWith("report.ts")) main();
