(async function () {
  // Where the timesheet app lives. If this bookmarklet was installed by
  // dragging the button from the app itself, refreshBookmarkletButton()
  // swaps this for wherever that page was actually loaded from (so a
  // self-hosted deployment still works) — this hardcoded default only
  // applies when the code here is installed by hand.
  var APP_URL = 'https://fvaldecan.github.io/agape-timesheet-generator/';
  var APP_ORIGIN = new URL(APP_URL).origin;

  // A snapshot of every configured rate rule's {match, matchMode} — core
  // rates (PL/GL/PHS) and custom "Other rates" alike, dollar amounts
  // excluded — baked in by refreshBookmarkletButton() when this button is
  // dragged/regenerated from the app. Empty here because a hand-installed
  // button (pasted from this file directly, not dragged) has no specific
  // coach's rates to bake in; it just means every booking title gets
  // prompted for once, same as an empty local cache would.
  var AGAPE_RULES_SNAPSHOT = [];

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
  // The custom-range entry point. A native <input type="date"> physically
  // can't submit an invalid calendar date, so unlike the typed-text version
  // this replaced, there's no "that doesn't look like a valid date" retry
  // loop to write — the browser's own picker already rules that out.
  function parseDateInputValue(raw) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw || '');
    if (!m) return null;
    return dateFromYMD(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10));
  }
  function promptForDateRange() {
    return new Promise(function (resolve) {
      var form = document.createElement('div');
      form.style.cssText = 'margin-top:12px !important;padding-top:12px !important;border-top:1px solid rgba(255,255,255,0.25) !important;';

      var errorLine = document.createElement('div');
      errorLine.style.cssText = 'all:unset !important;display:none !important;color:#ffb4a3 !important;font-size:12px !important;font-family:sans-serif !important;margin-bottom:6px !important;';
      form.appendChild(errorLine);

      function dateField(labelText) {
        var wrap = document.createElement('div');
        wrap.style.cssText = 'margin-bottom:8px !important;';
        var label = document.createElement('label');
        label.textContent = labelText;
        label.style.cssText = 'all:unset !important;display:block !important;color:#fff !important;font-size:12px !important;font-family:sans-serif !important;margin-bottom:3px !important;';
        var input = document.createElement('input');
        input.type = 'date';
        input.style.cssText = 'font-family:sans-serif !important;font-size:13px !important;padding:5px 7px !important;border-radius:4px !important;border:none !important;width:150px !important;box-sizing:border-box !important;';
        wrap.appendChild(label);
        wrap.appendChild(input);
        form.appendChild(wrap);
        return input;
      }
      var startInput = dateField('Start date');
      var endInput = dateField('End date');

      var btnRow = document.createElement('div');
      btnRow.style.cssText = 'margin-top:4px !important;';
      var fetchBtn = document.createElement('button');
      fetchBtn.textContent = 'Get schedule';
      fetchBtn.style.cssText = 'all:unset !important;display:inline-block !important;background:#fff !important;color:#1c2321 !important;border:none !important;padding:7px 12px !important;border-radius:4px !important;cursor:pointer !important;font-weight:600 !important;font-size:13px !important;font-family:sans-serif !important;margin-right:8px !important;';
      var cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'Never mind';
      cancelBtn.style.cssText = 'all:unset !important;display:inline-block !important;background:none !important;color:#fff !important;opacity:0.75 !important;border:1px solid rgba(255,255,255,0.4) !important;padding:6px 12px !important;border-radius:4px !important;cursor:pointer !important;font-size:13px !important;font-family:sans-serif !important;';
      btnRow.appendChild(fetchBtn);
      btnRow.appendChild(cancelBtn);
      form.appendChild(btnRow);

      function showError(text) {
        errorLine.textContent = text;
        errorLine.style.display = 'block';
      }

      var settled = false;
      function finish(value) {
        if (settled) return;
        settled = true;
        form.remove();
        resolve(value);
      }

      fetchBtn.onclick = function () {
        var start = parseDateInputValue(startInput.value);
        var end = parseDateInputValue(endInput.value);
        if (!start || !end) { showError('Pick both a start and end date.'); return; }
        if (end.getTime() < start.getTime()) { showError('End date needs to be on or after the start date.'); return; }
        if (daysBetweenUTC(start, end) + 1 > 60) { showError("That's a big range (more than 60 days) — double check the dates."); return; }
        finish({ start: start, end: end });
      };
      cancelBtn.onclick = function () { finish(null); };

      content.textContent = 'Enter a custom date range:';
      content.appendChild(form);
      try { startInput.focus(); } catch (e) {}
    });
  }
  // Replaces a native confirm() dialog (whose OK/Cancel carry no visible
  // label and were overloaded with two different meanings via copy alone)
  // with an explicit two-button choice, same overlay/button conventions as
  // promptForDateRange() above. Resolves straight to a {start, end} range or
  // null -- composing promptForDateRange() for the custom-range path -- so
  // the call site's contract doesn't change at all, just how it's produced.
  function promptForPeriodChoice(currentPeriod) {
    return new Promise(function (resolve) {
      var body = document.createElement('div');
      body.style.cssText = 'margin-top:10px !important;';

      var rangeLine = document.createElement('div');
      rangeLine.textContent = formatDateMDY(currentPeriod.start) + ' - ' + formatDateMDY(currentPeriod.end);
      rangeLine.style.cssText = 'all:unset !important;display:block !important;color:#fff !important;opacity:0.85 !important;font-size:13px !important;font-family:sans-serif !important;margin-bottom:10px !important;';
      body.appendChild(rangeLine);

      var btnRow = document.createElement('div');
      btnRow.style.cssText = 'margin-top:4px !important;';
      var currentBtn = document.createElement('button');
      currentBtn.textContent = 'Get current pay period';
      currentBtn.style.cssText = 'all:unset !important;display:inline-block !important;background:#fff !important;color:#1c2321 !important;border:none !important;padding:7px 12px !important;border-radius:4px !important;cursor:pointer !important;font-weight:600 !important;font-size:13px !important;font-family:sans-serif !important;margin-right:8px !important;';
      var customBtn = document.createElement('button');
      customBtn.textContent = 'Enter custom range';
      customBtn.style.cssText = 'all:unset !important;display:inline-block !important;background:none !important;color:#fff !important;opacity:0.75 !important;border:1px solid rgba(255,255,255,0.4) !important;padding:6px 12px !important;border-radius:4px !important;cursor:pointer !important;font-size:13px !important;font-family:sans-serif !important;';
      btnRow.appendChild(currentBtn);
      btnRow.appendChild(customBtn);
      body.appendChild(btnRow);

      var settled = false;
      function finish(value) {
        if (settled) return;
        settled = true;
        resolve(value);
      }

      currentBtn.onclick = function () { body.remove(); finish(currentPeriod); };
      customBtn.onclick = function () { body.remove(); promptForDateRange().then(finish); };

      content.textContent = 'Get your current pay period automatically?';
      content.appendChild(body);
      try { currentBtn.focus(); } catch (e) {}
    });
  }

  // The app tab doesn't open until the coach clicks "Send to timesheet
  // app" below, once scraping is done — see openAppTab()/startPinging()
  // for why and what replaces the old up-front window.open().
  var appWin = null;
  var appReady = false;
  var pingTimer = null;
  var onScheduleReceived = null;

  // Opens (or refocuses) the app tab. Only ever called from the "Send to
  // timesheet app" button's click handler, further down — that's still a
  // real, fresh user gesture, so window.open() still isn't treated as a
  // blocked popup, it's just a *different* click than the one that started
  // this whole run (the same "a fresh click gives a fresh gesture" idiom
  // the clipboard-copy fallback below already relies on). Deferring this
  // past the click that ran the bookmarklet is what keeps the coach on
  // Club Automation for the entire scrape instead of getting switched away
  // immediately.
  // A named target reuses the same tab across weeks. Passing an EMPTY url
  // (not APP_URL) is what makes reuse safe: if a window with this name
  // already exists, this call refocuses it WITHOUT navigating it — a real
  // navigation would reload the app tab and wipe out any weeks already
  // added to that in-progress sheet (nothing about the built sheet
  // persists across a reload, only Settings do).
  function openAppTab() {
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
  }

  // Starts pinging the app tab right after openAppTab() opens it, so it
  // gets as much time as possible to finish loading its own JS and
  // register its listener before waitForAck() below times out. Used to
  // start in parallel with the scrape loop instead (before this tab-switch
  // was deferred) — now there's no scrape left to run in parallel with, so
  // the app tab just gets a plain cold start once the coach clicks Send.
  // Purely reactive on the app's side (see index.html): it replies
  // AGAPE_READY to any ping, whether it just finished loading or has been
  // sitting open since a previous week.
  //
  // One listener handles both message types for the whole run: AGAPE_READY
  // just flips a flag, AGAPE_RECEIVED calls whatever waitForAck() below has
  // currently registered as onScheduleReceived (null until it's waiting).
  function startPinging() {
    if (!appWin) return;
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

  // A previous run's toast (e.g. one that hit the clipboard-fallback state
  // and was never dismissed) could still be sitting on the page -- remove
  // it before creating a new one, so two never stack.
  var prevOverlay = document.querySelector('[data-agape-overlay]');
  if (prevOverlay) prevOverlay.remove();

  var overlay = document.createElement('div');
  overlay.setAttribute('data-agape-overlay', '1');
  overlay.style.cssText = 'all:initial;position:fixed !important;top:16px !important;right:16px !important;z-index:2147483647 !important;background:#1c2321 !important;color:#fff !important;opacity:1 !important;filter:none !important;padding:16px 20px !important;border-radius:6px !important;font-family:sans-serif !important;font-size:14px !important;line-height:1.5 !important;box-shadow:0 4px 16px rgba(0,0,0,0.3) !important;max-width:320px !important;display:block !important;';
  overlay.setAttribute('role', 'status');
  overlay.setAttribute('aria-live', 'polite');

  // Always present, not just in the fallback state. Clears pingTimer before
  // removing the overlay -- without this, dismissing mid-flow (before appWin
  // is ever contacted successfully) would leave it pinging the app tab every
  // 300ms forever, with nothing left on screen to show for it.
  var closeBtn = document.createElement('button');
  closeBtn.textContent = String.fromCharCode(215); // ×
  closeBtn.setAttribute('aria-label', 'Dismiss');
  closeBtn.style.cssText = 'all:unset !important;position:absolute !important;top:6px !important;right:8px !important;cursor:pointer !important;color:#fff !important;opacity:0.6 !important;font-size:16px !important;line-height:1 !important;font-family:sans-serif !important;padding:4px 6px !important;';
  closeBtn.onclick = function () {
    if (pingTimer) clearInterval(pingTimer);
    overlay.remove();
  };
  overlay.appendChild(closeBtn);

  // Everything below targets `content`, never `overlay` itself, so a status
  // update (an overlay.textContent-style assignment) never wipes out the
  // close button sitting alongside it. `content` needs its own explicit
  // color/font here -- `overlay`'s `all:initial` reset doesn't cascade to
  // children the way inherited styles normally would, since `content` needs
  // that same reset applied to itself for the same host-page CSS isolation.
  var content = document.createElement('div');
  content.style.cssText = 'all:initial !important;display:block !important;color:#fff !important;font-family:sans-serif !important;font-size:14px !important;line-height:1.5 !important;padding-right:14px !important;';
  content.textContent = 'Getting your schedule... please stay on this page.';
  overlay.appendChild(content);

  // Attached to <html>, not <body> — some sites (including Club Automation)
  // dim document.body while an AJAX request is in flight, and CSS opacity
  // compounds through ancestors with no way for a child to opt back out.
  // Being a sibling of body instead of a descendant dodges that entirely.
  document.documentElement.appendChild(overlay);

  // Try to auto-fetch the requested range before falling back to whatever's
  // currently on screen. An unconditional ask on every click (not just when
  // nothing's on screen) — even a coach who already navigated to the right
  // week benefits from covering a whole multi-week pay period in one click
  // instead of one-week-at-a-time. A deliberate Cancel of the whole flow
  // (declining the current period, then also cancelling the custom-range
  // prompt) falls through to el as-is with no fallback notice — declining
  // isn't a failure. Only an *attempted* fetch that didn't pan out sets
  // usedFallback, since an unnoticed incomplete auto-fetch is a real
  // payroll-correctness risk and must never fail silently.
  var usedFallback = false;
  var userId = getUserId();
  if (userId) {
    var currentPeriod = currentPeriodRange(todayAsDateOnly());
    var requestedRange = await promptForPeriodChoice(currentPeriod);
    if (requestedRange) {
      // Under the old confirm(), the native dialog never touched content's
      // DOM, so choosing "yes" left its prior text alone. Now the choice UI
      // (and promptForDateRange()'s form) both write into content directly,
      // so without this reset either one's text would stay stuck on screen
      // through the fetch -- the scrape loop below only updates
      // content.textContent once it reaches a real (non-blocked) booking.
      content.textContent = 'Getting your schedule... please stay on this page.';
      var fetched = null;
      try { fetched = await fetchScheduleRange(userId, requestedRange.start, requestedRange.end); } catch (e) { fetched = null; }
      if (fetched) {
        el = fetched;
      } else {
        usedFallback = true;
      }
    }
  } else {
    usedFallback = true;
  }

  if (!el) {
    // No app tab or ping timer exists yet at this point — openAppTab()/
    // startPinging() don't run until the coach clicks "Send to timesheet
    // app", well after this check — so there's nothing to clean up here.
    overlay.remove();
    alert('Could not find your schedule on this page. Make sure you have your weekly schedule open (not the login page or another screen), and that it has finished loading, then try again.');
    return;
  }

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
  // Mirrors parseSchedule()'s displayTitle logic in index.html — combines
  // Club Automation's generic raw title (e.g. "Group class") with the
  // specific subtitle so each distinct class gets its own prompt and its
  // own rate rule, instead of every "Group class" booking collapsing into
  // one regardless of what class it actually is.
  function enrichedTitleOf(rawTitle, subtitle) {
    if (rawTitle === 'Group class') return rawTitle + ': ' + subtitle;
    if (rawTitle.indexOf('PL') === 0) return 'PL: ' + subtitle;
    return (rawTitle + ' ' + subtitle).trim();
  }
  // Deliberately duplicated from classifyRate()/ruleMatchesTitle()'s
  // matching logic in index.html, extended to check core rates ahead of
  // custom ones the same way classifyRate() does — this is a second
  // hand-sync point beyond the whole-file sync already documented near
  // the bottom of index.html, so keep the two in sync by hand if either
  // one's matching rule ever changes.
  function localClassifyMatches(title, snapshot) {
    for (var j = 0; j < snapshot.length; j++) {
      var r = snapshot[j];
      if (!r.match) continue;
      var mode = r.matchMode || 'contains';
      var matches = mode === 'startsWith'
        ? title.toUpperCase().indexOf(r.match.trim().toUpperCase()) === 0
        : title.toLowerCase().indexOf(r.match.trim().toLowerCase()) !== -1;
      if (matches) return true;
    }
    return false;
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
  // Every distinct real-booking title seen this run, piggybacking on the
  // titleOf()/subtitleOf() calls already made per iteration below — later
  // checked against AGAPE_RULES_SNAPSHOT to decide what to prompt for.
  var distinctTitles = [], seenTitles = {};

  for (var i = 0; i < liveBlocks.length; i++) {
    var t = titleOf(liveBlocks[i]);
    var sub = subtitleOf(liveBlocks[i]);
    var isBlocked = t.toLowerCase().indexOf('blocked') !== -1;
    var isEmptySlot = t.indexOf('PL') === 0 && !sub;
    if (isBlocked) { blockedCount++; continue; }
    if (isEmptySlot) { emptyCount++; continue; }
    realCount++;
    var enrichedT = enrichedTitleOf(t, sub);
    if (!seenTitles[enrichedT]) { seenTitles[enrichedT] = true; distinctTitles.push(enrichedT); }

    content.textContent = 'Getting your schedule... ' + (i + 1) + ' of ' + liveBlocks.length + '. Please stay on this page.';

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

  var titlesToPrompt = distinctTitles.filter(function (t) {
    return !localClassifyMatches(t, AGAPE_RULES_SNAPSHOT);
  });

  // Keeps asking until the coach either gives a valid number in range or
  // cancels — Cancel anywhere in this chain means "skip this title," never
  // "save a half-filled-in rule." max is optional (percentages pass 100;
  // dollar amounts have no upper bound).
  function promptForNumber(question, max) {
    while (true) {
      var raw = window.prompt(question);
      if (raw === null) return null;
      var n = parseFloat(raw.trim());
      var outOfRange = raw.trim() === '' || isNaN(n) || n < 0 || (max !== undefined && n > max);
      if (outOfRange) {
        alert("That doesn't look like a valid " + (max !== undefined ? ('percentage (0-' + max + ')') : 'dollar amount') + " — try again, or Cancel on the next prompt to skip this one.");
        continue;
      }
      return n;
    }
  }

  // Runs after the scrape above, not interleaved with it — confirm()/
  // prompt() are synchronous, not task-queue yields, so they don't go
  // stale the way an await does, and by this point the coach is still on
  // Club Automation regardless (the "Send to timesheet app" click, the one
  // gesture-timing-sensitive moment, hasn't happened yet). Each answered
  // title becomes a real rate rule; skipping (Cancel at any step) leaves
  // it exactly as unmatched as it is today — $0.00 with a warning icon in
  // the app, nothing lost, nothing forced.
  //
  // Two shapes on offer: flat hourly (rule.type='hourly'), or per-person
  // per-session with a percentage cut (rule.type='per_person') — the
  // latter covers group/clinic pricing like "$20/person per session,
  // Agape keeps 50%" regardless of how long the session runs. Headcount
  // itself isn't asked here — the app already collects that per-session,
  // not per rate rule (see rate row rendering in index.html).
  if (titlesToPrompt.length) content.textContent = 'Reviewing new booking types...';
  var newRateRules = [];
  for (var ti = 0; ti < titlesToPrompt.length; ti++) {
    var title = titlesToPrompt[ti];
    var setUp = confirm('"' + title + '" doesn\'t have a pay rate set up yet.\n\n' +
      "Set one up now? (Cancel to skip — it'll show as $0.00 with a warning on your sheet until you add one, same as today.)");
    if (!setUp) continue;

    var isFlat = confirm('Is "' + title + '" a flat hourly rate?\n\n' +
      'OK = flat $/hr.\nCancel = priced per person per session instead (e.g. $20/person, Agape keeps a %).');

    if (isFlat) {
      var rate = promptForNumber('What do you get paid per hour for "' + title + '"?');
      if (rate === null) continue;
      newRateRules.push({ match: title, matchMode: 'startsWith', type: 'hourly', mode: 'flat', rate: rate, defaultPeople: 1 });
    } else {
      var pricePerPerson = promptForNumber('What does each person pay for a session of "' + title + '"?');
      if (pricePerPerson === null) continue;
      var agapeCutPct = promptForNumber('What percentage does Agape keep for "' + title + '"?', 100);
      if (agapeCutPct === null) continue;
      newRateRules.push({ match: title, matchMode: 'startsWith', type: 'per_person', pricePerPerson: pricePerPerson, coachShare: 100 - agapeCutPct });
    }
  }

  // Embedded on the cloned root (not just the postMessage payload) so this
  // work survives the copy-to-clipboard fallback too, not only a
  // successful hand-off — see index.html's extractEmbeddedNewRateRules().
  if (newRateRules.length) {
    clone.setAttribute('data-agape-new-rate-rules', encodeURIComponent(JSON.stringify(newRateRules)));
  }
  var htmlOut = clone.outerHTML;

  var summaryLines = [realCount + ' real booking' + (realCount === 1 ? '' : 's') + ' found (' + ok + ' with location/attendance details' + (fail ? ', ' + fail + ' failed' : '') + ').'];
  if (usedFallback) summaryLines.push("Couldn't auto-fetch the full date range — only grabbed what's currently on screen. Navigate to any missing week and click the button again if needed.");
  if (blockedCount) summaryLines.push(blockedCount + ' blocked time block' + (blockedCount === 1 ? '' : 's') + ' (ignored, unpaid).');
  if (emptyCount) summaryLines.push(emptyCount + ' empty/unbooked slot' + (emptyCount === 1 ? '' : 's') + ' (ignored) — worth checking those in Club Automation if that seems off.');
  if (newRateRules.length) summaryLines.push('Set up ' + newRateRules.length + ' new pay rate' + (newRateRules.length === 1 ? '' : 's') + '.');
  var skippedCount = titlesToPrompt.length - newRateRules.length;
  if (skippedCount > 0) summaryLines.push(skippedCount + ' booking type' + (skippedCount === 1 ? '' : 's') + ' still without a rate — will show $0.00 until fixed.');
  var msg = summaryLines.join('\n');

  // Hand the scrape off to the app tab: send once the app has confirmed
  // it's listening (AGAPE_READY) AND openAppTab()/startPinging() have run,
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
            appWin.postMessage({ type: 'AGAPE_SCHEDULE_DATA', html: htmlOut, newRateRules: newRateRules }, APP_ORIGIN);
          } catch (e) {}
        } else {
          setTimeout(trySend, 300);
        }
      })();
    });
  }

  // Fallback: copying happens on a click of the button below, not
  // automatically here — by the time a failed hand-off attempt gets here,
  // the gesture from whatever click triggered it has gone stale in Safari
  // and both the Clipboard API and the execCommand fallback silently fail.
  // A fresh click gives a fresh gesture.
  function onCopyDone(success) {
    overlay.remove();
    if (success) {
      alert(msg + '\nCopied — now paste it into the timesheet app.');
    } else {
      window.prompt(msg + '\nCopy this manually (Ctrl+C / Cmd+C):', htmlOut);
    }
  }

  function showCopyFallback() {
    // openAppTab()/startPinging() ran and didn't pan out — stop pinging, or
    // it keeps hitting a tab nothing's waiting on every 300ms indefinitely.
    if (pingTimer) clearInterval(pingTimer);
    content.innerHTML = '';
    var whyLine = document.createElement('div');
    whyLine.textContent = "Couldn't reach the timesheet app tab automatically.";
    whyLine.style.cssText = 'all:unset !important;display:block !important;color:#fff !important;opacity:1 !important;font-size:14px !important;font-family:sans-serif !important;line-height:1.5 !important;';
    content.appendChild(whyLine);
    summaryLines.forEach(function (line) {
      var lineDiv = document.createElement('div');
      lineDiv.textContent = line;
      lineDiv.style.cssText = 'all:unset !important;display:block !important;color:#fff !important;opacity:0.85 !important;font-size:13px !important;font-family:sans-serif !important;line-height:1.5 !important;margin-top:6px !important;';
      content.appendChild(lineDiv);
    });
    var hint = document.createElement('div');
    hint.textContent = 'Click below to copy it, then paste into the app tab.';
    hint.style.cssText = 'all:unset !important;display:block !important;color:#fff !important;opacity:1 !important;font-size:14px !important;font-family:sans-serif !important;line-height:1.5 !important;margin-top:10px !important;margin-bottom:10px !important;';
    content.appendChild(hint);
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
    content.appendChild(copyBtn);
    copyBtn.focus();
  }

  // Scraping is done. This is the point where the coach chooses to move on
  // — clicking this button is a fresh user gesture, so openAppTab() below
  // can still call window.open() without it being treated as a blocked
  // popup, even though it's well after the click that started this run.
  // Staying on Club Automation up to exactly this point (instead of
  // switching away back when the bookmarklet was first clicked) is the
  // whole point of this redesign.
  content.innerHTML = '';
  var readyLine = document.createElement('div');
  readyLine.textContent = 'Your schedule is ready.';
  readyLine.style.cssText = 'all:unset !important;display:block !important;color:#fff !important;opacity:1 !important;font-size:14px !important;font-family:sans-serif !important;line-height:1.5 !important;font-weight:600 !important;';
  content.appendChild(readyLine);
  summaryLines.forEach(function (line) {
    var lineDiv = document.createElement('div');
    lineDiv.textContent = line;
    lineDiv.style.cssText = 'all:unset !important;display:block !important;color:#fff !important;opacity:0.85 !important;font-size:13px !important;font-family:sans-serif !important;line-height:1.5 !important;margin-top:6px !important;';
    content.appendChild(lineDiv);
  });
  var sendHint = document.createElement('div');
  sendHint.textContent = 'Click below to send it to your timesheet app.';
  sendHint.style.cssText = 'all:unset !important;display:block !important;color:#fff !important;opacity:1 !important;font-size:14px !important;font-family:sans-serif !important;line-height:1.5 !important;margin-top:10px !important;margin-bottom:10px !important;';
  content.appendChild(sendHint);
  var sendBtn = document.createElement('button');
  sendBtn.textContent = 'Send to timesheet app';
  sendBtn.style.cssText = 'all:unset !important;display:inline-block !important;background:#fff !important;color:#1c2321 !important;opacity:1 !important;border:none !important;padding:8px 14px !important;border-radius:4px !important;cursor:pointer !important;font-weight:600 !important;font-size:14px !important;font-family:sans-serif !important;';
  sendBtn.onclick = async function () {
    sendBtn.disabled = true;
    openAppTab();
    startPinging();
    content.innerHTML = '';
    content.textContent = 'Sending to your timesheet app...';

    var delivered = appWin ? await waitForAck() : false;

    if (delivered) {
      // Nothing else ever explicitly brings the app tab forward -- a fresh
      // tab likely gets focus as a side effect of being navigated at open
      // time, but a reused tab (the common case for a second week in the
      // same pay period) only ever got a bare reference via window.open('',
      // name), with no guaranteed focus. This is a different case from the
      // one Chrome blocks (a backgrounded tab reclaiming focus for itself,
      // confirmed a no-op in this repo's history) -- this is the CA-tab
      // script directing focus to a window it holds a legitimate handle to,
      // right when there's something real for the coach to look at.
      try { appWin.focus(); } catch (e) {}
      content.innerHTML = '';
      summaryLines.forEach(function (line, idx) {
        var lineDiv = document.createElement('div');
        lineDiv.textContent = line;
        lineDiv.style.cssText = 'all:unset !important;display:block !important;color:#fff !important;opacity:' + (idx > 0 ? '0.85' : '1') + ' !important;font-size:' + (idx > 0 ? '13px' : '14px') + ' !important;font-family:sans-serif !important;line-height:1.5 !important;margin-top:' + (idx > 0 ? '6px' : '0') + ' !important;';
        content.appendChild(lineDiv);
      });
      var doneLine = document.createElement('div');
      doneLine.textContent = 'Sent to the timesheet app — check that tab.';
      doneLine.style.cssText = 'all:unset !important;display:block !important;color:#fff !important;opacity:1 !important;font-size:14px !important;font-family:sans-serif !important;line-height:1.5 !important;margin-top:10px !important;font-weight:600 !important;';
      content.appendChild(doneLine);
      setTimeout(function () { overlay.remove(); }, 3000);
      return;
    }

    showCopyFallback();
  };
  content.appendChild(sendBtn);
  sendBtn.focus();
})();
