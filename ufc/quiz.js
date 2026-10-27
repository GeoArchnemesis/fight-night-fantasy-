// ============================================================
//  ufc/quiz.js — UFC ქვიზი (ქვიზი + "ვინ ვარ?", AI-ის და ადამიანის წინააღმდეგ)
//  პორტირებულია ufc-epic-quiz.html პროტოტიპიდან.
//  არ ტვირთავს app.js-ს. ავტორიზაციის მდგომარეობა (nav-ის ჩვენება ვიზუალური
//  თანხვედრისთვის) რეპლიცირებულია app.js-ის updateNavForUser/applySession-იდან,
//  ბალანსის ჩვენების ჩათვლით (მომხმარებლის მოთხოვნით) — მაგრამ ბილეთები,
//  ფსონები და ნებისმიერი ჩაწერადი ოპერაცია (place_bet/cashout/settle) ამ
//  გვერდზე საერთოდ არ არსებობს — მხოლოდ users.balance-ის წაკითხვა ჩვენებისთვის.
//
//  UPDATE (QuizUpdates.pdf): თამაშის დასაწყებად ახლა ავტორიზაცია სავალდებულოა —
//  "სტუმრის" იდენტობის სისტემა მთლიანად ამოღებულია. საკუთარი, ჩაშენებული
//  login/register მოდალი იხსნება "დაწყება"-ზე დაჭერისას — სესია არ წყდება,
//  app.js არ იტვირთება.
// ============================================================
"use strict";

/* ============================================================
   კონფიგურაცია
   ============================================================ */
const QUESTIONS_PER_GAME = 10;   // რამდენი კითხვა თითო თამაშში — სინქრონში ჰყავი supabase/quiz_pvp.sql-ის "limit 10"-თან
const AI_ACCURACY        = 0.60; // ნაგულისხმევი AI სიზუსტე (overridable დონის მიხედვით)
const TIME_PER_Q         = 15;   // წამი თითო კითხვაზე (მრავალპასუხიანი ქვიზი, AI-ის წინააღმდეგ)
const CARD_SPEED_MS      = 170;  // კარტის ბრძოლის სისწრაფე
const PVP_TIME_PER_Q     = 30;   // PDF p7: PvP-ში (ორივე ტიპი) — 30 წამი თითო კითხვაზე, AI-ის 15-ისგან დამოუკიდებლად
const PVP_GUESS_CLUE_BONUS = 5;  // PDF p7: "ვინ ვარ?" PvP-ში ყოველი ახალი მინიშნება +5 წამს მატებს დროს
const TIMER_AMBER_MS = 10000; // ბოლო ~10 წამი — ბარი ყვითლდება
const TIMER_RED_MS   = 5000;  // ბოლო ~5 წამი — ბარი წითლდება

/* prefers-reduced-motion: თაიმერის ბარი წყვეტს უწყვეტ (rAF) ანიმაციას და
   მხოლოდ მთელ წამებზე "ხტება" (იგივე სიხშირით, რითაც რიცხვი იცვლება) —
   დანარჩენი ქვიზის ანიმაციები (#quizRoot *) CSS-ით კი ისედაც გამორთულია. */
let REDUCE_MOTION = false;
if(typeof window !== "undefined" && window.matchMedia){
  const rmQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  REDUCE_MOTION = rmQuery.matches;
  const onRmChange = e => { REDUCE_MOTION = e.matches; };
  if(rmQuery.addEventListener) rmQuery.addEventListener("change", onRmChange);
  else if(rmQuery.addListener) rmQuery.addListener(onRmChange);
}

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
// Phase Q3: ნავში ავატარი ფოტოს პრეფერირებს, თუ users.avatar_type==='photo'.
function navAvaHtml(user){
  return (user.avatar_type === 'photo' && user.avatar_url)
    ? `<img src="${user.avatar_url}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`
    : (user.icon || '🥊');
}
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
      navUser.innerHTML = `<span class="nav-ava">${navAvaHtml(user)}</span><span class="nav-nick">${user.nick}</span>
        <div class="nav-dropdown" id="navDropdown"><a class="nav-dd-item" href="/profile/">პროფილი</a><button class="nav-dd-item danger" id="ddLogout">გამოსვლა</button></div>`;
      if(joinBtn && joinBtn.parentNode) joinBtn.parentNode.insertBefore(navUser, joinBtn);
      navUser.addEventListener('click', e=>{ if(e.target.closest('.nav-dropdown')) return; document.getElementById('navDropdown').classList.toggle('show'); });
      const ddLogout = document.getElementById('ddLogout');
      if(ddLogout) ddLogout.addEventListener('click', async ()=>{ document.getElementById('navDropdown').classList.remove('show'); try{ await sb.auth.signOut(); }catch(e){} });
    } else {
      navUser.querySelector('.nav-nick').textContent = user.nick;
      navUser.querySelector('.nav-ava').innerHTML = navAvaHtml(user);
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

/* ============================================================
   ავტორიზაციის მოდალი — ჩაშენებული login/register (QuizUpdates.pdf) ----
   მთავარ საიტზე არსებული auth-მოდალისგან დამოუკიდებელი, მინიმალური ვერსია
   (ელ.ფოსტა + პასვორდი + ნიკი — ტელეფონი/დაბადების წელი/სქესი არ იკრიბება
   აქ, ზუსტად ისევე, როგორც Google-ით შესვლისას მთავარ საიტზეც ხდება —
   მოგვიანებით /profile/-დან ივსება). იხსნება ნებისმიერი "დაწყება" ქმედების
   წინ (requireAuth), თუ ვიზიტორი შესული არ არის — სესია არ წყდება, და
   შესვლის/რეგისტრაციის დასრულებისთანავე ზუსტად ის ქმედება გრძელდება,
   რისთვისაც მოდალი გაიხსნა. --------------------------------------- */
let _pendingAuthAction = null;
let _authModalMode = 'signin';

function requireAuth(action){
  if(currentAuthUser){ action(); return; }
  _pendingAuthAction = action;
  openAuthModal();
}

function openAuthModal(mode){
  const m = document.getElementById('quizAuthModal');
  if(!m) return;
  setAuthModalMode(mode || 'signin');
  const submitBtn = document.getElementById('quizAuthSubmit');
  if(submitBtn) submitBtn.disabled = false;
  m.classList.add('show');
  const emailInp = document.getElementById('quizAuthEmail');
  if(emailInp) setTimeout(()=> emailInp.focus(), 60);
}
// nav-ის "შესვლა"/"რეგისტრაცია" ღილაკებისთვის — უბრალო გახსნა, pending action
// (თამაშის გაგრძელება) არ სჭირდება, უბრალოდ შედის/იწერება ანგარიშზე.
window.openAuthModalMode = function(mode){ openAuthModal(mode); };
function closeAuthModal(){
  const m = document.getElementById('quizAuthModal');
  if(m) m.classList.remove('show');
  showAuthError('');
}
// თუ მოდალს დახურავ ავტორიზაციის გარეშე — რასაც დაწყება სურდა, აღარ გაგრძელდება
function cancelAuthModal(){ _pendingAuthAction = null; closeAuthModal(); }

function setAuthModalMode(mode){
  _authModalMode = mode;
  const nickField = document.getElementById('quizAuthNickField');
  const title = document.getElementById('quizAuthTitle');
  const sub = document.getElementById('quizAuthSub');
  const submitBtn = document.getElementById('quizAuthSubmit');
  const switchWrap = document.getElementById('quizAuthSwitch');
  // R5: sign-in (არა რეგისტრაცია) დასაშვებია მეილის/ნიქნეიმის/ნომრით — label/placeholder მხოლოდ signin-ზე იცვლება
  const emailLabel = document.querySelector('label[for="quizAuthEmail"]');
  const emailInput = document.getElementById('quizAuthEmail');
  if(mode === 'signup'){
    if(nickField) nickField.style.display = '';
    if(title) title.textContent = 'რეგისტრაცია';
    if(sub) sub.textContent = 'თამაშის დასაწყებად საჭიროა ანგარიში.';
    if(submitBtn) submitBtn.textContent = 'რეგისტრაცია';
    if(switchWrap) switchWrap.innerHTML = 'უკვე გაქვს ანგარიში? <button type="button" id="quizAuthSwitchBtn">შესვლა</button>';
    if(emailLabel) emailLabel.textContent = 'ელ. ფოსტა';
    if(emailInput) emailInput.placeholder = 'შეიყვანე შენი მეილი';
  } else {
    if(nickField) nickField.style.display = 'none';
    if(title) title.textContent = 'შესვლა';
    if(sub) sub.textContent = 'თამაშის დასაწყებად საჭიროა ავტორიზაცია.';
    if(submitBtn) submitBtn.textContent = 'შესვლა';
    if(switchWrap) switchWrap.innerHTML = 'არ გაქვს ანგარიში? <button type="button" id="quizAuthSwitchBtn">რეგისტრაცია</button>';
    if(emailLabel) emailLabel.textContent = 'ელ.ფოსტა / ნიქნეიმი / ნომერი';
    if(emailInput) emailInput.placeholder = 'შეიყვანე ელ.ფოსტა, ნიქნეიმი ან ნომერი';
  }
  const switchBtn = document.getElementById('quizAuthSwitchBtn');
  if(switchBtn) switchBtn.addEventListener('click', ()=> setAuthModalMode(mode === 'signup' ? 'signin' : 'signup'));
  showAuthError('');
}
function showAuthError(msg){
  const el = document.getElementById('quizAuthError');
  if(!el) return;
  if(!msg){ el.style.display = 'none'; el.textContent = ''; return; }
  el.textContent = msg; el.style.display = 'block';
}

async function doQuizAuthSubmit(){
  const email = (document.getElementById('quizAuthEmail').value || '').trim();
  const pass = document.getElementById('quizAuthPass').value || '';
  const btn = document.getElementById('quizAuthSubmit');
  if(!email || !pass){ showAuthError('შეავსე ყველა ველი'); return; }
  if(!sb){ showAuthError('სერვერთან კავშირი ვერ დამყარდა.'); return; }
  if(btn) btn.disabled = true;

  try{
    if(_authModalMode === 'signup'){
      const nick = (document.getElementById('quizAuthNick').value || '').trim();
      if(!nick || !/^[a-zA-Z0-9._]{3,20}$/.test(nick)){
        showAuthError('სახელი: 3-20 სიმბოლო (ასოები, ციფრები, . _)'); if(btn) btn.disabled = false; return;
      }
      if(pass.length < 6){ showAuthError('პასვორდი: მინ. 6 სიმბოლო'); if(btn) btn.disabled = false; return; }

      // შენიშვნა: sb.rpc(...) არ არის სრული Promise — მხოლოდ .then()-ს
      // ახორციელებს, .catch()-ს პირდაპირ (await-ის გარეშე) ვერ მიადევნებ,
      // თორემ "is not a function" გაიჭრება. აქ უბრალოდ ვუცდით {data,error}-ს.
      const { data: taken, error: nickCheckErr } = await sb.rpc('is_nick_taken', { p_nick: nick, p_exclude_user_id: null });
      if(nickCheckErr) console.warn('[quiz] is_nick_taken failed:', nickCheckErr);
      if(taken){ showAuthError('ეს სახელი უკვე დაკავებულია — სცადე სხვა'); if(btn) btn.disabled = false; return; }

      const { data, error } = await sb.auth.signUp({ email, password: pass, options:{ data:{ nick } } });
      if(error){
        showAuthError(/already registered|already been registered/.test(error.message||'') ? 'ეს ელ. ფოსტა უკვე რეგისტრირებულია — სცადე შესვლა' : error.message);
        if(btn) btn.disabled = false; return;
      }
      if(!data.session){
        // email-დადასტურება ჩართულია ამ პროექტზე — სესია მხოლოდ დადასტურების
        // ბმულზე დაჭერის შემდეგ გაჩნდება, ამიტომ "დაუყოვნებლივი დაწყება" ამ
        // შემთხვევაში შეუძლებელია საიტის დადასტურების პოლიტიკის გარეშე.
        const sub = document.getElementById('quizAuthSub');
        if(sub) sub.textContent = 'რეგისტრაცია წარმატებულია! ანგარიშის გასააქტიურებლად დაადასტურე ელ.ფოსტა, შემდეგ დაბრუნდი და თავიდან დააჭირე დაწყებას.';
        if(btn) btn.disabled = false;
        return;
      }
      // data.session არსებობს (email-დადასტურება გამორთულია) — sb.auth.onAuthStateChange
      // თავად გამოიძახებს applyAuthSession-ს, რომელიც _pendingAuthAction-საც გაუშვებს.
    } else {
      // R5: email ველი ახლა მეილი/ნიქნეიმი/ნომერი შეიძლება იყოს — '@'-იანი
      // შემთხვევა უცვლელად signInWithPassword-ზე მიდის, არა-'@'-იანი კი
      // ახალ login-with-identifier edge function-ზე (resolve+signIn
      // სერვერის მხარეს, რეალური მეილი ბრაუზერამდე არასდროს აღწევს).
      if(email.includes('@')){
        const { error } = await sb.auth.signInWithPassword({ email, password: pass });
        if(error){ showAuthError('არასწორი მეილი ან პაროლი'); if(btn) btn.disabled = false; return; }
      } else {
        let resp;
        try{ resp = await sb.functions.invoke('login-with-identifier', { body: { identifier: email, password: pass } }); }
        catch(e){ resp = { data: null, error: e }; }
        if(resp.error || !resp.data || !resp.data.ok || !resp.data.session){ showAuthError('არასწორი მეილი ან პაროლი'); if(btn) btn.disabled = false; return; }
        const { error: setErr } = await sb.auth.setSession({ access_token: resp.data.session.access_token, refresh_token: resp.data.session.refresh_token });
        if(setErr){ showAuthError('არასწორი მეილი ან პაროლი'); if(btn) btn.disabled = false; return; }
      }
    }
  }catch(e){
    showAuthError('დაფიქსირდა შეცდომა — სცადე თავიდან.');
    if(btn) btn.disabled = false;
  }
}

// PDF p5: ამ გვერდის ავტორიზაციის მოდალს (app.js-ის მთავარი auth-მოდალისგან
// დამოუკიდებელი, იხ. ფაილის თავი) Google-ით შესვლა საერთოდ არ ჰქონდა —
// app.js-ის handleGoogleAuth()-ის იდენტური ლოგიკა, მხოლოდ redirectTo
// განსხვავებულია: აქ მთელი მიმდინარე URL (search-ის ჩათვლით) გამოიყენება,
// რომ ?room=<კოდი> დეპ-ლინკი OAuth-ის შემდეგაც შემორჩეს — წინააღმდეგ
// შემთხვევაში მოწვეული, რომელსაც Google-ით შესვლა უწევდა, ოთახის კოდს
// დაკარგავდა გადამისამართების დროს.
async function handleQuizGoogleAuth(){
  if(!sb) { showAuthError('სერვერთან კავშირი ვერ დამყარდა.'); return; }
  const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.href } });
  if(error) showAuthError(error.message || 'Google-ით შესვლა ვერ მოხერხდა.');
}

(function initAuthModal(){
  const close = document.getElementById('quizAuthClose');
  if(close) close.addEventListener('click', cancelAuthModal);
  const bg = document.getElementById('quizAuthModal');
  if(bg) bg.addEventListener('click', e=>{ if(e.target === bg) cancelAuthModal(); });
  const googleBtn = document.getElementById('quizAuthGoogleBtn');
  if(googleBtn) googleBtn.addEventListener('click', handleQuizGoogleAuth);
  const submit = document.getElementById('quizAuthSubmit');
  if(submit) submit.addEventListener('click', doQuizAuthSubmit);
  const form = document.getElementById('quizAuthForm');
  if(form) form.addEventListener('submit', e=>{ e.preventDefault(); doQuizAuthSubmit(); });
})();

async function fetchAuthUser(session){
  if(!session) return null;
  let ud = null;
  try{
    const res = await sb.from('users').select('nick,icon,balance,avatar_url,avatar_type').eq('id', session.user.id).maybeSingle();
    ud = res.data;
  }catch(e){ console.warn('[quiz] auth user fetch failed:', e); }
  return {
    id: session.user.id,
    nick: ud?.nick || session.user.user_metadata?.nick || (session.user.email || '').split('@')[0],
    icon: ud?.icon || '🥊',
    balance: (ud && ud.balance != null) ? ud.balance : null,
    avatar_url: ud?.avatar_url || null, avatar_type: ud?.avatar_type || 'emoji'
  };
}

let currentAuthUser = null; // თუ null-ია — ვიზიტორი შესული არ არის; თამაშის დასაწყებად საჭიროა (requireAuth)

let _authApplying = false;
async function applyAuthSession(session){
  if(!session || _authApplying) return;
  _authApplying = true;
  try{
    const user = await fetchAuthUser(session);
    currentAuthUser = user;
    updateAuthNav(user);
    // თუ ავტორიზაცია სწორედ იმიტომ გამოვითხოვეთ, რომ მოთამაშეს ქვიზის დაწყება
    // სურდა — ახლა გავაგრძელოთ ზუსტად იქედან.
    if(_pendingAuthAction){
      const fn = _pendingAuthAction; _pendingAuthAction = null;
      closeAuthModal();
      fn();
    }
  }
  finally { _authApplying = false; }
}

if(sb){
  sb.auth.getSession()
    .then(({ data })=> (data && data.session) ? applyAuthSession(data.session) : null)
    .catch(()=>{});
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
  gameType:null,   // "quiz" | "guess"
  questions:[],
  gCluesShown:1,   // "ვინ ვარ?" — რამდენი მინიშნებაა ამჟამად გამოჩენილი
  qi:0,
  playerPicks:[],   // მოთამაშის არჩეული პასუხის ინდექსი / ტექსტი თითო კითხვაზე
  oppPicks:[],      // AI-ის არჩეული პასუხის ინდექსი / ტექსტი
  playerPoints:[],  // "ვინ ვარ?" — მოთამაშის ქულები თითო კითხვაზე (0-4)
  oppPoints:[],     // "ვინ ვარ?" — AI-ის ქულები თითო კითხვაზე
  aiAnswers:[],     // AI-ის სისწორე თითო კითხვაზე (bool)
  timerRaf:null,     // rAF ციკლის handle (requestQuestionTimer-ის)
  timerDeadline:0,   // performance.now() დროის ნიშნული, როცა დრო ამოიწურება
  timerTotal:0,      // მთლიანი ხანგრძლივობა ms-ში — მინიშნების ბონუსზე იზრდება, ბარის % ამის მიმართ ითვლება
  timerBar:null,     // მიმდინარე კითხვის bar <i> ელემენტი
  timerNum:null,     // მიმდინარე კითხვის წამების რიცხვი-ელემენტი
  timerOnTimeout:null,
  timerLastSec:null, // prefers-reduced-motion — ბოლოს ჩვენებული მთელი წამი, 1/წმ-ში განახლებისთვის
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
function show(id){
  // კითხვის ეკრანებიდან (quiz/guess) გასვლისას თაიმერის rAF ციკლი ყოველთვის
  // წყდება აქ ერთ ადგილას — არც ერთი stray loop არ რჩება ფონში.
  if(id !== "screen-quiz" && id !== "screen-guess") stopQuestionTimer();
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
    // get_ai_quiz_questions (supabase/quiz_no_repeat.sql) ირჩევს 10 კითხვას
    // სერვერზე, user-ის „ნანახის" ისტორიის გათვალისწინებით (no-repeat) —
    // კლიენტს აღარ სჭირდება მთელი პულის წამოღება/shuffle/slice.
    const { data, error } = await sb.rpc('get_ai_quiz_questions', { p_game_type: 'quiz', p_level: dbLevel });
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
    // იხ. ზემოთ fetchQuestions-ის შენიშვნა — იგივე no-repeat RPC, guess-who პულზე.
    const { data, error } = await sb.rpc('get_ai_quiz_questions', { p_game_type: 'guess', p_level: dbLevel });
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
   წინააღმდეგ" (startPvpSetup — PvP ჯგუფური ოთახი, იხ. §2.5 ქვემოთ).
   data-locked მხარდაჭერა დარჩენილია მომავალში ხელახლა გამოსაყენებლად,
   თუ ოდესმე კიდევ რომელიმე ბარათი დაიბლოკება.
   ============================================================ */
$$("#screen-mode .mode").forEach(card=>{
  if(card.dataset.locked === "true") return; // მომავალში ჯერ არ ჩართული ბარათებისთვის
  const go = ()=> startLobby(card.dataset.mode);
  card.addEventListener("click", go);
  card.addEventListener("keydown", e=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); go(); }});
});

/* ============================================================
   2) ლობი — სირთულის არჩევა, შემდეგ "დაწყება"
   ============================================================ */
function startLobby(mode){
  if(mode === "pvp"){ startPvpSetup(); return; }
  if(mode !== "ai") return; // დაცვა — დანარჩენი არაცნობილი რეჟიმებისთვის
  $("#lobby-belt").textContent = "აირჩიე სირთულე";

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
  startBtn.onclick = ()=>{
    if(S.aiAcc == null) return;
    requireAuth(()=> startDifficulty());
  };
  async function startDifficulty(){
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
   2.5) PvP — ჯგუფური ოთახი (ჰოსტი + 8-მდე მეგობარი)
   იხ. supabase/quiz_group_pvp.sql. კითხვა-პასუხის ეკრანები (screen-quiz /
   screen-guess) AI-ის რეჟიმის იდენტურია — სხვაობა მხოლოდ: 1) პასუხები
   ემატება სერვერზე (submit_quiz_answer) ავტორიტეტული ქულის დასათვლელად,
   2) ბოლო კითხვის შემდეგ კარტების ბრძოლის ნაცვლად "ველოდებით
   დანარჩენებს" ეკრანზე გადადის, სანამ ოთახის ყველა მოთამაშე არ
   დაასრულებს (PRD §2.4 — ჯგუფურ რეჟიმში კითხვა-კითხვაზე reveal არ არის).
   ============================================================ */
let PVP = null; // { roomId, code, isHost, myId, myName, maxPlayers, players, started, resultsShown }

function resetPvp(){
  if(PVP){
    try{ if(PVP.playersChannel) sb.removeChannel(PVP.playersChannel); }catch(e){}
    try{ if(PVP.roomChannel) sb.removeChannel(PVP.roomChannel); }catch(e){}
  }
  PVP = null;
}

function startPvpSetup(){
  resetPvp();
  const diffWrap = $("#pvp-create-diff");
  diffWrap.innerHTML = "";
  let chosenLevel = null;
  const createBtn = $("#pvp-create-btn");
  createBtn.disabled = true;
  createBtn.textContent = "ოთახის შექმნა";

  const chips = document.createElement("div");
  chips.className = "diff-chips";
  DIFFICULTY.forEach(d=>{
    const c = document.createElement("button");
    c.className = "chip"; c.textContent = d.label + (d.enabled ? "" : " 🔒");
    if(!d.enabled){
      c.disabled = true;
      c.title = "მალე დაემატება — ჯერ არ არის კითხვები ამ დონეზე სერვერზე.";
    } else {
      c.onclick = ()=>{
        chosenLevel = d.dbLevel;
        chips.querySelectorAll(".chip").forEach(x=> x.classList.remove("sel"));
        c.classList.add("sel");
        createBtn.disabled = false;
      };
    }
    chips.appendChild(c);
  });
  diffWrap.appendChild(chips);
  const defaultChip = Array.from(chips.children).find((_,i)=> DIFFICULTY[i].enabled);
  if(defaultChip) defaultChip.click();

  createBtn.onclick = ()=> requireAuth(()=> createPvpRoom(chosenLevel));

  const codeInput = $("#pvp-join-code");
  const joinErr = $("#pvp-join-error");
  joinErr.style.display = "none";
  // დეპ-ლინკი (fnf.ge/ufc/quiz/?room=ABC123) — კოდი წინასწარ ივსება.
  const urlCode = new URLSearchParams(location.search).get("room");
  codeInput.value = urlCode ? urlCode.toUpperCase() : "";

  $("#pvp-join-btn").onclick = ()=> requireAuth(()=> joinPvpRoom(codeInput.value));

  show("screen-pvp-setup");
}

function pvpErrorMessage(err){
  const msg = (err && err.message) || "";
  if(msg.includes("room not found")) return "ასეთი ოთახი ვერ მოიძებნა.";
  if(msg.includes("room expired")) return "ოთახს ვადა გაუვიდა.";
  if(msg.includes("already full or finished")) return "ოთახი უკვე დაწყებულია ან დასრულდა.";
  if(msg.includes("room is full")) return "ოთახი სავსეა.";
  if(msg.includes("own room")) return "საკუთარ ოთახში ვერ შეხვალ.";
  return msg || "დაფიქსირდა შეცდომა — სცადე თავიდან.";
}

async function createPvpRoom(level){
  if(!level || !sb) return;
  const btn = $("#pvp-create-btn");
  btn.disabled = true; btn.textContent = "იქმნება…";
  try{
    const { data, error } = await sb.rpc('create_quiz_room', { p_game_type: S.gameType || 'quiz', p_level: level });
    if(error || !data || !data.length){
      alert("ოთახის შექმნა ვერ მოხერხდა: " + pvpErrorMessage(error));
      btn.disabled = false; btn.textContent = "ოთახის შექმნა";
      return;
    }
    const row = data[0];
    S.gameType = S.gameType || 'quiz';
    enterPvpLobby({ roomId: row.room_id, code: row.code, isHost: true, questions: row.questions });
  }catch(e){
    alert("დაფიქსირდა შეცდომა — სცადე თავიდან.");
    btn.disabled = false; btn.textContent = "ოთახის შექმნა";
  }
}

async function joinPvpRoom(codeRaw){
  const code = (codeRaw || "").trim().toUpperCase();
  const err = $("#pvp-join-error");
  err.style.display = "none";
  if(code.length < 4){ err.textContent = "შეიყვანე სწორი კოდი."; err.style.display = "block"; return; }
  if(!sb) return;
  const btn = $("#pvp-join-btn");
  btn.disabled = true; btn.textContent = "შედის…";
  try{
    const { data, error } = await sb.rpc('join_quiz_room', { p_code: code });
    if(error || !data || !data.length){
      err.textContent = pvpErrorMessage(error);
      err.style.display = "block";
      btn.disabled = false; btn.textContent = "ოთახში შესვლა";
      return;
    }
    const row = data[0];
    S.gameType = row.game_type;
    enterPvpLobby({ roomId: row.room_id, code, isHost: false, questions: row.questions });
  }catch(e){
    err.textContent = "დაფიქსირდა შეცდომა — სცადე თავიდან.";
    err.style.display = "block";
    btn.disabled = false; btn.textContent = "ოთახში შესვლა";
  }
}

function enterPvpLobby({ roomId, code, isHost, questions }){
  PVP = {
    roomId, code, isHost,
    myId: currentAuthUser && currentAuthUser.id,
    myName: currentAuthUser && currentAuthUser.nick,
    players: [],
    avatarsById: {},
    maxPlayers: 9,
    questions: questions || [],
    started: false,
    resultsShown: false,
  };
  $("#pvp-room-code").textContent = code;
  const startBtn = $("#pvp-start-btn");
  startBtn.style.display = isHost ? "" : "none";
  startBtn.disabled = true;
  startBtn.textContent = "დაწყება";
  $("#pvp-lobby-hint").textContent = isHost ? "ველოდებით მინიმუმ 1 მეგობარს..." : "ველოდებით ჰოსტს დაწყებას...";
  $("#pvp-lobby-hint").style.display = "";
  renderPvpLobbyList();
  subscribePvpRoom();
  refreshPvpPlayers();
  show("screen-pvp-lobby");
}

function subscribePvpRoom(){
  if(!sb || !sb.channel || !PVP) return;
  PVP.playersChannel = sb.channel("pvp-players-" + PVP.roomId)
    .on("postgres_changes", { event: "*", schema: "public", table: "quiz_room_players", filter: `room_id=eq.${PVP.roomId}` },
      ()=> refreshPvpPlayers())
    .subscribe();
  PVP.roomChannel = sb.channel("pvp-room-" + PVP.roomId)
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "quiz_rooms", filter: `id=eq.${PVP.roomId}` },
      payload=>{
        const row = payload.new || {};
        if(row.status === "active") onPvpRoomActive();
        else if(row.status === "finished") onPvpRoomFinished();
        else if(row.status === "abandoned") onPvpRoomAbandoned();
      })
    .subscribe();
}

async function fetchPvpAvatars(){
  if(!PVP || !sb) return;
  try{
    const { data, error } = await sb.rpc('get_quiz_room_player_avatars', { p_room_id: PVP.roomId });
    if(error){ console.warn("[quiz] PvP avatars fetch failed:", error.message || error); return; }
    (data || []).forEach(row=>{ PVP.avatarsById[row.player_id] = row; });
  }catch(e){ console.warn("[quiz] PvP avatars fetch failed:", e); }
}

function pvpAvatarHtml(playerId){
  const a = PVP && PVP.avatarsById && PVP.avatarsById[playerId];
  if(a && a.avatar_type === "photo" && a.avatar_url) return `<img src="${a.avatar_url}" alt="" />`;
  return (a && a.icon) || "🥊";
}

async function refreshPvpPlayers(){
  if(!PVP || !sb) return;
  const { data, error } = await sb
    .from("quiz_room_players")
    .select("player_id,player_name,is_host,finished_at")
    .eq("room_id", PVP.roomId)
    .order("joined_at", { ascending: true });
  if(error){ console.warn("[quiz] PvP player list fetch failed:", error); return; }
  PVP.players = data || [];
  await fetchPvpAvatars();
  const lobbyEl = document.getElementById("screen-pvp-lobby");
  const waitEl = document.getElementById("screen-pvp-wait");
  if(lobbyEl && lobbyEl.classList.contains("active")) renderPvpLobbyList();
  if(waitEl && waitEl.classList.contains("active")) renderPvpWaitCount();
}

function renderPvpLobbyList(){
  if(!PVP) return;
  const list = $("#pvp-players-list"); list.innerHTML = "";
  PVP.players.forEach(p=>{
    const row = document.createElement("div");
    row.className = "pvp-player";
    const isMe = p.player_id === PVP.myId;
    row.innerHTML = `<span class="ava">${pvpAvatarHtml(p.player_id)}</span>`+
      `<span class="nm">${p.player_name}${isMe ? " (შენ)" : ""}</span>`+
      (p.is_host ? `<span class="tag">ჰოსტი</span>` : "");
    list.appendChild(row);
  });
  // PDF p9: ბოლო მოთამაშის ქვეშ — ცარიელი ადგილების გრაფა, ვიზუალურად
  // რომ ჩანდეს თავისუფალი ადგილი და ველოდებით კიდევ ვინმეს.
  const emptySeats = Math.max(0, PVP.maxPlayers - PVP.players.length);
  for(let i=0; i<emptySeats; i++){
    const row = document.createElement("div");
    row.className = "pvp-player-empty";
    row.innerHTML = `<span class="ava">+</span><span class="nm">თავისუფალი ადგილი</span>`;
    list.appendChild(row);
  }
  $("#pvp-players-count").textContent = `${PVP.players.length} / ${PVP.maxPlayers} მოთამაშე`;
  if(PVP.isHost){
    const enough = PVP.players.length >= 2;
    $("#pvp-start-btn").disabled = !enough;
    $("#pvp-lobby-hint").style.display = enough ? "none" : "";
  }
}

function renderPvpWaitCount(){
  if(!PVP) return;
  const finished = PVP.players.filter(p=> p.finished_at).length;
  $("#pvp-wait-count").textContent = `${finished} / ${PVP.players.length} დაასრულა`;
}

function onPvpRoomActive(){
  if(!PVP || PVP.started) return;
  PVP.started = true;
  S.questions = PVP.questions || [];
  S.qi = 0;
  S.playerPicks = []; S.playerPoints = [];
  if(S.gameType === "guess") S.gCluesShown = 1;
  show(S.gameType === "guess" ? "screen-guess" : "screen-quiz");
  renderQuestion();
}

function finishPvpQuiz(){
  show("screen-pvp-wait");
  renderPvpWaitCount();
}

async function submitPvpAnswer(qIndex, pick){
  if(!PVP || !sb) return;
  try{
    const { error } = await sb.rpc('submit_quiz_answer', { p_room_id: PVP.roomId, p_question_index: qIndex, p_pick: pick });
    if(error) console.warn("[quiz] PvP submit_quiz_answer failed:", error.message || error);
  }catch(e){ console.warn("[quiz] PvP submit_quiz_answer failed:", e); }
}

async function revealPvpClue(qIndex){
  if(!PVP || !sb) return;
  try{
    const { error } = await sb.rpc('reveal_quiz_clue', { p_room_id: PVP.roomId, p_question_index: qIndex });
    if(error) console.warn("[quiz] PvP reveal_quiz_clue failed:", error.message || error);
  }catch(e){ console.warn("[quiz] PvP reveal_quiz_clue failed:", e); }
}

async function onPvpRoomFinished(){
  if(!PVP || PVP.resultsShown) return;
  PVP.resultsShown = true;
  try{
    const { data, error } = await sb.rpc('get_quiz_results', { p_room_id: PVP.roomId });
    if(error || !data || !data.length){
      alert("შედეგების ჩატვირთვა ვერ მოხერხდა.");
      return;
    }
    renderPvpResults(data[0]);
    show("screen-pvp-results");
  }catch(e){ console.warn("[quiz] PvP get_quiz_results failed:", e); }
}

function onPvpRoomAbandoned(){
  if(!PVP) return;
  alert("ოთახი დაიხურა.");
  resetPvp();
  S.gameType = null;
  show("screen-mode");
}

function renderPvpResults(result){
  const players = (result && result.players) || [];
  const podiumEl = $("#pvp-podium"); podiumEl.innerHTML = "";
  const restEl = $("#pvp-rest-list"); restEl.innerHTML = "";

  const top3 = players.slice(0, 3);
  const slots = [ { idx:1, cls:"p2" }, { idx:0, cls:"p1" }, { idx:2, cls:"p3" } ];
  slots.forEach(s=>{
    const p = top3[s.idx];
    const slot = document.createElement("div");
    slot.className = "podium-slot " + s.cls;
    if(!p){ slot.style.visibility = "hidden"; podiumEl.appendChild(slot); return; }
    const isMe = PVP && p.player_id === PVP.myId;
    // PDF p1: პოდიუმში ემოჯის ნაცვლად მოთამაშის რეალური სურათი/აიქონი —
    // ფერადი რგოლი (ოქრო/ვერცხლი/ბრინჯაო) კი .podium-slot.pN-ზეა, უცვლელი.
    const avaHtml = (p.avatar_type === "photo" && p.avatar_url) ? `<img src="${p.avatar_url}" alt="" />` : (p.icon || "🥊");
    slot.innerHTML = `<div class="podium-ring">${avaHtml}</div>`+
      `<div class="podium-nm">${p.player_name}${isMe ? " (შენ)" : ""}</div>`+
      `<div class="podium-pts">${p.total_score} ქულა</div>`+
      `<div class="podium-base"></div>`;
    podiumEl.appendChild(slot);
  });

  players.slice(3).forEach((p,i)=>{
    const isMe = PVP && p.player_id === PVP.myId;
    const row = document.createElement("div");
    row.className = "pvp-rest-row";
    row.innerHTML = `<span class="rank">${i+4}</span>`+
      `<span class="nm">${p.player_name}${isMe ? " (შენ)" : ""}</span>`+
      `<span class="pts">${p.total_score}</span>`;
    restEl.appendChild(row);
  });
}

$("#back-to-mode-from-pvp").addEventListener("click", ()=>{ resetPvp(); show("screen-mode"); });

$("#pvp-leave-btn").addEventListener("click", async ()=>{
  if(PVP){ try{ await sb.rpc('leave_quiz_room', { p_room_id: PVP.roomId }); }catch(e){} }
  resetPvp();
  show("screen-mode");
});

$("#pvp-start-btn").addEventListener("click", async ()=>{
  if(!PVP || !PVP.isHost) return;
  const btn = $("#pvp-start-btn");
  btn.disabled = true; btn.textContent = "იწყება…";
  try{
    const { error } = await sb.rpc('start_quiz_room', { p_room_id: PVP.roomId });
    if(error){
      alert("დაწყება ვერ მოხერხდა: " + pvpErrorMessage(error));
      btn.disabled = false; btn.textContent = "დაწყება";
    }
    // წარმატების შემთხვევაში quiz_rooms-ის Realtime UPDATE (status->active)
    // თავად გამოიძახებს onPvpRoomActive()-ს ყველასთვის, ჰოსტის ჩათვლით.
  }catch(e){
    alert("დაფიქსირდა შეცდომა.");
    btn.disabled = false; btn.textContent = "დაწყება";
  }
});

$("#pvp-copy-link").addEventListener("click", ()=>{
  if(!PVP) return;
  const url = location.origin + "/ufc/quiz/?room=" + PVP.code;
  const btn = $("#pvp-copy-link");
  const done = ()=>{ btn.textContent = "დაკოპირდა ✓"; setTimeout(()=> btn.textContent = "ოთახის ლინკის კოპირება", 1500); };
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(url).then(done).catch(()=> prompt("დააკოპირე ბმული:", url));
  } else {
    prompt("დააკოპირე ბმული:", url);
  }
});

$("#pvp-copy-code").addEventListener("click", ()=>{
  if(!PVP) return;
  const btn = $("#pvp-copy-code");
  const done = ()=>{ btn.textContent = "დაკოპირდა ✓"; setTimeout(()=> btn.textContent = "კოდის კოპირება", 1500); };
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(PVP.code).then(done).catch(()=> prompt("დააკოპირე კოდი:", PVP.code));
  } else {
    prompt("დააკოპირე კოდი:", PVP.code);
  }
});

$("#pvp-results-done").addEventListener("click", ()=>{
  resetPvp();
  S.gameType = null;
  show("screen-gametype");
});

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

  // pool უკვე სერვერზეა შერჩეული (no-repeat RPC, იხ. fetchQuestions/
  // fetchGuessQuestions) — აქ აღარ სჭირდება ხელახალი shuffle/slice.
  S.questions = pool;
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

/* ---------- კითხვის თაიმერი — საერთო ძრავა (#q-timer და #gq-timer) ----------
   ერთადერთი წყარო დროისთვის: S.timerDeadline (performance.now() ნიშნული).
   ბარის % და წამების რიცხვი ყოველ ფრეიმზე ამის მიხედვით ითვლება (rAF) —
   მინიშნების ბონუსი უბრალოდ deadline-ს და total-ს წევს წინ, ასე რომ ბარი
   ახალ სიგრძემდე CSS width-ტრანზიციით გლუვად "იზრდება", ნაცვლად ხტომისა. */
function stopQuestionTimer(){
  if(S.timerRaf) cancelAnimationFrame(S.timerRaf);
  S.timerRaf = null;
  S.timerLastSec = null;
}

function startQuestionTimer(bar, num, totalMs, onTimeout){
  stopQuestionTimer();
  S.timerBar = bar;
  S.timerNum = num;
  S.timerTotal = totalMs;
  S.timerDeadline = performance.now() + totalMs;
  S.timerOnTimeout = onTimeout;
  bar.style.width = "100%";
  bar.classList.remove("amber","red");
  if(num) num.textContent = Math.ceil(totalMs/1000);
  S.timerRaf = requestAnimationFrame(tickQuestionTimer);
}

function extendQuestionTimer(bonusMs){
  if(!S.timerRaf) return;
  S.timerDeadline += bonusMs;
  S.timerTotal += bonusMs;
}

function tickQuestionTimer(){
  const remaining = S.timerDeadline - performance.now();
  const sec = Math.max(0, Math.ceil(remaining/1000));

  // ჩვეულებრივ ყოველ ფრეიმზე ვნახავთ; prefers-reduced-motion-ში — მხოლოდ
  // მაშინ, როცა მთელი წამი იცვლება (იგივე სიხშირით, რითაც რიცხვი).
  if(!REDUCE_MOTION || sec !== S.timerLastSec){
    S.timerLastSec = sec;
    if(S.timerNum) S.timerNum.textContent = sec;
    if(S.timerBar){
      const pct = REDUCE_MOTION
        ? Math.max(0, Math.min(100, (sec*1000/S.timerTotal)*100))
        : Math.max(0, Math.min(100, (remaining/S.timerTotal)*100));
      S.timerBar.style.width = pct + "%";
      S.timerBar.classList.toggle("red", remaining <= TIMER_RED_MS);
      S.timerBar.classList.toggle("amber", remaining > TIMER_RED_MS && remaining <= TIMER_AMBER_MS);
    }
  }

  if(remaining <= 0){
    S.timerRaf = null;
    const cb = S.timerOnTimeout;
    S.timerOnTimeout = null;
    if(cb) cb();
    return;
  }
  S.timerRaf = requestAnimationFrame(tickQuestionTimer);
}

function startTimer(){
  const totalMs = (PVP ? PVP_TIME_PER_Q : TIME_PER_Q) * 1000;
  startQuestionTimer($("#q-timer"), $("#q-timer-num"), totalMs, ()=> answer(-1, null));
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

  startGuessTimer();
}

// PDF p7-p8: "ვინ ვარ?" — 30 წამი (PvP-ის და AI-ის წინააღმდეგ ორივეში),
// ყოველი ახალი მინიშნება +5 წამს მატებს (ქულის ჯარიმა უცვლელი რჩება —
// reveal_quiz_clue-ს არსებული ლოგიკა, ახალი scoring არაფერი დამატებული).
// დრო რომ ამოიწურება, submitGuess(true) იძახება — "ნაძალადევი" submit,
// ცარიელი ველის დაბლოკვის გარეშე, ყოველთვის გადადის შემდეგ კითხვაზე.
function startGuessTimer(){
  $("#gq-timer-row").style.display = "";
  startQuestionTimer($("#gq-timer"), $("#gq-timer-num"), PVP_TIME_PER_Q*1000, ()=> submitGuess(true));
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

function submitGuess(forced){
  const item = S.questions[S.qi];
  const val = ($("#gq-input").value || "").trim();

  // PDF p7-p8: PvP-ში ცარიელი ველით "პასუხის გაცემა" დაჭერა (დრო ჯერ არ
  // ამოწურულა — forced არ არის) იბლოკება, წითლად "ველი ცარიელია" —
  // მხოლოდ დროის ამოწურვა (startGuessTimer-ის submitGuess(true))
  // გადადის ცარიელი ველითაც ავტომატურად შემდეგ კითხვაზე.
  if(PVP && !forced && !val){
    const fb = $("#gq-feedback");
    fb.classList.add("show","bad");
    fb.classList.remove("ok");
    fb.innerHTML = `<span style="color:var(--red)">ველი ცარიელია</span>`;
    return;
  }

  stopQuestionTimer();
  $("#gq-answer-area").style.display = "none";
  const fb = $("#gq-feedback");
  fb.classList.add("show");

  S.playerPicks[S.qi] = val;

  if(PVP){
    // PvP ანტი-ჩიტის დიზაინით (quiz_group_pvp.sql) კლიენტს სწორი პასუხი
    // საერთოდ არ მოსდის — ლოკალური შემოწმება/reveal ჯგუფურ რეჟიმში აღარ
    // ხდება (PRD §2.4: პირდაპირ podium, შუალედური reveal გარეშე). ქულას
    // სერვერი ითვლის submit_quiz_answer-ში, სრული სურათი get_quiz_results-ით
    // ჩანს თამაშის ბოლოს. PDF p6: შუალედური "პასუხი გაგზავნილია" ტექსტის
    // მაგივრად — დუმილად, პირდაპირ შემდეგ კითხვაზე.
    S.playerPoints[S.qi] = 0;
    submitPvpAnswer(S.qi, val);
    advanceGuessQuestion();
    return;
  }

  const result = val ? isGuessCorrect(val, item.answer) : { correct:false, exact:false };
  const points = result.correct ? Math.max(1, Math.min(4, 5 - S.gCluesShown)) : 0;
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

  const nextBtn = $("#gq-next-q");
  nextBtn.style.display = "";
  nextBtn.onclick = ()=> advanceGuessQuestion();
}

function advanceGuessQuestion(){
  S.qi++;
  advanceOrFinish();
}

$("#gq-next-clue").addEventListener("click", ()=>{
  const item = S.questions[S.qi];
  if(!item) return;
  if(S.gCluesShown < item.clues.length){
    S.gCluesShown++;
    renderGuessClues();
    if(PVP) revealPvpClue(S.qi);
    extendQuestionTimer(PVP_GUESS_CLUE_BONUS*1000);
    if(S.gCluesShown >= item.clues.length) $("#gq-next-clue").disabled = true;
  }
});
$("#gq-submit").addEventListener("click", ()=> submitGuess());
$("#gq-input").addEventListener("keydown", e=>{ if(e.key==="Enter"){ e.preventDefault(); submitGuess(); }});

function answer(chosen, btn){
  stopQuestionTimer();
  const opts = $$("#q-opts .opt");
  opts.forEach(o=> o.disabled = true);
  if(chosen>=0){
    opts[chosen].classList.add("chosen");
    opts.forEach((o,i)=>{ if(i!==chosen) o.classList.add("dim"); });
  }
  S.playerPicks[S.qi] = chosen; // -1 თუ დრო ამოიწურა
  if(PVP) submitPvpAnswer(S.qi, chosen);

  setTimeout(()=>{
    S.qi++;
    advanceOrFinish();
  }, chosen>=0 ? 620 : 300);
}

/* PvP-ში "შემდეგი კითხვა / დასრულება" იგივეა, რაც AI-ის წინააღმდეგ — გარდა
   იმისა, რომ ბოლო კითხვის შემდეგ კარტების ბრძოლის ნაცვლად (ეს მხოლოდ AI-ის
   წინააღმდეგ რეჟიმშია საჭირო) პირდაპირ "ველოდებით დანარჩენებს" ეკრანზე
   გადადის, სანამ ოთახის ყველა მოთამაშე არ დაასრულებს (PRD §2.4). */
function advanceOrFinish(){
  if(S.qi >= S.questions.length){
    if(PVP){ finishPvpQuiz(); } else { finishQuiz(); }
  } else {
    renderQuestion();
  }
}

/* ============================================================
   4) ქვიზი დასრულდა → AI-ის წინააღმდეგ პირდაპირ კარტების ბრძოლაზე.
   ============================================================ */
function finishQuiz(){
  startCardBattle();
}

/* ============================================================
   5) კარტების ბრძოლა
   ============================================================ */
function startCardBattle(){
  S.bIndex = 0; S.cbYou = 0; S.cbOpp = 0;
  // QuizUpdates.pdf: ორივე მხარეს საკუთარი ნიკი უნდა ჩანდეს (არა უბრალოდ
  // "შენ") — ახლა ავტორიზაცია სავალდებულოა, ამიტომ currentAuthUser ყოველთვის
  // არსებობს ამ მომენტისთვის.
  const myLab = ((currentAuthUser && currentAuthUser.nick) || "შენ").slice(0,14);
  const oppAva = "🤖";
  const oppLab = "AI";
  $("#cb-you").textContent = "0";
  $("#cb-opp").textContent = "0";
  $("#cb-you-tag").textContent = "🤠 " + myLab;
  $("#cb-opp-ava").textContent = oppAva;
  $("#cb-opp-lab").textContent = oppLab;
  $("#qb-you-who").textContent = "🤠 " + myLab;
  $("#qb-opp-ava").textContent = oppAva;
  $("#qb-opp-lab2").textContent = oppLab;
  const review = document.getElementById('cbReview');
  if(review) review.style.display = "none";
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
  renderReview();
}

/* ---------- QuizUpdates.pdf: თამაშის დასრულების შემდეგ ყველა კითხვა-
   პასუხის მუდმივი სია (არა მხოლოდ კარტების ანიმაციის გავლისას გამოჩენილი
   წამიერი ჩანაწერი). ---- */
function renderReview(){
  const wrap = document.getElementById('cbReview');
  const list = document.getElementById('cbReviewList');
  if(!wrap || !list) return;
  const myLab = ((currentAuthUser && currentAuthUser.nick) || "შენ").slice(0,14);
  const oppLab = "AI";
  const oppIco = "🤖";

  list.innerHTML = "";
  S.questions.forEach((item, i)=>{
    let correctText, pText, oText, pOk, oOk;
    if(S.gameType === "guess"){
      correctText = item.answer;
      pText = (S.playerPicks[i] && String(S.playerPicks[i]).trim()) ? S.playerPicks[i] : "პასუხი არ გაეცა";
      oText = (S.oppPicks[i] && String(S.oppPicks[i]).trim()) ? S.oppPicks[i] : "—";
      pOk = (S.playerPoints[i] || 0) > 0;
      oOk = (S.oppPoints[i] || 0) > 0;
    } else {
      correctText = item.o[item.a];
      pText = (S.playerPicks[i] >= 0 && item.o[S.playerPicks[i]] != null) ? item.o[S.playerPicks[i]] : "პასუხი არ გაეცა";
      oText = (S.oppPicks[i] >= 0 && item.o[S.oppPicks[i]] != null) ? item.o[S.oppPicks[i]] : "—";
      pOk = S.playerPicks[i] === item.a; oOk = S.oppPicks[i] === item.a;
    }
    const qText = item.q || (item.clues && item.clues[0]) || "";
    const row = document.createElement("div");
    row.className = "cb-review-item";
    row.innerHTML = `
      <div class="cb-review-q"><span class="cb-review-num">${i+1}.</span>${qText}</div>
      <div class="cb-review-a ${pOk ? "ok" : "bad"}">🤠 ${myLab}: ${pText}</div>
      <div class="cb-review-a ${oOk ? "ok" : "bad"}">${oppIco} ${oppLab}: ${oText}</div>
      <div class="cb-review-correct">✓ სწორი პასუხი: ${correctText}</div>`;
    list.appendChild(row);
  });
  wrap.style.display = "";
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
  stopQuestionTimer(); clearTimeout(S.cbTimer); clearTimeout(S.cbReveal);
  S.gameType = null;
  show("screen-gametype");
}
