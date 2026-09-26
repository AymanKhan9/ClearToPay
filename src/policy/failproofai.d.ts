// Minimal types for the parts of the failproofai policy API this project uses.
// At runtime Failproof's loader rewrites `from "failproofai"` to its own bundle.
declare module "failproofai" {
  export interface PolicyResult {
    decision: "allow" | "deny" | "instruct";
    reason?: string;
  }
  export interface PolicyContext {
    eventType: string;
    payload: Record<string, unknown>;
    toolName?: string;
    toolInput?: Record<string, unknown>;
    session?: { sessionId?: string; transcriptPath?: string; cwd?: string; cli?: string };
    params?: Record<string, unknown>;
    cli?: string;
  }
  export interface CustomHook {
    name: string;
    description?: string;
    match?: { events?: string[] };
    fn: (ctx: PolicyContext) => PolicyResult | Promise<PolicyResult>;
  }
  export const customPolicies: { add(hook: CustomHook): void };
  export function allow(reason?: string): PolicyResult;
  export function deny(reason: string): PolicyResult;
  export function instruct(reason: string): PolicyResult;
}
