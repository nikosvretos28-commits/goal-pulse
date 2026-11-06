// Separate Late Over historical gate. Does not alter AI/VIP/HI rules.
const OVER_LINES = Object.freeze(["0.5", "1.5", "2.5", "3.5", "4.5", "5.5", "6.5"]);
const MIN_TEAM_SAMPLE = 15;
const MIN_TEAM_RATE = 0.65;
function normalizeOverLine(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const line = number.toFixed(1);
  return OVER_LINES.includes(line) ? line : null;
}
function evaluateLateOverHistory({ line: rawLine, homeProfile, awayProfile }) {
  const line = normalizeOverLine(rawLine);
  if (!line) return { eligible: false, reason: "unsupported-line", line: null, home: null, away: null };
  const inspect = profile => {
    const sample = Number(profile?.matches);
    const rawRate = profile?.overRates?.[line];
    const rate = rawRate == null || rawRate === "" ? null : Number(rawRate);
    const rawLeagueRate = profile?.leagueOverRates?.[line];
    const leagueRate = rawLeagueRate == null || rawLeagueRate === "" ? null : Number(rawLeagueRate);
    const qualifies = Number.isFinite(sample) && sample >= MIN_TEAM_SAMPLE && Number.isFinite(rate) && rate >= MIN_TEAM_RATE && Number.isFinite(leagueRate) && rate >= leagueRate;
    return { team: String(profile?.teamName || ""), sample: Number.isFinite(sample) ? sample : 0, rate: Number.isFinite(rate) ? rate : null, leagueRate: Number.isFinite(leagueRate) ? leagueRate : null, qualifies };
  };
  const home = inspect(homeProfile), away = inspect(awayProfile);
  const eligible = home.qualifies || away.qualifies;
  let reason = "historical-gate-passed";
  if (!eligible) {
    if (home.sample < MIN_TEAM_SAMPLE && away.sample < MIN_TEAM_SAMPLE) reason = "insufficient-sample";
    else if (home.rate == null || away.rate == null) reason = "missing-exact-line-rate";
    else if (home.leagueRate == null || away.leagueRate == null) reason = "missing-league-baseline";
    else if (home.rate < MIN_TEAM_RATE && away.rate < MIN_TEAM_RATE) reason = "both-teams-below-65-percent";
    else reason = "below-league-average";
  }
  return { eligible, reason, line, home, away };
}
module.exports = { OVER_LINES, MIN_TEAM_SAMPLE, MIN_TEAM_RATE, normalizeOverLine, evaluateLateOverHistory };
