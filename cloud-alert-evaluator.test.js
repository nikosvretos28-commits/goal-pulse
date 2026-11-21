"use strict";
const test=require("node:test"), assert=require("node:assert/strict");
const {evaluateCloudAlert,buildMatrixMetrics,MIN_SCORE,MIN_METRIC_COVERAGE}=require("./cloud-alert-evaluator");
const base={matchId:"m1",period:"1H",elapsedMinute:35,homeSot:11,awaySot:9,recentSot6:4,recentSot10:6,
homeXg:2,awayXg:2,homePsxg:2,awayPsxg:2,homeBigChances:2,awayBigChances:2,homeBoxEntries:15,awayBoxEntries:15,
homeKeyPasses:5,awayKeyPasses:5,homeProgressivePasses:12,awayProgressivePasses:12,homeDangerousAttacks:25,awayDangerousAttacks:25,
homeCorners:5,awayCorners:5,homePossession:51,awayPossession:49,dataQuality:"valid",confirmed:true};
test("20 combined SOT qualifies irrespective of distribution",()=>{for(const [h,a] of [[19,1],[15,5],[10,10]])assert.equal(evaluateCloudAlert({...base,homeSot:h,awaySot:a}).status,"qualified");assert.equal(evaluateCloudAlert({...base,homeSot:10,awaySot:9}).reason,"total_sot_below_20");});
test("minute 1 scan is eligible; minute 70 is not",()=>{assert.equal(evaluateCloudAlert({...base,elapsedMinute:1}).status,"qualified");assert.equal(evaluateCloudAlert({...base,elapsedMinute:70}).reason,"outside_matrix_minute_window");});
test("15 metrics preserve missing values as null",()=>{const m=buildMatrixMetrics({...base,homeXg:null,awayXg:null});assert.equal(Object.keys(m).length,15);assert.equal(m.xgTotal,null);});
test("score threshold and coverage guard are explicit",()=>{assert.equal(MIN_SCORE,75);assert.equal(MIN_METRIC_COVERAGE,8);const r=evaluateCloudAlert({...base,homeXg:null,awayXg:null,homePsxg:null,awayPsxg:null,homeBigChances:null,awayBigChances:null,homeBoxEntries:null,awayBoxEntries:null,homeKeyPasses:null,awayKeyPasses:null,homeProgressivePasses:null,awayProgressivePasses:null,homeDangerousAttacks:null,awayDangerousAttacks:null,homeCorners:null,awayCorners:null,homePossession:null,awayPossession:null});assert.equal(r.reason,"insufficient_metric_coverage");});
test("confirmation and regular time remain mandatory",()=>{assert.equal(evaluateCloudAlert({...base,confirmed:false}).reason,"sot_sample_not_confirmed");assert.equal(evaluateCloudAlert({...base,period:"ET"}).status,"not_applicable");});
