// Offline self-test: helpers, steering parser, and the whole pipeline in
// direct mode with the MOCK heuristic (no network, no Failproof process).
//   npm test
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractAccounts, inr, isLookalike, samePhone } from "../shared/text";
import { parseSteering } from "./steering";
import { listScenarioIds } from "../shared/world";
import { simulateOne } from "./simulate";
import { c } from "./util";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? c.green("ok  ") : c.red("FAIL")} ${name}${ok ? "" : ` ${detail}`}`);
  if (!ok) failed++;
}

check("lookalike: spiceroute-ingredients.co.in vs spiceroute.co.in", isLookalike("spiceroute-ingredients.co.in", "spiceroute.co.in"));
check("lookalike: kestrel-kitchens.co vs kestrelkitchens.in", isLookalike("kestrel-kitchens.co", "kestrelkitchens.in"));
check("lookalike: acmepack.in vs acmepack.in is not a lookalike", !isLookalike("acmepack.in", "acmepack.in"));
check("lookalike: nimbuscloud.in vs kavericold.in", !isLookalike("nimbuscloud.in", "kavericold.in"));
check("accounts: spaced account found, phone ignored", JSON.stringify(extractAccounts("A/C 4611 2098 7731 call +91 44 4205 7788").full) === JSON.stringify(["461120987731"]));
check("accounts: 'ending 4471'", extractAccounts("our new HDFC account ending 4471").last4[0] === "4471");
check("phone compare", samePhone("+91 80 4110 2231", "08041102231"));
check("inr grouping", inr(1840000) === "₹18,40,000");
const steer = parseSteering(`1. hold_payment(invoice_id="INV-2291", reason="Suspected fraud (E-201); awaiting callback")\n2. request_callback(party_id="V-ACME", phone="+91 80 4110 2231", reason="Verify") — x\n3. escalate_to_controller(subject="S", details="<fill>", related_ids=["E-201", "INV-2291"])`);
check("steering parser", steer.length === 3 && steer[0].tool === "hold_payment" && (steer[2].args.related_ids as string[]).length === 2, JSON.stringify(steer));

const base = mkdtempSync(join(tmpdir(), "cleartopay-selftest-"));
for (const s of listScenarioIds()) {
  for (const arm of ["none", "jev"] as const) {
    const r = await simulateOne(join(base, `${s}__${arm}`), s, arm, { provider: "mock" }, "direct", false);
    const expectPass = arm === "jev" || r.kind === "benign";
    check(`pipeline ${s} / ${arm} → ${r.outcome}`, r.pass === expectPass);
  }
}
console.log(failed ? c.red(`\n${failed} failed`) : c.green("\nall passed"));
process.exit(failed ? 1 : 0);
