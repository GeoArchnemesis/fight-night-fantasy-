// supabase/functions/telegram-bot/index.ts
// Fight Night Fantasy — Telegram Bot (Supabase Edge Function)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1'
const corsHeaders = { 'Content-Type': 'application/json' }
const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard'
const sb = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)
const TG_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!
const ODDS_API_KEY = Deno.env.get('ODDS_API_KEY') || ''
const ADMIN_CHAT_ID = Deno.env.get('TELEGRAM_CHAT_ID') || ''
const TG_WEBHOOK_SECRET = Deno.env.get('TELEGRAM_WEBHOOK_SECRET') || ''
const ADMIN_NOTIFY_SECRET = Deno.env.get('ADMIN_NOTIFY_SECRET') || ''

async function sendMsg(chatId: string | number, text: string) {
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST', headers: corsHeaders,
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
  })
}

function countryToFlag(alt: string): string {
  const map: Record<string, string> = {
    'USA':'🇺🇸','Canada':'🇨🇦','Mexico':'🇲🇽','Brazil':'🇧🇷','Argentina':'🇦🇷',
    'Colombia':'🇨🇴','Peru':'🇵🇪','Chile':'🇨🇱','Ecuador':'🇪🇨','Venezuela':'🇻🇪',
    'Uruguay':'🇺🇾','Jamaica':'🇯🇲','Trinidad and Tobago':'🇹🇹','Dominican Republic':'🇩🇴',
    'Puerto Rico':'🇵🇷','Guyana':'🇬🇾','Cuba':'🇨🇺','Aruba':'🇦🇼','Panama':'🇵🇦',
    'United Kingdom':'🇬🇧','England':'🏴󠁧󠁢󠁥󠁮󠁧󠁿','Scotland':'🏴󠁧󠁢󠁳󠁣󠁴󠁿','Wales':'🏴󠁧󠁢󠁷󠁬󠁳󠁿',
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
  }
  return map[alt] || '🏳️'
}

function nameSimilarity(a: string, b: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, ' ').trim().split(/\s+/).filter(Boolean)
  const wa = norm(a), wb = norm(b)
  let matches = 0
  for (const w of wa) {
    if (wb.some(x => x.startsWith(w.slice(0, 4)) || w.startsWith(x.slice(0, 4)))) matches++
  }
  return matches / Math.max(wa.length, wb.length, 1)
}

async function fetchAthleteDetails(espnId: string) {
  try {
    const res = await fetch(`https://sports.core.api.espn.com/v2/sports/mma/athletes/${espnId}`)
    const a = await res.json()
    return { age: a.age || null, height_cm: a.height ? Math.round(a.height * 2.54) : null, weight_kg: a.weight ? Math.round(a.weight * 0.4536) : null, reach_cm: a.reach ? Math.round(a.reach * 2.54) : null }
  } catch { return { age: null, height_cm: null, weight_kg: null, reach_cm: null } }
}

function parseESPNMethod(comp: any): string {
  const sources = [comp.headlines?.[0]?.description || '', comp.notes?.[0]?.headline || '', comp.status?.type?.description || '']
  for (const src of sources) {
    if (!src) continue
    const s = src.toLowerCase()
    if (s.includes('ko') || s.includes('tko')) return 'KO/TKO'
    if (s.includes('sub')) return 'Submission'
    if (s.includes('dec') || s.includes('decision') || s.includes('unanimous') || s.includes('split')) return 'Decision'
    if (s.includes('no contest')) return 'No Contest'
    if (s.includes('dq')) return 'DQ'
  }
  return ''
}

async function upsertFighter(f: any): Promise<number | null> {
  const slug = f.name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-')
  const imageUrl = f.espn_id ? `https://a.espncdn.com/i/headshots/mma/players/full/${f.espn_id}.png` : null
  const { data: existing } = await sb.from('fighters').select('id').eq('name', f.name).maybeSingle()
  if (existing) {
    const upd: any = {}
    if (f.age) upd.age = f.age; if (f.height_cm) upd.height_cm = f.height_cm
    if (f.weight_kg) upd.weight_kg = f.weight_kg; if (f.reach_cm) upd.reach_cm = f.reach_cm
    if (f.record) upd.record = f.record; if (f.espn_id) upd.espn_id = f.espn_id
    if (imageUrl) upd.image_url = imageUrl
    if (Object.keys(upd).length) await sb.from('fighters').update(upd).eq('id', existing.id)
    return existing.id
  }
  const { data, error } = await sb.from('fighters').insert({
    name: f.name, flag: f.flag, country: f.country, record: f.record || null,
    ufc_slug: slug, espn_id: f.espn_id || null, image_url: imageUrl,
    age: f.age || null, height_cm: f.height_cm || null, weight_kg: f.weight_kg || null, reach_cm: f.reach_cm || null,
  }).select().maybeSingle()
  if (error) return null
  return data?.id || null
}

// მხოლოდ ფოტოების განახლება — ივენთს/ბრძოლებს/კოეფიციენტებს/ბილეთებს არ ეხება
async function cmdUpdatePhotos(chatId: number): Promise<string> {
  // 1. მიმდინარე ივენთი DB-დან (უახლესი მომავალი, ან ბოლო)
  const nowIso = new Date().toISOString()
  let { data: evRows } = await sb.from('events').select('id,name').gte('event_date', nowIso).order('event_date', { ascending: true }).limit(1)
  if (!evRows || evRows.length === 0) {
    const past = await sb.from('events').select('id,name').lt('event_date', nowIso).order('event_date', { ascending: false }).limit(1)
    evRows = past.data
  }
  if (!evRows || evRows.length === 0) return '❌ ივენთი ვერ მოიძებნა ბაზაში'
  const dbEvent = evRows[0]

  // 2. ESPN-იდან იგივე სახელის ივენთი
  const today = new Date()
  let espnData: any = null
  for (let i = 0; i <= 30; i++) {
    const d = new Date(today); d.setDate(d.getDate() + i)
    const dateStr = d.toISOString().slice(0, 10).replace(/-/g, '')
    try {
      const res = await fetch(`${ESPN_BASE}?dates=${dateStr}`)
      const data = await res.json()
      if (data.events && data.events.length > 0 && data.events[0].name === dbEvent.name) { espnData = data; break }
      if (data.events && data.events.length > 0 && !espnData) espnData = data
    } catch {}
  }
  if (!espnData) return '❌ ESPN-ზე ივენთი ვერ მოიძებნა'
  const event = espnData.events[0]

  // 3. ყველა მებრძოლს მხოლოდ image_url + espn_id განუახლე (name-ით)
  let updated = 0, missing = 0
  const comps = event.competitions || []
  for (const c of comps) {
    for (const comp of (c.competitors || [])) {
      const name = comp?.athlete?.fullName || ''
      const espnId = comp?.id || ''
      if (!name || !espnId) { missing++; continue }
      const imageUrl = `https://a.espncdn.com/i/headshots/mma/players/full/${espnId}.png`
      const { data: existing } = await sb.from('fighters').select('id').eq('name', name).maybeSingle()
      if (!existing) { missing++; continue }
      await sb.from('fighters').update({ image_url: imageUrl, espn_id: espnId }).eq('id', existing.id)
      updated++
    }
  }
  return `✅ <b>ფოტოები განახლდა</b>\n\n${event.name}\n🖼️ ${updated} მებრძოლი განახლდა${missing ? `\n⚠️ ${missing} ვერ მოიძებნა` : ''}`
}

async function cmdUpdateEvent(chatId: number): Promise<string> {
  const today = new Date()
  let espnData: any = null
  for (let i = 0; i <= 30; i++) {
    const d = new Date(today); d.setDate(d.getDate() + i)
    const dateStr = d.toISOString().slice(0, 10).replace(/-/g, '')
    try {
      const res = await fetch(`${ESPN_BASE}?dates=${dateStr}`)
      const data = await res.json()
      if (data.events && data.events.length > 0) { espnData = data; break }
    } catch {}
  }
  if (!espnData) return '❌ მომდევნო 30 დღეში UFC ივენთი ვერ მოიძებნა'
  const event = espnData.events[0]
  const venue = event.competitions[0]?.venue
  const city = venue?.address?.city || '', country = venue?.address?.country || ''
  const location = city && country ? `${city}, ${country}` : city || country
  // #8: დუბლის შემოწმება case-insensitive-ად (ilike) — auto.js-ის იდენტურად
  const { data: existingRows, error: existingErr } = await sb.from('events')
    .select('id').ilike('name', event.name).order('id', { ascending: true })
  if (existingErr) return `❌ ივენთის შემოწმება ვერ მოხერხდა: ${existingErr.message}`
  if (existingRows && existingRows.length > 0) {
    return `ℹ️ ივენთი უკვე არსებობს (${existingRows.length} ჩანაწერი):\n<b>${event.name}</b>`
  }
  // #9: ჯერ ივენთი იქმნება — ბალანსების რესეტი მხოლოდ წარმატებული insert-ის შემდეგ
  const { data: evData, error: evErr } = await sb.from('events').insert({
    name: event.name, location, event_date: event.date, status: 'upcoming'
  }).select().maybeSingle()
  if (evErr) {
    // #8: unique index-მა (events_name_lower_unique) დაიჭირა პარალელური insert
    if ((evErr as any).code === '23505') return `ℹ️ ივენთი პარალელურად შეიქმნა — დუბლი აღკვეთილია:\n<b>${event.name}</b>`
    return `❌ ივენთის შეცდომა: ${evErr.message}`
  }
  // #7: ბალანსის reset მხოლოდ მაშინ, თუ ძველ ივენთებზე pending ბილეთი აღარ დარჩა
  // (თორემ ჩამოჭრილი stake-ები "უფასო" ხდება). Settlement ჯერ უნდა დასრულდეს.
  const { count: leftoverPending } = await sb.from('tickets')
    .select('id', { count: 'exact', head: true }).eq('status', 'pending')
  if ((leftoverPending || 0) > 0) {
    return `⚠️ ივენთი შეიქმნა, მაგრამ ბალანსები არ დარესეტდა — ${leftoverPending} pending ბილეთია ძველ ივენთზე.\nჯერ გაუშვი settlement (<b>settle</b>), მერე <b>reset</b>.`
  }
  await sb.from('users').update({ balance: 1000 }).gte('id', '00000000-0000-0000-0000-000000000000')
  const comps = [...event.competitions].reverse()
  let saved = 0
  for (let idx = 0; idx < comps.length; idx++) {
    const c = comps[idx]
    const redC = c.competitors.find((x: any) => x.order === 1) || c.competitors[0]
    const blueC = c.competitors.find((x: any) => x.order === 2) || c.competitors[1]
    const rounds = c.format?.regulation?.periods || 3
    const redDet = redC?.id ? await fetchAthleteDetails(redC.id) : {}
    const blueDet = blueC?.id ? await fetchAthleteDetails(blueC.id) : {}
    const red = { name: redC?.athlete?.fullName || '', flag: countryToFlag(redC?.athlete?.flag?.alt || ''), country: redC?.athlete?.flag?.alt || '', record: redC?.records?.[0]?.summary || '', espn_id: redC?.id || '', ...redDet }
    const blue = { name: blueC?.athlete?.fullName || '', flag: countryToFlag(blueC?.athlete?.flag?.alt || ''), country: blueC?.athlete?.flag?.alt || '', record: blueC?.records?.[0]?.summary || '', espn_id: blueC?.id || '', ...blueDet }
    const redId = await upsertFighter(red)
    const blueId = await upsertFighter(blue)
    if (!redId || !blueId) continue
    const { error } = await sb.from('fights').insert({
      event_id: evData!.id, red_fighter_id: redId, blue_fighter_id: blueId,
      weight_class: c.type?.abbreviation || 'Unknown', max_rounds: rounds,
      bout_order: idx + 1, red_odds: null, blue_odds: null, show_details: false, status: 'upcoming',
    })
    if (!error) saved++
  }
  return `✅ <b>ივენთი შეიქმნა</b>\n\n${event.name}\n📍 ${location}\n🥊 ${saved} ბრძოლა`
}

async function cmdUpdateOdds(chatId: number): Promise<string> {
  if (!ODDS_API_KEY) return '❌ ODDS_API_KEY არ არის კონფიგურირებული'
  const { data: upcomingEvents } = await sb.from('events').select('id,name').eq('status', 'upcoming').order('event_date', { ascending: true }).limit(1)
  if (!upcomingEvents || upcomingEvents.length === 0) return '❌ upcoming ივენთი ვერ მოიძებნა'
  const ev = upcomingEvents[0]
  const { data: fights } = await sb.from('fights').select('id,red:fighters!red_fighter_id(name),blue:fighters!blue_fighter_id(name)').eq('event_id', ev.id).eq('status', 'upcoming')
  if (!fights || fights.length === 0) return '❌ ბრძოლები ვერ მოიძებნა'
  const url = `https://api.the-odds-api.com/v4/sports/mma_mixed_martial_arts/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=h2h&oddsFormat=decimal`
  const oddsRes = await fetch(url)
  const oddsData = await oddsRes.json()
  let updated = 0
  const lines: string[] = []
  for (const fight of fights) {
    const redName = (fight as any).red?.name || '', blueName = (fight as any).blue?.name || ''
    let bestGame: any = null, bestScore = 0
    for (const game of oddsData) {
      const score = Math.max(
        nameSimilarity(game.home_team, redName) + nameSimilarity(game.away_team, blueName),
        nameSimilarity(game.home_team, blueName) + nameSimilarity(game.away_team, redName)
      )
      if (score > bestScore) { bestScore = score; bestGame = game }
    }
    if (bestScore < 1.0 || !bestGame) continue   // #14
    const preferred = ['pinnacle', 'betonlineag', 'betsson', 'nordicbet', 'coolbet']
    let bm: any = null
    for (const key of preferred) { bm = bestGame.bookmakers.find((b: any) => b.key === key); if (bm) break }
    if (!bm) bm = bestGame.bookmakers?.[0]
    const h2h = bm?.markets?.find((m: any) => m.key === 'h2h')
    if (!h2h) continue
    const redOdds = h2h.outcomes.find((o: any) => nameSimilarity(o.name, redName) > 0.4)?.price
    const blueOdds = h2h.outcomes.find((o: any) => nameSimilarity(o.name, blueName) > 0.4)?.price
    if (!redOdds || !blueOdds) continue
    await sb.from('fights').update({ red_odds: Math.round(redOdds * 100) / 100, blue_odds: Math.round(blueOdds * 100) / 100 }).eq('id', fight.id)
    lines.push(`${redName.split(' ').pop()} <b>${redOdds.toFixed(2)}</b> | ${blueName.split(' ').pop()} <b>${blueOdds.toFixed(2)}</b>`)
    updated++
  }
  return `📊 <b>კოეფიციენტები განახლდა</b>\n${ev.name}\n\n${updated}/${fights.length} ბრძოლა\n\n${lines.join('\n')}`
}

async function cmdSettle(chatId: number): Promise<string> {
  const { data: events } = await sb.from('events').select('id,name').in('status', ['upcoming', 'completed'])
  if (!events || events.length === 0) return '❌ ივენთი ვერ მოიძებნა'
  let targetEvent: any = null
  for (const ev of events) {
    const { data: f } = await sb.from('fights').select('id').eq('event_id', ev.id).eq('status', 'completed').limit(1)
    if (f && f.length > 0) { targetEvent = ev; break }
  }
  if (!targetEvent) return '❌ completed ბრძოლა ვერ მოიძებნა — ჯერ შედეგები შეიყვანე'

  // #5: settlement მთლიანად სერვერზე, ერთ ატომურ ტრანზაქციაში (settle_event_tickets RPC).
  // ბილეთების/ქულების/refund-ის/ივენთის-დახურვის მთელი ლოგიკა ერთ ადგილასაა —
  // auto.js-იც და ადმინ პანელიც (admin_settle_event) იმავე ფუნქციას იყენებენ.
  const { data: res, error } = await sb.rpc('settle_event_tickets', { p_event_id: targetEvent.id })
  if (error || !res?.ok) return `❌ Settlement ჩავარდა: ${res?.error || error?.message || 'უცნობი შეცდომა'}`

  return `🏁 <b>Settlement დასრულდა</b>\n${targetEvent.name}\n\n✅ ${res.won} მოგებული\n❌ ${res.lost} წაგებული\n⏭ ${res.skipped} გამოტოვებული${res.voided > 0 ? `\n↩️ ${res.voided} სრული void (stake დაბრუნდა)` : ''}${res.unmatched_winner > 0 ? `\n🚨 ${res.unmatched_winner} leg: გამარჯვებულის სახელი ვერ დაემთხვა — ხელით შეამოწმე` : ''}`
}

async function cmdFetchResults(chatId: number): Promise<string> {
  const { data: allEvents } = await sb.from('events').select('id,name,event_date').in('status', ['upcoming', 'completed']).order('event_date', { ascending: false })
  if (!allEvents || allEvents.length === 0) return '❌ ივენთი ვერ მოიძებნა'
  let ev: any = null
  for (const e of allEvents) {
    const { data: upFights } = await sb.from('fights').select('id').eq('event_id', e.id).eq('status', 'upcoming').limit(1)
    if (upFights && upFights.length > 0) { ev = e; break }
  }
  if (!ev) ev = allEvents[0]
  const dateStr = new Date(ev.event_date).toISOString().slice(0, 10).replace(/-/g, '')
  const res = await fetch(`${ESPN_BASE}?dates=${dateStr}`)
  const data = await res.json()
  if (!data.events || !data.events.length) return '❌ ESPN: ივენთი ვერ მოიძებნა'
  // ორმაგი card-ის დღეს სწორ ივენთს სახელით ვირჩევთ
  const espnEvent = data.events.find((e: any) => e.name === ev.name) || data.events[0]
  if (espnEvent.status?.type?.state === 'pre') return 'ℹ️ ივენთი ჯერ არ დაწყებულა'
  // espn_id აუცილებელია ID-ზე დაფუძნებული დამთხვევისა და ჩანაცვლების დეტექციისთვის (auto.js-ის სარკე)
  const { data: dbFights } = await sb.from('fights')
    .select('id,status,red:fighters!red_fighter_id(name,espn_id),blue:fighters!blue_fighter_id(name,espn_id)')
    .eq('event_id', ev.id)
  if (!dbFights) return '❌ ბრძოლები ვერ მოიძებნა DB-ში'
  let updated = 0, voidedCount = 0
  const lines: string[] = []
  for (const comp of espnEvent.competitions) {
    if (comp.status?.type?.state !== 'post') continue
    const winner = comp.competitors.find((c: any) => c.winner)
    if (!winner) continue
    const winnerName = winner.athlete?.fullName || ''
    const method = parseESPNMethod(comp)
    const round = comp.status?.period || ''

    // ── #13: დამთხვევა მხოლოდ ID-ით — სახელით fallback მოხსნილია ──
    const espnIds = (comp.competitors || []).map((c: any) => String(c.id || '')).filter(Boolean)
    if (!espnIds.length) { lines.push(`⚠️ competitor ID-ები არ არის ("${winnerName}") — გამოტოვება`); continue }
    const match: any = dbFights.find((f: any) => {
      const rid = String(f.red?.espn_id || '')
      const bid = String(f.blue?.espn_id || '')
      return (rid && espnIds.includes(rid)) || (bid && espnIds.includes(bid))
    })
    if (!match) { lines.push(`⚠️ ბრძოლა ID-ით ვერ დაემთხვა ("${winnerName}") — შეამოწმე fighters.espn_id`); continue }

    const rid = String(match.red?.espn_id || '')
    const bid = String(match.blue?.espn_id || '')
    const winnerId = String(winner.id || '')
    const winnerKnown = !!winnerId && ((winnerId === rid) || (winnerId === bid))

    // ── ჩანაცვლების დეტექცია: გამარჯვებულის ID ამ ბრძოლის არცერთ მხარეს არ ეკუთვნის → void ──
    if (rid && bid && !winnerKnown) {
      await sb.from('fights').update({ status: 'completed', is_voided: true }).eq('id', match.id)
      lines.push(`⚖️ ${match.red?.name} vs ${match.blue?.name} → void (ჩანაცვლება)`)
      voidedCount++
      continue
    }

    // ── #13/#4: გამარჯვებული მხოლოდ ID-ით — ვერ დადგინდა → ვტოვებთ (settlement skip-ავს) ──
    if (!winnerKnown) {
      lines.push(`⚠️ ${match.red?.name} vs ${match.blue?.name}: გამარჯვებულის ID ვერ დაემთხვა (espn_id შეავსე)`)
      continue
    }
    const exactWinner: string = winnerId === rid ? match.red.name : match.blue.name
    await sb.from('fights').update({ status: 'completed', result_winner: exactWinner, result_method: method, result_round: round ? parseInt(round) : null }).eq('id', match.id)
    lines.push(`🏆 ${exactWinner} (${method}, R${round}) [ID✓]`)
    updated++
  }
  if (updated === 0 && voidedCount === 0) return 'ℹ️ დასრულებული ბრძოლები ვერ მოიძებნა'
  return `🏆 <b>შედეგები განახლდა</b>\n${ev.name}\n\n${lines.join('\n')}${voidedCount ? `\n\n⚖️ ${voidedCount} ბრძოლა ნეიტრალდა (ჩანაცვლება)` : ''}`
}

async function cmdFull(chatId: number): Promise<string> {
  const lines: string[] = ['🔄 <b>სრული ციკლი დაიწყო...</b>\n']
  await sendMsg(chatId, '⏳ 1/4 — ივენთის შემოწმება...')
  const evResult = await cmdUpdateEvent(chatId)
  lines.push(evResult)
  await sendMsg(chatId, '⏳ 2/4 — კოეფიციენტები...')
  const oddsResult = await cmdUpdateOdds(chatId)
  lines.push('\n' + oddsResult)
  await sendMsg(chatId, '⏳ 3/4 — ESPN შედეგები...')
  const resultsResult = await cmdFetchResults(chatId)
  lines.push('\n' + resultsResult)
  await sendMsg(chatId, '⏳ 4/4 — Settlement...')
  const settleResult = await cmdSettle(chatId)
  lines.push('\n' + settleResult)
  return lines.join('\n')
}

async function cmdStatus(chatId: number): Promise<string> {
  const { data: ev } = await sb.from('events').select('name,event_date,status').order('event_date', { ascending: false }).limit(1).maybeSingle()
  const { data: users } = await sb.from('users').select('id')
  const { data: tickets } = await sb.from('tickets').select('id,status')
  const pending = tickets?.filter(t => t.status === 'pending').length || 0
  const won = tickets?.filter(t => t.status === 'won').length || 0
  const lost = tickets?.filter(t => t.status === 'lost').length || 0
  const eventDate = ev ? new Date(ev.event_date) : null
  const hoursUntil = eventDate ? Math.round((eventDate.getTime() - Date.now()) / 3600000) : '?'
  return `📊 <b>სტატუსი</b>\n\n📅 ${ev?.name || '—'}\n⏰ ${hoursUntil > 0 ? hoursUntil + ' საათი დარჩა' : 'დასრულებულია'}\n📌 სტატუსი: ${ev?.status || '—'}\n\n👥 ${users?.length || 0} მომხმარებელი\n🎫 ${pending} pending | ${won} won | ${lost} lost`
}

async function cmdResetBalances(chatId: number, force = false): Promise<string> {
  // #7: აქტიური ივენთის pending ბილეთების დროს რესეტი stake-ებს "უფასოს" გახდიდა
  // (ჩამოჭრა უქმდება, ბილეთი კი ცოცხალი რჩება). ამიტომ დაცვა — გადალახვა: "reset force"
  if (!force) {
    const { data: activeEvents } = await sb.from('events').select('id').neq('status', 'completed')
    const ids = (activeEvents || []).map((e: any) => e.id)
    if (ids.length) {
      const { count: pendCount } = await sb.from('tickets').select('id', { count: 'exact', head: true }).in('event_id', ids).eq('status', 'pending')
      if ((pendCount || 0) > 0) {
        return `⛔ აქტიურ ივენთზე ${pendCount} pending ბილეთია — რესეტი მათ stake-ებს ეფექტურად გააუქმებდა.\n\nთუ მაინც გინდა, დაწერე: <b>reset force</b>`
      }
    }
  }
  const { count, error } = await sb.from('users').update({ balance: 1000 }).gte('id', '00000000-0000-0000-0000-000000000000').select('id', { count: 'exact', head: true })
  if (error) return `❌ შეცდომა: ${error.message}`
  return `💰 <b>ბალანსები დარესეტდა</b>\n\n${count || 0} მომხმარებლის ბალანსი → 1,000 ქულა`
}

// ── MAIN HANDLER ─────────────────────────────────────────────

// ═══════════════════════════════ F1 კომანდები ═══════════════════════════════
const CLOUDBET_API_KEY = Deno.env.get('CLOUDBET_API_KEY') || ''
const CB_BASE = 'https://sports-api.cloudbet.com/pub/v2/odds'

function f1SlugToName(slug: string): string {
  return slug.replace(/^s-/, '').replace(/-/g, ' ').trim().toLowerCase()
}
function f1Deaccent(s: string): string {
  return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
}

async function latestF1Race(onlyUpcoming = false): Promise<any> {
  let q = sb.from('f1_races').select('id,name,status,completed_at').order('id', { ascending: false }).limit(1)
  if (onlyUpcoming) q = sb.from('f1_races').select('id,name,status,completed_at').eq('status', 'upcoming').order('id', { ascending: false }).limit(1)
  const { data } = await q
  return data && data[0] ? data[0] : null
}

// settle/result-ისთვის: ის upcoming რბოლა, რომლის race-market-ის start_time უკვე
// გასულია (დასამუშავებელი). თუ ასეთი არაა, უახლესი upcoming. ასე settle/result
// ახალ, ჯერ-არ-დაწყებულ რბოლას აღარ მოხვდება (#13).
async function raceDueForSettlement(): Promise<any> {
  const { data: races } = await sb.from('f1_races')
    .select('id,name,status,completed_at,f1_markets(kind,start_time)')
    .eq('status', 'upcoming').order('id', { ascending: false })
  if (!races || !races.length) return null
  const now = Date.now()
  const due = races.find((r: any) => {
    const rm = (r.f1_markets || []).find((m: any) => m.kind === 'race')
    return rm && rm.start_time && new Date(rm.start_time).getTime() <= now
  })
  const pick = due || races[0]
  return { id: pick.id, name: pick.name, status: pick.status, completed_at: pick.completed_at }
}


const ESPN_F1 = 'https://site.api.espn.com/apis/site/v2/sports/racing/f1/scoreboard'
const SEASON = new Date().getUTCFullYear()   // მიმდინარე წელი — ხელით ცვლა არ სჭირდება

// ESPN-იდან მომდევნო F1 რბოლის შექმნა (OpenF1 401-ს აბრუნებს — ეს მისი ჩამნაცვლებელია)
async function cmdF1CreateEvent(chatId: number): Promise<string> {
  let cal: any
  try {
    const r = await fetch(`${ESPN_F1}?dates=${SEASON}`, { signal: AbortSignal.timeout(15000) })
    cal = await r.json()
  } catch (e) { return `❌ ESPN-თან კავშირი ვერ მოხერხდა: ${(e as Error).message}` }
  const events = (cal.events || []).filter((e: any) => e.status?.type?.state === 'pre')
  if (!events.length) return '📭 ESPN-ზე მომავალი F1 რბოლა ვერ მოიძებნა'
  events.sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime())
  const ev = events[0]
  const raceName = ev.name
  const location = ev.circuit?.address?.country || ev.circuit?.place?.country || null

  const { data: exist } = await sb.from('f1_races').select('id,status').ilike('name', raceName).maybeSingle()
  if (exist) return `ℹ️ "${raceName}" უკვე ბაზაშია (id ${exist.id}, ${exist.status}).`

  const { data: race, error: rErr } = await sb.from('f1_races')
    .insert({ name: raceName, location, season: SEASON, status: 'upcoming' })
    .select('id').maybeSingle()
  if (rErr || !race) return `❌ რბოლის შექმნა ვერ მოხერხდა: ${rErr?.message || 'უცნობი'}`

  const comps = ev.competitions || []
  const compTime = (test: (a: string) => boolean) => {
    const c = comps.find((x: any) => test((x.type?.abbreviation || x.type?.text || '').toLowerCase()))
    return c?.date || null
  }
  // სპრინტ-weekend? ESPN აღნიშნავს SS (sprint quali) + SR (sprint race)
  const isSprint = comps.some((x: any) => {
    const a = (x.type?.abbreviation || x.type?.text || '').toLowerCase()
    return a === 'ss' || a === 'sr' || a.includes('sprint')
  })

  // markets: quali + race + fastest_lap ყოველთვის; sprint-ის ორი — თუ სპრინტ-weekend-ია
  const marketDefs: any[] = [
    { kind: 'quali',       start_time: compTime(a => a.includes('qual') && !a.includes('ss')) },
    { kind: 'race',        start_time: compTime(a => a === 'race' || (a.includes('race') && !a.includes('sprint') && a !== 'sr')) },
    { kind: 'fastest_lap', start_time: compTime(a => a === 'race' || a.includes('race')) },
  ]
  if (isSprint) {
    marketDefs.push({ kind: 'sprint_quali', start_time: compTime(a => a === 'ss' || a.includes('sprint') && a.includes('qual')) })
    marketDefs.push({ kind: 'sprint',       start_time: compTime(a => a === 'sr' || (a.includes('sprint') && !a.includes('qual'))) })
  }

  const { data: mkts, error: mErr } = await sb.from('f1_markets')
    .insert(marketDefs.map(d => ({ race_id: race.id, kind: d.kind, start_time: d.start_time, status: 'upcoming', is_voided: false })))
    .select('id,kind')
  if (mErr || !mkts) return `⚠️ რბოლა შეიქმნა (id ${race.id}), მაგრამ markets ვერ ჩაიწერა: ${mErr?.message}`

  // ყველა მძღოლი entry-ებად თითო market-ში — price=null (კოეფი დაკეტილი),
  // is_enabled=false (ფსონი ვერ დაიდება სანამ კოეფი არ ჩაიწერება), მაგრამ საიტზე ჩანან
  const { data: drivers } = await sb.from('f1_drivers').select('id')
  if (drivers && drivers.length) {
    const entries: any[] = []
    for (const m of mkts) for (const d of drivers)
      entries.push({ market_id: m.id, driver_id: d.id, price: null, is_enabled: false })
    const { error: eErr } = await sb.from('f1_market_entries').insert(entries)
    if (eErr) return `⚠️ რბოლა+markets შეიქმნა, მაგრამ მძღოლები ვერ ჩაიწერა: ${eErr.message}`
  }

  const fmtT = (t: string | null) => t ? new Date(t).toLocaleString('ka-GE', { timeZone: 'Asia/Tbilisi' }) : '—'
  const mkList = mkts.map((m: any) => '• ' + m.kind).join('\n')
  return `🏎️ <b>F1 რბოლა შეიქმნა</b>\n\n<b>${raceName}</b>\n📍 ${location || '—'}\n${isSprint ? '⚡ სპრინტ-weekend\n' : ''}\n<b>ბაზრები:</b>\n${mkList}\n\n🕒 ქვალიფიკაცია: ${fmtT(compTime(a => a.includes('qual')))}\n🏁 რბოლა: ${fmtT(compTime(a => a === 'race'))}\n\n✅ ${drivers?.length || 0} მძღოლი ჩაიწერა (კოეფები დაკეტილია)`
}

async function cmdF1Status(chatId: number): Promise<string> {
  const race = await latestF1Race()
  if (!race) return '🏎️ ბაზაში რბოლა არ არის'
  const { data: markets } = await sb.from('f1_markets')
    .select('id,kind,status,start_time,is_voided,result_driver_id').eq('race_id', race.id).order('id')
  const { count: pend } = await sb.from('f1_tickets').select('id', { count: 'exact', head: true })
    .eq('race_id', race.id).eq('status', 'pending')
  const lines = (markets || []).map((m: any) => {
    const res = m.is_voided ? '⚖️ void' : (m.result_driver_id ? '✅ შედეგი ჩაწერილია' : (m.status === 'completed' ? 'completed' : '⏳'))
    const st = m.start_time ? new Date(m.start_time).toLocaleString('ka-GE', { timeZone: 'Asia/Tbilisi' }) : '—'
    return `• <b>${m.kind}</b> | ${st} | ${res}`
  }).join('\n')
  return `🏎️ <b>${race.name}</b> (${race.status})\n\n${lines || 'მარკეტები არ არის'}\n\n🎫 pending ბილეთი: ${pend || 0}`
}

async function cmdF1Odds(chatId: number): Promise<string> {
  if (!CLOUDBET_API_KEY) return '⚠️ CLOUDBET_API_KEY არ არის დაყენებული Edge Function-ზე.\nგაუშვი: <code>supabase secrets set CLOUDBET_API_KEY=...</code> და ფუნქცია თავიდან დარედეპლოიდე.'
  const race = await latestF1Race(true)
  if (!race) return '🏎️ upcoming რბოლა არ არის — კოეფების განახლება არაფერზეა'
  const { data: markets } = await sb.from('f1_markets').select('id,kind,cb_key').eq('race_id', race.id)
  const withKey = (markets || []).filter((m: any) => m.cb_key)
  if (!withKey.length) return `⚠️ ${race.name}-ის მარკეტებს cb_key არ აქვთ — Cloudbet-ზე ვერ მივაბამ`
  const { data: drivers } = await sb.from('f1_drivers').select('id,name')
  const byName: Record<string, any> = {}
  for (const d of drivers || []) byName[f1Deaccent(d.name)] = d
  const out: string[] = []
  for (const m of withKey) {
    try {
      const r = await fetch(`${CB_BASE}/competitions/${m.cb_key}`, { headers: { 'X-API-Key': CLOUDBET_API_KEY } })
      if (!r.ok) { out.push(`${m.kind}: ❌ Cloudbet ${r.status}`); continue }
      const d = await r.json()
      const ev = (d.events || [])[0]
      const mkt = ev && ev.markets && ev.markets['motorsport.outright.v3']
      const sels = mkt && mkt.submarkets && mkt.submarkets.default && mkt.submarkets.default.selections
      if (!sels) { out.push(`${m.kind}: კოეფები ვერ მოიძებნა`); continue }
      let matched = 0
      for (const s of sels) {
        if (s.outcome === 's-the-field') continue
        const drv = byName[f1Deaccent(f1SlugToName(s.outcome))]
        if (!drv) continue
        await sb.from('f1_market_entries').upsert({
          market_id: m.id, driver_id: drv.id, price: s.price, probability: s.probability,
          is_enabled: s.status === 'SELECTION_ENABLED', updated_at: new Date().toISOString(),
        }, { onConflict: 'market_id,driver_id' })
        matched++
      }
      out.push(`${m.kind}: ✅ ${matched} კოეფი განახლდა`)
    } catch (e) { out.push(`${m.kind}: ❌ ${(e as Error).message}`) }
  }
  return `📊 <b>F1 კოეფები — ${race.name}</b>\n\n${out.join('\n')}`
}

// ხელით შედეგის ჩაწერა: "f1 შედეგი race 1" (kind + მძღოლის ნომერი) — OpenF1-ის ჩამნაცვლებელი

// ESPN-იდან F1 შედეგების ავტომატური წამოღება — ხელით მძღოლის ნომრის შეყვანა აღარ სჭირდება.
// ESPN აბრუნებს race/quali გამარჯვებულს (winner:true), მას სახელით ვამთხვევთ f1_drivers-ს.
async function cmdF1ResultAuto(chatId: number): Promise<string> {
  const race = await raceDueForSettlement()
  if (!race) return '🏎️ დასამუშავებელი რბოლა ვერ მოიძებნა'

  // ESPN-ის კალენდრიდან ამ რბოლის ჩანაწერი (სახელით)
  let cal: any
  try {
    const r = await fetch(`${ESPN_F1}?dates=${SEASON}`, { signal: AbortSignal.timeout(15000) })
    cal = await r.json()
  } catch (e) { return `❌ ESPN-თან კავშირი ვერ მოხერხდა: ${(e as Error).message}` }

  // სახელით დამთხვევა (ESPN-ის სახელი DB-ს სახელს შეიძლება ოდნავ განსხვავდებოდეს)
  const norm = (s: string) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]/g, '')   // deaccent: Hülkenberg→hulkenberg, Pérez→perez
  const espnEv = (cal.events || []).find((e: any) => norm(e.name).includes(norm(race.name).slice(0, 8)) || norm(race.name).includes(norm(e.name).slice(0, 8)))
  if (!espnEv) return `⚠️ ESPN-ზე "${race.name}" ვერ მოიძებნა — შედეგი ხელით: <b>f1 შედეგი race [ნომერი]</b>`

  // DB მძღოლები სახელით ძებნისთვის
  const { data: drivers } = await sb.from('f1_drivers').select('id,name')
  const dmap: Record<string, any> = {}
  for (const d of drivers || []) dmap[norm(d.name)] = d
  const findDrv = (espnName: string) => {
    const n = norm(espnName)
    if (dmap[n]) return dmap[n]
    // გვარით (ბოლო სიტყვა)
    const last = norm((espnName || '').split(' ').pop() || '')
    return (drivers || []).find((d: any) => norm(d.name).includes(last) && last.length >= 4) || null
  }

  const { data: markets } = await sb.from('f1_markets')
    .select('id,kind,result_driver_id').eq('race_id', race.id)
  if (!markets || !markets.length) return `⚠️ ${race.name}-ს მარკეტები არ აქვს`

  const out: string[] = []
  for (const mkt of markets) {
    if (mkt.result_driver_id) { out.push(`${mkt.kind}: უკვე ჩაწერილია`); continue }
    // ESPN competition ამ kind-ისთვის
    const comp = (espnEv.competitions || []).find((c: any) => {
      const a = (c.type?.abbreviation || c.type?.text || '').toLowerCase()
      if (mkt.kind === 'race') return a === 'race' || a.includes('race')
      if (mkt.kind === 'quali') return a.includes('qual')
      if (mkt.kind === 'sprint') return a.includes('sprint')
      return false
    })
    if (!comp) { out.push(`${mkt.kind}: ESPN-ზე ვერ მოიძებნა`); continue }
    if (comp.status?.type?.state !== 'post') { out.push(`${mkt.kind}: ჯერ არ დასრულებულა`); continue }
    const winner = (comp.competitors || []).find((x: any) => x.winner) || (comp.competitors || [])[0]
    const wName = winner?.athlete?.displayName || winner?.athlete?.fullName
    const drv = wName ? findDrv(wName) : null
    if (!drv) { out.push(`${mkt.kind}: გამარჯვებული "${wName}" ბაზაში ვერ მოიძებნა`); continue }
    await sb.from('f1_markets').update({ result_driver_id: drv.id, status: 'completed' }).eq('id', mkt.id)
    out.push(`${mkt.kind}: 🏆 ${drv.name}`)
  }
  return `🏁 <b>${race.name} — ESPN შედეგები</b>\n\n${out.join('\n')}\n\nბილეთების დასათვლელად: <b>f1 settle</b>`
}

async function cmdF1Result(chatId: number, text: string): Promise<string> {
  const m = text.match(/(race|quali|sprint)\s+(\d{1,2})/)
  if (!m) return '📝 ფორმატი: <b>f1 შედეგი race 1</b>\n(kind: race / quali / sprint, მერე გამარჯვებული მძღოლის ნომერი)\n\nმძღოლების ნომრები: <b>f1 მძღოლები</b>'
  const kind = m[1], num = parseInt(m[2])
  const race = await raceDueForSettlement()
  if (!race) return '🏎️ რბოლა ვერ მოიძებნა'
  const { data: mkt } = await sb.from('f1_markets').select('id,kind,result_driver_id').eq('race_id', race.id).eq('kind', kind).maybeSingle()
  if (!mkt) return `⚠️ ${race.name}-ს "${kind}" მარკეტი არ აქვს`
  const { data: drv } = await sb.from('f1_drivers').select('id,name').eq('car_number', num).maybeSingle()
  if (!drv) return `⚠️ მძღოლი #${num} ბაზაში ვერ მოიძებნა`
  await sb.from('f1_markets').update({ result_driver_id: drv.id, status: 'completed' }).eq('id', mkt.id)
  return `🏆 <b>${race.name}</b> — ${kind}: გამარჯვებული <b>${drv.name}</b> (#${num})\n\nბილეთების დასათვლელად: <b>f1 settle</b>`
}

async function cmdF1Drivers(chatId: number): Promise<string> {
  const { data } = await sb.from('f1_drivers').select('car_number,name').order('car_number')
  if (!data || !data.length) return 'მძღოლები ვერ მოიძებნა'
  return '🏎️ <b>მძღოლები</b>\n\n' + data.map((d: any) => `#${d.car_number ?? '—'} ${d.name}`).join('\n')
}

async function cmdF1Settle(chatId: number): Promise<string> {
  const race = await raceDueForSettlement()
  if (!race) return '🏎️ რბოლა ვერ მოიძებნა'
  const { data: res, error } = await sb.rpc('settle_f1_race_tickets', { p_race_id: race.id })
  if (error || !res?.ok) return `❌ F1 settlement ჩავარდა: ${res?.error || error?.message || 'უცნობი'}`
  let tail = ''
  // ყველა მარკეტი დასრულებულია → რბოლა completed + ბალანსების reset (f1-auto.js-ის ლოგიკის სარკე)
  const { data: mkts } = await sb.from('f1_markets').select('status,is_voided').eq('race_id', race.id)
  const allDone = (mkts || []).length > 0 && (mkts || []).every((x: any) => x.status === 'completed' || x.is_voided)
  if (allDone && race.status !== 'completed') {
    const patch: any = { status: 'completed' }
    if (!race.completed_at) patch.completed_at = new Date().toISOString()
    await sb.from('f1_races').update(patch).eq('id', race.id)
    const { data: rr } = await sb.rpc('f1_reset_balances', { p_completed_race_id: race.id })
    tail = `\n\n✅ რბოლა → completed\n💰 F1 ბალანსები → 1,000 (${rr?.reset || 0} მომხმარებელი)`
  }
  return `🏁 <b>F1 Settlement — ${race.name}</b>\n\n✅ ${res.won} მოგებული\n❌ ${res.lost} წაგებული\n⏭ ${res.skipped} გამოტოვებული${res.voided > 0 ? `\n↩️ ${res.voided} void` : ''}${tail}`
}

async function cmdF1Reset(chatId: number, force = false): Promise<string> {
  if (!force) {
    const { data: up } = await sb.from('f1_races').select('id').eq('status', 'upcoming')
    const ids = (up || []).map((r: any) => r.id)
    if (ids.length) {
      const { count } = await sb.from('f1_tickets').select('id', { count: 'exact', head: true }).in('race_id', ids).eq('status', 'pending')
      if ((count || 0) > 0) return `⛔ upcoming რბოლაზე ${count} pending ბილეთია.\nთუ მაინც გინდა: <b>f1 reset force</b>`
    }
  }
  const race = await latestF1Race()
  const { data: r, error } = await sb.rpc('f1_reset_balances', { p_completed_race_id: race ? race.id : 0 })
  if (error || !r?.ok) return `❌ შეცდომა: ${r?.error || error?.message}`
  return `💰 <b>F1 ბალანსები დარესეტდა</b>\n\n${r.reset || 0} მომხმარებელი → 1,000${r.deducted_users ? `\n${r.deducted_users}-ს pending ჩამოეჭრა` : ''}`
}

async function cmdF1Full(chatId: number): Promise<string> {
  await sendMsg(chatId, '⏳ F1 სრული ციკლი...')
  const odds = await cmdF1Odds(chatId)
  await sendMsg(chatId, odds)
  const settle = await cmdF1Settle(chatId)
  await sendMsg(chatId, settle)
  return await cmdF1Status(chatId)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('OK', { status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Telegram-Bot-Api-Secret-Token, X-Admin-Secret' } })
  }
  if (req.method !== 'POST') {
    return new Response('OK', { status: 200 })
  }
  try {
    const body = await req.json()
    if (body.notify) {
      const providedSecret = req.headers.get('X-Admin-Secret') || ''
      if (!ADMIN_NOTIFY_SECRET || providedSecret !== ADMIN_NOTIFY_SECRET) {
        return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Access-Control-Allow-Origin': '*' } })
      }
      if (ADMIN_CHAT_ID) await sendMsg(ADMIN_CHAT_ID, body.notify)
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { ...corsHeaders, 'Access-Control-Allow-Origin': '*' } })
    }
    const tgSecret = req.headers.get('X-Telegram-Bot-Api-Secret-Token') || ''
    if (!TG_WEBHOOK_SECRET || tgSecret !== TG_WEBHOOK_SECRET) {
      return new Response('OK', { status: 200 })
    }
    const msg = body.message
    if (!msg || !msg.text) return new Response('OK', { status: 200 })
    const chatId = msg.chat.id
    const text = msg.text.toLowerCase().trim()
    if (!ADMIN_CHAT_ID || String(chatId) !== String(ADMIN_CHAT_ID)) {
      await sendMsg(chatId, '⛔ არ გაქვს წვდომა')
      return new Response('OK', { status: 200 })
    }
    let response = ''
    // ── F1 ბრძანებები (ჯერ ეს — "f1 კოეფ" UFC-ის ბრენჩში რომ არ ჩავარდეს) ──
    if (text.startsWith('f1') || text.startsWith('/f1')) {
      const t = text.replace(/^\/?f1\s*/, '')
      if (t.includes('სტატუს') || t.includes('status') || t === '') {
        response = await cmdF1Status(chatId)
      } else if (t.includes('კოეფ') || t.includes('odds')) {
        await sendMsg(chatId, '⏳ Cloudbet კოეფები...')
        response = await cmdF1Odds(chatId)
      } else if (t.includes('შედეგ') || t.includes('result')) {
        // ნომრით → ხელით; ნომრის გარეშე → ESPN-იდან ავტომატურად
        if (/(race|quali|sprint)\s+\d/.test(t)) {
          response = await cmdF1Result(chatId, t)
        } else {
          await sendMsg(chatId, '⏳ ESPN-დან F1 შედეგების წამოღება...')
          response = await cmdF1ResultAuto(chatId)
        }
      } else if (t.includes('მძღოლ') || t.includes('driver')) {
        response = await cmdF1Drivers(chatId)
      } else if (t.includes('settle') || t.includes('დამუშავ')) {
        await sendMsg(chatId, '⏳ F1 Settlement...')
        response = await cmdF1Settle(chatId)
      } else if (t.includes('რესეტ') || t.includes('reset')) {
        response = await cmdF1Reset(chatId, t.includes('force') || t.includes('ძალით'))
      } else if (t.includes('სრულად') || t.includes('full')) {
        response = await cmdF1Full(chatId)
      } else if (t.includes('ივენთ') || t.includes('რბოლ') || t.includes('race') || t.includes('event')) {
        await sendMsg(chatId, '⏳ ESPN-დან F1 რბოლის ძებნა...')
        response = await cmdF1CreateEvent(chatId)
      } else {
        response = '🤷 ვერ გავიგე. F1 ბრძანებები: <b>help</b>'
      }
    }
    else if (text === '/start' || text === 'help' || text === '/help') {
      response = `🥊 <b>Fight Night Fantasy Bot</b>\n\n<b>── UFC ──</b>\n📥 <b>ივენთი</b> — ESPN-დან მომდევნო ივენთი\n🖼️ <b>ფოტო</b> — მებრძოლების ფოტოები\n📊 <b>კოეფიციენტები</b> — Odds API განახლება\n🏆 <b>შედეგები</b> — ESPN-დან შედეგები\n🏁 <b>settle</b> — ბილეთების დამუშავება\n🔄 <b>სრულად</b> — ყველაფერი ერთად\n📋 <b>სტატუსი</b> — მდგომარეობა\n💰 <b>რესეტი</b> — ბალანსები → 1,000\n\n<b>── F1 ──</b>\n📥 <b>f1 ივენთი</b> — ESPN-დან მომდევნო რბოლა\n📋 <b>f1 სტატუსი</b> — რბოლა/მარკეტები/ბილეთები\n📊 <b>f1 კოეფ</b> — Cloudbet კოეფების განახლება\n🏆 <b>f1 შედეგი</b> — ESPN-დან ავტომატურად (ან ხელით: <b>f1 შედეგი race 1</b>)\n🏎️ <b>f1 მძღოლები</b> — ნომრების სია\n🏁 <b>f1 settle</b> — ბილეთები + რბოლის დახურვა + რესეტი\n💰 <b>f1 რესეტი</b> — F1 ბალანსები → 1,000\n🔄 <b>f1 სრულად</b> — კოეფ+settle+სტატუსი`
    }
    else if (text.includes('ივენთ') || text.includes('event') || text === '/event') {
      await sendMsg(chatId, '⏳ ESPN-დან ძებნა...')
      response = await cmdUpdateEvent(chatId)
    }
    else if (text.includes('ფოტო') || text.includes('photo') || text === '/photos') {
      await sendMsg(chatId, '⏳ ფოტოების განახლება...')
      response = await cmdUpdatePhotos(chatId)
    }
    else if (text.includes('კოეფ') || text.includes('odds') || text === '/odds') {
      await sendMsg(chatId, '⏳ Odds API...')
      response = await cmdUpdateOdds(chatId)
    }
    else if (text.includes('შედეგ') || text.includes('result') || text === '/results') {
      await sendMsg(chatId, '⏳ ESPN შედეგები...')
      response = await cmdFetchResults(chatId)
    }
    else if (text.includes('settle') || text.includes('დამუშავება') || text === '/settle') {
      await sendMsg(chatId, '⏳ Settlement...')
      response = await cmdSettle(chatId)
    }
    else if (text.includes('სრულად') || text.includes('full') || text === '/full') {
      response = await cmdFull(chatId)
    }
    else if (text.includes('სტატუს') || text.includes('status') || text === '/status') {
      response = await cmdStatus(chatId)
    }
    else if (text.includes('რესეტ') || text.includes('reset') || text === '/reset') {
      await sendMsg(chatId, '⏳ ბალანსების რესეტი...')
      response = await cmdResetBalances(chatId, text.includes('force') || text.includes('ძალით'))
    }
    else {
      response = '🤷 ვერ გავიგე. დაწერე <b>help</b> კომანდების სანახავად.'
    }
    await sendMsg(chatId, response)
    return new Response('OK', { status: 200 })
  } catch (e) {
    console.error('Bot error:', e)
    return new Response('OK', { status: 200 })
  }
})
