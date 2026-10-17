# Goal Pulse — Live Corner Alert Protocol

Status: **engineering specification and implementation target**. A corner alert is a warning that a corner may occur soon; it is not a guarantee and is not a betting recommendation. Never display an unvalidated heuristic as a calibrated probability.

## 1. Exact alert definition

- **Target event:** a corner awarded in the match.
- **Forecast horizon:** next 5 minutes of match time; evaluate a separate 10-minute horizon only as a separately labelled model.
- **Alert wording:** “ΠΙΘΑΝΟ ΚΟΡΝΕΡ — αυξημένη πίεση” plus match minute, evidence, data freshness and confidence class.
- A corner counts only when the event feed confirms it. Do not count a shot, cross, blocked shot or attack as a corner.
- Do not issue another same-market alert for the same match during the 8-minute cooldown unless a clearly defined material-change rule is added and backtested.

## 2. Minimum data-quality gates

Before scoring a match, require:
1. Match is live and event ID / teams are identified consistently.
2. Latest statistics are fresh (target: no older than 90 seconds); otherwise suppress the alert.
3. At least two usable observations spanning 3–5 minutes exist to calculate a trend. On cold start, show “συλλογή δεδομένων” rather than pretending the trend is known.
4. Corner totals are numeric and non-decreasing after provider correction handling. Missing values stay missing, never become zero.
5. Match clock and score are available where possible. Handle half-time, extra time, abandoned/postponed matches and red-card changes explicitly.
6. If provider endpoints disagree, mark the feature unavailable until reconciled; do not silently blend incompatible definitions.

## 3. Signals — score separately, don't double-count

### A. Direct corner pressure (strongest evidence)
- Corners in last 5 and 10 minutes, calculated from timestamped corner events where possible.
- Repeated corners / a corner sequence; avoid treating the same corner as multiple signals.
- Corner count change must come from a verified event or a reliable cumulative-stat delta.

### B. Attacking pressure (supporting evidence)
- Shots and shots on target in last 5/10 minutes.
- Blocked shots and crosses into the penalty area, if the feed exposes them.
- Sustained possession in the attacking phase / final-third entries, only if provider definitions are known.
- Repeated attacks ending in a shot or defensive clearance.
- Dangerous-attacks counts are a weak, provider-dependent signal: use only as corroboration, never as the sole trigger.

### C. Match context
- Scoreline and time remaining: a trailing team may increase attacking urgency, but this is only a contextual modifier.
- Home/away and team-specific corner-for/corner-against rates, adjusted for opponent and competition, when sufficient historical matches exist.
- Red cards, substitutions, injury stoppages, half-time and extra time.
- A team leading comfortably may reduce attacking urgency; do not apply fixed assumptions without validation.

### D. Negative / suppressing evidence
- No recent shots or pressure events; stats stale or missing; feed outage; match state uncertain.
- Long stoppage, half-time, match finished, or a red-card / formation change before enough new observations are collected.
- A high full-match corner total alone is not evidence that another corner is imminent.

## 4. Initial transparent heuristic (not a probability)

Until there is enough timestamped event data and historical backtesting, use a **pressure score**, not a claimed probability. Suggested starting points, subject to tuning:
- +3: at least 1 confirmed corner in the last 5 minutes.
- +2: at least 2 shots in the last 5 minutes across either team, or 1 shot on target.
- +2: repeated verified attacking entries / crosses / blocked shots in the last 5 minutes, if available.
- +1: sustained attacking pressure across two consecutive observations.
- +1: team-specific historical corner rate is above competition baseline with adequate sample size.
- +1: match state plausibly increases urgency, but only as a minor modifier.
- −3: no shot/entry signal in the last 5 minutes.
- Suppress entirely for stale data, missing corner counter, non-live status, half-time, or uncertain event identity.

A candidate alert may be shown at score ≥5 only if at least two independent signal families contribute and the data-quality gates pass. This threshold is a testable starting point, **not** an empirically validated setting. If the current provider lacks event timestamps, do not award the “confirmed corner in last 5 minutes” points based on total-match corners.

## 5. Separate markets and alert logic

- Corner alerts must use their own feature set, threshold, cooldown, outcome definition and validation report.
- Goal alerts must not trigger corner alerts automatically; shots/xG can be shared observations but their predictive effect must be separately measured.
- Calculate features for each team and for the match, but avoid double-counting both teams' same event.
- Emit one clear alert with the strongest side/team context; don't flood the UI with duplicate team and match alerts.

## 6. Outcome tracking and validation

For every issued and eligible non-issued candidate, record:
- match ID, competition, provider, model/protocol version, observation timestamp, minute, score, red cards;
- exact pre-alert features, data age, pressure score, threshold and cooldown state;
- whether a confirmed corner occurred within 5 match minutes (and within 10 only for the separate horizon);
- time-to-corner, missed-corner cases, feed gaps, and whether the match ended or entered half-time first.

Evaluate chronologically by competition and season, without future-data leakage:
- precision: alerts followed by a corner within horizon / all alerts;
- recall / coverage: qualifying corner events preceded by an alert / eligible corner events;
- false alerts per match and per 90 minutes;
- median lead time, performance by minute/scoreline/team, and calibration only if a probability model exists;
- compare against simple baselines such as league average corner rate and current-match corner rate.
Use held-out matches. Do not call the displayed “hit rate” model accuracy unless its denominator, horizon and sample size are visible and validated.

## 7. User-facing alert card

Each card should show:
- **ΠΙΘΑΝΟ ΚΟΡΝΕΡ** (not “σίγουρο”)
- Match and minute; home/away team under pressure if evidence supports it
- “Ορίζοντας: επόμενα 5 λεπτά”
- 2–3 concrete reasons, e.g. “2 τελικές στα τελευταία 5′”, “αυξημένη πίεση σε 2 διαδοχικούς ελέγχους”
- Data age and evidence coverage
- Label “Πειραματικός δείκτης πίεσης” until validation supports a probability

## 8. Current implementation boundary

The current Goal Pulse live feed primarily supplies cumulative totals (shots, shots on target, corners) and a coarse dangerous-attacks field for up to 24 live matches, with rolling 5/10-minute deltas observed by the server. It does **not** reliably provide timestamped crosses, blocked shots, final-third entries, or a complete event stream for every match. Therefore:
- use cumulative deltas only when a valid baseline exists;
- do not fabricate event timing from total-match statistics;
- do not claim calibrated corner probabilities yet;
- prefer “pressure rising” alerts with evidence and confidence limitations;
- persist all candidate features and outcomes before asserting the model is learning.

## 9. Release checklist

- [ ] Live status, identity and freshness gates tested.
- [ ] Corner totals correctly normalized across each supported league/provider.
- [ ] Cold-start behavior and halftime suppression tested.
- [ ] Duplicate alert/cooldown behavior tested.
- [ ] Corner outcome labels verified from event data.
- [ ] Backtest and held-out evaluation completed.
- [ ] False-alert rate and sample size displayed honestly.
- [ ] Paid data provider and API costs approved before activation.
