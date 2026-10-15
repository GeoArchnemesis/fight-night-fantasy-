// ============================================================
//  ufc/quiz.js — UFC ქვიზი (Phase 1+2: ქვიზი + "ვინ ვარ?", მხოლოდ AI-ის წინააღმდეგ)
//  პორტირებულია ufc-epic-quiz.html პროტოტიპიდან. PvP (ადამიანის წინააღმდეგ)
//  ამ ფაზაში არ არის ჩართული — იხილეთ EPICQUIZ.PRD, Phase 3.
//  არ ტვირთავს app.js-ს. ავტორიზაციის მდგომარეობა (nav-ის ჩვენება ვიზუალური
//  თანხვედრისთვის) რეპლიცირებულია app.js-ის updateNavForUser/applySession-იდან,
//  ბალანსის ჩვენების ჩათვლით (მომხმარებლის მოთხოვნით) — მაგრამ ბილეთები,
//  ფსონები და ნებისმიერი ჩაწერადი ოპერაცია (place_bet/cashout/settle) ამ
//  გვერდზე საერთოდ არ არსებობს — მხოლოდ users.balance-ის წაკითხვა ჩვენებისთვის.
// ============================================================
"use strict";

/* ============================================================
   კონფიგურაცია
   ============================================================ */
const QUESTIONS_PER_GAME = 10;   // რამდენი კითხვა თითო თამაშში — სინქრონში ჰყავი supabase/quiz_pvp.sql-ის "limit 10"-თან
const AI_ACCURACY        = 0.60; // ნაგულისხმევი AI სიზუსტე (overridable დონის მიხედვით)
const TIME_PER_Q         = 15;   // წამი თითო კითხვაზე (მრავალპასუხიანი ქვიზი — AI-საც, PvP-საც)
const TIME_PER_GUESS_PVP = 25;   // წამი თითო კითხვაზე "ვინ ვარ?"-ში — მხოლოდ PvP-ში (AI-ის წინააღმდეგ თაიმერი არაა)
const CARD_SPEED_MS      = 170;  // კარტის ბრძოლის სისწრაფე
const MATCH_LS_KEY       = 'fnf_quiz_match';     // აქტიური PvP მატჩის localStorage გასაღები (resume-სთვის)
const GUEST_ID_LS_KEY    = 'fnf_quiz_guest_id';  // სტაბილური სტუმრის id — იგივე კაცს იცნობს სერვერი reload-ების მიღმაც
const GUEST_NAME_LS_KEY  = 'fnf_quiz_guest_name';

/* ---- Supabase (მხოლოდ კითხვა — ანონიმური, საჯარო key) ----
   ვცდილობთ ვიპოვოთ არსებული კლიენტი (window.sb / window.supabaseClient),
   თუ არა — ვქმნით ახალს public anon key-ით. ეს გვერდი app.js-ს არ ტვირთავს,
   ამიტომ ავტორიზაცია/სესია/ბალანსი აქ არ არსებობს — მხოლოდ კითხვების კითხვა. */
const SUPABASE_URL      = "https://qxfcwsiysnjxhxljqigl.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF4ZmN3c2l5c25qeGh4bGpxaWdsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxODM4MDUsImV4cCI6MjA5Nzc1OTgwNX0.SOeTrxnKulgO8ao8HSwxyKE-m9pvaQ54Pa_IGWWyKDc";

let sb = null;
(function initSB(){
  if(typeof window === "undefined") return;
  if(window.sb && window.sb.from){ sb = window.sb; return; }
  if(window.supabaseClient && window.supabaseClient.from){ sb = window.supabaseClient; return; }
  if(window.supabase && window.supabase.createClient && SUPABASE_URL && SUPABASE_ANON_KEY){
    try{
      // იგივე auth კონფიგი, რასაც app.js იყენებს (lock override გვერდის
      // დატვირთვისას სესიის საიმედოდ წასაკითხად) — სესია იზიარება იმავე
      // localStorage-ს, ამიტომ თუ ვიზიტორი app.js-იან გვერდზეა შესული,
      // აქაც ავტომატურად ცნობილი იქნება.
      sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, lock: (name, t, fn) => fn() }
      });
    }catch(e){ sb = null; }
  }
  if(!sb) console.warn("[quiz] Supabase კლიენტი ვერ მოიძებნა.");
})();

const fmt = n => Number.isFinite(+n) ? Math.round(+n).toLocaleString('en-US') : '0';

/* ============================================================
   ავტორიზაციის მდგომარეობის პარიტეტი (app.js-ის გარეშე) ----------
   მხოლოდ: სესიის წაკითხვა, nav-ის ჩვენება/დამალვა, ბალანსის ჩვენება.
   არანაირი ბილეთი/ფსონი/სეტლმენტი — ეს ყველაფერი ამ გვერდზე არც კი
   არსებობს (არც markup, არც RPC-ები). "პროფილი" ბმული გადის /profile/-ზე,
   რადგან პროფილის რედაქტირების მოდალი აქ არ იტვირთება. ------------- */
function updateAuthNav(user){
  document.body.classList.toggle('logged-in', !!user);
  const joinBtn = document.getElementById('joinBtn'), signinBtn = document.getElementById('signinBtn'),
        balancePill = document.querySelector('.balance-pill');
  let navUser = document.getElementById('navUser');

  if(user){
    if(joinBtn) joinBtn.style.display = 'none';
    if(signinBtn) signinBtn.style.display = 'none';
    if(!navUser){
      navUser = document.createElement('div'); navUser.id = 'navUser'; navUser.className = 'nav-user';
      navUser.innerHTML = `<span class="nav-ava">${user.icon || '🥊'}</span><span class="nav-nick">${user.nick}</span>
        <div class="nav-dropdown" id="navDropdown"><a class="nav-dd-item" href="/profile/">პროფილი</a><button class="nav-dd-item danger" id="ddLogout">გამოსვლა</button></div>`;
      if(joinBtn && joinBtn.parentNode) joinBtn.parentNode.insertBefore(navUser, joinBtn);
      navUser.addEventListener('click', e=>{ if(e.target.closest('.nav-dropdown')) return; document.getElementById('navDropdown').classList.toggle('show'); });
      const ddLogout = document.getElementById('ddLogout');
      if(ddLogout) ddLogout.addEventListener('click', async ()=>{ document.getElementById('navDropdown').classList.remove('show'); try{ await sb.auth.signOut(); }catch(e){} });
    } else {
      navUser.querySelector('.nav-nick').textContent = user.nick;
      navUser.querySelector('.nav-ava').textContent = user.icon || '🥊';
    }
    navUser.style.display = 'flex';
    if(balancePill){
      balancePill.classList.add('visible');
      const bEl = document.getElementById('balNav');
      if(bEl) bEl.textContent = (user.balance != null) ? fmt(user.balance) : '…';
    }
    addMobileAuthLinks();
  } else {
    if(joinBtn) joinBtn.style.display = '';
    if(signinBtn) signinBtn.style.display = '';
    if(navUser) navUser.style.display = 'none';
    if(balancePill) balancePill.classList.remove('visible');
    removeMobileAuthLinks();
  }
}

function addMobileAuthLinks(){
  const navLinks = document.getElementById('navLinks'); if(!navLinks) return;
  if(!document.getElementById('mProfile')){
    const p = document.createElement('a'); p.href = '/profile/'; p.id = 'mProfile'; p.className = 'nav-mobile-only'; p.textContent = 'პროფილი';
    navLinks.insertBefore(p, navLinks.firstChild);
  }
  if(!document.getElementById('mLogout')){
    const l = document.createElement('a'); l.href = '#'; l.id = 'mLogout'; l.className = 'nav-mobile-only danger'; l.textContent = 'გამოსვლა';
    l.addEventListener('click', async e=>{ e.preventDefault(); navLinks.classList.remove('open'); try{ await sb.auth.signOut(); }catch(e){} });
    navLinks.appendChild(l);
  }
}
function removeMobileAuthLinks(){
  const p = document.getElementById('mProfile'); if(p) p.remove();
  const l = document.getElementById('mLogout'); if(l) l.remove();
}
document.addEventListener('click', e => { const dd = document.getElementById('navDropdown'); if(dd && !e.target.closest('.nav-user')) dd.classList.remove('show'); });

async function fetchAuthUser(session){
  if(!session) return null;
  let ud = null;
  try{
    const res = await sb.from('users').select('nick,icon,balance').eq('id', session.user.id).maybeSingle();
    ud = res.data;
  }catch(e){ console.warn('[quiz] auth user fetch failed:', e); }
  return {
    id: session.user.id,
    nick: ud?.nick || session.user.user_metadata?.nick || (session.user.email || '').split('@')[0],
    icon: ud?.icon || '🥊',
    balance: (ud && ud.balance != null) ? ud.balance : null
  };
}

let currentAuthUser = null; // მცირე, საჯარო ასლი — PvP-ს სჭირდება იცოდეს "შესული ხარ თუ არა" (guest სახელის მოთხოვნის გადასაწყვეტად)

let _authApplying = false;
async function applyAuthSession(session){
  if(!session || _authApplying) return;
  _authApplying = true;
  try{
    const user = await fetchAuthUser(session);
    currentAuthUser = user;
    updateAuthNav(user);
  }
  finally { _authApplying = false; }
}

if(sb){
  sb.auth.getSession()
    .then(({ data })=> (data && data.session) ? applyAuthSession(data.session) : null)
    .catch(()=>{})
    .then(()=> bootstrapPvpResume()); // ჯერ ვიცით შესული ხარ თუ არა, მერე ვცდილობთ ?room=/localStorage-ის აღდგენას
  sb.auth.onAuthStateChange((event, session)=>{
    setTimeout(()=>{
      if(event === 'SIGNED_OUT'){ currentAuthUser = null; updateAuthNav(null); }
      else if(session) applyAuthSession(session);
    }, 0);
  });
}

// AI-ის სირთულის დონეები — acc = რა ალბათობით პასუხობს AI სწორად (მაღალი = რთული)
// dbLevel — quiz_questions.level / guess_who_questions.level მნიშვნელობა სერვერზე.
// enabled:false — ჯერ არ არსებობს კითხვები ამ დონეზე სერვერზე, ღილაკი გამორთულია.
const DIFFICULTY = [
  { key:"easy",   label:"მარტივი", acc:0.40, dbLevel:"მარტივი", enabled:true,
    note:"მარტივ კითხვებს ელოდე, ზოგადი ცოდნითაც შეიძლება გახვიდე ფონს.", color:"var(--green)" },
  { key:"medium", label:"საშუალო", acc:0.62, dbLevel:"საშუალო", enabled:false,
    note:"მეტ-ნაკლებად რთული კითხვებია, ალბათ MMA-ის შესახებ გარკვეული ცოდნა გჭირდება, მაგრამ რთულს არ გირჩევ", color:"var(--gold)" },
  { key:"hard",   label:"რთული",   acc:0.82, dbLevel:"რთული", enabled:false,
    note:'"საშუალოს" რჩევა უნდა გაგეთვალისწინებინა.', color:"var(--red-soft)" },
];

/* ============================================================
   მდგომარეობა
   ============================================================ */
const S = {
  mode:"ai",       // "ai" | "pvp" — ai ნაგულისხმევია სანამ PvP-ზე არ გადავა
  gameType:null,   // "quiz" | "guess"
  questions:[],
  gCluesShown:1,   // "ვინ ვარ?" — რამდენი მინიშნებაა ამჟამად გამოჩენილი
  qi:0,
  playerPicks:[],   // მოთამაშის არჩეული პასუხის ინდექსი / ტექსტი თითო კითხვაზე
  oppPicks:[],      // AI-ის არჩეული პასუხის ინდექსი / ტექსტი
  playerPoints:[],  // "ვინ ვარ?" — მოთამაშის ქულები თითო კითხვაზე (0-4)
  oppPoints:[],     // "ვინ ვარ?" — AI-ის ქულები თითო კითხვაზე
  aiAnswers:[],     // AI-ის სისწორე თითო კითხვაზე (bool)
  timer:null,
  timeLeft:0,
  bIndex:0,
  cbYou:0,
  cbOpp:0,
  cbTimer:null,
  cbReveal:null,
  aiAcc:null,
  diffKey:null,
};

/* PvP (Phase 3) — ცალკე, რომ AI-ის მდგომარეობას არ აერიოს.
   roomId/code/role/gameType/level — localStorage-შიც ინახება (resume). */
const P = {
  roomId:null, code:null, role:null, // role: "host" | "guest"
  gameType:null, level:null,
  started:false, finished:false,
  opponentName:null,
  channel:null, pollTimer:null,
};

/* ---------- helpers ---------- */
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
function show(id){
  $$(".screen").forEach(e=>e.classList.remove("active"));
  $("#"+id).classList.add("active");
  // მინი-ჰერო (სათაური) მხოლოდ პირველ ("აირჩიე თამაში") ეკრანზე ჩანს —
  // თამაშის პროცესში (კითხვები, ლობი, შედეგი) ბრენდინგის მაგივრად პირდაპირ
  // კითხვა/ტაიმერი ჩანდეს თავში.
  const hero = document.getElementById('quizHero');
  if(hero) hero.style.display = (id === "screen-gametype") ? "" : "none";
  window.scrollTo(0,0);
}
function shuffle(a){ a=a.slice(); for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; }

/* ---------- Supabase კითხვების წამოღება + ნორმალიზაცია ----------
   ბრუნდება app-ის ფორმატში: { q, o:[...], a:სწორი_ინდექსი }. */
function normalizeRow(row){
  const q = row.question ?? row.q ?? row.text ?? "";
  let opts = row.options ?? row.o ?? row.answers ?? [];
  if(typeof opts === "string"){ try{ opts = JSON.parse(opts); }catch(e){ opts = opts.split("|"); } }
  if(!Array.isArray(opts)) opts = [];
  let a = -1;

  if(opts.length && typeof opts[0] === "object" && opts[0] !== null){
    a = opts.findIndex(o => o && (o.correct===true || o.is_correct===true || o.isCorrect===true || o.answer===true));
    opts = opts.map(o => (o && (o.text ?? o.label ?? o.value ?? o.option)) ?? String(o));
  }
  if(a < 0){
    const idxLike = [row.answer, row.correct_index, row.correctIndex, row.correct, row.answer_index, row.correctOption];
    for(const v of idxLike){ if(typeof v === "number" && v>=0 && v<opts.length){ a = v; break; } }
  }
  if(a < 0){
    const strLike = [row.answer, row.correct_answer, row.correctAnswer, row.correct];
    for(const v of strLike){ if(typeof v === "string"){ const i = opts.indexOf(v); if(i>=0){ a = i; break; } } }
  }
  if(a < 0) a = 0; // ბოლო ვარიანტი — რომ თამაში არ გაითიშოს
  return { q:String(q), o:opts.map(String), a };
}

async function fetchQuestions(dbLevel){
  if(!sb || !dbLevel){ console.warn("[quiz] sb არ არის — ვერ წამოვიღე სერვერიდან."); return null; }
  try{
    const { data, error } = await sb
      .from('quiz_questions')
      .select('*')
      .eq('level', dbLevel)
      .eq('is_active', true);
    if(error){ console.error("[quiz] Supabase შეცდომა:", error.message||error); return null; }
    // ⚠️ განზრახ არ ვბეჭდავთ არც კითხვის, არც პასუხის შემცველ მონაცემებს კონსოლში (anti-cheat).
    if(!Array.isArray(data) || !data.length) return null;
    const norm = data.map(normalizeRow).filter(x => x.q && Array.isArray(x.o) && x.o.length >= 2);
    if(!norm.length){ console.warn("[quiz] კითხვები მოვიდა, მაგრამ ფორმატი ვერ დამუშავდა."); return null; }
    return norm;
  }catch(e){ console.error("[quiz] fetch გაითიშა:", e); return null; }
}

/* ---------- Supabase „ვინ ვარ?“ კითხვების წამოღება + ნორმალიზაცია ---------- */
function normalizeGuessRow(row){
  let clues = row.clues ?? row.hints ?? null;
  if(typeof clues === "string"){ try{ clues = JSON.parse(clues); }catch(e){ clues = clues.split("|"); } }
  if(!Array.isArray(clues)){
    clues = [row.clue1, row.clue2, row.clue3, row.clue4, row.clue5, row.clue6]
      .filter(c => c != null && String(c).trim() !== "");
  }
  const answer = row.answer ?? row.correct_answer ?? row.correctAnswer ?? row.name ?? "";
  return { clues: (clues||[]).map(String), answer: String(answer) };
}

async function fetchGuessQuestions(dbLevel){
  if(!sb || !dbLevel) return null;
  try{
    const { data, error } = await sb
      .from('guess_who_questions')
      .select('*')
      .eq('level', dbLevel)
      .eq('is_active', true);
    if(error){ console.error("[quiz] Supabase შეცდომა (ვინ ვარ?):", error.message||error); return null; }
    // ⚠️ აქაც არ ვბეჭდავთ მონაცემებს (პასუხებს) კონსოლში.
    if(!Array.isArray(data) || !data.length) return null;
    const norm = data.map(normalizeGuessRow).filter(x => x.answer && Array.isArray(x.clues) && x.clues.length);
    if(!norm.length) return null;
    return norm;
  }catch(e){ console.error("[quiz] fetch გაითიშა (ვინ ვარ?):", e); return null; }
}

/* ---------- თავისუფალი ტექსტის პასუხის შემოწმება „ვინ ვარ?“-სთვის ---------- */
function normName(s){
  return String(s||"")
    .toLowerCase()
    .replace(/['"’‘´`.,!?()\-–—]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
function collapseSpaces(s){ return s.replace(/\s+/g, ""); }
function levenshtein(a,b){
  const m=a.length, n=b.length;
  if(!m) return n; if(!n) return m;
  const dp = [];
  for(let i=0;i<=m;i++){ dp.push(new Array(n+1).fill(0)); dp[i][0]=i; }
  for(let j=0;j<=n;j++) dp[0][j]=j;
  for(let i=1;i<=m;i++){
    for(let j=1;j<=n;j++){
      dp[i][j] = a[i-1]===b[j-1] ? dp[i-1][j-1] : 1+Math.min(dp[i-1][j-1],dp[i-1][j],dp[i][j-1]);
    }
  }
  return dp[m][n];
}
function nameSimilarity(a,b){
  if(!a.length && !b.length) return 1;
  const dist = levenshtein(a,b);
  const maxLen = Math.max(a.length,b.length);
  return maxLen===0 ? 1 : 1 - dist/maxLen;
}
function isGuessCorrect(guess, answer){
  const gRaw = normName(guess), aRaw = normName(answer);
  if(!gRaw) return { correct:false, exact:false };
  if(gRaw === aRaw) return { correct:true, exact:true };

  const g = collapseSpaces(gRaw), a = collapseSpaces(aRaw);
  if(g === a) return { correct:true, exact:false }; // მხოლოდ სივრცე/აპოსტროფი განსხვავდებოდა

  if(nameSimilarity(g, a) >= 0.65) return { correct:true, exact:false };

  const aWords = aRaw.split(" ").filter(w=>w.length>=2);
  const gWords = gRaw.split(" ").filter(w=>w.length>=2);
  if(aWords.length && gWords.length){
    let allMatch = true;
    for(const aw of aWords){
      let best = 0;
      for(const gw of gWords){ best = Math.max(best, nameSimilarity(gw, aw)); }
      if(best < 0.62){ allMatch = false; break; }
    }
    if(allMatch) return { correct:true, exact:false };
  }

  if(g.length>=4 && (a.includes(g) || g.includes(a))) return { correct:true, exact:false };

  return { correct:false, exact:false };
}

/* ============================================================
   0) თამაშის ტიპის არჩევა (ქვიზი / ვინ ვარ?)
   ============================================================ */
$$("#screen-gametype .mode").forEach(card=>{
  const go = ()=> chooseGameType(card.dataset.gametype);
  card.addEventListener("click", go);
  card.addEventListener("keydown", e=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); go(); }});
});

function chooseGameType(type){
  S.gameType = type; // "quiz" | "guess"
  show("screen-mode");
}

const backBtn = $("#back-to-gametype");
if(backBtn) backBtn.addEventListener("click", ()=> show("screen-gametype"));

/* ============================================================
   1) რეჟიმის არჩევა — "AI-ის წინააღმდეგ" (startLobby) ან "ადამიანის
   წინააღმდეგ" (PvP — Phase 3, იხილეთ EPICQUIZ.PRD §7 და ქვემოთ, "PvP").
   ============================================================ */
$$("#screen-mode .mode").forEach(card=>{
  if(card.dataset.locked === "true") return; // მომავალში ჯერ არ ჩართული ბარათებისთვის
  const go = ()=> { if(card.dataset.mode === "human") startPvpChoice(); else startLobby(card.dataset.mode); };
  card.addEventListener("click", go);
  card.addEventListener("keydown", e=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); go(); }});
});

/* ============================================================
   2) ლობი — სირთულის არჩევა, შემდეგ "დაწყება"
   ============================================================ */
function startLobby(mode){
  if(mode !== "ai") return; // დაცვა — ამ ფაზაში მხოლოდ AI
  const you = $("#lob-you"), youName = $("#lob-you-name"), youStat = $("#lob-you-status");
  const opp = $("#lob-opp"), oppName = $("#lob-opp-name"), oppStat = $("#lob-opp-status");
  you.textContent = "🤠"; you.className = "avatar you on";
  youName.textContent = "შენ"; youStat.textContent = "";
  opp.textContent = "🤖"; opp.className = "avatar on";
  oppName.textContent = "AI"; oppStat.innerHTML = '<span class="ready">მზადაა</span>';
  $("#lobby-belt").textContent = "🥊 აირჩიე სირთულე";

  const action = $("#lobby-action");
  action.innerHTML = "";
  if(S.gameType === "guess") showGuessAIStart(action); else showAIStart(action);
  show("screen-lobby");
}

function buildDifficultyPicker(action, { onReady, startLabel, onStart }){
  action.innerHTML = "";
  S.aiAcc = null;

  const wrap = document.createElement("div");
  wrap.className = "difficulty";
  const lab = document.createElement("div");
  lab.className = "diff-label"; lab.textContent = "აირჩიე სირთულე";
  const chips = document.createElement("div");
  chips.className = "diff-chips";
  const note = document.createElement("div");
  note.className = "diff-note";
  wrap.appendChild(lab); wrap.appendChild(chips); wrap.appendChild(note);

  const startBtn = document.createElement("button");
  startBtn.className = "btn btn-primary"; startBtn.textContent = startLabel;
  startBtn.disabled = true;
  startBtn.onclick = async ()=>{
    if(S.aiAcc == null) return;
    startBtn.disabled = true;
    startBtn.textContent = "იტვირთება…";
    const res = await (onStart ? onStart() : beginQuiz());
    if(res && res.ok === false){
      note.innerHTML = res.message || "⚠️ კითხვები ვერ ჩაიტვირთა სერვერიდან.<br>სცადე მოგვიანებით.";
      note.style.color = "#ff5247";
      note.classList.add("show");
      startBtn.disabled = false;
      startBtn.textContent = startLabel;
    }
  };

  DIFFICULTY.forEach(d=>{
    const c = document.createElement("button");
    c.className = "chip"; c.textContent = d.label + (d.enabled ? "" : " 🔒");
    if(!d.enabled){
      c.disabled = true;
      c.title = "მალე დაემატება — ჯერ არ არის კითხვები ამ დონეზე სერვერზე.";
    } else {
      c.onclick = ()=>{
        S.aiAcc = d.acc;
        S.diffKey = d.key;
        chips.querySelectorAll(".chip").forEach(x=> x.classList.remove("sel"));
        c.classList.add("sel");
        note.textContent = d.note;
        note.style.color = d.color;
        note.classList.add("show");
        startBtn.disabled = false;
      };
    }
    chips.appendChild(c);
  });

  // წინასწარ არჩეული დონე — ერთადერთი ხელმისაწვდომი ("მარტივი") ავტომატურად
  // მონიშნულია და ღილაკი აქტიურია, მოთამაშეს აღარ სჭირდება ხელით არჩევა.
  const defaultChip = Array.from(chips.children).find((_,i)=> DIFFICULTY[i].enabled);
  if(defaultChip) defaultChip.click();

  action.appendChild(wrap);
  if(onReady) onReady(action);
  action.appendChild(startBtn);
}

function showAIStart(action){
  buildDifficultyPicker(action, { startLabel:"ქვიზის დაწყება" });
}

function showGuessAIStart(action){
  buildDifficultyPicker(action, {
    startLabel:"თამაშის დაწყება",
    onReady:(action)=>{
      const info = document.createElement("p");
      info.className = "tinyinfo";
      info.style.marginBottom = "clamp(6px,1.4dvh,14px)";
      info.textContent = "პასუხები შეიყვანე ქართულად 🇬🇪";
      action.appendChild(info);
    }
  });
}

/* ============================================================
   3) ქვიზი
   ============================================================ */
async function beginQuiz(){
  let pool = null;
  const diff = DIFFICULTY.find(d => d.key === S.diffKey);

  if(S.gameType === "guess"){
    pool = await fetchGuessQuestions(diff && diff.dbLevel);
  } else {
    pool = await fetchQuestions(diff && diff.dbLevel);
  }
  if(!pool || !pool.length) return { ok:false, reason:"server" };

  S.questions = shuffle(pool).slice(0, QUESTIONS_PER_GAME);
  S.qi = 0;
  S.playerPicks = []; S.playerPoints = []; S.oppPoints = [];
  const acc = (S.aiAcc != null) ? S.aiAcc : AI_ACCURACY;
  S.aiAnswers = S.questions.map(()=> Math.random() < acc);

  if(S.gameType === "guess"){
    S.oppPicks = S.questions.map((item,i)=>{
      if(S.aiAnswers[i]) return item.answer;
      const others = pool.filter(p=>p.answer!==item.answer);
      const pick = others.length ? others[Math.floor(Math.random()*others.length)] : item;
      return pick.answer;
    });
    S.oppPoints = S.questions.map((item,i)=>{
      if(!S.aiAnswers[i]) return 0;
      const clueCount = 1 + Math.floor(Math.random()*4); // 1..4
      return 5 - clueCount; // 4..1 ქულა
    });
  } else {
    S.oppPicks = S.questions.map((item,i)=>{
      if(S.aiAnswers[i]) return item.a;
      const wrong = item.o.map((_,k)=>k).filter(k => k !== item.a);
      return wrong.length ? wrong[Math.floor(Math.random()*wrong.length)] : item.a;
    });
  }

  $("#q-total").textContent = S.questions.length;
  $("#gq-total").textContent = S.questions.length;
  show(S.gameType === "guess" ? "screen-guess" : "screen-quiz");
  renderQuestion();
  return { ok:true };
}

function renderQuestion(){
  if(S.gameType === "guess") renderGuessQuestion();
  else renderMCQuestion();
}

function renderMCQuestion(){
  const item = S.questions[S.qi];
  $("#q-idx").textContent = S.qi+1;
  $("#q-num").textContent = S.qi+1;
  $("#q-text").textContent = item.q;
  const wrap = $("#q-opts"); wrap.innerHTML = "";
  const keys = ["ა","ბ","გ","დ","ე","ვ"];
  item.o.forEach((txt,i)=>{
    const btn = document.createElement("button");
    btn.className = "opt";
    btn.innerHTML = `<span class="key">${keys[i] || (i+1)}</span><span>${txt}</span>`;
    btn.onclick = ()=> answer(i, btn);
    wrap.appendChild(btn);
  });
  startTimer();
}

function startTimer(){
  clearInterval(S.timer);
  S.timeLeft = TIME_PER_Q;
  const bar = $("#q-timer");
  bar.style.width = "100%";
  S.timer = setInterval(()=>{
    S.timeLeft -= 0.25;
    bar.style.width = Math.max(0,(S.timeLeft/TIME_PER_Q)*100)+"%";
    if(S.timeLeft<=0){ clearInterval(S.timer); answer(-1,null); }
  }, 250);
}

/* ---------- „ვინ ვარ?“ — პროგრესული მინიშნებები (AI-ის წინააღმდეგ) ----------
   თაიმერი არაა — უპასუხე შენი ტემპით; პასუხის შემდეგ დაუყოვნებლივ ჩანს
   სწორია თუ არა, „შემდეგი“ ღილაკზე დაჭერით გააგრძელებ. ქულა დამოკიდებულია
   რამდენი მინიშნება გახსენი პასუხის გაცემამდე: 1→4, 2→3, 3→2, 4→1. ------ */
function renderGuessQuestion(){
  const item = S.questions[S.qi];
  $("#gq-idx").textContent = S.qi+1;
  $("#gq-num").textContent = S.qi+1;
  S.gCluesShown = 1;
  renderGuessClues();

  const inp = $("#gq-input");
  inp.value = ""; inp.disabled = false;
  $("#gq-submit").disabled = false;
  $("#gq-next-clue").disabled = (item.clues.length <= 1);
  $("#gq-answer-area").style.display = "";

  const fb = $("#gq-feedback");
  fb.classList.remove("show","ok","bad");
  fb.innerHTML = "";
  const nextQBtn = $("#gq-next-q");
  nextQBtn.style.display = "none";
  nextQBtn.onclick = null;

  clearInterval(S.timer);
  if(S.mode === "pvp"){
    $("#gq-timer-row").style.display = "";
    startGuessTimerPvp();
  } else {
    $("#gq-timer-row").style.display = "none"; // AI-ის წინააღმდეგ — თაიმერი არ ჩანს
  }
}

function startGuessTimerPvp(){
  clearInterval(S.timer);
  S.timeLeft = TIME_PER_GUESS_PVP;
  const bar = $("#gq-timer");
  bar.style.width = "100%";
  S.timer = setInterval(()=>{
    S.timeLeft -= 0.25;
    bar.style.width = Math.max(0,(S.timeLeft/TIME_PER_GUESS_PVP)*100)+"%";
    if(S.timeLeft<=0){ clearInterval(S.timer); submitGuess(); }
  }, 250);
}

function renderGuessClues(){
  const item = S.questions[S.qi];
  const wrap = $("#gq-clues"); wrap.innerHTML = "";
  for(let i=0; i<S.gCluesShown && i<item.clues.length; i++){
    const p = document.createElement("div");
    p.className = "gq-clue";
    p.innerHTML = `<span class="gq-clue-num">${i+1}.</span><span>${item.clues[i]}</span>`;
    wrap.appendChild(p);
  }
  wrap.scrollTop = wrap.scrollHeight;
}

function submitGuess(){
  clearInterval(S.timer);
  const item = S.questions[S.qi];
  const val = ($("#gq-input").value || "").trim();

  $("#gq-answer-area").style.display = "none";
  const fb = $("#gq-feedback");
  fb.classList.add("show");

  if(S.mode === "pvp"){
    // PvP-ში კლიენტმა არც კი იცის სწორი პასუხი reveal-მდე (anti-cheat —
    // იხილეთ supabase/quiz_pvp.sql), ამიტომ აქ fuzzy-match ვერ/არ გამოიყენება —
    // ქულა/სისწორე მთლიანად სერვერზე გამოითვლება submit_quiz_answer-ში
    // (clues_shown-იც იქვეა თვალყურდევნებული, არა კლიენტიდან მოსული).
    S.playerPicks[S.qi] = val;
    fb.classList.remove("bad"); fb.classList.add("ok");
    fb.innerHTML = "პასუხი გაიგზავნა — სწორი პასუხი ჩანს თამაშის დასრულების შემდეგ";
    submitPvpAnswer(S.qi, val);
  } else {
    const result = val ? isGuessCorrect(val, item.answer) : { correct:false, exact:false };
    const points = result.correct ? Math.max(1, Math.min(4, 5 - S.gCluesShown)) : 0;

    S.playerPicks[S.qi] = val;
    S.playerPoints[S.qi] = points;

    if(result.correct){
      fb.classList.add("ok"); fb.classList.remove("bad");
      fb.innerHTML = result.exact
        ? `✓ სწორია! <span class="sub">+${points} ქულა</span>`
        : `✓ სწორია! <span class="sub">ბაზაში ჩაწერილია: ${item.answer} · +${points} ქულა</span>`;
    } else {
      fb.classList.add("bad"); fb.classList.remove("ok");
      fb.innerHTML = `✗ არასწორია <span class="sub">სწორი პასუხია: ${item.answer}</span>`;
    }
  }

  const nextBtn = $("#gq-next-q");
  nextBtn.style.display = "";
  nextBtn.onclick = ()=> advanceGuessQuestion();
}

function advanceGuessQuestion(){
  S.qi++;
  if(S.qi >= S.questions.length){ finishQuiz(); }
  else { renderQuestion(); }
}

$("#gq-next-clue").addEventListener("click", ()=>{
  const item = S.questions[S.qi];
  if(!item) return;
  if(S.gCluesShown < item.clues.length){
    S.gCluesShown++;
    renderGuessClues();
    if(S.gCluesShown >= item.clues.length) $("#gq-next-clue").disabled = true;
    // PvP-ში "რამდენი მინიშნება გაშალა" სერვერზეც აღირიცხება (anti-cheat —
    // წინააღმდეგ შემთხვევაში კლიენტს შეეძლო ყოველთვის "1 მინიშნება ვნახეო" ეთქვა).
    if(S.mode === "pvp" && P.roomId){
      sb.rpc('reveal_quiz_clue', Object.assign({ p_room_id:P.roomId, p_question_index:S.qi }, pvpIdentityParams()))
        .then(()=>{})
        .catch(e=> console.warn('[quiz] reveal_quiz_clue failed:', e));
    }
  }
});
$("#gq-submit").addEventListener("click", ()=> submitGuess());
$("#gq-input").addEventListener("keydown", e=>{ if(e.key==="Enter"){ e.preventDefault(); submitGuess(); }});

function answer(chosen, btn){
  clearInterval(S.timer);
  const opts = $$("#q-opts .opt");
  opts.forEach(o=> o.disabled = true);
  if(chosen>=0){
    opts[chosen].classList.add("chosen");
    opts.forEach((o,i)=>{ if(i!==chosen) o.classList.add("dim"); });
  }
  S.playerPicks[S.qi] = chosen; // -1 თუ დრო ამოიწურა

  if(S.mode === "pvp") submitPvpAnswer(S.qi, chosen);

  setTimeout(()=>{
    S.qi++;
    if(S.qi >= S.questions.length){ finishQuiz(); }
    else { renderQuestion(); }
  }, chosen>=0 ? 620 : 300);
}

/* ============================================================
   4) ქვიზი დასრულდა → AI-ის წინააღმდეგ პირდაპირ კარტების ბრძოლაზე;
   PvP-ში ველოდებით მოწინააღმდეგეს (თუ უკვე დაასრულა — პირდაპირ შედეგზე).
   ============================================================ */
function finishQuiz(){
  if(S.mode === "pvp"){ pvpFinishMySide(); return; }
  startCardBattle();
}

/* ============================================================
   5) კარტების ბრძოლა
   ============================================================ */
function startCardBattle(){
  S.bIndex = 0; S.cbYou = 0; S.cbOpp = 0;
  const oppAva = (S.mode === "pvp") ? "🤠" : "🤖";
  const oppLab = (S.mode === "pvp") ? (P.opponentName || "მოწინააღმდეგე").slice(0,14) : "AI";
  $("#cb-you").textContent = "0";
  $("#cb-opp").textContent = "0";
  $("#cb-you-tag").textContent = "🤠 შენ";
  $("#cb-opp-ava").textContent = oppAva;
  $("#cb-opp-lab").textContent = oppLab;
  $("#qb-you-who").textContent = "🤠 შენ";
  $("#qb-opp-ava").textContent = oppAva;
  $("#qb-opp-lab2").textContent = oppLab;
  $("#cb-restart").style.display = "none";
  $("#cb-skip").style.display = "";
  const board = document.querySelector(".cb-score");
  board.classList.remove("finished");
  document.querySelector(".cb-side.you").classList.remove("win");
  document.querySelector(".cb-side.opp").classList.remove("win");
  $("#cb-round").className = "cb-round";
  $("#cb-log").textContent = "კითხვები ბრუნდება — ვნახოთ ვინ იყო უფრო ზუსტი!";
  $("#qb-card").classList.remove("show");
  $("#cb-final").classList.remove("show");
  document.querySelector(".qbattle").style.display = "";
  show("screen-cards");
  clearTimeout(S.cbTimer); clearTimeout(S.cbReveal);
  S.cbTimer = setTimeout(playCard, 150);
}

function fillCard(idx){
  const item = S.questions[idx];
  const pPick = S.playerPicks[idx], oPick = S.oppPicks[idx];
  $("#qb-num").textContent = `კითხვა ${idx+1}`;
  $("#qb-q").textContent = item.q;
  $("#qb-you-pick").textContent = (pPick>=0 && pPick!=null) ? item.o[pPick] : "პასუხი არ გაეცა";
  $("#qb-opp-pick").textContent = (oPick>=0 && oPick!=null) ? item.o[oPick] : "—";
  $("#qb-you-badge").textContent = "";
  $("#qb-opp-badge").textContent = "";
  $("#qb-you-correct").textContent = "";
}

function fillGuessCard(idx){
  const item = S.questions[idx];
  const pPick = S.playerPicks[idx], oPick = S.oppPicks[idx];
  $("#qb-num").textContent = `კითხვა ${idx+1}`;
  $("#qb-q").textContent = item.clues && item.clues[0] ? item.clues[0] : "პასუხი შეიყვანე #ქართულად";
  $("#qb-you-pick").textContent = (pPick && String(pPick).trim()) ? pPick : "პასუხი არ გაეცა";
  $("#qb-opp-pick").textContent = (oPick && String(oPick).trim()) ? oPick : "—";
  $("#qb-you-badge").textContent = "";
  $("#qb-opp-badge").textContent = "";
  $("#qb-you-correct").textContent = "";
}

function playCard(){
  if(S.bIndex >= S.questions.length){ return endBattle(); }
  const idx = S.bIndex;
  $("#cb-round").textContent = `კითხვა ${idx+1} / ${S.questions.length}`;

  const card = $("#qb-card");
  card.classList.remove("show");
  $("#qb-ans-you").className = "qb-ans you";
  $("#qb-ans-opp").className = "qb-ans opp";
  if(S.gameType === "guess") fillGuessCard(idx); else fillCard(idx);

  requestAnimationFrame(()=>{ card.classList.add("show"); });

  S.cbReveal = setTimeout(()=> revealCard(idx), Math.min(CARD_SPEED_MS*0.55, 480));
}

function revealCard(idx){
  const item = S.questions[idx];
  let pCorrect, oCorrect, correctText, pGain, oGain;
  if(S.gameType === "guess"){
    pGain = S.playerPoints[idx] || 0;
    oGain = S.oppPoints[idx] || 0;
    pCorrect = pGain > 0;
    oCorrect = oGain > 0;
    correctText = item.answer;
  } else if(S.mode === "pvp"){
    // PvP-ში სისწორეც სერვერზეა გამოთვლილი (submit_quiz_answer) — კლიენტი
    // აქ მხოლოდ უკვე დათვლილ ქულას კითხულობს, ხელახლა არ ადარებს pick-ს.
    pGain = S.playerPoints[idx] || 0;
    oGain = S.oppPoints[idx] || 0;
    pCorrect = pGain > 0;
    oCorrect = oGain > 0;
    correctText = item.o[item.a];
  } else {
    pCorrect = S.playerPicks[idx] === item.a;
    oCorrect = S.oppPicks[idx] === item.a;
    correctText = item.o[item.a];
    pGain = pCorrect ? 1 : 0;
    oGain = oCorrect ? 1 : 0;
  }

  $("#qb-ans-you").classList.add(pCorrect ? "correct" : "wrong");
  $("#qb-ans-opp").classList.add(oCorrect ? "correct" : "wrong");
  if(S.gameType === "guess"){
    $("#qb-you-badge").textContent = pCorrect ? ("✓ +"+pGain) : "✗";
    $("#qb-opp-badge").textContent = oCorrect ? ("✓ +"+oGain) : "✗";
  } else {
    $("#qb-you-badge").textContent = pCorrect ? "✓" : "✗";
    $("#qb-opp-badge").textContent = oCorrect ? "✓" : "✗";
  }
  if(!pCorrect) $("#qb-you-correct").textContent = "სწორი: " + correctText;

  if(pGain>0){ S.cbYou += pGain; bump($("#cb-you"), S.cbYou); }
  if(oGain>0){ S.cbOpp += oGain; bump($("#cb-opp"), S.cbOpp); }

  if(pCorrect && !oCorrect)      $("#cb-log").innerHTML = `<b style="color:var(--green)">შენ სწორად უპასუხე!</b> +${pGain} შენ`;
  else if(!pCorrect && oCorrect) $("#cb-log").innerHTML = `<b style="color:var(--red-soft)">AI-მ სწორად უპასუხა.</b> +${oGain} AI`;
  else if(pCorrect && oCorrect)  $("#cb-log").innerHTML = `ორივემ სწორად უპასუხა ✓`;
  else                           $("#cb-log").innerHTML = `ვერცერთმა ვერ გამოიცნო.`;

  S.bIndex = idx + 1;
  S.cbTimer = setTimeout(playCard, CARD_SPEED_MS);
}

function bump(el, val){
  el.textContent = val;
  el.classList.add("bump");
  setTimeout(()=> el.classList.remove("bump"), 220);
}

function endBattle(){
  clearTimeout(S.cbTimer); clearTimeout(S.cbReveal);
  $("#cb-skip").style.display = "none";
  $("#cb-restart").style.display = "";

  const you=S.cbYou, opp=S.cbOpp;
  const board = document.querySelector(".cb-score");
  const sideYou = document.querySelector(".cb-side.you");
  const sideOpp = document.querySelector(".cb-side.opp");
  board.classList.add("finished");
  sideYou.classList.remove("win"); sideOpp.classList.remove("win");

  document.querySelector(".qbattle").style.display = "none";
  $("#cb-log").innerHTML = "";
  $("#cb-round").className = "cb-round";
  $("#cb-round").textContent = "დასრულდა";

  const emoji = $("#cbf-emoji"), title = $("#cbf-title"), score = $("#cbf-score");
  score.textContent = `${you} – ${opp}`;
  if(you>opp){
    sideYou.classList.add("win");
    emoji.textContent = "🏆"; title.textContent = "თქვენ გაიმარჯვეთ"; title.className = "cbf-title win";
  } else if(you<opp){
    sideOpp.classList.add("win");
    emoji.textContent = "💀"; title.textContent = "თქვენ დამარცხდით"; title.className = "cbf-title lose";
  } else {
    emoji.textContent = "⚖️"; title.textContent = "ქვიზი ფრედ დასრულდა"; title.className = "cbf-title draw";
  }
  $("#cb-final").classList.add("show");
}

/* skip -> სწრაფად ბოლომდე */
$("#cb-skip").addEventListener("click", ()=>{
  clearTimeout(S.cbTimer);
  clearTimeout(S.cbReveal);
  while(S.bIndex < S.questions.length){
    const item = S.questions[S.bIndex];
    if(S.gameType === "guess" || S.mode === "pvp"){
      S.cbYou += S.playerPoints[S.bIndex] || 0;
      S.cbOpp += S.oppPoints[S.bIndex] || 0;
    } else {
      if(S.playerPicks[S.bIndex] === item.a) S.cbYou++;
      if(S.oppPicks[S.bIndex] === item.a) S.cbOpp++;
    }
    S.bIndex++;
  }
  $("#cb-you").textContent = S.cbYou;
  $("#cb-opp").textContent = S.cbOpp;
  endBattle();
});

$("#cb-restart").addEventListener("click", resetToMode);

function resetToMode(){
  clearInterval(S.timer); clearTimeout(S.cbTimer); clearTimeout(S.cbReveal);
  if(S.mode === "pvp"){ unsubscribeRoom(); clearMatchState(); resetPvpState(); }
  S.mode = "ai";
  S.gameType = null;
  show("screen-gametype");
}

/* ============================================================
   6) PvP — "ადამიანის წინააღმდეგ" კოდით მოწვევა (Phase 3, EPICQUIZ.PRD §7).
   სერვერი (supabase/quiz_pvp.sql) ინახავს სწორ პასუხებს — კლიენტი მხოლოდ
   ნედლ პასუხებს აგზავნის და პასუხობს სერვერის დათვლილ შედეგზე. ყოველი
   რეალურ-დროის განახლება კონკრეტული ოთახის id-ზეა subscribe-ილი, არა
   გლობალურ არხზე.
   ============================================================ */

/* ---------- იდენტობა: შესული მომხმარებელი ან სტაბილური სტუმარი ---------- */
function getGuestId(){
  try{
    let id = localStorage.getItem(GUEST_ID_LS_KEY);
    if(!id){
      id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ("g-"+Math.random().toString(36).slice(2)+Date.now().toString(36));
      localStorage.setItem(GUEST_ID_LS_KEY, id);
    }
    return id;
  }catch(e){
    // კერძო რეჟიმი/დაბლოკილი localStorage — ამ ჩანართისთვის მაინც სტაბილური id
    if(!window.__fnfGuestIdMem) window.__fnfGuestIdMem = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Math.random());
    return window.__fnfGuestIdMem;
  }
}
function getSavedGuestName(){ try{ return localStorage.getItem(GUEST_NAME_LS_KEY) || ""; }catch(e){ return ""; } }
function saveGuestName(name){ try{ localStorage.setItem(GUEST_NAME_LS_KEY, name); }catch(e){} }

function pvpIdentityParams(explicitGuestName){
  if(currentAuthUser) return { p_guest_id:null, p_guest_name:null };
  return { p_guest_id:getGuestId(), p_guest_name: explicitGuestName || getSavedGuestName() || null };
}

/* ---------- აქტიური მატჩის localStorage (resume crash/reload-ის შემდეგ) ---------- */
function saveMatchState(){
  try{
    if(!P.roomId){ localStorage.removeItem(MATCH_LS_KEY); return; }
    localStorage.setItem(MATCH_LS_KEY, JSON.stringify({
      roomId:P.roomId, code:P.code, role:P.role, gameType:P.gameType, level:P.level
    }));
  }catch(e){}
}
function loadMatchState(){
  try{ const raw = localStorage.getItem(MATCH_LS_KEY); return raw ? JSON.parse(raw) : null; }catch(e){ return null; }
}
function clearMatchState(){ try{ localStorage.removeItem(MATCH_LS_KEY); }catch(e){} }
function resetPvpState(){
  P.roomId=null; P.code=null; P.role=null; P.gameType=null; P.level=null;
  P.started=false; P.finished=false; P.opponentName=null;
}

/* ---------- შეცდომების გაადამიანურება ---------- */
function mapRpcError(error){
  const msg = (error && (error.message || error.details || "")) || "";
  if(msg.includes("room not found")) return "კოდი ვერ მოიძებნა — გადაამოწმე.";
  if(msg.includes("already full")) return "ეს ოთახი უკვე სავსეა ან დაწყებულია.";
  if(msg.includes("expired")) return "ამ ოთახის ვადა გავიდა — სთხოვე მეგობარს ახალი კოდი.";
  if(msg.includes("own room")) return "საკუთარ ოთახში ვერ შეუერთდები.";
  if(msg.includes("abandoned")) return "მოწინააღმდეგემ დატოვა თამაში.";
  return "დაფიქსირდა შეცდომა — სცადე თავიდან.";
}

/* ---------- ეკრანების ნავიგაცია ---------- */
function startPvpChoice(){ show("screen-pvp-choice"); }

$$("#screen-pvp-choice .mode").forEach(card=>{
  const go = ()=> (card.dataset.pvp === "create") ? enterPvpCreate() : enterPvpJoin();
  card.addEventListener("click", go);
  card.addEventListener("keydown", e=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); go(); }});
});
const backToMode = $("#back-to-mode");
if(backToMode) backToMode.addEventListener("click", ()=> show("screen-mode"));
const backToPvpChoice1 = $("#back-to-pvp-choice-1");
if(backToPvpChoice1) backToPvpChoice1.addEventListener("click", ()=> show("screen-pvp-choice"));
const backToPvpChoice2 = $("#back-to-pvp-choice-2");
if(backToPvpChoice2) backToPvpChoice2.addEventListener("click", ()=> show("screen-pvp-choice"));

function enterPvpCreate(){
  showPvpCreateForm();
  show("screen-pvp-create");
}

function showPvpCreateForm(){
  const action = $("#pvpCreateAction");
  buildDifficultyPicker(action, {
    startLabel: "ოთახის შექმნა",
    onReady: (action)=>{
      if(!currentAuthUser){
        const wrap = document.createElement("div");
        wrap.className = "name-entry";
        wrap.style.marginBottom = "14px";
        const lab = document.createElement("label"); lab.textContent = "შენი სახელი"; lab.htmlFor = "pvp-create-name";
        const inp = document.createElement("input");
        inp.type = "text"; inp.id = "pvp-create-name"; inp.maxLength = 20; inp.placeholder = "მაგ. გიორგი";
        inp.value = getSavedGuestName();
        wrap.appendChild(lab); wrap.appendChild(inp);
        action.insertBefore(wrap, action.firstChild);
      }
    },
    onStart: ()=> pvpCreateRoom()
  });
}

async function pvpCreateRoom(){
  const diff = DIFFICULTY.find(d=> d.key === S.diffKey);
  if(!diff) return { ok:false, message:"აირჩიე სირთულე" };

  let guestName = null;
  if(!currentAuthUser){
    const inp = $("#pvp-create-name");
    guestName = ((inp && inp.value) || "").trim().slice(0,20);
    if(!guestName) return { ok:false, message:"შეიყვანე შენი სახელი" };
    saveGuestName(guestName);
  }

  const { data, error } = await sb.rpc('create_quiz_room', Object.assign(
    { p_game_type:S.gameType, p_level:diff.dbLevel }, pvpIdentityParams(guestName)
  ));
  if(error || !data || !data[0]){
    console.warn('[quiz] create_quiz_room failed:', error);
    return { ok:false, message:"ოთახის შექმნა ვერ მოხერხდა. სცადე თავიდან." };
  }

  const row = data[0];
  resetPvpState();
  P.roomId = row.room_id; P.code = row.code; P.role = "host";
  P.gameType = S.gameType; P.level = diff.dbLevel; P.started = false;
  saveMatchState();
  showPvpWait({ title:"ოთახი შექმნილია!", sub:"გაუზიარე კოდი მეგობარს და დაელოდე მის შემოერთებას.", code:row.code });
  subscribeRoom(P.roomId);
  return { ok:true };
}

function enterPvpJoin(prefillCode){
  const nameWrap = $("#pvpJoinNameWrap");
  if(nameWrap){
    if(currentAuthUser){ nameWrap.style.display = "none"; }
    else {
      nameWrap.style.display = "";
      const inp = $("#pvp-join-name");
      if(inp) inp.value = getSavedGuestName();
    }
  }
  const codeInp = $("#pvp-join-code");
  if(codeInp) codeInp.value = prefillCode || "";
  showJoinError("");
  show("screen-pvp-join");
}

function showJoinError(msg){
  const err = $("#pvpJoinError");
  if(!err) return;
  if(!msg){ err.classList.remove("show"); err.textContent = ""; return; }
  err.textContent = msg; err.style.color = "var(--red-soft)"; err.classList.add("show");
}

const pvpJoinBtn = $("#pvp-join-btn");
if(pvpJoinBtn) pvpJoinBtn.addEventListener("click", ()=> doPvpJoin());
const pvpJoinCodeInp = $("#pvp-join-code");
if(pvpJoinCodeInp) pvpJoinCodeInp.addEventListener("keydown", e=>{ if(e.key==="Enter"){ e.preventDefault(); doPvpJoin(); }});

async function doPvpJoin(){
  const code = (($("#pvp-join-code") || {}).value || "").trim();
  if(!code){ showJoinError("შეიყვანე კოდი"); return; }

  let guestName = null;
  if(!currentAuthUser){
    guestName = (($("#pvp-join-name") || {}).value || "").trim().slice(0,20);
    if(!guestName){ showJoinError("შეიყვანე შენი სახელი"); return; }
    saveGuestName(guestName);
  }

  const btn = $("#pvp-join-btn");
  if(btn){ btn.disabled = true; btn.textContent = "ვუერთდები…"; }
  const { data, error } = await sb.rpc('join_quiz_room', Object.assign({ p_code:code }, pvpIdentityParams(guestName)));
  if(btn){ btn.disabled = false; btn.textContent = "შეერთება"; }

  if(error || !data || !data[0]){ showJoinError(mapRpcError(error)); return; }

  const row = data[0];
  resetPvpState();
  P.roomId = row.room_id; P.role = "guest";
  P.gameType = row.game_type; P.level = row.level; P.started = true; P.opponentName = row.host_name;
  saveMatchState();
  subscribeRoom(P.roomId);
  beginPvpMatch(row.questions, []);
}

function showPvpWait({ title, sub, code }){
  const t = $("#pvpWaitTitle"), s = $("#pvpWaitSub"), box = $("#pvpCodeBox");
  if(t) t.textContent = title || "";
  if(s) s.textContent = sub || "";
  if(box){
    if(code){ box.style.display = ""; const ct = $("#pvpCodeText"); if(ct) ct.textContent = code; }
    else box.style.display = "none";
  }
  show("screen-pvp-wait");
}

const pvpCopyBtn = $("#pvpCopyLink");
if(pvpCopyBtn) pvpCopyBtn.addEventListener("click", async ()=>{
  const link = location.origin + "/ufc/quiz/?room=" + encodeURIComponent(P.code || "");
  try{
    if(navigator.clipboard && navigator.clipboard.writeText){
      await navigator.clipboard.writeText(link);
      pvpCopyBtn.textContent = "დაკოპირდა ✓";
      setTimeout(()=> pvpCopyBtn.textContent = "ბმულის კოპირება", 1600);
    } else {
      pvpCopyBtn.textContent = link;
    }
  }catch(e){ pvpCopyBtn.textContent = link; }
});

const pvpLeaveBtn = $("#pvpLeaveBtn");
if(pvpLeaveBtn) pvpLeaveBtn.addEventListener("click", async ()=>{
  if(P.roomId){
    try{ await sb.rpc('leave_quiz_room', Object.assign({ p_room_id:P.roomId }, pvpIdentityParams())); }catch(e){}
  }
  unsubscribeRoom(); clearMatchState(); resetPvpState();
  S.mode = "ai";
  show("screen-gametype");
});

/* ---------- Realtime (კონკრეტულ room id-ზე) + polling fallback ---------- */
function subscribeRoom(roomId){
  unsubscribeRoom();
  if(sb){
    try{
      P.channel = sb.channel('quiz-room-'+roomId)
        .on('postgres_changes', { event:'UPDATE', schema:'public', table:'quiz_rooms', filter:`id=eq.${roomId}` },
            payload => onRoomUpdate(payload.new))
        .subscribe();
    }catch(e){ console.warn('[quiz] realtime subscribe failed:', e); }
  }
  clearInterval(P.pollTimer);
  P.pollTimer = setInterval(pollRoomStatus, 4000); // Realtime-ის სარეზერვო — თუ replication ჩართული არაა/ჩამოვარდა
}
function unsubscribeRoom(){
  if(P.channel){ try{ sb.removeChannel(P.channel); }catch(e){} P.channel = null; }
  clearInterval(P.pollTimer); P.pollTimer = null;
}
async function pollRoomStatus(){
  if(!P.roomId || !sb) return;
  try{
    const { data } = await sb.from('quiz_rooms').select('status,guest_name,host_finished_at,guest_finished_at').eq('id', P.roomId).maybeSingle();
    if(data) onRoomUpdate(data);
  }catch(e){}
}

function onRoomUpdate(row){
  if(!row || !P.roomId) return;

  if(row.guest_name && !P.opponentName && P.role === "host") P.opponentName = row.guest_name;

  if(P.role === "host" && !P.started && row.status === "active"){
    P.started = true;
    rejoinAndEnter();
    return;
  }
  if(row.status === "finished" && !P.finished){
    P.finished = true;
    unsubscribeRoom();
    fetchAndShowResults();
    return;
  }
  if(row.status === "abandoned"){
    unsubscribeRoom();
    clearMatchState();
    showPvpWait({ title:"მოწინააღმდეგემ დატოვა თამაში", sub:"დაბრუნდი მენიუში და სცადე თავიდან." });
    setTimeout(()=>{ resetPvpState(); S.mode = "ai"; show("screen-gametype"); }, 2200);
  }
}

/* ---------- rejoin — ჰოსტის "guest შემოუერთდა" მომენტიც და page-reload resume-იც ---------- */
async function rejoinAndEnter(){
  try{
    const { data, error } = await sb.rpc('rejoin_quiz_room', Object.assign({ p_room_id:P.roomId }, pvpIdentityParams()));
    if(error || !data || !data[0]) throw error || new Error("no data");
    const row = data[0];
    P.gameType = row.game_type; P.level = row.level;
    if(row.host_name && P.role === "guest") P.opponentName = row.host_name;
    if(row.guest_name && P.role === "host") P.opponentName = row.guest_name;

    if(row.status === "abandoned"){
      clearMatchState();
      showPvpWait({ title:"ეს თამაში აღარ არსებობს", sub:"დაბრუნდი მენიუში და სცადე თავიდან." });
      setTimeout(()=>{ resetPvpState(); S.mode = "ai"; show("screen-gametype"); }, 2200);
      return;
    }
    if(row.status === "finished"){ P.finished = true; fetchAndShowResults(); return; }
    if(row.status === "waiting"){
      showPvpWait({ title:"ოთახი შექმნილია!", sub:"გაუზიარე კოდი მეგობარს და დაელოდე მის შემოერთებას.", code:row.code });
      subscribeRoom(P.roomId);
      return;
    }
    subscribeRoom(P.roomId);
    beginPvpMatch(row.questions, row.answered_indexes || []);
  }catch(e){
    console.warn('[quiz] rejoin failed:', e);
    clearMatchState(); resetPvpState();
    S.mode = "ai";
    show("screen-gametype");
  }
}

/* ---------- თამაშის დაწყება/გაგრძელება — იყენებს იმავე #screen-quiz/#screen-guess
   ეკრანებს და renderQuestion()-ს, რასაც AI-ის რეჟიმი ---------- */
function beginPvpMatch(questions, answeredIdx){
  S.mode = "pvp";
  S.gameType = P.gameType;
  S.questions = (S.gameType === "guess")
    ? questions.map(q=> ({ clues:(q && q.clues) || [] }))
    : questions.map(q=> ({ q:(q && q.q) || "", o:(q && q.o) || [] }));
  S.playerPicks = []; S.playerPoints = []; S.oppPicks = []; S.oppPoints = [];

  const answeredSet = new Set(answeredIdx || []);
  S.qi = 0;
  while(answeredSet.has(S.qi) && S.qi < S.questions.length) S.qi++;

  $("#q-total").textContent = S.questions.length;
  $("#gq-total").textContent = S.questions.length;

  if(S.qi >= S.questions.length){
    pvpFinishMySide(); // resume ზუსტად მას შემდეგ, რაც უკვე ყველაფერს უპასუხე
    return;
  }
  show(S.gameType === "guess" ? "screen-guess" : "screen-quiz");
  renderQuestion();
}

async function pvpFinishMySide(){
  showPvpWait({
    title:"შენ დაასრულე!",
    sub: P.opponentName ? ("ველოდებით "+P.opponentName+"-ს…") : "ველოდებით მოწინააღმდეგეს…"
  });
  // შეიძლება მოწინააღმდეგემ ჩვენზე ადრე დაასრულა — პირდაპირ შევამოწმოთ
  try{
    const { data } = await sb.from('quiz_rooms').select('status').eq('id', P.roomId).maybeSingle();
    if(data && data.status === "finished"){ P.finished = true; unsubscribeRoom(); fetchAndShowResults(); }
  }catch(e){}
}

async function fetchAndShowResults(){
  try{
    const { data, error } = await sb.rpc('get_quiz_results', Object.assign({ p_room_id:P.roomId }, pvpIdentityParams()));
    if(error || !data || !data[0]) throw error || new Error("no data");
    const r = data[0];
    const myPicks   = (P.role === "host") ? r.host_picks  : r.guest_picks;
    const oppPicks  = (P.role === "host") ? r.guest_picks : r.host_picks;
    const myPoints  = (P.role === "host") ? r.host_points : r.guest_points;
    const oppPoints = (P.role === "host") ? r.guest_points: r.host_points;
    P.opponentName = (P.role === "host") ? r.guest_name : r.host_name;

    S.mode = "pvp";
    S.gameType = r.game_type;
    const n = (r.answer_key && r.answer_key.length) || S.questions.length;
    for(let i=0;i<n;i++){
      if(S.gameType === "guess"){
        S.questions[i] = Object.assign({}, S.questions[i], { answer: r.answer_key[i] });
        S.playerPoints[i] = myPoints[i] || 0;
        S.oppPoints[i] = oppPoints[i] || 0;
        S.playerPicks[i] = (myPicks[i] !== undefined && myPicks[i] !== null) ? myPicks[i] : "";
        S.oppPicks[i] = (oppPicks[i] !== undefined && oppPicks[i] !== null) ? oppPicks[i] : "";
      } else {
        S.questions[i] = Object.assign({}, S.questions[i], { a: r.answer_key[i] });
        S.playerPicks[i] = (myPicks[i] !== undefined && myPicks[i] !== null) ? myPicks[i] : -1;
        S.oppPicks[i] = (oppPicks[i] !== undefined && oppPicks[i] !== null) ? oppPicks[i] : -1;
      }
    }
    clearMatchState();
    startCardBattle();
  }catch(e){
    console.warn('[quiz] get_quiz_results failed:', e);
  }
}

/* ---------- Bootstrap — გვერდის ჩატვირთვისას: ჯერ ?room=CODE, მერე
   localStorage-ში შენახული აქტიური მატჩი, თორემ ჩვეულებრივი მენიუ ---------- */
async function bootstrapPvpResume(){
  if(!sb) return;
  const params = new URLSearchParams(location.search);
  const urlCode = (params.get('room') || '').trim().toUpperCase();
  const saved = loadMatchState();

  if(saved && saved.roomId && (!urlCode || saved.code === urlCode)){
    P.roomId = saved.roomId; P.code = saved.code; P.role = saved.role;
    P.gameType = saved.gameType; P.level = saved.level;
    P.started = true; P.finished = false;
    await rejoinAndEnter();
    return;
  }

  if(urlCode){
    enterPvpJoin(urlCode);
    if(currentAuthUser) doPvpJoin(); // შესულს სახელის კითხვა არ სჭირდება
  }
}
