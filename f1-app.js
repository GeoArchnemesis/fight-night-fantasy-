// ============================================================
//  F1 Fantasy — f1-app.js  (app.js-ის სარკე, F1-ზე მორგებული)
//  ბალანსი: user_balances(sport='f1') via get_sport_balance
//  markets: რბოლის + კვალიფიკაციის გამარჯვებული
// ============================================================
(function () {
if (window.__FNF_F1_LOADED__) { console.warn('[FNF] f1-app.js უკვე ჩატვირთულია'); return; }
window.__FNF_F1_LOADED__ = true;
// პროფილის გვერდი (/profile) ამ გასაღებით ხვდება, საიდან მოვიდა მომხმარებელი
try { localStorage.setItem('fnf_sport', 'f1'); } catch (e) {}

const SUPABASE_URL = "https://qxfcwsiysnjxhxljqigl.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF4ZmN3c2l5c25qeGh4bGpxaWdsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxODM4MDUsImV4cCI6MjA5Nzc1OTgwNX0.SOeTrxnKulgO8ao8HSwxyKE-m9pvaQ54Pa_IGWWyKDc";
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, lock: (name, t, fn) => fn() }
});

const SPORT = 'f1';

// ── helpers ──
const r2  = x => Math.round(x * 100) / 100;
const fmt = n => Number.isFinite(+n) ? Math.round(+n).toLocaleString('en-US') : '0';
const EN_MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const $ = id => document.getElementById(id);
function $on(id, ev, fn) { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); }
const KIND_LABEL = { race: 'რბოლის გამარჯვებული', quali: 'კვალიფიკაციის გამარჯვებული', fastest_lap: 'უსწრაფესი წრე', sprint: 'სპრინტის გამარჯვებული', sprint_quali: 'სპრინტ-კვალიფიკაციის გამარჯვებული' };
const KIND_SHORT = { race: 'რბოლა', quali: 'კვალიფიკაცია', fastest_lap: 'უსწრაფესი წრე', sprint: 'სპრინტი', sprint_quali: 'სპრინტ-კვალ.' };

// ── state ──
// MARKETS: [{ id, kind, start_time(Date), status, resultDriverId, isVoided, entries:[{driverId,name,team,colour,img,odds,enabled}] }]
let MARKETS = [];
const START = 1000;
const state = { balance: START, score: 0, picks: {}, mode: 'express', expressStake: 0, tickets: [], user: null, tkCollapsed: {}, raceName: '', raceId: null };
let currentUser = null;
let _balanceKnown = false;

// ── SERVER TIME ──
let _timeOffset = 0;
function serverNow() { return Date.now() + _timeOffset; }
async function syncServerTime() {
  try {
    const timeout = new Promise(resolve => setTimeout(() => resolve({ __timedOut: true }), 4000));
    const res = await Promise.race([sb.rpc('server_now'), timeout]);
    if (!res || res.__timedOut) return;
    const { data, error } = res;
    if (error || data == null) return;
    const serverMs = new Date(data).getTime();
    if (!Number.isFinite(serverMs)) return;
    _timeOffset = serverMs - Date.now();
  } catch (e) {}
}

// ── BETTING RULES (per market: იხურება დაწყებამდე 1 საათით ადრე) ──
const HOUR = 3600000;
function marketOpen(m) {
  if (!m) return false;
  if (m.status !== 'upcoming' || m.isVoided) return false;
  if (m.start_time && (m.start_time.getTime() - serverNow()) < HOUR) return false;
  return true;
}
function anyMarketOpen() { return MARKETS.some(marketOpen); }
function raceStart() { const rm = MARKETS.find(m => m.kind === 'race'); return rm ? rm.start_time : null; }
function qualiStart() { const qm = MARKETS.find(m => m.kind === 'quali'); return qm ? qm.start_time : null; }
// ქეშაუთი იხურება, როგორც კი პირველი სესია (ჩვეულებრივ კვალიფიკაცია) დაიწყება —
// ემთხვევა cashout_ticket_f1 RPC-ის ლოგიკას (თუ leg-ის market დაიწყო → ქეშაუთი დახურული).
function earliestMarketStart() {
  const ts = MARKETS.map(m => m.start_time ? m.start_time.getTime() : Infinity).filter(t => Number.isFinite(t));
  return ts.length ? Math.min(...ts) : null;
}
function canCashout() { const es = earliestMarketStart(); if (es == null) return true; return es > serverNow(); }
// per-ticket წესი (სერვერის cashout_ticket_f1-ის სარკე): ბილეთის ქეშაუთი ღიაა,
// სანამ ამ ბილეთის leg-ების არცერთი market არ დაწყებულა. მაგ: quali დაიწყო,
// მაგრამ ბილეთი მხოლოდ რბოლაზეა (ხვალ) → ქეშაუთი ისევ შესაძლებელია.
function ticketCanCashout(t) {
  const sels = (t && t.sels) || [];
  if (!sels.length) return canCashout();
  return sels.every(s => s.marketStart == null || s.marketStart > serverNow());
}

// ── CASHOUT POPUP ──
function showCashoutPopup(msg, ok) {
  let pop = document.getElementById('coPopup');
  if (!pop) {
    pop = document.createElement('div'); pop.id = 'coPopup';
    pop.style.cssText = 'position:fixed;inset:0;z-index:300;background:rgba(5,4,8,.8);backdrop-filter:blur(6px);display:flex;justify-content:center;align-items:center;padding:20px';
    pop.innerHTML = `<div style="background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:28px;max-width:340px;width:100%;text-align:center">
      <div id="coMsg" style="font-size:1.05rem;margin-bottom:18px"></div>
      <button id="coClose" class="btn btn-primary" style="width:100%">დახურვა</button></div>`;
    document.body.appendChild(pop);
    document.getElementById('coClose').onclick = () => { pop.style.display = 'none'; };
  }
  const m = document.getElementById('coMsg');
  m.innerHTML = msg; m.style.color = ok ? 'var(--green)' : 'var(--red-soft)';
  document.getElementById('coClose').textContent = 'დახურვა';
  document.getElementById('coClose').onclick = () => { pop.style.display = 'none'; };
  pop.style.display = 'flex';
}

// ქეშაუთის დადასტურების popup — UFC-ის ანალოგი (F1-ს აკლდა → ერთი შემთხვევითი
// დაჭერა შეუქცევად 80% ქეშაუთს იწვევდა). Promise<bool> აბრუნებს.
function confirmCashoutPopup(refundText) {
  return new Promise((resolve) => {
    let pop = document.getElementById('coConfirmPopup');
    if (!pop) {
      pop = document.createElement('div'); pop.id = 'coConfirmPopup';
      pop.style.cssText = 'position:fixed;inset:0;z-index:301;background:rgba(5,4,8,.8);backdrop-filter:blur(6px);display:flex;justify-content:center;align-items:center;padding:20px';
      pop.innerHTML = `<div style="background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:28px;max-width:340px;width:100%;text-align:center">
        <div id="coCfMsg" style="font-size:1.05rem;margin-bottom:20px"></div>
        <div style="display:flex;gap:10px">
          <button id="coCfNo" class="btn" style="flex:1;background:var(--ink);border:1px solid var(--line)">გაუქმება</button>
          <button id="coCfYes" class="btn btn-primary" style="flex:1">დადასტურება</button>
        </div></div>`;
      document.body.appendChild(pop);
    }
    document.getElementById('coCfMsg').innerHTML = refundText;
    pop.style.display = 'flex';
    const done = (v) => { pop.style.display = 'none'; resolve(v); };
    document.getElementById('coCfYes').onclick = () => done(true);
    document.getElementById('coCfNo').onclick = () => done(false);
    pop.onclick = (e) => { if (e.target === pop) done(false); };
  });
}

async function doCashout(idx) {
  const t = state.tickets[idx];
  if (!t || t.status !== 'open') return;
  if (!ticketCanCashout(t)) { showCashoutPopup('ქეშაუთი დახურულია — შენი ბილეთის სესია დაიწყო', false); return; }
  // დადასტურების popup — შემთხვევითი დაჭერისგან დაცვა (რეალურ თანხას სერვერი წყვეტს)
  // მიახლოებითი დაბრუნება: <1სთ 100%, მერე 80% (რეალურს სერვერი წყვეტს)
  const ageMs = serverNow() - (t.placedAt || serverNow());
  const est = Math.round((t.stake || 0) * (ageMs <= 3600000 ? 1 : 0.8));
  const confirmed = await confirmCashoutPopup(
    'ნამდვილად გსურს ქეშაუთი?<br>მიიღე <b>' + fmt(est) + '</b> ქულა');
  if (!confirmed) return;
  try {
    const { data: res, error } = await sb.rpc('cashout_ticket_f1', { p_ticket_id: t._dbId });
    if (error || !res || !res.ok) { showCashoutPopup('ქეშაუთი ვერ შესრულდა', false); return; }
    updateBalance(res.balance);
    t.status = 'cashout'; t.settledAt = serverNow();
    renderTickets();
    const pct = Math.round((res.pct || 0) * 100);
    showCashoutPopup('ქეშაუთი შესრულდა!<br>დაგიბრუნდა <b>' + fmt(res.refund) + '</b> ქულა (' + pct + '%)', true);
  } catch (e) { showCashoutPopup('შეცდომა — სცადე თავიდან', false); }
}

// ── LOAD RACE + MARKETS ──
async function loadRaceFromDB() {
  // upcoming რბოლები markets-ით
  const sel = `id,name,location,status,completed_at,openf1_meeting_key,
    f1_markets(id,kind,start_time,status,result_driver_id,is_voided,
      f1_market_entries(driver_id,price,probability,is_enabled,
        driver:f1_drivers!driver_id(name,team,team_colour,image_url,car_number)))`;
  let race = null;
  try {
    const { data: up } = await sb.from('f1_races').select(sel).eq('status', 'upcoming');
    if (up && up.length) {
      // ავირჩიოთ ის, ვის race-market start_time-იც უახლოეს მომავალშია
      const withStart = up.map(r => {
        const rm = (r.f1_markets || []).find(m => m.kind === 'race');
        return { r, start: rm && rm.start_time ? new Date(rm.start_time).getTime() : Infinity };
      }).sort((a, b) => a.start - b.start);
      race = (withStart.find(x => x.start >= serverNow() - 3 * HOUR) || withStart[0]).r;
    }
    if (!race) {
      const { data: done } = await sb.from('f1_races').select(sel).eq('status', 'completed').order('completed_at', { ascending: false }).limit(1);
      race = done && done[0];
    }
  } catch (e) { console.warn('loadRaceFromDB failed:', e); }
  if (!race) return null;

  state.raceId = race.id;
  state.raceName = race.name || '';
  window.__raceId = race.id;

  // markets აწყობა (race ჯერ, quali მერე)
  const order = { quali: 0, sprint_quali: 1, sprint: 2, race: 3, fastest_lap: 4 };
  MARKETS = (race.f1_markets || []).map(m => ({
    id: m.id, kind: m.kind,
    start_time: m.start_time ? new Date(m.start_time) : null,
    status: m.status || 'upcoming',
    resultDriverId: m.result_driver_id || null,
    isVoided: m.is_voided === true,
    entries: (m.f1_market_entries || [])
      .filter(e => e.driver)
      .map(e => ({
        driverId: e.driver_id,
        name: e.driver.name || '—',
        team: e.driver.team || '',
        colour: e.driver.team_colour ? ('#' + e.driver.team_colour) : 'var(--red)',
        img: e.driver.image_url || null,
        odds: e.price == null ? null : Number(e.price),
        enabled: e.is_enabled !== false
      }))
      .sort((a, b) => (a.odds == null ? 99 : a.odds) - (b.odds == null ? 99 : b.odds))
  })).sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9));

  // hero — ათვლა მომდევნო სესიაზე (კვალიფიკაცია → სპრინტი → რბოლა)
  const SESSION_TAG = { sprint_quali: 'UPCOMING SPRINT QUALI', quali: 'UPCOMING QUALIFYING', sprint: 'UPCOMING SPRINT', race: 'UPCOMING RACE' };
  window.__f1sessions = MARKETS
    .filter(m => SESSION_TAG[m.kind] && m.start_time)
    .map(m => ({ kind: m.kind, time: m.start_time.getTime(), tag: SESSION_TAG[m.kind] }))
    .sort((a, b) => a.time - b.time);
  window.__f1raceCompleted = (race.status === 'completed');
  const locEl = $('eventLocation2'); if (locEl) locEl.textContent = (race.location || race.name || '').toUpperCase();
  updateNextSession();

  const cdEl = $('countdown'), endedEl = $('eventEndedMsg');
  const over = (race.status === 'completed');
  if (cdEl) cdEl.style.display = over ? 'none' : '';
  if (endedEl) endedEl.style.display = over ? 'block' : 'none';

  return race;
}

// ── PICKS / ODDS ──
function entryOf(marketId, driverId) {
  const m = MARKETS.find(x => x.id === marketId); if (!m) return null;
  return m.entries.find(e => e.driverId === driverId) || null;
}
function pickOdds(marketId) { const p = state.picks[marketId]; return p ? Number(p.odds) || 0 : 0; }
function setPick(marketId, driverId) {
  const m = MARKETS.find(x => x.id === marketId); if (!m || !marketOpen(m)) return;
  const e = entryOf(marketId, driverId); if (!e || !e.enabled || e.odds == null) return;
  const cur = state.picks[marketId];
  if (cur && cur.driverId === driverId) delete state.picks[marketId];
  else state.picks[marketId] = { marketId, kind: m.kind, driverId, name: e.name, team: e.team, odds: e.odds, stake: (cur && cur.stake) || 0 };
  refresh();
}
function refresh() { renderMarkets(); renderSlip(); renderBar(); }

// ── RENDER MARKETS ──
function renderMarkets() {
  const wrap = document.getElementById('markets');
  if (!MARKETS.length) { wrap.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted)">ამ ეტაპზე რბოლა ხელმისაწვდომი არ არის.</div>'; return; }
  const noImg = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 120'%3E%3Crect width='120' height='120' fill='%230E0D14'/%3E%3Ccircle cx='60' cy='48' r='26' fill='%23F31D25' opacity='.85'/%3E%3Crect x='38' y='72' width='44' height='30' rx='6' fill='%23F31D25' opacity='.8'/%3E%3C/svg%3E";

  wrap.innerHTML = MARKETS.map(m => {
    const open = marketOpen(m);
    const completed = (m.status === 'completed' && m.resultDriverId);
    let note = '';
    if (m.isVoided) note = '<span style="color:var(--muted)">გაუქმებულია</span>';
    else if (completed) note = '<span style="color:var(--green)">დასრულდა</span>';
    else if (!open) note = '<span style="color:var(--muted)">ფსონები დაკეტილია</span>';

    const cards = m.entries.map(e => {
      const picked = state.picks[m.id] && state.picks[m.id].driverId === e.driverId;
      const isWinner = completed && m.resultDriverId === e.driverId;
      const has = e.odds != null && e.odds > 0;
      const canPick = open && has && e.enabled;
      const cls = 'f1-drv' + (picked ? ' on' : '') + (isWinner ? ' winner' : '');
      return `<button class="${cls}" ${canPick ? `data-pick="${m.id}" data-drv="${e.driverId}"` : 'disabled'} style="--team:${e.colour}">
        <span class="drv-badge" style="background:${e.colour}"></span>
        <img class="drv-img" src="${e.img || noImg}" alt="${e.name}" loading="lazy" width="44" height="44">
        <span class="drv-info"><span class="drv-name">${e.name}</span><span class="drv-team">${e.team}</span></span>
        <span class="drv-od">${has ? e.odds.toFixed(2) : '—'}</span>
      </button>`;
    }).join('');

    return `<div class="f1-market-group">
      <div class="f1-market-title ${m.kind}"><span class="dot"></span>${KIND_LABEL[m.kind] || m.kind} ${note ? '· ' + note : ''}</div>
      <div class="f1-drv-grid">${cards || '<div style="color:var(--muted);padding:12px">კოეფები ჯერ არ არის</div>'}</div>
    </div>`;
  }).join('');

  wrap.querySelectorAll('[data-pick]').forEach(b => { if (!b.disabled) b.onclick = () => setPick(+b.dataset.pick, +b.dataset.drv); });
  wrap.querySelectorAll('.drv-img').forEach(img => { img.addEventListener('error', function onErr() { this.removeEventListener('error', onErr); this.src = noImg; }); });
}

// ── SLIP ──
function picksArr() { return Object.keys(state.picks).map(k => +k).map(k => state.picks[k]); }
function comboOdds() { return r2(picksArr().reduce((p, s) => p * (Number.isFinite(s.odds) && s.odds > 0 ? s.odds : 1), 1)); }
function setMode(m) { state.mode = m; renderSlip(); }
function digits(inp) { const v = inp.value.replace(/[^0-9]/g, ''); inp.value = v; return +v || 0; }

function renderSlip() {
  const arr = picksArr();
  $('slipBadge').textContent = arr.length;
  $('tabExpress').classList.toggle('on', state.mode === 'express');
  $('tabSingle').classList.toggle('on', state.mode === 'single');
  const body = $('slipBody'), foot = $('slipFoot');
  if (arr.length === 0) { body.innerHTML = '<div class="slip-empty">ბილეთი ცარიელია.<br>აირჩიე მრბოლელი.</div>'; foot.innerHTML = ''; return; }
  body.innerHTML = arr.map(s => `
    <div class="sel">
      <div class="sel-top"><div><div class="sel-name">${s.name} — მოგება</div><div class="sel-mk">${KIND_SHORT[s.kind]} · კოეფ. ${Number(s.odds).toFixed(2)}</div></div>
        <button class="sel-rm" data-rm="${s.marketId}" aria-label="წაშლა">&times;</button></div>
      ${state.mode === 'single' ? `<div class="stake-row"><input class="stake-in" type="text" inputmode="numeric" placeholder="ფსონი (ქულა)" value="${s.stake || ''}" data-stake="${s.marketId}"><span class="sel-ret">მოგება: <b data-ret="${s.marketId}">${s.stake ? fmt(s.stake * s.odds) : '0'}</b></span></div>` : ''}
    </div>`).join('');
  body.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { delete state.picks[+b.dataset.rm]; refresh(); renderSlip(); });
  body.querySelectorAll('[data-stake]').forEach(inp => inp.oninput = () => {
    const i = +inp.dataset.stake, v = digits(inp);
    if (state.picks[i]) state.picks[i].stake = v;
    const r = body.querySelector('[data-ret="' + i + '"]'); if (r) r.textContent = fmt(v * pickOdds(i));
    updateTotals();
  });
  renderFoot();
}
function totalStakeSingle() { return picksArr().reduce((s, x) => s + (x.stake || 0), 0); }
function renderFoot() {
  const foot = $('slipFoot');
  if (state.mode === 'express') {
    const co = comboOdds(), st = state.expressStake;
    foot.innerHTML = `
      <div class="tot-row"><span class="lab">ჯამური კოეფიციენტი</span><span style="font-weight:700">${co.toFixed(2)}</span></div>
      <div class="tot-row"><span class="lab">ფსონი</span><input class="foot-stake" type="text" inputmode="numeric" placeholder="0" value="${st || ''}" id="expStake"></div>
      <div class="tot-row"><span class="lab">შესაძლო მოგება</span><span class="green" id="foWin">${fmt(st * co)} ქულა</span></div>
      <div class="stake-err" id="foErr" style="display:none">არასაკმარისი ქულები</div>
      <button class="btn btn-primary" id="placeBtn">ბილეთის დადება</button>`;
    const es = $('expStake'); if (es) es.oninput = () => { state.expressStake = digits(es); updateTotals(); };
  } else {
    foot.innerHTML = `
      <div class="tot-row"><span class="lab">ფსონი</span><span style="font-weight:700" id="foTot">${fmt(totalStakeSingle())} ქულა</span></div>
      <div class="tot-row"><span class="lab">შესაძლო მოგება</span><span class="green" id="foWin">${fmt(picksArr().reduce((s, x) => s + (x.stake || 0) * x.odds, 0))} ქულა</span></div>
      <div class="stake-err" id="foErr" style="display:none">არასაკმარისი ქულები</div>
      <button class="btn btn-primary" id="placeBtn">ბილეთის დადება</button>`;
  }
  $('placeBtn').onclick = placeBets;
  updateTotals();
}
function updateTotals() {
  renderBar();
  const pb = $('placeBtn'), err = $('foErr'), win = $('foWin');
  if (!pb) return;
  if (state.mode === 'express') {
    const co = comboOdds(), n = state.expressStake, over = n > state.balance;
    const es = $('expStake'); if (es) es.classList.toggle('over', over);
    if (win) win.textContent = fmt(n * co) + ' ქულა';
    if (err) err.style.display = over ? 'block' : 'none';
    pb.disabled = n <= 0 || over;
  } else {
    const ts = totalStakeSingle(), tr = picksArr().reduce((s, x) => s + (x.stake || 0) * x.odds, 0), over = ts > state.balance;
    const tot = $('foTot'); if (tot) { tot.textContent = fmt(ts) + ' ქულა'; tot.style.color = over ? 'var(--red-soft)' : ''; }
    if (win) win.textContent = fmt(tr) + ' ქულა';
    if (err) err.style.display = over ? 'block' : 'none';
    document.querySelectorAll('#slipBody .stake-in').forEach(x => x.classList.toggle('over', over));
    pb.disabled = ts <= 0 || over;
  }
}

// ── PLACE BETS ──
function betError(res, error) {
  const e = (res && res.error) || (error && error.message) || '';
  const map = {
    'insufficient balance': 'არასაკმარისი ქულები ბალანსზე',
    'betting closed': 'ფსონების მიღება დასრულებულია',
    'market closed': 'ეს ბაზარი დაკეტილია',
    'selection unavailable': 'ამ მრბოლელს კოეფიციენტი ჯერ არ აქვს',
    'not authenticated': 'გთხოვ, გაიარე ავტორიზაცია',
    'driver not in market': 'მრბოლელი ვერ მოიძებნა',
    'market not found': 'ბაზარი ვერ მოიძებნა'
  };
  return map[e] || ('ფსონი ვერ დაიდო: ' + (e || 'უცნობი შეცდომა'));
}
async function placeBets() {
  const pb = $('placeBtn');
  if (!currentUser) { closeSlip(); openModal('join'); return; }
  const arr = picksArr(); if (arr.length === 0) return;
  if (arr.some(s => !(Number.isFinite(s.odds) && s.odds > 0))) { alert('ერთ-ერთ არჩევანს კოეფიციენტი არ აქვს — წაშალე ბილეთიდან'); return; }
  const raceId = state.raceId; if (!raceId) { closeSlip(); alert('რბოლა ვერ მოიძებნა'); return; }

  if (pb) pb.disabled = true;
  await refreshBalance();
  try {
    if (state.mode === 'express') {
      const st = state.expressStake;
      if (st <= 0) return;
      if (st > state.balance) { updateTotals(); alert('არასაკმარისი ქულები (გაქვს ' + fmt(state.balance) + ')'); return; }
      const selections = arr.map(s => ({ market_id: s.marketId, driver_id: s.driverId }));
      const { data: res, error } = await sb.rpc('place_bet_f1', { p_race_id: raceId, p_type: 'express', p_stake: st, p_selections: selections });
      if (error || !res || !res.ok) { await refreshBalance(); updateTotals(); alert(betError(res, error)); return; }
      updateBalance(res.balance);
      const finalOdds = res.total_odds != null ? Number(res.total_odds) : comboOdds();
      state.tickets.unshift({ _dbId: res.ticket_id, type: 'express',
        sels: arr.map(s => ({ kind: s.kind, driverName: s.name, odds: s.odds, res: null })),
        stake: st, odds: finalOdds, status: 'open', placedAt: serverNow() });
    } else {
      const ts = totalStakeSingle();
      if (ts <= 0) return;
      if (ts > state.balance) { updateTotals(); alert('არასაკმარისი ქულები (გაქვს ' + fmt(state.balance) + ')'); return; }
      let placedAny = false;
      for (const s of arr) {
        if (s.stake > 0) {
          const selections = [{ market_id: s.marketId, driver_id: s.driverId }];
          const { data: res, error } = await sb.rpc('place_bet_f1', { p_race_id: raceId, p_type: 'single', p_stake: s.stake, p_selections: selections });
          if (error || !res || !res.ok) { await refreshBalance(); alert(betError(res, error)); continue; }
          updateBalance(res.balance); placedAny = true;
          const finalOdds = res.total_odds != null ? Number(res.total_odds) : s.odds;
          state.tickets.unshift({ _dbId: res.ticket_id, type: 'single',
            sels: [{ kind: s.kind, driverName: s.name, odds: s.odds, res: null }],
            stake: s.stake, odds: finalOdds, status: 'open', placedAt: serverNow() });
        }
      }
      if (!placedAny) { updateTotals(); return; }
    }
    state.picks = {}; state.expressStake = 0;
    closeSlip(); refresh(); renderSlip(); renderTickets();
  } catch (e) {
    console.warn('placeBets failed:', e);
    await refreshBalance(); updateTotals();
    alert('ფსონი ვერ დაიდო — სცადე თავიდან');
  } finally {
    const pb2 = $('placeBtn'); if (pb2) pb2.disabled = false;
    updateTotals();
  }
}

// ── TICKETS ──
async function loadUserTickets() {
  if (!currentUser) return;
  try {
    const { data: rows, error } = await sb.from('f1_tickets')
      .select(`id,type,stake,total_odds,status,placed_at,
        f1_selections(market_id,driver_id,odds,result,
          market:f1_markets!market_id(kind,start_time,result_driver_id,is_voided,status),
          driver:f1_drivers!driver_id(name))`)
      .eq('user_id', currentUser.id).order('placed_at', { ascending: false });
    if (error || !rows) return;
    const statusMap = { pending: 'open', open: 'open', won: 'won', lost: 'lost', cashout: 'cashout', void: 'void' };
    state.tickets = rows.map(tk => ({
      _dbId: tk.id, type: tk.type,
      sels: (tk.f1_selections || []).map(s => {
        const mk = s.market || {};
        // #15: მხოლოდ settlement-ის მიერ ჩაწერილი საბოლოო შედეგი — კლიენტი აღარ ითვლის
        const res = s.result || null;
        return { kind: mk.kind || 'race', driverName: (s.driver && s.driver.name) || '—', odds: Number(s.odds), res,
                 marketStart: mk.start_time ? new Date(mk.start_time).getTime() : null };
      }),
      stake: Number(tk.stake), odds: Number(tk.total_odds), status: statusMap[tk.status] || tk.status,
      placedAt: tk.placed_at ? new Date(tk.placed_at).getTime() : serverNow()
    }));
  } catch (e) { console.warn('loadUserTickets failed:', e); }
}

function renderTickets() {
  const activeList = $('activeTickets'), historyList = $('historyTickets');
  const activeTickets = state.tickets.filter(t => t.status === 'open');
  const historyTickets = state.tickets.filter(t => ['won','lost','cashout','void'].includes(t.status)).sort((a, b) => (b.placedAt || 0) - (a.placedAt || 0));

  const summaryEl = $('tkSummary'); if (summaryEl) summaryEl.textContent = state.tickets.length + ' ბილეთი';
  const ab = $('activeBadge'); if (ab) ab.textContent = activeTickets.length;
  const hb = $('historyBadge'); if (hb) hb.textContent = historyTickets.length;

  const stLabel = { open: 'მიმდინარე', won: 'მოგებული', lost: 'წაგებული', cashout: 'ქეშაუთი', void: 'ანულირებული' };
  // ქეშაუთის ღილაკი თითო ბილეთს ცალკე უმოწმდება (per-leg market start)

  const card = (t) => {
    const realIdx = state.tickets.indexOf(t);
    const key = t._dbId != null ? String(t._dbId) : ('idx' + realIdx);
    const showCashout = t.status === 'open' && ticketCanCashout(t);
    const totalOdds = Number(t.odds || 0).toFixed(2);
    const potentialWin = Math.round((t.stake || 0) * (t.odds || 0));
    const isCollapsed = state.tkCollapsed[key] !== false;
    // #6: void leg-ები ბილეთიდან ქრება — მხოლოდ აქტიური პოზიციები ჩანს
    const visSels = t.sels.filter(s => s.res !== 'void');
    const statusColor = t.status === 'won' ? 'var(--green)' : (t.status === 'lost' ? 'var(--red-soft)' : (t.status === 'cashout' ? 'var(--gold)' : (t.status === 'void' ? 'var(--muted)' : '#ff9d3c')));
    const winColor = t.status === 'won' ? 'var(--green)' : t.status === 'lost' ? 'var(--red-soft)' : 'var(--gold)';
    const winText = t.status === 'won' ? '+' + fmt(potentialWin) : fmt(potentialWin);
    const collapsed = `<div class="tk-collapsed-info">
        <div class="tkc-col"><span class="tkc-lbl">პოზიცია</span><span class="tkc-val">${visSels.length}</span></div>
        <div class="tkc-col"><span class="tkc-lbl">ფსონი</span><span class="tkc-val">${fmt(t.stake)}</span></div>
        <div class="tkc-col"><span class="tkc-lbl">კოეფ.</span><span class="tkc-val">${totalOdds}</span></div>
        <div class="tkc-col"><span class="tkc-lbl">${t.status === 'cashout' ? 'ქეშაუთი' : 'შესაძლო მოგება'}</span><span class="tkc-val" style="color:${winColor}">${t.status === 'cashout' ? '✓' : winText}</span></div>
      </div>`;
    return `
    <div class="ticket tk-${t.status} ${isCollapsed ? 'collapsed' : ''}">
      <div class="tk-head" data-tktoggle="${key}" style="cursor:pointer">
        <div class="tk-head-left"><span class="tk-status ${t.status}" style="color:${statusColor}">${stLabel[t.status] || t.status}</span><span class="tk-type">${t.type === 'express' ? 'ექსპრესი · ' + visSels.length + ' მოვლენა' : 'სინგლი'}</span></div>
        <span class="tk-arrow ${isCollapsed ? '' : 'open'}">▾</span>
      </div>
      ${isCollapsed ? collapsed : `
      <div class="tk-sels">
        ${visSels.length === 0 ? '<div class="tk-empty" style="padding:10px">ყველა პოზიცია გაუქმდა — ფსონი დაბრუნებულია</div>' : visSels.map(s => {
          const resCls = s.res === 'ok' ? 'ok' : s.res === 'no' ? 'no' : '';
          const resTxt = s.res === 'ok' ? '✓' : s.res === 'no' ? '✗' : '';
          return `<div class="tk-sel"><div class="tk-sel-main">
              <div class="tk-sel-fighters"><span class="tk-sel-red">${KIND_SHORT[s.kind] || s.kind}</span></div>
              <div class="tk-sel-pick pick-red">${s.driverName} — მოგება</div></div>
            <div class="tk-sel-right">${resTxt ? `<span class="tk-sel-result ${resCls}">${resTxt}</span>` : ''}<span class="tk-sel-odds">${Number(s.odds || 0).toFixed(2)}</span></div></div>`;
        }).join('')}
      </div>
      <div class="tk-foot"><span class="tk-foot-type">${t.type === 'express' ? 'ექსპრესი' : 'სინგლი'}</span><span class="tk-foot-pay">
          ${t.status === 'won' ? '<span style="color:var(--green)">+' + fmt(potentialWin) + ' ქულა</span>'
            : t.status === 'lost' ? '<span style="color:var(--red-soft)">' + fmt(potentialWin) + ' ქულა</span>'
            : t.status === 'cashout' ? '<span style="color:var(--gold)">ქეშაუთი</span>'
            : t.status === 'void' ? '<span style="color:var(--muted)">დაბრუნდა</span>'
            : '<span class="tk-foot-label">შეს. მოგება</span><span style="color:var(--gold)">' + fmt(potentialWin) + '</span>'}
        </span></div>
      ${showCashout ? `<button class="cashout-btn" data-co="${realIdx}">↩ ქეშაუთი</button>` : ''}
      `}
    </div>`;
  };

  if (activeList && historyList) {
    activeList.innerHTML = activeTickets.length === 0 ? '<div class="tk-empty">აქტიური ბილეთი არ არის. აირჩიე მრბოლელი და დადე ფსონი.</div>' : activeTickets.map(card).join('');
    historyList.innerHTML = historyTickets.length === 0 ? '<div class="tk-empty">ისტორია ცარიელია.</div>' : historyTickets.map(card).join('');
  }
  document.querySelectorAll('[data-co]').forEach(b => b.onclick = (e) => { e.stopPropagation(); doCashout(+b.dataset.co); });
  document.querySelectorAll('[data-tktoggle]').forEach(b => b.onclick = () => { const k = b.dataset.tktoggle; state.tkCollapsed[k] = state.tkCollapsed[k] === false ? true : false; renderTickets(); });
}

// ── BALANCE / BAR ──
function updateBalance(val) { if (!Number.isFinite(+val)) return; _balanceKnown = true; state.balance = +val; const el = $('balNav'); if (el) el.textContent = fmt(val); }
async function refreshBalance() {
  if (!currentUser) return;
  try {
    const { data, error } = await sb.rpc('get_sport_balance', { p_sport: SPORT });
    if (!error && data && data.balance != null) { currentUser.balance = data.balance; updateBalance(data.balance); }
  } catch (e) {}
}
function renderBar() {
  const n = picksArr().length;
  $('bbCoef').textContent = (n ? comboOdds() : 1).toFixed(2);
  $('balNav').textContent = _balanceKnown ? fmt(state.balance) : '…';
  $('bbCount').textContent = n;
  $('betbar').classList.toggle('show', n > 0 && anyMarketOpen());
}

// ── CONTACT INFO (account-level, იგივე users ცხრილი) ──
const AVATAR_ICONS = ['🥊','🏆','🔥','⚡','💪','🦁','🐺','👊','💎','🎯','⭐','🦅'];
let _contactPopupShown = false;
function hasContact(u) { return !!(u && (u.phone || u.telegram)); }
function needsProfileInfo(u) { if (!u) return false; return !(u.phone || u.telegram) || !u.birth_year || !u.gender; }
function showContactInfoPopup() {
  if (_contactPopupShown || !currentUser) return; _contactPopupShown = true;
  const m = $('contactInfoModal'); if (!m) return;
  if ($('ciPhone')) $('ciPhone').value = currentUser.phone || '';
  if ($('ciTelegram')) $('ciTelegram').value = currentUser.telegram || '';
  if ($('ciBirthYear')) $('ciBirthYear').value = currentUser.birth_year || '';
  document.querySelectorAll('input[name="ciGender"]').forEach(r => { r.checked = (currentUser.gender === r.value); });
  const cw = $('ciContactWrap'); if (cw) cw.style.display = hasContact(currentUser) ? 'none' : 'block';
  const by = $('ciBirthYearField'); if (by) by.style.display = currentUser.birth_year ? 'none' : 'block';
  const gf = $('ciGenderField'); if (gf) gf.style.display = currentUser.gender ? 'none' : 'block';
  const err = $('ciError'); if (err) err.style.display = 'none';
  m.classList.add('show');
}
function closeContactInfoPopup() { const m = $('contactInfoModal'); if (m) m.classList.remove('show'); }
async function saveContactInfo() {
  const phone = ($('ciPhone') && $('ciPhone').value || '').trim();
  const telegram = ($('ciTelegram') && $('ciTelegram').value || '').trim();
  const by = ($('ciBirthYear') && $('ciBirthYear').value || '').trim();
  const gEl = document.querySelector('input[name="ciGender"]:checked');
  const gender = gEl ? gEl.value : '';
  const errEl = $('ciError'); const showErr = m => { if (errEl) { errEl.textContent = m; errEl.style.display = 'block'; } };
  if (!hasContact(currentUser) && !phone && !telegram) { showErr('შეიყვანე მინიმუმ ერთი: ნომერი ან ტელეგრამი'); return; }
  if (!currentUser.birth_year && (!by || !/^\d{4}$/.test(by) || +by < 1900 || +by > 2015)) { showErr('შეიყვანე სწორი დაბადების წელი'); return; }
  if (!currentUser.gender && !gender) { showErr('აირჩიე სქესი'); return; }
  const updates = {};
  if (phone) updates.phone = phone;
  if (telegram) updates.telegram = telegram.replace(/^@/, '');
  if (!currentUser.birth_year && by) updates.birth_year = +by;
  if (!currentUser.gender && gender) updates.gender = gender;
  if (Object.keys(updates).length === 0) { closeContactInfoPopup(); return; }
  try {
    const { data, error } = await sb.from('users').update(updates).eq('id', currentUser.id).select('id,phone,telegram,birth_year,gender');
    if (error) { showErr('შენახვა ვერ მოხერხდა'); return; }
    if (!data || data.length === 0) { showErr('შენახვა დაბლოკილია (RLS).'); return; }
    currentUser.phone = data[0].phone || null; currentUser.telegram = data[0].telegram || null;
    currentUser.birth_year = data[0].birth_year || null; currentUser.gender = data[0].gender || null;
  } catch (e) { showErr('შეცდომა: ' + e.message); return; }
  closeContactInfoPopup(); loadLeaderboard();
}

// ── LEADERBOARD (f1_leaderboard_view + f1_score_history) ──
const LEADERBOARD = [];
let _currentLbPeriod = 'goat';
function renderLeaderboard() {
  const fullSorted = LEADERBOARD.map((r, i) => ({ ...r, rank: i + 1 }));
  const meIdx = currentUser ? fullSorted.findIndex(r => r.id === currentUser.id) : -1;
  let display;
  if (meIdx >= 0 && meIdx < 10) display = fullSorted.slice(0, 10);
  else if (meIdx >= 10) display = fullSorted.slice(0, 9).concat([fullSorted[meIdx]]);
  else display = fullSorted.slice(0, 10);
  const checkSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3"><path d="M6 12l4 4 8-8"/></svg>';
  const lbRows = $('lbRows'); if (!lbRows) return;
  lbRows.innerHTML = display.map(r => {
    const you = currentUser && r.id === currentUser.id;
    const sign = r.pts > 0 ? '+' : '';
    const badge = r.verified ? '<span class="lb-verified-badge" title="ვერიფიცირებული">' + checkSvg + '</span>' : '';
    const nm = r.name || '—';
    const nmSize = nm.length > 16 ? '.78rem' : nm.length > 12 ? '.88rem' : '1rem';
    const ptsStr = sign + fmt(r.pts);
    const ptsSize = ptsStr.length > 8 ? '.78rem' : ptsStr.length > 6 ? '.9rem' : '1.05rem';
    return `<div class="lb-row ${you ? 'you' : ''}${r.verified ? ' verified-row' : ''}">
      <span class="lb-rank ${r.rank <= 3 ? 'top' : ''}">${r.rank}</span>
      <span class="lb-user"><span class="lb-ava-glove">${r.icon || '🥊'}</span><span class="lb-userinfo"><span class="lb-verified"><span class="lb-name" style="font-size:${nmSize}">${nm}</span>${badge}</span>${you ? '<span class="lb-tag">შენ</span>' : ''}</span></span>
      <span class="lb-roi"></span><span class="lb-pts" style="font-size:${ptsSize}">${ptsStr}</span></div>`;
  }).join('');
  renderLbFullButton(fullSorted);
}
function renderLbFullButton(fullSorted) {
  const lbWrap = document.querySelector('#leaderboard .lb'); if (!lbWrap) return;
  let btn = $('lbFullBtn');
  if (fullSorted.length > 10) {
    if (!btn) { btn = document.createElement('button'); btn.id = 'lbFullBtn'; btn.className = 'lb-full-btn'; btn.textContent = 'სრულად'; lbWrap.parentNode.appendChild(btn); }
    btn.onclick = () => openLbPopup(fullSorted); btn.style.display = 'block';
  } else if (btn) { btn.style.display = 'none'; }
}
function openLbPopup(fullSorted) {
  const overlay = document.createElement('div'); overlay.className = 'lb-popup-bg';
  const checkSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3"><path d="M6 12l4 4 8-8"/></svg>';
  const rowsHtml = fullSorted.map(r => {
    const you = currentUser && r.id === currentUser.id; const sign = r.pts > 0 ? '+' : '';
    const badge = r.verified ? '<span class="lb-verified-badge">' + checkSvg + '</span>' : '';
    const nm = r.name || '—';
    return `<div class="lb-row ${you ? 'you' : ''}${r.verified ? ' verified-row' : ''}">
      <span class="lb-rank ${r.rank <= 3 ? 'top' : ''}">${r.rank}</span>
      <span class="lb-user"><span class="lb-ava-glove">${r.icon || '🥊'}</span><span class="lb-userinfo"><span class="lb-verified"><span class="lb-name">${nm}</span>${badge}</span>${you ? '<span class="lb-tag">შენ</span>' : ''}</span></span>
      <span class="lb-pts">${sign + fmt(r.pts)}</span></div>`;
  }).join('');
  overlay.innerHTML = `<div class="lb-popup"><div class="lb-popup-head"><h3>სრული ლიდერბორდი</h3><button class="x" id="lbPopupClose">&times;</button></div><div class="lb-popup-body">${rowsHtml}</div></div>`;
  document.body.appendChild(overlay);
  const close = () => document.body.removeChild(overlay);
  $('lbPopupClose').onclick = close;
  overlay.onclick = e => { if (e.target === overlay) close(); };
}
function periodStartDate(period) {
  // #19: სერვერის დროზე — პერიოდის საზღვარი ყველასთვის ერთნაირი
  const now = new Date(serverNow()); const y = now.getFullYear(), m = now.getMonth();
  if (period === '1m') return new Date(y, m, 1);
  if (period === '3m') return new Date(y, m - 2, 1);
  if (period === '6m') return new Date(y, m - 5, 1);
  if (period === '1y') return new Date(y - 1, m, 1);
  return new Date(2020, 0, 1);
}
async function loadLeaderboard(period) {
  if (period) _currentLbPeriod = period;
  try {
    let rows;
    if (_currentLbPeriod === 'goat') {
      const { data, error } = await sb.from('f1_leaderboard_view').select('*').order('score', { ascending: false });
      if (error || !data) return;
      rows = data.map(u => ({ id: u.id, name: u.nick || '—', pts: Number(u.score) || 0, icon: u.icon || '🥊', verified: !!u.verified }));
    } else {
      const since = periodStartDate(_currentLbPeriod).toISOString();
      let { data: hist, error: hErr } = await sb.from('f1_score_history').select('user_id, amount, created_at').gte('created_at', since);
      if (hErr) { const retry = await sb.from('f1_score_history').select('user_id, amount, created_at'); hist = retry.data; hErr = retry.error; }
      if (hErr || !hist) { LEADERBOARD.length = 0; renderLeaderboard(); renderLbTabs(); return; }
      const { data: usersData } = await sb.from('f1_leaderboard_view').select('*');
      const userMap = {};
      (usersData || []).forEach(u => { userMap[u.id] = { nick: u.nick || '—', icon: u.icon || '🥊', verified: !!u.verified }; });
      const map = {};
      hist.forEach(h => { const uid = h.user_id; if (!map[uid]) map[uid] = { id: uid, name: userMap[uid]?.nick || '—', icon: userMap[uid]?.icon || '🥊', pts: 0, verified: userMap[uid]?.verified || false }; map[uid].pts += Number(h.amount) || 0; });
      rows = Object.values(map).filter(r => r.pts > 0).sort((a, b) => b.pts - a.pts);
    }
    LEADERBOARD.length = 0; rows.forEach(r => LEADERBOARD.push(r));
    renderLeaderboard(); renderLbTabs();
  } catch (e) { console.warn('loadLeaderboard failed:', e); }
}
function renderLbTabs() {
  const tabs = $('lbTabs'); if (!tabs) return;
  const periods = [{ key: '1m', label: '1 თვე' }, { key: '3m', label: '3 თვე' }, { key: '6m', label: '6 თვე' }, { key: '1y', label: '1 წელი' }, { key: 'goat', label: 'G.O.A.T' }];
  tabs.innerHTML = periods.map(p => `<button class="lb-tab ${_currentLbPeriod === p.key ? 'on' : ''}" data-period="${p.key}">${p.label}</button>`).join('');
  tabs.querySelectorAll('.lb-tab').forEach(b => { b.onclick = () => loadLeaderboard(b.dataset.period); });
}

// ── LIVE RESULTS refresh ──
async function loadLiveResults() {
  if (!state.raceId) return;
  try { await loadRaceFromDB(); renderMarkets(); if (currentUser) { await loadUserTickets(); renderTickets(); } await loadLeaderboard(); } catch (e) {}
}

// ── SLIP open/close ──
function openSlip() { $('slipBg').classList.add('show'); $('slip').classList.add('show'); }
function closeSlip() { $('slipBg').classList.remove('show'); $('slip').classList.remove('show'); }

// ── COUNTDOWN ──
const cd_d = $('cd-d'), cd_h = $('cd-h'), cd_m = $('cd-m'), cd_s = $('cd-s');
function updateNextSession() {
  const list = window.__f1sessions || [];
  const now = serverNow();
  const next = list.find(s => s.time > now) || list[list.length - 1] || null;
  window.__eventDate = next ? new Date(next.time) : null;
  let label;
  if (window.__f1raceCompleted) label = 'RACE FINISHED';
  else if (next && (next.time - now) <= 0) label = '🔴 LIVE NOW';
  else label = next ? next.tag : 'UPCOMING RACE';
  const tagEl = document.querySelector('.event-tag');
  if (tagEl) { const fs = tagEl.querySelector('span'); if (fs) fs.textContent = label; }
  const dateEl = $('eventDate');
  if (dateEl && window.__eventDate) dateEl.textContent = EN_MONTHS[window.__eventDate.getMonth()] + ' ' + window.__eventDate.getDate();
}
function tick() {
  updateNextSession();
  const ed = window.__eventDate; const p = n => String(n).padStart(2, '0');
  if (!ed) { [cd_d, cd_h, cd_m, cd_s].forEach(el => { if (el) el.textContent = '--'; }); return; }
  const diff = ed - serverNow();
  if (diff <= 0) { [cd_d, cd_h, cd_m, cd_s].forEach(el => { if (el) el.textContent = '00'; }); return; }
  const d = Math.floor(diff / 864e5), h = Math.floor(diff % 864e5 / 36e5), m = Math.floor(diff % 36e5 / 6e4), s = Math.floor(diff % 6e4 / 1e3);
  if (cd_d) cd_d.textContent = p(d); if (cd_h) cd_h.textContent = p(h); if (cd_m) cd_m.textContent = p(m); if (cd_s) cd_s.textContent = p(s);
}
tick(); setInterval(tick, 1000);

// ── AUTH ──
const modal = $('modal');
let modalMode = 'join';
function passwordError(pass) {
  if (pass.length < 6) return 'პაროლი მინ. 6 სიმბოლო';
  if (!/[A-Z]/.test(pass)) return 'პაროლში მინ. 1 დიდი ასო (A-Z)';
  if (!/[a-z]/.test(pass)) return 'პაროლში მინ. 1 პატარა ასო (a-z)';
  if (!/[0-9]/.test(pass)) return 'პაროლში მინ. 1 ციფრი (0-9)';
  return null;
}
function updatePassChecklist() {
  const pass = ($('inPass') && $('inPass').value) || '';
  const set = (id, ok) => { const el = $(id); if (el) el.classList.toggle('ok', ok); };
  set('pcLen', pass.length >= 6); set('pcUpper', /[A-Z]/.test(pass)); set('pcLower', /[a-z]/.test(pass)); set('pcDigit', /[0-9]/.test(pass));
}
function authError(msg) { const el = $('authError'); if (el) { el.textContent = msg; el.style.display = msg ? 'block' : 'none'; } }
function openModal(mode) {
  modalMode = mode; authError('');
  const ae = $('authError'); if (ae) ae.style.color = 'var(--red)';
  if ($('inPass')) { $('inPass').value = ''; $('inPass').setAttribute('autocomplete', mode === 'join' ? 'new-password' : 'current-password'); }
  if ($('modalTitle')) $('modalTitle').textContent = mode === 'join' ? 'შემოუერთდი ლიგას' : 'კეთილი იყოს დაბრუნება';
  if ($('modalSub')) $('modalSub').textContent = ' ';
  ['nameField','confirmField','phoneField','birthYearField','genderField'].forEach(id => { const el = $(id); if (el) el.style.display = mode === 'join' ? 'block' : 'none'; });
  if ($('inName')) $('inName').value = '';
  if ($('inRegPhone')) $('inRegPhone').value = '';
  if ($('inBirthYear')) $('inBirthYear').value = '';
  document.querySelectorAll('input[name="gender"]').forEach(r => r.checked = false);
  updatePassChecklist();
  if ($('passHint')) $('passHint').style.display = mode === 'join' ? 'block' : 'none';
  if ($('modalSubmit')) $('modalSubmit').textContent = mode === 'join' ? 'რეგისტრაცია' : 'შესვლა';
  const sw = $('modalSwitch'); if (sw) sw.innerHTML = mode === 'join' ? 'უკვე გაქვს ანგარიში? <button id="switchMode">შესვლა</button>' : 'ახალი ხარ აქ? <button id="switchMode">რეგისტრაცია</button>';
  const swb = $('switchMode'); if (swb) swb.onclick = () => openModal(mode === 'join' ? 'signin' : 'join');
  const fw = $('forgotWrap'); if (fw) fw.style.display = mode === 'signin' ? 'block' : 'none';
  if (modal) modal.classList.add('show');
}
function closeModal() { if (modal) modal.classList.remove('show'); authError(''); }
function updateNavForUser(user) {
  document.body.classList.toggle('logged-in', !!user);
  const joinBtn = $('joinBtn'), signinBtn = $('signinBtn'), pill = document.querySelector('.balance-pill');
  let navUser = $('navUser');
  if (user) {
    if (joinBtn) joinBtn.style.display = 'none';
    if (signinBtn) signinBtn.style.display = 'none';
    if (!navUser) {
      navUser = document.createElement('div'); navUser.id = 'navUser'; navUser.className = 'nav-user';
      navUser.innerHTML = `<span class="nav-ava">${user.icon || '🥊'}</span><span class="nav-nick">${user.nick}</span>
        <div class="nav-dropdown" id="navDropdown"><button class="nav-dd-item" id="ddProfile">პროფილი</button><button class="nav-dd-item danger" id="ddLogout">გამოსვლა</button></div>`;
      if (joinBtn && joinBtn.parentNode) joinBtn.parentNode.insertBefore(navUser, joinBtn);
      navUser.onclick = (e) => { if (e.target.closest('.nav-dropdown')) return; $('navDropdown').classList.toggle('show'); };
      $('ddProfile').onclick = () => { $('navDropdown').classList.remove('show'); openProfile(); };
      $('ddLogout').onclick = () => { $('navDropdown').classList.remove('show'); doLogout(); };
    } else { navUser.querySelector('.nav-nick').textContent = user.nick; navUser.querySelector('.nav-ava').textContent = user.icon || '🥊'; }
    navUser.style.display = 'flex';
    if (pill) pill.classList.add('visible');
    addMobileMenuLinks();
    // #14: ბალანსი მხოლოდ რეალური მნიშვნელობით — თორემ '…' რჩება refreshBalance-მდე
    if (user.balance != null) updateBalance(user.balance);
    else { _balanceKnown = false; const bEl = $('balNav'); if (bEl) bEl.textContent = '…'; }
  } else {
    if (joinBtn) joinBtn.style.display = '';
    if (signinBtn) signinBtn.style.display = '';
    if (navUser) navUser.style.display = 'none';
    if (pill) pill.classList.remove('visible');
    removeMobileMenuLinks(); _balanceKnown = false; state.balance = 1000;
  }
}
function addMobileMenuLinks() {
  const navLinks = $('navLinks'); if (!navLinks) return;
  if (!$('mProfile')) { const p = document.createElement('a'); p.href = '#'; p.id = 'mProfile'; p.className = 'nav-mobile-only'; p.textContent = 'პროფილი'; p.onclick = (e) => { e.preventDefault(); navLinks.classList.remove('open'); openProfile(); }; navLinks.insertBefore(p, navLinks.firstChild); }
  if (!$('mLogout')) { const l = document.createElement('a'); l.href = '#'; l.id = 'mLogout'; l.className = 'nav-mobile-only danger'; l.textContent = 'გამოსვლა'; l.onclick = (e) => { e.preventDefault(); navLinks.classList.remove('open'); doLogout(); }; navLinks.appendChild(l); }
}
function removeMobileMenuLinks() { const p = $('mProfile'); if (p) p.remove(); const l = $('mLogout'); if (l) l.remove(); }
document.addEventListener('click', e => { const dd = $('navDropdown'); if (dd && !e.target.closest('.nav-user')) dd.classList.remove('show'); });

async function loadUserProfile(userId, fallbackEmail) {
  let ud = null;
  try { const res = await sb.from('users').select('*').eq('id', userId).maybeSingle(); ud = res.data; } catch (e) {}
  return {
    id: userId, email: fallbackEmail,
    nick: ud?.nick || (fallbackEmail || '').split('@')[0],
    balance: null, icon: ud?.icon || '🥊',   // #14: რეალურ ბალანსს refreshBalance (get_sport_balance) წამოიღებს
    phone: ud?.phone || null, telegram: ud?.telegram || null,
    birth_year: ud?.birth_year || null, gender: ud?.gender || null
  };
}
async function hydrateUserData() {
  if (!currentUser) return;
  await _raceReady;
  try { await refreshBalance(); } catch (e) {}
  try { await loadUserTickets(); } catch (e) {}
  renderTickets();
  try { renderLeaderboard(); } catch (e) {}
  if (needsProfileInfo(currentUser)) setTimeout(showContactInfoPopup, 1500);
}
async function doRegister() {
  const nick = ($('inName').value || '').trim();
  const email = ($('inEmail').value || '').trim();
  const pass = $('inPass').value || '';
  const passConfirm = $('inPassConfirm').value || '';
  const phone = ($('inRegPhone') && $('inRegPhone').value || '').trim();
  const birthYear = ($('inBirthYear') && $('inBirthYear').value || '').trim();
  const gEl = document.querySelector('input[name="gender"]:checked');
  const gender = gEl ? gEl.value : '';
  if (!nick || !/^[a-zA-Z0-9._]{3,20}$/.test(nick)) { authError('სახელი: 3-20 სიმბოლო (ასოები, ციფრები, . _)'); return; }
  try { const { data: taken } = await sb.rpc('is_nick_taken', { p_nick: nick, p_exclude_user_id: null }); if (taken) { authError('ეს სახელი უკვე დაკავებულია'); return; } } catch (e) {}
  if (!email) { authError('შეიყვანე ელ. ფოსტა'); return; }
  const pErr = passwordError(pass); if (pErr) { authError(pErr); return; }
  if (pass !== passConfirm) { authError('პაროლები არ ემთხვევა'); return; }
  if (!phone) { authError('შეიყვანე მობილურის ნომერი'); return; }
  if (!birthYear || !/^\d{4}$/.test(birthYear) || +birthYear < 1900 || +birthYear > 2015) { authError('შეიყვანე სწორი დაბადების წელი'); return; }
  if (!gender) { authError('აირჩიე სქესი'); return; }
  const btn = $('modalSubmit'); btn.textContent = '…'; btn.disabled = true;
  const { data, error } = await sb.auth.signUp({ email, password: pass, options: { data: { nick, phone, birth_year: +birthYear, gender } } });
  btn.disabled = false; btn.textContent = 'რეგისტრაცია';
  if (error) { const msg = error.message || ''; if (msg.includes('already registered') || msg.includes('already been registered')) authError('ეს ელ. ფოსტა უკვე რეგისტრირებულია'); else authError(msg); return; }
  if (!data.session) { const el = $('authError'); el.style.color = 'var(--green)'; el.textContent = 'რეგისტრაცია წარმატებულია! დაადასტურე ელ.ფოსტა.'; el.style.display = 'block'; return; }
  await new Promise(r => setTimeout(r, 1000));
  try { await sb.from('users').update({ phone: phone || null, birth_year: +birthYear, gender }).eq('id', data.user.id); } catch (e) {}
  currentUser = await loadUserProfile(data.user.id, email);
  currentUser.phone = currentUser.phone || phone; currentUser.birth_year = currentUser.birth_year || +birthYear; currentUser.gender = currentUser.gender || gender;
  // ერთი საერთო event_id ბრაუზერისთვის (GTM) და სერვერისთვის (Meta CAPI) — Deduplicated
  var fbEventId = 'reg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
  window.dataLayer = window.dataLayer || [];
  window.dataLayer.push({ event: 'user_registration', method: 'email', fb_event_id: fbEventId });
  try {
    var fbpCookie = (document.cookie.match(/(?:^|; )_fbp=([^;]*)/) || [])[1] || '';
    var fbcCookie = (document.cookie.match(/(?:^|; )_fbc=([^;]*)/) || [])[1] || '';
    fetch(SUPABASE_URL + '/functions/v1/meta-capi', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_id: fbEventId, email: email, phone: phone, fbp: fbpCookie, fbc: fbcCookie, url: location.href })
    }).catch(function () {});
  } catch (e) {}
  closeModal(); updateNavForUser(currentUser); await hydrateUserData();
}
async function doSignIn() {
  const email = ($('inEmail').value || '').trim();
  const pass = $('inPass').value || '';
  if (!email || !pass) { authError('შეიყვანე ელ. ფოსტა და პაროლი'); return; }
  const btn = $('modalSubmit'); btn.textContent = '…'; btn.disabled = true;
  const { data, error } = await sb.auth.signInWithPassword({ email, password: pass });
  btn.disabled = false; btn.textContent = 'შესვლა';
  if (error) { authError('არასწორი მეილი ან პაროლი'); return; }
  currentUser = await loadUserProfile(data.user.id, email);
  closeModal(); updateNavForUser(currentUser); await hydrateUserData();
}
async function doLogout() { await sb.auth.signOut(); currentUser = null; state.tickets = []; renderTickets(); updateNavForUser(null); }
async function handleGoogleAuth() {
  const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.origin + window.location.pathname } });
  if (error) console.warn(error.message);
}

// ── PROFILE MODAL ──
function openProfile() {
  if (!currentUser) return;
  const m = $('profileModal'); if (!m) return;
  if ($('profNick')) $('profNick').value = currentUser.nick || '';
  if ($('profEmail')) $('profEmail').value = currentUser.email || '';
  if ($('profPhone')) $('profPhone').value = currentUser.phone || '';
  if ($('profTelegram')) $('profTelegram').value = currentUser.telegram || '';
  if ($('profOldPass')) $('profOldPass').value = '';
  if ($('profNewPass')) $('profNewPass').value = '';
  const picker = $('iconPicker');
  if (picker) {
    picker.innerHTML = AVATAR_ICONS.map(ic => '<button class="icon-opt ' + ((currentUser.icon || '🥊') === ic ? 'active' : '') + '" data-icon="' + ic + '">' + ic + '</button>').join('');
    picker.querySelectorAll('.icon-opt').forEach(b => b.onclick = () => { picker.querySelectorAll('.icon-opt').forEach(x => x.classList.remove('active')); b.classList.add('active'); });
  }
  profileMsg(''); m.classList.add('show');
}
function closeProfile() { $('profileModal').classList.remove('show'); }
function profileMsg(msg, color) { const el = $('profileMsg'); if (msg) { el.textContent = msg; el.style.color = color || 'var(--green)'; el.style.display = 'block'; } else { el.style.display = 'none'; } }
async function saveProfile() {
  if (!currentUser) return;
  const nick = ($('profNick').value || '').trim();
  const email = ($('profEmail').value || '').trim();
  const phone = ($('profPhone').value || '').trim();
  const telegram = ($('profTelegram').value || '').trim().replace(/^@/, '');
  const oldPass = $('profOldPass').value || '';
  const newPass = $('profNewPass').value || '';
  const selIcon = document.querySelector('#iconPicker .icon-opt.active');
  const icon = selIcon ? selIcon.dataset.icon : currentUser.icon || '🥊';
  if (nick && !/^[a-zA-Z0-9._]{3,20}$/.test(nick)) { profileMsg('სახელი: 3-20 სიმბოლო (ასოები, ციფრები, . _)', 'var(--red)'); return; }
  try {
    const nickChanged = nick && nick !== currentUser.nick;
    if (nickChanged) {
      let taken = false;
      const rpc = await sb.rpc('is_nick_taken', { p_nick: nick, p_exclude_user_id: currentUser.id });
      taken = !!rpc.data;
      if (taken) { profileMsg('ასეთი ზედმეტსახელი უკვე არსებობს', 'var(--red)'); return; }
    }
    const phoneChanged = phone !== (currentUser.phone || '');
    const tgChanged = telegram !== (currentUser.telegram || '');
    if (nickChanged || icon !== currentUser.icon || phoneChanged || tgChanged) {
      const upd = { nick: nick || currentUser.nick, icon };
      if (phoneChanged) upd.phone = phone || null;
      if (tgChanged) upd.telegram = telegram || null;
      const { data, error } = await sb.from('users').update(upd).eq('id', currentUser.id).select('id');
      if (error) { profileMsg('შენახვა ვერ მოხერხდა', 'var(--red)'); return; }
      if (!data || data.length === 0) { profileMsg('შენახვა დაბლოკილია (RLS).', 'var(--red)'); return; }
      if (nickChanged) currentUser.nick = nick;
      currentUser.icon = icon;
      if (phoneChanged) currentUser.phone = phone || null;
      if (tgChanged) currentUser.telegram = telegram || null;
      updateNavForUser(currentUser);
    }
    if (email && email !== currentUser.email) {
      const { error } = await sb.auth.updateUser({ email });
      if (error) { profileMsg('მეილის შეცვლა ვერ მოხერხდა', 'var(--red)'); return; }
      currentUser.email = email;
    }
    if (newPass) {
      const pErr = passwordError(newPass); if (pErr) { profileMsg('ახალი ' + pErr, 'var(--red)'); return; }
      if (!oldPass) { profileMsg('შეიყვანე ძველი პაროლი', 'var(--red)'); return; }
      const { error: se } = await sb.auth.signInWithPassword({ email: currentUser.email, password: oldPass });
      if (se) { profileMsg('ძველი პაროლი არასწორია', 'var(--red)'); return; }
      const { error: ue } = await sb.auth.updateUser({ password: newPass });
      if (ue) { profileMsg('პაროლის შეცვლა ვერ მოხერხდა', 'var(--red)'); return; }
    }
    profileMsg('წარმატებით შეინახა!', 'var(--green)');
  } catch (e) { profileMsg('შეცდომა: ' + e.message, 'var(--red)'); }
}

// ── FORGOT / RESET ──
function openForgotPassword() { closeModal(); const m = $('forgotModal'); if (m) m.classList.add('show'); const e = $('forgotError'); if (e) e.style.display = 'none'; const s = $('forgotSuccess'); if (s) s.style.display = 'none'; }
function closeForgotModal() { const m = $('forgotModal'); if (m) m.classList.remove('show'); }
function openResetPasswordModal() { const m = $('resetPasswordModal'); if (m) m.classList.add('show'); }
async function sendPasswordReset() {
  const email = ($('forgotEmail').value || '').trim();
  const errEl = $('forgotError');
  if (!email) { if (errEl) { errEl.textContent = 'შეიყვანე ელ. ფოსტა'; errEl.style.display = 'block'; } return; }
  try {
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin + window.location.pathname });
    if (error) { if (errEl) { errEl.textContent = 'ვერ გაიგზავნა: ' + error.message; errEl.style.display = 'block'; } return; }
    const s = $('forgotSuccess'); if (s) s.style.display = 'block';
    if (errEl) errEl.style.display = 'none';
  } catch (e) {}
}
async function submitNewPassword() {
  const p1 = $('recoveryNewPass').value || '', p2 = $('recoveryNewPassConfirm').value || '';
  const errEl = $('recoveryError');
  const pErr = passwordError(p1); if (pErr) { if (errEl) { errEl.textContent = pErr; errEl.style.display = 'block'; } return; }
  if (p1 !== p2) { if (errEl) { errEl.textContent = 'პაროლები არ ემთხვევა'; errEl.style.display = 'block'; } return; }
  try {
    const { error } = await sb.auth.updateUser({ password: p1 });
    if (error) { if (errEl) { errEl.textContent = 'ვერ განახლდა: ' + error.message; errEl.style.display = 'block'; } return; }
    const s = $('recoverySuccess'); if (s) s.style.display = 'block';
    if (errEl) errEl.style.display = 'none';
    setTimeout(() => { const m = $('resetPasswordModal'); if (m) m.classList.remove('show'); }, 1500);
  } catch (e) {}
}
function toggleEye(inputId) {
  const inp = $(inputId); if (!inp) return;
  const isPass = inp.type === 'password'; inp.type = isPass ? 'text' : 'password';
  const btn = inp.parentElement.querySelector('.eye-toggle');
  if (btn) btn.innerHTML = isPass
    ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>'
    : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
}

// ── inject F1 driver-card CSS (style.css-ის დამოუკიდებლად) ──
(function injectCss() {
  const css = `
  .f1-drv-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px}
  .f1-drv{display:flex;align-items:center;gap:10px;padding:8px 12px 8px 8px;border:1px solid var(--line);border-radius:10px;background:var(--surface);cursor:pointer;transition:.15s;color:var(--text);text-align:left;position:relative;overflow:hidden}
  .f1-drv:hover:not(:disabled){border-color:var(--team);transform:translateY(-1px)}
  .f1-drv.on{border-color:var(--team);box-shadow:0 0 0 1px var(--team) inset;background:color-mix(in srgb,var(--team) 12%,var(--surface))}
  .f1-drv.winner{border-color:var(--green);box-shadow:0 0 0 1px var(--green) inset}
  .f1-drv:disabled{opacity:.45;cursor:not-allowed}
  .f1-drv .drv-badge{width:4px;height:34px;border-radius:4px;flex:none}
  .f1-drv .drv-img{width:44px;height:44px;border-radius:8px;object-fit:cover;background:var(--ink);flex:none}
  .f1-drv .drv-info{display:flex;flex-direction:column;min-width:0;flex:1}
  .f1-drv .drv-name{font-weight:700;font-size:.92rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .f1-drv .drv-team{font-family:var(--mono);font-size:.7rem;color:var(--muted)}
  .f1-drv .drv-od{font-family:var(--mono);font-weight:700;font-size:1rem;color:var(--gold);flex:none}
  `;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
})();

// ── EVENT LISTENERS ──
$on('openSlip', 'click', openSlip);
$on('closeSlip', 'click', closeSlip);
$on('slipBg', 'click', closeSlip);
$on('tabExpress', 'click', () => setMode('express'));
$on('tabSingle', 'click', () => setMode('single'));
$on('joinBtn', 'click', () => openModal('join'));
$on('signinBtn', 'click', () => openModal('signin'));
$on('modalClose', 'click', closeModal);
if (modal) modal.onclick = e => { if (e.target === modal) closeModal(); };
$on('modalSubmit', 'click', () => modalMode === 'join' ? doRegister() : doSignIn());
$on('inPass', 'input', updatePassChecklist);
$on('googleBtn', 'click', handleGoogleAuth);
$on('forgotBtn', 'click', openForgotPassword);
$on('forgotModalClose', 'click', closeForgotModal);
$on('forgotModal', 'click', e => { if (e.target.id === 'forgotModal') closeForgotModal(); });
$on('forgotSubmit', 'click', sendPasswordReset);
$on('recoverySubmit', 'click', submitNewPassword);
$on('backToLogin', 'click', () => { closeForgotModal(); openModal('signin'); });
$on('profileClose', 'click', closeProfile);
$on('profileModal', 'click', e => { if (e.target.id === 'profileModal') closeProfile(); });
$on('profileSave', 'click', saveProfile);
$on('profileLogout', 'click', () => { closeProfile(); doLogout(); });
$on('ciSave', 'click', saveContactInfo);
$on('ciSkip', 'click', closeContactInfoPopup);
$on('contactInfoModal', 'click', e => { if (e.target.id === 'contactInfoModal') closeContactInfoPopup(); });
$on('activeToggle', 'click', () => { const act = $('activeTickets'), arrow = $('activeArrow'); if (!act) return; const isOpen = act.style.display !== 'none'; act.style.display = isOpen ? 'none' : 'flex'; if (arrow) arrow.classList.toggle('open', !isOpen); });
$on('historyToggle', 'click', () => { const hist = $('historyTickets'), arrow = $('historyArrow'); if (!hist) return; const isOpen = hist.style.display !== 'none'; hist.style.display = isOpen ? 'none' : 'flex'; if (arrow) arrow.classList.toggle('open', !isOpen); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeModal(); closeSlip(); closeForgotModal(); closeProfile(); closeContactInfoPopup(); } });
const navLinks = $('navLinks');
$on('menuBtn', 'click', () => { if (navLinks) navLinks.classList.toggle('open'); });
// მობილური "ფენტეზის ტიპი" dropdown — კლიკით (მობილურზე :hover არ არსებობს)
(function(){
  const sp = document.getElementById('mnavSport');
  if (!sp) return;
  const pop = sp.querySelector('.mnav-pop');
  if (!pop) return;
  sp.addEventListener('click', (e) => {
    if (e.target.closest('.mnav-pop-opt')) return;   // F1/NBA/UFC ლინკზე კლიკი — გაატარე
    e.stopPropagation();
    pop.classList.toggle('show');
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#mnavSport')) pop.classList.remove('show');
  });
})();
document.querySelectorAll('a[href^="#"]').forEach(a => a.addEventListener('click', e => {
  const id = a.getAttribute('href').slice(1); const t = document.getElementById(id);
  if (t) { e.preventDefault(); t.scrollIntoView({ behavior: 'smooth', block: 'start' }); if (navLinks) navLinks.classList.remove('open'); }
}));

// ── SESSION / INIT ──
let _raceLoaded = false, _resolveRace;
const _raceReady = new Promise(res => { _resolveRace = res; });
let _sessionApplying = false;

async function loadRaceAndRender() {
  if (_raceLoaded) return; _raceLoaded = true;
  try { await loadRaceFromDB(); } catch (e) { console.warn(e); }
  renderMarkets(); renderSlip(); renderBar(); updateNavForUser(currentUser);
  try { await loadLeaderboard(); } catch (e) {}
  _resolveRace();
  renderTickets();
  setInterval(loadLiveResults, 2 * 60 * 1000);
}
async function applySession(session) {
  if (!session || currentUser || _sessionApplying) return;
  _sessionApplying = true;
  try {
    currentUser = await loadUserProfile(session.user.id, session.user.email);
    updateNavForUser(currentUser);
    await hydrateUserData();
  } catch (e) { console.warn('applySession failed:', e); }
  finally { _sessionApplying = false; }
}
sb.auth.onAuthStateChange((event, session) => {
  setTimeout(() => {
    if (event === 'SIGNED_OUT') { currentUser = null; state.tickets = []; renderTickets(); updateNavForUser(null); }
    else { applySession(session); if (event === 'PASSWORD_RECOVERY') openResetPasswordModal(); }
  }, 0);
});

const loadingEl = $('markets');
if (loadingEl) loadingEl.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted)">იტვირთება…</div>';

async function init() {
  try { await syncServerTime(); } catch (e) {}
  let session = null;
  try { const { data } = await sb.auth.getSession(); session = data.session; } catch (e) {}
  if (session) { const jb = $('joinBtn'), sb2 = $('signinBtn'); if (jb) jb.style.display = 'none'; if (sb2) sb2.style.display = 'none'; }
  await loadRaceAndRender();
  if (session && !currentUser) { try { await applySession(session); } catch (e) {} }
}
init();

window.toggleEye = toggleEye;
})();
