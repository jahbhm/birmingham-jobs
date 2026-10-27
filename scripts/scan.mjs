#!/usr/bin/env node
/**
 * Rescan job openings for two independent searches and rewrite index.html.
 *
 *   insurance  — entry-level brokerage roles, for a Dec-2026 finance grad
 *   technology — Senior Director and executive technology leadership
 *
 * Both cover the same geography: Birmingham first, outward to Texas.
 * Runs on GitHub Actions. No npm dependencies — Node 20+ only.
 *
 * Design notes:
 *  - The page keeps its data in one <script type="application/json" id="data"> block.
 *    We replace ONLY that block, never the CSS/markup/behaviour below it.
 *  - If anything fails validation we exit non-zero WITHOUT writing, so a bad run
 *    leaves the last known-good page live rather than publishing garbage.
 *  - "applied" checkmarks live in the reader's browser, keyed on
 *    track+title+employer+city, so the model is told to keep those stable.
 *  - A failure in one track never touches the other track's listings.
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
  (previous.jobs || []).map(j => `${j.track || 'insurance'}|${j.title}|${j.employer}|${j.city}`.toLowerCase())
);
{
  const byTrack = {};
  (previous.jobs || []).forEach(j => {
    const t = j.track || 'insurance';
    byTrack[t] = (byTrack[t] || 0) + 1;
  });
  console.log(`Loaded ${priorKeys.size} listings from the previous scan ` +
    `(${Object.entries(byTrack).map(([t, n]) => `${t}: ${n}`).join(', ') || 'none'}).`);
}

/* ------------------------------------------------------------------ *
 * 2. Ask Claude to research and return a fresh dataset
 * ------------------------------------------------------------------ */

// Driving miles from Birmingham. Texas is the outer bound.
const CITIES = {
  'Birmingham, AL': 0,
  'Tuscaloosa, AL': 60,  'Montgomery, AL': 90,   'Huntsville, AL': 100,
  'Atlanta, GA': 150,    'Chattanooga, TN': 150, 'Columbus, GA': 160,
  'Alpharetta, GA': 175, 'Nashville, TN': 190,
  'Jackson, MS': 240,    'Memphis, TN': 240,     'Knoxville, TN': 260,
  'Mobile, AL': 260,     'Pensacola, FL': 270,   'Greenville, SC': 300,
  'New Orleans, LA': 340,'Baton Rouge, LA': 370, 'Louisville, KY': 370,
  'Charlotte, NC': 380,  'Little Rock, AR': 400, 'Jacksonville, FL': 420,
  'Raleigh, NC': 500,    'Shreveport, LA': 500,  'Orlando, FL': 530,
  'Tampa, FL': 530,      'Dallas, TX': 650,      'Fort Worth, TX': 680,
  'Houston, TX': 680,    'Miami, FL': 760,       'Austin, TX': 780,
  'San Antonio, TX': 850,
  'Remote': 0
};

const INSURANCE_PROMPT = `Research currently-open insurance brokerage job openings in the US Southeast and return them as JSON.

## CANDIDATE
December 2026 finance graduate. Completed an insurance internship at CAC / The Baldwin Group in Birmingham, Alabama. Needs a job STARTING JANUARY 2027. Willing to get an Alabama P&C or Life & Health license. Based in Birmingham.

## GEOGRAPHIC PRIORITY — strict order
1. Birmingham, AL — THE priority. Search this hardest and return the most results here.
2. Rest of Alabama: Tuscaloosa (60mi), Montgomery (90mi), Huntsville (100mi), Mobile (260mi).
3. Neighbouring states, nearest first: Atlanta & Columbus GA, Chattanooga / Nashville / Memphis / Knoxville TN, Jackson MS, Pensacola & Jacksonville FL, New Orleans & Baton Rouge LA, Greenville SC, Charlotte & Raleigh NC, Louisville KY, Little Rock AR.
4. Outer bound — TEXAS. Dallas, Fort Worth, Houston, Austin and San Antonio are all in scope. Also Orlando, Tampa and Miami FL.
5. Fully remote roles welcome at any distance — set city to "Remote".

Texas is the furthest anything should be. Do NOT return roles in California, the Northeast, the Midwest beyond Louisville, or the Mountain West unless they are fully remote.

DISTANCE IS A TIEBREAK, NOT A QUOTA. A strong Birmingham opening always beats a strong Houston one, but include the Houston one too — the board sorts by distance and he can filter.

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

The only thing to avoid is listing the IDENTICAL single posting twice because you found it on two different boards. When that happens, emit ONE entry: put the best link in "url" and EVERY other URL for that same posting in "alsoOn".

Best link order for "url":
 1. The employer's own careers page or ATS (Workday, Greenhouse, Lever, iCIMS…)
 2. An industry board (InsurancePond, GreatInsuranceJobs)
 3. A major aggregator (Indeed, LinkedIn, ZipRecruiter, Glassdoor)

Always populate "alsoOn" when a posting appears on more than one site — do not discard the extra URLs. The page shows each site as its own tag, and the scan falls back to them if the main link dies. Example:

  "url": "https://baldwin.wd1.myworkdayjobs.com/...",
  "alsoOn": ["https://www.indeed.com/viewjob?jk=...", "https://www.linkedin.com/jobs/view/..."]

Use an empty array when it's only on one site.

When you are not certain whether two postings are the same req or two separate openings, INCLUDE BOTH as separate entries. Err toward showing more.

## EVERY ENTRY NEEDS A WORKING LINK
Every job must have a "url" to that specific posting. Never emit an entry without one. If no direct per-posting link exists, link to the employer's careers-page search results and begin the note with "Employer careers page — search by title."

Prefer the employer's OWN careers-page URL over an aggregator when both exist. Direct links survive longer and the page labels them as "(direct)", which signals a better-quality lead.

## DATE POSTED
Set "posted" to the date the employer published the listing, as "YYYY-MM-DD", whenever the posting or the search result states it. Job boards usually show this as "Posted 3 days ago", "Active 2 days ago" or an explicit date — convert relative phrasing to an actual date using today's date.

Set "posted" to null when you genuinely cannot tell. Do NOT guess, and do NOT substitute today's date as a placeholder — the page falls back to the date a scan first saw the listing, which is honest, whereas a fabricated date would push a stale role to the top of the board.

## PRESERVING THE READER'S CHECKMARKS
The page tracks "applied" by hashing title + employer + city, NOT url. When a job also appeared in the previous list below, reuse its "title", "employer" and "city" values EXACTLY, character for character, even if the url changed. Altering them silently erases his checkmark.

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
      "start": "Rolling", "url": "https://...", "alsoOn": ["https://...", "https://..."],
      "posted": "YYYY-MM-DD or null",
      "tier": "alumni|major|regional|program",
      "isNew": false, "note": "one or two plain sentences on fit, no hype" }
  ]
}

Aim for 15-30 solid listings. Quality over volume — skip anything you cannot link.`;

const TECHNOLOGY_PROMPT = `Research currently-open SENIOR TECHNOLOGY LEADERSHIP roles and return them as JSON.

## CANDIDATE
An experienced digital/engineering leader based in Birmingham, Alabama, currently running engineering for a media organisation. Looking at Senior Director and executive-level technology roles. Not an individual-contributor search.

## SENIORITY — this is the hard filter
INCLUDE: Senior Director, Director, Head of Engineering/Technology/Digital/Product, VP / SVP / EVP of Engineering or Technology, Chief Technology Officer, Chief Information Officer, Chief Digital Officer, Chief Product Officer, Head of Platform, Senior Director of IT, Director of Software Engineering, VP of Digital.

EXCLUDE ABSOLUTELY: individual contributor roles at any level (Senior Engineer, Staff, Principal Engineer, Architect with no reports), Engineering Manager and Senior Engineering Manager, Scrum Master, Project Manager, Technical Lead, Product Manager below Director, and anything with "Associate", "Junior" or "Entry" in the title. If a posting does not clearly manage managers or own an entire function, LEAVE IT OUT.

## GEOGRAPHIC PRIORITY — same radius as the other search
1. Birmingham, AL — THE priority. Search this hardest.
2. Rest of Alabama: Huntsville (100mi, strong tech/defence market), Montgomery, Tuscaloosa, Mobile.
3. Neighbouring states, nearest first: Atlanta GA, Chattanooga / Nashville / Memphis / Knoxville TN, Jackson MS, New Orleans & Baton Rouge LA, Greenville SC, Charlotte & Raleigh NC, Louisville KY, Little Rock AR, Jacksonville / Orlando / Tampa FL.
4. Outer bound — TEXAS. Dallas, Fort Worth, Houston, Austin, San Antonio.
5. FULLY REMOTE roles are high value at this level — include them generously, city "Remote".

Texas is the furthest. No California, Northeast, Midwest beyond Louisville, or Mountain West unless fully remote.

## SECTORS WORTH EXTRA ATTENTION
Media and broadcast, streaming and OTT, publishing, non-profit and faith-based organisations, healthcare systems, financial services and insurance technology, higher education, utilities, and logistics — these match his background. But do not restrict the search to them.

## WHERE TO SEARCH — cover all of these
Major aggregators: LinkedIn Jobs, Indeed, Glassdoor, ZipRecruiter, Google Jobs, Monster, CareerBuilder.
Executive and tech-specific: Built In, Dice, The Ladders, ExecThread, Otta, Hired, Wellfound, RemoteRocketship, We Work Remotely, FlexJobs.
Employer careers sites and ATS platforms: Workday, Greenhouse, Lever, iCIMS, SmartRecruiters, Taleo, Ashby, Jobvite.
Also check executive search listings when the hiring company is named.

Run SEPARATE searches by title, by city, and by sector.

## LIST EVERY DISTINCT OPENING — DO NOT MERGE
If an employer has two director-level reqs open, list both. Never collapse roles because the titles look similar.

The only thing to avoid is listing the IDENTICAL posting twice from two boards. Then emit ONE entry: best link in "url", every other URL in "alsoOn".

Best link order for "url":
 1. Employer careers page or ATS
 2. A tech-specific board (Built In, Dice)
 3. A major aggregator (LinkedIn, Indeed, ZipRecruiter, Glassdoor)

Always populate "alsoOn" when a posting is on several sites. Use an empty array when it is only on one.

When unsure whether two postings are the same req or two openings, INCLUDE BOTH.

## EVERY ENTRY NEEDS A WORKING LINK
Every job must have a "url" to that specific posting. Never emit an entry without one. If no per-posting link exists, link to the employer's careers-page search results and begin the note with "Employer careers page — search by title."

## DATE POSTED
Set "posted" to the publication date as "YYYY-MM-DD" when the posting or search result states it; convert "3 days ago" style phrasing using today's date. Set it to null when you cannot tell. Never guess and never substitute today's date.

## COMPENSATION
Include the salary band in "pay" whenever it is published — it matters a great deal at this level. Use "Not listed" when it genuinely isn't shown.

## PRESERVING THE READER'S CHECKMARKS
When a job also appeared in the previous list below, reuse its "title", "employer" and "city" values EXACTLY, character for character, even if the url changed.

## PREVIOUS SCAN — use for the isNew flag
${JSON.stringify((previous.jobs || []).filter(j => j.track === 'technology').map(j => ({ title: j.title, employer: j.employer })), null, 1)}

Anything not in that list is new. Drop listings clearly taken down; when unsure, keep.

## TIERS
"exec"     = VP, SVP, EVP, CTO, CIO, CDO, CPO, Chief anything
"director" = Senior Director, Director, Head of
"regional" = anything leadership-level that fits neither cleanly

## START FIELD
Always "Rolling" for this search unless a posting explicitly names a future cohort start, in which case "verify start".

## OUTPUT
Return ONLY a JSON object, no prose, no markdown fence:

{
  "updated": "<ISO 8601 with -06:00 offset>",
  "cities": ${JSON.stringify(CITIES)},
  "jobs": [
    { "title": "", "employer": "", "city": "<a key in cities>", "pay": "<band or 'Not listed'>",
      "start": "Rolling", "url": "https://...", "alsoOn": [],
      "posted": "YYYY-MM-DD or null",
      "tier": "exec|director|regional",
      "isNew": false, "note": "one or two plain sentences on fit, no hype" }
  ]
}

Aim for 15-30 solid listings. Quality over volume — skip anything you cannot link, and skip anything below Director.`;

async function callClaude(prompt) {
  const body = {
    model: MODEL,
    max_tokens: 16000,
    messages: [{ role: 'user', content: prompt }],
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

/* ------------------------------------------------------------------ *
 * 2b. Research each track
 *
 * Two independent searches share this board: the insurance search and the
 * technology-leadership search. They get separate prompts and separate API
 * calls — one combined prompt produces muddled results, because the
 * seniority filters are opposites (entry-level vs director-and-above).
 *
 * A failure in one track must not sink the other. Each is validated on its
 * own, and the run only aborts if BOTH come back unusable.
 * ------------------------------------------------------------------ */

const TIERS_BY_TRACK = {
  insurance:  new Set(['alumni', 'major', 'regional', 'program']),
  technology: new Set(['exec', 'director', 'regional'])
};

function extractJson(s) {
  // Tolerate a stray ```json fence or leading prose.
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) s = fenced[1];
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a === -1 || b === -1 || b < a) throw new Error('no JSON object found');
  return JSON.parse(s.slice(a, b + 1));
}

async function researchTrack(track, prompt) {
  console.log(`\n── ${track} ─────────────────────────────`);
  console.log(`Researching with ${MODEL} (search budget: ${MAX_SEARCHES})…`);

  let reply;
  try {
    reply = await callClaude(prompt);
  } catch (e) {
    console.error(`  research call failed — ${e.message}`);
    return null;
  }

  const text = (reply.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim();

  if (reply.usage) {
    const u = reply.usage;
    console.log(`  Tokens — in: ${u.input_tokens}, out: ${u.output_tokens}` +
      (u.server_tool_use ? `, searches: ${u.server_tool_use.web_search_requests}` : ''));
  }

  if (!text) {
    console.error('  model returned no text.');
    return null;
  }

  let parsed;
  try {
    parsed = extractJson(text);
  } catch (e) {
    console.error(`  could not parse model output — ${e.message}`);
    console.error('  first 300 chars: ' + text.slice(0, 300));
    return null;
  }

  if (!Array.isArray(parsed.jobs) || parsed.jobs.length < 3) {
    console.error(`  only ${(parsed.jobs || []).length} listings returned — treating as a failed scan.`);
    return null;
  }

  const validTiers = TIERS_BY_TRACK[track];
  const problems = [];
  const clean = [];

  for (const [i, j] of parsed.jobs.entries()) {
    const where = `${track}[${i}] ${j.title || '(untitled)'}`;

    if (!j.title || !j.employer) { problems.push(`${where}: missing title or employer`); continue; }
    if (!j.url || !/^https?:\/\//i.test(j.url)) { problems.push(`${where}: missing or malformed url`); continue; }
    if (!j.note) j.note = '';

    // Repair rather than reject.
    if (!validTiers.has(j.tier)) {
      j.tier = 'regional';
    }
    if (CITIES[j.city] == null) {
      console.warn(`  note: unknown city "${j.city}" on ${j.title} — filing as Remote`);
      j.city = 'Remote';
    }
    if (j.start !== 'Rolling' && j.start !== 'verify start') j.start = 'Rolling';

    if (Array.isArray(j.alsoOn)) {
      j.alsoOn = [...new Set(
        j.alsoOn.filter(u => typeof u === 'string' && /^https?:\/\//i.test(u) && u !== j.url)
      )];
    } else {
      j.alsoOn = [];
    }

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

    j.track = track;
    clean.push(j);
  }

  if (problems.length) {
    console.warn(`  skipped ${problems.length} malformed entr${problems.length === 1 ? 'y' : 'ies'}:`);
    problems.slice(0, 8).forEach(p => console.warn('    - ' + p));
  }

  if (clean.length < 3) {
    console.error(`  only ${clean.length} usable listings after validation — treating as failed.`);
    return null;
  }

  console.log(`  ${clean.length} usable listings.`);
  return clean;
}

// Run both tracks. Sequential rather than parallel so the log reads cleanly
// and the two searches don't contend for the same rate limit.
const insuranceJobs  = await researchTrack('insurance',  INSURANCE_PROMPT);
const technologyJobs = await researchTrack('technology', TECHNOLOGY_PROMPT);

if (!insuranceJobs && !technologyJobs) {
  console.error('\nFATAL: both searches failed. Page left untouched.');
  process.exit(1);
}
if (!insuranceJobs)  console.warn('\nInsurance search failed — keeping its existing listings untouched.');
if (!technologyJobs) console.warn('\nTechnology search failed — keeping its existing listings untouched.');

// Only the tracks that succeeded get refreshed; a failed track's existing
// listings pass through the merge unchanged rather than ageing out.
const freshTracks = new Set(
  [insuranceJobs && 'insurance', technologyJobs && 'technology'].filter(Boolean)
);

const data = {
  updated: new Date().toISOString(),
  repo: previous.repo,
  cities: CITIES,
  jobs: [...(insuranceJobs || []), ...(technologyJobs || [])]
};

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
// City is part of the key: the same title at the same employer in two cities
// is two openings, not one. Leaving it out silently merged them.
const keyOf = j => `${j.track || 'insurance'}|${j.title}|${j.employer}|${j.city}`.toLowerCase();
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
      // Union the mirrors: a board we saw last week is still worth keeping
      // as a fallback even if this scan didn't surface it.
      alsoOn: [...new Set([...(old.alsoOn || []), ...(found.alsoOn || [])])]
                .filter(u => u !== (found.url || old.url)),
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
  // A track whose research failed this run shouldn't have its listings aged out.
  if (!freshTracks.has(j.track || 'insurance')) continue;
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

let promoted = 0;

async function verifyAll(jobs) {
  const queue = [...jobs];
  const tally = { ok: 0, dead: 0, expired: 0, unknown: 0 };

  async function worker() {
    while (queue.length) {
      const j = queue.shift();
      let { verdict, phrase } = await checkLink(j.url);

      // The primary link is gone, but the same job may still be live on one of
      // the other boards it was posted to. Try those before writing it off.
      if ((verdict === 'dead' || verdict === 'expired') && (j.alsoOn || []).length) {
        for (const alt of j.alsoOn) {
          const retry = await checkLink(alt);
          if (retry.verdict === 'ok') {
            console.log(`  ↻ ${j.title} — primary link gone, promoting mirror:`);
            console.log(`      ${alt}`);
            j.alsoOn = [j.url, ...j.alsoOn.filter(u => u !== alt)];
            j.url = alt;
            verdict = 'ok';
            phrase = null;
            promoted++;
            break;
          }
        }
      }

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

const mirrored = data.jobs.filter(j => (j.alsoOn || []).length).length;

console.log(
  `Links: ${tally.ok} live, ${tally.unknown} unverifiable (site blocked the check), ` +
  `${tally.dead} returned 404, ${tally.expired} say the job has closed.`
);
console.log(
  `${mirrored} listing(s) are posted on more than one site` +
  (promoted ? `; ${promoted} rescued by falling back to a mirror.` : '.')
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

console.log('\n──────────────────────────────────────');
for (const t of ['insurance', 'technology']) {
  const inT  = data.jobs.filter(j => (j.track || 'insurance') === t);
  const bham = inT.filter(j => j.city === 'Birmingham, AL').length;
  const nw   = inT.filter(j => j.isNew).length;
  console.log(`${t.padEnd(11)} ${String(inT.length).padStart(3)} listings  ` +
    `(${bham} Birmingham, ${nw} new)`);
}
console.log(`${'total'.padEnd(11)} ${String(data.jobs.length).padStart(3)} listings`);

if (fresh.length) {
  console.log('\nNew since last scan:');
  for (const t of ['insurance', 'technology']) {
    const f = fresh.filter(j => (j.track || 'insurance') === t);
    if (!f.length) continue;
    console.log(`  [${t}]`);
    f.forEach(j => console.log(`    • ${j.title} — ${j.employer} (${j.city})\n      ${j.url}`));
  }
}
