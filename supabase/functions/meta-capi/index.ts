// ============================================================
//  meta-capi — Supabase Edge Function
//  ივენთს სერვერიდან უგზავნის Meta Conversions API-ს (browser + server dedup).
//  უნივერსალურია: event_name body-დან მოაქვს (default CompleteRegistration),
//  ამიტომ რეგისტრაციასაც, ticketPlaced-საც და PageView-საც ემსახურება.
//
//  Secrets (Supabase Dashboard → Edge Functions → Secrets):
//    META_PIXEL_ID   = 964984466586376
//    META_CAPI_TOKEN = <access token>
//
//  კლიენტი იძახებს:
//    fetch(SUPABASE_URL + '/functions/v1/meta-capi', { method:'POST',
//      headers:{'Content-Type':'application/json'},
//      body: JSON.stringify({ event_name, event_id, email, phone, fbp, fbc,
//                             url, external_id, gender }) })
//
//  დედუპლიკაცია: იგივე event_id უნდა გაიგზავნოს ბრაუზერის fbq()/GTM-შიც.
//
//  --- ცვლილებები 2026-10-29 ---
//  1) ტელეფონს ქვეყნის კოდი ემატება. Meta ელოდება 995XXXXXXXXX-ს, app.js-ის
//     normalizePhone() კი 995-ს აჭრის და ბაზაში 9 ციფრი ინახება — ამის გამო
//     აქამდე გაგზავნილი ტელეფონის არცერთი hash არ ემთხვეოდა.
//  2) fbc სარეზერვო გზა: თუ cookie ცარიელია, მაგრამ url-ში fbclid დევს,
//     fbc აქვე აეწყობა.
//  3) gender (male/female -> m/f), თუ კლიენტი გამოგზავნის.
//  4) Graph API v18.0 -> v26.0 (v18-ს ვადა ამოეწურა).
// ============================================================

const META_PIXEL_ID = Deno.env.get('META_PIXEL_ID') || '';
const META_CAPI_TOKEN = Deno.env.get('META_CAPI_TOKEN') || '';
const GRAPH_VERSION = 'v26.0';

// ნებადართული ივენთები — რომ თვითნებური event_name არ გაიგზავნოს
const ALLOWED_EVENTS = new Set(['CompleteRegistration', 'ticketPlaced', 'PageView']);

async function sha256(s: string): Promise<string> {
  const data = new TextEncoder().encode(s.trim().toLowerCase());
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Meta ელოდება მხოლოდ ციფრებს, ქვეყნის კოდით, '+'-ის გარეშე: 995XXXXXXXXX
function phoneForMeta(raw: string): string {
  let d = String(raw || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 10 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 9) d = '995' + d;
  return d;
}

// fbc ფორმატი: fb.1.<timestamp>.<fbclid>
function fbcFromUrl(u: string): string {
  try {
    const id = new URL(u).searchParams.get('fbclid');
    return id ? 'fb.1.' + Date.now() + '.' + id : '';
  } catch (_e) { return ''; }
}

function genderForMeta(raw: string): string {
  const g = String(raw || '').trim().toLowerCase();
  if (g === 'male' || g === 'm') return 'm';
  if (g === 'female' || g === 'f') return 'f';
  return '';
}

Deno.serve(async (req) => {
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
    console.log('meta-capi', 'BLOCKED_ORIGIN', origin || '(none)');
    return new Response(JSON.stringify({ ok: false, error: 'origin not allowed' }),
      { status: 403, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405, headers: cors });

  if (!META_PIXEL_ID || !META_CAPI_TOKEN) {
    return new Response(JSON.stringify({ ok: false, error: 'secrets not configured' }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* ცარიელი body-იც მისაღებია */ }

  const reqName = typeof body.event_name === 'string' ? body.event_name : '';
  const eventName = ALLOWED_EVENTS.has(reqName) ? reqName : 'CompleteRegistration';
  // Phase 2: CompleteRegistration and ticketPlaced must come from a signed-in user.
  // email and external_id are taken from the verified token, never from the body.
  const AUTH_REQUIRED = new Set(['CompleteRegistration', 'ticketPlaced']);
  const authHeader = req.headers.get('authorization') || '';
  const bearer = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
  let tokenUserId = '';
  let tokenEmail = '';
  if (bearer) {
    try {
      const ures = await fetch(Deno.env.get('SUPABASE_URL') + '/auth/v1/user', {
        headers: { apikey: Deno.env.get('SUPABASE_ANON_KEY') || '', Authorization: 'Bearer ' + bearer },
      });
      if (ures.ok) {
        const u = await ures.json();
        tokenUserId = (u && u.id) || '';
        tokenEmail = (u && u.email) || '';
      }
    } catch (_e) { /* ტოკენი ვერ გადამოწმდა */ }
  }
  if (AUTH_REQUIRED.has(eventName) && !tokenUserId) {
    console.log('meta-capi', eventName, 'NO_AUTH');
    return new Response(JSON.stringify({ ok: false, error: 'auth required' }),
      { status: 401, headers: { ...cors, 'Content-Type': 'application/json' } });
  }

  const prefix = eventName === 'ticketPlaced' ? 'tkt' : eventName === 'PageView' ? 'pv' : 'reg';
  const eventId = typeof body.event_id === 'string' && body.event_id ? body.event_id : prefix + '_' + crypto.randomUUID();
  const email = tokenEmail;
  const phone = tokenUserId ? phoneForMeta(typeof body.phone === 'string' ? body.phone : '') : '';
  const fbp = typeof body.fbp === 'string' ? body.fbp : '';
  const externalId = tokenUserId;
  const url = typeof body.url === 'string' ? body.url : 'https://fnf.ge/';
  const gender = tokenUserId ? genderForMeta(typeof body.gender === 'string' ? body.gender : '') : '';
  const testEventCode = Deno.env.get('META_TEST_EVENT_CODE') || '';

  // fbc: ჯერ კლიენტის cookie, თუ ცარიელია — url-ის fbclid-დან
  let fbc = typeof body.fbc === 'string' ? body.fbc : '';
  if (!fbc) fbc = fbcFromUrl(url);

  const userData: Record<string, unknown> = {
    client_ip_address: (req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for')?.split(',')[0] || '').trim() || undefined,
    client_user_agent: req.headers.get('user-agent') || undefined,
  };
  if (email) userData.em = [await sha256(email)];
  if (phone) userData.ph = [await sha256(phone)];
  if (gender) userData.ge = [await sha256(gender)];
  if (fbp) userData.fbp = fbp;
  if (fbc) userData.fbc = fbc;
  if (externalId) userData.external_id = [await sha256(externalId)];

  const payload: Record<string, unknown> = {
    data: [{
      event_name: eventName,
      event_time: Math.floor(Date.now() / 1000),
      event_id: eventId,                 // ბრაუზერის fbq-ს იგივე ID → Deduplicated
      action_source: 'website',
      event_source_url: url,
      user_data: userData,
    }],
  };
  if (testEventCode) payload.test_event_code = testEventCode;

  try {
    const res = await fetch(
      'https://graph.facebook.com/' + GRAPH_VERSION + '/' + META_PIXEL_ID + '/events?access_token=' + META_CAPI_TOKEN,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
    );
    const out = await res.json();
    console.log('meta-capi', eventName, res.ok ? 'OK' : 'FAIL', JSON.stringify(out));
    return new Response(JSON.stringify({ ok: res.ok, meta: out }),
      { status: res.ok ? 200 : 502, headers: { ...cors, 'Content-Type': 'application/json' } });
  } catch (e) {
    console.log('meta-capi', eventName, 'ERROR', (e as Error).message);
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }),
      { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
});
