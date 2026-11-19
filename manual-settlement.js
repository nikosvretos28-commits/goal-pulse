'use strict';

const { parseOverLine, gradeOverMarket } = require('./settlement');

const REPAIR = Object.freeze({
  eventId: 'sportscore:zp5rzgh3jkpoq82',
  fixtureId: 'zp5rzgh3jkpoq82',
  score: Object.freeze({ home: 7, away: 1 }),
  provider: 'SofaScore (user-supplied screenshot)',
  evidence: 'user_supplied_sofascore_screenshot',
  date: '2026-11-19',
  alertIds: Object.freeze([
    'push:sportscore:zp5rzgh3jkpoq82:AI:recent_sot_pressure:1795049231308',
    'push:sportscore:zp5rzgh3jkpoq82:AI:recent_sot_pressure:1795049050946',
    'push:sportscore:zp5rzgh3jkpoq82:AI:first_half_8_sot:1795050071463',
    'push:sportscore:zp5rzgh3jkpoq82:AI:power-ranking-59:1795049351596'
  ])
});

function buildManualFirstHalfSettlement(row, settledAt) {
  if (!row || !REPAIR.alertIds.includes(String(row.alert_id || row.alertId || ''))) {
    throw new Error('Alert is not in the approved repair allowlist');
  }
  if (String(row.event_id || row.eventId || '') !== REPAIR.eventId) {
    throw new Error('Alert fixture does not match the approved fixture');
  }
  if (String(row.level || '').toUpperCase() !== 'AI') {
    throw new Error('Only the four approved AI alerts can be repaired');
  }
  const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
  if (payload.source !== 'server-push' || payload.periodAtSignal !== 'first_half') {
    throw new Error('Alert is not an eligible first-half server alert');
  }
  if (['won', 'lost', 'push', 'void'].includes(String(payload.betOutcome || '').toLowerCase())) {
    throw new Error('Alert is already terminal; refusing to overwrite its settlement');
  }
  if (String(payload.lineType || '').toLowerCase() === 'asian') {
    throw new Error('Asian markets are not eligible for this repair');
  }
  const market = String(payload.market || '');
  const line = parseOverLine(market);
  if (line === null || !/\bover\b/i.test(market) || /corner|κόρνερ/i.test(market)) {
    throw new Error('Alert has no unambiguous standard Over goal line');
  }
  const total = REPAIR.score.home + REPAIR.score.away;
  const outcome = gradeOverMarket(total, line);
  if (!outcome) throw new Error('Could not grade the saved Over line');

  const score = `${REPAIR.score.home}-${REPAIR.score.away}`;
  return {
    ...payload,
    betOutcome: outcome,
    betFinalScore: score,
    betMatchFinalScore: payload.betMatchFinalScore || null,
    betScoreScope: 'first_half',
    betSettlementProvider: REPAIR.provider,
    betSettlementFixtureId: REPAIR.fixtureId,
    betSettlementFixtureDate: REPAIR.date,
    betSettlementLeague: payload.league || null,
    betScoreSource: REPAIR.evidence,
    betHalfTimeScore: score,
    betSettledAt: settledAt,
    evaluatedAt: settledAt,
    evaluationRule: 'manual_verified_half_time_score',
    manualSettlementAudit: {
      action: 'targeted_manual_repair',
      evidence: REPAIR.evidence,
      provider: REPAIR.provider,
      fixtureEventId: REPAIR.eventId,
      fixtureId: REPAIR.fixtureId,
      scoreScope: 'first_half',
      score,
      market,
      overLine: line,
      outcome,
      repairedAt: settledAt,
      allowlistedRepair: true
    }
  };
}

module.exports = { REPAIR, buildManualFirstHalfSettlement };
