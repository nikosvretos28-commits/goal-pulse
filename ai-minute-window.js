"use strict";

function isAiMinuteEligible(minute, status = "") {
  if (!Number.isInteger(minute) || minute < 46 || minute > 88) return false;
  const period = String(status || "").trim().toLowerCase();
  // Completed fixtures must never qualify, even if a provider leaves a stale minute.
  if (/\b(?:finished|full\s*time|ended|complete|completed|ft|aet)\b/.test(period) ||
      /ολοκληρώθηκε|τελικό\s*σφύριγμα|λήξη\s*αγώνα/.test(period)) return false;
  // Explicit first-half or halftime labels override a misleading elapsed clock.
  if (/\b(?:1h|1st\s*half|first\s*half|ht|half[\s-]*time|halftime)\b/.test(period) ||
      /1ο\s*ημίχρονο|πρώτο\s*ημίχρονο|ανάπαυλα|ημίχρονο/.test(period)) return false;
  return true;
}

function isCumulativeSotMinute(minute, status = "") {
  return isAiMinuteEligible(minute, status) && minute < 70;
}


function isFirstHalfCumulativeSotMinute(minute, status = "") {
  if (!Number.isInteger(minute) || minute < 1 || minute >= 35) return false;
  const period = String(status || "").trim().toLowerCase();
  // Completed fixtures and explicit second-half/halftime labels must never qualify.
  if (/\\b(?:finished|full\\s*time|ended|complete|completed|ft|aet|2h|2nd\\s*half|second\\s*half|half[\\s-]*time|halftime|ht)\\b/.test(period) ||
      /ολοκληρώθηκε|τελικό\\s*σφύριγμα|λήξη\\s*αγώνα|2ο\\s*ημίχρονο|δεύτερο\\s*ημίχρονο|ανάπαυλα/.test(period)) return false;
  return true;
}

module.exports = { isAiMinuteEligible, isCumulativeSotMinute, isFirstHalfCumulativeSotMinute };
