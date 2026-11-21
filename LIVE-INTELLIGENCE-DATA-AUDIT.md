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

## Independent LIVE INTELLIGENCE runtime (2026-11-21)

The feature branch now includes a separate runtime (live-intelligence-runtime.js) and a dedicated history endpoint:

- The independent scanner polls /api/live-intelligence every 30 seconds. It does not call or mutate the AI, VIP, HI Activity, Matrix Alert or Cloud Alert evaluators.
- It establishes a baseline on the first observation of each fixture. It emits a state-change candidate only after a later observed snapshot confirms a score increase or a red-card-count increase. Score decreases/corrections are recorded as new state but are not treated as goals.
- A score change and a red-card change observed in the same poll are recorded as separate alerts.
- Alert IDs are deterministic and the database has a unique (event_id, trigger_type, trigger_fingerprint) constraint. Repeated scans cannot create a second history record for the same event state.
- Delivery uses the existing web-push subscription store and VAPID configuration, but a distinct LIVE INTELLIGENCE payload/channel/tag. Failed or no-subscriber deliveries remain pending for a later retry; missing VAPID configuration is recorded as not configured.
- History and last observed match state are stored in dedicated live_intelligence_* tables when PostgreSQL is available. An in-memory fallback is used when it is not; that fallback is not durable across restarts.
- The LIVE INTELLIGENCE panel now displays its own alert history and scanner/persistence status.
- Alerts freeze score, minute, league, country and both team names from the observed match snapshot. Placeholder competition/country values are rejected.

## Remaining implementation gates

1. **True rolling windows:** PitchAPI provides minute/minute-added shot metadata, not exact event timestamps. The 5-minute and 10-minute SOT/xG/PSxG windows therefore remain unavailable. They must not be approximated from minute-only data or cumulative sample deltas.
2. **Statistical pressure alerts:** Sustained attacking superiority and box-entry pressure alerts remain dormant until both teams have verified rolling Box Entries, SOT and xG for genuine event-time windows. The current autonomous push scanner can send verified score/red-card state-change alerts only.
3. **Provider coverage:** Verify source definitions and availability for Final Third Entries, Defensive Pressure and Pressure Recoveries. Keep Big Chances provider-classified; never infer them from shots.
4. **Push prerequisites:** Actual delivery requires configured VAPID keys and at least one valid browser push subscription. Database history is durable only when PostgreSQL is configured and reachable.
5. **Live runtime verification:** The branch CI can validate code and tests, but real push delivery, database persistence and 30-second live polling still require deployment and a live environment check. No deployment has been performed.

Existing alert channels and provider variables remain unchanged.

## PitchAPI shot-event schema verification (2026-11-21)

The official PitchAPI reference for `GET /v1/matches/{id}/shots` confirms that each shot row includes:

- `team_id` for team attribution.
- `is_on_target` for on-target classification (including blocked shots heading on target, per provider definition).
- `expected_goals` and optional `expected_goals_on_target` for shot-level xG / PSxG.
- `minute` and optional `minute_added` for match-minute placement.
- `event_type`, `is_blocked`, and `is_inside_box` for event context.

The documented shot schema does **not** include an RFC 3339 event timestamp or a seconds-within-minute field. Therefore:

- PitchAPI is a verified source for event-level SOT, xG and optional PSxG, subject to the response being present and fresh.
- PitchAPI shot rows can support minute-resolution event ordering, but must not be converted into fabricated second-precision `timestampSeconds`.
- The engine's strict 5-minute / 10-minute rolling event-time windows remain unavailable until a source supplies genuine event timestamps, or the product explicitly approves a clearly labeled minute-resolution alternative.
- The existing `/shots` integration currently uses the rows only to count shots inside the box; it does not yet pass event-level SOT/xG/PSxG into LIVE INTELLIGENCE.
- `big_chances` remains an editorial/team-stat field; do not infer it from `is_on_target`, xG, or shot location.

Reference checked: official PitchAPI API reference, `GET /v1/matches/{id}/shots` and Shot fields, https://pitchapi.dev/.


## Integration status after PitchAPI event adapter (2026-11-21)

The independent LIVE INTELLIGENCE adapter now consumes the already-fetched PitchAPI `/shots` response on PitchAPI fixtures:

- Normalizes provider shot rows and maps `team_id` to home/away using the provider team IDs.
- Counts SOT only when `is_on_target === true`; it does not use total shots or off-target attempts as SOT.
- Uses all shot rows for event-derived xG totals when the cumulative team xG stat is unavailable.
- Uses PSxG only for on-target shot rows when the cumulative team PSxG stat is unavailable.
- Keeps Big Chances unavailable; it does not infer them from shots.
- Retains the provider's `minute` / `minute_added` as minute-resolution metadata and explicitly leaves `timestampSeconds` null.
- The API adapter prefers verified cumulative team stats and uses shot-event totals only as a fallback, with the source labeled `PitchAPI /shots event totals`.
- 5-minute and 10-minute rolling windows remain unavailable unless the input explicitly declares genuine event-time coverage. Minute-only shot rows cannot enter second-based windows.

The PitchAPI adapter remains read-only with respect to existing protocol data. The separate LIVE INTELLIGENCE runtime now owns its own polling, score/red-card state-change push path, deduplication and history. The adapter still cannot supply true event-time rolling windows; statistical pressure alerts remain unavailable until that source gap is resolved.
