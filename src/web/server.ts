// Local web console: type an operator task, pick arms, watch real agent runs
// side by side. Each arm is a real Claude Code run with the real guard.
//
//   npm run web                          # http://127.0.0.1:5173
//   npm run web -- --port 8080 --model haiku --jev typesafe

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { listScenarioIds, loadScenario, repoRoot } from "../shared/world";
import type { Arm } from "../shared/types";
import { ARMS, taskText, type JevOpts } from "../cli/workspace";
import { runOne, type AgentEvent } from "../cli/run";
import { readVerdicts } from "../policy/state";
import { args as parseArgs, c } from "../cli/util";

const a = parseArgs(process.argv.slice(2));
const port = Number(a.port ?? 5173);
const provider = String(a.jev ?? "typesafe") as JevOpts["provider"];
const model = String(a.model ?? "haiku");
const MAX_PROMPT = 4096;

// ponytail: one batch at a time; queue per user if this ever serves more than one person.
let busy = false;

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  let s = "";
  for await (const chunk of req) {
    s += chunk;
    if (s.length > MAX_PROMPT * 4) throw new Error("body too large");
  }
  return s;
}

async function startBatch(req: IncomingMessage, res: ServerResponse) {
  let body: { prompt?: unknown; scenario?: unknown; arms?: unknown };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { error: "invalid JSON" });
  }
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const scenario = String(body.scenario ?? "");
  const arms = Array.isArray(body.arms) ? [...new Set(body.arms.map(String))] : [];
  if (!prompt || prompt.length > MAX_PROMPT) return json(res, 400, { error: `prompt must be 1–${MAX_PROMPT} characters` });
  if (!listScenarioIds().includes(scenario)) return json(res, 400, { error: "unknown scenario" });
  if (!arms.length || arms.length > ARMS.length || !arms.every((x) => (ARMS as string[]).includes(x))) return json(res, 400, { error: `arms must be a non-empty subset of ${ARMS.join(", ")}` });
  if (busy) return json(res, 409, { error: "a batch is already running" });

  busy = true;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const batchDir = resolve(repoRoot(), "runs", "web", stamp);
  res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-cache" });
  const send = (o: unknown) => res.write(JSON.stringify(o) + "\n");
  send({ type: "batch", dir: batchDir, provider, model });
  console.log(`${c.bold(scenario)} · arms ${arms.join(",")} · ${batchDir}`);

  try {
    await Promise.all(
      (arms as Arm[]).map(async (arm) => {
        const dir = resolve(batchDir, `${scenario}__${arm}`);
        try {
          const result = await runOne(
            dir,
            scenario,
            arm,
            { provider },
            { model, permissionMode: "dontAsk", budgetUsd: 3, timeoutMin: 12, live: false, onEvent: (e: AgentEvent) => send({ arm, ...e }) },
            "",
            prompt,
          );
          send({ arm, type: "done", result, verdicts: readVerdicts(dir) });
        } catch (e) {
          send({ arm, type: "failed", error: e instanceof Error ? e.message : String(e) });
        }
      }),
    );
  } finally {
    busy = false;
    res.end();
  }
}

const page = resolve(repoRoot(), "web", "index.html");

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(readFileSync(page)); // read per request so edits show on reload
  }
  if (req.method === "GET" && url.pathname === "/api/scenarios") {
    return json(res, 200, {
      provider,
      model,
      arms: ARMS,
      scenarios: listScenarioIds().map((id) => {
        const s = loadScenario(id);
        return { id, title: s.title, kind: s.kind, summary: s.summary, task: taskText({ ...s, operator_note: undefined }), with_note: s.operator_note ? taskText(s) : null };
      }),
    });
  }
  if (req.method === "POST" && url.pathname === "/api/run") return void startBatch(req, res);
  json(res, 404, { error: "not found" });
}).listen(port, "127.0.0.1", () => {
  if (provider === "mock") console.log(c.yellow("Warning: --jev mock uses a keyword heuristic, not Jev."));
  console.log(`ClearToPay console on ${c.bold(`http://127.0.0.1:${port}`)} · agent ${model} · Jev via ${provider}`);
});
