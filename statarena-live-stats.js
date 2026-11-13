"use strict";

function normalizeTeamName(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/\b(fc|cf|sc|afc|club|football|soccer|women|woman|ladies|female)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ").trim();
}

function numeric(value) {
  if (value == null || value === "") return null;
  const parsed = Number.parseFloat(String(value).replace("%", "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function statName(row) {
  const type = row?.type;
  return String(
    (type && typeof type === "object" ? type.name || type.label : type) ||
    row?.name || row?.statistic || row?.code || ""
  ).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function statValue(row) {
  return numeric(row?.data?.value ?? row?.value ?? row?.total ?? row?.amount);
}

function normalizeStatArenaMatch(match) {
  if (!match || typeof match !== "object") return null;
  const participants = Array.isArray(match.participants) ? match.participants
    : Array.isArray(match.teams) ? match.teams : [];
  const home = participants.find(p => /home/i.test(String(p?.meta?.location || p?.location || p?.homeAway || p?.side || "")));
  const away = participants.find(p => /away/i.test(String(p?.meta?.location || p?.location || p?.homeAway || p?.side || "")));
  const homeName = home?.name || home?.display_name || match.home?.name || match.home_team?.name || "";
  const awayName = away?.name || away?.display_name || match.away?.name || match.away_team?.name || "";
  if (!homeName || !awayName) return null;

  const homeId = String(home?.id ?? home?.team_id ?? "");
  const awayId = String(away?.id ?? away?.team_id ?? "");
  const rows = Array.isArray(match.statistics) ? match.statistics
    : Array.isArray(match.stats) ? match.stats : [];
  const values = { home: {}, away: {} };
  const aliases = {
    shotsOnTarget: ["shotsontarget", "shotson goal", "shotsongoal", "shotsontarget"],
    totalShots: ["shotstotal", "totalshots", "goalattempts"],
    shotsOffTarget: ["shotsofftarget", "offtargetshots"],
    shotsInBox: ["shotsinsidebox", "shotsinbox", "shotsinsidepenaltyarea"],
    corners: ["corners", "cornerkicks"],
    possession: ["ballpossession", "possession"],
    dangerousAttacks: ["dangerousattacks"],
    bigChances: ["bigchancescreated", "bigchances"]
  };
  const aliasMap = new Map(Object.entries(aliases).flatMap(([key, names]) => names.map(name => [name.replace(/[^a-z0-9]/g, ""), key])));
  for (const row of rows) {
    const key = aliasMap.get(statName(row).replace(/[^a-z0-9]/g, ""));
    const value = statValue(row);
    if (!key || value == null) continue;
    const participantId = String(row?.participant_id ?? row?.participant?.id ?? row?.team_id ?? "");
    const participantName = normalizeTeamName(row?.participant?.name || row?.team?.name || row?.participant_name || "");
    let side = "";
    if (participantId && homeId && participantId === homeId) side = "home";
    else if (participantId && awayId && participantId === awayId) side = "away";
    else if (participantName && participantName === normalizeTeamName(homeName)) side = "home";
    else if (participantName && participantName === normalizeTeamName(awayName)) side = "away";
    if (!side) continue;
    values[side][key] = value;
  }
  return { homeName, awayName, values };
}

module.exports = { normalizeTeamName, normalizeStatArenaMatch };
