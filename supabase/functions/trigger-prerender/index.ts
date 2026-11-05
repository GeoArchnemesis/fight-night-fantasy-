// ============================================================
//  trigger-prerender -- Supabase Edge Function
//  EPJQI8FX/news.html admin-ის მიერ გამოძახებული სტატიის შენახვის შემდეგ,
//  რომ scripts/prerender-news.js-ის GitHub Actions workflow (prerender-news.yml)
//  დაუყოვნებლივ გაეშვას publish-ზე, ნაცვლად იმისა რომ დაელოდოს მის cron-ს
//  (*/30 * * * *, რომელსაც GitHub რეალურად ბევრად იშვიათად უშვებს -- 2026-11-04-ზე
//  დღეში სამჯერ: 04:44, 11:10, 19:37). cron უცვლელი რჩება, როგორც backup.
//
//  კონვენციები, აღებული არსებული ორი ფუნქციიდან (ახალი არაფერია გამოგონილი):
//    - CORS (preflight, Allow-Origin ორიგინალ წარმოშობათა სიით, Vary: Origin) --
//      სიტყვასიტყვით meta-capi/index.ts-დან.
//    - Authorization bearer token-ის გადამოწმება SUPABASE_URL + "/auth/v1/user"-ზე
//      fetch-ით (apikey + Bearer <token>) -- იგივე ნიმუში, რასაც meta-capi
//      იყენებს token-დან userId/email ამოსაღებად.
//    - JSON შეცდომის ფორმა { ok: false, error: "..." } და success ფორმა
//      { ok: true, ... } -- იგივე, რასაც meta-capi აბრუნებს ორივე შემთხვევაში.
//  ეს ფუნქცია არ იყენებს telegram-bot/login-with-identifier-ის service_role
//  კლიენტს ან გაზიარებულ secret header-ს (X-Admin-Secret) -- ავტორიზაცია
//  მხოლოდ ზარის გამომგზავნის საკუთარი access token-ითაა, ისევე როგორც
//  EPJQI8FX/news.html თავად ამოწმებს თავის admin-ს (იხ. ქვემოთ).
//
//  ავტორიზაცია (ერთადერთი -- არ არსებობს არც გაზიარებული secret, არც
//  ანონიმური გზა):
//    1) Authorization: Bearer <caller-ის Supabase access token>
//    2) ტოკენი მოწმდება SUPABASE_URL+"/auth/v1/user"-ზე -- თუ არავალიდურია, 401
//    3) იგივე მომხმარებლის is_admin მოწმდება ზუსტად იმავე query-თი, რასაც
//       EPJQI8FX/news.html თავად უშვებს initAdminSession()-ში (news.html:339):
//         sb.from('users').select('is_admin').eq('id', session.user.id).single()
//       აქაც anon key + caller-ის საკუთარი JWT-ით (არა service_role), ანუ
//       იგივე RLS policy-ის ქვეშ -- ვინც admin გვერდს ხედავს, ის აქაც გაივლის
//       ავტორიზაციას, და პირიქით. თუ is_admin არ არის true, 403.
//    4) მხოლოდ ამის შემდეგ -- POST GitHub-ის workflow_dispatch API-ზე.
//
//  Secrets (Supabase Dashboard -> Edge Functions -> Secrets, .github/workflows/
//  deploy-trigger-prerender.yml-ის მიერ დაყენებული):
//    GITHUB_DISPATCH_TOKEN = <GitHub fine-grained PAT, Actions: Read and write,
//                             მხოლოდ GeoArchnemesis/fight-night-fantasy- რეპოზე>
//  SUPABASE_URL და SUPABASE_ANON_KEY ცალკე დაყენებას არ საჭიროებს -- ეს ორი
//  ყოველ Edge Function-ზე პლატფორმის მიერაა ავტომატურად მოწოდებული (იგივენაირად,
//  როგორც meta-capi/telegram-bot უკვე იყენებენ Deno.env.get-ით).
//
//  ----------------------------------------------------------------
//  Giorgi-მ ხელით უნდა გააკეთოს, დეპლოიმდე (თანმიმდევრობით):
//    1. შექმენი GitHub fine-grained personal access token, scope -- მხოლოდ
//       ერთი რეპო: GeoArchnemesis/fight-night-fantasy-. Permissions-ში მხოლოდ
//       Actions = Read and write, სხვა არაფერი.
//    2. დაამატე ის GitHub Actions repository secret-ად, სახელით
//       GH_DISPATCH_TOKEN (იხ. შენიშვნა ქვემოთ, თუ რატომ არა
//       GITHUB_DISPATCH_TOKEN).
//    3. გააკეთე push -- ეს დეპლოის ფუნქციას და აწვდის secret-ს Supabase-ს.
//    4. გამოაქვეყნე სატესტო სტატია და დარწმუნდი, რომ prerender-news.yml
//       წამებში (არა წუთებში) დაიწყო.
//
//  შენიშვნა ნაბიჯ 2-თან დაკავშირებით: "GITHUB_" პრეფიქსი დაცულია GitHub-ის
//  მიერ repository secret-ის სახელისთვის -- GitHub თავად უარყოფს ნებისმიერ
//  secret-ს, რომლის სახელიც ამ პრეფიქსით იწყება (დადასტურებულია commit-ის
//  წინ). ამიტომ repository secret დარქმეულია GH_DISPATCH_TOKEN, და
//  .github/workflows/deploy-trigger-prerender.yml-ის "Set Edge Function
//  secrets" ნაბიჯი მას მაპავს GITHUB_DISPATCH_TOKEN გარემოს ცვლადზე
//  (supabase secrets set GITHUB_DISPATCH_TOKEN="${{ secrets.GH_DISPATCH_TOKEN }}").
//  თავად ამ ფუნქციის კოდი (ქვემოთ) მხოლოდ Deno.env.get('GITHUB_DISPATCH_TOKEN')-ს
//  კითხულობს -- repository secret-ის სახელი მისთვის არ არის ხილული.
//
//  რა ეს არ ასწორებს (იხ. commit-ის შეტყობინება task-ის მოთხოვნით -- აქ არ
//  შეცვლილა): scripts/prerender-news.js-ის query (ხაზი ~580) ირჩევს მხოლოდ
//  is_published=true-ს, published_at-ზე ზედა ზღვარის გარეშე. სტატია, რომელსაც
//  is_published=true და მომავალი published_at აქვს, მაინც დაუყოვნებლივ გამოცხვება
//  ამ ფუნქციის დაძახებისას -- published_at ველი თარიღს არ გეგმავს, მხოლოდ
//  საჩვენებელი/რედაქციული მონაცემია.
// ============================================================

const REPO_OWNER = 'GeoArchnemesis';
const REPO_NAME = 'fight-night-fantasy-';
const WORKFLOW_FILE = 'prerender-news.yml';

Deno.serve(async (req) => {
  // CORS: სიტყვასიტყვით meta-capi/index.ts-ის კონვენცია (ორიგინალთა
  // allow-list, Vary: Origin) -- არა wildcard '*', როგორც telegram-bot/
  // login-with-identifier იყენებენ, რადგან ეს ფუნქცია ბრაუზერიდან
  // ავტორიზებული ადმინის ტოკენით მოიხმობა.
  const ALLOWED_ORIGINS = new Set([
    'https://fnf.ge',
    'https://www.fnf.ge',
  ]);
  const origin = req.headers.get('origin') || '';
  const originOk = ALLOWED_ORIGINS.has(origin);

  const cors: Record<string, string> = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
  if (originOk) cors['Access-Control-Allow-Origin'] = origin;

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (!originOk) {
    console.log('trigger-prerender', 'BLOCKED_ORIGIN', origin || '(none)');
    return new Response(JSON.stringify({ ok: false, error: 'origin not allowed' }),
      { status: 403, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405, headers: cors });

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

  // Caller-ის Supabase access token -- იგივე ნიმუში, რასაც meta-capi
  // იყენებს bearer token-იდან userId/email-ის ამოსაღებად.
  const authHeader = req.headers.get('authorization') || '';
  const bearer = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
  if (!bearer) {
    console.log('trigger-prerender', 'NO_TOKEN');
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
    console.log('trigger-prerender', 'INVALID_TOKEN');
    return new Response(JSON.stringify({ ok: false, error: 'auth required' }),
      { status: 401, headers: { ...cors, 'Content-Type': 'application/json' } });
  }

  // ზუსტად იგივე query, რასაც EPJQI8FX/news.html თავად უშვებს
  // initAdminSession()-ში (news.html:339), anon key + caller-ის საკუთარი
  // JWT-ით -- ანუ იგივე RLS policy-ის ქვეშ, არა service_role-ით გვერდის ავლით.
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
    console.log('trigger-prerender', userId, 'NOT_ADMIN');
    return new Response(JSON.stringify({ ok: false, error: 'admin required' }),
      { status: 403, headers: { ...cors, 'Content-Type': 'application/json' } });
  }

  const GITHUB_DISPATCH_TOKEN = Deno.env.get('GITHUB_DISPATCH_TOKEN') || '';
  if (!GITHUB_DISPATCH_TOKEN) {
    console.log('trigger-prerender', userId, 'NO_DISPATCH_TOKEN_CONFIGURED');
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
        'User-Agent': 'fnf-ge-trigger-prerender',
      },
      body: JSON.stringify({ ref: 'main' }),
    });

    if (gres.status === 204) {
      console.log('trigger-prerender', userId, 'DISPATCHED');
      return new Response(JSON.stringify({ ok: true }),
        { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    // GitHub's own response -- status code and body -- is surfaced so the
    // admin sees why, but the dispatch token itself is never included here.
    const text = await gres.text();
    console.log('trigger-prerender', userId, 'GITHUB_FAIL', gres.status, text);
    return new Response(JSON.stringify({ ok: false, error: 'github dispatch failed', status: gres.status, body: text }),
      { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } });
  } catch (e) {
    console.log('trigger-prerender', userId, 'ERROR', (e as Error).message);
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }),
      { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
});
