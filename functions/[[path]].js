// ============================================================
//  functions/[[path]].js — Cloudflare Pages Function (SCAFFOLD ONLY)
// ============================================================
//  This is groundwork for Phase C, not the live-data implementation.
//  It proves the per-route pass-through pipeline works end to end —
//  every request still gets exactly the same static HTML it got
//  before this file existed — with one intentional no-op HTMLRewriter
//  transform attached, ready for later phases to register real
//  element handlers on (e.g. injecting live Supabase odds/leaderboard
//  data server-side before the HTML reaches the client).
//
//  [[path]] is Cloudflare's catch-all route syntax: this one file
//  handles every request on the site once deployed as a Pages
//  Function, matching the eventual "per-route SSR" goal.
//
//  Why this doesn't read a file off disk: Pages Functions run on the
//  Workers runtime, not Node.js — there is no filesystem access at
//  request time (no `fs`, no `__dirname`). The equivalent of "read
//  the matching static HTML file from the repo" in this runtime is
//  `context.env.ASSETS.fetch(request)`: Cloudflare's built-in binding
//  that hands the request to the same static-asset layer that serves
//  the site today (including its existing index.html/.html/404
//  resolution rules), so this Function changes nothing about what
//  gets served until real transform logic is added below.
//
//  See the accompanying PR/commit message for the 404.html shadowing
//  risk analysis — this scaffold does not change 404 behavior, but it
//  hasn't been verified live against Cloudflare yet either.
// ============================================================

export async function onRequest(context) {
  // Delegate to the static asset layer — same response the site would
  // have served without this Function in place at all.
  const response = await context.env.ASSETS.fetch(context.request);

  // Placeholder transform: zero element handlers registered, so this
  // is a byte-for-byte no-op today. Later phases attach `.on(selector,
  // handler)` calls here to rewrite specific elements server-side.
  //
  // Not yet scoped to text/html responses only — HTMLRewriter is safe
  // to run on any content type (nothing to match on non-HTML bodies),
  // but a real implementation should probably skip calling it at all
  // for static assets (css/js/images) once real handlers exist, to
  // avoid parsing every request through an HTML rewriter unnecessarily.
  return new HTMLRewriter().transform(response);
}
