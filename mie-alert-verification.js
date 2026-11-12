"use strict";

function isVerifiedSecondHalfMieRecord(record) {
  if (!record || typeof record !== "object") return false;
  const minute = Number(record.minute);
  const finalScore = String(record.finalScore || "");
  return record.period === "second_half" &&
    Number.isInteger(minute) && minute >= 46 && minute <= 88 &&
    ["won", "lost"].includes(String(record.outcome || "").toLowerCase()) &&
    String(record.scoreScope || "") === "full_time" &&
    Boolean(String(record.settlementProvider || "").trim()) &&
    Boolean(String(record.settlementFixtureId || "").trim()) &&
    /^[0-9]+-[0-9]+$/.test(finalScore);
}

module.exports = { isVerifiedSecondHalfMieRecord };
