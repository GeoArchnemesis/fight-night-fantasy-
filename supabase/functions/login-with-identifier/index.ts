// supabase/functions/login-with-identifier/index.ts
// Fight Night Fantasy — login by email, nickname, or phone + password (R5 part 2)
//
// NOT auto-deployed. There is no GitHub Actions workflow watching this path
// (deploy-bot.yml only watches supabase/functions/telegram-bot/**) — deploy
// manually with the supabase CLI when ready, see the command in the PR/
// commit notes.
//
// Why this exists as an edge function instead of a plain anon-callable SQL
// RPC: resolving a nickname/phone to its account email has to happen before
// the caller is authenticated, so the resolver would have to be callable by
// `anon` — and the anon key is embedded in every frontend file, i.e.
// effectively public. A bare "resolve_login_email(identifier) returns text"
// RPC would let anyone script through guessed nicknames/phone numbers and
// harvest real registered email addresses with no password required at all.
// Doing the resolution AND the sign-in in one server-side step, using the
// service_role client, means the real email and any "does this identifier
// exist" signal never reach the browser — the only way to learn anything is
// to already have a correct password for that account, exactly like a
// normal login.
//
// Contract:
//   request:  POST { identifier: string, password: string }
//             (frontend only calls this for identifiers that do NOT contain
//             '@' — an '@'-containing input keeps using
//             sb.auth.signInWithPassword(email, password) directly, unchanged)
//   success:  200 { ok: true, session: <Supabase auth session object> }
//   failure:  401 { ok: false }   — ALWAYS this exact shape, regardless of
//             whether the identifier didn't match, matched 2+ accounts
//             (e.g. a phone number shared by more than one user — treated
//             identically to no-match, never guesses which account), or the
//             password was wrong. A distinguishable "no such user" response
//             would turn this into the same enumeration oracle this design
//             is meant to avoid.
//
// Known residual limitation (disclosed, not fixed here — would need its own
// reviewed change if it ever matters): no rate limiting at this layer. The
// Supabase project's own throttling applies to its /auth/v1 endpoints, not
// to a custom Edge Function reached via /functions/v1/<name>, so this does
// not add brute-force protection beyond whatever already exists for a
// direct signInWithPassword call.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1'

const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  // R6: confirmed root cause of "login by nickname/phone always fails" —
  // the real supabase-js client always sends `apikey` and `x-client-info`
  // on every functions.invoke() call (verified directly against the actual
  // library, not assumed), and neither was in this allow-list. Every real
  // browser's CORS preflight blocked the POST before it ever reached this
  // function — reproduced live with a headless Chromium against the
  // deployed function: "Request header field x-client-info is not allowed
  // by Access-Control-Allow-Headers in preflight response."
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info',
}

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

function fail() {
  return new Response(JSON.stringify({ ok: false }), { status: 401, headers: corsHeaders })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('OK', { status: 200, headers: corsHeaders })
  if (req.method !== 'POST') return new Response('OK', { status: 200, headers: corsHeaders })

  let body: { identifier?: string; password?: string }
  try {
    body = await req.json()
  } catch {
    return fail()
  }

  const identifier = (body.identifier || '').trim()
  const password = body.password || ''
  if (!identifier || !password || identifier.includes('@')) return fail()

  // Two separate .eq() lookups (never a hand-built .or() filter string) —
  // the identifier is fully attacker-controlled and unauthenticated, and
  // PostgREST's .or() syntax is a comma/paren-delimited mini-language that
  // raw user input could otherwise manipulate. .eq() is always safely
  // parameterized. A Set of emails correctly collapses the (extremely
  // unlikely) case where the same account matches both nick and phone down
  // to one match, while two genuinely different accounts still count as
  // ambiguous.
  const [{ data: byNick, error: nickErr }, { data: byPhone, error: phoneErr }] = await Promise.all([
    admin.from('users').select('email').eq('nick', identifier),
    admin.from('users').select('email').eq('phone', identifier),
  ])
  if (nickErr || phoneErr) return fail()

  const emails = new Set<string>()
  for (const row of byNick || []) if (row.email) emails.add(row.email)
  for (const row of byPhone || []) if (row.email) emails.add(row.email)
  if (emails.size !== 1) return fail()

  const email = [...emails][0]
  const { data: signInData, error: signInErr } = await admin.auth.signInWithPassword({ email, password })
  if (signInErr || !signInData?.session) return fail()

  return new Response(JSON.stringify({ ok: true, session: signInData.session }), {
    status: 200,
    headers: corsHeaders,
  })
})
