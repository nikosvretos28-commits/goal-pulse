const LIVE_HISTORY_TTL_MS = 11 * 60 * 1000;

function addRollingTrends(matches, historyStore, now = Date.now()) {
  if (!(historyStore instanceof Map)) throw new TypeError("historyStore must be a Map");
  for (const match of matches || []) {
    const id = String(match?.eventId || "");
    if (!id || !Array.isArray(match.teams) || match.teams.length < 2) continue;
    let history = historyStore.get(id) || [];
    const last = history[history.length - 1];
    const snapshot = {
      at: now,
      teams: match.teams.map(team => ({
        team: String(team.team || "").trim().toLowerCase(),
        shotsOnTarget: team.shotsOnTarget,
        corners: team.corners,
        attacks: team.attacks,
        dangerousAttacks: team.dangerousAttacks
      }))
    };
    if (!last || now - last.at >= 12000) history.push(snapshot);
    history = history.filter(item => now - item.at <= LIVE_HISTORY_TTL_MS);
    historyStore.set(id, history);

    const makeWindow = minutes => {
      const targetAge = minutes * 60 * 1000;
      const baseline = [...history].reverse().find(item => now - item.at >= targetAge);
      if (!baseline || !last) return { available: false, sampleMinutes: null, teams: [] };
      const deltas = match.teams.map((team, index) => {
        const name = String(team.team || "").trim().toLowerCase();
        const previous = baseline.teams.find(item => item.team && item.team === name) || baseline.teams[index];
        if (!previous) return { team: team.team, shotsOnTarget: null, corners: null, attacks: null, dangerousAttacks: null };
        const delta = key => {
          const current = team[key];
          const old = previous[key];
          if (current == null || old == null || !Number.isFinite(Number(current)) || !Number.isFinite(Number(old))) return null;
          return Math.max(0, Number(current) - Number(old));
        };
        return {
          team: team.team,
          shotsOnTarget: delta("shotsOnTarget"),
          corners: delta("corners"),
          attacks: delta("attacks"),
          dangerousAttacks: delta("dangerousAttacks")
        };
      });
      const available = deltas.some(item =>
        item.shotsOnTarget != null || item.corners != null ||
        item.attacks != null || item.dangerousAttacks != null
      );
      return {
        available,
        sampleMinutes: Math.round((now - baseline.at) / 60000 * 10) / 10,
        teams: deltas
      };
    };
    match.trend = {
      source: "server-observed cumulative-stat deltas",
      window5m: makeWindow(5),
      window10m: makeWindow(10)
    };
  }
  if (historyStore.size > 500) {
    const oldest = [...historyStore.entries()]
      .sort((a, b) => (a[1].at(-1)?.at || 0) - (b[1].at(-1)?.at || 0))
      .slice(0, historyStore.size - 500);
    for (const [id] of oldest) historyStore.delete(id);
  }
}

module.exports = { addRollingTrends };
