globalThis.WebSocket = require('ws');
// ============================================================
//  UFC Fantasy — Zero-Touch Automation Script
//  GitHub Actions-ით ყოველ 30 წუთში ეშვება
//
//  რას აკეთებს:
//  1. upcoming ივენთი არ არსებობს + ორშაბათია? → ESPN-დან მომდევნოს ქმნის
//  2. ივენთი დასრულდა? → ESPN შედეგები + settlement
//  3. ივენთამდე დრო არის? → კოეფიციენტების განახლება (11:00 და 23:00 თბილისის დრო)
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
    'USA':'🇺🇸','Canada':'🇨🇦','Mexico':'🇲🇽','Brazil':'🇧🇷','Argentina':'🇦🇷',
    'Colombia':'🇨🇴','Peru':'🇵🇪','Chile':'🇨🇱','Ecuador':'🇪🇨','Venezuela':'🇻🇪',
    'Uruguay':'🇺🇾','Jamaica':'🇯🇲','Trinidad and Tobago':'🇹🇹','Dominican Republic':'🇩🇴',
    'Puerto Rico':'🇵🇷','Guyana':'🇬🇾','Cuba':'🇨🇺','Aruba':'🇦🇼','Panama':'🇵🇦',
    'United Kingdom':'🇬🇧','England':'🏴','Scotland':'🏴','Wales':'🏴',
    'Ireland':'🇮🇪','France':'🇫🇷','Germany':'🇩🇪','Italy':'🇮🇹','Spain':'🇪🇸',
    'Netherlands':'🇳🇱','Poland':'🇵🇱','Sweden':'🇸🇪','Norway':'🇳🇴','Denmark':'🇩🇰',
    'Finland':'🇫🇮','Belgium':'🇧🇪','Austria':'🇦🇹','Switzerland':'🇨🇭',
    'Portugal':'🇵🇹','Czech Republic':'🇨🇿','Czechia':'🇨🇿','Hungary':'🇭🇺',
    'Romania':'🇷🇴','Serbia':'🇷🇸','Croatia':'🇭🇷','Bosnia and Herzegovina':'🇧🇦',
    'Bulgaria':'🇧🇬','Greece':'🇬🇷','Lithuania':'🇱🇹','Latvia':'🇱🇻','Estonia':'🇪🇪',
    'Moldova':'🇲🇩','Albania':'🇦🇱','North Macedonia':'🇲🇰','Montenegro':'🇲🇪',
    'Slovakia':'🇸🇰','Slovenia':'🇸🇮','Iceland':'🇮🇸','Kosovo':'🇽🇰',
    'Russia':'🇷🇺','Ukraine':'🇺🇦','Georgia':'🇬🇪','Armenia':'🇦🇲','Azerbaijan':'🇦🇿',
    'Kazakhstan':'🇰🇿','Uzbekistan':'🇺🇿','Kyrgyzstan':'🇰🇬','Tajikistan':'🇹🇯',
    'Turkmenistan':'🇹🇲','Belarus':'🇧🇾',
    'China':'🇨🇳','Japan':'🇯🇵','South Korea':'🇰🇷','Thailand':'🇹🇭','Philippines':'🇵🇭',
    'Indonesia':'🇮🇩','India':'🇮🇳','Mongolia':'🇲🇳','Myanmar':'🇲🇲','Vietnam':'🇻🇳',
    'Malaysia':'🇲🇾','Singapore':'🇸🇬','Taiwan':'🇹🇼','Pakistan':'🇵🇰',
    'Afghanistan':'🇦🇫','Iraq':'🇮🇶','Iran':'🇮🇷','Israel':'🇮🇱',
    'Australia':'🇦🇺','New Zealand':'🇳🇿','Fiji':'🇫🇯','Samoa':'🇼🇸',
    'Turkey':'🇹🇷','Türkiye':'🇹🇷','Saudi Arabia':'🇸🇦','UAE':'🇦🇪',
    'Bahrain':'🇧🇭','Jordan':'🇯🇴','Lebanon':'🇱🇧','Syria':'🇸🇾',
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
  return '';
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
  if (!fight) return null;
  if (fight.is_voided) return 'void';   // ბრძოლა ნეიტრალდა (მებრძოლის ჩანაცვლება) — ეს leg არ ითვლება
  if (!fight.result_winner) return null;
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
  // (.maybeSingle()-ის ნაცვლად .select() ვიყენებთ — .maybeSingle() error-ს აგდებდა
  //  და existing-ს null-ს უტოვებდა, თუ ერთზე მეტი დუბლიკატი უკვე არსებობდა.
  //  ეს არის runaway დუბლიკაციის ძირითადი მიზეზი, რომელიც ასევე ყოველ ჯერზე
  //  ყველა მომხმარებლის ბალანსსაც აბრუნებდა 1000-ზე.)
  const { data: existingRows, error: existingErr } = await sb.from('events')
    .select('id').eq('name', event.name).order('id', { ascending: true });
  if (existingErr) { log(`⚠ ივენთის შემოწმება ვერ მოხერხდა: ${existingErr.message}`); return null; }
  if (existingRows && existingRows.length > 0) {
    log(`ივენთი უკვე არსებობს: ${event.name} (${existingRows.length} ჩანაწერი ბაზაში) — ახალი აღარ იქმნება`);
    return existingRows[0].id;
  }

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

      const preferred = ['pinnacle','betonlineag','betsson','nordicbet','coolbet'];
      let bm = null;
      for (const key of preferred) { bm = bestGame.bookmakers.find(b => b.key === key); if (bm) break; }
      if (!bm) bm = bestGame.bookmakers?.[0];
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

  const { data: dbFights } = await sb.from('fights')
    .select('id,red_fighter_id,blue_fighter_id,red:fighters!red_fighter_id(name,espn_id),blue:fighters!blue_fighter_id(name,espn_id)')
    .eq('event_id', eventId);

  if (!dbFights) return;

  let resultsUpdated = 0;
  let voidedCount = 0;
  for (const comp of event.competitions) {
    if (comp.status?.type?.state !== 'post') continue;
    const winner = comp.competitors.find(c => c.winner);
    if (!winner) continue;

    const winnerName = winner.athlete?.fullName || '';
    const method = parseESPNMethod(comp);
    const round  = comp.status?.period || '';
    const time   = comp.status?.displayClock || '';

    // ── ID-ზე დაფუძნებული დამთხვევა (მთავარი, საიმედო გზა) ──
    // ESPN competitor.id ↔ fighters.espn_id. ID არ იცვლება; სახელი შეიძლება.
    const espnIds = (comp.competitors || []).map(c => String(c.id || '')).filter(Boolean);
    let match = null;
    let matchedById = false;
    if (espnIds.length) {
      match = dbFights.find(f => {
        const rid = String(f.red?.espn_id || '');
        const bid = String(f.blue?.espn_id || '');
        return (rid && espnIds.includes(rid)) || (bid && espnIds.includes(bid));
      });
      if (match) matchedById = true;
    }
    // fallback: სახელით (მხოლოდ თუ ID-მ ვერ იპოვა — მაგ. ძველი მონაცემი espn_id-ის გარეშე)
    if (!match) {
      match = dbFights.find(f =>
        nameSimilarity(f.red?.name || '', winnerName) > 0.4 ||
        nameSimilarity(f.blue?.name || '', winnerName) > 0.4
      );
    }
    if (!match) {
      log(`  ⚠ winner "${winnerName}" ვერ დაემთხვა ვერც ერთ ბრძოლას — გამოტოვება`);
      continue;
    }

    // ── მებრძოლის ჩანაცვლების შემოწმება (ID-ით) ──
    // თუ ID-ით ვიპოვეთ ბრძოლა, მაგრამ ESPN-ის ორივე მებრძოლის ID ბაზას არ ემთხვევა
    // ზუსტად ამ ბრძოლის red/blue-ს — ესე იგი მებრძოლი ჩანაცვლდა → ბრძოლა void.
    if (matchedById) {
      const rid = String(match.red?.espn_id || '');
      const bid = String(match.blue?.espn_id || '');
      const winnerId = String(winner.id || '');
      const winnerKnown = (winnerId === rid) || (winnerId === bid);
      if (!winnerKnown) {
        // გამარჯვებული ESPN-ზე არის ID, რომელიც ბაზაში ამ ბრძოლის არცერთ მხარეს არ ეკუთვნის
        // → მებრძოლი შეიცვალა short-notice. ვნიშნავთ void-ად.
        await sb.from('fights').update({ status: 'completed', is_voided: true }).eq('id', match.id);
        log(`  ⚖️ ჩანაცვლება აღმოჩენილია (ID არ ემთხვევა) → ბრძოლა ნეიტრალდება (void): ${match.red?.name} vs ${match.blue?.name}`);
        await sendTelegram(`⚖️ <b>ბრძოლა ნეიტრალდა (void)</b>\n\nმებრძოლი შეიცვალა (ID არ ემთხვევა ESPN-ს).\n${match.red?.name} vs ${match.blue?.name}\nESPN გამარჯვებული: ${winnerName}\n\n➡️ ამ ბრძოლის პოზიცია ბილეთებიდან ამოვარდა, კოეფ. გადაითვალა.`);
        voidedCount++;
        continue;
      }
    }

    // ── გამარჯვებული მხარის დადგენა ──
    let exactWinner;
    if (matchedById) {
      const winnerId = String(winner.id || '');
      exactWinner = (winnerId === String(match.red?.espn_id || '')) ? match.red.name : match.blue.name;
    } else {
      const matchRed = nameSimilarity(match.red?.name || '', winnerName);
      const matchBlue = nameSimilarity(match.blue?.name || '', winnerName);
      if (matchRed < 0.5 && matchBlue < 0.5) {
        log(`  ⚠ winner "${winnerName}" ვერ დაემთხვა ვერც ერთ მებრძოლს — გამოტოვება`);
        continue;
      }
      exactWinner = matchRed >= matchBlue ? match.red.name : match.blue.name;
    }

    await sb.from('fights').update({
      status: 'completed', result_winner: exactWinner, result_method: method,
      result_round: round ? parseInt(round) : null, result_time: time || null,
    }).eq('id', match.id);

    log(`  🏆 ${match.red?.name} vs ${match.blue?.name} → ${exactWinner} (${method} R${round})${matchedById ? ' [ID✓]' : ' [name]'}`);
    resultsUpdated++;
  }
  if (voidedCount > 0) log(`⚖️ ${voidedCount} ბრძოლა ნეიტრალდა (მებრძოლის ჩანაცვლება)`);

  if (resultsUpdated === 0) {
    log('ახალი შედეგი ვერ მოიძებნა — მაგრამ settlement მაინც ვცადოთ (pending ბილეთებისთვის)');
  } else {
    log(`${resultsUpdated} შედეგი განახლდა — settlement იწყება...`);
  }

  const { data: fights } = await sb.from('fights')
    .select('id,result_winner,result_method,result_round,is_voided,red:fighters!red_fighter_id(name),blue:fighters!blue_fighter_id(name)')
    .eq('event_id', eventId).eq('status', 'completed');

  if (!fights || fights.length === 0) return;

  const fightMap = {};
  fights.forEach(f => {
    fightMap[f.id] = {
      result_winner: f.result_winner || '',
      result_method: f.result_method || '',
      result_round:  f.result_round  || null,
      is_voided:     f.is_voided === true,
      red_name:      f.red?.name     || '',
      blue_name:     f.blue?.name    || '',
    };
  });

  const { data: tickets } = await sb.from('tickets')
    .select('id,type,stake,total_odds,user_id,ticket_selections(id,fight_id,picked_fighter,picked_round,picked_method,odds)')
    .eq('event_id', eventId).eq('status', 'pending').is('settled_at', null);

  if (!tickets || tickets.length === 0) { log('pending ბილეთი ვერ მოიძებნა'); }
  else {
    let wonCount = 0, lostCount = 0, skipped = 0, voidRefundCount = 0, errorCount = 0;

    for (const ticket of tickets) {
     try {
      const sels = ticket.ticket_selections || [];
      const results = sels.map(sel => {
        const fight = fightMap[sel.fight_id];
        if (!fight) return null;
        return selectionWon(sel, fight);
      });

      // თუ რომელიმე leg ჯერ არ დასრულებულა (null) → ბილეთი ჯერ არ ფასდება
      if (results.some(r => r === null)) { skipped++; continue; }

      // void leg-ები — ცალკე გამოვყოთ. ისინი არც მოგება, არც წაგება.
      const voidIdx = [];
      results.forEach((r, i) => { if (r === 'void') voidIdx.push(i); });
      const activeResults = results.filter(r => r !== 'void');

      // ── შემთხვევა A: ბილეთის ყველა leg void-ია → სრული void, stake დაბრუნება ──
      if (activeResults.length === 0) {
        // ყველა selection void — ნიშნავს void-ს ჩავუწერთ და stake დავაბრუნებთ
        for (let si = 0; si < sels.length; si++) {
          await sb.from('ticket_selections').update({ result: 'void' }).eq('id', sels[si].id);
        }
        await sb.from('tickets').update({ status: 'void', settled_at: new Date().toISOString() }).eq('id', ticket.id);
        // stake დაბრუნება — cashout-ის მსგავსად, ბალანსზე (increment_user_score არა — ეს score-ია, ბალანსი გვინდა)
        // ბალანსი trigger-ითაა დაცული, ამიტ RPC-ს ვიყენებთ თუ არსებობს; თუ არა — refund score_history-ს არ ვწერთ.
        try {
          await sb.rpc('refund_ticket_stake', { p_ticket_id: ticket.id });
        } catch (e) {
          log(`  ⚠ stake დაბრუნების RPC ვერ გაეშვა ბილეთ ${ticket.id}-ზე: ${e.message}`);
        }
        log(`  ↩️ სრული void — ბილეთი ${ticket.id}: stake (${ticket.stake}) დაბრუნდა`);
        voidRefundCount++;
        continue;
      }

      // ── შემთხვევა B: ნაწილობრივ void — void leg-ები ამოვარდება, კოეფ. გადაითვლება ──
      // ჩავწეროთ თითო selection-ის შედეგი (void leg-ს 'void')
      for (let si = 0; si < sels.length; si++) {
        const r = results[si];
        if (r === true || r === false || r === 'void') {
          await sb.from('ticket_selections').update({ result: r === true ? 'ok' : r === false ? 'no' : 'void' }).eq('id', sels[si].id);
        }
      }

      const allWon  = activeResults.every(r => r === true);
      const anyLost = activeResults.some(r => r === false);
      const newStatus = anyLost ? 'lost' : (allWon ? 'won' : 'pending');
      if (newStatus === 'pending') { skipped++; continue; }

      // total_odds გადათვლა: ავიღოთ საწყისი და გავყოთ void leg-ების კოეფიციენტებზე
      let adjustedOdds = Number(ticket.total_odds);
      if (voidIdx.length > 0) {
        for (const i of voidIdx) {
          const voidOdds = Number(sels[i].odds) || 1;
          if (voidOdds > 0) adjustedOdds = adjustedOdds / voidOdds;
        }
        adjustedOdds = Math.round(adjustedOdds * 100) / 100;
        // ბილეთის total_odds და potential_win განვაახლოთ
        await sb.from('tickets').update({
          total_odds: adjustedOdds,
          potential_win: Math.round(Number(ticket.stake) * adjustedOdds)
        }).eq('id', ticket.id);
        log(`  ⚖️ ბილეთი ${ticket.id}: ${voidIdx.length} void leg ამოვარდა, კოეფ. ${ticket.total_odds} → ${adjustedOdds}`);
      }

      await sb.from('tickets').update({
        status: newStatus, settled_at: new Date().toISOString()
      }).eq('id', ticket.id);

      if (newStatus === 'won') {
        wonCount++;
        const winnings = Math.round(Number(ticket.stake) * adjustedOdds);
        await sb.rpc('increment_user_score', { p_user_id: ticket.user_id, p_amount: winnings });
        await sb.from('score_history').insert({
          user_id: ticket.user_id, amount: winnings
        });
        log(`  ✓ მოგება: ${winnings} ქულა (user: ${String(ticket.user_id).slice(0, 8)}...)`);
      } else {
        lostCount++;
      }
     } catch (e) {
       // ერთი ბილეთის ჩავარდნა დანარჩენს არ აჩერებს — ლოგი + ტელეგრამი, ხელით მიხედვისთვის
       errorCount++;
       log(`  ❌ ბილეთი ${ticket.id} ვერ დამუშავდა: ${e.message}`);
       try {
         await sendTelegram(`⚠️ <b>ბილეთი ვერ დამუშავდა</b>\n\nID: ${ticket.id}\nშეცდომა: <code>${(e.message || String(e)).slice(0, 300)}</code>\n\n➡️ საჭიროა ხელით შემოწმება.`);
       } catch (_) {}
       continue;
     }
    }

    log(`✅ Settlement: ${wonCount} მოგებული | ${lostCount} წაგებული | ${skipped} გამოტოვებული | ${voidRefundCount} სრული void${errorCount > 0 ? ` | ${errorCount} შეცდომა` : ''}`);
    await sendTelegram(`🏁 <b>Settlement დასრულდა</b>\n\n✅ ${wonCount} მოგებული\n❌ ${lostCount} წაგებული\n⏭ ${skipped} გამოტოვებული${voidRefundCount > 0 ? `\n↩️ ${voidRefundCount} სრული void (stake დაბრუნდა)` : ''}${errorCount > 0 ? `\n🚨 ${errorCount} ბილეთი ვერ დამუშავდა — ხელით შემოწმება საჭიროა` : ''}`);
  }

  const { data: remaining } = await sb.from('fights')
    .select('id').eq('event_id', eventId).neq('status', 'completed').limit(1);

  if (!remaining || remaining.length === 0) {
    await sb.from('events').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', eventId);
    log('✅ ივენთის სტატუსი → completed (completed_at ჩაიწერა)');
  }
}

// ── STEP 4: Google Sheets Backup ─────────────────────────────

function getBackupSlot() {
  const days = ['კვ', 'ორშ', 'სამ', 'ოთხ', 'ხუთ', 'პარ', 'შაბ'];
  const now = new Date();
  const day = days[now.getUTCDay()];
  const half = now.getUTCHours() < 12 ? '00' : '12';
  return `${day}_${half}`;
}

function shouldRunBackup() {
  const hour = new Date().getUTCHours();
  const minute = new Date().getUTCMinutes();
  return (hour === 0 || hour === 12) && minute < 30;
}

async function backupToSheets(eventName) {
  if (!BACKUP_SHEET_URL) { log('⏭ Backup URL არ არის — გამოტოვება'); return; }
  log('📋 Google Sheets backup...');

  try {
    const slot = getBackupSlot();

    const { data: users } = await sb.from('users').select('nick,email,balance,score,icon,created_at');

    const { data: tickets } = await sb.from('tickets')
      .select('id,type,stake,total_odds,potential_win,status,placed_at,settled_at,user:users!user_id(nick),event:events!event_id(name)');

    const { data: selections } = await sb.from('ticket_selections')
      .select('ticket_id,fight_id,picked_fighter,picked_round,picked_method,odds,result,fight:fights!fight_id(red:fighters!red_fighter_id(name),blue:fighters!blue_fighter_id(name))');

    const { data: events } = await sb.from('events').select('id,name,location,event_date,status');

    const { data: fights } = await sb.from('fights')
      .select('id,weight_class,red_odds,blue_odds,result_winner,result_method,result_round,status,event:events!event_id(name),red:fighters!red_fighter_id(name),blue:fighters!blue_fighter_id(name)');

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

async function settlementSweep() {
  try {
    const weekAgo = new Date(Date.now() - 7 * 24 * 3600000).toISOString();
    const { data: events } = await sb.from('events')
      .select('id,name,event_date,status')
      .gte('event_date', weekAgo)
      .order('event_date', { ascending: false });

    if (!events || events.length === 0) return;

    for (const ev of events) {
      const { data: pendingTickets } = await sb.from('tickets')
        .select('id').eq('event_id', ev.id).eq('status', 'pending').is('settled_at', null).limit(1);
      if (!pendingTickets || pendingTickets.length === 0) continue;

      const { data: completedFights } = await sb.from('fights')
        .select('id').eq('event_id', ev.id).eq('status', 'completed').limit(1);
      if (!completedFights || completedFights.length === 0) continue;

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

  await settlementSweep();

  const { data: upcomingEvents } = await sb.from('events')
    .select('id,name,event_date,status')
    .eq('status', 'upcoming')
    .order('event_date', { ascending: true })
    .limit(1);

  const upcoming = upcomingEvents?.[0];

  if (!upcoming) {
    // ახალი ივენთი იქმნება, როცა ბოლო ივენთის settlement-იდან (completed_at) 1 საათი გავიდა.
    // (ორშაბათის შეზღუდვა მოხსნილია — ივენთი ავტომატურად მოდის settlement-იდან 1 საათში.)
    const { data: lastCompleted } = await sb.from('events')
      .select('id,name,completed_at,event_date,status')
      .eq('status', 'completed')
      .order('completed_at', { ascending: false, nullsFirst: false })
      .limit(1);

    const last = lastCompleted?.[0];
    if (last) {
      // completed_at fallback — ძველ ივენთს თუ არ აქვს, event_date-ს ვიყენებთ
      const completedTime = last.completed_at ? new Date(last.completed_at).getTime()
                                              : new Date(last.event_date).getTime();
      const hoursSince = (Date.now() - completedTime) / 3600000;
      if (hoursSince < 1) {
        log(`⏳ ბოლო ივენთი დასრულდა ${Math.round(hoursSince * 60)} წუთის წინ — ახალ ივენთამდე ${Math.round((1 - hoursSince) * 60)} წუთი (შედეგები ჩანს საიტზე)`);
        return;
      }
      log(`✅ ბოლო ივენთის settlement-იდან ${hoursSince.toFixed(1)} საათი გავიდა — ვქმნით ახალ ივენთს`);
    } else {
      log('📭 completed ივენთი არ არის — ვცდით ახალი ივენთის შექმნას');
    }

    log('🔍 ESPN-დან შემდეგი ივენთის ძებნა...');
    const espnData = await findNextESPNEvent();
    if (espnData) {
      const eventId = await createEventFromESPN(espnData);
      if (eventId && ODDS_API_KEY) {
        log('📊 კოეფიციენტების წამოღება...');
        await updateOdds(eventId);
      }
    } else {
      log('📭 მომდევნო 30 დღეში UFC ივენთი ვერ მოიძებნა — შემდეგ გაშვებაზე ისევ ვცდით');
    }
    return;
  }

  const eventDate = new Date(upcoming.event_date);
  const hoursUntil = (eventDate.getTime() - Date.now()) / 3600000;
  log(`📅 ${upcoming.name}`);
  log(`⏰ ${hoursUntil > 0 ? Math.round(hoursUntil) + ' საათი დარჩა' : 'ივენთი დასრულდა ' + Math.abs(Math.round(hoursUntil)) + ' საათის წინ'}`);

  if (hoursUntil > 1) {
    const hour = new Date().getUTCHours();
    const isOddsHour = [7, 19].includes(hour);
    const minute = new Date().getUTCMinutes();
    if (ODDS_API_KEY && isOddsHour && minute < 30) {
      log(`📊 კოეფიციენტების განახლება (${hour}:00 UTC / ${(hour + 4) % 24}:00 თბილისი — დღეში 2-ჯერ)...`);
      await updateOdds(upcoming.id);
    } else {
      const nextUtc = [7, 19].find(h => h > hour) ?? 7;
      log(`⏳ ველოდებით (კოეფ. შემდეგი განახლება: ${nextUtc}:00 UTC / ${(nextUtc + 4) % 24}:00 თბილისი)`);
    }

    if (shouldRunBackup()) {
      await backupToSheets(upcoming.name);
    }

    return;
  }

  if (hoursUntil > -0.5) {
    log('🔴 ივენთი მიმდინარეობს — ველოდებით');
    return;
  }

  log('🏁 ივენთი დასრულდა — შედეგების წამოღება + settlement...');
  await fetchResultsAndSettle(upcoming.id, upcoming.event_date);

  await backupToSheets(upcoming.name);

  log('✅ Settlement დასრულდა — შედეგები ჩანს საიტზე. ახალი ივენთი settlement-იდან 1 საათში შეიქმნება.');
}

main()
  .then(() => log('✅ Auto script finished'))
  .catch(async (e) => {
    log(`❌ Fatal error: ${e.message}`);
    // ერრორი ტელეგრამზე — რომ ხელით მიხედვა შესაძლ იყოს
    try {
      await sendTelegram(`🚨 <b>auto.js ჩავარდა (Fatal error)</b>\n\n<code>${(e.message || String(e)).slice(0, 500)}</code>\n\n➡️ საჭიროა ხელით შემოწმება. settlement შესაძლოა არ დასრულებულა.`);
    } catch (_) { /* თუ telegram-იც ჩავარდა, აღარაფერი გვრჩება ლოგის გარდა */ }
    process.exit(1);
  });
