'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { REPAIR, buildManualFirstHalfSettlement } = require('./manual-settlement');

function row(index, market = 'Over 7.5 Goals') {
  return {
    alert_id: REPAIR.alertIds[index],
    event_id: REPAIR.eventId,
    level: 'AI',
    payload: { source: 'server-push', periodAtSignal: 'first_half', market, league: 'Test League' }
  };
}

test('repairs only allowlisted first-half AI alerts and grades Over using the supplied HT score', () => {
  const settled = buildManualFirstHalfSettlement(row(0), '2026-11-19T05:30:00.000Z');
  assert.equal(settled.betFinalScore, '7-1');
  assert.equal(settled.betHalfTimeScore, '7-1');
  assert.equal(settled.betScoreScope, 'first_half');
  assert.equal(settled.betOutcome, 'won');
  assert.equal(settled.evaluationRule, 'manual_verified_half_time_score');
  assert.equal(settled.manualSettlementAudit.overLine, 7.5);
});

test('grades each saved Over line independently from the same half-time score', () => {
  assert.equal(buildManualFirstHalfSettlement(row(1, 'Over 6.5 Goals'), 'now').betOutcome, 'won');
  assert.equal(buildManualFirstHalfSettlement(row(2, 'Over 8.5 Goals'), 'now').betOutcome, 'lost');
});

test('rejects non-allowlisted alerts, wrong fixture, non-AI, second-half, Asian, and already-settled rows', () => {
  assert.throws(() => buildManualFirstHalfSettlement({ ...row(0), alert_id: 'other' }, 'now'), /allowlist/);
  assert.throws(() => buildManualFirstHalfSettlement({ ...row(0), event_id: 'wrong' }, 'now'), /fixture/);
  assert.throws(() => buildManualFirstHalfSettlement({ ...row(0), level: 'VIP' }, 'now'), /AI alerts/);
  assert.throws(() => buildManualFirstHalfSettlement({ ...row(0), payload: { ...row(0).payload, periodAtSignal: 'second_half' } }, 'now'), /first-half/);
  assert.throws(() => buildManualFirstHalfSettlement({ ...row(0), payload: { ...row(0).payload, lineType: 'asian' } }, 'now'), /Asian/);
  assert.throws(() => buildManualFirstHalfSettlement({ ...row(0), payload: { ...row(0).payload, betOutcome: 'won' } }, 'now'), /already terminal/);
  assert.throws(() => buildManualFirstHalfSettlement(row(0, 'Over corners'), 'now'), /unambiguous/);
});

test('the repair scope is exactly the four pending alert IDs for the named fixture', () => {
  assert.equal(REPAIR.alertIds.length, 4);
  assert.equal(new Set(REPAIR.alertIds).size, 4);
  assert.equal(REPAIR.eventId, 'sportscore:zp5rzgh3jkpoq82');
});
