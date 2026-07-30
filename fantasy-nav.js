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
  var css = [
    // „აქტიური" ნიშნების დამალვა ყველა გვერდზე (UFC/F1/NBA-საც)
    '.nav-fx-pop .fx-tag,.mnav-pop .mnav-pop-tag{display:none}',
    // ── DESKTOP: გვერდზე ამომავალი ქვემენიუ ──
    '.fx-sub{position:relative}',
    '.fx-sub-lbl{cursor:pointer}',
    '.fx-sub-right{display:inline-flex;align-items:center;gap:7px}',
    '.fx-sub-caret{font-size:.72em;opacity:.6;transition:transform .2s}',
    '.fx-sub:hover .fx-sub-caret,.fx-sub.open .fx-sub-caret{transform:rotate(90deg)}',
    '.fx-sub-pop{position:absolute;left:calc(100% + 8px);top:-7px;display:none;flex-direction:column;gap:2px;background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:6px;min-width:190px;z-index:70;box-shadow:0 12px 34px rgba(0,0,0,.45)}',
    // უხილავი „ხიდი" ღრიჭოზე — მაუსი ნელა რომ გადადის, hover არ იკარგება
    '.fx-sub-pop::before{content:"";position:absolute;left:-12px;top:0;width:14px;height:100%}',
    '.fx-sub:hover>.fx-sub-pop,.fx-sub.open>.fx-sub-pop,.fx-sub.fx-hover>.fx-sub-pop{display:flex}',
    '.fx-sub-pop a.on{background:rgba(245,196,81,.1);color:var(--gold)}',
    // ── MOBILE: გვერდზე ამომავალი ქვემენიუ ──
    '.mnav-sub{position:relative}',
    '.mnav-sub-right{display:inline-flex;align-items:center;gap:7px}',
    '.mnav-sub-caret{font-size:.8em;opacity:.6;transition:transform .2s}',
    '.mnav-sub.open .mnav-sub-caret{transform:rotate(90deg)}',
    '.mnav-sub-pop{position:absolute;left:calc(100% + 8px);bottom:0;display:none;flex-direction:column;gap:2px;background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:6px;min-width:160px;z-index:49;box-shadow:0 12px 34px rgba(0,0,0,.45)}',
    '.mnav-sub.open>.mnav-sub-pop{display:flex}'
  ].join('');
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  function build() {
    // ── DESKTOP: .nav-fx-pop ──
    var d = document.querySelector('.nav-fx-pop');
    if (d && !d.querySelector('.fx-sub')) {
      var links = LEAGUES.map(function (l) {
        return '<a href="/football/' + l.slug + '/"' + (active === l.code ? ' class="on"' : '') + '>' + l.label + '</a>';
      }).join('');
      var sub = document.createElement('div');
      sub.className = 'fx-sub';
      // label = <a> .nav-fx-pop-ის შიგნით → იგივე ფონტი/padding/სწორება ავტომატურად
      sub.innerHTML =
        '<a class="fx-sub-lbl' + (active ? ' on' : '') + '">ფეხბურთი'
        + '<span class="fx-sub-right"><span class="fx-sub-caret">▸</span></span></a>'
        + '<div class="fx-sub-pop">' + links + '</div>';
      d.appendChild(sub);
      var lbl = sub.querySelector('.fx-sub-lbl');
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
