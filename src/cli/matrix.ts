// The reliability matrix: every scenario × arm × k real agent runs, graded,
// then aggregated into report.md (pass^k per scenario, ₹ exposed per arm).
// Re-running with the same --out resumes: finished runs are kept.
//
//   npm run matrix -- --arms none,floor,jev --k 3 --concurrency 4 --model haiku --jev typesafe

import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { listScenarioIds, repoRoot } from "../shared/world";
import type { Arm } from "../shared/types";
import { gradeRun, type RunResult } from "../grader/grade";
import { runOne, describe, type AgentOpts } from "./run";
import { writeReport } from "./report";
import { args as parseArgs, c } from "./util";
import type { JevOpts } from "./workspace";

async function pool<T>(items: T[], n: number, fn: (x: T, i: number) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, n) }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i], i);
      }
    }),
  );
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const arms = String(a.arms ?? "none,floor,jev").split(",") as Arm[];
  const scenarios = !a.scenarios || a.scenarios === "all" ? listScenarioIds() : String(a.scenarios).split(",");
  const k = Number(a.k ?? 3);
  const provider = String(a.jev ?? "typesafe") as JevOpts["provider"];
  const out = resolve(String(a.out ?? resolve(repoRoot(), "runs", `matrix-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`)));
  mkdirSync(out, { recursive: true });
  const agent: AgentOpts = {
    model: String(a.model ?? "haiku"),
    permissionMode: String(a["permission-mode"] ?? "dontAsk"),
    budgetUsd: Number(a.budget ?? 3),
    timeoutMin: Number(a["timeout-min"] ?? 12),
    live: !!a.live,
  };
  if (arms.includes("jev") && provider === "mock") console.log(c.yellow("Warning: --jev mock uses a keyword heuristic, not Jev. Don't report these numbers."));

  const jobs: { s: string; arm: Arm; i: number; dir: string }[] = [];
  for (let i = 1; i <= k; i++) for (const s of scenarios) for (const arm of arms) jobs.push({ s, arm, i, dir: resolve(out, `${s}__${arm}__${i}`) });
  console.log(`${jobs.length} runs → ${out}  (agent ${agent.model}, Jev via ${provider}, concurrency ${a.concurrency ?? 4})\n`);

  const results: RunResult[] = [];
  let done = 0;
  await pool(jobs, Number(a.concurrency ?? 4), async (j) => {
    let r: RunResult;
    if (existsSync(resolve(j.dir, "result.json")) && existsSync(resolve(j.dir, "transcript.jsonl"))) {
      r = gradeRun(j.dir);
    } else {
      const label = c.dim(`[${j.s} ${j.arm} #${j.i}] `);
      try {
        r = await runOne(j.dir, j.s, j.arm, { provider, model: a["jev-model"] as string | undefined }, agent, label);
      } catch (e) {
        console.error(`${label}${c.red(String((e as Error).message ?? e))}`);
        return;
      }
    }
    results.push(r);
    done++;
    console.log(`${c.dim(`${done}/${jobs.length}`)} ${j.s} ${c.bold(j.arm)} #${j.i}: ${describe(r)}`);
    writeReport(out, results, { title: `agent ${agent.model}, Jev via ${provider}` });
  });
  console.log("\n" + writeReport(out, results, { title: `agent ${agent.model}, Jev via ${provider}` }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
