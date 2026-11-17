"use strict";

/**
 * Extract an explicit football match minute from provider clock/status fields.
 * Stoppage time is preserved as base+added time (e.g. 90+4′), not converted
 * to 94. Status labels such as HT or "2nd Half" are never mistaken for minutes.
 */
function normalizeLiveMinute(...candidates) {
  for (const candidate of candidates.flat()) {
    if (candidate === null || candidate === undefined) continue;
    const value = String(candidate).trim();
    if (!value) continue;

    let match = value.match(/(?:^|\b)(\d{1,3})\s*\+\s*(\d{1,2})?(?:\s*['′’]|\s*(?:min|minute)s?)?/i);
    if (match) return Number(match[1]) + "+" + (match[2] === undefined ? "" : Number(match[2])) + "′";

    match = value.match(/(?:^|\b)(\d{1,3}):\d{2}\b/);
    if (match) return Number(match[1]) + "′";

    match = value.match(/^\s*(\d{1,3})\s*(['′’]|(?:min|minute)s?)?\s*$/i);
    if (match) return Number(match[1]) + "′";

    match = value.match(/(?:^|\s)(\d{1,3})\s*['′’]/);
    if (match) return Number(match[1]) + "′";
  }
  return null;
}

module.exports = { normalizeLiveMinute };
