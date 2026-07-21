// worktime — MD3 component layer.
//
// Replaces every browser/OS-rendered widget with a custom Material component:
// <select>, <datalist>, <input type=date|time>, confirm() and title= tooltips.
// Replacing a native control means inheriting everything the browser gave us
// for free, so each component here carries its own roles, keyboard model and
// focus handling; that plumbing is the bulk of this file, not the visuals.
//
// The one native element deliberately kept is <dialog>: it renders no OS chrome
// and supplies top-layer stacking, the backdrop and a real focus trap.

const KEYS_CLOSE = ['Escape', 'Tab'];

const pad2 = (n) => String(n).padStart(2, '0');

/** Is the user's locale a 12-hour one? Drives the time picker's AM/PM field. */
const HOUR12 = (() => {
  const opts = new Intl.DateTimeFormat([], { hour: 'numeric' }).resolvedOptions();
  return opts.hour12 !== false && opts.hourCycle !== 'h23' && opts.hourCycle !== 'h24';
})();

// ------------------------------------------------------------------ popups --

/** Every popup in this file is body-mounted and fixed, so no ancestor's
 *  overflow can clip it — the failure mode a CSS-only dropdown always hits. */
function mountPopup(className, role) {
  const el = document.createElement('div');
  el.className = className;
  if (role) el.setAttribute('role', role);
  el.hidden = true;
  document.body.append(el);
  return el;
}

/** Place below the anchor, flipping above when the viewport would clip it. */
function position(popup, anchor) {
  // A modal <dialog> renders in the top layer, so a body-mounted popup would be
  // painted underneath its backdrop. Re-home the popup into the open dialog
  // when the anchor lives there; fixed positioning stays viewport-relative
  // either way, so the coordinates below need no adjustment.
  const host = anchor.closest('dialog[open]') || document.body;
  if (popup.parentElement !== host) host.append(popup);

  popup.hidden = false;
  const a = anchor.getBoundingClientRect();
  const p = popup.getBoundingClientRect();
  const gap = 4;
  let top = a.bottom + gap;
  if (top + p.height > innerHeight - 8 && a.top - p.height - gap > 8) {
    top = a.top - p.height - gap;
  }
  const left = Math.min(Math.max(8, a.left), Math.max(8, innerWidth - p.width - 8));
  popup.style.top = `${Math.max(8, top)}px`;
  popup.style.left = `${left}px`;
  popup.style.minWidth = `${a.width}px`;
}

/** Close when focus or a pointer goes anywhere outside the popup + its anchor. */
function autoDismiss(popup, anchor, close) {
  const onDown = (e) => {
    if (!popup.contains(e.target) && !anchor.contains(e.target)) close();
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  // Scroll is captured so that scrolling *any* ancestor dismisses the popup —
  // it is anchored to a viewport position it cannot keep. Scrolling inside the
  // popup is the exception: a long option list has its own overflow, and
  // closing on that would make it impossible to reach the bottom of the list.
  const onScroll = (e) => { if (!popup.contains(e.target)) close(); };
  addEventListener('pointerdown', onDown, true);
  addEventListener('keydown', onKey, true);
  addEventListener('resize', close);
  addEventListener('scroll', onScroll, true);
  return () => {
    removeEventListener('pointerdown', onDown, true);
    removeEventListener('keydown', onKey, true);
    removeEventListener('resize', close);
    removeEventListener('scroll', onScroll, true);
  };
}

// ----------------------------------------------------------------- listbox --

/**
 * Shared listbox behind both the select and the autocomplete. Selection is
 * tracked with aria-activedescendant so DOM focus stays on the combobox, which
 * is what lets a text input keep receiving keystrokes while the list is open.
 */
function createListbox(anchor, { onPick, id }) {
  const list = mountPopup('md-menu', 'listbox');
  list.id = id;
  let items = [];
  let active = -1;
  let detach = null;

  const render = () => {
    list.textContent = '';
    items.forEach((item, i) => {
      const opt = document.createElement('div');
      opt.className = 'md-menu-item state';
      opt.id = `${id}-opt-${i}`;
      opt.setAttribute('role', 'option');
      opt.setAttribute('aria-selected', String(item.selected === true));
      opt.textContent = item.label;
      if (item.leading) opt.prepend(item.leading);
      // A real element, not ::after — .state already owns that pseudo-element
      // for the state layer, and its inset/opacity would swallow the check.
      if (item.selected) {
        const check = document.createElement('span');
        check.className = 'md-menu-check';
        opt.append(check);
      }
      opt.addEventListener('pointerdown', (e) => e.preventDefault());
      opt.addEventListener('click', () => onPick(item));
      list.append(opt);
    });
  };

  const paint = () => {
    [...list.children].forEach((c, i) => c.classList.toggle('active', i === active));
    anchor.setAttribute('aria-activedescendant', active < 0 ? '' : `${id}-opt-${active}`);
    if (active >= 0) list.children[active]?.scrollIntoView({ block: 'nearest' });
  };

  const api = {
    get open() { return !list.hidden; },
    get items() { return items; },
    show(next) {
      items = next;
      if (!items.length) return api.close();
      render();
      position(list, anchor);
      anchor.setAttribute('aria-expanded', 'true');
      active = items.findIndex((i) => i.selected);
      paint();
      detach ||= autoDismiss(list, anchor, api.close);
    },
    close() {
      if (list.hidden) return;
      list.hidden = true;
      anchor.setAttribute('aria-expanded', 'false');
      anchor.setAttribute('aria-activedescendant', '');
      active = -1;
      detach?.();
      detach = null;
    },
    /** Returns true when the key was consumed, so callers can preventDefault. */
    handleKey(e) {
      if (!api.open) return false;
      if (e.key === 'ArrowDown') { active = (active + 1) % items.length; paint(); return true; }
      if (e.key === 'ArrowUp') { active = (active - 1 + items.length) % items.length; paint(); return true; }
      if (e.key === 'Home') { active = 0; paint(); return true; }
      if (e.key === 'End') { active = items.length - 1; paint(); return true; }
      if (e.key === 'Enter' && active >= 0) { onPick(items[active]); return true; }
      if (KEYS_CLOSE.includes(e.key)) { api.close(); return e.key === 'Escape'; }
      return false;
    },
  };
  return api;
}

// ------------------------------------------------------------------ select --

/**
 * MD3 exposed dropdown menu, replacing <select>. The trigger is a button rather
 * than a text input because the value set is closed — typing into it would
 * promise filtering the component does not do.
 */
export function createSelect(mount, { label, onChange }) {
  const field = document.createElement('div');
  field.className = 'field dense md-select';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'md-select-trigger state';
  trigger.setAttribute('role', 'combobox');
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.id = `${mount.id || 'sel'}-trigger`;

  const text = document.createElement('span');
  text.className = 'md-select-text';
  trigger.append(text, arrowIcon());

  const lab = document.createElement('label');
  lab.className = 'md-select-label';
  lab.textContent = label;
  lab.setAttribute('for', trigger.id);

  field.append(trigger, lab);
  mount.replaceWith(field);

  let options = [];
  let value = '';

  const box = createListbox(trigger, {
    id: `${trigger.id}-list`,
    onPick: (item) => {
      box.close();
      trigger.focus();
      if (item.value === value) return;
      value = item.value;
      paint();
      onChange(value);
    },
  });
  trigger.setAttribute('aria-controls', `${trigger.id}-list`);

  const paint = () => {
    const hit = options.find((o) => o.value === value);
    text.textContent = hit ? hit.label : '';
  };

  const open = () => box.show(options.map((o) => ({ ...o, selected: o.value === value })));

  trigger.addEventListener('click', () => (box.open ? box.close() : open()));
  trigger.addEventListener('keydown', (e) => {
    if (!box.open && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
      e.preventDefault(); open(); return;
    }
    if (box.handleKey(e)) e.preventDefault();
  });

  return {
    setOptions(next) { options = next; paint(); },
    setValue(next) { value = next; paint(); },
    get value() { return value; },
  };
}

// ------------------------------------------------------------ autocomplete --

/**
 * MD3 autocomplete, replacing <datalist>. Unlike a datalist it filters on
 * substring rather than prefix, and it never blocks free text — the project
 * field has to accept slugs that do not exist yet.
 */
export function attachAutocomplete(input, getOptions) {
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  const id = `${input.id}-ac`;
  input.setAttribute('aria-controls', id);

  // Committing a choice sets .value and fires `input` for anything listening.
  // That event lands back on our own refresh handler, which would immediately
  // re-open the list we just closed — so suppress reentry for the commit.
  let picking = false;

  const box = createListbox(input, {
    id,
    onPick: (item) => {
      picking = true;
      input.value = item.value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      box.close();
      input.focus();
      picking = false;
    },
  });

  const refresh = () => {
    if (picking) return;
    const q = input.value.trim().toLowerCase();
    const hits = getOptions()
      .filter((o) => !q || o.toLowerCase().includes(q))
      .slice(0, 8)
      .map((o) => ({ value: o, label: o, selected: o === input.value }));
    box.show(hits);
  };

  input.addEventListener('input', refresh);
  input.addEventListener('focus', refresh);
  input.addEventListener('blur', () => setTimeout(box.close, 120));
  input.addEventListener('keydown', (e) => {
    if (!box.open && e.key === 'ArrowDown') { refresh(); e.preventDefault(); return; }
    // When the list consumes the key, stop it dead. Enter over a highlighted
    // suggestion means "take this one" — without stopImmediatePropagation it
    // also reaches the app's own Enter handlers on this same element and
    // starts a timer / submits the form in the same keystroke. This listener
    // is registered before those, which is what makes the stop effective.
    if (box.handleKey(e)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  });
  return box;
}

// -------------------------------------------------------------- date picker --

const MONTHS = (m) => new Date(2000, m, 1).toLocaleDateString([], { month: 'long' });
const WEEKDAYS = () =>
  // 2024-01-01 was a Monday, matching weekStart() in reports.js.
  [...Array(7)].map((_, i) =>
    new Date(2024, 0, 1 + i).toLocaleDateString([], { weekday: 'narrow' }));

/** Replaces <input type="date">. Value stays a "YYYY-MM-DD" string. */
export function attachDatePicker(input) {
  input.type = 'text';
  input.autocomplete = 'off';
  input.setAttribute('inputmode', 'numeric');
  input.setAttribute('aria-haspopup', 'dialog');

  const btn = trailingButton('Choose date', calendarIcon());
  input.after(btn);
  input.classList.add('has-trailing');

  const pop = mountPopup('md-datepicker', 'dialog');
  pop.setAttribute('aria-label', 'Choose date');
  pop.setAttribute('aria-modal', 'false');

  let cursor = new Date();
  let detach = null;

  const parse = () => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.value.trim());
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  };

  const close = () => {
    if (pop.hidden) return;
    pop.hidden = true;
    detach?.(); detach = null;
    btn.setAttribute('aria-expanded', 'false');
  };

  const commit = (d) => {
    input.value = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    close();
    input.focus();
  };

  const render = () => {
    pop.textContent = '';

    const head = document.createElement('div');
    head.className = 'md-dp-head';
    const prev = iconButton('Previous month', chevron('left'));
    const next = iconButton('Next month', chevron('right'));
    const title = document.createElement('div');
    title.className = 'md-dp-title';
    title.setAttribute('aria-live', 'polite');
    title.textContent = `${MONTHS(cursor.getMonth())} ${cursor.getFullYear()}`;
    prev.onclick = () => { cursor = new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1); render(); };
    next.onclick = () => { cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1); render(); };
    head.append(prev, title, next);

    const grid = document.createElement('div');
    grid.className = 'md-dp-grid';
    grid.setAttribute('role', 'grid');
    grid.setAttribute('aria-label', title.textContent);

    for (const w of WEEKDAYS()) {
      const c = document.createElement('div');
      c.className = 'md-dp-wd';
      c.setAttribute('role', 'columnheader');
      c.setAttribute('aria-label', w);
      c.textContent = w;
      grid.append(c);
    }

    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const lead = (first.getDay() + 6) % 7; // Monday-first offset
    const days = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
    const sel = parse();
    const today = new Date();
    const same = (a, b) => a && b && a.getFullYear() === b.getFullYear()
      && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

    for (let i = 0; i < lead; i++) {
      const blank = document.createElement('div');
      blank.setAttribute('role', 'gridcell');
      grid.append(blank);
    }
    for (let d = 1; d <= days; d++) {
      const date = new Date(cursor.getFullYear(), cursor.getMonth(), d);
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'md-dp-day state';
      cell.setAttribute('role', 'gridcell');
      cell.textContent = String(d);
      cell.setAttribute('aria-label', date.toLocaleDateString([],
        { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }));
      if (same(date, sel)) { cell.classList.add('selected'); cell.setAttribute('aria-selected', 'true'); }
      if (same(date, today)) cell.classList.add('today');
      // Roving tabindex: one stop for the whole grid, arrows move within it.
      cell.tabIndex = same(date, sel) || (!sel && same(date, today)) ? 0 : -1;
      cell.onclick = () => commit(date);
      cell.addEventListener('keydown', (e) => {
        const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
        if (step) {
          e.preventDefault();
          const to = new Date(date.getFullYear(), date.getMonth(), date.getDate() + step);
          if (to.getMonth() !== cursor.getMonth() || to.getFullYear() !== cursor.getFullYear()) {
            cursor = new Date(to.getFullYear(), to.getMonth(), 1);
            render();
          }
          focusDay(to);
        } else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); commit(date); }
      });
      grid.append(cell);
    }

    const foot = document.createElement('div');
    foot.className = 'md-dp-foot';
    const todayBtn = document.createElement('button');
    todayBtn.type = 'button';
    todayBtn.className = 'btn-text state';
    todayBtn.textContent = 'Today';
    todayBtn.onclick = () => commit(new Date());
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn-text state';
    cancel.textContent = 'Cancel';
    cancel.onclick = () => { close(); input.focus(); };
    foot.append(todayBtn, cancel);

    pop.append(head, grid, foot);
    position(pop, input.parentElement);
  };

  const focusDay = (d) => {
    const label = String(d.getDate());
    const hit = [...pop.querySelectorAll('.md-dp-day')].find((c) => c.textContent === label);
    if (hit) { [...pop.querySelectorAll('.md-dp-day')].forEach((c) => (c.tabIndex = -1)); hit.tabIndex = 0; hit.focus(); }
  };

  const open = () => {
    cursor = parse() || new Date();
    render();
    btn.setAttribute('aria-expanded', 'true');
    detach = autoDismiss(pop, input.parentElement, close);
    (pop.querySelector('.md-dp-day[tabindex="0"]') || pop.querySelector('.md-dp-day'))?.focus();
  };

  btn.onclick = () => (pop.hidden ? open() : close());
  return { open, close };
}

// -------------------------------------------------------------- time picker --

/**
 * Replaces <input type="time"> with MD3's *time input* variant (two numeric
 * fields), not the dial — a dial is a poor fit for the keyboard-first editing
 * this dashboard is built around. Value stays a 24h "HH:MM" string.
 */
export function attachTimePicker(input) {
  input.type = 'text';
  input.autocomplete = 'off';
  input.setAttribute('inputmode', 'numeric');
  input.setAttribute('aria-haspopup', 'dialog');

  const btn = trailingButton('Choose time', clockIcon());
  input.after(btn);
  input.classList.add('has-trailing');

  const pop = mountPopup('md-timepicker', 'dialog');
  pop.setAttribute('aria-label', 'Choose time');

  let detach = null;

  const parse = () => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(input.value.trim());
    if (!m) return { h: 9, m: 0 };
    return { h: Math.min(23, +m[1]), m: Math.min(59, +m[2]) };
  };

  const close = () => {
    if (pop.hidden) return;
    pop.hidden = true;
    detach?.(); detach = null;
    btn.setAttribute('aria-expanded', 'false');
  };

  const render = () => {
    pop.textContent = '';
    const { h, m } = parse();
    let hour = h, min = m;
    let pm = h >= 12;

    const row = document.createElement('div');
    row.className = 'md-tp-row';

    const hourField = numField('Hour', HOUR12 ? (hour % 12 || 12) : hour, HOUR12 ? 1 : 0, HOUR12 ? 12 : 23);
    const sep = document.createElement('span');
    sep.className = 'md-tp-sep';
    sep.textContent = ':';
    sep.setAttribute('aria-hidden', 'true');
    const minField = numField('Minute', min, 0, 59);
    row.append(hourField.wrap, sep, minField.wrap);

    let ampm = null;
    if (HOUR12) {
      ampm = document.createElement('div');
      ampm.className = 'md-tp-ampm';
      ampm.setAttribute('role', 'radiogroup');
      ampm.setAttribute('aria-label', 'AM or PM');
      for (const v of ['AM', 'PM']) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'md-tp-period state';
        b.textContent = v;
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', String((v === 'PM') === pm));
        b.onclick = () => {
          pm = v === 'PM';
          [...ampm.children].forEach((c) =>
            c.setAttribute('aria-checked', String((c.textContent === 'PM') === pm)));
        };
        ampm.append(b);
      }
      row.append(ampm);
    }

    const foot = document.createElement('div');
    foot.className = 'md-tp-foot';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn-text state';
    cancel.textContent = 'Cancel';
    cancel.onclick = () => { close(); input.focus(); };
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'btn-text state';
    ok.textContent = 'OK';
    ok.onclick = () => {
      let hh = Number(hourField.input.value) || 0;
      const mm = Math.min(59, Number(minField.input.value) || 0);
      if (HOUR12) hh = (hh % 12) + (pm ? 12 : 0);
      input.value = `${pad2(Math.min(23, hh))}:${pad2(mm)}`;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      close();
      input.focus();
    };
    foot.append(cancel, ok);

    pop.append(row, foot);
    position(pop, input.parentElement);
    hourField.input.focus();
    hourField.input.select();
  };

  const open = () => {
    render();
    btn.setAttribute('aria-expanded', 'true');
    detach = autoDismiss(pop, input.parentElement, close);
  };

  btn.onclick = () => (pop.hidden ? open() : close());
  return { open, close };
}

/** Numeric spin field: arrows step, and the value is clamped on the way out. */
function numField(label, value, min, max) {
  const wrap = document.createElement('div');
  wrap.className = 'md-tp-field';
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.inputMode = 'numeric';
  inp.className = 'md-tp-input';
  inp.value = label === 'Minute' ? pad2(value) : String(value);
  inp.setAttribute('aria-label', label);
  inp.addEventListener('keydown', (e) => {
    const d = e.key === 'ArrowUp' ? 1 : e.key === 'ArrowDown' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    let v = (Number(inp.value) || 0) + d;
    if (v > max) v = min;
    if (v < min) v = max;
    inp.value = label === 'Minute' ? pad2(v) : String(v);
  });
  inp.addEventListener('blur', () => {
    let v = Math.max(min, Math.min(max, Number(inp.value) || min));
    inp.value = label === 'Minute' ? pad2(v) : String(v);
  });
  const cap = document.createElement('span');
  cap.className = 'md-tp-cap';
  cap.textContent = label;
  wrap.append(inp, cap);
  return { wrap, input: inp };
}

// ----------------------------------------------------------------- confirm --

/**
 * MD3 basic dialog offering one button per choice. Resolves the chosen value, or
 * null if the user cancelled or dismissed. `choices` is `[{ label, value,
 * destructive }]`, rendered left to right after Cancel.
 */
export function choiceDialog({ title, message, choices }) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'md-confirm';
    dlg.setAttribute('aria-labelledby', 'md-confirm-title');

    const h = document.createElement('h2');
    h.id = 'md-confirm-title';
    h.textContent = title;

    const p = document.createElement('p');
    p.textContent = message;

    const actions = document.createElement('div');
    actions.className = 'dialog-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn-text state';
    cancel.textContent = 'Cancel';
    actions.append(cancel);

    dlg.append(h, p, actions);
    document.body.append(dlg);

    const done = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    for (const c of choices) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-text state';
      btn.textContent = c.label;
      if (c.destructive) btn.style.color = 'var(--md-error)';
      btn.onclick = () => done(c.value);
      actions.append(btn);
    }
    cancel.onclick = () => done(null);
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(null); });

    dlg.showModal();
    cancel.focus();
  });
}

/**
 * MD3 basic dialog, replacing window.confirm(). Returns a promise so callers
 * read the same way they did before, but the call no longer blocks the thread
 * or render an OS-styled box.
 */
export async function confirmDialog({ title, message, confirmLabel = 'OK', destructive = false }) {
  const v = await choiceDialog({
    title,
    message,
    choices: [{ label: confirmLabel, value: true, destructive }],
  });
  return v === true;
}

/**
 * MD3 basic dialog with a single text input, replacing window.prompt(). Resolves
 * the trimmed value, or null if cancelled/dismissed or left empty. Built on the
 * same native <dialog> as choiceDialog so focus trapping and the backdrop come
 * for free.
 */
export function promptDialog({ title, label, placeholder = ' ', confirmLabel = 'Add', initial = '' }) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'md-confirm';
    dlg.setAttribute('aria-labelledby', 'md-prompt-title');

    const h = document.createElement('h2');
    h.id = 'md-prompt-title';
    h.textContent = title;

    const form = document.createElement('form');
    form.method = 'dialog';

    const field = document.createElement('div');
    field.className = 'field';
    const input = document.createElement('input');
    input.placeholder = placeholder;
    input.value = initial;
    input.id = 'md-prompt-input';
    const lab = document.createElement('label');
    lab.setAttribute('for', input.id);
    lab.textContent = label;
    field.append(input, lab);

    const actions = document.createElement('div');
    actions.className = 'dialog-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn-text state';
    cancel.textContent = 'Cancel';
    const ok = document.createElement('button');
    ok.type = 'submit';
    ok.className = 'btn-primary state';
    ok.textContent = confirmLabel;
    actions.append(cancel, ok);

    form.append(field, actions);
    dlg.append(h, form);
    document.body.append(dlg);

    const done = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      done(input.value.trim() || null);
    });
    cancel.onclick = () => done(null);
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(null); });

    dlg.showModal();
    input.focus();
  });
}

// ---------------------------------------------------------------- tooltips --

/**
 * MD3 plain tooltip, replacing the native title= bubble. Native tooltips are
 * slow, unstyleable and never appear on keyboard focus; this one does.
 */
export function initTooltips() {
  const tip = mountPopup('md-tooltip', 'tooltip');
  let timer;

  const show = (host) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      tip.textContent = host.dataset.tip;
      position(tip, host);
      tip.classList.add('show');
    }, 300);
  };
  const hide = () => { clearTimeout(timer); tip.classList.remove('show'); tip.hidden = true; };

  for (const evt of ['pointerenter', 'focusin']) {
    document.addEventListener(evt, (e) => {
      const host = e.target.closest?.('[data-tip]');
      if (host) show(host);
    }, true);
  }
  for (const evt of ['pointerleave', 'focusout', 'pointerdown']) {
    document.addEventListener(evt, (e) => {
      if (e.target.closest?.('[data-tip]')) hide();
    }, true);
  }
}

// ------------------------------------------------------------------- icons --

const svg = (paths, extra = '') => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', '20');
  s.setAttribute('height', '20');
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('focusable', 'false');
  s.innerHTML = `${paths}${extra}`;
  return s;
};

const arrowIcon = () => svg('<path fill="currentColor" d="M7 10l5 5 5-5z"/>');
const calendarIcon = () => svg('<path fill="currentColor" d="M19 4h-1V2h-2v2H8V2H6v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2m0 16H5V10h14z"/>');
const clockIcon = () => svg('<path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20m0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16m.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/>');
const chevron = (dir) => svg(dir === 'left'
  ? '<path fill="currentColor" d="M15.4 7.4 14 6l-6 6 6 6 1.4-1.4-4.6-4.6z"/>'
  : '<path fill="currentColor" d="M8.6 16.6 10 18l6-6-6-6-1.4 1.4 4.6 4.6z"/>');

function iconButton(label, icon) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn-icon state';
  b.setAttribute('aria-label', label);
  b.append(icon);
  return b;
}

/** Trailing icon inside a text field, per the MD3 text-field anatomy. */
function trailingButton(label, icon) {
  const b = iconButton(label, icon);
  b.classList.add('md-field-trailing');
  b.setAttribute('aria-expanded', 'false');
  b.tabIndex = -1; // the field itself is the tab stop; this is a pointer affordance
  return b;
}
