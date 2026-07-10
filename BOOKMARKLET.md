# Schedule Copy Bookmarklet

**The easiest way to install this is inside the app itself** — open
`index.html`, step 1 has it as a drag-to-bookmarks-bar button, no copying
code by hand required. This file is here as a fallback (for the manual
install method, or if you just want to read the source) and as reference
documentation for the repo.

This is a browser bookmark that runs a script instead of opening a page.
Click it while your Club Automation schedule is open, and it copies the
schedule data to your clipboard — ready to paste into the timesheet app.

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

```
javascript:(async function () { if (window.location.hostname.indexOf('clubautomation.com') === -1) { alert('This button only works on your Club Automation schedule page. Go there first, open your weekly schedule, then click this again.'); return; } var el = document.getElementById('court_schedule'); if (!el) { alert('Could not find your schedule on this page. Make sure you have your weekly schedule open (not the login page or another screen), and that it has finished loading, then try again.'); return; } var overlay = document.createElement('div'); overlay.style.cssText = 'position:fixed;top:16px;right:16px;z-index:999999;background:#1c2321;color:#fff;padding:14px 18px;border-radius:6px;font-family:sans-serif;font-size:14px;box-shadow:0 4px 16px rgba(0,0,0,0.3);max-width:280px;'; overlay.textContent = 'Getting your schedule... please stay on this page.'; document.body.appendChild(overlay); function titleOf(block) { var h4 = block.querySelector('h4'); if (!h4) return ''; var clone = h4.cloneNode(true); var icons = clone.querySelectorAll('.icons'); for (var k = 0; k < icons.length; k++) { icons[k].remove(); } return clone.textContent.trim(); } function subtitleOf(block) { var h4 = block.querySelector('h4'); if (!h4) return ''; var sib = h4.nextElementSibling; return sib ? sib.textContent.replace(/\s+/g, ' ').trim() : ''; } var clone = el.cloneNode(true); var liveBlocks = el.querySelectorAll('.eventBlock'); var cloneBlocks = clone.querySelectorAll('.eventBlock'); var ok = 0, fail = 0, skipped = 0, blockedCount = 0, emptyCount = 0, realCount = 0; for (var i = 0; i < liveBlocks.length; i++) { var t = titleOf(liveBlocks[i]); var isBlocked = t.toLowerCase().indexOf('blocked') !== -1; var isEmptySlot = t.indexOf('PL') === 0 && !subtitleOf(liveBlocks[i]); if (isBlocked) { blockedCount++; continue; } if (isEmptySlot) { emptyCount++; continue; } realCount++; overlay.textContent = 'Getting your schedule... ' + (i + 1) + ' of ' + liveBlocks.length + '. Please stay on this page.'; var cls = liveBlocks[i].className; var schedMatch = cls.match(/schedule-(\d+)/); var resMatch = cls.match(/resource-(\d{4})-\d{2}-\d{2}/); if (!schedMatch) { skipped++; continue; } var scheduleId = schedMatch[1]; var year = resMatch ? resMatch[1] : String(new Date().getFullYear()); try { var resp = await fetch('/event/event-full-info', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' }, body: new URLSearchParams({ schedule_id: scheduleId, resource_id: year, current_component: '0', is_groupex: '0', is_human_resource_component_view: '0', is_staff_schedule_view: '1', locationId: '0' }), credentials: 'same-origin' }); var data = await resp.json(); if (data && data.status === 1 && data.content) { cloneBlocks[i].setAttribute('data-detail', encodeURIComponent(data.content)); ok++; } else { fail++; } } catch (e) { fail++; } await new Promise(function (r) { setTimeout(r, 150); }); } overlay.remove(); var htmlOut = clone.outerHTML; var msg = realCount + ' real booking' + (realCount === 1 ? '' : 's') + ' found (' + ok + ' with location/attendance details' + (fail ? ', ' + fail + ' failed' : '') + ').'; if (blockedCount) msg += ' ' + blockedCount + ' blocked time block' + (blockedCount === 1 ? '' : 's') + ' (ignored, unpaid).'; if (emptyCount) msg += ' ' + emptyCount + ' empty/unbooked slot' + (emptyCount === 1 ? '' : 's') + ' (ignored) — worth checking those in Club Automation if that seems off.'; if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(htmlOut).then(function () { alert(msg + ' Copied — now paste it into the timesheet app.'); }, function () { window.prompt(msg + ' Copy this manually (Ctrl+C / Cmd+C):', htmlOut); }); } else { window.prompt(msg + ' Copy this manually (Ctrl+C / Cmd+C):', htmlOut); } })();
```

Note on `resource_id`: this is set to the event's year (e.g. `2026`),
inferred from the schedule grid's own `resource-YYYY-MM-DD` class. That
held up in testing, but if it ever behaves oddly around a new year
boundary, check DevTools → Network on a real click and compare.

## Use it

1. Log into Club Automation like normal and open your weekly schedule.
2. Make sure the week you want has actually loaded on screen.
3. Click the bookmark.
4. A small banner appears in the corner saying to stay on the page while
   it works — it processes events one at a time with a short pause
   between each to avoid hammering the server, so a busy week can take
   5-15 seconds.
5. When it's done, you'll get an alert with a count of real bookings vs.
   blocked/empty slots, and the schedule is copied to your clipboard.
6. If your browser blocks clipboard access, you'll get a popup with the
   raw text instead — select all and copy from there.
7. Go to the timesheet app, paste into the box, and hit **Parse**.

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

**Clipboard didn't work** — some browsers block clipboard access from
bookmarklets depending on settings. You'll get a popup with the raw text
in it instead — just select all (Ctrl+A / Cmd+A), copy, and paste that
into the app.
