// supabase/functions/telegram-bot/index.ts
// Fight Night Fantasy — Telegram Bot (Supabase Edge Function)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = { 'Content-Type': 'application/json' }

// ESPN
const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard'

// Supabase (ავტომატურად ხელმისაწვდომია Edge Function-ში)
const sb = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

const TG_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!
const ODDS_API_KEY = Deno.env.get('ODDS_API_KEY') || ''
const ADMIN_CHAT_ID = Deno.env.get('TELEGRAM_CHAT_ID') || ''

// ── Telegram helpers ─────────────────────────────────────────

async function sendMsg(chatId: string | number, text: string) {
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: corsHeaders,
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
  })
}

// ── ESPN helpers ─────────────────────────────────────────────

function countryToFlag(alt: string): string {
  const map: Record<string, string> = {
    'Azerbaijan':'🇦🇿','Brazil':'🇧🇷','Russia':'🇷🇺','USA':'🇺🇸','Kazakhstan':'🇰🇿',
    'Georgia':'🇬🇪','Armenia':'🇦🇲','Ukraine':'🇺🇦','Mexico':'🇲🇽','Germany':'🇩🇪',
    'Poland':'🇵🇱','Sweden':'🇸🇪','Australia':'🇦🇺','France':'🇫🇷','Ireland':'🇮🇪',
    'Canada':'🇨🇦','Netherlands':'🇳🇱','China':'🇨🇳','Japan':'🇯🇵','United Kingdom':'🇬🇧',
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

// ── upsert fighter ──────────────────────────────────────────

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

// ── COMMANDS ─────────────────────────────────────────────────

async function cmdUpdateEvent(chatId: number): Promise<string> {
  // ESPN-დან მომდევნო ივენთის ძებნა
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

  // შევამოწმოთ არსებობს თუ არა
  const { data: existing } = await sb.from('events').select('id').eq('name', event.name).maybeSingle()
  if (existing) return `ℹ️ ივენთი უკვე არსებობს:\n<b>${event.name}</b>`

  // ბალანსები → 1000
  await sb.from('users').update({ balance: 1000 }).gte('id', '00000000-0000-0000-0000-000000000000')

  // ივენთი
  const { data: evData, error: evErr } = await sb.from('events').insert({
    name: event.name, location, event_date: event.date, status: 'upcoming'
  }).select().maybeSingle()
  if (evErr) return `❌ ივენთის შეცდომა: ${evErr.message}`

  // ბრძოლები
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
      bout_order: idx + 1, red_odds: 1.80, blue_odds: 2.00, show_details: false, status: 'upcoming',
    })
    if (!error) saved++
  }

  return `✅ <b>ივენთი შეიქმნა</b>\n\n${event.name}\n📍 ${location}\n🥊 ${saved} ბრძოლა\n💰 ბალანსები → 1,000`
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
    if (bestScore < 0.5 || !bestGame) continue

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

  // ივენთი completed ბრძოლებით
  let targetEvent: any = null
  for (const ev of events) {
    const { data: f } = await sb.from('fights').select('id').eq('event_id', ev.id).eq('status', 'completed').limit(1)
    if (f && f.length > 0) { targetEvent = ev; break }
  }
  if (!targetEvent) return '❌ completed ბრძოლა ვერ მოიძებნა — ჯერ შედეგები შეიყვანე'

  const { data: fights } = await sb.from('fights').select('id,result_winner,result_method,result_round,red:fighters!red_fighter_id(name),blue:fighters!blue_fighter_id(name)').eq('event_id', targetEvent.id).eq('status', 'completed')
  if (!fights || fights.length === 0) return '❌ completed ბრძოლა არ არის'

  const fightMap: Record<string, any> = {}
  fights.forEach((f: any) => { fightMap[f.id] = { result_winner: f.result_winner || '', result_method: f.result_method || '', result_round: f.result_round || null, red_name: f.red?.name || '', blue_name: f.blue?.name || '' } })

  const { data: tickets } = await sb.from('tickets').select('id,type,stake,total_odds,user_id,ticket_selections(id,fight_id,picked_fighter,picked_round,picked_method,odds)').eq('event_id', targetEvent.id).eq('status', 'pending').is('settled_at', null)
  if (!tickets || tickets.length === 0) return 'ℹ️ pending ბილეთი ვერ მოიძებნა'

  let wonCount = 0, lostCount = 0, skipped = 0
  for (const ticket of tickets) {
    const sels = (ticket as any).ticket_selections || []
    const results = sels.map((sel: any) => {
      const fight = fightMap[sel.fight_id]
      if (!fight || !fight.result_winner) return null
      const winnerSide = fight.result_winner === fight.red_name ? 'red' : 'blue'
      if (sel.picked_fighter && sel.picked_fighter !== winnerSide) return false
      if (sel.picked_round) { if (Number(fight.result_round) !== Number(sel.picked_round)) return false }
      if (sel.picked_method) {
        const r = (fight.result_method || '').toLowerCase()
        const p = sel.picked_method
        if (p === 'ნოკაუტი' && !r.includes('ko') && !r.includes('tko')) return false
        if (p === 'მტკივნეული' && !r.includes('sub')) return false
        if (p === 'გადაწყვეტილება' && !r.includes('dec') && !r.includes('decision')) return false
      }
      return true
    })
    if (results.some((r: any) => r === null)) { skipped++; continue }
    const allWon = results.every((r: any) => r === true)
    const anyLost = results.some((r: any) => r === false)
    const newStatus = anyLost ? 'lost' : (allWon ? 'won' : 'pending')
    if (newStatus === 'pending') { skipped++; continue }

    // თითო selection-ის result ჩაწერა (✅/❌)
    for (let si = 0; si < sels.length; si++) {
      const r = results[si]
      if (r === true || r === false) {
        await sb.from('ticket_selections').update({ result: r ? 'ok' : 'no' }).eq('id', sels[si].id)
      }
    }

    await sb.from('tickets').update({ status: newStatus, settled_at: new Date().toISOString() }).eq('id', ticket.id)
    if (newStatus === 'won') {
      wonCount++
      const winnings = Math.round(Number(ticket.stake) * Number(ticket.total_odds))
      await sb.rpc('increment_user_score', { p_user_id: ticket.user_id, p_amount: winnings })
      await sb.from('score_history').insert({ user_id: ticket.user_id, amount: winnings })
    } else { lostCount++ }
  }

  await sb.from('events').update({ status: 'completed' }).eq('id', targetEvent.id)
  return `🏁 <b>Settlement დასრულდა</b>\n${targetEvent.name}\n\n✅ ${wonCount} მოგებული\n❌ ${lostCount} წაგებული\n⏭ ${skipped} გამოტოვებული`
}

async function cmdFetchResults(chatId: number): Promise<string> {
  // იპოვე ივენთი რომელსაც აქვს ჯერ დაუსრულებელი (upcoming) ბრძოლები — ივენთის სტატუსის მიუხედავად
  const { data: allEvents } = await sb.from('events').select('id,name,event_date').in('status', ['upcoming', 'completed']).order('event_date', { ascending: false })
  if (!allEvents || allEvents.length === 0) return '❌ ივენთი ვერ მოიძებნა'

  let ev: any = null
  for (const e of allEvents) {
    const { data: upFights } = await sb.from('fights').select('id').eq('event_id', e.id).eq('status', 'upcoming').limit(1)
    if (upFights && upFights.length > 0) { ev = e; break }
  }
  // თუ ყველა ბრძოლა დასრულებულია, აიღე უახლესი ივენთი მაინც (ხელახლა გადასამოწმებლად)
  if (!ev) ev = allEvents[0]

  const dateStr = new Date(ev.event_date).toISOString().slice(0, 10).replace(/-/g, '')

  const res = await fetch(`${ESPN_BASE}?dates=${dateStr}`)
  const data = await res.json()
  if (!data.events || !data.events.length) return '❌ ESPN: ივენთი ვერ მოიძებნა'

  const espnEvent = data.events[0]
  if (espnEvent.status?.type?.state === 'pre') return 'ℹ️ ივენთი ჯერ არ დაწყებულა'

  const { data: dbFights } = await sb.from('fights').select('id,status,red:fighters!red_fighter_id(name),blue:fighters!blue_fighter_id(name)').eq('event_id', ev.id)
  if (!dbFights) return '❌ ბრძოლები ვერ მოიძებნა DB-ში'

  let updated = 0
  const lines: string[] = []
  for (const comp of espnEvent.competitions) {
    if (comp.status?.type?.state !== 'post') continue
    const winner = comp.competitors.find((c: any) => c.winner)
    if (!winner) continue
    const winnerName = winner.athlete?.fullName || ''
    const method = parseESPNMethod(comp)
    const round = comp.status?.period || ''

    const match = dbFights.find((f: any) => nameSimilarity(f.red?.name || '', winnerName) > 0.4 || nameSimilarity(f.blue?.name || '', winnerName) > 0.4)
    if (!match) continue

    // მკაცრი შემოწმება — winner ნამდვილად ერთ-ერთი მებრძოლია
    const mRed = nameSimilarity(match.red?.name || '', winnerName)
    const mBlue = nameSimilarity(match.blue?.name || '', winnerName)
    if (mRed < 0.5 && mBlue < 0.5) continue
    const exactWinner = mRed >= mBlue ? match.red.name : match.blue.name

    await sb.from('fights').update({ status: 'completed', result_winner: exactWinner, result_method: method, result_round: round ? parseInt(round) : null }).eq('id', match.id)
    lines.push(`🏆 ${exactWinner} (${method}, R${round})`)
    updated++
  }

  if (updated === 0) return 'ℹ️ დასრულებული ბრძოლები ვერ მოიძებნა'
  return `🏆 <b>შედეგები განახლდა</b>\n${ev.name}\n\n${lines.join('\n')}`
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

// ── MAIN HANDLER ─────────────────────────────────────────────

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('OK', { status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' } })
  }
  if (req.method !== 'POST') {
    return new Response('OK', { status: 200 })
  }

  try {
    const body = await req.json()

    // ── Admin Panel notification ──
    if (body.notify) {
      if (ADMIN_CHAT_ID) await sendMsg(ADMIN_CHAT_ID, body.notify)
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { ...corsHeaders, 'Access-Control-Allow-Origin': '*' } })
    }

    const msg = body.message
    if (!msg || !msg.text) return new Response('OK', { status: 200 })

    const chatId = msg.chat.id
    const text = msg.text.toLowerCase().trim()

    // უსაფრთხოება — მხოლოდ ადმინის chat_id
    if (ADMIN_CHAT_ID && String(chatId) !== String(ADMIN_CHAT_ID)) {
      await sendMsg(chatId, '⛔ არ გაქვს წვდომა')
      return new Response('OK', { status: 200 })
    }

    let response = ''

    if (text === '/start' || text === 'help' || text === '/help') {
      response = `🥊 <b>Fight Night Fantasy Bot</b>\n\nკომანდები:\n\n📥 <b>ივენთი</b> — ESPN-დან მომდევნო ივენთი\n📊 <b>კოეფიციენტები</b> — Odds API განახლება\n🏆 <b>შედეგები</b> — ESPN-დან შედეგები\n🏁 <b>settlement</b> — ბილეთების დამუშავება\n🔄 <b>სრულად</b> — ყველაფერი ერთად\n📋 <b>სტატუსი</b> — მიმდინარე მდგომარეობა`
    }
    else if (text.includes('ივენთ') || text.includes('event') || text === '/event') {
      await sendMsg(chatId, '⏳ ESPN-დან ძებნა...')
      response = await cmdUpdateEvent(chatId)
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
