// ============================================================
//  PRERENDER PAGES — bakes the admin-edited title/body_html from
//  public.site_pages into about/index.html, terms/index.html and
//  privacy/index.html, inside their PAGE-TITLE/PAGE-BODY marker
//  comments (see supabase/site_pages.sql / site_pages_seed.sql and the
//  commit that added those markers to the three pages).
//
//  Why: same reasoning as scripts/prerender-news.js -- these pages
//  have no build step and no per-route SSR (see CLAUDE.md), so a
//  crawler needs the real text already in the raw HTML, not something
//  injected by client-side JS after the fact. This script makes the
//  raw HTML already correct by splicing the DB row's title/body_html
//  into each file's marker-delimited region, same convention as the
//  news system (marker blocks stay in the output so this is safely
//  re-runnable, throw-if-anchor-missing so template drift fails loudly
//  instead of silently writing nothing).
//
//  Read-only against Supabase (anon key, same one already embedded in
//  every frontend file -- no service_role needed; public.site_pages
//  grants anon SELECT, see supabase/site_pages.sql). Writes ONLY to
//  the three files listed in PAGE_FILES below -- nothing else, ever.
//
//  Usage:
//    node scripts/prerender-pages.js
//    SUPABASE_URL=... SUPABASE_ANON_KEY=... node scripts/prerender-pages.js
// ============================================================

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qxfcwsiysnjxhxljqigl.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF4ZmN3c2l5c25qeGh4bGpxaWdsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxODM4MDUsImV4cCI6MjA5Nzc1OTgwNX0.SOeTrxnKulgO8ao8HSwxyKE-m9pvaQ54Pa_IGWWyKDc';

const REPO_ROOT = path.join(__dirname, '..');

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

// The only three files this script will ever touch.
const PAGE_FILES = {
  about: path.join(REPO_ROOT, 'about', 'index.html'),
  terms: path.join(REPO_ROOT, 'terms', 'index.html'),
  privacy: path.join(REPO_ROOT, 'privacy', 'index.html'),
};

// Inline, single-line marker pair (title sits inside the <h1> tag) --
// same shape as prerender-news.js's replaceMarkerBlock() for its
// HREFLANG/OGLOCALEALT markers: the start/end comments stay in the
// output, so this is safely re-runnable.
function replaceMarkerBlock(html, startMarker, endMarker, content, label) {
  const startIdx = html.indexOf(startMarker);
  const endIdx = html.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1) throw new Error(`anchor not found (template drifted?): ${label}`);
  return html.slice(0, startIdx) + startMarker + content + endMarker + html.slice(endIdx + endMarker.length);
}

// Multi-line block marker pair (the body sits on its own lines between
// the markers) -- same shape as prerender-news.js's NEWS-HOME/
// NEWS-SPORT block splicing: markers kept, explicit surrounding
// newlines so the file's existing formatting is preserved exactly.
function replaceMultilineMarkerBlock(html, startMarker, endMarker, content, label) {
  const startIdx = html.indexOf(startMarker);
  const endIdx = html.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1) throw new Error(`anchor not found (template drifted?): ${label}`);
  return html.slice(0, startIdx) + startMarker + '\n' + content + '\n' + endMarker + html.slice(endIdx + endMarker.length);
}

async function main() {
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  log('Fetching site pages...');
  const { data: rows, error } = await sb.from('site_pages').select('slug, title, body_html');
  if (error) { log('Supabase error: ' + error.message); process.exit(1); }
  log(`Found ${(rows || []).length} row(s).`);

  const bySlug = {};
  (rows || []).forEach((r) => { bySlug[r.slug] = r; });

  let ok = 0, failed = 0;
  for (const slug of Object.keys(PAGE_FILES)) {
    const filePath = PAGE_FILES[slug];
    try {
      const row = bySlug[slug];
      if (!row) throw new Error(`no row in public.site_pages for slug "${slug}"`);

      let html = fs.readFileSync(filePath, 'utf8');
      html = replaceMarkerBlock(
        html, '<!-- PAGE-TITLE:START -->', '<!-- PAGE-TITLE:END -->',
        row.title, `${slug} title`
      );
      html = replaceMultilineMarkerBlock(
        html, '<!-- PAGE-BODY:START -->', '<!-- PAGE-BODY:END -->',
        row.body_html, `${slug} body`
      );
      fs.writeFileSync(filePath, html, 'utf8');
      log(`✓ ${slug}/index.html updated`);
      ok++;
    } catch (e) {
      log(`✗ ${slug}: ${e.message}`);
      failed++;
    }
  }

  log(`Done. ${ok} page(s) written, ${failed} failed/skipped.`);
  if (failed > 0 && ok === 0) process.exit(1);
}

main().catch((e) => { log('Fatal: ' + e.message); process.exit(1); });
