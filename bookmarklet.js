(async function () {
  // Where the timesheet app lives. If this bookmarklet was installed by
  // dragging the button from the app itself, refreshBookmarkletButton()
  // swaps this for wherever that page was actually loaded from (so a
  // self-hosted deployment still works) — this hardcoded default only
  // applies when the code here is installed by hand.
  var APP_URL = 'https://fvaldecan.github.io/agape-timesheet-generator/';
  var APP_ORIGIN = new URL(APP_URL).origin;

  if (window.location.hostname.indexOf('clubautomation.com') === -1) {
    alert('This button only works on your Club Automation schedule page. Go there first, open your weekly schedule, then click this again.');
    return;
  }
  var el = document.getElementById('court_schedule');

  // ---------------------------------------------------------------------
  // Auto-fetch a date range from Club Automation, instead of relying on
  // its own date-nav UI already being on the right week. Not wired into
  // the main flow yet — these are pure helpers, exercised by a sandboxed
  // test harness (mocked fetch + synthetic HTML) before anything below
  // calls them. Pay periods are 14 days, Monday-anchored; ANCHOR_MONDAY
  // is a confirmed period-start Monday, used only to find which 14-day
  // bucket a given date falls into (re-verify this still holds before
  // trusting it blindly — pay periods could shift).
  // ---------------------------------------------------------------------
  var DAY_MS = 24 * 60 * 60 * 1000;
  var ANCHOR_MONDAY = new Date(Date.UTC(2026, 6, 20));
  function dateFromYMD(y, m, d) { return new Date(Date.UTC(y, m - 1, d)); }
  function addDaysUTC(date, n) { return new Date(date.getTime() + n * DAY_MS); }
  function daysBetweenUTC(a, b) { return Math.round((b.getTime() - a.getTime()) / DAY_MS); }
  function formatDateMDY(date) {
    return String(date.getUTCMonth() + 1).padStart(2, '0') + '/' + String(date.getUTCDate()).padStart(2, '0') + '/' + date.getUTCFullYear();
  }
  function todayAsDateOnly() {
    var now = new Date();
    return dateFromYMD(now.getFullYear(), now.getMonth() + 1, now.getDate());
  }
  // Floors (today - anchor) / 14d to find which pay period "today" falls in.
  function currentPeriodRange(today) {
    var daysSinceAnchor = daysBetweenUTC(ANCHOR_MONDAY, today);
    var periodIndex = Math.floor(daysSinceAnchor / 14);
    var periodStart = addDaysUTC(ANCHOR_MONDAY, periodIndex * 14);
    return { start: periodStart, end: addDaysUTC(periodStart, 13) };
  }
  // Only a 7-day fetch is confirmed to work, so a longer/odd-aligned range
  // gets covered by whole Monday-aligned weeks, rounding OUT past both
  // ends rather than risking an unconfirmed partial-week request.
  function weekChunksCovering(start, end) {
    var offsetIntoWeek = ((daysBetweenUTC(ANCHOR_MONDAY, start) % 7) + 7) % 7;
    var chunkStart = addDaysUTC(start, -offsetIntoWeek);
    var chunks = [];
    while (chunkStart.getTime() <= end.getTime()) {
      chunks.push({ start: chunkStart, end: addDaysUTC(chunkStart, 6) });
      chunkStart = addDaysUTC(chunkStart, 7);
    }
    return chunks;
  }
  // A hidden input already on the staff-schedule page — no separate lookup.
  function getUserId() {
    var input = document.getElementById('filter-user_id');
    return input && input.value ? input.value : null;
  }
  function fetchWeekDoc(userId, weekStart) {
    return fetch('/schedule/user-week', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
      body: new URLSearchParams({
        multiselectdata: '',
        season: '0',
        schedule_id: '',
        user_id: userId,
        date: formatDateMDY(weekStart),
        date_end: formatDateMDY(addDaysUTC(weekStart, 6)),
        reload: '1',
        save: '0',
        pageType: 'user-week',
        readonly: '1'
      }),
      credentials: 'same-origin'
    }).then(function (resp) {
      if (!resp.ok) throw new Error('bad status ' + resp.status);
      return resp.text();
    }).then(function (text) {
      return new DOMParser().parseFromString(text, 'text/html');
    });
  }
  // Trims fetched cells back to exactly what was requested — weekChunksCovering
  // rounds OUT to whole weeks, so a coach catching up one missed day must not
  // silently re-include a whole neighboring week that may already be on a
  // previous timesheet.
  function filterCellsByDateRange(container, start, end) {
    container.querySelectorAll('td[id^="court_"]').forEach(function (td) {
      var m = /^court_(\d{4})-(\d{2})-(\d{2})_row_/.exec(td.id);
      if (!m) { td.remove(); return; }
      var cellDate = dateFromYMD(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10));
      if (cellDate.getTime() < start.getTime() || cellDate.getTime() > end.getTime()) td.remove();
    });
  }
  // Fetches every needed week chunk sequentially (150ms apart, same courtesy
  // throttle as the per-event fetch below), merges all court_* cells into one
  // synthetic container, trims to the exact requested range. Returns null on
  // any failure — network error, non-2xx, or zero real cells across every
  // fetched week — checked BEFORE date-filtering, since a legitimately empty
  // custom sub-range is fine and shouldn't count as a failure.
  //
  // Critical: the merged <td> cells must land inside a real
  // <table><tbody><tr>, not loose under the wrapper <div> — appendChild()
  // doesn't enforce HTML nesting rules, so this looks fine as an in-memory
  // tree, but the final payload gets serialized to a string and re-parsed on
  // the app side, and HTML5's parser silently drops a <td> that isn't inside
  // a <table><tr> when parsing from text. Skipping the wrapper reproduces
  // exactly as "No events found," raw HTML dumped unparsed into the paste box.
  async function fetchScheduleRange(userId, start, end) {
    var chunks = weekChunksCovering(start, end);
    var docs = [];
    for (var i = 0; i < chunks.length; i++) {
      var doc;
      try {
        doc = await fetchWeekDoc(userId, chunks[i].start);
      } catch (e) {
        return null;
      }
      docs.push(doc);
      if (i < chunks.length - 1) await new Promise(function (r) { setTimeout(r, 150); });
    }
    var rawCellCount = docs.reduce(function (sum, d) { return sum + d.querySelectorAll('td[id^="court_"]').length; }, 0);
    if (rawCellCount === 0) return null;
    var container = document.createElement('div');
    container.id = 'court_schedule';
    var table = document.createElement('table');
    var tbody = document.createElement('tbody');
    var tr = document.createElement('tr');
    table.appendChild(tbody);
    tbody.appendChild(tr);
    container.appendChild(table);
    var seenIds = {};
    docs.forEach(function (doc) {
      doc.querySelectorAll('td[id^="court_"]').forEach(function (td) {
        if (seenIds[td.id]) return;
        seenIds[td.id] = true;
        // Fetched nodes belong to a separate DOMParser document — importNode
        // is required to bring one into this document before it can be
        // appended here.
        tr.appendChild(document.importNode(td, true));
      });
    });
    filterCellsByDateRange(container, start, end);
    return container;
  }

  if (!el) {
    alert('Could not find your schedule on this page. Make sure you have your weekly schedule open (not the login page or another screen), and that it has finished loading, then try again.');
    return;
  }

  // Open (or refocus) the app tab synchronously, in the same click gesture
  // that ran this bookmarklet — waiting until after the async scraping
  // below would get it treated as a blocked popup in some browsers, the
  // same gesture-staleness problem noted below for the clipboard copy.
  // A named target reuses the same tab across weeks. Passing an EMPTY url
  // (not APP_URL) is what makes reuse safe: if a window with this name
  // already exists, this call refocuses it WITHOUT navigating it — a real
  // navigation would reload the app tab and wipe out any weeks already
  // added to that in-progress sheet (nothing about the built sheet
  // persists across a reload, only Settings do).
  var appWin = null;
  try { appWin = window.open('', 'agapeTimesheetApp'); } catch (e) { appWin = null; }
  if (appWin) {
    var isFreshTab;
    try {
      // Reading .location.href succeeds and returns 'about:blank' only for
      // a brand-new same-origin window; it throws for a window already
      // navigated to the app (now cross-origin from clubautomation.com).
      // Writing/navigating .location cross-origin is always allowed —
      // only *reading* it is restricted — so this asymmetry is what lets
      // fresh-vs-reused be told apart without ever needing real access to
      // the app tab's contents.
      isFreshTab = (appWin.location.href === 'about:blank' || appWin.location.href === '');
    } catch (e) { isFreshTab = false; }
    if (isFreshTab) {
      try { appWin.location.href = APP_URL; } catch (e) { appWin = null; }
    }
  }

  // Start pinging the app tab now, in parallel with the scrape loop below
  // — not after it finishes — so the app tab gets the whole scrape
  // duration (often several seconds) to finish loading its own JS and
  // register its listener, instead of a cold start eating into the later
  // send-timeout. Purely reactive on the app's side (see index.html): it
  // replies AGAPE_READY to any ping, whether it just finished loading or
  // has been sitting open since a previous week.
  //
  // One listener handles both message types for the whole run: AGAPE_READY
  // just flips a flag, AGAPE_RECEIVED calls whatever waitForAck() below has
  // currently registered as onScheduleReceived (null until it's waiting).
  var appReady = false;
  var pingTimer = null;
  var onScheduleReceived = null;
  if (appWin) {
    pingTimer = setInterval(function () {
      if (appReady) { clearInterval(pingTimer); return; }
      try { appWin.postMessage({ type: 'AGAPE_PING' }, APP_ORIGIN); } catch (e) {}
    }, 300);
    window.addEventListener('message', function (e) {
      if (e.source !== appWin || !e.data) return;
      if (e.data.type === 'AGAPE_READY') appReady = true;
      else if (e.data.type === 'AGAPE_RECEIVED' && onScheduleReceived) onScheduleReceived();
    });
  }

  var overlay = document.createElement('div');
  overlay.style.cssText = 'all:initial;position:fixed !important;top:16px !important;right:16px !important;z-index:2147483647 !important;background:#1c2321 !important;color:#fff !important;opacity:1 !important;filter:none !important;padding:16px 20px !important;border-radius:6px !important;font-family:sans-serif !important;font-size:14px !important;line-height:1.5 !important;box-shadow:0 4px 16px rgba(0,0,0,0.3) !important;max-width:320px !important;display:block !important;';
  overlay.textContent = 'Getting your schedule... please stay on this page.';
  overlay.setAttribute('role', 'status');
  overlay.setAttribute('aria-live', 'polite');
  // Attached to <html>, not <body> — some sites (including Club Automation)
  // dim document.body while an AJAX request is in flight, and CSS opacity
  // compounds through ancestors with no way for a child to opt back out.
  // Being a sibling of body instead of a descendant dodges that entirely.
  document.documentElement.appendChild(overlay);

  function titleOf(block) {
    var h4 = block.querySelector('h4');
    if (!h4) return '';
    var clone = h4.cloneNode(true);
    var icons = clone.querySelectorAll('.icons');
    for (var k = 0; k < icons.length; k++) { icons[k].remove(); }
    return clone.textContent.trim();
  }
  function subtitleOf(block) {
    var h4 = block.querySelector('h4');
    if (!h4) return '';
    var sib = h4.nextElementSibling;
    return sib ? sib.textContent.replace(/\s+/g, ' ').trim() : '';
  }
  // Fallback for when navigator.clipboard.writeText() fails (Safari can
  // reject it once the user's original click gesture has expired, which
  // it will have by the time the async scraping loop below finishes).
  function copyFallback(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  var clone = el.cloneNode(true);
  var liveBlocks = el.querySelectorAll('.eventBlock');
  var cloneBlocks = clone.querySelectorAll('.eventBlock');
  var ok = 0, fail = 0, skipped = 0, blockedCount = 0, emptyCount = 0, realCount = 0;

  for (var i = 0; i < liveBlocks.length; i++) {
    var t = titleOf(liveBlocks[i]);
    var isBlocked = t.toLowerCase().indexOf('blocked') !== -1;
    var isEmptySlot = t.indexOf('PL') === 0 && !subtitleOf(liveBlocks[i]);
    if (isBlocked) { blockedCount++; continue; }
    if (isEmptySlot) { emptyCount++; continue; }
    realCount++;

    overlay.textContent = 'Getting your schedule... ' + (i + 1) + ' of ' + liveBlocks.length + '. Please stay on this page.';

    var cls = liveBlocks[i].className;
    var schedMatch = cls.match(/schedule-(\d+)/);
    var resMatch = cls.match(/resource-(\d{4})-\d{2}-\d{2}/);
    if (!schedMatch) { skipped++; continue; }
    var scheduleId = schedMatch[1];
    var year = resMatch ? resMatch[1] : String(new Date().getFullYear());

    try {
      var resp = await fetch('/event/event-full-info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
        body: new URLSearchParams({
          schedule_id: scheduleId,
          resource_id: year,
          current_component: '0',
          is_groupex: '0',
          is_human_resource_component_view: '0',
          is_staff_schedule_view: '1',
          locationId: '0'
        }),
        credentials: 'same-origin'
      });
      var data = await resp.json();
      if (data && data.status === 1 && data.content) {
        cloneBlocks[i].setAttribute('data-detail', encodeURIComponent(data.content));
        ok++;
      } else {
        fail++;
      }
    } catch (e) {
      fail++;
    }
    await new Promise(function (r) { setTimeout(r, 150); });
  }

  var htmlOut = clone.outerHTML;

  // The scrape loop above is done — swap the overlay's stale "N of M"
  // progress text for what's actually happening next, so it doesn't look
  // stuck during the hand-off (usually quick, but not instant).
  overlay.textContent = 'Sending to your timesheet app...';

  var summaryLines = [realCount + ' real booking' + (realCount === 1 ? '' : 's') + ' found (' + ok + ' with location/attendance details' + (fail ? ', ' + fail + ' failed' : '') + ').'];
  if (blockedCount) summaryLines.push(blockedCount + ' blocked time block' + (blockedCount === 1 ? '' : 's') + ' (ignored, unpaid).');
  if (emptyCount) summaryLines.push(emptyCount + ' empty/unbooked slot' + (emptyCount === 1 ? '' : 's') + ' (ignored) — worth checking those in Club Automation if that seems off.');
  var msg = summaryLines.join('\n');

  // Hand the scrape off to the app tab: send once the app has confirmed
  // it's listening (AGAPE_READY) AND the scrape above has finished,
  // whichever happens last. An 8s watchdog covers both "the app never
  // became ready" and "it became ready but never acknowledged receipt" —
  // on timeout (or if window.open never got a tab at all), delivered stays
  // false and the code below falls back to today's copy-to-clipboard flow,
  // so a coach is never stuck with no recourse.
  function waitForAck() {
    return new Promise(function (resolve) {
      var settled = false;
      var to = setTimeout(function () {
        if (!settled) { settled = true; onScheduleReceived = null; resolve(false); }
      }, 8000);
      onScheduleReceived = function () {
        if (settled) return;
        settled = true;
        clearTimeout(to);
        onScheduleReceived = null;
        resolve(true);
      };
      (function trySend() {
        if (settled) return;
        if (appReady) {
          try {
            appWin.postMessage({ type: 'AGAPE_SCHEDULE_DATA', html: htmlOut, newRateRules: [] }, APP_ORIGIN);
          } catch (e) {}
        } else {
          setTimeout(trySend, 300);
        }
      })();
    });
  }
  var delivered = appWin ? await waitForAck() : false;

  if (delivered) {
    overlay.innerHTML = '';
    summaryLines.forEach(function (line, idx) {
      var lineDiv = document.createElement('div');
      lineDiv.textContent = line;
      lineDiv.style.cssText = 'all:unset !important;display:block !important;color:#fff !important;opacity:' + (idx > 0 ? '0.85' : '1') + ' !important;font-size:' + (idx > 0 ? '13px' : '14px') + ' !important;font-family:sans-serif !important;line-height:1.5 !important;margin-top:' + (idx > 0 ? '6px' : '0') + ' !important;';
      overlay.appendChild(lineDiv);
    });
    var doneLine = document.createElement('div');
    doneLine.textContent = 'Sent to the timesheet app — check that tab.';
    doneLine.style.cssText = 'all:unset !important;display:block !important;color:#fff !important;opacity:1 !important;font-size:14px !important;font-family:sans-serif !important;line-height:1.5 !important;margin-top:10px !important;font-weight:600 !important;';
    overlay.appendChild(doneLine);
    setTimeout(function () { overlay.remove(); }, 3000);
    return;
  }

  // Fallback: copying happens on a click of the button below, not
  // automatically here — by the time the scraping loop (and the failed
  // hand-off attempt) above finishes, the user's original click gesture
  // has gone stale in Safari and both the Clipboard API and the
  // execCommand fallback silently fail. A fresh click gives a fresh gesture.
  function onCopyDone(success) {
    overlay.remove();
    if (success) {
      alert(msg + '\nCopied — now paste it into the timesheet app.');
    } else {
      window.prompt(msg + '\nCopy this manually (Ctrl+C / Cmd+C):', htmlOut);
    }
  }

  overlay.innerHTML = '';
  var whyLine = document.createElement('div');
  whyLine.textContent = "Couldn't reach the timesheet app tab automatically.";
  whyLine.style.cssText = 'all:unset !important;display:block !important;color:#fff !important;opacity:1 !important;font-size:14px !important;font-family:sans-serif !important;line-height:1.5 !important;';
  overlay.appendChild(whyLine);
  summaryLines.forEach(function (line) {
    var lineDiv = document.createElement('div');
    lineDiv.textContent = line;
    lineDiv.style.cssText = 'all:unset !important;display:block !important;color:#fff !important;opacity:0.85 !important;font-size:13px !important;font-family:sans-serif !important;line-height:1.5 !important;margin-top:6px !important;';
    overlay.appendChild(lineDiv);
  });
  var hint = document.createElement('div');
  hint.textContent = 'Click below to copy it, then paste into the app tab.';
  hint.style.cssText = 'all:unset !important;display:block !important;color:#fff !important;opacity:1 !important;font-size:14px !important;font-family:sans-serif !important;line-height:1.5 !important;margin-top:10px !important;margin-bottom:10px !important;';
  overlay.appendChild(hint);
  var copyBtn = document.createElement('button');
  copyBtn.textContent = 'Copy schedule';
  copyBtn.style.cssText = 'all:unset !important;display:inline-block !important;background:#fff !important;color:#1c2321 !important;opacity:1 !important;border:none !important;padding:8px 14px !important;border-radius:4px !important;cursor:pointer !important;font-weight:600 !important;font-size:14px !important;font-family:sans-serif !important;';
  copyBtn.onclick = function () {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(htmlOut).then(function () {
        onCopyDone(true);
      }, function () {
        onCopyDone(copyFallback(htmlOut));
      });
    } else {
      onCopyDone(copyFallback(htmlOut));
    }
  };
  overlay.appendChild(copyBtn);
  copyBtn.focus();
})();
