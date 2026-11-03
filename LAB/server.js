// GoalMatrix LAB-only live feed proxy. Read-only public ESPN endpoints; no production imports or writes.
const http = require('node:http');\nconst fs = require('node:fs');\nconst path = require('node:path');
const { URL } = require('node:url');
const PORT = Number(process.env.PORT || 3000);
const LEAGUES = [
  ['eng.1','Premier League'],['esp.1','La Liga'],['ita.1','Serie A'],['ger.1','Bundesliga'],
  ['fra.1','Ligue 1'],['gre.1','Greek Super League'],['ned.1','Eredivisie'],['por.1','Primeira Liga'],
  ['sco.1','Scottish Premiership'],['tur.1','Turkish Super Lig'],['uefa.champions','UEFA Champions League'],
  ['uefa.europa','UEFA Europa League'],['uefa.europa.conf','UEFA Conference League'],['usa.1','MLS'],
  ['mex.1','Liga MX'],['bra.1','Brazil Serie A'],['arg.1','Argentina Primera'],['aus.1','A-League'],
  ['jpn.1','J1 League'],['kor.1','K League 1'],['sau.1','Saudi Pro League']
];
const leagueMap = new Map(LEAGUES.map(([code,name])=>[code,name]));
const cache = new Map();
const TTL = 25000;
const headers = {'Accept':'application/json, text/plain, */*','User-Agent':'Mozilla/5.0 GoalMatrix-LAB/1.0','Referer':'https://www.espn.com/soccer/'};
const send=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Access-Control-Allow-Origin':'*','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
const num=v=>{if(v===null||v===undefined||v==='')return null;const n=Number(String(v).replace('%',''));return Number.isFinite(n)?n:null;};
async function json(url,timeout=9000){const r=await fetch(url,{headers,signal:AbortSignal.timeout(timeout)});if(!r.ok)throw new Error('provider_http_'+r.status);return r.json();}
async function scoreboard(code,date){
 const url='https://site.api.espn.com/apis/site/v2/sports/soccer/'+code+'/scoreboard?dates='+date+'&limit=200';
 let body;try{body=await json(url);}catch(e){body=await json('https://site.web.api.espn.com/apis/site/v2/sports/soccer/'+code+'/scoreboard?dates='+date+'&limit=200');}
 return (body.events||[]).map(e=>{
  const c=e.competitions?.[0], teams=c?.competitors||[], h=teams.find(t=>t.homeAway==='home'), a=teams.find(t=>t.homeAway==='away');
  const state=e.status?.type?.state||c?.status?.type?.state||'unknown';
  return {id:String(e.id),leagueCode:code,league:leagueMap.get(code)||code,home:h?.team?.displayName||h?.team?.name||'Home',away:a?.team?.displayName||a?.team?.name||'Away',homeScore:num(h?.score),awayScore:num(a?.score),status:state,statusText:e.status?.type?.shortDetail||c?.status?.type?.shortDetail||e.status?.type?.description||'',clock:e.status?.displayClock||c?.status?.displayClock||'',period:e.status?.period||c?.status?.period||null,start:e.date||null,live:state==='in'};
 }).filter(x=>x.id);
}
async function liveGames(){
 const date=new Date().toISOString().slice(0,10).replace(/-/g,'');
 const results=await Promise.allSettled(LEAGUES.map(([code])=>scoreboard(code,date)));
 const games=[],errors=[];
 results.forEach((r,i)=>{if(r.status==='fulfilled')games.push(...r.value);else errors.push({league:LEAGUES[i][1],error:r.reason?.message||'unavailable'});});
 games.sort((a,b)=>(Number(b.live)-Number(a.live))||(a.start||'').localeCompare(b.start||''));
 return {provider:'ESPN public scoreboard',retrievedAt:new Date().toISOString(),date,liveCount:games.filter(g=>g.live).length,totalReturned:games.length,leaguesChecked:LEAGUES.length,leaguesFailed:errors,coverageNote:'Coverage depends on ESPN competition availability. This feed is experimental; not every league or live statistic is guaranteed.',games};
}
function statValue(stats,aliases){const normalized=s=>String(s||'').toLowerCase().replace(/[^a-z]/g,'');for(const alias of aliases){const x=stats.find(v=>[v.name,v.abbreviation].some(n=>normalized(n)===normalized(alias)));if(x){const n=num(x.displayValue??x.value);if(n!==null)return n;}}return null;}
async function matchStats(code,eventId){
 if(!leagueMap.has(code)||!/^[0-9]+$/.test(eventId))throw new Error('invalid_match_reference');
 let body;const base='https://site.api.espn.com/apis/site/v2/sports/soccer/'+code+'/summary?event='+encodeURIComponent(eventId);
 try{body=await json(base);}catch(e){body=await json('https://site.web.api.espn.com/apis/site/v2/sports/soccer/'+code+'/summary?event='+encodeURIComponent(eventId));}
 const teams=body?.boxscore?.teams||[];
 const values=teams.map(t=>{const s=t.statistics||[];return {team:t.team?.displayName||t.team?.name||'',side:t.homeAway||t.team?.homeAway||'unknown',totalShots:statValue(s,['totalshots','shots','shotsattempted']),shotsOnTarget:statValue(s,['shotsontarget','shotsongoal','sog']),shotsOffTarget:statValue(s,['shotsofftarget','offtargetshots','shotswide']),blockedShots:statValue(s,['blockedshots','shotsblocked']),corners:statValue(s,['woncorners','cornerkicks','corners']),possession:statValue(s,['possessionpct','possession']),xG:statValue(s,['expectedgoals','xg']),saves:statValue(s,['saves','goalkeepersaves']),fouls:statValue(s,['fouls']),yellowCards:statValue(s,['yellowcards']),redCards:statValue(s,['redcards'])};});
 return {provider:'ESPN summary',eventId, retrievedAt:new Date().toISOString(),statisticsAvailable:values.some(t=>Object.entries(t).some(([k,v])=>!['team','side'].includes(k)&&v!==null)),teams:values,missingFields:['rolling_5m_sot','rolling_10m_sot','big_chances','shots_inside_box','xGOT'].filter(k=>!values.some(t=>t[k]!=null)),note:'Only values explicitly supplied by ESPN are returned. Rolling windows and absent fields are not inferred.'};
}
const server=http.createServer(async(req,res)=>{
 const u=new URL(req.url,'http://localhost');
 if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,OPTIONS','Access-Control-Allow-Headers':'Content-Type'});return res.end();}
 if(u.pathname==='/health')return send(res,200,{ok:true,service:'goalmatrix-lab-live-api',mode:'read_only',productionConnected:false});
 if(u.pathname==='/api/live-games'){
  const cached=cache.get('games');if(cached&&Date.now()-cached.at<TTL)return send(res,200,cached.data);
  try{const data=await liveGames();cache.set('games',{at:Date.now(),data});return send(res,200,data);}catch(e){return send(res,502,{error:'live_feed_unavailable',message:e.message,retrievedAt:new Date().toISOString()});}
 }
 if(u.pathname==='/api/match-stats'){
  try{const code=u.searchParams.get('league'),id=u.searchParams.get('event');if(!code||!id)return send(res,400,{error:'league_and_event_required'});const key='stats:'+code+':'+id;const cached=cache.get(key);if(cached&&Date.now()-cached.at<TTL)return send(res,200,cached.data);const data=await matchStats(code,id);cache.set(key,{at:Date.now(),data});return send(res,200,data);}catch(e){return send(res,502,{error:'match_stats_unavailable',message:e.message});}
 }
 if(u.pathname==='/')return send(res,200,{service:'GoalMatrix LAB API',health:'/health',liveGames:'/api/live-games',matchStats:'/api/match-stats?league=eng.1&event=EVENT_ID'});
 send(res,404,{error:'not_found'});
});
server.listen(PORT,'0.0.0.0',()=>console.log('GoalMatrix LAB live API listening on '+PORT));
