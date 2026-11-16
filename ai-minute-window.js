"use strict";

function isAiMinuteEligible(minute, status = "") {
  if (!Number.isInteger(minute) || minute < 46 || minute > 84) return false;
  const period = String(status || "").trim().toLowerCase();
  // Completed fixtures must never qualify, even if a provider leaves a stale minute.
  if (/\b(?:finished|full\s*time|ended|complete|completed|ft|aet)\b/.test(period) ||
      /ολοκληρώθηκε|τελικό\s*σφύριγμα|λήξη\s*αγώνα/.test(period)) return false;
  // Explicit first-half or halftime labels override a misleading elapsed clock.
  if (/\b(?:1h|1st\s*half|first\s*half|ht|half[\s-]*time|halftime)\b/.test(period) ||
      /1ο\s*ημίχρονο|πρώτο\s*ημίχρονο|ανάπαυλα|ημίχρονο/.test(period)) return false;
  return true;
}

// First-half rolling SOT triggers use the same independently qualifying 5m/10m
// thresholds as the second half, but only during live first-half minutes 1–34.
function isFirstHalfSotMinute(minute, status = "") {
  if (!Number.isInteger(minute) || minute < 1 || minute > 34) return false;
  const period = String(status || "").trim().toLowerCase();
  if (/\b(?:finished|full\s*time|ended|complete|completed|ft|aet|2h|2nd\s*half|second\s*half|second_half|ht|half[\s-]*time|halftime)\b/.test(period) ||
      /ολοκληρώθηκε|τελικό\s*σφύριγμα|λήξη\s*αγώνα|δεύτερο\s*ημίχρονο|2ο\s*ημίχρονο|ανάπαυλα|ημίχρονο/.test(period)) return false;
  if (/\b(?:1h|1st\s*half|first\s*half|first_half)\b/.test(period) ||
      /1ο\s*ημίχρονο|πρώτο\s*ημίχρονο/.test(period)) return true;
  // ESPN can provide the elapsed clock as statusText (for example "31'") and
  // the authoritative event state separately as "in". Accept that explicit
  // live state, but never a halftime/finished/second-half label rejected above.
  return !period || /\b(?:live|in)\b/.test(period);
}

function isCumulativeSotMinute(minute, status = "") {
  // The cumulative 20+ combined-SOT trigger is limited to match minutes 1–65:
  // first-half minutes 1–34 and second-half minutes 46–65. Other AI triggers
  // retain their own eligible windows; this limit applies only to the 20+ SOT path.
  return isFirstHalfSotMinute(minute, status) ||
    (Number.isInteger(minute) && minute <= 65 && isAiMinuteEligible(minute, status));
}

// Independent first-half AI trigger: 8+ combined match SOT by minute 34.
function isFirstHalfEightSotMinute(minute, status = "") {
  if (!Number.isInteger(minute) || minute < 1 || minute > 34) return false;
  const period = String(status || "").trim().toLowerCase();
  if (/\b(?:finished|full\s*time|ended|complete|completed|ft|aet|2h|2nd\s*half|second\s*half|ht|half[\s-]*time|halftime)\b/.test(period) ||
      /ολοκληρώθηκε|τελικό\s*σφύριγμα|λήξη\s*αγώνα|δεύτερο\s*ημίχρονο|2ο\s*ημίχρονο|ανάπαυλα/.test(period)) return false;
  if (/\b(?:1h|1st\s*half|first\s*half)\b/.test(period) ||
      /1ο\s*ημίχρονο|πρώτο\s*ημίχρονο/.test(period)) return true;
  // ESPN can provide the elapsed clock as statusText (for example "31'") and
  // the authoritative event state separately as "in". Accept that explicit
  // live state, but never a halftime/finished/second-half label rejected above.
  return !period || /\b(?:live|in)\b/.test(period);
}

module.exports = { isAiMinuteEligible, isCumulativeSotMinute, isFirstHalfSotMinute, isFirstHalfEightSotMinute };
