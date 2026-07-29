(async function () {
  if (window.location.hostname.indexOf('clubautomation.com') === -1) {
    alert('This button only works on your Club Automation schedule page. Go there first, open your weekly schedule, then click this again.');
    return;
  }
  var el = document.getElementById('court_schedule');
  if (!el) {
    alert('Could not find your schedule on this page. Make sure you have your weekly schedule open (not the login page or another screen), and that it has finished loading, then try again.');
    return;
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
  var summaryLines = [realCount + ' real booking' + (realCount === 1 ? '' : 's') + ' found (' + ok + ' with location/attendance details' + (fail ? ', ' + fail + ' failed' : '') + ').'];
  if (blockedCount) summaryLines.push(blockedCount + ' blocked time block' + (blockedCount === 1 ? '' : 's') + ' (ignored, unpaid).');
  if (emptyCount) summaryLines.push(emptyCount + ' empty/unbooked slot' + (emptyCount === 1 ? '' : 's') + ' (ignored) — worth checking those in Club Automation if that seems off.');
  var msg = summaryLines.join('\n');

  // Copying happens on a click of the button below, not automatically here —
  // by the time the scraping loop above finishes, the user's original click
  // gesture has gone stale in Safari and both the Clipboard API and the
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
  summaryLines.forEach(function (line, idx) {
    var lineDiv = document.createElement('div');
    lineDiv.textContent = line;
    lineDiv.style.cssText = 'all:unset !important;display:block !important;color:#fff !important;opacity:' + (idx > 0 ? '0.85' : '1') + ' !important;font-size:' + (idx > 0 ? '13px' : '14px') + ' !important;font-family:sans-serif !important;line-height:1.5 !important;margin-top:' + (idx > 0 ? '6px' : '0') + ' !important;';
    overlay.appendChild(lineDiv);
  });
  var hint = document.createElement('div');
  hint.textContent = 'Click below to copy it.';
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
