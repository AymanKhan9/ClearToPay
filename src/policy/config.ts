import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { DEFAULT_THRESHOLDS, type RunConfig } from "../shared/types";

export function guardDir(cwd: string): string {
  return resolve(cwd, ".cleartopay");
}

/** Per-run config written by the runner into <run>/.cleartopay/config.json. */
export function loadRunConfig(cwd: string): RunConfig | null {
  const p = resolve(guardDir(cwd), "config.json");
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as RunConfig;
    return { ...raw, thresholds: { ...DEFAULT_THRESHOLDS, ...(raw.thresholds ?? {}) } };
  } catch {
    return null;
  }
}

/**
 * API keys come from the environment first, then from
 * ~/.cleartopay/credentials.json ({"typesafe_api_key": "...", "openrouter_api_key": "..."}).
 * The file fallback matters when Failproof evaluates policies in its
 * background daemon, which does not inherit the agent's environment.
 */
export function apiKeyFor(provider: "typesafe" | "openrouter"): string | undefined {
  const envName = provider === "typesafe" ? "TYPESAFE_API_KEY" : "OPENROUTER_API_KEY";
  if (process.env[envName]) return process.env[envName];
  const p = resolve(homedir(), ".cleartopay", "credentials.json");
  if (!existsSync(p)) return undefined;
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as Record<string, string>;
    return provider === "typesafe" ? j.typesafe_api_key : j.openrouter_api_key;
  } catch {
    return undefined;
  }
}
