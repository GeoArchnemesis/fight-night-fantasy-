// ============================================================
//  SOCCER Fantasy — Zero-Touch Automation (6 ლიგა)
//  GitHub Actions-ით ეშვება. f1-auto.js / nba-auto.js / auto.js-ს არ ეხება.
//
//  წყარო: ESPN site API (fixtures + 1X2 კოეფები + შედეგები) —
//         + ESPN core API (Over/Under, best-effort).
//
//  ლიგები: La Liga, Premier League, Serie A, Bundesliga, Ligue 1, Champions League
//
//  რას აკეთებს ყოველ გაშვებაზე (თითო ლიგაზე):
//   1) processResults() — დასრულებული მატჩების შედეგი / გადადებულის void
//   2) refreshOdds()    — მიმავალი მატჩების 1X2 (+OU) კოეფების განახლება
//   3) settle_soccer_round() — ბილეთების settlement; ტურის ბოლოს reset (RPC-ში)
//   4) createNextRound()— მხოლოდ როცა მიმდინარე ტური აღარ არის upcoming
//
//  ტურის დაჯგუფება: ESPN round-ს არ აბრუნებს → დროზე-დაფუძნებული კლასტერი
//  (ტური = ლიგის გუნდები/2 ყველაზე ადრეული მატჩი).
// ============================================================

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;         // service_role
const TG_TOKEN     = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT      = process.env.TELEGRAM_CHAT_ID || '';

const SEASON          = new Date().getUTCFullYear();
const SITE_BASE       = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const CORE_BASE       = 'https://sports.core.api.espn.com/v2/sports/soccer/leagues';
const WINDOW_PAST_DAYS   = 10;  // შედეგებისთვის უკან (გაზრდილი — გვიანი შედეგი არ დაიკარგოს)
const WINDOW_FUTURE_DAYS = 25;  // fixtures-ისთვის წინ
const ENABLE_OU       = true;   // Over/Under best-effort (ESPN core API)

// ── football-data.org: matchday (ლიგის ოფიციალური ტური) ──
const FD_KEY = process.env.FOOTBALL_DATA_KEY || '';
const FD_CODES = { esp1: 'PD', eng1: 'PL', ita1: 'SA', ger1: 'BL1', fra1: 'FL1', ucl: 'CL' };
// ── შიდა თასები (ESPN) — ლიგის კოდით ინახება, ბალანსი საერთოა ──
const CUPS = {
  esp1: { slug: 'esp.copa_del_rey',    name: 'Copa del Rey' },
  eng1: { slug: 'eng.fa',              name: 'FA Cup' },
  ita1: { slug: 'ita.coppa_italia',    name: 'Coppa Italia' },
  ger1: { slug: 'ger.dfb_pokal',       name: 'DFB Pokal' },
  fra1: { slug: 'fra.coupe_de_france', name: 'Coupe de France' },
  ucl:  null,
};
const _FD_STOP = new Set(['fc','cf','sc','afc','ac','as','ss','rc','cd','ud','club','calcio','de','the','cp','ogc','rcd']);
function _fdNorm(x){ return (x||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim(); }
function _fdTok(x){ return _fdNorm(x).split(' ').filter(w => w.length > 2 && !_FD_STOP.has(w)); }
function _fdOverlap(a,b){ const A=_fdTok(a), B=new Set(_fdTok(b)); if(!A.length) return 0; let c=0; for(const t of A) if(B.has(t)) c++; return c/A.length; }
const _mdCache = {};
async function loadMatchdays(lg){
  const code = FD_CODES[lg.code];
  if (!FD_KEY || !code) return [];
  if (_mdCache[lg.code]) return _mdCache[lg.code];
  try {
    const r = await fetch(`https://api.football-data.org/v4/competitions/${code}/matches?season=${SEASON}`, { headers: { 'X-Auth-Token': FD_KEY } });
    if (!r.ok) { log(`[${lg.code}] football-data HTTP ${r.status}`); _mdCache[lg.code] = []; return []; }
    const j = await r.json();
    const list = (j.matches || []).filter(m => m.matchday != null)
      .map(m => ({ md: m.matchday, h: m.homeTeam.name, a: m.awayTeam.name, d: (m.utcDate || '').slice(0, 10) }));
    _mdCache[lg.code] = list; return list;
  } catch (e) { log(`[${lg.code}] football-data fetch: ${e.message}`); _mdCache[lg.code] = []; return []; }
}
function matchdayOf(fdList, homeName, awayName, dateIso){
  if (!fdList || !fdList.length) return null;
  const D = new Date((dateIso || '').slice(0, 10)).getTime();
  let best = null, bs = 0;
  for (const f of fdList) {
    const dd = Math.abs((D - new Date(f.d).getTime()) / 86400000);
    if (!isFinite(dd) || dd > 1) continue;
    const s = Math.min(Math.max(_fdOverlap(homeName, f.h), _fdOverlap(f.h, homeName)),
                       Math.max(_fdOverlap(awayName, f.a), _fdOverlap(f.a, awayName)));
    if (s > bs) { bs = s; best = f; }
  }
  return (best && bs >= 0.5) ? best.md : null;
}
// ESPN cup event → ქართული ეტაპი
function stageLabel(ev){
  const slug = (ev.season?.slug || ev.competitions?.[0]?.type?.text || '').toLowerCase();
  const map = [['final','ფინალი'],['semi','1/2 ფინალი'],['quarter','1/4 ფინალი'],
    ['round-of-16','1/8 ფინალი'],['round-of-32','1/16 ფინალი'],
    ['fifth','მე-5 რაუნდი'],['fourth','მე-4 რაუნდი'],['third','მე-3 რაუნდი'],
    ['second','მე-2 რაუნდი'],['first','1-ლი რაუნდი'],['preliminary','საკვალიფიკაციო']];
  for (const [k, v] of map) if (slug.includes(k)) return v;
  return null;
}

// მატჩი თითო ტურზე (გუნდები / 2) — ტურის საზღვრის საიმედო განსაზღვრა
// (ESPN round-ს არ აბრუნებს; gap ცუდად მუშაობს, რადგან ჟორნადები ხშირად ზედიზედაა)
const PER_ROUND = { esp1: 10, eng1: 10, ita1: 10, ger1: 9, fra1: 9, ucl: 18 };
const DEFAULT_PER_ROUND = 10;
const ROUND_MAX_GAP_DAYS = 5;   // თუ perRound-მდე ასეთ შუალედს წავაწყდით — ვჩერდებით

// fallback თუ soccer_leagues ცხრილი ვერ წაიკითხა
const LEAGUES_FALLBACK = [
  { code: 'esp1', name: 'La Liga',          espn_slug: 'esp.1' },
  { code: 'eng1', name: 'Premier League',   espn_slug: 'eng.1' },
  { code: 'ita1', name: 'Serie A',          espn_slug: 'ita.1' },
  { code: 'ger1', name: 'Bundesliga',       espn_slug: 'ger.1' },
  { code: 'fra1', name: 'Ligue 1',          espn_slug: 'fra.1' },
  { code: 'ucl',  name: 'Champions League', espn_slug: 'uefa.champions' },
];

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('SUPABASE_URL / SUPABASE_KEY აუცილებელია'); process.exit(1);
}
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── helpers ──────────────────────────────────────────────
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'fnf-soccer-auto' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
  } catch (e) { log(`Telegram: ${e.message}`); }
}

function ymd(d) {
  const y = d.getUTCFullYear(), m = String(d.getUTCMonth() + 1).padStart(2, '0'), day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}
const num = (v) => (typeof v === 'number' && isFinite(v)) ? v : (v != null && isFinite(+v) ? +v : null);
// ამერიკული moneyline → ათწილადი კოეფი
function amToDec(ml) {
  ml = num(ml);
  if (ml == null || ml === 0) return null;
  return Math.round((ml > 0 ? (ml / 100 + 1) : (100 / Math.abs(ml) + 1)) * 100) / 100;
}

// ── ESPN ─────────────────────────────────────────────────
// scoreboard-ს ვიღებთ ~9-დღიან ნაწილებად (cap-ის თავიდან ასაცილებლად), ვაერთიანებთ
async function fetchWindow(slug) {
  const events = [];
  const seen = new Set();
  const start = Date.now() - WINDOW_PAST_DAYS * 86400000;
  const end   = Date.now() + WINDOW_FUTURE_DAYS * 86400000;
  const CHUNK = 9 * 86400000;
  for (let t = start; t < end; t += CHUNK) {
    const from = ymd(new Date(t)), to = ymd(new Date(Math.min(t + CHUNK, end)));
    try {
      const j = await getJSON(`${SITE_BASE}/${slug}/scoreboard?dates=${from}-${to}`);
      for (const e of (j.events || [])) if (!seen.has(e.id)) { seen.add(e.id); events.push(e); }
    } catch (err) { log(`ESPN fetch ${slug} ${from}-${to}: ${err.message}`); }
  }
  return events;
}

// competition-იდan 1X2 ათწილადი კოეფები (Bet365)
function oneX2(comp) {
  const o = (comp.odds || [])[0];
  if (!o) return null;
  const h = num(o.homeTeamOdds?.value), d = num(o.drawOdds?.value), a = num(o.awayTeamOdds?.value);
  if (h == null && d == null && a == null) return null;
  return { home: h, draw: d, away: a };
}

// ESPN core API — 1X2 (american moneyline→decimal, scoreboard-ის სარეზერვო) + Over/Under
async function fetchCoreOdds(slug, eventId) {
  const out = { x2: null, ou: null };
  try {
    const j = await getJSON(`${CORE_BASE}/${slug}/events/${eventId}/competitions/${eventId}/odds`);
    for (const it of (j.items || [])) {
      if (!out.x2) {
        const h = amToDec(it.homeTeamOdds?.moneyLine);
        const d = amToDec(it.drawOdds?.moneyLine);
        const a = amToDec(it.awayTeamOdds?.moneyLine);
        if (h != null || d != null || a != null) out.x2 = { home: h, draw: d, away: a };
      }
      if (!out.ou) {
        const cur = it.current;
        if (cur && cur.over && cur.under) {
          const over  = num(cur.over.decimal ?? cur.over.value);
          const under = num(cur.under.decimal ?? cur.under.value);
          const line  = num(it.overUnder ?? cur.total?.alternateDisplayValue);
          // მხოლოდ 2.5 ხაზი (კოეფი ხაზს უკავშირდება — სხვა ხაზი არ გვინდა)
          if (over && over > 0 && under && under > 0 && line != null && Math.abs(line - 2.5) < 0.01) {
            out.ou = { line: 2.5, over, under };
          }
        }
      }
    }
  } catch (e) { /* best-effort */ }
  return out;
}

// ── DB helpers ───────────────────────────────────────────
async function activeRound(leagueCode) {
  const { data } = await sb.from('soccer_rounds')
    .select('id,round_no,status').eq('league', leagueCode).eq('status', 'upcoming')
    .order('id', { ascending: true }).limit(1);
  return (data && data[0]) || null;
}

async function upsertEntry(marketId, outcome, label, price) {
  const p = num(price);
  const { data: ex } = await sb.from('soccer_market_entries')
    .select('id').eq('market_id', marketId).eq('outcome', outcome).maybeSingle();
  if (ex) {
    await sb.from('soccer_market_entries').update({ price: p, is_enabled: p != null }).eq('id', ex.id);
  } else {
    await sb.from('soccer_market_entries').insert({ market_id: marketId, outcome, label, price: p, is_enabled: p != null });
  }
}

// 1X2 + OU market-ების უზრუნველყოფა ერთ მატჩზე
async function ensureMarkets(lg, matchId, ev) {
  const comp = ev.competitions[0];
  const kickoff = ev.date;

  // scoreboard-ის 1X2 (Bet365); თუ არ არის ან OU გვინდა — core (DraftKings)
  const sbOdds = oneX2(comp);
  let core = { x2: null, ou: null };
  if (!sbOdds || ENABLE_OU) core = await fetchCoreOdds(lg.espn_slug, ev.id);
  const odds = sbOdds || core.x2;

  // 1X2
  let { data: mkt } = await sb.from('soccer_markets')
    .select('id').eq('match_id', matchId).eq('kind', '1x2').maybeSingle();
  if (!mkt) {
    const r = await sb.from('soccer_markets')
      .insert({ match_id: matchId, kind: '1x2', line: null, start_time: kickoff, status: 'upcoming' })
      .select('id').maybeSingle();
    mkt = r.data;
  }
  if (mkt) {
    await upsertEntry(mkt.id, '1', 'მასპინძელი', odds?.home);
    await upsertEntry(mkt.id, 'x', 'ფრე',        odds?.draw);
    await upsertEntry(mkt.id, '2', 'სტუმარი',    odds?.away);
  }

  // Over/Under (best-effort)
  if (ENABLE_OU && core.ou) {
    let { data: oum } = await sb.from('soccer_markets')
      .select('id').eq('match_id', matchId).eq('kind', 'over_under').maybeSingle();
    if (!oum) {
      const r = await sb.from('soccer_markets')
        .insert({ match_id: matchId, kind: 'over_under', line: core.ou.line, start_time: kickoff, status: 'upcoming' })
        .select('id').maybeSingle();
      oum = r.data;
    }
    if (oum) {
      await upsertEntry(oum.id, 'over',  `მეტი ${core.ou.line}`,    core.ou.over);
      await upsertEntry(oum.id, 'under', `ნაკლები ${core.ou.line}`, core.ou.under);
    }
  }
}

// ── ახალი ტურის შექმნა (მხოლოდ როცა აქტიური ტური არ არის) ──
async function createNextRound(lg, events) {
  const pre = events.filter(e => e.status?.type?.state === 'pre')
    .map(e => ({ ev: e, t: new Date(e.date).getTime(), cup: e._cup || null }))
    .filter(x => isFinite(x.t)).sort((a, b) => a.t - b.t);
  const leagueUp = pre.filter(x => !x.cup);
  const cupUp = pre.filter(x => x.cup);
  // ტურს ვქმნით მხოლოდ ლიგის მატჩებზე — თასით რაუნდს არ ვავსებთ (flooding-ის თავიდან აცილება)
  if (!leagueUp.length) { log(`[${lg.code}] ლიგის მომავალი მატჩი არ არის — ტურს არ ვქმნით`); return; }

  // ლიგის კლასტერი (count-based, როგორც იყო). თუ ლიგას მატჩი არ აქვს — თასით ვიწყებთ.
  const perRound = PER_ROUND[lg.code] || DEFAULT_PER_ROUND;
  const maxGap = ROUND_MAX_GAP_DAYS * 86400000;
  const teamsOf = (ev) => (ev.competitions?.[0]?.competitors || []).map(c => c.team?.id || c.team?.displayName);
  const base = leagueUp;   // ყოველთვის ლიგა
  const seen = new Set(); const cluster = [];
  for (const item of base) {
    if (cluster.length >= perRound) break;
    if (cluster.length && (item.t - cluster[cluster.length - 1].t > maxGap)) break;
    const teams = teamsOf(item.ev);
    if (teams.some(id => seen.has(id))) break;
    cluster.push(item); teams.forEach(id => seen.add(id));
  }
  if (!cluster.length) cluster.push(base[0]);

  // თასის მატჩები — მხოლოდ ლიგის ტურის რეალურ პერიოდში (±1 დღე), მაქს. CUP_CAP ცალი (flooding-ის თავიდან აცილება)
  const CUP_CAP = 4;
  const winMin = cluster[0].t - 86400000;
  const winMax = cluster[cluster.length - 1].t + 86400000;
  const items = [...cluster];
  let cupAdded = 0;
  for (const c of cupUp) {
    if (cupAdded >= CUP_CAP) break;
    if (c.t >= winMin && c.t <= winMax && !items.some(x => x.ev.id === c.ev.id)) { items.push(c); cupAdded++; }
  }
  items.sort((a, b) => a.t - b.t);

  // matchday (football-data) → ტურის ნომერი; fallback: count-based
  const fdList = await loadMatchdays(lg);
  let matchday = null;
  const firstLeague = items.find(x => !x.cup);
  if (firstLeague) {
    const c = firstLeague.ev.competitions[0];
    const H = c.competitors.find(z => z.homeAway === 'home')?.team?.displayName;
    const A = c.competitors.find(z => z.homeAway === 'away')?.team?.displayName;
    matchday = matchdayOf(fdList, H, A, firstLeague.ev.date);
  }
  const { data: last } = await sb.from('soccer_rounds')
    .select('round_no').eq('league', lg.code).eq('season', SEASON)
    .order('round_no', { ascending: false }).limit(1).maybeSingle();
  const roundNo = matchday || ((last?.round_no || 0) + 1);
  const name = `${lg.name} — ტური ${roundNo}`;

  const { data: r, error } = await sb.from('soccer_rounds')
    .insert({ league: lg.code, season: SEASON, round_no: roundNo, name, status: 'upcoming' })
    .select('id').maybeSingle();
  if (error || !r) { log(`[${lg.code}] round insert error: ${error?.message}`); return; }

  let created = 0, cupCreated = 0;
  for (const item of items) {
    const ev = item.ev; const comp = ev.competitions[0];
    const home = comp.competitors.find(c => c.homeAway === 'home');
    const away = comp.competitors.find(c => c.homeAway === 'away');
    if (!home || !away) continue;

    const { data: exist } = await sb.from('soccer_matches')
      .select('id').eq('league', lg.code).eq('espn_id', ev.id).maybeSingle();
    if (exist) continue;

    const competition = item.cup ? item.cup.name : lg.name;
    const stage = item.cup ? stageLabel(ev) : null;

    const { data: m } = await sb.from('soccer_matches').insert({
      round_id: r.id, league: lg.code, espn_id: ev.id,
      home_team: home.team.displayName, away_team: away.team.displayName,
      home_abbr: home.team.abbreviation || null, away_abbr: away.team.abbreviation || null,
      home_logo: home.team.logo || null, away_logo: away.team.logo || null,
      home_color: home.team.color || null, away_color: away.team.color || null,
      venue: comp.venue?.fullName || null, kickoff: ev.date, status: 'upcoming',
      competition, stage,
    }).select('id').maybeSingle();
    if (!m) continue;

    await ensureMarkets(lg, m.id, ev);
    if (item.cup) cupCreated++; else created++;
  }

  const cupName = CUPS[lg.code]?.name || 'თასი';
  await sendTelegram(
    `⚽️ <b>${lg.name} — ახალი ტური (${roundNo})</b>\n\n${created} ლიგის მატჩი` +
    (cupCreated ? ` + ${cupCreated} ${cupName} მატჩი` : '') +
    `.\nკოეფები ავტომატურად აიტვირთა.`
  );
  log(`[${lg.code}] ტური ${roundNo} — ${created} ლიგა + ${cupCreated} თასი`);
}

// ── მიმდინარე ტურის მატჩების ფერების/emblema-ს backfill ──
// (კოეფებს The Odds API ანახლებს — soccer-odds.js, 3 დღეში ერთხელ; ESPN კოეფი მხოლოდ
//  მატჩის შექმნისას ჩაიდება. აქ 30-წუთიან ESPN-განახლებას აღარ ვაკეთებთ, რომ
//  The Odds API-ის მნიშვნელობები არ გადავაწეროთ.)
async function refreshOdds(lg, round, events) {
  const { data: matches } = await sb.from('soccer_matches')
    .select('id,espn_id,status,is_voided,kickoff,home_color,away_color').eq('round_id', round.id);
  for (const mt of matches || []) {
    if (mt.status === 'completed' || mt.is_voided) continue;
    if (mt.kickoff && new Date(mt.kickoff).getTime() <= Date.now()) continue; // დაწყებულს არ ვეხებით
    if (mt.home_color != null && mt.away_color != null) continue;             // ფერი უკვე აქვს
    const ev = events.find(e => e.id === mt.espn_id);
    if (!ev) continue;
    const comp = ev.competitions[0];
    const h = comp.competitors.find(c => c.homeAway === 'home');
    const a = comp.competitors.find(c => c.homeAway === 'away');
    const upd = {};
    if (h?.team?.color) upd.home_color = h.team.color;
    if (a?.team?.color) upd.away_color = a.team.color;
    if (h?.team?.logo) upd.home_logo = h.team.logo;
    if (a?.team?.logo) upd.away_logo = a.team.logo;
    if (Object.keys(upd).length) await sb.from('soccer_matches').update(upd).eq('id', mt.id);
  }
}

// ── შედეგები / void ──
async function voidMatch(matchId) {
  await sb.from('soccer_matches').update({ status: 'completed', is_voided: true }).eq('id', matchId);
  await sb.from('soccer_markets').update({ status: 'completed', is_voided: true }).eq('match_id', matchId);
}

async function processResults(lg, round, events) {
  const { data: matches } = await sb.from('soccer_matches')
    .select('id,espn_id,status,is_voided,home_team,away_team').eq('round_id', round.id);
  for (const mt of matches || []) {
    if (mt.status === 'completed' || mt.is_voided) continue;
    let ev = events.find(e => e.id === mt.espn_id);
    if (!ev) {
      // fallback — გუნდების სახელით (espn_id შეიძლება ძველი/შეცვლილი იყოს)
      const _n = (x) => (x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
      const key = [_n(mt.home_team), _n(mt.away_team)].sort().join('|');
      ev = events.find(e => {
        const c = e.competitions?.[0]; if (!c) return false;
        const nm = (c.competitors || []).map(z => _n(z.team?.displayName)).filter(Boolean).sort().join('|');
        return nm === key;
      });
    }
    // გადადება/გადატანა: DB-ის kickoff გავიდა >2 დღით, ESPN კი ან აღარ აჩვენებს, ან მომავალში გადაიტანა (pre) → void
    const _dbT = mt.kickoff ? new Date(mt.kickoff).getTime() : 0;
    const _staleDays = _dbT ? (Date.now() - _dbT) / 86400000 : 0;
    if (_staleDays > 2 && (!ev || ev.status?.type?.state === 'pre')) {
      await voidMatch(mt.id);
      await sendTelegram(`⚖️ <b>მატჩი ნეიტრალდა (გადაიდო/გადაიტანა)</b>\n\n${lg.name}: ${mt.home_team} vs ${mt.away_team}\n➡️ stake settlement-ზე დაბრუნდება.`);
      log(`[${lg.code}] void (გადადება/გადატანა): ${mt.home_team} vs ${mt.away_team}`);
      continue;
    }
    if (!ev) continue;

    const t = ev.status?.type || {};
    const stName   = (t.name || '').toUpperCase();
    const stDetail = (t.description || '').toLowerCase();

    // გადადება / გაუქმება → void
    if (stName.includes('POSTPON') || stName.includes('CANCEL') ||
        stDetail.includes('postpon') || stDetail.includes('cancel')) {
      await voidMatch(mt.id);
      await sendTelegram(`⚖️ <b>მატჩი ნეიტრალდა (გადაიდო/გაუქმდა)</b>\n\n${lg.name}: ${mt.home_team} vs ${mt.away_team}\n➡️ stake settlement-ზე დაბრუნდება.`);
      log(`[${lg.code}] void: ${mt.home_team} vs ${mt.away_team}`);
      continue;
    }

    if (t.state !== 'post') continue;  // ჯერ არ დასრულებულა

    const comp = ev.competitions[0];
    const home = comp.competitors.find(c => c.homeAway === 'home');
    const away = comp.competitors.find(c => c.homeAway === 'away');
    const hs = parseInt(home?.score, 10), as = parseInt(away?.score, 10);
    if (Number.isNaN(hs) || Number.isNaN(as)) continue;

    const res1x2 = hs > as ? '1' : (hs < as ? '2' : 'x');
    await sb.from('soccer_matches')
      .update({ status: 'completed', result: res1x2, home_score: hs, away_score: as })
      .eq('id', mt.id);

    const { data: mkts } = await sb.from('soccer_markets')
      .select('id,kind,line,is_voided').eq('match_id', mt.id);
    for (const mk of mkts || []) {
      if (mk.is_voided) continue;
      if (mk.kind === '1x2') {
        await sb.from('soccer_markets').update({ status: 'completed', result_outcome: res1x2 }).eq('id', mk.id);
      } else if (mk.kind === 'over_under' && mk.line != null) {
        const outcome = (hs + as) > Number(mk.line) ? 'over' : 'under';  // .5 ხაზი → push არ არის
        await sb.from('soccer_markets').update({ status: 'completed', result_outcome: outcome }).eq('id', mk.id);
      }
    }
    log(`[${lg.code}] შედეგი: ${mt.home_team} ${hs}-${as} ${mt.away_team} → ${res1x2}`);
  }
}

// ── ერთი ლიგის სრული ციკლი ──
async function syncLeague(lg) {
  const leagueEvents = await fetchWindow(lg.espn_slug);
  const cup = CUPS[lg.code];
  let cupEvents = [];
  if (cup) { try { cupEvents = (await fetchWindow(cup.slug)).map(e => { e._cup = cup; return e; }); } catch (e) {} }
  const events = [...leagueEvents, ...cupEvents];   // თასის მატჩებიც (espn_id-ით მუშაობს results/odds)
  if (!events.length) { log(`[${lg.code}] ESPN-მ მოვლენა არ დააბრუნა`); }

  let round = await activeRound(lg.code);

  if (round) {
    await processResults(lg, round, events);
    await refreshOdds(lg, round, events);
    const { data: res } = await sb.rpc('settle_soccer_round', { p_round_id: round.id });
    if (res && (res.won || res.lost || res.voided)) {
      log(`[${lg.code}] settle: won ${res.won}, lost ${res.lost}, void ${res.voided}, skip ${res.skipped}`);
    }
    if (res && res.round_completed) {
      await sendTelegram(`🏁 <b>${lg.name} — ტური დასრულდა</b>\n\nბალანსი განულდა (1000). settlement: ✅ ${res.won} მოგება / ❌ ${res.lost} წაგება.`);
      log(`[${lg.code}] ტური დასრულდა → reset`);
      round = null;   // ამავე გაშვებაზე შემდეგი ტური შეიქმნება
    } else {
      round = await activeRound(lg.code);
    }
  }

  if (!round) {
    await createNextRound(lg, events);
  }
}

async function loadLeagues() {
  const { data } = await sb.from('soccer_leagues')
    .select('code,name,espn_slug,is_active,sort_order').order('sort_order', { ascending: true });
  const rows = (data || []).filter(l => l.is_active !== false);
  return rows.length ? rows : LEAGUES_FALLBACK;
}

async function main() {
  log('SOCCER auto — დაიწყო');
  const leagues = await loadLeagues();
  for (const lg of leagues) {
    try { await syncLeague(lg); }
    catch (e) { log(`[${lg.code}] შეცდომა: ${e.message}`); }
  }
  log('SOCCER auto — დასრულდა');
}

main().catch(e => { console.error(e); process.exit(1); });
