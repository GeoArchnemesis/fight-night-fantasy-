// ============================================================
//  GENERATE SITEMAP — regenerates the whole of sitemap.xml from scratch
//  on every run. This is the single script that owns sitemap.xml; it
//  replaces the old two-script hybrid (scripts/sync-news-sitemap.js's
//  hand-edited static entries + NEWS:START/END block, and
//  scripts/prerender-news.js's NEWS-EN:START/END block).
//
//  Three sources, assembled in this order:
//    1. STATIC_PAGES below -- a hardcoded list of the real public pages.
//       lastmod for each comes from that file's own last commit date
//       (`git log -1 --format=%cI`), never a hand-typed date -- falls
//       back to the file's mtime (with a warning) if git has no history
//       for it (e.g. a shallow clone).
//    2. Georgian news articles -- one Supabase query against
//       news_feed_view, filtered to is_published=true and kind='article'
//       (videos have no slug/page and are excluded, same as
//       scripts/prerender-news.js's `articles` filter). Emits
//       /news/<slug>/.
//    3. English news mirrors -- the same article rows, filtered to
//       articles with both title_en and body_en present (hasEn(), same
//       rule scripts/prerender-news.js already uses for which articles
//       get a real /en/news/<slug>/ page). Emits /en/news/ plus
//       /en/news/<slug>/ for each one.
//
//  Safety check: before writing, this scans every git-tracked .html file
//  in the repo and warns (does not fail) about any that are in neither
//  STATIC_PAGES nor EXCLUDED_* nor match the dynamic /news/<slug>/ or
//  /en/news/<slug>/ pattern -- a nudge that a new page was added and
//  forgotten here, not a hard gate.
//
//  Auth note: this reads with the anon key (same one already embedded in
//  every frontend file on this site), not service_role. news_feed_view
//  has `where is_published = true` baked into its own definition
//  (supabase/news_feed_view.sql) and is granted to anon, so the anon key
//  already sees exactly the published rows this script needs -- nothing
//  here ever needs to see an unpublished draft, so service_role was never
//  actually required (the older scripts/sync-news-sitemap.js's header
//  claiming otherwise was wrong).
//
//  Usage:
//    node scripts/generate-sitemap.js
//    SUPABASE_URL=... SUPABASE_ANON_KEY=... node scripts/generate-sitemap.js
// ============================================================

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qxfcwsiysnjxhxljqigl.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF4ZmN3c2l5c25qeGh4bGpxaWdsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxODM4MDUsImV4cCI6MjA5Nzc1OTgwNX0.SOeTrxnKulgO8ao8HSwxyKE-m9pvaQ54Pa_IGWWyKDc';

const REPO_ROOT = path.join(__dirname, '..');
const SITEMAP_PATH = path.join(REPO_ROOT, 'sitemap.xml');

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Real public pages. [loc, repo-relative file path (for git lastmod), priority]
// Order matches the hand-maintained sitemap.xml this replaces, so a diff
// against the old file shows only lastmod changes, not reordering.
const STATIC_PAGES = [
  ['https://fnf.ge/', 'index.html', '1.0'],
  ['https://fnf.ge/ufc/', 'ufc/index.html', '0.9'],
  ['https://fnf.ge/quiz/', 'quiz/index.html', '0.9'],
  ['https://fnf.ge/quiz/ufcquiz/', 'quiz/ufcquiz/index.html', '0.9'],
  ['https://fnf.ge/quiz/footballquiz/', 'quiz/footballquiz/index.html', '0.9'],
  ['https://fnf.ge/f1/', 'f1/index.html', '0.9'],
  ['https://fnf.ge/nba/', 'nba/index.html', '0.9'],
  ['https://fnf.ge/football/laliga/', 'football/laliga/index.html', '0.9'],
  ['https://fnf.ge/football/epl/', 'football/epl/index.html', '0.9'],
  ['https://fnf.ge/football/seriea/', 'football/seriea/index.html', '0.9'],
  ['https://fnf.ge/football/bundesliga/', 'football/bundesliga/index.html', '0.9'],
  ['https://fnf.ge/football/ligue1/', 'football/ligue1/index.html', '0.9'],
  ['https://fnf.ge/football/ucl/', 'football/ucl/index.html', '0.9'],
  ['https://fnf.ge/about/', 'about/index.html', '0.6'],
  ['https://fnf.ge/rules/', 'rules/index.html', '0.6'],
  ['https://fnf.ge/news/', 'news/index.html', '0.6'],
  ['https://fnf.ge/terms/', 'terms/index.html', '0.6'],
  ['https://fnf.ge/privacy/', 'privacy/index.html', '0.6'],
];

// Pages that must never be indexed. Prefixes match any file under that
// directory; exact entries match a single file.
//   profile/    -- login-gated utility page, no unique static content, noindex'd
//                  (see profile/index.html).
//   ufc/quiz/   -- old quiz URL, kept only as a JS redirect stub to /quiz/,
//                  noindex'd itself so it never outranks /quiz/.
//   EPJQI8FX/   -- the admin editor, never meant to be public/indexed.
const EXCLUDED_PREFIXES = ['profile/', 'ufc/quiz/', 'EPJQI8FX/'];
const EXCLUDED_FILES = [
  'news/post.html',
  '404.html',
  // Build template scripts/build-quiz-pages.js reads from, not a route of
  // its own -- the only file under scripts/templates/.
  'scripts/templates/quiz-page.template.html',
];

function isExcluded(relPath) {
  return EXCLUDED_FILES.includes(relPath) || EXCLUDED_PREFIXES.some((p) => relPath.startsWith(p));
}

// /news/<slug>/index.html or /en/news/<slug>/index.html -- the per-article
// pages scripts/prerender-news.js bakes, one subdirectory per published
// article. The listing pages themselves (news/index.html, en/news/index.html)
// are handled as STATIC_PAGES / the EN block below, not matched here.
function isDynamicNewsArticle(relPath) {
  return /^(en\/)?news\/[^/]+\/index\.html$/.test(relPath)
    && relPath !== 'news/index.html' && relPath !== 'en/news/index.html';
}

function runSafetyCheck() {
  const tracked = execSync('git ls-files "*.html"', { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean);
  const staticRelPaths = new Set(STATIC_PAGES.map(([, p]) => p));
  const unaccounted = tracked.filter((p) =>
    !staticRelPaths.has(p) && !isExcluded(p) && !isDynamicNewsArticle(p) && p !== 'en/news/index.html'
  );
  if (unaccounted.length) {
    log(`⚠ ${unaccounted.length} HTML page(s) are in neither the include list nor the exclusion list -- review and add them to one or the other:`);
    unaccounted.forEach((p) => log(`    - ${p}`));
  } else {
    log('✓ safety check: every tracked HTML page is accounted for.');
  }
}

function gitLastmod(relPath) {
  try {
    const out = execSync(`git log -1 --format=%cI -- "${relPath}"`, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
    if (out) return out.slice(0, 10);
  } catch (e) { /* fall through to mtime */ }
  try {
    const stat = fs.statSync(path.join(REPO_ROOT, relPath));
    log(`⚠ no git history for ${relPath} -- falling back to file mtime for lastmod`);
    return stat.mtime.toISOString().slice(0, 10);
  } catch (e) {
    log(`⚠ could not read ${relPath} to determine lastmod -- omitting <lastmod>`);
    return '';
  }
}

function urlBlock(loc, lastmod, priority) {
  return [
    '  <url>',
    `    <loc>${xmlEscape(loc)}</loc>`,
    lastmod ? `    <lastmod>${lastmod}</lastmod>` : null,
    `    <priority>${priority}</priority>`,
    '  </url>',
  ].filter(Boolean).join('\n');
}

// Same eligibility rule as scripts/prerender-news.js's hasEn(): both the
// headline and the body must be non-empty, or the EN page is never baked
// and must not be linked from the sitemap either.
function hasEn(a) {
  return !!(a.title_en && a.title_en.trim() && a.body_en && a.body_en.trim());
}

function articleLastmod(a) {
  return (a.published_at || a.created_at || '').slice(0, 10);
}

async function main() {
  runSafetyCheck();

  const staticUrls = STATIC_PAGES.map(([loc, relPath, priority]) => urlBlock(loc, gitLastmod(relPath), priority));

  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  log('Fetching published articles (news_feed_view)...');
  const { data: feedItems, error } = await sb
    .from('news_feed_view')
    .select('kind,slug,published_at,created_at,title_en,body_en')
    .eq('is_published', true)
    .order('published_at', { ascending: false });
  if (error) { log('✗ Supabase error: ' + error.message); process.exit(1); }

  // Videos have no slug/page of their own (Task 4, phase 3) -- excluded
  // here exactly as scripts/prerender-news.js excludes them from its own
  // `articles` list.
  const articles = feedItems.filter((i) => i.kind === 'article');
  const enArticles = articles.filter(hasEn);
  log(`Found ${articles.length} published article(s), ${enArticles.length} with an English version.`);

  const kaNewsUrls = articles.map((a) => urlBlock(`https://fnf.ge/news/${a.slug}/`, articleLastmod(a), '0.5'));

  const enListingLastmod = enArticles.map(articleLastmod).filter(Boolean).sort().pop() || '';
  const enNewsUrls = [
    urlBlock('https://fnf.ge/en/news/', enListingLastmod, '0.6'),
    ...enArticles.map((a) => urlBlock(`https://fnf.ge/en/news/${a.slug}/`, articleLastmod(a), '0.5')),
  ];

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...staticUrls,
    ...kaNewsUrls,
    ...enNewsUrls,
    '</urlset>',
    '',
  ].join('\n');

  fs.writeFileSync(SITEMAP_PATH, xml, 'utf8');
  log(`✓ sitemap.xml regenerated (${staticUrls.length} static, ${kaNewsUrls.length} KA news, ${enNewsUrls.length} EN news URL(s))`);
}

main().catch((e) => { log('Fatal: ' + e.message); process.exit(1); });
