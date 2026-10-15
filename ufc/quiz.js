// ============================================================
//  ufc/quiz.js — UFC ქვიზი (Phase 1+2: ქვიზი + "ვინ ვარ?", მხოლოდ AI-ის წინააღმდეგ)
//  პორტირებულია ufc-epic-quiz.html პროტოტიპიდან. PvP (ადამიანის წინააღმდეგ)
//  ამ ფაზაში არ არის ჩართული — იხილეთ EPICQUIZ.PRD, Phase 3.
//  არ ტვირთავს/არ ეხება app.js-ს, ბალანსს, ბილეთებს ან სეტლმენტს.
// ============================================================
"use strict";

/* ============================================================
   კონფიგურაცია
   ============================================================ */
const QUESTIONS_PER_GAME = 10;   // რამდენი კითხვა თითო თამაშში
const AI_ACCURACY        = 0.60; // ნაგულისხმევი AI სიზუსტე (overridable დონის მიხედვით)
const TIME_PER_Q         = 15;   // წამი თითო კითხვაზე (მრავალპასუხიანი ქვიზი)
const CARD_SPEED_MS      = 170;  // კარტის ბრძოლის სისწრაფე

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
    try{ sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY); }catch(e){ sb = null; }
  }
  if(!sb) console.warn("[quiz] Supabase კლიენტი ვერ მოიძებნა.");
})();

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

/* ---------- helpers ---------- */
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
function show(id){ $$(".screen").forEach(e=>e.classList.remove("active")); $("#"+id).classList.add("active"); window.scrollTo(0,0); }
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
   1) რეჟიმის არჩევა — ამ ფაზაში მხოლოდ "AI-ის წინააღმდეგ" აქტიურია.
   "ადამიანის წინააღმდეგ" ბარათი ჩანს locked/"მალე" მდგომარეობაში
   (იხილეთ EPICQUIZ.PRD Phase 3) — არანაირი Realtime/channel არ იხსნება.
   ============================================================ */
$$("#screen-mode .mode").forEach(card=>{
  if(card.dataset.locked === "true") return; // locked ბარათს handler საერთოდ არ ემატება
  const go = ()=> startLobby(card.dataset.mode);
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

function buildDifficultyPicker(action, { onReady, startLabel }){
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
    const res = await beginQuiz();
    if(res && res.ok === false){
      note.innerHTML = "⚠️ კითხვები ვერ ჩაიტვირთა სერვერიდან.<br>სცადე მოგვიანებით.";
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
  $("#gq-timer-row").style.display = "none"; // AI-ის წინააღმდეგ — თაიმერი არ ჩანს
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
  const item = S.questions[S.qi];
  const val = ($("#gq-input").value || "").trim();

  $("#gq-answer-area").style.display = "none";

  const result = val ? isGuessCorrect(val, item.answer) : { correct:false, exact:false };
  const points = result.correct ? Math.max(1, Math.min(4, 5 - S.gCluesShown)) : 0;

  S.playerPicks[S.qi] = val;
  S.playerPoints[S.qi] = points;

  const fb = $("#gq-feedback");
  fb.classList.add("show");
  if(result.correct){
    fb.classList.add("ok"); fb.classList.remove("bad");
    fb.innerHTML = result.exact
      ? `✓ სწორია! <span class="sub">+${points} ქულა</span>`
      : `✓ სწორია! <span class="sub">ბაზაში ჩაწერილია: ${item.answer} · +${points} ქულა</span>`;
  } else {
    fb.classList.add("bad"); fb.classList.remove("ok");
    fb.innerHTML = `✗ არასწორია <span class="sub">სწორი პასუხია: ${item.answer}</span>`;
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

  setTimeout(()=>{
    S.qi++;
    if(S.qi >= S.questions.length){ finishQuiz(); }
    else { renderQuestion(); }
  }, chosen>=0 ? 620 : 300);
}

/* ============================================================
   4) ქვიზი დასრულდა → პირდაპირ კარტების ბრძოლაზე
   ============================================================ */
function finishQuiz(){
  startCardBattle();
}

/* ============================================================
   5) კარტების ბრძოლა
   ============================================================ */
function startCardBattle(){
  S.bIndex = 0; S.cbYou = 0; S.cbOpp = 0;
  $("#cb-you").textContent = "0";
  $("#cb-opp").textContent = "0";
  $("#cb-you-tag").textContent = "🤠 შენ";
  $("#cb-opp-ava").textContent = "🤖";
  $("#cb-opp-lab").textContent = "AI";
  $("#qb-you-who").textContent = "🤠 შენ";
  $("#qb-opp-ava").textContent = "🤖";
  $("#qb-opp-lab2").textContent = "AI";
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
    if(S.gameType === "guess"){
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
  S.gameType = null;
  show("screen-gametype");
}
