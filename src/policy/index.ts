// Failproof AI policy entry. Bundled by scripts/build.mjs into
// dist/cleartopay-policies.mjs and dropped into each run's
// .failproofai/policies/ directory, where Failproof loads it automatically.
//
//   cleartopay-intent       UserPromptSubmit  records the operator's own words (trusted channel)
//   cleartopay-guard        PreToolUse        floor → taint → Jev → decision, on every mcp__ap__ tool
//   cleartopay-finish-gate  Stop              no finishing with due invoices unhandled or fraud unescalated

import { customPolicies, allow, deny, instruct, type PolicyResult } from "failproofai";
import { onPreToolUse, onPrompt, onStop, type HookResult } from "./handlers";

const toFailproof = (r: HookResult): PolicyResult =>
  r.decision === "deny" ? deny(r.reason ?? "Blocked by ClearToPay.") : r.decision === "instruct" && r.reason ? instruct(r.reason) : allow();

customPolicies.add({
  name: "cleartopay-intent",
  description: "Record the operator's own prompt as the trusted instruction channel for Jev",
  match: { events: ["UserPromptSubmit"] },
  fn: async (ctx) => toFailproof(await onPrompt(ctx)),
});

customPolicies.add({
  name: "cleartopay-guard",
  description: "Accounts-payable money guard: code floor, then Jev verdicts on the related correspondence",
  match: { events: ["PreToolUse"] },
  fn: async (ctx) => toFailproof(await onPreToolUse(ctx)),
});

customPolicies.add({
  name: "cleartopay-finish-gate",
  description: "Don't let the agent finish with due invoices unhandled, or with a fraud verdict not escalated",
  match: { events: ["Stop"] },
  fn: async (ctx) => toFailproof(await onStop(ctx)),
});
