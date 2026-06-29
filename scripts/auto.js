globalThis.WebSocket = require('ws');
// ============================================================
//  UFC Fantasy — Zero-Touch Automation Script
//  GitHub Actions-ით ყოველ 30 წუთში ეშვება
//
//  რას აკეთებს:
//  1. upcoming ივენთი არ არსებობს? → ESPN-დან მომდევნოს ქმნის
//  2. ივენთი დასრულდა? → ESPN შედეგები + settlement
//  3. ივენთამდე დრო არის? → კოეფიციენტების განახლება
//  4. Settlement-ის შემდეგ → ბალანსების რესტარტი
// ============================================================

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const ODDS_API_KEY      = process.env.ODDS_API_KEY || '';
const BACKUP_SHEET_URL  = process.env.BACKUP_SHEET_URL || '';
const TG_TOKEN          = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT           = process.env.TELEGRAM_CHAT_ID || '';
const ESPN_BASE         = 'https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ SUPABASE_URL და SUPABASE_KEY აუცილებელია');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── HELPERS ──────────────────────────────────────────────────

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

function countryToFlag(alt) {
  const map = {
    // ჩრდილოეთ/სამხრეთ ამერიკა
    'USA':'🇺🇸','Canada':'🇨🇦','Mexico':'🇲🇽','Brazil':'🇧🇷','Argentina':'🇦🇷',
    'Colombia':'🇨🇴','Peru':'🇵🇪','Chile':'🇨🇱','Ecuador':'🇪🇨','Venezuela':'🇻🇪',
    'Uruguay':'🇺🇾','Jamaica':'🇯🇲','Trinidad and Tobago':'🇹🇹','Dominican Republic':'🇩🇴',
    'Puerto Rico':'🇵🇷','Guyana':'🇬🇾','Cuba':'🇨🇺','Aruba':'🇦🇼','Panama':'🇵🇦',
    // ევროპა
    'United Kingdom':'🇬🇧','England':'🏴󠁧󠁢󠁥󠁮󠁧󠁿','Scotland':'🏴󠁧󠁢󠁳󠁣󠁴󠁿','Wales':'🏴󠁧󠁢󠁷󠁬󠁳󠁿',
    'Ireland':'🇮🇪','France':'🇫🇷','Germany':'🇩🇪','Italy':'🇮🇹','Spain':'🇪🇸',
    'Netherlands':'🇳🇱','Poland':'🇵🇱','Sweden':'🇸🇪','Norway':'🇳🇴','Denmark':'🇩🇰',
    'Finland':'🇫🇮','Belgium':'🇧🇪','Austria':'🇦🇹','Switzerland':'🇨🇭',
    'Portugal':'🇵🇹','Czech Republic':'🇨🇿','Czechia':'🇨🇿','Hungary':'🇭🇺',
    'Romania':'🇷🇴','Serbia':'🇷🇸','Croatia':'🇭🇷','Bosnia and Herzegovina':'🇧🇦',
    'Bulgaria':'🇧🇬','Greece':'🇬🇷','Lithuania':'🇱🇹','Latvia':'🇱🇻','Estonia':'🇪🇪',
    'Moldova':'🇲🇩','Albania':'🇦🇱','North Macedonia':'🇲🇰','Montenegro':'🇲🇪',
    'Slovakia':'🇸🇰','Slovenia':'🇸🇮','Iceland':'🇮🇸','Kosovo':'🇽🇰',
    // СНГ / ცენტრალური აზია
    'Russia':'🇷🇺','Ukraine':'🇺🇦','Georgia':'🇬🇪','Armenia':'🇦🇲','Azerbaijan':'🇦🇿',
    'Kazakhstan':'🇰🇿','Uzbekistan':'🇺🇿','Kyrgyzstan':'🇰🇬','Tajikistan':'🇹🇯',
    'Turkmenistan':'🇹🇲','Belarus':'🇧🇾',
    // აზია / ოკეანეთი
    'China':'🇨🇳','Japan':'🇯🇵','South Korea':'🇰🇷','Thailand':'🇹🇭','Philippines':'🇵🇭',
    'Indonesia':'🇮🇩','India':'🇮🇳','Mongolia':'🇲🇳','Myanmar':'🇲🇲','Vietnam':'🇻🇳',
    'Malaysia':'🇲🇾','Singapore':'🇸🇬','Taiwan':'🇹🇼','Pakistan':'🇵🇰',
    'Afghanistan':'🇦🇫','Iraq':'🇮🇶','Iran':'🇮🇷','Israel':'🇮🇱',
    'Australia':'🇦🇺','New Zealand':'🇳🇿','Fiji':'🇫🇯','Samoa':'🇼🇸',
    // ახლო აღმოსავლეთი / თურქეთი
    'Turkey':'🇹🇷','Türkiye':'🇹🇷','Saudi Arabia':'🇸🇦','UAE':'🇦🇪',
    'Bahrain':'🇧🇭','Jordan':'🇯🇴','Lebanon':'🇱🇧','Syria':'🇸🇾',
    // აფრიკა
    'South Africa':'🇿🇦','Nigeria':'🇳🇬','Cameroon':'🇨🇲','Ghana':'🇬🇭',
    'Morocco':'🇲🇦','Egypt':'🇪🇬','Tunisia':'🇹🇳','Algeria':'🇩🇿',
    'Kenya':'🇰🇪','DR Congo':'🇨🇩','Senegal':'🇸🇳','Angola':'🇦🇴',
  };
  return map[alt] || '🏳️';
}

function nameSimilarity(a, b) {
  const norm = s => s.toLowerCase().replace(/[^a-z]/g, ' ').trim().split(/\s+/).filter(Boolean);
  const wa = norm(a), wb = norm(b);
  let matches = 0;
  for (const w of wa) {
    if (wb.some(x => x.startsWith(w.slice(0, 4)) || w.startsWith(x.slice(0, 4)))) matches++;
  }
  return matches / Math.max(wa.length, wb.length, 1);
}

function parseESPNMethod(comp) {
  const sources = [
    comp.headlines?.[0]?.description || '',
    comp.notes?.[0]?.headline || '',
    comp.status?.type?.description || ''
  ];
  for (const src of sources) {
    if (!src) continue;
    const s = src.toLowerCase();
    if (s.includes('ko') || s.includes('tko')) return 'KO/TKO';
    if (s.includes('sub')) return 'Submission';
    if (s.includes('dec') || s.includes('decision') || s.includes('unanimous') || s.includes('split')) return 'Decision';
    if (s.includes('no contest')) return 'No Contest';
    if (s.includes('dq') || s.includes('disqualif')) return 'DQ';
  }
  return ''; // მეთოდი ვერ ამოიცნო — არ დავაბრუნოთ "Final"
}

function methodMatches(picked, result) {
  if (!picked || !result) return false;
  const r = result.toLowerCase();
  if (picked === 'ნოკაუტი')        return r.includes('ko') || r.includes('tko');
  if (picked === 'მტკივნეული')     return r.includes('sub');
  if (picked === 'გადაწყვეტილება') return r.includes('dec') || r.includes('decision');
  return false;
}

function selectionWon(sel, fight) {
  if (!fight || !fight.result_winner) return null;
  const winnerSide = fight.result_winner === fight.red_name ? 'red' : 'blue';
  if (sel.picked_fighter && sel.picked_fighter !== winnerSide) return false;
  if (sel.picked_round) {
    const resultRound = fight.result_round ? Number(fight.result_round) : null;
    if (resultRound !== Number(sel.picked_round)) return false;
  }
  if (sel.picked_method) {
    if (!methodMatches(sel.picked_method, fight.result_method || '')) return false;
  }
  return true;
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

async function sendTelegram(msg) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text: msg, parse_mode: 'HTML' })
    });
  } catch (e) { log('⚠ Telegram შეცდომა: ' + e.message); }
}

async function fetchAthleteDetails(espnId) {
  try {
    const a = await fetchJSON(`https://sports.core.api.espn.com/v2/sports/mma/athletes/${espnId}`);
    return {
      age: a.age || null,
      height_cm: a.height ? Math.round(a.height * 2.54) : null,
      weight_kg: a.weight ? Math.round(a.weight * 0.4536) : null,
      reach_cm: a.reach ? Math.round(a.reach * 2.54) : null,
    };
  } catch { return { age: null, height_cm: null, weight_kg: null, reach_cm: null }; }
}

// ── STEP 1: ახალი ივენთის შექმნა ────────────────────────────

async function findNextESPNEvent() {
  const today = new Date();
  for (let i = 0; i <= 30; i++) {
    const d = new Date(today); d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().slice(0, 10).replace(/-/g, '');
    try {
      const data = await fetchJSON(`${ESPN_BASE}?dates=${dateStr}`);
      if (data.events && data.events.length > 0) return data;
    } catch {}
  }
  return null;
}

async function upsertFighter(f) {
  const slug = f.name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
  const imageUrl = f.espn_id ? `https://a.espncdn.com/i/headshots/mma/players/full/${f.espn_id}.png` : null;

  const { data: existing } = await sb.from('fighters').select('id').eq('name', f.name).maybeSingle();
  if (existing) {
    const upd = {};
    if (f.age)       upd.age       = f.age;
    if (f.height_cm) upd.height_cm = f.height_cm;
    if (f.weight_kg) upd.weight_kg = f.weight_kg;
    if (f.reach_cm)  upd.reach_cm  = f.reach_cm;
    if (f.record)    upd.record    = f.record;
    if (f.espn_id)   upd.espn_id   = f.espn_id;
    if (imageUrl)    upd.image_url = imageUrl;
    if (Object.keys(upd).length) await sb.from('fighters').update(upd).eq('id', existing.id);
    return existing.id;
  }

  const { data, error } = await sb.from('fighters').insert({
    name: f.name, flag: f.flag, country: f.country,
    record: f.record || null, ufc_slug: slug,
    espn_id: f.espn_id || null, image_url: imageUrl,
    age: f.age || null, height_cm: f.height_cm || null,
    weight_kg: f.weight_kg || null, reach_cm: f.reach_cm || null,
  }).select().maybeSingle();

  if (error) { log(`  ⚠ მებრძოლი ვერ შეიქმნა: ${f.name} — ${error.message}`); return null; }
  return data?.id || null;
}

async function createEventFromESPN(espnData) {
  const event = espnData.events[0];
  const venue = event.competitions[0]?.venue;
  const city    = venue?.address?.city || '';
  const country = venue?.address?.country || '';
  const location = city && country ? `${city}, ${country}` : city || country;

  // შევამოწმოთ უკვე ხომ არ არსებობს
  const { data: existing } = await sb.from('events').select('id').eq('name', event.name).maybeSingle();
  if (existing) { log(`ივენთი უკვე არსებობს: ${event.name}`); return existing.id; }

  // ბალანსების რესტარტი ახალი ივენთისთვის
  log('💰 ბალანსების რესტარტი → 1,000');
  await sb.from('users').update({ balance: 1000 }).gte('id', '00000000-0000-0000-0000-000000000000');

  // ივენთი
  const { data: evData, error: evErr } = await sb.from('events').insert({
    name: event.name, location, event_date: event.date, status: 'upcoming'
  }).select().maybeSingle();

  if (evErr) { log(`❌ ივენთის შეცდომა: ${evErr.message}`); return null; }
  log(`✅ ივენთი შეიქმნა: ${event.name} (id: ${evData.id})`);

  // ბრძოლები
  const comps = [...event.competitions].reverse();
  let saved = 0;

  for (let idx = 0; idx < comps.length; idx++) {
    const c = comps[idx];
    const redC  = c.competitors.find(x => x.order === 1) || c.competitors[0];
    const blueC = c.competitors.find(x => x.order === 2) || c.competitors[1];
    const rounds = c.format?.regulation?.periods || 3;

    // მებრძოლების დეტალები
    const redDetails  = redC?.id  ? await fetchAthleteDetails(redC.id) : {};
    const blueDetails = blueC?.id ? await fetchAthleteDetails(blueC.id) : {};

    const red = {
      name: redC?.athlete?.fullName || '', flag: countryToFlag(redC?.athlete?.flag?.alt || ''),
      country: redC?.athlete?.flag?.alt || '', record: redC?.records?.[0]?.summary || '',
      espn_id: redC?.id || '', ...redDetails
    };
    const blue = {
      name: blueC?.athlete?.fullName || '', flag: countryToFlag(blueC?.athlete?.flag?.alt || ''),
      country: blueC?.athlete?.flag?.alt || '', record: blueC?.records?.[0]?.summary || '',
      espn_id: blueC?.id || '', ...blueDetails
    };

    const redId  = await upsertFighter(red);
    const blueId = await upsertFighter(blue);
    if (!redId || !blueId) continue;

    const { error: fErr } = await sb.from('fights').insert({
      event_id: evData.id, red_fighter_id: redId, blue_fighter_id: blueId,
      weight_class: c.type?.abbreviation || 'Unknown',
      max_rounds: rounds, bout_order: idx + 1,
      is_title_bout: rounds === 5, red_odds: null, blue_odds: null,
      show_details: false, status: 'upcoming',
    });

    if (!fErr) { log(`  🥊 ${red.name} vs ${blue.name}`); saved++; }
  }

  log(`✅ ${saved} ბრძოლა შეიქმნა`);
  await sendTelegram(`🆕 <b>ახალი ივენთი შეიქმნა</b>\n\n${event.name}\n📍 ${location}\n🥊 ${saved} ბრძოლა\n💰 ბალანსები → 1,000`);
  return evData.id;
}

// ── STEP 2: კოეფიციენტების განახლება ─────────────────────────

async function updateOdds(eventId) {
  if (!ODDS_API_KEY) { log('⏭ Odds API key არ არის — გამოტოვება'); return; }

  const { data: fights } = await sb.from('fights')
    .select('id,red:fighters!red_fighter_id(name),blue:fighters!blue_fighter_id(name)')
    .eq('event_id', eventId).eq('status', 'upcoming');

  if (!fights || fights.length === 0) return;

  try {
    const url = `https://api.the-odds-api.com/v4/sports/mma_mixed_martial_arts/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=h2h&oddsFormat=decimal`;
    const oddsData = await fetchJSON(url);
    let updated = 0;

    for (const fight of fights) {
      const redName  = fight.red?.name || '';
      const blueName = fight.blue?.name || '';

      let bestGame = null, bestScore = 0;
      for (const game of oddsData) {
        const score = Math.max(
          nameSimilarity(game.home_team, redName) + nameSimilarity(game.away_team, blueName),
          nameSimilarity(game.home_team, blueName) + nameSimilarity(game.away_team, redName)
        );
        if (score > bestScore) { bestScore = score; bestGame = game; }
      }
      if (bestScore < 0.5 || !bestGame) continue;

      const bm = bestGame.bookmakers?.[0];
      const h2h = bm?.markets?.find(m => m.key === 'h2h');
      if (!h2h) continue;

      const redOdds  = h2h.outcomes.find(o => nameSimilarity(o.name, redName) > 0.4)?.price;
      const blueOdds = h2h.outcomes.find(o => nameSimilarity(o.name, blueName) > 0.4)?.price;
      if (!redOdds || !blueOdds) continue;

      await sb.from('fights').update({
        red_odds: Math.round(redOdds * 100) / 100,
        blue_odds: Math.round(blueOdds * 100) / 100,
      }).eq('id', fight.id);

      log(`  📊 ${redName} (${redOdds}) vs ${blueName} (${blueOdds})`);
      updated++;
    }

    log(`✅ ${updated}/${fights.length} კოეფიციენტი განახლდა`);
    if (updated > 0) await sendTelegram(`📊 <b>კოეფიციენტები განახლდა</b>\n\n${updated}/${fights.length} ბრძოლა`);
  } catch (e) {
    log(`⚠ Odds API შეცდომა: ${e.message}`);
  }
}

// ── STEP 3: ESPN შედეგები + Settlement ──────────────────────

async function fetchResultsAndSettle(eventId, eventDate) {
  const dateStr = new Date(eventDate).toISOString().slice(0, 10).replace(/-/g, '');

  log('📡 ESPN-დან შედეგების წამოღება...');
  let espnData;
  try {
    espnData = await fetchJSON(`${ESPN_BASE}?dates=${dateStr}`);
  } catch (e) {
    log(`⚠ ESPN შეცდომა: ${e.message}`);
    return;
  }

  if (!espnData.events || !espnData.events.length) { log('ESPN: ივენთი ვერ მოიძებნა'); return; }

  const event = espnData.events[0];
  const espnState = event.status?.type?.state;
  log(`ESPN სტატუსი: ${event.status?.type?.description || espnState}`);

  if (espnState === 'pre') { log('ივენთი ჯერ არ დაწყებულა'); return; }

  // DB-ში ბრძოლების წამოღება
  const { data: dbFights } = await sb.from('fights')
    .select('id,red:fighters!red_fighter_id(name),blue:fighters!blue_fighter_id(name)')
    .eq('event_id', eventId);

  if (!dbFights) return;

  // შედეგების განახლება
  let resultsUpdated = 0;
  for (const comp of event.competitions) {
    if (comp.status?.type?.state !== 'post') continue;
    const winner = comp.competitors.find(c => c.winner);
    if (!winner) continue;

    const winnerName = winner.athlete?.fullName || '';
    const method = parseESPNMethod(comp);
    const round  = comp.status?.period || '';
    const time   = comp.status?.displayClock || '';

    const match = dbFights.find(f =>
      nameSimilarity(f.red?.name || '', winnerName) > 0.4 ||
      nameSimilarity(f.blue?.name || '', winnerName) > 0.4
    );
    if (!match) continue;

    // მკაცრი შემოწმება — winner ნამდვილად ერთ-ერთი მებრძოლია
    const matchRed = nameSimilarity(match.red?.name || '', winnerName);
    const matchBlue = nameSimilarity(match.blue?.name || '', winnerName);
    if (matchRed < 0.5 && matchBlue < 0.5) {
      log(`  ⚠ winner "${winnerName}" ვერ დაემთხვა ვერც ერთ მებრძოლს — გამოტოვება`);
      continue;
    }
    // ზუსტი სახელი DB-დან (ESPN-ის ვარიაციის ნაცვლად)
    const exactWinner = matchRed >= matchBlue ? match.red.name : match.blue.name;

    await sb.from('fights').update({
      status: 'completed', result_winner: exactWinner, result_method: method,
      result_round: round ? parseInt(round) : null, result_time: time || null,
    }).eq('id', match.id);

    log(`  🏆 ${match.red?.name} vs ${match.blue?.name} → ${exactWinner} (${method} R${round})`);
    resultsUpdated++;
  }

  if (resultsUpdated === 0) {
    log('ახალი შედეგი ვერ მოიძებნა — მაგრამ settlement მაინც ვცადოთ (pending ბილეთებისთვის)');
  } else {
    log(`${resultsUpdated} შედეგი განახლდა — settlement იწყება...`);
  }

  // SETTLEMENT
  const { data: fights } = await sb.from('fights')
    .select('id,result_winner,result_method,result_round,red:fighters!red_fighter_id(name),blue:fighters!blue_fighter_id(name)')
    .eq('event_id', eventId).eq('status', 'completed');

  if (!fights || fights.length === 0) return;

  const fightMap = {};
  fights.forEach(f => {
    fightMap[f.id] = {
      result_winner: f.result_winner || '',
      result_method: f.result_method || '',
      result_round:  f.result_round  || null,
      red_name:      f.red?.name     || '',
      blue_name:     f.blue?.name    || '',
    };
  });

  const { data: tickets } = await sb.from('tickets')
    .select('id,type,stake,total_odds,user_id,ticket_selections(id,fight_id,picked_fighter,picked_round,picked_method,odds)')
    .eq('event_id', eventId).eq('status', 'pending').is('settled_at', null);

  if (!tickets || tickets.length === 0) { log('pending ბილეთი ვერ მოიძებნა'); }
  else {
    let wonCount = 0, lostCount = 0, skipped = 0;

    for (const ticket of tickets) {
      const sels = ticket.ticket_selections || [];
      const results = sels.map(sel => {
        const fight = fightMap[sel.fight_id];
        if (!fight) return null;
        return selectionWon(sel, fight);
      });

      if (results.some(r => r === null)) { skipped++; continue; }

      const allWon  = results.every(r => r === true);
      const anyLost = results.some(r => r === false);
      const newStatus = anyLost ? 'lost' : (allWon ? 'won' : 'pending');
      if (newStatus === 'pending') { skipped++; continue; }

      // თითო selection-ის result ჩაწერა (✅/❌-ისთვის)
      for (let si = 0; si < sels.length; si++) {
        const r = results[si];
        if (r === true || r === false) {
          await sb.from('ticket_selections').update({ result: r ? 'ok' : 'no' }).eq('id', sels[si].id);
        }
      }

      await sb.from('tickets').update({
        status: newStatus, settled_at: new Date().toISOString()
      }).eq('id', ticket.id);

      if (newStatus === 'won') {
        wonCount++;
        const winnings = Math.round(Number(ticket.stake) * Number(ticket.total_odds));
        await sb.rpc('increment_user_score', { p_user_id: ticket.user_id, p_amount: winnings });
        await sb.from('score_history').insert({
          user_id: ticket.user_id, amount: winnings
        });
        log(`  ✓ მოგება: ${winnings} ქულა (user: ${String(ticket.user_id).slice(0, 8)}...)`);
      } else {
        lostCount++;
      }
    }

    log(`✅ Settlement: ${wonCount} მოგებული | ${lostCount} წაგებული | ${skipped} გამოტოვებული`);
    await sendTelegram(`🏁 <b>Settlement დასრულდა</b>\n\n✅ ${wonCount} მოგებული\n❌ ${lostCount} წაგებული\n⏭ ${skipped} გამოტოვებული`);
  }

  // ივენთის სტატუსი → completed (თუ ყველა ბრძოლა დასრულდა)
  const { data: remaining } = await sb.from('fights')
    .select('id').eq('event_id', eventId).neq('status', 'completed').limit(1);

  if (!remaining || remaining.length === 0) {
    await sb.from('events').update({ status: 'completed' }).eq('id', eventId);
    log('✅ ივენთის სტატუსი → completed');
  }
}

// ── STEP 4: Google Sheets Backup ─────────────────────────────

function getBackupSlot() {
  const days = ['კვ', 'ორშ', 'სამ', 'ოთხ', 'ხუთ', 'პარ', 'შაბ'];
  const now = new Date();
  const day = days[now.getUTCDay()];
  const half = now.getUTCHours() < 12 ? '00' : '12';
  return `${day}_${half}`;  // მაგ: "ორშ_00", "პარ_12"
}

function shouldRunBackup() {
  const hour = new Date().getUTCHours();
  const minute = new Date().getUTCMinutes();
  // ყოველ 12 საათში: 0:00 და 12:00 UTC
  return (hour === 0 || hour === 12) && minute < 30;
}

async function backupToSheets(eventName) {
  if (!BACKUP_SHEET_URL) { log('⏭ Backup URL არ არის — გამოტოვება'); return; }
  log('📋 Google Sheets backup...');

  try {
    const slot = getBackupSlot();

    // მომხმარებლები
    const { data: users } = await sb.from('users').select('nick,email,balance,score,icon,created_at');

    // ბილეთები + nick + event name
    const { data: tickets } = await sb.from('tickets')
      .select('id,type,stake,total_odds,potential_win,status,placed_at,settled_at,user:users!user_id(nick),event:events!event_id(name)');

    // სელექციები
    const { data: selections } = await sb.from('ticket_selections')
      .select('ticket_id,fight_id,picked_fighter,picked_round,picked_method,odds,result,fight:fights!fight_id(red:fighters!red_fighter_id(name),blue:fighters!blue_fighter_id(name))');

    // ივენთები
    const { data: events } = await sb.from('events').select('id,name,location,event_date,status');

    // ბრძოლები
    const { data: fights } = await sb.from('fights')
      .select('id,weight_class,red_odds,blue_odds,result_winner,result_method,result_round,status,event:events!event_id(name),red:fighters!red_fighter_id(name),blue:fighters!blue_fighter_id(name)');

    // ლიდერბორდი
    const { data: leaderboard } = await sb.from('score_history')
      .select('amount,created_at,user:users!user_id(nick)');

    const payload = {
      slot,
      event_name: eventName || '',
      users: users || [],
      tickets: (tickets || []).map(t => ({
        ...t, nick: t.user?.nick || '', event_name: t.event?.name || ''
      })),
      selections: (selections || []).map(s => ({
        ...s, fight_name: `${s.fight?.red?.name || '?'} vs ${s.fight?.blue?.name || '?'}`
      })),
      events: events || [],
      fights: (fights || []).map(f => ({
        ...f, event_name: f.event?.name || '', red_name: f.red?.name || '', blue_name: f.blue?.name || ''
      })),
      leaderboard: (leaderboard || []).map(l => ({
        ...l, nick: l.user?.nick || ''
      })),
    };

    const res = await fetch(BACKUP_SHEET_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const result = await res.json();
    if (result.success) log(`✅ Backup შენახულია (slot: ${slot})`);
    else log(`⚠ Backup შეცდომა: ${result.error || 'unknown'}`);

  } catch (e) {
    log(`⚠ Backup failed: ${e.message}`);
  }
}

// ── MAIN ─────────────────────────────────────────────────────

// ── SETTLEMENT SWEEP — orphaned pending ბილეთების დამუშავება ──
// ნებისმიერი ივენთი რომელსაც აქვს completed ბრძოლები + pending ბილეთი
async function settlementSweep() {
  try {
    // ყველა ივენთი ბოლო 7 დღეში (upcoming ან completed)
    const weekAgo = new Date(Date.now() - 7 * 24 * 3600000).toISOString();
    const { data: events } = await sb.from('events')
      .select('id,name,event_date,status')
      .gte('event_date', weekAgo)
      .order('event_date', { ascending: false });

    if (!events || events.length === 0) return;

    for (const ev of events) {
      // აქვს თუ არა pending ბილეთი?
      const { data: pendingTickets } = await sb.from('tickets')
        .select('id').eq('event_id', ev.id).eq('status', 'pending').is('settled_at', null).limit(1);
      if (!pendingTickets || pendingTickets.length === 0) continue;

      // აქვს თუ არა completed ბრძოლა?
      const { data: completedFights } = await sb.from('fights')
        .select('id').eq('event_id', ev.id).eq('status', 'completed').limit(1);
      if (!completedFights || completedFights.length === 0) continue;

      // settlement ვცადოთ ამ ივენთზე
      log(`🧹 Settlement sweep: ${ev.name} (pending ბილეთები ნაპოვნია)`);
      await fetchResultsAndSettle(ev.id, ev.event_date);
    }
  } catch (e) {
    log(`⚠ settlementSweep შეცდომა: ${e.message}`);
  }
}

async function main() {
  log('========================================');
  log('UFC Fantasy — Auto Script Started');
  log('========================================');

  // 0. SETTLEMENT SWEEP — ნებისმიერი ივენთი (upcoming ან completed)
  //    რომელსაც აქვს pending ბილეთი + completed ბრძოლები →
  //    settlement ხელახლა ვცადოთ. ეს იცავს "შედეგი არ მაქვს" პრობლემისგან:
  //    თუ ერთი ბრძოლა ვერ ჩაიწერა და ივენთი completed ვერ გახდა,
  //    ან თუ ბილეთი settlement-მა გამოტოვა.
  await settlementSweep();

  // 1. მიმდინარე upcoming ივენთის შემოწმება
  const { data: upcomingEvents } = await sb.from('events')
    .select('id,name,event_date,status')
    .eq('status', 'upcoming')
    .order('event_date', { ascending: true })
    .limit(1);

  const upcoming = upcomingEvents?.[0];

  if (!upcoming) {
    // არ გვაქვს upcoming ივენთი → ვეძებთ ახალს
    log('📭 upcoming ივენთი არ არსებობს — ვეძებთ ახალს...');
    const espnData = await findNextESPNEvent();
    if (espnData) {
      const eventId = await createEventFromESPN(espnData);
      if (eventId && ODDS_API_KEY) {
        log('📊 კოეფიციენტების წამოღება...');
        await updateOdds(eventId);
      }
    } else {
      log('📭 მომდევნო 30 დღეში UFC ივენთი ვერ მოიძებნა');
    }
    return;
  }

  // 2. upcoming ივენთი გვაქვს
  const eventDate = new Date(upcoming.event_date);
  const hoursUntil = (eventDate.getTime() - Date.now()) / 3600000;
  log(`📅 ${upcoming.name}`);
  log(`⏰ ${hoursUntil > 0 ? Math.round(hoursUntil) + ' საათი დარჩა' : 'ივენთი დასრულდა ' + Math.abs(Math.round(hoursUntil)) + ' საათის წინ'}`);

  if (hoursUntil > 1) {
    // ივენთამდე 1+ საათი — კოეფიციენტების განახლება დღეში 4-ჯერ
    // გაეშვება მხოლოდ 00, 06, 12, 18 საათზე (UTC)
    const hour = new Date().getUTCHours();
    const isOddsHour = [0, 6, 12, 18].includes(hour);
    const minute = new Date().getUTCMinutes();
    if (ODDS_API_KEY && isOddsHour && minute < 30) {
      log(`📊 კოეფიციენტების განახლება (${hour}:00 UTC — დღეში 4-ჯერ)...`);
      await updateOdds(upcoming.id);
    } else {
      log(`⏳ ველოდებით (კოეფ. შემდეგი განახლება: ${[0,6,12,18].find(h => h > hour) || 0}:00 UTC)`);
    }

    // 12-საათიანი backup (0:00 და 12:00 UTC)
    if (shouldRunBackup()) {
      await backupToSheets(upcoming.name);
    }

    return;
  }

  if (hoursUntil > -0.5) {
    // ივენთი ახლახან დაიწყო — ჯერ ნაადრევია
    log('🔴 ივენთი მიმდინარეობს — ველოდებით');
    return;
  }

  // 3. ივენთი დასრულდა → შედეგები + settlement
  log('🏁 ივენთი დასრულდა — შედეგების წამოღება + settlement...');
  await fetchResultsAndSettle(upcoming.id, upcoming.event_date);

  // 3.5. Backup → Google Sheets
  await backupToSheets(upcoming.name);

  // 4. Settlement-ის შემდეგ მაშინვე ვეძებთ მომდევნო ივენთს
  log('');
  log('🔄 მომდევნო ივენთის ძებნა...');
  const nextESPN = await findNextESPNEvent();
  if (nextESPN) {
    const nextId = await createEventFromESPN(nextESPN);
    if (nextId && ODDS_API_KEY) {
      log('📊 ახალი ივენთის კოეფიციენტები...');
      await updateOdds(nextId);
    }
  } else {
    log('📭 მომდევნო ივენთი ჯერ არ არის (30 დღეში)');
  }
}

main()
  .then(() => log('✅ Auto script finished'))
  .catch(e => { log(`❌ Fatal error: ${e.message}`); process.exit(1); });
