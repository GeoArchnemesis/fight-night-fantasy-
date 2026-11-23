// ============================================================
//  PRERENDER NEWS — bakes one static /news/<slug>/index.html per
//  published article (plus an /en/news/<slug>/index.html twin when the
//  article has English content), and injects real <a href> anchors +
//  titles into news/index.html's / news/en-index's initial grid markup.
//
//  Why: fnf.ge has no build step and no per-route SSR (see CLAUDE.md),
//  so today /news/post.html?slug=X ships a generic placeholder
//  <title>, no Open Graph tags at all, and no body text in the raw
//  HTML -- fine for a browser (client JS fills it in) but invisible
//  to Googlebot's first pass and to every social-link unfurler
//  (Facebook/Telegram/Twitter never execute JS). This script makes
//  the raw HTML already correct, the same way news/post.html's own
//  client-side nwRenderArticle() would render it, by copying that
//  file and splicing in the real head tags + body for each article.
//
//  The generated page is NOT a different page: it's the same
//  news/post.html template with its placeholder content replaced and
//  HTML comment markers removed. The exact same <script> tags run
//  afterwards, so comments/reactions/share all still work -- nwLoad()
//  derives the slug (and language, from the /en/ path prefix) from the
//  URL -- and re-fetches + re-renders the same content on top. That
//  re-render is harmless (idempotent, same data, just re-draws the
//  identical DOM), not because the baked content is wrong.
//
//  Categories were removed (2026-10-22, owner decision) -- every
//  article lives directly under /news/ (or /en/news/ for its English
//  twin), no /news/category/<slug>/ hubs, no category pill, no
//  category-based "related articles". See the removed buildCategoryPage
//  in git history if this ever needs reviving.
//
//  English (2026-10-22): title_en/meta_title_en/meta_description_en/
//  cover_image_alt_en/body_en were already written by the admin but
//  never had their own crawlable URL -- EN was a client-side toggle on
//  the *same* /news/<slug>/ URL, so Google only ever saw Georgian. Each
//  eligible article (title_en AND body_en both non-empty) now also gets
//  a real /en/news/<slug>/ page, with reciprocal hreflang on both
//  twins and no hreflang block at all when no EN twin exists.
//
//  Read-only against Supabase (anon key, same one already embedded in
//  every frontend file -- no service_role needed, since this only
//  ever reads is_published=true rows, same filter the public site
//  already applies). Writes local files under news/ and en/news/, plus
//  the homepage's NEWS-HOME and the nine sport pages' VIDEO-SLIDER marker
//  blocks (internal links, FNF-SEO-PRD.md §5).
//
//  Does NOT write sitemap.xml -- scripts/generate-sitemap.js is the only
//  script that owns that file; run it after this one.
//
//  Usage:
//    node scripts/prerender-news.js
//    SUPABASE_URL=... SUPABASE_ANON_KEY=... node scripts/prerender-news.js
//
//  *** RUN THIS AFTER EVERY CHANGE TO news/post.html OR news/index.html. ***
//  This has bitten the same way twice during Phases 0b-5: a fix lands in
//  the source template (new markup, new JS), but the already-generated
//  copies under news/<slug>/index.html (and its en/news/<slug>/ twin)
//  are untouched static files -- they keep shipping whatever HTML existed
//  the last time this script ran, silently drifting out of date with no
//  error from anything (the site still "works", it's just serving stale
//  markup to crawlers and to anyone who lands on the generated page
//  directly). There is no file-watcher or CI hook enforcing this yet.
// ============================================================

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qxfcwsiysnjxhxljqigl.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF4ZmN3c2l5c25qeGh4bGpxaWdsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxODM4MDUsImV4cCI6MjA5Nzc1OTgwNX0.SOeTrxnKulgO8ao8HSwxyKE-m9pvaQ54Pa_IGWWyKDc';

const REPO_ROOT = path.join(__dirname, '..');
const TEMPLATE_PATH = path.join(REPO_ROOT, 'news', 'post.html');
const LISTING_PATH = path.join(REPO_ROOT, 'news', 'index.html');
const EN_NEWS_DIR = path.join(REPO_ROOT, 'en', 'news');

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

// Approved author bios (2026-10-22), for the Person schema and the
// author-line tooltip. Keyed by the exact `author` string in Supabase.
// Georgian only -- not shown on EN pages (would read oddly mid-English).
const AUTHOR_BIOS = {
  GeoArchnemesis: 'GeoArchnemesis - FNF.GE-ის ჟურნალისტი და დამფუძნებელი.',
};

function xmlEscapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// An article counts as having a real English version only when BOTH the
// headline and the body are non-empty -- a lone meta_title_en with no
// body would ship a half-English page, which is exactly what task 2a
// says to skip. Videos (Task 4, phase 3) are Georgian-only but always
// appear in the EN listing with their Georgian title (news_feed_view
// already sets a video row's title_en = its title_ka, never null) -- no
// body to check, no translation, always eligible.
function hasEn(a) {
  if (a.kind === 'video') return true;
  return !!(a.title_en && a.title_en.trim() && a.body_en && a.body_en.trim());
}

// Task 4, phase 3: "minutes:seconds", literally -- not H:MM:SS, per spec.
function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds || 0));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

// Standard play-button overlay (circle + triangle), inline SVG matching
// this site's existing icon convention (contact popup's X, quiz's back
// chevron) rather than an emoji or icon font.
const PLAY_ICON_SVG = '<svg class="nw-play-icon" width="56" height="56" viewBox="0 0 56 56" aria-hidden="true" focusable="false"><circle cx="28" cy="28" r="28" fill="rgba(0,0,0,.55)"/><path d="M22 17.5v21l18-10.5z" fill="#fff"/></svg>';
// Feather Icons v4.29.1 "eye" (MIT) -- same icon set/stroke conventions as
// news/index.html's NW_ICON_LIKE/COMMENT/SHARE (that file's own comment
// names the exact set), copied statically, not drawn/invented.
const EYE_ICON_SVG = '<svg class="nw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
function formatViewCount(n) { return Number(n || 0).toLocaleString('en-US'); }

// Mirrors nwTransformUrl()/nwSrcset() in news/post.html and
// news/index.html -- Supabase Storage's object endpoint ignores
// resize query params; the render endpoint is a different path.
// width alone (no height/resize) leaves the render endpoint free to keep
// the source's native 2400x1616 height, stretching the delivered pixels
// into the wrong ratio -- every call site must pass its own height.
function transformUrl(url, width, quality, height, resize = 'cover') {
  const marker = '/storage/v1/object/public/';
  const idx = url ? url.indexOf(marker) : -1;
  if (idx === -1) return url;
  const base = url.slice(0, idx) + '/storage/v1/render/image/public/' + url.slice(idx + marker.length);
  return `${base}?width=${width}&height=${height}&resize=${resize}&quality=${quality}`;
}
// sizes: array of [width, height] pairs, one target aspect ratio per slot.
function srcset(url, sizes, quality) {
  if (!url) return '';
  return sizes.map(([w, h]) => `${transformUrl(url, w, quality, h)} ${w}w`).join(', ');
}

// Mirrors nwExcerpt() in news/post.html.
function excerpt(html, maxLen) {
  const text = (html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLen) return text;
  const cut = text.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim() + '…';
}

// schema.org BreadcrumbList -- positions are 1-based and sequential.
function breadcrumbJsonLd(items) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, name: it.name, item: it.url })),
  };
}

// Mirrors NW_KA_MONTHS_LONG in news/post.html -- do NOT switch this to
// toLocaleDateString('ka-GE'), see CLAUDE.md.
const NW_KA_MONTHS_LONG = ['იანვარი','თებერვალი','მარტი','აპრილი','მაისი','ივნისი','ივლისი','აგვისტო','სექტემბერი','ოქტომბერი','ნოემბერი','დეკემბერი'];
function formatDateKaLong(d) {
  return d.getDate() + ' ' + NW_KA_MONTHS_LONG[d.getMonth()] + ', ' + d.getFullYear();
}
// en-US has no CLAUDE.md caveat (unlike ka-GE) -- Node's built-in ICU
// handles it fine.
function formatDateEnLong(d) {
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}
function formatDate(d, lang) {
  return lang === 'en' ? formatDateEnLong(d) : formatDateKaLong(d);
}

// Absolute -- for canonical/og:url/hreflang/JSON-LD, where the spec
// requires a full URL.
function urlFor(slug, lang) {
  return lang === 'en' ? `https://fnf.ge/en/news/${slug}/` : `https://fnf.ge/news/${slug}/`;
}
// Relative -- for in-page <a href> navigation (cards, sidebar, lang
// toggle), matching every other internal link on the site.
function relUrlFor(slug, lang) {
  return lang === 'en' ? `/en/news/${slug}/` : `/news/${slug}/`;
}

// 3 most recent OTHER published articles, newest first -- no longer
// category-based (categories removed 2026-10-22). On an EN page this
// only offers other EN-eligible articles, so every sidebar link stays
// in the same language as the page it's on.
function relatedArticles(a, allArticles, lang) {
  return allArticles
    .filter((o) => o.slug !== a.slug && (lang !== 'en' || hasEn(o)))
    .sort((x, y) => new Date(y.published_at || 0) - new Date(x.published_at || 0))
    .slice(0, 3);
}

function sidebarCardHtml(a, lang) {
  const title = lang === 'en' ? a.title_en : a.title_ka;
  const alt = (lang === 'en' ? a.cover_image_alt_en : a.cover_image_alt_ka) || title;
  const thumb = a.cover_image_url
    ? `<img class="acl-thumb" src="${transformUrl(a.cover_image_url, 224, 75, 168)}" srcset="${srcset(a.cover_image_url, [[224, 168], [336, 252]], 75)}" sizes="112px" width="112" height="84" alt="${xmlEscapeAttr(alt)}" loading="lazy" decoding="async" />`
    : '';
  const dateStr = a.published_at ? formatDate(new Date(a.published_at), lang) : '';
  return `<a class="article-card--list" href="${relUrlFor(a.slug, lang)}">${thumb}<div class="acl-content"><h3 class="acl-title">${escapeHtml(title)}</h3><div class="acl-meta"><time datetime="${a.published_at || ''}">${escapeHtml(dateStr)}</time></div></div></a>`;
}

// Video card (Task 4, phase 3) -- shared by homeHeroCardHtml() and
// heroCardHtml() below, same way those two already share identical
// markup/CSS for articles, just the heading tag differing (h3 under the
// homepage/sport strip's own <h2>, h2 under /news/'s <h1>). Exactly the
// elements approved: thumbnail + play overlay + duration, title, date
// (same formatDate() as articles), and the watch button -- nothing else.
// No dek (videos have none); same Georgian title in both languages
// (news_feed_view already sets title_en = title_ka for a video row, so
// this reads a.title_ka regardless of `lang` -- never translated).
//
// opts.showViewCount: /news/ itself ("good, do not touch it") keeps the
// exact card it already had -- only homeHeroCardHtml() (homepage slider,
// fantasy-page slider, fantasy-page 3-item strip) passes this, adding the
// eye icon + view count on the same line as the date, right after it.
function videoCardHtmlInner(a, lang, headingTag, opts) {
  const title = a.title_ka;
  const dateStr = a.published_at ? formatDate(new Date(a.published_at), lang) : '';
  const durationStr = formatDuration(a.duration_seconds);
  const watchLabel = 'უყურე ვიდეოს საიტზე';
  const viewsHtml = (opts && opts.showViewCount)
    ? ` <span class="nw-video-views">${EYE_ICON_SVG} ${formatViewCount(a.view_count)}</span>`
    : '';
  return `
    <div class="nw-card-wrap">
      <a class="nw-card video-card--hero" href="?video=${encodeURIComponent(a.video_id)}" data-video-id="${xmlEscapeAttr(a.video_id)}">
        <span class="nw-video-thumb-wrap">
          <img class="nw-card-img" src="${xmlEscapeAttr(a.thumbnail_url)}" alt="${xmlEscapeAttr(title)}" width="800" height="450" loading="lazy" decoding="async" />
          <span class="nw-play-btn" aria-hidden="true">${PLAY_ICON_SVG}</span>
          <span class="nw-video-duration">${escapeHtml(durationStr)}</span>
        </span>
        <div class="nw-card-body">
          <${headingTag} class="nw-card-title">${escapeHtml(title)}</${headingTag}>
          <div class="nw-card-meta"><time datetime="${xmlEscapeAttr(a.published_at || '')}">${escapeHtml(dateStr)}</time>${viewsHtml}</div>
          <span class="btn btn-primary nw-video-watch-btn">${escapeHtml(watchLabel)}</span>
        </div>
      </a>
    </div>`;
}

// Same markup/CSS as /news/'s own hero card (heroCardHtml, defined
// below) -- duplicated rather than called directly because the
// homepage's section heading is already an <h2> ("სიახლეები"), so the
// card title here has to be an <h3> to sit under it instead of beside
// it in the heading hierarchy. /news/'s own hero keeps <h2> (it sits
// under that page's <h1>, not an <h2>).
function homeHeroCardHtml(a) {
  if (a.kind === 'video') return videoCardHtmlInner(a, 'ka', 'h3', { showViewCount: true });
  const alt = a.cover_image_alt_ka || a.title_ka;
  const dek = a.meta_description_ka;
  const dateStr = a.published_at ? formatDate(new Date(a.published_at), 'ka') : '';
  const img = a.cover_image_url
    ? `<img class="nw-card-img" src="${transformUrl(a.cover_image_url, 400, 75, 225)}" srcset="${srcset(a.cover_image_url, [[400, 225], [800, 450], [1200, 675]], 75)}" sizes="(min-width: 480px) 343px, 100vw" width="800" height="450" alt="${xmlEscapeAttr(alt)}" loading="lazy" decoding="async" />`
    : '';
  return `
    <div class="nw-card-wrap">
      <a class="nw-card article-card--hero" href="${relUrlFor(a.slug, 'ka')}">
        ${img}
        <div class="nw-card-body">
          <h3 class="nw-card-title">${escapeHtml(a.title_ka)}</h3>
          ${dek ? `<p class="nw-card-dek">${escapeHtml(dek)}</p>` : ''}
          <div class="nw-card-meta"><time datetime="${xmlEscapeAttr(a.published_at || '')}">${escapeHtml(dateStr)}</time></div>
        </div>
      </a>
    </div>`;
}

// Task 4, phase 3 -- fantasy pages (above "ჩემი ბილეთები", VIDEO-SLIDER
// marker) AND the homepage (NEWS-HOME marker, see main() below -- the
// homepage's own news section is this same slider too, not a separate
// 3-item grid). The complete merged list, no cap -- .nw-slider-list is
// the scroll-snap container (style.css), same .nw-card-wrap cards.
// opts.id: the homepage is the only page with an id="newsStrip" anchor on
// this section (nothing links to one on the 9 fantasy pages), so only it
// passes opts.id:'newsStrip'.
function videoSliderHtml(items, heading, opts) {
  if (!items.length) return '';
  const idAttr = (opts && opts.id) ? ` id="${opts.id}"` : '';
  return [
    `<section class="news-strip"${idAttr}><div class="wrap">`,
    `<div class="sec-head"><h2>${escapeHtml(heading)}</h2></div>`,
    '<div class="nw-slider-list">',
    items.map((a) => homeHeroCardHtml(a)).join(''),
    '</div>',
    '</div></section>',
  ].join('\n');
}

// Without categories there's no reliable signal for which single sport
// an article is "about", so the article page's contextual fantasy-page
// link (FNF-SEO-PRD.md §5d / task 3d) points at the homepage rather than
// guessing a specific sport. Revisit if a per-article sport field is
// ever added.
function sportCtaHtml(lang) {
  return lang === 'en'
    ? `<p class="nw-sport-cta">Play fantasy sports at <a href="/">Fight Night Fantasy</a>.</p>`
    : `<p class="nw-sport-cta">ითამაშე <a href="/">ფენტეზი</a> Fight Night Fantasy-ზე.</p>`;
}

// Slice-based, marker-preserving substitution (same convention as the
// NEWS-GRID markers below): the start/end comments stay in the output,
// not just the generated content between them. This matters for
// news/index.html specifically, since it's BOTH the source template and
// the write destination for the KA listing -- a plain needle-consuming
// replace() would work once, then throw "anchor not found" on every
// later run because the markers it's looking for would already be gone
// from the file it just wrote. (news/post.html doesn't have this
// problem -- its per-article output goes to a different file -- but
// every call site here uses the same safe helper for consistency.)
function replaceMarkerBlock(html, startMarker, endMarker, content, label) {
  const startIdx = html.indexOf(startMarker);
  const endIdx = html.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1) throw new Error(`anchor not found (template drifted?): ${label}`);
  return html.slice(0, startIdx) + startMarker + content + endMarker + html.slice(endIdx + endMarker.length);
}

// Reciprocal hreflang (task 2c): present on BOTH twins when an EN
// version exists, absent entirely (both twins) when it doesn't -- never
// a one-sided link to a URL that isn't actually being generated.
function hreflangTags(kaUrl, enUrl, enExists) {
  if (!enExists) return '';
  return [
    `<link rel="alternate" hreflang="ka" href="${kaUrl}" />`,
    `<link rel="alternate" hreflang="en" href="${enUrl}" />`,
    `<link rel="alternate" hreflang="x-default" href="${kaUrl}" />`,
  ].join('\n');
}

function ogLocaleAlt(lang, enExists) {
  if (!enExists) return '';
  const alt = lang === 'en' ? 'ka_GE' : 'en_US';
  return `<meta property="og:locale:alternate" content="${alt}" />`;
}

// Real <a href> toggle (task 2g) -- never a client-side switch. Shared by
// article pages (kaUrl/enUrl = the sibling article URLs) and the listing
// pages (kaUrl/enUrl = /news/ and /en/news/). On the KA side it only
// appears when an EN twin exists; the EN side always has one (KA is the
// required, always-present language).
function langToggleHtml(kaUrl, enUrl, lang, enExists) {
  if (lang === 'ka' && !enExists) {
    return `<div class="nw-lang" id="nwLang"><span aria-current="page">ქართ</span></div>`;
  }
  return [
    `<div class="nw-lang" id="nwLang">`,
    `<a href="${kaUrl}"${lang === 'ka' ? ' aria-current="page"' : ''}>ქართ</a>`,
    `<a href="${enUrl}"${lang === 'en' ? ' aria-current="page"' : ''}>Eng</a>`,
    `</div>`,
  ].join('');
}

function buildArticlePage(template, a, allArticles, lang) {
  const enExists = hasEn(a);
  const title = lang === 'en' ? a.title_en : a.title_ka;
  const body = lang === 'en' ? a.body_en : a.body_ka;
  const metaTitle = lang === 'en' ? (a.meta_title_en || a.title_en) : (a.meta_title_ka || a.title_ka);
  const metaDesc = (lang === 'en' ? a.meta_description_en : a.meta_description_ka) || excerpt(body, 155);
  const cleanUrl = urlFor(a.slug, lang);
  const alt = (lang === 'en' ? a.cover_image_alt_en : a.cover_image_alt_ka) || title;
  const dateStr = a.published_at ? formatDate(new Date(a.published_at), lang) : '';
  const ogImage = a.cover_image_url ? transformUrl(a.cover_image_url, 1200, 75, 630) : 'https://fnf.ge/logo.png';
  const backLabel = lang === 'en' ? 'News' : 'სიახლეები';
  const backHref = lang === 'en' ? '/en/news/' : '/news/';

  const coverHtml = a.cover_image_url
    ? `<img class="nw-art-cover" src="${transformUrl(a.cover_image_url, 800, 75, 450)}" srcset="${srcset(a.cover_image_url, [[400, 225], [800, 450], [1200, 675], [1600, 900]], 75)}" sizes="(min-width: 1100px) 760px, (min-width: 768px) 700px, 100vw" width="800" height="450" alt="${xmlEscapeAttr(alt)}" loading="eager" fetchpriority="high" decoding="async" />`
    : '';

  const authorBio = lang === 'ka' && a.author && AUTHOR_BIOS[a.author];
  const authorHtml = authorBio ? `<span title="${xmlEscapeAttr(authorBio)}">${a.author}</span>` : a.author;
  const metaLine = [authorHtml, dateStr ? `<time datetime="${xmlEscapeAttr(a.published_at)}">${escapeHtml(dateStr)}</time>` : '']
    .filter(Boolean).join(' · ');

  const bakedArt = [
    `<a class="qback" href="${backHref}"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 66 43" aria-hidden="true" focusable="false"><polygon points="39.58,4.46 44.11,0 66,21.5 44.11,43 39.58,38.54 56.94,21.5"></polygon><polygon points="19.79,4.46 24.32,0 46.21,21.5 24.32,43 19.79,38.54 37.15,21.5"></polygon><polygon points="0,4.46 4.53,0 26.42,21.5 4.53,43 0,38.54 17.36,21.5"></polygon></svg><span class="qback-label">${backLabel}</span></a>`,
    langToggleHtml(relUrlFor(a.slug, 'ka'), relUrlFor(a.slug, 'en'), lang, enExists),
    `<h1 class="nw-art-title">${escapeHtml(title)}</h1>`,
    coverHtml,
    `<div class="nw-art-body">${body}</div>`,
    `<div class="nw-art-meta">${metaLine}</div>`,
    sportCtaHtml(lang),
  ].join('\n');

  const related = relatedArticles(a, allArticles, lang);
  const sidebarHtml = related.length
    ? related.map((o) => sidebarCardHtml(o, lang)).join('')
    : `<div class="nw-comment-empty">${lang === 'en' ? 'No other articles yet' : 'სხვა სტატია ჯერ არ არის'}</div>`;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: title,
    inLanguage: lang,
    datePublished: a.published_at || undefined,
    dateModified: a.published_at || undefined,
    image: a.cover_image_url || undefined,
  };
  if (a.author) jsonLd.author = { '@type': 'Person', name: a.author, description: authorBio || undefined };

  // BreadcrumbList (task 3a): Home → News → <article title>. No category
  // level -- categories are gone.
  const homeLabel = lang === 'en' ? 'Home' : 'მთავარი';
  const newsLabel = lang === 'en' ? 'News' : 'სიახლეები';
  const newsUrl = lang === 'en' ? 'https://fnf.ge/en/news/' : 'https://fnf.ge/news/';
  const breadcrumbLd = breadcrumbJsonLd([
    { name: homeLabel, url: 'https://fnf.ge/' },
    { name: newsLabel, url: newsUrl },
    { name: title, url: cleanUrl },
  ]);

  let html = template;

  const replace = (needle, replacement, label) => {
    if (!html.includes(needle)) throw new Error(`prerender anchor not found (template drifted?): ${label}`);
    html = html.replace(needle, replacement);
  };

  if (lang === 'en') {
    replace('<html lang="ka">', '<html lang="en">', 'html lang attribute');
  }

  replace(
    '<title id="nwTitleTag">სტატია - Fight Night Fantasy</title>',
    `<title id="nwTitleTag">${escapeHtml(metaTitle)}</title>`,
    'title'
  );
  replace(
    '<meta name="description" id="nwDescTag" content="Fight Night Fantasy - სიახლეები." />',
    `<meta name="description" id="nwDescTag" content="${xmlEscapeAttr(metaDesc)}" />`,
    'description'
  );
  replace(
    '<link rel="canonical" id="nwCanonical" href="https://fnf.ge/news/" />',
    `<link rel="canonical" id="nwCanonical" href="${cleanUrl}" />`,
    'canonical'
  );
  html = replaceMarkerBlock(
    html, '<!-- HREFLANG:START -->', '<!-- HREFLANG:END -->',
    hreflangTags(urlFor(a.slug, 'ka'), urlFor(a.slug, 'en'), enExists),
    'hreflang markers'
  );
  replace(
    '<meta property="og:url" id="nwOgUrl" content="https://fnf.ge/news/" />',
    `<meta property="og:url" id="nwOgUrl" content="${cleanUrl}" />`,
    'og:url'
  );
  replace(
    '<meta property="og:locale" id="nwOgLocale" content="ka_GE" />',
    `<meta property="og:locale" id="nwOgLocale" content="${lang === 'en' ? 'en_US' : 'ka_GE'}" />`,
    'og:locale'
  );
  html = replaceMarkerBlock(
    html, '<!-- OGLOCALEALT:START -->', '<!-- OGLOCALEALT:END -->',
    ogLocaleAlt(lang, enExists),
    'og:locale:alternate markers'
  );
  replace(
    '<meta property="og:title" id="nwOgTitle" content="Fight Night Fantasy - სიახლეები" />',
    `<meta property="og:title" id="nwOgTitle" content="${xmlEscapeAttr(metaTitle)}" />`,
    'og:title'
  );
  replace(
    '<meta property="og:description" id="nwOgDesc" content="Fight Night Fantasy - სიახლეები." />',
    `<meta property="og:description" id="nwOgDesc" content="${xmlEscapeAttr(metaDesc)}" />`,
    'og:description'
  );
  replace(
    '<meta property="og:image" id="nwOgImage" content="https://fnf.ge/logo.png" />',
    `<meta property="og:image" id="nwOgImage" content="${xmlEscapeAttr(ogImage)}" />`,
    'og:image'
  );
  replace(
    '<meta property="article:published_time" id="nwArticlePublished" content="" />',
    a.published_at ? `<meta property="article:published_time" id="nwArticlePublished" content="${xmlEscapeAttr(a.published_at)}" />` : '',
    'article:published_time'
  );
  replace(
    '<meta name="twitter:title" id="nwTwTitle" content="Fight Night Fantasy - სიახლეები" />',
    `<meta name="twitter:title" id="nwTwTitle" content="${xmlEscapeAttr(metaTitle)}" />`,
    'twitter:title'
  );
  replace(
    '<meta name="twitter:description" id="nwTwDesc" content="Fight Night Fantasy - სიახლეები." />',
    `<meta name="twitter:description" id="nwTwDesc" content="${xmlEscapeAttr(metaDesc)}" />`,
    'twitter:description'
  );
  replace(
    '<meta name="twitter:image" id="nwTwImage" content="https://fnf.ge/logo.png" />',
    `<meta name="twitter:image" id="nwTwImage" content="${xmlEscapeAttr(ogImage)}" />`,
    'twitter:image'
  );
  replace(
    '<script type="application/ld+json">PRERENDER_JSONLD_PLACEHOLDER</script>',
    `<script type="application/ld+json" id="nwJsonLd">${JSON.stringify(jsonLd)}</script>\n<script type="application/ld+json" id="nwBreadcrumbLd">${JSON.stringify(breadcrumbLd)}</script>`,
    'json-ld placeholder'
  );
  replace(
    '<main class="nw-art" id="nwArt">\n<a class="qback" href="/news/"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 66 43" aria-hidden="true" focusable="false"><polygon points="39.58,4.46 44.11,0 66,21.5 44.11,43 39.58,38.54 56.94,21.5"></polygon><polygon points="19.79,4.46 24.32,0 46.21,21.5 24.32,43 19.79,38.54 37.15,21.5"></polygon><polygon points="0,4.46 4.53,0 26.42,21.5 4.53,43 0,38.54 17.36,21.5"></polygon></svg><span class="qback-label">სიახლეები</span></a>\n<div class="nw-loading">იტვირთება...</div>\n</main>',
    `<main class="nw-art" id="nwArt">\n${bakedArt}\n</main>`,
    'article body'
  );
  replace(
    '<div class="nw-sidebar-list" id="nwSidebarList"><div class="nw-loading">იტვირთება...</div></div>',
    `<div class="nw-sidebar-list" id="nwSidebarList">${sidebarHtml}</div>`,
    'sidebar related articles'
  );

  return html;
}

// Hero reuses .nw-card/.nw-card-wrap/.nw-card-img/.nw-card-body verbatim
// (Phase 4's "keep .nw-card as-is" -- its 12px radius and flush 16:9
// crop are already correct) plus .article-card--hero as a second class
// so the PRD's named component is present in the markup; .nw-card-dek
// is the one element the hero needs that .nw-card didn't already have.
function heroCardHtml(a, lang) {
  if (a.kind === 'video') return videoCardHtmlInner(a, lang, 'h2');
  const title = lang === 'en' ? a.title_en : a.title_ka;
  const alt = (lang === 'en' ? a.cover_image_alt_en : a.cover_image_alt_ka) || title;
  const dek = lang === 'en' ? a.meta_description_en : a.meta_description_ka;
  const dateStr = a.published_at ? formatDate(new Date(a.published_at), lang) : '';
  const img = a.cover_image_url
    ? `<img class="nw-card-img" src="${transformUrl(a.cover_image_url, 400, 75, 225)}" srcset="${srcset(a.cover_image_url, [[400, 225], [800, 450], [1200, 675]], 75)}" sizes="(min-width: 480px) 343px, 100vw" width="800" height="450" alt="${xmlEscapeAttr(alt)}" loading="lazy" decoding="async" />`
    : '';
  return `
    <div class="nw-card-wrap">
      <a class="nw-card article-card--hero" href="${relUrlFor(a.slug, lang)}">
        ${img}
        <div class="nw-card-body">
          <h2 class="nw-card-title">${escapeHtml(title)}</h2>
          ${dek ? `<p class="nw-card-dek">${escapeHtml(dek)}</p>` : ''}
          <div class="nw-card-meta"><time datetime="${xmlEscapeAttr(a.published_at || '')}">${escapeHtml(dateStr)}</time></div>
        </div>
      </a>
    </div>`;
}

// PRD 8.3 -- every article after the hero.
function listCardHtml(a, lang) {
  const title = lang === 'en' ? a.title_en : a.title_ka;
  const alt = (lang === 'en' ? a.cover_image_alt_en : a.cover_image_alt_ka) || title;
  const dateStr = a.published_at ? formatDate(new Date(a.published_at), lang) : '';
  const img = a.cover_image_url
    ? `<img class="acl-thumb" src="${transformUrl(a.cover_image_url, 224, 75, 168)}" srcset="${srcset(a.cover_image_url, [[224, 168], [336, 252]], 75)}" sizes="112px" width="112" height="84" alt="${xmlEscapeAttr(alt)}" loading="lazy" decoding="async" />`
    : '';
  return `
    <div class="nw-card-wrap">
      <a class="nw-card article-card--list" href="${relUrlFor(a.slug, lang)}">
        ${img}
        <div class="acl-content">
          <h2 class="acl-title">${escapeHtml(title)}</h2>
          <div class="acl-meta"><time datetime="${xmlEscapeAttr(a.published_at || '')}">${escapeHtml(dateStr)}</time></div>
        </div>
      </a>
    </div>`;
}

function buildListingGrid(articles, lang) {
  if (!articles.length) return `<div class="nw-empty">${lang === 'en' ? 'No articles yet' : 'სტატია ჯერ არ არის'}</div>`;
  return articles.map((a) => heroCardHtml(a, lang)).join('');
}

// Builds either news/index.html (lang='ka') or en/news/index.html
// (lang='en') from the SAME pristine template -- the EN listing only
// ever shows EN-eligible articles (task 2a's skip rule applies to the
// listing too, not just individual article pages).
function buildListingPage(listingTemplate, articles, lang) {
  const eligible = lang === 'en' ? articles.filter(hasEn) : articles;
  const grid = buildListingGrid(eligible, lang);

  let html = listingTemplate;
  const replace = (needle, replacement, label) => {
    if (!html.includes(needle)) throw new Error(`listing anchor not found (template drifted?): ${label}`);
    html = html.replace(needle, replacement);
  };

  if (lang === 'en') {
    replace('<html lang="ka">', '<html lang="en">', 'html lang attribute');

    const kaUrl = 'https://fnf.ge/news/';
    const enUrl = 'https://fnf.ge/en/news/';
    replace('<title>FNF - სიახლეები</title>', '<title>FNF News</title>', 'title');
    replace(
      '<meta name="description" content="სპორტული ფენტეზი, სიახლეები და ანალიზი - UFC, Formula 1, NBA და ფეხბურთი." />',
      '<meta name="description" content="Sports fantasy news and analysis - UFC, Formula 1, NBA and football." />',
      'description'
    );
    replace('<link rel="canonical" href="https://fnf.ge/news/" />', `<link rel="canonical" href="${enUrl}" />`, 'canonical');
    html = replaceMarkerBlock(html, '<!-- HREFLANG:START -->', '<!-- HREFLANG:END -->', hreflangTags(kaUrl, enUrl, true), 'hreflang markers');
    replace('<meta property="og:url" content="https://fnf.ge/news/" />', `<meta property="og:url" content="${enUrl}" />`, 'og:url');
    replace('<meta property="og:locale" id="nwOgLocale" content="ka_GE" />', '<meta property="og:locale" id="nwOgLocale" content="en_US" />', 'og:locale');
    html = replaceMarkerBlock(html, '<!-- OGLOCALEALT:START -->', '<!-- OGLOCALEALT:END -->', ogLocaleAlt('en', true), 'og:locale:alternate markers');
    replace('<meta property="og:title" content="სიახლეები - Fight Night Fantasy" />', '<meta property="og:title" content="News - Fight Night Fantasy" />', 'og:title');
    replace(
      '<meta property="og:description" content="Fight Night Fantasy - სიახლეები და განახლებები." />',
      '<meta property="og:description" content="Fight Night Fantasy - news and updates." />',
      'og:description'
    );
    replace('<meta name="twitter:title" content="სიახლეები - Fight Night Fantasy" />', '<meta name="twitter:title" content="News - Fight Night Fantasy" />', 'twitter:title');
    replace(
      '<meta name="twitter:description" content="Fight Night Fantasy - სიახლეები და განახლებები." />',
      '<meta name="twitter:description" content="Fight Night Fantasy - news and updates." />',
      'twitter:description'
    );
    replace(
      '{ "@type": "ListItem", "position": 1, "name": "მთავარი", "item": "https://fnf.ge/" },\n    { "@type": "ListItem", "position": 2, "name": "სიახლეები", "item": "https://fnf.ge/news/" }',
      `{ "@type": "ListItem", "position": 1, "name": "Home", "item": "https://fnf.ge/" },\n    { "@type": "ListItem", "position": 2, "name": "News", "item": "${enUrl}" }`,
      'breadcrumb'
    );
    replace('<h1 class="nw-title">სიახლეები</h1>', '<h1 class="nw-title">News</h1>', 'h1 title');
  } else {
    // KA page: still needs the hreflang/locale-alt markers resolved --
    // present only when at least one EN-eligible article exists.
    const kaUrl = 'https://fnf.ge/news/';
    const enUrl = 'https://fnf.ge/en/news/';
    const anyEn = articles.some(hasEn);
    html = replaceMarkerBlock(html, '<!-- HREFLANG:START -->', '<!-- HREFLANG:END -->', hreflangTags(kaUrl, enUrl, anyEn), 'hreflang markers');
    html = replaceMarkerBlock(html, '<!-- OGLOCALEALT:START -->', '<!-- OGLOCALEALT:END -->', ogLocaleAlt('ka', anyEn), 'og:locale:alternate markers');
  }

  html = replaceMarkerBlock(
    html, '<!-- LANGTOGGLE:START -->', '<!-- LANGTOGGLE:END -->',
    langToggleHtml('/news/', '/en/news/', lang, lang === 'en' ? true : articles.some(hasEn)),
    'lang toggle'
  );

  const gridStart = '<!-- NEWS-GRID:START -->';
  const gridEnd = '<!-- NEWS-GRID:END -->';
  const gridStartIdx = html.indexOf(gridStart);
  const gridEndIdx = html.indexOf(gridEnd);
  if (gridStartIdx === -1 || gridEndIdx === -1) throw new Error('listing anchor not found (template drifted?): grid markers');
  html = html.slice(0, gridStartIdx) + gridStart + grid + gridEnd + html.slice(gridEndIdx + gridEnd.length);

  return html;
}

async function main() {
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  log('Fetching published articles + videos (news_feed_view)...');
  // One query, one round trip -- news_feed_view (supabase/news_feed_view.sql)
  // unions news + youtube_videos server-side and does the is_published
  // filtering itself (kept here too, harmlessly, as defense in depth).
  const { data: feedItems, error } = await sb
    .from('news_feed_view')
    .select('*')
    .eq('is_published', true)
    .order('published_at', { ascending: false });

  if (error) { log('Supabase error: ' + error.message); process.exit(1); }

  // Everything below that generates an actual article page (per-article
  // /news/<slug>/, the sidebar related-articles list, the sitemap's EN
  // block) must never see a video row -- videos have no slug/body and
  // never get their own page (Task 4, phase 3). `articles` is exactly
  // what this whole file already called `articles` before this change;
  // every one of those call sites is untouched.
  const articles = feedItems.filter((i) => i.kind === 'article');
  const videoCount = feedItems.length - articles.length;
  log(`Found ${articles.length} published article(s) (${articles.filter(hasEn).length} with an English version), ${videoCount} published video(s).`);

  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  // The template's placeholder JSON-LD tag is injected at runtime by
  // nwInjectJsonLd() (id="nwJsonLd"), so there's nothing to match in
  // the raw template -- insert a placeholder comment once, right
  // before </head>, that the per-article build then replaces.
  const templateWithPlaceholder = template.includes('PRERENDER_JSONLD_PLACEHOLDER')
    ? template
    : template.replace('</head>', '<script type="application/ld+json">PRERENDER_JSONLD_PLACEHOLDER</script>\n</head>');

  let ok = 0, failed = 0, enOk = 0, enFailed = 0;
  for (const a of articles) {
    try {
      const html = buildArticlePage(templateWithPlaceholder, a, articles, 'ka');
      const dir = path.join(REPO_ROOT, 'news', a.slug);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'index.html'), html, 'utf8');
      log(`✓ news/${a.slug}/index.html`);
      ok++;
    } catch (e) {
      log(`✗ ${a.slug}: ${e.message}`);
      failed++;
    }

    if (!hasEn(a)) continue;
    try {
      const html = buildArticlePage(templateWithPlaceholder, a, articles, 'en');
      const dir = path.join(EN_NEWS_DIR, a.slug);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'index.html'), html, 'utf8');
      log(`✓ en/news/${a.slug}/index.html`);
      enOk++;
    } catch (e) {
      log(`✗ en/${a.slug}: ${e.message}`);
      enFailed++;
    }
  }

  // Pristine copy (markers/placeholders intact) captured before the KA
  // listing below is rewritten in place -- the EN listing build needs
  // the same untouched template.
  const listingPristine = fs.readFileSync(LISTING_PATH, 'utf8');

  // Inject real <a href> anchors + titles into news/index.html's
  // initial grid, between marker comments (NEWS-GRID:START/END below).
  // Everything else in the file (nav, styles, client JS) is untouched --
  // nwRender() still re-draws the same grid on top once Supabase replies,
  // for live like/comment counts and infinite scroll.
  try {
    const listing = buildListingPage(listingPristine, feedItems, 'ka');
    fs.writeFileSync(LISTING_PATH, listing, 'utf8');
    log(`✓ news/index.html grid updated (${feedItems.length} card(s) baked in)`);
  } catch (e) {
    log(`✗ news/index.html: ${e.message}`);
  }

  try {
    const enListing = buildListingPage(listingPristine, feedItems, 'en');
    fs.mkdirSync(EN_NEWS_DIR, { recursive: true });
    fs.writeFileSync(path.join(EN_NEWS_DIR, 'index.html'), enListing, 'utf8');
    const enCount = feedItems.filter(hasEn).length;
    log(`✓ en/news/index.html grid updated (${enCount} card(s) baked in)`);
  } catch (e) {
    log(`✗ en/news/index.html: ${e.message}`);
  }

  // Homepage "სიახლეები" section (FNF-SEO-PRD.md §5a / task 3b): same
  // complete merged list as the fantasy-page slider, no cap -- not a
  // sliced 3-item grid. Position (NEWS-HOME marker) and heading text
  // unchanged. Renders nothing (not an empty section) when there's
  // nothing published yet -- same rule as the sport-page blocks below.
  const homePath = path.join(REPO_ROOT, 'index.html');
  let home = fs.readFileSync(homePath, 'utf8');
  const homeStart = '<!-- NEWS-HOME:START -->';
  const homeEnd = '<!-- NEWS-HOME:END -->';
  if (!home.includes(homeStart) || !home.includes(homeEnd)) {
    log('✗ index.html has no NEWS-HOME:START/END markers -- skipping homepage news strip.');
  } else {
    const block = videoSliderHtml(feedItems, 'სიახლეები', { id: 'newsStrip' });
    const hsi = home.indexOf(homeStart);
    const hei = home.indexOf(homeEnd);
    home = home.slice(0, hsi) + homeStart + '\n' + block + '\n' + homeEnd + home.slice(hei + homeEnd.length);
    fs.writeFileSync(homePath, home, 'utf8');
    log(`✓ index.html news strip updated (${feedItems.length} item(s))`);
  }

  // Each sport page's "latest news" slider (task 3c, reworked task 4 phase
  // 3). Categories are gone, so this can no longer be filtered per sport --
  // every sport page shows the same complete merged list as the homepage
  // strip. (The older, pre-slider 3-item NEWS-SPORT block that used to sit
  // further down these same 9 pages was removed as a duplicate -- this
  // slider is the only "latest news" block left on them.)
  const SPORT_NEWS_FILES = [
    'ufc/index.html', 'f1/index.html', 'nba/index.html',
    'football/epl/index.html', 'football/laliga/index.html', 'football/seriea/index.html',
    'football/bundesliga/index.html', 'football/ligue1/index.html', 'football/ucl/index.html',
  ];
  const sliderBlock = videoSliderHtml(feedItems, 'სიახლეები');
  for (const file of SPORT_NEWS_FILES) {
    const spPath = path.join(REPO_ROOT, file);
    let spHtml;
    try {
      spHtml = fs.readFileSync(spPath, 'utf8');
    } catch (e) {
      log(`✗ ${file}: ${e.message}`);
      continue;
    }

    const vsStart = '<!-- VIDEO-SLIDER:START -->';
    const vsEnd = '<!-- VIDEO-SLIDER:END -->';
    if (!spHtml.includes(vsStart) || !spHtml.includes(vsEnd)) {
      log(`✗ ${file} has no VIDEO-SLIDER:START/END markers -- skipping slider.`);
      continue;
    }
    const vsi = spHtml.indexOf(vsStart);
    const vei = spHtml.indexOf(vsEnd);
    spHtml = spHtml.slice(0, vsi) + vsStart + '\n' + sliderBlock + '\n' + vsEnd + spHtml.slice(vei + vsEnd.length);

    fs.writeFileSync(spPath, spHtml, 'utf8');
    log(`✓ ${file} slider updated (${feedItems.length} item(s))`);
  }

  log(`Done. ${ok} KA article page(s) written (${failed} failed), ${enOk} EN article page(s) written (${enFailed} failed).`);
  if (failed > 0 || enFailed > 0) process.exit(1);
}

main().catch((e) => { log('Fatal: ' + e.message); process.exit(1); });
