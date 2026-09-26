// Minimal Jev (TypeSafe System One) client with contract validation.
//
// Providers:
//   typesafe   POST https://api.typesafe.ai/v1/systemone      (TYPESAFE_API_KEY)
//   openrouter POST https://openrouter.ai/api/v1/systemone     (OPENROUTER_API_KEY)
//   mock       local keyword heuristics, ONLY for offline plumbing tests
//
// A response that is missing an answer, has the wrong type, or carries a
// probability outside [0,1] is treated as a failure, never as a zero
// ("a missing part is not a zero").

import { createHash } from "node:crypto";
import type { Question, QuestionSet } from "./questions";
import { apiKeyFor } from "./config";
import { mockAnswers } from "./mockjev";

export interface NoulAnswer { type: "noul"; noul: number }
export interface ChoiceAnswer { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
export interface ScoreAnswer { type: "score"; score: number; probabilities: Record<string, number>; confidence: number; legend?: Record<string, string> }
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface JevCall {
  request_id: string;
  provider: string;
  model_requested: string;
  model_reported: string;
  latency_ms: number;
  input_tokens: number;
  cached: boolean;
  answers: Record<string, Answer>;
}

export interface JevSettings {
  provider: "typesafe" | "openrouter" | "mock";
  model: string;
  base_url?: string;
  timeout_ms: number;
}

export class JevError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
  }
}

const ENDPOINTS = {
  typesafe: "https://api.typesafe.ai/v1/systemone",
  openrouter: "https://openrouter.ai/api/v1/systemone",
};

export function requestDigest(state: unknown, questions: QuestionSet, model: string): string {
  return createHash("sha256").update(JSON.stringify({ state, questions, model })).digest("hex").slice(0, 16);
}

function validate(questions: QuestionSet, answers: unknown): Record<string, Answer> {
  if (!answers || typeof answers !== "object") throw new JevError("response has no answers", "contract");
  const out: Record<string, Answer> = {};
  for (const [id, q] of Object.entries(questions)) {
    const a = (answers as Record<string, Answer>)[id];
    if (!a || a.type !== q.type) throw new JevError(`missing or mistyped answer for ${id}`, "contract");
    if (a.type === "noul") {
      if (typeof a.noul !== "number" || a.noul < 0 || a.noul > 1) throw new JevError(`bad noul for ${id}`, "contract");
    } else if (a.type === "choice") {
      const opts = Object.keys((q as Extract<Question, { type: "choice" }>).criteria);
      if (!opts.includes(a.choice)) throw new JevError(`choice for ${id} not in options`, "contract");
      const sum = Object.values(a.probabilities ?? {}).reduce((s, p) => s + p, 0);
      if (Math.abs(sum - 1) > 0.02) throw new JevError(`choice probabilities for ${id} sum to ${sum}`, "contract");
    } else if (a.type === "score") {
      if (typeof a.score !== "number") throw new JevError(`bad score for ${id}`, "contract");
    }
    out[id] = a;
  }
  return out;
}

async function postOnce(url: string, key: string, body: unknown, signal: AbortSignal): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

export async function askJev(settings: JevSettings, state: unknown, questions: QuestionSet): Promise<JevCall> {
  const request_id = requestDigest(state, questions, settings.model);
  const started = Date.now();

  if (settings.provider === "mock") {
    const answers = validate(questions, mockAnswers(state, questions));
    return {
      request_id,
      provider: "mock",
      model_requested: settings.model,
      model_reported: "mock-heuristic (NOT Jev)",
      latency_ms: Date.now() - started,
      input_tokens: Math.ceil(JSON.stringify({ state, questions }).length / 4),
      cached: false,
      answers,
    };
  }

  const key = apiKeyFor(settings.provider);
  if (!key) throw new JevError(`no API key for ${settings.provider}`, "no-key");
  const url = settings.base_url ?? ENDPOINTS[settings.provider];
  const body = { state, model: settings.model, questions };

  const deadline = started + settings.timeout_ms;
  let lastErr: JevError | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining < 250) break;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), remaining);
    try {
      const res = await postOnce(url, key, body, ctl.signal);
      clearTimeout(timer);
      if (res.status === 429 || res.status === 529 || res.status >= 500) {
        lastErr = new JevError(`HTTP ${res.status}`, `http-${res.status}`);
        await new Promise((r) => setTimeout(r, 250));
        continue;
      }
      if (!res.ok) {
        const text = (await res.text()).slice(0, 200).replace(/[\x00-\x1f\x7f]/g, " ");
        throw new JevError(`HTTP ${res.status}: ${text}`, `http-${res.status}`);
      }
      const json = (await res.json()) as { model?: string; answers?: unknown; usage?: { input_tokens?: number } };
      return {
        request_id,
        provider: settings.provider,
        model_requested: settings.model,
        model_reported: json.model ?? "unreported",
        latency_ms: Date.now() - started,
        input_tokens: json.usage?.input_tokens ?? 0,
        cached: false,
        answers: validate(questions, json.answers),
      };
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof JevError) throw e;
      lastErr = new JevError(ctl.signal.aborted ? "timeout" : String((e as Error).message ?? e), ctl.signal.aborted ? "timeout" : "network");
    }
  }
  throw lastErr ?? new JevError("timeout", "timeout");
}

export function noul(call: JevCall | undefined, id: string): number | undefined {
  const a = call?.answers[id];
  return a && a.type === "noul" ? a.noul : undefined;
}

export function choice(call: JevCall | undefined, id: string): ChoiceAnswer | undefined {
  const a = call?.answers[id];
  return a && a.type === "choice" ? a : undefined;
}
