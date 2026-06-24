// ============================================================
//  UFC Fantasy — app.js
// ============================================================

const SUPABASE_URL = "https://qxfcwsiysnjxhxljqigl.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF4ZmN3c2l5c25qeGh4bGpxaWdsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxODM4MDUsImV4cCI6MjA5Nzc1OTgwNX0.SOeTrxnKulgO8ao8HSwxyKE-m9pvaQ54Pa_IGWWyKDc";
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// ── helpers ───────────────────────────────────────────────────
const r2  = x => Math.round(x * 100) / 100;
const fmt = n => Math.round(n).toLocaleString('en-US');
const METHODS = ['ნოკაუტი', 'მტკივნეული', 'გადაწყვეტილება'];

// ── global state ──────────────────────────────────────────────
let FIGHTS = [];
const START = 1000;
const state = {
  balance: START, score: 0,
  picks: {}, mode: 'express', expressStake: 0,
  tickets: [], user: null, openDetail: {}
};
let currentUser = null;

// ─────────────────────────────────────────────────────────────
//  BETTING RULES
// ─────────────────────────────────────────────────────────────

// ბეთინგი იხურება ივენთამდე 10 წუთით ადრე
function isBettingClosed() {
  const ed = window.__eventDate;
  if (!ed) return false;
  return (ed - Date.now()) < 10 * 60 * 1000;
}

// ქეშაუთი შეიძლება ივენთამდე 1 საათზე მეტი რომ დარჩეს
function canCashout() {
  const ed = window.__eventDate;
  if (!ed) return true;
  return (ed - Date.now()) > 60 * 60 * 1000;
}

// 1 სთ-მდე — სრული თანხა, შემდეგ — 80%
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
  t.status = 'cashout';
  state.balance += amt;
  updateBalance(state.balance);
  if (currentUser) {
    await sb.from('users').update({ balance: state.balance }).eq('id', currentUser.id);
    // DB-შიც განაახლე ბილეთის სტატუსი
    if (t._dbId) {
      await sb.from('tickets').update({ status: 'cashout' }).eq('id', t._dbId);
    }
  }
  renderTickets();
}

// ─────────────────────────────────────────────────────────────
//  DB LOAD
// ─────────────────────────────────────────────────────────────
async function loadEventFromDB() {
  const { data: events, error: eErr } = await sb
    .from('events').select('*')
    .eq('status', 'upcoming')
    .order('event_date', { ascending: true })
    .limit(1);
  if (eErr || !events || events.length === 0) return null;

  const ev = events[0];
  window.__currentEventId = ev.id;

  const { data: fights, error: fErr } = await sb
    .from('fights')
    .select(`id,bout_order,weight_class,max_rounds,is_title_bout,red_odds,blue_odds,show_details,
             red:fighters!red_fighter_id(name,flag,rank,record,age,height_cm,weight_kg,reach_cm,ufc_slug,ko_pct,sub_pct,dec_pct,image_url),
             blue:fighters!blue_fighter_id(name,flag,rank,record,age,height_cm,weight_kg,reach_cm,ufc_slug,ko_pct,sub_pct,dec_pct,image_url)`)
    .eq('event_id', ev.id)
    .order('bout_order', { ascending: true });
  if (fErr) return null;

  FIGHTS = fights.map(f => ({
    _dbId: f.id,
    wc: f.weight_class,
    rounds: f.max_rounds + ' Rounds',
    maxRound: f.max_rounds,
    showDetails: f.show_details !== false,
    red: {
      name: f.red.name, flag: f.red.flag || '🏳️', odds: Number(f.red_odds),
      img: f.red.image_url || null,
      record: f.red.record || '-', age: String(f.red.age || '-'),
      ht: (f.red.height_cm || '-') + ' სმ', wt: (f.red.weight_kg || '-') + ' კგ',
      reach: (f.red.reach_cm || '-') + ' სმ'
    },
    blue: {
      name: f.blue.name, flag: f.blue.flag || '🏳️', odds: Number(f.blue_odds),
      img: f.blue.image_url || null,
      record: f.blue.record || '-', age: String(f.blue.age || '-'),
      ht: (f.blue.height_cm || '-') + ' სმ', wt: (f.blue.weight_kg || '-') + ' კგ',
      reach: (f.blue.reach_cm || '-') + ' სმ'
    }
  }));

  const tagEl = document.querySelector('.event-tag');
  if (tagEl) {
    const dt = new Date(ev.event_date);
    const EN = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    tagEl.innerHTML = 'UPCOMING EVENT<br>' + ev.location.toUpperCase() + '<br>' + EN[dt.getMonth()].toUpperCase() + ' ' + dt.getDate();
    window.__eventDate = dt;
  }
  return ev;
}

// ─────────────────────────────────────────────────────────────
//  ODDS HELPERS
// ─────────────────────────────────────────────────────────────
function roundOdds(i, r) {
  const f = FIGHTS[i];
  const base = (f.red.odds + f.blue.odds) / 2;
  return r2(base * (1 + r * 0.15));
}
function methodOdds(i, m) {
  const f    = FIGHTS[i];
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
  // ბეთინგი დახურულია
  if (isBettingClosed()) {
    document.getElementById('betbar').classList.remove('show');
    document.getElementById('markets').innerHTML = `
      <div class="betting-closed-banner">
        <div class="bc-title">ფსონების მიღება დასრულებულია</div>
        <div class="bc-sub">ივენთის დაწყებამდე 10 წუთზე ნაკლებია</div>
      </div>`;
    return;
  }

  const noImg = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 200'%3E%3Crect width='200' height='200' fill='%230E0D14'/%3E%3Ccircle cx='100' cy='85' r='42' fill='%23F31D25' opacity='.9'/%3E%3Ccircle cx='78' cy='75' r='16' fill='%23ff4040'/%3E%3Ccircle cx='100' cy='68' r='16' fill='%23ff4040'/%3E%3Ccircle cx='122' cy='75' r='16' fill='%23ff4040'/%3E%3Crect x='75' y='110' width='50' height='40' rx='8' fill='%23F31D25' opacity='.85'/%3E%3Crect x='82' y='145' width='36' height='18' rx='5' fill='%23cc1018'/%3E%3Ctext x='100' y='185' text-anchor='middle' font-size='14' fill='%23555'%3EMMA%3C/text%3E%3C/svg%3E";

  document.getElementById('markets').innerHTML = FIGHTS.map((f, i) => {
    const p = state.picks[i], fr = p ? p.fighter : null, open = state.openDetail[i];
    const mainOn = p && p.fighter && !p.round && !p.method;
    const fcls = fr || '';

    const roundChips = Array.from({ length: f.maxRound }, (_, k) => k + 1).map(r =>
      `<button class="mkt-chip ${fcls} ${p && p.round === r ? 'on' : ''}" data-round="${i}" data-val="${r}">
        <span class="ml">${r}</span><span class="mo">${roundOdds(i, r).toFixed(2)}</span>
      </button>`).join('');

    const methodChips = METHODS.map(m =>
      `<button class="mkt-chip ${fcls} ${p && p.method === m ? 'on' : ''}" data-method="${i}" data-val="${m}">
        <span class="ml">${m}</span><span class="mo">${methodOdds(i, m).toFixed(2)}</span>
      </button>`).join('');

    const taleRow = (lab, a, b) =>
      `<div class="tale-row"><span class="tv l">${a}</span><span class="tl">${lab}</span><span class="tv r">${b}</span></div>`;

    const pickBtn = (side, d) => {
      const flag  = `<span class="p-flag">${d.flag}</span>`;
      const name  = `<span class="p-name">${d.name}</span>`;
      const od    = `<span class="p-od">${d.odds.toFixed(2)}</span>`;
      const inner = side === 'red' ? flag + name + od : od + name + flag;
      return `<button class="pick ${side} ${mainOn && fr === side ? 'on' : ''}" data-winner="${i}" data-fr="${side}">${inner}</button>`;
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
          <img src="${f.red.img || noImg}" alt="${f.red.name}" loading="lazy">
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
          <img src="${f.blue.img || noImg}" alt="${f.blue.name}" loading="lazy">
        </div>
      </div>
      <div class="picks-wrap">
        <div class="picks-hint">აირჩიე ფავორიტი მებრძოლი</div>
        <div class="bout-picks">
          ${pickBtn('red',  f.red)}
          ${pickBtn('blue', f.blue)}
        </div>
      </div>
      ${f.showDetails ? `<button class="more-btn" data-more="${i}">${open ? 'ნაკლები დეტალი ▲' : 'მეტი დეტალი ▾'}</button>` : ''}
      <div class="extra ${open ? 'show' : ''}">
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
  const arr = picksArr(); if (arr.length === 0) return;
  const eventId = window.__currentEventId || null;

  if (state.mode === 'express') {
    const st = state.expressStake; if (st <= 0 || st > state.balance) return;
    const odds = comboOdds(), pw = Math.round(st * odds);
    const ticket = {
      type: 'express',
      sels: arr.map(s => ({ i: s.i, fighter: s.fighter, round: s.round, method: s.method, odds: s.odds, name: s.name })),
      stake: st, odds, status: 'open', placedAt: Date.now()
    };
    state.balance -= st; updateBalance(state.balance);
    if (eventId) {
      const { data: tk } = await sb.from('tickets')
        .insert({ user_id: currentUser.id, event_id: eventId, type: 'express', stake: st, total_odds: odds, potential_win: pw, status: 'pending' })
        .select().single();
      if (tk) {
        ticket._dbId = tk.id;
        await sb.from('ticket_selections').insert(arr.map(s => ({
          ticket_id: tk.id, fight_id: FIGHTS[s.i]?._dbId,
          picked_fighter: s.fighter, picked_round: s.round || null, picked_method: s.method || null, odds: s.odds
        })));
        await sb.from('users').update({ balance: state.balance }).eq('id', currentUser.id);
      }
    }
    state.tickets.unshift(ticket);
  } else {
    const ts = totalStakeSingle(); if (ts <= 0 || ts > state.balance) return;
    for (const s of arr) {
      if (s.stake > 0) {
        const pw = Math.round(s.stake * s.odds);
        const ticket = {
          type: 'single',
          sels: [{ i: s.i, fighter: s.fighter, round: s.round, method: s.method, odds: s.odds, name: s.name }],
          stake: s.stake, odds: s.odds, status: 'open', placedAt: Date.now()
        };
        if (eventId) {
          const { data: tk } = await sb.from('tickets')
            .insert({ user_id: currentUser.id, event_id: eventId, type: 'single', stake: s.stake, total_odds: s.odds, potential_win: pw, status: 'pending' })
            .select().single();
          if (tk) {
            ticket._dbId = tk.id;
            await sb.from('ticket_selections').insert({
              ticket_id: tk.id, fight_id: FIGHTS[s.i]?._dbId,
              picked_fighter: s.fighter, picked_round: s.round || null, picked_method: s.method || null, odds: s.odds
            });
          }
        }
        state.tickets.unshift(ticket);
      }
    }
    state.balance -= ts; updateBalance(state.balance);
    if (eventId) await sb.from('users').update({ balance: state.balance }).eq('id', currentUser.id);
  }

  state.picks = {}; state.expressStake = 0;
  closeSlip(); refresh(); renderSlip(); renderTickets();
}

// ─────────────────────────────────────────────────────────────
//  TICKETS
// ─────────────────────────────────────────────────────────────
function renderTickets() {
  const activeList = document.getElementById('activeTickets');
  const historyList = document.getElementById('historyTickets');
  const activeTickets = state.tickets.filter(t => t.status === 'open');
  const historyTickets = state.tickets.filter(t => t.status !== 'open').sort((a, b) => (b.placedAt || 0) - (a.placedAt || 0));
  document.getElementById('tkSummary').textContent = state.tickets.length + ' ბილეთი';

  const st = { open: 'ღია', won: 'მოგებული', lost: 'წაგებული', cashout: 'ქეშაუთი' };
  const cashoutOk = canCashout();

  const renderTicketCard = (t, idx) => {
    const realIdx = state.tickets.indexOf(t);
    const showCashout = t.status === 'open' && cashoutOk;
    return `
    <div class="ticket">
      <div class="tk-head">
        <span class="tk-type">${t.type === 'express' ? 'ექსპრესი · ' + t.sels.length + ' მოვლენა' : 'სინგლი'}</span>
        <span class="tk-status ${t.status}">${st[t.status] || t.status}</span>
      </div>
      <div class="tk-sels">
        ${t.sels.map(s => `
          <div class="tk-sel">
            <span>${s.name}</span>
            <span class="tk-od">${s.odds.toFixed(2)}${s.res ? ` <span class="res ${s.res}">${s.res === 'ok' ? '✓' : '✗'}</span>` : ''}</span>
          </div>`).join('')}
      </div>
      <div class="tk-foot">
        <span class="lbl">ფსონი: ${fmt(t.stake)} · კოეფ. ${t.odds.toFixed(2)}</span>
        <span class="pay ${t.status === 'won' ? 'won' : ''}">
          ${t.status === 'won' ? '+' + fmt(t.stake * t.odds)
            : t.status === 'lost'    ? '0'
            : t.status === 'cashout' ? 'ქეშაუთი'
            : 'შესაძლო ' + fmt(t.stake * t.odds)} ქულა
        </span>
      </div>
      ${showCashout ? `<button class="cashout-btn" data-co="${realIdx}">${cashoutLabel(t)}</button>` : ''}
    </div>`;
  };

  if (activeTickets.length === 0) {
    activeList.innerHTML = '<div class="tk-empty">აქტიური ბილეთი არ არის. აირჩიე კოეფიციენტი და დადე პირველი ფსონი.</div>';
  } else {
    activeList.innerHTML = activeTickets.map(renderTicketCard).join('');
  }

  if (historyTickets.length === 0) {
    historyList.innerHTML = '<div class="tk-empty">ისტორია ცარიელია.</div>';
  } else {
    historyList.innerHTML = historyTickets.map(renderTicketCard).join('');
  }

  document.querySelectorAll('[data-co]').forEach(b => b.onclick = () => doCashout(+b.dataset.co));
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
  document.getElementById('betbar').classList.toggle('show', n > 0);
}

// ─────────────────────────────────────────────────────────────
//  LEADERBOARD
// ─────────────────────────────────────────────────────────────
const LEADERBOARD = [];
const AVATAR_ICONS = ['🥊','🏆','🔥','⚡','💪','🦁','🐺','👊','💎','🎯','⭐','🦅'];

function renderLeaderboard() {
  // LEADERBOARD-დან ამოვიღოთ current user (თუ არის), რომ დუბლიკატი არ იყოს
  const rows = currentUser
    ? LEADERBOARD.filter(r => r.name !== currentUser.nick)
    : [...LEADERBOARD];

  if (currentUser) {
    const profit = state.balance - 1000;
    rows.push({ name: currentUser.nick, tag: 'შენ', pts: profit, bets: state.tickets.length, you: true, icon: currentUser.icon || '🥊' });
  }
  rows.sort((a, b) => b.pts - a.pts);
  document.getElementById('lbRows').innerHTML = rows.map((r, idx) => {
    const rank = idx + 1;
    const icon = r.icon || '🥊';
    const sign = r.pts > 0 ? '+' : '';
    return `<div class="lb-row ${r.you ? 'you' : ''}">
      <span class="lb-rank ${rank <= 3 ? 'top' : ''}">${rank}</span>
      <span class="lb-user">
        <span class="lb-ava-glove">${icon}</span>
        <span><span class="lb-name">${r.name}</span><br><span class="lb-tag">${r.tag || ''}</span></span>
      </span>
      <span class="lb-roi">${r.bets} ბილეთი</span>
      <span class="lb-pts">${sign}${fmt(r.pts)}</span>
    </div>`;
  }).join('');
}

// ─────────────────────────────────────────────────────────────
//  LOAD LEADERBOARD FROM DB
// ─────────────────────────────────────────────────────────────
async function loadLeaderboard() {
  try {
    const { data: users, error } = await sb
      .from('users').select('nick,icon,balance')
      .order('balance', { ascending: false }).limit(20);
    if (error || !users) return;
    LEADERBOARD.length = 0;
    users.forEach(u => {
      const profit = (u.balance || 0) - 1000; // მოგება = ბალანსი - საწყისი 1000
      LEADERBOARD.push({
        name: u.nick || '—', tag: '', pts: profit, bets: 0, icon: u.icon || '🥊'
      });
    });
    renderLeaderboard();
  } catch (e) {
    console.warn('loadLeaderboard failed:', e);
  }
}

// ─────────────────────────────────────────────────────────────
//  LOAD USER TICKETS FROM DB
// ─────────────────────────────────────────────────────────────
function rebuildSelName(i, s) {
  const f = FIGHTS[i];
  if (!f) return s.picked_fighter || '—';
  const a = [];
  if (s.picked_fighter) a.push((s.picked_fighter === 'red' ? f.red.name : f.blue.name) + ' მოგება');
  if (s.picked_round)   a.push(s.picked_round + '-ე რაუნდი');
  if (s.picked_method)  a.push(s.picked_method);
  return a.join(' · ');
}

async function loadUserTickets() {
  if (!currentUser) return;
  try {
    let q = sb.from('tickets')
      .select('id,type,stake,total_odds,status,created_at,ticket_selections(fight_id,picked_fighter,picked_round,picked_method,odds)')
      .eq('user_id', currentUser.id)
      .order('created_at', { ascending: false });

    if (window.__currentEventId) {
      q = q.eq('event_id', window.__currentEventId);
    }

    const { data: rows, error } = await q;
    if (error || !rows) return;

    const statusMap = { pending: 'open', open: 'open', won: 'won', lost: 'lost', cashout: 'cashout' };
    state.tickets = rows.map(tk => ({
      _dbId: tk.id,
      type: tk.type,
      sels: (tk.ticket_selections || []).map(s => {
        const i = FIGHTS.findIndex(f => f._dbId === s.fight_id);
        return {
          i,
          fighter: s.picked_fighter,
          round: s.picked_round,
          method: s.picked_method,
          odds: Number(s.odds),
          name: rebuildSelName(i, s)
        };
      }),
      stake: Number(tk.stake),
      odds: Number(tk.total_odds),
      status: statusMap[tk.status] || tk.status,
      placedAt: tk.created_at ? new Date(tk.created_at).getTime() : Date.now()
    }));
  } catch (e) {
    console.warn('loadUserTickets failed:', e);
  }
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
  const diff = ed - Date.now(); if (diff <= 0) return;
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
  const passEl = document.getElementById('inPass'); if (passEl) passEl.value = '';
  document.getElementById('modalTitle').textContent  = mode === 'join' ? 'შემოუერთდი ლიგას' : 'კეთილი იყოს დაბრუნება';
  document.getElementById('modalSub').textContent    = mode === 'join' ? ' ' : ' ';
  document.getElementById('nameField').style.display = mode === 'join' ? 'block' : 'none';
  document.getElementById('modalSubmit').textContent = mode === 'join' ? 'რეგისტრაცია' : 'შესვლა';
  document.getElementById('modalSwitch').innerHTML   = mode === 'join'
    ? 'უკვე გაქვს ანგარიში? <button id="switchMode">შესვლა</button>'
    : 'ახალი ხარ აქ? <button id="switchMode">რეგისტრაცია</button>';
  document.getElementById('switchMode').onclick = () => openModal(mode === 'join' ? 'signin' : 'join');
  document.getElementById('forgotWrap').style.display = mode === 'signin' ? 'block' : 'none';
  modal.classList.add('show');
}
function closeModal() { modal.classList.remove('show'); authError(''); }

// ─────────────────────────────────────────────────────────────
//  NAV UPDATE (გასწორებული — აღარ აქვს add/remove კონფლიქტი)
// ─────────────────────────────────────────────────────────────
function updateNavForUser(user) {
  const joinBtn     = document.getElementById('joinBtn');
  const signinBtn   = document.getElementById('signinBtn');
  const balancePill = document.querySelector('.balance-pill');
  let navUser       = document.getElementById('navUser');

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
    if (navProfile) { navProfile.style.display = 'block'; navProfile.onclick = (e) => { e.preventDefault(); openProfile(); }; }
    if (navLogout)  { navLogout.style.display  = 'block'; navLogout.onclick  = (e) => { e.preventDefault(); doLogout(); }; }

    updateBalance(user.balance || 1000);
  } else {
    if (joinBtn)   joinBtn.style.display = '';
    if (signinBtn) signinBtn.style.display = '';
    if (navUser)   navUser.style.display = 'none';
    if (balancePill) balancePill.classList.remove('visible');

    const navProfile = document.getElementById('navProfile');
    const navLogout  = document.getElementById('navLogout');
    if (navProfile) navProfile.style.display = 'none';
    if (navLogout)  navLogout.style.display  = 'none';

    updateBalance(1000);
  }
}

// Close dropdown when clicking outside
document.addEventListener('click', e => {
  const dd = document.getElementById('navDropdown');
  if (dd && !e.target.closest('.nav-user')) dd.classList.remove('show');
});

async function doRegister() {
  const nick  = (document.getElementById('inName').value  || '').trim();
  const email = (document.getElementById('inEmail').value || '').trim();
  const pass  = document.getElementById('inPass').value   || '';
  if (!nick || !/^[a-zA-Z0-9_]{3,20}$/.test(nick)) { authError('სახელი: 3-20 ლათინური სიმბოლო (a-z, 0-9, _)'); return; }
  if (!email) { authError('შეიყვანე ელ. ფოსტა'); return; }
  if (pass.length < 6) { authError('პაროლი მინ. 6 სიმბოლო'); return; }
  const btn = document.getElementById('modalSubmit'); btn.textContent = '…'; btn.disabled = true;
  const { data, error } = await sb.auth.signUp({ email, password: pass, options: { data: { nick } } });
  btn.disabled = false; btn.textContent = 'რეგისტრაცია';
  if (error) { authError(error.message); return; }
  await new Promise(r => setTimeout(r, 1000));
  const { data: ud } = await sb.from('users').select('*').eq('id', data.user.id).single();
  currentUser = { id: data.user.id, email, nick: ud?.nick || nick, balance: ud?.balance || 1000, icon: ud?.icon || '🥊' };
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
  currentUser = { id: data.user.id, email, nick: ud?.nick || email, balance: ud?.balance || 1000, icon: ud?.icon || '🥊' };
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

// onAuthStateChange — ერთადერთი სესიის მართვის წერტილი
let _initDone = false;

async function runInit(session) {
  if (_initDone) return;
  _initDone = true;

  // 1. სესიიდან იუზერის წამოღება
  if (session) {
    try {
      const { data: ud } = await sb.from('users').select('*').eq('id', session.user.id).single();
      if (ud) {
        currentUser = {
          id: session.user.id,
          email: session.user.email,
          nick: ud.nick,
          balance: ud.balance || 1000,
          icon: ud.icon || '🥊'
        };
      }
    } catch (e) {
      console.warn('User load failed:', e);
    }
  }

  // 2. მებრძოლების ჩატვირთვა
  await loadEventFromDB();

  // 3. UI რენდერი
  renderMarkets();
  renderSlip();
  renderBar();
  updateNavForUser(currentUser);

  // 4. ლიდერბორდი და ბილეთები
  await loadLeaderboard();
  if (currentUser) await loadUserTickets();
  renderTickets();

  // 5. Image fallback
  setInterval(() => {
    const fallback = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 200'%3E%3Crect width='200' height='200' fill='%230E0D14'/%3E%3Ccircle cx='100' cy='85' r='42' fill='%23F31D25' opacity='.9'/%3E%3Ccircle cx='78' cy='75' r='16' fill='%23ff4040'/%3E%3Ccircle cx='100' cy='68' r='16' fill='%23ff4040'/%3E%3Ccircle cx='122' cy='75' r='16' fill='%23ff4040'/%3E%3Crect x='75' y='110' width='50' height='40' rx='8' fill='%23F31D25' opacity='.85'/%3E%3Crect x='82' y='145' width='36' height='18' rx='5' fill='%23cc1018'/%3E%3C/svg%3E";
    document.querySelectorAll('.stage-img img').forEach(img => {
      if (!img.naturalWidth) img.src = fallback;
    });
  }, 3000);
}

sb.auth.onAuthStateChange(async (event, session) => {
  // პირველი callback (ნებისმიერი ივენთი) → INIT გაშვება
  if (!_initDone) {
    await runInit(session);
    return;
  }

  // შემდეგი ივენთები — ლოგინი/ლოგაუთი სესიის დროს
  if (event === 'SIGNED_IN' && session && !currentUser) {
    const { data: ud } = await sb.from('users').select('*').eq('id', session.user.id).single();
    if (ud) {
      currentUser = { id: session.user.id, email: session.user.email, nick: ud.nick, balance: ud.balance || 1000, icon: ud.icon || '🥊' };
      updateNavForUser(currentUser);
      await loadUserTickets();
      renderTickets();
    }
  } else if (event === 'SIGNED_OUT') {
    currentUser = null; state.tickets = []; renderTickets(); updateNavForUser(null);
  }
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

  // Render icon picker
  const picker = document.getElementById('iconPicker');
  picker.innerHTML = AVATAR_ICONS.map(ic =>
    `<button class="icon-opt ${(currentUser.icon || '🥊') === ic ? 'active' : ''}" data-icon="${ic}">${ic}</button>`
  ).join('');
  picker.querySelectorAll('.icon-opt').forEach(b => b.onclick = () => {
    picker.querySelectorAll('.icon-opt').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
  });

  pm.classList.add('show');
}

function closeProfile() {
  document.getElementById('profileModal').classList.remove('show');
}

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
    // Update nickname and icon in users table
    if (nick && nick !== currentUser.nick || icon !== currentUser.icon) {
      await sb.from('users').update({ nick, icon }).eq('id', currentUser.id);
      currentUser.nick = nick;
      currentUser.icon = icon;
    }

    // Update email
    if (email && email !== currentUser.email) {
      const { error } = await sb.auth.updateUser({ email });
      if (error) { profileMsg('მეილის შეცვლა ვერ მოხერხდა: ' + error.message, 'var(--red)'); return; }
      currentUser.email = email;
    }

    // Update password
    if (newPass) {
      if (newPass.length < 6) { profileMsg('ახალი პაროლი მინ. 6 სიმბოლო', 'var(--red)'); return; }
      if (!oldPass) { profileMsg('შეიყვანე ძველი პაროლი', 'var(--red)'); return; }
      const { error: signErr } = await sb.auth.signInWithPassword({ email: currentUser.email, password: oldPass });
      if (signErr) { profileMsg('ძველი პაროლი არასწორია', 'var(--red)'); return; }
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
//  EVENT LISTENERS
// ─────────────────────────────────────────────────────────────
document.getElementById('openSlip').onclick   = openSlip;
document.getElementById('closeSlip').onclick  = closeSlip;
document.getElementById('slipBg').onclick     = closeSlip;
document.getElementById('tabExpress').onclick = () => setMode('express');
document.getElementById('tabSingle').onclick  = () => setMode('single');
document.getElementById('joinBtn').onclick    = () => openModal('join');
document.getElementById('signinBtn').onclick  = () => openModal('signin');
document.getElementById('modalClose').onclick = closeModal;
modal.onclick = e => { if (e.target === modal) closeModal(); };
document.getElementById('modalSubmit').onclick = () => modalMode === 'join' ? doRegister() : doSignIn();
document.getElementById('googleBtn').onclick   = handleGoogleAuth;

// Forgot password
document.getElementById('forgotBtn').onclick = openForgotPassword;
document.getElementById('forgotModalClose').onclick = closeForgotModal;
document.getElementById('forgotModal').onclick = e => { if (e.target.id === 'forgotModal') closeForgotModal(); };
document.getElementById('forgotSubmit').onclick = sendPasswordReset;
document.getElementById('backToLogin').onclick = () => { closeForgotModal(); openModal('signin'); };

// Profile
document.getElementById('profileClose').onclick = closeProfile;
document.getElementById('profileModal').onclick = e => { if (e.target.id === 'profileModal') closeProfile(); };
document.getElementById('profileSave').onclick = saveProfile;
document.getElementById('profileLogout').onclick = () => { closeProfile(); doLogout(); };

// History toggle
document.getElementById('historyToggle').onclick = () => {
  const hist = document.getElementById('historyTickets');
  const arrow = document.getElementById('historyArrow');
  const isOpen = hist.style.display !== 'none';
  hist.style.display = isOpen ? 'none' : 'flex';
  arrow.classList.toggle('open', !isOpen);
};

document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeModal(); closeSlip(); closeForgotModal(); closeProfile(); } });

const navLinks = document.getElementById('navLinks');
document.getElementById('menuBtn').onclick = () => navLinks.classList.toggle('open');
document.querySelectorAll('a[href^="#"]').forEach(a => a.addEventListener('click', e => {
  const id = a.getAttribute('href').slice(1); const t = document.getElementById(id);
  if (t) { e.preventDefault(); t.scrollIntoView({ behavior: 'smooth', block: 'start' }); navLinks.classList.remove('open'); }
}));

// ─────────────────────────────────────────────────────────────
//  INIT — loading ინდიკატორი (ძირითადი ლოგიკა runInit-შია, onAuthStateChange იძახებს)
// ─────────────────────────────────────────────────────────────
const loadingEl = document.getElementById('markets');
if (loadingEl) loadingEl.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted)">იტვირთება ბრძოლები…</div>';
