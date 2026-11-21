// ============================================================
//  news-slider.js — "counter" nav (prev/next arrows + N/total counter,
//  dots below) for the news/video slider (.news-strip .nw-slider-list,
//  see style.css). Pure progressive enhancement: the slider itself
//  (cards, peek, scroll-snap) is already fully built server-side by
//  scripts/prerender-news.js -- this file only adds the navigation
//  chrome on top of it client-side, so the prerendered markup never
//  needs to change. Same idempotent-IIFE pattern as video-popup.js/
//  fantasy-nav.js (safe if this script tag is ever present twice).
//  Below 860px (style.css's own breakpoint for its 2-cards-per-column
//  mobile layout), a "page" is 2 cards, not 1 -- the nav steps, counter
//  and dots all follow that, re-deriving on resize/rotation.
// ============================================================
(function () {
  if (window.__FNF_NEWS_SLIDER__) return;
  window.__FNF_NEWS_SLIDER__ = true;

  var ARROW_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
  // Same 860px breakpoint style.css's own mobile rework of .nw-slider-list
  // uses (CSS grid, 2 cards per column/page) -- below it, nav moves by 2
  // cards ("pages") at a time instead of 1, matching that layout; a dot
  // then represents a page, not a single card.
  var MOBILE_MQ = window.matchMedia('(max-width:860px)');

  function initSlider(strip) {
    var list = strip.querySelector('.nw-slider-list');
    if (!list) return; // not a scroll-slider (e.g. the 3-item static grid variant) -- nothing to do
    var cards = Array.prototype.slice.call(list.children);
    if (cards.length < 2) return; // nothing to navigate between

    var secHead = strip.querySelector('.sec-head');
    var nav = document.createElement('div');
    nav.className = 'nw-slider-nav';

    var prevBtn = document.createElement('button');
    prevBtn.type = 'button';
    prevBtn.className = 'nw-slider-arrow nw-slider-prev';
    prevBtn.setAttribute('aria-label', 'წინა');
    prevBtn.innerHTML = ARROW_SVG;
    prevBtn.style.transform = 'scaleX(-1)';

    var counter = document.createElement('span');
    counter.className = 'nw-slider-counter';

    var nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'nw-slider-arrow nw-slider-next';
    nextBtn.setAttribute('aria-label', 'შემდეგი');
    nextBtn.innerHTML = ARROW_SVG;

    nav.appendChild(prevBtn);
    nav.appendChild(counter);
    nav.appendChild(nextBtn);
    if (secHead) secHead.appendChild(nav);
    strip.classList.add('news-slider--has-nav');

    var dotsWrap = document.createElement('div');
    dotsWrap.className = 'nw-slider-dots';
    list.insertAdjacentElement('afterend', dotsWrap);

    var current = 0;
    var step = 1; // 1 card per page (desktop) or 2 (mobile) -- set by applyStep()
    var dots = [];

    function pageCount() { return Math.ceil(cards.length / step); }
    function pageOf(i) { return Math.floor(i / step); }

    function rebuildDots() {
      dotsWrap.innerHTML = '';
      var n = pageCount();
      dots = [];
      for (var p = 0; p < n; p++) {
        (function (p) {
          var d = document.createElement('button');
          d.type = 'button';
          d.className = 'nw-slider-dot';
          d.setAttribute('aria-label', (p + 1) + '/' + n);
          d.addEventListener('click', function () { scrollToIndex(p * step); });
          dotsWrap.appendChild(d);
          dots.push(d);
        })(p);
      }
    }

    function update() {
      var n = pageCount(), p = pageOf(current);
      counter.textContent = (p + 1) + '/' + n;
      prevBtn.disabled = p <= 0;
      nextBtn.disabled = p >= n - 1;
      dots.forEach(function (d, i) { d.classList.toggle('active', i === p); });
    }
    function scrollToIndex(i) {
      i = Math.max(0, Math.min(cards.length - 1, i));
      cards[i].scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' });
    }
    prevBtn.addEventListener('click', function () { scrollToIndex((pageOf(current) - 1) * step); });
    nextBtn.addEventListener('click', function () { scrollToIndex((pageOf(current) + 1) * step); });

    function applyStep() {
      var next = MOBILE_MQ.matches ? 2 : 1;
      if (next === step && dots.length) return;
      step = next;
      current = 0;
      rebuildDots();
      update();
    }

    // "Current" is the leftmost card that's at least 60% visible -- with
    // several cards visible per view, several fire isIntersecting at
    // once, so IntersectionObserver (root: the slider itself) tracks each
    // card's own visible/not-visible flag instead of just reacting to
    // whichever entry this callback batch happens to list last, then
    // always reads off the first (leftmost) visible one. Only recomputes
    // on actual visibility changes (arrow clicks, dot clicks, touch
    // swipes, scroll-snap settling), not on every scroll frame.
    if ('IntersectionObserver' in window) {
      var visible = cards.map(function () { return false; });
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          var idx = cards.indexOf(entry.target);
          if (idx > -1) visible[idx] = entry.isIntersecting && entry.intersectionRatio >= 0.6;
        });
        var leading = visible.indexOf(true);
        if (leading > -1 && leading !== current) { current = leading; update(); }
      }, { root: list, threshold: [0, 0.6, 1] });
      cards.forEach(function (c) { io.observe(c); });
    }

    applyStep();
    if (MOBILE_MQ.addEventListener) MOBILE_MQ.addEventListener('change', applyStep);
    else if (MOBILE_MQ.addListener) MOBILE_MQ.addListener(applyStep); // older Safari
  }

  function init() {
    Array.prototype.slice.call(document.querySelectorAll('.news-strip')).forEach(initSlider);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
