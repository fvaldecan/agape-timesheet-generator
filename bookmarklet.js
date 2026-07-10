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
  overlay.style.cssText = 'position:fixed;top:16px;right:16px;z-index:999999;background:#1c2321;color:#fff;padding:14px 18px;border-radius:6px;font-family:sans-serif;font-size:14px;box-shadow:0 4px 16px rgba(0,0,0,0.3);max-width:280px;';
  overlay.textContent = 'Getting your schedule... please stay on this page.';
  document.body.appendChild(overlay);

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

  overlay.remove();

  var htmlOut = clone.outerHTML;
  var msg = realCount + ' real booking' + (realCount === 1 ? '' : 's') + ' found (' + ok + ' with location/attendance details' + (fail ? ', ' + fail + ' failed' : '') + ').';
  if (blockedCount) msg += ' ' + blockedCount + ' blocked time block' + (blockedCount === 1 ? '' : 's') + ' (ignored, unpaid).';
  if (emptyCount) msg += ' ' + emptyCount + ' empty/unbooked slot' + (emptyCount === 1 ? '' : 's') + ' (ignored) — worth checking those in Club Automation if that seems off.';

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(htmlOut).then(function () {
      alert(msg + ' Copied — now paste it into the timesheet app.');
    }, function () {
      window.prompt(msg + ' Copy this manually (Ctrl+C / Cmd+C):', htmlOut);
    });
  } else {
    window.prompt(msg + ' Copy this manually (Ctrl+C / Cmd+C):', htmlOut);
  }
})();
