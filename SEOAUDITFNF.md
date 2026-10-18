# SEO Audit — Fight Night Fantasy (fnf.ge)

**Scope:** LOCAL FILES ONLY. The live production site at `https://fnf.ge` was never contacted — the production deployment currently reflects `main` (pre-quiz-feature), while this audit covers the uncommitted/local `feature/ufc-quiz` branch at `/Users/admin/Desktop/fight-night-fantasy--main`, served to the audit tooling at `http://localhost:8000/` purely so rendering tools (Lighthouse, Playwright) had something to load.

**Date:** 2026-10-16
**Branch audited:** `feature/ufc-quiz` (12 local commits ahead of `main`, nothing pushed)
**Pages audited (12):** `/` (hub), `/ufc/`, `/ufc/quiz/` (new, in-development), `/f1/`, `/nba/`, `/football/{laliga,epl,seriea,bundesliga,ligue1,ucl}/` (6 leagues), `/profile/`
**Excluded:** `/admin/` (internal tool, already disallowed in `robots.txt`)

**Method:** 9 specialist passes (technical, content, schema, sitemap, performance, visual, GEO/AI-search, agent-readiness, search-experience/intent) — all reading local source files directly and/or hitting `http://localhost:8000/*` only.

**Important disclosure:** two of the nine passes necessarily made real network requests as an unavoidable side effect of *rendering* the actual page code, even though the target was `localhost`:
- The **performance** pass ran real Lighthouse against `localhost`, and the pages themselves hardcode references to live third-party hosts (Google Tag Manager, Google Fonts, the jsDelivr-hosted Supabase SDK, the live Supabase project `qxfcwsiysnjxhxljqigl.supabase.co` for read-only RPCs/images, ESPN's CDN for fighter headshots). Loading the real page in headless Chrome triggered real, **read-only** GET/RPC requests to those hosts. `fnf.ge` itself was never contacted, and nothing was written anywhere.
- The **visual** pass used a custom Playwright script (the skill's own screenshot tool refuses `localhost` by design) against the same local pages, same caveat applies for whatever third-party assets those pages load (images, fonts).

No page content, questions/answers, credentials, or write operations were affected. If you want zero third-party contact at all in a future pass, the pages would need to be audited with those scripts stripped/mocked first — flagging this as a known tradeoff rather than hiding it.

---

## Executive Summary

### SEO Health Score: **43 / 100** — Needs Work

| Category | Weight | Score | Contribution |
|---|---|---|---|
| Technical SEO | 22% | 75 | 16.5 |
| Content Quality | 23% | 30 | 6.9 |
| On-Page SEO | 20% | 40 | 8.0 |
| Schema / Structured Data | 10% | 15 | 1.5 |
| Performance (lab CWV) | 10% | 45 | 4.5 |
| AI Search Readiness | 10% | 37 | 3.7 |
| Images | 5% | 45 | 2.25 |

The site's **technical bones are solid** (clean sitemap, correct canonicals, no broken internal links, correct `robots.txt`) — the score is dragged down almost entirely by **content and on-page gaps**, most of which converged independently across 4 of the 9 specialist passes (content, sitemap/technical, GEO, and search-experience), which is a strong signal they're real rather than one agent's opinion.

### Top 5 Critical/cross-cutting issues (found independently by multiple passes)

1. **The six football league pages are 99.6–99.8% identical** in visible body text — same template, no league name anywhere in the body, UFC-branded footer/nav copy left on all of them. Flagged independently by Content, GEO, and Search-Experience passes as a near-duplicate-content risk.
2. **The homepage has ~13 words of visible text.** Nine sport cards are background-image links with empty captions. The single most important URL on the site has almost nothing for a crawler, an AI answer engine, or a human to read.
3. **All live product data (odds, fixtures, countdowns, leaderboards) is 100% client-rendered via Supabase** — invisible to any crawler/AI agent that doesn't execute JavaScript (most non-Google AI search crawlers don't). Flagged by Technical, GEO, and Agentic passes.
4. **No structured data anywhere** (zero `application/ld+json` blocks across all 12 pages) — no Organization/WebSite entity, no breadcrumbs, nothing for an answer engine to cite with confidence.
5. **Gambling-vocabulary ambiguity on a real-money-prize, free-to-play product.** The site uses sportsbook language (ფსონი/odds, ექსპრესი/accumulator, ქეშაუთი/cash-out, "💸 ფულადი პრიზები" headlined prominently) with no visible "no deposit / free to play" statement, no terms, no age notice — while collecting phone number, birth year, gender, and (per the commented-out profile section) an ID selfie for verification. This reads as a trust/compliance risk independent of SEO, flagged by both Content and Search-Experience passes as their top finding.

### Top 5 quick wins (low effort, real impact)

1. Add 2–3 sentences of real copy + visible card captions to the homepage.
2. Add `/ufc/quiz/` to `sitemap.xml` once the feature is stable (currently correctly omitted — see Known Open Items).
3. Fix the two different phone numbers appearing across the site (`557 077 665` vs `557 007 665`).
4. Add `defer` to the Supabase SDK `<script>` tag and switch Google Fonts to the async-load pattern — pure `<head>`-markup changes, zero risk to betting/settlement logic, recovers ~2–3s of render-blocking time per Lighthouse.
5. Add `width`/`height` (or `aspect-ratio`) to the UFC leaderboard banner image — single fix for a 0.684 (Poor) CLS score on `/ufc/`.

---

## 1. Technical SEO

**No Critical issues.** Canonicals, `robots.txt`, and internal links are all clean.

**High**
- **`ufc/quiz/` is fully indexable-tagged (canonical, OG/Twitter, no noindex) but absent from `sitemap.xml`** — and on this branch, `ufc/index.html` already links to it in three places (promo CTA, bottom mobile nav, JS-injected nav link). Once this branch merges, Googlebot will discover `/ufc/quiz/` via internal links regardless of sitemap status. **Resolve as part of the merge, not after.**
- **`profile/index.html` is in the sitemap but has zero unique static content** (guest-only "not logged in" prompt) and, unlike all 11 other pages, has **no meta description and no OG/Twitter tags at all.** Recommend `noindex` + sitemap removal rather than filling in metadata for a login-walled utility page.

**Medium**
- All sport/league pages are 100% client-rendered (see Executive Summary #3) — no static fallback if the Supabase fetch is slow/fails during a crawl.
- An **untracked prototype file `ufc-epic-quiz.html`** sits at the repo root (confirmed via `git status`) with no canonical/robots meta. If ever accidentally committed, GitHub Pages would serve it live as a crawlable, duplicate-looking page. **Delete it or add to `.gitignore` before any broad `git add`.**
- Non-HTML repo paths (`/scripts/`, `/supabase/`) are publicly servable by GitHub Pages and not disallowed in `robots.txt`. Nothing links to them and no secrets were found in them, so this is low-severity — add `Disallow: /scripts/` and `Disallow: /supabase/` for defense-in-depth.

**Low (passes, noted for completeness)**
- `f1/index.html`'s `<title>`/`og:title` mismatch is confirmed still present (already a known tracked issue).
- No `hreflang` present — correct, since the site is single-locale Georgian.
- `robots.txt`, `sitemap.xml`, and every internal link checked across all 12 pages are internally consistent with no broken references.

---

## 2. Content Quality

**Overall content score: 30/100 · E-E-A-T: 21/100 · AI citation readiness: 25/100**

**Critical**
- **Football pages near-duplicate** (99.55–99.77% identical visible text) — see Executive Summary #1.
- **No responsible-gambling, age-restriction, terms, or privacy content** on a product that pays cash prizes and collects phone/birth-year/gender/gender data — see Executive Summary #5. This is the single biggest E-E-A-T (Trust) deficit found.
- **Football pages literally tell visitors they're on a UFC/MMA product**: the shared footer says "the first Georgian UFC Fantasy, test your MMA intuition," and the nav item reads "ბრძოლები" (Fights) on a football page. Factually wrong on-page copy.

**High**
- Homepage is 13 words total (see Executive Summary #2).
- Football meta descriptions are hand-templated (league name swapped into one identical sentence structure) — title, description, and body are all near-identical across the six pages.
- **Two different contact phone numbers** appear across the site: `557 077 665` vs `557 007 665` — inconsistent on `ufc/`, `f1/`, `nba/`, `profile/`, every football page, and `ufc/quiz/`.
- Prize rules are vague and inconsistent: UFC/football state a 100 GEL monthly pool; F1/NBA give no amount. No page explains how the pool is split, how many winners there are, or how payment works.
- The UFC quiz page is thin (224 words, almost all UI labels) with no explanation of modes, scoring, or the login requirement — and its own promotional teaser on `/ufc/` promises something ("free vs AI") the quiz page doesn't fully match (it also requires login and has a PvP mode the teaser never mentions).

**Medium**
- No `<h1>` on `/ufc/`, `/f1/`, `/nba/`, or any football page.
- Repeated grammar errors in shared copy (e.g., "რადგან მიიღო" should be "რომ მიიღო"; missing verbs/periods in rule text) — same error ships to all mirrored pages since they share templates.
- Mixed English jargon/transliterations ("Leaderboard", "UPCOMING EVENT", "იუზერი") alongside Georgian labels for the same concepts elsewhere on the same page.
- Cash-out/cutoff rules differ by sport with no comparison table explaining why.
- The "საიტი მუშაობს სატესტო რეჟიმში" (test mode) banner on every page undercuts trust, especially right where the site asks for ID verification.

**Low**
- Brand-suffix duplication in meta descriptions; inconsistent title ordering (some pages "Sport — Fight Night Fantasy", others reversed).
- No freshness/authorship signals anywhere (no "last updated" dates visible; all `sitemap.xml` `lastmod` values are a stale, identical `2026-09-09` despite real edits on Oct 1 and Oct 15).
- Real first-party trust data exists (past winners, settled events) but is never published statically — a "previous winners" page would be a strong, cheap Experience/Trust signal.

---

## 3. On-Page SEO

(Synthesized from the technical, content, schema, and GEO passes' overlapping on-page findings.)

- **No `<h1>` on 8 of 12 pages** (`/ufc/`, `/f1/`, `/nba/`, all 6 football pages) — only the hub, quiz, and profile pages have one.
- **Title/`og:title` inconsistency**: `f1/index.html`'s title and `og:title` don't match; `/nba/` leads with the sport name in English ("NBA Fantasy — Fight Night Fantasy") while most other pages lead with the brand in Georgian — no single consistent pattern across the site.
- Heading hierarchy on sport pages is dominated by **modal titles** (7 of each page's 11–14 headings are auth/password/profile modal headers, not content structure).
- Internal linking is otherwise healthy — every checked `href` resolves to a real page, no orphaned/broken links found.
- The hub's 9 sport-picker cards have **no visible text labels at all** — names exist only in `aria-label`, invisible to both text-only crawlers and sighted users skimming quickly.

---

## 4. Schema & Structured Data

**No structured data exists anywhere on the site** — confirmed by grep for `ld+json`/`itemscope`/`itemtype` across every HTML file and every JS renderer (zero matches). Nothing is currently broken; everything below is a missing opportunity, not a fix.

**High-value additions recommended:**
- **`Organization` + `WebSite` schema on the homepage** — the natural anchor for the brand entity. *Caution: only use the real brand Facebook page (`facebook.com/FNF.GE`) as `sameAs` — the footer's Facebook/LinkedIn icons currently point to what appear to be the developer's personal profiles, not brand pages. Using those would misattribute a personal account to the business entity.*
- **`BreadcrumbList`** for the six `football/<league>/` pages and `ufc/quiz/` — note there's no `/football/` index page, so a 3-level breadcrumb would cite a URL that 404s; use 2 levels for football pages.
- **`SportsEvent`** is viable for UFC/F1/NBA/football fixtures, but the data is 100% client-rendered — this must be generated dynamically by `app.js`/`f1-app.js`/`nba-app.js`/`football-app.js` at the point they already render the fixture, not hand-written as static JSON-LD (it would go stale immediately otherwise).

**Explicitly do NOT add** (to avoid misrepresenting the product):
- **`Product`/`Offer`/`AggregateRating`** anywhere — this is a free points-based game with a monthly cash-prize payout, not a priced/purchasable wagering product. Adding `Offer` schema would misrepresent it as a priced betting product.
- **`FAQPage`** on the existing "წესები" (rules) sections — they're numbered statements, not genuine question/answer pairs, and `FAQPage` rich results are retired for all sites as of May 2026 regardless.
- **`Game`/`VideoGame`/`SoftwareApplication`** on the quiz page — no Google rich-result support for this content shape, and `SoftwareApplication` expects metadata (OS, category) that doesn't apply to a browser trivia quiz. `BreadcrumbList` is the one concrete, accurate addition for this page.

---

## 5. Performance (Lab-Only — Real CWV Field Data Requires the Live Site)

Real Lighthouse 13 was run against all 4 sampled pages (hub, `/ufc/`, `/ufc/quiz/`, `/football/epl/`) via `localhost`. **CrUX field data is impossible to obtain for localhost and was not attempted.** See the disclosure at the top of this document regarding real third-party network calls made as a side effect of rendering.

| Page | Perf score | LCP (lab) | CLS | TBT |
|---|---|---|---|---|
| `/` (hub) | 71 | 11.6s* | 0 (Pass) | 240ms |
| `/ufc/` | 32 | 11.8s* | **0.684 (Poor)** | 360ms |
| `/ufc/quiz/` | 54 | 10.8s* | 0 (Pass) | 420ms |
| `/football/epl/` | 56 | 12.6s* | 0 (Pass) | 350ms |

*LCP seconds are inflated by Lighthouse's simulated-throttling amplifying real latency to the live third-party hosts these pages reference (Supabase, Google Fonts, jsDelivr, ESPN) — **treat the absolute seconds as a lab artifact; the relative findings below are solid and reproducible.**

**Critical**
- **Supabase JS SDK loaded as a render-blocking, non-deferred `<script>` in `<head>`** on every app page, before `style.css` even loads. Lighthouse estimates **1.4–1.8 seconds of wasted time per page** from this alone. Fix: add `defer` (the actual `supabase.createClient()` calls already happen in scripts loaded later, at the end of `<body>`) — zero risk to app logic.
- **CLS of 0.684 ("Poor") on `/ufc/`** — nearly 7x the "Good" threshold. Root cause: an unsized `<img>` in the leaderboard banner (`.lb-banner img`) with no `width`/`height`/`aspect-ratio`, so the page jumps when it loads. Single highest-leverage visual-stability fix on the site.

**High**
- Google Fonts loaded as a blocking `<link>` (916–1,230ms wasted) — switch to the standard preload+async-swap pattern.
- Missing `preconnect` for `cdn.jsdelivr.net` despite it hosting a render-blocking script.
- `style.css` itself is queued behind the two issues above and shows 1,051–1,351ms of wasted time purely from ordering — reorder `<head>` so the same-origin stylesheet loads first.
- `/ufc/` has the heaviest page weight (4.8MB, 3.9MB of it ESPN fighter-headshot images outside this codebase's direct control) — consider a resized/modern-format proxy for below-the-fold headshots.

**Medium**
- A Facebook Pixel is injected by Google Tag Manager on every page (including the quiz, which has no conversion event) — a GTM configuration question, not a code fix.
- `/ufc/` DOM size (1,510 elements) is at the commonly-cited "excessive DOM" guideline.
- The UFC page's real LCP image (a fighter headshot) already does the right things (explicit dimensions, `fetchpriority="high"`) but is delayed ~2s behind the head-blocking resources above — fixing those should pull this down proportionally.

**Low:** minor unminified CSS/JS savings (not worth a build-step change given this is an intentionally no-build-step static site); static PNG assets (logo, OG image) could become WebP, but none of them are the LCP element on any page tested.

**Fix priority (items 1–4 are pure `<head>`-markup changes with zero touch to betting/settlement logic):** defer Supabase SDK → async-load Google Fonts → reorder `<head>` → add jsDelivr preconnect → fix the leaderboard banner image sizing.

---

## 6. Images

- Hub's 9 sport cards are CSS background-images with **no `<img>` tag and no visible caption** — nothing for an image-aware crawler or a screen reader to describe.
- The UFC leaderboard banner image has no `width`/`height`, causing the CLS issue above (§5).
- ESPN-hosted fighter headshots make up the bulk of `/ufc/`'s page weight (3.78MB) — outside this codebase's direct control, but worth exploring a resized/cached proxy for non-LCP headshots.
- Static brand assets (`logo.png`, `og-image.png`) are PNG; low-priority WebP conversion candidates since neither is ever the LCP element.
- No broken image references or missing `alt` text found on the images that *do* exist in the markup (the gap is images that don't exist where they should — the hub cards).

---

## 7. AI Search Readiness (GEO) — Score: 37/100

| Dimension | Score | Note |
|---|---|---|
| Citability | 35 | Rules exist in static HTML but as numbered fragments, not standalone quotable prose |
| Structural readability | 45 | No H1 on sport pages, no question-style headings, no FAQ |
| Multi-modal | 30 | Hub cards are CSS images with only `aria-label`s; no video |
| Authority & brand | 30 | No Organization/WebSite schema, no `og:site_name`, no about page, no named operator |
| Technical accessibility | 50 | Static HTML with permissive `robots.txt`, but all live data is JS-rendered and there's no `llms.txt`/JSON-LD |

**Critical**
- All product data (odds, fixtures, leaderboards) is invisible to non-JS-executing AI crawlers (OAI-SearchBot, PerplexityBot, Claude-SearchBot largely don't render JS) — see Executive Summary #3.
- Homepage has ~13 crawlable words (see Executive Summary #2).

**High**
- **No `llms.txt`** anywhere (confirmed 404 locally).
- **No structured data** — no entity for an answer engine to attribute a citation to, no `og:site_name` anywhere.
- Rules are numbered fragments, never phrased as the questions people actually ask an AI assistant ("is it free?", "how do I get a prize?") — no FAQ exists to answer them directly.
- Rules/copy actively differ (and in football's case, are factually wrong) between sports — an AI pulling from one page may quote rules that don't apply elsewhere.

**Medium:** inconsistent brand naming across titles/`og:title`s; no H1 on sport pages (same finding as §3); weak trust/authority signals for a cash-prize product (no about/terms/operator identity, two conflicting phone numbers); content is Georgian-only (expected for this audience, but means zero visibility for English-language queries about the product).

**Low:** `robots.txt` makes no explicit AI-bot policy choice (currently a blanket wildcard allow, which already permits every AI search/training crawler — fine if intentional, worth being a deliberate decision rather than a default); `/profile/` indexable with no real content.

**Estimated platform scores:** Google AI Overviews 35, ChatGPT Search 30, Perplexity 30, Bing Copilot 35 — all capped primarily by thin/duplicate content and the JS-rendering gap, not by crawl access (nothing is blocked).

### Agent-readiness (accessibility tree / Lighthouse "Agentic Browsing" proxy)
- **Critical:** same JS-rendering gap as above — an agent that doesn't execute JS sees empty pick/odds/leaderboard containers on every sport page.
- **High:** the mobile sport-switcher (`#mnavSport`, `role="button"`) has **no keyboard handler** in any of the 4 shared sport scripts — not operable via Enter/Space. Notably, `ufc/quiz.js` already implements the correct pattern elsewhere in this same codebase; it just wasn't reused for the older shared scripts.
- **Medium:** no `<h1>` on 9 sport pages (consistent with §3); ambiguous round/method pick-chip accessible names (bare numbers/odds with no `aria-label` tying them to their group heading).
- **Low (expected, not defects):** no `llms.txt`/`ai-catalog.json`/`.well-known` discovery files, no Markdown delivery, no WebMCP — all reasonable for this site's current scope; a password-visibility toggle button never updates its accessible name/state after use.

---

## 8. Search Experience (SXO) — bonus category, not in the standard weighting

This pass couldn't check real SERPs (network constraint), so treat its intent inferences as hypotheses to verify, not certainties — but its conclusions converge strongly with the Content and GEO passes run independently.

**Critical**
- Football pages are interchangeable from a searcher's perspective (same finding as §1/§2, confirmed a third time from a pure intent-match angle).
- **Gambling-perception ambiguity** (same as Executive Summary #5) — flagged here as the top *search-experience* risk specifically because a visitor landing from a "free fantasy game" search query would see sportsbook UI/vocabulary with no reassurance, and a visitor actually looking for real-money betting would see "free points" language mixed in — **neither intent is cleanly served.**

**High:** no H1/value-proposition hero on any sport page (empty countdown-only hero when there's no upcoming event is a dead end for a new visitor); hub explains nothing (same as §2); `/ufc/quiz/` isn't discoverable from search (missing from sitemap and from the hub) despite "UFC ქვიზი" likely being a low-competition, winnable query in Georgian.

**Medium:** the quiz page doesn't explain itself above the fold, and the login wall only appears after 3 clicks into the flow — likely to cause drop-off; F1/NBA title/OG inconsistency plus stale NBA preseason copy; football rules use "event" wording that contradicts the real per-round reset mechanic; no trust/legal surface anywhere despite collecting an ID selfie for verification.

**Persona scores (out of 100, weakest first):** cautious/compliance-minded visitor 33, league-specific football fan 42, hub newcomer 43, fresh quiz searcher 51, F1/NBA casual fan 53, returning UFC player 76 (already well-served).

---

## Prioritized Action Plan

### Phase 1 — Critical (fix before any public SEO push)
1. Differentiate the 6 football league pages: unique H1/hero/intro per league, fix the UFC-branded footer/nav copy, unique meta descriptions.
2. Add a real intro + visible card captions to the homepage.
3. Add a clear, prominent "free to play, no deposit, points have no cash value" statement site-wide, plus an age notice and a terms/privacy/responsible-play page — treat this as a trust/compliance item, not just an SEO one.
4. Add `width`/`height`/`aspect-ratio` to the UFC leaderboard banner image (CLS fix).
5. Defer the Supabase SDK script tag across all app pages.

### Phase 2 — High-impact (within 1–2 weeks)
6. Resolve the sitemap situation for `/ufc/quiz/` as part of merging the feature (add to sitemap + remove any temporary debug UI, or add `noindex` until it's fully stable — don't ship it in indexed-but-unfinished limbo).
7. Add `Organization`+`WebSite` JSON-LD to the homepage (using the real brand Facebook page only).
8. Add H1s to all 8 pages currently missing one.
9. Fix the two conflicting phone numbers.
10. Async-load Google Fonts; reorder `<head>` so `style.css` isn't queued behind third parties; add `preconnect` for `cdn.jsdelivr.net`.
11. Add `llms.txt`.
12. Reconcile prize/reset/cash-out rules into one consistent, accurate policy per sport.

### Phase 3 — Content & Authority (within 1 month)
13. Add `BreadcrumbList` schema for football pages and the quiz.
14. Add a short FAQ (question-phrased headings) per sport, covering the things people actually ask an AI assistant.
15. Add an About/operator page and a "past winners" archive for trust signals.
16. Generate `SportsEvent` JSON-LD dynamically from the already-fetched fixture data in each sport's app script.
17. Give the UFC quiz page proper above-the-fold explanatory copy (modes, scoring, login requirement, free) and consider letting a logged-out visitor play one AI round before the login wall.

### Phase 4 — Ongoing
18. Keep `sitemap.xml` `lastmod` values accurate going forward (consider deriving from git history at deploy time rather than a manual bulk date).
19. Delete or `.gitignore` the untracked `ufc-epic-quiz.html` prototype file before any broad `git add`.
20. Monitor `/ufc/` DOM size and page weight as more fight cards/markets are added.
21. Add the missing keyboard handler to the mobile sport-switcher across the 4 shared app scripts (accessibility/agent-readiness).

---

## What This Audit Could NOT Assess (requires the live site)

- Real Core Web Vitals field data (CrUX) — lab-only proxies are in §5, but field data needs real traffic on the public origin.
- Google Search Console data: actual indexation status, real search queries/impressions/CTR.
- Real HTTP response security headers (HSTS, CSP, etc.) — these come from GitHub Pages' live serving configuration, not from these repository files.
- Backlink profile, referring domains, anchor text.
- Real SERP rankings and competitor positioning — the Search Experience (§8) section's intent-match analysis is inferred from page content and query-wording reasoning, not live SERP comparison.
- Live crawl-budget/rate-limiting behavior and actual Googlebot rendering outcomes.
- IndexNow protocol adoption (Bing/Yandex/Naver).

---

## Screenshots

Captured locally via Playwright against `localhost:8000` (desktop 1440×900, mobile 390×844, both above-the-fold and full-page) — saved to `seo-audit-screenshots/` in this repo:

- `hub-*` — homepage
- `ufc-*` — `/ufc/`
- `ufc-quiz-*` — `/ufc/quiz/` (new feature)
- `epl-*` — `/football/epl/` (representative football league page)
- `*-loggedin-mnav.png` — mobile bottom nav with `body.logged-in` force-simulated (the only way to inspect it without a real session)

**One flagged visual bug found:** `/ufc/quiz/`'s full-page screenshot shows a large empty black area below the footer on both desktop and mobile (`ufc-quiz-desktop-full.png`) — not present on the other 3 pages sampled. Not yet root-caused (the visual audit ran out of its turn budget before confirming), but the leading hypothesis is a hidden `.screen` element or an inherited `min-height` contributing layout height while `display:none`. Worth a direct DevTools check of `#quizRoot`'s computed height before this page ships. Two minor cosmetic notes also found: the mobile bottom nav's "ticket history" label is pre-existing-truncated site-wide (not quiz-specific), and the quiz mode-select cards' decorative emoji watermarks render at near-invisible opacity.

---

*This report consolidates 9 parallel specialist passes (technical, content, schema, sitemap, performance, visual, GEO/AI-search, agent-readiness, search-experience) into one document per request. Full category detail, additional evidence, and JSON-structured findings for each pass are preserved in this session's scratchpad if deeper citations are needed later; this file is the durable, repo-local deliverable.*
