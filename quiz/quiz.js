// ============================================================
//  quiz/quiz.js — UFC + Football ქვიზი (ქვიზი + "ვინ ვარ?", AI-ის და
//  ადამიანის წინააღმდეგ). ადრე ufc/quiz.js იყო, ერთადერთ გვერდზე
//  (ufc/quiz/index.html) ჩატვირთული -- Task 1 (quiz URL restructure)-ის
//  შემდეგ სამივე რეალურ გვერდზეა გაზიარებული: /quiz/ (სპორტის ამრჩევი),
//  /quiz/ufcquiz/, /quiz/footballquiz/ (იხ. quizRootForSport/
//  QUIZ_DEFAULT_SPORT ქვემოთ). /ufc/quiz/ ახლა მხოლოდ რედირექტია.
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
const TIME_PER_Q         = 30;   // წამი თითო კითხვაზე (მრავალპასუხიანი ქვიზი, AI-ის წინააღმდეგ)
const PVP_TIME_PER_Q     = 30;   // PDF p7: PvP-ში (ორივე ტიპი) — 30 წამი თითო კითხვაზე, AI-ის 15-ისგან დამოუკიდებლად
const GUESS_TIME_PER_Q   = 40;   // "ვინ ვარ?" — 40 წამი თითო კითხვაზე, AI-ის და PvP-ის წინააღმდეგ ორივეში (TIME_PER_Q/PVP_TIME_PER_Q-სგან დამოუკიდებლად, ჩვეულებრივ ქვიზს არ ეხება)
const PVP_GUESS_CLUE_BONUS = 5;  // PDF p7: "ვინ ვარ?" PvP-ში ყოველი ახალი მინიშნება +5 წამს მატებს დროს
const TIMER_AMBER_MS = 10000; // ბოლო ~10 წამი — ბარი ყვითლდება
const TIMER_RED_MS   = 5000;  // ბოლო ~5 წამი — ბარი წითლდება

// PvP away/forfeit budget (server-authoritative, see quiz_pvp_away_budget_seconds()
// in supabase/quiz_leave_v2.sql) — hardcoded here only for the client-side
// recovery-banner countdown display, never to decide an actual forfeit.
const PVP_AWAY_BUDGET_MS = 20000;
// PvP AFK rule: after this many *consecutive* timed-out questions, every
// following question's timer shrinks to AFK_SHORT_TIME_MS and a
// "დაბრუნება" button appears — see updateAfkButtonVisibility/startTimer/startGuessTimer.
const AFK_TIMEOUT_THRESHOLD = 2;
const AFK_SHORT_TIME_MS = 5000;

/* ============================================================
   Task 1 (quiz URL restructure): three real static roots now exist --
   /quiz/ (sport picker), /quiz/ufcquiz/ (UFC), /quiz/footballquiz/
   (Football) -- each a real file/directory so a direct visit or refresh
   works without server-side rewrites (GitHub Pages has none). The
   canonical root for address-bar/pushState/share-link purposes is derived
   from S.sport (quizRootForSport), not fixed at page load: choosing a
   sport from the bare /quiz/ picker moves the canonical root to the
   matching sport page, which is what 404.html's mirrored ufcquiz/
   footballquiz shims expect a deep refresh to land back on.
   QUIZ_DEFAULT_SPORT reads which of the three roots this load started on,
   so /quiz/ufcquiz/ and /quiz/footballquiz/ boot straight into their sport
   (skipping screen-sport) exactly like the old ?sport=ufc/?sport=football
   deep link already did, while bare /quiz/ still shows the picker. ============================================================ */
function quizRootForSport(sport){
  if(sport === 'UFC') return '/quiz/ufcquiz/';
  if(sport === 'Football') return '/quiz/footballquiz/';
  return '/quiz/';
}
const QUIZ_DEFAULT_SPORT = (function(){
  if(typeof location === "undefined") return null;
  var p = location.pathname;
  if(p.indexOf('/quiz/ufcquiz/') === 0) return 'UFC';
  if(p.indexOf('/quiz/footballquiz/') === 0) return 'Football';
  return null;
})();

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
// XSS hardening (Phase 8): nick/avatar_url/player_name are user-editable
// (the 3-20-char nick format rule is enforced client-side only -- the DB
// CHECK constraint in supabase/users_nick_constraint.sql is not applied
// yet) and get interpolated into innerHTML below and further down (PvP
// lobby/podium/results). escapeHtml() is also safe for the
// <img src="..."> attribute context specifically because it escapes the
// quote characters, which is what actually matters there -- it doesn't
// need URL-scheme validation, since <img src> (unlike <a href>) can't
// execute a javascript: URI.
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// Phase Q3: ნავში ავატარი ფოტოს პრეფერირებს, თუ users.avatar_type==='photo'.
function navAvaHtml(user){
  return (user.avatar_type === 'photo' && user.avatar_url)
    ? `<img src="${escapeHtml(user.avatar_url)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`
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
      navUser.innerHTML = `<span class="nav-ava">${navAvaHtml(user)}</span><span class="nav-nick">${escapeHtml(user.nick)}</span>
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
let _pendingAuthIntent = null; // serializable description of _pendingAuthAction, for the Google-redirect case (see persistPendingIntent/resumePendingIntent below)
let _authModalMode = 'signin';

function requireAuth(action, intent){
  if(currentAuthUser){ action(); return; }
  _pendingAuthAction = action;
  _pendingAuthIntent = intent || null;
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
function cancelAuthModal(){ _pendingAuthAction = null; _pendingAuthIntent = null; closeAuthModal(); }

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
  // პაროლის ავტომატური "ძლიერი პაროლის" შეთავაზება: ერთ ველზე autocomplete-ის
  // გადართვა (ძველი მიდგომა) არ მუშაობდა -- Chrome ველს პირველი რენდერის
  // მიხედვით განსაზღვრავს და მერე აღარ გადაანალიზებს. ორი ცალკე, სტაბილური
  // ID-ითა და ფიქსირებული autocomplete-ით ველი (quizAuthPassLogin/
  // quizAuthPassReg) + display-ის გადართვა ხსნის ამას სტრუქტურულად, app.js-ის
  // openModal()-ის იგივე ფიქსის ანალოგიურად.
  const passFieldLogin = document.getElementById('quizAuthPassFieldLogin');
  const passFieldReg = document.getElementById('quizAuthPassFieldReg');
  const passLoginInput = document.getElementById('quizAuthPassLogin');
  const passRegInput = document.getElementById('quizAuthPassReg');
  if(passLoginInput) passLoginInput.value = '';
  if(passRegInput) passRegInput.value = '';
  if(mode === 'signup'){
    if(nickField) nickField.style.display = '';
    if(title) title.textContent = 'რეგისტრაცია';
    if(sub) sub.textContent = 'თამაშის დასაწყებად საჭიროა ანგარიში.';
    if(submitBtn) submitBtn.textContent = 'რეგისტრაცია';
    if(switchWrap) switchWrap.innerHTML = 'უკვე გაქვს ანგარიში? <button type="button" id="quizAuthSwitchBtn">შესვლა</button>';
    if(emailLabel) emailLabel.textContent = 'ელ. ფოსტა';
    if(emailInput){
      emailInput.placeholder = 'შეიყვანე შენი მეილი';
      // R5-signup მხოლოდ მეილს იღებს -- type="email" უბრუნდება. autocomplete
      // მაინც "username" რჩება (არა "email") -- ეს ველი ანგარიშის ლოგინ
      // იდენტიფიკატორია პაროლის მენეჯერისთვის, არა საკონტაქტო მეილი.
      emailInput.type = 'email';
      emailInput.autocomplete = 'username';
    }
    if(passFieldLogin) passFieldLogin.style.display = 'none';
    if(passFieldReg) passFieldReg.style.display = '';
  } else {
    if(nickField) nickField.style.display = 'none';
    if(title) title.textContent = 'შესვლა';
    if(sub) sub.textContent = 'თამაშის დასაწყებად საჭიროა ავტორიზაცია.';
    if(submitBtn) submitBtn.textContent = 'შესვლა';
    if(switchWrap) switchWrap.innerHTML = 'არ გაქვს ანგარიში? <button type="button" id="quizAuthSwitchBtn">რეგისტრაცია</button>';
    if(emailLabel) emailLabel.textContent = 'ელ.ფოსტა / ნიქნეიმი / ნომერი';
    if(emailInput){
      emailInput.placeholder = 'შეიყვანე ელ.ფოსტა, ნიქნეიმი ან ნომერი';
      // type="email" (with autocomplete="email") on a field that also takes a
      // nickname or a phone number brings up the wrong mobile keyboard and
      // wrong autofill -- type="text" still gets the email keyboard layout
      // via inputmode, without rejecting a nickname or digits.
      emailInput.type = 'text';
      emailInput.inputMode = 'email';
      emailInput.autocomplete = 'username';
    }
    if(passFieldLogin) passFieldLogin.style.display = '';
    if(passFieldReg) passFieldReg.style.display = 'none';
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

// R6: same as app.js's normalizePhone() — this page doesn't load app.js,
// so it needs its own copy.
function normalizePhone(raw){
  let digits = String(raw || '').replace(/\D/g, '');
  if(digits.startsWith('995') && digits.length > 9) digits = digits.slice(3);
  if(digits.startsWith('0') && digits.length > 9) digits = digits.slice(1);
  return digits;
}

async function doQuizAuthSubmit(){
  const email = (document.getElementById('quizAuthEmail').value || '').trim();
  const pass = document.getElementById(_authModalMode === 'signup' ? 'quizAuthPassReg' : 'quizAuthPassLogin').value || '';
  const btn = document.getElementById('quizAuthSubmit');
  if(!email || !pass){ showAuthError('შეავსე ყველა ველი'); return; }
  if(!sb){ showAuthError('სერვერთან კავშირი ვერ დამყარდა.'); return; }
  if(btn) btn.disabled = true;

  try{
    if(_authModalMode === 'signup'){
      const nick = (document.getElementById('quizAuthNick').value || '').trim();
      if(!nick || !/^[a-zA-Z0-9._]{3,20}$/.test(nick)){
        showAuthError('სახელი: 3-20 სიმბოლო (ასოები, ციფრები, . _)'); return;
      }
      if(pass.length < 6){ showAuthError('პასვორდი: მინ. 6 სიმბოლო'); return; }

      // შენიშვნა: sb.rpc(...) არ არის სრული Promise — მხოლოდ .then()-ს
      // ახორციელებს, .catch()-ს პირდაპირ (await-ის გარეშე) ვერ მიადევნებ,
      // თორემ "is not a function" გაიჭრება. აქ უბრალოდ ვუცდით {data,error}-ს.
      const { data: taken, error: nickCheckErr } = await sb.rpc('is_nick_taken', { p_nick: nick, p_exclude_user_id: null });
      if(nickCheckErr) console.warn('[quiz] is_nick_taken failed:', nickCheckErr);
      if(taken){ showAuthError('ეს სახელი უკვე დაკავებულია - სცადე სხვა'); return; }

      const { data, error } = await sb.auth.signUp({ email, password: pass, options:{ data:{ nick } } });
      if(error){
        showAuthError(/already registered|already been registered/.test(error.message||'') ? 'ეს ელ. ფოსტა უკვე რეგისტრირებულია - სცადე შესვლა' : error.message);
        return;
      }
      if(!data.session){
        // email-დადასტურება ჩართულია ამ პროექტზე — სესია მხოლოდ დადასტურების
        // ბმულზე დაჭერის შემდეგ გაჩნდება, ამიტომ "დაუყოვნებლივი დაწყება" ამ
        // შემთხვევაში შეუძლებელია საიტის დადასტურების პოლიტიკის გარეშე.
        const sub = document.getElementById('quizAuthSub');
        if(sub) sub.textContent = 'რეგისტრაცია წარმატებულია! ანგარიშის გასააქტიურებლად დაადასტურე ელ.ფოსტა, შემდეგ დაბრუნდი და თავიდან დააჭირე დაწყებას.';
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
        if(error){ showAuthError('არასწორი მეილი ან პაროლი'); return; }
      } else {
        // R6: a phone-shaped identifier (digits/spaces/dashes/+/parens only)
        // is normalized the same way it's stored — a real nickname can
        // never match this (registration only allows [a-zA-Z0-9._], no
        // spaces/dashes/+/parens), so this can't mangle a nickname login.
        const identifier = /^[\d\s()+-]+$/.test(email) ? normalizePhone(email) : email;
        let resp;
        try{ resp = await sb.functions.invoke('login-with-identifier', { body: { identifier, password: pass } }); }
        catch(e){ resp = { data: null, error: e }; }
        if(resp.error || !resp.data || !resp.data.ok || !resp.data.session){ showAuthError('არასწორი მეილი ან პაროლი'); return; }
        const { error: setErr } = await sb.auth.setSession({ access_token: resp.data.session.access_token, refresh_token: resp.data.session.refresh_token });
        if(setErr){ showAuthError('არასწორი მეილი ან პაროლი'); return; }
      }
    }
  }catch(e){
    showAuthError('დაფიქსირდა შეცდომა - სცადე თავიდან.');
  }finally{
    // every outcome (error, success, or the "confirm your email" pending
    // state) must leave the button clickable again -- success closes the
    // modal anyway (applyAuthSession), but a reopened modal must not show
    // a dead button.
    if(btn) btn.disabled = false;
  }
}

// PDF p5: ამ გვერდის ავტორიზაციის მოდალს (app.js-ის მთავარი auth-მოდალისგან
// დამოუკიდებელი, იხ. ფაილის თავი) Google-ით შესვლა საერთოდ არ ჰქონდა —
// app.js-ის handleGoogleAuth()-ის იდენტური ლოგიკა, მხოლოდ redirectTo
// განსხვავებულია: Task 1-მდე აქ ყოველთვის ჰარდქოდილი /ufc/quiz/ მისამართი
// გამოიყენებოდა (სამი ცალკე რეალური გვერდის -- /quiz/, /quiz/ufcquiz/,
// /quiz/footballquiz/ -- გაჩენის შემდეგ ეს არასწორი იქნებოდა: მომხმარებელი
// /quiz/footballquiz/-დან Google-ით შესვლის შემდეგ /quiz/ufcquiz/-ზე
// დაბრუნდებოდა). ახლა origin+pathname+search -- რომელ გვერდზეც დაიწყო,
// იმავეზე ბრუნდება. ქვესადგურებზე (მაგ. /quiz/ufcquiz/questionquiz)
// 404.html-ის მირორებული შიმები კანონიკურ root-ზე მიჰყავს, სანამ
// supabase-js Supabase-ის დაბრუნებულ auth fragment/code-ს წაიკითხავდა.
// ?room=<კოდი> დეპ-ლინკი (location.search) მაინც შემორჩება, ხოლო რომელ
// ეკრანზე იყო მოთამაშე, უკვე persistPendingIntent-ით sessionStorage-შია
// შენახული.
async function handleQuizGoogleAuth(){
  if(!sb) { showAuthError('სერვერთან კავშირი ვერ დამყარდა.'); return; }
  persistPendingIntent();
  const redirectTo = window.location.origin + window.location.pathname + window.location.search;
  const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } });
  if(error) showAuthError(error.message || 'Google-ით შესვლა ვერ მოხერხდა.');
}

// Google-ით შესვლის OAuth-რედირექტი მთელ გვერდს თავიდან ტვირთავს, ამიტომ
// მეხსიერებაში მყოფი _pendingAuthAction ("დაწყება"-ზე დაჭერით გამოთხოვილი
// ავტორიზაციის შემდეგ რისი გაგრძელებაც იყო საჭირო) იკარგება. redirectTo
// ინარჩუნებს URL-ს (?room= ჩათვლით), მაგრამ ეს არ კმარა "ქვიზის დაწყება"
// ან ოთახის შექმნის/შესვლის მოქმედებისთვის, რომლებიც URL-ში არ ჩანს -- ამ
// intent-ს sessionStorage-ში ვტოვებთ და რედირექტის შემდეგ ერთხელ ვკითხულობთ.
const QUIZ_PENDING_INTENT_KEY = 'fnfQuizPendingIntent';
const QUIZ_PENDING_INTENT_TTL_MS = 10 * 60 * 1000; // ათი წუთი -- საკმარისია Google-ის round trip-ისთვის, საკმარისად მოკლეა რომ ძველი/დავიწყებული intent არ გაგრძელდეს
function persistPendingIntent(){
  if(!_pendingAuthIntent) return;
  try{
    sessionStorage.setItem(QUIZ_PENDING_INTENT_KEY, JSON.stringify(Object.assign({}, _pendingAuthIntent, { ts: Date.now() })));
  }catch(e){ /* სთორეჯი მიუწვდომელია -- Google-ით შესვლის შემდეგ უბრალოდ არაფერი გაგრძელდება ავტომატურად */ }
}
function resumePendingIntent(){
  let raw = null;
  try{
    raw = sessionStorage.getItem(QUIZ_PENDING_INTENT_KEY);
    if(raw) sessionStorage.removeItem(QUIZ_PENDING_INTENT_KEY); // ერთჯერადი მოხმარება -- წარმატებით წაკითხვისთანავე იშლება
  }catch(e){ return; }
  if(!raw) return;
  let intent;
  try{ intent = JSON.parse(raw); }catch(e){ return; }
  if(!intent || !intent.type || !intent.gameType || typeof intent.ts !== 'number' || (Date.now() - intent.ts) > QUIZ_PENDING_INTENT_TTL_MS) return;

  // იგივე პატერნი, რასაც quizRestoreStep იყენებს popstate-ზე -- პირდაპირ
  // S.gameType-ის დაყენება და startLobby(), screen-mode-ის გავლის გარეშე.
  // intent.sport missing (an older/pre-sport-picker intent) defaults to
  // UFC -- every pre-existing intent was UFC-only.
  S.sport = intent.sport || 'UFC';
  S.gameType = intent.gameType;
  updateLandAbout();
  if(intent.type === 'ai'){
    startLobby('ai', { push:false });
    const startBtn = document.querySelector('#lobby-action .btn-primary');
    if(startBtn) startBtn.click();
  } else if(intent.type === 'pvp-create'){
    startLobby('pvp', { push:false });
    const createBtn = document.getElementById('pvp-create-btn');
    if(createBtn) createBtn.click();
  } else if(intent.type === 'pvp-join'){
    startLobby('pvp', { push:false });
    const codeInput = document.getElementById('pvp-join-code');
    if(codeInput && intent.roomCode) codeInput.value = intent.roomCode;
    const joinBtn = document.getElementById('pvp-join-btn');
    if(joinBtn) joinBtn.click();
  }
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
  // #quizAuthSubmit is outside <form> and the form has no submit button of
  // its own, so with 2+ text fields in it, Chrome/Firefox never fire a
  // 'submit' event on Enter (confirmed empirically) -- the line above never
  // runs on its own. Route Enter through the same click handler instead of
  // adding a submit button, so that handler stays the single entry point.
  if(form) form.addEventListener('keydown', e=>{
    if(e.key !== 'Enter') return;
    e.preventDefault();
    const btn = document.getElementById('quizAuthSubmit');
    if(btn && !btn.disabled) btn.click();
  });
})();
// app.js:1258 closes its auth modal on Escape -- this one has no equivalent yet.
document.addEventListener('keydown', e=>{
  if(e.key !== 'Escape') return;
  const m = document.getElementById('quizAuthModal');
  if(m && m.classList.contains('show')) cancelAuthModal();
});

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
// PvP pagehide mark-away (see quiz_mark_away below) needs the current access
// token synchronously, from inside a pagehide handler that can't await a
// fresh sb.auth.getSession() call -- kept current by every session event.
let _authAccessToken = null;

let _authApplying = false;
async function applyAuthSession(session){
  if(!session) return;
  _authAccessToken = session.access_token;
  if(_authApplying) return;
  _authApplying = true;
  try{
    const user = await fetchAuthUser(session);
    currentAuthUser = user;
    updateAuthNav(user);
    // ნავიდან "შესვლა"/"რეგისტრაცია" ღილაკით გახსნილ მოდალსაც (pending
    // action გარეშე) უნდა დაიხუროს სესიის მიღებისთანავე -- თორემ ვიზიტორს
    // მოდალი რჩება გაშლილი შესული გვერდის თავზე.
    closeAuthModal();
    // თუ ავტორიზაცია სწორედ იმიტომ გამოვითხოვეთ, რომ მოთამაშეს ქვიზის დაწყება
    // სურდა — ახლა გავაგრძელოთ ზუსტად იქედან.
    if(_pendingAuthAction){
      const fn = _pendingAuthAction; _pendingAuthAction = null; _pendingAuthIntent = null;
      fn();
    } else {
      // Google-ით შესვლის რედირექტმა შეიძლება page-ის reload გამოიწვია --
      // _pendingAuthAction მეხსიერებაშია და მას გადარჩენა არ შეეძლო, ამიტომ
      // sessionStorage-ში დატოვებული intent-ის მეშვეობით ვაგრძელებთ.
      resumePendingIntent();
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
      if(event === 'SIGNED_OUT'){ currentAuthUser = null; _authAccessToken = null; updateAuthNav(null); }
      else if(session) applyAuthSession(session);
    }, 0);
  });
}

// AI-ის სირთულის დონეები — acc = რა ალბათობით პასუხობს AI სწორად (მაღალი = რთული)
// dbLevel — quiz_questions.level / guess_who_questions.level მნიშვნელობა სერვერზე.
// "შერეული" (mixed) დონეს საკუთარი row-ები არ გააჩნია არც ერთ ცხრილში —
// dbLevel="შერეული" სერვერზე (get_ai_quiz_questions / create_quiz_room)
// არის query-time სენტინელი: ყოველთვის ზუსტად 3 მარტივი + 5 საშუალო +
// 2 რთული კითხვისგან შედგება (არა წმინდა შემთხვევითობა ყველა დონეზე),
// იხ. supabase/quiz_mixed_composition.sql.
const DIFFICULTY_UFC = [
  { key:"easy",   label:"მარტივი", acc:0.40, dbLevel:"მარტივი", enabled:true,
    note:"მარტივ კითხვებს ელოდე, ზოგადი ცოდნითაც შეიძლება გახვიდე ფონს.", color:"var(--green)" },
  { key:"medium", label:"საშუალო", acc:0.62, dbLevel:"საშუალო", enabled:true,
    note:"მეტ-ნაკლებად რთული კითხვებია, ალბათ MMA-ის შესახებ გარკვეული ცოდნა გჭირდება, მაგრამ რთულს არ გირჩევ",
    noteHtml:'მეტ-ნაკლებად რთული კითხვებია, ალბათ MMA-ის შესახებ გარკვეული ცოდნა გჭირდება, <span style="color:var(--red-soft)">მაგრამ რთულს არ გირჩევ</span>', color:"var(--gold)" },
  { key:"hard",   label:"რთული",   acc:0.82, dbLevel:"რთული", enabled:true,
    note:'"საშუალოს" რჩევა უნდა გაგეთვალისწინებინა.', color:"var(--red-soft)" },
  { key:"mixed",  label:"შერეული", acc:0.62, dbLevel:"შერეული", enabled:true,
    note:"ამ კატეგორიაში ყველა სირთულის კითხვები შეგხვდება.", color:"var(--blue)" },
];
// Football-flavored level descriptions (verbatim, see FOOTBALL-QUIZ-PRD.md §6
// and FOOTBALL-QUIZ-DATABASE.md's own "სტრუქტურა და დონეების აღწერები") --
// same key/dbLevel/acc/color per level as UFC (same vs-AI accuracy curve,
// same stored level values), only the note text differs by sport.
const DIFFICULTY_FOOTBALL = [
  { key:"easy",   label:"მარტივი", acc:0.40, dbLevel:"მარტივი", enabled:true,
    note:"ზოგადი საფეხბურთო ცოდნაც საკმარისია", color:"var(--green)" },
  { key:"medium", label:"საშუალო", acc:0.62, dbLevel:"საშუალო", enabled:true,
    note:"გარკვეული ცოდნა გჭირდება კითხვებზე პასუხის გასაცემად", color:"var(--gold)" },
  { key:"hard",   label:"რთული",   acc:0.82, dbLevel:"რთული", enabled:true,
    note:"ტატო ბაციკაზე თუ არ ხარ გაეშვი.", color:"var(--red-soft)" },
  { key:"mixed",  label:"შერეული", acc:0.62, dbLevel:"შერეული", enabled:true,
    note:"ამ დონეზე ალბათ ყველაზე კარგად გაერთობი", color:"var(--blue)" },
];
function currentDifficulty(){
  return S.sport === "Football" ? DIFFICULTY_FOOTBALL : DIFFICULTY_UFC;
}

/* ============================================================
   მდგომარეობა
   ============================================================ */
const S = {
  sport:null,      // "UFC" | "Football" -- chosen on screen-sport, see chooseSport()
  gameType:null,   // "quiz" | "guess"
  mode:null,       // "ai" | "pvp" -- opponent picked on the merged screen-gametype screen, before Start is pressed (see chooseGameType/resetGametypeUI)
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
  cbEndTimers:[],    // ბარათების ბრძოლის დასრულების ეკრანზე (strips + ქულების თვლა) დაგეგმილი setTimeout-ების სია
  aiAcc:null,
  diffKey:null,
  consecTimeouts:0, // PvP AFK rule — consecutive timed-out questions for the local player (vs-AI never touches this)
};

/* ---------- helpers ---------- */
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
function show(id){
  // კითხვის ეკრანებიდან (quiz/guess) გასვლისას თაიმერის rAF ციკლი ყოველთვის
  // წყდება აქ ერთ ადგილას — არც ერთი stray loop არ რჩება ფონში.
  if(id !== "screen-quiz" && id !== "screen-guess") stopQuestionTimer();
  // იგივე, გამორთული პასუხის დროის "აქ ხარ?" პატერნისთვის (იხ.
  // startGuessWhoAfkWatch) -- ჩვეულებრივი თაიმერისგან დამოუკიდებელი
  // setTimeout-ების წყვილი, ამიტომ ცალკე უნდა გაითიშოს აქვე.
  if(id !== "screen-guess") stopGuessWhoAfkWatch();
  // იგივე პატერნი screen-pvp-wait-ის fallback პოლინგისთვის (იხ.
  // startPvpWaitPolling) -- ამ ეკრანიდან ნებისმიერ სხვაზე გადასვლისას
  // ყოველთვის წყდება აქ, ერთ ადგილას.
  if(id !== "screen-pvp-wait") stopPvpWaitPolling();
  // იგივე screen-pvp-lobby-ისთვის (იხ. startPvpLobbyPolling).
  if(id !== "screen-pvp-lobby") stopPvpLobbyPolling();
  // ბარათების ბრძოლის დასრულების ეკრანზე (strips-ის ანიმაცია + ქულების
  // თვლა) დაგეგმილი setTimeout-ები ყოველთვის წყდება აქ ერთ ადგილას — ახალი
  // თამაში ძველის ტაიმერებს არასდროს იმკვიდრებს.
  if(id !== "screen-cards") stopEndBattleAnimation();
  $$(".screen").forEach(e=>e.classList.remove("active"));
  $("#"+id).classList.add("active");
  // მინი-ჰერო (სათაური) მხოლოდ ყველაზე პირველ ("აირჩიე ქვიზის ტიპი",
  // სპორტის არჩევა) ეკრანზე ჩანს — თამაშის პროცესში (კითხვები, ლობი,
  // შედეგი) ბრენდინგის მაგივრად პირდაპირ კითხვა/ტაიმერი ჩანდეს თავში.
  const hero = document.getElementById('quizHero');
  if(hero) hero.style.display = (id === "screen-sport") ? "" : "none";
  // სპორტის მიხედვით ფონი -- ზუსტად 2 ეკრანზე (თამაშის ტიპი+ოპონენტი
  // გაერთიანებული ეკრანი / ოთახის შექმნა-შესვლა). #quizApp.qzapp-sportbg(.qzapp-sport-ufc|
  // -football) ჩართავს quiz-page.template.html-ის შესაბამის CSS წესს
  // (#quizApp::before-ის override, იხ. იქაური კომენტარი) -- დანარჩენ
  // ყველა ეკრანზე (სპორტის არჩევის ჩათვლით) იგივე საერთო BackgroundQuiz.webp
  // რჩება უცვლელი, რადგან ეს კლასი მხოლოდ აქ ემატება.
  const sportBgScreens = ["screen-gametype","screen-pvp-setup"];
  const quizAppEl = document.getElementById('quizApp');
  if(quizAppEl){
    const sportBg = sportBgScreens.indexOf(id) > -1;
    quizAppEl.classList.toggle('qzapp-sportbg', sportBg);
    quizAppEl.classList.toggle('qzapp-sport-ufc', sportBg && S.sport === 'UFC');
    quizAppEl.classList.toggle('qzapp-sport-football', sportBg && S.sport === 'Football');
  }
  // Desktop card enlarge (2026-11-22 request, Part 1): #quizRoot.gt-wide
  // widens just this one screen's column grid (CSS, min-width:641px only)
  // -- on while screen-gametype is active, off for every other screen, so
  // #quizRoot's shared 560px cap is untouched everywhere else.
  const quizRootEl = document.getElementById('quizRoot');
  if(quizRootEl) quizRootEl.classList.toggle('gt-wide', id === 'screen-gametype');
  const inGame = ["screen-quiz","screen-guess","screen-cards","screen-pvp-setup","screen-pvp-lobby","screen-pvp-wait","screen-pvp-results"].indexOf(id) > -1;
  if(!inGame){ window.scrollTo(0,0); return; }
  requestAnimationFrame(()=>{
    const nav = document.querySelector("nav");
    const navH = nav ? nav.getBoundingClientRect().height : 0;
    const el = document.getElementById(id);
    if(!el) return;
    const pt = parseFloat(getComputedStyle(el).paddingTop) || 0;
    const y = el.getBoundingClientRect().top + window.scrollY + pt - navH - 6;
    window.scrollTo(0, Math.max(0, y));
  });
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
    const { data, error } = await sb.rpc('get_ai_quiz_questions', { p_game_type: 'quiz', p_level: dbLevel, p_category: S.sport || 'UFC' });
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
  return {
    clues: (clues||[]).map(String),
    answer: String(answer),
    sub_category: row.sub_category ?? null,
    is_abbrev_hint: !!row.is_abbrev_hint,
  };
}

async function fetchGuessQuestions(dbLevel){
  if(!sb || !dbLevel) return null;
  try{
    // იხ. ზემოთ fetchQuestions-ის შენიშვნა — იგივე no-repeat RPC, guess-who პულზე.
    const { data, error } = await sb.rpc('get_ai_quiz_questions', { p_game_type: 'guess', p_level: dbLevel, p_category: S.sport || 'UFC' });
    if(error){ console.error("[quiz] Supabase შეცდომა (ვინ ვარ?):", error.message||error); return null; }
    // ⚠️ აქაც არ ვბეჭდავთ მონაცემებს (პასუხებს) კონსოლში.
    if(!Array.isArray(data) || !data.length) return null;
    const norm = data.map(normalizeGuessRow).filter(x => x.answer && Array.isArray(x.clues) && x.clues.length);
    if(!norm.length) return null;
    return norm;
  }catch(e){ console.error("[quiz] fetch გაითიშა (ვინ ვარ?):", e); return null; }
}

/* ---------- თავისუფალი ტექსტის პასუხის შემოწმება „ვინ ვარ?“-სთვის ----------
   ზუსტი ანალოგია Supabase-ის quiz_norm_name / quiz_build_answer_variants /
   quiz_is_guess_correct ფუნქციებისა (იხ. supabase/guess_who_answer_matching.sql)
   — PvP-ში ქულებს ეს იგივე ლოგიკა სერვერზე ითვლის, ამიტომ ორივე მხარეს
   ხელით უნდა მოვარგოთ ერთმანეთს, საერთო წყარო არ არსებობს. */
function normName(s){
  return String(s||"")
    .toLowerCase()
    .replace(/[„“”"‘’'`´().,!?\-–—]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
// პასუხი, რომელსაც ხელით დამატებული ვარიანტები სჭირდება, რადგან
// buildAnswerVariants-ის ზოგადი (a)-(e) წესები მათთვის საკმარისი არაა.
const MANUAL_ANSWER_ALIASES = [
  { answer: "ქუინზ პარკ რეინჯერსი", aliases: ["ქპრ"] },
  { answer: "RCDE", aliases: ["არსიდიი", "არესიდიი", "რცდე"] },
  { answer: "სტად ლუი II", aliases: ["სტად ლუი", "სტად ლუი 2"] },
];
function buildAnswerVariants(answerRaw){
  const answer = String(answerRaw||"");
  const full = normName(answer);
  const variants = [];
  if(full) variants.push(full);

  const pStart = answer.indexOf("(");
  const pEnd = answer.indexOf(")");
  let outside = full, inside = "";
  if(pStart >= 0 && pEnd > pStart){
    outside = normName(answer.slice(0,pStart) + " " + answer.slice(pEnd+1));
    inside = normName(answer.slice(pStart+1, pEnd));
  }
  if(outside && outside !== full) variants.push(outside);
  if(inside) variants.push(inside);

  const words = outside.split(" ").filter(Boolean);
  if(words.length >= 1) variants.push(words[words.length-1]); // ბოლო სიტყვა (გვარი/საკვანძო სიტყვა)
  if(words.length >= 2) variants.push(words.slice(1).join(" ")); // პირველი (ქალაქი/კუთვნილებითი) სიტყვის მოცილებით

  for(const entry of MANUAL_ANSWER_ALIASES){
    if(full === normName(entry.answer)){
      for(const alias of entry.aliases) variants.push(normName(alias));
    }
  }
  return variants;
}
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
// ზუსტი ანალოგი Supabase-ის quiz_is_guess_correct-ისა — იხ. ზემოთ normName-ის
// კომენტარი. STRICT_SHORT ზღვარი შემოღებულია იმიტომ, რომ 6 სიმბოლომდე
// ვარიანტებზე უბრალო 60%-იანი მსგავსება ცდომილებების ტოლერანტულია
// (მაგ. "მესი" საკმარისად ჰგავს "მესხი"-ს — 0.8 — რომ არასწორად ჩათვალოს
// სწორად; short ვარიანტებს ამიტომ თითქმის ზუსტი დამთხვევა სჭირდება).
const MATCH_LOOSE = 0.6; // კვლავ გამოიყენება მხოლოდ სიტყვების ქვესიმრავლის შემოწმებაში ქვემოთ — უცვლელი, ცალკე გადასაწყვეტია
const MATCH_STRICT_SHORT = 0.84;
// 6 სიმბოლოზე გრძელი ვარიანტებისთვის ბრტყელი 60%-იანი მსგავსება (ძველი
// MATCH_LOOSE) სიგრძის ზრდასთან ერთად სულ უფრო მეტ რედაქტირების მანძილს
// უშვებდა (7 სიმბოლოზე უკვე 2-მდე) — ზუსტად ეს აღმოჩნდა "რონალდო"-ს
// "რივალდო"-დ ცნობის მიზეზი. ამის ნაცვლად დასაშვები მანძილი თავად
// სკალირდება სიგრძესთან: ზუსტად 1 სიმბოლო სხვაობა 7-სიმბოლოიან
// ვარიანტებზე, იზრდება კიდევ 1-ით მხოლოდ ყოველ +10 სიგრძეზე (უფრო
// სწრაფი ზრდა, მაგ. length/7, ცდაში უშვებდა ორი სხვადასხვა ~25-
// სიმბოლოიანი სტადიონის სახელის დამთხვევას, განსხვავებულს მხოლოდ
// ქალაქის სახელით — სანამ ეს ფორმულა არ შენელდა). ზუსტი ანალოგი
// quiz_is_guess_correct-ის ალგორითმის SQL-ში (supabase/guess_who_answer_matching.sql)
// — თუ ოდესმე შეცვალო, შეცვალე ორივე მხარეს ერთად.
function guessMatchAllowedDistance(len){
  return 1 + Math.floor(Math.max(0, len - 7) / 10);
}
function isGuessCorrect(guess, answer){
  const g = normName(guess);
  if(!g) return { correct:false, exact:false };
  const exact = g === normName(answer);

  const variants = buildAnswerVariants(answer);

  for(const v of variants){
    if(g === v) return { correct:true, exact };
  }
  for(const v of variants){
    if(v.length <= 6){
      if(nameSimilarity(g, v) >= MATCH_STRICT_SHORT) return { correct:true, exact };
    } else {
      if(levenshtein(g, v) <= guessMatchAllowedDistance(v.length)) return { correct:true, exact };
    }
  }

  // სიტყვების ქვესიმრავლის შემოწმება — დასაშვებია ნაწილობრივი/შეცდომიანი
  // მრავალსიტყვიანი სახელი (მაგ. "ქვინს პარკი" ვარიანტზე "ქუინზ პარკ
  // რეინჯერსი"), თუმცა მხოლოდ >=2 რეალურ სიტყვაზე — ერთსიტყვიანი ვარიანტები
  // ზემოთა STRICT_SHORT შემოწმებით უნდა გავიდეს, თორემ "მესი" isGuessCorrect-ში
  // "მესხი"-საც დაემთხვევა ცალკეული სიტყვების 60%-იანი ზღვრით.
  const poolWords = variants.flatMap(v => v.split(" ")).filter(w=>w.length>=2);
  const guessWords = g.split(" ").filter(w=>w.length>=2);
  if(guessWords.length >= 2 && poolWords.length){
    let allMatch = true;
    for(const gw of guessWords){
      let best = 0;
      for(const pw of poolWords){ best = Math.max(best, nameSimilarity(gw, pw)); }
      if(best < MATCH_LOOSE){ allMatch = false; break; }
    }
    if(allMatch) return { correct:true, exact };
  }

  for(const v of variants){
    if(g.length>=4 && (v.includes(g) || g.includes(v))) return { correct:true, exact };
  }

  return { correct:false, exact:false };
}

/* ============================================================
   Phase 9: URL + analytics map for the seven tracked quiz screens --
   single source of truth for pushState's path, the dataLayer page_title,
   and the ?s= direct-link shim's reverse (rest -> screen) lookup. 404.html
   has the matching forward (path -> ?s=) direction (mirrored for all three
   roots as of Task 1); keep the "rest" strings byte-identical between the
   two, including capitalisation (quizAI/whoAI, not quizai/whoai --
   404.html's own matching is case-insensitive, but the canonical ?s= value
   it redirects to, and everything here, is not).
   ============================================================ */
const QUIZ_STEPS = [
  { rest: "",                      gameType: null,    mode: null,  title: "Quiz — Start" },
  { rest: "questionquiz",          gameType: "quiz",  mode: null,  title: "Quiz — Choose Mode" },
  { rest: "wheamI",                gameType: "guess", mode: null,  title: "Guess Who — Choose Mode" },
  { rest: "questionquiz/quizAI",   gameType: "quiz",  mode: "ai",  title: "Quiz — vs AI" },
  { rest: "questionquiz/quizcoop", gameType: "quiz",  mode: "pvp", title: "Quiz — vs Friends" },
  { rest: "wheamI/whoAI",          gameType: "guess", mode: "ai",  title: "Guess Who — vs AI" },
  { rest: "wheamI/whocoop",        gameType: "guess", mode: "pvp", title: "Guess Who — vs Friends" },
];
function quizStepFor(gameType, mode){
  return QUIZ_STEPS.find(s => s.gameType === (gameType || null) && s.mode === (mode || null));
}
// pushState + dataLayer for one of the seven forward transitions above.
// Never called for a backward (popstate) move or on page load -- only
// from the four places below that build a screen's UI for the first time
// in a given visit (chooseGameType, startLobby's ai branch, startPvpSetup,
// and the two "play again"/"done" resets back to the gametype screen).
// Football shares every one of these seven (gameType,mode) URL slugs with
// UFC (no separate URL scheme this run, see pushSportStep below) --
// quizSport is carried in history.state only, never in the path/rest.
function pushQuizStep(gameType, mode){
  const step = quizStepFor(gameType, mode);
  if(!step) return;
  const path = quizRootForSport(S.sport) + step.rest;
  // ?room=<code> (the PvP share link) has to survive every pushState
  // between here and screen-pvp-setup actually reading it, or a plain
  // pushState(..., path) would silently drop it from the address bar.
  const roomParam = new URLSearchParams(location.search).get("room");
  const addressBarUrl = path + (roomParam ? "?room=" + encodeURIComponent(roomParam) : "");
  history.pushState({ quizSport: S.sport, quizGameType: step.gameType, quizMode: step.mode }, "", addressBarUrl);
  window.dataLayer = window.dataLayer || [];
  const payload = { event: "quiz_step", page_path: path, page_title: step.title, external_id: (currentAuthUser && currentAuthUser.id) || "" };
  if(S.sport) payload.quiz_sport = S.sport;
  if(step.gameType) payload.quiz_game_type = step.gameType;
  if(step.mode) payload.quiz_mode = step.mode;
  window.dataLayer.push(payload);
}
// Rebuilds a screen's UI for a given (sport, gameType, mode) triple without
// touching history -- shared by popstate and the ?s= direct-link shim.
// Reuses chooseSport/chooseGameType/startLobby themselves (push:false)
// rather than duplicating their UI-building logic. sport===null means the
// true root (screen-sport, nothing chosen yet -- see pushSportStep).
function quizRestoreStep(sport, gameType, mode){
  if(!sport){
    S.sport = null;
    S.gameType = null;
    show("screen-sport");
    updateLandAbout();
    return;
  }
  S.sport = sport;
  updateLandAbout();
  if(!gameType){
    chooseSport(sport, { push:false });
    return;
  }
  if(!mode){
    chooseGameType(gameType, { push:false });
    return;
  }
  S.gameType = gameType;
  startLobby(mode, { push:false });
}

/* ============================================================
   -1) სპორტის არჩევა (UFC / ფეხბურთი) -- ყველაზე პირველი ეკრანი
   ============================================================ */
$$("#screen-sport .mode").forEach(card=>{
  const go = ()=> chooseSport(card.dataset.sport);
  card.addEventListener("click", go);
  card.addEventListener("keydown", e=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); go(); }});
});

// A real page refresh on a sub-path (e.g. /quiz/ufcquiz/questionquiz) never
// reaches a static file -- 404.html shims it to ?s=<rest> on the matching
// root, and that rest string is shared byte-for-byte between UFC and
// Football (see
// pushQuizStep above), so the URL alone can't say which sport was active.
// Persisting the last chosen sport here lets initQuizDeepLink below
// recover it instead of always assuming UFC.
const QUIZ_SPORT_STORAGE_KEY = "fnfQuizSport";
function persistCurrentSport(sport){
  try{ if(sport) sessionStorage.setItem(QUIZ_SPORT_STORAGE_KEY, sport); }catch(e){}
}
function readPersistedSport(){
  try{ return sessionStorage.getItem(QUIZ_SPORT_STORAGE_KEY); }catch(e){ return null; }
}

// screen-gametype's two card descriptions are sport-dependent copy too
// (same reason as DIFFICULTY_FOOTBALL's notes and the land-about divs
// below) -- exact verbatim strings, not generated.
const GAMETYPE_CARD_TEXT = {
  UFC: {
    quiz: "კითხვები UFC-დან",
    guess: "ფაქტებს გეტყვი მებრძოლებზე<br>ეცადე გამოიცნო ვისზეა საუბარი"
  },
  Football: {
    quiz: "კითხვები ფეხბურთიდან",
    guess: "ფეხბურთთან დაკავშირებულ ფაქტებს გეტყვი<br>ეცადე გამოიცნო ვისზე ან რაზეა საუბარი"
  }
};

// Sport-aware land-about explainer (ufc/quiz/index.html, below the quiz
// app) -- one <div data-landabout="neutral|UFC|Football"> per sport in the
// markup, this just shows the one matching S.sport and hides the others.
// Also refreshes screen-gametype's two card descriptions (GAMETYPE_CARD_TEXT
// above), the other sport-dependent copy outside the per-level DIFFICULTY
// arrays. Called from every place S.sport changes (chooseSport,
// quizRestoreStep, PvP join/resume, the pending-intent resume after login)
// so neither drifts from what's actually selected, plus once on initial
// load below for the neutral default.
function updateLandAbout(){
  const key = (S.sport === "UFC" || S.sport === "Football") ? S.sport : "neutral";
  $$(".land-about [data-landabout]").forEach(el=>{
    el.style.display = (el.dataset.landabout === key) ? "" : "none";
  });
  const cardText = GAMETYPE_CARD_TEXT[S.sport] || GAMETYPE_CARD_TEXT.UFC;
  const quizDesc = document.getElementById("gametype-quiz-desc");
  const guessDesc = document.getElementById("gametype-guess-desc");
  if(quizDesc) quizDesc.textContent = cardText.quiz;
  // #quizRoot #gametype-guess-desc (quiz-page.template.html) handles both
  // sports' two-line rendering itself (nowrap + a calc()'d font-size tied
  // to the card's own width) -- no per-sport class needed here anymore.
  if(guessDesc) guessDesc.innerHTML = cardText.guess;
  // gametype-sport-label is now a fixed string ("აირჩიე თამაშის ტიპი",
  // baked in by build-quiz-pages.js) on all three pages -- no longer
  // sport-specific, so nothing to update here any more.
}
updateLandAbout();

function chooseSport(sport, opts){
  opts = opts || {};
  S.sport = sport; // "UFC" | "Football"
  persistCurrentSport(sport);
  updateLandAbout();
  // ქვიზი წინასწარ არჩეულია ეკრანის გახსნისთანავე, რომ ოპონენტის არჩევანი
  // მაშინვე ჩანდეს (push:false -- ეს default-ი არ ინახება ისტორიაში/URL-ში,
  // მხოლოდ pushSportStep-ის სპორტის root URL-ი იწერება ქვემოთ).
  chooseGameType("quiz", { push:false });
  if(opts.push !== false) pushSportStep(sport);
}

// Task 1: the address-bar URL for this root step is now sport-specific --
// choosing a sport from the bare /quiz/ picker moves the canonical root to
// /quiz/ufcquiz/ or /quiz/footballquiz/ (quizRootForSport) -- only
// history.state's quizSport used to differ; now the path does too, which
// is still enough for the existing popstate handler to give
// one-screen-at-a-time Back from here.
function pushSportStep(sport){
  const root = quizRootForSport(sport);
  const roomParam = new URLSearchParams(location.search).get("room");
  const addressBarUrl = root + (roomParam ? "?room=" + encodeURIComponent(roomParam) : "");
  history.pushState({ quizSport: sport, quizGameType: null, quizMode: null }, "", addressBarUrl);
  window.dataLayer = window.dataLayer || [];
  window.dataLayer.push({ event: "quiz_step", page_path: root, page_title: "Quiz — Sport: " + sport, quiz_sport: sport, external_id: (currentAuthUser && currentAuthUser.id) || "" });
}

/* ============================================================
   0) თამაშის ტიპის და ოპონენტის არჩევა (გაერთიანებული ეკრანი) -- თამაშის
   ტიპის არჩევისას (ქვიზი / ვინ ვარ?) ოპონენტის ბარათები ("AI-ის
   წინააღმდეგ" / "ადამიანის წინააღმდეგ") ამავე screen-gametype ეკრანზე
   ქვემოთ ჩნდება (#gametype-opponent-wrap, .show კლასით) -- ცალკე
   screen-mode ეკრანი აღარ არსებობს. data-locked მხარდაჭერა დარჩენილია
   მომავალში ხელახლა გამოსაყენებლად, თუ ოდესმე კიდევ რომელიმე ოპონენტის
   ბარათი დაიბლოკება.
   ============================================================ */
const gametypeOppWrap = $("#gametype-opponent-wrap");
const gametypeStartBtn = $("#gametype-start-btn");

// S.gameType/S.mode-ზე დამოკიდებული UI-ს ნეიტრალურ მდგომარეობაში დაბრუნება
// (ორივე ბარათის .sel მოხსნა, ოპონენტის სექცია დამალვა, "დაწყება" ღილაკის
// გამორთვა) -- chooseGameType-ის (ახალი ტიპის არჩევისას) და PvP-დან/
// ბარათების ეკრანიდან დაბრუნების ყველა წერტილში (resetToMode/
// finishPvpResults/onPvpRoomAbandoned) გამოიყენება ერთნაირად.
// Default opponent (2026-11-22 request, Part 2; narrowed same day): the
// human/PvP card is pre-selected on the very first load only -- not on
// every later reset (switching game type, returning from a finished/
// abandoned PvP match all route through chooseGameType -> resetGametypeUI
// too, same as the first load, but from then on this just reapplies
// whatever S.mode the user last actually chose, instead of forcing PvP
// again). gametypeDefaultModeApplied is the one-time flag gating that.
const DEFAULT_GAMETYPE_MODE = "pvp";
let gametypeDefaultModeApplied = false;
function resetGametypeUI(){
  if(!gametypeDefaultModeApplied){
    S.mode = DEFAULT_GAMETYPE_MODE;
    gametypeDefaultModeApplied = true;
  }
  $$("#screen-gametype .gametype-modes .mode").forEach(c=> c.classList.remove("sel"));
  $$("#gametype-opponent-wrap .mode").forEach(c=> c.classList.toggle("sel", c.dataset.mode === S.mode));
  if(gametypeOppWrap) gametypeOppWrap.classList.remove("show");
  // S.gameType is already set by chooseGameType (the only caller) before
  // this runs, so this correctly enables the button for the new default.
  if(gametypeStartBtn) gametypeStartBtn.disabled = !(S.gameType && S.mode);
}

$$("#screen-gametype .gametype-modes .mode").forEach(card=>{
  const go = ()=> chooseGameType(card.dataset.gametype);
  card.addEventListener("click", go);
  card.addEventListener("keydown", e=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); go(); }});
  // Connector hover preview (2026-11-22 request, Part 4) -- desktop only;
  // CSS keeps #gametype-connector display:none below 641px, so this is
  // visually inert on mobile. Hovering an unselected game-type card
  // previews the curve from THIS card to the currently selected opponent
  // card.
  card.addEventListener("mouseenter", ()=>{
    if(card.classList.contains("sel")) return;
    const selMode = $("#gametype-opponent-wrap .modes .mode.sel");
    if(selMode) drawGametypePreview(card, selMode);
  });
  card.addEventListener("mouseleave", clearGametypePreview);
});

function chooseGameType(type, opts){
  opts = opts || {};
  S.gameType = type; // "quiz" | "guess"
  resetGametypeUI(); // ახალი ტიპის არჩევისას ოპონენტის წინა არჩევანი ყოველთვის იწმინდება
  $$("#screen-gametype .gametype-modes .mode").forEach(c=> c.classList.toggle("sel", c.dataset.gametype === type));
  if(gametypeOppWrap) gametypeOppWrap.classList.add("show");
  show("screen-gametype");
  drawGametypeConnector();
  if(opts.push !== false) pushQuizStep(type, null);
}

$$("#gametype-opponent-wrap .mode").forEach(card=>{
  if(card.dataset.locked === "true") return; // მომავალში ჯერ არ ჩართული ბარათებისთვის
  const go = ()=>{
    S.mode = card.dataset.mode;
    $$("#gametype-opponent-wrap .mode").forEach(c=> c.classList.toggle("sel", c === card));
    if(gametypeStartBtn) gametypeStartBtn.disabled = !(S.gameType && S.mode);
    clearGametypePreview();
    drawGametypeConnector();
  };
  card.addEventListener("click", go);
  card.addEventListener("keydown", e=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); go(); }});
  // Hovering an unselected opponent card previews the curve from the
  // currently selected game-type card to THIS card.
  card.addEventListener("mouseenter", ()=>{
    if(card.classList.contains("sel")) return;
    const selGametype = $("#screen-gametype .gametype-modes .mode.sel");
    if(selGametype) drawGametypePreview(selGametype, card);
  });
  card.addEventListener("mouseleave", clearGametypePreview);
});
if(gametypeStartBtn) gametypeStartBtn.addEventListener("click", ()=>{
  if(!S.gameType || !S.mode) return;
  startLobby(S.mode); // "ai" -> screen-lobby (სირთულის არჩევა); "pvp" -> startPvpSetup (ოთახის შექმნა/შესვლა)
});

/* ============================================================
   Connector line (2026-11-22 request, Parts 3/4) -- static SVG curve
   between the selected game-type card and the selected opponent card,
   plus a faint hover preview of where it would move. Desktop only (CSS
   hides #gametype-connector entirely below 641px); both draw functions
   below bail out harmlessly whenever a selected card can't be found,
   which covers the mobile/hidden-screen case too (no separate guard
   needed). Redrawn on selection change (the two "go" closures above, plus
   chooseGameType above), window resize, and once web fonts finish loading
   (a font swap can shift each card's real width/height after first paint).
   ============================================================ */
const gametypeLayoutEl = document.querySelector(".gametype-layout");
const gametypeConnectorSvg = document.getElementById("gametype-connector");
const gtcLine = gametypeConnectorSvg && gametypeConnectorSvg.querySelector(".gtc-line");
const gtcBase = gametypeConnectorSvg && gametypeConnectorSvg.querySelector(".gtc-base");
const gtcPreview = gametypeConnectorSvg && gametypeConnectorSvg.querySelector(".gtc-preview");
const gtcDotA = gametypeConnectorSvg && gametypeConnectorSvg.querySelector(".gtc-dot-a");
const gtcDotB = gametypeConnectorSvg && gametypeConnectorSvg.querySelector(".gtc-dot-b");

// Mid-point of a card's right or left edge, in pixels relative to
// containerRect (always .gametype-layout's own getBoundingClientRect()).
function gtcEdgePoint(card, edge, containerRect){
  const r = card.getBoundingClientRect();
  return { x: (edge === "right" ? r.right : r.left) - containerRect.left, y: (r.top + r.height / 2) - containerRect.top };
}
// Cubic bezier, both control points offset horizontally by 55% of the
// horizontal distance between the two endpoints: M x1 y1 C x1+dx y1,
// x2-dx y2, x2 y2 with dx = (x2-x1)*0.55.
function gtcPathFor(p1, p2){
  const dx = (p2.x - p1.x) * 0.55;
  return "M " + p1.x + " " + p1.y + " C " + (p1.x + dx) + " " + p1.y + ", " + (p2.x - dx) + " " + p2.y + ", " + p2.x + " " + p2.y;
}
function drawGametypeConnector(){
  if(!gametypeConnectorSvg || !gametypeLayoutEl) return;
  const gtCard = document.querySelector("#screen-gametype .gametype-modes .mode.sel");
  const mdCard = document.querySelector("#gametype-opponent-wrap .modes .mode.sel");
  if(!gtCard || !mdCard){ gtcLine.setAttribute("d", ""); gtcBase.setAttribute("d", ""); return; }
  const containerRect = gametypeLayoutEl.getBoundingClientRect();
  gametypeConnectorSvg.setAttribute("viewBox", "0 0 " + containerRect.width + " " + containerRect.height);
  const p1 = gtcEdgePoint(gtCard, "right", containerRect);
  const p2 = gtcEdgePoint(mdCard, "left", containerRect);
  const d = gtcPathFor(p1, p2);
  gtcLine.setAttribute("d", d);
  gtcBase.setAttribute("d", d);
  gtcDotA.setAttribute("cx", p1.x); gtcDotA.setAttribute("cy", p1.y);
  gtcDotB.setAttribute("cx", p2.x); gtcDotB.setAttribute("cy", p2.y);
}
function drawGametypePreview(fromCard, toCard){
  if(!gtcPreview || !gametypeLayoutEl) return;
  const containerRect = gametypeLayoutEl.getBoundingClientRect();
  gtcPreview.setAttribute("d", gtcPathFor(gtcEdgePoint(fromCard, "right", containerRect), gtcEdgePoint(toCard, "left", containerRect)));
  gtcPreview.classList.add("show");
}
function clearGametypePreview(){
  if(gtcPreview) gtcPreview.classList.remove("show");
}
window.addEventListener("resize", drawGametypeConnector);
if(document.fonts && document.fonts.ready) document.fonts.ready.then(drawGametypeConnector);

// #quizHero's back control sits above the sport picker, outside the
// QUIZ_STEPS history stack the other .qback buttons rely on -- it needs
// its own in-site-history check rather than a plain history.back().
const quizHeroBackBtn = $("#quizHeroBack");
if(quizHeroBackBtn) quizHeroBackBtn.addEventListener("click", (e)=>{
  e.preventDefault();
  if(document.referrer.startsWith(location.origin) && history.length > 1){
    history.back();
  } else {
    location.href = "/";
  }
});

// screen-gametype is one level below the sport picker now (it used to be
// the root screen and had no back control of its own) -- Back here always
// means "return to the sport picker", same history.back() pattern as
// every other qback button.
const backToSportBtn = $("#back-to-sport");
if(backToSportBtn) backToSportBtn.addEventListener("click", ()=> history.back());

$("#back-from-lobby").addEventListener("click", ()=>{ stopQuestionTimer(); history.back(); });

/* ============================================================
   1) რეჟიმის არჩევა — "AI-ის წინააღმდეგ" (startLobby) ან "ადამიანის
   წინააღმდეგ" (startPvpSetup — PvP ჯგუფური ოთახი, იხ. §2.5 ქვემოთ).
   ============================================================ */

/* ============================================================
   2) ლობი — სირთულის არჩევა, შემდეგ "დაწყება"
   ============================================================ */
function startLobby(mode, opts){
  opts = opts || {};
  if(mode === "pvp"){ startPvpSetup(opts); return; }
  if(mode !== "ai") return; // დაცვა — დანარჩენი არაცნობილი რეჟიმებისთვის
  $("#lobby-belt").textContent = "აირჩიე სირთულის დონე";

  const action = $("#lobby-action");
  action.innerHTML = "";
  if(S.gameType === "guess") showGuessAIStart(action); else showAIStart(action);
  show("screen-lobby");
  if(opts.push !== false) pushQuizStep(S.gameType, "ai");
}

function buildDifficultyPicker(action, { onReady, startLabel, onStart }){
  action.innerHTML = "";
  S.aiAcc = null;

  const wrap = document.createElement("div");
  wrap.className = "difficulty";
  const chips = document.createElement("div");
  chips.className = "diff-chips";
  const note = document.createElement("div");
  note.className = "diff-note";
  wrap.appendChild(chips); wrap.appendChild(note);

  const startBtn = document.createElement("button");
  startBtn.className = "btn btn-primary"; startBtn.textContent = startLabel;
  startBtn.disabled = true;
  startBtn.onclick = ()=>{
    if(S.aiAcc == null) return;
    requireAuth(()=> startDifficulty(), { type:'ai', gameType:S.gameType, sport:S.sport });
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

  currentDifficulty().forEach(d=>{
    const c = document.createElement("button");
    c.className = "chip"; c.textContent = d.label + (d.enabled ? "" : " 🔒");
    if(!d.enabled){
      c.disabled = true;
      c.title = "მალე დაემატება - ჯერ არ არის კითხვები ამ დონეზე სერვერზე.";
    } else {
      c.onclick = ()=>{
        S.aiAcc = d.acc;
        S.diffKey = d.key;
        chips.querySelectorAll(".chip").forEach(x=> x.classList.remove("sel"));
        c.classList.add("sel");
        if(d.noteHtml){ note.innerHTML = d.noteHtml; } else { note.textContent = d.note; }
        note.style.color = d.color;
        note.classList.add("show");
        startBtn.disabled = false;
      };
    }
    chips.appendChild(c);
  });

  // წინასწარ არჩეული დონე — ერთადერთი ხელმისაწვდომი ("მარტივი") ავტომატურად
  // მონიშნულია და ღილაკი აქტიურია, მოთამაშეს აღარ სჭირდება ხელით არჩევა.
  const defaultChip = Array.from(chips.children).find((_,i)=> currentDifficulty()[i].enabled);
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

// Game recovery: a player who navigates away from this page during a live
// PvP game has no way back in otherwise -- the server already supports
// rejoining (public.rejoin_quiz_room), the client just never remembered
// which room it was in. See enterPvpLobby below and initPvpRoomRecovery
// near the bottom of this file.
const PVP_ROOM_STORAGE_KEY = "fnf_quiz_room";
const PVP_ROOM_STORAGE_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours
// awayMsUsed/awayStartedAt track the cumulative away budget (client-side
// display only, see PVP_AWAY_BUDGET_MS -- the server is the actual forfeit
// authority) across possibly multiple leave/return cycles of the same room.
function savePvpRoomRecoveryState(roomId, code){
  try{ localStorage.setItem(PVP_ROOM_STORAGE_KEY, JSON.stringify({ roomId, code, savedAt: Date.now(), awayMsUsed: 0, awayStartedAt: null })); }catch(e){}
}
function readPvpRoomRecoveryState(){
  try{
    const raw = localStorage.getItem(PVP_ROOM_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  }catch(e){ return null; }
}
function updatePvpAwayRecoveryState(patch){
  const cur = readPvpRoomRecoveryState();
  if(!cur) return;
  try{ localStorage.setItem(PVP_ROOM_STORAGE_KEY, JSON.stringify(Object.assign({}, cur, patch, { savedAt: Date.now() }))); }catch(e){}
}
function clearPvpRoomRecoveryState(){
  try{ localStorage.removeItem(PVP_ROOM_STORAGE_KEY); }catch(e){}
}
// 20000 - awayMsUsed - (time elapsed since awayStartedAt), clamped at 0 --
// display-only countdown for the recovery banner (change 2/3).
function pvpAwayRemainingMs(record){
  const used = (record && typeof record.awayMsUsed === "number") ? record.awayMsUsed : 0;
  const startedAt = (record && typeof record.awayStartedAt === "number") ? record.awayStartedAt : Date.now();
  return Math.max(0, PVP_AWAY_BUDGET_MS - used - (Date.now() - startedAt));
}

// Phase 5A: give every room a shareable/refreshable URL. history.state keeps
// whatever pushQuizStep/quizRestoreStep already put there (the popstate
// handler below reads st.quizGameType/st.quizMode from it) -- only the
// address bar itself changes, so a plain room link always resumes into the
// right place without disturbing that back/forward stack.
function setRoomUrlParam(code){
  if(!code) return;
  history.replaceState(history.state, "", quizRootForSport(S.sport) + "?room=" + encodeURIComponent(code));
}
function stripRoomParam(){
  const url = new URL(location.href);
  if(!url.searchParams.has("room")) return;
  url.searchParams.delete("room");
  history.replaceState(history.state, "", url.pathname + url.search + url.hash);
}

// Fired on 'pagehide' (navigating away / closing the tab) while a PvP game
// is active -- a normal sb.rpc() call would usually get cancelled during
// unload, so this sends a keepalive fetch instead. Deliberately not hooked
// to visibilitychange: switching tabs must do nothing (see PVP.forfeited /
// PVP.resultsShown guards below for "don't fire twice").
function pvpShouldMarkAway(){
  return !!(PVP && PVP.started && !PVP.resultsShown && !PVP.forfeited && _authAccessToken);
}
function sendQuizMarkAwayKeepalive(){
  if(!pvpShouldMarkAway()) return;
  try{
    fetch(SUPABASE_URL + "/rest/v1/rpc/quiz_mark_away", {
      method: "POST",
      keepalive: true,
      headers: {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": "Bearer " + _authAccessToken,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ p_room_id: PVP.roomId })
    });
  }catch(e){}
  updatePvpAwayRecoveryState({ awayStartedAt: Date.now() });
}
window.addEventListener("pagehide", sendQuizMarkAwayKeepalive);

function resetPvp(){
  stopPvpWaitPolling();
  stopPvpLobbyPolling();
  stopGuessWhoAfkWatch();
  if(PVP){
    try{ if(PVP.playersChannel) sb.removeChannel(PVP.playersChannel); }catch(e){}
    try{ if(PVP.roomChannel) sb.removeChannel(PVP.roomChannel); }catch(e){}
  }
  PVP = null;
}

// Compact classic dropdown -- guess-who PvP room creation's answer-time
// picker (see startPvpSetup below). Absolutely positioned via CSS, so
// opening/closing it never moves, grows or stretches anything else on
// the page. These two document-level listeners are registered once, here
// at parse time (not inside startPvpSetup, which re-runs every visit to
// the screen) -- closes on an option pick (handled separately, inside
// startPvpSetup), a click anywhere outside it, or Escape.
//
// #pvp-create-panel also gets .answer-time-dd-open toggled here, not
// just the list's own .show -- that .pvp-panel is what actually traps
// the dropdown (opacity:.9/.8 makes it a stacking context, quiz-page.
// template.html's own comment by #quizRoot .pvp-panel.answer-time-dd-open
// has the full explanation), so closing it here (not just on the list)
// is what lets the join-room panel and the mobile bottom nav paint over
// it again once it's closed.
function closeAnswerTimeDropdown(){
  const btn = document.getElementById("pvp-answer-time-btn");
  const list = document.getElementById("pvp-answer-time-list");
  const panel = document.getElementById("pvp-create-panel");
  if(btn) btn.setAttribute("aria-expanded", "false");
  if(list) list.classList.remove("show");
  if(panel) panel.classList.remove("answer-time-dd-open");
}
document.addEventListener("click", (e)=>{
  const wrap = document.getElementById("pvp-answer-time-wrap");
  if(wrap && !wrap.contains(e.target)) closeAnswerTimeDropdown();
});
document.addEventListener("keydown", (e)=>{
  if(e.key === "Escape") closeAnswerTimeDropdown();
});

function startPvpSetup(opts){
  opts = opts || {};
  resetPvp();
  const diffWrap = $("#pvp-create-diff");
  diffWrap.innerHTML = "";
  let chosenLevel = null;
  const createBtn = $("#pvp-create-btn");
  createBtn.disabled = true;
  createBtn.textContent = "ოთახის შექმნა";

  const chips = document.createElement("div");
  chips.className = "diff-chips";
  currentDifficulty().forEach(d=>{
    const c = document.createElement("button");
    c.className = "chip"; c.textContent = d.label + (d.enabled ? "" : " 🔒");
    if(!d.enabled){
      c.disabled = true;
      c.title = "მალე დაემატება - ჯერ არ არის კითხვები ამ დონეზე სერვერზე.";
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
  const defaultChip = Array.from(chips.children).find((_,i)=> currentDifficulty()[i].enabled);
  if(defaultChip) defaultChip.click();

  // Answer-time control -- guess-who PvP only (decision: regular quiz PvP
  // keeps its fixed 30s timer untouched, this control doesn't apply there
  // and stays hidden). Default on screen load: 40s, i.e. byte-for-byte
  // today's existing fixed GUESS_TIME_PER_Q behaviour, unless the host
  // actually picks a different option -- see pvpAnswerTimeOff()/
  // startGuessTimer() and supabase/quiz_pvp_answer_time.sql.
  const atWrap = $("#pvp-answer-time-wrap");
  const atBtn = $("#pvp-answer-time-btn");
  const atValue = $("#pvp-answer-time-value");
  const atList = $("#pvp-answer-time-list");
  let answerTimeSeconds = 40;
  if(S.gameType === "guess"){
    atWrap.style.display = "";
    closeAnswerTimeDropdown();
    atValue.textContent = "40 წამი";
    atList.querySelectorAll(".answer-time-dd-opt").forEach(opt=>{
      const isDefault = opt.dataset.seconds === "40";
      opt.classList.toggle("sel", isDefault);
      opt.setAttribute("aria-selected", String(isDefault));
      opt.onclick = ()=>{
        answerTimeSeconds = opt.dataset.seconds === "" ? null : Number(opt.dataset.seconds);
        atValue.textContent = opt.textContent;
        atList.querySelectorAll(".answer-time-dd-opt").forEach(x=>{
          x.classList.toggle("sel", x === opt);
          x.setAttribute("aria-selected", String(x === opt));
        });
        closeAnswerTimeDropdown();
      };
    });
    atBtn.onclick = (e)=>{
      e.stopPropagation();
      const open = atBtn.getAttribute("aria-expanded") === "true";
      if(open){ closeAnswerTimeDropdown(); return; }
      atBtn.setAttribute("aria-expanded", "true");
      atList.classList.add("show");
      const panel = document.getElementById("pvp-create-panel");
      if(panel) panel.classList.add("answer-time-dd-open");
    };
  } else {
    atWrap.style.display = "none";
  }

  createBtn.onclick = ()=> requireAuth(
    ()=> createPvpRoom(chosenLevel, S.gameType === "guess" ? answerTimeSeconds : undefined),
    { type:'pvp-create', gameType:S.gameType, sport:S.sport }
  );

  const codeInput = $("#pvp-join-code");
  const joinErr = $("#pvp-join-error");
  joinErr.style.display = "none";
  // დეპ-ლინკი (fnf.ge/quiz/ufcquiz/?room=ABC123 და ა.შ.) — კოდი წინასწარ ივსება.
  const urlCode = new URLSearchParams(location.search).get("room");
  codeInput.value = urlCode ? urlCode.toUpperCase() : "";

  $("#pvp-join-btn").onclick = ()=> requireAuth(()=> joinPvpRoom(codeInput.value), { type:'pvp-join', gameType:S.gameType, sport:S.sport, roomCode:codeInput.value });

  show("screen-pvp-setup");
  if(opts.push !== false) pushQuizStep(S.gameType, "pvp");
}

function pvpErrorMessage(err){
  const msg = (err && err.message) || "";
  if(msg.includes("room not found")) return "ასეთი ოთახი ვერ მოიძებნა.";
  if(msg.includes("room expired")) return "ოთახს ვადა გაუვიდა.";
  if(msg.includes("already full or finished")) return "ოთახი უკვე დაწყებულია ან დასრულდა.";
  if(msg.includes("room is full")) return "ოთახი სავსეა.";
  if(msg.includes("own room")) return "საკუთარ ოთახში ვერ შეხვალ.";
  return msg || "დაფიქსირდა შეცდომა - სცადე თავიდან.";
}

// answerTimeSeconds: undefined for regular quiz (control doesn't apply,
// nothing to persist), or a guess-who room's choice from the dropdown --
// a number (30/40/60), or null for "გამორთული" (off). See startPvpSetup
// above and supabase/quiz_pvp_answer_time.sql.
async function createPvpRoom(level, answerTimeSeconds){
  if(!level || !sb) return;
  const btn = $("#pvp-create-btn");
  btn.disabled = true; btn.textContent = "იქმნება…";
  try{
    const { data, error } = await sb.rpc('create_quiz_room', { p_game_type: S.gameType || 'quiz', p_level: level, p_category: S.sport || 'UFC' });
    if(error || !data || !data.length){
      showQuizToast("ოთახის შექმნა ვერ მოხერხდა: " + pvpErrorMessage(error), 3500);
      btn.disabled = false; btn.textContent = "ოთახის შექმნა";
      return;
    }
    const row = data[0];
    S.gameType = S.gameType || 'quiz';
    // Must be awaited (not fire-and-forget) and must happen before
    // enterPvpLobby below shows the room code -- that's the ordering
    // that guarantees a guest can never join before this is committed.
    // A failure here just leaves the column at its default (off) instead
    // of blocking room creation over a non-critical setting.
    if(answerTimeSeconds !== undefined){
      try{
        await sb.rpc('set_quiz_room_answer_time', { p_room_id: row.room_id, p_seconds: answerTimeSeconds });
      }catch(e){ console.warn("[quiz] set_quiz_room_answer_time failed:", e); }
    }
    enterPvpLobby({ roomId: row.room_id, code: row.code, isHost: true, questions: row.questions });
  }catch(e){
    showQuizToast("დაფიქსირდა შეცდომა - სცადე თავიდან.", 3500);
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
    S.sport = row.category || 'UFC';
    updateLandAbout();
    enterPvpLobby({ roomId: row.room_id, code, isHost: false, questions: row.questions });
  }catch(e){
    err.textContent = "დაფიქსირდა შეცდომა - სცადე თავიდან.";
    err.style.display = "block";
    btn.disabled = false; btn.textContent = "ოთახში შესვლა";
  }
}

function enterPvpLobby({ roomId, code, isHost, questions }){
  savePvpRoomRecoveryState(roomId, code);
  setRoomUrlParam(code);
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
    resultsLoading: false,
    answerTimeSeconds: null, // guess-who only -- fetched below, see pvpAnswerTimeOff()
  };
  fetchPvpAnswerTime();
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
  startPvpLobbyPolling();
  show("screen-pvp-lobby");
}

// Guess-who PvP's per-room answer-time setting (supabase/
// quiz_pvp_answer_time.sql) -- a plain select, not an RPC: quiz_rooms
// already has a public SELECT RLS policy (quiz_rooms_select_all), so this
// needs no new grant and touches none of create_quiz_room/join_quiz_room/
// rejoin_quiz_room/start_quiz_room. Read here for BOTH host and guest
// (not trusted from the host's own in-memory choice at creation time), so
// a refresh/rejoin mid-lobby always reflects what's actually committed
// server-side, not a stale local value.
async function fetchPvpAnswerTime(){
  if(!PVP || !sb) return;
  const roomId = PVP.roomId;
  try{
    const { data, error } = await sb.from('quiz_rooms').select('answer_time_seconds').eq('id', roomId).single();
    if(error){ console.warn("[quiz] fetchPvpAnswerTime failed:", error.message || error); return; }
    if(PVP && PVP.roomId === roomId) PVP.answerTimeSeconds = (data && data.answer_time_seconds) || null;
  }catch(e){ console.warn("[quiz] fetchPvpAnswerTime failed:", e); }
}

// true only for a guess-who PvP room whose host explicitly turned the
// per-question timer off -- this control doesn't exist for regular quiz
// PvP (always false there, see startPvpSetup/createPvpRoom), so
// S.gameType==="guess" is implied whenever this returns true in practice.
function pvpAnswerTimeOff(){
  return !!(PVP && S.gameType === "guess" && PVP.answerTimeSeconds == null);
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
  if(a && a.avatar_type === "photo" && a.avatar_url) return `<img src="${escapeHtml(a.avatar_url)}" alt="" />`;
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
  PVP.isHost = PVP.players.some(p=> p.player_id === PVP.myId && p.is_host);
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
      `<span class="nm">${escapeHtml(p.player_name)}${isMe ? " (შენ)" : ""}</span>`+
      (p.is_host ? `<span class="tag">ჰოსტი</span>` : "");
    list.appendChild(row);
  });
  // ბოლო მოთამაშის ქვეშ - მაქსიმუმ ერთი "თავისუფალი ადგილი" მწკრივი,
  // ვიზუალურად რომ ჩანდეს ველოდებით კიდევ ვინმეს. დარჩენილი ადგილების
  // საერთო რაოდენობა #pvp-players-count-შია, ამიტომ დანარჩენი ცარიელი
  // სლოტების რენდერი არ სჭირდება (9 მოთამაშემდე რომ აღარ გაიწელოს სია).
  if(PVP.players.length < PVP.maxPlayers){
    const row = document.createElement("div");
    row.className = "pvp-player-empty";
    row.innerHTML = `<span class="ava">+</span><span class="nm">თავისუფალი ადგილი</span>`;
    list.appendChild(row);
  }
  $("#pvp-players-count").textContent = `${PVP.players.length} / ${PVP.maxPlayers} მოთამაშე`;
  const startBtn = $("#pvp-start-btn");
  const hint = $("#pvp-lobby-hint");
  startBtn.style.display = PVP.isHost ? "" : "none";
  if(PVP.isHost){
    const enough = PVP.players.length >= 2;
    startBtn.disabled = !enough;
    hint.textContent = "ველოდებით მინიმუმ 1 მეგობარს...";
    hint.style.display = enough ? "none" : "";
  } else {
    hint.textContent = "ველოდებით ჰოსტს დაწყებას...";
    hint.style.display = "";
  }
}

function renderPvpWaitCount(){
  if(!PVP) return;
  const finished = PVP.players.filter(p=> p.finished_at).length;
  $("#pvp-wait-count").textContent = `${finished} / ${PVP.players.length} დაასრულა`;
  // Fallback for a missed quiz_rooms Realtime "finished" event: the player
  // list (kept current by refreshPvpPlayers, including the interval below)
  // already says everyone is done, so act on it instead of waiting on an
  // event that may never arrive. onPvpRoomFinished's own guards make this
  // safe to call repeatedly and safe to call alongside the Realtime path.
  if(PVP.players.length && finished >= PVP.players.length) onPvpRoomFinished();
}

// Safety net for the case where the quiz_room_players Realtime event is
// also missed (not just quiz_rooms) -- e.g. a phone that drops its
// websocket silently. Polls the same refreshPvpPlayers() the subscription
// already calls, which re-renders the count above and re-checks the
// fallback. 4s keeps screen-pvp-wait responsive (it is normally only on
// screen for the few seconds until the last player finishes) without
// adding meaningful load for the free Supabase tier -- one lightweight
// select on an indexed room_id per still-waiting client.
let _pvpWaitInterval = null;
function stopPvpWaitPolling(){
  if(_pvpWaitInterval){ clearInterval(_pvpWaitInterval); _pvpWaitInterval = null; }
}
function startPvpWaitPolling(){
  stopPvpWaitPolling();
  _pvpWaitInterval = setInterval(refreshPvpPlayers, 4000);
}

// Same fallback as startPvpWaitPolling above, for the lobby screen --
// subscribePvpRoom's playersChannel.subscribe() takes no status callback,
// so a dropped/never-connected Realtime subscription here was previously
// completely silent: enterPvpLobby called refreshPvpPlayers() exactly
// once, and a player already sitting in the lobby had no other path that
// ever asked the server again, so a friend joining never appeared without
// a manual page reload. Same 4s interval/reasoning as the wait screen.
let _pvpLobbyInterval = null;
function stopPvpLobbyPolling(){
  if(_pvpLobbyInterval){ clearInterval(_pvpLobbyInterval); _pvpLobbyInterval = null; }
}
function startPvpLobbyPolling(){
  stopPvpLobbyPolling();
  _pvpLobbyInterval = setInterval(refreshPvpPlayers, 4000);
}

function onPvpRoomActive(){
  if(!PVP || PVP.started) return;
  PVP.started = true;
  setRoomUrlParam(PVP.code);
  S.questions = PVP.questions || [];
  S.qi = 0;
  S.playerPicks = []; S.playerPoints = [];
  S.consecTimeouts = 0;
  if(S.gameType === "guess") S.gCluesShown = 1;
  show(S.gameType === "guess" ? "screen-guess" : "screen-quiz");
  renderQuestion();
}

function finishPvpQuiz(){
  show("screen-pvp-wait");
  renderPvpWaitCount();
  startPvpWaitPolling();
}

// roomId defaults to PVP.roomId; an explicit override lets a caller submit
// against a room before PVP itself has been rebuilt.
async function submitPvpAnswer(qIndex, pick, roomId){
  roomId = roomId || (PVP && PVP.roomId);
  if(!roomId || !sb) return;
  try{
    const { error } = await sb.rpc('submit_quiz_answer', { p_room_id: roomId, p_question_index: qIndex, p_pick: pick });
    if(error){
      console.warn("[quiz] PvP submit_quiz_answer failed:", error.message || error);
      if(PVP && /player forfeited/.test(error.message || "")) PVP.forfeited = true;
    }
  }catch(e){ console.warn("[quiz] PvP submit_quiz_answer failed:", e); }
}

async function revealPvpClue(qIndex){
  if(!PVP || !sb) return;
  try{
    const { error } = await sb.rpc('reveal_quiz_clue', { p_room_id: PVP.roomId, p_question_index: qIndex });
    if(error) console.warn("[quiz] PvP reveal_quiz_clue failed:", error.message || error);
  }catch(e){ console.warn("[quiz] PvP reveal_quiz_clue failed:", e); }
}

// Two independent signals can call this for the same room (the quiz_rooms
// Realtime "finished" event, and the renderPvpWaitCount fallback above,
// itself driven by both the quiz_room_players subscription and the
// interval poll) -- resultsShown guards against showing the results twice,
// and resultsLoading guards against two overlapping get_quiz_results calls
// when both signals fire within the same tick (resultsShown alone would
// not catch that, since it is only set after a call succeeds, below).
async function onPvpRoomFinished(){
  if(!PVP || PVP.resultsShown || PVP.resultsLoading) return;
  PVP.resultsLoading = true;
  let data, error;
  try{
    ({ data, error } = await sb.rpc('get_quiz_results', { p_room_id: PVP.roomId }));
  }catch(e){
    // Network/transport failure, not a server-side rejection -- same
    // "stay retriable" contract as the two branches below: resultsShown
    // is never touched here, so the next poll tick or Realtime event
    // tries again instead of the player being stuck silently.
    console.warn("[quiz] PvP get_quiz_results request failed:", e);
    if(PVP) PVP.resultsLoading = false;
    return;
  }
  if(error){
    // The fallback above can fire a moment before sweep_quiz_room (called
    // inside get_quiz_results itself) has flipped the room to 'finished'
    // server-side -- supabase/quiz_presence.sql's get_quiz_results then
    // raises exactly this message. Leaving resultsShown false lets the
    // Realtime event or the next poll retry; it must not be silenced here.
    if(!/room not finished yet/.test(error.message || "")){
      showQuizToast("შედეგების ჩატვირთვა ვერ მოხერხდა.", 3500);
    }
    if(PVP) PVP.resultsLoading = false;
    return;
  }
  if(!data || !data.length){
    showQuizToast("შედეგების ჩატვირთვა ვერ მოხერხდა.", 3500);
    if(PVP) PVP.resultsLoading = false;
    return;
  }
  // Rendering gets its OWN try/catch, separate from the RPC call above --
  // a bug in renderPvpResults must not look like (or permanently behave
  // like) a failed RPC response. resultsShown is only set AFTER render
  // actually succeeds, so a throw here leaves it false: the next poll
  // tick or Realtime event calls this function again from scratch and
  // retries the render, instead of the player being stranded forever
  // with resultsShown already (wrongly) true. The player sees no change
  // on a failed attempt -- still screen-pvp-wait, same ველოდებით
  // ოპონენტებს/counter text already on screen -- until a later attempt
  // renders successfully.
  try{
    renderPvpResults(data[0]);
    clearPvpRoomRecoveryState();
    PVP.resultsShown = true;
    show("screen-pvp-results");
  }catch(e){
    console.error("[quiz] PvP results render failed -- will retry on next poll/Realtime tick:", e, { roomId: PVP.roomId, result: data[0] });
  }
  if(PVP) PVP.resultsLoading = false;
}

function onPvpRoomAbandoned(){
  if(!PVP) return;
  clearPvpRoomRecoveryState();
  stripRoomParam();
  showQuizToast("ოთახი დაიხურა.", 3500);
  resetPvp();
  chooseGameType("quiz", { push:false }); // ეკრანის ხელახლა გახსნისას ისევ ქვიზი წინასწარ არჩეული
}

// get_quiz_results sorts players by total_score desc already (see
// supabase/quiz_category_isolation.sql's get_quiz_results -- "order by
// pr.total_score desc, pr.joined_at asc") -- this just assigns the dense
// place number on top of that existing order: tied scores share one place
// number, and the next *distinct* score gets the very next number (no
// gaps), e.g. two players tied at the top are both "1", the next player
// is "2", not "3".
function renderPvpResults(result){
  const players = (result && result.players) || [];
  const restEl = $("#pvp-rest-list"); restEl.innerHTML = "";

  let rank = 0, prevScore = null;
  players.forEach(p=>{
    if(prevScore === null || p.total_score !== prevScore){ rank++; prevScore = p.total_score; }
    const isMe = PVP && p.player_id === PVP.myId;
    const row = document.createElement("div");
    row.className = "pvp-rest-row";
    row.innerHTML = `<span class="rank">${rank}</span>`+
      `<span class="nm">${escapeHtml(p.player_name)}${isMe ? " (შენ)" : ""}</span>`+
      `<span class="pts">${p.total_score}</span>`;
    restEl.appendChild(row);
  });

  renderPvpResultsReview(result, players);
}

// Same per-question correct/wrong breakdown as the offline vs-AI results
// screen (renderReview above -- reuses its .cb-review* classes so both
// screens read the same way), generalized from the fixed you/AI pair to
// however many players were in the room. S.questions/PVP.questions never
// carried the correct answer to the client during play (PvP anti-cheat,
// see submitGuess's own comment on this) -- result.answer_key (from
// get_quiz_results, same array order as S.questions) is what finally
// reveals it, now that the game is over.
function renderPvpResultsReview(result, players){
  const list = $("#pvpResultsReviewList");
  if(!list) return;
  const answerKey = (result && result.answer_key) || [];
  const isGuess = S.gameType === "guess";
  list.innerHTML = "";

  S.questions.forEach((item, i)=>{
    const qText = isGuess ? ((item.clues && item.clues[0]) || "") : (item.q || "");
    const correctText = isGuess ? String(answerKey[i] ?? "") : ((item.o && item.o[answerKey[i]] != null) ? item.o[answerKey[i]] : "");

    const rowsHtml = players.map(p=>{
      const isMe = PVP && p.player_id === PVP.myId;
      const pick = p.picks ? p.picks[String(i)] : undefined;
      const points = (p.points ? p.points[String(i)] : 0) || 0;
      const ok = points > 0;
      let pText;
      if(isGuess){
        // Another player's free-text guess -- unlike item.q/item.o/answerKey
        // (trusted, author-written question content), this came from a
        // participant's own input, so it must be escaped same as nick/
        // player_name elsewhere in this file.
        pText = (pick != null && String(pick).trim()) ? escapeHtml(String(pick)) : "პასუხი არ გაეცა";
      } else {
        pText = (typeof pick === "number" && pick >= 0 && item.o && item.o[pick] != null) ? item.o[pick] : "პასუხი არ გაეცა";
      }
      return `<div class="cb-review-a ${ok ? "ok" : "bad"}">${escapeHtml(p.player_name)}${isMe ? " (შენ)" : ""}: ${pText} <span class="pts">${points}</span></div>`;
    }).join("");

    const row = document.createElement("div");
    row.className = "cb-review-item";
    row.innerHTML = `
      <div class="cb-review-q"><span class="cb-review-num">${i+1}.</span>${qText}</div>
      ${rowsHtml}
      <div class="cb-review-correct">სწორი პასუხი: ${correctText}</div>`;
    list.appendChild(row);
  });
}

$("#back-to-mode-from-pvp").addEventListener("click", ()=>{ resetPvp(); history.back(); });

async function leavePvpRoom(){
  clearPvpRoomRecoveryState();
  stripRoomParam();
  if(PVP){ try{ await sb.rpc('leave_quiz_room', { p_room_id: PVP.roomId }); }catch(e){} }
  resetPvp();
  history.back();
}
$("#pvp-leave-btn").addEventListener("click", leavePvpRoom);
$("#back-from-pvp-wait").addEventListener("click", leavePvpRoom);

$("#pvp-start-btn").addEventListener("click", async ()=>{
  if(!PVP || !PVP.isHost) return;
  const btn = $("#pvp-start-btn");
  btn.disabled = true; btn.textContent = "იწყება…";
  try{
    const { error } = await sb.rpc('start_quiz_room', { p_room_id: PVP.roomId });
    if(error){
      showQuizToast("დაწყება ვერ მოხერხდა: " + pvpErrorMessage(error), 3500);
      btn.disabled = false; btn.textContent = "დაწყება";
    }
    // წარმატების შემთხვევაში quiz_rooms-ის Realtime UPDATE (status->active)
    // თავად გამოიძახებს onPvpRoomActive()-ს ყველასთვის, ჰოსტის ჩათვლით.
  }catch(e){
    showQuizToast("დაფიქსირდა შეცდომა.", 3500);
    btn.disabled = false; btn.textContent = "დაწყება";
  }
});

// R8: prompt()-ის ნაცვლად — style.css-ის არსებული .toast/.toast.show
// (ბარგამოყენებელი სხვაგან აქამდე) პატერნი: fade+slide, 1.5წმ, თვითონ შლის თავს.
function showQuizToast(msg, duration=1500){
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(()=> el.classList.add("show"));
  setTimeout(()=>{
    el.classList.remove("show");
    setTimeout(()=> el.remove(), 350);
  }, duration);
}

// Clipboard API-ის fallback — ფარული textarea + document.execCommand('copy'),
// ყოველთვის შლის textarea-ს. readonly ხელს უშლის მობილურზე კლავიატურის
// გამოჩენას select()-ზე.
function legacyCopy(text){
  try{
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }catch(e){ return false; }
}

async function copyToClipboard(text){
  try{
    if(navigator.clipboard && navigator.clipboard.writeText){
      await navigator.clipboard.writeText(text);
      return true;
    }
  }catch(e){}
  try{ return legacyCopy(text); }catch(e){ return false; }
}

$("#pvp-copy-link").addEventListener("click", async ()=>{
  if(!PVP) return;
  const url = location.origin + quizRootForSport(S.sport) + "?room=" + PVP.code;
  const btn = $("#pvp-copy-link");
  try{
    const ok = await copyToClipboard(url);
    if(ok){
      btn.textContent = "დაკოპირდა ✓";
      setTimeout(()=> btn.textContent = "ოთახის ლინკის კოპირება", 1500);
      showQuizToast("ლინკი დაკოპირებულია");
    } else {
      showQuizToast("კოპირება ვერ მოხერხდა");
    }
  }catch(e){
    showQuizToast("კოპირება ვერ მოხერხდა");
  }
});

$("#pvp-copy-code").addEventListener("click", async ()=>{
  if(!PVP) return;
  const btn = $("#pvp-copy-code");
  try{
    const ok = await copyToClipboard(PVP.code);
    if(ok){
      btn.textContent = "დაკოპირდა ✓";
      setTimeout(()=> btn.textContent = "კოდის კოპირება", 1500);
      showQuizToast("კოდი დაკოპირებულია");
    } else {
      showQuizToast("კოპირება ვერ მოხერხდა");
    }
  }catch(e){
    showQuizToast("კოპირება ვერ მოხერხდა");
  }
});

function finishPvpResults(){
  clearPvpRoomRecoveryState();
  stripRoomParam();
  resetPvp();
  chooseGameType("quiz", { push:false }); // ეკრანის ხელახლა გახსნისას ისევ ქვიზი წინასწარ არჩეული
  pushQuizStep(null, null);
}
$("#pvp-results-done").addEventListener("click", finishPvpResults);
$("#back-from-pvp-results").addEventListener("click", finishPvpResults);

/* ============================================================
   3) ქვიზი
   ============================================================ */
/* ============================================================
   "რთული" დონის AI-ის ზედა ზღვარი — დანარჩენი დონეებისგან განსხვავებით
   (დამოუკიდებელი per-question ალბათობა, იხ. DIFFICULTY[].acc) "რთულზე"
   AI-ის საბოლოო შედეგი ზუსტად იზღუდება, რომ მოთამაშეს მოგების შანსი
   დარჩეს: ქვიზში ყოველთვის კითხვების რაოდენობის 80% ან 90% სწორი პასუხი
   (არასდროს 100%, არასდროს <80%), "ვინ ვარ?"-ში კი ქულების ჯამი —
   მაქსიმალური შესაძლო ჯამის შემთხვევითი 80-90%, კითხვებზე განაწილებული. */
function computeHardQuizAnswers(n){
  const wrongCount = Math.max(1, Math.round(n * (Math.random() < 0.5 ? 0.2 : 0.1)));
  const wrongIdx = new Set(shuffle(Array.from({length:n}, (_,i)=>i)).slice(0, wrongCount));
  return Array.from({length:n}, (_,i)=> !wrongIdx.has(i));
}

function computeHardGuessPoints(n){
  const maxTotal = n * 4;
  const target = Math.round(maxTotal * (0.8 + Math.random() * 0.1));
  const points = new Array(n).fill(4);
  let excess = maxTotal - target;
  for(const i of shuffle(Array.from({length:n}, (_,i)=>i))){
    if(excess <= 0) break;
    const reduceBy = Math.min(points[i] - 1, excess);
    points[i] -= reduceBy;
    excess -= reduceBy;
  }
  return points;
}

async function beginQuiz(){
  let pool = null;
  const diff = currentDifficulty().find(d => d.key === S.diffKey);

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
  const isHard = !!(diff && diff.key === "hard");
  const acc = (S.aiAcc != null) ? S.aiAcc : AI_ACCURACY;
  if(isHard){
    S.aiAnswers = S.gameType === "guess" ? S.questions.map(()=>true) : computeHardQuizAnswers(S.questions.length);
  } else {
    S.aiAnswers = S.questions.map(()=> Math.random() < acc);
  }

  if(S.gameType === "guess"){
    S.oppPicks = S.questions.map((item,i)=>{
      if(S.aiAnswers[i]) return item.answer;
      const others = pool.filter(p=>p.answer!==item.answer);
      const pick = others.length ? others[Math.floor(Math.random()*others.length)] : item;
      return pick.answer;
    });
    S.oppPoints = isHard ? computeHardGuessPoints(S.questions.length) : S.questions.map((item,i)=>{
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

/* ---------- backgrounding — rAF stops entirely while the tab is hidden,
   and mobile browsers aggressively throttle background timers, so this
   can't rely on anything having "run" while away. S.timerDeadline is a
   performance.now()-based absolute instant, which keeps advancing while
   hidden regardless — that's what both branches below reconcile against.

   OFFLINE (vs AI): pause — stash the remaining time on hide, rebuild the
   deadline from it on return. No question lost, nothing auto-answered.

   ONLINE (PvP): the deadline is left untouched while hidden (time keeps
   "running" exactly as if watching). On return, any question whose
   deadline has already passed is submitted as a timeout — exactly the
   same submit_quiz_answer call the live countdown's own timeout path
   uses, just without the visual feedback nobody was there to see — once
   per question, fast-forwarded silently, until landing on the first
   question whose fresh deadline is still ahead. PvP has no shared
   "current question" pointer (quiz_room_answers is per-player), so this
   is catching up the player's own timeline, which is the only thing
   there is to catch up to. ---------- */
let _timerSuspendedForHidden = false;

function onQuizPageHidden(){
  if(!S.timerRaf) return;
  cancelAnimationFrame(S.timerRaf);
  S.timerRaf = null;
  _timerSuspendedForHidden = true;
  if(!PVP) S.timerHiddenRemaining = Math.max(0, S.timerDeadline - performance.now());
}

function onQuizPageVisible(){
  if(!_timerSuspendedForHidden) return;
  _timerSuspendedForHidden = false;
  if(PVP) catchUpPvpTimer();
  else {
    S.timerDeadline = performance.now() + (S.timerHiddenRemaining || 0);
    S.timerRaf = requestAnimationFrame(tickQuestionTimer);
  }
}

document.addEventListener("visibilitychange", ()=>{
  if(document.hidden) onQuizPageHidden(); else onQuizPageVisible();
});

// Silently submits the same timeout a live countdown would (pick=-1 for
// quiz, pick="" for guess-who — identical to answer(-1,null)'s and a
// forced submitGuess()'s own submission), without any of the visual
// feedback those paths show for a question the player actually watched.
function submitPvpTimeoutSilently(){
  const pick = S.gameType === "guess" ? "" : -1;
  S.playerPicks[S.qi] = pick;
  S.playerPoints[S.qi] = 0;
  submitPvpAnswer(S.qi, pick);
}

function catchUpPvpTimer(){
  const overrun = performance.now() - S.timerDeadline;
  if(overrun <= 0){
    S.timerRaf = requestAnimationFrame(tickQuestionTimer);
    return;
  }
  // Mirrors startGuessTimer's own base-duration pick below -- a room with
  // a custom guess-who answer time (30/40/60) must reconcile against that
  // same duration, not the hardcoded default, or this skips the wrong
  // number of questions. Never reached for an answer-time-OFF room: that
  // mode never sets S.timerRaf in the first place (see renderGuessQuestion),
  // so onQuizPageHidden's own guard already skips calling this at all.
  const totalMs = (S.gameType === "guess")
    ? ((PVP && typeof PVP.answerTimeSeconds === "number") ? PVP.answerTimeSeconds : GUESS_TIME_PER_Q) * 1000
    : PVP_TIME_PER_Q * 1000;
  const questionsToSkip = Math.floor(overrun / totalMs) + 1;
  for(let i = 0; i < questionsToSkip && S.qi < S.questions.length; i++){
    submitPvpTimeoutSilently();
    S.qi++;
  }
  advanceOrFinish(); // finishes if S.qi ran out, otherwise renders the
                      // landing question with a full fresh timer — same
                      // dispatch the normal in-game flow already uses.
}

/* ---------- PvP AFK rule — 2 consecutive timeouts shrink every following
   question's timer to AFK_SHORT_TIME_MS and surface a "დაბრუნება" button
   (vs-AI games never set S.consecTimeouts, so pvpAfkModeActive is always
   false there). ---------- */
function pvpAfkModeActive(){
  return !!(PVP && S.consecTimeouts >= AFK_TIMEOUT_THRESHOLD);
}
function updateAfkButtonVisibility(){
  const show = pvpAfkModeActive();
  const qBtn = document.getElementById("q-afk-btn");
  const gqBtn = document.getElementById("gq-afk-btn");
  if(qBtn) qBtn.style.display = show ? "" : "none";
  if(gqBtn) gqBtn.style.display = show ? "" : "none";
}
function handleAfkReturnClick(){
  S.consecTimeouts = 0;
  if(S.gameType === "guess") startGuessTimer(); else startTimer();
}
(function initAfkButtons(){
  const qBtn = document.getElementById("q-afk-btn");
  if(qBtn) qBtn.addEventListener("click", handleAfkReturnClick);
  const gqBtn = document.getElementById("gq-afk-btn");
  if(gqBtn) gqBtn.addEventListener("click", handleAfkReturnClick);
})();

function startTimer(){
  const totalMs = pvpAfkModeActive() ? AFK_SHORT_TIME_MS : (PVP ? PVP_TIME_PER_Q : TIME_PER_Q) * 1000;
  startQuestionTimer($("#q-timer"), $("#q-timer-num"), totalMs, ()=> answer(-1, null));
  updateAfkButtonVisibility();
}

/* ---------- „ვინ ვარ?“ — პროგრესული მინიშნებები (AI-ის წინააღმდეგ) ----------
   თაიმერი არაა — უპასუხე შენი ტემპით; პასუხის შემდეგ დაუყოვნებლივ ჩანს
   სწორია თუ არა, „შემდეგი“ ღილაკზე დაჭერით გააგრძელებ. ქულა დამოკიდებულია
   რამდენი მინიშნება გახსენი პასუხის გაცემამდე: 1→4, 2→3, 3→2, 4→1. ------ */
function guessPointsNow(){
  return Math.max(1, Math.min(4, 5 - S.gCluesShown));
}
function updateGuessPoints(){
  const el = $("#gq-points");
  if(el) el.textContent = guessPointsNow() + " ქულა";
}
// დინამიკური ლეიბლი პასუხის ველზე — კითხვის sub_category-ზე დაყრდნობით
// (display-only, არასდროს ფილტრავს/აჯგუფებს კითხვების პულს). PvP-ში item.answer
// არ მოსდის კლიენტს (ანტი-ჩიტი), ამიტომ RCDE-ის განსაკუთრებული შემთხვევა
// is_abbrev_hint დროშითაა მონიშნული სერვერზე (create_quiz_room/get_ai_quiz_questions),
// პასუხის ტექსტის გამჟღავნების გარეშე.
function guessWhoInputLabel(item){
  if(item && item.is_abbrev_hint) return "გამოიცანი მოედანი (ინგლისური აბრევიატურა ქართულად ან ინგლისურად)";
  if(S.sport !== "Football") return "გამოიცანი მებრძოლი";
  switch(item && item.sub_category){
    case "ფეხბურთელი": return "გამოიცანი ფეხბურთელი";
    case "გუნდი":      return "გამოიცანი კლუბი";
    case "სტადიონი":   return "გამოიცანი მოედანი";
    case "მსაჯი":      return "გამოიცანი მსაჯი";
    case "მწვრთნელი":  return "გამოიცანი მწვრთნელი";
    default:            return "გამოიცანი";
  }
}
function renderGuessQuestion(){
  const item = S.questions[S.qi];
  $("#gq-idx").textContent = S.qi+1;
  $("#gq-num").textContent = S.qi+1;
  S.gCluesShown = 1;
  updateGuessPoints();
  renderGuessClues();

  const inputLabel = guessWhoInputLabel(item);
  const inputLabelEl = $("#gq-input-label");
  if(inputLabelEl) inputLabelEl.textContent = inputLabel;

  const inp = $("#gq-input");
  inp.setAttribute("aria-label", inputLabel);
  inp.value = ""; inp.disabled = false;
  $("#gq-submit").disabled = false;
  $("#gq-idk").disabled = false;
  $("#gq-next-clue").disabled = (item.clues.length <= 1);
  $("#gq-answer-area").style.display = "";

  const fb = $("#gq-feedback");
  fb.classList.remove("show","ok","bad");
  fb.innerHTML = "";
  const nextQBtn = $("#gq-next-q");
  nextQBtn.style.display = "none";
  nextQBtn.onclick = null;

  // Answer-time OFF (guess-who PvP only) replaces the visible countdown
  // with the "აქ ხარ?" presence check instead -- see startGuessWhoAfkWatch.
  if(pvpAnswerTimeOff()){
    $("#gq-timer-row").style.display = "none";
    startGuessWhoAfkWatch();
  } else {
    startGuessTimer();
  }

  // 2026-11-22: same scrollIntoView call submitGuess() already uses to
  // bring .qcard back into view (the "one deliberate scroll in the whole
  // quiz flow" comment there), reused here so it also fires when the NEW
  // question actually renders -- not just at submit/feedback time. Single
  // player's normal-answer path already happened to land in the right
  // place because nothing moved the viewport between that submit-time
  // scroll and the next render; "არ ვიცი" (submitGuess(false, true)) and
  // every PvP path (which returns out of submitGuess before reaching that
  // scroll at all -- PvP renders its next question immediately, no
  // separate "next question" click) did not. This one call, unconditional
  // and un-branched by viewport width, covers all of them identically.
  fb.closest(".qcard").scrollIntoView({ behavior: "smooth", block: "start" });
}

// "ვინ ვარ?" — GUESS_TIME_PER_Q წამი (PvP-ის და AI-ის წინააღმდეგ ორივეში,
// ჩვეულებრივი ქვიზის TIME_PER_Q/PVP_TIME_PER_Q-სგან დამოუკიდებლად),
// ყოველი ახალი მინიშნება +5 წამს მატებს (ქულის ჯარიმა უცვლელი რჩება —
// reveal_quiz_clue-ს არსებული ლოგიკა, ახალი scoring არაფერი დამატებული).
// დრო რომ ამოიწურება, submitGuess(true) იძახება — "ნაძალადევი" submit,
// ცარიელი ველის დაბლოკვის გარეშე, ყოველთვის გადადის შემდეგ კითხვაზე.
// PvP-ში GUESS_TIME_PER_Q-ის მაგივრად ოთახის საკუთარი დრო გამოიყენება,
// თუ ჰოსტმა შეცვალა (იხ. pvpAnswerTimeOff -- off რეჟიმში ეს ფუნქცია
// საერთოდ არ გამოიძახება, renderGuessQuestion-ის ზემოთა განშტოება).
function startGuessTimer(){
  $("#gq-timer-row").style.display = "";
  const base = (PVP && S.gameType === "guess" && typeof PVP.answerTimeSeconds === "number")
    ? PVP.answerTimeSeconds : GUESS_TIME_PER_Q;
  const totalMs = pvpAfkModeActive() ? AFK_SHORT_TIME_MS : base*1000;
  startQuestionTimer($("#gq-timer"), $("#gq-timer-num"), totalMs, ()=> submitGuess(true));
  updateAfkButtonVisibility();
}

/* ---------- Guess-who PvP, room answer-time OFF -- "აქ ხარ?" presence
   check replaces the countdown entirely (no visible bar/number, see
   renderGuessQuestion above). Plain setTimeouts, not the shared rAF engine
   above -- there's no bar to drive, and unlike rAF these keep running
   (not throttled to a full stop) while the tab is backgrounded, which
   already matches PvP's "time keeps running while hidden" policy on its
   own, with no catch-up reconciliation needed on return.

   Two strikes, same S.consecTimeouts counter the timer-ON AFK rule above
   already uses (reset to 0 on any manual submit, inside submitGuess) --
   only the CONSEQUENCE differs here: a first unconfirmed prompt silently
   skips just this one question (submitGuess(true), consecTimeouts -> 1).
   A second CONSECUTIVE one (no successful "კი" or manual answer in
   between, i.e. consecTimeouts already >= 1 when the grace window lapses
   again) ends this player's game entirely via quiz_forfeit_player -- an
   existing, already-live RPC with no caller until now (see
   forfeitPvpRoom's own comment elsewhere in this file): it forfeits the
   player and runs sweep_quiz_room, which zeroes every one of their
   answers, including ones already correct, and advances the room toward
   'finished' once the opponent is done too. ---------- */
let _gqAfkWatchTimer = null;
let _gqAfkGraceTimer = null;

function stopGuessWhoAfkWatch(){
  if(_gqAfkWatchTimer) clearTimeout(_gqAfkWatchTimer);
  if(_gqAfkGraceTimer) clearTimeout(_gqAfkGraceTimer);
  _gqAfkWatchTimer = null; _gqAfkGraceTimer = null;
  hideAfkPrompt();
}

function startGuessWhoAfkWatch(){
  stopGuessWhoAfkWatch();
  _gqAfkWatchTimer = setTimeout(showAfkPrompt, 40000);
}

function showAfkPrompt(){
  const m = $("#pvpAfkModal");
  if(m) m.classList.add("show");
  _gqAfkGraceTimer = setTimeout(onAfkPromptExpired, 10000);
}

function hideAfkPrompt(){
  const m = $("#pvpAfkModal");
  if(m) m.classList.remove("show");
}

function onAfkPromptYes(){
  if(_gqAfkGraceTimer) clearTimeout(_gqAfkGraceTimer);
  _gqAfkGraceTimer = null;
  hideAfkPrompt();
  S.consecTimeouts = 0; // proved presence -- clears any pending strike
  startGuessWhoAfkWatch(); // same still-unanswered question, watch again
}

function onAfkPromptExpired(){
  _gqAfkGraceTimer = null;
  hideAfkPrompt();
  if(!PVP || S.gameType !== "guess") return;
  if((S.consecTimeouts||0) >= 1) forfeitPvpGuessWho();
  else submitGuess(true); // advances; renderGuessQuestion re-arms this
                           // watch for the next question automatically
}

async function forfeitPvpGuessWho(){
  stopGuessWhoAfkWatch();
  if(!PVP || !sb) return;
  const roomId = PVP.roomId;
  try{ await sb.rpc('quiz_forfeit_player', { p_room_id: roomId }); }
  catch(e){ console.warn("[quiz] quiz_forfeit_player failed:", e); }
  finishPvpQuiz();
}

$("#pvp-afk-yes").addEventListener("click", onAfkPromptYes);
$("#pvp-afk-leave").addEventListener("click", ()=>{ hideAfkPrompt(); leavePvpRoom(); });

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

// giveUp === true — მოთამაშემ "არ ვიცი" დააჭირა: პასუხი ყოველთვის
// არასწორია, ველში ჩაწერილი ტექსტი (თუ იყო) უგულებელყოფილია. ცარიელი
// ველის გაგზავნაც (ღილაკი "პასუხის გაცემა", forced არ არის) ახლა იგივენაირად
// არასწორია, დაბლოკვის გარეშე — ქვემოთ isGuessCorrect-ის განშტოება ცარიელ
// val-საც არასწორად თვლის.
function submitGuess(forced, giveUp){
  const item = S.questions[S.qi];
  const val = giveUp ? "" : ($("#gq-input").value || "").trim();

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
    S.consecTimeouts = forced ? (S.consecTimeouts||0) + 1 : 0;
    advanceGuessQuestion();
    return;
  }

  const result = val ? isGuessCorrect(val, item.answer) : { correct:false, exact:false };
  const points = result.correct ? guessPointsNow() : 0;
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

  // #gq-answer-area just collapsed (display:none above), so on a short
  // mobile viewport the question/clues can be scrolled out of frame above
  // it (the player was scrolled down to reach the input/submit button) --
  // the result is then unreadable without its context. This is the one
  // deliberate scroll in the whole quiz flow; it must not be copied
  // anywhere else questions are shown.
  const qcard = fb.closest(".qcard");
  if(qcard) qcard.scrollIntoView({ behavior: "smooth", block: "start" });

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
    updateGuessPoints();
    renderGuessClues();
    if(PVP) revealPvpClue(S.qi);
    extendQuestionTimer(PVP_GUESS_CLUE_BONUS*1000);
    if(S.gCluesShown >= item.clues.length) $("#gq-next-clue").disabled = true;
  }
});
$("#gq-submit").addEventListener("click", ()=> submitGuess());
$("#gq-input").addEventListener("keydown", e=>{ if(e.key==="Enter"){ e.preventDefault(); submitGuess(); }});
$("#gq-idk").addEventListener("click", ()=> submitGuess(false, true));

// R7: mobile keyboard was covering #gq-input and #gq-submit — uses
// visualViewport (not a fixed pixel guess, so it adapts to whatever height
// the on-screen keyboard actually takes) and only reacts to an actual
// viewport-size change (keyboard open/close/orientation), never to typing
// itself, so it can't fight the user's own scrolling or jump around as
// they type.
if(window.visualViewport){
  window.visualViewport.addEventListener("resize", ()=>{
    const inp = document.getElementById("gq-input");
    if(document.activeElement !== inp) return;
    const area = document.getElementById("gq-answer-area");
    if(!area) return;
    const vv = window.visualViewport;
    const visibleBottom = vv.offsetTop + vv.height;
    const rect = area.getBoundingClientRect();
    if(rect.bottom > visibleBottom){
      window.scrollBy({ top: rect.bottom - visibleBottom + 12, behavior: "smooth" });
    }
  });
}

function answer(chosen, btn){
  stopQuestionTimer();
  const opts = $$("#q-opts .opt");
  opts.forEach(o=> o.disabled = true);
  if(chosen>=0){
    opts[chosen].classList.add("chosen");
    opts.forEach((o,i)=>{ if(i!==chosen) o.classList.add("dim"); });
  }
  S.playerPicks[S.qi] = chosen; // -1 თუ დრო ამოიწურა
  if(PVP){
    submitPvpAnswer(S.qi, chosen);
    S.consecTimeouts = (chosen === -1) ? (S.consecTimeouts||0) + 1 : 0;
  }

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
  const review = document.getElementById('cbReview');
  if(review) review.style.display = "none";
  $("#cb-restart").style.display = "none";
  $("#cb-finish").style.display = "none";
  const controls = document.querySelector(".cb-controls");
  if(controls) controls.classList.remove("finished");
  const board = document.querySelector(".cb-score");
  board.classList.remove("finished", "win", "lose", "draw");
  document.querySelector(".cb-side.you").classList.remove("win");
  document.querySelector(".cb-side.opp").classList.remove("win");
  $("#cb-round").className = "cb-round";
  $("#cb-final").classList.remove("show");
  $("#cbBanner").className = "cb-banner";
  show("screen-cards");
  stopEndBattleAnimation();
  // vs-AI აღარასდროს თამაშობს კარტა-კარტაზე ბრძოლას — პირდაპირ საბოლოო
  // მდგომარეობაზე გადადის (tallyFinalScores + endBattle); animateEndBattle-ის
  // ქულების თვლის ანიმაცია (ქვემოთ) ერთადერთია, რაც ამის შემდეგ რჩება.
  tallyFinalScores();
  endBattle();
}

function tallyFinalScores(){
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
}

/* ---------- თამაშის დასრულების ეკრანზე: სწორი/არასწორი პასუხების
   დამოუკიდებელი (მოთამაშე vs AI) მასივი, strips-ისა და renderReview-ის
   გასაზიარებლად. ---- */
function computeCorrectness(i){
  const item = S.questions[i];
  if(S.gameType === "guess"){
    return { pOk: (S.playerPoints[i] || 0) > 0, oOk: (S.oppPoints[i] || 0) > 0 };
  }
  return { pOk: S.playerPicks[i] === item.a, oOk: S.oppPicks[i] === item.a };
}

function stopEndBattleAnimation(){
  (S.cbEndTimers || []).forEach(t => clearTimeout(t));
  S.cbEndTimers = [];
}

/* თითო კითხვაზე ორი strip (შენ / AI) — უჯრედები თავდაპირველად საწყის
   მდგომარეობაში იქმნება, შემდეგ animateEndBattle ანიჭებს correct/wrong
   კლასებს დაგვიანებით. */
function renderCardStrips(){
  const n = S.questions.length;
  const youWrap = document.getElementById('cbStripYou');
  const oppWrap = document.getElementById('cbStripOpp');
  const correctness = [];
  if(!youWrap || !oppWrap) return { youCells:[], oppCells:[], correctness };
  youWrap.innerHTML = ""; oppWrap.innerHTML = "";
  for(let i=0;i<n;i++){
    correctness.push(computeCorrectness(i));
    const yc = document.createElement("div"); yc.className = "cb-strip-cell";
    const oc = document.createElement("div"); oc.className = "cb-strip-cell";
    youWrap.appendChild(yc); oppWrap.appendChild(oc);
  }
  return { youCells: Array.from(youWrap.children), oppCells: Array.from(oppWrap.children), correctness };
}

/* strips-ის ანიმაცია + ქულების სინქრონული ათვლა ნულიდან. prefers-reduced-
   motion-ის შემთხვევაში ყველაფერი დაუყოვნებლივ საბოლოო მდგომარეობაშია. */
function animateEndBattle(youFinal, oppFinal){
  stopEndBattleAnimation();
  const { youCells, oppCells, correctness } = renderCardStrips();
  const youNumEl = $("#cb-you"), oppNumEl = $("#cb-opp");

  if(REDUCE_MOTION){
    correctness.forEach((c,i)=>{
      youCells[i].classList.add(c.pOk ? "correct" : "wrong");
      oppCells[i].classList.add(c.oOk ? "correct" : "wrong");
    });
    youNumEl.textContent = youFinal;
    oppNumEl.textContent = oppFinal;
    return;
  }

  youNumEl.textContent = "0";
  oppNumEl.textContent = "0";
  let youCount = 0, oppCount = 0;
  correctness.forEach((c,i)=>{
    const delay = 220 + i*110;
    S.cbEndTimers.push(setTimeout(()=>{
      youCells[i].classList.add(c.pOk ? "correct" : "wrong");
      if(c.pOk){ youCount++; youNumEl.textContent = youCount; }
    }, delay));
    S.cbEndTimers.push(setTimeout(()=>{
      oppCells[i].classList.add(c.oOk ? "correct" : "wrong");
      if(c.oOk){ oppCount++; oppNumEl.textContent = oppCount; }
    }, delay));
  });
}

function endBattle(){
  $("#cb-restart").style.display = "";
  $("#cb-finish").style.display = "";
  const controls = document.querySelector(".cb-controls");
  if(controls) controls.classList.add("finished");

  const you=S.cbYou, opp=S.cbOpp;
  const board = document.querySelector(".cb-score");
  const sideYou = document.querySelector(".cb-side.you");
  const sideOpp = document.querySelector(".cb-side.opp");
  board.classList.add("finished");
  board.classList.remove("win", "lose", "draw");
  sideYou.classList.remove("win"); sideOpp.classList.remove("win");

  document.querySelector(".qbattle").style.display = "none";
  $("#cb-log").innerHTML = "";
  $("#cb-round").className = "cb-round";
  $("#cb-round").innerHTML = '<span class="cb-vs-rule"></span><span class="cb-vs-text">VS</span><span class="cb-vs-rule"></span>';

  // CHANGE 1: დასრულების ეკრანზე ემოჯი აღარ ჩანს არც ერთ მხარეს.
  const myLab = ((currentAuthUser && currentAuthUser.nick) || "შენ").slice(0,14);
  $("#cb-you-tag").textContent = myLab;
  $("#cb-opp-ava").textContent = "";
  $("#cb-opp-lab").textContent = "AI";

  if(you>opp){ sideYou.classList.add("win"); board.classList.add("win"); }
  else if(you<opp){ sideOpp.classList.add("win"); board.classList.add("lose"); }
  else { board.classList.add("draw"); }

  animateEndBattle(you, opp);
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

  list.innerHTML = "";
  S.questions.forEach((item, i)=>{
    let correctText, pText, oText, pOk, oOk, pPts, oPts;
    if(S.gameType === "guess"){
      correctText = item.answer;
      pText = (S.playerPicks[i] && String(S.playerPicks[i]).trim()) ? S.playerPicks[i] : "პასუხი არ გაეცა";
      oText = (S.oppPicks[i] && String(S.oppPicks[i]).trim()) ? S.oppPicks[i] : "-";
      pPts = S.playerPoints[i] || 0;
      oPts = S.oppPoints[i] || 0;
      pOk = pPts > 0;
      oOk = oPts > 0;
    } else {
      correctText = item.o[item.a];
      pText = (S.playerPicks[i] >= 0 && item.o[S.playerPicks[i]] != null) ? item.o[S.playerPicks[i]] : "პასუხი არ გაეცა";
      oText = (S.oppPicks[i] >= 0 && item.o[S.oppPicks[i]] != null) ? item.o[S.oppPicks[i]] : "-";
      pOk = S.playerPicks[i] === item.a; oOk = S.oppPicks[i] === item.a;
      // ჩვეულებრივ ქვიზში S.playerPoints/oppPoints საერთოდ არ ივსება
      // (tallyFinalScores-იც ბინარულად, +1 თითო სწორ პასუხზე, ითვლის --
      // იხ. ზემოთ) -- იგივე წესით, არა S.playerPoints[i]-ით (ყოველთვის 0
      // იქნებოდა ამ რეჟიმში).
      pPts = pOk ? 1 : 0; oPts = oOk ? 1 : 0;
    }
    const qText = item.q || (item.clues && item.clues[0]) || "";
    const row = document.createElement("div");
    row.className = "cb-review-item";
    row.innerHTML = `
      <div class="cb-review-q"><span class="cb-review-num">${i+1}.</span>${qText}</div>
      <div class="cb-review-a ${pOk ? "ok" : "bad"}">${myLab}: ${pText} <span class="pts">${pPts}</span></div>
      <div class="cb-review-a ${oOk ? "ok" : "bad"}"><span class="cb-review-ai">${oppLab}:</span> ${oText} <span class="pts">${oPts}</span></div>
      <div class="cb-review-correct">სწორი პასუხი: ${correctText}</div>`;
    list.appendChild(row);
  });
  wrap.style.display = "";
}

$("#cb-restart").addEventListener("click", ()=>{
  stopQuestionTimer(); stopEndBattleAnimation();
  if(!S.gameType){ resetToMode(); return; }
  chooseGameType(S.gameType);
});
$("#cb-finish").addEventListener("click", ()=>{
  stopQuestionTimer(); stopEndBattleAnimation();
  location.href = "/";
});
$("#back-from-cards").addEventListener("click", resetToMode);

function resetToMode(){
  stopQuestionTimer(); stopEndBattleAnimation();
  chooseGameType("quiz", { push:false }); // ეკრანის ხელახლა გახსნისას ისევ ქვიზი წინასწარ არჩეული
  pushQuizStep(null, null);
}

/* ============================================================
   Phase 9: quiz URL history -- popstate moves back one screen inside the
   quiz (instead of leaving the page), and a direct link / refresh on one
   of the seven paths (served by 404.html's shim as ?s=<rest> on the
   ufcquiz/footballquiz root -- or on the bare /quiz/ root, for an old
   /ufc/quiz/ link -- since these paths aren't real files) opens the
   matching screen and then straightens the address bar back out to the
   canonical path.
   ============================================================ */
window.addEventListener("popstate", e=>{
  // Phase 5A fix A: this page's own history steps (pushQuizStep/
  // quizRestoreStep) mean going back inside a live PvP game only ever
  // switches screens -- pagehide never fires, so quiz_mark_away never
  // fires either, and the other players never learn this player is gone.
  // A backward move out of a live game (results not shown yet) must mean
  // actually leaving it, no confirmation dialog. The PvP lobby ('waiting')
  // is untouched -- its own back-row button (leavePvpRoom) already calls
  // leave_quiz_room.
  if(PVP && PVP.started && !PVP.resultsShown){
    const roomId = PVP.roomId;
    clearPvpRoomRecoveryState();
    stripRoomParam();
    resetPvp();
    if(roomId && sb) sb.rpc('leave_quiz_room', { p_room_id: roomId }).catch(()=>{});
  }
  const st = e.state || {};
  quizRestoreStep(st.quizSport || null, st.quizGameType || null, st.quizMode || null);
});

// initQuizDeepLink below resolves and consumes ?s=, then rewrites the URL
// via replaceState -- initQuizSportDeepLink runs right after it and must
// not re-read the now-rewritten location.search (it would silently
// re-trigger on the same load and stomp the step initQuizDeepLink just
// restored, regressing a sub-path refresh back to the bare sport/gametype
// screen). Both read from this one snapshot, taken before either runs.
const _quizInitialSearch = location.search;

(function initQuizDeepLink(){
  const params = new URLSearchParams(_quizInitialSearch);
  const sParam = params.get("s");
  if(!sParam) return;
  const step = QUIZ_STEPS.find(s => s.rest === sParam);
  if(!step || !step.rest) return; // unrecognised -- leave the sport screen showing, untouched
  // These ?s= slugs are shared byte-for-byte between UFC and Football (see
  // pushQuizStep/persistCurrentSport above) -- the URL itself can't say
  // which sport was active on the bare /quiz/ root (an old /ufc/quiz/ link,
  // via the redirect stub), so prefer this page's own default sport
  // (QUIZ_DEFAULT_SPORT, set when the link already landed on /quiz/ufcquiz/
  // or /quiz/footballquiz/ -- 404.html's mirrored shims always build these),
  // then the last one persisted in this tab, defaulting to UFC only when
  // nothing else is known (e.g. a bookmarked/shared pre-sport-picker link).
  const sportHere = QUIZ_DEFAULT_SPORT || readPersistedSport() || "UFC";
  quizRestoreStep(sportHere, step.gameType, step.mode);
  // ?room=<code> (the PvP share link, independent of this shim) stays
  // live if it rode along with the ?s= redirect.
  const roomParam = params.get("room");
  const canonicalPath = quizRootForSport(sportHere) + step.rest + (roomParam ? "?room=" + encodeURIComponent(roomParam) : "");
  history.replaceState({ quizSport: sportHere, quizGameType: step.gameType, quizMode: step.mode }, "", canonicalPath);
})();

// Homepage sport cards (index.html) used to link here with ?sport=ufc or
// ?sport=football so the card's own sport was picked immediately, skipping
// screen-sport -- a plain deep link one level shallower than the ?s= shim
// above, so it's skipped whenever ?s= already resolved a sport+step. The
// cards now link straight to /quiz/ufcquiz/ and /quiz/footballquiz/
// instead (QUIZ_DEFAULT_SPORT below does the same job for a bare visit to
// either root), but ?sport= itself still works for any old/shared link
// that still has it.
(function initQuizSportDeepLink(){
  const params = new URLSearchParams(_quizInitialSearch);
  if(params.get("s")) return;
  const raw = (params.get("sport") || "").trim().toLowerCase();
  let sport = raw === "football" ? "Football" : raw === "ufc" ? "UFC" : null;
  if(!sport) sport = QUIZ_DEFAULT_SPORT;
  if(!sport) return;
  quizRestoreStep(sport, null, null);
  const roomParam = params.get("room");
  const canonicalPath = quizRootForSport(sport) + (roomParam ? "?room=" + encodeURIComponent(roomParam) : "");
  history.replaceState({ quizSport: sport, quizGameType: null, quizMode: null }, "", canonicalPath);
})();

// PvP share link (?room=<code>) must join the room directly, not just
// prefill the join input on a screen the visitor never reaches. Phase 5A
// fix D: a matching local recovery record means this ?room= link is OUR
// OWN room (setRoomUrlParam put us here ourselves, on entering the lobby
// or going active) -- rejoin and resume straight back into it below, no
// recovery banner, no extra click, instead of running the "join a
// friend's room" flow. No matching record (or rejoin saying "not a
// participant") means a genuine shared invite link, so that flow still
// runs exactly as before.
(async function initQuizRoomDeepLink(){
  const params = new URLSearchParams(location.search);
  const roomCode = (params.get("room") || "").trim().toUpperCase();
  if(!roomCode || !sb) return;

  function showPvpJoinUi(){
    // S.gameType may already be set by the ?s= shim above (e.g. a "guess"
    // room link), so keep it when present instead of forcing "quiz". The
    // room's real sport isn't known until the join/rejoin call below
    // returns its category -- default UFC here is just pre-join
    // scaffolding (a generic "enter code" screen), corrected immediately
    // after a successful join/rejoin.
    quizRestoreStep(S.sport || "UFC", S.gameType || "quiz", "pvp");
    const codeInput = document.getElementById("pvp-join-code");
    if(codeInput) codeInput.value = roomCode;
  }

  const saved = readPvpRoomRecoveryState();
  const isOwnRoom = !!(saved && saved.roomId && saved.code && saved.code.toUpperCase() === roomCode);
  if(!isOwnRoom) showPvpJoinUi();

  // A signed-in visitor must not see the auth modal flash while
  // currentAuthUser is still being filled in asynchronously by
  // applyAuthSession. A stored Supabase session key means that will
  // resolve shortly, so wait briefly for it; otherwise do not wait.
  let hasStoredSession = false;
  try{
    for(let i = 0; i < localStorage.length; i++){
      const key = localStorage.key(i);
      if(key && key.indexOf("-auth-token") !== -1){ hasStoredSession = true; break; }
    }
  }catch(e){}
  if(hasStoredSession){
    const deadline = Date.now() + 2500;
    while(!currentAuthUser && Date.now() < deadline){
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  if(isOwnRoom && currentAuthUser){
    try{
      const { data, error } = await sb.rpc('rejoin_quiz_room', { p_room_id: saved.roomId });
      if(error){
        if(/player forfeited/.test(error.message || "")){
          clearPvpRoomRecoveryState();
          showQuizToast("ეს ქვიზი თქვენთვის დასრულებულია", 3500);
          stripRoomParam();
          return;
        }
        // 'not a participant' or anything else -- stale/mismatched record,
        // fall through to the normal join flow below.
      } else if(data && data.length){
        const row = data[0];
        if(row.status === "waiting" || row.status === "active"){
          resumePvpRoom(saved.roomId, row);
          return;
        }
        // 'finished'/'abandoned' -- nothing left to resume into, fall
        // through (a stale link to our own, now-over room).
      }
    }catch(e){ /* fall through to the join flow below */ }
  }

  if(isOwnRoom) showPvpJoinUi(); // rejoin above didn't pan out -- same fallback UI as a friend's link
  requireAuth(()=> joinPvpRoom(roomCode));
})();

/* ============================================================
   PvP game recovery -- a player who navigates away from this page during a
   live PvP game has no way back in otherwise. enterPvpLobby remembers the
   room in localStorage (PVP_ROOM_STORAGE_KEY); on the next load, if nothing
   else is going on, this rejoins and offers the player a banner back in.
   ============================================================ */
function setNavOffsetForBanner(px){
  // Pushing body down is enough on its own: nav's natural (unscrolled) flow
  // position moves down with it, clearing the fixed banner above. (Also
  // overriding nav's own sticky top:0 here would double-count the offset --
  // html/body both have overflow-x:hidden, which makes a sticky child's
  // "top" resolve against body's padding box, so top:bannerHeight on top of
  // body's own padding-top:bannerHeight stacks to 2x, not bannerHeight.)
  document.body.style.paddingTop = px ? px + "px" : "";
}

let _pvpBannerInterval = null;
function hidePvpRecoveryBanner(){
  const el = document.getElementById("pvpRecoveryBanner");
  if(el) el.classList.remove("show");
  setNavOffsetForBanner(0);
  if(_pvpBannerInterval){ clearInterval(_pvpBannerInterval); _pvpBannerInterval = null; }
}

// remainingMs: the away budget left to display (pvpAwayRemainingMs), not a
// fixed countdown -- the server is the sole forfeit authority, so reaching
// 0 here just clears the banner/local state, it doesn't call onForfeit.
function showPvpRecoveryBanner(remainingMs, onReturn, onForfeit){
  const el = document.getElementById("pvpRecoveryBanner");
  if(!el) return;
  const timerEl = document.getElementById("pvpRecoveryTimer");
  const closeBtn = document.getElementById("pvpRecoveryClose");
  const returnBtn = document.getElementById("pvpRecoveryReturn");
  const deadline = Date.now() + Math.max(0, remainingMs || 0);
  function renderRemaining(){
    const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    if(timerEl) timerEl.textContent = left;
    return left;
  }
  renderRemaining();
  el.classList.add("show");
  setNavOffsetForBanner(el.offsetHeight);

  let settled = false;
  function finish(fn){
    if(settled) return;
    settled = true;
    hidePvpRecoveryBanner();
    fn();
  }

  if(_pvpBannerInterval) clearInterval(_pvpBannerInterval);
  _pvpBannerInterval = setInterval(()=>{
    if(renderRemaining() <= 0){
      // Budget ran out -- the server has already forfeited the player on
      // its own (sweep_quiz_room); the client just clears the UI.
      settled = true;
      hidePvpRecoveryBanner();
      clearPvpRoomRecoveryState();
    }
  }, 1000);

  if(returnBtn) returnBtn.onclick = ()=> finish(onReturn);
  if(closeBtn) closeBtn.onclick = e => { e.stopPropagation(); finish(onForfeit); };
}

// Rebuilds PVP/S from a rejoin_quiz_room row and shows the right screen.
// 'waiting' reuses enterPvpLobby (which re-saves the recovery key with a
// fresh savedAt -- harmless, and keeps the 6h window alive while active).
// 'active' has no existing entry point (enterPvpLobby is lobby-only), so
// PVP is built directly here, landing on the first unanswered question.
async function resumePvpRoom(roomId, row){
  // Tell the server the player is back (resets its own away clock) before
  // touching any local game state. awayMsUsed/awayStartedAt are then folded
  // together into a new cumulative awayMsUsed for the display-only budget
  // (change 2) -- the server stays the real forfeit authority regardless.
  try{ await sb.rpc('quiz_mark_back', { p_room_id: roomId }); }catch(e){}
  const rec = readPvpRoomRecoveryState();
  if(rec && typeof rec.awayStartedAt === "number"){
    updatePvpAwayRecoveryState({
      awayMsUsed: (rec.awayMsUsed || 0) + Math.max(0, Date.now() - rec.awayStartedAt),
      awayStartedAt: null
    });
  }

  const myId = currentAuthUser && currentAuthUser.id;
  const players = row.players || [];
  const me = players.find(p => p.player_id === myId);
  const isHost = !!(me && me.is_host);
  S.gameType = row.game_type;
  // rejoin_quiz_room returns the room's own category (see
  // quiz_category_isolation.sql) -- a Football player resuming must land
  // back in Football, never bounced to UFC.
  S.sport = row.category || 'UFC';
  updateLandAbout();

  if(row.status === "waiting"){
    enterPvpLobby({ roomId, code: row.code, isHost, questions: row.questions });
    return;
  }

  PVP = {
    roomId, code: row.code, isHost,
    myId, myName: currentAuthUser && currentAuthUser.nick,
    players, avatarsById: {},
    maxPlayers: row.max_players || 9,
    questions: row.questions || [],
    started: true,
    resultsShown: false,
    resultsLoading: false,
  };
  // enterPvpLobby (the "waiting" branch above) sets this itself -- this
  // branch builds PVP directly, so it must set it too, or the displayed
  // code can keep showing whatever room this player was in before.
  $("#pvp-room-code").textContent = row.code;
  setRoomUrlParam(row.code);
  subscribePvpRoom();
  S.questions = PVP.questions;
  S.qi = 0;
  S.playerPicks = []; S.playerPoints = [];
  S.consecTimeouts = 0;
  if(S.gameType === "guess") S.gCluesShown = 1;
  const answered = new Set(row.answered_indexes || []);
  const firstUnanswered = S.questions.findIndex((_, i) => !answered.has(i));
  if(firstUnanswered === -1){
    finishPvpQuiz();
  } else {
    S.qi = firstUnanswered;
    show(S.gameType === "guess" ? "screen-guess" : "screen-quiz");
    renderQuestion();
  }
}

// submit_quiz_answer now rejects a forfeited player server-side (Phase 1),
// so looping submitPvpAnswer over every unanswered index is dead code.
// Phase 5A fix B: this used to call quiz_forfeit_player, which raises
// 'room not active' for a 'waiting' room -- the banner's x in the lobby
// did nothing. leave_quiz_room is the single "give up and get out" path
// for every room status now: it deletes the player (and hands off host)
// in a 'waiting' room, and forfeits with all answers zeroed (same as
// quiz_forfeit_player did) in an 'active' one -- quiz_forfeit_player
// itself is left in place with no remaining caller.
async function forfeitPvpRoom(roomId){
  try{ await sb.rpc('leave_quiz_room', { p_room_id: roomId }); }catch(e){}
  clearPvpRoomRecoveryState();
  stripRoomParam();
}

(async function initPvpRoomRecovery(){
  if(new URLSearchParams(location.search).get("room")) return; // the ?room= deep link above already owns this load
  // Set by quiz-return-banner.js's "დაბრუნება" button (sitewide banner) --
  // skip the in-page banner entirely and resume straight into the game.
  const isResume = new URLSearchParams(location.search).get("resume") === "1";
  let saved = null;
  try{
    const raw = localStorage.getItem(PVP_ROOM_STORAGE_KEY);
    if(raw) saved = JSON.parse(raw);
  }catch(e){ return; }
  if(!saved || !saved.roomId || typeof saved.savedAt !== "number"){
    if(saved) clearPvpRoomRecoveryState();
    return;
  }
  if(Date.now() - saved.savedAt > PVP_ROOM_STORAGE_MAX_AGE_MS){
    clearPvpRoomRecoveryState();
    return;
  }

  // Phase 5A fix C: fold any time already elapsed under the OLD
  // awayStartedAt into awayMsUsed immediately, then move the reference
  // point to now -- awayMsUsed otherwise only ever grows on an actual
  // resume (see resumePvpRoom below), so every refresh/reopen in between
  // recomputed the remaining budget against a stale awayStartedAt that
  // never advanced on its own, making the countdown look like it restarted
  // at a fresh 20s instead of continuing to run down.
  if(typeof saved.awayStartedAt === "number"){
    const foldedUsed = (saved.awayMsUsed || 0) + Math.max(0, Date.now() - saved.awayStartedAt);
    saved = Object.assign({}, saved, { awayMsUsed: foldedUsed, awayStartedAt: Date.now() });
    updatePvpAwayRecoveryState({ awayMsUsed: foldedUsed, awayStartedAt: Date.now() });
  }

  if(!sb) return;

  // Same "wait briefly for an already-known session" pattern as
  // initQuizRoomDeepLink above.
  let hasStoredSession = false;
  try{
    for(let i = 0; i < localStorage.length; i++){
      const key = localStorage.key(i);
      if(key && key.indexOf("-auth-token") !== -1){ hasStoredSession = true; break; }
    }
  }catch(e){}
  if(hasStoredSession){
    const deadline = Date.now() + 2500;
    while(!currentAuthUser && Date.now() < deadline){
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  if(!currentAuthUser) return;

  let row;
  try{
    const { data, error } = await sb.rpc('rejoin_quiz_room', { p_room_id: saved.roomId });
    if(error){
      clearPvpRoomRecoveryState();
      if(/player forfeited/.test(error.message || "")){
        showQuizToast("ეს ქვიზი თქვენთვის დასრულებულია", 3500);
      }
      return;
    }
    if(!data || !data.length){ clearPvpRoomRecoveryState(); return; }
    row = data[0];
  }catch(e){ clearPvpRoomRecoveryState(); return; }

  if(row.status === "finished" || row.status === "abandoned"){ clearPvpRoomRecoveryState(); return; }
  if(row.status !== "waiting" && row.status !== "active") return;

  if(isResume){
    const url = new URL(location.href);
    url.searchParams.delete("resume");
    history.replaceState(history.state, "", url.pathname + url.search + url.hash);
    resumePvpRoom(saved.roomId, row);
    return;
  }

  showPvpRecoveryBanner(
    pvpAwayRemainingMs(saved),
    ()=> resumePvpRoom(saved.roomId, row),
    ()=> forfeitPvpRoom(saved.roomId)
  );
})();
