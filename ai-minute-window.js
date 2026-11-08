"use strict";

function isAiMinuteEligible(minute, status = "") {
  if (!Number.isInteger(minute) || minute < 46 || minute > 88) return false;
  const period = String(status || "").trim().toLowerCase();
  // Explicit first-half or halftime labels override a misleading elapsed clock.
  if (/\b(?:1h|1st\s*half|first\s*half|ht|half[\s-]*time|halftime)\b/.test(period) ||
      /1ο\s*ημίχρονο|πρώτο\s*ημίχρονο|ανάπαυλα|ημίχρονο/.test(period)) return false;
  return true;
}

function isCumulativeSotMinute(minute, status = "") {
  return isAiMinuteEligible(minute, status) && minute < 70;
}

module.exports = { isAiMinuteEligible, isCumulativeSotMinute };
