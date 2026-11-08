'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { findUniqueCompletedFixture } = require('./settlement');

const alert = {
  home: 'Charleston Battery',
  away: 'Hartford Athletic',
  league: 'USL Championship',
  date: '2026-11-08'
};

test('fixture matching accepts a one-day provider timezone offset when enabled', () => {
  const fixture = {
    id: 'provider-1',
    home: 'Charleston Battery',
    away: 'Hartford Athletic',
    league: 'USL Championship',
    date: '2026-11-07'
  };
  assert.equal(findUniqueCompletedFixture([fixture], { ...alert, dateToleranceDays: 1 }), fixture);
});

test('fixture matching remains exact-date by default', () => {
  const fixture = {
    id: 'provider-1',
    home: 'Charleston Battery',
    away: 'Hartford Athletic',
    league: 'USL Championship',
    date: '2026-11-07'
  };
  assert.equal(findUniqueCompletedFixture([fixture], alert), null);
});

test('fixture matching rejects ambiguous adjacent-date candidates', () => {
  const fixtures = [
    { id: 'provider-1', home: alert.home, away: alert.away, league: alert.league, date: '2026-11-07' },
    { id: 'provider-2', home: alert.home, away: alert.away, league: alert.league, date: '2026-11-08' }
  ];
  assert.equal(findUniqueCompletedFixture(fixtures, { ...alert, dateToleranceDays: 1 }), null);
});

test('a mismatched provider event ID does not block a unique identity match', () => {
  const fixture = {
    id: 'provider-id',
    home: alert.home,
    away: alert.away,
    league: alert.league,
    date: alert.date
  };
  assert.equal(findUniqueCompletedFixture([fixture], { ...alert, eventId: 'different-feed-id' }), fixture);
});

test('fixture matching never swaps home and away teams', () => {
  const fixture = {
    id: 'provider-1',
    home: alert.away,
    away: alert.home,
    league: alert.league,
    date: alert.date
  };
  assert.equal(findUniqueCompletedFixture([fixture], { ...alert, dateToleranceDays: 1 }), null);
});
