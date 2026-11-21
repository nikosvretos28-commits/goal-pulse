"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildLiveIntelligenceAnalysis, buildShotDerivedWindow, readMetric, METRICS } = require("./live-intelligence");

function metric(value, extra = {}) { return { available: true, value, source: "test-provider", ...extra }; }
function team({ sot=0, xg=0, box=0 } = {}) {
  return {
    shotsOnTarget: metric(sot), xg: metric(xg), psxg: metric(0),
    bigChances: metric(0), boxEntries: metric(box),
    dangerousAttacks: metric(0), finalThirdEntries: metric(0),
    progressivePasses: metric(0), keyPasses: metric(0),
    matchMomentum: metric(0), defensivePressures: metric(0),
    pressureRecoveries: metric(0), score: metric(0), minute: metric(72),
    numericalAdvantage: metric(0)
  };
}
function window(home, away) { return { home, away }; }

test("exposes an independent 15-metric analysis protocol", () => {
  const result = buildLiveIntelligenceAnalysis({});
  assert.equal(result.protocol, "GOALMATRIX LIVE INTELLIGENCE");
  assert.equal(result.independent, true);
  assert.equal(METRICS.length, 15);
  assert.equal(result.alertDelivery, "not_configured");
});

test("does not convert missing or stale provider data into zero", () => {
  assert.deepEqual(readMetric(null), { status: "unavailable", value: null, source: null, updatedAt: null });
  assert.equal(readMetric({ available: true, value: 0 }).value, 0);
  assert.equal(readMetric({ available: true, value: 4, stale: true }).status, "pending");
  assert.equal(readMetric({ available: true, value: 4, stale: true }).value, null);
});

test("compares last 5, last 10 and match totals team by team", () => {
  const result = buildLiveIntelligenceAnalysis({
    windows: {
      last5: window(team({sot:2,xg:0.4,box:4}), team({sot:0,xg:0.05,box:1})),
      last10: window(team({sot:3,xg:0.7,box:7}), team({sot:0,xg:0.1,box:2}))
    },
    totals: window(team({sot:6,xg:1.2,box:15}), team({sot:2,xg:0.4,box:7}))
  });
  assert.equal(result.windows.last5.comparisons.shotsOnTarget.leader, "home");
  assert.equal(result.windows.last10.comparisons.xg.difference, 0.6);
  assert.equal(result.windows.totals.matchSot, 8);
  assert.equal(result.pressure.status, "sustained_attacking_superiority");
  assert.equal(result.windows.last5.momentum.leader, "home");
});

test("missing coverage remains unavailable and blocks unsupported conclusions", () => {
  const result = buildLiveIntelligenceAnalysis({
    windows: { last5: window(team({box:3}), team({box:1})), last10: window(team(), team()) }
  });
  assert.equal(result.windows.last5.comparisons.xg.status, "unavailable");
  assert.equal(result.windows.last5.teams.home.xg.value, null);
  assert.equal(result.pressure.status, "insufficient_data");
});

test("game-state changes are ordered and unconfirmed events are not described as confirmed", () => {
  const result = buildLiveIntelligenceAnalysis({
    gameState: { score: {home:1,away:0}, minute:72, period:"2H", redCards:{home:0,away:1} },
    events: [
      {type:"red_card",team:"away",timestampSeconds:4000,minute:67,confirmed:true},
      {type:"goal",team:"home",timestampSeconds:4200,minute:70,confirmed:false}
    ],
    windowStartSeconds:3900
  });
  assert.equal(result.gameState.leader, "home");
  assert.equal(result.gameState.numericalAdvantage, "home");
  assert.equal(result.recentGameStateChanges[0].type, "red_card");
  assert.equal(result.recentGameStateChanges[1].description, "Αναμένεται επιβεβαίωση");
});

test("does not treat equal values as a team leader in match momentum inputs", () => {
  const result = buildLiveIntelligenceAnalysis({
    windows: { last5: window(team({sot:1,xg:0.2,box:2}), team({sot:1,xg:0.2,box:2})),
      last10: window(team({sot:2,xg:0.4,box:4}), team({sot:2,xg:0.4,box:4})) }
  });
  assert.equal(result.windows.last5.comparisons.boxEntries.leader, "level");
  assert.equal(result.pressure.status, "balanced_or_unclear");
  assert.equal(result.windows.last5.momentum.status, "neutral");
});

test("builds overlapping 5-minute and 10-minute shot windows from event timestamps", () => {
  const events = [
    {type:"shot",team:"home",timestampSeconds:4100,onTarget:true,xg:0.2,psxg:0.3,bigChance:false},
    {type:"shot",team:"home",timestampSeconds:3800,onTarget:true,xg:0.4,psxg:0.5,bigChance:true},
    {type:"shot",team:"away",timestampSeconds:3700,onTarget:false,xg:0.1,psxg:null,bigChance:false},
    {type:"shot",team:"away",timestampSeconds:3000,onTarget:true,xg:0.3,psxg:0.2,bigChance:false}
  ];
  const last5 = buildShotDerivedWindow(events,{nowSeconds:4200,durationSeconds:300,coverage:{available:true}});
  const last10 = buildShotDerivedWindow(events,{nowSeconds:4200,durationSeconds:600,coverage:{available:true}});
  assert.equal(last5.home.shotsOnTarget,1);
  assert.equal(last10.home.shotsOnTarget,2);
  assert.equal(last10.away.shotsOnTarget,1);
  assert.equal(last10.home.xg,0.6);
  assert.equal(last10.home.psxg,0.8);
  assert.equal(last10.home.bigChances,null);
});

test("does not fabricate zero values when shot-event coverage is unavailable", () => {
  const result = buildShotDerivedWindow([], {nowSeconds:4200,durationSeconds:300,coverage:{available:false}});
  assert.equal(result.available,false);
  assert.equal(result.home.shotsOnTarget,null);
  assert.equal(result.away.xg,null);
});
