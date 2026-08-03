# Schedule Copy Bookmarklet

**The easiest way to install this is inside the app itself** — open
`index.html`, step 1 has it as a drag-to-bookmarks-bar button, no copying
code by hand required. This file is here as a fallback (for the manual
install method, or if you just want to read the source) and as reference
documentation for the repo.

This is a browser bookmark that runs a script instead of opening a page.
Click it while your Club Automation schedule is open, and it opens (or
switches to) a timesheet app tab and sends the schedule there directly —
no copy/paste needed. If it can't reach that tab for some reason, it falls
back to copying the schedule to your clipboard instead, same as before.

If it sees a booking type it doesn't already have a pay rate for, it asks
right there on the page — flat hourly, or priced per person per session —
and saves your answer as a real rate rule in the app. (This only works
well if you installed by dragging the button from the app itself — see
the note under "The code" below for why the copy in this file can't
remember what you've already answered.)

It runs entirely inside your own logged-in browser tab. It never sends
anything anywhere except back to Club Automation itself (it fetches
location/attendance from Club Automation's own `/event/event-full-info`
endpoint, using your browser's existing session — your login credentials
never pass through the bookmarklet code, the app, or anyone else).

It counts blocked time and empty/unbooked slots and reports them in the
alert before you paste anything — so if something looks off (e.g. a
lesson that should be booked but shows as an empty slot), you can go fix
it in Club Automation first. It also checks it's actually running on a
Club Automation page before doing anything, and shows a small "please
stay on this page" banner with live progress while it's fetching details,
so it's never unclear whether it's still working.

## Install

1. Show your browser's bookmarks bar if it's hidden
   (Chrome/Edge: Ctrl+Shift+B or Cmd+Shift+B).
2. Right-click the bookmarks bar → **Add page** (or **New bookmark**).
3. Name it (e.g. "Get My Schedule").
4. Paste the whole code block below into the **URL** field (it starts
   with `javascript:`).
5. Save.

## The code

This copy hardcodes the public GitHub Pages deployment as the app it hands
off to, and — this is the important part — **always starts with an empty
rate-rule snapshot**, so it can't tell what you've already configured. It
will ask about every booking type, every single time, even ones you
already have a saved rate for. It still *saves* your answers correctly
(the app dedupes and merges them fine), it just can't skip asking about
titles it doesn't know it already knows.

**If you want it to stop re-asking about titles you've already answered,
install via the app's own drag-to-bookmarks-bar button instead** (step 1
in `index.html`). That version bakes in your actual current rate rules
each time you drag it, and re-bakes them every time you edit a rate in
Settings — so it only prompts about genuinely new booking types. It also
auto-detects wherever you loaded the app from, instead of always pointing
at the public deployment.

```
javascript:(async function () { var APP_URL = 'https://fvaldecan.github.io/agape-timesheet-generator/'; var APP_ORIGIN = new URL(APP_URL).origin; var AGAPE_RULES_SNAPSHOT = []; if (window.location.hostname.indexOf('clubautomation.com') === -1) { alert('This button only works on your Club Automation schedule page. Go there first, open your weekly schedule, then click this again.'); return; } var el = document.getElementById('court_schedule'); if (!el) { alert('Could not find your schedule on this page. Make sure you have your weekly schedule open (not the login page or another screen), and that it has finished loading, then try again.'); return; } var appWin = null; try { appWin = window.open('', 'agapeTimesheetApp'); } catch (e) { appWin = null; } if (appWin) { var isFreshTab; try { isFreshTab = (appWin.location.href === 'about:blank' || appWin.location.href === ''); } catch (e) { isFreshTab = false; } if (isFreshTab) { try { appWin.location.href = APP_URL; } catch (e) { appWin = null; } } } try { window.focus(); } catch (e) {} var appReady = false; var pingTimer = null; var onScheduleReceived = null; if (appWin) { pingTimer = setInterval(function () { if (appReady) { clearInterval(pingTimer); return; } try { appWin.postMessage({ type: 'AGAPE_PING' }, APP_ORIGIN); } catch (e) {} }, 300); window.addEventListener('message', function (e) { if (e.source !== appWin || !e.data) return; if (e.data.type === 'AGAPE_READY') appReady = true; else if (e.data.type === 'AGAPE_RECEIVED' && onScheduleReceived) onScheduleReceived(); }); } var overlay = document.createElement('div'); overlay.style.cssText = 'all:initial;position:fixed !important;top:16px !important;right:16px !important;z-index:2147483647 !important;background:#1c2321 !important;color:#fff !important;opacity:1 !important;filter:none !important;padding:16px 20px !important;border-radius:6px !important;font-family:sans-serif !important;font-size:14px !important;line-height:1.5 !important;box-shadow:0 4px 16px rgba(0,0,0,0.3) !important;max-width:320px !important;display:block !important;'; overlay.textContent = 'Getting your schedule... please stay on this page.'; overlay.setAttribute('role', 'status'); overlay.setAttribute('aria-live', 'polite'); document.documentElement.appendChild(overlay); function titleOf(block) { var h4 = block.querySelector('h4'); if (!h4) return ''; var clone = h4.cloneNode(true); var icons = clone.querySelectorAll('.icons'); for (var k = 0; k < icons.length; k++) { icons[k].remove(); } return clone.textContent.trim(); } function subtitleOf(block) { var h4 = block.querySelector('h4'); if (!h4) return ''; var sib = h4.nextElementSibling; return sib ? sib.textContent.replace(/\s+/g, ' ').trim() : ''; } function localClassifyMatches(title, snapshot) { for (var j = 0; j < snapshot.length; j++) { var r = snapshot[j]; if (!r.match) continue; var mode = r.matchMode || 'contains'; var matches = mode === 'startsWith' ? title.toUpperCase().indexOf(r.match.trim().toUpperCase()) === 0 : title.toLowerCase().indexOf(r.match.trim().toLowerCase()) !== -1; if (matches) return true; } return false; } function copyFallback(text) { var ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.top = '0'; ta.style.left = '0'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.focus(); ta.select(); var ok = false; try { ok = document.execCommand('copy'); } catch (e) { ok = false; } document.body.removeChild(ta); return ok; } var clone = el.cloneNode(true); var liveBlocks = el.querySelectorAll('.eventBlock'); var cloneBlocks = clone.querySelectorAll('.eventBlock'); var ok = 0, fail = 0, skipped = 0, blockedCount = 0, emptyCount = 0, realCount = 0; var distinctTitles = [], seenTitles = {}; for (var i = 0; i < liveBlocks.length; i++) { var t = titleOf(liveBlocks[i]); var isBlocked = t.toLowerCase().indexOf('blocked') !== -1; var isEmptySlot = t.indexOf('PL') === 0 && !subtitleOf(liveBlocks[i]); if (isBlocked) { blockedCount++; continue; } if (isEmptySlot) { emptyCount++; continue; } realCount++; if (!seenTitles[t]) { seenTitles[t] = true; distinctTitles.push(t); } overlay.textContent = 'Getting your schedule... ' + (i + 1) + ' of ' + liveBlocks.length + '. Please stay on this page.'; var cls = liveBlocks[i].className; var schedMatch = cls.match(/schedule-(\d+)/); var resMatch = cls.match(/resource-(\d{4})-\d{2}-\d{2}/); if (!schedMatch) { skipped++; continue; } var scheduleId = schedMatch[1]; var year = resMatch ? resMatch[1] : String(new Date().getFullYear()); try { var resp = await fetch('/event/event-full-info', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' }, body: new URLSearchParams({ schedule_id: scheduleId, resource_id: year, current_component: '0', is_groupex: '0', is_human_resource_component_view: '0', is_staff_schedule_view: '1', locationId: '0' }), credentials: 'same-origin' }); var data = await resp.json(); if (data && data.status === 1 && data.content) { cloneBlocks[i].setAttribute('data-detail', encodeURIComponent(data.content)); ok++; } else { fail++; } } catch (e) { fail++; } await new Promise(function (r) { setTimeout(r, 150); }); } var titlesToPrompt = distinctTitles.filter(function (t) { return !localClassifyMatches(t, AGAPE_RULES_SNAPSHOT); }); function promptForNumber(question, max) { while (true) { var raw = window.prompt(question); if (raw === null) return null; var n = parseFloat(raw.trim()); var outOfRange = raw.trim() === '' || isNaN(n) || n < 0 || (max !== undefined && n > max); if (outOfRange) { alert("That doesn't look like a valid " + (max !== undefined ? ('percentage (0-' + max + ')') : 'dollar amount') + " — try again, or Cancel on the next prompt to skip this one."); continue; } return n; } } var newRateRules = []; for (var ti = 0; ti < titlesToPrompt.length; ti++) { var title = titlesToPrompt[ti]; var setUp = confirm('"' + title + '" doesn\'t have a pay rate set up yet.\n\n' + "Set one up now? (Cancel to skip — it'll show as $0.00 with a warning on your sheet until you add one, same as today.)"); if (!setUp) continue; var isFlat = confirm('Is "' + title + '" a flat hourly rate?\n\n' + 'OK = flat $/hr.\nCancel = priced per person per session instead (e.g. $20/person, Agape keeps a %).'); if (isFlat) { var rate = promptForNumber('What do you get paid per hour for "' + title + '"?'); if (rate === null) continue; newRateRules.push({ match: title, matchMode: 'startsWith', type: 'hourly', mode: 'flat', rate: rate, defaultPeople: 1 }); } else { var pricePerPerson = promptForNumber('What does each person pay for a session of "' + title + '"?'); if (pricePerPerson === null) continue; var agapeCutPct = promptForNumber('What percentage does Agape keep for "' + title + '"?', 100); if (agapeCutPct === null) continue; newRateRules.push({ match: title, matchMode: 'startsWith', type: 'per_person', pricePerPerson: pricePerPerson, coachShare: 100 - agapeCutPct }); } } if (newRateRules.length) { clone.setAttribute('data-agape-new-rate-rules', encodeURIComponent(JSON.stringify(newRateRules))); } var htmlOut = clone.outerHTML; var summaryLines = [realCount + ' real booking' + (realCount === 1 ? '' : 's') + ' found (' + ok + ' with location/attendance details' + (fail ? ', ' + fail + ' failed' : '') + ').']; if (blockedCount) summaryLines.push(blockedCount + ' blocked time block' + (blockedCount === 1 ? '' : 's') + ' (ignored, unpaid).'); if (emptyCount) summaryLines.push(emptyCount + ' empty/unbooked slot' + (emptyCount === 1 ? '' : 's') + ' (ignored) — worth checking those in Club Automation if that seems off.'); if (newRateRules.length) summaryLines.push('Set up ' + newRateRules.length + ' new pay rate' + (newRateRules.length === 1 ? '' : 's') + '.'); var skippedCount = titlesToPrompt.length - newRateRules.length; if (skippedCount > 0) summaryLines.push(skippedCount + ' booking type' + (skippedCount === 1 ? '' : 's') + ' still without a rate — will show $0.00 until fixed.'); var msg = summaryLines.join('\n'); function waitForAck() { return new Promise(function (resolve) { var settled = false; var to = setTimeout(function () { if (!settled) { settled = true; onScheduleReceived = null; resolve(false); } }, 8000); onScheduleReceived = function () { if (settled) return; settled = true; clearTimeout(to); onScheduleReceived = null; resolve(true); }; (function trySend() { if (settled) return; if (appReady) { try { appWin.postMessage({ type: 'AGAPE_SCHEDULE_DATA', html: htmlOut, newRateRules: newRateRules }, APP_ORIGIN); } catch (e) {} } else { setTimeout(trySend, 300); } })(); }); } var delivered = appWin ? await waitForAck() : false; if (delivered) { try { appWin.focus(); } catch (e) {} overlay.innerHTML = ''; summaryLines.forEach(function (line, idx) { var lineDiv = document.createElement('div'); lineDiv.textContent = line; lineDiv.style.cssText = 'all:unset !important;display:block !important;color:#fff !important;opacity:' + (idx > 0 ? '0.85' : '1') + ' !important;font-size:' + (idx > 0 ? '13px' : '14px') + ' !important;font-family:sans-serif !important;line-height:1.5 !important;margin-top:' + (idx > 0 ? '6px' : '0') + ' !important;'; overlay.appendChild(lineDiv); }); var doneLine = document.createElement('div'); doneLine.textContent = 'Sent to the timesheet app — check that tab.'; doneLine.style.cssText = 'all:unset !important;display:block !important;color:#fff !important;opacity:1 !important;font-size:14px !important;font-family:sans-serif !important;line-height:1.5 !important;margin-top:10px !important;font-weight:600 !important;'; overlay.appendChild(doneLine); setTimeout(function () { overlay.remove(); }, 3000); return; } function onCopyDone(success) { overlay.remove(); if (success) { alert(msg + '\nCopied — now paste it into the timesheet app.'); } else { window.prompt(msg + '\nCopy this manually (Ctrl+C / Cmd+C):', htmlOut); } } overlay.innerHTML = ''; var whyLine = document.createElement('div'); whyLine.textContent = "Couldn't reach the timesheet app tab automatically."; whyLine.style.cssText = 'all:unset !important;display:block !important;color:#fff !important;opacity:1 !important;font-size:14px !important;font-family:sans-serif !important;line-height:1.5 !important;'; overlay.appendChild(whyLine); summaryLines.forEach(function (line) { var lineDiv = document.createElement('div'); lineDiv.textContent = line; lineDiv.style.cssText = 'all:unset !important;display:block !important;color:#fff !important;opacity:0.85 !important;font-size:13px !important;font-family:sans-serif !important;line-height:1.5 !important;margin-top:6px !important;'; overlay.appendChild(lineDiv); }); var hint = document.createElement('div'); hint.textContent = 'Click below to copy it, then paste into the app tab.'; hint.style.cssText = 'all:unset !important;display:block !important;color:#fff !important;opacity:1 !important;font-size:14px !important;font-family:sans-serif !important;line-height:1.5 !important;margin-top:10px !important;margin-bottom:10px !important;'; overlay.appendChild(hint); var copyBtn = document.createElement('button'); copyBtn.textContent = 'Copy schedule'; copyBtn.style.cssText = 'all:unset !important;display:inline-block !important;background:#fff !important;color:#1c2321 !important;opacity:1 !important;border:none !important;padding:8px 14px !important;border-radius:4px !important;cursor:pointer !important;font-weight:600 !important;font-size:14px !important;font-family:sans-serif !important;'; copyBtn.onclick = function () { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(htmlOut).then(function () { onCopyDone(true); }, function () { onCopyDone(copyFallback(htmlOut)); }); } else { onCopyDone(copyFallback(htmlOut)); } }; overlay.appendChild(copyBtn); copyBtn.focus(); })();
```

Note on `resource_id`: this is set to the event's year (e.g. `2026`),
inferred from the schedule grid's own `resource-YYYY-MM-DD` class. That
held up in testing, but if it ever behaves oddly around a new year
boundary, check DevTools → Network on a real click and compare.

## Use it

1. Log into Club Automation like normal and open your weekly schedule.
2. Make sure the week you want has actually loaded on screen.
3. Click the bookmark. It opens (or reuses) a timesheet app tab in the
   background — if your browser blocks pop-ups, allow them for Club
   Automation and click the bookmark again. You stay on the Club
   Automation page the whole time; the app tab doesn't steal focus.
4. A small banner appears in the corner saying to stay on the page while
   it works — it processes events one at a time with a short pause
   between each to avoid hammering the server, so a busy week can take
   5-15 seconds.
5. If it finds a booking type it doesn't recognize, you'll get a series
   of pop-up questions — one "set this up now?" confirmation, then either
   an hourly rate or a per-person price plus what percentage Agape keeps.
   Cancel any of them to skip that title — it'll just show $0.00 with a
   warning on your sheet until you fix it later in Settings.
6. When it's done, the schedule is sent straight to the app tab, which
   parses and adds it automatically, then brings that tab to the front for
   you — no paste, no Parse click, just review the finished sheet.
7. Doing a multi-week pay period? Navigate to the next week in Club
   Automation and click the bookmark again — it reuses the same app tab
   (without reloading it) so the sheet you're building isn't lost, and
   duplicate entries are skipped automatically.
8. If the hand-off can't complete for some reason (pop-up blocked, slow
   connection), it falls back automatically: you'll see a "couldn't reach
   the app tab" message with a **Copy schedule** button — click it, then
   paste into the app tab and hit **Parse** same as before.

## Troubleshooting

**"This button only works on your Club Automation schedule page"** — you
clicked it somewhere other than Club Automation. Go to your schedule
there first.

**"Could not find your schedule on this page"** — the schedule grid loads
in after the page opens. Wait a couple seconds for the week to actually
render before clicking the bookmark.

**Some events "failed"** — that's usually a transient network hiccup or
the session expiring mid-run. Reload the page and try again. Failed
events just fall back to no location/attendance — nothing crashes.

**It opened a blank tab and nothing happened** — most likely a pop-up
blocker interfered right as the tab was opening. Allow pop-ups for Club
Automation in your browser settings and click the bookmark again.

**"Couldn't reach the timesheet app tab automatically"** — the hand-off
didn't complete in time (slow connection, or something else interrupted
it). Click **Copy schedule** in that same message, then paste into the
app tab and hit **Parse** — this is the same fallback the button used to
use for everything, so nothing is actually broken, it's just the backup
path.

**It keeps asking about the same booking type every time** — expected
with this manually-pasted copy (see "The code" above): it always starts
with an empty rate-rule snapshot, so it can't tell what you've already
answered. Your answers are still being saved correctly in the app either
way — this is just a "keeps asking" annoyance, not a data problem.
Install via the app's own drag-to-bookmarks button instead if this
bothers you; that version remembers.
