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

## EVERY ENTRY NEEDS A WORKING LINK
Every job must have a "url" to that specific posting. Never emit an entry without one. If no direct per-posting link exists, link to the employer's careers-page search results and begin the note with "Employer careers page — search by title."

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
      "start": "Rolling", "url": "https://...", "tier": "alumni|major|regional|program",
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

  // Repair rather than reject for these two.
  if (data.cities[j.city] == null) {
    console.warn(`  note: unknown city "${j.city}" on ${j.title} — filing as Remote`);
    j.city = 'Remote';
  }
  if (j.start !== 'Rolling' && j.start !== 'verify start') {
    j.start = 'Rolling';
  }

  // Trust our own diff over the model's.
  j.isNew = !priorKeys.has(`${j.title}|${j.employer}`.toLowerCase());
});

// Guard against a bad run gutting the list.
if ((data.jobs || []).length < Math.max(5, Math.floor(priorKeys.size * 0.4))) {
  problems.push(
    `only ${data.jobs.length} listings returned vs ${priorKeys.size} previously — ` +
    `looks like a failed scan, refusing to publish`
  );
}

if (problems.length) {
  console.error('FATAL: validation failed. Page left untouched.');
  problems.slice(0, 20).forEach(p => console.error('  - ' + p));
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
