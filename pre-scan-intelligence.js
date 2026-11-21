"use strict";

const FINISHED = /finished|full.?time|ended|completed|\bft\b|shoot.?out|postponed|cancelled|abandoned|ολοκληρώθηκε/i;

function validSot(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function createPreScanTracker({ maxAgeMs = 36 * 60 * 60 * 1000, maxMatches = 5000 } = {}) {
  const matches = new Map();

  function prune(now) {
    for (const [id, state] of matches) {
      if (now - Number(state.lastSeenAt || 0) > maxAgeMs) matches.delete(id);
    }
    if (matches.size > maxMatches) {
      const oldest = [...matches.entries()].sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt);
      for (let i = 0; i < oldest.length - maxMatches; i++) matches.delete(oldest[i][0]);
    }
  }

  function restore(eventId, payload) {
    const id = String(eventId || "");
    if (!id || !payload || typeof payload !== "object") return false;
    const rows = Array.isArray(payload.observations) ? payload.observations.slice(-120) : [];
    if (!rows.length) return false;
    matches.set(id, {
      eventId: id,
      home: String(payload.home || ""),
      away: String(payload.away || ""),
      league: String(payload.league || ""),
      firstSeenAt: Number(payload.firstSeenAt || rows[0].at || Date.now()),
      lastSeenAt: Number(payload.lastSeenAt || rows[rows.length - 1].at || Date.now()),
      observations: rows
    });
    return true;
  }

  function observe(input = {}) {
    const id = String(input.eventId || "");
    const now = Number(input.at || Date.now());
    const minute = Number(input.minute);
    const status = String(input.status || "");
    if (!id || !Number.isFinite(now) || !Number.isFinite(minute) || minute < 1 || minute > 130 || FINISHED.test(status)) return null;
    if (!Array.isArray(input.teams) || input.teams.length !== 2) return null;
    const teams = input.teams.map(team => ({
      team: String(team?.team || "").trim(),
      shotsOnTarget: validSot(team?.shotsOnTarget)
    }));
    // A Pre-Scan observation is valid only when both teams have exact SOT values.
    // Total shots and shots off target are deliberately never read.
    if (teams.some(team => !team.team || team.shotsOnTarget === null)) return null;

    let state = matches.get(id);
    if (!state) {
      state = {
        eventId: id,
        home: String(input.home || ""),
        away: String(input.away || ""),
        league: String(input.league || ""),
        firstSeenAt: now,
        lastSeenAt: now,
        observations: []
      };
      matches.set(id, state);
    }
    if (input.home) state.home = String(input.home);
    if (input.away) state.away = String(input.away);
    if (input.league) state.league = String(input.league);
    const previous = state.observations[state.observations.length - 1] || null;
    const observation = { at: now, minute, teams };
    state.observations.push(observation);
    state.observations = state.observations.filter(row => now - row.at <= maxAgeMs).slice(-120);
    state.lastSeenAt = now;
    prune(now);
    return buildContext(state, previous, observation);
  }

  function buildContext(state, previous = null, latest = null) {
    const rows = state.observations || [];
    const current = latest || rows[rows.length - 1];
    if (!current) return null;
    const first = rows[0] || current;
    const baselineByTeam = new Map(first.teams.map(row => [row.team, row.shotsOnTarget]));
    const currentByTeam = new Map(current.teams.map(row => [row.team, row.shotsOnTarget]));
    const initialSot = Object.fromEntries(first.teams.map(row => [row.team, row.shotsOnTarget]));
    const latestSot = Object.fromEntries(current.teams.map(row => [row.team, row.shotsOnTarget]));
    const deltaSot = Object.fromEntries(current.teams.map(row => [
      row.team,
      Math.max(0, row.shotsOnTarget - (baselineByTeam.get(row.team) ?? row.shotsOnTarget))
    ]));
    return {
      eventId: state.eventId,
      firstSeenAt: state.firstSeenAt,
      lastSeenAt: state.lastSeenAt,
      trackedMinutes: Number(((state.lastSeenAt - state.firstSeenAt) / 60000).toFixed(2)),
      observationCount: rows.length,
      firstMinute: first.minute,
      currentMinute: current.minute,
      initialSot,
      latestSot,
      deltaSot,
      source: "live-scanner-exact-cumulative-sot",
      // Context only: this never changes GPT trigger eligibility or thresholds.
      previousObservationAt: previous?.at || null
    };
  }

  function get(eventId) {
    const state = matches.get(String(eventId || ""));
    return state ? buildContext(state) : null;
  }

  function getState(eventId) {
    const state = matches.get(String(eventId || ""));
    return state ? JSON.parse(JSON.stringify(state)) : null;
  }

  return { observe, restore, get, getState, size: () => matches.size };
}

module.exports = { createPreScanTracker, validSot };
