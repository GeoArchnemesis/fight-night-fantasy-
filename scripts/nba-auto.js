// ============================================================
//  NBA Fantasy — Zero-Touch Automation Script
//  GitHub Actions / cron-job.org — ყოველ 15-30 წუთში
//
//  რას აკეთებს:
//  1. ESPN-დან მომდევნო 7 დღის თამაშების სინქრონიზაცია (ID-ით, idempotent)
//  2. კოეფების განახლება The Odds API-დან (basketball_nba, h2h) — 6 საათში ერთხელ
//  3. დაწყებული თამაშების შედეგები ESPN-დან (მხოლოდ espn_event_id-ით — სახელის
//     fallback არ არის, UFC-ის #13-ის გაკვეთილი) + settle_nba_tickets RPC
//  4. ორშაბათის (Tbilisi) კვირეული ბალანსის რესეტი — app_state-ის slot-დედუპით
//     (auto.js-ის backup-slot პატერნი): cron drift-ზე მდგრადია და იდემპოტენტურ
//     nba_reset_balances RPC-ს იძახებს
// ============================================================

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const ODDS_API_KEY = process.env.ODDS_API_KEY || '';
const TG_TOKEN     = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT      = process.env.TELEGRAM_CHAT_ID || '';
const ESPN_NBA     = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard';

const SYNC_DAYS_AHEAD = 7;      // რამდენი დღით წინ მოგვაქვს თამაშები
const ODDS_WINDOW_H   = 72;     // კოეფებს ვაახლებთ მხოლოდ ამ ფანჯარაში მყოფ თამაშებზე
const ODDS_REFRESH_H  = 6;      // კოეფის განახლების ინტერვალი (1 API call ფარავს ყველა თამაშს)

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ SUPABASE_URL და SUPABASE_KEY აუცილებელია');
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── HELPERS ──────────────────────────────────────────────────

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

async function fetchJSON(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

async function sendTelegram(msg) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text: msg, parse_mode: 'HTML' }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) { log(`⚠ Telegram: ${e.message}`); }
}

function nameSimilarity(a, b) {
  const norm = s => (s || '').toLowerCase().replace(/[^a-z]/g, ' ').trim().split(/\s+/).filter(Boolean);
  const wa = norm(a), wb = norm(b);
  let matches = 0;
  for (const w of wa) {
    if (wb.some(x => x.startsWith(w.slice(0, 4)) || w.startsWith(x.slice(0, 4)))) matches++;
  }
  return matches / Math.max(wa.length, wb.length, 1);
}

// გუნდის სახელების შედარება: ჯერ ზუსტი (case-insensitive), მერე similarity —
// NBA-ის სახელები სტანდარტიზებულია ("Los Angeles Lakers"), ზუსტი თითქმის ყოველთვის ჭრის
function teamMatch(a, b) {
  const na = (a || '').trim().toLowerCase(), nb = (b || '').trim().toLowerCase();
  if (na && na === nb) return 2;
  return nameSimilarity(a, b);
}

// YYYYMMDD (UTC) — ESPN-ის ?dates= ფორმატისთვის
function espnDate(d) { return d.toISOString().slice(0, 10).replace(/-/g, ''); }

// Tbilisi = UTC+4 მუდმივად (საქართველოში DST არ არის)
function tbilisiNow() { return new Date(Date.now() + 4 * 3600 * 1000); }

// მიმდინარე კვირის ორშაბათის თარიღი Tbilisi-ის დროით (YYYY-MM-DD) — რესეტის slot key
function currentMondayKey() {
  const d = tbilisiNow();
  const day = (d.getUTCDay() + 6) % 7;     // ორშაბათი=0 ... კვირა=6
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

// ── 1. თამაშების სინქრონიზაცია ESPN-დან ─────────────────────

async function syncGames() {
  const from = new Date();
  const to = new Date(Date.now() + SYNC_DAYS_AHEAD * 86400000);
  const url = `${ESPN_NBA}?dates=${espnDate(from)}-${espnDate(to)}&limit=200`;

  let data;
  try { data = await fetchJSON(url); }
  catch (e) { log(`⚠ ESPN sync შეცდომა: ${e.message}`); return; }

  const events = data.events || [];
  if (!events.length) { log('📭 ESPN: მომდევნო 7 დღეში NBA თამაში არ არის'); return; }

  let added = 0, updated = 0, skippedSL = 0;
  for (const ev of events) {
    // Q2: მხოლოდ preseason(1)/regular(2)/postseason(3) — Summer League და
    // სხვა გამოფენითი თამაშები (კოეფი Odds API-ში მათზე არ არის) გამოტოვებულია.
    // + All-Star უიკენდი (თებერვალი): type/slug-ზე დამოუკიდებლად, სახელითაც ვჭერთ.
    const seasonType = ev.season?.type != null ? Number(ev.season.type) : null;   // string "2"-ის დაზღვევა — თორემ მთელი სეზონი ჩუმად გამოიტოვებოდა
    const seasonSlug = (ev.season?.slug || '').toLowerCase();
    const evName = (ev.name || ev.shortName || '').toLowerCase();
    if ((seasonType != null && ![1, 2, 3].includes(seasonType)) || seasonSlug.includes('summer')
        || seasonSlug.includes('all-star') || evName.includes('all-star') || evName.includes('rising stars')) {
      skippedSL++; continue;
    }
    const comp = ev.competitions?.[0];
    if (!comp) continue;
    const home = comp.competitors?.find(c => c.homeAway === 'home');
    const away = comp.competitors?.find(c => c.homeAway === 'away');
    if (!home?.team || !away?.team) continue;

    const row = {
      espn_event_id: String(ev.id),
      home_team: home.team.displayName,
      away_team: away.team.displayName,
      home_abbr: home.team.abbreviation || null,
      away_abbr: away.team.abbreviation || null,
      home_logo: home.team.logo || home.team.logos?.[0]?.href || null,
      away_logo: away.team.logo || away.team.logos?.[0]?.href || null,
      start_time: ev.date,
    };

    // completed/void თამაშს არასდროს ვეხებით — F1-ის #1 ოსცილაციის გაკვეთილი:
    // upsert-ის payload-ში status საერთოდ არ შედის
    const { data: exist } = await sb.from('nba_games')
      .select('id,status,is_voided,start_time').eq('espn_event_id', row.espn_event_id).maybeSingle();

    if (!exist) {
      const { error } = await sb.from('nba_games').insert({ ...row, status: 'upcoming' });
      if (!error) { added++; log(`  🆕 ${row.away_team} @ ${row.home_team} (${row.start_time})`); }
      else log(`  ⚠ insert ${row.espn_event_id}: ${error.message}`);
    } else if (exist.status === 'upcoming' && !exist.is_voided) {
      // მხოლოდ დროისა და გუნდების განახლება (გადადება/ცვლილება), status ხელუხლებელი
      if (new Date(exist.start_time).getTime() !== new Date(row.start_time).getTime()) {
        await sb.from('nba_games').update(row).eq('id', exist.id);
        updated++;
      }
    }
  }
  log(`✅ თამაშები: +${added} ახალი, ${updated} განახლდა (სულ ESPN: ${events.length}${skippedSL ? `, ${skippedSL} გამოტოვდა — Summer League/სხვა` : ''})`);
  if (added > 0) await sendTelegram(`🏀 <b>ახალი NBA თამაშები</b>\n\n+${added} თამაში დაემატა (მომდევნო ${SYNC_DAYS_AHEAD} დღე)`);
}

// ── 2. კოეფების განახლება ────────────────────────────────────

async function updateOdds() {
  if (!ODDS_API_KEY) { log('⏭ Odds API key არ არის — გამოტოვება'); return 0; }

  const nowIso = new Date().toISOString();
  const winIso = new Date(Date.now() + ODDS_WINDOW_H * 3600000).toISOString();
  const { data: games } = await sb.from('nba_games')
    .select('id,home_team,away_team,start_time,odds_updated_at')
    .eq('status', 'upcoming').eq('is_voided', false)
    .gt('start_time', nowIso).lt('start_time', winIso);

  if (!games || !games.length) { log('⏭ კოეფებისთვის თამაში არ არის ფანჯარაში'); return 0; }

  // საჭიროა თუ არა refresh: თუ ყველა თამაშის კოეფი ODDS_REFRESH_H-ზე ახალია — ვტოვებთ
  const staleCutoff = Date.now() - ODDS_REFRESH_H * 3600000;
  const anyStale = games.some(g => !g.odds_updated_at || new Date(g.odds_updated_at).getTime() < staleCutoff);
  if (!anyStale) { log(`⏭ კოეფები ახალია (<${ODDS_REFRESH_H}სთ)`); return 0; }

  // #2 fix: gate ბოლო *მცდელობაზეც* (და არა მხოლოდ წარმატებაზე) — თორემ ერთი
  // ვერ-დამთხვეული თამაში (null odds_updated_at) ყოველ 30 წუთში API call-ს
  // დახარჯავდა (~48/დღე) და უფასო ქვოტა (500/თვე) 10 დღეში ამოიწურებოდა.
  const { data: att } = await sb.from('app_state').select('value').eq('key', 'nba_odds_last_attempt').maybeSingle();
  if (att?.value && Date.now() - new Date(att.value).getTime() < ODDS_REFRESH_H * 3600000) {
    log(`⏭ Odds API-ის ბოლო მცდელობიდან <${ODDS_REFRESH_H}სთ — ვტოვებთ`); return 0;
  }
  await sb.from('app_state').upsert({ key: 'nba_odds_last_attempt', value: new Date().toISOString(), updated_at: new Date().toISOString() });

  let oddsData;
  try {
    oddsData = await fetchJSON(`https://api.the-odds-api.com/v4/sports/basketball_nba/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=h2h&oddsFormat=decimal`);
  } catch (e) { log(`⚠ Odds API შეცდომა: ${e.message}`); return 0; }

  let updated = 0;
  for (const g of games) {
    let best = null, bestScore = 0;
    for (const og of oddsData) {
      const score = teamMatch(og.home_team, g.home_team) + teamMatch(og.away_team, g.away_team);
      if (score > bestScore) { bestScore = score; best = og; }
    }
    if (bestScore < 2.0 || !best) continue;   // ორივე გუნდი მკაცრად უნდა დაემთხვეს

    const preferred = ['pinnacle', 'betonlineag', 'betsson', 'nordicbet', 'coolbet'];
    let bm = null;
    for (const key of preferred) { bm = best.bookmakers?.find(b => b.key === key); if (bm) break; }
    if (!bm) bm = best.bookmakers?.[0];
    const h2h = bm?.markets?.find(m => m.key === 'h2h');
    if (!h2h) continue;

    const homeOdds = h2h.outcomes.find(o => teamMatch(o.name, g.home_team) >= 1)?.price;
    const awayOdds = h2h.outcomes.find(o => teamMatch(o.name, g.away_team) >= 1)?.price;
    if (!homeOdds || !awayOdds) continue;

    await sb.from('nba_games').update({
      home_odds: Math.round(homeOdds * 100) / 100,
      away_odds: Math.round(awayOdds * 100) / 100,
      odds_updated_at: new Date().toISOString(),   // მხოლოდ წარმატებულ განახლებაზე (#8-ის გაკვეთილი)
    }).eq('id', g.id);
    log(`  📊 ${g.away_team} (${awayOdds}) @ ${g.home_team} (${homeOdds})`);
    updated++;
  }
  log(`✅ ${updated}/${games.length} თამაშის კოეფი განახლდა`);
  if (updated > 0) await sendTelegram(`📊 <b>NBA კოეფები განახლდა</b>\n\n${updated}/${games.length} თამაში`);
  return updated;
}

// ── 3. შედეგები + settlement ─────────────────────────────────

async function fetchResultsAndSettle() {
  const nowIso = new Date().toISOString();
  const { data: started } = await sb.from('nba_games')
    .select('id,espn_event_id,home_team,away_team,start_time')
    .eq('status', 'upcoming').eq('is_voided', false).lte('start_time', nowIso);

  if (!started || !started.length) return;
  log(`🔍 ${started.length} დაწყებული თამაშის შედეგის შემოწმება...`);

  // „გაჭედილი" თამაშის ალერტი (ერთხელ თითო თამაშზე): 48სთ+ დაწყებულია და შედეგი არაა —
  // სავარაუდოდ გადაიდო/გაუქმდა და ESPN-იდან event გაქრა → ხელით void-ე ან წაშალე
  try {
    const staleGames = started.filter(g => Date.now() - new Date(g.start_time).getTime() > 48 * 3600000);
    if (staleGames.length) {
      const { data: al } = await sb.from('app_state').select('value').eq('key', 'nba_stale_alerted').maybeSingle();
      const alerted = new Set((al?.value || '').split(',').filter(Boolean));
      const fresh = staleGames.filter(g => !alerted.has(String(g.id)));
      if (fresh.length) {
        await sendTelegram(`⚠️ <b>NBA: ${fresh.length} თამაში 48სთ+ შედეგის გარეშეა</b>\n\n${fresh.map(g => `• ${g.away_team} @ ${g.home_team}`).join('\n')}\n\n➡️ სავარაუდოდ გადაიდო/გაუქმდა — ბაზაში void-ე (is_voided=true) ან წაშალე.`);
        fresh.forEach(g => alerted.add(String(g.id)));
        await sb.from('app_state').upsert({ key: 'nba_stale_alerted', value: [...alerted].slice(-100).join(','), updated_at: new Date().toISOString() });
      }
    }
  } catch (e) { log(`⚠ stale-alert: ${e.message}`); }

  // scoreboard-ის დიაპაზონი: ყველაზე ძველი დაწყებული თამაშიდან ხვალამდე
  // (ESPN თამაშებს აშშ-ის თარიღით აჯგუფებს — ±1 დღის ბუფერი ამიტომ გვჭირდება).
  // lookback cap 3 დღე — „გაჭედილმა" თამაშმა დიაპაზონი უსასრულოდ არ გაზარდოს (limit=200).
  const minComputed = Math.min(...started.map(g => new Date(g.start_time).getTime())) - 86400000;
  const minStart = new Date(Math.max(minComputed, Date.now() - 3 * 86400000));
  const maxD = new Date(Date.now() + 86400000);
  let data;
  try { data = await fetchJSON(`${ESPN_NBA}?dates=${espnDate(minStart)}-${espnDate(maxD)}&limit=200`); }
  catch (e) { log(`⚠ ESPN results შეცდომა: ${e.message}`); return; }

  const byId = new Map((data.events || []).map(ev => [String(ev.id), ev]));
  let written = 0;

  for (const g of started) {
    const ev = byId.get(g.espn_event_id);   // მხოლოდ ID-ით — სახელის fallback არ არის
    if (!ev) continue;
    const comp = ev.competitions?.[0];
    if (!comp || !ev.status?.type?.completed) continue;

    const winnerComp = comp.competitors?.find(c => c.winner === true);
    if (!winnerComp) {
      log(`  ⚠ ${g.away_team} @ ${g.home_team}: completed მაგრამ winner ვერ დადგინდა`);
      await sendTelegram(`⚠️ <b>NBA შედეგი ვერ ჩაიწერა</b>\n\n${g.away_team} @ ${g.home_team}\nESPN completed-ია, winner ველი ცარიელია — ხელით შეამოწმე.`);
      continue;
    }
    const side = winnerComp.homeAway === 'home' ? 'home' : 'away';
    const { error } = await sb.from('nba_games')
      .update({ status: 'completed', result_winner: side }).eq('id', g.id);
    if (!error) {
      written++;
      const winName = side === 'home' ? g.home_team : g.away_team;
      log(`  🏆 ${g.away_team} @ ${g.home_team} → ${winName}`);
    }
  }

  if (written === 0) { log('⏭ ახალი დასრულებული თამაში არ არის'); return; }

  const { data: res, error: settleErr } = await sb.rpc('settle_nba_tickets');
  if (settleErr || !res?.ok) {
    log(`🚨 settle_nba_tickets ჩავარდა: ${res?.error || settleErr?.message}`);
    await sendTelegram(`🚨 <b>NBA Settlement ჩავარდა</b>\n\n<code>${(res?.error || settleErr?.message || '').slice(0, 300)}</code>\n\n➡️ საჭიროა ხელით შემოწმება.`);
    return;
  }
  log(`🏁 Settlement: ✅${res.won} ❌${res.lost} ↩️${res.voided} ⏭${res.skipped}`);
  await sendTelegram(`🏀 <b>NBA შედეგები</b>\n\n${written} თამაში დასრულდა\n\n🏁 Settlement:\n✅ ${res.won} მოგებული\n❌ ${res.lost} წაგებული${res.voided > 0 ? `\n↩️ ${res.voided} void` : ''}\n⏭ ${res.skipped} ელოდება სხვა თამაშებს`);
}

// ── 4. ორშაბათის კვირეული რესეტი ─────────────────────────────

async function weeklyResetIfMonday() {
  const key = currentMondayKey();
  const { data } = await sb.from('app_state').select('value').eq('key', 'nba_last_reset_week').maybeSingle();
  if (data?.value === key) return;   // ეს კვირა უკვე დარესეტებულია

  // slot ჯერ ჩავწეროთ, მერე რესეტი — ორი პარალელური გაშვება ერთსა და იმავე
  // კვირას ორჯერ რომ არ დაარესეტოს (RPC ისედაც იდემპოტენტურია, ეს სპამის დაცვაა)
  await sb.from('app_state').upsert({ key: 'nba_last_reset_week', value: key, updated_at: new Date().toISOString() });

  const { data: res, error } = await sb.rpc('nba_reset_balances');
  if (error || !res?.ok) {
    // #1 fix: slot-ს ვაუქმებთ, რომ მომდევნო cron-გაშვებამ თავიდან სცადოს —
    // თორემ ერთი ჩავარდნა მთელი კვირის რესეტს უხმაუროდ გამოტოვებდა.
    // RPC იდემპოტენტურია, ამიტომ განმეორებითი ცდა უსაფრთხოა.
    await sb.from('app_state').delete().eq('key', 'nba_last_reset_week');
    log(`🚨 nba_reset_balances ჩავარდა: ${res?.error || error?.message} — slot გაუქმდა, ვცდით შემდეგ გაშვებაზე`);
    await sendTelegram(`🚨 <b>NBA კვირეული რესეტი ჩავარდა</b>\n\n<code>${(res?.error || error?.message || '').slice(0, 300)}</code>\n\n🔁 ავტომატურად ვცდით შემდეგ გაშვებაზე (30 წთ).`);
    return;
  }
  log(`💰 კვირეული რესეტი (${key}): ${res.reset} მომხმარებელი → 1,000`);
  await sendTelegram(`💰 <b>NBA კვირეული რესეტი</b> (ორშაბათი ${key})\n\n${res.reset} მომხმარებელი → 1,000${res.deducted_users ? `\n${res.deducted_users}-ს pending ჩამოეჭრა` : ''}`);
}

// ── MAIN ─────────────────────────────────────────────────────

async function main() {
  log('🏀 NBA auto — დაწყება');
  try {
    await weeklyResetIfMonday();
    await syncGames();
    await updateOdds();
    await fetchResultsAndSettle();
    log('✅ NBA auto — დასრულდა');
  } catch (e) {
    log(`🚨 Fatal: ${e.message}`);
    await sendTelegram(`🚨 <b>nba-auto.js ჩავარდა (Fatal error)</b>\n\n<code>${(e.message || String(e)).slice(0, 500)}</code>\n\n➡️ საჭიროა ხელით შემოწმება.`);
    process.exit(1);
  }
}

main();
