// ============================================================
//  YOUTUBE VIDEO SYNC — Task 4, phase 1 (data layer)
//  GitHub Actions cron (youtube-sync.yml) — ყოველ 6 საათში.
//
//  სინქრონიზაციას უკეთებს public.youtube_videos ცხრილს არხის
//  (https://www.youtube.com/@FNFantasy) ატვირთვების playlist-იდან,
//  YouTube Data API v3-ით. არც ერთი ველი ხელით არ ივსება -- ყველაფერი
//  ამ სკრიპტიდან მოდის.
//
//  ნაბიჯები:
//  1. channels.list(forHandle=...) → uploads playlist ID (1 quota ერთეული)
//  2. playlistItems.list — არხის ყველა ატვირთვა თავ-ბოლო, pagination-ით
//     (1 ერთეული გვერდზე)
//  3. videos.list ნაწილ-ნაწილ 50-50 (50 id-მდე ერთ მოთხოვნაში, 1 ერთეული
//     ნაწილზე) — duration/privacyStatus/viewCount-ის მისაღებად
//  4. Shorts-ების გამორიცხვა — 60 წამზე ნაკლები ხანგრძლივობის ვიდეო
//     საერთოდ არ ინახება ბაზაში
//  5. ბაზაში native .upsert()-ით (onConflict: video_id) -- ეს
//     განზრახ გადახვევაა repo-ს დანარჩენი auto-სკრიპტების select→
//     insert/update პატერნისგან (Giorgi-ს დადასტურებული) -- სუფთა
//     კონტენტ-სინქია, settlement/concurrency რისკის გარეშე.
//  6. ნებისმიერი ადრე ნანახი video_id, რომელიც ამ გაშვებისას აღარ
//     ჩანდა არხის საჯარო ატვირთვების სიაში (დამალული/წაშლილი YouTube-ზე)
//     → is_published=false ამ ცხრილშიც. API-key-only playlistItems.list
//     მხოლოდ საჯარო ვიდეოებს აბრუნებს, ამიტომ ეს ერთადერთი გზაა
//     ასეთი ვიდეოს დასატყობად.
//
//  DRY_RUN=1 — ბაზაში არაფერს წერს, მხოლოდ რას ჩაწერდა ლოგავს
//  (nba-auto.js-ის იგივე DRY_RUN proxy-wrapper პატერნი).
// ============================================================

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_KEY;       // service_role
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const TG_TOKEN        = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT         = process.env.TELEGRAM_CHAT_ID || '';

const CHANNEL_HANDLE     = 'FNFantasy';  // https://www.youtube.com/@FNFantasy -- channels.list(forHandle=) არ ითხოვს "@"-ს
const YT_API             = 'https://www.googleapis.com/youtube/v3';
const SHORTS_MAX_SECONDS = 60;           // ამაზე ნაკლები ხანგრძლივობის ვიდეო ყოველთვის Short-ია -- იაფი pre-filter, ქსელის მოთხოვნის გარეშე
// YouTube-მა Shorts-ის მაქს. ხანგრძლივობა 3 წუთამდე გაზარდა -- მხოლოდ
// duration ამიერიდან საკმარისი აღარაა (იხ. isActuallyShort ქვემოთ). ეს
// ზედა ზღვარი მხოლოდ გადაწყვეტს, რომელ ვიდეოებს სჭირდება ქსელური
// გადამოწმება საერთოდ -- ამაზე გრძელი ვიდეო ცალსახად Short ვერ იქნება.
const SHORTS_CHECK_MAX_SECONDS = 180;
const UPSERT_BATCH       = 500;          // ერთ .upsert()-ში ჩასაწერი მაქს. რიგის რაოდენობა

// Task 4, phase 2: EPJQI8FX/admin.html-ის ღილაკს (და Telegram-ის "იუთუბი"
// ბრძანებას) workflow_dispatch-ის HTTP პასუხი არაფერს ეუბნება რეალური
// გაშვების შედეგზე (204 მაშინვე ბრუნდება, გაშვებამდეც კი) -- ამ გაშვების
// შედეგი აქ, app_state-ში იწერება, რომ supabase/functions/trigger-youtube-sync
// (საკუთარი, ავტომატურად მოწოდებული service_role-ით) უკან წაიკითხოს და
// ბრაუზერს დაუბრუნოს -- ბრაუზერი app_state-ს არასდროს ეხება პირდაპირ.
const APP_STATE_KEY = 'youtube_sync_last_run';

// DRY_RUN=1 → ჩაწერის ნაცვლად მხოლოდ ლოგავს (insert/update/unpublish); ბაზაში არაფერი იწერება
const DRY_RUN    = process.env.DRY_RUN === '1';
const DRY_REPORT = [];   // { action: 'insert'|'update'|'unpublish', video, detail }

if (!SUPABASE_URL || !SUPABASE_KEY || !YOUTUBE_API_KEY) {
  console.error('SUPABASE_URL / SUPABASE_KEY / YOUTUBE_API_KEY აუცილებელია');
  process.exit(1);
}
const _sb = createClient(SUPABASE_URL, SUPABASE_KEY);
// DRY_RUN backstop: ნებისმიერი insert/update/upsert/delete/rpc → throw
// (იგივე პატერნი, რასაც nba-auto.js/soccer-auto.js იყენებენ) -- select
// კითხვები მაინც გადის, რომ DRY_RUN-ზეც შევძლოთ არსებული რიგების დათვალიერება.
const sb = !DRY_RUN ? _sb : {
  from(table) {
    const q = _sb.from(table);
    const block = (op) => () => { throw new Error(`DRY_RUN: ${op} ${table} დაბლოკილია`); };
    return { select: (...a) => q.select(...a), insert: block('insert'), update: block('update'), upsert: block('upsert'), delete: block('delete') };
  },
  rpc(name) { throw new Error(`DRY_RUN: rpc ${name} დაბლოკილია`); },
};

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

async function fetchJSON(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url.split('?')[0]}: ${body?.error?.message || JSON.stringify(body)}`);
  return body;
}

async function sendTelegram(msg) {
  if (DRY_RUN) return;
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text: msg, parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) { log(`⚠ Telegram: ${e.message}`); }
}

// nba-auto.js-ის იგივე app_state upsert კონვენცია (key/value/updated_at,
// onConflict პარამეტრის გარეშე -- key უკვე პირველადი გასაღებია). ყოველთვის
// _sb-ით (არა DRY_RUN-wrapped sb-ით) -- DRY_RUN-ზე ზემოთა if-ი ისედაც
// აბრუნებს, ამ ფუნქციამდე არასდროს აღწევს.
async function writeAppState(value) {
  if (DRY_RUN) return;
  try {
    const { error } = await _sb.from('app_state').upsert({
      key: APP_STATE_KEY, value: JSON.stringify(value), updated_at: new Date().toISOString(),
    });
    if (error) log(`🚨 app_state ჩაწერა ჩავარდა: ${error.message}`);
  } catch (e) { log(`🚨 app_state ჩაწერა ჩავარდა: ${e.message}`); }
}

// ---------- ISO 8601 duration (PT#H#M#S) → წამები ----------
function isoDurationToSeconds(iso) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
  if (!m) return 0;
  const [, d, h, min, s] = m;
  return (Number(d) || 0) * 86400 + (Number(h) || 0) * 3600 + (Number(min) || 0) * 60 + (Number(s) || 0);
}
function formatMMSS(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return (h ? `${h}:${mm}` : mm) + ':' + String(s).padStart(2, '0');
}

// ---------- საუკეთესო ხელმისაწვდომი thumbnail ----------
function bestThumbnail(thumbs) {
  if (!thumbs) return null;
  return (thumbs.maxres || thumbs.standard || thumbs.high || thumbs.medium || thumbs.default || {}).url || null;
}

// ---------- 1) არხის uploads playlist ID ----------
async function resolveUploadsPlaylistId() {
  const url = `${YT_API}/channels?part=contentDetails&forHandle=${CHANNEL_HANDLE}&key=${YOUTUBE_API_KEY}`;
  const data = await fetchJSON(url);
  const uploadsId = data?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsId) throw new Error(`არხის uploads playlist ვერ მოიძებნა (@${CHANNEL_HANDLE})`);
  return uploadsId;
}

// ---------- 2) ატვირთვების playlist-ის სრული, გვერდებად წაკითხვა ----------
async function fetchAllPlaylistItems(playlistId) {
  const items = [];
  let pageToken = '';
  let quotaUnits = 0;
  do {
    const url = `${YT_API}/playlistItems?part=snippet,contentDetails&maxResults=50&playlistId=${playlistId}&key=${YOUTUBE_API_KEY}`
      + (pageToken ? `&pageToken=${pageToken}` : '');
    const data = await fetchJSON(url);
    quotaUnits++;
    for (const item of data.items || []) {
      const videoId = item?.contentDetails?.videoId;
      if (videoId) items.push({ videoId, snippet: item.snippet });
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return { items, quotaUnits };
}

// ---------- 3) videos.list 50-50 ნაწილად — duration/status/viewCount ----------
async function fetchVideoDetails(videoIds) {
  const details = new Map();
  let quotaUnits = 0;
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const url = `${YT_API}/videos?part=snippet,contentDetails,status,statistics&id=${batch.join(',')}&key=${YOUTUBE_API_KEY}`;
    const data = await fetchJSON(url);
    quotaUnits++;
    for (const v of data.items || []) details.set(v.id, v);
  }
  return { details, quotaUnits };
}

// ---------- 4) Shorts-ის ავტორიტეტული შემოწმება ----------
// YouTube /shorts/<id> URL-ზე პირდაპირ 200-ით პასუხობს ზუსტად მაშინ, როცა
// ეს ვიდეო რეალურად Short-ია -- ნებისმიერი ჩვეულებრივი ატვირთვა იმავე
// URL-დან 303-ით გადამისამართდება /watch?v=<id>-ზე. ეს ის გვერდია, საიდანაც
// YouTube-ის საკუთარი აპებიც არჩევენ Short-ს ჩვეულებრივი ვიდეოსგან --
// empirical-ად დადასტურებული (lt3QNTTrVPY, 68 წმ, duration-only წესს
// გამორჩა: /shorts/lt3QNTTrVPY → HTTP 200, Location არ არის; ამ არხის
// ჩვეულებრივი ვიდეოები კი ყველა 303-ით მიდის /watch-ზე) -- ამიტომ
// ავტორიტეტულია, არა ევრისტიკა. redirect:'manual' საჭიროა, რომ fetch
// თავად არ გაჰყვეს redirect-ს -- სტატუსი და Location თავად გვჭირდება.
async function isActuallyShort(videoId) {
  const res = await fetch(`https://www.youtube.com/shorts/${videoId}`, {
    method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(15000),
  });
  if (res.status === 200) return true;                      // /shorts/-ზევე დარჩა -- ნამდვილი Short
  if (res.status >= 300 && res.status < 400) return false;   // გადამისამართდა /watch-ზე -- არ არის Short
  throw new Error(`/shorts/ პასუხი მოულოდნელია: HTTP ${res.status}`);
}

async function main() {
  log(`▶️ YouTube sync — დაწყება${DRY_RUN ? ' (DRY_RUN)' : ''}`);
  let totalQuota = 0;

  const uploadsId = await resolveUploadsPlaylistId();
  totalQuota += 1;
  log(`uploads playlist: ${uploadsId}`);

  const { items: playlistItems, quotaUnits: q1 } = await fetchAllPlaylistItems(uploadsId);
  totalQuota += q1;
  log(`playlistItems: ნაპოვნია ${playlistItems.length} ვიდეო (${q1} გვერდი)`);

  const videoIds = playlistItems.map(p => p.videoId);
  const { details, quotaUnits: q2 } = await fetchVideoDetails(videoIds);
  totalQuota += q2;
  log(`videos.list: წამოღებულია ${details.size} ვიდეოს დეტალი (${q2} ნაწილი)`);

  // არსებული რიგები — insert/update კლასიფიკაციისთვის ანგარიშში (წერის
  // ლოგიკას არ ცვლის -- .upsert() ყოველთვის ბრმად გადაწერს). ეს select
  // DRY_RUN-ზეც გადის (wrapper-ი მხოლოდ writes-ს ბლოკავს).
  const { data: existingRows, error: existingErr } = await sb
    .from('youtube_videos')
    .select('video_id,title,thumbnail_url,duration_seconds,view_count,is_published');
  if (existingErr) throw new Error(`არსებული რიგების წაკითხვა ჩავარდა: ${existingErr.message}`);
  const existingByVideoId = new Map((existingRows || []).map(r => [r.video_id, r]));

  const seenVideoIds = new Set();
  // /shorts/ შემოწმება ვერ დასრულდა ამ ვიდეოზე ამ გაშვებაზე (ქსელის
  // შეცდომა/ვადა) -- toHide-მ ეს ვიდეო არ უნდა ჩათვალოს "გაქრაო", თორემ
  // დროებითი ქსელის ავარია შეცდომით დამალავდა ნამდვილად საჯარო ვიდეოს.
  const checkFailedIds = new Set();
  const rows = [];
  let skippedShorts = 0, skippedNoDuration = 0;

  for (const pi of playlistItems) {
    const v = details.get(pi.videoId);
    if (!v) { skippedNoDuration++; continue; }  // videos.list-ში არ გამოჩნდა (წაშლილი/დამუშავების პროცესშია)

    const durationSeconds = isoDurationToSeconds(v.contentDetails?.duration);
    if (!durationSeconds) { skippedNoDuration++; continue; }  // მიმდინარე ლაივი ან ჯერ არ დამუშავებული — შემდეგ გაშვებაზე

    if (durationSeconds < SHORTS_MAX_SECONDS) { skippedShorts++; continue; }  // 60წმ-ზე ნაკლები -- ცალსახად Short, ქსელური შემოწმება არც კი სჭირდება

    // 60-180წმ შუალედი ორაზროვანია (YouTube-ის გაზრდილი Shorts ზღვრის
    // გამო) -- მხოლოდ აქ გვჭირდება ავტორიტეტული /shorts/ redirect-შემოწმება.
    if (durationSeconds <= SHORTS_CHECK_MAX_SECONDS) {
      let isShort;
      try {
        isShort = await isActuallyShort(pi.videoId);
      } catch (e) {
        log(`⚠ ${pi.videoId}: /shorts/ შემოწმება ჩავარდა (${e.message}) — გამოტოვებული ამ გაშვებაზე, ხელახლა ეცდება შემდეგზე`);
        checkFailedIds.add(pi.videoId);
        continue;
      }
      if (isShort) { skippedShorts++; continue; }  // Short დადასტურდა -- საერთოდ არ ინახება
    }

    seenVideoIds.add(pi.videoId);
    const row = {
      video_id:         pi.videoId,
      title:            v.snippet?.title || pi.snippet?.title || '(სათაურის გარეშე)',
      thumbnail_url:    bestThumbnail(v.snippet?.thumbnails) || bestThumbnail(pi.snippet?.thumbnails),
      duration_seconds: durationSeconds,
      view_count:       Number(v.statistics?.viewCount) || 0,
      published_at:     v.snippet?.publishedAt || pi.snippet?.publishedAt,
      is_published:     v.status?.privacyStatus === 'public',
      updated_at:       new Date().toISOString(),
    };
    rows.push(row);

    const ex = existingByVideoId.get(row.video_id);
    if (!ex) {
      DRY_REPORT.push({ action: 'insert', video: row.title, detail: `${row.video_id}, ${formatMMSS(row.duration_seconds)}, ${row.view_count} ნახვა` });
    } else if (ex.title !== row.title || ex.thumbnail_url !== row.thumbnail_url
      || ex.duration_seconds !== row.duration_seconds || Number(ex.view_count) !== row.view_count
      || ex.is_published !== row.is_published) {
      DRY_REPORT.push({ action: 'update', video: row.title, detail: `${row.video_id}, ნახვები ${ex.view_count}→${row.view_count}` });
    }
  }

  // ადრე ნანახი, ახლა საჯარო სიიდან გამქრალი ვიდეოები → is_published=false.
  // checkFailedIds გამორიცხულია განზრახ -- მათზე უბრალოდ არ ვიცით ამ
  // გაშვებაზე (/shorts/ შემოწმება ჩავარდა), ეს არ ნიშნავს რომ გაქრნენ.
  const toHide = (existingRows || [])
    .filter(r => r.is_published && !seenVideoIds.has(r.video_id) && !checkFailedIds.has(r.video_id))
    .map(r => r.video_id);
  for (const videoId of toHide) DRY_REPORT.push({ action: 'unpublish', video: videoId, detail: 'აღარ ჩანს არხის საჯარო ატვირთვების სიაში' });

  log(`დამუშავდა: ${rows.length} ჩაიწერება, ${skippedShorts} Shorts გამოტოვებული, ${skippedNoDuration} დეტალის გარეშე (ლაივი/დამუშავების პროცესში)`);

  if (DRY_RUN) {
    const n = (a) => DRY_REPORT.filter(r => r.action === a).length;
    log(`DRY_RUN ანგარიში: ${n('insert')} ახალი, ${n('update')} განახლდება, ${n('unpublish')} დაიმალება`);

    const newest = [...rows].sort((a, b) => new Date(b.published_at) - new Date(a.published_at)).slice(0, 5);
    log('ყველაზე ახალი 5 ვიდეო:');
    for (const r of newest) {
      log(`  "${r.title}" — ${formatMMSS(r.duration_seconds)} — ${r.view_count} ნახვა — ${r.published_at} (${r.video_id})`);
    }
  } else {
    let written = 0;
    for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
      const batch = rows.slice(i, i + UPSERT_BATCH);
      const { error } = await sb.from('youtube_videos').upsert(batch, { onConflict: 'video_id' });
      if (error) { log(`🚨 upsert ჩავარდა (${i}-${i + batch.length}): ${error.message}`); continue; }
      written += batch.length;
    }
    log(`ჩაწერილი/განახლებული: ${written}/${rows.length}`);

    if (toHide.length) {
      const { error: hideErr } = await sb.from('youtube_videos')
        .update({ is_published: false, updated_at: new Date().toISOString() })
        .in('video_id', toHide);
      if (hideErr) log(`🚨 is_published=false ჩავარდა: ${hideErr.message}`);
      else log(`დამალულია (აღარ ჩანს საჯარო სიაში): ${toHide.length} ვიდეო`);
    }
  }

  log(`დასრულდა — YouTube API quota ~${totalQuota} ერთეული ამ გაშვებაზე`);
  if (!DRY_RUN) {
    const n = (a) => DRY_REPORT.filter(r => r.action === a).length;
    const summary = {
      ok: true, at: new Date().toISOString(),
      inserted: n('insert'), updated: n('update'), unpublished: n('unpublish'), skipped_shorts: skippedShorts,
    };
    await writeAppState(summary);
    await sendTelegram(`📺 <b>YouTube sync</b>\n\n${summary.inserted} ახალი, ${summary.updated} განახლდა, ${summary.unpublished} დაიმალა\n${skippedShorts} Shorts გამოტოვებული\nquota: ~${totalQuota}`);
  }
}

main().catch(async (e) => {
  console.error(e);
  await writeAppState({ ok: false, at: new Date().toISOString(), error: (e.message || String(e)).slice(0, 500) });
  await sendTelegram(`🚨 <b>youtube-sync.js ჩავარდა (Fatal error)</b>\n\n<code>${(e.message || String(e)).slice(0, 500)}</code>\n\n➡️ საჭიროა ხელით შემოწმება.`);
  process.exit(1);
});
