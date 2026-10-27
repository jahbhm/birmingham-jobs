# Birmingham Insurance Job Board

A self-updating job board for entry-level insurance brokerage roles, Birmingham AL first, then outward by distance.

GitHub Actions runs the scan on a schedule, rewrites `index.html`, and commits. Vercel redeploys on the commit. Nothing depends on a laptop being awake.

```
GitHub Actions (cron)
   └─ scripts/scan.mjs
        └─ Anthropic API + web search
             └─ rewrites index.html
                  └─ git commit
                       └─ Vercel auto-deploys
```

---

## Setup — about 10 minutes, once

### 1. Create the repo

```bash
cd path/to/this/folder
git init
git add .
git commit -m "Job board"
git branch -M main
git remote add origin https://github.com/YOURNAME/birmingham-jobs.git
git push -u origin main
```

Make it **public** — GitHub Actions minutes are unlimited on public repos. Nothing sensitive lives here; the listings are public postings and the reader's checkmarks never leave his browser.

### 2. Add the API key

Get a key at **console.anthropic.com → API Keys**.

In the repo: **Settings → Secrets and variables → Actions → New repository secret**

| Name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | `sk-ant-...` |

Set a spend limit while you're in the console — **Settings → Limits**. $10/month is a sensible ceiling and protects you from a runaway loop.

### 3. Let Actions write to the repo

**Settings → Actions → General → Workflow permissions** → select **Read and write permissions** → Save.

Without this the scan runs fine but the `git push` fails.

### 4. Connect Vercel

At **vercel.com/new**, import the repo. Leave every build setting at its default — framework preset "Other", no build command, output directory blank. It's a static file.

You'll get a URL like `birmingham-jobs.vercel.app`. That's the link to send.

### 5. Test it

**Actions → Scan job listings → Run workflow.** Watch the log. A healthy run ends with something like:

```
Loaded 19 listings from the previous scan.
Researching with claude-haiku-5-5 (search budget: 12)…
Tokens — in: 58210, out: 7430, searches: 11

Wrote 23 listings (9 in Birmingham), 4 new.
```

---

## What it costs

This is the part worth reading before you leave it running.

Web search bills **$10 per 1,000 searches**, and that dominates everything else — the Haiku tokens are rounding error next to it. Per run at the default budget of 12 searches, you're looking at roughly **$0.13**.

| Schedule | Cron | Runs/mo | Est. cost/mo |
|---|---|---|---|
| Every 5h, all week | `0 */5 * * *` | ~146 | ~$19 |
| Every 5h, weekdays | `0 */5 * * 1-5` | ~110 | ~$14 |
| **Every 12h, weekdays** (current) | `0 13,23 * * 1-5` | ~44 | **~$6** |
| Once daily, weekdays | `0 13 * * 1-5` | ~22 | ~$3 |

Currently set to **twice a day on weekdays — 7am and 5pm Central.** The morning run means fresh listings are waiting when he sits down; the evening run catches whatever was posted during the business day.

That's the sweet spot. Broker postings turn over on a daily cadence, not an hourly one — a req posted Tuesday morning is still there Wednesday. Scanning five times a day mostly re-reads the same listings at full search cost.

To change it, edit the `cron:` line in `.github/workflows/scan.yml` and push. Note that GitHub cron is UTC and doesn't observe daylight saving, so these fire an hour later in Central terms from March to November.

### Other cost levers

Both are repository *variables* (**Settings → Secrets and variables → Actions → Variables**), so you can change them without touching code:

| Variable | Default | Effect |
|---|---|---|
| `MAX_SEARCHES` | `12` | The main dial. `8` cuts per-run cost to ~$0.09; below ~6 the research gets visibly thinner. |
| `MODEL` | `claude-haiku-5-5` | `claude-sonnet-5-5` finds better matches and writes sharper notes, at maybe 3-4× the token cost — still small next to search spend. Worth trying for a week if the listings feel shallow. |

---

## How it protects itself

A bad scan is worse than no scan, so `scan.mjs` refuses to publish unless everything checks out. On any failure it exits non-zero, writes nothing, and the last good page stays live.

It bails if the API call fails after 4 retries, if the model returns unparseable output, if any job is missing a working `http(s)` link, if a tier value is wrong, or if the result set collapses to under 40% of the previous count — that last one catches the failure mode where a scan half-works and would otherwise wipe most of the board.

It repairs rather than rejects two things: an unrecognized city gets filed as Remote, and a malformed `start` value falls back to `Rolling`.

It also recomputes the `isNew` flags itself from the previous commit rather than trusting the model's own bookkeeping.

---

## The reader's checkmarks

Each listing has an **Applied** checkbox and a **Hide** button. Both persist in whatever browser he's using, via `localStorage`.

They're keyed on a hash of **title + employer**, deliberately not the URL — aggregator links rotate constantly, and keying on them would reset his progress every scan. The scan prompt instructs the model to keep those two strings byte-identical for jobs that carry over.

Consequences worth knowing: his checkmarks don't sync between his laptop and his phone, and clearing site data wipes them. That's the tradeoff for having no accounts, no database, and no monthly hosting bill. If he wants cross-device sync later, that needs a real backend and a different conversation.

---

## Files

```
index.html                     the whole page — markup, styles, behaviour, data
scripts/scan.mjs               research + rewrite; no npm dependencies, Node 20+
.github/workflows/scan.yml     the schedule
```

`index.html` keeps its data in one block:

```html
<script type="application/json" id="data"> { ... } </script>
```

The scan replaces **only** what's between those tags. Everything else is yours to edit freely — restyle it, reword the footer, add a section. Just don't hand-edit that JSON block while a scan might be running, and don't change those tags, or the scan will no longer find its anchor and will exit with "data block not found."

---

## Troubleshooting

**Workflow didn't fire on schedule.** GitHub's scheduled runs are best-effort and the free queue is lowest priority — delays of 10-30 minutes are normal, and runs occasionally skip under heavy load. If it hasn't fired in a day, check that the repo isn't dormant; GitHub disables scheduled workflows on public repos after 60 days without a commit, and emails you first.

**"data block not found."** `index.html` was edited in a way that broke the anchor tags. Restore them, or `git revert` to the last bot commit.

**Push step fails.** Workflow permissions are still read-only. Step 3 above.

**Nothing commits, run after run.** That's success, not failure — listings genuinely didn't change. The workflow skips empty commits on purpose.

**401 from the API.** The secret is missing, misnamed, or the key was revoked. It must be named exactly `ANTHROPIC_API_KEY`.
