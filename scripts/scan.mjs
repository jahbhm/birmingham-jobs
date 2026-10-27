#!/usr/bin/env node
/**
 * Rescan Southeast insurance-brokerage job openings and rewrite index.html.
 *
 * Runs on GitHub Actions every 5 hours. No npm dependencies — Node 20+ only.
 *
 * Design notes:
 *  - The page keeps its data in one <script type="application/json" id="data"> block.
 *    We replace ONLY that block, never the CSS/markup/behaviour below it.
 *  - If anything fails validation we exit non-zero WITHOUT writing, so a bad run
 *    leaves the last known-good page live rather than publishing garbage.
 *  - "applied" checkmarks in the reader's browser are keyed on title+employer,
 *    so the model is told to keep those strings stable across runs.
 *
 * Env:
 *   ANTHROPIC_API_KEY  required
 *   MODEL              optional, default claude-haiku-5-5
 *   PAGE               optional, default ./index.html
 *   MAX_SEARCHES       optional, default 12 — this is the main cost lever.
 *                      Web search bills per search, so this caps spend per run.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const API_KEY      = process.env.ANTHROPIC_API_KEY;
const MODEL        = process.env.MODEL || 'claude-haiku-5-5';
const PAGE         = resolve(process.env.PAGE || './index.html');
const MAX_SEARCHES = Math.max(1, parseInt(process.env.MAX_SEARCHES || '12', 10));

const OPEN  = '<script type="application/json" id="data">';
const CLOSE = '</script>';

if (!API_KEY) {
  console.error('FATAL: ANTHROPIC_API_KEY is not set.');
  console.error('Add it under Settings -> Secrets and variables -> Actions.');
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * 1. Read the live page and pull out the current dataset
 * ------------------------------------------------------------------ */

let html;
try {
  html = readFileSync(PAGE, 'utf8');
} catch (e) {
  console.error(`FATAL: cannot read ${PAGE} — ${e.message}`);
  process.exit(1);
}

const start = html.indexOf(OPEN);
if (start === -1) {
  console.error('FATAL: data block not found. Was index.html edited by hand?');
  process.exit(1);
}
const dataStart = start + OPEN.length;
const dataEnd = html.indexOf(CLOSE, dataStart);
if (dataEnd === -1) {
  console.error('FATAL: data block is not closed.');
  process.exit(1);
}

let previous;
try {
  previous = JSON.parse(html.slice(dataStart, dataEnd));
} catch (e) {
  console.error(`FATAL: existing data block is not valid JSON — ${e.message}`);
  process.exit(1);
}

const priorKeys = new Set(
  (previous.jobs || []).map(j => `${j.title}|${j.employer}`.toLowerCase())
);
console.log(`Loaded ${priorKeys.size} listings from the previous scan.`);

/* ------------------------------------------------------------------ *
 * 2. Ask Claude to research and return a fresh dataset
 * ------------------------------------------------------------------ */

const CITIES = {
  'Birmingham, AL': 0, 'Tuscaloosa, AL': 60, 'Montgomery, AL': 90,
  'Huntsville, AL': 100, 'Atlanta, GA': 150, 'Alpharetta, GA': 175,
  'Nashville, TN': 190, 'Mobile, AL': 260, 'Remote': 0
};

const PROMPT = `Research currently-open insurance brokerage job openings in the US Southeast and return them as JSON.

## CANDIDATE
December 2026 finance graduate. Completed an insurance internship at CAC / The Baldwin Group in Birmingham, Alabama. Needs a job STARTING JANUARY 2027. Willing to get an Alabama P&C or Life & Health license. Based in Birmingham.

## GEOGRAPHIC PRIORITY — strict order
1. Birmingham, AL — the priority. Search this hardest.
2. Rest of Alabama, nearest first: Tuscaloosa (60mi), Montgomery (90mi), Huntsville (100mi), Mobile (260mi).
3. Out of state, nearest first: Atlanta GA (150mi), Alpharetta GA (175mi), Nashville TN (190mi).
4. Fully remote roles welcome at any tier — set city to "Remote".
Nothing further out than Atlanta/Nashville unless remote or an exceptional named program.

## EMPLOYERS TO CHECK BY NAME
The Baldwin Group / CAC / CAC Specialty (HIGHEST PRIORITY — he interned there), Marsh McLennan Agency, McGriff, EPIC Insurance Brokers, Higginbotham, Arthur J. Gallagher / Gallagher Bassett, The Hilb Group, Aon, WTW, Brown & Brown, Risk Strategies, USI, Alliant, NFP, Hub International, Alfa Insurance, Liberty Mutual, Swiss Re, Beazley, Chubb, Travelers, plus regional Birmingham agencies.

## TITLES TO INCLUDE
Account Coordinator, Client Service Associate/Specialist, Account Administrator, Associate Account Manager, Commercial Lines Account Manager, Producer Trainee, Entry Level Producer, Benefits Analyst, Claims Trainee, Underwriting Trainee/Analyst, Risk Analyst, and rotational or early-career analyst programs.

EXCLUDE: roles requiring 5+ years; commission-only 1099 captive sales (final expense, door-to-door); anything outside the radius that is not remote.

## WHERE TO SEARCH — cover all of these
Major aggregators: Indeed, LinkedIn Jobs, Glassdoor, ZipRecruiter, SimplyHired, Monster, CareerBuilder, Google Jobs.
Early-career boards: Handshake, WayUp, RippleMatch, Built In, college job boards.
Industry boards: InsurancePond, GreatInsuranceJobs, Big I (Independent Insurance Agents), Alabama Independent Insurance Agents, Jobs in Insurance.
Employer careers sites directly, plus the ATS platforms they run on: Workday, Greenhouse, Lever, iCIMS, SmartRecruiters, Taleo, Paylocity, CareerPlug, Jobvite.

Run SEPARATE searches by employer name, by job title, and by city — a single broad sweep misses most of the market.

## LIST EVERY DISTINCT OPENING — DO NOT MERGE
If an employer has three Account Coordinator reqs open, list all three. Separate requisitions are separate opportunities and missing one is far worse than showing one too many. Never collapse roles just because the titles look alike.

The only thing to avoid is listing the IDENTICAL single posting twice because you found it on two different boards. When that happens, keep one and prefer the better link:
 1. The employer's own careers page or ATS (Workday, Greenhouse, Lever, iCIMS…)
 2. An industry board (InsurancePond, GreatInsuranceJobs)
 3. A major aggregator (Indeed, LinkedIn, ZipRecruiter, Glassdoor)

When you are not certain whether two postings are the same req or two openings, INCLUDE BOTH. Err toward showing more.

## EVERY ENTRY NEEDS A WORKING LINK
Every job must have a "url" to that specific posting. Never emit an entry without one. If no direct per-posting link exists, link to the employer's careers-page search results and begin the note with "Employer careers page — search by title."

Prefer the employer's OWN careers-page URL over an aggregator when both exist. Direct links survive longer and the page labels them as "(direct)", which signals a better-quality lead.

## DATE POSTED
Set "posted" to the date the employer published the listing, as "YYYY-MM-DD", whenever the posting or the search result states it. Job boards usually show this as "Posted 3 days ago", "Active 2 days ago" or an explicit date — convert relative phrasing to an actual date using today's date.

Set "posted" to null when you genuinely cannot tell. Do NOT guess, and do NOT substitute today's date as a placeholder — the page falls back to the date a scan first saw the listing, which is honest, whereas a fabricated date would push a stale role to the top of the board.

## PRESERVING THE READER'S CHECKMARKS
The page tracks "applied" by hashing title + employer, NOT url. When a job also appeared in the previous list below, reuse its "title" and "employer" strings EXACTLY, character for character, even if the url changed. Altering them silently erases his checkmark.

## PREVIOUS SCAN — use for the isNew flag
${JSON.stringify((previous.jobs || []).map(j => ({ title: j.title, employer: j.employer })), null, 1)}

Any job NOT in that list gets "isNew": true. Any job already in it gets "isNew": false.
Drop listings that have clearly been taken down. If unsure, keep it — a stale link beats a missed opening.

## TIERS
"alumni"   = Baldwin / CAC only
"major"    = other large brokers in Birmingham
"regional" = Alabama outside Birmingham
"program"  = named early-career / rotational programs, mostly Atlanta & Nashville

## START FIELD
"Rolling" if it starts when filled. Exactly "verify start" if it looks like a mid-2027 cohort program rather than a January start — the page filters on this, so be accurate.

## OUTPUT
Return ONLY a JSON object, no prose, no markdown fence:

{
  "updated": "<ISO 8601 with -06:00 offset>",
  "cities": ${JSON.stringify(CITIES)},
  "jobs": [
    { "title": "", "employer": "", "city": "<a key in cities>", "pay": "<or 'Not listed'>",
      "start": "Rolling", "url": "https://...", "posted": "YYYY-MM-DD or null",
      "tier": "alumni|major|regional|program",
      "isNew": false, "note": "one or two plain sentences on fit, no hype" }
  ]
}

Aim for 15-30 solid listings. Quality over volume — skip anything you cannot link.`;

async function callClaude() {
  const body = {
    model: MODEL,
    max_tokens: 16000,
    messages: [{ role: 'user', content: PROMPT }],
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: MAX_SEARCHES }]
  };

  // Retry on transient failures: rate limit, overload, 5xx.
  const MAX_TRIES = 4;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    let res;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify(body)
      });
    } catch (e) {
      console.error(`  network error on attempt ${attempt}: ${e.message}`);
      if (attempt === MAX_TRIES) throw e;
      await sleep(attempt * 5000);
      continue;
    }

    if (res.ok) return res.json();

    const text = await res.text().catch(() => '');
    const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
    console.error(`  HTTP ${res.status} on attempt ${attempt}${retryable ? ' (retrying)' : ''}`);
    if (!retryable || attempt === MAX_TRIES) {
      throw new Error(`Anthropic API ${res.status}: ${text.slice(0, 400)}`);
    }
    await sleep(attempt * 8000);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

console.log(`Researching with ${MODEL} (search budget: ${MAX_SEARCHES})…`);
let reply;
try {
  reply = await callClaude();
} catch (e) {
  console.error(`FATAL: research call failed — ${e.message}`);
  console.error('Page left untouched.');
  process.exit(1);
}

// Concatenate text blocks; skip the server-side search tool blocks.
const text = (reply.content || [])
  .filter(b => b.type === 'text')
  .map(b => b.text)
  .join('')
  .trim();

if (reply.usage) {
  const u = reply.usage;
  console.log(`Tokens — in: ${u.input_tokens}, out: ${u.output_tokens}` +
    (u.server_tool_use ? `, searches: ${u.server_tool_use.web_search_requests}` : ''));
}

if (!text) {
  console.error('FATAL: model returned no text. Page left untouched.');
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * 3. Parse and validate before touching the page
 * ------------------------------------------------------------------ */

function extractJson(s) {
  // Tolerate a stray ```json fence or leading prose.
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) s = fenced[1];
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a === -1 || b === -1 || b < a) throw new Error('no JSON object found');
  return JSON.parse(s.slice(a, b + 1));
}

let data;
try {
  data = extractJson(text);
} catch (e) {
  console.error(`FATAL: could not parse model output — ${e.message}`);
  console.error('First 500 chars:\n' + text.slice(0, 500));
  process.exit(1);
}

const problems = [];

if (!Array.isArray(data.jobs) || data.jobs.length === 0) {
  problems.push('jobs array is missing or empty');
}
if (!data.cities || typeof data.cities !== 'object') {
  data.cities = CITIES; // non-fatal, just restore it
}

const TIERS = new Set(['alumni', 'major', 'regional', 'program']);

(data.jobs || []).forEach((j, i) => {
  const where = `job[${i}] ${j.title || '(untitled)'}`;
  if (!j.title || !j.employer) problems.push(`${where}: missing title or employer`);
  if (!j.url || !/^https?:\/\//i.test(j.url)) problems.push(`${where}: missing or malformed url`);
  if (!TIERS.has(j.tier)) problems.push(`${where}: bad tier "${j.tier}"`);
  if (!j.note) problems.push(`${where}: missing note`);

  // Repair rather than reject for these.
  if (data.cities[j.city] == null) {
    console.warn(`  note: unknown city "${j.city}" on ${j.title} — filing as Remote`);
    j.city = 'Remote';
  }
  if (j.start !== 'Rolling' && j.start !== 'verify start') {
    j.start = 'Rolling';
  }

  // A posted date must be a real date, and must not be in the future —
  // a hallucinated date would sort a stale listing to the top of the board.
  if (j.posted) {
    const t = Date.parse(j.posted);
    if (isNaN(t) || t > Date.now() + 86400000) {
      console.warn(`  note: dropping implausible posted date "${j.posted}" on ${j.title}`);
      j.posted = null;
    } else {
      j.posted = new Date(t).toISOString().slice(0, 10);
    }
  } else {
    j.posted = null;
  }

  // Trust our own diff over the model's.
  j.isNew = !priorKeys.has(`${j.title}|${j.employer}`.toLowerCase());
});

// A scan returning almost nothing means the research failed, not that the
// market emptied out. Merging (below) makes this non-destructive either way.
if ((data.jobs || []).length < 3) {
  problems.push(`only ${data.jobs.length} listings returned — treating as a failed scan`);
}

if (problems.length) {
  console.error('FATAL: validation failed. Page left untouched.');
  problems.slice(0, 20).forEach(p => console.error('  - ' + p));
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * 3b. Merge into the existing board rather than replacing it
 *
 * Any single scan sees a partial slice of the market — a different set of
 * search results, a model that stopped early, an aggregator that was slow.
 * Replacing wholesale means a thin Tuesday deletes what a good Monday found.
 * So the board accumulates: new finds get added, existing ones get refreshed,
 * and a listing is only dropped after it's gone missing MISS_LIMIT scans in a
 * row — about three days at two scans a day.
 * ------------------------------------------------------------------ */

const MISS_LIMIT = 6;
const keyOf = j => `${j.title}|${j.employer}`.toLowerCase();
const TODAY = new Date().toISOString().slice(0, 10);

const merged = new Map();

// Start from what's already on the board.
for (const old of previous.jobs || []) {
  merged.set(keyOf(old), { ...old, isNew: false });
}

let added = 0, refreshed = 0;

for (const found of data.jobs) {
  const k = keyOf(found);
  const old = merged.get(k);

  if (old) {
    // Still live — refresh details, but never move firstSeen: it's the anchor
    // the page sorts on when a listing has no stated posted date.
    merged.set(k, {
      ...old, ...found,
      firstSeen: old.firstSeen || TODAY,
      posted: found.posted || old.posted || null,
      isNew: false, _miss: 0
    });
    refreshed++;
  } else {
    merged.set(k, { ...found, firstSeen: TODAY, isNew: true, _miss: 0 });
    added++;
  }
}

// Age out anything this scan didn't see.
const seen = new Set(data.jobs.map(keyOf));
let dropped = 0, aging = 0;

for (const [k, j] of merged) {
  if (seen.has(k)) continue;
  j._miss = (j._miss || 0) + 1;
  if (j._miss >= MISS_LIMIT) {
    merged.delete(k);
    dropped++;
  } else {
    aging++;
  }
}

data.jobs = [...merged.values()];

console.log(
  `\nMerge: ${added} added, ${refreshed} refreshed, ` +
  `${aging} not seen this scan (kept), ${dropped} aged out.`
);


/* ------------------------------------------------------------------ *
 * 3c. Verify every link before publishing
 *
 * A board full of 404s is worse than a short board. But most job aggregators
 * actively block automated requests, so "didn't return 200" cannot mean
 * "dead" — that would wipe everything on the first run.
 *
 * Three outcomes:
 *   ok       2xx/3xx — confirmed live
 *   dead     404 or 410 — the server explicitly says it's gone
 *   unknown  403 / 429 / 999 / 5xx / timeout / network error — the site
 *            refused to answer. Keep the listing, mark it unverified.
 *
 * A listing is only dropped after TWO consecutive scans report it dead, so a
 * one-off blip can't delete a real opening.
 * ------------------------------------------------------------------ */

const DEAD_LIMIT   = 2;
const LINK_TIMEOUT = 10000;
const CONCURRENCY  = 6;

// Some sites 404 anything that looks like a bot; a normal UA avoids that.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Phrases a board shows when the req is filled or pulled but the URL still
// returns 200. These are the ones that only appear on an expired posting —
// deliberately specific, because something like "no longer" on its own would
// match ordinary job-description prose.
const EXPIRED_PHRASES = [
  'no longer available',
  'no longer accepting applications',
  'no longer accepting online applications',
  'is no longer active',
  'no longer open',
  'this job has expired',
  'this posting has expired',
  'this listing has expired',
  'job posting has expired',
  'posting is no longer',
  'this position has been filled',
  'this job has been filled',
  'position is closed',
  'this job is closed',
  'applications are closed',
  'job posting has been removed',
  'this job post is closed',
  'the job you are looking for is not available',
  'this job may no longer be available',
  'unfortunately, this job is not available',
  'this job ad has expired'
];

const MAX_BODY = 1_500_000;   // don't pull multi-MB pages

function looksExpired(html) {
  // Strip tags and collapse whitespace so phrases split across markup match.
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .toLowerCase();

  for (const p of EXPIRED_PHRASES) {
    if (text.includes(p)) return p;
  }
  return null;
}

async function checkLink(url) {
  const opts = {
    redirect: 'follow',
    signal: AbortSignal.timeout(LINK_TIMEOUT),
    headers: { 'user-agent': UA, 'accept': 'text/html,application/xhtml+xml' }
  };

  try {
    // GET rather than HEAD: a filled posting often still returns 200, so the
    // only way to know is to read what the page actually says.
    const res = await fetch(url, { ...opts, method: 'GET' });

    if (res.status === 404 || res.status === 410) return { verdict: 'dead' };
    if (!(res.status >= 200 && res.status < 400)) {
      return { verdict: 'unknown' };   // 403, 429, 999 (LinkedIn), 5xx — blocked, not gone
    }

    const type = res.headers.get('content-type') || '';
    const len  = parseInt(res.headers.get('content-length') || '0', 10);
    if (!type.includes('html') || len > MAX_BODY) {
      return { verdict: 'ok' };        // can't read it, but it answered
    }

    const body = await res.text();
    if (body.length > MAX_BODY) return { verdict: 'ok' };

    const phrase = looksExpired(body);
    if (phrase) return { verdict: 'expired', phrase };

    return { verdict: 'ok' };
  } catch (e) {
    return { verdict: 'unknown' };     // timeout, DNS failure, TLS error
  }
}

async function verifyAll(jobs) {
  const queue = [...jobs];
  const tally = { ok: 0, dead: 0, expired: 0, unknown: 0 };

  async function worker() {
    while (queue.length) {
      const j = queue.shift();
      const { verdict, phrase } = await checkLink(j.url);
      tally[verdict]++;
      j.link = verdict;
      j.linkChecked = TODAY;
      if (phrase) j.expiredPhrase = phrase; else delete j.expiredPhrase;

      // 404 and "no longer available" both mean gone; same two-strike rule.
      if (verdict === 'dead' || verdict === 'expired') {
        j._dead = (j._dead || 0) + 1;
      } else {
        j._dead = 0;
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return tally;
}

console.log(`\nVerifying ${data.jobs.length} links…`);
const tally = await verifyAll(data.jobs);

const confirmedGone = data.jobs.filter(j => j._dead >= DEAD_LIMIT);
const pending       = data.jobs.filter(j => j._dead === 1);

if (confirmedGone.length) {
  console.log(`Removing ${confirmedGone.length} listing(s) gone on two consecutive scans:`);
  confirmedGone.forEach(j => console.log(
    `  ✗ ${j.title} — ${j.employer}` +
    (j.expiredPhrase ? `  ("${j.expiredPhrase}")` : '  (404)')
  ));
}
if (pending.length) {
  console.log(`${pending.length} listing(s) flagged once — kept, will drop if still gone next scan:`);
  pending.forEach(j => console.log(
    `  ? ${j.title} — ${j.employer}` +
    (j.expiredPhrase ? `  ("${j.expiredPhrase}")` : '  (404)')
  ));
}

data.jobs = data.jobs.filter(j => (j._dead || 0) < DEAD_LIMIT);

console.log(
  `Links: ${tally.ok} live, ${tally.unknown} unverifiable (site blocked the check), ` +
  `${tally.dead} returned 404, ${tally.expired} say the job has closed.`
);

// If nearly everything came back dead, something is wrong with the checker
// rather than with every listing at once. Don't let it empty the board.
const goneCount = tally.dead + tally.expired;
if (goneCount > 0 && goneCount >= Math.floor(data.jobs.length * 0.8) && tally.ok === 0) {
  console.error('FATAL: almost every link reported dead and none verified live.');
  console.error('That points at the checker, not the listings. Page left untouched.');
  process.exit(1);
}

data.updated = new Date().toISOString();

/* ------------------------------------------------------------------ *
 * 4. Splice the new data in
 * ------------------------------------------------------------------ */

const rebuilt =
  html.slice(0, dataStart) + '\n' + JSON.stringify(data, null, 1) + '\n' + html.slice(dataEnd);

// Paranoia: confirm the page we're about to write still parses.
try {
  const vs = rebuilt.indexOf(OPEN) + OPEN.length;
  const ve = rebuilt.indexOf(CLOSE, vs);
  JSON.parse(rebuilt.slice(vs, ve));
} catch (e) {
  console.error(`FATAL: rebuilt page failed self-check — ${e.message}`);
  process.exit(1);
}

writeFileSync(PAGE, rebuilt);

const fresh = data.jobs.filter(j => j.isNew);
const bham  = data.jobs.filter(j => j.city === 'Birmingham, AL').length;

console.log(`\nWrote ${data.jobs.length} listings (${bham} in Birmingham), ${fresh.length} new.`);
if (fresh.length) {
  console.log('\nNew since last scan:');
  fresh.forEach(j => console.log(`  • ${j.title} — ${j.employer} (${j.city})\n    ${j.url}`));
}
