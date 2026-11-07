'use strict';

function scoreNumber(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function isFinished(status, statusText) {
  const state = String(status || '').trim().toLowerCase();
  const label = String(statusText || '').trim().toLowerCase();
  return state === 'post' || /finished|full.?time|ended|final|\bft\b/.test(label);
}

function getPeriodSettlementScore(input = {}) {
  const period = String(input.period || '').toLowerCase();
  const label = String(input.statusText || '').toLowerCase();
  const clock = String(input.minute || '').toLowerCase();
  const finished = isFinished(input.status, label);
  if (period === 'first_half') {
    const home = scoreNumber(input.homeHtScore);
    const away = scoreNumber(input.awayHtScore);
    const confirmedHalfTime = /half.?time|halftime|τέλος\s*(?:του\s*)?ημιχρόνου|^ημίχρονο$/.test(label) || /\bht\b/.test(clock);
    if (home === null || away === null || (!confirmedHalfTime && !finished)) return null;
    return { home, away, total: home + away, scope: 'first_half' };
  }
  if (period === 'second_half') {
    if (!finished) return null;
    const home = scoreNumber(input.homeScore);
    const away = scoreNumber(input.awayScore);
    if (home === null || away === null) return null;
    return { home, away, total: home + away, scope: 'full_time' };
  }
  return null;
}

function parseOverLine(market) {
  const match = String(market || '').match(/\bover\s*(\d+(?:[.,]\d+)?)/i);
  if (!match) return null;
  const line = Number(match[1].replace(',', '.'));
  return Number.isFinite(line) && line >= 0 ? line : null;
}

function gradeOverMarket(totalGoals, line) {
  const total = scoreNumber(totalGoals);
  const target = scoreNumber(line);
  if (total === null || target === null) return null;
  if (total === target && Number.isInteger(target)) return 'push';
  return total > target ? 'won' : 'lost';
}

function normalizeFixtureName(value) {
  return String(value || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/^(?:(?:cd|fc|cf|sc|ac|afc)\s+|club deportivo\s+|deportivo\s+)/, '').trim();
}

function findUniqueCompletedFixture(candidates, alert = {}) {
  const rows = Array.isArray(candidates) ? candidates : [];
  const home = normalizeFixtureName(alert.home);
  const away = normalizeFixtureName(alert.away);
  if (!home || !away) return null;
  const league = normalizeFixtureName(alert.league);
  const date = String(alert.date || '').slice(0, 10);
  const identityMatches = candidate => {
    if (normalizeFixtureName(candidate.home) !== home || normalizeFixtureName(candidate.away) !== away) return false;
    const candidateDate = String(candidate.date || '').slice(0, 10);
    if (date && candidateDate && candidateDate !== date) return false;
    const candidateLeague = normalizeFixtureName(candidate.league);
    if (league && candidateLeague && candidateLeague !== league) return false;
    return true;
  };
  if (alert.eventId != null && String(alert.eventId).trim()) {
    const idMatches = rows.filter(candidate => String(candidate.id ?? '') === String(alert.eventId));
    if (idMatches.length) {
      const exact = idMatches.filter(identityMatches);
      return exact.length === 1 ? exact[0] : null;
    }
  }
  if (!date) return null;
  const exact = rows.filter(candidate => {
    if (!identityMatches(candidate)) return false;
    if (String(candidate.date || '').slice(0, 10) !== date) return false;
    if (league && normalizeFixtureName(candidate.league) !== league) return false;
    return true;
  });
  return exact.length === 1 ? exact[0] : null;
}

module.exports = {
  scoreNumber,
  getPeriodSettlementScore,
  parseOverLine,
  gradeOverMarket,
  normalizeFixtureName,
  findUniqueCompletedFixture
};
