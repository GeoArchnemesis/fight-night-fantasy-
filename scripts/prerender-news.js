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

// Mirrors nwReadingTime() in both news/post.html and news/index.html.
function readingTime(body) {
  const text = (body || '').replace(/<[^>]+>/g, ' ').trim();
  const words = text ? text.split(/\s+/).length : 0;
  return Math.max(1, Math.ceil(words / 160));
}
function catsOf(a) {
  return (a.news_article_categories || []).map((x) => x.news_categories).filter(Boolean);
}
function catPillHtml(a) {
  const cats = catsOf(a);
  if (!cats.length) return '';
  return `<span class="nw-cat-pill">${escapeHtml(cats[0].name_ka)}</span>`;
}

// Mirrors NW_KA_MONTHS_LONG in news/post.html -- do NOT switch this to
// toLocaleDateString('ka-GE'), see CLAUDE.md.
const NW_KA_MONTHS_LONG = ['იანვარი','თებერვალი','მარტი','აპრილი','მაისი','ივნისი','ივლისი','აგვისტო','სექტემბერი','ოქტომბერი','ნოემბერი','დეკემბერი'];
function formatDateKaLong(d) {
  return d.getDate() + ' ' + NW_KA_MONTHS_LONG[d.getMonth()] + ', ' + d.getFullYear();
}

// Up to 3 published articles sharing a category with `a`, excluding
// itself, newest first -- computed from the in-memory `allArticles`
// list (already fetched with categories for this whole build run)
// rather than a second query, since prerendering has every published
// article in hand already.
function relatedArticles(a, allArticles) {
  const ids = new Set(catsOf(a).map((c) => c.id));
  if (!ids.size) return [];
  return allArticles
    .filter((o) => o.slug !== a.slug && catsOf(o).some((c) => ids.has(c.id)))
    .sort((x, y) => new Date(y.published_at || 0) - new Date(x.published_at || 0))
    .slice(0, 3);
}
function sidebarCardHtml(a) {
  const thumb = a.cover_image_url
    ? `<img class="acl-thumb" src="${transformUrl(a.cover_image_url, 224, 75, 168)}" srcset="${srcset(a.cover_image_url, [[224, 168], [336, 252]], 75)}" sizes="112px" width="112" height="84" alt="${xmlEscapeAttr(a.cover_image_alt_ka || a.title_ka)}" loading="lazy" decoding="async" />`
    : '';
  const dateStr = a.published_at ? formatDateKaLong(new Date(a.published_at)) : '';
  return `<a class="article-card--list" href="/news/${encodeURIComponent(a.slug)}/">${thumb}<div class="acl-content"><h3 class="acl-title">${escapeHtml(a.title_ka)}</h3><div class="acl-meta"><time datetime="${a.published_at || ''}">${escapeHtml(dateStr)}</time> · ${readingTime(a.body_ka)} წთ კითხვა</div></div></a>`;
}

function buildArticlePage(template, a, allArticles) {
  const title = a.title_ka;
  const metaTitle = a.meta_title_ka || a.title_ka;
  const metaDesc = a.meta_description_ka || excerpt(a.body_ka, 155);
  const cleanUrl = `https://fnf.ge/news/${a.slug}/`;
  const alt = a.cover_image_alt_ka || title;
  const dateStr = a.published_at ? formatDateKaLong(new Date(a.published_at)) : '';
  const ogImage = a.cover_image_url ? transformUrl(a.cover_image_url, 1200, 75, 630) : 'https://fnf.ge/logo.png';
  const readMins = readingTime(a.body_ka);

  const cats = catsOf(a);
  const chipsHtml = cats.length
    ? `<div class="nw-chips">${cats.map((c) => `<span class="nw-cat-pill">${escapeHtml(c.name_ka)}</span>`).join('')}</div>`
    : '';

  const coverHtml = a.cover_image_url
    ? `<img class="nw-art-cover" src="${transformUrl(a.cover_image_url, 800, 75, 450)}" srcset="${srcset(a.cover_image_url, [[400, 225], [800, 450], [1200, 675], [1600, 900]], 75)}" sizes="(min-width: 1100px) 760px, (min-width: 768px) 700px, 100vw" width="800" height="450" alt="${xmlEscapeAttr(alt)}" loading="eager" fetchpriority="high" decoding="async" />`
    : '';

  const metaLine = [a.author, dateStr ? `<time datetime="${xmlEscapeAttr(a.published_at)}">${escapeHtml(dateStr)}</time>` : '']
    .filter(Boolean).join(' · ') + (dateStr ? ` · ${readMins} წთ კითხვა` : '');

  const bakedArt = [
    `<a class="nw-back" href="/news/">← სიახლეები</a>`,
    `<div class="nw-lang" id="nwLang"><button type="button" data-lang="ka">ქართ</button><button type="button" data-lang="en">Eng</button></div>`,
    chipsHtml,
    `<h1 class="nw-art-title">${escapeHtml(title)}</h1>`,
    `<div class="nw-art-meta">${metaLine}</div>`,
    coverHtml,
    `<div class="nw-art-body">${a.body_ka}</div>`,
  ].join('\n');

  const related = relatedArticles(a, allArticles);
  const sidebarHtml = related.length
    ? related.map(sidebarCardHtml).join('')
    : '<div class="nw-comment-empty">სხვა სტატია ჯერ არ არის</div>';

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
function heroCardHtml(a) {
  const dateStr = a.published_at ? formatDateKaLong(new Date(a.published_at)) : '';
  const dek = a.meta_description_ka;
  const img = a.cover_image_url
    ? `<img class="nw-card-img" src="${transformUrl(a.cover_image_url, 400, 75, 225)}" srcset="${srcset(a.cover_image_url, [[400, 225], [800, 450], [1200, 675]], 75)}" sizes="(min-width: 480px) 343px, 100vw" width="800" height="450" alt="${xmlEscapeAttr(a.cover_image_alt_ka || a.title_ka)}" loading="lazy" decoding="async" />`
    : '';
  return `
    <div class="nw-card-wrap">
      <a class="nw-card article-card--hero" href="/news/${encodeURIComponent(a.slug)}/">
        ${img}
        ${catPillHtml(a)}
        <div class="nw-card-body">
          <h2 class="nw-card-title">${escapeHtml(a.title_ka)}</h2>
          ${dek ? `<p class="nw-card-dek">${escapeHtml(dek)}</p>` : ''}
          <div class="nw-card-meta"><time datetime="${xmlEscapeAttr(a.published_at || '')}">${escapeHtml(dateStr)}</time> · ${readingTime(a.body_ka)} წთ კითხვა</div>
        </div>
      </a>
    </div>`;
}

// PRD 8.3 -- every article after the hero.
function listCardHtml(a) {
  const dateStr = a.published_at ? formatDateKaLong(new Date(a.published_at)) : '';
  const img = a.cover_image_url
    ? `<img class="acl-thumb" src="${transformUrl(a.cover_image_url, 224, 75, 168)}" srcset="${srcset(a.cover_image_url, [[224, 168], [336, 252]], 75)}" sizes="112px" width="112" height="84" alt="${xmlEscapeAttr(a.cover_image_alt_ka || a.title_ka)}" loading="lazy" decoding="async" />`
    : '';
  return `
    <div class="nw-card-wrap">
      <a class="nw-card article-card--list" href="/news/${encodeURIComponent(a.slug)}/">
        ${img}
        <div class="acl-content">
          ${catPillHtml(a)}
          <h2 class="acl-title">${escapeHtml(a.title_ka)}</h2>
          <div class="acl-meta"><time datetime="${xmlEscapeAttr(a.published_at || '')}">${escapeHtml(dateStr)}</time> · ${readingTime(a.body_ka)} წთ კითხვა</div>
        </div>
      </a>
    </div>`;
}

function buildListingGrid(articles) {
  if (!articles.length) return '<div class="nw-empty">სტატია ჯერ არ არის</div>';
  const [hero, ...rest] = articles;
  return heroCardHtml(hero) + rest.map(listCardHtml).join('');
}

// activeSlug: null on /news/ itself, or the category slug on
// /news/category/<slug>/ -- real <a href> links, not buttons, so every
// category is reachable via a crawlable link in the raw HTML (see the
// matching client-side nwRenderChips() in news/index.html).
function buildChipRow(allArticles, activeSlug) {
  const seen = new Map();
  allArticles.forEach((a) => catsOf(a).forEach((c) => { if (!seen.has(c.slug)) seen.set(c.slug, c); }));
  const cats = [...seen.values()];
  if (!cats.length) return '';
  const allChip = `<a class="chip" href="/news/"${activeSlug === null ? ' aria-current="page"' : ''}>ყველა</a>`;
  const catChips = cats.map((c) => `<a class="chip" href="/news/category/${c.slug}/"${activeSlug === c.slug ? ' aria-current="page"' : ''}>${escapeHtml(c.name_ka)}</a>`).join('');
  return allChip + catChips;
}

// Builds one /news/category/<slug>/ page from the same listing
// template, filtered to that category's articles (hero + list, same
// as the main listing), its own chip row (this category marked
// aria-current), and TODO-marked title/description -- real editorial
// copy per category is Giorgi's to write, not invented here.
function buildCategoryPage(listingTemplate, cat, articles, allArticlesForChips) {
  const filtered = articles.filter((a) => catsOf(a).some((c) => c.slug === cat.slug));
  const grid = buildListingGrid(filtered);
  const chips = buildChipRow(allArticlesForChips, cat.slug);

  let html = listingTemplate;
  const replace = (needle, replacement, label) => {
    if (!html.includes(needle)) throw new Error(`category-page anchor not found (template drifted?): ${label}`);
    html = html.replace(needle, replacement);
  };

  // TODO(giorgi): write real per-category title/description copy --
  // this is a placeholder template, not reviewed editorial SEO text.
  const todoTitle = `${cat.name_ka} — სიახლეები | Fight Night Fantasy`;
  const todoDesc = `${cat.name_ka} კატეგორიის სტატიები Fight Night Fantasy-ზე.`;
  const catUrl = `https://fnf.ge/news/category/${cat.slug}/`;

  replace('<title>სიახლეები — Fight Night Fantasy</title>', `<title>${escapeHtml(todoTitle)}</title><!-- TODO(giorgi): placeholder title, write real copy -->`, 'category title');
  replace(
    '<meta name="description" content="Fight Night Fantasy — სიახლეები და განახლებები UFC, Formula 1, NBA და ფეხბურთის ფენტეზის შესახებ." />',
    `<meta name="description" content="${xmlEscapeAttr(todoDesc)}" /><!-- TODO(giorgi): placeholder description, write real copy -->`,
    'category description'
  );
  replace('<link rel="canonical" href="https://fnf.ge/news/" />', `<link rel="canonical" href="${catUrl}" />`, 'category canonical');
  replace('<meta property="og:url" content="https://fnf.ge/news/" />', `<meta property="og:url" content="${catUrl}" />`, 'category og:url');
  replace('<meta property="og:title" content="სიახლეები — Fight Night Fantasy" />', `<meta property="og:title" content="${xmlEscapeAttr(todoTitle)}" />`, 'category og:title');
  replace(
    '<meta property="og:description" content="Fight Night Fantasy — სიახლეები და განახლებები." />',
    `<meta property="og:description" content="${xmlEscapeAttr(todoDesc)}" />`,
    'category og:description'
  );
  // Index-based, not an exact-literal replace() like the six head tags
  // above: listingTemplate is read fresh off disk each run, and by the
  // time this runs the main /news/ page has already had its own chip
  // row and grid baked into that same file on disk for a DIFFERENT
  // category/filter state -- an exact-literal match against "empty" or
  // "whatever the previous run happened to leave" is exactly the
  // fragile thing that broke the first version of this function.
  const chipOpenTag = '<div class="chip-row" id="nwChipRow"';
  const chipOpenIdx = html.indexOf(chipOpenTag);
  if (chipOpenIdx === -1) throw new Error('category-page anchor not found (template drifted?): chip row open tag');
  const chipCloseIdx = html.indexOf('</div>', chipOpenIdx) + '</div>'.length;
  html = html.slice(0, chipOpenIdx) + `<div class="chip-row" id="nwChipRow"${chips ? '' : ' hidden'}>${chips}</div>` + html.slice(chipCloseIdx);

  const gridStart = '<!-- NEWS-GRID:START -->';
  const gridEnd = '<!-- NEWS-GRID:END -->';
  const gridStartIdx = html.indexOf(gridStart);
  const gridEndIdx = html.indexOf(gridEnd);
  if (gridStartIdx === -1 || gridEndIdx === -1) throw new Error('category-page anchor not found (template drifted?): grid markers');
  html = html.slice(0, gridStartIdx) + gridStart + grid + gridEnd + html.slice(gridEndIdx + gridEnd.length);

  return html;
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

  log('Fetching categories...');
  const { data: categories, error: catError } = await sb.from('news_categories').select('*');
  if (catError) { log('Supabase error (categories): ' + catError.message); process.exit(1); }
  log(`Found ${categories.length} categor${categories.length === 1 ? 'y' : 'ies'}.`);

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
      const html = buildArticlePage(templateWithPlaceholder, a, articles);
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

  // Pristine copy (markers/placeholders intact) captured before the
  // main listing below is rewritten in place -- buildCategoryPage()
  // needs the same untouched template for each category page it builds.
  const listingPristine = fs.readFileSync(LISTING_PATH, 'utf8');

  // Inject real <a href> anchors + titles into news/index.html's
  // initial grid, between marker comments, same convention as
  // scripts/sync-news-sitemap.js's NEWS:START/END block. Everything
  // else in the file (nav, styles, client JS) is untouched -- nwRender()
  // still re-draws the same grid on top once Supabase replies, for the
  // KA/EN toggle and live like/comment counts.
  let listing = listingPristine;
  const startMarker = '<!-- NEWS-GRID:START -->';
  const endMarker = '<!-- NEWS-GRID:END -->';
  const chipMarker = '<div class="chip-row" id="nwChipRow" hidden></div>';
  if (!listing.includes(startMarker) || !listing.includes(endMarker)) {
    log('✗ news/index.html has no NEWS-GRID markers -- run the one-time template edit first, skipping listing prerender.');
  } else {
    const chips = buildChipRow(articles, null);
    listing = listing.replace(chipMarker, `<div class="chip-row" id="nwChipRow"${chips ? '' : ' hidden'}>${chips}</div>`);
    const startIdx = listing.indexOf(startMarker);
    const endIdx = listing.indexOf(endMarker);
    const grid = buildListingGrid(articles);
    listing = listing.slice(0, startIdx) + startMarker + grid + endMarker + listing.slice(endIdx + endMarker.length);
    fs.writeFileSync(LISTING_PATH, listing, 'utf8');
    log(`✓ news/index.html grid updated (${articles.length} card(s) baked in)`);
  }

  // One /news/category/<slug>/ page per row in news_categories, even
  // ones with zero articles yet (an empty-state page for a category
  // that exists but hasn't been used is correct, not broken).
  let catOk = 0, catFailed = 0;
  const catSlugs = [];
  for (const cat of categories) {
    try {
      const html = buildCategoryPage(listingPristine, cat, articles, articles);
      const dir = path.join(REPO_ROOT, 'news', 'category', cat.slug);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'index.html'), html, 'utf8');
      log(`✓ news/category/${cat.slug}/index.html`);
      catSlugs.push(cat.slug);
      catOk++;
    } catch (e) {
      log(`✗ category ${cat.slug}: ${e.message}`);
      catFailed++;
    }
  }

  // Sitemap: per-article entries stay scripts/sync-news-sitemap.js's job
  // (run separately) -- this script owns the category block it alone
  // has the data for, inside its own markers so re-runs don't duplicate.
  const sitemapPath = path.join(REPO_ROOT, 'sitemap.xml');
  let sitemap = fs.readFileSync(sitemapPath, 'utf8');
  const catStart = '<!-- NEWS-CAT:START -->';
  const catEnd = '<!-- NEWS-CAT:END -->';
  if (!sitemap.includes(catStart) || !sitemap.includes(catEnd)) {
    log('✗ sitemap.xml has no NEWS-CAT:START/END markers -- add them once, skipping category sitemap entries.');
  } else {
    const today = new Date().toISOString().slice(0, 10);
    const catUrls = catSlugs.map((slug) => [
      '  <url>',
      `    <loc>https://fnf.ge/news/category/${slug}/</loc>`,
      `    <lastmod>${today}</lastmod>`,
      '    <priority>0.4</priority>',
      '  </url>',
    ].join('\n')).join('\n');
    const block = `${catStart}\n${catUrls}\n${catEnd}`;
    const csi = sitemap.indexOf(catStart);
    const cei = sitemap.indexOf(catEnd);
    sitemap = sitemap.slice(0, csi) + block + sitemap.slice(cei + catEnd.length);
    fs.writeFileSync(sitemapPath, sitemap, 'utf8');
    log(`✓ sitemap.xml category block updated (${catSlugs.length} categor${catSlugs.length === 1 ? 'y' : 'ies'})`);
  }

  log(`Done. ${ok} article page(s) written (${failed} failed), ${catOk} category page(s) written (${catFailed} failed).`);
  if (failed > 0 || catFailed > 0) process.exit(1);
}

main().catch((e) => { log('Fatal: ' + e.message); process.exit(1); });
