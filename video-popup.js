// ============================================================
//  video-popup.js — YouTube ვიდეოს პოპაპი, საერთო ყველა გვერდზე, სადაც
//  ვიდეოს ბარათი შეიძლება გამოჩნდეს (მთავარი, 9 ფენტეზის გვერდი,
//  news/index.html და en/news/index.html). fantasy-nav.js-ის იგივე
//  ჩართვის კონვენცია: <script src="/video-popup.js?v=1"></script>
//  ნებისმიერ გვერდზე.
//
//  Task 4, phase 3 (ვიდეოების ჩვენება საიტზე). პოპაპი იხსნება ზუსტად იმ
//  გვერდზე, საიდანაც ვიდეოს ბარათზე დააჭირეს -- URL ხდება იმ გვერდის
//  საკუთარი pathname + ?video=VIDEOID, და პოპაპის დახურვისას იმავე
//  გვერდის სუფთა URL-ს უბრუნდება (არსად არ ნავიგირებს /news/-ზე
//  ვიდეოს საყურებლად). ბარათების href="?video=ID" უკვე ფარდობითია,
//  ამიტომ ყოველთვის სწორად resolve-დება იმ გვერდის მიმართ, სადაც
//  ჩასმულია (prerender-news.js-ის მხრიდან არაფერია გვერდზე-სპეციფიკური).
//
//  Fullscreen-იდან გამოსვლის შემდეგ საიტზე დარჩენა და "Watch on YouTube"
//  კონტროლის შენარჩუნება -- ჩვეულებრივი YouTube iframe embed-ის
//  ნაგულისხმევი ქცევაა (allowfullscreen + სტანდარტული allow ატრიბუტი),
//  დამატებითი არაფერია საჭირო.
//
//  დახურვის ქცევა ზუსტად იმეორებს საკონტაქტო პოპაპს (იხ. index.html/
//  404.html #contactPopup) -- X ღილაკი, Esc, ბექდროფზე დაჭერა. მექანიზმი
//  განსხვავებულია (.modal-bg/.modal + .show კლასი, არა inline style
//  toggle), რადგან ეს საერთო, უკვე არსებული მოდალების სისტემაა (auth
//  მოდალი, კონტაქტის ინფოს პოპაპი), მაგრამ ქცევა იგივეა.
// ============================================================
(function () {
  if (window.__FNF_VIDEO_POPUP__) return;
  window.__FNF_VIDEO_POPUP__ = true;

  var POPUP_ID = 'videoPopup';
  var FRAME_ID = 'videoPopupFrame';

  // GA4 virtual-pageview tracking for the popup's two history-only states
  // (?video=ID open, and closed). _lastVirtualPageViewUrl guards against a
  // duplicate push if the resulting URL doesn't actually change.
  var _lastVirtualPageViewUrl = null;
  function pushVirtualPageView() {
    var href = location.href;
    if (href === _lastVirtualPageViewUrl) return;
    _lastVirtualPageViewUrl = href;
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({
      event: 'virtual_page_view',
      page_path: location.pathname + location.search,
      page_title: document.title,
      page_location: href
    });
  }

  function injectMarkup() {
    if (document.getElementById(POPUP_ID)) return;
    var bg = document.createElement('div');
    bg.id = POPUP_ID;
    bg.className = 'modal-bg';
    bg.innerHTML =
      '<div class="modal modal-video">' +
        '<button type="button" class="modal-close modal-video-close" id="videoPopupClose" aria-label="დახურვა">' +
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke-width="1.5" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12"/></svg>' +
        '</button>' +
        '<div class="video-popup-frame-wrap">' +
          '<iframe id="' + FRAME_ID + '" src="" title="YouTube video player" frameborder="0" ' +
          'allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>' +
        '</div>' +
      '</div>';
    document.body.appendChild(bg);
    bg.addEventListener('click', function (e) { if (e.target === bg) closeVideoPopup(); });
    document.getElementById('videoPopupClose').addEventListener('click', function () { closeVideoPopup(); });
  }

  // push: whether this call should write a new history entry (false when
  // the address bar already reflects this state -- popstate, or the
  // initial-load direct-link case below). track: whether this call should
  // report a virtual pageview -- defaults to the same as push, except
  // popstate explicitly passes track:true even though push:false, since
  // Back/Forward over the popup is still a real screen change; the
  // initial-load case passes neither, so it stays silent (that URL's real
  // pageview already covers it).
  function openVideoPopup(videoId, push, track) {
    if (!videoId) return;
    injectMarkup();
    document.getElementById(FRAME_ID).src = 'https://www.youtube.com/embed/' + encodeURIComponent(videoId) + '?autoplay=1';
    document.getElementById(POPUP_ID).classList.add('show');
    if (push !== false) {
      history.pushState({ videoPopup: videoId }, '', location.pathname + '?video=' + encodeURIComponent(videoId));
    }
    if (track === undefined ? push !== false : track) pushVirtualPageView();
  }
  function closeVideoPopup(push, track) {
    var el = document.getElementById(POPUP_ID);
    if (el) el.classList.remove('show');
    var frame = document.getElementById(FRAME_ID);
    if (frame) frame.src = ''; // შეჩერდეს დაკვრა
    if (push !== false) {
      history.pushState({}, '', location.pathname);
    }
    if (track === undefined ? push !== false : track) pushVirtualPageView();
  }
  window.openVideoPopup = openVideoPopup;
  window.closeVideoPopup = closeVideoPopup;

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var el = document.getElementById(POPUP_ID);
    if (el && el.classList.contains('show')) closeVideoPopup();
  });

  window.addEventListener('popstate', function () {
    var id = new URLSearchParams(location.search).get('video');
    if (id) openVideoPopup(id, false, true); else closeVideoPopup(false, true);
  });

  // Click-delegation: ნებისმიერი [data-video-id] მქონე ელემენტი (ვიდეოს
  // ბარათების გარე <a>) ხსნის პოპაპს ნავიგაციის მაგივრად -- მუშაობს
  // prerender-news.js-ის მიერ გამომცხვარ სტატიკურ ბარათებზეც და
  // news/index.html-ის ცოცხალი JS-რენდერის ბარათებზეც, დამატებითი
  // per-card JS-ის გარეშე.
  document.addEventListener('click', function (e) {
    var card = e.target.closest('[data-video-id]');
    if (!card) return;
    e.preventDefault();
    openVideoPopup(card.getAttribute('data-video-id'));
  });

  // პირდაპირი ვიზიტი/refresh: თუ ?video= უკვე URL-შია ჩატვირთვისას,
  // პოპაპი დაუყოვნებლივ იხსნება (pushState საჭირო არაა -- URL უკვე სწორია).
  var initialVideo = new URLSearchParams(location.search).get('video');
  if (initialVideo) openVideoPopup(initialVideo, false);
})();
