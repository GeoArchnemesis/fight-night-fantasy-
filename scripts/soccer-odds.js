// ============================================================
//  SOCCER ODDS — The Odds API-დან 1X2 + ტოტალი 2.5 (მედიანა ბукмекерებზე)
//  ცალკე workflow-ით ეშვება (soccer-odds.yml), იშვიათად — 3 დღეში ერთხელ,
//  რადგან The Odds API-ს ლიმიტი აქვს (~500 მოთხოვნა/თვე).
//
//  ESPN აკეთებს fixtures/შედეგებს/settlement-ს (soccer-auto.js, 30წთ).
//  ეს სკრიპტი მხოლოდ კოეფებს ანახლებს მიმდინარე ტურის მიმავალ მატჩებზე.
//
//  team-name matching: The Odds API-ისა და ESPN-ის სახელები უმეტესად ემთხვევა
//  (Alavés, Getafe…); ნაწილობრივი შეუსაბამობისთვის — ნორმალიზაცია + token-overlap.
// ============================================================

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;      // service_role
const ODDS_API_KEY = process.env.ODDS_API_KEY;
const TG_TOKEN     = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT      = process.env.TELEGRAM_CHAT_ID || '';

const REGION   = 'eu';
const ODDS_BASE = 'https://api.the-odds-api.com/v4';

// ლიგის კოდი → The Odds API sport key
const LEAGUES = [
  { code: 'esp1', sport: 'soccer_spain_la_liga' },
  { code: 'eng1', sport: 'soccer_epl' },
  { code: 'ita1', sport: 'soccer_italy_serie_a' },
  { code: 'ger1', sport: 'soccer_germany_bundesliga' },
  { code: 'fra1', sport: 'soccer_france_ligue_one' },
  { code: 'ucl',  sport: 'soccer_uefa_champs_league' },   // სექტემბრამდე არააქტიური — 404/ცარიელი, უვნებელი
];

if (!SUPABASE_URL || !SUPABASE_KEY || !ODDS_API_KEY) {
  console.error('SUPABASE_URL / SUPABASE_KEY / ODDS_API_KEY აუცილებელია'); process.exit(1);
}
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

async function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
  } catch (e) {}
}

// ── team-name matching helpers ──
const STOP = new Set(['fc', 'cf', 'sc', 'afc', 'ac', 'as', 'ss', 'rc', 'cd', 'ud', 'club', 'calcio', 'de', 'the', 'if', 'bk', 'sv']);
function norm(s) {
  return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
function tokens(s) { return norm(s).split(' ').filter(w => w.length > 2 && !STOP.has(w)); }
function overlap(a, b) {
  const A = tokens(a), B = new Set(tokens(b));
  if (!A.length) return 0;
  let c = 0; for (const x of A) if (B.has(x)) c++;
  return c / A.length;
}
// odds-event ↔ db-match დამთხვევა (home & away ორივე უნდა ემთხვეოდეს)
function matchScore(ev, m) {
  const h = Math.max(overlap(ev.home_team, m.home_team), overlap(m.home_team, ev.home_team));
  const a = Math.max(overlap(ev.away_team, m.away_team), overlap(m.away_team, ev.away_team));
  return Math.min(h, a);
}

const median = (arr) => {
  const a = arr.filter(x => typeof x === 'number' && isFinite(x) && x > 1).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : Math.round(((a[mid - 1] + a[mid]) / 2) * 100) / 100;
};

// ერთი odds-event-იდან median 1X2 + median 2.5 ტოტალი
function extractOdds(ev) {
  const home = [], draw = [], away = [], over = [], under = [];
  for (const bk of ev.bookmakers || []) {
    for (const mk of bk.markets || []) {
      if (mk.key === 'h2h') {
        for (const o of mk.outcomes || []) {
          if (o.name === ev.home_team) home.push(o.price);
          else if (o.name === ev.away_team) away.push(o.price);
          else if (o.name === 'Draw') draw.push(o.price);
        }
      } else if (mk.key === 'totals') {
        for (const o of mk.outcomes || []) {
          if (Math.abs((o.point ?? 0) - 2.5) > 0.01) continue;   // მხოლოდ 2.5
          if (o.name === 'Over') over.push(o.price);
          else if (o.name === 'Under') under.push(o.price);
        }
      }
    }
  }
  return {
    x2: { home: median(home), draw: median(draw), away: median(away) },
    ou: { over: median(over), under: median(under) },
  };
}

// ── DB: მატჩის markets-ის განახლება ──
async function upsertEntry(marketId, outcome, label, price) {
  const p = (typeof price === 'number' && isFinite(price)) ? price : null;
  const { data: ex } = await sb.from('soccer_market_entries')
    .select('id').eq('market_id', marketId).eq('outcome', outcome).maybeSingle();
  if (ex) await sb.from('soccer_market_entries').update({ price: p, is_enabled: p != null }).eq('id', ex.id);
  else await sb.from('soccer_market_entries').insert({ market_id: marketId, outcome, label, price: p, is_enabled: p != null });
}

async function applyOdds(match, odds) {
  // 1X2
  let { data: mkt } = await sb.from('soccer_markets')
    .select('id').eq('match_id', match.id).eq('kind', '1x2').maybeSingle();
  if (!mkt && (odds.x2.home != null || odds.x2.draw != null || odds.x2.away != null)) {
    const r = await sb.from('soccer_markets')
      .insert({ match_id: match.id, kind: '1x2', line: null, start_time: match.kickoff, status: 'upcoming' })
      .select('id').maybeSingle();
    mkt = r.data;
  }
  if (mkt) {
    await upsertEntry(mkt.id, '1', 'მასპინძელი', odds.x2.home);
    await upsertEntry(mkt.id, 'x', 'ფრე',        odds.x2.draw);
    await upsertEntry(mkt.id, '2', 'სტუმარი',    odds.x2.away);
  }
  // ტოტალი 2.5
  if (odds.ou.over != null && odds.ou.under != null) {
    let { data: oum } = await sb.from('soccer_markets')
      .select('id').eq('match_id', match.id).eq('kind', 'over_under').maybeSingle();
    if (!oum) {
      const r = await sb.from('soccer_markets')
        .insert({ match_id: match.id, kind: 'over_under', line: 2.5, start_time: match.kickoff, status: 'upcoming' })
        .select('id').maybeSingle();
      oum = r.data;
    } else {
      await sb.from('soccer_markets').update({ line: 2.5 }).eq('id', oum.id);
    }
    if (oum) {
      await upsertEntry(oum.id, 'over',  'მეტი 2.5',    odds.ou.over);
      await upsertEntry(oum.id, 'under', 'ნაკლები 2.5', odds.ou.under);
    }
  }
}

async function activeRoundMatches(leagueCode) {
  const { data: rounds } = await sb.from('soccer_rounds')
    .select('id').eq('league', leagueCode).eq('status', 'upcoming').order('id').limit(1);
  const round = rounds && rounds[0];
  if (!round) return [];
  const { data: matches } = await sb.from('soccer_matches')
    .select('id,home_team,away_team,kickoff,status,is_voided').eq('round_id', round.id);
  const now = Date.now();
  return (matches || []).filter(m => m.status === 'upcoming' && !m.is_voided
    && m.kickoff && new Date(m.kickoff).getTime() > now);
}

async function syncLeague(lg, remainingRef) {
  const matches = await activeRoundMatches(lg.code);
  if (!matches.length) { log(`[${lg.code}] აქტიური ტურის მიმავალი მატჩი არ არის — გამოტოვება`); return { updated: 0, unmatched: 0 }; }

  let events, resp;
  try {
    resp = await fetch(`${ODDS_BASE}/sports/${lg.sport}/odds/?apiKey=${ODDS_API_KEY}&regions=${REGION}&markets=h2h,totals&oddsFormat=decimal`);
    const rem = resp.headers.get('x-requests-remaining');
    if (rem != null) remainingRef.value = rem;
    if (resp.status === 404) { log(`[${lg.code}] The Odds API: ლიგა არააქტიურია (404)`); return { updated: 0, unmatched: 0 }; }
    if (!resp.ok) { log(`[${lg.code}] The Odds API HTTP ${resp.status}`); return { updated: 0, unmatched: 0 }; }
    events = await resp.json();
  } catch (e) { log(`[${lg.code}] The Odds API fetch ჩავარდა: ${e.message}`); return { updated: 0, unmatched: 0 }; }
  if (!Array.isArray(events) || !events.length) { log(`[${lg.code}] კოეფი ჯერ არ დაუდიათ`); return { updated: 0, unmatched: 0 }; }

  let updated = 0;
  const usedEvents = new Set();
  const MATCH_HOURS = 12;   // odds-მატჩი DB-მატჩს დაუკავშირდება მხოლოდ თუ დროც ≤12სთ სხვაობაშია
  for (const m of matches) {
    const mt = new Date(m.kickoff).getTime();
    // საუკეთესო დამთხვევა: გუნდები (≥0.5) და დროც ახლოს
    let best = null, bestScore = 0, bestDiff = Infinity;
    for (const ev of events) {
      if (usedEvents.has(ev.id)) continue;
      const s = matchScore(ev, m);
      if (s < 0.5) continue;
      const diffH = Math.abs(new Date(ev.commence_time).getTime() - mt) / 3.6e6;
      if (!isFinite(diffH) || diffH > MATCH_HOURS) continue;   // დრო არ ემთხვევა → სხვა ტური/თასი
      if (s > bestScore || (s === bestScore && diffH < bestDiff)) { best = ev; bestScore = s; bestDiff = diffH; }
    }
    if (!best) { log(`[${lg.code}] ვერ დაემთხვა (გუნდი/დრო): ${m.home_team} vs ${m.away_team}`); continue; }
    usedEvents.add(best.id);
    const odds = extractOdds(best);
    await applyOdds(m, odds);
    updated++;
  }
  log(`[${lg.code}] განახლდა ${updated}/${matches.length} მატჩი`);
  return { updated, unmatched: matches.length - updated };
}

async function main() {
  log('SOCCER ODDS (The Odds API) — დაიწყო');
  const remainingRef = { value: null };
  let totalUpdated = 0;
  for (const lg of LEAGUES) {
    try { const r = await syncLeague(lg, remainingRef); totalUpdated += r.updated; }
    catch (e) { log(`[${lg.code}] შეცდომა: ${e.message}`); }
  }
  log(`დასრულდა — სულ განახლდა ${totalUpdated} მატჩი | დარჩენილი მოთხოვნა: ${remainingRef.value ?? '?'}`);
  if (totalUpdated > 0) {
    await sendTelegram(`💹 <b>ფეხბურთის კოეფები განახლდა (The Odds API)</b>\n\n${totalUpdated} მატჩი — 1X2 + ტოტალი 2.5.\nდარჩენილი API მოთხოვნა: ${remainingRef.value ?? '?'}/თვე`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
