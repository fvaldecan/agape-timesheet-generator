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

// Reusable rate-rule editor: drag-to-reorder, add/remove rows, flat/split/
// per-person field sets, live missing-field highlighting. Extracted (PR 1
// commit 3, docs/MULTI_COACH_PLAN.md) so the multi-coach page can bind one
// instance per coach rather than sharing a single global state.rates.
//
// getRates() is a zero-arg closure returning the live rates array to
// mutate — each instance stays bound to whatever array it returns, so
// multiple editors never step on each other. containerEl is the element
// rows render into. onChange() runs after every mutation, before
// re-render; the caller wires persistence (and any "dirty" banner) there.
//
// Field-level inputs (match text, matchMode, rate/clientRate/agapeCut/
// pricePerPerson/coachShare, defaultPeople) are wired via addEventListener
// after the row's HTML is built, rather than inline onchange="" strings —
// inline strings can only reach global functions/state, which is exactly
// what a per-coach instance can't rely on. Fields carry a data-field
// attribute naming which property they write; a single generic listener
// handles all of them.
function createRateEditor(getRates, containerEl, onChange) {
  function render() {
    const rates = getRates();
    containerEl.innerHTML = '';
    let dragSrcIndex = null;

    rates.forEach((r, i) => {
      const missing = rateRuleMissingFields(r);
      const missCls = field => missing.includes(field) ? ' field-missing' : '';

      const row = document.createElement('div');
      row.className = 'rate-row' + (missing.length ? ' rate-row-incomplete' : '');
      row.draggable = true;

      // A row must be draggable as a whole (that's what makes the drag
      // image/drop target work), but only starting the drag from the handle
      // — not from anywhere you might click/select text in an input.
      let allowDrag = false;
      row.addEventListener('dragstart', e => {
        if (!allowDrag) { e.preventDefault(); return; }
        allowDrag = false;
        dragSrcIndex = i;
        e.dataTransfer.effectAllowed = 'move';
        row.classList.add('dragging');
      });
      row.addEventListener('dragend', () => row.classList.remove('dragging'));
      row.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        row.classList.add('drag-over');
      });
      row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
      row.addEventListener('drop', e => {
        e.preventDefault();
        row.classList.remove('drag-over');
        if (dragSrcIndex === null || dragSrcIndex === i) return;
        const [moved] = rates.splice(dragSrcIndex, 1);
        rates.splice(i, 0, moved);
        dragSrcIndex = null;
        onChange();
        render();
      });

      const missAttr = field => missing.includes(field) ? ' aria-invalid="true"' : '';
      const missPlaceholder = field => missing.includes(field) ? ' placeholder="required"' : '';
      const rowLabel = r.match ? `"${r.match}" rate row` : `rate row ${i + 1}`;

      let typeFields;
      if (r.type === 'per_person') {
        typeFields = `
          <span class="affix">$<input class="${missCls('pricePerPerson')}" data-field="pricePerPerson" value="${r.pricePerPerson ?? ''}" type="number" step="0.01" title="Price charged per person" aria-label="Price charged per person"${missAttr('pricePerPerson')}${missPlaceholder('pricePerPerson')}></span>
          <span class="rate-suffix">per person</span>
          <span class="rate-x">&times;</span>
          <span class="affix"><input class="${missCls('coachShare')}" data-field="coachShare" value="${r.coachShare ?? ''}" type="number" title="Percent of that price that goes to the coach" aria-label="Percent of that price that goes to the coach"${missAttr('coachShare')}${missPlaceholder('coachShare')}>%</span>
          <span class="rate-suffix">to coach</span>
        `;
      } else if (r.mode === 'split') {
        const clientRate = r.clientRate;
        const agapeCut = r.agapeCut;
        const net = (clientRate ?? 0) - (agapeCut ?? 0);
        typeFields = `
          <select class="rate-mode" aria-label="Pricing mode">
            <option value="flat">Flat $/hr</option>
            <option value="split" selected>Client rate − Agape cut</option>
          </select>
          <span class="affix">$<input class="${missCls('clientRate')}" data-field="clientRate" value="${clientRate ?? ''}" type="number" step="0.01" title="What the client is billed per hour" aria-label="What the client is billed per hour"${missAttr('clientRate')}${missPlaceholder('clientRate')}></span>
          <span class="rate-x">&minus;</span>
          <span class="affix">$<input class="${missCls('agapeCut')}" data-field="agapeCut" value="${agapeCut ?? ''}" type="number" step="0.01" title="What Agape keeps per hour" aria-label="What Agape keeps per hour"${missAttr('agapeCut')}${missPlaceholder('agapeCut')}></span>
          <span class="rate-suffix">= $${net.toFixed(2)}/hr to you</span>
          <span class="rate-x">&middot;</span>
          <input data-field="defaultPeople" value="${r.defaultPeople ?? 1}" type="number" min="1" class="w-40" title="Default # people for this booking type" aria-label="Default number of people for this booking type">
          <span class="rate-suffix">people</span>
        `;
      } else {
        typeFields = `
          <select class="rate-mode" aria-label="Pricing mode">
            <option value="flat" selected>Flat $/hr</option>
            <option value="split">Client rate − Agape cut</option>
          </select>
          <span class="affix">$<input class="${missCls('rate')}" data-field="rate" value="${r.rate ?? ''}" type="number" step="0.01" title="Pay per hour" aria-label="Pay per hour"${missAttr('rate')}${missPlaceholder('rate')}></span>
          <span class="rate-suffix">/hr to you</span>
          <span class="rate-x">&middot;</span>
          <input data-field="defaultPeople" value="${r.defaultPeople ?? 1}" type="number" min="1" class="w-40" title="Default # people for this booking type" aria-label="Default number of people for this booking type">
          <span class="rate-suffix">people</span>
        `;
      }

      row.innerHTML = `
        <span class="rate-drag-handle" title="Drag to reorder — first match wins" aria-hidden="true">&#10495;</span>
        <span class="rate-reorder">
          <button type="button" class="rate-move-btn" data-action="move-up" aria-label="Move ${escapeHtml(rowLabel)} up" title="Move up"${i === 0 ? ' disabled' : ''}>&#9650;</button>
          <button type="button" class="rate-move-btn" data-action="move-down" aria-label="Move ${escapeHtml(rowLabel)} down" title="Move down"${i === rates.length - 1 ? ' disabled' : ''}>&#9660;</button>
        </span>
        <input class="rate-match${missCls('match')}" data-field="match" value="${escapeHtml(r.match)}" placeholder="${missing.includes('match') ? 'Title text... (required)' : 'Title text...'}" aria-label="Match text from booking title"${missAttr('match')}>
        <select class="rate-matchmode" data-field="matchMode" aria-label="Match mode">
          <option value="startsWith" ${r.matchMode === 'startsWith' ? 'selected' : ''}>Starts with</option>
          <option value="contains" ${r.matchMode !== 'startsWith' ? 'selected' : ''}>Contains</option>
        </select>
        <select class="rate-type" aria-label="Rate type">
          <option value="hourly" ${r.type !== 'per_person' ? 'selected' : ''}>Hourly</option>
          <option value="per_person" ${r.type === 'per_person' ? 'selected' : ''}>Per-person split</option>
        </select>
        <span class="rate-fields">${typeFields}</span>
        <button data-action="remove" aria-label="Remove ${escapeHtml(rowLabel)}">remove</button>
      `;

      // Generic field wiring: every plain-value input/select carries a
      // data-field naming which rate-rule property it writes. matchMode
      // and match write the raw string; everything else here is numeric,
      // with the money fields falling back to undefined on a cleared
      // input (see rateRuleMissingFields) rather than coercing '' to 0.
      row.querySelectorAll('[data-field]').forEach(fieldEl => {
        fieldEl.addEventListener('change', () => {
          const field = fieldEl.dataset.field;
          const raw = fieldEl.value;
          if (field === 'match' || field === 'matchMode') {
            r[field] = raw;
          } else if (field === 'defaultPeople') {
            r.defaultPeople = Number(raw);
          } else {
            r[field] = raw === '' ? undefined : Number(raw);
          }
          onChange();
          render();
        });
      });

      row.querySelector('.rate-type').addEventListener('change', e => setType(i, e.target.value));
      const modeSelect = row.querySelector('.rate-mode');
      if (modeSelect) modeSelect.addEventListener('change', e => setMode(i, e.target.value));

      row.querySelector('[data-action="move-up"]').addEventListener('click', () => moveRow(i, -1));
      row.querySelector('[data-action="move-down"]').addEventListener('click', () => moveRow(i, 1));
      row.querySelector('[data-action="remove"]').addEventListener('click', () => {
        rates.splice(i, 1);
        onChange();
        render();
      });

      row.querySelector('.rate-drag-handle').addEventListener('mousedown', () => { allowDrag = true; });
      row.addEventListener('mouseup', () => { allowDrag = false; });
      containerEl.appendChild(row);
    });
  }

  function addRow() {
    getRates().push({ match: '', matchMode: 'contains', type: 'hourly', mode: 'flat', defaultPeople: 1 });
    onChange();
    render();
  }

  // Keyboard-operable equivalent of the mouse-only drag-to-reorder above —
  // order is meaningful ("first match wins"), so it can't be mouse-only.
  // Swaps two adjacent rows in place; out-of-range moves (top row up,
  // bottom row down) are no-ops rather than errors.
  function moveRow(i, direction) {
    const rates = getRates();
    const j = i + direction;
    if (j < 0 || j >= rates.length) return;
    [rates[i], rates[j]] = [rates[j], rates[i]];
    onChange();
    render();
  }

  // Switching type/mode only ever changes that one field — it never invents
  // a pay number for the fields that type/mode needs. Leaving them blank is
  // intentional: it surfaces as an obviously-empty box rather than a
  // plausible-looking guessed rate.
  function setType(i, value) {
    getRates()[i].type = value;
    onChange();
    render();
  }
  function setMode(i, value) {
    getRates()[i].mode = value;
    onChange();
    render();
  }

  return { render, addRow, moveRow, setType, setMode };
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

// BOOKMARKLET_SOURCE mirrors bookmarklet.js (the canonical, hand-edited
// source) — minified to one line so it can be dragged to a bookmarks bar
// or copy/pasted as a javascript: URL. This can't be a <script src> loader
// instead: Club Automation's CSP blocks cross-origin <script src> (and
// fetch/XHR) from a bookmarklet running on their page, so a loader
// silently does nothing when clicked there. It must be the full scraping
// logic inline. Keep this in sync with bookmarklet.js and BOOKMARKLET.md
// by hand whenever any of the three changes.
const BOOKMARKLET_SOURCE = `(async function () { if (window.location.hostname.indexOf('clubautomation.com') === -1) { alert('This button only works on your Club Automation schedule page. Go there first, open your weekly schedule, then click this again.'); return; } var el = document.getElementById('court_schedule'); if (!el) { alert('Could not find your schedule on this page. Make sure you have your weekly schedule open (not the login page or another screen), and that it has finished loading, then try again.'); return; } var overlay = document.createElement('div'); overlay.style.cssText = 'all:initial;position:fixed !important;top:16px !important;right:16px !important;z-index:2147483647 !important;background:#1c2321 !important;color:#fff !important;opacity:1 !important;filter:none !important;padding:16px 20px !important;border-radius:6px !important;font-family:sans-serif !important;font-size:14px !important;line-height:1.5 !important;box-shadow:0 4px 16px rgba(0,0,0,0.3) !important;max-width:320px !important;display:block !important;'; overlay.textContent = 'Getting your schedule... please stay on this page.'; overlay.setAttribute('role', 'status'); overlay.setAttribute('aria-live', 'polite'); document.documentElement.appendChild(overlay); function titleOf(block) { var h4 = block.querySelector('h4'); if (!h4) return ''; var clone = h4.cloneNode(true); var icons = clone.querySelectorAll('.icons'); for (var k = 0; k < icons.length; k++) { icons[k].remove(); } return clone.textContent.trim(); } function subtitleOf(block) { var h4 = block.querySelector('h4'); if (!h4) return ''; var sib = h4.nextElementSibling; return sib ? sib.textContent.replace(/\\s+/g, ' ').trim() : ''; } function copyFallback(text) { var ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.top = '0'; ta.style.left = '0'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.focus(); ta.select(); var ok = false; try { ok = document.execCommand('copy'); } catch (e) { ok = false; } document.body.removeChild(ta); return ok; } var clone = el.cloneNode(true); var liveBlocks = el.querySelectorAll('.eventBlock'); var cloneBlocks = clone.querySelectorAll('.eventBlock'); var ok = 0, fail = 0, skipped = 0, blockedCount = 0, emptyCount = 0, courtTimeCount = 0, realCount = 0; for (var i = 0; i < liveBlocks.length; i++) { var t = titleOf(liveBlocks[i]); var isBlocked = t.toLowerCase().indexOf('blocked') !== -1; var isEmptySlot = t.indexOf('PL') === 0 && !subtitleOf(liveBlocks[i]); var isCourtTime = t.trim().toLowerCase() === 'court time'; if (isBlocked) { blockedCount++; continue; } if (isEmptySlot) { emptyCount++; continue; } if (isCourtTime) { courtTimeCount++; continue; } realCount++; overlay.textContent = 'Getting your schedule... ' + (i + 1) + ' of ' + liveBlocks.length + '. Please stay on this page.'; var cls = liveBlocks[i].className; var schedMatch = cls.match(/schedule-(\\d+)/); var resMatch = cls.match(/resource-(\\d{4})-\\d{2}-\\d{2}/); if (!schedMatch) { skipped++; continue; } var scheduleId = schedMatch[1]; var year = resMatch ? resMatch[1] : String(new Date().getFullYear()); try { var resp = await fetch('/event/event-full-info', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' }, body: new URLSearchParams({ schedule_id: scheduleId, resource_id: year, current_component: '0', is_groupex: '0', is_human_resource_component_view: '0', is_staff_schedule_view: '1', locationId: '0' }), credentials: 'same-origin' }); var data = await resp.json(); if (data && data.status === 1 && data.content) { cloneBlocks[i].setAttribute('data-detail', encodeURIComponent(data.content)); ok++; } else { fail++; } } catch (e) { fail++; } await new Promise(function (r) { setTimeout(r, 150); }); } var htmlOut = clone.outerHTML; var summaryLines = [realCount + ' real booking' + (realCount === 1 ? '' : 's') + ' found (' + ok + ' with location/attendance details' + (fail ? ', ' + fail + ' failed' : '') + ').']; if (blockedCount) summaryLines.push(blockedCount + ' blocked time block' + (blockedCount === 1 ? '' : 's') + ' (ignored, unpaid).'); if (courtTimeCount) summaryLines.push(courtTimeCount + ' court rental' + (courtTimeCount === 1 ? '' : 's') + ' (Court Time, ignored — not payroll-relevant).'); if (emptyCount) summaryLines.push(emptyCount + ' empty/unbooked slot' + (emptyCount === 1 ? '' : 's') + ' (ignored) — worth checking those in Club Automation if that seems off.'); var msg = summaryLines.join('\\n'); function onCopyDone(success) { overlay.remove(); if (success) { alert(msg + '\\nCopied — now paste it into the timesheet app.'); } else { window.prompt(msg + '\\nCopy this manually (Ctrl+C / Cmd+C):', htmlOut); } } overlay.innerHTML = ''; summaryLines.forEach(function (line, idx) { var lineDiv = document.createElement('div'); lineDiv.textContent = line; lineDiv.style.cssText = 'all:unset !important;display:block !important;color:#fff !important;opacity:' + (idx > 0 ? '0.85' : '1') + ' !important;font-size:' + (idx > 0 ? '13px' : '14px') + ' !important;font-family:sans-serif !important;line-height:1.5 !important;margin-top:' + (idx > 0 ? '6px' : '0') + ' !important;'; overlay.appendChild(lineDiv); }); var hint = document.createElement('div'); hint.textContent = 'Click below to copy it.'; hint.style.cssText = 'all:unset !important;display:block !important;color:#fff !important;opacity:1 !important;font-size:14px !important;font-family:sans-serif !important;line-height:1.5 !important;margin-top:10px !important;margin-bottom:10px !important;'; overlay.appendChild(hint); var copyBtn = document.createElement('button'); copyBtn.textContent = 'Copy schedule'; copyBtn.style.cssText = 'all:unset !important;display:inline-block !important;background:#fff !important;color:#1c2321 !important;opacity:1 !important;border:none !important;padding:8px 14px !important;border-radius:4px !important;cursor:pointer !important;font-weight:600 !important;font-size:14px !important;font-family:sans-serif !important;'; copyBtn.onclick = function () { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(htmlOut).then(function () { onCopyDone(true); }, function () { onCopyDone(copyFallback(htmlOut)); }); } else { onCopyDone(copyFallback(htmlOut)); } }; overlay.appendChild(copyBtn); copyBtn.focus(); })();`;

// Builds the bookmarklet's javascript: URL and wires it onto the
// drag-to-bookmarks-bar button plus the read-only fallback textarea.
// Shared by index.html and multi-coach.html so adding the multi-coach
// page didn't mean a fourth hand-synced copy of this wiring.
//
// The script text itself is passed through encodeURIComponent before it's
// ever assigned to href. Reading an <a>'s .href back out (which is exactly
// what dragging a link to the bookmarks bar does) forces the browser to
// re-serialize the URL, and characters like { } ' [ ] # \ aren't in the
// safe set for that — they get silently percent-encoded, which corrupts
// unencoded JS source. Percent-encoding it ourselves first means the whole
// string is already just letters/digits/%XX, so that re-serialization is a
// no-op; per the HTML spec a javascript: URL is percent-decoded right
// before it runs, so the code still executes exactly as written.
function setupBookmarkletButton(buttonElId, textareaElId) {
  try {
    const bookmarkletCode = 'javascript:' + encodeURIComponent(BOOKMARKLET_SOURCE);
    const bookmarkletBtn = document.getElementById(buttonElId);
    if (bookmarkletBtn) bookmarkletBtn.setAttribute('href', bookmarkletCode);
    const bookmarkletCodeBox = document.getElementById(textareaElId);
    if (bookmarkletCodeBox) bookmarkletCodeBox.value = bookmarkletCode;
  } catch (e) {
    console.error('Could not set up the bookmarklet button:', e);
  }
}

// ---------------------------------------------------------------------
// Export builders — generalized (PR 1 commit 5, docs/MULTI_COACH_PLAN.md)
// to accept a `sections` array instead of a single implicit sheet, so the
// multi-coach page (PR 7) can produce one combined export with a section
// per confirmed coach. Each section is
// { name, byLocation, grandTotal, compLines }.
//
// For a single-element sections array the output is byte-identical to
// what index.html's downloadCsv/downloadDocx/printTimesheet produced
// before this extraction. The "Date,..." line (csvForSections /
// printHtmlForSections / docxDocumentForSections all agree on this) only
// ever appears when there's exactly one section — it's a single-coach-page
// artifact ("when was this sheet generated"), not something that makes
// sense repeated once per coach in a combined export.
// ---------------------------------------------------------------------
function csvForSections(sections) {
  let csv = '';
  sections.forEach((section, idx) => {
    const { name, byLocation, grandTotal, compLines } = section;
    csv += `Name,"${(name || '').replace(/"/g, '""')}"\n`;
    if (sections.length === 1) {
      csv += `Date,${formatDateDisplay(todayIso())}\n`;
    }
    csv += '\n';
    csv += 'Location,Date,Type of Class,Sport,Time,Rate,# People,Amount\n';
    Object.entries(byLocation).forEach(([loc, rows]) => {
      rows.forEach(r => {
        csv += `"${loc}","${formatDateDisplay(r.date)}","${r.type.replace(/"/g, '""')}","${(r.sport || '').replace(/"/g, '""')}","${formatTimeRange(r.startTime, r.endTime)}","${hourlyWageLabel(r)}",${r.numPeople ?? ''},${amountFor(r).toFixed(2)}\n`;
      });
    });
    csv += `,,,,,,TOTAL,${grandTotal.toFixed(2)}\n`;

    if (compLines && compLines.length > 0) {
      csv += `\nCOMPENSATION\n`;
      compLines.forEach(line => { csv += `"${line.replace(/"/g, '""')}"\n`; });
    }

    if (idx < sections.length - 1) csv += '\n';
  });
  return csv;
}

function printHtmlForSections(sections) {
  let html = '';
  sections.forEach(section => {
    const { name, byLocation, grandTotal, compLines } = section;
    html += `<div class="print-name">Name: ${escapeHtml(name)}</div>`;
    if (sections.length === 1) {
      html += `<div class="print-date">Date: ${escapeHtml(formatDateDisplay(todayIso()))}</div>`;
    }
    html += `<div class="print-title">TIMESHEET</div>`;

    Object.entries(byLocation).forEach(([loc, rows]) => {
      const subtotal = rows.reduce((s, r) => s + amountFor(r), 0);
      html += `<div class="print-loc">${escapeHtml(loc.toUpperCase())}</div>`;
      html += `<table class="print-table"><tr><th>Date</th><th>Type of Class</th><th>Sport</th><th>Time</th><th>Hourly Wage of Employee for each class</th><th class="num"># People</th><th class="num">Amount</th></tr>`;
      // Consecutive same-date rows get a real merged cell here — the anchor
      // row's <td> declares rowspan, the rest of the run just omits the Date
      // <td> entirely and the browser's own table layout handles the rest.
      const runInfo = dateRunInfo(rows);
      rows.forEach((r, i) => {
        const dateCell = runInfo[i].isFirstOfRun
          ? `<td rowspan="${runInfo[i].runLength}">${escapeHtml(formatDateDisplay(r.date))}</td>`
          : '';
        html += `<tr>
        ${dateCell}
        <td>${escapeHtml(r.type)}</td>
        <td>${escapeHtml(r.sport || '')}</td>
        <td>${escapeHtml(formatTimeRange(r.startTime, r.endTime))}</td>
        <td>${escapeHtml(hourlyWageLabel(r))}</td>
        <td class="num">${r.numPeople ?? '—'}</td>
        <td class="num">$${amountFor(r).toFixed(2)}</td>
      </tr>`;
      });
      html += `<tr class="print-subtotal"><td colspan="6">Subtotal:</td><td>$${subtotal.toFixed(2)}</td></tr>`;
      html += `</table>`;
    });

    html += `<div class="print-total">TOTAL: $${grandTotal.toFixed(2)}</div>`;

    if (compLines && compLines.length > 0) {
      html += `<div class="print-comp-title">COMPENSATION</div>`;
      html += `<div class="print-comp"><ul>${compLines.map(l => `<li>${escapeHtml(l)}</li>`).join('')}</ul></div>`;
    }
  });
  return html;
}

async function docxDocumentForSections(sections) {
  const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType, ShadingType } = docx;
  const colWidths = [1300, 2600, 1000, 1800, 1500, 1000, 1400];

  // Reused across every location table in every section — it's static
  // content (just the column labels), so one instance is fine to hand to
  // multiple Table constructors, same as the single-coach code did before
  // this was generalized.
  const headerRow = new TableRow({
    children: ['Date', 'Type of Class', 'Sport', 'Time', 'Hourly Wage of Employee for each class', '# People', 'Amount'].map((label, i) => new TableCell({
      width: { size: colWidths[i], type: WidthType.DXA },
      shading: { type: ShadingType.CLEAR, fill: 'D9D9D9' },
      children: [new Paragraph({ children: [new TextRun({ text: label, bold: true })] })],
    })),
  });

  const children = [];
  sections.forEach(section => {
    const { name, byLocation, grandTotal, compLines } = section;
    children.push(new Paragraph({ children: [new TextRun({ text: `Name ${name}`, bold: true, size: 24 })] }));
    if (sections.length === 1) {
      children.push(new Paragraph({ children: [new TextRun({ text: `Date ${formatDateDisplay(todayIso())}`, size: 20 })], spacing: { after: 100 } }));
    }
    children.push(new Paragraph({ children: [new TextRun({ text: 'TIMESHEET', bold: true, size: 24 })], spacing: { after: 300 } }));

    Object.entries(byLocation).forEach(([loc, rows]) => {
      const subtotal = rows.reduce((s, r) => s + amountFor(r), 0);
      children.push(new Paragraph({ children: [new TextRun({ text: loc.toUpperCase(), bold: true })], spacing: { before: 200, after: 100 } }));

      // Consecutive rows sharing a date get a real merged cell here (docx
      // supports rowSpan directly) — the anchor row declares rowSpan and the
      // rest of the run simply omits the Date cell from its children.
      const runInfo = dateRunInfo(rows);
      const dataRows = rows.map((r, idx) => {
        const cells = [];
        if (runInfo[idx].isFirstOfRun) {
          cells.push(new TableCell({
            width: { size: colWidths[0], type: WidthType.DXA },
            rowSpan: runInfo[idx].runLength,
            children: [new Paragraph({ children: [new TextRun({ text: formatDateDisplay(r.date) })] })],
          }));
        }
        [r.type, r.sport || '', formatTimeRange(r.startTime, r.endTime), hourlyWageLabel(r), r.numPeople ?? '—', `$${amountFor(r).toFixed(2)}`].forEach((val, j) => {
          const colIdx = j + 1; // colWidths[0] is Date, handled above
          cells.push(new TableCell({
            width: { size: colWidths[colIdx], type: WidthType.DXA },
            children: [new Paragraph({ alignment: colIdx >= 5 ? AlignmentType.RIGHT : AlignmentType.LEFT, children: [new TextRun({ text: String(val) })] })],
          }));
        });
        return new TableRow({ children: cells });
      });

      const subtotalRow = new TableRow({
        children: [
          new TableCell({ width: { size: colWidths[0]+colWidths[1]+colWidths[2]+colWidths[3]+colWidths[4]+colWidths[5], type: WidthType.DXA }, columnSpan: 6,
            children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: 'Subtotal:', bold: true })] })] }),
          new TableCell({ width: { size: colWidths[6], type: WidthType.DXA },
            children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: `$${subtotal.toFixed(2)}`, bold: true })] })] }),
        ],
      });

      children.push(new Table({ width: { size: colWidths.reduce((a,b)=>a+b,0), type: WidthType.DXA }, columnWidths: colWidths, rows: [headerRow, ...dataRows, subtotalRow] }));
      children.push(new Paragraph({ text: '', spacing: { after: 200 } }));
    });

    children.push(new Paragraph({ children: [new TextRun({ text: `TOTAL: $${grandTotal.toFixed(2)}`, bold: true, size: 28 })], spacing: { before: 200 } }));

    if (compLines && compLines.length > 0) {
      children.push(new Paragraph({
        children: [new TextRun({ text: 'COMPENSATION', bold: true, size: 22 })],
        spacing: { before: 400, after: 120 },
        border: { top: { style: 'single', size: 6, color: 'CCCCCC' } },
      }));
      compLines.forEach(line => {
        children.push(new Paragraph({
          children: [new TextRun({ text: line })],
          bullet: { level: 0 },
          spacing: { after: 60 },
        }));
      });
    }
  });

  return new Document({ sections: [{ properties: { page: { size: { width: 12240, height: 15840 } } }, children }] });
}
