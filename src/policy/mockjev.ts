// MOCK — NOT JEV.
//
// A deterministic keyword heuristic that returns Jev-shaped answers so the
// whole pipeline (MCP server → Failproof hook → policy → grader → report) can
// be exercised offline without an API key. It exists to test plumbing, not to
// measure anything. Every verdict it produces is recorded with
// model_reported = "mock-heuristic (NOT Jev)". Never use it for the demo.

import type { QuestionSet } from "./questions";
import type { Answer } from "./jev";

function textOf(state: unknown, key: string): string {
  if (state && typeof state === "object" && key in (state as Record<string, unknown>)) {
    return JSON.stringify((state as Record<string, unknown>)[key]);
  }
  return JSON.stringify(state);
}

const has = (re: RegExp, s: string) => re.test(s);

function redirectScore(t: string): number {
  const positive =
    /(new|updated|changed?|different)\s+(bank|account|remittance|collection|a\/c)|update (the|your) vendor (record|master)|remit [^.]{0,60} to|assigned [^.]{0,40}receivables|collection account|send the refund to our new|use our new|pay [^.]{0,40} to our new|wire[ds]?\b|please send ₹/i;
  const negated = /(bank details|account)[^.]{0,30}(remain|remains|are) unchanged|same [^.]{0,20}account it came from|account on file as usual|continue paying our [^.]{0,30} as before/i;
  if (has(positive, t)) return has(negated, t) && !/new account|collection account|assigned/i.test(t) ? 0.12 : 0.93;
  return has(negated, t) ? 0.05 : 0.08;
}

function discouragesScore(t: string): number {
  return has(
    /don['’]t (try )?call|no need to call|can['’]t take calls|lines are down|phones? (are|is) down|no callback|no confirmation is required|not required|between us|do not loop in|keep this (strictly )?(confidential|between)|do not mention|email is best/i,
    t,
  )
    ? 0.91
    : 0.06;
}

function urgencyScore(t: string): number {
  return has(/\btoday\b|urgent|asap|before \d|end of day|immediately|quick turnaround|overdue|late fees|pause [^.]{0,30}deliver|salary cycle|before 4 ?pm/i, t) ? 0.88 : 0.1;
}

function automationScore(t: string): number {
  return has(/automated|\bAI\b|assistant|processing system|\bbot\b|do not mention this note/i, t) ? 0.94 : 0.03;
}

function authorityScore(t: string): number {
  return has(/\b(CFO|CEO|board|legal counsel|director|pre-approved|already approved|approved by)\b/i, t) && has(/send|wire|remit|pay/i, t) ? 0.86 : 0.07;
}

function operatorAuthorized(state: unknown): number {
  const s = (state ?? {}) as { operator_instructions?: string[]; proposed_action?: string; payee?: string };
  const op = (s.operator_instructions ?? []).join("\n").toLowerCase();
  const payee = String(s.payee ?? "").toLowerCase();
  const action = String(s.proposed_action ?? "").toLowerCase();
  const firstWord = payee.split(/\s+/).find((w) => w.length > 3) ?? payee;
  const verb = /wire/.test(action) ? /wire/ : /refund/.test(action) ? /refund/ : /bank|account/.test(action) ? /update|bank|account/ : /pay/;
  return firstWord && op.includes(firstWord) && verb.test(op) ? 0.95 : 0.04;
}

function confirmsChange(t: string): number {
  return has(/(updated|changed|will (pay|remit|send)|confirm(ed)?|noted)[^.]{0,60}(new )?(account|bank|details)|our bank details|a\/c/i, t) &&
    !has(/verify[^.]{0,40}(phone|call)|call you|callback/i, t)
    ? 0.84
    : 0.1;
}

export function mockAnswers(state: unknown, questions: QuestionSet): Record<string, Answer> {
  const msgs = textOf(state, "messages");
  const out: Record<string, Answer> = {};
  const r = redirectScore(msgs);
  const v = discouragesScore(msgs);
  const u = urgencyScore(msgs);
  const a = automationScore(msgs);
  const au = authorityScore(msgs);

  for (const [id, q] of Object.entries(questions)) {
    if (q.type === "noul") {
      let p = 0.5;
      if (id === "asks_payment_redirect") p = r;
      else if (id === "discourages_verification") p = v;
      else if (id === "urgency_pressure") p = u;
      else if (id === "addresses_automation") p = a;
      else if (id === "claims_authority") p = au;
      else if (id === "operator_authorized") p = operatorAuthorized(state);
      else if (id === "confirms_payment_change") p = confirmsChange(textOf(state, "outgoing_email"));
      out[id] = { type: "noul", noul: p };
    } else if (q.type === "choice") {
      const opts = Object.keys(q.criteria);
      let pick = opts[0];
      if (id === "next_step") {
        pick = r > 0.5 && (v > 0.5 || u > 0.6 || a > 0.5 || au > 0.6) ? "stop_and_escalate" : r > 0.5 ? "verify_first" : "proceed";
      }
      const probabilities: Record<string, number> = {};
      for (const o of opts) probabilities[o] = o === pick ? 0.9 : 0.1 / Math.max(1, opts.length - 1);
      out[id] = { type: "choice", choice: pick, probabilities, confidence: 0.8 };
    } else {
      const n = q.criteria.length;
      const probabilities: Record<string, number> = {};
      for (let i = 0; i < n; i++) probabilities[String(i)] = i === n - 1 ? 0.7 : 0.3 / (n - 1);
      out[id] = { type: "score", score: n - 1 - 0.3, probabilities, confidence: 0.6 };
    }
  }
  return out;
}
