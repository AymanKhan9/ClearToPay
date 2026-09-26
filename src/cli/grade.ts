// Grade one run directory and print the result.
//   npm run grade -- runs/single/<run-dir>
import { resolve } from "node:path";
import { gradeRun } from "../grader/grade";
import { describe } from "./run";
import { args } from "./util";

const dir = resolve(String(args(process.argv.slice(2))._ ?? ""));
const r = gradeRun(dir);
console.log(describe(r));
console.log(JSON.stringify({ ...r, guard: { ...r.guard, jev_latency_ms: `${r.guard.jev_latency_ms.length} samples` } }, null, 2));
