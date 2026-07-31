// ---------------------------------------------------------------------
// shared.js — parsing, rate math, grouping, and formatting logic shared
// between index.html (single-coach) and multi-coach.html (payroll review).
//
// See docs/MULTI_COACH_PLAN.md, PR 1 Commit 1. Everything below is moved
// unmodified from index.html's inline <script> except two deliberate
// signature changes (classifyRate and buildShifts now take an explicit
// `rates` argument instead of reading a single global `state.rates`,
// since multi-coach.html runs this pipeline once per coach with that
// coach's own rate list) plus the same change applied to validateRates
// for consistency. index.html is not wired up to this file yet — that's
// a separate, later commit.
// ---------------------------------------------------------------------

function escapeHtml(s) { return (s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// Splits pasted contract/compensation text into clean lines, stripping
// whatever bullet character it came in with (Word/PDF paste-ins commonly
// use "●", "•", "-", "*", or a number) so we can re-render consistently.
function parseBulletLines(text) {
  return (text || '')
    .split('\n')
    .map(line => line.replace(/^[\s●•▪○*-]+/, '').replace(/^\d+[.)]\s*/, '').trim())
    .filter(line => line.length > 0)
    .filter(line => line.toUpperCase() !== 'COMPENSATION'); // we render our own heading, skip a duplicate
}

// Returns the field *keys* (not labels) still blank on a rate row — used
// both to build the Parse-time error message and to highlight the exact
// empty input boxes in the editor. Every row in the list is required,
// including a freshly-added blank one: "+ add a rate" is a promise to
// finish it, not a free pass to leave it half-done.
const RATE_FIELD_LABELS = {
  match: 'match text',
  rate: 'hourly rate',
  clientRate: 'client rate',
  agapeCut: 'Agape cut',
  pricePerPerson: 'price per person',
  coachShare: 'coach share %',
};
function rateRuleMissingFields(r) {
  const blank = v => v === undefined || v === null || v === '' || (typeof v === 'number' && isNaN(v));
  const missing = [];
  if (blank(r.match)) missing.push('match');
  if (r.type === 'per_person') {
    if (blank(r.pricePerPerson)) missing.push('pricePerPerson');
    if (blank(r.coachShare)) missing.push('coachShare');
  } else if (r.mode === 'split') {
    if (blank(r.clientRate)) missing.push('clientRate');
    if (blank(r.agapeCut)) missing.push('agapeCut');
  } else {
    if (blank(r.rate)) missing.push('rate');
  }
  return missing;
}
// Signature change from index.html's original (zero-arg, read state.rates
// directly) — see file header. Behavior is otherwise identical.
function validateRates(rates) {
  const problems = [];
  if (rates.length === 0) {
    problems.push('No pay rate rules configured — every booking would compute as $0. Add at least one rate below.');
    return problems;
  }
  rates.forEach((r, i) => {
    const missing = rateRuleMissingFields(r);
    if (missing.length) {
      const label = r.match ? `"${r.match}"` : '(no match text yet)';
      problems.push(`Rate row ${i + 1} ${label}: missing ${missing.map(f => RATE_FIELD_LABELS[f]).join(', ')}.`);
    }
  });
  return problems;
}

// ---------------------------------------------------------------------
// Parser — mirrors parse_schedule.py, but reads the DOM directly
// ---------------------------------------------------------------------
function parseSchedule(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const cells = doc.querySelectorAll('td[id^="court_"]');
  const events = [];

  cells.forEach(td => {
    const block = td.querySelector('.eventBlock');
    if (!block) return;

    const m = td.id.match(/^court_(\d{4}-\d{2}-\d{2})_row_(\d{2}:\d{2})/);
    if (!m) return;
    const [_, dateStr, timeStr] = m;
    const start = new Date(`${dateStr}T${timeStr}:00`);
    const durationHrs = parseFloat(block.getAttribute('data-duration') || '0');
    const end = new Date(start.getTime() + durationHrs * 3600 * 1000);

    const h4 = block.querySelector('h4');
    if (!h4) return;
    const h4Clone = h4.cloneNode(true);
    h4Clone.querySelectorAll('.icons').forEach(n => n.remove());
    const title = h4Clone.textContent.trim();

    const subtitleDiv = h4.nextElementSibling;
    let subtitle = '';
    let nameCount = 0;
    if (subtitleDiv) {
      const clone = subtitleDiv.cloneNode(true);
      const brCount = clone.querySelectorAll('br').length;
      clone.querySelectorAll('br').forEach(br => br.replaceWith(' '));
      subtitle = clone.textContent.replace(/\s+/g, ' ').trim();
      if (subtitle) nameCount = brCount + 1; // e.g. "Lock<br>Yasutake" = 2 names
    }

    const fmtTime24 = d => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

    // If the enriched bookmarklet ran, each eventBlock carries a
    // data-detail attribute (URL-encoded event-full-info response HTML)
    // with real Location/Service/Attendance — use it when present.
    let detail = null;
    const detailAttr = block.getAttribute('data-detail');
    if (detailAttr) {
      try { detail = parseEventInfoHtml(decodeURIComponent(detailAttr)); } catch (e) { detail = null; }
    }

    // "PL: <coach name>" is Club Automation's label for who's teaching —
    // redundant here since the coach's name is already at the top of the
    // sheet, so we drop it and just show "PL: <client>".
    const displayTitle = title === 'Group class'
      ? `${title}: ${subtitle}`
      : (title.startsWith('PL') ? `PL: ${subtitle}` : `${title} ${subtitle}`.trim());

    // Round both onto the 30-minute grid, then re-derive duration from the
    // rounded pair — see roundToHalfHour() — rather than trusting the raw
    // data-duration attribute, so pay math always matches the on-grid time
    // actually shown.
    const startTimeRounded = roundToHalfHour(timeStr);
    const endTimeRounded = roundToHalfHour(fmtTime24(end));

    events.push({
      date: dateStr,                 // already yyyy-mm-dd from the cell id — canonical form, no conversion needed
      rawTitle: title,
      title: displayTitle,
      client: title.startsWith('PL') ? subtitle : '',
      startTime: startTimeRounded,
      endTime: endTimeRounded,
      durationHrs: hoursBetween(startTimeRounded, endTimeRounded),
      nameCount,                                    // # of names listed on the booking itself (semi-privates etc.)
      detailLocation: detail ? detail.location : null,
      detailAttendance: detail ? detail.attendanceCurrent : null,
      detailAttendanceMax: detail ? detail.attendanceMax : null,
      detailService: detail ? detail.service : null,
      _sort: start,
    });
  });

  events.sort((a, b) => a._sort - b._sort);
  return events;
}

// ---------------------------------------------------------------------
// Calculator — mirrors generate_timesheet.py, plus per-row editable
// location and attendee count (nothing here is auto-defaulted silently;
// anything unresolved lands in an "Unassigned" bucket for manual review).
// ---------------------------------------------------------------------
// Signature change from index.html's original classifyRate(title) (which
// read the single global state.rates directly) — see file header.
function classifyRate(title, rates) {
  for (const r of rates) {
    if (!r.match) continue;
    const mode = r.matchMode || 'contains';
    const matches = mode === 'startsWith'
      ? title.toUpperCase().startsWith(r.match.trim().toUpperCase())
      : title.toLowerCase().includes(r.match.trim().toLowerCase());
    if (matches) return r;
  }
  // Nothing configured matches this title — pay $0 rather than guessing a
  // plausible-looking number, so an unclassified booking is obviously wrong
  // and gets a rate rule added for it, instead of silently landing at $45.
  return { match: '', matchMode: 'contains', type: 'hourly', mode: 'flat', rate: 0, defaultPeople: 1 };
}
// Group class titles sometimes end with "- FV" / "- CM"; use that as a hint only.
function locationHint(title) {
  const m = title.match(/-\s*(FV|CM)\s*$/i);
  if (!m) return null;
  return m[1].toUpperCase() === 'FV' ? 'Fountain Valley' : 'Costa Mesa';
}
// Club Automation's Service field comes through as a full word ("Pickleball",
// "Tennis") — reviewers want the shorthand Club Automation itself uses
// elsewhere (its court names are "PBall Court #", "Tennis Court #"). Unknown
// services pass through unchanged rather than getting mangled.
function sportLabel(raw) {
  const s = (raw || '').trim().toLowerCase();
  if (s === 'pickleball') return 'PBALL';
  if (s === 'tennis') return 'TENNIS';
  return (raw || '').trim();
}

// Parses the balloon popup HTML Club Automation returns when you click an
// event (see BOOKMARKLET.md for how this gets captured). Not wired up to
// an automatic fetch yet — we don't have the request URL/params confirmed.
// Once we do, this is ready to plug into an automated per-event lookup.
function parseEventInfoHtml(contentHtml) {
  const doc = new DOMParser().parseFromString(contentHtml, 'text/html');
  const result = {};
  doc.querySelectorAll('.label').forEach(labelEl => {
    const label = labelEl.textContent.replace(':', '').trim().toLowerCase();
    let val = '';
    let node = labelEl.nextSibling;
    while (node && !(node.nodeType === 1 && node.tagName === 'BR')) {
      val += node.textContent || '';
      node = node.nextSibling;
    }
    val = val.trim();
    if (label === 'attendance') {
      const m = val.match(/(\d+)\s*\/\s*(\d+)/);
      if (m) { result.attendanceCurrent = Number(m[1]); result.attendanceMax = Number(m[2]); }
    } else if (label === 'location') {
      result.location = val;
    } else if (label === 'service') {
      result.service = val;
    } else if (label === 'duration') {
      result.duration = val;
    } else if (label === 'resource') {
      result.resource = val;
    }
  });
  return result;
}

let shiftIdCounter = 0;

// Signature change from index.html's original buildShifts(events) (which
// called the zero-arg classifyRate(title)) — see file header.
function buildShifts(events, rates) {
  const shifts = [];
  const excluded = { blocked: [], emptySlots: [] };
  events.forEach(e => {
    if (e.rawTitle.toLowerCase().includes('blocked')) {
      excluded.blocked.push(e);
      return;
    }
    // Open/unbooked slots show as "PL: <coach's last name>" with no client name — not a real lesson.
    if ((e.rawTitle.includes('GL') || e.rawTitle.includes('PL')) && !e.client) {
      excluded.emptySlots.push(e);
      return;
    }

    const rule = classifyRate(e.title, rates);
    // Real location from the click-to-fetch detail wins; fall back to the
    // "- FV"/"- CM" title-suffix guess for group classes if that's absent.
    const location = e.detailLocation || locationHint(e.title);
    // Headcount priority: real attendance (from the click-to-fetch detail)
    // > names actually listed on the booking (semi-privates, co-taught
    // group classes) > the rule's plain default. This applies whether the
    // matched rule is hourly or per-person — a class like "Drill & Play"
    // can match an hourly rate rule but should still show real attendance,
    // not just fall back to a generic default.
    const defaultPeople = e.detailAttendance ?? (e.nameCount > 1 ? e.nameCount : (rule.defaultPeople ?? 1));

    shifts.push({
      id: shiftIdCounter++,
      date: e.date,
      type: e.title,
      client: e.client,
      startTime: e.startTime,
      endTime: e.endTime,
      durationHrs: e.durationHrs,
      rule,                 // snapshot of the matched rate rule at parse time
      location,             // null = unassigned, needs manual pick
      sport: sportLabel(e.detailService),  // from the click-to-fetch detail; blank if unavailable
      numPeople: defaultPeople,
      attendanceMax: e.detailAttendanceMax ?? null,  // just a helpful hint, not used in pay math
      manualAmount: null,   // set when the coach overrides the computed amount
    });
  });
  return { shifts, excluded };
}

function effectiveHourlyRate(rule) {
  if (rule.mode === 'split') {
    return (rule.clientRate ?? 0) - (rule.agapeCut ?? 0);
  }
  return rule.rate ?? 0;
}

function amountFor(shift) {
  if (shift.manualAmount !== null && shift.manualAmount !== undefined) {
    return Math.round(shift.manualAmount * 100) / 100;
  }
  if (shift.rule.type === 'per_person') {
    const n = shift.numPeople || 0;
    const price = Number(shift.rule.pricePerPerson ?? 0);
    const share = (shift.rule.coachShare ?? 0) / 100;
    return Math.round(price * n * share * 100) / 100;
  }
  return Math.round(effectiveHourlyRate(shift.rule) * shift.durationHrs * 100) / 100;
}

// Turns a shift's date + start time into a real, comparable timestamp, so
// rows always display in chronological order no matter what order they
// were pasted/added/edited in. Anything that can't be parsed (e.g. a
// manually-added blank row) sorts to the end rather than breaking the sort.
// date/startTime are stored in canonical ISO form (yyyy-mm-dd, 24hr HH:MM —
// what native <input type="date">/<input type="time"> produce), so this no
// longer needs to regex-parse a display string like the old "7/8/26" +
// "8:00AM-9:00AM" format required.
function shiftSortKey(s) {
  if (!s.date) return Infinity;
  const ts = new Date(`${s.date}T${s.startTime || '00:00'}:00`).getTime();
  return isNaN(ts) ? Infinity : ts;
}

function computeGroups(shifts) {
  const sorted = [...shifts].sort((a, b) => shiftSortKey(a) - shiftSortKey(b));
  const byLocation = {};
  sorted.forEach(s => {
    const loc = s.location || 'Unassigned';
    if (!byLocation[loc]) byLocation[loc] = [];
    byLocation[loc].push(s);
  });
  let grandTotal = 0;
  Object.values(byLocation).forEach(rows => {
    rows.forEach(r => { grandTotal += amountFor(r); });
  });
  return { byLocation, grandTotal: Math.round(grandTotal * 100) / 100 };
}

// rows must already be sorted chronologically (computeGroups guarantees
// this) — consecutive same-date rows are then always adjacent. Returns a
// parallel array so the app table (visual merge) and docx/print exports
// (real rowspan) can both group same-day rows without re-deriving this.
// A blank date never merges with anything, even another blank one.
function dateRunInfo(rows) {
  const info = [];
  for (let i = 0; i < rows.length; i++) {
    if (i > 0 && rows[i].date && rows[i].date === rows[i - 1].date) {
      info.push({ isFirstOfRun: false, runLength: 0 });
      continue;
    }
    let len = 1;
    while (rows[i].date && i + len < rows.length && rows[i + len].date === rows[i].date) len++;
    info.push({ isFirstOfRun: true, runLength: len });
  }
  return info;
}

// Monday-start week key (yyyy-mm-dd of that week's Monday) for the "Week
// of ..." sub-heading nested inside each location section — purely a
// display/collapse aid for multi-week sheets. Location stays the primary
// grouping (it drives subtotals and the docx/print export structure);
// this only helps a coach orient within a location's rows once a sheet
// spans more than one week. A blank/unparseable date has no week.
function weekOf(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  if (isNaN(d.getTime())) return null;
  const day = d.getDay();
  const monday = new Date(d);
  monday.setDate(d.getDate() - ((day + 6) % 7));
  return `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
}
// rows must already be sorted chronologically (computeGroups guarantees
// this), so consecutive same-week rows are always adjacent — groups them
// into an ordered list of { weekStart, rows } without re-sorting.
function groupByWeek(rows) {
  const groups = [];
  let current = null;
  rows.forEach(r => {
    const wk = weekOf(r.date);
    if (!current || current.weekStart !== wk) {
      current = { weekStart: wk, rows: [] };
      groups.push(current);
    }
    current.rows.push(r);
  });
  return groups;
}

// A shift is a bad time order when both times are set and end <= start —
// real lessons are always same-day, so this almost always means a
// data-entry mistake (e.g. picking AM instead of PM) rather than a genuine
// overnight session, even though hoursBetween() still computes a (wrong)
// duration for it rather than blocking anything.
function shiftHasBadTimeOrder(s) {
  if (!s.startTime || !s.endTime) return false;
  return s.endTime <= s.startTime;
}

// Flags shifts whose date+time range overlaps another shift's, anywhere on
// the sheet — not just within the same location group, since one coach
// can't actually teach two lessons at once regardless of which court each
// is booked at. Times are canonical zero-padded "HH:MM" strings, so plain
// string comparison already matches time order — no need to parse them.
// Uses half-open interval overlap (max(start) < min(end)) so back-to-back
// sessions (one ends exactly when the next starts) never trigger a false
// positive; that's normal scheduling, not a conflict. Shifts already
// flagged as a bad time order are excluded from the overlap check — their
// range doesn't mean anything meaningful to compare.
function computeConflictIds(shifts) {
  const badOrderIds = new Set();
  const overlapIds = new Set();
  const usable = [];
  shifts.forEach(s => {
    if (shiftHasBadTimeOrder(s)) { badOrderIds.add(s.id); return; }
    if (s.date && s.startTime && s.endTime) usable.push(s);
  });
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const a = usable[i], b = usable[j];
      if (a.date !== b.date) continue;
      const overlapStart = a.startTime > b.startTime ? a.startTime : b.startTime;
      const overlapEnd = a.endTime < b.endTime ? a.endTime : b.endTime;
      if (overlapStart < overlapEnd) {
        overlapIds.add(a.id);
        overlapIds.add(b.id);
      }
    }
  }
  return { badOrderIds, overlapIds };
}

// Folds every reason a row's collapsed summary line should show a warning
// icon and auto-expand into one place — missing location, unmatched rate,
// and the two time-conflict conditions from computeConflictIds() all read
// the same way to the coach ("this row needs a look"), so they share one
// mechanic rather than three different visual languages.
function attentionReasons(shift, conflictIds) {
  const reasons = [];
  if (!shift.location) reasons.push('missing location');
  if (!shift.rule.match) reasons.push('no matching rate');
  if (conflictIds.badOrderIds.has(shift.id)) reasons.push('end time before start time');
  if (conflictIds.overlapIds.has(shift.id)) reasons.push('overlaps another entry');
  return reasons;
}
function shiftNeedsAttention(shift, conflictIds) {
  return attentionReasons(shift, conflictIds).length > 0;
}

function shiftFingerprint(s) {
  return [s.date, s.startTime, s.endTime, s.type, s.client].join('|').toLowerCase();
}

// Calendar-derived times land on the 30-minute grid the <select> editor
// (see timeOptionsHtml) offers, even when Club Automation hands us an odd
// one-off duration (see README "One-off event durations don't always match
// actual pay") — otherwise a parsed time with no matching <option> would
// render as blank despite a real value being stored underneath.
function roundToHalfHour(hhmm) {
  const m = (hhmm || '').match(/^(\d{2}):(\d{2})$/);
  if (!m) return hhmm;
  const totalMin = Number(m[1]) * 60 + Number(m[2]);
  const rounded = (Math.round(totalMin / 30) * 30) % (24 * 60);
  return `${String(Math.floor(rounded / 60)).padStart(2, '0')}:${String(rounded % 60).padStart(2, '0')}`;
}
// durationHrs normally comes from real calendar data at parse time, but
// editing start/end time (manual line items, or fixing a parsed time) has to
// keep it in sync by hand — otherwise hourly-rate rows stay priced off
// whatever durationHrs happened to be before the edit (0 for a fresh manual
// row), silently pinning amountFor() to $0 forever.
function hoursBetween(startTime, endTime) {
  const s = (startTime || '').match(/^(\d{2}):(\d{2})$/);
  const e = (endTime || '').match(/^(\d{2}):(\d{2})$/);
  if (!s || !e) return 0;
  const startMin = Number(s[1]) * 60 + Number(s[2]);
  let endMin = Number(e[1]) * 60 + Number(e[2]);
  if (endMin < startMin) endMin += 24 * 60; // overnight session
  return Math.round(((endMin - startMin) / 60) * 100) / 100;
}

// A rule with no match text is the classifyRate() fallback for a title that
// hit nothing configured (see classifyRate) — real rules always have match
// text, since validateRates() blocks Parse until every row has one. That
// makes `!rule.match` a reliable signal for "this shift's $0 is a fallback,
// not a real rate," distinct everywhere it's displayed or exported.
function rateLabelFor(rule) {
  if (!rule.match) return '<span class="rate-unmatched">No rate matched</span>';
  if (rule.type === 'per_person') return `$${rule.pricePerPerson ?? 0}/person &times; ${rule.coachShare ?? 0}%`;
  if (rule.mode === 'split') return `$${rule.clientRate ?? 0}&minus;$${rule.agapeCut ?? 0}/hr`;
  return `$${rule.rate ?? 0}/hr`;
}
function rateLabelPlain(rule) {
  if (!rule.match) return 'No rate matched';
  if (rule.type === 'per_person') return `$${rule.pricePerPerson ?? 0}/person x ${rule.coachShare ?? 0}%`;
  if (rule.mode === 'split') return `$${rule.clientRate ?? 0}-$${rule.agapeCut ?? 0}/hr`;
  return `$${rule.rate ?? 0}/hr`;
}

// Exports show the real effective hourly rate, not the rule's raw formula —
// a per-person split like "$20/person x 50%" doesn't tell you what the
// lesson actually paid per hour once headcount and duration are folded in.
// Flat/split-hourly rules already *are* an hourly rate, so their formula is
// left alone; only per-person needs the computed rate appended.
function hourlyWageLabel(shift) {
  const plain = rateLabelPlain(shift.rule);
  if (shift.rule.type !== 'per_person' || !shift.durationHrs) return plain;
  const perHour = (amountFor(shift) / shift.durationHrs).toFixed(2);
  return `$${perHour}/hr (${plain})`;
}

// Shifts store date/time in the canonical ISO form native <input type="date">
// / <input type="time"> controls use (yyyy-mm-dd, 24hr HH:MM) — these convert
// back to the M/D/YY + "8:00AM-9:00AM" display format the exported sheet has
// always used, so only the editing UI changed, not the CSV/docx output.
function formatDateDisplay(iso) {
  const m = (iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso || '';
  const [, y, mo, d] = m;
  return `${Number(mo)}/${Number(d)}/${y.slice(2)}`;
}
// Today in the same yyyy-mm-dd form formatDateDisplay expects — local date,
// not UTC, so it can't drift a day off around midnight.
function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function formatTime12(hhmm) {
  const m = (hhmm || '').match(/^(\d{2}):(\d{2})$/);
  if (!m) return '';
  let h = Number(m[1]);
  const min = m[2];
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${min}${ampm}`;
}
// Times are edited via a <select> of every half-hour mark rather than a
// native <input type="time"> — an off-grid value simply isn't one of the
// options, so there's nothing to round or validate after the fact. The
// range is 6am-9pm (lesson hours) rather than the full day, to keep the
// list short; a `selected` value outside that range (e.g. an odd import)
// still gets its own option appended so it isn't silently dropped.
const TIME_OPTION_START_MIN = 6 * 60;
const TIME_OPTION_END_MIN = 21 * 60;
function timeOptionsHtml(selected) {
  let html = `<option value=""${selected ? '' : ' selected'}>--:--</option>`;
  let sawSelected = false;
  for (let totalMin = TIME_OPTION_START_MIN; totalMin <= TIME_OPTION_END_MIN; totalMin += 30) {
    const val = `${String(Math.floor(totalMin / 60)).padStart(2, '0')}:${String(totalMin % 60).padStart(2, '0')}`;
    if (val === selected) sawSelected = true;
    html += `<option value="${val}"${val === selected ? ' selected' : ''}>${formatTime12(val)}</option>`;
  }
  if (selected && !sawSelected) {
    html += `<option value="${selected}" selected>${formatTime12(selected)}</option>`;
  }
  return html;
}
function formatTimeRange(startTime, endTime) {
  const s = formatTime12(startTime);
  const e = formatTime12(endTime);
  if (!s && !e) return '';
  return `${s}-${e}`;
}

// Windows/macOS both reject a handful of characters in filenames — strip
// them rather than let a coach's name (which can contain anything) produce
// a save dialog error.
function sanitizeFilenamePart(s) {
  return (s || '').replace(/[\\/:*?"<>|]/g, '').trim();
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
