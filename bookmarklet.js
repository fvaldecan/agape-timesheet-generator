(async function () {
  // Where the timesheet app lives. If this bookmarklet was installed by
  // dragging the button from the app itself, refreshBookmarkletButton()
  // swaps this for wherever that page was actually loaded from (so a
  // self-hosted deployment still works) — this hardcoded default only
  // applies when the code here is installed by hand.
  var APP_URL = 'https://fvaldecan.github.io/agape-timesheet-generator/';
  var APP_ORIGIN = new URL(APP_URL).origin;
  // A snapshot of {match, matchMode} pairs from the app's current pay
  // rate rules, as of whenever this bookmarklet was last installed — used
  // below to guess which booking titles already have a rate configured,
  // without ever needing live access to the app's own storage (a
  // bookmarklet running on Club Automation's origin can't read that).
  // Always empty here: this file is the manually-installed copy, with no
  // page to pull a live snapshot from, so every title looks "new" to it.
  // The app-generated copy (index.html's drag-to-bookmarks button) fills
  // this in for real, and re-fills it each time a coach re-drags the
  // button — a stale/empty snapshot only ever causes a redundant question
  // or a missed one, never bad data, since the app re-checks everything
  // for real once it receives the schedule.
  var AGAPE_RULES_SNAPSHOT = [];

  if (window.location.hostname.indexOf('clubautomation.com') === -1) {
    alert('This button only works on your Club Automation schedule page. Go there first, open your weekly schedule, then click this again.');
    return;
  }
  var el = document.getElementById('court_schedule');
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

  // Reclaim focus immediately, then keep reclaiming it for as long as the
  // hand-off is in flight — window.open() firing once isn't enough on its
  // own, since navigating a fresh tab via .location.href above can steal
  // focus asynchronously, *after* that first reclaim already ran (the
  // navigation and the focus call race each other). Runs the whole scrape
  // duration (often several seconds), not just at open, and gets cleared
  // once `delivered` is decided either way, below. This can cause a brief
  // visible flash as focus bounces; that's an accepted tradeoff.
  // Programmatic focus is known to differ across Chrome/Firefox/Safari —
  // treat this as best-effort until verified live in each.
  try { window.focus(); } catch (e) {}
  var focusReclaimTimer = appWin ? setInterval(function () {
    try { window.focus(); } catch (e) {}
  }, 400) : null;

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
  // Deliberately duplicated from classifyRate()'s matching logic in
  // index.html — this is a second hand-sync point beyond the whole-file
  // sync already documented near the bottom of index.html, so keep the
  // two in sync by hand if either one's matching rule ever changes.
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
  // Every distinct real-booking title seen this run — piggybacks on the
  // titleOf() call already made per iteration below, no extra work. Not
  // used yet; a later commit checks each of these against a local rate
  // snapshot to decide what to prompt for.
  var distinctTitles = [], seenTitles = {};

  for (var i = 0; i < liveBlocks.length; i++) {
    var t = titleOf(liveBlocks[i]);
    var isBlocked = t.toLowerCase().indexOf('blocked') !== -1;
    var isEmptySlot = t.indexOf('PL') === 0 && !subtitleOf(liveBlocks[i]);
    if (isBlocked) { blockedCount++; continue; }
    if (isEmptySlot) { emptyCount++; continue; }
    realCount++;
    if (!seenTitles[t]) { seenTitles[t] = true; distinctTitles.push(t); }

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
  // stale the way an await does; the one gesture-timing-sensitive call
  // (window.open) already happened before any of this. Each answered
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

  // The scrape loop above is done — swap the overlay's stale "N of M"
  // progress text for a status matching what's actually happening next,
  // so it doesn't look stuck during the (usually quick, but not
  // instant) hand-off.
  overlay.textContent = 'Sending to your timesheet app...';

  var summaryLines = [realCount + ' real booking' + (realCount === 1 ? '' : 's') + ' found (' + ok + ' with location/attendance details' + (fail ? ', ' + fail + ' failed' : '') + ').'];
  if (blockedCount) summaryLines.push(blockedCount + ' blocked time block' + (blockedCount === 1 ? '' : 's') + ' (ignored, unpaid).');
  if (emptyCount) summaryLines.push(emptyCount + ' empty/unbooked slot' + (emptyCount === 1 ? '' : 's') + ' (ignored) — worth checking those in Club Automation if that seems off.');
  if (newRateRules.length) summaryLines.push('Set up ' + newRateRules.length + ' new pay rate' + (newRateRules.length === 1 ? '' : 's') + '.');
  var skippedCount = titlesToPrompt.length - newRateRules.length;
  if (skippedCount > 0) summaryLines.push(skippedCount + ' booking type' + (skippedCount === 1 ? '' : 's') + ' still without a rate — will show $0.00 until fixed.');
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
            appWin.postMessage({ type: 'AGAPE_SCHEDULE_DATA', html: htmlOut, newRateRules: newRateRules }, APP_ORIGIN);
          } catch (e) {}
        } else {
          setTimeout(trySend, 300);
        }
      })();
    });
  }
  var delivered = appWin ? await waitForAck() : false;
  if (focusReclaimTimer !== null) clearInterval(focusReclaimTimer);

  if (delivered) {
    // Only now — after the schedule is actually parsed and added on the
    // app side (AGAPE_RECEIVED only fires once that's finished, see
    // index.html's message listener) — bring that tab to the front. Before
    // this point the coach stayed on Club Automation the whole time.
    try { appWin.focus(); } catch (e) {}
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
