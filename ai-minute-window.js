"use strict";

function isAiMinuteEligible(minute) {
  return Number.isFinite(minute) && minute >= 46 && minute <= 88;
}

function isCumulativeSotMinute(minute) {
  return isAiMinuteEligible(minute) && minute < 70;
}

module.exports = { isAiMinuteEligible, isCumulativeSotMinute };
