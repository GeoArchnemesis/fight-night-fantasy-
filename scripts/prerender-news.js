// ============================================================
//  PRERENDER NEWS — bakes one static /news/<slug>/index.html per
//  published article, and injects real <a href> anchors + titles
//  into news/index.html's initial grid markup.
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
//  three HTML comment markers removed. The exact same <script> tags
//  run afterwards, so comments/reactions/share/language-toggle all
//  still work -- nwLoad() derives the slug from the path (it's one of
//  /news/<slug>/, not ?slug=X) and re-fetches + re-renders the same
//  content on top. That re-render is harmless (idempotent, same data,
//  just re-draws the identical DOM) -- it exists for comments/
//  reactions/the language toggle, not because the baked content is
//  wrong.
//
//  Read-only against Supabase (anon key, same one already embedded in
//  every frontend file -- no service_role needed, since this only
//  ever reads is_published=true rows, same filter the public site
//  already applies). Writes only local files under news/.
//
//  Usage:
//    node scripts/prerender-news.js
//    SUPABASE_URL=... SUPABASE_ANON_KEY=... node scripts/prerender-news.js
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

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

function xmlEscapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Mirrors nwTransformUrl()/nwSrcset() in news/post.html and
// news/index.html -- Supabase Storage's object endpoint ignores
// resize query params; the render endpoint is a different path.
function transformUrl(url, width, quality, extra) {
  const marker = '/storage/v1/object/public/';
  const idx = url ? url.indexOf(marker) : -1;
  if (idx === -1) return url;
  const base = url.slice(0, idx) + '/storage/v1/render/image/public/' + url.slice(idx + marker.length);
  return `${base}?width=${width}&quality=${quality}${extra || ''}`;
}
function srcset(url, widths, quality) {
  if (!url) return '';
  return widths.map((w) => `${transformUrl(url, w, quality)} ${w}w`).join(', ');
}

// Mirrors nwExcerpt() in news/post.html.
function excerpt(html, maxLen) {
  const text = (html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLen) return text;
  const cut = text.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim() + '…';
}

// Mirrors NW_KA_MONTHS_LONG in news/post.html -- do NOT switch this to
// toLocaleDateString('ka-GE'), see CLAUDE.md.
const NW_KA_MONTHS_LONG = ['იანვარი','თებერვალი','მარტი','აპრილი','მაისი','ივნისი','ივლისი','აგვისტო','სექტემბერი','ოქტომბერი','ნოემბერი','დეკემბერი'];
function formatDateKaLong(d) {
  return d.getDate() + ' ' + NW_KA_MONTHS_LONG[d.getMonth()] + ', ' + d.getFullYear();
}

function buildArticlePage(template, a) {
  const title = a.title_ka;
  const metaTitle = a.meta_title_ka || a.title_ka;
  const metaDesc = a.meta_description_ka || excerpt(a.body_ka, 155);
  const cleanUrl = `https://fnf.ge/news/${a.slug}/`;
  const alt = a.cover_image_alt_ka || title;
  const dateStr = a.published_at ? formatDateKaLong(new Date(a.published_at)) : '';
  const ogImage = a.cover_image_url ? transformUrl(a.cover_image_url, 1200, 75, '&height=630&resize=cover') : 'https://fnf.ge/logo.png';

  const cats = (a.news_article_categories || []).map((x) => x.news_categories).filter(Boolean);
  const chipsHtml = cats.length
    ? `<div class="nw-chips">${cats.map((c) => `<span class="nw-chip">${escapeHtml(c.name_ka)}</span>`).join('')}</div>`
    : '';

  const coverHtml = a.cover_image_url
    ? `<img class="nw-art-cover" src="${transformUrl(a.cover_image_url, 800, 75)}" srcset="${srcset(a.cover_image_url, [400, 800, 1200], 75)}" sizes="(min-width: 768px) 700px, 100vw" width="1600" height="900" alt="${xmlEscapeAttr(alt)}" loading="eager" fetchpriority="high" decoding="async" />`
    : '';

  const bakedArt = [
    `<a class="nw-back" href="/news/">← სიახლეები</a>`,
    `<div class="nw-lang" id="nwLang"><button type="button" data-lang="ka">ქართ</button><button type="button" data-lang="en">Eng</button></div>`,
    chipsHtml,
    `<h1 class="nw-art-title">${escapeHtml(title)}</h1>`,
    `<div class="nw-art-meta">${escapeHtml([a.author, dateStr].filter(Boolean).join(' · '))}</div>`,
    `<div class="nw-reactions" id="nwReactions"></div>`,
    coverHtml,
    `<div class="nw-art-body">${a.body_ka}</div>`,
  ].join('\n');

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: a.title_ka,
    datePublished: a.published_at || undefined,
    dateModified: a.published_at || undefined,
    image: a.cover_image_url || undefined,
  };
  if (a.author) jsonLd.author = { '@type': 'Person', name: a.author };

  let html = template;

  const replace = (needle, replacement, label) => {
    if (!html.includes(needle)) throw new Error(`prerender anchor not found (template drifted?): ${label}`);
    html = html.replace(needle, replacement);
  };

  replace(
    '<title id="nwTitleTag">სტატია — Fight Night Fantasy</title>',
    `<title id="nwTitleTag">${escapeHtml(metaTitle)}</title>`,
    'title'
  );
  replace(
    '<meta name="description" id="nwDescTag" content="Fight Night Fantasy — სიახლეები." />',
    `<meta name="description" id="nwDescTag" content="${xmlEscapeAttr(metaDesc)}" />`,
    'description'
  );
  replace(
    '<link rel="canonical" id="nwCanonical" href="https://fnf.ge/news/" />',
    `<link rel="canonical" id="nwCanonical" href="${cleanUrl}" />`,
    'canonical'
  );
  replace(
    '<meta property="og:url" id="nwOgUrl" content="https://fnf.ge/news/" />',
    `<meta property="og:url" id="nwOgUrl" content="${cleanUrl}" />`,
    'og:url'
  );
  replace(
    '<meta property="og:title" id="nwOgTitle" content="Fight Night Fantasy — სიახლეები" />',
    `<meta property="og:title" id="nwOgTitle" content="${xmlEscapeAttr(metaTitle)}" />`,
    'og:title'
  );
  replace(
    '<meta property="og:description" id="nwOgDesc" content="Fight Night Fantasy — სიახლეები." />',
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
    '<meta name="twitter:title" id="nwTwTitle" content="Fight Night Fantasy — სიახლეები" />',
    `<meta name="twitter:title" id="nwTwTitle" content="${xmlEscapeAttr(metaTitle)}" />`,
    'twitter:title'
  );
  replace(
    '<meta name="twitter:description" id="nwTwDesc" content="Fight Night Fantasy — სიახლეები." />',
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
    `<script type="application/ld+json" id="nwJsonLd">${JSON.stringify(jsonLd)}</script>`,
    'json-ld placeholder'
  );
  replace(
    '<main class="nw-art" id="nwArt">\n<a class="nw-back" href="/news/">← სიახლეები</a>\n<div class="nw-loading">იტვირთება...</div>\n</main>',
    `<main class="nw-art" id="nwArt">\n${bakedArt}\n</main>`,
    'article body'
  );

  return html;
}

function buildListingGrid(articles) {
  return articles.map((a) => {
    const dateStr = a.published_at ? formatDateKaLong(new Date(a.published_at)) : '';
    const img = a.cover_image_url
      ? `<img class="nw-card-img" src="${transformUrl(a.cover_image_url, 400, 75)}" srcset="${srcset(a.cover_image_url, [400, 800], 75)}" sizes="(min-width: 480px) 343px, 100vw" width="800" height="450" alt="${xmlEscapeAttr(a.cover_image_alt_ka || a.title_ka)}" loading="lazy" decoding="async" />`
      : '';
    return `
    <div class="nw-card-wrap">
      <a class="nw-card" href="/news/${encodeURIComponent(a.slug)}/">
        ${img}
        <div class="nw-card-body">
          <div class="nw-card-title">${escapeHtml(a.title_ka)}</div>
          <div class="nw-card-meta">${escapeHtml(dateStr)}</div>
        </div>
      </a>
    </div>`;
  }).join('');
}

async function main() {
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  log('Fetching published articles...');
  const { data: articles, error } = await sb
    .from('news')
    .select('*,news_article_categories(category_id,news_categories(id,name_ka,name_en,slug))')
    .eq('is_published', true)
    .order('published_at', { ascending: false });

  if (error) { log('Supabase error: ' + error.message); process.exit(1); }
  log(`Found ${articles.length} published article(s).`);

  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  // The template's placeholder JSON-LD tag is injected at runtime by
  // nwInjectJsonLd() (id="nwJsonLd"), so there's nothing to match in
  // the raw template -- insert a placeholder comment once, right
  // before </head>, that the per-article build then replaces.
  const templateWithPlaceholder = template.includes('PRERENDER_JSONLD_PLACEHOLDER')
    ? template
    : template.replace('</head>', '<script type="application/ld+json">PRERENDER_JSONLD_PLACEHOLDER</script>\n</head>');

  let ok = 0, failed = 0;
  for (const a of articles) {
    try {
      const html = buildArticlePage(templateWithPlaceholder, a);
      const dir = path.join(REPO_ROOT, 'news', a.slug);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'index.html'), html, 'utf8');
      log(`✓ news/${a.slug}/index.html`);
      ok++;
    } catch (e) {
      log(`✗ ${a.slug}: ${e.message}`);
      failed++;
    }
  }

  // Inject real <a href> anchors + titles into news/index.html's
  // initial grid, between marker comments, same convention as
  // scripts/sync-news-sitemap.js's NEWS:START/END block. Everything
  // else in the file (nav, styles, client JS) is untouched -- nwRender()
  // still re-draws the same grid on top once Supabase replies, for the
  // KA/EN toggle and live like/comment counts.
  let listing = fs.readFileSync(LISTING_PATH, 'utf8');
  const startMarker = '<!-- NEWS-GRID:START -->';
  const endMarker = '<!-- NEWS-GRID:END -->';
  if (!listing.includes(startMarker) || !listing.includes(endMarker)) {
    log('✗ news/index.html has no NEWS-GRID markers -- run the one-time template edit first, skipping listing prerender.');
  } else {
    const startIdx = listing.indexOf(startMarker);
    const endIdx = listing.indexOf(endMarker);
    const grid = buildListingGrid(articles);
    listing = listing.slice(0, startIdx) + startMarker + grid + endMarker + listing.slice(endIdx + endMarker.length);
    fs.writeFileSync(LISTING_PATH, listing, 'utf8');
    log(`✓ news/index.html grid updated (${articles.length} card(s) baked in)`);
  }

  log(`Done. ${ok} article page(s) written, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { log('Fatal: ' + e.message); process.exit(1); });
