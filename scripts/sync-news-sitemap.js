// ============================================================
//  SYNC NEWS SITEMAP — maintains the auto-generated block in
//  sitemap.xml for published news articles.
//
//  There is no build step in this repo (see CLAUDE.md), so nothing
//  regenerates sitemap.xml automatically when an article is
//  published/unpublished through admin/news.html -- that editor only
//  talks to Supabase from the browser, it has no access to this
//  repo's files. Run this script manually (or wire it into a GitHub
//  Action later, same as the other scripts/*.js automation) whenever
//  the set of published articles changes.
//
//  URLs point at /news/post.html?slug=<slug> -- the real, working URL
//  today (Phase D3 decision: no build step + no per-route SSR yet
//  means true /news/<slug>/ paths don't resolve to anything). Once
//  Phase C4's real SSR exists and DNS is cut over, update the URL
//  template below to the clean path -- nothing else about this
//  script needs to change.
//
//  Usage:
//    SUPABASE_URL=... SUPABASE_KEY=<service_role> node scripts/sync-news-sitemap.js
//    DRY_RUN=1 ... node scripts/sync-news-sitemap.js   -- logs without writing sitemap.xml
// ============================================================

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY; // service_role (bypasses RLS to see everything, filtered by is_published below)
const DRY_RUN = process.env.DRY_RUN === '1';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('SUPABASE_URL / SUPABASE_KEY აუცილებელია');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const SITEMAP_PATH = path.join(__dirname, '..', 'sitemap.xml');
const START_MARKER = '<!-- NEWS:START -->';
const END_MARKER = '<!-- NEWS:END -->';

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildNewsBlock(articles) {
  const urls = articles.map((a) => {
    const lastmod = (a.published_at || a.created_at || '').slice(0, 10);
    return [
      '  <url>',
      `    <loc>https://fnf.ge/news/post.html?slug=${xmlEscape(a.slug)}</loc>`,
      lastmod ? `    <lastmod>${lastmod}</lastmod>` : null,
      '    <priority>0.5</priority>',
      '  </url>',
    ].filter(Boolean).join('\n');
  });
  return `${START_MARKER}\n${urls.join('\n')}\n${END_MARKER}`;
}

async function main() {
  log('მოთხოვნა: გამოქვეყნებული სტატიები...');
  const { data: articles, error } = await sb
    .from('news')
    .select('slug,published_at,created_at')
    .eq('is_published', true)
    .order('published_at', { ascending: false });

  if (error) { log('❌ Supabase შეცდომა: ' + error.message); process.exit(1); }

  log(`✅ ${articles.length} გამოქვეყნებული სტატია ნაპოვნია`);

  const sitemap = fs.readFileSync(SITEMAP_PATH, 'utf8');
  const startIdx = sitemap.indexOf(START_MARKER);
  const endIdx = sitemap.indexOf(END_MARKER);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    log('❌ NEWS:START/NEWS:END მარკერები ვერ მოიძებნა sitemap.xml-ში -- იხილეთ ეს ფაილი ხელით.');
    process.exit(1);
  }

  const newBlock = buildNewsBlock(articles);
  const updated = sitemap.slice(0, startIdx) + newBlock + sitemap.slice(endIdx + END_MARKER.length);

  if (DRY_RUN) {
    log('DRY_RUN -- sitemap.xml არ შეიცვლება. ახალი ბლოკი:');
    console.log(newBlock);
    return;
  }

  fs.writeFileSync(SITEMAP_PATH, updated, 'utf8');
  log('✅ sitemap.xml განახლდა');
}

main().catch((e) => { log('❌ ' + e.message); process.exit(1); });
