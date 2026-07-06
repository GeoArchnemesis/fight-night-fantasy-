// ============================================================
//  UFC Fantasy — app.js  (v16 — ID verification upload added)
// ============================================================

const SUPABASE_URL = "https://qxfcwsiysnjxhxljqigl.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF4ZmN3c2l5c25qeGh4bGpxaWdsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxODM4MDUsImV4cCI6MjA5Nzc1OTgwNX0.SOeTrxnKulgO8ao8HSwxyKE-m9pvaQ54Pa_IGWWyKDc";
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    lock: (name, acquireTimeout, fn) => fn()
  }
});

// ── helpers ───────────────────────────────────────────────────
const r2  = x => Math.round(x * 100) / 100;
const fmt = n => Math.round(n).toLocaleString('en-US');
const METHODS = ['ნოკაუტი', 'მტკივნეული', 'გადაწყვეტილება'];

const $ = id => document.getElementById(id);
function $on(id, ev, fn) { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); }

// ── global state ──────────────────────────────────────────────
let FIGHTS = [];
const START = 1000;
const state = {
  balance: START, score: 0,
  picks: {}, mode: 'express', expressStake: 0,
  tickets: [], user: null, openDetail: {}, tkCollapsed: {}
};
let currentUser = null;

// ─────────────────────────────────────────────────────────────
//  BETTING RULES
// ─────────────────────────────────────────────────────────────
function isBettingClosed() {
  const ed = window.__eventDate;
  if (!ed) return false;
  const diff = ed - Date.now(); return diff < 1 * 60 * 1000;
}

function isEventInProgress() {
  const ed = window.__eventDate;
  if (!ed) return false;
  return (ed - Date.now()) < 0;
}

function canCashout() {
  const ed = window.__eventDate;
  if (!ed) return true;
  return (ed - Date.now()) > 60 * 60 * 1000;
}

function cashoutAmount(t) {
  const age = Date.now() - (t.placedAt || Date.now());
  if (age <= 60 * 60 * 1000) return t.stake;
  return Math.round(t.stake * 0.8);
}

function cashoutLabel(t) {
  const age = Date.now() - (t.placedAt || Date.now());
  return age <= 60 * 60 * 1000 ? '↩ ქეშაუთი (უფასო)' : '↩ ქეშაუთი (80%)';
}

// ─────────────────────────────────────────────────────────────
//  CASHOUT POPUP
// ─────────────────────────────────────────────────────────────
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
        <div style="color:var(--gold);font-size:1.05rem;font-weight:700;margin-bottom:24px">
          დაგიბრუნდება: ${fmt(amt)} ქულა${amt < stake ? ' (80%)' : ' (სრულად)'}
        </div>
        <div style="display:flex;gap:12px;justify-content:center">
          <button id="coCancelBtn" style="padding:10px 24px;border-radius:8px;border:1px solid var(--line);background:var(--surface-2);color:var(--text);cursor:pointer;font-family:inherit">გაუქმება</button>
          <button id="coConfirmBtn" style="padding:10px 24px;border-radius:8px;border:none;background:var(--red);color:#fff;cursor:pointer;font-family:inherit;font-weight:700">დადასტურება</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = val => { document.body.removeChild(overlay); resolve(val); };
    if (blocked) {
      document.getElementById('coClose').onclick = () => close(false);
    } else {
      document.getElementById('coConfirmBtn').onclick = () => close(true);
      document.getElementById('coCancelBtn').onclick  = () => close(false);
    }
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

  // cashout_ticket RPC — server-side ლოგიკა (balance ვერ გაყალბდება)
  const { data: res, error } = await sb.rpc('cashout_ticket', { p_ticket_id: t._dbId });
  if (error || !res || !res.ok) {
    alert('ქეშაუთი ვერ შესრულდა: ' + (res?.error || error?.message || 'უცნობი შეცდომა'));
    return;
  }

  t.status = 'cashout';
  updateBalance(res.balance);
  renderTickets();
}

// ─────────────────────────────────────────────────────────────
//  DB LOAD
// ─────────────────────────────────────────────────────────────
async function loadEventFromDB() {
  // upcoming ან ბოლო 24 საათში completed (ივენთი მიმდინარეობს)
  const { data: events, error: eErr } = await sb
    .from('events').select('*')
    .in('status', ['upcoming', 'completed'])
    .order('event_date', { ascending: false })
    .limit(1);
  if (eErr || !events || events.length === 0) return null;
  // მხოლოდ 24 საათში completed გამოვიყენოთ
  const ev0 = events[0];
  const hoursSince = (Date.now() - new Date(ev0.event_date).getTime()) / 3600000;
  if (ev0.status === 'completed' && hoursSince > 48) return null;

  const ev = ev0;
  window.__currentEventId = ev.id;

  const { data: fights, error: fErr } = await sb
    .from('fights')
    .select(`id,bout_order,weight_class,max_rounds,is_title_bout,red_odds,blue_odds,show_details,status,result_winner,result_method,result_round,
             red:fighters!red_fighter_id(name,flag,rank,record,age,height_cm,weight_kg,reach_cm,ufc_slug,ko_pct,sub_pct,dec_pct,image_url),
             blue:fighters!blue_fighter_id(name,flag,rank,record,age,height_cm,weight_kg,reach_cm,ufc_slug,ko_pct,sub_pct,dec_pct,image_url)`)
    .eq('event_id', ev.id)
    .order('bout_order', { ascending: true });
  if (fErr) return null;

  FIGHTS = fights.map(f => {
    // გამარჯვებული მხარე — მხოლოდ დასრულებულ ბრძოლაზე
    let resultWinner = null;
    if (f.status === 'completed' && f.result_winner) {
      resultWinner = f.result_winner === f.red.name ? 'red' : 'blue';
    }
    return {
      _dbId: f.id,
      wc: f.weight_class,
      rounds: f.max_rounds + ' Rounds',
      maxRound: f.max_rounds,
      showDetails: f.show_details !== false,
      status: f.status || 'upcoming',
      resultWinner,
      resultMethod: f.result_method || null,
      resultRound: f.result_round || null,
      red: {
        name: f.red.name, flag: f.red.flag || '🏳️', odds: f.red_odds == null ? null : Number(f.red_odds),
        img: f.red.image_url || null,
        record: f.red.record || '-', age: String(f.red.age || '-'),
        ht: (f.red.height_cm || '-') + ' სმ', wt: (f.red.weight_kg || '-') + ' კგ',
        reach: (f.red.reach_cm || '-') + ' სმ'
      },
      blue: {
        name: f.blue.name, flag: f.blue.flag || '🏳️', odds: f.blue_odds == null ? null : Number(f.blue_odds),
        img: f.blue.image_url || null,
        record: f.blue.record || '-', age: String(f.blue.age || '-'),
        ht: (f.blue.height_cm || '-') + ' სმ', wt: (f.blue.weight_kg || '-') + ' კგ',
        reach: (f.blue.reach_cm || '-') + ' სმ'
      }
    };
  });

  const tagEl = document.querySelector('.event-tag');
  if (tagEl) {
    const dt = new Date(ev.event_date);
    const EN = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const diff = dt - Date.now();
    let label = 'UPCOMING EVENT';
    if (ev.status === 'completed') label = 'EVENT FINISHED';
    else if (diff <= 0) label = '🔴 LIVE NOW';
    tagEl.innerHTML = label + '<br>' + (ev.location || '').toUpperCase() + '<br>' + EN[dt.getMonth()].toUpperCase() + ' ' + dt.getDate();
    window.__eventDate = dt;
  }
  return ev;
}

// ─────────────────────────────────────────────────────────────
//  ODDS HELPERS
// ─────────────────────────────────────────────────────────────
function roundOdds(i, r) {
  const f = FIGHTS[i];
  if (f.red.odds == null || f.blue.odds == null) return 0;
  const base = (f.red.odds + f.blue.odds) / 2;
  return r2(base * (1 + r * 0.15));
}
function methodOdds(i, m) {
  const f    = FIGHTS[i];
  if (f.red.odds == null || f.blue.odds == null) return 0;
  const base = (f.red.odds + f.blue.odds) / 2;
  if (m === 'გადაწყვეტილება') return r2(base * 0.9);
  if (m === 'ნოკაუტი')        return r2(base * 1.4);
  if (m === 'მტკივნეული')     return r2(base * 1.6);
  return 1.5;
}
function pickOdds(i) {
  const p = state.picks[i];
  if (!p) return 0;
  if (!p.round && !p.method) return p.fighter === 'red' ? FIGHTS[i].red.odds : FIGHTS[i].blue.odds;
  let o = 1;
  if (p.round)  o *= roundOdds(i, p.round);
  if (p.method) o *= methodOdds(i, p.method);
  return r2(o);
}
function selName(i) {
  const p = state.picks[i]; const a = [];
  if (p.fighter) a.push((p.fighter === 'red' ? FIGHTS[i].red.name : FIGHTS[i].blue.name) + ' მოგება');
  if (p.round)   a.push(p.round + '-ე რაუნდი');
  if (p.method)  a.push(p.method);
  return a.join(' · ');
}
function selMk(i) {
  const p = state.picks[i];
  return (p.round && p.method) ? 'რაუნდი + მეთოდი'
    : p.method ? 'გამარჯვების მეთოდი'
    : p.round  ? 'დასრულების რაუნდი'
    : 'მატჩის გამარჯვებული';
}

// ─────────────────────────────────────────────────────────────
//  PICK MANAGEMENT
// ─────────────────────────────────────────────────────────────
function ensure(i) {
  if (!state.picks[i]) state.picks[i] = { fighter: null, round: null, method: null, stake: 0 };
  return state.picks[i];
}
function clean(i) {
  const p = state.picks[i];
  if (p && !p.fighter && !p.round && !p.method) delete state.picks[i];
}
function setWinner(i, fr) {
  const p = state.picks[i];
  if (p && p.fighter === fr && !p.round && !p.method) delete state.picks[i];
  else state.picks[i] = { fighter: fr, round: null, method: null, stake: (p && p.stake) || 0 };
  refresh();
}
function setFighterDetail(i, fr) { const p = ensure(i); p.fighter = fr; clean(i); refresh(); }
function setRound(i, r) {
  const p = ensure(i);
  if (p.method === 'გადაწყვეტილება') p.method = null;
  p.round = p.round === r ? null : r;
  clean(i); refresh();
}
function setMethod(i, m) {
  const p = ensure(i);
  if (m === 'გადაწყვეტილება') { p.method = p.method === m ? null : m; if (p.method) p.round = null; }
  else { p.method = p.method === m ? null : m; }
  clean(i); refresh();
}
function toggleDetail(i) { state.openDetail[i] = !state.openDetail[i]; renderMarkets(); }
function refresh() { renderMarkets(); renderSlip(); renderBar(); }

// ─────────────────────────────────────────────────────────────
//  RENDER MARKETS
// ─────────────────────────────────────────────────────────────
function renderMarkets() {
  if (FIGHTS.length === 0) {
    document.getElementById('markets').innerHTML = '';
    return;
  }

  const inProgress = isEventInProgress();
  const betting = !isBettingClosed();

  // betbar მხოლოდ ფსონის დასადებად
  if (!betting) document.getElementById('betbar').classList.remove('show');

  const noImg = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 200'%3E%3Crect width='200' height='200' fill='%230E0D14'/%3E%3Ccircle cx='100' cy='85' r='42' fill='%23F31D25' opacity='.9'/%3E%3Ccircle cx='78' cy='75' r='16' fill='%23ff4040'/%3E%3Ccircle cx='100' cy='68' r='16' fill='%23ff4040'/%3E%3Ccircle cx='122' cy='75' r='16' fill='%23ff4040'/%3E%3Crect x='75' y='110' width='50' height='40' rx='8' fill='%23F31D25' opacity='.85'/%3E%3Crect x='82' y='145' width='36' height='18' rx='5' fill='%23cc1018'/%3E%3Ctext x='100' y='185' text-anchor='middle' font-size='14' fill='%23555'%3EMMA%3C/text%3E%3C/svg%3E";

  document.getElementById('markets').innerHTML = FIGHTS.map((f, i) => {
    const p = state.picks[i], fr = p ? p.fighter : null, open = state.openDetail[i];
    const mainOn = p && p.fighter && !p.round && !p.method;
    const fcls = fr || '';

    // ცოცხალი შედეგები — winner glow (მხოლოდ დასრულებულ ბრძოლაზე)
    const winner = (f.status === 'completed') ? f.resultWinner : null;
    const isCompleted = !!winner;

    const roundChips = Array.from({ length: f.maxRound }, (_, k) => k + 1).map(r =>
      `<button class="mkt-chip ${fcls} ${p && p.round === r ? 'on' : ''}" data-round="${i}" data-val="${r}" ${!betting ? 'disabled' : ''}>
        <span class="ml">${r}</span><span class="mo">${roundOdds(i, r).toFixed(2)}</span>
      </button>`).join('');

    const methodChips = METHODS.map(m =>
      `<button class="mkt-chip ${fcls} ${p && p.method === m ? 'on' : ''}" data-method="${i}" data-val="${m}" ${!betting ? 'disabled' : ''}>
        <span class="ml">${m}</span><span class="mo">${methodOdds(i, m).toFixed(2)}</span>
      </button>`).join('');

    const taleRow = (lab, a, b) =>
      `<div class="tale-row"><span class="tv l">${a}</span><span class="tl">${lab}</span><span class="tv r">${b}</span></div>`;

    const pickBtn = (side, d) => {
      const hasOdds = d.odds != null && d.odds > 0;
      const flag  = `<span class="p-flag">${d.flag}</span>`;
      const name  = `<span class="p-name">${d.name}</span>`;
      const od    = `<span class="p-od">${hasOdds ? d.odds.toFixed(2) : '—'}</span>`;
      const inner = side === 'red' ? flag + name + od : od + name + flag;
      // winner glow: მოგებული მებრძოლი მწვანე ველში
      const winnerCls = isCompleted && winner === side ? ' winner' : '';
      const onCls = betting && mainOn && fr === side ? ' on' : '';
      // კოეფიციენტი არ არის → ფსონის დადება დაბლოკილია
      const disabledAttr = (!betting || !hasOdds) ? ' disabled' : '';
      const canPick = betting && hasOdds;
      return `<button class="pick ${side}${onCls}${winnerCls}" ${canPick ? `data-winner="${i}" data-fr="${side}"` : ''} ${disabledAttr}>${inner}</button>`;
    };

    return `
    <div class="bout">
      <div class="bout-head">
        <span class="rank left">${f.red.record}</span>
        <span class="bout-class"><span class="wc">${f.wc}</span><span class="rd">${f.rounds}</span></span>
        <span class="rank right">${f.blue.record}</span>
      </div>
      <div class="bout-stage">
        <div class="stage-img left">
          <img src="${f.red.img || noImg}" alt="${f.red.name}" decoding="async" width="323" height="235" ${i === 0 ? 'fetchpriority="high"' : 'loading="lazy"'}>
        </div>
        <div class="stage-mid">
          <div class="tale-wrap">
            ${taleRow('ასაკი',   f.red.age,   f.blue.age)}
            ${taleRow('სიმაღლე', f.red.ht,    f.blue.ht)}
            ${taleRow('წონა',    f.red.wt,    f.blue.wt)}
            ${taleRow('წვდომი',  f.red.reach, f.blue.reach)}
          </div>
        </div>
        <div class="stage-img right">
          <img src="${f.blue.img || noImg}" alt="${f.blue.name}" decoding="async" width="323" height="235" ${i === 0 ? 'fetchpriority="high"' : 'loading="lazy"'}>
        </div>
      </div>
      <div class="picks-wrap">
        ${betting ? '<div class="picks-hint">აირჩიე ფავორიტი მებრძოლი</div>' : (isCompleted ? '<div class="picks-hint" style="color:var(--green)">დასრულდა</div>' : '<div class="picks-hint">ფსონები დაკეტილია</div>')}
        <div class="bout-picks">
          ${pickBtn('red',  f.red)}
          ${pickBtn('blue', f.blue)}
        </div>
      </div>
      ${betting && f.showDetails ? `<button class="more-btn" data-more="${i}">${open ? 'ნაკლები დეტალი ▲' : 'მეტი დეტალი ▾'}</button>` : ''}
      <div class="extra ${open && betting ? 'show' : ''}">
        <div class="extra-group">
          <div class="extra-title">აირჩიე მებრძოლი</div>
          <div class="fighter-pick">
            <button class="fp-btn red ${fr === 'red' ? 'on' : ''}"   data-fighter="${i}" data-fr="red">${f.red.name}</button>
            <button class="fp-btn blue ${fr === 'blue' ? 'on' : ''}" data-fighter="${i}" data-fr="blue">${f.blue.name}</button>
          </div>
        </div>
        <div class="extra-group center">
          <div class="extra-title">გამარჯვების მეთოდი</div>
          <div class="mkt-chips">${methodChips}</div>
        </div>
        <div class="extra-group center">
          <div class="extra-title">რომელ რაუნდში დასრულდება ბრძოლა</div>
          <div class="mkt-chips">${roundChips}</div>
        </div>
        ${p ? `<div class="combo-bar ${fcls}"><span>ჯამური კოეფიციენტი</span><span class="cv">${pickOdds(i).toFixed(2)}</span></div>` : ''}
      </div>
    </div>`;
  }).join('');

  document.querySelectorAll('[data-winner]').forEach(b  => b.onclick = () => setWinner(+b.dataset.winner, b.dataset.fr));
  document.querySelectorAll('[data-fighter]').forEach(b => b.onclick = () => setFighterDetail(+b.dataset.fighter, b.dataset.fr));
  document.querySelectorAll('[data-round]').forEach(b   => { if (!b.disabled) b.onclick = () => setRound(+b.dataset.round, +b.dataset.val); });
  document.querySelectorAll('[data-method]').forEach(b  => { if (!b.disabled) b.onclick = () => setMethod(+b.dataset.method, b.dataset.val); });
  document.querySelectorAll('[data-more]').forEach(b    => b.onclick = () => toggleDetail(+b.dataset.more));

  document.querySelectorAll('.stage-img img').forEach(img => {
    img.addEventListener('error', function onErr() {
      this.removeEventListener('error', onErr);
      this.src = noImg;
    });
  });
}

// ─────────────────────────────────────────────────────────────
//  SLIP
// ─────────────────────────────────────────────────────────────
function picksArr()  { return Object.keys(state.picks).map(i => +i).map(i => ({ i, ...state.picks[i], odds: pickOdds(i), name: selName(i), mk: selMk(i) })); }
function comboOdds() { return r2(picksArr().reduce((p, s) => p * s.odds, 1)); }
function setMode(m)  { state.mode = m; renderSlip(); }
function digits(inp) { const v = inp.value.replace(/[^0-9]/g, ''); inp.value = v; return +v || 0; }

function renderSlip() {
  const arr  = picksArr();
  document.getElementById('slipBadge').textContent = arr.length;
  document.getElementById('tabExpress').classList.toggle('on', state.mode === 'express');
  document.getElementById('tabSingle').classList.toggle('on',  state.mode === 'single');
  const body = document.getElementById('slipBody'), foot = document.getElementById('slipFoot');
  if (arr.length === 0) {
    body.innerHTML = '<div class="slip-empty">ბილეთი ცარიელია.<br>დააჭირე კოეფიციენტს ბრძოლების სიაში.</div>';
    foot.innerHTML = ''; return;
  }
  body.innerHTML = arr.map(s => `
    <div class="sel ${s.fighter || ''}">
      <div class="sel-top">
        <div>
          <div class="sel-name">${s.name}</div>
          <div class="sel-mk">${s.mk} · კოეფ. ${s.odds.toFixed(2)}</div>
        </div>
        <button class="sel-rm" data-rm="${s.i}" aria-label="წაშლა">&times;</button>
      </div>
      ${state.mode === 'single' ? `
        <div class="stake-row">
          <input class="stake-in" type="text" inputmode="numeric" placeholder="ფსონი (ქულა)" value="${s.stake || ''}" data-stake="${s.i}">
          <span class="sel-ret">მოგება: <b data-ret="${s.i}">${s.stake ? fmt(s.stake * s.odds) : '0'}</b></span>
        </div>` : ''}
    </div>`).join('');

  body.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => {
    delete state.picks[+b.dataset.rm]; refresh(); renderSlip();
  });
  body.querySelectorAll('[data-stake]').forEach(inp => inp.oninput = () => {
    const i = +inp.dataset.stake, v = digits(inp);
    if (state.picks[i]) state.picks[i].stake = v;
    const r = body.querySelector('[data-ret="' + i + '"]');
    if (r) r.textContent = fmt(v * pickOdds(i));
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
    const es = document.getElementById('expStake');
    if (es) es.oninput = () => { state.expressStake = digits(es); updateTotals(); };
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
    const es = document.getElementById('expStake');
    if (es) es.classList.toggle('over', over);
    if (win) win.textContent = fmt(n * co) + ' ქულა';
    if (err) err.style.display = over ? 'block' : 'none';
    pb.disabled = n <= 0 || over;
  } else {
    const ts = totalStakeSingle(), tr = picksArr().reduce((s, x) => s + (x.stake || 0) * x.odds, 0), over = ts > state.balance;
    const tot = document.getElementById('foTot');
    if (tot) { tot.textContent = fmt(ts) + ' ქულა'; tot.style.color = over ? 'var(--red-soft)' : ''; }
    if (win) win.textContent = fmt(tr) + ' ქულა';
    if (err) err.style.display = over ? 'block' : 'none';
    document.querySelectorAll('#slipBody .stake-in').forEach(x => x.classList.toggle('over', over));
    pb.disabled = ts <= 0 || over;
  }
}

// ─────────────────────────────────────────────────────────────
//  PLACE BETS
// ─────────────────────────────────────────────────────────────
async function placeBets() {
  if (!currentUser) { closeSlip(); openModal('join'); return; }
  if (isBettingClosed()) { closeSlip(); alert('ფსონების მიღება დასრულებულია'); return; }
  const arr = picksArr(); if (arr.length === 0) return;
  const eventId = window.__currentEventId || null;
  if (!eventId) { closeSlip(); alert('ივენთი ვერ მოიძებნა'); return; }

  if (state.mode === 'express') {
    const st = state.expressStake; if (st <= 0 || st > state.balance) return;
    const odds = comboOdds();
    const selections = arr.map(s => ({
      fight_id: FIGHTS[s.i]?._dbId,
      picked_fighter: s.fighter,
      picked_round: s.round || null,
      picked_method: s.method || null,
      odds: s.odds
    }));

    // place_bet RPC — server-side ლოგიკა (balance ვერ გაყალბდება)
    const { data: res, error } = await sb.rpc('place_bet', {
      p_event_id: eventId, p_type: 'express', p_stake: st, p_total_odds: odds, p_selections: selections
    });
    if (error || !res || !res.ok) {
      alert('ფსონი ვერ დაიდო: ' + (res?.error || error?.message || 'უცნობი შეცდომა'));
      return;
    }
    // ბალანსი server-დან
    updateBalance(res.balance);
    const finalOdds = res.total_odds != null ? Number(res.total_odds) : odds;
    const ticket = {
      _dbId: res.ticket_id, type: 'express',
      sels: arr.map(s => ({ i: s.i, fighter: s.fighter, round: s.round, method: s.method, odds: s.odds, name: s.name })),
      stake: st, odds: finalOdds, status: 'open', placedAt: Date.now()
    };
    state.tickets.unshift(ticket);
  } else {
    const ts = totalStakeSingle(); if (ts <= 0 || ts > state.balance) return;
    for (const s of arr) {
      if (s.stake > 0) {
        const selections = [{
          fight_id: FIGHTS[s.i]?._dbId,
          picked_fighter: s.fighter,
          picked_round: s.round || null,
          picked_method: s.method || null,
          odds: s.odds
        }];
        const { data: res, error } = await sb.rpc('place_bet', {
          p_event_id: eventId, p_type: 'single', p_stake: s.stake, p_total_odds: s.odds, p_selections: selections
        });
        if (error || !res || !res.ok) {
          alert('ფსონი ვერ დაიდო: ' + (res?.error || error?.message || 'უცნობი შეცდომა'));
          continue;
        }
        updateBalance(res.balance);
        const finalOdds = res.total_odds != null ? Number(res.total_odds) : s.odds;
        const ticket = {
          _dbId: res.ticket_id, type: 'single',
          sels: [{ i: s.i, fighter: s.fighter, round: s.round, method: s.method, odds: s.odds, name: s.name }],
          stake: s.stake, odds: finalOdds, status: 'open', placedAt: Date.now()
        };
        state.tickets.unshift(ticket);
      }
    }
  }

  state.picks = {}; state.expressStake = 0;
  closeSlip(); refresh(); renderSlip(); renderTickets();
}

// ─────────────────────────────────────────────────────────────
//  TICKETS
// ─────────────────────────────────────────────────────────────
function renderTickets() {
  const activeList  = $('activeTickets');
  const historyList = $('historyTickets');
  const singleList  = $('ticketsList');

  const activeTickets = state.tickets.filter(t => t.status === 'open');
  const historyTickets = state.tickets.filter(t => t.status === 'won' || t.status === 'lost').sort((a, b) => (b.placedAt || 0) - (a.placedAt || 0));

  const summaryEl = $('tkSummary');
  if (summaryEl) summaryEl.textContent = state.tickets.length + ' ბილეთი';
  const activeBadge = $('activeBadge');
  if (activeBadge) activeBadge.textContent = activeTickets.length;
  const historyBadge = $('historyBadge');
  if (historyBadge) historyBadge.textContent = historyTickets.length;

  const stLabel = { open: 'მიმდინარე', won: 'მოგებული', lost: 'წაგებული', cashout: 'ქეშაუთი', pending: 'მიმდინარე' };
  const cashoutOk = canCashout();

  // selection-ის შედეგი — DB res ან FIGHTS-დან გამოთვლა
  const selResult = (s) => {
    if (s.res === 'ok' || s.res === 'no') return s.res;
    // FIGHTS-დან ცოცხალი გამოთვლა — მხოლოდ დასრულებულ ბრძოლაზე
    const f = (s.i >= 0 && s.i < FIGHTS.length) ? FIGHTS[s.i] : null;
    if (!f || f.status !== 'completed' || !f.resultWinner) return null;
    return f.resultWinner === s.fighter ? 'ok' : 'no';
  };

  const renderTicketCard = (t) => {
    const realIdx = state.tickets.indexOf(t);
    const showCashout = t.status === 'open' && cashoutOk;
    const totalOdds = t.odds.toFixed(2);
    const potentialWin = Math.round(t.stake * t.odds);
    const isCollapsed = state.tkCollapsed[realIdx] !== false; // ნაგულისხმევად დაკეცილი
    const statusColor = t.status === 'won' ? 'var(--green)' : (t.status === 'lost' ? 'var(--red-soft)' : (t.status === 'cashout' ? 'var(--gold)' : '#ff9d3c'));

    // დაკეცილი ხედი — სტატუსი + 4 მაჩვენებელი ორ ხაზად
    const winColor = t.status === 'won' ? 'var(--green)' : t.status === 'lost' ? 'var(--red-soft)' : 'var(--gold)';
    const winText = t.status === 'won' ? '+' + fmt(potentialWin) : fmt(potentialWin);
    const collapsedView = `
      <div class="tk-collapsed-info">
        <div class="tkc-col"><span class="tkc-lbl">პოზიცია</span><span class="tkc-val">${t.sels.length}</span></div>
        <div class="tkc-col"><span class="tkc-lbl">ფსონი</span><span class="tkc-val">${fmt(t.stake)}</span></div>
        <div class="tkc-col"><span class="tkc-lbl">კოეფ.</span><span class="tkc-val">${totalOdds}</span></div>
        <div class="tkc-col"><span class="tkc-lbl">შესაძლო მოგება</span><span class="tkc-val" style="color:${winColor}">${winText}</span></div>
      </div>`;

    return `
    <div class="ticket tk-${t.status} ${isCollapsed ? 'collapsed' : ''}">
      <div class="tk-head" data-tktoggle="${realIdx}" style="cursor:pointer">
        <div class="tk-head-left">
          <span class="tk-status ${t.status}" style="color:${statusColor}">${stLabel[t.status] || t.status}</span>
          <span class="tk-type">${t.type === 'express' ? 'ექსპრესი · ' + t.sels.length + ' მოვლენა' : 'სინგლი'}</span>
        </div>
        <span class="tk-arrow ${isCollapsed ? '' : 'open'}">▾</span>
      </div>
      ${isCollapsed ? collapsedView : `
      <div class="tk-sels">
        ${t.sels.map(s => {
          const parts = s.name.split(' · ');
          const fighterPart = parts[0] || '';
          const extras = parts.slice(1).join(' · ');
          const fighterName = fighterPart.replace(' მოგება', '');
          const isRed = s.fighter === 'red';
          const f = (s.i >= 0 && s.i < FIGHTS.length) ? FIGHTS[s.i] : null;
          const redName = s.redName || (f ? f.red.name : '');
          const blueName = s.blueName || (f ? f.blue.name : '');
          const pickLabel = extras || 'გამარჯვებული';
          const res = selResult(s);
          // სუფთა შედეგი — span-ით, emoji-ს გარეშე
          const resCls = res === 'ok' ? 'ok' : res === 'no' ? 'no' : '';
          const resTxt = res === 'ok' ? '✓' : res === 'no' ? '✗' : '';

          return `<div class="tk-sel">
            <div class="tk-sel-main">
              <div class="tk-sel-fighters">
                <span class="tk-sel-dot red"></span>
                <span class="tk-sel-red">${redName || 'Red'}</span>
                <span class="tk-sel-vs">vs</span>
                <span class="tk-sel-blue">${blueName || 'Blue'}</span>
                <span class="tk-sel-dot blue"></span>
              </div>
              <div class="tk-sel-pick pick-${isRed ? 'red' : 'blue'}">${fighterName} — ${pickLabel}</div>
            </div>
            <div class="tk-sel-right">
              ${resTxt ? `<span class="tk-sel-result ${resCls}">${resTxt}</span>` : ''}
              <span class="tk-sel-odds">${s.odds.toFixed(2)}</span>
            </div>
          </div>`;
        }).join('')}
      </div>
      <div class="tk-foot">
        <span class="tk-foot-type">${t.type === 'express' ? 'ექსპრესი' : 'სინგლი'}</span>
        <span class="tk-foot-pay">
          ${t.status === 'won'
            ? '<span style="color:var(--green)">+' + fmt(potentialWin) + ' ქულა</span>'
            : t.status === 'lost'
            ? '<span style="color:var(--red-soft)">' + fmt(potentialWin) + ' ქულა</span>'
            : t.status === 'cashout'
            ? '<span style="color:var(--gold)">ქეშაუთი</span>'
            : '<span class="tk-foot-label">შეს. მოგება</span><span style="color:var(--gold)">' + fmt(potentialWin) + '</span>'}
        </span>
      </div>
      ${showCashout ? `<button class="cashout-btn" data-co="${realIdx}">${cashoutLabel(t)}</button>` : ''}
      `}
    </div>`;
  };

  if (activeList && historyList) {
    activeList.innerHTML = activeTickets.length === 0
      ? '<div class="tk-empty">აქტიური ბილეთი არ არის. აირჩიე კოეფიციენტი და დადე პირველი ფსონი.</div>'
      : activeTickets.map(renderTicketCard).join('');
    historyList.innerHTML = historyTickets.length === 0
      ? '<div class="tk-empty">ისტორია ცარიელია.</div>'
      : historyTickets.map(renderTicketCard).join('');
  } else if (singleList) {
    const all = [...activeTickets, ...historyTickets];
    singleList.innerHTML = all.length === 0
      ? '<div class="tk-empty">ბილეთი ჯერ არ გაქვს. აირჩიე კოეფიციენტი და დადე პირველი ფსონი.</div>'
      : all.map(renderTicketCard).join('');
  }

  document.querySelectorAll('[data-co]').forEach(b => b.onclick = (e) => { e.stopPropagation(); doCashout(+b.dataset.co); });
  document.querySelectorAll('[data-tktoggle]').forEach(b => b.onclick = () => {
    const idx = +b.dataset.tktoggle;
    state.tkCollapsed[idx] = state.tkCollapsed[idx] === false ? true : false;
    renderTickets();
  });
}

// ─────────────────────────────────────────────────────────────
//  BALANCE / BAR
// ─────────────────────────────────────────────────────────────
function updateBalance(val) {
  state.balance = val;
  document.getElementById('balNav').textContent = fmt(val);
}
function renderBar() {
  const n = picksArr().length;
  document.getElementById('bbCoef').textContent  = (n ? comboOdds() : 1).toFixed(2);
  document.getElementById('balNav').textContent  = fmt(state.balance);
  document.getElementById('bbCount').textContent = n;
  // betbar მხოლოდ მაშინ თუ picks არის და ფსონი ღიაა
  document.getElementById('betbar').classList.toggle('show', n > 0 && !isBettingClosed());
}

// ─────────────────────────────────────────────────────────────
//  LEADERBOARD
// ─────────────────────────────────────────────────────────────
const LEADERBOARD = [];
const AVATAR_ICONS = ['🥊','🏆','🔥','⚡','💪','🦁','🐺','👊','💎','🎯','⭐','🦅'];

function renderLeaderboard() {
  const fullSorted = LEADERBOARD.map((r, i) => ({ ...r, rank: i + 1 }));
  const meIdx = currentUser ? fullSorted.findIndex(r => r.id === currentUser.id) : -1;

  let display;
  if (meIdx >= 0 && meIdx < 10) {
    display = fullSorted.slice(0, 10);
  } else if (meIdx >= 10) {
    display = fullSorted.slice(0, 9).concat([fullSorted[meIdx]]);
  } else {
    display = fullSorted.slice(0, 10);
  }

  const lbRows = document.getElementById('lbRows');
  if (!lbRows) return;
  lbRows.innerHTML = display.map(r => {
    const you = currentUser && r.id === currentUser.id;
    const icon = r.icon || '🥊';
    const sign = r.pts > 0 ? '+' : '';
    return `<div class="lb-row ${you ? 'you' : ''}">
      <span class="lb-rank ${r.rank <= 3 ? 'top' : ''}">${r.rank}</span>
      <span class="lb-user">
        <span class="lb-ava-glove">${icon}</span>
        <span><span class="lb-name">${r.name}</span><br><span class="lb-tag">${you ? 'შენ' : ''}</span></span>
      </span>
      <span class="lb-roi"></span>
      <span class="lb-pts">${sign}${fmt(r.pts)}</span>
    </div>`;
  }).join('');

  renderLbFullButton(fullSorted);
}

function renderLbFullButton(fullSorted) {
  const lbWrap = document.querySelector('#leaderboard .lb');
  if (!lbWrap) return;
  let btn = document.getElementById('lbFullBtn');
  if (fullSorted.length > 10) {
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'lbFullBtn';
      btn.className = 'lb-full-btn';
      btn.textContent = 'სრულად';
      lbWrap.parentNode.appendChild(btn);
    }
    btn.onclick = () => openLbPopup(fullSorted);
    btn.style.display = 'block';
  } else if (btn) {
    btn.style.display = 'none';
  }
}

function openLbPopup(fullSorted) {
  const overlay = document.createElement('div');
  overlay.className = 'lb-popup-bg';
  const rowsHtml = fullSorted.map(r => {
    const you = currentUser && r.id === currentUser.id;
    const sign = r.pts > 0 ? '+' : '';
    return `<div class="lb-row ${you ? 'you' : ''}">
      <span class="lb-rank ${r.rank <= 3 ? 'top' : ''}">${r.rank}</span>
      <span class="lb-user">
        <span class="lb-ava-glove">${r.icon || '🥊'}</span>
        <span><span class="lb-name">${r.name}</span><br><span class="lb-tag">${you ? 'შენ' : ''}</span></span>
      </span>
      <span class="lb-pts">${sign}${fmt(r.pts)}</span>
    </div>`;
  }).join('');
  overlay.innerHTML = `
    <div class="lb-popup">
      <div class="lb-popup-head">
        <h3>სრული ლიდერბორდი</h3>
        <button class="x" id="lbPopupClose" aria-label="დახურვა">&times;</button>
      </div>
      <div class="lb-popup-body">${rowsHtml}</div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => document.body.removeChild(overlay);
  document.getElementById('lbPopupClose').onclick = close;
  overlay.onclick = e => { if (e.target === overlay) close(); };
}

// ─────────────────────────────────────────────────────────────
//  LOAD LEADERBOARD FROM DB — პერიოდის მიხედვით score_history-დან
// ─────────────────────────────────────────────────────────────
let _currentLbPeriod = 'goat';

// ms helper
function periodToMs(period) {
  const map = { '1m': 30*24*3600*1000, '3m': 90*24*3600*1000, '6m': 180*24*3600*1000, '1y': 365*24*3600*1000 };
  return map[period] || 30*24*3600*1000;
}

async function loadLeaderboard(period) {
  if (period) _currentLbPeriod = period;
  try {
    let rows;

    if (_currentLbPeriod === 'goat') {
      // G.O.A.T — users.score (ყველა დროის ჯამი)
      const { data, error } = await sb
        .from('leaderboard_view').select('id,nick,icon,score')
        .order('score', { ascending: false });
      if (error || !data) return;
      rows = data.map(u => ({
        id: u.id, name: u.nick || '—', pts: Number(u.score) || 0, icon: u.icon || '🥊'
      }));
    } else {
      // პერიოდი: score_history-დან ჯამი
      const since = new Date(Date.now() - periodToMs(_currentLbPeriod)).toISOString();

      // ჯერ score_history (created_at ფილტრით)
      let { data: hist, error: hErr } = await sb
        .from('score_history')
        .select('user_id, amount, created_at')
        .gte('created_at', since);

      // თუ created_at ფილტრმა ვერ იმუშავა, ყველა ავიღოთ
      if (hErr) {
        const r2 = await sb.from('score_history').select('user_id, amount, created_at');
        hist = r2.data; hErr = r2.error;
      }
      if (hErr || !hist) { LEADERBOARD.length = 0; renderLeaderboard(); renderLbTabs(); return; }

      // users ცალკე (nick + icon)
      const { data: usersData } = await sb.from('leaderboard_view').select('id,nick,icon');
      const userMap = {};
      (usersData || []).forEach(u => { userMap[u.id] = { nick: u.nick || '—', icon: u.icon || '🥊' }; });

      const map = {};
      hist.forEach(h => {
        const uid = h.user_id;
        if (!map[uid]) map[uid] = { id: uid, name: userMap[uid]?.nick || '—', icon: userMap[uid]?.icon || '🥊', pts: 0 };
        map[uid].pts += Number(h.amount) || 0;
      });
      rows = Object.values(map).filter(r => r.pts > 0).sort((a, b) => b.pts - a.pts);
    }

    LEADERBOARD.length = 0;
    rows.forEach(r => LEADERBOARD.push(r));
    renderLeaderboard();
    renderLbTabs();
  } catch (e) {
    console.warn('loadLeaderboard failed:', e);
  }
}

function renderLbTabs() {
  const tabs = document.getElementById('lbTabs');
  if (!tabs) return;
  const periods = [
    { key: '1m',   label: '1 თვე' },
    { key: '3m',   label: '3 თვე' },
    { key: '6m',   label: '6 თვე' },
    { key: '1y',   label: '1 წელი' },
    { key: 'goat', label: 'G.O.A.T' },
  ];
  tabs.innerHTML = periods.map(p => `
    <button class="lb-tab ${_currentLbPeriod === p.key ? 'on' : ''}" data-period="${p.key}">${p.label}</button>
  `).join('');
  tabs.querySelectorAll('.lb-tab').forEach(b => {
    b.onclick = () => loadLeaderboard(b.dataset.period);
  });
}

// ─────────────────────────────────────────────────────────────
//  TICKET SETTLEMENT — server-side only (bot / admin / auto.js)
//  client-side settlement ამოღებულია race condition-ის თავიდან
//  ასაცილებლად. settlement ხდება მხოლოდ:
//    1. GitHub Actions Cron (scripts/auto.js) — ყოველ 30 წუთში
//    2. Telegram ბოტი — "settlement" კომანდა
//    3. Admin პანელი — "settleAllTickets" ღილაკი
// ─────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────
//  LIVE RESULTS — ყოველ 2 წუთში DB-დან შედეგების წამოღება
// ─────────────────────────────────────────────────────────────
async function loadLiveResults() {
  const eventId = window.__currentEventId;
  if (!eventId) return;
  // ივენთ მიმდინარეობისას ან completed (ბილეთების ✅/❌ განახლებისთვის)
  const ed = window.__eventDate;
  const diffH = ed ? (Date.now() - ed.getTime()) / 3600000 : 0;
  if (ed && diffH < 0) return; // ივენთამდე — polling არ სჭირდება
  if (ed && diffH > 24) return; // 24 საათზე მეტი გავიდა — polling შეაჩერე
  try {
    const { data: fights } = await sb
      .from('fights')
      .select('id,status,result_winner,red:fighters!red_fighter_id(name),blue:fighters!blue_fighter_id(name)')
      .eq('event_id', eventId);
    if (!fights) return;
    let changed = false;
    fights.forEach(f => {
      const idx = FIGHTS.findIndex(x => x._dbId === f.id);
      if (idx < 0) return;
      // winner მხოლოდ დასრულებულ ბრძოლაზე
      let rw = null;
      if (f.status === 'completed' && f.result_winner) {
        rw = f.result_winner === f.red?.name ? 'red' : 'blue';
      }
      if (FIGHTS[idx].resultWinner !== rw || FIGHTS[idx].status !== f.status) {
        FIGHTS[idx].resultWinner = rw;
        FIGHTS[idx].status = f.status || 'upcoming';
        changed = true;
      }
    });
    if (changed) {
      renderMarkets();
      // ბილეთების ✅/❌ და სტატუსი განახლება (settlement server-side-ით)
      if (currentUser) {
        try { await loadUserTickets(); renderTickets(); } catch(e) {}
      }
      await loadLeaderboard();
    }
  } catch(e) { console.warn('loadLiveResults failed:', e); }
}

// ─────────────────────────────────────────────────────────────
//  LOAD USER TICKETS FROM DB
// ─────────────────────────────────────────────────────────────
async function loadUserTickets() {
  if (!currentUser) return;
  try {
    let q = sb.from('tickets')
      .select(`id,type,stake,total_odds,status,placed_at,ticket_selections(fight_id,picked_fighter,picked_round,picked_method,odds,result,fight:fights!fight_id(id,status,result_winner,red:fighters!red_fighter_id(name),blue:fighters!blue_fighter_id(name)))`)
      .eq('user_id', currentUser.id)
      .order('placed_at', { ascending: false });

    // ყველა ბილეთი — არ გავფილტროთ event_id-ით
    // (ისტორიაში სხვა ივენთების ბილეთებიც ჩანდეს)

    const { data: rows, error } = await q;
    if (error || !rows) return;

    const statusMap = { pending: 'open', open: 'open', won: 'won', lost: 'lost', cashout: 'cashout' };
    state.tickets = rows.map(tk => ({
      _dbId: tk.id,
      type: tk.type,
      sels: (tk.ticket_selections || []).map(s => {
        const i = FIGHTS.findIndex(f => f._dbId === s.fight_id);
        // მებრძოლების სახელები პირდაპირ DB-დან (ისტორიული ბილეთებისთვისაც)
        const ffight = s.fight || null;
        const redName = ffight?.red?.name || '';
        const blueName = ffight?.blue?.name || '';
        const fighterName = s.picked_fighter === 'red' ? redName : blueName;
        // res — DB-ში ან fight-ის შედეგიდან გამოთვლა
        let res = s.result || null;
        if (!res && ffight && ffight.status === 'completed' && ffight.result_winner) {
          const winSide = ffight.result_winner === redName ? 'red' : 'blue';
          res = s.picked_fighter === winSide ? 'ok' : 'no';
        }
        return {
          i,
          fighter: s.picked_fighter,
          round: s.picked_round,
          method: s.picked_method,
          odds: Number(s.odds),
          name: rebuildSelNameDB(fighterName, s),
          redName, blueName,
          res
        };
      }),
      stake: Number(tk.stake),
      odds: Number(tk.total_odds),
      status: statusMap[tk.status] || tk.status,
      placedAt: tk.placed_at ? new Date(tk.placed_at).getTime() : Date.now()
    }));
  } catch (e) {
    console.warn('loadUserTickets failed:', e);
  }
}

// მებრძოლის სახელი + extras (DB-დან წამოღებული სახელით)
function rebuildSelNameDB(fighterName, s) {
  const a = [];
  if (fighterName) a.push(fighterName + ' მოგება');
  else if (s.picked_fighter) a.push((s.picked_fighter === 'red' ? 'Red' : 'Blue') + ' მოგება');
  if (s.picked_round)  a.push(s.picked_round + '-ე რაუნდი');
  if (s.picked_method) a.push(s.picked_method);
  return a.join(' · ') || '—';
}

// ─────────────────────────────────────────────────────────────
//  SLIP OPEN / CLOSE
// ─────────────────────────────────────────────────────────────
function openSlip()  { document.getElementById('slipBg').classList.add('show'); document.getElementById('slip').classList.add('show'); }
function closeSlip() { document.getElementById('slipBg').classList.remove('show'); document.getElementById('slip').classList.remove('show'); }

// ─────────────────────────────────────────────────────────────
//  COUNTDOWN
// ─────────────────────────────────────────────────────────────
let eventDate = new Date(Date.now() + 9 * 864e5); eventDate.setHours(22, 0, 0, 0);
const EN_MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
document.getElementById('eventDate').textContent = '· ' + EN_MONTHS[eventDate.getMonth()] + ' ' + eventDate.getDate();
const cd_d = document.getElementById('cd-d'), cd_h = document.getElementById('cd-h'),
      cd_m = document.getElementById('cd-m'), cd_s = document.getElementById('cd-s');
function tick() {
  const ed = window.__eventDate || eventDate;
  const diff = ed - Date.now(); if (diff <= 0) { cd_d.textContent = "--"; cd_h.textContent = "--"; cd_m.textContent = "--"; cd_s.textContent = "--"; return; }
  const d = Math.floor(diff / 864e5), h = Math.floor(diff % 864e5 / 36e5),
        m = Math.floor(diff % 36e5 / 6e4), s = Math.floor(diff % 6e4 / 1e3);
  const p = n => String(n).padStart(2, '0');
  cd_d.textContent = p(d); cd_h.textContent = p(h); cd_m.textContent = p(m); cd_s.textContent = p(s);
}
tick(); setInterval(tick, 1000);

// ─────────────────────────────────────────────────────────────
//  AUTH
// ─────────────────────────────────────────────────────────────
const modal = document.getElementById('modal');
let modalMode = 'join';

function authError(msg) {
  const el = document.getElementById('authError');
  if (el) { el.textContent = msg; el.style.display = msg ? 'block' : 'none'; }
}

function openModal(mode) {
  modalMode = mode; authError('');
  const authErrEl = document.getElementById('authError'); if (authErrEl) authErrEl.style.color = 'var(--red)';
  const passEl = document.getElementById('inPass'); if (passEl) passEl.value = '';
  document.getElementById('modalTitle').textContent  = mode === 'join' ? 'შემოუერთდი ლიგას' : 'კეთილი იყოს დაბრუნება';
  document.getElementById('modalSub').textContent    = mode === 'join' ? ' ' : ' ';
  document.getElementById('nameField').style.display = mode === 'join' ? 'block' : 'none';
  document.getElementById('confirmField').style.display = mode === 'join' ? 'block' : 'none';
  const passHintEl = document.getElementById('passHint');
  if (passHintEl) passHintEl.style.display = mode === 'join' ? 'block' : 'none';
  document.getElementById('modalSubmit').textContent = mode === 'join' ? 'რეგისტრაცია' : 'შესვლა';
  document.getElementById('modalSwitch').innerHTML   = mode === 'join'
    ? 'უკვე გაქვს ანგარიში? <button id="switchMode">შესვლა</button>'
    : 'ახალი ხარ აქ? <button id="switchMode">რეგისტრაცია</button>';
  document.getElementById('switchMode').onclick = () => openModal(mode === 'join' ? 'signin' : 'join');
  const forgotWrap = $('forgotWrap');
  if (forgotWrap) forgotWrap.style.display = mode === 'signin' ? 'block' : 'none';
  modal.classList.add('show');
}
function closeModal() { modal.classList.remove('show'); authError(''); }


// ─────────────────────────────────────────────────────────────
//  SEC-HEAD VISIBILITY — სათაურის დამალვა
// ─────────────────────────────────────────────────────────────
function updateSecHead() {
  const secHead = document.querySelector('#card .sec-head');
  if (!secHead) return;
  // სტუმარს ან ივენთ მიმდინარეობისას — დამალე
  if (!currentUser || isEventInProgress()) {
    secHead.style.display = 'none';
  } else {
    secHead.style.display = '';
  }
}

// ─────────────────────────────────────────────────────────────
//  NAV UPDATE
// ─────────────────────────────────────────────────────────────
function updateNavForUser(user) {
  const joinBtn     = document.getElementById('joinBtn');
  const signinBtn   = document.getElementById('signinBtn');
  const balancePill = document.querySelector('.balance-pill');
  let navUser       = document.getElementById('navUser');
  const pg = document.getElementById('prizeGuide'); if (pg) pg.style.display = user ? 'none' : 'block';

  if (user) {
    if (joinBtn)   joinBtn.style.display = 'none';
    if (signinBtn) signinBtn.style.display = 'none';

    if (!navUser) {
      navUser = document.createElement('div');
      navUser.id = 'navUser'; navUser.className = 'nav-user';
      navUser.innerHTML = `
        <span class="nav-ava">${user.icon || '🥊'}</span>
        <span class="nav-nick">${user.nick}</span>
        <div class="nav-dropdown" id="navDropdown">
          <button class="nav-dd-item" id="ddProfile">პროფილი</button>
          <button class="nav-dd-item danger" id="ddLogout">გამოსვლა</button>
        </div>`;
      if (joinBtn && joinBtn.parentNode) joinBtn.parentNode.insertBefore(navUser, joinBtn);
      navUser.onclick = (e) => {
        if (e.target.closest('.nav-dropdown')) return;
        document.getElementById('navDropdown').classList.toggle('show');
      };
      document.getElementById('ddProfile').onclick = () => { document.getElementById('navDropdown').classList.remove('show'); openProfile(); };
      document.getElementById('ddLogout').onclick  = () => { document.getElementById('navDropdown').classList.remove('show'); doLogout(); };
    } else {
      navUser.querySelector('.nav-nick').textContent = user.nick;
      navUser.querySelector('.nav-ava').textContent  = user.icon || '🥊';
    }

    navUser.style.display = 'flex';
    if (balancePill) balancePill.classList.add('visible');

    const navProfile = document.getElementById('navProfile');
    const navLogout  = document.getElementById('navLogout');
    if (navProfile) navProfile.style.display = 'none';
    if (navLogout)  navLogout.style.display  = 'none';

    addMobileMenuLinks();
    updateBalance(user.balance || 1000);
    updateSecHead();
  } else {
    if (joinBtn)   joinBtn.style.display = '';
    if (signinBtn) signinBtn.style.display = '';
    if (navUser)   navUser.style.display = 'none';
    if (balancePill) balancePill.classList.remove('visible');

    const navProfile = document.getElementById('navProfile');
    const navLogout  = document.getElementById('navLogout');
    if (navProfile) navProfile.style.display = 'none';
    if (navLogout)  navLogout.style.display  = 'none';

    removeMobileMenuLinks();
    updateBalance(1000);
  }
}

function addMobileMenuLinks() {
  const navLinks = document.getElementById('navLinks');
  if (!navLinks) return;
  if (!document.getElementById('mProfile')) {
    const p = document.createElement('a');
    p.href = '#'; p.id = 'mProfile'; p.className = 'nav-mobile-only';
    p.textContent = 'პროფილი';
    p.onclick = (e) => { e.preventDefault(); navLinks.classList.remove('open'); openProfile(); };
    navLinks.insertBefore(p, navLinks.firstChild);
  }
  if (!document.getElementById('mLogout')) {
    const l = document.createElement('a');
    l.href = '#'; l.id = 'mLogout'; l.className = 'nav-mobile-only danger';
    l.textContent = 'გამოსვლა';
    l.onclick = (e) => { e.preventDefault(); navLinks.classList.remove('open'); doLogout(); };
    navLinks.appendChild(l);
  }
}

function removeMobileMenuLinks() {
  const p = document.getElementById('mProfile'); if (p) p.remove();
  const l = document.getElementById('mLogout'); if (l) l.remove();
}

document.addEventListener('click', e => {
  const dd = document.getElementById('navDropdown');
  if (dd && !e.target.closest('.nav-user')) dd.classList.remove('show');
});

async function doRegister() {
  const nick  = (document.getElementById('inName').value  || '').trim();
  const email = (document.getElementById('inEmail').value || '').trim();
  const pass  = document.getElementById('inPass').value   || '';
  const passConfirm = document.getElementById('inPassConfirm').value || '';
  if (!nick || !/^[a-zA-Z0-9_]{3,20}$/.test(nick)) { authError('სახელი: 3-20 ლათინური სიმბოლო (a-z, 0-9, _)'); return; }
  if (!email) { authError('შეიყვანე ელ. ფოსტა'); return; }
  if (pass.length < 6) { authError('პაროლი მინ. 6 სიმბოლო'); return; }
  if (!/[A-Z]/.test(pass)) { authError('პაროლში მინ. 1 დიდი ასო (A-Z)'); return; }
  if (!/[a-z]/.test(pass)) { authError('პაროლში მინ. 1 პატარა ასო (a-z)'); return; }
  if (!/[0-9]/.test(pass)) { authError('პაროლში მინ. 1 ციფრი (0-9)'); return; }
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/.test(pass)) { authError('პაროლში მინ. 1 სიმბოლო (!@#$%...)'); return; }
  if (pass !== passConfirm) { authError('პაროლები არ ემთხვევა'); return; }
  const btn = document.getElementById('modalSubmit'); btn.textContent = '…'; btn.disabled = true;
  const { data, error } = await sb.auth.signUp({ email, password: pass, options: { data: { nick } } });
  btn.disabled = false; btn.textContent = 'რეგისტრაცია';
  if (error) { authError(error.message); return; }

  // თუ Confirm Email ჩართულია პროექტში, signUp სესიას არ აბრუნებს,
  // სანამ მომხმარებელი მეილში ბმულზე არ დააჭერს — ამ დროს currentUser-ის
  // გამოგონება (ნაცვლად namely null session-ის პატივისცემისა) მომხმარებელს
  // "თითქოს შესულს" უჩვენებდა ისე, რომ რეალური auth session არ ჰქონდა,
  // რის გამოც ნებისმიერი RPC (place_bet და სხვ.) "not authenticated"-ით ჩაიშლებოდა.
  if (!data.session) {
    const el = document.getElementById('authError');
    el.style.color = 'var(--green)';
    el.textContent = 'რეგისტრაცია წარმატებულია! ანგარიშის გასააქტიურებლად დაადასტურე ელ.ფოსტა — შეამოწმე საფოსტო ყუთი (ასევე spam/junk).';
    el.style.display = 'block';
    return;
  }

  await new Promise(r => setTimeout(r, 1000));
  const { data: ud } = await sb.from('users').select('*').eq('id', data.user.id).single();
  currentUser = { id: data.user.id, email, nick: ud?.nick || nick, balance: ud?.balance || 1000, score: Number(ud?.score) || 0, icon: ud?.icon || '🥊' };
  closeModal(); updateNavForUser(currentUser);
}

async function doSignIn() {
  const email = (document.getElementById('inEmail').value || '').trim();
  const pass  = document.getElementById('inPass').value   || '';
  if (!email || !pass) { authError('შეიყვანე ელ. ფოსტა და პაროლი'); return; }
  const btn = document.getElementById('modalSubmit'); btn.textContent = '…'; btn.disabled = true;
  const { data, error } = await sb.auth.signInWithPassword({ email, password: pass });
  btn.disabled = false; btn.textContent = 'შესვლა';
  if (error) { authError('არასწორი მეილი ან პაროლი'); return; }
  const { data: ud } = await sb.from('users').select('*').eq('id', data.user.id).single();
  currentUser = { id: data.user.id, email, nick: ud?.nick || email, balance: ud?.balance || 1000, score: Number(ud?.score) || 0, icon: ud?.icon || '🥊' };
  closeModal(); updateNavForUser(currentUser);
}

async function doLogout() {
  await sb.auth.signOut(); currentUser = null; updateNavForUser(null);
}

async function handleGoogleAuth() {
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin + window.location.pathname }
  });
  if (error) console.warn(error.message);
}

// ─────────────────────────────────────────────────────────────
//  INIT — მებრძოლები ცალკე, ავტორიზაცია ცალკე
// ─────────────────────────────────────────────────────────────
let _fightsLoaded = false;

let _resolveFights;
const _fightsReady = new Promise(res => { _resolveFights = res; });

async function loadFightsAndRender() {
  if (_fightsLoaded) return;
  _fightsLoaded = true;
  try {
    await loadEventFromDB();
  } catch (e) {
    console.warn('loadEventFromDB failed:', e);
  }
  renderMarkets();
  renderSlip();
  renderBar();
  updateNavForUser(currentUser);
  try { await loadLeaderboard(); } catch (e) { console.warn('loadLeaderboard failed:', e); }

  _resolveFights();

  if (currentUser) {
    try { await loadUserTickets(); } catch (e) { console.warn('loadUserTickets failed:', e); }
  }
  renderTickets();

  // ცოცხალი შედეგები — ყოველ 2 წუთში (ივენთ მიმდინარეობისას + completed 24სთ)
  loadLiveResults();
  setInterval(loadLiveResults, 2 * 60 * 1000);

  // sec-head სათაური: სტუმარს და ივენთ მიმდინარეობისას დამალე
  updateSecHead();
}

async function applySession(session) {
  if (!session || currentUser) return;
  try {
    const { data: ud } = await sb.from('users').select('*').eq('id', session.user.id).single();
    if (ud) {
      currentUser = {
        id: session.user.id,
        email: session.user.email,
        nick: ud.nick,
        balance: ud.balance || 1000,
        score: Number(ud.score) || 0,
        icon: ud.icon || '🥊'
      };
      updateNavForUser(currentUser);
      await _fightsReady;
      try { await loadUserTickets(); } catch (e) { console.warn('loadUserTickets failed:', e); }
      renderTickets();
      renderLeaderboard();
      updateSecHead();
    }
  } catch (e) {
    console.warn('applySession failed:', e);
  }
}

sb.auth.onAuthStateChange((event, session) => {
  setTimeout(() => {
    if (event === 'SIGNED_OUT') {
      currentUser = null;
      state.tickets = [];
      renderTickets();
      updateNavForUser(null);
    } else {
      applySession(session);
      if (event === 'PASSWORD_RECOVERY') openResetPasswordModal();
    }
  }, 0);
});

// ─────────────────────────────────────────────────────────────
//  PROFILE MODAL
// ─────────────────────────────────────────────────────────────
function openProfile() {
  if (!currentUser) return;
  const pm = document.getElementById('profileModal');
  document.getElementById('profNick').value = currentUser.nick || '';
  document.getElementById('profEmail').value = currentUser.email || '';
  document.getElementById('profOldPass').value = '';
  document.getElementById('profNewPass').value = '';
  profileMsg('', '');

  const picker = document.getElementById('iconPicker');
  picker.innerHTML = AVATAR_ICONS.map(ic =>
    `<button class="icon-opt ${(currentUser.icon || '🥊') === ic ? 'active' : ''}" data-icon="${ic}">${ic}</button>`
  ).join('');
  picker.querySelectorAll('.icon-opt').forEach(b => b.onclick = () => {
    picker.querySelectorAll('.icon-opt').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
  });

  pm.classList.add('show');
  loadVerificationStatus();
}

function closeProfile() {
  document.getElementById('profileModal').classList.remove('show');
}

// ─────────────────────────────────────────────────────────────
//  ID VERIFICATION — selfie + პირადობის მოწმობის ატვირთვა
// ─────────────────────────────────────────────────────────────
let verifSelectedFile = null;

async function loadVerificationStatus() {
  const statusEl = document.getElementById('verifStatus');
  const wrap = document.getElementById('verifUploadWrap');
  verifSelectedFile = null;
  document.getElementById('verifPreview').style.display = 'none';
  document.getElementById('verifSubmitBtn').style.display = 'none';
  document.getElementById('verifPhotoInput').value = '';

  const { data: rows, error } = await sb.from('verifications')
    .select('status,admin_note,submitted_at')
    .eq('user_id', currentUser.id)
    .order('submitted_at', { ascending: false })
    .limit(1);

  // თუ verifications ცხრილი არ არსებობს (v6 SQL ჯერ არ გაშვებული) — სექცია ჩუმად
  // დაიმალოს, არ დააფუჭოს profile modal
  if (error) {
    const profSection = document.querySelector('#verifStatus')?.closest('.profile-section');
    if (profSection) profSection.style.display = 'none';
    return;
  }

  const last = rows && rows[0];

  if (!last) {
    statusEl.textContent = '';
    wrap.style.display = 'block';
    return;
  }

  if (last.status === 'pending') {
    statusEl.textContent = '⏳ შენი ვერიფიკაცია განხილვის პროცესშია — ჩვეულებრივ 24 საათში მოგივა პასუხი.';
    statusEl.style.color = 'var(--gold)';
    wrap.style.display = 'none';
  } else if (last.status === 'approved') {
    statusEl.textContent = '✅ ვერიფიცირებული ხარ — პრიზის მიღება შესაძლებელია.';
    statusEl.style.color = 'var(--green)';
    wrap.style.display = 'none';
  } else if (last.status === 'rejected') {
    statusEl.textContent = '❌ წინა მცდელობა უარყოფილია' + (last.admin_note ? (': ' + last.admin_note) : '') + ' — სცადე ხელახლა, უფრო გარკვევით ფოტოთი.';
    statusEl.style.color = 'var(--red)';
    wrap.style.display = 'block';
  }
}

function pickVerificationPhoto() {
  document.getElementById('verifPhotoInput').click();
}

function onVerificationFileSelected() {
  const input = document.getElementById('verifPhotoInput');
  const file = input.files && input.files[0];
  if (!file) return;

  if (file.size > 8 * 1024 * 1024) {
    alert('ფაილი ძალიან დიდია (მაქს. 8MB)');
    input.value = '';
    return;
  }
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    alert('მხოლოდ JPG/PNG/WEBP ფორმატია დაშვებული');
    input.value = '';
    return;
  }

  verifSelectedFile = file;
  const preview = document.getElementById('verifPreview');
  preview.src = URL.createObjectURL(file);
  preview.style.display = 'block';
  document.getElementById('verifSubmitBtn').style.display = 'block';
}

async function submitVerificationPhoto() {
  if (!verifSelectedFile || !currentUser) return;
  const btn = document.getElementById('verifSubmitBtn');
  btn.disabled = true; btn.textContent = 'იტვირთება...';

  const ext = (verifSelectedFile.name.split('.').pop() || 'jpg').toLowerCase();
  const path = `${currentUser.id}/${Date.now()}.${ext}`;

  const { error: upErr } = await sb.storage.from('id-verification').upload(path, verifSelectedFile, {
    contentType: verifSelectedFile.type,
    upsert: false
  });

  if (upErr) {
    btn.disabled = false; btn.textContent = 'ვერიფიკაციის გაგზავნა';
    alert('ატვირთვა ვერ მოხერხდა: ' + upErr.message);
    return;
  }

  const { error: insErr } = await sb.from('verifications').insert({
    user_id: currentUser.id,
    photo_path: path,
    status: 'pending'
  });

  btn.disabled = false; btn.textContent = 'ვერიფიკაციის გაგზავნა';

  if (insErr) {
    alert('ვერიფიკაციის გაგზავნა ვერ მოხერხდა: ' + insErr.message);
    return;
  }

  await loadVerificationStatus();
}

$on('verifPickBtn', 'click', pickVerificationPhoto);
$on('verifPhotoInput', 'change', onVerificationFileSelected);
$on('verifSubmitBtn', 'click', submitVerificationPhoto);

function profileMsg(msg, color) {
  const el = document.getElementById('profileMsg');
  if (msg) { el.textContent = msg; el.style.color = color || 'var(--green)'; el.style.display = 'block'; }
  else { el.style.display = 'none'; }
}

async function saveProfile() {
  if (!currentUser) return;
  const nick = (document.getElementById('profNick').value || '').trim();
  const email = (document.getElementById('profEmail').value || '').trim();
  const oldPass = document.getElementById('profOldPass').value || '';
  const newPass = document.getElementById('profNewPass').value || '';
  const selectedIcon = document.querySelector('#iconPicker .icon-opt.active');
  const icon = selectedIcon ? selectedIcon.dataset.icon : currentUser.icon || '🥊';

  if (nick && !/^[a-zA-Z0-9_]{3,20}$/.test(nick)) { profileMsg('სახელი: 3-20 ლათინური სიმბოლო (a-z, 0-9, _)', 'var(--red)'); return; }

  try {
    const nickChanged = nick && nick !== currentUser.nick;
    if (nickChanged) {
      // v8 SQL გაუშვია → RPC მუშაობს. თუ არა → fallback leaderboard_view-ზე
      let taken = false;
      const rpcRes = await sb.rpc('is_nick_taken', {
        p_nick: nick, p_exclude_user_id: currentUser.id
      });
      if (rpcRes.error) {
        const { data: fb } = await sb.from('leaderboard_view')
          .select('id').eq('nick', nick).neq('id', currentUser.id).maybeSingle();
        taken = !!fb;
      } else {
        taken = !!rpcRes.data;
      }
      if (taken) {
        profileMsg('ასეთი ზედმეტსახელი უკვე არსებობს', 'var(--red)');
        return;
      }
    }

    if (nickChanged || icon !== currentUser.icon) {
      const { error: updErr } = await sb.from('users').update({ nick: nick || currentUser.nick, icon }).eq('id', currentUser.id);
      if (updErr) {
        if (String(updErr.message || '').toLowerCase().includes('duplicate') || updErr.code === '23505') {
          profileMsg('ასეთი ზედმეტსახელი უკვე არსებობს', 'var(--red)');
        } else {
          profileMsg('შენახვა ვერ მოხერხდა: ' + updErr.message, 'var(--red)');
        }
        return;
      }
      if (nickChanged) currentUser.nick = nick;
      currentUser.icon = icon;
    }

    if (email && email !== currentUser.email) {
      const { error } = await sb.auth.updateUser({ email });
      if (error) { profileMsg('მეილის შეცვლა ვერ მოხერხდა: ' + error.message, 'var(--red)'); return; }
      currentUser.email = email;
    }

    if (newPass) {
      if (newPass.length < 6) { profileMsg('ახალი პაროლი მინ. 6 სიმბოლო', 'var(--red)'); return; }
      if (!oldPass) { profileMsg('შეიყვანე ძველი პაროლი', 'var(--red)'); return; }
      const { error: signErr } = await sb.auth.signInWithPassword({ email: currentUser.email, password: oldPass });
      if (signErr) {
        profileMsg('ძველი პაროლი არასწორია', 'var(--red)');
        document.getElementById('profOldPass').value = '';
        document.getElementById('profNewPass').value = '';
        return;
      }
      const { error: upErr } = await sb.auth.updateUser({ password: newPass });
      if (upErr) { profileMsg('პაროლის შეცვლა ვერ მოხერხდა', 'var(--red)'); return; }
    }

    updateNavForUser(currentUser);
    renderLeaderboard();
    profileMsg('წარმატებით შეინახა!', 'var(--green)');
  } catch (e) {
    profileMsg('შეცდომა: ' + e.message, 'var(--red)');
  }
}

// ─────────────────────────────────────────────────────────────
//  FORGOT PASSWORD
// ─────────────────────────────────────────────────────────────
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

function closeForgotModal() {
  document.getElementById('forgotModal').classList.remove('show');
}

// ─────────────────────────────────────────────────────────────
//  PASSWORD RECOVERY — მეილის ბმულზე დაჭერის შემდეგ
//  (Supabase თვითონ ავტორიზებს ამ სესიას — ძველი პაროლი აქ არ სჭირდება)
// ─────────────────────────────────────────────────────────────
function openResetPasswordModal() {
  closeModal();
  closeForgotModal();
  document.getElementById('recoveryNewPass').value = '';
  document.getElementById('recoveryNewPassConfirm').value = '';
  document.getElementById('recoveryError').style.display = 'none';
  document.getElementById('recoverySuccess').style.display = 'none';
  document.querySelectorAll('#resetPasswordModal .field').forEach(f => f.style.display = 'block');
  document.getElementById('recoverySubmit').style.display = 'block';
  document.getElementById('resetPasswordModal').classList.add('show');
}

async function submitNewPassword() {
  const p1 = document.getElementById('recoveryNewPass').value;
  const p2 = document.getElementById('recoveryNewPassConfirm').value;
  const errEl = document.getElementById('recoveryError');
  errEl.style.display = 'none';

  if (!p1 || p1.length < 6) { errEl.textContent = 'პაროლი მინ. 6 სიმბოლო'; errEl.style.display = 'block'; return; }
  if (p1 !== p2) { errEl.textContent = 'პაროლები არ ემთხვევა'; errEl.style.display = 'block'; return; }

  const btn = document.getElementById('recoverySubmit');
  btn.disabled = true; btn.textContent = '…';
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

  const btn = document.getElementById('forgotSubmit');
  btn.textContent = '…'; btn.disabled = true;

  const { error } = await sb.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + window.location.pathname
  });

  btn.disabled = false; btn.textContent = 'გამოგზავნა';

  if (error) {
    errEl.textContent = error.message; errEl.style.display = 'block'; return;
  }

  document.querySelector('#forgotModal .field').style.display = 'none';
  document.getElementById('forgotSubmit').style.display = 'none';
  document.getElementById('forgotSuccess').style.display = 'block';
  errEl.style.display = 'none';
}

// ─────────────────────────────────────────────────────────────
//  TOGGLE PASSWORD VISIBILITY
// ─────────────────────────────────────────────────────────────
function toggleEye(inputId) {
  const inp = document.getElementById(inputId);
  if (!inp) return;
  const isPass = inp.type === 'password';
  inp.type = isPass ? 'text' : 'password';
  const btn = inp.parentElement.querySelector('.eye-toggle');
  if (btn) btn.innerHTML = isPass
    ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>'
    : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
}

// ─────────────────────────────────────────────────────────────
//  EVENT LISTENERS
// ─────────────────────────────────────────────────────────────
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

$on('activeToggle', 'click', () => {
  const act = $('activeTickets');
  const arrow = $('activeArrow');
  if (!act) return;
  const isOpen = act.style.display !== 'none';
  act.style.display = isOpen ? 'none' : 'flex';
  if (arrow) arrow.classList.toggle('open', !isOpen);
});
$on('historyToggle', 'click', () => {
  const hist = $('historyTickets');
  const arrow = $('historyArrow');
  if (!hist) return;
  const isOpen = hist.style.display !== 'none';
  hist.style.display = isOpen ? 'none' : 'flex';
  if (arrow) arrow.classList.toggle('open', !isOpen);
});

document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeModal(); closeSlip(); closeForgotModal(); closeProfile(); } });

const navLinks = $('navLinks');
$on('menuBtn', 'click', () => { if (navLinks) navLinks.classList.toggle('open'); });
document.querySelectorAll('a[href^="#"]').forEach(a => a.addEventListener('click', e => {
  const id = a.getAttribute('href').slice(1); const t = document.getElementById(id);
  if (t) { e.preventDefault(); t.scrollIntoView({ behavior: 'smooth', block: 'start' }); if (navLinks) navLinks.classList.remove('open'); }
}));

// ─────────────────────────────────────────────────────────────
//  INIT
// ─────────────────────────────────────────────────────────────
const loadingEl = document.getElementById('markets');
if (loadingEl) loadingEl.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted)">იტვირთება ბრძოლები…</div>';

try {
  const hasSession = Object.keys(localStorage).some(k => k.startsWith('sb-') && k.endsWith('-auth-token'));
  if (hasSession) {
    const jb = document.getElementById('joinBtn');
    const sb2 = document.getElementById('signinBtn');
    if (jb) jb.style.display = 'none';
    if (sb2) sb2.style.display = 'none';
  }
} catch (e) {}

setTimeout(loadFightsAndRender, 0);
