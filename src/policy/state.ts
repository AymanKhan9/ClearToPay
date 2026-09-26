// Per-run guard state kept next to the run (<run>/.cleartopay/), plus the
// flight recorder: one JSON line per guarded decision, with the full Jev
// distributions, so thresholds can be replayed and the demo can show exactly
// which probabilities changed the agent's course.

import { appendFileSync, existsSync, mkdirSync, readFileSync, openSync, closeSync, unlinkSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { writeJsonAtomic } from "../shared/world";
import { guardDir } from "./config";
import type { JevCall } from "./jev";

export interface Taint {
  key: string; // party:V-ACME | account:4611... | domain:x | email:E-201 | thread:T-...
  reason: string;
  at: string;
  verdict_seq: number;
  evidence_latest?: string; // newest email that caused the flag; a verified callback after this clears a party flag
}

export interface GuardState {
  taints: Taint[];
  stop_denials: number;
  verdict_seq: number;
  jev_cache: Record<string, JevCall>;
}

const EMPTY: GuardState = { taints: [], stop_denials: 0, verdict_seq: 0, jev_cache: {} };

function statePath(cwd: string): string {
  return resolve(guardDir(cwd), "guard-state.json");
}

export function readState(cwd: string): GuardState {
  const p = statePath(cwd);
  if (!existsSync(p)) return structuredClone(EMPTY);
  try {
    return { ...structuredClone(EMPTY), ...(JSON.parse(readFileSync(p, "utf8")) as GuardState) };
  } catch {
    return structuredClone(EMPTY);
  }
}

/**
 * Serialize a short read-modify-write across concurrent hook processes.
 * Never hold this across a network call: Failproof gives a policy 10 s and
 * treats a timeout as allow, so a long lock wait would fail open.
 */
export async function withState<T>(cwd: string, fn: (s: GuardState) => Promise<T> | T): Promise<T> {
  mkdirSync(guardDir(cwd), { recursive: true });
  const lock = resolve(guardDir(cwd), "state.lock");
  const start = Date.now();
  let fd: number | null = null;
  while (fd === null) {
    try {
      fd = openSync(lock, "wx");
    } catch {
      // Break a stale lock left by a killed hook process.
      try {
        if (Date.now() - statSync(lock).mtimeMs > 15_000) unlinkSync(lock);
      } catch {
        /* raced */
      }
      if (Date.now() - start > 2_000) throw new Error("guard state lock timeout");
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  try {
    const s = readState(cwd);
    const out = await fn(s);
    writeJsonAtomic(statePath(cwd), s);
    return out;
  } finally {
    closeSync(fd);
    try {
      unlinkSync(lock);
    } catch {
      /* already gone */
    }
  }
}

export function isTainted(s: GuardState, keys: string[]): Taint | undefined {
  return s.taints.find((t) => keys.includes(t.key));
}

export function addTaints(s: GuardState, keys: string[], reason: string, at: string, evidenceLatest?: string): void {
  for (const key of keys) {
    if (!s.taints.some((t) => t.key === key)) s.taints.push({ key, reason, at, verdict_seq: s.verdict_seq, evidence_latest: evidenceLatest });
  }
}

// ── Operator intent (trusted channel) ──

export interface OperatorPrompt {
  at: string;
  source: "runner" | "UserPromptSubmit";
  text: string;
}

export function readOperatorPrompts(cwd: string): OperatorPrompt[] {
  const p = resolve(guardDir(cwd), "operator.json");
  if (!existsSync(p)) return [];
  try {
    return (JSON.parse(readFileSync(p, "utf8")) as { prompts: OperatorPrompt[] }).prompts ?? [];
  } catch {
    return [];
  }
}

export function appendOperatorPrompt(cwd: string, prompt: OperatorPrompt): void {
  mkdirSync(guardDir(cwd), { recursive: true });
  const prompts = readOperatorPrompts(cwd);
  // Keep the last five distinct prompts.
  if (!prompts.some((x) => x.text === prompt.text)) prompts.push(prompt);
  writeJsonAtomic(resolve(guardDir(cwd), "operator.json"), { prompts: prompts.slice(-5) });
}

// ── Flight recorder ──

export interface VerdictRow {
  seq: number;
  at: string;
  arm: string;
  event: string;
  tool: string;
  args: Record<string, unknown>;
  tier: "floor" | "jev" | "taint" | "code" | "fail-closed" | "gate";
  level: "green" | "amber" | "red" | "grey" | "floor-deny" | "error";
  decision: "allow" | "deny" | "instruct";
  summary: string;
  message?: string;
  floor?: { rule: string; detail: string };
  facts?: Record<string, unknown>;
  jev?: { purpose: string; call: JevCall }[];
  taints_added?: string[];
  error?: string;
}

export function recordVerdict(cwd: string, row: VerdictRow): void {
  mkdirSync(guardDir(cwd), { recursive: true });
  appendFileSync(resolve(guardDir(cwd), "verdicts.jsonl"), JSON.stringify(row) + "\n");
}

export function readVerdicts(cwd: string): VerdictRow[] {
  const p = resolve(guardDir(cwd), "verdicts.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as VerdictRow);
}
