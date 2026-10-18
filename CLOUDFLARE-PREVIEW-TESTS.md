# Cloudflare Pages Preview — Test Plan

Concrete checks to run once a preview push is approved. **Nothing in this
file has been run yet — no push has happened.** This is the checklist for
whenever Giorgi explicitly approves pushing something to test against a
live Cloudflare preview.

## Before pushing anything

- The Cloudflare Pages project (`fight-night-fantasy`) is already connected
  to this GitHub repo, with `main` as the production branch. `fnf.ge`'s DNS
  still points directly at GitHub Pages — pushing to GitHub does **not**
  affect live traffic either way, but it is still a real push to a real
  remote and needs its own explicit go-ahead each time, independent of any
  earlier approval.
- **Recommendation:** push `dev` (not `main`) for this round of testing.
  Cloudflare Pages builds a preview URL for any pushed branch; pushing
  `dev` gets an isolated preview (something like
  `dev.fight-night-fantasy.pages.dev`, exact URL shown in the Cloudflare
  dashboard after the push) without touching the `main`/production build
  slot at all. `main` on GitHub is still at `406bbc8` — none of Phase A/B/C
  is merged there yet, so pushing `main` right now would also mean
  deciding to merge `dev` → `main` first, which is a separate decision.
- GitHub Pages at `fnf.ge` keeps serving the current live site throughout —
  it is not affected by anything in this list.

## 1. Real routes load identically to production

Compare each preview URL against the matching live `fnf.ge` URL (view
source and visually):

| Path | Live (fnf.ge) | Preview |
|---|---|---|
| `/` | has it | compare |
| `/ufc/` | has it | compare |
| `/f1/` | has it | compare |
| `/nba/` | has it | compare |
| one football league, e.g. `/football/epl/` | has it | compare |
| `/profile/` | has it | compare |
| `/about/`, `/rules/` | has it | compare |

What to check per page: page renders, hero/leaderboard/fixtures load from
Supabase as normal, no visual difference, `view-source:` HTML matches
(the Function's `HTMLRewriter` pass-through has zero registered handlers,
so output should be byte-for-byte identical — any difference here is a
real bug, not expected noise).

**`/ufc/quiz/` is a special case:** it isn't on `main`/live `fnf.ge` yet
(only merged into `dev` in this session), so there's no production
baseline to diff against. For this one, check instead that it **loads and
functions correctly in preview with no console errors** — pick a mode,
answer a few questions, confirm login/registration works. This is the
first real test of the quiz page outside local `python -m http.server`.

## 2. A genuinely nonexistent path still 404s correctly

Visit paths that have never existed, e.g.:
- `/this-page-does-not-exist`
- `/ufc/this-does-not-exist`

Expected: the custom `404.html` content renders (red "404" / "გვერდი ვერ
მოიძებნა"), and the HTTP status is `404` (check via DevTools Network tab,
not just the visible content — a 200 serving 404-looking content would be
a real bug masked by looking fine).

## 3. Uppercase/legacy URL redirects still work

These are `404.html`'s own documented redirect rules (read directly from
its current inline script, not guessed) — each should land on the target
with no redirect loop:

| Visit | Expected final URL |
|---|---|
| `/UFC/` | `/ufc/` |
| `/F1/` | `/f1/` |
| `/NBA/` | `/nba/` |
| `/Profile/` | `/profile/` |
| `/Football/LaLiga/` | `/football/laliga/` |
| `/f1.html` | `/f1/` |
| `/ufc.html` | `/ufc/` |
| `/nba.html` | `/nba/` |
| `/index.html` | `/` |
| `/admin` | `/admin/admin.html` |

**This is the specific risk flagged in the Phase C investigation:** this
redirect logic only works today because GitHub Pages serves `404.html`'s
body (with a 404 status) for the unmatched/mismatched-case path, and the
browser then runs its script. Whether Cloudflare's static-asset matching
behaves the same way — especially case-sensitivity — is unverified. If any
row in this table fails (no redirect, wrong target, or a redirect loop),
that confirms the open question from the investigation and needs a fix
before DNS cutover is ever considered, not just a note.

## 4. No settlement-critical behavior changed

The scaffold is a pure pass-through today, so this should trivially pass —
but it's the baseline regression check for every future phase that adds
real server-side logic to this Function, so it's worth establishing now:

- On a preview sport page (`/ufc/` or similar), open DevTools → Network,
  place a test action that would normally hit Supabase (login, or just
  loading odds/leaderboard data) and confirm the requests go directly from
  the **browser** to `https://qxfcwsiysnjxhxljqigl.supabase.co/...` —
  i.e. client-side, exactly as today, not proxied through or altered by
  the Pages Function.
- Confirm no new console errors anywhere in the above checks.
- Confirm cache-busting query strings on script tags (`?v=NNN`) are intact
  in the served HTML — `HTMLRewriter` re-serializes the document, so this
  is a basic check that no attribute values got mangled in the pass-through.

## If anything here fails

Stop before considering any further Cloudflare work (real per-route SSR,
`_routes.json`, or DNS cutover) — none of that should proceed until every
row above passes on a live preview. Report back with exactly which check
failed and what was observed instead of the expected result.
