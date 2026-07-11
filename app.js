// ============================================================
//  UFC Fantasy — app.js  (v19 — server-time sync)
// ============================================================
(function () {
if (window.__FNF_APP_LOADED__) {
  console.warn('[FNF] app.js უკვე ჩატვირთულია — დუბლიკატი გაშვება იგნორირდება');
  return;
}
window.__FNF_APP_LOADED__ = true;

const SUPABASE_URL = "https://qxfcwsiysnjxhxljqigl.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF4ZmN3c2l5c25qeGh4bGpxaWdsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxODM4MDUsImV4cCI6MjA5Nzc1OTgwNX0.SOeTrxnKulgO8ao8HSwxyKE-m9pvaQ54Pa_IGWWyKDc";
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, lock: (name, t, fn) => fn() }
});

// ── helpers ──
const r2  = x => Math.round(x * 100) / 100;
const fmt = n => Number.isFinite(+n) ? Math.round(+n).toLocaleString('en-US') : '0';
const METHODS = ['ნოკაუტი', 'მტკივნეული', 'გადაწყვეტილება'];
const EN_MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const $ = id => document.getElementById(id);
function $on(id, ev, fn) { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); }

// ── state ──
let FIGHTS = [];
const START = 1000;
const state = { balance: START, score: 0, picks: {}, mode: 'express', expressStake: 0, tickets: [], user: null, openDetail: {}, tkCollapsed: {}, eventName: '' };
let currentUser = null;
let _balanceKnown = false;

// ── SERVER TIME (მოწყობილობის საათის აცდენის კომპენსაცია) ──
// _timeOffset = სერვერსა და მოწყობილობის საათს შორის სხვაობა (ms).
// 0 = ჩვეულებრივი Date.now(). თუ sync ვერ მოხდა, 0-ზე რჩება და ყველაფერი ისე მუშაობს, როგორც ადრე.
let _timeOffset = 0;
function serverNow() { return Date.now() + _timeOffset; }
async function syncServerTime() {
  try {
    const { data, error } = await sb.rpc('server_now');
    if (error || data == null) return;
    const serverMs = new Date(data).getTime();
    if (!Number.isFinite(serverMs)) return;
    _timeOffset = serverMs - Date.now();
  } catch (e) { /* ვერ მოვიდა — offset რჩება 0-ზე, fallback = Date.now() */ }
}

// ── BETTING RULES ──
function isBettingClosed() { const ed = window.__eventDate; if (!ed) return false; return (ed - serverNow()) < 60000; }
function isEventInProgress() { const ed = window.__eventDate; if (!ed) return false; return (ed - serverNow()) < 0; }
function canCashout() { const ed = window.__eventDate; if (!ed) return true; return (ed - serverNow()) > 3600000; }
function cashoutAmount(t) { const age = serverNow() - (t.placedAt || serverNow()); return age <= 3600000 ? t.stake : Math.round(t.stake * 0.8); }
function cashoutLabel(t) { const age = serverNow() - (t.placedAt || serverNow()); return age <= 3600000 ? '↩ ქეშაუთი (უფასო)' : '↩ ქეშაუთი (80%)'; }

// ── CASHOUT POPUP ──
function showCashoutPopup(amt, stake, blocked) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
    overlay.innerHTML = blocked ? `
      <div style="background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:32px;max-width:360px;width:100%;text-align:center">
        <div style="font-size:1.2rem;font-weight:700;margin-bottom:10px;color:var(--red)">ქეშაუთი შეუძლებელია</div>
        <div style="color:var(--muted);margin-bottom:24px;font-size:.9rem">ივენთის დაწყებამდე 1 საათზე ნაკლებია დარჩენილი</div>
        <button id="coClose" style="padding:10px 28px;border-radius:8px;border:1px solid var(--line);background:var(--surface-2);color:var(--text);cursor:pointer;font-family:inherit">დახურვა</button>
      </div>` : `
      <div style="background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:32px;max-width:360px;width:100%;text-align:center">
        <div style="font-size:1.2rem;font-weight:700;margin-bottom:10px">ქეშაუთის დადასტურება</div>
        <div style="color:var(--muted);margin-bottom:8px">დარწმუნებული ხართ რომ გსურთ ქეშაუთი?</div>
        <div style="color:var(--gold);font-size:1.05rem;font-weight:700;margin-bottom:24px">დაგიბრუნდება: ${fmt(amt)} ქულა${amt < stake ? ' (80%)' : ' (სრულად)'}</div>
        <div style="display:flex;gap:12px;justify-content:center">
          <button id="coCancelBtn" style="padding:10px 24px;border-radius:8px;border:1px solid var(--line);background:var(--surface-2);color:var(--text);cursor:pointer;font-family:inherit">გაუქმება</button>
          <button id="coConfirmBtn" style="padding:10px 24px;border-radius:8px;border:none;background:var(--red);color:#fff;cursor:pointer;font-family:inherit;font-weight:700">დადასტურება</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = val => { document.body.removeChild(overlay); resolve(val); };
    if (blocked) { document.getElementById('coClose').onclick = () => close(false); }
    else { document.getElementById('coConfirmBtn').onclick = () => close(true); document.getElementById('coCancelBtn').onclick = () => close(false); }
    overlay.onclick = e => { if (e.target === overlay) close(false); };
  });
}

async function doCashout(idx) {
  const t = state.tickets[idx];
  if (!t || t.status !== 'open') return;
  if (!canCashout()) { await showCashoutPopup(null, null, true); return; }
  const amt = cashoutAmount(t);
  const confirmed = await showCashoutPopup(amt, t.stake, false);
  if (!confirmed) return;
  if (!t._dbId) { alert('ბილეთის ID ვერ მოიძებნა'); return; }
  const { data: res, error } = await sb.rpc('cashout_ticket', { p_ticket_id: t._dbId });
  if (error || !res || !res.ok) { alert('ქეშაუთი ვერ შესრულდა: ' + (res?.error || error?.message || 'უცნობი შეცდომა')); return; }
  t.status = 'cashout';
  updateBalance(res.balance);
  renderTickets();
}

// ── DB LOAD (ივენთის შერჩევა გასწორებული) ──
async function loadEventFromDB() {
  const nowIso = new Date(serverNow()).toISOString();
  const { data: upRows } = await sb.from('events').select('*').gte('event_date', nowIso).order('event_date', { ascending: true }).limit(1);
  const { data: pastRows } = await sb.from('events').select('*').lt('event_date', nowIso).order('event_date', { ascending: false }).limit(1);
  const now = serverNow();
  const upcoming = upRows && upRows[0];
  const recent = pastRows && pastRows[0];
  const recentLiveOrFresh = recent && ((now - new Date(recent.event_date).getTime()) / 3600000) <= 48;
  let ev = null;
  if (recentLiveOrFresh) ev = recent;
  else if (upcoming) ev = upcoming;
  else if (recent) ev = recent;
  if (!ev) return null;

  window.__currentEventId = ev.id;
  state.eventName = ev.name || '';

  const { data: fights, error: fErr } = await sb.from('fights')
    .select(`id,bout_order,weight_class,max_rounds,is_title_bout,red_odds,blue_odds,show_details,status,result_winner,result_method,result_round,
             red:fighters!red_fighter_id(name,flag,rank,record,age,height_cm,weight_kg,reach_cm,ufc_slug,ko_pct,sub_pct,dec_pct,image_url),
             blue:fighters!blue_fighter_id(name,flag,rank,record,age,height_cm,weight_kg,reach_cm,ufc_slug,ko_pct,sub_pct,dec_pct,image_url)`)
    .eq('event_id', ev.id).order('bout_order', { ascending: true });
  if (fErr) return ev;

  FIGHTS = (fights || []).map(f => {
    let resultWinner = null;
    if (f.status === 'completed' && f.result_winner) {
      if (f.result_winner === f.red?.name) resultWinner = 'red';
      else if (f.result_winner === f.blue?.name) resultWinner = 'blue';
      else resultWinner = null;
    }
    return {
      _dbId: f.id, wc: f.weight_class, rounds: f.max_rounds + ' Rounds', maxRound: f.max_rounds,
      showDetails: f.show_details !== false, status: f.status || 'upcoming', resultWinner,
      resultMethod: f.result_method || null, resultRound: f.result_round || null,
      red: { name: f.red.name, flag: f.red.flag || '🏳️', odds: f.red_odds == null ? null : Number(f.red_odds), img: f.red.image_url || null,
        record: f.red.record || '-', age: String(f.red.age || '-'), ht: (f.red.height_cm || '-') + ' სმ', wt: (f.red.weight_kg || '-') + ' კგ', reach: (f.red.reach_cm || '-') + ' სმ' },
      blue: { name: f.blue.name, flag: f.blue.flag || '🏳️', odds: f.blue_odds == null ? null : Number(f.blue_odds), img: f.blue.image_url || null,
        record: f.blue.record || '-', age: String(f.blue.age || '-'), ht: (f.blue.height_cm || '-') + ' სმ', wt: (f.blue.weight_kg || '-') + ' კგ', reach: (f.blue.reach_cm || '-') + ' სმ' }
    };
  });

  const dt = new Date(ev.event_date);
  window.__eventDate = dt;
  const diff = dt - serverNow();
  let label = 'UPCOMING EVENT';
  if (ev.status === 'completed') label = 'EVENT FINISHED';
  else if (diff <= 0) label = '🔴 LIVE NOW';
  const tagEl = document.querySelector('.event-tag');
  if (tagEl) { const fs = tagEl.querySelector('span'); if (fs) fs.textContent = label; }
  const locEl = $('eventLocation2'); if (locEl) locEl.textContent = (ev.location || '').toUpperCase();
  const dateEl = $('eventDate'); if (dateEl) dateEl.textContent = '· ' + EN_MONTHS[dt.getMonth()] + ' ' + dt.getDate();
  return ev;
}

// ── ODDS HELPERS ──
function fightHasOdds(f) { return f && f.red.odds != null && f.blue.odds != null && f.red.odds > 0 && f.blue.odds > 0; }
function roundOdds(i, r) { const f = FIGHTS[i]; if (!fightHasOdds(f)) return 0; const base = (f.red.odds + f.blue.odds) / 2; return r2(base * (1 + r * 0.15)); }
function methodOdds(i, m) { const f = FIGHTS[i]; if (!fightHasOdds(f)) return 0; const base = (f.red.odds + f.blue.odds) / 2;
  if (m === 'გადაწყვეტილება') return r2(base * 0.9); if (m === 'ნოკაუტი') return r2(base * 1.4); if (m === 'მტკივნეული') return r2(base * 1.6); return 1.5; }
function pickOdds(i) { const p = state.picks[i]; const f = FIGHTS[i]; if (!p || !fightHasOdds(f)) return 0;
  if (!p.round && !p.method) return p.fighter === 'red' ? f.red.odds : f.blue.odds;
  let o = 1; if (p.round) o *= roundOdds(i, p.round); if (p.method) o *= methodOdds(i, p.method); return r2(o); }
function selName(i) { const p = state.picks[i]; const a = [];
  if (p.fighter) a.push((p.fighter === 'red' ? FIGHTS[i].red.name : FIGHTS[i].blue.name) + ' მოგება');
  if (p.round) a.push(p.round + '-ე რაუნდი'); if (p.method) a.push(p.method); return a.join(' · '); }
function selMk(i) { const p = state.picks[i]; return (p.round && p.method) ? 'რაუნდი + მეთოდი' : p.method ? 'გამარჯვების მეთოდი' : p.round ? 'დასრულების რაუნდი' : 'ბრძოლის გამარჯვებული'; }

// ── PICK MANAGEMENT ──
function ensure(i) { if (!state.picks[i]) state.picks[i] = { fighter: null, round: null, method: null, stake: 0 }; return state.picks[i]; }
function clean(i) { const p = state.picks[i]; if (p && !p.fighter && !p.round && !p.method) delete state.picks[i]; }
function setWinner(i, fr) { if (!fightHasOdds(FIGHTS[i])) return; const p = state.picks[i];
  if (p && p.fighter === fr && !p.round && !p.method) delete state.picks[i];
  else state.picks[i] = { fighter: fr, round: null, method: null, stake: (p && p.stake) || 0 }; refresh(); }
function setFighterDetail(i, fr) { if (!fightHasOdds(FIGHTS[i])) return; const p = ensure(i); p.fighter = fr; clean(i); refresh(); }
function setRound(i, r) { if (!fightHasOdds(FIGHTS[i])) return; const p = ensure(i);
  if (p.method === 'გადაწყვეტილება') p.method = null; p.round = p.round === r ? null : r; clean(i); refresh(); }
function setMethod(i, m) { if (!fightHasOdds(FIGHTS[i])) return; const p = ensure(i);
  if (m === 'გადაწყვეტილება') { p.method = p.method === m ? null : m; if (p.method) p.round = null; }
  else { p.method = p.method === m ? null : m; } clean(i); refresh(); }
function toggleDetail(i) { state.openDetail[i] = !state.openDetail[i]; renderMarkets(); }
function refresh() { renderMarkets(); renderSlip(); renderBar(); }

// ── RENDER MARKETS ──
function renderMarkets() {
  if (FIGHTS.length === 0) { document.getElementById('markets').innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted)">ამ ეტაპზე ბრძოლები არ არის ხელმისაწვდომი.</div>'; return; }
  const betting = !isBettingClosed();
  if (!betting) document.getElementById('betbar').classList.remove('show');
  const noImg = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 200'%3E%3Crect width='200' height='200' fill='%230E0D14'/%3E%3Ccircle cx='100' cy='85' r='42' fill='%23F31D25' opacity='.9'/%3E%3Crect x='75' y='110' width='50' height='40' rx='8' fill='%23F31D25' opacity='.85'/%3E%3Ctext x='100' y='185' text-anchor='middle' font-size='14' fill='%23555'%3EMMA%3C/text%3E%3C/svg%3E";

  document.getElementById('markets').innerHTML = FIGHTS.map((f, i) => {
    const p = state.picks[i], fr = p ? p.fighter : null, open = state.openDetail[i];
    const mainOn = p && p.fighter && !p.round && !p.method;
    const fcls = fr || '';
    const hasOdds = fightHasOdds(f);
    const canBet = betting && hasOdds;
    const winner = (f.status === 'completed') ? f.resultWinner : null;
    const isCompleted = !!winner;

    const roundChips = Array.from({ length: f.maxRound }, (_, k) => k + 1).map(r =>
      `<button class="mkt-chip ${fcls} ${p && p.round === r ? 'on' : ''}" data-round="${i}" data-val="${r}" ${!canBet ? 'disabled' : ''}><span class="ml">${r}</span><span class="mo">${roundOdds(i, r).toFixed(2)}</span></button>`).join('');
    const methodChips = METHODS.map(m =>
      `<button class="mkt-chip ${fcls} ${p && p.method === m ? 'on' : ''}" data-method="${i}" data-val="${m}" ${!canBet ? 'disabled' : ''}><span class="ml">${m}</span><span class="mo">${methodOdds(i, m).toFixed(2)}</span></button>`).join('');
    const taleRow = (lab, a, b) => `<div class="tale-row"><span class="tv l">${a}</span><span class="tl">${lab}</span><span class="tv r">${b}</span></div>`;

    const pickBtn = (side, d) => {
      const has = d.odds != null && d.odds > 0;
      const flag = `<span class="p-flag">${d.flag}</span>`, name = `<span class="p-name">${d.name}</span>`, od = `<span class="p-od">${has ? d.odds.toFixed(2) : '—'}</span>`;
      const inner = side === 'red' ? flag + name + od : od + name + flag;
      const winnerCls = isCompleted && winner === side ? ' winner' : '';
      const onCls = betting && mainOn && fr === side ? ' on' : '';
      const canPick = betting && has;
      return `<button class="pick ${side}${onCls}${winnerCls}" ${canPick ? `data-winner="${i}" data-fr="${side}"` : ''}${canPick ? '' : ' disabled'}>${inner}</button>`;
    };

    let hint;
    if (betting && !hasOdds) hint = '<div class="picks-hint" style="color:var(--gold)">კოეფიციენტები ჯერ არ არის — მალე დაემატება</div>';
    else if (betting) hint = '<div class="picks-hint">აირჩიე ფავორიტი მებრძოლი</div>';
    else if (isCompleted) hint = '<div class="picks-hint" style="color:var(--green)">დასრულდა</div>';
    else hint = '<div class="picks-hint">ფსონები დაკეტილია</div>';

    return `
    <div class="bout">
      <div class="bout-head"><span class="rank left">${f.red.record}</span><span class="bout-class"><span class="wc">${f.wc}</span><span class="rd">${f.rounds}</span></span><span class="rank right">${f.blue.record}</span></div>
      <div class="bout-stage">
        <div class="stage-img left"><img src="${f.red.img || noImg}" alt="${f.red.name}" decoding="async" width="323" height="235" ${i === 0 ? 'fetchpriority="high"' : 'loading="lazy"'}></div>
        <div class="stage-mid"><div class="tale-wrap">${taleRow('ასაკი', f.red.age, f.blue.age)}${taleRow('სიმაღლე', f.red.ht, f.blue.ht)}${taleRow('წონა', f.red.wt, f.blue.wt)}${taleRow('წვდომი', f.red.reach, f.blue.reach)}</div></div>
        <div class="stage-img right"><img src="${f.blue.img || noImg}" alt="${f.blue.name}" decoding="async" width="323" height="235" ${i === 0 ? 'fetchpriority="high"' : 'loading="lazy"'}></div>
      </div>
      <div class="picks-wrap">${hint}<div class="bout-picks">${pickBtn('red', f.red)}${pickBtn('blue', f.blue)}</div></div>
      ${canBet && f.showDetails ? `<button class="more-btn" data-more="${i}">${open ? 'ნაკლები დეტალი ▲' : 'მეტი დეტალი ▾'}</button>` : ''}
      <div class="extra ${open && canBet ? 'show' : ''}">
        <div class="extra-group"><div class="extra-title">აირჩიე მებრძოლი</div><div class="fighter-pick">
          <button class="fp-btn red ${fr === 'red' ? 'on' : ''}" data-fighter="${i}" data-fr="red" ${!canBet ? 'disabled' : ''}>${f.red.name}</button>
          <button class="fp-btn blue ${fr === 'blue' ? 'on' : ''}" data-fighter="${i}" data-fr="blue" ${!canBet ? 'disabled' : ''}>${f.blue.name}</button>
        </div></div>
        <div class="extra-group center"><div class="extra-title">გამარჯვების მეთოდი</div><div class="mkt-chips">${methodChips}</div></div>
        <div class="extra-group center"><div class="extra-title">რომელ რაუნდში დასრულდება ბრძოლა</div><div class="mkt-chips">${roundChips}</div></div>
        ${p ? `<div class="combo-bar ${fcls}"><span>ჯამური კოეფიციენტი</span><span class="cv">${pickOdds(i).toFixed(2)}</span></div>` : ''}
      </div>
    </div>`;
  }).join('');

  document.querySelectorAll('[data-winner]').forEach(b => { if (!b.disabled) b.onclick = () => setWinner(+b.dataset.winner, b.dataset.fr); });
  document.querySelectorAll('[data-fighter]').forEach(b => { if (!b.disabled) b.onclick = () => setFighterDetail(+b.dataset.fighter, b.dataset.fr); });
  document.querySelectorAll('[data-round]').forEach(b => { if (!b.disabled) b.onclick = () => setRound(+b.dataset.round, +b.dataset.val); });
  document.querySelectorAll('[data-method]').forEach(b => { if (!b.disabled) b.onclick = () => setMethod(+b.dataset.method, b.dataset.val); });
  document.querySelectorAll('[data-more]').forEach(b => b.onclick = () => toggleDetail(+b.dataset.more));
  document.querySelectorAll('.stage-img img').forEach(img => { img.addEventListener('error', function onErr() { this.removeEventListener('error', onErr); this.src = noImg; }); });
}

// ── SLIP ──
function picksArr() { return Object.keys(state.picks).map(i => +i).map(i => ({ i, ...state.picks[i], odds: pickOdds(i), name: selName(i), mk: selMk(i) })); }
function comboOdds() { return r2(picksArr().reduce((p, s) => p * (Number.isFinite(s.odds) && s.odds > 0 ? s.odds : 1), 1)); }
function setMode(m) { state.mode = m; renderSlip(); }
function digits(inp) { const v = inp.value.replace(/[^0-9]/g, ''); inp.value = v; return +v || 0; }

function renderSlip() {
  const arr = picksArr();
  document.getElementById('slipBadge').textContent = arr.length;
  document.getElementById('tabExpress').classList.toggle('on', state.mode === 'express');
  document.getElementById('tabSingle').classList.toggle('on', state.mode === 'single');
  const body = document.getElementById('slipBody'), foot = document.getElementById('slipFoot');
  if (arr.length === 0) { body.innerHTML = '<div class="slip-empty">ბილეთი ცარიელია.<br>დააჭირე კოეფიციენტს ბრძოლების სიაში.</div>'; foot.innerHTML = ''; return; }
  body.innerHTML = arr.map(s => `
    <div class="sel ${s.fighter || ''}">
      <div class="sel-top"><div><div class="sel-name">${s.name}</div><div class="sel-mk">${s.mk} · კოეფ. ${s.odds.toFixed(2)}</div></div>
        <button class="sel-rm" data-rm="${s.i}" aria-label="წაშლა">&times;</button></div>
      ${state.mode === 'single' ? `<div class="stake-row"><input class="stake-in" type="text" inputmode="numeric" placeholder="ფსონი (ქულა)" value="${s.stake || ''}" data-stake="${s.i}"><span class="sel-ret">მოგება: <b data-ret="${s.i}">${s.stake ? fmt(s.stake * s.odds) : '0'}</b></span></div>` : ''}
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
  const foot = document.getElementById('slipFoot');
  if (state.mode === 'express') {
    const co = comboOdds(), st = state.expressStake;
    foot.innerHTML = `
      <div class="tot-row"><span class="lab">ჯამური კოეფიციენტი</span><span style="font-weight:700">${co.toFixed(2)}</span></div>
      <div class="tot-row"><span class="lab">ფსონი</span><input class="foot-stake" type="text" inputmode="numeric" placeholder="0" value="${st || ''}" id="expStake"></div>
      <div class="tot-row"><span class="lab">შესაძლო მოგება</span><span class="green" id="foWin">${fmt(st * co)} ქულა</span></div>
      <div class="stake-err" id="foErr" style="display:none">არასაკმარისი ქულები</div>
      <button class="btn btn-primary" id="placeBtn">ბილეთის დადება</button>`;
    const es = document.getElementById('expStake'); if (es) es.oninput = () => { state.expressStake = digits(es); updateTotals(); };
  } else {
    foot.innerHTML = `
      <div class="tot-row"><span class="lab">ფსონი</span><span style="font-weight:700" id="foTot">${fmt(totalStakeSingle())} ქულა</span></div>
      <div class="tot-row"><span class="lab">შესაძლო მოგება</span><span class="green" id="foWin">${fmt(picksArr().reduce((s, x) => s + (x.stake || 0) * x.odds, 0))} ქულა</span></div>
      <div class="stake-err" id="foErr" style="display:none">არასაკმარისი ქულები</div>
      <button class="btn btn-primary" id="placeBtn">ბილეთის დადება</button>`;
  }
  document.getElementById('placeBtn').onclick = placeBets;
  updateTotals();
}

function updateTotals() {
  renderBar();
  const pb = document.getElementById('placeBtn'), err = document.getElementById('foErr'), win = document.getElementById('foWin');
  if (!pb) return;
  if (state.mode === 'express') {
    const co = comboOdds(), n = state.expressStake, over = n > state.balance;
    const es = document.getElementById('expStake'); if (es) es.classList.toggle('over', over);
    if (win) win.textContent = fmt(n * co) + ' ქულა';
    if (err) err.style.display = over ? 'block' : 'none';
    pb.disabled = n <= 0 || over;
  } else {
    const ts = totalStakeSingle(), tr = picksArr().reduce((s, x) => s + (x.stake || 0) * x.odds, 0), over = ts > state.balance;
    const tot = document.getElementById('foTot'); if (tot) { tot.textContent = fmt(ts) + ' ქულა'; tot.style.color = over ? 'var(--red-soft)' : ''; }
    if (win) win.textContent = fmt(tr) + ' ქულა';
    if (err) err.style.display = over ? 'block' : 'none';
    document.querySelectorAll('#slipBody .stake-in').forEach(x => x.classList.toggle('over', over));
    pb.disabled = ts <= 0 || over;
  }
}

// ── PLACE BETS ──
async function placeBets() {
  const pb = document.getElementById('placeBtn');
  if (!currentUser) { closeSlip(); openModal('join'); return; }
  if (isBettingClosed()) { closeSlip(); alert('ფსონების მიღება დასრულებულია'); return; }
  const arr = picksArr(); if (arr.length === 0) return;
  if (arr.some(s => !(Number.isFinite(s.odds) && s.odds > 0))) { alert('ერთ-ერთ ბრძოლას კოეფიციენტი ჯერ არ აქვს — წაშალე იგი ბილეთიდან'); return; }
  const eventId = window.__currentEventId || null;
  if (!eventId) { closeSlip(); alert('ივენთი ვერ მოიძებნა'); return; }

  // ორმაგი დაკლიკვის ბლოკი + რეალური ბალანსი DB-დან (თავიდან ავიცილოთ ცრუ 1000)
  if (pb) pb.disabled = true;
  await refreshBalance();

  try {
    if (state.mode === 'express') {
      const st = state.expressStake;
      if (st <= 0) { return; }
      if (st > state.balance) { updateTotals(); alert('არასაკმარისი ქულები ბალანსზე (გაქვს ' + fmt(state.balance) + ')'); return; }
      const odds = comboOdds();
      const selections = arr.map(s => ({ fight_id: FIGHTS[s.i]?._dbId, picked_fighter: s.fighter, picked_round: s.round || null, picked_method: s.method || null, odds: s.odds }));
      const { data: res, error } = await sb.rpc('place_bet', { p_event_id: eventId, p_type: 'express', p_stake: st, p_total_odds: odds, p_selections: selections });
      if (error || !res || !res.ok) { await refreshBalance(); updateTotals(); alert(betError(res, error)); return; }
      updateBalance(res.balance);
      const finalOdds = res.total_odds != null ? Number(res.total_odds) : odds;
      state.tickets.unshift({ _dbId: res.ticket_id, type: 'express',
        sels: arr.map(s => ({ i: s.i, fighter: s.fighter, round: s.round, method: s.method, odds: s.odds, name: s.name, redName: FIGHTS[s.i]?.red.name, blueName: FIGHTS[s.i]?.blue.name })),
        stake: st, odds: finalOdds, status: 'open', placedAt: serverNow() });
      window.dataLayer = window.dataLayer || []; window.dataLayer.push({event:'ticket_placed', ticket_type:'express', event_name: state.eventName||'', num_picks: arr.length});
    } else {
      const ts = totalStakeSingle();
      if (ts <= 0) { return; }
      if (ts > state.balance) { updateTotals(); alert('არასაკმარისი ქულები ბალანსზე (გაქვს ' + fmt(state.balance) + ')'); return; }
      let placedAny = false;
      for (const s of arr) {
        if (s.stake > 0) {
          const selections = [{ fight_id: FIGHTS[s.i]?._dbId, picked_fighter: s.fighter, picked_round: s.round || null, picked_method: s.method || null, odds: s.odds }];
          const { data: res, error } = await sb.rpc('place_bet', { p_event_id: eventId, p_type: 'single', p_stake: s.stake, p_total_odds: s.odds, p_selections: selections });
          if (error || !res || !res.ok) { await refreshBalance(); alert(betError(res, error)); continue; }
          updateBalance(res.balance); placedAny = true;
          const finalOdds = res.total_odds != null ? Number(res.total_odds) : s.odds;
          state.tickets.unshift({ _dbId: res.ticket_id, type: 'single',
            sels: [{ i: s.i, fighter: s.fighter, round: s.round, method: s.method, odds: s.odds, name: s.name, redName: FIGHTS[s.i]?.red.name, blueName: FIGHTS[s.i]?.blue.name }],
            stake: s.stake, odds: finalOdds, status: 'open', placedAt: serverNow() });
          window.dataLayer = window.dataLayer || []; window.dataLayer.push({event:'ticket_placed', ticket_type:'single', event_name: state.eventName||'', num_picks:1});
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
    const pb2 = document.getElementById('placeBtn'); if (pb2) pb2.disabled = false;
    updateTotals();
  }
}

// ── TICKETS ──
function renderTickets() {
  const activeList = $('activeTickets'), historyList = $('historyTickets'), singleList = $('ticketsList');
  const activeTickets = state.tickets.filter(t => t.status === 'open');
  const historyTickets = state.tickets.filter(t => t.status === 'won' || t.status === 'lost' || t.status === 'cashout').sort((a, b) => (b.placedAt || 0) - (a.placedAt || 0));

  const summaryEl = $('tkSummary'); if (summaryEl) summaryEl.textContent = state.tickets.length + ' ბილეთი';
  const activeBadge = $('activeBadge'); if (activeBadge) activeBadge.textContent = activeTickets.length;
  const historyBadge = $('historyBadge'); if (historyBadge) historyBadge.textContent = historyTickets.length;

  const stLabel = { open: 'მიმდინარე', won: 'მოგებული', lost: 'წაგებული', cashout: 'ქეშაუთი', pending: 'მიმდინარე' };
  const cashoutOk = canCashout();

  const selResult = (s) => {
    if (s.res === 'ok' || s.res === 'no') return s.res;
    const f = (s.i >= 0 && s.i < FIGHTS.length) ? FIGHTS[s.i] : null;
    if (!f || f.status !== 'completed' || !f.resultWinner) return null;
    return f.resultWinner === s.fighter ? 'ok' : 'no';
  };

  const renderTicketCard = (t) => {
    const realIdx = state.tickets.indexOf(t);
    const key = t._dbId != null ? String(t._dbId) : ('idx' + realIdx);
    const showCashout = t.status === 'open' && cashoutOk;
    const totalOdds = Number(t.odds || 0).toFixed(2);
    const potentialWin = Math.round((t.stake || 0) * (t.odds || 0));
    const isCollapsed = state.tkCollapsed[key] !== false;
    const statusColor = t.status === 'won' ? 'var(--green)' : (t.status === 'lost' ? 'var(--red-soft)' : (t.status === 'cashout' ? 'var(--gold)' : '#ff9d3c'));
    const winColor = t.status === 'won' ? 'var(--green)' : t.status === 'lost' ? 'var(--red-soft)' : 'var(--gold)';
    const winText = t.status === 'won' ? '+' + fmt(potentialWin) : fmt(potentialWin);
    const collapsedView = `<div class="tk-collapsed-info">
        <div class="tkc-col"><span class="tkc-lbl">პოზიცია</span><span class="tkc-val">${t.sels.length}</span></div>
        <div class="tkc-col"><span class="tkc-lbl">ფსონი</span><span class="tkc-val">${fmt(t.stake)}</span></div>
        <div class="tkc-col"><span class="tkc-lbl">კოეფ.</span><span class="tkc-val">${totalOdds}</span></div>
        <div class="tkc-col"><span class="tkc-lbl">${t.status === 'cashout' ? 'ქეშაუთი' : 'შესაძლო მოგება'}</span><span class="tkc-val" style="color:${winColor}">${t.status === 'cashout' ? '✓' : winText}</span></div>
      </div>`;
    return `
    <div class="ticket tk-${t.status} ${isCollapsed ? 'collapsed' : ''}">
      <div class="tk-head" data-tktoggle="${key}" style="cursor:pointer">
        <div class="tk-head-left"><span class="tk-status ${t.status}" style="color:${statusColor}">${stLabel[t.status] || t.status}</span><span class="tk-type">${t.type === 'express' ? 'ექსპრესი · ' + t.sels.length + ' მოვლენა' : 'სინგლი'}</span></div>
        <span class="tk-arrow ${isCollapsed ? '' : 'open'}">▾</span>
      </div>
      ${isCollapsed ? collapsedView : `
      <div class="tk-sels">
        ${t.sels.map(s => {
          const parts = s.name.split(' · '); const fighterName = (parts[0] || '').replace(' მოგება', ''); const extras = parts.slice(1).join(' · ');
          const isRed = s.fighter === 'red';
          const f = (s.i >= 0 && s.i < FIGHTS.length) ? FIGHTS[s.i] : null;
          const redName = s.redName || (f ? f.red.name : ''); const blueName = s.blueName || (f ? f.blue.name : '');
          const pickLabel = extras || 'გამარჯვებული';
          const res = selResult(s); const resCls = res === 'ok' ? 'ok' : res === 'no' ? 'no' : ''; const resTxt = res === 'ok' ? '✓' : res === 'no' ? '✗' : '';
          return `<div class="tk-sel"><div class="tk-sel-main">
              <div class="tk-sel-fighters"><span class="tk-sel-dot red"></span><span class="tk-sel-red">${redName || 'Red'}</span><span class="tk-sel-vs">vs</span><span class="tk-sel-blue">${blueName || 'Blue'}</span><span class="tk-sel-dot blue"></span></div>
              <div class="tk-sel-pick pick-${isRed ? 'red' : 'blue'}">${fighterName} — ${pickLabel}</div></div>
            <div class="tk-sel-right">${resTxt ? `<span class="tk-sel-result ${resCls}">${resTxt}</span>` : ''}<span class="tk-sel-odds">${Number(s.odds || 0).toFixed(2)}</span></div></div>`;
        }).join('')}
      </div>
      <div class="tk-foot"><span class="tk-foot-type">${t.type === 'express' ? 'ექსპრესი' : 'სინგლი'}</span><span class="tk-foot-pay">
          ${t.status === 'won' ? '<span style="color:var(--green)">+' + fmt(potentialWin) + ' ქულა</span>'
            : t.status === 'lost' ? '<span style="color:var(--red-soft)">' + fmt(potentialWin) + ' ქულა</span>'
            : t.status === 'cashout' ? '<span style="color:var(--gold)">ქეშაუთი</span>'
            : '<span class="tk-foot-label">შეს. მოგება</span><span style="color:var(--gold)">' + fmt(potentialWin) + '</span>'}
        </span></div>
      ${showCashout ? `<button class="cashout-btn" data-co="${realIdx}">${cashoutLabel(t)}</button>` : ''}
      `}
    </div>`;
  };

  if (activeList && historyList) {
    activeList.innerHTML = activeTickets.length === 0 ? '<div class="tk-empty">აქტიური ბილეთი არ არის. აირჩიე კოეფიციენტი და დადე პირველი ფსონი.</div>' : activeTickets.map(renderTicketCard).join('');
    historyList.innerHTML = historyTickets.length === 0 ? '<div class="tk-empty">ისტორია ცარიელია.</div>' : historyTickets.map(renderTicketCard).join('');
  } else if (singleList) {
    const all = [...activeTickets, ...historyTickets];
    singleList.innerHTML = all.length === 0 ? '<div class="tk-empty">ბილეთი ჯერ არ გაქვს. აირჩიე კოეფიციენტი და დადე პირველი ფსონი.</div>' : all.map(renderTicketCard).join('');
  }
  document.querySelectorAll('[data-co]').forEach(b => b.onclick = (e) => { e.stopPropagation(); doCashout(+b.dataset.co); });
  document.querySelectorAll('[data-tktoggle]').forEach(b => b.onclick = () => { const key = b.dataset.tktoggle; state.tkCollapsed[key] = state.tkCollapsed[key] === false ? true : false; renderTickets(); });
}

// ── BALANCE / BAR ──
function updateBalance(val) { if (!Number.isFinite(+val)) return; _balanceKnown = true; state.balance = +val; const el = document.getElementById('balNav'); if (el) el.textContent = fmt(val); }
// რეალური ბალანსი DB-დან — რომ UI ყოველთვის სიმართლეს აჩვენებდეს
async function refreshBalance() {
  if (!currentUser) return;
  try { const { data } = await sb.from('users').select('balance').eq('id', currentUser.id).maybeSingle();
    if (data && data.balance != null) { currentUser.balance = data.balance; updateBalance(data.balance); } } catch (e) {}
}
// სერვერის შეცდომების ქართული თარგმანი
function betError(res, error) {
  const e = (res && res.error) || (error && error.message) || '';
  const map = {
    'insufficient balance': 'არასაკმარისი ქულები ბალანსზე',
    'betting closed': 'ფსონების მიღება დასრულებულია',
    'odds not available': 'ამ ბრძოლას კოეფიციენტი ჯერ არ აქვს',
    'invalid selection or odds not available yet': 'ამ ბრძოლას კოეფიციენტი ჯერ არ აქვს',
    'not authenticated': 'გთხოვ, გაიარე ავტორიზაცია',
    'fight not open': 'ეს ბრძოლა ფსონისთვის დაკეტილია',
    'fight is not open for betting': 'ეს ბრძოლა ფსონისთვის დაკეტილია',
    'event not found': 'ივენთი ვერ მოიძებნა'
  };
  return map[e] || ('ფსონი ვერ დაიდო: ' + (e || 'უცნობი შეცდომა'));
}
function renderBar() {
  const n = picksArr().length;
  document.getElementById('bbCoef').textContent = (n ? comboOdds() : 1).toFixed(2);
  document.getElementById('balNav').textContent = _balanceKnown ? fmt(state.balance) : '…';
  document.getElementById('bbCount').textContent = n;
  document.getElementById('betbar').classList.toggle('show', n > 0 && !isBettingClosed());
}

// ── LEADERBOARD ──
const LEADERBOARD = [];
const AVATAR_ICONS = ['🥊','🏆','🔥','⚡','💪','🦁','🐺','👊','💎','🎯','⭐','🦅'];
let _contactPopupShown = false;
function hasContact(user) { return !!(user && (user.phone || user.telegram)); }
// ინდივიდუალურად ამოწმებს რა აკლია იუზერს — რომელიმე თუ აკლია, popup ამოხტება
function needsProfileInfo(user) {
  if (!user) return false;
  return !(user.phone || user.telegram) || !user.birth_year || !user.gender;
}

function showContactInfoPopup() {
  if (_contactPopupShown || !currentUser) return; _contactPopupShown = true;
  const m = document.getElementById('contactInfoModal'); if (!m) return;
  const ciPhoneEl = document.getElementById('ciPhone'); if (ciPhoneEl) ciPhoneEl.value = currentUser.phone || '';
  const ciTgEl = document.getElementById('ciTelegram'); if (ciTgEl) ciTgEl.value = currentUser.telegram || '';
  const ciByEl = document.getElementById('ciBirthYear'); if (ciByEl) ciByEl.value = currentUser.birth_year || '';
  document.querySelectorAll('input[name="ciGender"]').forEach(r => { r.checked = (currentUser.gender === r.value); });

  // მხოლოდ ის ვაჩვენოთ, რაც აკლია
  const contactWrap = document.getElementById('ciContactWrap');
  if (contactWrap) contactWrap.style.display = hasContact(currentUser) ? 'none' : 'block';
  const byField = document.getElementById('ciBirthYearField'); if (byField) byField.style.display = currentUser.birth_year ? 'none' : 'block';
  const gField = document.getElementById('ciGenderField'); if (gField) gField.style.display = currentUser.gender ? 'none' : 'block';

  const ciErr = document.getElementById('ciError'); if (ciErr) ciErr.style.display = 'none';
  m.classList.add('show');
}
function closeContactInfoPopup() { const m = document.getElementById('contactInfoModal'); if (m) m.classList.remove('show'); }

async function saveContactInfo() {
  const phone = (document.getElementById('ciPhone') && document.getElementById('ciPhone').value || '').trim();
  const telegram = (document.getElementById('ciTelegram') && document.getElementById('ciTelegram').value || '').trim();
  const birthYearRaw = (document.getElementById('ciBirthYear') && document.getElementById('ciBirthYear').value || '').trim();
  const genderEl = document.querySelector('input[name="ciGender"]:checked');
  const gender = genderEl ? genderEl.value : '';
  const errEl = document.getElementById('ciError');
  const showErr = msg => { if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; } };

  // ვამოწმებთ მხოლოდ იმას, რაც აკლია (ანუ რაც ჩანს popup-ში)
  if (!hasContact(currentUser)) {
    if (!phone && !telegram) { showErr('შეიყვანე მინიმუმ ერთი: ნომერი ან ტელეგრამი'); return; }
  }
  if (!currentUser.birth_year) {
    if (!birthYearRaw || !/^\d{4}$/.test(birthYearRaw) || +birthYearRaw < 1900 || +birthYearRaw > 2015) { showErr('შეიყვანე სწორი დაბადების წელი (მაგ. 1998)'); return; }
  }
  if (!currentUser.gender && !gender) { showErr('აირჩიე სქესი'); return; }

  const updates = {};
  if (phone) updates.phone = phone;
  if (telegram) updates.telegram = telegram.replace(/^@/, '');
  if (!currentUser.birth_year && birthYearRaw) updates.birth_year = +birthYearRaw;
  if (!currentUser.gender && gender) updates.gender = gender;

  if (Object.keys(updates).length === 0) { closeContactInfoPopup(); return; }

  try {
    const { data, error } = await sb.from('users').update(updates).eq('id', currentUser.id).select('id,phone,telegram,birth_year,gender');
    if (error) { showErr((error.message && error.message.toLowerCase().includes('column')) ? 'სვეტები DB-ში ჯერ არ არსებობს — გაუშვი migration' : ('შენახვა ვერ მოხერხდა: ' + error.message)); return; }
    if (!data || data.length === 0) { showErr('შენახვა დაბლოკილია (RLS).'); return; }
    currentUser.phone = data[0].phone || null;
    currentUser.telegram = data[0].telegram || null;
    currentUser.birth_year = data[0].birth_year || null;
    currentUser.gender = data[0].gender || null;
  } catch (e) { showErr('შეცდომა: ' + e.message); return; }
  closeContactInfoPopup(); renderLeaderboard();
}
$on('ciSave', 'click', saveContactInfo);
$on('ciSkip', 'click', closeContactInfoPopup);
$on('contactInfoModal', 'click', e => { if (e.target.id === 'contactInfoModal') closeContactInfoPopup(); });

function renderLeaderboard() {
  const fullSorted = LEADERBOARD.map((r, i) => ({ ...r, rank: i + 1 }));
  const meIdx = currentUser ? fullSorted.findIndex(r => r.id === currentUser.id) : -1;
  let display;
  if (meIdx >= 0 && meIdx < 10) display = fullSorted.slice(0, 10);
  else if (meIdx >= 10) display = fullSorted.slice(0, 9).concat([fullSorted[meIdx]]);
  else display = fullSorted.slice(0, 10);
  const checkSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3"><path d="M6 12l4 4 8-8"/></svg>';
  const lbRows = document.getElementById('lbRows'); if (!lbRows) return;
  lbRows.innerHTML = display.map(r => {
    const you = currentUser && r.id === currentUser.id;
    const sign = r.pts > 0 ? '+' : '';
    const verified = (r.verified !== undefined) ? !!r.verified : !!(r.phone || r.telegram);
    const badge = verified ? '<span class="lb-verified-badge" title="ვერიფიცირებული">' + checkSvg + '</span>' : '';
    const nm = r.name || '—';
    const nmSize = nm.length > 16 ? '.78rem' : nm.length > 12 ? '.88rem' : '1rem';
    const ptsStr = sign + fmt(r.pts);
    const ptsSize = ptsStr.length > 8 ? '.78rem' : ptsStr.length > 6 ? '.9rem' : '1.05rem';
    return `<div class="lb-row ${you ? 'you' : ''}${verified ? ' verified-row' : ''}">
      <span class="lb-rank ${r.rank <= 3 ? 'top' : ''}">${r.rank}</span>
      <span class="lb-user"><span class="lb-ava-glove">${r.icon || '🥊'}</span><span class="lb-userinfo"><span class="lb-verified"><span class="lb-name" style="font-size:${nmSize}">${nm}</span>${badge}</span>${you ? '<span class="lb-tag">შენ</span>' : ''}</span></span>
      <span class="lb-roi"></span><span class="lb-pts" style="font-size:${ptsSize}">${ptsStr}</span></div>`;
  }).join('');
  renderLbFullButton(fullSorted);
}

function renderLbFullButton(fullSorted) {
  const lbWrap = document.querySelector('#leaderboard .lb'); if (!lbWrap) return;
  let btn = document.getElementById('lbFullBtn');
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
    const verified = (r.verified !== undefined) ? !!r.verified : !!(r.phone || r.telegram);
    const badge = verified ? '<span class="lb-verified-badge" title="ვერიფიცირებული">' + checkSvg + '</span>' : '';
    const nm = r.name || '—';
    const nmSize = nm.length > 16 ? '.78rem' : nm.length > 12 ? '.88rem' : '1rem';
    const ptsStr = sign + fmt(r.pts);
    const ptsSize = ptsStr.length > 8 ? '.78rem' : ptsStr.length > 6 ? '.9rem' : '1.05rem';
    return `<div class="lb-row ${you ? 'you' : ''}${verified ? ' verified-row' : ''}">
      <span class="lb-rank ${r.rank <= 3 ? 'top' : ''}">${r.rank}</span>
      <span class="lb-user"><span class="lb-ava-glove">${r.icon || '🥊'}</span><span class="lb-userinfo"><span class="lb-verified"><span class="lb-name" style="font-size:${nmSize}">${nm}</span>${badge}</span>${you ? '<span class="lb-tag">შენ</span>' : ''}</span></span>
      <span class="lb-pts" style="font-size:${ptsSize}">${ptsStr}</span></div>`;
  }).join('');
  overlay.innerHTML = `<div class="lb-popup"><div class="lb-popup-head"><h3>სრული ლიდერბორდი</h3><button class="x" id="lbPopupClose" aria-label="დახურვა">&times;</button></div><div class="lb-popup-body">${rowsHtml}</div></div>`;
  document.body.appendChild(overlay);
  const close = () => document.body.removeChild(overlay);
  document.getElementById('lbPopupClose').onclick = close;
  overlay.onclick = e => { if (e.target === overlay) close(); };
}

let _currentLbPeriod = 'goat';
function periodStartDate(period) {
  const now = new Date(); const y = now.getFullYear(), m = now.getMonth();
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
      const { data, error } = await sb.from('leaderboard_view').select('*').order('score', { ascending: false });
      if (error || !data) return;
      rows = data.map(u => ({ id: u.id, name: u.nick || '—', pts: Number(u.score) || 0, icon: u.icon || '🥊', verified: (u.verified !== undefined) ? !!u.verified : !!(u.phone || u.telegram) }));
    } else {
      const since = periodStartDate(_currentLbPeriod).toISOString();
      let { data: hist, error: hErr } = await sb.from('score_history').select('user_id, amount, created_at').gte('created_at', since);
      if (hErr) { const retry = await sb.from('score_history').select('user_id, amount, created_at'); hist = retry.data; hErr = retry.error; }
      if (hErr || !hist) { LEADERBOARD.length = 0; renderLeaderboard(); renderLbTabs(); return; }
      const { data: usersData } = await sb.from('leaderboard_view').select('*');
      const userMap = {};
      (usersData || []).forEach(u => { userMap[u.id] = { nick: u.nick || '—', icon: u.icon || '🥊', verified: (u.verified !== undefined) ? !!u.verified : !!(u.phone || u.telegram) }; });
      const map = {};
      hist.forEach(h => { const uid = h.user_id; if (!map[uid]) map[uid] = { id: uid, name: userMap[uid]?.nick || '—', icon: userMap[uid]?.icon || '🥊', pts: 0, verified: userMap[uid]?.verified || false }; map[uid].pts += Number(h.amount) || 0; });
      rows = Object.values(map).filter(r => r.pts > 0).sort((a, b) => b.pts - a.pts);
    }
    LEADERBOARD.length = 0; rows.forEach(r => LEADERBOARD.push(r));
    renderLeaderboard(); renderLbTabs();
  } catch (e) { console.warn('loadLeaderboard failed:', e); }
}

function renderLbTabs() {
  const tabs = document.getElementById('lbTabs'); if (!tabs) return;
  const periods = [{ key: '1m', label: '1 თვე' }, { key: '3m', label: '3 თვე' }, { key: '6m', label: '6 თვე' }, { key: '1y', label: '1 წელი' }, { key: 'goat', label: 'G.O.A.T' }];
  tabs.innerHTML = periods.map(p => `<button class="lb-tab ${_currentLbPeriod === p.key ? 'on' : ''}" data-period="${p.key}">${p.label}</button>`).join('');
  tabs.querySelectorAll('.lb-tab').forEach(b => { b.onclick = () => loadLeaderboard(b.dataset.period); });
}

// ── LIVE RESULTS ──
async function loadLiveResults() {
  const eventId = window.__currentEventId; if (!eventId) return;
  const ed = window.__eventDate; const diffH = ed ? (serverNow() - ed.getTime()) / 3600000 : 0;
  if (ed && diffH < 0) return; if (ed && diffH > 48) return;
  try {
    const { data: fights } = await sb.from('fights').select('id,status,result_winner,red:fighters!red_fighter_id(name),blue:fighters!blue_fighter_id(name)').eq('event_id', eventId);
    if (!fights) return;
    let changed = false;
    fights.forEach(f => {
      const idx = FIGHTS.findIndex(x => x._dbId === f.id); if (idx < 0) return;
      let rw = null;
      if (f.status === 'completed' && f.result_winner) { if (f.result_winner === f.red?.name) rw = 'red'; else if (f.result_winner === f.blue?.name) rw = 'blue'; else rw = null; }
      if (FIGHTS[idx].resultWinner !== rw || FIGHTS[idx].status !== f.status) { FIGHTS[idx].resultWinner = rw; FIGHTS[idx].status = f.status || 'upcoming'; changed = true; }
    });
    if (changed) { renderMarkets(); if (currentUser) { try { await loadUserTickets(); renderTickets(); } catch (e) {} } await loadLeaderboard(); }
  } catch (e) { console.warn('loadLiveResults failed:', e); }
}

// ── LOAD USER TICKETS ──
async function loadUserTickets() {
  if (!currentUser) return;
  try {
    const { data: rows, error } = await sb.from('tickets')
      .select(`id,type,stake,total_odds,status,placed_at,ticket_selections(fight_id,picked_fighter,picked_round,picked_method,odds,result,fight:fights!fight_id(id,status,result_winner,red:fighters!red_fighter_id(name),blue:fighters!blue_fighter_id(name)))`)
      .eq('user_id', currentUser.id).order('placed_at', { ascending: false });
    if (error || !rows) return;
    const statusMap = { pending: 'open', open: 'open', won: 'won', lost: 'lost', cashout: 'cashout' };
    state.tickets = rows.map(tk => ({
      _dbId: tk.id, type: tk.type,
      sels: (tk.ticket_selections || []).map(s => {
        const i = FIGHTS.findIndex(f => f._dbId === s.fight_id);
        const ffight = s.fight || null;
        const redName = ffight?.red?.name || '', blueName = ffight?.blue?.name || '';
        const fighterName = s.picked_fighter === 'red' ? redName : blueName;
        let res = s.result || null;
        if (!res && ffight && ffight.status === 'completed' && ffight.result_winner) {
          let winSide = null;
          if (ffight.result_winner === redName) winSide = 'red'; else if (ffight.result_winner === blueName) winSide = 'blue';
          if (winSide) res = s.picked_fighter === winSide ? 'ok' : 'no';
        }
        return { i, fighter: s.picked_fighter, round: s.picked_round, method: s.picked_method, odds: Number(s.odds), name: rebuildSelNameDB(fighterName, s), redName, blueName, res };
      }),
      stake: Number(tk.stake), odds: Number(tk.total_odds), status: statusMap[tk.status] || tk.status,
      placedAt: tk.placed_at ? new Date(tk.placed_at).getTime() : serverNow()
    }));
  } catch (e) { console.warn('loadUserTickets failed:', e); }
}
function rebuildSelNameDB(fighterName, s) {
  const a = [];
  if (fighterName) a.push(fighterName + ' მოგება'); else if (s.picked_fighter) a.push((s.picked_fighter === 'red' ? 'Red' : 'Blue') + ' მოგება');
  if (s.picked_round) a.push(s.picked_round + '-ე რაუნდი'); if (s.picked_method) a.push(s.picked_method);
  return a.join(' · ') || '—';
}

// ── SLIP OPEN/CLOSE ──
function openSlip() { document.getElementById('slipBg').classList.add('show'); document.getElementById('slip').classList.add('show'); }
function closeSlip() { document.getElementById('slipBg').classList.remove('show'); document.getElementById('slip').classList.remove('show'); }

// ── COUNTDOWN ──
const cd_d = document.getElementById('cd-d'), cd_h = document.getElementById('cd-h'), cd_m = document.getElementById('cd-m'), cd_s = document.getElementById('cd-s');
function tick() {
  const ed = window.__eventDate; const p = n => String(n).padStart(2, '0');
  if (!ed) { [cd_d, cd_h, cd_m, cd_s].forEach(el => { if (el) el.textContent = '--'; }); return; }
  const diff = ed - serverNow();
  if (diff <= 0) { [cd_d, cd_h, cd_m, cd_s].forEach(el => { if (el) el.textContent = '00'; }); return; }
  const d = Math.floor(diff / 864e5), h = Math.floor(diff % 864e5 / 36e5), m = Math.floor(diff % 36e5 / 6e4), s = Math.floor(diff % 6e4 / 1e3);
  if (cd_d) cd_d.textContent = p(d); if (cd_h) cd_h.textContent = p(h); if (cd_m) cd_m.textContent = p(m); if (cd_s) cd_s.textContent = p(s);
}
tick(); setInterval(tick, 1000);

// ── AUTH ──
const modal = document.getElementById('modal');
let modalMode = 'join';

function passwordError(pass) {
  if (pass.length < 6) return 'პაროლი მინ. 6 სიმბოლო';
  if (!/[A-Z]/.test(pass)) return 'პაროლში მინ. 1 დიდი ასო (A-Z)';
  if (!/[a-z]/.test(pass)) return 'პაროლში მინ. 1 პატარა ასო (a-z)';
  if (!/[0-9]/.test(pass)) return 'პაროლში მინ. 1 ციფრი (0-9)';
  return null;
}
// ცოცხალი პაროლის ჩეკლისტი — ჩაწერისას თითო მოთხოვნა მწვანდება
function updatePassChecklist() {
  const p = ($('inPass') && $('inPass').value) || '';
  const set = (id, cond) => { const el = $(id); if (el) el.classList.toggle('ok', cond); };
  set('pcLen',   p.length >= 6);
  set('pcUpper', /[A-Z]/.test(p));
  set('pcLower', /[a-z]/.test(p));
  set('pcDigit', /[0-9]/.test(p));
}
$on('inPass', 'input', updatePassChecklist);
function authError(msg) { const el = document.getElementById('authError'); if (el) { el.textContent = msg; el.style.display = msg ? 'block' : 'none'; } }

function openModal(mode) {
  modalMode = mode; authError('');
  const authErrEl = document.getElementById('authError'); if (authErrEl) authErrEl.style.color = 'var(--red)';
  const passEl = document.getElementById('inPass'); if (passEl) passEl.value = '';
  const titleEl = document.getElementById('modalTitle'); if (titleEl) titleEl.textContent = mode === 'join' ? 'შემოუერთდი ლიგას' : 'კეთილი იყოს დაბრუნება';
  const subEl = document.getElementById('modalSub'); if (subEl) subEl.textContent = ' ';
  const nameFieldEl = document.getElementById('nameField'); if (nameFieldEl) nameFieldEl.style.display = mode === 'join' ? 'block' : 'none';
  const confirmFieldEl = document.getElementById('confirmField'); if (confirmFieldEl) confirmFieldEl.style.display = mode === 'join' ? 'block' : 'none';
  const phoneFieldEl = document.getElementById('phoneField'); if (phoneFieldEl) phoneFieldEl.style.display = mode === 'join' ? 'block' : 'none';
  const birthYearFieldEl = document.getElementById('birthYearField'); if (birthYearFieldEl) birthYearFieldEl.style.display = mode === 'join' ? 'block' : 'none';
  const genderFieldEl = document.getElementById('genderField'); if (genderFieldEl) genderFieldEl.style.display = mode === 'join' ? 'block' : 'none';
  const nameEl = document.getElementById('inName'); if (nameEl) nameEl.value = '';
  const regPhoneEl = document.getElementById('inRegPhone'); if (regPhoneEl) regPhoneEl.value = '';
  const birthYearEl = document.getElementById('inBirthYear'); if (birthYearEl) birthYearEl.value = '';
  document.querySelectorAll('input[name="gender"]').forEach(r => r.checked = false);
  updatePassChecklist();
  const passHintEl = document.getElementById('passHint'); if (passHintEl) passHintEl.style.display = mode === 'join' ? 'block' : 'none';
  const submitEl = document.getElementById('modalSubmit'); if (submitEl) submitEl.textContent = mode === 'join' ? 'რეგისტრაცია' : 'შესვლა';
  const switchWrap = document.getElementById('modalSwitch'); if (switchWrap) switchWrap.innerHTML = mode === 'join' ? 'უკვე გაქვს ანგარიში? <button id="switchMode">შესვლა</button>' : 'ახალი ხარ აქ? <button id="switchMode">რეგისტრაცია</button>';
  const switchBtn = document.getElementById('switchMode'); if (switchBtn) switchBtn.onclick = () => openModal(mode === 'join' ? 'signin' : 'join');
  const forgotWrap = $('forgotWrap'); if (forgotWrap) forgotWrap.style.display = mode === 'signin' ? 'block' : 'none';
  if (modal) modal.classList.add('show');
}
function closeModal() { modal.classList.remove('show'); authError(''); }
function updateSecHead() {
  const secHead = document.querySelector('#card .sec-head'); if (!secHead) return;
  secHead.style.display = (!currentUser || isEventInProgress()) ? 'none' : '';
}
function updateNavForUser(user) {
  const joinBtn = document.getElementById('joinBtn'), signinBtn = document.getElementById('signinBtn'), balancePill = document.querySelector('.balance-pill');
  let navUser = document.getElementById('navUser');
  if (user) {
    if (joinBtn) joinBtn.style.display = 'none';
    if (signinBtn) signinBtn.style.display = 'none';
    if (!navUser) {
      navUser = document.createElement('div'); navUser.id = 'navUser'; navUser.className = 'nav-user';
      navUser.innerHTML = `<span class="nav-ava">${user.icon || '🥊'}</span><span class="nav-nick">${user.nick}</span>
        <div class="nav-dropdown" id="navDropdown"><button class="nav-dd-item" id="ddProfile">პროფილი</button><button class="nav-dd-item danger" id="ddLogout">გამოსვლა</button></div>`;
      if (joinBtn && joinBtn.parentNode) joinBtn.parentNode.insertBefore(navUser, joinBtn);
      navUser.onclick = (e) => { if (e.target.closest('.nav-dropdown')) return; document.getElementById('navDropdown').classList.toggle('show'); };
      document.getElementById('ddProfile').onclick = () => { document.getElementById('navDropdown').classList.remove('show'); openProfile(); };
      document.getElementById('ddLogout').onclick = () => { document.getElementById('navDropdown').classList.remove('show'); doLogout(); };
    } else { navUser.querySelector('.nav-nick').textContent = user.nick; navUser.querySelector('.nav-ava').textContent = user.icon || '🥊'; }
    navUser.style.display = 'flex';
    if (balancePill) balancePill.classList.add('visible');
    addMobileMenuLinks(); updateBalance(user.balance != null ? user.balance : 1000); updateSecHead();
  } else {
    if (joinBtn) joinBtn.style.display = '';
    if (signinBtn) signinBtn.style.display = '';
    if (navUser) navUser.style.display = 'none';
    if (balancePill) balancePill.classList.remove('visible');
    removeMobileMenuLinks(); _balanceKnown = false; state.balance = 1000;
  }
}

function addMobileMenuLinks() {
  const navLinks = document.getElementById('navLinks'); if (!navLinks) return;
  if (!document.getElementById('mProfile')) { const p = document.createElement('a'); p.href = '#'; p.id = 'mProfile'; p.className = 'nav-mobile-only'; p.textContent = 'პროფილი'; p.onclick = (e) => { e.preventDefault(); navLinks.classList.remove('open'); openProfile(); }; navLinks.insertBefore(p, navLinks.firstChild); }
  if (!document.getElementById('mLogout')) { const l = document.createElement('a'); l.href = '#'; l.id = 'mLogout'; l.className = 'nav-mobile-only danger'; l.textContent = 'გამოსვლა'; l.onclick = (e) => { e.preventDefault(); navLinks.classList.remove('open'); doLogout(); }; navLinks.appendChild(l); }
}
function removeMobileMenuLinks() { const p = document.getElementById('mProfile'); if (p) p.remove(); const l = document.getElementById('mLogout'); if (l) l.remove(); }
document.addEventListener('click', e => { const dd = document.getElementById('navDropdown'); if (dd && !e.target.closest('.nav-user')) dd.classList.remove('show'); });

async function hydrateUserData() {
  if (!currentUser) return;
  await _fightsReady;
  try { await refreshBalance(); } catch (e) {}
  try { await loadUserTickets(); } catch (e) { console.warn(e); }
  renderTickets();
  try { renderLeaderboard(); } catch (e) {}
  updateSecHead();
  if (needsProfileInfo(currentUser)) setTimeout(showContactInfoPopup, 1500);
}

async function doRegister() {
  const nick = (document.getElementById('inName').value || '').trim();
  const email = (document.getElementById('inEmail').value || '').trim();
  const pass = document.getElementById('inPass').value || '';
  const passConfirm = document.getElementById('inPassConfirm').value || '';
  const phone = (document.getElementById('inRegPhone') && document.getElementById('inRegPhone').value || '').trim();
  const birthYear = (document.getElementById('inBirthYear') && document.getElementById('inBirthYear').value || '').trim();
  const genderEl = document.querySelector('input[name="gender"]:checked');
  const gender = genderEl ? genderEl.value : '';
  if (!nick || !/^[a-zA-Z0-9_]{3,20}$/.test(nick)) { authError('სახელი: 3-20 ლათინური სიმბოლო (a-z, 0-9, _)'); return; }
  // ნიქის უნიკალურობა — is_nick_taken RPC (RLS-safe, anon-ისთვისაც მუშაობს)
  try { const { data: taken } = await sb.rpc('is_nick_taken', { p_nick: nick, p_exclude_user_id: null }); if (taken) { authError('ეს სახელი უკვე დაკავებულია — სცადე სხვა'); return; } } catch (e) {}
  if (!email) { authError('შეიყვანე ელ. ფოსტა'); return; }
  const pErr = passwordError(pass); if (pErr) { authError(pErr); return; }
  if (pass !== passConfirm) { authError('პაროლები არ ემთხვევა'); return; }
  if (!phone) { authError('შეიყვანე მობილურის ნომერი'); return; }
  if (!birthYear || !/^\d{4}$/.test(birthYear) || +birthYear < 1900 || +birthYear > 2015) { authError('შეიყვანე სწორი დაბადების წელი (მაგ. 1998)'); return; }
  if (!gender) { authError('აირჩიე სქესი'); return; }
  const btn = document.getElementById('modalSubmit'); btn.textContent = '…'; btn.disabled = true;
  const { data, error } = await sb.auth.signUp({ email, password: pass, options: { data: { nick, phone, birth_year: +birthYear, gender } } });
  btn.disabled = false; btn.textContent = 'რეგისტრაცია';
  if (error) { const msg = error.message || ''; if (msg.includes('already registered') || msg.includes('already been registered')) authError('ეს ელ. ფოსტა უკვე რეგისტრირებულია — სცადე შესვლა'); else if (msg.includes('Database error')) authError('ეს სახელი უკვე დაკავებულია — სცადე სხვა'); else authError(msg); return; }
  if (!data.session) { const el = document.getElementById('authError'); el.style.color = 'var(--green)'; el.textContent = 'რეგისტრაცია წარმატებულია! ანგარიშის გასააქტიურებლად დაადასტურე ელ.ფოსტა — შეამოწმე საფოსტო ყუთი (ასევე spam/junk).'; el.style.display = 'block'; return; }
  await new Promise(r => setTimeout(r, 1000));
  let ud = null;
  try { const res = await sb.from('users').select('*').eq('id', data.user.id).maybeSingle(); ud = res.data; } catch (e) {}
  try { const ipRes = await fetch('https://api.ipify.org?format=json'); const ipData = await ipRes.json(); await sb.from('users').update({ registration_ip: ipData.ip, last_login_ip: ipData.ip, phone: phone || null }).eq('id', data.user.id); } catch (e) {}
  try { await sb.from('users').update({ birth_year: +birthYear, gender }).eq('id', data.user.id); } catch (e) {}
  currentUser = { id: data.user.id, email, nick: ud?.nick || nick, balance: (ud && ud.balance != null) ? ud.balance : 1000, score: Number(ud?.score) || 0, icon: ud?.icon || '🥊', phone: phone || ud?.phone || null, telegram: ud?.telegram || null, birth_year: +birthYear || ud?.birth_year || null, gender: gender || ud?.gender || null };
  window.dataLayer = window.dataLayer || []; window.dataLayer.push({ event: 'user_registration', method: 'email' });
  closeModal(); updateNavForUser(currentUser); await hydrateUserData();
}

async function doSignIn() {
  const email = (document.getElementById('inEmail').value || '').trim();
  const pass = document.getElementById('inPass').value || '';
  if (!email || !pass) { authError('შეიყვანე ელ. ფოსტა და პაროლი'); return; }
  const btn = document.getElementById('modalSubmit'); btn.textContent = '…'; btn.disabled = true;
  const { data, error } = await sb.auth.signInWithPassword({ email, password: pass });
  btn.disabled = false; btn.textContent = 'შესვლა';
  if (error) { authError('არასწორი მეილი ან პაროლი'); return; }
  let ud = null;
  try { const res = await sb.from('users').select('*').eq('id', data.user.id).maybeSingle(); ud = res.data; } catch (e) {}
  currentUser = { id: data.user.id, email, nick: ud?.nick || email, balance: (ud && ud.balance != null) ? ud.balance : 1000, score: Number(ud?.score) || 0, icon: ud?.icon || '🥊', phone: ud?.phone || null, telegram: ud?.telegram || null, birth_year: ud?.birth_year || null, gender: ud?.gender || null };
  closeModal(); updateNavForUser(currentUser); await hydrateUserData();
}

async function doLogout() { await sb.auth.signOut(); currentUser = null; state.tickets = []; renderTickets(); updateNavForUser(null); }

async function handleGoogleAuth() {
  const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.origin + window.location.pathname } });
  if (error) console.warn(error.message);
}

// ── INIT ──
let _fightsLoaded = false;
let _resolveFights;
const _fightsReady = new Promise(res => { _resolveFights = res; });
let _sessionApplying = false;

async function loadFightsAndRender() {
  if (_fightsLoaded) return; _fightsLoaded = true;
  try { await loadEventFromDB(); } catch (e) { console.warn('loadEventFromDB failed:', e); }
  renderMarkets(); renderSlip(); renderBar(); updateNavForUser(currentUser);
  try { await loadLeaderboard(); } catch (e) { console.warn('loadLeaderboard failed:', e); }
  _resolveFights();
  renderTickets();
  loadLiveResults(); setInterval(loadLiveResults, 2 * 60 * 1000);
  updateSecHead();
}

async function applySession(session) {
  if (!session || currentUser || _sessionApplying) return;
  _sessionApplying = true;
  try {
    let ud = null;
    try { const res = await sb.from('users').select('*').eq('id', session.user.id).maybeSingle(); ud = res.data; } catch (e) { console.warn('users select failed:', e); }
    currentUser = { id: session.user.id, email: session.user.email,
      nick: ud?.nick || session.user.user_metadata?.nick || (session.user.email || '').split('@')[0],
      balance: (ud && ud.balance != null) ? ud.balance : 1000, score: Number(ud?.score) || 0,
      icon: ud?.icon || '🥊', phone: ud?.phone || null, telegram: ud?.telegram || null, birth_year: ud?.birth_year || null, gender: ud?.gender || null };
    try { const ipRes = await fetch('https://api.ipify.org?format=json'); const ipData = await ipRes.json(); await sb.from('users').update({ last_login_ip: ipData.ip }).eq('id', session.user.id); } catch (e) {}
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

// ── PROFILE MODAL ──
function openProfile() {
  if (!currentUser) return;
  const pm = document.getElementById('profileModal');
  document.getElementById('profNick').value = currentUser.nick || '';
  document.getElementById('profEmail').value = currentUser.email || '';
  document.getElementById('profPhone').value = currentUser.phone || '';
  document.getElementById('profTelegram').value = currentUser.telegram || '';
  document.getElementById('profOldPass').value = '';
  document.getElementById('profNewPass').value = '';
  profileMsg('', '');
  const picker = document.getElementById('iconPicker');
  picker.innerHTML = AVATAR_ICONS.map(ic => `<button class="icon-opt ${(currentUser.icon || '🥊') === ic ? 'active' : ''}" data-icon="${ic}">${ic}</button>`).join('');
  picker.querySelectorAll('.icon-opt').forEach(b => b.onclick = () => { picker.querySelectorAll('.icon-opt').forEach(x => x.classList.remove('active')); b.classList.add('active'); });
  pm.classList.add('show'); loadVerificationStatus();
}
function closeProfile() { document.getElementById('profileModal').classList.remove('show'); }

// ── ID VERIFICATION ──
let verifSelectedFile = null;
async function loadVerificationStatus() {
  const statusEl = document.getElementById('verifStatus'); const wrap = document.getElementById('verifUploadWrap');
  if (!statusEl || !wrap) return;
  verifSelectedFile = null;
  const preview = document.getElementById('verifPreview'); if (preview) preview.style.display = 'none';
  const submitBtn = document.getElementById('verifSubmitBtn'); if (submitBtn) submitBtn.style.display = 'none';
  const photoInput = document.getElementById('verifPhotoInput'); if (photoInput) photoInput.value = '';
  const { data: rows, error } = await sb.from('verifications').select('status,admin_note,submitted_at').eq('user_id', currentUser.id).order('submitted_at', { ascending: false }).limit(1);
  if (error) { const ps = document.querySelector('#verifStatus')?.closest('.profile-section'); if (ps) ps.style.display = 'none'; return; }
  const last = rows && rows[0];
  if (!last) { statusEl.textContent = ''; wrap.style.display = 'block'; return; }
  if (last.status === 'pending') { statusEl.textContent = '⏳ შენი ვერიფიკაცია განხილვის პროცესშია — ჩვეულებრივ 24 საათში მოგივა პასუხი.'; statusEl.style.color = 'var(--gold)'; wrap.style.display = 'none'; }
  else if (last.status === 'approved') { statusEl.textContent = '✅ ვერიფიცირებული ხარ — პრიზის მიღება შესაძლებელია.'; statusEl.style.color = 'var(--green)'; wrap.style.display = 'none'; }
  else if (last.status === 'rejected') { statusEl.textContent = '❌ წინა მცდელობა უარყოფილია' + (last.admin_note ? (': ' + last.admin_note) : '') + ' — სცადე ხელახლა, უფრო გარკვევით ფოტოთი.'; statusEl.style.color = 'var(--red)'; wrap.style.display = 'block'; }
}
function pickVerificationPhoto() { const el = document.getElementById('verifPhotoInput'); if (el) el.click(); }
function onVerificationFileSelected() {
  const input = document.getElementById('verifPhotoInput'); const file = input.files && input.files[0]; if (!file) return;
  if (file.size > 8 * 1024 * 1024) { alert('ფაილი ძალიან დიდია (მაქს. 8MB)'); input.value = ''; return; }
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { alert('მხოლოდ JPG/PNG/WEBP ფორმატია დაშვებული'); input.value = ''; return; }
  verifSelectedFile = file;
  const preview = document.getElementById('verifPreview'); preview.src = URL.createObjectURL(file); preview.style.display = 'block';
  document.getElementById('verifSubmitBtn').style.display = 'block';
}
async function submitVerificationPhoto() {
  if (!verifSelectedFile || !currentUser) return;
  const btn = document.getElementById('verifSubmitBtn'); btn.disabled = true; btn.textContent = 'იტვირთება...';
  const ext = (verifSelectedFile.name.split('.').pop() || 'jpg').toLowerCase();
  const path = `${currentUser.id}/${Date.now()}.${ext}`;
  const { error: upErr } = await sb.storage.from('id-verification').upload(path, verifSelectedFile, { contentType: verifSelectedFile.type, upsert: false });
  if (upErr) { btn.disabled = false; btn.textContent = 'ვერიფიკაციის გაგზავნა'; alert('ატვირთვა ვერ მოხერხდა: ' + upErr.message); return; }
  const { error: insErr } = await sb.from('verifications').insert({ user_id: currentUser.id, photo_path: path, status: 'pending' });
  btn.disabled = false; btn.textContent = 'ვერიფიკაციის გაგზავნა';
  if (insErr) { alert('ვერიფიკაციის გაგზავნა ვერ მოხერხდა: ' + insErr.message); return; }
  await loadVerificationStatus();
}
$on('verifPickBtn', 'click', pickVerificationPhoto);
$on('verifPhotoInput', 'change', onVerificationFileSelected);
$on('verifSubmitBtn', 'click', submitVerificationPhoto);

function profileMsg(msg, color) { const el = document.getElementById('profileMsg'); if (msg) { el.textContent = msg; el.style.color = color || 'var(--green)'; el.style.display = 'block'; } else { el.style.display = 'none'; } }

async function saveProfile() {
  if (!currentUser) return;
  const nick = (document.getElementById('profNick').value || '').trim();
  const email = (document.getElementById('profEmail').value || '').trim();
  const phone = (document.getElementById('profPhone').value || '').trim();
  const telegram = (document.getElementById('profTelegram').value || '').trim().replace(/^@/, '');
  const oldPass = document.getElementById('profOldPass').value || '';
  const newPass = document.getElementById('profNewPass').value || '';
  const selectedIcon = document.querySelector('#iconPicker .icon-opt.active');
  const icon = selectedIcon ? selectedIcon.dataset.icon : currentUser.icon || '🥊';
  if (nick && !/^[a-zA-Z0-9_]{3,20}$/.test(nick)) { profileMsg('სახელი: 3-20 ლათინური სიმბოლო (a-z, 0-9, _)', 'var(--red)'); return; }
  try {
    const nickChanged = nick && nick !== currentUser.nick;
    if (nickChanged) {
      let taken = false;
      const rpcRes = await sb.rpc('is_nick_taken', { p_nick: nick, p_exclude_user_id: currentUser.id });
      if (rpcRes.error) { const { data: fb } = await sb.from('leaderboard_view').select('id').eq('nick', nick).neq('id', currentUser.id).maybeSingle(); taken = !!fb; }
      else taken = !!rpcRes.data;
      if (taken) { profileMsg('ასეთი ზედმეტსახელი უკვე არსებობს', 'var(--red)'); return; }
    }
    const phoneChanged = phone !== (currentUser.phone || '');
    const telegramChanged = telegram !== (currentUser.telegram || '');
    if (nickChanged || icon !== currentUser.icon || phoneChanged || telegramChanged) {
      const upd = { nick: nick || currentUser.nick, icon };
      if (phoneChanged) upd.phone = phone || null; if (telegramChanged) upd.telegram = telegram || null;
      let { data: updData, error: updErr } = await sb.from('users').update(upd).eq('id', currentUser.id).select('id');
      if (updErr) {
        if (updErr.message && updErr.message.includes('column') && (phoneChanged || telegramChanged)) {
          const retry = await sb.from('users').update({ nick: nick || currentUser.nick, icon }).eq('id', currentUser.id).select('id');
          if (retry.error) { profileMsg('შენახვა ვერ მოხერხდა: ' + retry.error.message, 'var(--red)'); return; }
          updData = retry.data;
        } else if (String(updErr.message || '').toLowerCase().includes('duplicate') || updErr.code === '23505') { profileMsg('ასეთი ზედმეტსახელი უკვე არსებობს', 'var(--red)'); return; }
        else { profileMsg('შენახვა ვერ მოხერხდა: ' + updErr.message, 'var(--red)'); return; }
      }
      if (!updData || updData.length === 0) { profileMsg('შენახვა დაბლოკილია (RLS). გაუშვი კონსოლიდირებული SQL Supabase-ში.', 'var(--red)'); return; }
      if (nickChanged) currentUser.nick = nick;
      currentUser.icon = icon;
      if (phoneChanged) currentUser.phone = phone || null;
      if (telegramChanged) currentUser.telegram = telegram || null;
    }
    if (email && email !== currentUser.email) {
      const { error } = await sb.auth.updateUser({ email });
      if (error) { profileMsg('მეილის შეცვლა ვერ მოხერხდა: ' + error.message, 'var(--red)'); return; }
      currentUser.email = email;
    }
    if (newPass) {
      const pErr = passwordError(newPass); if (pErr) { profileMsg('ახალი ' + pErr, 'var(--red)'); return; }
      if (!oldPass) { profileMsg('შეიყვანე ძველი პაროლი', 'var(--red)'); return; }
      const { error: signErr } = await sb.auth.signInWithPassword({ email: currentUser.email, password: oldPass });
      if (signErr) { profileMsg('ძველი პაროლი არასწორია', 'var(--red)'); document.getElementById('profOldPass').value = ''; document.getElementById('profNewPass').value = ''; return; }
      const { error: upErr } = await sb.auth.updateUser({ password: newPass });
      if (upErr) { profileMsg('პაროლის შეცვლა ვერ მოხერხდა', 'var(--red)'); return; }
    }
    updateNavForUser(currentUser); renderLeaderboard(); profileMsg('წარმატებით შეინახა!', 'var(--green)');
  } catch (e) { profileMsg('შეცდომა: ' + e.message, 'var(--red)'); }
}

// ── FORGOT / RESET PASSWORD ──
function openForgotPassword() {
  closeModal();
  const fm = document.getElementById('forgotModal');
  document.getElementById('forgotEmail').value = '';
  document.getElementById('forgotError').style.display = 'none';
  document.getElementById('forgotSuccess').style.display = 'none';
  document.getElementById('forgotSubmit').style.display = 'block';
  document.querySelector('#forgotModal .field').style.display = 'block';
  fm.classList.add('show');
}
function closeForgotModal() { document.getElementById('forgotModal').classList.remove('show'); }

function openResetPasswordModal() {
  closeModal(); closeForgotModal();
  document.getElementById('recoveryNewPass').value = '';
  document.getElementById('recoveryNewPassConfirm').value = '';
  document.getElementById('recoveryError').style.display = 'none';
  document.getElementById('recoverySuccess').style.display = 'none';
  document.querySelectorAll('#resetPasswordModal .field').forEach(f => f.style.display = 'block');
  document.getElementById('recoverySubmit').style.display = 'block';
  document.getElementById('resetPasswordModal').classList.add('show');
}
async function submitNewPassword() {
  const p1 = document.getElementById('recoveryNewPass').value, p2 = document.getElementById('recoveryNewPassConfirm').value;
  const errEl = document.getElementById('recoveryError'); errEl.style.display = 'none';
  const pErr = passwordError(p1); if (pErr) { errEl.textContent = pErr; errEl.style.display = 'block'; return; }
  if (p1 !== p2) { errEl.textContent = 'პაროლები არ ემთხვევა'; errEl.style.display = 'block'; return; }
  const btn = document.getElementById('recoverySubmit'); btn.disabled = true; btn.textContent = '…';
  const { error } = await sb.auth.updateUser({ password: p1 });
  btn.disabled = false; btn.textContent = 'პასვორდის დაყენება';
  if (error) { errEl.textContent = error.message; errEl.style.display = 'block'; return; }
  document.querySelectorAll('#resetPasswordModal .field').forEach(f => f.style.display = 'none');
  btn.style.display = 'none';
  document.getElementById('recoverySuccess').style.display = 'block';
  setTimeout(() => { document.getElementById('resetPasswordModal').classList.remove('show'); }, 2500);
}
async function sendPasswordReset() {
  const email = (document.getElementById('forgotEmail').value || '').trim();
  const errEl = document.getElementById('forgotError');
  if (!email) { errEl.textContent = 'შეიყვანე ელ. ფოსტა'; errEl.style.display = 'block'; return; }
  const btn = document.getElementById('forgotSubmit'); btn.textContent = '…'; btn.disabled = true;
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin + window.location.pathname });
  btn.disabled = false; btn.textContent = 'გამოგზავნა';
  if (error) { errEl.textContent = error.message; errEl.style.display = 'block'; return; }
  document.querySelector('#forgotModal .field').style.display = 'none';
  document.getElementById('forgotSubmit').style.display = 'none';
  document.getElementById('forgotSuccess').style.display = 'block';
  errEl.style.display = 'none';
}

// ── TOGGLE PASSWORD VISIBILITY ──
function toggleEye(inputId) {
  const inp = document.getElementById(inputId); if (!inp) return;
  const isPass = inp.type === 'password'; inp.type = isPass ? 'text' : 'password';
  const btn = inp.parentElement.querySelector('.eye-toggle');
  if (btn) btn.innerHTML = isPass
    ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>'
    : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
}

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

$on('activeToggle', 'click', () => { const act = $('activeTickets'), arrow = $('activeArrow'); if (!act) return; const isOpen = act.style.display !== 'none'; act.style.display = isOpen ? 'none' : 'flex'; if (arrow) arrow.classList.toggle('open', !isOpen); });
$on('historyToggle', 'click', () => { const hist = $('historyTickets'), arrow = $('historyArrow'); if (!hist) return; const isOpen = hist.style.display !== 'none'; hist.style.display = isOpen ? 'none' : 'flex'; if (arrow) arrow.classList.toggle('open', !isOpen); });

document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeModal(); closeSlip(); closeForgotModal(); closeProfile(); closeContactInfoPopup(); } });

const navLinks = $('navLinks');
$on('menuBtn', 'click', () => { if (navLinks) navLinks.classList.toggle('open'); });
document.querySelectorAll('a[href^="#"]').forEach(a => a.addEventListener('click', e => {
  const id = a.getAttribute('href').slice(1); const t = document.getElementById(id);
  if (t) { e.preventDefault(); t.scrollIntoView({ behavior: 'smooth', block: 'start' }); if (navLinks) navLinks.classList.remove('open'); }
}));

// ── INIT (server-time → getSession → fights → session) ──
const loadingEl = document.getElementById('markets');
if (loadingEl) loadingEl.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted)">იტვირთება ბრძოლები…</div>';

async function init() {
  try { await syncServerTime(); } catch (e) {}   // სერვერის დროის სინქრონიზაცია — ჯერ ეს, მერე ყველაფერი
  let session = null;
  try { const { data } = await sb.auth.getSession(); session = data.session; } catch (e) {}
  if (session) { const jb = $('joinBtn'), sb2 = $('signinBtn'); if (jb) jb.style.display = 'none'; if (sb2) sb2.style.display = 'none'; }
  await loadFightsAndRender();
  if (session && !currentUser) { try { await applySession(session); } catch (e) {} }
}
init();

// inline onclick handler-ებისთვის (HTML-ში onclick="toggleEye(...)")
window.toggleEye = toggleEye;

})(); // ── END IIFE ──
