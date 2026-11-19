// ============================================================
//  BUILD QUIZ PAGES — generates the three real, static quiz pages
//  (quiz/index.html, quiz/ufcquiz/index.html, quiz/footballquiz/index.html)
//  from one shared source template (scripts/templates/quiz-page.template.html)
//  plus this file's own per-page SEO config (PAGES below).
//
//  Why: Task 1 (quiz URL restructure) needs three real files/directories
//  so a direct visit or refresh on any of the three quiz URLs works on
//  static GitHub Pages (no server-side rewrites) -- but the quiz app's
//  markup/CSS/scripts must not be hand-duplicated three times, or the
//  copies will drift the next time something in the quiz changes. This
//  script is the single place that combines them: the shared body comes
//  from the template, the per-page title/description/og/twitter/
//  breadcrumb values come from PAGES below, never from whatever the
//  three output files already contain -- so re-running this after an
//  edit to the shared template is always safe and never clobbers one
//  page's SEO copy with another's (or with the template's own, which
//  carries no real copy at all, only placeholders).
//
//  Edit the shared quiz markup/CSS/scripts in the template file. Edit a
//  page's title/description/og/twitter copy, canonical URL or breadcrumb
//  trail in PAGES below. Never hand-edit the three generated files --
//  the next run overwrites them.
//
//  Usage:
//    node scripts/build-quiz-pages.js
// ============================================================

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const TEMPLATE_PATH = path.join(__dirname, 'templates', 'quiz-page.template.html');

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

// Exact Georgian SEO copy, agreed verbatim -- do not reword, translate, or
// add to any of these strings without checking first (see MoonUpdate.md
// standing rule: never invent user-facing site text).
// Exact strings from quiz/quiz.js's GAMETYPE_CARD_TEXT -- keep byte-identical
// with that object (the only reason this exists is to pre-paint the right
// sport's copy before quiz.js runs; quiz.js's own updateLandAbout() still
// re-applies the identical text/class at runtime, so a drift here would
// only ever show as a one-frame flash back to the correct text, never
// wrong text staying on screen).
const GAMETYPE_CARD_TEXT = {
  UFC: {
    quiz: 'კითხვები UFC-დან',
    guess: 'ფაქტებს გეტყვი მებრძოლებზე<br>ეცადე გამოიცნო ვისზეა საუბარი',
    guessTight: false,
  },
  Football: {
    quiz: 'კითხვები ფეხბურთიდან',
    guess: 'ფეხბურთთან დაკავშირებულ ფაქტებს გეტყვი<br>ეცადე გამოიცნო ვისზე ან რაზეა საუბარი',
    guessTight: true,
  },
};

const PAGES = [
  {
    outFile: 'quiz/index.html',
    canonical: 'https://fnf.ge/quiz/',
    title: 'ითამაშე სპორტული ქვიზი',
    description: "გამოსცადე შენი ცოდნა fnf.ge-ზე. ითამაშე UFC ან საფეხბურთო ქვიზი და გამოიცანი ვინ ვარ მე. ითამაშე მეგობრის წინააღმდეგ ონლაინ ან AI-ის წინააღმდეგ.",
    ogTitle: 'სპორტული ქვიზი | Fight Night Fantasy',
    ogDescription: 'რამდენად კარგად იცნობ სპორტს? ითამაშე UFC და საფეხბურთო ქვიზი fnf.ge-ზე.',
    breadcrumb: [
      { name: 'მთავარი', item: 'https://fnf.ge/' },
      { name: 'ქვიზი', item: 'https://fnf.ge/quiz/' },
    ],
    // bare /quiz/ shows screen-sport first -- no sport chosen yet, so this
    // matches quiz.js updateLandAbout()'s own UFC fallback for S.sport===null.
    gametype: GAMETYPE_CARD_TEXT.UFC,
  },
  {
    outFile: 'quiz/ufcquiz/index.html',
    canonical: 'https://fnf.ge/quiz/ufcquiz/',
    title: 'ითამაშე UFC ქვიზი',
    description: 'გამოსცადე შენი MMA-ს ცოდნა fnf.ge-ზე. ითამაშე ქვიზი ან გამოიცანი ვინ ვარ მე. ითამაშე მეგობრის წინააღმდეგ ონლაინ ან AI-ის წინააღმდეგ.',
    ogTitle: 'UFC ქვიზი | Fight Night Fantasy',
    ogDescription: 'რამდენად კარგად იცნობ MMA-ს? ითამაშე ქვიზი და გამოიცანი ვინ ვარ fnf.ge-ზე.',
    breadcrumb: [
      { name: 'მთავარი', item: 'https://fnf.ge/' },
      { name: 'ქვიზი', item: 'https://fnf.ge/quiz/' },
      { name: 'UFC ქვიზი', item: 'https://fnf.ge/quiz/ufcquiz/' },
    ],
    gametype: GAMETYPE_CARD_TEXT.UFC,
  },
  {
    outFile: 'quiz/footballquiz/index.html',
    canonical: 'https://fnf.ge/quiz/footballquiz/',
    title: 'ითამაშე საფეხბურთო ქვიზი',
    description: 'გამოსცადე შენი საფეხბურთო ცოდნა fnf.ge-ზე. ითამაშე ქვიზი ან გამოიცანი ვინ ვარ მე. ითამაშე მეგობრის წინააღმდეგ ონლაინ ან AI-ის წინააღმდეგ.',
    ogTitle: 'საფეხბურთო ქვიზი | Fight Night Fantasy',
    ogDescription: 'რამდენად კარგად იცნობ ფეხბურთს? ითამაშე ქვიზი და გამოიცანი ვინ ვარ fnf.ge-ზე.',
    breadcrumb: [
      { name: 'მთავარი', item: 'https://fnf.ge/' },
      { name: 'ქვიზი', item: 'https://fnf.ge/quiz/' },
      { name: 'საფეხბურთო ქვიზი', item: 'https://fnf.ge/quiz/footballquiz/' },
    ],
    gametype: GAMETYPE_CARD_TEXT.Football,
  },
];

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function breadcrumbJson(trail) {
  return trail
    .map((step, i) => {
      return `    { "@type": "ListItem", "position": ${i + 1}, "name": "${step.name}", "item": "${step.item}" }`;
    })
    .join(',\n');
}

function renderPage(template, page) {
  return template
    .replace(/__QUIZ_TITLE__/g, escapeHtml(page.title))
    .replace(/__QUIZ_DESCRIPTION__/g, escapeHtml(page.description))
    .replace(/__QUIZ_CANONICAL__/g, page.canonical)
    .replace(/__QUIZ_OG_TITLE__/g, escapeHtml(page.ogTitle))
    .replace(/__QUIZ_OG_DESCRIPTION__/g, escapeHtml(page.ogDescription))
    .replace(/__QUIZ_BREADCRUMB_JSON__/g, breadcrumbJson(page.breadcrumb))
    // These two carry literal markup (a <br>), exactly as quiz.js's
    // GAMETYPE_CARD_TEXT sets it via innerHTML/textContent at runtime --
    // not HTML-escaped, unlike the meta/title fields above.
    .replace(/__QUIZ_GAMETYPE_QUIZ_DESC__/g, () => page.gametype.quiz)
    .replace(/__QUIZ_GAMETYPE_GUESS_DESC__/g, () => page.gametype.guess)
    .replace(/__QUIZ_GAMETYPE_GUESS_DESC_CLASS__/g, page.gametype.guessTight ? 'gametype-desc--tight' : '');
}

function main() {
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  // Fail loudly if the template drifted and a placeholder got typo'd or
  // removed -- silently shipping a literal "__QUIZ_TITLE__" is worse than
  // refusing to write anything.
  const requiredPlaceholders = [
    '__QUIZ_TITLE__', '__QUIZ_DESCRIPTION__', '__QUIZ_CANONICAL__',
    '__QUIZ_OG_TITLE__', '__QUIZ_OG_DESCRIPTION__', '__QUIZ_BREADCRUMB_JSON__',
    '__QUIZ_GAMETYPE_QUIZ_DESC__', '__QUIZ_GAMETYPE_GUESS_DESC__', '__QUIZ_GAMETYPE_GUESS_DESC_CLASS__',
  ];
  for (const ph of requiredPlaceholders) {
    if (!template.includes(ph)) throw new Error(`template missing placeholder: ${ph}`);
  }

  let ok = 0;
  for (const page of PAGES) {
    const outPath = path.join(REPO_ROOT, page.outFile);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const html = renderPage(template, page);
    if (html.includes('__QUIZ_')) throw new Error(`unresolved placeholder left in ${page.outFile}`);
    fs.writeFileSync(outPath, html, 'utf8');
    log(`✓ ${page.outFile} written`);
    ok++;
  }
  log(`Done. ${ok} page(s) written.`);
}

main();
