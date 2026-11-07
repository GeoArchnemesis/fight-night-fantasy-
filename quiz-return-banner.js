// ============================================================
//  quiz-return-banner.js — PvP "return to the room" banner, sitewide.
//  ufc/quiz/index.html already has its own #pvpRecoveryBanner (built by
//  initPvpRoomRecovery in ufc/quiz.js); this is the same banner for every
//  OTHER page, so a player who navigates away mid-game during his 20s
//  away budget (see PVP_AWAY_BUDGET_MS / fnf_quiz_room in ufc/quiz.js)
//  can still get back to it. Self-contained: no supabase-js, reads/writes
//  only the existing "fnf_quiz_room" localStorage record that ufc/quiz.js
//  already maintains. Same idempotent IIFE pattern as fantasy-nav.js.
//  ჩართვა: <script defer src="/quiz-return-banner.js"></script>
// ============================================================
(function () {
  if (window.__FNF_QUIZ_RETURN_BANNER__) return;
  window.__FNF_QUIZ_RETURN_BANNER__ = true;

  // ufc/quiz/index.html has its own banner -- don't double up there.
  if (location.pathname.indexOf('/ufc/quiz') === 0) return;

  var STORAGE_KEY = 'fnf_quiz_room';
  var AWAY_BUDGET_MS = 20000;
  var MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours

  // Same public anon key already embedded in ufc/quiz.js -- read-only RPC
  // call, safe to ship client-side.
  var SUPABASE_URL = "https://qxfcwsiysnjxhxljqigl.supabase.co";
  var SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF4ZmN3c2l5c25qeGh4bGpxaWdsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxODM4MDUsImV4cCI6MjA5Nzc1OTgwNX0.SOeTrxnKulgO8ao8HSwxyKE-m9pvaQ54Pa_IGWWyKDc";

  function readRecord() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function clearRecord() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
  }
  function remainingMs(record) {
    var used = (typeof record.awayMsUsed === "number") ? record.awayMsUsed : 0;
    return Math.max(0, AWAY_BUDGET_MS - used - (Date.now() - record.awayStartedAt));
  }
  // No supabase-js on this page to hold a live session var (ufc/quiz.js's
  // _authAccessToken) -- supabase-js's own localStorage session record is
  // the only place left to read it from, keyed "...-auth-token" the same
  // way ufc/quiz.js already scans for an existing session (see
  // initPvpRoomRecovery's hasStoredSession check).
  function findAccessToken() {
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var key = localStorage.key(i);
        if (!key || key.indexOf("-auth-token") === -1) continue;
        var raw = localStorage.getItem(key);
        if (!raw) continue;
        var parsed = JSON.parse(raw);
        var token = parsed && (parsed.access_token || (parsed.currentSession && parsed.currentSession.access_token));
        if (token) return token;
      }
    } catch (e) {}
    return null;
  }

  var record = readRecord();
  if (!record) return;
  if (typeof record.awayStartedAt !== "number") return;
  if (typeof record.savedAt !== "number" || Date.now() - record.savedAt > MAX_AGE_MS) return;
  if (remainingMs(record) <= 0) return;

  // Copy of #pvpRecoveryBanner's own CSS (ufc/quiz/index.html) so the two
  // look identical -- own <style>, own ids, no shared DOM with that page.
  function injectStyle() {
    var css = [
      '#fnfQrb{display:none;position:fixed;top:0;left:0;right:0;z-index:60;align-items:center;gap:10px;background:var(--gold);color:var(--ink);padding:10px 14px;padding-top:calc(10px + env(safe-area-inset-top,0px));font-family:var(--head)}',
      '#fnfQrb.show{display:flex}',
      '#fnfQrb .pvp-rb-text{flex:1;min-width:0;font-weight:700;font-size:.85rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '#fnfQrb .pvp-rb-return{min-height:auto;padding:3px 12px;margin:0 2px;font-size:inherit;border-color:currentColor;vertical-align:baseline}',
      '#fnfQrb .pvp-rb-timer{flex:none;font-family:var(--mono);font-weight:700;font-size:1.05rem;min-width:22px;text-align:center}',
      '#fnfQrb .pvp-rb-close{flex:none;width:44px;height:44px;display:flex;align-items:center;justify-content:center;background:transparent;border:none;color:var(--ink);font-size:1.5rem;line-height:1;cursor:pointer}'
    ].join('');
    var st = document.createElement('style');
    st.textContent = css;
    document.head.appendChild(st);
  }

  function buildBanner() {
    var el = document.createElement('div');
    el.id = 'fnfQrb';
    el.innerHTML =
      '<span class="pvp-rb-text">ოთახში <button type="button" class="btn btn-ghost pvp-rb-return" id="fnfQrbReturn">დაბრუნება</button></span>' +
      '<span class="pvp-rb-timer" id="fnfQrbTimer">20</span>' +
      '<button type="button" class="pvp-rb-close" id="fnfQrbClose" aria-label="დახურვა">&times;</button>';
    document.body.appendChild(el);
    return el;
  }

  // Same approach as ufc/quiz.js's setNavOffsetForBanner: push body down by
  // the banner's own height so the fixed banner doesn't cover the nav.
  function setBodyOffset(px) {
    document.body.style.paddingTop = px ? px + "px" : "";
  }

  var intervalId = null;
  function hide() {
    var el = document.getElementById('fnfQrb');
    if (el) el.classList.remove('show');
    setBodyOffset(0);
    if (intervalId) { clearInterval(intervalId); intervalId = null; }
  }

  function doForfeit(roomId) {
    var token = findAccessToken();
    if (token) {
      try {
        fetch(SUPABASE_URL + "/rest/v1/rpc/quiz_forfeit_player", {
          method: "POST",
          headers: {
            "apikey": SUPABASE_ANON_KEY,
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ p_room_id: roomId })
        });
      } catch (e) {}
    }
    // No token: skip the request -- the server forfeits him at 20s anyway.
    clearRecord();
    hide();
  }

  function show(record) {
    injectStyle();
    var el = buildBanner();
    var timerEl = document.getElementById('fnfQrbTimer');
    var returnBtn = document.getElementById('fnfQrbReturn');
    var closeBtn = document.getElementById('fnfQrbClose');

    var deadline = Date.now() + remainingMs(record);
    function renderRemaining() {
      var left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      if (timerEl) timerEl.textContent = left;
      return left;
    }
    renderRemaining();
    el.classList.add('show');
    setBodyOffset(el.offsetHeight);

    returnBtn.onclick = function () {
      hide();
      location.href = '/ufc/quiz/?resume=1';
    };
    closeBtn.onclick = function (e) {
      e.stopPropagation();
      doForfeit(record.roomId);
    };

    intervalId = setInterval(function () {
      if (renderRemaining() <= 0) {
        clearRecord();
        hide();
      }
    }, 1000);
  }

  function init() { show(record); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
