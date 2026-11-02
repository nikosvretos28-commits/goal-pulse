# GoalMatrix LAB — Experimental Protocol Cards
**Status:** specification for isolated LAB experiments; not production code or a live betting feed.
**Start:** 2026-11-02 (shadow-data collection only, once the LAB data pipeline is connected).
**Isolation:** no production alerts, notifications, settings, scoring, history, or user-facing recommendations may be changed by these experiments.

The LAB page must expose two separate tabs/cards:
1. **LATE GOALS INTELLIGENCE**
2. **AI ALERTS — EXPERIMENTAL**

Each card stores a timestamped snapshot, data-provider/source, event ID, competition, season, match minute, score, sample size, missing-data flags, and the exact experiment/profile version. Never convert unavailable values to zero. Do not mix historical final-match data into a live snapshot that predates it.

---

## Card 1 — LATE GOALS INTELLIGENCE

### Purpose
Measure and compare late-goal patterns by team, match state, competition and season. This is an experiment, not a betting recommendation. Referee season profile is included as contextual evidence, not as a standalone trigger.

### A. Pre-match team and season context
For both teams, for the current season and separately for the most recent form window:
- Matches played; wins/draws/losses.
- Goals scored and conceded; averages per match.
- Clean sheets; matches with at least one goal conceded.
- Scoring rate and conceding rate.
- Goal timing for and against: 1–15, 16–30, 31–45+, 46–60, 61–65, 66–75, 76–80, 81–90+, and extra time when available.
- Matches scoring after 65', 75', 80', and 85'; matches conceding in those same periods.
- Late goals scored/conceded per match and percentage of matches with a late goal.
- Comebacks, equalizers and winning goals after 65' when event data supports them.
- Home/away splits, with sample sizes.
- Recent match list with opponent, venue, final score and goal timestamps.

### B. Live match statistics (home, away and total)
Capture the provider's actual values and update timestamp:
- Total shots.
- Shots on target (SOT).
- Shots off target.
- Blocked shots.
- Shots inside the box and shots outside the box.
- Shots on target from inside the box, when explicitly supplied.
- Big chances and big chances missed.
- Expected goals (xG) and expected goals on target (xGOT), separately.
- Corners.
- Possession.
- Dangerous attacks and total attacks, only where the provider defines/supplies them.
- Goalkeeper saves.
- Passes and pass accuracy.
- Fouls, yellow cards, red cards and offsides.
- Penalties awarded/scored/missed and woodwork, only when event data supplies them.
- Match events with minute and team: goals, substitutions, cards, penalties and VAR decisions.

Show home/away values side by side. Keep total and rolling-window values distinct. If a field is not supplied, show “Μη διαθέσιμο”; do not infer it.

### C. Live late-game state
- Current minute, period, score and score difference.
- Time since last goal and last major event.
- SOT/shots/corners/big-chance activity in rolling 5- and 10-minute windows, where timestamps allow it.
- Whether either team is chasing, protecting a lead, or level (derived only from score and clock).
- Late-goal signals split into 65'+, 75'+, 80'+ and 85'+ cohorts; do not collapse them into one threshold.
- Separate goals-for and goals-against evidence for each team.
- Flag stoppage time and extra time separately.

### D. Referee Intelligence (context module inside this card)
For the appointed referee, current season first; show career/previous-season data separately:
- Matches officiated and sample size.
- Average total goals per match in those matches.
- Over 1.5, Over 2.5, Over 3.5 rates and counts.
- BTTS rate and count.
- Average yellow cards, red cards, total cards and fouls.
- Penalties awarded per match and count, if available.
- Home/away win rates only as descriptive context, never as a predictive conclusion.
- Competition-specific referee sample where enough matches exist.
- Match list with date, competition, teams, score and event/card/penalty details.

Always show N (matches) beside every percentage/average. Mark small samples clearly; do not rank referees or imply causation. If referee assignment is unconfirmed, show “Not confirmed”.

### E. LAB experiment outputs
- Compare late-goal definitions: after 65', 75', 80' and 85'.
- Report goals-for and goals-against separately.
- Evaluate by league, team, home/away, score state and referee context.
- Store the snapshot as it was known at the time; prevent future-data leakage.
- Report sample size, coverage, missingness and provider freshness.
- No automatic production alert or bet recommendation.

---

## Card 2 — AI ALERTS (EXPERIMENTAL)

### Purpose
Run alternative AI-alert hypotheses side by side against a frozen reference profile. The purpose is to discover whether a changed rule improves reliability; no experimental profile may overwrite or influence production AI Alerts. This card includes experimental full-match Over filters and first-half Over filters described below.

### A. Frozen reference profile
Use the currently agreed production specification only as a labelled benchmark:
- Minute window: 1'–40'.
- Trigger A: at least 3 new SOT in rolling 5 minutes.
- Trigger B: at least 6 new SOT in rolling 10 minutes.
- Alternative xG trigger: one team at least 2.50 AND the other at least 2.00.
- Missing xG is neutral when an SOT trigger qualifies.
- No minimum odds threshold.
- No Asian Over markets in automatic alerts.
- Inside-box SOT and Big Chances are supplementary, not mandatory gates.

This is a comparison baseline only. Verify deployed revision before describing it as live production behavior.

### B. Experimental profiles
Create versioned, independently configurable profiles to test changes to:
- Eligible minute windows (including first-half-only and separately defined late windows).
- Rolling SOT thresholds and durations (5m/10m, with additional windows only as separately named experiments).
- Team-level versus match-total SOT calculations.
- xG thresholds and the two-team relationship.
- Whether xG is a separate alternative trigger or a supporting feature.
- Big Chances, inside-box shots/SOT, total shots and dangerous attacks as supplementary features or explicitly isolated experimental triggers.
- Momentum, rapid-chance clusters and open-game signals, only when backed by timestamped provider data.
- Score state and time since last goal.
- Historical team form and goal-time profiles.
- Referee season context (averages and rates with sample size), as a feature to evaluate—not an automatic veto or sole trigger.
- Market/odds availability as a separately measured execution condition; do not silently add an odds floor.

Do not assume a new threshold is approved. Every profile must have a name, version, exact rules, start/end date and an immutable configuration snapshot.

### C. Team and league goal profile — full match
For each team, use its current league season and show the competition baseline alongside it. Calculate separately:
- Average goals scored per match (goals for).
- Average goals conceded per match (goals against).
- Average total goals in the team's matches (goals for + goals against).
- Full-match Over 0.5, 1.5, 2.5, 3.5 and higher available lines: counts, percentages and sample size.
- Clean-sheet percentage and percentage of matches in which the team conceded at least one goal.
- Home and away splits, plus overall season figures.
- The league's own goals-for, goals-against, total-goals averages and Over percentages as a comparison baseline.

**Experimental full-match Over 3.5 filter:** before an Over 3.5 candidate can pass the historical team-profile gate, at least one of the two teams must have an average of **3.00 or more total goals per match in its own league-season matches** (goals scored plus goals conceded). If neither team reaches 3.00, reject that Over 3.5 candidate at this gate. This is only a historical eligibility filter; it does not itself create or approve an alert. Also display each team's Over 3.5 percentage and sample size. Do not confuse the 3.00 average-total-goals condition with a 3.5-goal outcome threshold.

### D. First-half team and league goal profile
For each team, in its current league season, calculate:
- Average first-half goals scored per match (first-half goals for, +).
- Average first-half goals conceded per match (first-half goals against, −).
- Average total first-half goals in the team's matches (first-half goals for + against).
- First-half Over 0.5, 1.5, 2.5 and 3.5 rates, with counts, percentages and sample size.
- Home and away splits, plus overall season figures.
- The same first-half goals-for, goals-against, total-goals averages and Over rates for the league as a whole.
- Clearly identify whether a statistic is team-specific or league-wide; never substitute one for the other.

**Experimental first-half Over filter:** assess the exact first-half line proposed by the candidate (for example, Over 1.5 HT must be checked against each team's Over 1.5 HT history):
- If both teams are below 65% for that exact Over line, reject the candidate at this historical filter.
- If at least one team is at or above 80% for that exact line, allow the candidate to continue through the remaining alert checks, even if the other team is below 65%.
- Otherwise, if at least one team is at least 65% but neither reaches 80%, allow it to continue through the remaining checks; this is not an automatic approval.
- Apply the rule independently to each line; do not use an Over 2.5 percentage to qualify an Over 1.5 candidate, for example.

All team and league averages/rates must include the number of matches used. Prefer current-season data; show recent-form data separately rather than silently blending it into season figures. Mark small samples and unavailable fields explicitly.

### E. Full live match feature set
Capture for each team and match total:
- Total shots; SOT; shots off target; blocked shots.
- Shots inside/outside the box; inside-box SOT if available.
- Big chances and big chances missed.
- xG and xGOT.
- Corners; possession.
- Dangerous attacks and total attacks where provider-defined.
- Goalkeeper saves; passes and pass accuracy.
- Fouls; yellow/red cards; offsides.
- Goals and event timeline.
- Rolling 5m and 10m SOT, with source timestamps and calculation method.
- Match minute, period, score, team identities and event/provider IDs.
- Data age/freshness and per-field availability.

### F. Pre-match context
- Team season and recent-form scoring/conceding rates.
- Home/away splits and goal-time distributions.
- Referee current-season averages: goals, Over 1.5/2.5/3.5, BTTS, cards, reds and penalties, always with sample size.
- Competition baseline and match-level historical context.
- Context features are supplementary; evaluate their incremental value and do not let them silently suppress a live SOT-qualified event except where a separately versioned experimental historical-Over filter explicitly defines a rejection rule.

### G. Pipeline diagnostics
Record counts and examples at each stage:
- Live matches received.
- Match identity/team mapping success.
- Usable statistics and two-team coverage.
- Missing/stale fields and source update age.
- Score and clock availability/consistency.
- In-window matches.
- SOT 5m/10m signal counts; xG signal counts.
- Each supplementary feature's availability and contribution.
- Protocol-qualified candidates per profile.
- Rejections by reason (minute, missing stats, score mismatch, cooldown, duplicate, historical Over filter, etc.).
- History writes attempted/succeeded/failed.
- Shadow notification attempts/suppressed/failed; LAB must not send production push notifications.
- Provider/API errors, latency and retry counts.

### H. Evaluation and settlement
Before evaluating, declare one outcome definition per experiment (for example, goal within the next 10 minutes, or goal before full time); never mix definitions in one percentage.
- Store each candidate snapshot as-of trigger time.
- Count every candidate once per profile; deduplicate retries by stable event/profile/snapshot key.
- Record subsequent goal time, final score and settlement status.
- Report sample size, hit rate, false-alert rate, precision/recall where labels permit, calibration and confidence intervals.
- Split chronologically into development and unseen evaluation periods; avoid random leakage across the same match.
- Compare each experiment with the frozen reference using identical matches and settlement rules.
- Label insufficient sample sizes; never claim a validated hit rate from a small sample.

### I. Safety and isolation requirements
- Shadow mode only at first. No public betting picks, no production notifications and no automatic bet placement.
- LAB data, counters, profiles and history must use separate storage keys/tables/namespaces from production.
- No writes to production settings, protocols, alerts, history, scanners or user subscriptions.
- A failed or missing provider feed must be visible as unavailable/stale, not converted to zero.
- Promote nothing to production without explicit user approval, a reviewed PR, reproducible backtest and separate deployment authorization.

---

## Initial build sequence
1. Build the LAB page shell with two tabs/cards using the existing GoalMatrix visual identity, clearly labelled “LAB / EXPERIMENTAL”.
2. Implement a data dictionary and provider-coverage matrix before connecting live feeds.
3. Add timestamped, isolated storage and pipeline-health diagnostics.
4. Connect historical/current-season team, match-event and referee datasets with provenance and sample-size labels.
5. Start shadow collection; validate completeness and freshness before running comparisons.
6. Add profile comparison and evaluation views only after enough correctly timestamped data has accumulated.

**Current status:** this document defines the two experimental cards. It does not mean the UI, data integrations, scanners or live experiments are already implemented or running.
