// ============================================================
//  fantasy-nav.js — საერთო ნავიგაცია ყველა გვერდზე
//  „ფენტეზის ტიპი" dropdown-ში ამატებს „ფეხბურთი"-ს, რომელსაც გვერდიდან
//  ამოსდის 6 ლიგის ქვემენიუ (desktop: hover/კლიკი, mobile: კლიკი).
//  ჩართვა ნებისმიერ გვერდზე: <script src="/fantasy-nav.js"></script>
//  (football გვერდზე window.LEAGUE-ს კითხულობს აქტიური ლიგის მოსანიშნად)
// ============================================================
(function () {
  if (window.__FNF_FANTASY_NAV__) return;
  window.__FNF_FANTASY_NAV__ = true;

  var LEAGUES = [
    { slug: 'laliga',     label: 'ლა ლიგა',        code: 'esp1' },
    { slug: 'epl',        label: 'პრემიერ ლიგა',   code: 'eng1' },
    { slug: 'seriea',     label: 'სერია A',        code: 'ita1' },
    { slug: 'bundesliga', label: 'ბუნდესლიგა',     code: 'ger1' },
    { slug: 'ligue1',     label: 'ლიგა 1',         code: 'fra1' },
    { slug: 'ucl',        label: 'ჩემპიონთა ლიგა', code: 'ucl'  }
  ];
  var active = window.LEAGUE || null;

  // მხოლოდ პოზიციონირება/flyout — ფონტსა და padding-ს არსებული .nav-fx-pop a / .mnav-pop-opt აძლევს
  // (DESKTOP .fx-sub-ის style ახლა style.css-შია, რადგან markup-იც იქ, HTML-ში
  // დასტატიკურებულია SEO-სთვის -- ქვემოთ მხოლოდ MOBILE .mnav-sub რჩება injected)
  var css = [
    // „აქტიური" ნიშნების დამალვა ყველა გვერდზე (UFC/F1/NBA-საც)
    '.nav-fx-pop .fx-tag,.mnav-pop .mnav-pop-tag{display:none}',
    // ── MOBILE: გვერდზე ამომავალი ქვემენიუ ──
    '.mnav-sub{position:relative}',
    '.mnav-sub-right{display:inline-flex;align-items:center;gap:7px}',
    '.mnav-sub-caret{font-size:var(--fs-meta);opacity:.6;transition:transform .2s}',
    '.mnav-sub.open .mnav-sub-caret{transform:rotate(90deg)}',
    '.mnav-sub-pop{position:absolute;left:calc(100% + 8px);bottom:0;display:none;flex-direction:column;gap:2px;background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:6px;min-width:160px;z-index:49;box-shadow:0 12px 34px rgba(0,0,0,.45)}',
    '.mnav-sub.open>.mnav-sub-pop{display:flex}'
  ].join('');
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  function build() {
    // ── DESKTOP: .nav-fx-pop ──
    var d = document.querySelector('.nav-fx-pop');
    if (d) {
      var sub = d.querySelector('.fx-sub');
      if (!sub) {
        var links = LEAGUES.map(function (l) {
          return '<a href="/football/' + l.slug + '/">' + l.label + '</a>';
        }).join('');
        sub = document.createElement('div');
        sub.className = 'fx-sub';
        // label = <a> .nav-fx-pop-ის შიგნით → იგივე ფონტი/padding/სწორება ავტომატურად
        sub.innerHTML =
          '<a class="fx-sub-lbl">ფეხბურთი'
          + '<span class="fx-sub-right"><span class="fx-sub-caret">▸</span></span></a>'
          + '<div class="fx-sub-pop">' + links + '</div>';
        d.appendChild(sub);
      }
      // "on" კლასი აქტიურ ლიგაზე -- static (HTML-ში უკვე ჩაწერილი) თუ ახლად
      // აგებული fx-sub, ორივე შემთხვევაში window.LEAGUE მხოლოდ აქ, runtime-ზეა ცნობილი
      var lbl = sub.querySelector('.fx-sub-lbl');
      if (active) {
        lbl.classList.add('on');
        var activeLeague = LEAGUES.filter(function (l) { return l.code === active; })[0];
        var activeLink = activeLeague && sub.querySelector('a[href="/football/' + activeLeague.slug + '/"]');
        if (activeLink) activeLink.classList.add('on');
      }
      lbl.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();   // არსებულმა navFx handler-მა dropdown არ დახუროს
        sub.classList.toggle('open');
      });
      // hover-intent: ნელა მოძრაობისას ღრიჭოს გავლა არ დახუროს (300ms დაყოვნება)
      var closeT;
      sub.addEventListener('mouseenter', function () { clearTimeout(closeT); sub.classList.add('fx-hover'); });
      sub.addEventListener('mouseleave', function () { closeT = setTimeout(function () { sub.classList.remove('fx-hover'); }, 300); });
    }

    // ── MOBILE: .mnav-pop ──
    var m = document.querySelector('.mnav-pop');
    if (m && !m.querySelector('.mnav-sub')) {
      var mlinks = LEAGUES.map(function (l) {
        return '<a class="mnav-pop-opt' + (active === l.code ? ' on' : '') + '" href="/football/' + l.slug + '/">' + l.label + '</a>';
      }).join('');
      var wrap = document.createElement('div');
      wrap.className = 'mnav-sub';
      wrap.innerHTML =
        '<div class="mnav-pop-opt mnav-sub-toggle">ფეხბურთი'
        + '<span class="mnav-sub-right"><span class="mnav-sub-caret">▸</span></span></div>'
        + '<div class="mnav-sub-pop">' + mlinks + '</div>';
      m.appendChild(wrap);
      var tog = wrap.querySelector('.mnav-sub-toggle');
      tog.addEventListener('click', function (e) {
        e.stopPropagation();   // არ დახუროს mnav-pop / არ ჩაითვალოს გარე კლიკად
        wrap.classList.toggle('open');
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();

// ============================================================
//  ufc-quiz-nav — "ქვიზი" ბმულის ჩამატება ნავში, ყველა გვერდზე
//  სადაც fantasy-nav.js ჩატვირთულია (ადრე მხოლოდ /ufc/-ის ინლაინ
//  ასლში იყო, ამიტომ /news/-ზე და სხვაგან ქვიზის ბმული საერთოდ
//  არ ჩანდა -- იხ. commit message). ბმული ემატება ზედა ნავის
//  ძირითად ჯგუფში (#navLinks) -- იგივე ადგილას, სადაც
//  "ლიდერბორდი"/"ბილეთების ისტორია"/"პროფილი" (დესკტოპზე .d-only)
//  და "ბრძოლები"/"ლიდერბორდი"/"წესები" (ჰამბურგერ-მენიუში .m-only)
//  ზის -- და არა "ფენტეზის ტიპი"-ს ჩამოსაშლელში. საკუთარი
//  idempotent guard და "ორჯერ არ ჩასვა" შემოწმება, ცალკე
//  __FNF_FANTASY_NAV__-ისგან, რადგან ეს დამოუკიდებელი ფუნქციაა.
// ============================================================
(function () {
  if (window.__FNF_QUIZ_NAV__) return;
  window.__FNF_QUIZ_NAV__ = true;

  function build() {
    var nav = document.getElementById('navLinks');
    if (!nav || nav.querySelector('.quiz-nav-link')) return;

    var d = document.createElement('a');
    d.className = 'd-only quiz-nav-link';
    d.href = '/ufc/quiz/';
    d.textContent = 'ქვიზი';
    nav.appendChild(d);

    var m = document.createElement('a');
    m.className = 'm-only quiz-nav-link';
    m.href = '/ufc/quiz/';
    m.textContent = 'ქვიზი';
    nav.appendChild(m);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();

// ============================================================
//  hide-on-scroll header (FNF-UI-UX-PRD.md Phase 6, item 1) --
//  sitewide, since <nav> and its sticky/transform CSS (style.css) are
//  the same on every page this script already loads on. rAF-throttled,
//  one scroll listener for the whole site rather than one per page.
//  prefers-reduced-motion is handled in CSS (the transition itself is
//  disabled there), not by skipping the class toggle here -- the
//  reduced-motion user still gets the show/hide *state* change, just
//  without the animated slide.
// ============================================================
(function () {
  if (window.__FNF_HIDE_NAV__) return;
  window.__FNF_HIDE_NAV__ = true;

  var nav = document.querySelector('nav');
  if (!nav) return;

  var lastY = window.scrollY;
  var raf = null;

  function tick() {
    raf = null;
    var y = window.scrollY;
    if (y > lastY && y > 120) {
      nav.classList.add('is-hidden');
    } else if (y < lastY) {
      nav.classList.remove('is-hidden');
    }
    lastY = y;
  }

  window.addEventListener('scroll', function () {
    if (raf) return;
    raf = requestAnimationFrame(tick);
  }, { passive: true });
})();
