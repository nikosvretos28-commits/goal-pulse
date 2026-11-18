"use strict";

// Shared provider-agnostic live-state recognition for AI Alerts, VIP and Hi Activity.
// Inspect event-level and every competition-level status because providers can
// leave one object stale while updating another.
const LIVE_STATES = new Set([
  "in", "live", "playing", "inplay", "in_play", "in_progress", "inprogress",
  "1h", "2h", "1st_half", "2nd_half", "first_half", "second_half",
  "ht", "halftime", "half_time", "break", "break_time", "interval", "bt",
  "et", "extra_time", "extratime",
  "p", "pen", "pens", "penalties", "penalty", "penalty_shootout", "shootout",
  "overtime", "first_period", "second_period", "third_period", "fourth_period",
  "period_1", "period_2", "period_3", "period_4",
  "q1", "q2", "q3", "q4"
]);

const LIVE_LABEL_PATTERN = /(?:^|_)(?:in_progress|inprogress|inplay|in_play|first_half|second_half|1st_half|2nd_half|half_time|halftime|1h|2h|extra_time|extratime|penalties|penalty_shootout|shootout|overtime|first_period|second_period|third_period|fourth_period|period_[1-4]|q[1-4])(?:_|$)/;

function normalizeStatus(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/^status_/, "");
}

function isLiveEvent(event) {
  if (!event || typeof event !== "object") return false;
  const competitions = Array.isArray(event.competitions) ? event.competitions : [];
  const statusTypes = [
    event.status?.type,
    ...competitions.map(competition => competition?.status?.type)
  ].filter(status => status && typeof status === "object");

  const values = statusTypes.flatMap(status => [
    status.state, status.name, status.description, status.detail, status.shortDetail
  ]).filter(value => value != null).map(normalizeStatus);

  return values.some(value => LIVE_STATES.has(value) || LIVE_LABEL_PATTERN.test(value));
}

const liveStateApi = { isLiveEvent, normalizeStatus };
if (typeof module !== "undefined" && module.exports) module.exports = liveStateApi;
if (typeof window !== "undefined") window.GoalMatrixLiveState = liveStateApi;
