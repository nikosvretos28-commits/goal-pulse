# Goal Pulse AI protocol — implementation and verification record

Last updated: 2026-10-22
Branch: `fix/dirty-sheet-team-matching`
Pull request: https://github.com/nikosvretos28-commits/goal-pulse/pull/14

## Current implementation (branch, not yet live)

### Live goal-alert decision
The live server evaluates five named scanners:
- `momentum`: recent short-window pressure.
- `sustainedPressure`: sustained match pressure.
- `xgSurge`: a measured xG change when xG is available.
- `defensiveWeakness`: historical opponent-conceding tendency from Dirty Sheet results, shrunk toward a league baseline.
- `lateGamePressure`: late-match context applied to recent pressure.

The scanners share some underlying live statistics and are **not statistically independent**. The final decision therefore counts distinct evidence families (short-window pressure, sustained pressure, measured xG surge, historical defensive weakness), rather than simply counting scanner names. A strong single signal can qualify only with additional corroborating evidence. Missing xG or historical data is neutral; it is not fabricated.

The exact score-derived market and period are checked against the available live-odds provider. If the provider has no usable quote, the system must not fabricate a price; odds availability and whether an alert is allowed to proceed are separate concerns that still need end-to-end verification. There is no minimum-odds threshold in this branch. Asian markets remain excluded from automatic AI alerts.

### Live scanning and activity UI
The frontend keeps a rolling match-stat trail and displays 5- and 10-minute deltas when enough real samples have accumulated. The inline summary includes shots, shots on target, attacks, dangerous attacks and corners. High Activity ranks every match that meets the recent-pressure rules; it is not intentionally capped at five. It excludes half-time and exits when the recent activity conditions no longer hold, then can re-enter if fresh data again qualifies. xG can support ranking only when comparable live samples exist; missing xG does not block evaluation. Corner deltas are displayed, but corner-only activity is not a goal High Activity trigger.

### Dirty Sheet sample weighting
Team names are normalized for common prefixes/suffixes. Recent completed matches are used, with a five-match empirical prior toward the league conceding baseline. Team rates are weighted by their sample reliability; the raw rate, weighted rate, sample count, and league baseline are available for debugging. Missing/insufficient history falls back neutrally.

### Settled history, scanner evaluation and dataset
- The analyst reads only server-generated AI alert history with real `won`/`lost` outcomes for its performance report.
- Per-scanner and per-league/scanner summaries are derived from those settled records. A sample is flagged as reliable only at 20 or more settled records; these are descriptive rates, not guaranteed future performance.
- A durable PostgreSQL `ai_training_examples` table stores one labeled row per settled alert, with features frozen at signal time and a binary label (win=1, loss=0). Missing features stay null. Final score/post-match features are not added to the signal feature vector.
- The analyst runs after server start, hourly, and on request through `GET /api/protocol-analyst`.
- The growing dataset is **not yet a trained machine-learning model**. The report explicitly says that chronological train/test validation and a separate training process are required. It must not be advertised as millions of historical phases or as having a proven hit rate.

### Free deployment fallback
A GitHub Actions workflow builds and publishes a container image to GitHub Container Registry, intended to avoid Render's exhausted free build-pipeline minutes. The Docker build now runs `node --check server.js` so a syntax error blocks image publication. The Render service still points to the Git-based Node build until the image workflow is confirmed successful and an image-based Render service is configured with the existing environment variables and database connection.

## Verification status on 2026-10-22
- [x] Scanner ensemble, evidence-family gate, Dirty Sheet weighting, scanner/league settled reporting, and labeled-dataset schema are committed on this branch.
- [x] Analyst invocation exists at startup, hourly, and via the API endpoint.
- [x] Signal-time feature snapshot exists in alert payload construction.
- [x] Docker build includes a Node syntax check.
- [x] The container workflow triggers on any push to the selected branches, including frontend-only changes, so the static UI is not left out of a rebuilt image.
- [x] The live 5-/10-minute inline summary includes attacks and dangerous attacks as well as shots, shots on target and corners.
- [x] GitHub Actions container build/push succeeded for commit `ca1595b25bf1a1f2d50535c91569d831c9ea2d6c`; Docker build and `node --check server.js` passed.
- [ ] Render deployment of this branch has not been confirmed; the current Render service is configured for `main`, and its recent builds failed. The image-based route still requires checking GHCR package visibility and configuring Render with the image plus existing environment variables/database connection.
- [ ] Live odds coverage and prediction performance have not been validated end-to-end.

Do not merge or claim the features are live until the container workflow (or another successful build) and live API/database checks pass. Do not alter settled historical outcomes just to improve the reported success rate.
