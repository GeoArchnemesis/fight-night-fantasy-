// ============================================================
//  INDEXNOW PING — notifies Bing/Yandex/other participating search
//  engines that specific fnf.ge URLs changed, so they can recrawl
//  without waiting for a scheduled pass.
//
//  DO NOT RUN THIS until after a real deploy. IndexNow verifies the key
//  by fetching https://fnf.ge/<key>.txt over the live site -- pinging
//  before that file is actually deployed will just fail (or, worse,
//  get silently ignored by engines that cache a bad verification).
//  There is no dry-run mode: this always makes a real network call to
//  api.indexnow.org, so only run it by hand after `git push` has landed
//  on GitHub Pages.
//
//  Usage (after deploy):
//    node scripts/indexnow-ping.js https://fnf.ge/ https://fnf.ge/news/some-article/
//  With no arguments, pings DEFAULT_URLS below (the pages this session's
//  internal-linking + breadcrumb work touched).
// ============================================================

const https = require('https');

const HOST = 'fnf.ge';
const KEY = '020ecdab8a2ae29e5551142faa47ddeb';
const KEY_LOCATION = `https://${HOST}/${KEY}.txt`;
const ENDPOINT = 'https://api.indexnow.org/indexnow';

const DEFAULT_URLS = [
  'https://fnf.ge/',
  'https://fnf.ge/ufc/',
  'https://fnf.ge/f1/',
  'https://fnf.ge/nba/',
  'https://fnf.ge/football/epl/',
  'https://fnf.ge/football/laliga/',
  'https://fnf.ge/football/seriea/',
  'https://fnf.ge/football/bundesliga/',
  'https://fnf.ge/football/ligue1/',
  'https://fnf.ge/football/ucl/',
  'https://fnf.ge/news/',
  'https://fnf.ge/news/merab-dvalishvili-fight-week/',
  'https://fnf.ge/en/news/',
  'https://fnf.ge/en/news/merab-dvalishvili-fight-week/',
];

function ping(urlList) {
  const payload = JSON.stringify({ host: HOST, key: KEY, keyLocation: KEY_LOCATION, urlList });
  return new Promise((resolve, reject) => {
    const req = https.request(
      ENDPOINT,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function main() {
  const urlList = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_URLS;

  const bad = urlList.filter((u) => !u.startsWith(`https://${HOST}/`));
  if (bad.length) {
    console.error(`Refusing to ping URL(s) outside https://${HOST}/: ${bad.join(', ')}`);
    process.exit(1);
  }

  console.log(`Pinging IndexNow with ${urlList.length} URL(s)...`);
  const { status, body } = await ping(urlList);
  console.log(`IndexNow responded ${status}: ${body || '(empty body)'}`);

  // 200 = submitted, 202 = accepted but key not verified yet. Anything
  // else (400/403/422/429) means something's wrong -- bad key, bad
  // host, or rate-limited -- and should fail the run, not go silent.
  if (status !== 200 && status !== 202) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
