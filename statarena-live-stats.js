"use strict";

function normalizeTeamName(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/\b(fc|cf|sc|afc|club|football|soccer|women|woman|ladies|female)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ").trim();
}

function numeric(value) {
  if (value == null || value === "") return null;
  if (typeof value === "object") {
    value = value.value ?? value.total ?? value.amount ?? value.display;
  }
  if (value == null || value === "") return null;
  const parsed = Number.parseFloat(String(value).replace("%", "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function statName(row) {
  const type = row?.type;
  return String(
    (type && typeof type === "object" ? type.name || type.label : type) ||
    row?.name || row?.statistic || row?.code || row?.type_name || ""
  ).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function statValue(row) {
  return numeric(row?.data?.value ?? row?.value ?? row?.total ?? row?.amount);
}

function sideValue(row, side) {
  const data = row?.data;
  const values = row?.values;
  const candidates = [
    row?.[side], row?.[side + "_value"], row?.[side + "Value"],
    data?.[side], data?.[side + "_value"], data?.[side + "Value"],
    values?.[side], values?.[side + "_value"], values?.[side + "Value"]
  ];
  for (const candidate of candidates) {
    const parsed = numeric(candidate);
    if (parsed != null) return parsed;
  }
  return null;
}

function statisticRows(match) {
  const statistics = match?.statistics ?? match?.stats;
  if (Array.isArray(statistics)) return statistics.map(row => ({ row, forcedSide: "" }));
  if (statistics && typeof statistics === "object") {
    const rows = [];
    for (const side of ["home", "away"]) {
      if (Array.isArray(statistics[side])) {
        for (const row of statistics[side]) rows.push({ row, forcedSide: side });
      }
    }
    if (rows.length) return rows;
    return Object.entries(statistics).map(([name, value]) => ({
      row: { name, ...(value && typeof value === "object" ? value : { value }) },
      forcedSide: ""
    }));
  }
  return [];
}

function normalizeStatArenaMatch(match) {
  if (!match || typeof match !== "object") return null;
  const participants = Array.isArray(match.participants) ? match.participants
    : Array.isArray(match.teams) ? match.teams : [];
  const home = participants.find(p => /home/i.test(String(p?.meta?.location || p?.location || p?.homeAway || p?.side || "")));
  const away = participants.find(p => /away/i.test(String(p?.meta?.location || p?.location || p?.homeAway || p?.side || "")));
  const homeName = home?.name || home?.display_name || match.home?.name || match.home_team?.name || match.homeTeam?.name || "";
  const awayName = away?.name || away?.display_name || match.away?.name || match.away_team?.name || match.awayTeam?.name || "";
  if (!homeName || !awayName) return null;

  const homeId = String(home?.id ?? home?.team_id ?? "");
  const awayId = String(away?.id ?? away?.team_id ?? "");
  const values = { home: {}, away: {} };
  const aliases = {
    shotsOnTarget: ["shotsontarget", "shotson goal", "shotsongoal"],
    totalShots: ["shotstotal", "totalshots", "goalattempts"],
    shotsOffTarget: ["shotsofftarget", "offtargetshots"],
    shotsInBox: ["shotsinsidebox", "shotsinbox", "shotsinsidepenaltyarea"],
    corners: ["corners", "cornerkicks"],
    possession: ["ballpossession", "possession"],
    dangerousAttacks: ["dangerousattacks"],
    bigChances: ["bigchancescreated", "bigchances"]
  };
  const aliasMap = new Map(Object.entries(aliases).flatMap(([key, names]) =>
    names.map(name => [name.replace(/[^a-z0-9]/g, ""), key])
  ));

  for (const entry of statisticRows(match)) {
    const row = entry.row;
    const key = aliasMap.get(statName(row));
    if (!key) continue;

    // Some API responses group each statistic into one home/away pair rather
    // than emitting one row per participant. Preserve the provider's side labels.
    const pairedHome = sideValue(row, "home");
    const pairedAway = sideValue(row, "away");
    if (pairedHome != null) values.home[key] = pairedHome;
    if (pairedAway != null) values.away[key] = pairedAway;
    if (pairedHome != null || pairedAway != null) continue;

    const value = statValue(row);
    if (value == null) continue;
    const participantId = String(row?.participant_id ?? row?.participant?.id ?? row?.team_id ?? row?.participantId ?? "");
    const participantName = normalizeTeamName(row?.participant?.name || row?.team?.name || row?.participant_name || "");
    let side = entry.forcedSide;
    if (!side && participantId && homeId && participantId === homeId) side = "home";
    else if (!side && participantId && awayId && participantId === awayId) side = "away";
    else if (!side && participantName && participantName === normalizeTeamName(homeName)) side = "home";
    else if (!side && participantName && participantName === normalizeTeamName(awayName)) side = "away";
    if (side) values[side][key] = value;
  }
  return { homeName, awayName, values };
}

module.exports = { normalizeTeamName, normalizeStatArenaMatch };
