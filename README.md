# Console Warrior

Automated WCAG 2.1 AA **structured accessibility review bot**, scoped to SOW S2.3.F:

- Contrast ratio check (major text elements)
- Keyboard navigation test
- Focus state verification
- Alt text audit
- Heading hierarchy review
- ARIA labels on interactive elements

Out of scope (not assessed, by design): full WCAG audit/certification, screen
reader testing (JAWS/NVDA), AODA/ADA legal compliance reporting.

This is the automated version of a manual "paste console snippets, read the
table, screenshot the finding" workflow. It runs the same checks with real
browser automation (Playwright) instead of hand-pasted console scripts,
against every URL on a site, and produces a report with **screenshot
evidence for every finding** — instead of a transcript of console output.

## Why this instead of `axe-core` alone

Generic automated scanners (including axe-core, which this tool also runs as
an independent cross-check) are deliberately conservative — they skip
anything that requires judgement, which means large classes of real WCAG
2.1 AA failures never get flagged, and they can also produce a small number
of false positives on unusual-but-compliant markup. The bespoke checks here
encode the specific rules that avoid both problems:

- **Visibility** is judged consistently everywhere via
  `offsetParent !== null` (+ size/opacity/visibility checks), so hidden
  `display:none` subtrees (e.g. closed nav dropdowns) never get flagged.
- **Contrast** does real alpha compositing of semi-transparent
  backgrounds/text and reads `-webkit-text-fill-color` first — a translucent
  highlight span or gradient-clipped heading won't falsely read as 1:1 or 21:1.
- **Text over images/gradients** is bucketed separately as "needs a human
  eye" — never silently passed, never counted as a failure.
- **Label-in-Name (2.5.3)** is checked in the spec-correct direction: the
  *visible* label must be contained in the accessible name. Checking it
  backwards flags good practice (e.g. `aria-label="Learn more about how X
  works"` on a button reading "Learn More") as a violation.
- **Large-text contrast threshold** (3:1) only applies at ≥24px, or ≥18.66px
  when bold — otherwise the stricter 4.5:1 applies.
- **`alt=""`** is valid for decorative images and is never counted as a
  failure — it's bucketed as "confirm decorative", a judgement call.
- **Keyboard interaction is driven with real Playwright/CDP input**, not
  `element.dispatchEvent(new KeyboardEvent(...))` from inside the page —
  many frameworks correctly ignore untrusted synthetic events, which is a
  known way for a hand-rolled console script to report a false pass on a
  dropdown that's actually keyboard-inoperable.
- **Tab order is recorded before anything else touches focus.** Chromium's
  sequential focus navigation resumes from wherever focus last was, even
  after `blur()` — it does not reset to the top of the document — so this
  check must run before the dropdown/focus-state checks, or their
  programmatic `.focus()` calls silently corrupt the recorded order.

## Setup

```bash
npm install
# If Playwright can't find a matching Chromium build:
npx playwright install chromium
```

## Web dashboard

A browser UI around the same engine described above — same checks, same
screenshots, same reports. Playwright still runs **only on the server**; the
page in your browser is just a client of that server's HTTP/SSE API, so this
is not something you could host as a static site (e.g. GitHub Pages) — it
needs the Node process running to do anything.

```bash
npm run dashboard          # http://localhost:3000
PORT=8080 npm run dashboard  # or: node src/server/index.js 8080
```

From the dashboard you can:

- **Start a new audit** — enter a site name and paste a full list of pages
  into a single textarea (one URL per line). A **Preset** dropdown offers
  every config already checked into `config/sites/` (including OutSail
  staging) as a one-click starting point — pick one, then still edit the
  list before starting.
- **Watch live progress** — each page's status (queued/auditing/done/error)
  streams in over Server-Sent Events as the run happens, no polling or
  refresh required.
- **Cancel a run in progress** — closes the browser immediately; whatever
  pages had already finished are still summarized and reported instead of
  the whole run being thrown away.
- **See summary breakdowns** — findings totals broken down by severity, by
  check type (with affected-page counts), and by page (automated vs. manual
  split), not just the three grand totals.
- **Browse findings, grouped by default** — the same underlying issue
  repeated across many pages (a shared header/nav/footer problem is the
  common case) collapses into a single card showing how many pages it
  affects, expandable to the full page list with per-page evidence. A
  **Raw findings** toggle switches to the flat, ungrouped list — nothing is
  ever dropped from exports, grouping is purely a display convenience.
  Filter by **page**, **check type**, **severity**, **automated vs. manual
  review**, free-text **search**, **sort** by severity/check/page (or
  pages-affected in grouped view), with **pagination** and a per-page-size
  control, so you can pull up e.g. "just the critical keyboard-trap
  findings on the pricing page."
- **Click any evidence thumbnail** to open a lightbox with next/previous
  navigation (mouse or arrow keys), a caption, and a download link.
- **Download the same four outputs the CLI produces** — HTML report, Word
  report, raw JSON results, and a `screenshots.zip` of every evidence image
  — plus the summary JSON.
- **Revisit past runs** — the History view lists every audit this server has
  run (including ones from a previous process, restored from the
  `output/<run-id>/job.json` manifest each run writes alongside its reports;
  see [Does history survive a restart?](#does-history-survive-a-restart)).

None of this changes what a check computes — the dashboard's server code
(`src/server/`) calls the exact same `auditSite()`/`buildSummary()`/report
renderers the CLI does, plus one small addition: `auditSite()` now also
accepts an optional `signal` (for cancellation) and `onPageStart` (for live
progress) — both are no-ops unless a caller passes them, so `node src/cli.js
run` behaves exactly as before.

### Dashboard API

The frontend (`web/`) is a small vanilla-JS single-page app talking to a
JSON/SSE API, useful directly if you want to script something instead:

| Method & path | Does |
|---|---|
| `GET /api/limits` | The configured `maxPages`/`maxConcurrency`/`jobTimeoutMs`/retention limits (see [Hosting this safely](#hosting-this-safely)) |
| `GET /api/presets` | Site configs from `config/sites/*.json` |
| `POST /api/audits` | Start a run: `{ siteName, urls[], viewport?, concurrency? }`. 400s if the URL list exceeds `maxPages`, if `concurrency` exceeds `maxConcurrency`, or if any URL fails the SSRF/scheme check; 409s if another audit is already running (see below) |
| `GET /api/audits` | List all runs (current process + restored from disk) |
| `GET /api/audits/:id` | Status, progress, summary once available |
| `GET /api/audits/:id/events` | SSE stream of page-start/page-done/page-error/status/done |
| `POST /api/audits/:id/cancel` | Cancel a pending/running audit |
| `GET /api/audits/:id/findings` | Findings, grouped by default. Query params: `page=`, `check=`, `severity=`, `manualReview=`, `q=` (free-text search), `grouped=true\|false` (default `true`), `sortBy=severity\|check\|page\|pageCount\|instanceCount`, `sortDir=asc\|desc`, `limit=` (default 50, max 500), `offset=`. Returns `{ total, offset, limit, grouped, items }` — `items` is grouped-finding objects (with `pageCount`/`pages`/`instances`) when `grouped=true`, or flat findings otherwise |
| `GET /api/audits/:id/breakdown` | `{ bySeverity, byCheck, byPage }` finding-count breakdowns |
| `GET /api/audits/:id/download/{html,docx,json,summary,screenshots}` | The report files (`screenshots` streams a zip) |

Grouping never discards data: `grouped=false` (the **Raw findings** toggle in
the UI) returns the exact same flat list the JSON/summary downloads contain,
and every group in the `grouped=true` response carries its full `instances`
array, so nothing is only reachable through the collapsed view.

### Hosting this safely

The CLI only ever visits URLs a developer typed on their own machine; the
dashboard accepts a URL list over HTTP from whoever can reach it, which is a
materially different trust boundary. Before putting the dashboard anywhere
reachable outside your own machine:

- **Require authentication, or keep it off the public internet entirely.**
  Setting both `DASHBOARD_USERNAME` and `DASHBOARD_PASSWORD` turns on HTTP
  Basic Auth in front of *everything* — the API and the static frontend
  alike — checked with a constant-time comparison. Setting only one of the
  two is treated as a misconfiguration and the server responds `500` to
  every request rather than silently running unauthenticated (fail closed,
  not open). If you don't set either, the dashboard has **no** login and
  must only ever run somewhere already private — behind a VPN, on
  localhost, or behind your own reverse-proxy auth. There is no supported
  "public but read-only" mode.
- **Only `http:`/`https:` audit targets are accepted.** Anything else
  (`file:`, `javascript:`, `ftp:`, …) is rejected before an audit starts.
- **Private/local-network targets are blocked by default** —
  `src/engine/ssrfGuard.js` resolves every hostname and rejects loopback,
  RFC1918/CGNAT/link-local ranges, and the cloud metadata address
  (`169.254.169.254`) for both IPv4 and IPv6, and also installs a
  per-request `context.route()` guard inside the audited page's browser
  context so a same-origin **redirect to a private address mid-audit**
  gets the same treatment, not just the URL typed into the form. This is
  belt-and-suspenders, not bulletproof: a target that only resolves to a
  private address *after* a TTL expires mid-audit (DNS rebinding) is a
  known, accepted residual risk of any DNS-based check — don't rely on
  this guard alone if you're auditing untrusted third-party URLs from a
  sensitive network. `DASHBOARD_ALLOW_PRIVATE_TARGETS=true` disables this
  entirely; it exists only for the test suite (it points a fixture audit
  target at `127.0.0.1`) and must never be set in a real deployment.
- **Page count, concurrency, and run time are all capped.** A run
  requesting more pages or concurrency than the configured limit is
  rejected with `400` before anything starts (no partial browser launch),
  and a run already in progress is force-cancelled if it runs past the
  configured timeout. `GET /api/limits` reports the effective values.
- **Only one audit runs at a time.** `POST /api/audits` responds `409` if
  another audit is `pending` or `running` — no accidental pile of
  concurrent Chromium instances from a double-clicked "Start audit" or a
  retried request.
- **Old output is deleted automatically**, not left to accumulate forever
  — see [Output retention](#output-retention) below.

| Env var | Controls | Default |
|---|---|---|
| `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD` | HTTP Basic Auth for the whole app. Both or neither — one alone is a `500` on every request | unset (no auth) |
| `DASHBOARD_MAX_PAGES` | Max URLs accepted per run | `60` |
| `DASHBOARD_MAX_CONCURRENCY` | Max `concurrency` accepted per run | `8` |
| `DASHBOARD_JOB_TIMEOUT_MINUTES` | Force-cancel a run still going after this long | `45` |
| `DASHBOARD_RETENTION_DAYS` | Delete a run's output once its directory is older than this | `14` |
| `DASHBOARD_RETENTION_MAX_JOBS` | Keep at most this many run directories (oldest deleted first), regardless of age | `100` |
| `DASHBOARD_ALLOW_PRIVATE_TARGETS` | **Testing only.** Disables the SSRF guard entirely | unset (guard on) |

#### Output retention

`cleanupOldOutputs()` (`src/server/jobManager.js`) runs once at server
startup and every 6 hours after that (`src/server/index.js`), applying
`DASHBOARD_RETENTION_DAYS` and `DASHBOARD_RETENTION_MAX_JOBS` together — a
run directory is deleted once it's *either* older than the retention window
*or* pushed past the job-count cap by newer runs, whichever comes first. A
directory belonging to a `pending` or `running` job is never touched
regardless of age, so a long-running audit is never deleted out from under
itself. Deletion removes the entire `output/<run-id>/` directory (reports,
JSON, screenshots) and drops the in-memory job record; there's no
soft-delete or trash — treat the retention window as the actual backup
window if you need these reports kept longer than that.

#### Does history survive a restart?

Yes. Every job writes a `job.json` manifest into its own `output/<run-id>/`
directory as it progresses; on process start, `hydrateFromDisk()` reads
every manifest under `output/` and rebuilds the in-memory job list from
them (marking anything still `pending`/`running` at the time of the crash
or restart as `interrupted`, since there's no way to know what actually
happened to that browser process). The History view and `GET /api/audits`
are reading that rebuilt list — a server restart does not lose past runs,
though the retention cleanup above still applies to them exactly as it
would to a run from the current process.

## Usage

```bash
node src/cli.js run --config config/sites/outsail-staging.example.json
```

Or without a config file:

```bash
node src/cli.js run --urls https://example.com/,https://example.com/about --name "Example Co"
```

### Options

| Flag | Description | Default |
|---|---|---|
| `-c, --config <path>` | JSON config with `name`, `urls[]`, `viewport` | — |
| `-u, --urls <list>` | Comma-separated URL list (merges with `--config`) | — |
| `-n, --name <name>` | Site name shown in the report | `Accessibility Audit` |
| `-o, --out <dir>` | Output directory | `output/<slug>-<timestamp>` |
| `--formats <list>` | `html,docx,gdocs` (comma list) | `html,docx` |
| `--concurrency <n>` | Pages audited in parallel | `3` |
| `--gdoc-credentials <path>` | Service account JSON (for `gdocs` format) | — |
| `--gdoc-folder <id>` | Drive folder ID to upload into (for `gdocs` format) | — |

### Config file format

```json
{
  "name": "Client Site",
  "viewport": { "width": 1440, "height": 900 },
  "urls": ["https://client.com/", "https://client.com/about"]
}
```

One config per site/client — see `config/sites/example.json` for a template
and `config/sites/outsail-staging.example.json` for the real 29-page list
this tool's methodology was originally built against.

## Output

Each run writes to `output/<run-id>/`:

- `report.html` — self-contained interactive report (open in any browser).
  Findings are grouped Fail / Manual Review / Pass per check, per page, each
  with a linked screenshot.
- `report.docx` — the same findings as a Word document, ready to hand to a
  client or attach to the SOW deliverable.
- `results.json` / `summary.json` — raw structured data, if you want to pipe
  it into something else (a dashboard, a ticket-per-finding script, etc).
- `screenshots/` — one full-page screenshot per URL, plus one cropped,
  highlighted screenshot per finding.

### Reading the report

Every check section shows a count with a colored chip: green **0** = pass,
red = hard failure, amber = **manual review** (a judgement call that cannot
be computed from markup alone — e.g. "is over an image/gradient" contrast,
or "is this alt="" actually decorative"). Manual-review items are never
counted toward failures and never silently dropped.

## Optional: Google Docs export

`--formats gdocs` uploads the generated `.docx` and asks Drive to convert it
into a native, editable Google Doc. This needs a Google Cloud service
account with the Drive API enabled:

1. Create a service account, download its JSON key.
2. Share the destination Drive folder with the service account's email
   (Editor access) — service accounts have no personal Drive storage, so a
   shared destination folder is required.
3. Run with `--formats gdocs --gdoc-credentials ./sa.json --gdoc-folder <folderId>`.

## What still requires a human

This tool automates exactly the SOW S2.3.F checklist and nothing more. It
deliberately does not attempt to auto-resolve:

1. **Text over images/gradients** — flagged as manual review; a person has
   to eyeball actual contrast.
2. **Whether a focus ring is actually perceptible** against its background —
   the check proves style *changes* on focus, not that the change is
   legible.
3. **Whether an `alt=""` image is genuinely decorative** — a content
   judgement, not a computable fact.
4. Anything explicitly out of SOW scope: full WCAG audit/certification,
   JAWS/NVDA screen reader testing, AODA/ADA legal compliance reporting.

## Project layout

```
src/
  cli.js                    entrypoint (commander)
  engine/
    browser.js               browser/context launch, page priming
    domHelpers.js             shared in-page DOM primitives (visibility, tagging)
    ssrfGuard.js               target-safety checks + in-page redirect guard (dashboard hosting)
    pageAudit.js               runs all checks for one URL
    siteAudit.js                concurrency-limited runner across a URL list (cancellable)
    screenshot.js                 full-page + per-finding evidence capture
    checks/                        one module per SOW item + axe baseline
  report/
    buildSummary.js            cross-page aggregation (fail/manual-review counts)
    findings.js                  flat per-instance finding list + severity, plus grouping/breakdown for the dashboard
    sortSearch.js                 sort/search helpers for the dashboard findings API
    html/render.js               self-contained HTML report
    docx/render.js                 Word report (docx npm package)
    gdocs/upload.js                 optional Drive upload/convert
  server/
    app.js                    Express routes (REST + SSE) — Playwright-side of the dashboard
    jobManager.js               in-memory run registry: start/cancel/list, disk-persisted manifest
    index.js                     `npm run dashboard` entrypoint
  util/slug.js               shared id/timestamp slugging (CLI + dashboard)
web/                        dashboard frontend (vanilla JS/CSS, no build step)
config/sites/                 one JSON file per client/site
test/                        node:test suite (`npm test`) + fixtures/ (local page + static server)
```

### Adding a new site

Drop a new `config/sites/<name>.json` (copy `example.json`), fill in `name`
and `urls`, then either run `node src/cli.js run --config
config/sites/<name>.json` or pick it from the dashboard's preset dropdown —
both read the same file.

### Tests

```bash
npm test          # node:test — see below for what each file covers
npm run smoke      # CLI end-to-end, local fixture page (see below)
```

- `test/findings.test.js` — unit tests of severity/manual-review
  classification, finding grouping (collapsing a repeated issue across
  pages into one group with a page count/list), the severity/check/page
  breakdown tallies, and the sort/search helpers.
- `test/checks.test.js` — the bespoke DOM checks against a real,
  minimal-fixture Playwright page: a closed `<details>`'s content isn't
  mistaken for visible, a `visibility:hidden` control is flagged but a
  `display:none` or off-screen-positioned (skip-link-style) one isn't, a
  `disabled` button isn't reported as missing a focus indicator, and a
  `<label for>`-associated `<textarea>`/`<select>` isn't double-flagged as
  nameless.
- `test/ssrfGuard.test.js` — the target-safety checks in isolation: private/
  loopback/link-local/CGNAT/metadata IPv4 and IPv6 addresses, non-http(s)
  schemes, and the `allowHosts` test-only override.
- `test/retention.test.js` — `cleanupOldOutputs()` against a sandboxed
  `output/` directory: age-based deletion, the `maxJobs` cap, and that a
  `pending`/`running` job's directory is never touched.
- `test/server.test.js` — the real dashboard server against the local
  fixture page (real Playwright, real checks, no mocking): starts an audit
  over HTTP, polls it to completion, checks the grouped/raw findings API
  (including pagination and sorting), the breakdown endpoint, downloads
  (including that the screenshots zip is a real zip), a mid-run cancel, the
  page/concurrency limits and single-active-run guard, the SSRF guard
  rejecting a private-network target, and HTTP Basic Auth (including the
  fail-closed half-configured case).
- `test/buildSummary.test.js` — cross-page summary aggregation.

### Smoke-testing without hitting a real site

```bash
npm run smoke
```

(equivalent to starting `test/fixtures/serve.js` and running the CLI against
it — see `test/fixtures/run-smoke.sh`)

`test/fixtures/sample-page.html` deliberately contains one instance of every
finding type (contrast failures, a text-over-gradient manual-review case, a
real vs. broken keyboard toggle, missing/filename/linked/decorative alt
cases, a heading-level skip, unlabeled inputs, mismatched ARIA labels, a
duplicate ID, and both a good and a broken focus indicator) so a full run
against it exercises every code path.
