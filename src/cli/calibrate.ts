// Measured calibration for the evidence questions ("questions get check-ups
// too"). Sends each labelled email in data/calibration/emails.jsonl with the
// exact runtime question bank, then reports per-question accuracy, Brier score,
// AUC and a suggested threshold. --write stores thresholds.json, which new
// runs pick up automatically.
//
//   npm run calibrate -- --jev typesafe
//   npm run calibrate -- --jev typesafe --write

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { repoRoot } from "../shared/world";
import { DEFAULT_THRESHOLDS, type Thresholds } from "../shared/types";
import { askJev, noul, choice, type JevCall } from "../policy/jev";
import { EVIDENCE_QUESTIONS } from "../policy/questions";
import { defaultModelFor, loadThresholds } from "./workspace";
import { args, c } from "./util";

interface Labelled {
  id: string;
  from: string;
  subject: string;
  body: string;
  labels: Record<string, 0 | 1>;
  next_step: string;
  note?: string;
}

const QUESTION_TO_THRESHOLD: Record<string, keyof Thresholds> = {
  asks_payment_redirect: "redirect",
  discourages_verification: "discourages_verification",
  urgency_pressure: "urgency",
  addresses_automation: "injection",
  claims_authority: "impersonation",
};

function auc(pos: number[], neg: number[]): number {
  if (!pos.length || !neg.length) return NaN;
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

async function main() {
  const a = args(process.argv.slice(2));
  const provider = String(a.jev ?? "typesafe") as "typesafe" | "openrouter" | "mock";
  const model = String(a["jev-model"] ?? a.model ?? defaultModelFor(provider));
  const dir = resolve(repoRoot(), "data", "calibration");
  const items = readFileSync(resolve(dir, "emails.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Labelled);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  mkdirSync(resolve(dir, "runs"), { recursive: true });
  const rawPath = resolve(dir, "runs", `${provider}-${stamp}.jsonl`);
  if (provider === "mock") console.log(c.yellow("MOCK heuristic, not Jev: this only tests the script."));

  const calls: { item: Labelled; call: JevCall }[] = [];
  const conc = Number(a.concurrency ?? 5);
  for (let i = 0; i < items.length; i += conc) {
    const batch = items.slice(i, i + conc);
    const res = await Promise.all(
      batch.map(async (item) => {
        const state = {
          proposed_action: "Handle this email as part of the weekly accounts-payable run.",
          messages: [{ id: item.id, from: item.from, subject: item.subject, body: item.body, attachments: [] }],
        };
        const call = await askJev({ provider, model, timeout_ms: 15000 }, state, EVIDENCE_QUESTIONS);
        appendFileSync(rawPath, JSON.stringify({ id: item.id, labels: item.labels, next_step: item.next_step, answers: call.answers, model: call.model_reported, latency_ms: call.latency_ms }) + "\n");
        return { item, call };
      }),
    );
    calls.push(...res);
    process.stdout.write(c.dim(`${calls.length}/${items.length} `));
  }
  console.log("\n");

  const current = loadThresholds();
  const suggested: Partial<Thresholds> = {};
  const L: string[] = [`# Calibration — ${provider} ${model} — ${stamp}`, "", `${items.length} labelled emails. Raw answers: \`${rawPath.replace(repoRoot() + "/", "")}\``, ""];
  L.push("| question | positives | AUC | Brier | acc @ current τ | τ current | τ suggested (max F1) | F1 @ suggested |", "|---|---|---|---|---|---|---|---|");
  const misses: string[] = [];
  for (const q of Object.keys(QUESTION_TO_THRESHOLD)) {
    const pts = calls.map(({ item, call }) => ({ y: item.labels[q] ?? 0, p: noul(call, q) ?? 0.5, id: item.id }));
    const pos = pts.filter((x) => x.y === 1).map((x) => x.p);
    const neg = pts.filter((x) => x.y === 0).map((x) => x.p);
    const brier = pts.reduce((s, x) => s + (x.p - x.y) ** 2, 0) / pts.length;
    const tKey = QUESTION_TO_THRESHOLD[q];
    const tCur = current[tKey] as number;
    const acc = pts.filter((x) => (x.p >= tCur ? 1 : 0) === x.y).length / pts.length;
    // Max F1 over a grid; among ties, the threshold closest to 0.5, clamped to
    // [0.3, 0.8] so a small labelled set can't push a gate to an extreme.
    const grid: { t: number; f1: number }[] = [];
    for (let t = 0.3; t <= 0.801; t += 0.05) {
      const tp = pts.filter((x) => x.p >= t && x.y === 1).length;
      const fp = pts.filter((x) => x.p >= t && x.y === 0).length;
      const fn = pts.filter((x) => x.p < t && x.y === 1).length;
      grid.push({ t: Math.round(t * 100) / 100, f1: tp ? (2 * tp) / (2 * tp + fp + fn) : 0 });
    }
    const maxF1 = Math.max(...grid.map((g) => g.f1));
    const best = grid.filter((g) => g.f1 >= maxF1 - 1e-9).sort((x, y) => Math.abs(x.t - 0.5) - Math.abs(y.t - 0.5))[0];
    (suggested as Record<string, number>)[tKey] = best.t;
    L.push(`| ${q} | ${pos.length}/${pts.length} | ${auc(pos, neg).toFixed(3)} | ${brier.toFixed(3)} | ${(acc * 100).toFixed(0)}% | ${tCur} | ${best.t} | ${best.f1.toFixed(2)} |`);
    for (const x of pts) if ((x.p >= tCur ? 1 : 0) !== x.y) misses.push(`- ${q} on **${x.id}**: label ${x.y}, p=${x.p.toFixed(2)} — ${items.find((i) => i.id === x.id)?.note || items.find((i) => i.id === x.id)?.subject}`);
  }
  const stepAcc = calls.filter(({ item, call }) => choice(call, "next_step")?.choice === item.next_step).length;
  L.push("", `next_step choice agrees with the label on ${stepAcc}/${calls.length}.`);
  const lat = calls.map((x) => x.call.latency_ms).sort((x, y) => x - y);
  L.push(`Latency p50 ${lat[Math.floor(lat.length / 2)]} ms, max ${lat[lat.length - 1]} ms.`);
  if (misses.length) L.push("", "## Disagreements at the current thresholds", "", ...misses);
  const md = L.join("\n") + "\n";
  writeFileSync(resolve(dir, `report-${provider}.md`), md);
  console.log(md);
  if (a.write) {
    const next = { ...DEFAULT_THRESHOLDS, ...current, ...suggested };
    writeFileSync(resolve(dir, "thresholds.json"), JSON.stringify(next, null, 2) + "\n");
    console.log(c.green(`Wrote data/calibration/thresholds.json`), next);
  } else {
    console.log(c.dim("Run with --write to store the suggested thresholds."));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
