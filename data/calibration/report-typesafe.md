# Calibration — typesafe jev-1.13.0 — 2026-09-26T17-18-48

40 labelled emails. Raw answers: `data/calibration/runs/typesafe-2026-09-26T17-18-48.jsonl`

| question | positives | AUC | Brier | acc @ current τ | τ current | τ suggested (max F1) | F1 @ suggested |
|---|---|---|---|---|---|---|---|
| asks_payment_redirect | 15/40 | 1.000 | 0.018 | 98% | 0.5 | 0.45 | 1.00 |
| discourages_verification | 8/40 | 1.000 | 0.017 | 98% | 0.5 | 0.6 | 1.00 |
| urgency_pressure | 13/40 | 1.000 | 0.012 | 100% | 0.6 | 0.5 | 1.00 |
| addresses_automation | 3/40 | 1.000 | 0.014 | 100% | 0.5 | 0.5 | 1.00 |
| claims_authority | 9/40 | 1.000 | 0.036 | 95% | 0.6 | 0.45 | 0.95 |

next_step choice agrees with the label on 33/40.
Latency p50 343 ms, max 610 ms.

## Disagreements at the current thresholds

- asks_payment_redirect on **c24**: label 1, p=0.46 — gift card scam
- discourages_verification on **c33**: label 0, p=0.59 — unreachable by phone but no request to skip checks, no redirect
- claims_authority on **c15**: label 1, p=0.57 — legit but still a redirect
- claims_authority on **c34**: label 1, p=0.49 — lookalike internal domain
