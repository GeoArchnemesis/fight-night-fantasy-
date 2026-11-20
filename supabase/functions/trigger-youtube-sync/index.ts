// ============================================================
//  trigger-youtube-sync -- Supabase Edge Function
//  EPJQI8FX/admin.html-ის "იუთუბის ვიდეოს სინქრონიზაცია" ღილაკისთვის --
//  დაუყოვნებლივ უშვებს youtube-sync.yml-ს (GitHub Actions), ზუსტად იმავე
//  კონვენციით, რასაც supabase/functions/trigger-prerender უკვე იყენებს
//  (ახალი არაფერია გამოგონილი -- იხ. იმ ფაილის თავსართი და commit history).
//
//  ორი მოქმედება ერთ ფუნქციაში:
//    POST <url>          -- დაუყოვნებლივ დაუშვი youtube-sync.yml
//    GET  <url>?status=1 -- ბოლო (წარმატებული ან ჩავარდნილი) სინქის შედეგის
//                           წაკითხვა. scripts/youtube-sync.js თავად წერს ამ
//                           შედეგს app_state-ში (key: youtube_sync_last_run)
//                           საკუთარი service_role კლიენტით ყოველი რეალური
//                           გაშვების ბოლოს. ეს ფუნქცია მას კითხულობს
//                           საკუთარი, პლატფორმის მიერ ავტომატურად მოწოდებული
//                           SUPABASE_SERVICE_ROLE_KEY-ით -- app_state-ის RLS
//                           არსად არ იცვლება ამისთვის, ბრაუზერი ამ ცხრილს
//                           პირდაპირ არასდროს ეხება.
//  (workflow_dispatch-ის HTTP პასუხი თავისთავად არაფერს ამბობს რეალურ
//  შედეგზე -- 204 მაშინვე ბრუნდება, გაშვების დაწყებამდეც კი -- ამიტომაა ეს
//  მეორე, status-action საჭირო.)
//
//  ავტორიზაცია (ორივე მოქმედებისთვის იდენტური, ზუსტად trigger-prerender-ის
//  მსგავსად -- არც გაზიარებული secret, არც ანონიმური გზა):
//    1) Authorization: Bearer <caller-ის Supabase access token>
//    2) ტოკენი მოწმდება SUPABASE_URL+"/auth/v1/user"-ზე -- თუ არავალიდურია, 401
//    3) იგივე მომხმარებლის is_admin მოწმდება ზუსტად იმავე query-თი, რასაც
//       EPJQI8FX/admin.html თავად უშვებს initAdminSession()-ში:
//         sb.from('users').select('is_admin').eq('id', session.user.id).single()
//       anon key + caller-ის საკუთარი JWT-ით (არა service_role) -- ანუ
//       იგივე RLS policy-ის ქვეშ. თუ is_admin არ არის true, 403.
//    4) მხოლოდ ამის შემდეგ -- POST GitHub-ის workflow_dispatch API-ზე
//       (ან app_state-ის წაკითხვა, status-action-ზე).
//
//  Secrets (.github/workflows/deploy-trigger-youtube-sync.yml-ის მიერ
//  დაყენებული):
//    GITHUB_DISPATCH_TOKEN = იგივე PAT, რასაც trigger-prerender-იც იყენებს
//                             (GH_DISPATCH_TOKEN repository secret-იდან
//                             remap-ილი -- "GITHUB_" პრეფიქსი GitHub-ის
//                             repository secret-ის სახელისთვის დაცულია,
//                             იხ. trigger-prerender/index.ts-ის შენიშვნა)
//  SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY -- სამივე
//  პლატფორმის მიერაა ავტომატურად მოწოდებული ყოველ Edge Function-ზე,
//  ცალკე დაყენება არ სჭირდება.
//
//  არც YOUTUBE_API_KEY, არც Supabase service-role key არასდროს აღწევს
//  ბრაუზერამდე ამ ფუნქციის მეშვეობით -- ეს ფუნქცია მხოლოდ GitHub-ის
//  workflow_dispatch-ს უშვებს (სადაც YOUTUBE_API_KEY ცხოვრობს, GitHub
//  Actions secret-ად) და app_state-ის ერთ ჩანაწერს კითხულობს.
// ============================================================

const REPO_OWNER = 'GeoArchnemesis';
const REPO_NAME = 'fight-night-fantasy-';
const WORKFLOW_FILE = 'youtube-sync.yml';
const APP_STATE_KEY = 'youtube_sync_last_run';

Deno.serve(async (req) => {
  // CORS: სიტყვასიტყვით trigger-prerender/index.ts-ის კონვენცია.
  const ALLOWED_ORIGINS = new Set([
    'https://fnf.ge',
    'https://www.fnf.ge',
  ]);
  const origin = req.headers.get('origin') || '';
  const originOk = ALLOWED_ORIGINS.has(origin);

  const cors: Record<string, string> = {
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
  if (originOk) cors['Access-Control-Allow-Origin'] = origin;

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (!originOk) {
    console.log('trigger-youtube-sync', 'BLOCKED_ORIGIN', origin || '(none)');
    return new Response(JSON.stringify({ ok: false, error: 'origin not allowed' }),
      { status: 403, headers: { ...cors, 'Content-Type': 'application/json' } });
  }

  const url = new URL(req.url);
  const isStatus = url.searchParams.get('status') === '1';
  if (req.method !== 'POST' && !(req.method === 'GET' && isStatus)) {
    return new Response('method not allowed', { status: 405, headers: cors });
  }

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

  // Caller-ის Supabase access token -- იგივე ნიმუში, რასაც trigger-prerender
  // იყენებს bearer token-იდან userId-ის ამოსაღებად.
  const authHeader = req.headers.get('authorization') || '';
  const bearer = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
  if (!bearer) {
    console.log('trigger-youtube-sync', 'NO_TOKEN');
    return new Response(JSON.stringify({ ok: false, error: 'auth required' }),
      { status: 401, headers: { ...cors, 'Content-Type': 'application/json' } });
  }

  let userId = '';
  try {
    const ures = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + bearer },
    });
    if (ures.ok) {
      const u = await ures.json();
      userId = (u && u.id) || '';
    }
  } catch (_e) { /* ტოკენი ვერ გადამოწმდა */ }

  if (!userId) {
    console.log('trigger-youtube-sync', 'INVALID_TOKEN');
    return new Response(JSON.stringify({ ok: false, error: 'auth required' }),
      { status: 401, headers: { ...cors, 'Content-Type': 'application/json' } });
  }

  // ზუსტად იგივე query, რასაც EPJQI8FX/admin.html თავად უშვებს
  // initAdminSession()-ში, anon key + caller-ის საკუთარი JWT-ით -- ანუ
  // იგივე RLS policy-ის ქვეშ, არა service_role-ით გვერდის ავლით.
  let isAdmin = false;
  try {
    const pres = await fetch(
      SUPABASE_URL + '/rest/v1/users?select=is_admin&id=eq.' + encodeURIComponent(userId),
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + bearer } }
    );
    if (pres.ok) {
      const rows = await pres.json();
      isAdmin = !!(rows && rows[0] && rows[0].is_admin);
    }
  } catch (_e) { /* პროფილი ვერ წამოიღო */ }

  if (!isAdmin) {
    console.log('trigger-youtube-sync', userId, 'NOT_ADMIN');
    return new Response(JSON.stringify({ ok: false, error: 'admin required' }),
      { status: 403, headers: { ...cors, 'Content-Type': 'application/json' } });
  }

  // ---------- GET ?status=1 — ბოლო სინქის შედეგი app_state-დან ----------
  if (isStatus) {
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    try {
      const ares = await fetch(
        SUPABASE_URL + '/rest/v1/app_state?select=value&key=eq.' + APP_STATE_KEY,
        { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY } }
      );
      if (!ares.ok) throw new Error('app_state fetch HTTP ' + ares.status);
      const rows = await ares.json();
      const raw = rows && rows[0] && rows[0].value;
      let result = null;
      if (raw) { try { result = JSON.parse(raw); } catch (_e) { result = null; } }
      return new Response(JSON.stringify({ ok: true, result }),
        { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } });
    } catch (e) {
      console.log('trigger-youtube-sync', userId, 'STATUS_ERROR', (e as Error).message);
      return new Response(JSON.stringify({ ok: false, error: (e as Error).message }),
        { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
    }
  }

  // ---------- POST — დაუყოვნებლივ დაუშვი youtube-sync.yml ----------
  const GITHUB_DISPATCH_TOKEN = Deno.env.get('GITHUB_DISPATCH_TOKEN') || '';
  if (!GITHUB_DISPATCH_TOKEN) {
    console.log('trigger-youtube-sync', userId, 'NO_DISPATCH_TOKEN_CONFIGURED');
    return new Response(JSON.stringify({ ok: false, error: 'dispatch token not configured' }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  }

  // repo owner/name/workflow file are hard-coded module constants above,
  // never read from the request -- the caller cannot point this at another
  // repository or workflow.
  const dispatchUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/${WORKFLOW_FILE}/dispatches`;

  try {
    const gres = await fetch(dispatchUrl, {
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': 'Bearer ' + GITHUB_DISPATCH_TOKEN,
        'Content-Type': 'application/json',
        // GitHub REST API requires a User-Agent on every request.
        'User-Agent': 'fnf-ge-trigger-youtube-sync',
      },
      body: JSON.stringify({ ref: 'main' }),  // dry_run input omitted -- workflow_dispatch uses its declared default (false), a real run
    });

    if (gres.status === 204) {
      console.log('trigger-youtube-sync', userId, 'DISPATCHED');
      return new Response(JSON.stringify({ ok: true }),
        { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    // GitHub's own response -- status code and body -- is surfaced so the
    // admin sees why, but the dispatch token itself is never included here.
    const text = await gres.text();
    console.log('trigger-youtube-sync', userId, 'GITHUB_FAIL', gres.status, text);
    return new Response(JSON.stringify({ ok: false, error: 'github dispatch failed', status: gres.status, body: text }),
      { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } });
  } catch (e) {
    console.log('trigger-youtube-sync', userId, 'ERROR', (e as Error).message);
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }),
      { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
});
