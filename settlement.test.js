'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getPeriodSettlementScore,
  parseOverLine,
  gradeOverMarket,
  getProviderFixtureId,
  findUniqueCompletedFixture
} = require('./settlement');

test('first-half settlement uses confirmed half-time score, never full-time score', () => {
  const result = getPeriodSettlementScore({
    period: 'first_half', status: 'post', statusText: 'Final',
    homeScore: 3, awayScore: 2, homeHtScore: 1, awayHtScore: 0
  });
  assert.deepEqual(result, { home: 1, away: 0, total: 1, scope: 'first_half' });
});

test('first-half alert stays pending when half-time score is missing, even if full-time exists', () => {
  assert.equal(getPeriodSettlementScore({
    period: 'first_half', status: 'post', statusText: 'Final',
    homeScore: 3, awayScore: 2, homeHtScore: null, awayHtScore: null
  }), null);
});

test('first-half score is not accepted before half-time is confirmed', () => {
  assert.equal(getPeriodSettlementScore({
    period: 'first_half', status: 'in', statusText: '1st half',
    homeScore: 1, awayScore: 0, homeHtScore: 1, awayHtScore: 0
  }), null);
});

test('second-half settlement requires confirmed full time', () => {
  assert.equal(getPeriodSettlementScore({
    period: 'second_half', status: 'in', statusText: '2nd half', homeScore: 2, awayScore: 1
  }), null);
  assert.deepEqual(getPeriodSettlementScore({
    period: 'second_half', status: 'post', statusText: 'Final', homeScore: 2, awayScore: 1
  }), { home: 2, away: 1, total: 3, scope: 'full_time' });
});

test('Over line parser handles decimal comma and ignores unrelated markets', () => {
  assert.equal(parseOverLine('Over 2,5'), 2.5);
  assert.equal(parseOverLine('Under 2.5'), null);
});

test('Over grading distinguishes win, loss and integer-line push', () => {
  assert.equal(gradeOverMarket(3, 2.5), 'won');
  assert.equal(gradeOverMarket(2, 2.5), 'lost');
  assert.equal(gradeOverMarket(2, 2), 'push');
});

test('fixture fallback requires exact date, orientation, league and a unique match', () => {
  const candidates = [
    { id: '1', date: '2026-11-07', home: 'Alpha FC', away: 'Beta SC', league: 'Premier League', result: 1 },
    { id: '2', date: '2026-11-07', home: 'Alpha FC', away: 'Beta SC', league: 'Cup', result: 2 }
  ];
  assert.equal(findUniqueCompletedFixture(candidates, {
    home: 'Alpha FC', away: 'Beta SC', league: 'Premier League', date: '2026-11-07'
  }).result, 1);
  assert.equal(findUniqueCompletedFixture(candidates, {
    home: 'Beta SC', away: 'Alpha FC', league: 'Premier League', date: '2026-11-07'
  }), null);
  assert.equal(findUniqueCompletedFixture(candidates, {
    home: 'Alpha FC', away: 'Beta SC', date: '2026-11-07'
  }), null);
});

test('normalizes club suffixes used by historical settlement providers', () => {
  const { normalizeFixtureName } = require('./settlement');
  assert.equal(normalizeFixtureName('Puerto Rico Surf SC'), 'puerto rico surf');
  assert.equal(normalizeFixtureName('Academia Quintana'), 'academia quintana');
  assert.equal(normalizeFixtureName('FC Puerto Rico Surf'), 'puerto rico surf');
});

test('normalizes common club prefixes', () => {
  assert.equal(findUniqueCompletedFixture([{id:'x',date:'2026-11-07',home:'Alpha FC',away:'Beta SC',league:'League'}], {
    home:'Alpha',away:'Beta',league:'League',date:'2026-11-07'
  }).id, 'x');
});

test('fixture fallback accepts a league-label mismatch only when teams and date identify one fixture', () => {
  const candidates = [
    { id: 'unique', date: '2026-11-07', home: 'Alpha FC', away: 'Beta SC', league: 'Premier Division' }
  ];
  assert.equal(findUniqueCompletedFixture(candidates, {
    home: 'Alpha', away: 'Beta', league: 'Premier League', date: '2026-11-07'
  }).id, 'unique');
  candidates.push({ id: 'ambiguous', date: '2026-11-07', home: 'Alpha', away: 'Beta', league: 'Cup' });
  assert.equal(findUniqueCompletedFixture(candidates, {
    home: 'Alpha', away: 'Beta', league: 'Premier League', date: '2026-11-07'
  }), null);
});

test('fixture ID match is still checked against the team identity', () => {
  const candidates = [{ id: '123', date: '2026-11-07', home: 'Alpha', away: 'Beta', league: 'League' }];
  assert.equal(findUniqueCompletedFixture(candidates, {
    eventId: '123', home: 'Wrong', away: 'Teams', league: 'League', date: '2026-11-07'
  }), null);
});

test('normalizes common club prefixes', () => {
  assert.equal(findUniqueCompletedFixture([{id:'x',date:'2026-11-07',home:'Alpha FC',away:'Beta SC',league:'League'}], {
    home:'Alpha',away:'Beta',league:'League',date:'2026-11-07'
  }).id, 'x');
});

test('SportScore fixture identity falls back to a stable slug when numeric IDs are absent', () => {
  assert.equal(getProviderFixtureId({ slug: 'alpha-vs-beta-2026-11-08' }), 'alpha-vs-beta-2026-11-08');
  assert.equal(getProviderFixtureId({ match_slug: 'alpha-beta' }), 'alpha-beta');
  assert.equal(getProviderFixtureId({ url: 'https://sportscore.com/match/football/alpha-vs-beta-2026-11-08' }), 'alpha-vs-beta-2026-11-08');
});

test('SportScore fixture identity prefers provider IDs and never fabricates an identity', () => {
  assert.equal(getProviderFixtureId({ id: 123, slug: 'alpha-beta' }), '123');
  assert.equal(getProviderFixtureId({}), '');
});

test('valid Over markets can be settled without a saved start score', () => {
  const { canSettleOverWithoutStartScore } = require('./settlement');
  assert.equal(canSettleOverWithoutStartScore('Over 0.5'), true);
  assert.equal(canSettleOverWithoutStartScore('Over 2,5'), true);
  assert.equal(canSettleOverWithoutStartScore('Over 2.5 corners'), false);
  assert.equal(canSettleOverWithoutStartScore('Under 2.5'), false);
  assert.equal(canSettleOverWithoutStartScore('Over'), false);
});

test('fixture fallback uses kickoff time when both alert and provider expose it', () => {
  const candidates = [
    { id: 'same-day-wrong-time', date: '2026-11-07', kickoffAt: '2026-11-07T10:00:00Z', home: 'Alpha', away: 'Beta', league: 'League' },
    { id: 'right-kickoff', date: '2026-11-07', kickoffAt: '2026-11-07T18:00:00Z', home: 'Alpha', away: 'Beta', league: 'League' }
  ];
  const match = findUniqueCompletedFixture(candidates, {
    home: 'Alpha', away: 'Beta', league: 'League', date: '2026-11-07',
    kickoffAt: '2026-11-07T18:15:00Z'
  });
  assert.equal(match.id, 'right-kickoff');
});

test('fixture fallback rejects kickoff mismatch beyond the four-hour tolerance', () => {
  const candidates = [
    { id: 'wrong-time', date: '2026-11-07', kickoffAt: '2026-11-07T10:00:00Z', home: 'Alpha', away: 'Beta', league: 'League' }
  ];
  assert.equal(findUniqueCompletedFixture(candidates, {
    home: 'Alpha', away: 'Beta', league: 'League', date: '2026-11-07',
    kickoffAt: '2026-11-07T18:00:00Z'
  }), null);
});

test('fixture fallback keeps strict team/date matching when kickoff is missing', () => {
  const candidates = [
    { id: 'no-time', date: '2026-11-07', home: 'Alpha', away: 'Beta', league: 'League' }
  ];
  assert.equal(findUniqueCompletedFixture(candidates, {
    home: 'Alpha', away: 'Beta', league: 'League', date: '2026-11-07',
    kickoffAt: '2026-11-07T18:00:00Z'
  }).id, 'no-time');
});


test('newest pending settlement rows get first provider lookup opportunity', () => {
  const { prioritizeSettlementRows, rotateSettlementRows } = require('./settlement');
  const rows = [
    { id: 'old', created_at: '2026-11-01T00:00:00Z' },
    { id: 'new', created_at: '2026-11-19T03:30:00Z' },
    { id: 'middle', created_at: '2026-11-10T00:00:00Z' }
  ];
  const prioritized = prioritizeSettlementRows(rows);
  assert.deepEqual(prioritized.map(row => row.id), ['new', 'middle', 'old']);
  assert.deepEqual(rotateSettlementRows(prioritized, 0).map(row => row.id), ['new', 'middle', 'old']);
  assert.deepEqual(rotateSettlementRows(prioritized, 1).map(row => row.id), ['middle', 'old', 'new']);
  assert.deepEqual(prioritizeSettlementRows(null), []);
});

test('settlement retry queue rotates first opportunity fairly across pending rows', () => {
  const { rotateSettlementRows } = require('./settlement');
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual([0, 1, 2].map(offset => rotateSettlementRows(rows, offset)[0].id), ['a', 'b', 'c']);
  assert.deepEqual(rotateSettlementRows(rows, 4).map(row => row.id), ['b', 'c', 'a']);
  assert.deepEqual(rotateSettlementRows([], 10), []);
});
