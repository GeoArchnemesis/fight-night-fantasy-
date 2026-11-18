# Football Quiz — Implementation Plan (PRD)

> Planning document only. No code or SQL has been written or applied for this task. Everything below is for review; nothing here has touched the database or the repo's working files except this document.

## 1. Goal

Add a Football quiz that plays identically to the existing UFC quiz (same screens, same components, same CSS, same vs-AI / vs-human mechanics), seeded with the 997 verbatim questions from `FOOTBALL-QUIZ-DATABASE.md`, while guaranteeing the two quizzes never share questions.

---

## 2. How the UFC quiz stack works today (investigation findings)

### 2.1 Data model
- `public.quiz_questions(id, question, options jsonb, correct_index int, level text, category text, is_active bool)`. **`category` already exists as a column and is already populated with `'UFC'`** on every row inserted by `ufc_quiz_seed.sql` / `ufc_quiz_seed_BLOCK2.sql` — but **nothing currently filters on it**. This looks like it was added in anticipation of a second category, but the filter was never wired up.
- `public.guess_who_questions(...)` — the parallel table for the "ვინ ვარ?" (guess-who) game type. **Football has no guess-who content** — `FOOTBALL-QUIZ-DATABASE.md` only contains "ნაწილი B — ქვიზი" (997 multiple-choice questions, no clue-based profiles). This matters for the entry-UI design (§4).
- `public.quiz_user_seen_questions(user_id, game_type, level, question_id)` — no-repeat tracking for vs-AI, keyed on `(game_type, level)` only. **No category in the key today.**
- `public.quiz_rooms(id, code, game_type, level, status, host_id, host_name, questions jsonb, ...)` — PvP room state. `game_type` is `check (in ('quiz','guess'))`. **No sport/category column at all.**

### 2.2 RPCs that pool questions — confirmed to have zero category filter
- `get_ai_quiz_questions(p_game_type, p_level)` (`quiz_no_repeat.sql`) — vs-AI question fetch. Filters only by `game_type` and `level` (or the `'შერეული'` mixed sentinel, which drops the level filter too). **Today this pools every active row in `quiz_questions` regardless of category.**
- `create_quiz_room(p_game_type, p_level, ...)` (live version in `quiz_group_pvp.sql`, supersedes the copy in `quiz_pvp.sql`) — same story: filters by `game_type`/`level` only, no category.
- `join_quiz_room(p_code, ...)` — just looks up a room by code and returns its already-baked `questions` jsonb; doesn't re-query `quiz_questions`, so it's not a leak vector itself, but a room's `code` namespace is **global across all content** (see §3.3 below).

**Conclusion: if Football rows are inserted into `quiz_questions` with no further change, they start appearing in the live UFC vs-AI quiz and in every newly created PvP room immediately.** Isolation is not optional — it's required just to keep the UFC quiz working correctly, let alone to give Football its own quiz.

### 2.3 Seeding pattern (`ufc_quiz_seed.sql` + `_BLOCK2.sql`)
- A single reviewable `.sql` file, **not auto-applied** — pasted into the Supabase SQL editor by hand.
- **BLOCK 1**: pure `select`s — before/after counts, dedupe self-check, an "already applied?" guard preview. Zero writes.
- **BLOCK 2**: one `begin; do $tag$ ... end $tag$; commit;` — guarded by the same "already applied?" check so a second run is a true no-op; deactivates legacy rows (`is_active = false`, never deleted/edited) via a dynamically-captured `max(id)`, then inserts new rows with `where not exists (...)` dedupe on `(question, level)`, all in one transaction.
- Every question/option string is copied **byte-for-byte** from the source markdown into dollar-quoted (`$gq$...$gq$`) SQL literals — no escaping needed, no rewording.
- `options` is stored as `to_jsonb(ARRAY[...]::text[])`, `correct_index` is a plain 0-based int into that array (not an `is_correct` flag per option).

### 2.4 Levels (`ufc/quiz.js` — `DIFFICULTY` array, line ~492)
- Three **stored** levels: `მარტივი`, `საშუალო`, `რთული` — plus `შერეული` (mixed), which is a **query-time sentinel only**. It's never written as a `level` value on any row; `get_ai_quiz_questions` and `create_quiz_room` both special-case `p_level = 'შერეული'` by dropping the level filter (see `v_mixed` in both functions) so the pool spans every active level for that `game_type`.
- The frontend `DIFFICULTY` array also carries the vs-AI bot's simulated accuracy per level (`acc: 0.40/0.62/0.82/0.62`) and the Georgian level description shown on the lobby screen (`note`/`noteHtml`). These descriptions are currently UFC-flavored text ("MMA-ის შესახებ...") — Football needs its **own** description strings, which are given verbatim in the task and also already present at the bottom of `FOOTBALL-QUIZ-DATABASE.md` (§ "სტრუქტურა და დონეების აღწერები") — the two sources match exactly.

### 2.5 Frontend flow (`ufc/quiz.js`, `ufc/quiz/index.html`)
- Single-page app at `/ufc/quiz/`, screens toggled via `show(id)` (`.screen.active` class swap) — `screen-gametype` → `screen-mode` → `screen-lobby` → `screen-quiz` (or the PvP branch: `screen-pvp-setup` → `screen-pvp-lobby` → `screen-pvp-wait`/`screen-quiz` → `screen-pvp-results`).
- `screen-gametype` (the very first screen) is a 2-card picker: "ქვიზი" (quiz) vs "გამოიცანი ვინ ვარ" (guess-who) — `data-gametype="quiz"|"guess"` drives `chooseGameType()`, which sets `S.gameType` and shows `screen-mode`.
- `screen-mode` is another 2-card picker: AI vs PvP (`data-mode="ai"|"pvp"`).
- `screen-lobby` renders the 4 difficulty cards from `DIFFICULTY` and, on pick, calls `fetchQuestions(dbLevel)` → `sb.rpc('get_ai_quiz_questions', {p_game_type:'quiz', p_level: dbLevel})` for vs-AI, or `createPvpRoom(level)` → `sb.rpc('create_quiz_room', {...})` for PvP.
- Deep history/back-button support via a `QUIZ_STEPS` table + `pushState`, a `?room=<code>` deep link for joining a PvP room, a `fnf_quiz_room` localStorage record (`PVP_ROOM_STORAGE_KEY`) for reconnecting to an in-progress PvP room after a reload, a `fnfQuizPendingIntent` sessionStorage record for resuming "start quiz" after a Google OAuth round-trip, and a site-wide `quiz-return-banner.js` (loaded on every page via `/ufc/`, `/f1/`, `/nba/`, `/football/*`, etc.) that reads that same `fnf_quiz_room` key to show a "return to your game" banner anywhere on the site.
- **The whole page is UFC-branded**, independent of game-type/mode selection: `<title>FNF - ქვიზი</title>` but OG/meta copy says "UFC ქვიზი"; canonical URL is `https://fnf.ge/ufc/quiz/`; the nav's "ფენტეზის ტიპი" dropdown highlights `UFC` as `.on`; the breadcrumb JSON-LD says `"name": "UFC"`; the mini-hero (`#quizHero`, shown only on `screen-gametype`) has a **hardcoded** `<h1>UFC ქვიზი</h1>`; the OAuth redirect URL in `handleQuizGoogleAuth()` is hardcoded to `/ufc/quiz/`. The gametype card for "ქვიზი" also has hardcoded copy `"კითხვები UFC-დან"` ("questions from UFC").
- Entry points into this page: `ufc/index.html`'s mobile nav ("ქვიზი" button → `/ufc/quiz/`), and **every other sport section's mobile nav also links to the same `/ufc/quiz/` URL** (confirmed in `football/epl/index.html` etc.) — so today "the quiz" is already treated site-wide as one shared destination, not a UFC-only feature, even though its URL/branding says otherwise.

---

## 3. Decision 1 — Isolation strategy (needs your sign-off)

### Option A — Shared tables, new `category`/`sport` filter parameter (recommended)
Reuse `quiz_questions` as-is (it already has `category`, already populated `'UFC'`), add Football rows with `category = 'Football'`, and add a **required** `p_category` parameter to `get_ai_quiz_questions` and `create_quiz_room`/`join_quiz_room`'s room-creation path. Every query against `quiz_questions` gains `and category = p_category`.

Supporting schema change: add `category text not null` to `quiz_user_seen_questions`'s primary key (currently `(user_id, game_type, level, question_id)`) so a user's Football no-repeat history is tracked independently of their UFC history, and add `category text not null` to `quiz_rooms` (with a `check (category in ('UFC','Football'))`) so a room's code also remembers which sport it belongs to.

**Pros**
- The schema already seems to anticipate this (`category` column + `'UFC'` value already there, unused) — this is very likely the originally-intended extension point.
- No duplicated RPC logic. The UFC quiz's RPCs encode a lot of hard-won edge-case handling (no-repeat cycling, the `შერეული` mixed sentinel, PvP room code generation/retry, N-player scoring) — duplicating all of that into a parallel `*_football_*` RPC set means maintaining two copies of the same bug surface forever.
- `guess_who_questions` is untouched — Football has no guess-who content, so there's nothing to do there.
- One seen-questions table, one rooms table — simpler to reason about and query/admin.

**Cons**
- Touches already-**live** functions (`get_ai_quiz_questions` is called in production today). Must add the new parameter carefully — Postgres allows adding a parameter via `create or replace function` with the new param placed last, but every call site (currently only `ufc/quiz.js`) must be updated to pass it explicitly; if a call site is missed, that call breaks or (worse) silently pools everything.
- `quiz_user_seen_questions` needs a primary-key migration (add column, backfill existing rows with `category='UFC'`, re-key) — a real migration, not purely additive.
- `quiz_rooms` needs a new column + constraint, and `create_quiz_room`'s return type is unchanged but its body and the room lookup in `join_quiz_room` both need the extra column threaded through.
- Isolation safety now depends on **every** query remembering the `category` filter — a future dev adding a new question-reading query could forget it. (Mitigated by making the parameter required with no default, and by code review / the dry-run BLOCK 1 pattern.)

### Option B — Fully separate schema (`football_quiz_questions` table + parallel RPCs)
Mirror `quiz_questions`/`guess_who_questions`'s existing split: a brand-new `football_quiz_questions` table, a brand-new `get_football_quiz_questions`/`create_football_quiz_room`/`join_football_quiz_room` RPC set, a brand-new `football_quiz_rooms`/`football_quiz_room_keys`/`football_quiz_room_answers`/`football_quiz_user_seen_questions` table set.

**Pros**
- Architecturally impossible for Football content to leak into a UFC query, or vice versa — there's no shared filter to forget. Strongest possible isolation guarantee.
- Zero risk to the already-live UFC RPCs — their signatures and bodies never change.
- Matches this codebase's existing precedent of "new content type → new table" (`quiz_questions` vs `guess_who_questions`).

**Cons**
- Duplicates a lot of non-trivial logic: the no-repeat cycling algorithm, the mixed-level sentinel handling, PvP room code generation + collision retry, N-player join/start/submit/score/leave/rejoin flow (`quiz_group_pvp.sql` alone is ~590 lines). Any future bugfix to PvP (e.g. the AFK/host-handover edge cases already patched multiple times per the SQL file list — `quiz_pvp_host_leave.sql`, `quiz_host_handover.sql`, `quiz_leave_v2.sql`, `quiz_results_fix.sql`) would need to be applied twice.
- More tables, more RPCs, more surface area for `list_tables`/admin tooling, more to keep "in sync" (as the existing SQL files' own comments repeatedly flag, e.g. "keep in sync with ufc/quiz.js").
- Doesn't scale well if a third sport is added later — this is "N tables × N RPC sets" growth instead of "N categories in one table."

### Recommendation
**Option A.** The `category` column's existence (already correctly populated, already unused) is a strong signal this was the intended design, and the UFC PvP/no-repeat machinery is complex enough that duplicating it is a real maintenance liability. The migration cost (PK change on `quiz_user_seen_questions`, new column on `quiz_rooms`) is small and one-time. I'd make `p_category` a required (no default) parameter on the touched RPCs specifically so a missing category can't silently fall back to "pool everything."

**Your call — let me know which to proceed with**, or a third option if you see one I'm missing.

---

## 4. Decision 2 — Entry UI & routing (needs your sign-off)

The task says: open the quiz → show UFC / Football → picking Football opens the same UI with only Football content. Two sub-questions fell out of investigation that aren't fully specified yet:

### 4.1 Where does the sport picker live, and what happens to UFC branding?
The existing page is `/ufc/quiz/` and is UFC-branded independent of what screen you're on: page `<title>`/OG tags say "UFC ქვიზი", canonical URL and breadcrumb JSON-LD say "UFC", the nav highlights UFC as the active "fantasy type", the mini-hero `<h1>` is hardcoded "UFC ქვიზი", and the Google OAuth redirect URL is hardcoded to `/ufc/quiz/`. Yet **every other sport section already links to this same URL** as "the quiz" (not a UFC-specific feature) from their own mobile nav.

Two sub-options:
- **4.1a — Same URL, sport-aware branding.** Add the sport picker as a new first screen (`screen-sport`) on the existing `/ufc/quiz/` page. Make the hero `<h1>`, nav "active fantasy type" highlight, OAuth redirect, canonical URL, and OG/meta copy all switch based on the chosen sport. This keeps one URL (no broken inbound links, no SEO fragmentation) but means several currently-hardcoded "UFC" spots become conditional.
- **4.1b — New sport-neutral URL** (e.g. `/quiz/`), with `/ufc/quiz/` becoming a redirect (or staying as a UFC-only deep link, e.g. `/quiz/?sport=ufc`, for existing bookmarks/links). Cleaner separation of concerns, but is a bigger routing change and needs every existing nav link (`ufc/index.html`, all six `football/*/index.html`, `nba/index.html`, `f1/index.html`, any others) repointed.

**My lean**: 4.1a — smaller blast radius, keeps the single URL every sport section already points to, and the "sport-aware branding" bits are a handful of well-isolated spots (one `<h1>`, one redirect string, nav highlight logic, meta tags) rather than a site-wide link-repoint. But this is a real UX/SEO tradeoff you should decide, not something to default silently.

### 4.2 Does Football get a "game type" screen at all?
UFC's first content screen (`screen-gametype`) picks between "ქვიზი" (quiz) and "გამოიცანი ვინ ვარ" (guess-who). **Football has no guess-who content** in the reviewed database — only the 997-question multiple-choice bank. So after picking "Football" on the sport screen, there's nothing to choose between.

**My lean**: skip `screen-gametype` entirely for Football and go straight from the sport picker to `screen-mode` (AI vs human), with `S.gameType` set to `'quiz'` automatically. This avoids presenting a single-card "choice" that isn't a real choice. (If you'd rather future-proof for a Football guess-who mode later, we could instead show a gametype screen with only the quiz card enabled/visible — happy to do either.)

---

## 5. Seeding plan

- New file `supabase/football_quiz_seed.sql`, following the **exact same pattern** as `ufc_quiz_seed.sql`/`ufc_quiz_seed_BLOCK2.sql`: not auto-applied, pasted into the Supabase SQL editor by hand.
  - **BLOCK 1** (read-only): before/after counts by level, an internal dedupe self-check across the 997 rows this migration would insert, and an "already applied?" guard preview — mirroring the existing file's structure.
  - **BLOCK 2** (guarded, single transaction): inserts all 997 rows into `quiz_questions` with `category = 'Football'` (or into `football_quiz_questions` if Option B is chosen instead), `is_active = true`, idempotent via `where not exists (...)` on `(question, level, category)`. **No deactivation step is needed here** — unlike the original UFC seed (which had to retire 98 pre-existing legacy rows that predated the `category` column), there is no pre-existing Football content to deactivate; this file is a pure insert.
- **Verbatim import, zero reshuffling.** Each question's 4 options are taken in the exact order they appear in `FOOTBALL-QUIZ-DATABASE.md` (A/B/C/D → array index 0/1/2/3), and `correct_index` is derived purely from the `✅` marker already in the source (e.g. `✅ D` → `correct_index = 3`). The document's own header note confirms the options were *already* shuffled per-question during review ("ვარიანტების არევა: ვარიანტები აირია კითხვა-კითხვა... რადგან საიტი ჩვენებისას ვარიანტებს არ ურევს") — i.e. the site does not shuffle options at render time, so the source order **is** the display order. This matches `normalizeRow()` in `quiz.js`, which takes `options` as a plain ordered array and `correct_index` as a plain integer — no shuffling happens client-side either.
- **Verification before writing SQL**: cross-check the file's stated totals (200 / 498 / 299 = 997, matching `## დონე:` headers at lines 19, 1421, 4909) against an actual line-by-line parse of all 997 `**N.**` blocks, confirming each has exactly 4 options and exactly one `✅` marker, before generating the INSERT values — same spirit as the UFC seed file's internal self-collision check in BLOCK 1.
- Level values stored verbatim as the Georgian strings `მარტივი` / `საშუალო` / `რთული` (matching the existing `level` column's values for UFC — same column, same literal strings, just scoped by `category` now).

---

## 6. Levels

- Three stored levels, mapped directly from the database's own level headers:
  - `მარტივი` — questions 1–200
  - `საშუალო` — questions 201–698
  - `რთული` — questions 699–997
- `შერეული` (mixed) — **not stored**, query-time only, exactly like UFC: `get_ai_quiz_questions`/`create_quiz_room` treat `p_level = 'შერეული'` as "drop the level filter, keep the category filter," so it pools from all 997 active Football rows.
- Level descriptions shown on the lobby screen — these exact four strings, no rewording (also independently confirmed present verbatim at the bottom of `FOOTBALL-QUIZ-DATABASE.md`):
  - მარტივი: `ზოგადი საფეხბურთო ცოდნაც საკმარისია`
  - საშუალო: `გარკვეული ცოდნა გჭირდება კითხვებზე პასუხის გასაცემად`
  - რთული: `ტატო ბაციკაზე თუ არ ხარ გაეშვი.`
  - შერეული: `ამ დონეზე ალბათ ყველაზე კარგად გაერთობი`
- A new `DIFFICULTY`-equivalent array (or a Football-specific variant of the existing one, selected by sport) carries these four description strings in place of the UFC ones. The vs-AI bot accuracy curve (`acc: 0.40/0.62/0.82/0.62`) is generic difficulty pacing, not UFC-specific content, so it can be reused unchanged for Football unless you'd like it tuned differently.

---

## 7. Modes

- **vs AI**: same `fetchQuestions()` → `get_ai_quiz_questions` → `renderQuestion()` flow as UFC, parameterized by category/sport. No guess-who branch is needed for Football (see §4.2).
- **vs human (PvP)**: same `create_quiz_room` / `join_quiz_room` / `start_quiz_room` / `submit_quiz_answer` / `reveal_quiz_clue` (N/A for Football, no clues) / `get_quiz_results` / `leave_quiz_room` / `rejoin_quiz_room` flow, parameterized by category/sport so a room "remembers" which sport it's for (needed under Option A so a `?room=<code>` deep link or the `fnf_quiz_room` localStorage reconnect record resolves to the right branding/content, and under either option so the PvP lobby only ever contains Football questions).
- **Shared state collision to watch for**: `PVP_ROOM_STORAGE_KEY` (`fnf_quiz_room` in localStorage) and the site-wide `quiz-return-banner.js` are **not currently sport-scoped** — if a user starts a UFC PvP room, then separately starts a Football PvP room before finishing the first, the single localStorage key gets overwritten and the "return to your game" banner / reconnect flow would only remember the most recent one. This is an edge case (needs two simultaneous in-progress PvP games across two sports) but should be called out explicitly — see open questions.

---

## 8. Touch list (what will need to change, once isolation + routing are decided — not written yet)

**New files**
- `supabase/football_quiz_seed.sql` (BLOCK 1 / BLOCK 2, per §5)

**Database (existing files, edited or companion migration file — exact shape depends on §3 decision)**
- `supabase/quiz_no_repeat.sql` — `get_ai_quiz_questions` gains `p_category`; `quiz_user_seen_questions` gains `category` in its primary key.
- `supabase/quiz_group_pvp.sql` — `create_quiz_room` gains `p_category`; `quiz_rooms` gains a `category`/`sport` column + constraint; `join_quiz_room`/`rejoin_quiz_room`/`get_quiz_results` return it so the client can brand the room correctly.

**Frontend**
- `ufc/quiz/index.html` — new sport-picker screen/markup; sport-aware hero `<h1>`/meta/canonical/breadcrumb if 4.1a is chosen (or no changes here + a new page if 4.1b is chosen); a Football-specific `DIFFICULTY`-style descriptions block.
- `ufc/quiz.js` — sport state (`S.sport` or similar) threaded through every `sb.rpc(...)` call that currently omits a category; `fetchQuestions`/`createPvpRoom`/the OAuth redirect URL/the `QUIZ_STEPS` routing table all become sport-aware; skip-gametype-screen logic for Football (§4.2).
- `quiz-return-banner.js` (site-wide) — sport-aware label/link if the reconnect banner should say "Football ქვიზი" vs "UFC ქვიზი" rather than a generic "ქვიზი".
- Nav entry points — `ufc/index.html` and all six `football/*/index.html` "ქვიზი" mobile-nav buttons (and `nba/index.html`/`f1/index.html` if they have the same button) may need their link/label revisited depending on §4.1.

This list is for scoping/review only — nothing in it has been implemented.

---

## 9. Hard constraints honored in this plan

- No question, answer, or option text is invented, reworded, or translated anywhere in this plan — the seeding section describes a mechanical, verbatim copy keyed off the existing `✅` marker.
- No level description text is invented — the four strings in §6 are copied exactly from your message and independently cross-checked against `FOOTBALL-QUIZ-DATABASE.md`'s own "სტრუქტურა და დონეების აღწერები" section, which contains the identical four strings.
- No SQL or code was written or applied this run.

---

## 10. Open questions for your review

1. **Isolation (§3)**: Option A (shared table + category param, recommended) or Option B (fully separate schema)?
2. **Routing/branding (§4.1)**: keep `/ufc/quiz/` as the one URL with sport-aware branding, or split into a new sport-neutral URL?
3. **Game-type screen for Football (§4.2)**: skip it entirely (go straight to AI/human picker), or show it with only the quiz card active, to leave room for a future Football guess-who mode?
4. **PvP room / reconnect-banner sport scoping (§7)**: should a user be able to have one in-progress UFC PvP game and one in-progress Football PvP game "remembered" simultaneously (i.e. is this worth the extra plumbing), or is "only the most recent one is remembered" acceptable?
5. **Vs-AI difficulty curve (§6)**: reuse the UFC bot-accuracy values (0.40/0.62/0.82/0.62) unchanged for Football, or would you like different pacing?
6. **Nav/entry points (§8)**: do you want a Football quiz link added anywhere beyond wherever the sport-picker screen itself lives (e.g. on the `football/*` league pages' desktop nav, which currently only link to betting, not the quiz)?

---

## Phase 2 — Homepage quiz section, photo cards, back button

> Planning only. No code or copy has been written for this phase — specs below are agreed decisions to implement next, pending the copy sign-off in §4 of this phase.

### 1. Back button (quiz sport-select screen)

- **Target**: `ufc/quiz/index.html` ~line 548, the home-icon control inside `#quizHero`:
  ```html
  <a class="qz-home" href="/" aria-label="მთავარი გვერდი">…svg…</a>
  ```
- **Change**: convert this anchor into a back button, matching the `.qback` back-buttons already used on every inner quiz screen (same red pill, same chevron SVG — the arrow markup used by `#back-to-sport`, `#back-to-gametype`, etc. at `ufc/quiz/index.html` lines 572/589/605/614/635/654/664/710, styled by `.qback`/`.qback-label`/`.qback svg` in `style.css` lines 794–799).
- **Behavior**: on click —
  - if same-origin in-site history exists → `history.back()` (returns the user to wherever they entered the quiz from);
  - else (direct load / refresh, no in-site history) → fallback to `location.href = '/'`.
- Keep a meaningful `aria-label` (e.g. "უკან" to match the other `.qback` buttons' label, replacing the current "მთავარი გვერდი").
- This only touches the control inside `#quizHero` on `screen-sport` — it does not change any of the existing `.qback` buttons on the inner screens (`#back-to-sport`, `#back-to-gametype`, etc.), which keep their current `history.back()`-style behavior untouched.

### 2. Sport-picker cards (`#screen-sport` `.mode` cards)

- **Target**: `ufc/quiz/index.html` lines 558–568 (`#screen-sport`, the two `.mode` cards at lines 561–566).
- **Current**: text-only — `<h2>UFC</h2>` / `<h2>ფეხბურთი</h2>`, no image.
- **New**: each `.mode` card becomes:
  - a full-bleed **1:1 square photo** on top (no text/label burned into the photo, no sport-name text anywhere on the card);
  - a **"ითამაშე"** button directly below the photo, styled with the site's existing primary button style (`.btn.btn-primary`, used throughout `ufc/quiz/index.html` and every sport page — e.g. lines 619/647/668/700/815).
  - Photos are real assets Gio will upload later; **for now, use a plain white placeholder banner** in place of each photo so sizing can be tuned before the real images land.
  - Recommended source photo size: **800×800px** (1:1 square).
- **Unchanged**: `data-sport="UFC"` / `data-sport="Football"` stay on the card elements, and the existing selection logic stays as-is — clicking anywhere on the card OR clicking its "ითამაშე" button both select that sport and proceed exactly as today (`chooseSport()`/equivalent handler, unchanged).
- Cards keep the existing responsive 2-column `.modes` grid layout (no layout/breakpoint changes beyond swapping in the photo+button structure).

### 3. Homepage quiz section (`index.html`)

- **Insertion point** — a new `<section>` between the Fantasy sport-picker block and the News block:
  - **After** line 117 (`</div>` closing `<div class="land-cards">…</div>`, lines 107–117 — the "აირჩიე ფენტეზის ტიპი" Fantasy card grid at `index.html` line 105 `<h1 class="land-title">`).
  - **Before** line 119 (`<!-- NEWS-HOME:START -->`, immediately preceding `<section id="newsStrip">` at line 120).
  - i.e. the new section's markup goes directly between the existing `</div>` at line 117 and the `<!-- NEWS-HOME:START -->` comment at line 119.
- **Heading**: "ქვიზი", styled as an H1 in the same style as the homepage's other section headings (matching the pattern of `.land-title` at line 105 / the `<h2>` section headings such as `სიახლეები` at line 121 and `რა არის FNF.GE` at line 159 — exact heading element/class to mirror whichever the other homepage sections use consistently; implementer confirms against current CSS before coding).
- **Contents**: the **same** 1:1 photo-card + "ითამაშე" button component as the quiz sport-picker (§2 above) — reused, not re-implemented — with white placeholders standing in for the real UFC/Football photos until Gio uploads them.
- **Click behavior (decided — Option B)**: both cards/buttons on the homepage navigate straight to the quiz sport-picker at `/ufc/quiz/` with **no sport pre-selected**. The user picks UFC or Football on the picker screen itself (§2). This keeps the homepage section a simple "go play the quiz" entry point and scales cleanly as more quizzes (e.g. Formula 1) are added later — no per-sport homepage routing to maintain.

### 4. Copy / text — PENDING, no copy written yet

- The quiz page's land-about explainer block ("რა არის UFC ქვიზი") is currently UFC-worded and shown generically regardless of sport.
- **Plan**: make this explainer sport-aware on the quiz page:
  - **neutral** text shown on the sport-picker landing (`screen-sport`), before a sport is chosen;
  - **UFC** text (unchanged, verbatim) shown once the UFC flow is chosen;
  - **Football** text — same rules/structure as the UFC version, reworded for football — shown once the Football flow is chosen.
- All new Georgian copy (the neutral landing text + the Football version) will be **drafted by the planner and sent to Gio for approval/edits before any implementation**. Marked pending — not to be written until that round-trip happens. UFC's existing text is not touched.

### 5. Deferred / future — documented, not scheduled now

- **URL restructure**: `/quiz/`, `/quiz/ufc`, `/quiz/footballquiz`, with `/ufc/quiz/` kept alive as a redirect for existing links/bookmarks. Not part of this phase — current plan keeps everything on `/ufc/quiz/` (see Phase-1 §4.1a).
- **Football "გამოიცანი ვინ ვარ" (guess-who) mode**: ~1000 questions coming later. Will require adding category isolation to `guess_who_questions` (currently UFC-only, no `category` column — see Phase-1 §2.1) plus a sport parameter threaded through the guess-who RPCs, mirroring the `quiz_questions` isolation work already live/in-flight for the multiple-choice quiz.
- **Formula 1 / additional quizzes**: both the homepage quiz section (§3) and the sport-picker (§2) are being built now to accept more sport cards without restructuring — adding F1 later should mean "add one more card," not a redesign.

### 6. Deploy note

- The already-written, currently-uncommitted category/sport-picker frontend changes (`ufc/quiz.js`, `ufc/quiz/index.html` — per git status: `M ufc/quiz.js`, `M ufc/quiz/index.html`) and this Phase 2 work (back button, photo cards, homepage section) are meant to be **committed and deployed together**, not separately.
- Safety net already in place: the RPCs' `DEFAULT 'UFC'` on the category parameter means that even if a call site is ever missed, it falls back to UFC-only pooling rather than leaking Football content (or vice versa) — this is the live safety net referenced in Phase-1 §3.
