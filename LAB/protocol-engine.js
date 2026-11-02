/* GoalMatrix LAB only. Pure evaluators; no production imports, writes, or notifications. */
export const REFERENCE_AI_PROFILE = Object.freeze({
  id: 'reference-v1', minuteMin: 1, minuteMax: 40,
  sot5MatchTotal: 3, sot10MatchTotal: 6,
  xgHomeMin: 2.5, xgAwayMin: 2.0
});

const finite = value => value === null || value === undefined || value === '' ? null : (Number.isFinite(Number(value)) ? Number(value) : null);
const sumPair = pair => {
  const h = finite(pair?.home), a = finite(pair?.away);
  return h === null || a === null ? null : h + a;
};
const pct = (hits, played) => finite(played) > 0 && finite(hits) !== null ? (Number(hits) / Number(played)) * 100 : null;

export function evaluateExperimentalAI(snapshot = {}, profile = REFERENCE_AI_PROFILE) {
  const reasons = [];
  const minute = finite(snapshot.match?.minute);
  const period = String(snapshot.match?.period || '').toLowerCase();
  if (minute === null || minute < profile.minuteMin || minute > profile.minuteMax || (period && !['1h','first_half','1st half'].includes(period))) {
    reasons.push('outside_reference_minute_window');
  }
  const sot5 = sumPair(snapshot.live?.sot5);
  const sot10 = sumPair(snapshot.live?.sot10);
  const sotSignal = (sot5 !== null && sot5 >= profile.sot5MatchTotal) || (sot10 !== null && sot10 >= profile.sot10MatchTotal);
  const xgh = finite(snapshot.live?.xg?.home), xga = finite(snapshot.live?.xg?.away);
  const xgSignal = xgh !== null && xga !== null && xgh >= profile.xgHomeMin && xga >= profile.xgAwayMin;
  const signal = sotSignal || xgSignal;
  if (!signal) reasons.push('no_reference_sot_or_xg_signal');

  const line = String(snapshot.market?.line || '').toLowerCase();
  let fullOverFilter = { status: 'not_applicable' };
  if (line === 'over3.5' || line === 'o3.5') {
    const h = finite(snapshot.season?.home?.totalGoalsAverage);
    const a = finite(snapshot.season?.away?.totalGoalsAverage);
    if (h === null || a === null) fullOverFilter = { status: 'unavailable', reason: 'missing_team_season_average' };
    else if (!(h > 3.0 || a > 3.0)) {
      fullOverFilter = { status: 'rejected', homeAverage: h, awayAverage: a, reason: 'neither_team_average_strictly_above_3.00' };
      reasons.push('historical_over35_filter');
    } else fullOverFilter = { status: 'passed', homeAverage: h, awayAverage: a };
  }

  const htLine = String(snapshot.market?.firstHalfLine || '').toLowerCase();
  let firstHalfFilter = { status: 'not_applicable' };
  if (htLine) {
    const lineKey = htLine.replace(/[^0-9.]/g, '');
    const hLine = snapshot.season?.home?.firstHalfOvers?.[lineKey];
    const aLine = snapshot.season?.away?.firstHalfOvers?.[lineKey];
    const hRate = pct(hLine?.hits, hLine?.played);
    const aRate = pct(aLine?.hits, aLine?.played);
    if (hRate === null || aRate === null) firstHalfFilter = { status: 'unavailable', line: htLine, homeRate: hRate, awayRate: aRate, reason: 'missing_exact_line_history' };
    else if (hRate < 65 && aRate < 65) {
      firstHalfFilter = { status: 'rejected', line: htLine, homeRate: hRate, awayRate: aRate, reason: 'both_teams_below_65_percent' };
      reasons.push('historical_first_half_filter');
    } else firstHalfFilter = { status: 'passed', line: htLine, homeRate: hRate, awayRate: aRate, strong: hRate >= 80 || aRate >= 80 };
  }

  const windowPass = !reasons.includes('outside_reference_minute_window');
  const historicalPending = fullOverFilter.status === 'unavailable' || firstHalfFilter.status === 'unavailable';
  const protocolPass = windowPass && signal && !historicalPending && !reasons.includes('historical_over35_filter') && !reasons.includes('historical_first_half_filter');
  const missing = [];
  if (sot5 === null) missing.push('sot5');
  if (sot10 === null) missing.push('sot10');
  if (xgh === null || xga === null) missing.push('xg');
  if (fullOverFilter.status === 'unavailable') missing.push('full_match_season_goal_average');
  if (firstHalfFilter.status === 'unavailable') missing.push('first_half_exact_line_history');
  return {
    mode: 'shadow_only', profile: profile.id, candidate: protocolPass,
    decision: protocolPass ? 'candidate_for_shadow_evaluation' : historicalPending ? 'pending_missing_historical_data' : 'not_qualified',
    signals: { sot5MatchTotal: sot5, sot10MatchTotal: sot10, sotSignal, xgHome: xgh, xgAway: xga, xgSignal },
    filters: { fullOver35: fullOverFilter, firstHalf: firstHalfFilter },
    missing, reasons, pending: historicalPending,
    note: 'This is an isolated LAB evaluation. It does not send alerts or place bets.'
  };
}

export function evaluateLateGoals(snapshot = {}) {
  const minute = finite(snapshot.match?.minute);
  const home = snapshot.season?.home || {};
  const away = snapshot.season?.away || {};
  const live = snapshot.live || {};
  const missing = [];
  const fields = ['totalShots','sot','shotsInsideBox','bigChances','xg','xgot','corners'];
  for (const field of fields) if (live[field]?.home == null || live[field]?.away == null) missing.push(field);
  const lateWindows = [65,75,80,85].map(threshold => ({
    afterMinute: threshold,
    homeScoredRate: finite(home[`scoredAfter${threshold}Rate`]),
    homeConcededRate: finite(home[`concededAfter${threshold}Rate`]),
    awayScoredRate: finite(away[`scoredAfter${threshold}Rate`]),
    awayConcededRate: finite(away[`concededAfter${threshold}Rate`])
  }));
  const referee = snapshot.referee || {};
  return {
    mode: 'descriptive_shadow_analysis',
    matchState: { minute, period: snapshot.match?.period ?? null, score: snapshot.match?.score ?? null, timeSinceLastGoalMinutes: finite(snapshot.match?.timeSinceLastGoalMinutes) },
    liveStats: live,
    lateWindows,
    referee: { name: referee.name || 'Not confirmed', matches: finite(referee.matches), averageGoals: finite(referee.averageGoals), over15Rate: finite(referee.over15Rate), over25Rate: finite(referee.over25Rate), over35Rate: finite(referee.over35Rate), bttsRate: finite(referee.bttsRate), cardsAverage: finite(referee.cardsAverage), penaltiesPerMatch: finite(referee.penaltiesPerMatch) },
    missing,
    note: 'Descriptive analysis only. Referee context is not a trigger; no alert or betting recommendation is generated.'
  };
}
