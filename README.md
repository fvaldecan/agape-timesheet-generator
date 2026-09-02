# Agape Timesheet Generator

A small web app that turns a Club Automation weekly schedule into a
formatted, totaled commission sheet — .docx or .csv. Everything runs in
the browser; no backend, no database, nothing to host besides a couple of
static files.

**[Try it live](https://fvaldecan.github.io/agape-timesheet-generator/)**

## How it works

1. Coach fills in **Settings** first (step 1 on the page) — name,
   compensation notes, and pay rates are all required before anything
   else works, so a sheet never quietly goes out with a blank name or a
   $0 rate. Then drags the **"Get My Schedule"** bookmarklet button
   (step 2) up to their bookmarks bar — one-time setup, no separate file
   to dig through.
2. Logs into Club Automation, opens their schedule, clicks the bookmark
   from their bookmarks bar. They stay on Club Automation while it
   scrapes — if it finds a booking type with no rate set up yet, it asks
   right there (flat hourly, or per-person with a percentage to the
   coach) instead of just showing $0.00 later. Once it's ready, clicking
   **Send to timesheet app** opens (or switches to) the app in a browser
   tab and sends the schedule there directly, no copy/paste. The app
   parses it automatically and shows its own review summary (found /
   will-add / blocked / empty / duplicates) — nothing is added to the
   sheet until you click **Add to sheet**. (If the hand-off can't reach
   the app tab for some reason, it falls back to copying the schedule to
   the clipboard instead, with a prompt to paste it in and hit **Parse**
   manually.)
3. If the pay period covers more than one week (common — usually 2),
   navigate to the next week in Club Automation and click the bookmark
   again — it reuses the same app tab, so the sheet already being built
   isn't lost. Duplicate entries (same date, time, and type) are
   automatically skipped.
4. Reviews the sheet, grouped by **location** and then by **week** within
   each location (collapsible, so a multi-week sheet doesn't turn into an
   endless scroll). Each entry is a single summary line — click it to
   expand every editable field (date, type, sport, time, location, rate,
   headcount, amount). Anything that needs a look (missing location, no
   matching rate rule, a bad start/end time, or an overlap with another
   entry) shows a warning icon and auto-expands so it can't be missed.
5. Downloads a `.docx` or `.csv` commission sheet once everything's in.
6. **Clear & start over** wipes everything to begin a fresh pay period.

Your schedule data never leaves your browser. The schedule HTML, rate
settings, and compensation notes all stay local — there's no client
roster stored anywhere, so no client names ever touch a server. The one
exception is anonymous usage analytics ([GoatCounter](https://www.goatcounter.com/)):
it records aggregate pageviews, unique visitors, which export buttons get
clicked, and a "timesheet completed" event (fired once per sheet, the
first time any export happens — repeat downloads or extra formats of the
same sheet don't inflate it). Alongside that same event, it records which
coarse duration bucket the sheet fell into (under 2min / 2-5min / 5-10min
/ 10-20min / over 20min), timed from the first Parse click to that first
export — GoatCounter's free tier only counts hits to a path with no
numeric event values, so bucketing is how a rough time-to-complete
distribution comes out of it without ever sending an exact timestamp. It
never sees the schedule content, rate numbers, or anything typed into the
app. See the `<script data-goatcounter>` tag near the bottom of
`index.html` if you want to see exactly what it sends, or strip it out
entirely.

## Deploying it

It's a couple of static files (`index.html` + `style.css`) — any static host works.

**GitHub Pages** (what this repo is set up for):
1. Push this repo to GitHub.
2. Repo Settings → Pages → deploy from the `main` branch, root folder.
3. Your app is live at `https://<username>.github.io/<repo>/`.

## Before you make the repo public — read this

### There's no access control on the page itself

This app doesn't hold any secrets or private data of its own (everything
sensitive stays local to each coach's browser), so the stakes of someone
stumbling onto the page are low — worst case, a stranger sees a form for
building a commission sheet with no data in it. Anyone with the link can
open it, though, and it'll show up in search engines if left unguarded.

If you want it access-controlled, here are real options, roughly
cheapest/easiest first:

- **Cloudflare Pages + Cloudflare Access** — deploy the static site to
  Cloudflare Pages, then put it behind Cloudflare Access with an email
  allow-list (only these specific Agape email addresses can load the
  page). Free for small teams, and the access control happens on
  Cloudflare's side, not in your JS.
- **Netlify password protection** — Netlify has a built-in site-wide
  password feature, but it's a paid-tier feature.
- **Private repo + private hosting** — keep the repo itself private (not
  ideal if you want it as a public portfolio piece), and share the
  deployed link only with coworkers.

A reasonable middle ground: keep the **code** public on your portfolio
(it's a legitimate, well-built project to show off), but deploy the
**actual working version your coworkers use** somewhere gated properly,
like Cloudflare Access. Two deployments, one repo.

### Rate/comp structure

Every coach starts with three fixed **core rates** — Private Lesson (PL),
Group Lesson (GL), Private Hitting Session (PHS) — plus any number of
**custom rates** for anything else. Each custom rate matches on the
booking's type of class (Starts with / Contains, your choice) and is
either **Hourly** or **Per person**. Hourly rules have two pricing modes:
a flat `$/hr` amount, or `client rate minus Agape's cut` (e.g. billed at
$65/hr, Agape takes $20, you get $45/hr) — useful since the cut varies by
coach. Every hourly rule also has a default "# people," mainly for
flagging semi-private lessons.

`index.html`'s `CORE_RATE_DEFAULTS` ships with the three core rows'
*shapes* pre-filled (match text, pricing mode) but the actual dollar
amounts left blank on purpose — this repo is public, so no real Agape
pricing lives in the source. `DEFAULT_RATES` (the custom-rate list) starts
empty; there's nothing to guess at custom rates for since they vary coach
to coach, and a pre-seeded guess row that isn't actually complete would
just block Parse/Add until someone noticed and deleted it. The app's own
"missing field" highlighting (name, compensation notes, and every rate —
all shown in red until filled in) walks each coach through filling in
their own numbers in Settings the first time they use it, and everything
they enter stays local to their browser (see above).

## Files

- `index.html` — the whole app (parsing, calculation, export, everything)
- `style.css` — all styling, kept out of `index.html` so the markup stays readable
- `BOOKMARKLET.md` — the schedule-copy bookmarklet, code + install steps
- `README.md` — this file

## Known limitations

- **One week per capture, always** — but the app now handles this. Club
  Automation's schedule report is hardcoded to a 7-day range (`date` to
  `date_end`, always 6 days apart in the page's own form fields), so a
  2+ week pay period always needs multiple captures. Parsing is additive
  (see "How it works" above) with automatic duplicate detection, so just
  click the bookmark again for each week in turn.
- **Location and attendance aren't in the schedule page HTML — they load
  on click.** Confirmed: clicking an event fires an AJAX call that returns
  a popup with Location, Service, and Attendance (`current / max`). The
  parser for that response (`parseEventInfoHtml`) is already written and
  tested in `index.html`, but it isn't wired up to an automatic fetch loop
  yet — that needs the actual request URL, method, and params (DevTools →
  Network tab → click an event → find the request under `/resource/...`
  → Copy as cURL). Once that's confirmed, this becomes a real automation:
  fetch every event's detail on parse and skip manual location entry
  entirely.
- **Open/unbooked slots are filtered out automatically.** Club Automation
  shows unfilled "PL: &lt;coach's last name&gt;" slots with no client name — those aren't
  real lessons and are excluded during parsing. If a real booking is ever
  missing a client name for some other reason, it'll silently disappear
  too — spot check the total against what you expect.
- **"Court Time" bookings are excluded too** — plain customer court
  rentals with no coach attached, so they're never payroll-relevant.
  This is an exact match on the booking's title, not a partial one, so a
  real class whose title happens to mention court time won't be caught
  by accident.
- **No location roster.** Every private lesson lands in an **Unassigned**
  section until you pick a location for it that week — nothing is
  remembered client-to-client, since the same client can attend either
  location. A wrong guess (from the click-fetch detail, or the "- FV" /
  "- CM" title-suffix hint) can be corrected directly — editing it moves
  the entry into the right location/week group immediately.
- **Booking titles that don't match any rate rule are flagged, not
  silently zeroed.** The bookmarklet already asks about most of these
  up front while scraping (see "How it works" above), but a title you
  skip there — or one from a schedule pasted in manually — still shows
  up priced at $0.00 rather than a guess. Fix it by adding a rate rule
  that matches, or by clicking "+ Add rate rule for this" on the entry
  itself.
- **A missing location, an unmatched rate, an end time before its start
  time, and an entry overlapping another one's time all share one warning
  mechanic.** Any of those four conditions puts a warning icon on that
  entry's summary line and auto-expands it (an explicit collapse sticks
  until you edit it again), plus a banner above the sheet with a live
  count. Overlap detection checks every entry against every other
  regardless of location — one coach can't be in two places at once, so a
  cross-location double-booking is exactly as real a conflict as a
  same-location one. Back-to-back sessions (one ending exactly when the
  next starts) don't trigger it. None of this blocks anything — it's a
  heads-up, not a hard stop — but exporting (CSV, docx, or print) with any
  of these still outstanding asks for confirmation first.
- **Group class headcount isn't in the calendar data**, so it can't be
  auto-detected. Any rate rule set to "Per person" shows an editable
  headcount field per session. Hourly rules also show an editable "#
  people" field (defaulted from the rule, usually 1) — purely
  informational for hourly pricing, but useful for flagging semi-private
  lessons (e.g. two students in one booking).
- **Everything is manually editable.** Each entry is a single summary line
  (date, type, time, amount) that expands on click into every field —
  date, type, sport, location, rate, headcount, amount, and start/end
  time (picked from a 30-minute-increment list rather than free-typed, so
  it can't drift out of the half-hour grid Club Automation books on). Any
  entry can be deleted (e.g. a cancelled lesson) or added (e.g. something
  missing from the calendar). An edited amount shows in orange with a
  reset (↺) button to snap back to the calculated value.
- **Cancelled lessons still show up on the calendar.** The schedule HTML
  doesn't distinguish a cancelled booking from one that happened — delete
  the row manually if that's the case.
- **One-off event durations don't always match actual pay.** Scheduled
  duration on the calendar and what actually got paid have differed by a
  few minutes/dollars in practice. Spot check one-off events, or just
  override the amount directly on the entry.
