import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Email, Party, Scenario, World } from "./types";

/** Repo root, resolved from this file whether run via tsx or bundled into dist/. */
export function repoRoot(): string {
  if (process.env.CLEARTOPAY_ROOT) return process.env.CLEARTOPAY_ROOT;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(resolve(dir, "data", "world.base.json"))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** Atomic write so a reader (the policy, the grader) never sees a torn file. */
export function writeJsonAtomic(path: string, data: unknown): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

export function loadWorld(path: string): World {
  return readJson<World>(path);
}

export function saveWorld(path: string, world: World): void {
  writeJsonAtomic(path, world);
}

export function listScenarioIds(root = repoRoot()): string[] {
  return readdirSync(resolve(root, "data", "scenarios"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

export function loadScenario(id: string, root = repoRoot()): Scenario {
  return readJson<Scenario>(resolve(root, "data", "scenarios", `${id}.json`));
}

export function buildWorld(scenario: Scenario, root = repoRoot()): World {
  const world = readJson<World>(resolve(root, "data", "world.base.json"));
  const p = scenario.patch;

  if (p.parties) {
    for (const patch of p.parties) {
      const idx = world.parties.findIndex((x) => x.id === patch.id);
      if (idx >= 0) world.parties[idx] = { ...world.parties[idx], ...patch } as Party;
      else world.parties.push(patch as Party);
    }
  }
  if (p.remove_emails) world.inbox = world.inbox.filter((e) => !p.remove_emails!.includes(e.id));
  if (p.replace_emails) {
    for (const e of p.replace_emails) {
      const idx = world.inbox.findIndex((x) => x.id === e.id);
      if (idx >= 0) world.inbox[idx] = e;
      else world.inbox.push(e);
    }
  }
  if (p.add_emails) world.inbox.push(...p.add_emails);
  if (p.callbacks) world.callbacks.push(...p.callbacks);
  if (p.credits) {
    for (const c of p.credits) {
      const idx = world.credits.findIndex((x) => x.id === c.id);
      if (idx >= 0) world.credits[idx] = c;
      else world.credits.push(c);
    }
  }
  world.inbox.sort((a: Email, b: Email) => a.date.localeCompare(b.date));
  return world;
}

export function party(world: World, id: string): Party | undefined {
  return world.parties.find((x) => x.id === id);
}

export function nowIso(world: World): string {
  // The world clock: scenario "today" plus real elapsed seconds since the run
  // started would complicate grading, so every action is stamped with the
  // scenario time plus a monotonically increasing number of seconds.
  const base = Date.parse(world.company.today);
  return new Date(base + world.ledger.length * 30_000).toISOString();
}
