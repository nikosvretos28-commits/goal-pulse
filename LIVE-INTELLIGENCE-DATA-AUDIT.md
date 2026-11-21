# GOALMATRIX LIVE INTELLIGENCE — provider coverage audit

This is a read-only audit of the current `server.js` live-stat normalization paths. It does not change providers, provider variables, or existing alert behavior.

## Observed coverage in the current code

| Requested field | Current code evidence | Readiness |
|---|---|---|
| Cumulative SOT per team | Explicit SOT aliases in SportScore, PitchAPI and ESPN fallback paths; SOT is not inferred from total shots | Available when a provider supplies it |
| Rolling SOT, last 5m / 10m | Existing rolling trend snapshots calculate deltas from persisted cumulative-stat samples; these are sample-time deltas, not confirmed shot-event timestamps | Partial; does not yet satisfy strict event-time requirement |
| Cumulative xG | Provider aliases for expected goals / xG in SportScore, PitchAPI and ESPN paths | Available when supplied |
| Rolling xG, last 5m / 10m | No verified rolling xG event aggregation found in the inspected paths | Not verified |
| PSxG | Provider aliases for PSxG / post-shot xG in SportScore, PitchAPI and ESPN paths | Available when supplied |
| Big Chances | Provider aliases in SportScore, PitchAPI and ESPN paths | Available when supplied; preserve provider definition |
| Box Entries | Provider aliases in SportScore, PitchAPI and ESPN paths | Available when supplied; current rolling delta path does not include it |
| Dangerous Attacks | Provider aliases in SportScore and ESPN paths; persisted rolling snapshots include dangerous-attacks deltas | Partial; retain provider/source label |
| Final Third Entries | No verified normalized field alias found in inspected paths | Not verified |
| Progressive Passes | Provider aliases in SportScore, PitchAPI and ESPN paths | Available when supplied |
| Key Passes | Provider aliases in SportScore, PitchAPI and ESPN paths | Available when supplied |
| Match Momentum | Can be derived only when comparable rolling Box Entries, SOT and xG are all available for both teams | Not yet fully supported by rolling inputs |
| Defensive Pressure actions | No verified normalized field alias found in inspected paths | Not verified |
| Pressure Recoveries | No verified normalized field alias found in inspected paths | Not verified |
| Game State | Score and period/minute come from scoreboard; red-card values / incident timeline are handled in existing live-stat paths | Available, subject to provider confirmation and correction handling |

## Data integrity rules for the new protocol

- A missing field remains unavailable; it must never be coerced to numeric zero.
- A numeric zero is valid only when the provider confirms coverage for that field.
- Never substitute total shots, shots off target, or shots inside the box for SOT.
- Never label sample-delta rolling statistics as event-timestamp rolling statistics.
- Do not derive Final Third Entries, Defensive Pressure or Pressure Recoveries from unrelated statistics.
- Big Chances must remain provider-defined; do not infer them solely from shot events.
- xG and PSxG must retain the provider/model identity. Do not combine values from different models in one comparison.
- The new protocol must use a separate endpoint/state/history/delivery path. Existing alert modules remain untouched.

## Remaining implementation gates

1. Identify a provider/feed with genuine timestamped shot events and compatible xG/PSxG event data, or clearly label the rolling window as unavailable.
2. Verify source coverage and definitions for Final Third Entries, Defensive Pressure and Pressure Recoveries.
3. Trigger selection is now defined in the independent engine: confirmed goal/red-card state changes, sustained attacking superiority, pressure without a clear SOT/xG edge, and pressure with some chance indicators. Unconfirmed events never trigger a state-change alert.
4. Push payload formatting now requires a complete alert-time snapshot: both team names, score, current minute, competition and country. Incomplete snapshots are rejected rather than filled with guesses. The message also includes the analysis label and available SOT/xG context.
5. Remaining before production push delivery: connect only verified provider inputs to this engine, persist independent LIVE INTELLIGENCE history/deduplication/cooldown, and add the independent UI panel and test-push flow. The existing alert channels remain isolated.
