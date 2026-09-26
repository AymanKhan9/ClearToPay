// Demo screen: the guard's decisions for one run, with Jev's probabilities as
// bars, followed by what actually happened in the ERP.
//
//   npm run show -- runs/single/<run-dir>

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { World } from "../shared/types";
import { loadScenario, readJson } from "../shared/world";
import { readVerdicts } from "../policy/state";
import { gradeRun } from "../grader/grade";
import { args, c, rupees } from "./util";

function bar(p: number, width = 20): string {
  const n = Math.round(p * width);
  const s = "█".repeat(n) + "░".repeat(width - n);
  return p >= 0.65 ? c.red(s) : p >= 0.35 ? c.yellow(s) : c.green(s);
}

const levelTag: Record<string, (s: string) => string> = {
  red: (s) => c.red(c.bold(s)),
  amber: c.yellow,
  grey: c.yellow,
  green: c.green,
  "floor-deny": (s) => c.magenta(c.bold(s)),
  error: c.red,
};

export function printTimeline(dir: string): void {
  const rows = readVerdicts(dir);
  console.log(c.bold("Guard decisions"));
  if (!rows.length) console.log(c.dim("  (none recorded — unguarded arm, or no guarded tool was called)"));
  for (const r of rows) {
    const tag = (levelTag[r.level] ?? ((s: string) => s))(`${r.decision.toUpperCase()} ${r.level}`);
    const argsShort = JSON.stringify(r.args).slice(0, 90);
    console.log(`${c.dim(String(r.seq).padStart(3))} ${r.event === "Stop" ? c.bold("finish") : c.bold(r.tool)} ${c.dim(argsShort)}`);
    console.log(`    ${tag} ${c.dim(`[${r.tier}]`)} ${r.summary}`);
    for (const j of r.jev ?? []) {
      console.log(`    ${c.cyan(`Jev ${j.purpose}`)} ${c.dim(`${j.call.model_reported} · ${j.call.cached ? "cached" : `${j.call.latency_ms} ms`} · ${j.call.input_tokens} tok`)}`);
      for (const [id, a] of Object.entries(j.call.answers)) {
        if (a.type === "noul") console.log(`      ${id.padEnd(26)} ${bar(a.noul)} ${a.noul.toFixed(2)}`);
        else if (a.type === "choice") console.log(`      ${id.padEnd(26)} ${c.bold(a.choice)} ${Object.entries(a.probabilities).map(([k, p]) => `${k} ${p.toFixed(2)}`).join(" · ")}`);
        else console.log(`      ${id.padEnd(26)} score ${a.score.toFixed(2)}`);
      }
    }
    if (r.floor) console.log(`    ${c.magenta("floor")} ${r.floor.rule}`);
    if (r.taints_added?.length) console.log(`    ${c.red("flagged")} ${r.taints_added.join(", ")}`);
  }

  const world = readJson<World>(resolve(dir, "world.json"));
  const res = gradeRun(dir);
  const run = readJson<{ scenario: string }>(resolve(dir, "run.json"));
  const attacker = new Set(loadScenario(run.scenario).expect.attacker_accounts);
  console.log("\n" + c.bold("What happened in the ERP"));
  for (const p of world.payments) {
    const bad = attacker.has(p.bank.account_number);
    console.log(`  ${p.kind.padEnd(14)} ${rupees(p.amount).padStart(12)} → ${p.payee_name} A/C ${p.bank.account_number} ${p.invoice_id ?? p.credit_id ?? ""}${bad ? c.red("  ← ATTACKER ACCOUNT") : ""}`);
  }
  for (const i of world.invoices.filter((x) => x.status === "held")) console.log(`  ${c.yellow("held")}           ${i.id} — ${i.hold_reason}`);
  for (const cb of world.callbacks.filter((x) => x.status === "requested")) console.log(`  ${c.cyan("callback")}       ${cb.id} ${cb.party_id} on ${cb.phone}`);
  for (const e of world.escalations) console.log(`  ${c.cyan("escalated")}      ${e.id} ${e.subject}`);
  for (const p of res.poisoned) console.log(`  ${c.red("POISONED")}       ${p.party_id} now pays A/C ${p.account}`);
  console.log(`\n${res.pass ? c.green("PASS") : c.red("FAIL")} · ${res.outcome} · sent to attacker ${rupees(res.attacker_paid)} · exposed ${rupees(res.exposed)} · legit paid ${res.legit.paid}/${res.legit.expected}`);
}

if (process.argv[1]?.endsWith("show.ts")) {
  const a = args(process.argv.slice(2));
  const dir = resolve(String(a._ ?? ""));
  if (!existsSync(resolve(dir, "run.json"))) {
    console.error("usage: npm run show -- <run-dir>");
    process.exit(1);
  }
  printTimeline(dir);
}
