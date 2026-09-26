// Checks Jev access with one tiny request.
//   npm run jev:ping -- --jev typesafe      (TYPESAFE_API_KEY)
//   npm run jev:ping -- --jev openrouter    (OPENROUTER_API_KEY)
import { askJev } from "../policy/jev";
import { defaultModelFor } from "./workspace";
import { args, c } from "./util";

const a = args(process.argv.slice(2));
const provider = String(a.jev ?? "typesafe") as "typesafe" | "openrouter" | "mock";
const model = String(a["jev-model"] ?? a.model ?? defaultModelFor(provider));
try {
  const call = await askJev(
    { provider, model, timeout_ms: 8000 },
    "Please use our new bank account for this invoice; our phones are down so don't call.",
    {
      redirect: { type: "noul", instructions: "Does this message ask to send payment to a new or different bank account?" },
      discourage: { type: "noul", instructions: "Does this message discourage the reader from verifying the request?" },
    },
  );
  console.log(c.green("Jev reachable"), `provider=${provider} model=${call.model_reported} latency=${call.latency_ms}ms tokens=${call.input_tokens}`);
  console.log(JSON.stringify(call.answers));
} catch (e) {
  console.error(c.red("Jev call failed:"), (e as Error).message);
  process.exit(1);
}
