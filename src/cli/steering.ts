// Parses the concrete tool calls a deny message tells the agent to make, e.g.
//   hold_payment(invoice_id="INV-2291", reason="Suspected fraud (E-201); awaiting callback")
//   escalate_to_controller(subject="…", details="<…>", related_ids=["E-201", "INV-2291"])
// Used by the simulator to act like a cooperative agent. Calls whose values
// are placeholders ("<…>", "CB-…") are skipped or filled with generic text.

const STEER_TOOLS = ["hold_payment", "request_callback", "escalate_to_controller", "schedule_payment", "update_vendor_bank_details", "issue_refund"];

export interface ParsedCall {
  tool: string;
  args: Record<string, unknown>;
}

function parseArgs(src: string, start: number): { args: Record<string, unknown>; end: number } | null {
  const args: Record<string, unknown> = {};
  let i = start;
  const ws = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };
  const readString = (): string | null => {
    if (src[i] !== '"') return null;
    const j = src.indexOf('"', i + 1);
    if (j < 0) return null;
    const s = src.slice(i + 1, j);
    i = j + 1;
    return s;
  };
  for (;;) {
    ws();
    if (src[i] === ")") return { args, end: i + 1 };
    if (src.startsWith("...", i)) {
      i += 3;
      ws();
      if (src[i] === ",") i++;
      continue;
    }
    const m = /^([a-z_]+)\s*=\s*/.exec(src.slice(i));
    if (!m) return null;
    const key = m[1];
    i += m[0].length;
    if (src[i] === '"') {
      const s = readString();
      if (s === null) return null;
      args[key] = s;
    } else if (src[i] === "[") {
      i++;
      const arr: string[] = [];
      for (;;) {
        ws();
        if (src[i] === "]") {
          i++;
          break;
        }
        const s = readString();
        if (s === null) return null;
        arr.push(s);
        ws();
        if (src[i] === ",") i++;
      }
      args[key] = arr;
    } else {
      return null;
    }
    ws();
    if (src[i] === ",") i++;
  }
}

export function parseSteering(text: string): ParsedCall[] {
  const calls: ParsedCall[] = [];
  for (const tool of STEER_TOOLS) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(`${tool}(`, from);
      if (at < 0) break;
      from = at + tool.length + 1;
      const parsed = parseArgs(text, from);
      if (!parsed || !Object.keys(parsed.args).length) continue;
      calls.push({ tool, args: parsed.args });
    }
  }
  // Order the way a careful clerk would: hold, verify, escalate.
  const order = ["hold_payment", "request_callback", "escalate_to_controller", "update_vendor_bank_details", "issue_refund", "schedule_payment"];
  return calls
    .sort((a, b) => order.indexOf(a.tool) - order.indexOf(b.tool))
    .map((c) => {
      const args = { ...c.args };
      for (const [k, v] of Object.entries(args)) {
        if (typeof v === "string" && v.startsWith("<")) args[k] = "Stopped by the payment guard; see the guard's message.";
      }
      return { tool: c.tool, args };
    })
    .filter((c) => !Object.values(c.args).some((v) => typeof v === "string" && /CB-…|<CB/.test(v)));
}

export function invoicesIn(text: string): string[] {
  return [...new Set(text.match(/INV-\d{4}/g) ?? [])];
}
