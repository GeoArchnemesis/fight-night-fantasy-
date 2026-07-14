// ============================================================
//  F1 Fantasy — Zero-Touch Automation (ცალკე UFC-სგან)
//  GitHub Actions-ით ეშვება. auto.js-ს არ ეხება.
//
//  წყაროები:
//   - Cloudbet (motorsport) → კოეფები: რბოლის + კვალიფიკაციის გამარჯვებული
//   - OpenF1 → განრიგი (meeting/sessions) + შედეგები (session_result)
//   - jolpica → (ცალკე, drivers-ის ხელით განახლებისთვის; აქ არ გამოიყენება)
//
//  რას აკეთებს ყოველ გაშვებაზე:
//   1) settleFinished() — დასრულებული რბოლების settlement (OpenF1 შედეგებით)
//   2) syncUpcoming()   — მომდევნო GP: race/quali markets + კოეფების განახლება
// ============================================================

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_KEY     = process.env.SUPABASE_KEY;            // service_role
const CLOUDBET_API_KEY = process.env.CLOUDBET_API_KEY || '';
const TG_TOKEN         = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT          = process.env.TELEGRAM_CHAT_ID || '';

const SEASON      = new Date().getUTCFullYear();
const CB_BASE     = 'https://sports-api.cloudbet.com/pub/v2/odds';
const OPENF1      = 'https://api.openf1.org/v1';
const INCLUDE_THE_FIELD = false;   // Cloudbet-ის "the field" outcome — გამორთული

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('SUPABASE_URL / SUPABASE_KEY აუცილებელია'); process.exit(1);
}
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── helpers ──────────────────────────────────────────────
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

async function getJSON(url, headers) {
  const res = await fetch(url, { headers: headers || {} });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}
const cbGet   = (path) => getJSON(`${CB_BASE}${path}`, { 'X-API-Key': CLOUDBET_API_KEY });
const of1Get  = (path) => getJSON(`${OPENF1}${path}`);

function slugToName(slug) {              // 's-kimi-antonelli' -> 'kimi antonelli'
  return slug.replace(/^s-/, '').replace(/-/g, ' ').trim().toLowerCase();
}

async function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML' }),
    });
  } catch (_) {}
}

// ── Cloudbet: მიმდინარე GP-ის competitions (race + quali) ─────
async function findCloudbetGP() {
  const data = await cbGet('/sports/motorsport');
  let raceComp = null, qualiComp = null;
  for (const cat of data.categories || []) {
    for (const c of cat.competitions || []) {
      const n = (c.name || '').toLowerCase();
      if (/grand prix\s*-\s*qualifying$/.test(n)) qualiComp = c;
      else if (/grand prix$/.test(n) && !/championship/.test(n)) raceComp = c;
    }
  }
  return { raceComp, qualiComp };   // raceComp.name მაგ: "Belgian Grand Prix"
}

// competition-იდან outcome→price რუკა (race winner / quali winner)
async function cloudbetOdds(competitionKey) {
  const d = await cbGet(`/competitions/${competitionKey}`);
  const ev = (d.events || [])[0];
  if (!ev) return [];
  const mkt = ev.markets && ev.markets['motorsport.outright.v3'];
  const sels = mkt && mkt.submarkets && mkt.submarkets.default && mkt.submarkets.default.selections;
  if (!sels) return [];
  return sels
    .filter(s => INCLUDE_THE_FIELD || s.outcome !== 's-the-field')
    .map(s => ({ name: slugToName(s.outcome), slug: s.outcome,
                 price: s.price, probability: s.probability,
                 enabled: s.status === 'SELECTION_ENABLED' }));
}

// ── OpenF1: GP-ის meeting + sessions (race/quali) ─────────────
async function findOpenF1Meeting(gpName) {
  const meetings = await of1Get(`/meetings?year=${SEASON}`);
  const target = gpName.toLowerCase();
  // ზუსტი დამთხვევა meeting_name-ზე, fallback — შემცველობა
  let m = meetings.find(x => (x.meeting_name || '').toLowerCase() === target)
       || meetings.find(x => target.includes((x.meeting_name || '').toLowerCase()))
       || meetings.find(x => (x.meeting_name || '').toLowerCase().includes(target.replace(' grand prix','')));
  if (!m) return null;
  const sessions = await of1Get(`/sessions?meeting_key=${m.meeting_key}`);
  const race  = sessions.find(s => s.session_type === 'Race');
  const quali = sessions.find(s => s.session_type === 'Qualifying');
  return { meeting: m, race, quali };
}

// ── drivers რუკა ──────────────────────────────────────────
async function driverMaps() {
  const { data } = await sb.from('f1_drivers').select('id,name,car_number,slug');
  const byName = {}, byNumber = {};
  for (const d of data || []) {
    byName[(d.name || '').toLowerCase()] = d;
    if (d.car_number != null) byNumber[d.car_number] = d;
  }
  return { byName, byNumber, all: data || [] };
}

// ── SYNC: მომდევნო GP-ის markets + კოეფები ─────────────────
async function syncUpcoming() {
  if (!CLOUDBET_API_KEY) { log('CLOUDBET_API_KEY არ არის — sync გამოტოვდა'); return; }

  const { raceComp, qualiComp } = await findCloudbetGP();
  if (!raceComp) { log('Cloudbet: მიმდინარე GP ვერ მოიძებნა'); return; }
  const gpName = raceComp.name;
  log(`GP: ${gpName}`);

  const of1 = await findOpenF1Meeting(gpName);
  if (!of1 || !of1.race) { log(`OpenF1: "${gpName}"-ის meeting/სესია ვერ მოიძებნა`); return; }

  // f1_races upsert (meeting_key-ით idempotent)
  const raceRow = {
    name: of1.meeting.meeting_name || gpName,
    location: of1.meeting.country_name || null,
    season: SEASON,
    round: null,
    status: 'upcoming',
    openf1_meeting_key: of1.meeting.meeting_key,
  };
  const { data: upRace, error: rErr } = await sb.from('f1_races')
    .upsert(raceRow, { onConflict: 'openf1_meeting_key' })
    .select('id').maybeSingle();
  if (rErr) throw new Error(`f1_races upsert: ${rErr.message}`);
  const raceId = upRace.id;

  // markets: race + quali (start_time + session_key)
  const marketDefs = [
    { kind: 'race',  comp: raceComp,  ses: of1.race },
    { kind: 'quali', comp: qualiComp, ses: of1.quali },
  ].filter(m => m.comp && m.ses);

  const { byName } = await driverMaps();

  for (const md of marketDefs) {
    const { data: upMkt, error: mErr } = await sb.from('f1_markets')
      .upsert({
        race_id: raceId, kind: md.kind, cb_key: md.comp.key,
        start_time: md.ses.date_start, status: 'upcoming',
        openf1_session_key: md.ses.session_key,
      }, { onConflict: 'race_id,kind' })
      .select('id').maybeSingle();
    if (mErr) throw new Error(`f1_markets upsert (${md.kind}): ${mErr.message}`);
    const marketId = upMkt.id;

    // კოეფები
    const odds = await cloudbetOdds(md.comp.key);
    let matched = 0, missed = [];
    for (const o of odds) {
      const drv = byName[o.name];
      if (!drv) { missed.push(o.name); continue; }
      // slug ბაზაში შევინახოთ სამომავლოდ
      if (!drv.slug) await sb.from('f1_drivers').update({ slug: o.slug }).eq('id', drv.id);
      await sb.from('f1_market_entries').upsert({
        market_id: marketId, driver_id: drv.id,
        price: o.price, probability: o.probability,
        is_enabled: o.enabled, updated_at: new Date().toISOString(),
      }, { onConflict: 'market_id,driver_id' });
      matched++;
    }
    log(`  ${md.kind}: ${matched} კოეფი განახლდა${missed.length ? ' | ვერ დაემთხვა: ' + missed.join(', ') : ''}`);
  }
}

// ── SETTLE: დასრულებული რბოლების დამუშავება ────────────────
async function settleFinished() {
  const { data: races } = await sb.from('f1_races')
    .select('id,name,openf1_meeting_key').eq('status', 'upcoming');
  if (!races || races.length === 0) return;

  const now = Date.now();
  const { byNumber } = await driverMaps();

  for (const race of races) {
    const { data: markets } = await sb.from('f1_markets')
      .select('id,kind,start_time,openf1_session_key,result_driver_id,is_voided')
      .eq('race_id', race.id);
    const raceMkt = (markets || []).find(m => m.kind === 'race');
    if (!raceMkt || !raceMkt.start_time) continue;
    // რბოლა უნდა დასრულებულიყო (start + ~3სთ)
    if (now < new Date(raceMkt.start_time).getTime() + 3 * 3600000) continue;

    log(`Settlement: ${race.name}`);

    // შედეგები OpenF1-იდან თითო market-ზე
    for (const m of markets) {
      if (m.result_driver_id || m.is_voided || !m.openf1_session_key) continue;
      let winnerNum = null;
      try {
        const res = await of1Get(`/session_result?session_key=${m.openf1_session_key}`);
        const w = (res || []).find(r => r.position === 1);
        winnerNum = w ? w.driver_number : null;
      } catch (e) { log(`  OpenF1 შედეგი ვერ წამოვიდა (${m.kind}): ${e.message}`); }
      if (winnerNum == null) { log(`  ${m.kind}: შედეგი ჯერ არ არის`); continue; }
      const drv = byNumber[winnerNum];
      if (!drv) { log(`  ${m.kind}: გამარჯვებული #${winnerNum} ბაზაში ვერ მოიძებნა`); continue; }
      await sb.from('f1_markets').update({ result_driver_id: drv.id, status: 'completed' }).eq('id', m.id);
      log(`  ${m.kind}: გამარჯვებული ${drv.name} (#${winnerNum})`);
    }

    await settleTickets(race.id);
  }
}

// tickets settlement — UFC-ის void/win ლოგიკის სარკე
async function settleTickets(raceId) {
  const { data: markets } = await sb.from('f1_markets')
    .select('id,status,result_driver_id,is_voided').eq('race_id', raceId);
  const mMap = {};
  (markets || []).forEach(m => { mMap[m.id] = m; });

  const { data: tickets } = await sb.from('f1_tickets')
    .select('id,stake,total_odds,user_id,f1_selections(id,market_id,driver_id,odds)')
    .eq('race_id', raceId).eq('status', 'pending').is('settled_at', null);
  if (!tickets || tickets.length === 0) { log('  pending F1 ბილეთი არ არის'); return; }

  let won = 0, lost = 0, skip = 0, voided = 0;
  for (const t of tickets) {
    const sels = t.f1_selections || [];
    // per-leg result: true/false/void/null(ჯერ არ დამუშავებული)
    const results = sels.map(s => {
      const m = mMap[s.market_id];
      if (!m) return null;
      if (m.is_voided) return 'void';
      if (m.status !== 'completed' || !m.result_driver_id) return null;
      return s.driver_id === m.result_driver_id;
    });
    if (results.some(r => r === null)) { skip++; continue; }

    const voidIdx = []; results.forEach((r, i) => { if (r === 'void') voidIdx.push(i); });
    const active = results.filter(r => r !== 'void');

    // ყველა leg void → სრული refund
    if (active.length === 0) {
      for (const s of sels) await sb.from('f1_selections').update({ result: 'void' }).eq('id', s.id);
      await sb.from('f1_tickets').update({ status: 'void', settled_at: new Date().toISOString() }).eq('id', t.id);
      try { await sb.rpc('f1_refund_stake', { p_ticket_id: t.id }); }
      catch (e) { log(`  refund RPC ჩავარდა (${t.id}): ${e.message}`); }
      voided++; continue;
    }

    for (let i = 0; i < sels.length; i++) {
      const r = results[i];
      await sb.from('f1_selections').update({ result: r === true ? 'ok' : r === false ? 'no' : 'void' }).eq('id', sels[i].id);
    }

    const anyLost = active.some(r => r === false);
    const status = anyLost ? 'lost' : 'won';

    // void leg-ები კოეფიდან ამოვარდება
    let odds = Number(t.total_odds);
    for (const i of voidIdx) {
      const vo = Number(sels[i].odds) || 1;
      if (vo > 0) odds = odds / vo;
    }
    odds = Math.round(odds * 100) / 100;
    if (voidIdx.length > 0) {
      await sb.from('f1_tickets').update({ total_odds: odds, potential_win: Math.round(Number(t.stake) * odds) }).eq('id', t.id);
    }
    await sb.from('f1_tickets').update({ status, settled_at: new Date().toISOString() }).eq('id', t.id);

    if (status === 'won') {
      const winnings = Math.round(Number(t.stake) * odds);
      await sb.rpc('f1_increment_score', { p_user_id: t.user_id, p_amount: winnings });
      await sb.from('f1_score_history').insert({ user_id: t.user_id, amount: winnings, ticket_id: t.id });
      won++;
    } else lost++;
  }

  // ყველა market დამუშავდა? → რბოლა completed
  const allDone = (markets || []).every(m => m.status === 'completed' || m.is_voided);
  if (allDone) await sb.from('f1_races').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', raceId);

  log(`  settlement: won=${won} lost=${lost} void=${voided} skipped=${skip}`);
}

// ── SYNC standings (rank/points) — car_number-ით (აქცენტებს გვერდს უვლის) ──
async function syncStandings() {
  try {
    const d = await getJSON(`https://api.jolpi.ca/ergast/f1/current/driverstandings/?limit=100`);
    const rows = (((d.MRData || {}).StandingsTable || {}).StandingsLists || [])[0];
    const list = rows ? rows.DriverStandings : [];
    if (!list || !list.length) { log('standings: ცარიელი'); return; }
    let n = 0;
    for (const r of list) {
      const num = parseInt(r.Driver.permanentNumber);
      if (!num) continue;
      await sb.from('f1_drivers')
        .update({ rank: parseInt(r.position), points: parseFloat(r.points) })
        .eq('car_number', num);
      n++;
    }
    log(`standings: ${n} მძღოლის rank/points განახლდა`);
  } catch (e) { log(`standings sync ჩავარდა: ${e.message}`); }
}

// ── main ─────────────────────────────────────────────────
async function main() {
  await settleFinished();
  await syncUpcoming();
  await syncStandings();
}

main()
  .then(() => log('F1 auto finished'))
  .catch(async (e) => {
    log(`Fatal: ${e.message}`);
    await sendTelegram(`🏎️ <b>f1-auto.js ჩავარდა</b>\n<code>${(e.message || String(e)).slice(0, 400)}</code>`);
    process.exit(1);
  });
