// Hedonist – logika aplikácie a prepínanie obrazoviek.

import {
  DEFAULT_SETTINGS, HLAD_CHUT, JEDLA, TEMPA, ensurePersistentStorage, openDatabase,
} from './db.js';
import {
  APP_VERSION, MAILTO_LIMIT, backupFileName, createBackup, emailBody, emailSubject, mailtoUrl,
  parseBackup,
} from './export.js';

const SCREENS = ['karta', 'zapis', 'zaznamy', 'odoslat', 'nastavenia']; // prvá je úvodná
const AFTER_PREFIX = 'doplnit-'; // #doplnit-<id> = doplnenie po jedle
const EDIT_PREFIX = 'upravit-'; // #upravit-<id> = úprava záznamu
const SWIPE_DELETE_PX = 100; // o koľko treba riadok potiahnuť doľava

const TIME_ZONE = 'Europe/Bratislava';
const PO20_DELAY_MS = 20 * 60 * 1000;
const PENDING_MAX_AGE_MIN = 6 * 60;
const PENDING_MAX_AHEAD_MIN = 60; // tolerancia pre čas zadaný mierne dopredu
const LONG_PRESS_MS = 450; // skôr, než Android spustí vlastné dlhé podržanie
const RETURN_FALLBACK_MS = 3000; // ak sa po odoslaní aplikácia vôbec neopustí

const RANGES = Object.freeze(['Neodoslané', 'Dnes', 'Posledných 7 dní', 'Vlastný rozsah']);

// Stupnica hladu a sýtosti (presný text karty, sekcia 5 zadania).
const SCALE = [
  [10, 'Bolestivo prejedený', 'nevoľnosť, reflux, bolesť'],
  [9, 'Prejedený', 'tlak, ospalosť, povoľujem opasok'],
  [8, 'Plný', 'ťažoba, ďalšie sústo už nechutí'],
  [7, 'Spokojne sýty', 'žalúdok cítim, ťažko mi nie je'],
  [6, 'Príjemne nasýtený', 'hlad zmizol, ešte by šlo, netreba'],
  [5, 'Neutrálny', 'ani hlad, ani sýtosť'],
  [4, 'Mierne hladný', '„niečo by som zjedol“, vydržím'],
  [3, 'Hladný', 'prázdno v žalúdku, jasný hlad'],
  [2, 'Veľmi hladný', 'kručanie, podráždenosť, myslím na jedlo'],
  [1, 'Vyhladovaný', 'slabosť, triaška, závrat'],
].map(([value, name, description]) => ({ value, name, description }));

// Predvolené jedlo podľa času: platí prvá hranica, pred ktorou čas je.
const MEAL_LIMITS = [
  ['09:30', 'Raňajky'],
  ['11:00', 'Desiata'],
  ['14:00', 'Obed'],
  ['17:00', 'Olovrant'],
  ['20:30', 'Večera'],
];

/* ---------- Výpočty (testované v test.html) ---------- */

const clockFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** Dátum a čas v Bratislave v tvare, v akom sa ukladajú do záznamu. */
export function localDateTime(date = new Date()) {
  const part = Object.fromEntries(
    clockFormat.formatToParts(date).map(({ type, value }) => [type, value]));
  return { datum: `${part.year}-${part.month}-${part.day}`, cas: `${part.hour}:${part.minute}` };
}

export function defaultMeal(time) {
  return MEAL_LIMITS.find(([limit]) => time < limit)?.[1] ?? 'Neskoro večer';
}

export function formatScore(value) {
  return String(value).replace('.', ',');
}

/** Ťuknutie na riadok: celé číslo, ďalšie ťuknutie na ten istý riadok strieda pol stupňa. */
export function tapScore(current, row) {
  return current === row ? halfScore(row) : row;
}

/** Dlhé podržanie: o pol stupňa nižšie. Pod 1 sa ísť nedá. */
export function halfScore(row) {
  return row === 1 ? 1 : row - 0.5;
}

/** Podfarbenie zóny začiatku a značky STOP / ZAČNI podľa nastavení. */
export function scaleMarks(row, { startOd, startDo, stop }) {
  const inZone = (value) => value >= startOd && value <= startDo;
  // Riadok zastupuje aj hodnotu o pol stupňa nižšiu.
  const rowInZone = (r) => inZone(r) || (r > 1 && inZone(r - 0.5));
  const isStop = row === Math.ceil(stop);
  const zone = !isStop && rowInZone(row);
  const topOfZone = zone && !(row < 10 && rowInZone(row + 1) && row + 1 !== Math.ceil(stop));
  return { zone, stop: isStop, tag: isStop ? 'STOP' : topOfZone ? 'ZAČNI' : '' };
}

const wallMinutes = ({ datum, cas }) => Date.parse(`${datum}T${cas}:00Z`) / 60000;

/** Jedlá z posledných 6 hodín, ktorým chýba `po` alebo `po20`; najnovšie prvé. */
export function pendingRecords(records, now = new Date()) {
  const current = wallMinutes(localDateTime(now));
  return records
    .filter((record) => {
      if (record.po !== null && record.po20 !== null) return false;
      const age = current - wallMinutes(record);
      return age <= PENDING_MAX_AGE_MIN && age >= -PENDING_MAX_AHEAD_MIN;
    })
    .sort((a, b) => wallMinutes(b) - wallMinutes(a));
}

/** Milisekundy do zápisu po20, 0 = teraz; `null`, ak `po` ešte nie je zapísané. */
export function remainingMs(record, now = new Date()) {
  if (record.po === null || !record.poZapisane) return null;
  return Math.max(0, Date.parse(record.poZapisane) + PO20_DELAY_MS - now.getTime());
}

/** Pripomienky na zápis po20, ktoré ešte len majú prísť. */
export function upcomingReminders(records, now = new Date()) {
  return records
    .filter((record) => record.po20 === null && remainingMs(record, now) > 0)
    .map((record) => ({
      id: record.id,
      at: Date.parse(record.poZapisane) + PO20_DELAY_MS,
      body: mealSummary(record),
    }));
}

/** Prečo sa zóna nedá uložiť; prázdny text = je v poriadku. */
export function zoneProblem({ startOd, startDo, stop }) {
  if (startOd > startDo) return '„Začať od“ nesmie byť viac ako „Začať do“.';
  if (stop <= startDo) return 'STOP musí byť viac ako „Začať do“.';
  return '';
}

/** Uplynulo 20 minút od zápisu `po` a `po20` ešte chýba. */
export function isDue(record, now = new Date()) {
  return record.po20 === null && remainingMs(record, now) === 0;
}

/** Je na obrazovke Zápis aspoň jedna karta „Teraz: po 20 min“? */
export function hasDueRecord(records, now = new Date()) {
  return pendingRecords(records, now).some((record) => isDue(record, now));
}

export function formatCountdown(ms) {
  const seconds = Math.ceil(ms / 1000);
  const pad = (number) => String(number).padStart(2, '0');
  return `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
}

export function mealSummary(record) {
  return `${record.jedlo} ${record.cas} · pred ${formatScore(record.pred)}`;
}

export function pendingLabel(record) {
  return `${mealSummary(record)} · chýba: ${record.po === null ? 'po' : 'po 20 min'}`;
}

/** „V zóne“: true / false, alebo `null`, kým chýba `po`. */
export function zoneResult(record, { startOd, startDo, stop }) {
  if (record.po === null) return null;
  return record.pred >= startOd && record.pred <= startDo && record.po <= stop;
}

/** Posunie dátum `RRRR-MM-DD` o daný počet dní. */
export function shiftDate(datum, days) {
  const date = new Date(`${datum}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const between = (records, from, to) =>
  records.filter(({ datum }) => datum >= from && datum <= to);

/** Posledných 7 dní: dnešok a 6 kalendárnych dní pred ním. */
const lastWeek = (records, today) => between(records, shiftDate(today, -6), today);

/** Záznamy na odoslanie podľa zvoleného rozsahu (jedna z hodnôt `RANGES`). */
export function selectForSending(records, range, { today, from, to }) {
  const [unsent, todayOnly, week] = RANGES;
  if (range === unsent) return records.filter(({ odoslane }) => odoslane === null);
  if (range === todayOnly) return between(records, today, today);
  if (range === week) return lastWeek(records, today);
  return from && to ? between(records, from, to) : [];
}

/** Súhrn za posledných 7 dní. */
export function weekSummary(records, settings, now = new Date()) {
  const week = lastWeek(records, localDateTime(now).datum);
  const average = (values) => (values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null);
  // Percento sa počíta len z jedál, ktoré sa dajú vyhodnotiť.
  const rated = week.map((record) => zoneResult(record, settings))
    .filter((result) => result !== null);

  return {
    count: week.length,
    averageBefore: average(week.map(({ pred }) => pred)),
    averageAfter: average(week.map(({ po }) => po).filter((po) => po !== null)),
    zonePercent: rated.length
      ? Math.round((100 * rated.filter(Boolean).length) / rated.length)
      : null,
    notHunger: week.filter(({ hladChut }) => hladChut !== 'Hlad').length,
  };
}

export function formatAverage(value) {
  return value === null ? '–' : value.toFixed(1).replace('.', ',');
}

export function formatValues({ pred, po, po20 }) {
  return [pred, po, po20].map((value) => (value === null ? '–' : formatScore(value))).join(' → ');
}

/** Záznamy po dňoch; najnovší deň aj najnovšie jedlo sú hore. */
export function groupByDay(records) {
  const sorted = [...records].sort((a, b) => wallMinutes(b) - wallMinutes(a));
  const days = new Map();
  for (const record of sorted) {
    if (!days.has(record.datum)) days.set(record.datum, []);
    days.get(record.datum).push(record);
  }
  return [...days];
}

const dayFormat = new Intl.DateTimeFormat('sk-SK', {
  timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'numeric', year: 'numeric',
});

export function dayLabel(datum) {
  const label = dayFormat.format(new Date(`${datum}T00:00:00Z`));
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/* ---------- Pomocné prvky ---------- */

const byId = (id) => document.getElementById(id);

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Rad čipov s jednou vybranou hodnotou. `optional`: druhé ťuknutie výber zruší. */
function createChips(container, options, { optional = false, onSelect } = {}) {
  let value = null;
  const buttons = options.map((option) => {
    const button = element('button', 'chip', option);
    button.type = 'button';
    button.addEventListener('click', () => {
      set(optional && value === option ? null : option);
      onSelect?.(value);
    });
    return button;
  });

  function set(next) {
    value = next;
    buttons.forEach((button, i) => {
      button.setAttribute('aria-pressed', String(options[i] === value));
    });
  }

  container.append(...buttons);
  set(null);
  return { get value() { return value; }, set };
}

/** Zvislá stupnica 10 → 1 na výber hodnoty. */
function createScalePicker(list, { onChange } = {}) {
  let value = null;

  const rows = SCALE.map(({ value: row, name }) => {
    const item = element('li', '');
    const button = element('button', '');
    button.type = 'button';
    button.dataset.row = row;
    const number = element('span', 'scale-value', row);
    const tag = element('span', 'scale-tag');
    button.append(number, ' ', element('span', 'scale-name', name), ' ', tag);
    item.append(button);

    let timer = null;
    let longPressed = false;
    let origin = null;
    const cancel = () => clearTimeout(timer);

    button.addEventListener('pointerdown', (event) => {
      longPressed = false;
      origin = { x: event.clientX, y: event.clientY };
      cancel();
      timer = setTimeout(() => {
        longPressed = true;
        set(halfScore(row));
        navigator.vibrate?.(20);
      }, LONG_PRESS_MS);
    });
    button.addEventListener('pointermove', (event) => {
      if (origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 10) cancel();
    });
    for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
      button.addEventListener(type, cancel);
    }
    button.addEventListener('contextmenu', (event) => event.preventDefault());
    button.addEventListener('click', (event) => {
      // Po dlhom podržaní nasledujúce kliknutie ignorujeme (klávesnica má detail 0).
      if (longPressed && event.detail !== 0) {
        longPressed = false;
        return;
      }
      set(tapScore(value, row));
    });

    return { row, item, button, number, tag };
  });

  function set(next) {
    value = next;
    for (const { row, item, button, number } of rows) {
      const selected = value !== null && Math.ceil(value) === row;
      item.classList.toggle('is-selected', selected);
      button.setAttribute('aria-pressed', String(selected));
      number.textContent = formatScore(selected ? value : row);
    }
    onChange?.(value);
  }

  function setMarks(settings) {
    for (const { row, item, tag } of rows) {
      const marks = scaleMarks(row, settings);
      item.classList.toggle('is-zone', marks.zone);
      item.classList.toggle('is-stop', marks.stop);
      tag.textContent = marks.tag;
    }
  }

  list.replaceChildren(...rows.map(({ item }) => item));
  set(null);
  setMarks(DEFAULT_SETTINGS);
  return { get value() { return value; }, set, setMarks };
}

let toastTimer = null;

function showToast(message) {
  const toast = byId('toast');
  toast.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.textContent = ''; }, 2000);
}

function showError(id, message) {
  const output = byId(id);
  output.textContent = message;
  output.hidden = !message;
}

/** Potvrdzovací dialóg; vráti `true`, len ak používateľ potvrdí. */
async function askConfirm({ title, text, yes, no }) {
  const dialog = byId('dialog');
  // Ak je otvorená iná otázka, počkáme, aby sa odpovede nepomiešali.
  while (dialog.open) {
    await new Promise((resolve) => dialog.addEventListener('close', resolve, { once: true }));
  }
  byId('dialog-title').textContent = title;
  byId('dialog-text').textContent = text;
  byId('dialog-yes').textContent = yes;
  byId('dialog-no').textContent = no;
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'yes'), { once: true });
  });
}

/* ---------- Zápis ---------- */

/** Formulár nového záznamu. */
function createEntryForm(db, onSaved) {
  const form = byId('entry-form');
  const date = byId('entry-date');
  const time = byId('entry-time');
  const note = byId('entry-note');
  const more = byId('entry-more');
  const submit = form.querySelector('[type="submit"]');

  // Kým používateľ čas alebo jedlo nezmení, sledujú aktuálny čas.
  let timeChosen = false;
  let mealChosen = false;

  const meal = createChips(byId('entry-meal'), JEDLA, { onSelect: () => { mealChosen = true; } });
  const before = createScalePicker(byId('entry-scale'));
  const hunger = createChips(byId('entry-hunger'), HLAD_CHUT);
  const tempo = createChips(byId('entry-tempo'), TEMPA, { optional: true });

  function refreshTime() {
    // Pole, ktoré používateľ práve upravuje, neprepisujeme.
    if (!timeChosen && ![date, time].includes(document.activeElement)) {
      const now = localDateTime();
      if (date.value !== now.datum) date.value = now.datum;
      if (time.value !== now.cas) time.value = now.cas;
    }
    if (!mealChosen && time.value) meal.set(defaultMeal(time.value));
  }

  function reset() {
    timeChosen = false;
    mealChosen = false;
    before.set(null);
    hunger.set(null);
    tempo.set(null);
    note.value = '';
    more.open = false;
    showError('entry-error', '');
    refreshTime();
  }

  for (const input of [date, time]) {
    input.addEventListener('input', () => {
      timeChosen = true;
      refreshTime();
    });
  }
  form.addEventListener('click', () => showError('entry-error', ''));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    refreshTime();
    const problem = (!date.value || !time.value) ? 'Doplň dátum a čas.'
      : before.value === null ? 'Vyber hodnotu pred jedlom.'
        : hunger.value === null ? 'Vyber Hlad / chuť.'
          : '';
    showError('entry-error', problem);
    if (problem) return;

    submit.disabled = true;
    try {
      await db.addRecord({
        datum: date.value,
        cas: time.value.slice(0, 5),
        jedlo: meal.value,
        pred: before.value,
        hladChut: hunger.value,
        tempo: tempo.value,
        poznamka: note.value.trim(),
      });
      reset();
      await onSaved();
    } catch (error) {
      console.error(error);
      showError('entry-error', 'Záznam sa nepodarilo uložiť.');
    } finally {
      submit.disabled = false;
    }
  });

  reset();
  return { refreshTime, setMarks: before.setMarks };
}

/** Doplnenie `po` a `po20` k existujúcemu záznamu. */
function createAfterForm(db, onSaved) {
  const form = byId('after-form');
  const note = byId('after-note');
  const submit = form.querySelector('[type="submit"]');
  const scale = createScalePicker(byId('after-scale'));
  const tempo = createChips(byId('after-tempo'), TEMPA, { optional: true });

  let record = null;
  let field = null; // 'po' alebo 'po20'

  function tick() {
    const remaining = field === 'po20' ? remainingMs(record) : null;
    byId('after-countdown').hidden = remaining === null;
    if (remaining === null) return;
    byId('after-countdown-label').textContent =
      remaining > 0 ? 'Do zápisu po 20 min' : 'Teraz: po 20 min';
    byId('after-timer').textContent = formatCountdown(remaining);
    byId('after-countdown').classList.toggle('is-due', remaining === 0);
  }

  function open(next) {
    const nextField = next.po === null ? 'po' : 'po20';
    // Pri opätovnom zobrazení toho istého kroku rozpísané hodnoty nemažeme.
    const same = record?.id === next.id && field === nextField;
    record = next;
    field = nextField;
    if (!same) {
      scale.set(null);
      tempo.set(next.tempo);
      note.value = next.poznamka;
      showError('after-error', '');
    }
    const first = field === 'po';
    byId('after-title').textContent = first ? 'Po jedle' : 'Po 20 min';
    byId('after-legend').textContent = first ? 'Po (1–10)' : 'Po 20 min (1–10)';
    byId('after-summary').textContent = first
      ? mealSummary(record)
      : `${mealSummary(record)} · po ${formatScore(record.po)}`;
    byId('after-details').hidden = !first;
    tick();
  }

  function close() {
    record = null;
    field = null;
  }

  byId('after-back').addEventListener('click', () => location.replace('#zapis'));
  form.addEventListener('click', () => showError('after-error', ''));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (scale.value === null) {
      showError('after-error', 'Vyber hodnotu na stupnici.');
      return;
    }
    const changes = field === 'po'
      ? { po: scale.value, tempo: tempo.value, poznamka: note.value.trim() }
      : { po20: scale.value };

    submit.disabled = true;
    try {
      const saved = await db.updateRecord(record.id, changes);
      close();
      await onSaved(saved);
    } catch (error) {
      console.error(error);
      showError('after-error', 'Záznam sa nepodarilo uložiť.');
    } finally {
      submit.disabled = false;
    }
  });

  return { open, close, tick, setMarks: scale.setMarks };
}

/** Obrazovka Zápis: rozpracované jedlá, nový záznam a doplnenie po jedle. */
function createEntryScreen(db) {
  let records = [];
  let rendered = '';
  let request = 0;

  function renderPending() {
    const now = new Date();
    const items = pendingRecords(records, now).map((record) => ({
      id: record.id,
      label: pendingLabel(record),
      due: isDue(record, now),
    }));
    // Prekresľujeme len pri zmene, aby sa nestratil fokus ani rozrobené ťuknutie.
    const signature = JSON.stringify(items);
    if (signature === rendered) return;
    rendered = signature;

    byId('pending').replaceChildren(...items.map(({ id, label, due }) => {
      const link = element('a', due ? 'pending-card is-due' : 'pending-card');
      link.href = `#${AFTER_PREFIX}${id}`;
      link.append(element('span', '', label));
      if (due) link.append(' ', element('strong', '', 'Teraz: po 20 min'));
      const item = element('li', '');
      item.append(link);
      return item;
    }));
  }

  const entryForm = createEntryForm(db, async () => {
    showToast('Uložené');
    await show(null);
    byId('main').scrollTop = 0;
  });

  const afterForm = createAfterForm(db, async (saved) => {
    showToast('Uložené');
    // Po zápise `po` zostaneme pri zázname a ukážeme odpočet do `po20`.
    if (saved.po20 === null) {
      await show(saved.id);
      byId('main').scrollTop = 0;
    } else {
      location.replace('#zapis');
    }
  });

  /** Zobrazí úvod (`afterId` = null) alebo doplnenie daného záznamu. */
  async function show(afterId) {
    const current = ++request;
    const [all, settings] = await Promise.all([db.getAllRecords(), db.getSettings()]);
    if (current !== request) return; // medzitým prišla novšia požiadavka
    records = all;
    entryForm.setMarks(settings);
    afterForm.setMarks(settings);

    const record = afterId ? records.find((item) => item.id === afterId) : null;
    if (afterId && (!record || (record.po !== null && record.po20 !== null))) {
      location.replace('#zapis');
      return;
    }
    byId('entry-home').hidden = Boolean(record);
    byId('after-form').hidden = !record;
    if (record) {
      afterForm.open(record);
    } else {
      afterForm.close();
      entryForm.refreshTime();
      renderPending();
    }
  }

  function tick() {
    if (!byId('after-form').hidden) {
      afterForm.tick();
    } else if (!byId('entry-home').hidden) {
      entryForm.refreshTime();
      renderPending();
    }
  }

  return { show, tick };
}

/* ---------- Záznamy ---------- */

/** Potiahnutie riadku doľava (prstom aj myšou). */
function addSwipeLeft(row, onSwipe) {
  let start = null;
  let offset = 0;
  let dragging = false;
  let dragged = false;

  const move = (x) => {
    offset = x;
    row.style.transform = x ? `translateX(${x}px)` : '';
    row.parentElement.classList.toggle('is-swiping', x < 0);
  };
  const finish = () => {
    start = null;
    dragging = false;
    row.classList.remove('is-dragging');
  };

  row.draggable = false;
  row.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary || event.button !== 0) return;
    start = { x: event.clientX, y: event.clientY };
    dragged = false;
  });
  row.addEventListener('pointermove', (event) => {
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (!dragging) {
      if (Math.hypot(dx, dy) < 10) return;
      if (dx > 0 || Math.abs(dx) < Math.abs(dy)) {
        start = null; // iný smer – necháme stránku posúvať
        return;
      }
      dragging = true;
      dragged = true;
      row.classList.add('is-dragging');
      row.setPointerCapture(event.pointerId);
    }
    move(Math.min(0, dx));
  });
  row.addEventListener('pointerup', async () => {
    const confirmed = dragging && -offset >= SWIPE_DELETE_PX;
    finish();
    if (confirmed) await onSwipe();
    move(0);
  });
  row.addEventListener('pointercancel', () => {
    finish();
    move(0);
  });
  // Po potiahnutí sa nemá otvoriť úprava.
  row.addEventListener('click', (event) => {
    if (dragged && event.detail !== 0) event.preventDefault();
    dragged = false;
  });
}

function recordRow(record, settings) {
  const link = element('a', 'record-row');
  link.href = `#${EDIT_PREFIX}${record.id}`;
  link.append(
    element('span', 'record-time', record.cas), ' ',
    element('span', 'record-meal', record.jedlo), ' ',
    element('span', 'record-tag', record.hladChut), ' ',
    element('span', 'record-values', formatValues(record)),
  );
  const zone = zoneResult(record, settings);
  if (zone !== null) {
    link.append(' ', element('span', zone ? 'record-zone is-in' : 'record-zone',
      `V zóne: ${zone ? 'áno' : 'nie'}`));
  }
  if (record.odoslane === null) {
    const dot = element('span', 'record-dot');
    dot.append(element('span', 'visually-hidden', 'neodoslané'));
    link.append(' ', dot);
  }
  return link;
}

/** Úprava jedného záznamu. */
function createEditForm(db, onDone) {
  const form = byId('edit-form');
  const date = byId('edit-date');
  const time = byId('edit-time');
  const note = byId('edit-note');
  const submit = form.querySelector('[type="submit"]');
  const meal = createChips(byId('edit-meal'), JEDLA);
  const hunger = createChips(byId('edit-hunger'), HLAD_CHUT);
  const tempo = createChips(byId('edit-tempo'), TEMPA, { optional: true });

  const scales = [['pred', 'Pred'], ['po', 'Po'], ['po20', 'Po 20 min']].map(([field, label]) => {
    const picker = createScalePicker(byId(`edit-${field}`), {
      onChange: (value) => {
        byId(`edit-${field}-label`).textContent =
          `${label}: ${value === null ? '–' : formatScore(value)}`;
      },
    });
    byId(`edit-${field}-clear`)?.addEventListener('click', () => picker.set(null));
    return { field, picker };
  });

  let id = null;

  function open(record) {
    // Pri opätovnom zobrazení toho istého záznamu rozpísané zmeny nemažeme.
    if (record.id === id) return;
    id = record.id;
    date.value = record.datum;
    time.value = record.cas;
    meal.set(record.jedlo);
    hunger.set(record.hladChut);
    tempo.set(record.tempo);
    note.value = record.poznamka;
    for (const { field, picker } of scales) {
      picker.set(record[field]);
      byId(`edit-${field}-box`).open = false;
    }
    showError('edit-error', '');
  }

  function close() {
    id = null;
  }

  byId('edit-back').addEventListener('click', () => {
    close();
    onDone(false);
  });
  form.addEventListener('click', () => showError('edit-error', ''));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!date.value || !time.value) {
      showError('edit-error', 'Doplň dátum a čas.');
      return;
    }
    const values = Object.fromEntries(scales.map(({ field, picker }) => [field, picker.value]));
    submit.disabled = true;
    try {
      await db.updateRecord(id, {
        ...values,
        datum: date.value,
        cas: time.value.slice(0, 5),
        jedlo: meal.value,
        hladChut: hunger.value,
        tempo: tempo.value,
        poznamka: note.value.trim(),
      });
      close();
      onDone(true);
    } catch (error) {
      console.error(error);
      showError('edit-error', 'Záznam sa nepodarilo uložiť.');
    } finally {
      submit.disabled = false;
    }
  });

  return {
    open,
    close,
    setMarks: (settings) => scales.forEach(({ picker }) => picker.setMarks(settings)),
  };
}

/** Obrazovka Záznamy: súhrn, zoznam po dňoch a úprava. */
function createRecordsScreen(db) {
  let request = 0;
  let listScroll = 0;
  let openedFromList = false;

  const editForm = createEditForm(db, (saved) => {
    if (saved) showToast('Uložené');
    if (openedFromList) history.back();
    else location.replace('#zaznamy');
  });

  async function remove(record) {
    const confirmed = await askConfirm({
      title: 'Vymazať záznam?',
      text: `${dayLabel(record.datum)} · ${mealSummary(record)}`,
      yes: 'Vymazať',
      no: 'Zrušiť',
    });
    if (!confirmed) return;
    await db.deleteRecord(record.id);
    const scroll = byId('main').scrollTop;
    await show(null);
    byId('main').scrollTop = scroll;
    showToast('Vymazané');
  }

  function renderList(records, settings) {
    const summary = weekSummary(records, settings);
    byId('sum-count').textContent = summary.count;
    byId('sum-before').textContent = formatAverage(summary.averageBefore);
    byId('sum-after').textContent = formatAverage(summary.averageAfter);
    byId('sum-zone').textContent =
      summary.zonePercent === null ? '–' : `${summary.zonePercent} %`;
    byId('sum-not-hunger').textContent = summary.notHunger;

    byId('records-empty').hidden = records.length > 0;
    byId('records-list').replaceChildren(...groupByDay(records).map(([datum, items]) => {
      const day = element('section', 'day');
      const list = element('ul', 'day-list');
      list.append(...items.map((record) => {
        const item = element('li', 'record');
        const background = element('span', 'record-delete', 'Vymazať');
        background.setAttribute('aria-hidden', 'true');
        const link = recordRow(record, settings);
        link.addEventListener('click', () => {
          listScroll = byId('main').scrollTop;
          openedFromList = true;
        });
        addSwipeLeft(link, () => remove(record).catch((error) => {
          console.error(error);
          showToast('Záznam sa nepodarilo vymazať.');
        }));
        item.append(background, link);
        return item;
      }));
      day.append(element('h3', 'day-title', dayLabel(datum)), list);
      return day;
    }));
  }

  /** Zobrazí zoznam (`editId` = null) alebo úpravu daného záznamu. */
  async function show(editId) {
    const current = ++request;
    const [records, settings] = await Promise.all([db.getAllRecords(), db.getSettings()]);
    if (current !== request) return;

    const record = editId ? records.find((item) => item.id === editId) : null;
    if (editId && !record) {
      location.replace('#zaznamy');
      return;
    }
    const returning = !record && !byId('edit-form').hidden;
    byId('list-view').hidden = Boolean(record);
    byId('edit-form').hidden = !record;
    if (record) {
      editForm.setMarks(settings);
      editForm.open(record);
      byId('main').scrollTop = 0;
    } else {
      editForm.close();
      renderList(records, settings);
      // Po návrate z úpravy sa vrátime na pôvodné miesto v zozname.
      if (returning) byId('main').scrollTop = listScroll;
      openedFromList = false;
    }
  }

  return { show };
}

/* ---------- Odoslať a záloha ---------- */

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    console.warn('Kopírovanie do schránky zlyhalo:', error);
    return false;
  }
}

/**
 * Zavolá `callback`, keď sa používateľ vráti do aplikácie. Ak ju do `fallbackMs`
 * vôbec neopustí, zavolá ho aj tak. Vráti funkciu na zrušenie.
 */
function whenBack(callback, fallbackMs) {
  let left = document.hidden;
  const listeners = new AbortController();
  const { signal } = listeners;
  const finish = () => {
    cancel();
    callback();
  };
  const timer = fallbackMs ? setTimeout(() => { if (!left) finish(); }, fallbackMs) : null;
  function cancel() {
    clearTimeout(timer);
    listeners.abort();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) left = true;
    else if (left) finish();
  }, { signal });
  window.addEventListener('blur', () => { left = true; }, { signal });
  window.addEventListener('focus', () => { if (left && !document.hidden) finish(); }, { signal });
  return cancel;
}

function downloadFile(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = element('a', '');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** Obrazovka Odoslať. `onSent` sa zavolá po označení záznamov ako odoslaných. */
function createSendScreen(db, onSent) {
  const from = byId('send-from');
  const to = byId('send-to');
  const file = byId('restore-file');
  const range = createChips(byId('send-range'), RANGES, {
    onSelect: () => show().catch((error) => console.error(error)),
  });
  range.set(RANGES[0]);

  let request = 0;
  let draft = null; // to, čo práve vidno v náhľade
  let stopWaiting = null;
  let asking = false;

  /** Po návrate sa opýta, či bol e-mail odoslaný. */
  async function confirmSent() {
    if (asking) return;
    asking = true;
    try {
      const ids = await db.getPendingSend();
      if (!ids) return;
      const sent = await askConfirm({
        title: 'Odoslal si e-mail?',
        text: `Počet záznamov v exporte: ${ids.length}`,
        yes: 'Áno',
        no: 'Nie',
      });
      if (sent) await db.markSent(ids);
      await db.setPendingSend(null);
      if (sent) onSent();
    } finally {
      asking = false;
    }
  }

  function waitForReturn(fallbackMs = RETURN_FALLBACK_MS) {
    stopWaiting?.();
    stopWaiting = whenBack(
      () => confirmSent().catch((error) => console.error(error)), fallbackMs);
  }

  function showFallback(message) {
    byId('send-copy-all').hidden = false;
    showError('send-error', message);
  }

  async function send() {
    if (!draft) return;
    const { ids, email, subject, body, url } = draft;
    showError('send-error', '');
    stopWaiting?.();

    if (url.length <= MAILTO_LIMIT) {
      // Poštu otvárame hneď v obsluhe ťuknutia, inak ju prehliadač môže zablokovať.
      const saved = db.setPendingSend(ids);
      location.href = url;
      await saved;
      waitForReturn();
      return;
    }

    const data = { title: subject, text: body };
    if (!draft.canShare) {
      showFallback('Zdieľanie nie je dostupné. Skopíruj e-mail do schránky.');
      return;
    }
    // Zdieľanie neprenesie adresáta, preto ho dáme do schránky.
    if (email && !(await copyText(email))) {
      showToast('Adresu sa nepodarilo skopírovať');
    }
    await db.setPendingSend(ids);
    try {
      await navigator.share(data);
      waitForReturn();
    } catch (error) {
      await db.setPendingSend(null);
      if (error.name !== 'AbortError') {
        console.warn('Zdieľanie zlyhalo:', error);
        showFallback('Zdieľanie zlyhalo. Skopíruj e-mail do schránky.');
      }
    }
  }

  async function copy(text, done) {
    const copied = await copyText(text);
    showError('send-error', copied ? '' : 'Kopírovanie zlyhalo. Označ text v náhľade ručne.');
    if (copied) showToast(done);
    return copied;
  }

  function sendNote({ email, url, canShare }) {
    const missing = 'Adresa príjemcu nie je nastavená – doplníš ju v pošte alebo v Nastaveniach.';
    if (url.length <= MAILTO_LIMIT) return email ? '' : missing;
    if (!canShare) return 'Export je dlhý a zdieľanie nie je dostupné. Použi schránku.';
    const address = email
      ? `Adresa ${email} sa skopíruje do schránky, prilep ju do poľa Komu.`
      : missing;
    return `Export je dlhý, otvorí sa zdieľanie – vyber Gmail. ${address}`;
  }

  async function show() {
    const current = ++request;
    const [records, settings] = await Promise.all([db.getAllRecords(), db.getSettings()]);
    if (current !== request) return;

    const custom = range.value === RANGES[3];
    byId('send-custom').hidden = !custom;
    const today = localDateTime().datum;
    from.value ||= shiftDate(today, -6);
    to.value ||= today;

    const selected = selectForSending(records, range.value,
      { today, from: from.value, to: to.value });

    draft = null;
    if (selected.length > 0) {
      const subject = emailSubject(selected);
      const body = emailBody(selected);
      draft = {
        ids: selected.map(({ id }) => id),
        email: settings.email,
        subject,
        body,
        url: mailtoUrl(settings.email, subject, body),
        canShare: Boolean(navigator.share)
          && (navigator.canShare?.({ title: subject, text: body }) ?? true),
      };
    }

    const invalid = custom && from.value > to.value;
    byId('send-empty').textContent = invalid
      ? 'Dátum „od“ je neskôr ako „do“.'
      : 'Vo vybranom rozsahu nie sú žiadne záznamy.';
    byId('send-empty').hidden = Boolean(draft);
    byId('send-mail').hidden = !draft;
    showError('send-error', '');
    if (!draft) return;

    byId('send-recipient').textContent = draft.email || 'nenastavený';
    byId('send-subject').textContent = draft.subject;
    byId('send-preview').textContent = draft.body;
    byId('send-note').textContent = sendNote(draft);
    // Ak sa dlhý export nedá ani zdieľať, ostáva len schránka.
    const onlyClipboard = draft.url.length > MAILTO_LIMIT && !draft.canShare;
    byId('send-button').hidden = onlyClipboard;
    byId('send-copy-all').hidden = !onlyClipboard;
  }

  async function backup() {
    const [records, settings] = await Promise.all([db.getAllRecords(), db.getSettings()]);
    const name = backupFileName(localDateTime().datum);
    downloadFile(name, createBackup(records, settings));
    byId('backup-status').textContent =
      `Záloha ${name} (záznamov: ${records.length}) je v stiahnutých súboroch.`;
  }

  async function restore(source) {
    const status = byId('backup-status');
    status.textContent = '';
    showError('backup-error', '');
    try {
      const result = await db.importData(parseBackup(await source.text()));
      status.textContent = `Obnovené. Pridané: ${result.added}, aktualizované: `
        + `${result.updated}, bez zmeny: ${result.unchanged}.`
        + (result.settingsRestored ? ' Obnovené aj nastavenia.' : '');
      await show();
    } catch (error) {
      console.warn('Obnova zlyhala:', error);
      showError('backup-error', `Obnova zlyhala, nič sa nezmenilo. ${error.message}`);
    }
  }

  const report = (promise, message) => promise.catch((error) => {
    console.error(error);
    showToast(message);
  });

  for (const input of [from, to]) {
    input.addEventListener('change', () => report(show(), 'Náhľad sa nepodarilo pripraviť.'));
  }
  byId('send-button').addEventListener('click',
    () => report(send(), 'Odoslanie sa nepodarilo.'));
  byId('send-copy-subject').addEventListener('click',
    () => copy(draft.subject, 'Predmet skopírovaný'));
  byId('send-copy-body').addEventListener('click',
    () => copy(draft.body, 'Telo skopírované'));
  byId('send-copy-all').addEventListener('click', async () => {
    const { ids, body } = draft;
    if (!(await copy(body, 'Skopírované do schránky'))) return;
    await db.setPendingSend(ids);
    // E-mail sa odosiela ručne, preto sa pýtame až po skutočnom návrate.
    waitForReturn(null);
  });
  byId('backup-button').addEventListener('click',
    () => report(backup(), 'Zálohu sa nepodarilo vytvoriť.'));
  byId('restore-button').addEventListener('click', () => file.click());
  file.addEventListener('change', () => {
    const [source] = file.files;
    if (source) report(restore(source), 'Obnova sa nepodarila.');
    file.value = ''; // ten istý súbor sa dá vybrať znova
  });

  return { show, confirmSent };
}

/* ---------- Pripomienka po 20 minútach (best effort) ---------- */

const notificationsSupported = () => 'Notification' in window && 'serviceWorker' in navigator;

/**
 * Pripomienku plánuje stránka aj service worker. Android môže oboje uspať,
 * preto je hlavnou poistkou zvýraznená karta na obrazovke Zápis. Rovnaký
 * `tag` zaručí, že sa neukážu dve notifikácie.
 */
function createReminders(db) {
  const timers = new Map(); // id → { at, handle }
  let queue = Promise.resolve();

  const notification = ({ id, body }) => ({
    title: 'Teraz: po 20 min',
    options: {
      body, tag: `po20-${id}`, data: { id }, lang: 'sk', icon: './icons/icon-192.png',
    },
  });

  async function fire(reminder) {
    const record = await db.getRecord(reminder.id);
    if (!record || record.po20 !== null) return;
    const registration = await navigator.serviceWorker.ready;
    const { title, options } = notification(reminder);
    await registration.showNotification(title, options);
  }

  async function update() {
    const allowed = notificationsSupported() && Notification.permission === 'granted';
    if (!allowed) return;

    const records = await db.getAllRecords();
    const wanted = new Map(upcomingReminders(records).map((item) => [item.id, item]));
    const registration = await navigator.serviceWorker.ready;
    const send = (message) => registration.active.postMessage(message);

    for (const [id, timer] of timers) {
      if (wanted.get(id)?.at === timer.at) continue;
      clearTimeout(timer.handle);
      timers.delete(id);
      // Uplynutý čas neruší service worker, ten môže notifikáciu práve zobrazovať.
      if (timer.at > Date.now() || !records.some((record) => record.id === id)) {
        send({ type: 'CANCEL', id });
      }
    }
    for (const reminder of wanted.values()) {
      if (!timers.has(reminder.id)) {
        const handle = setTimeout(() => {
          fire(reminder).catch((error) => console.warn('Pripomienka zlyhala:', error));
        }, reminder.at - Date.now());
        timers.set(reminder.id, { at: reminder.at, handle });
      }
      // Service worker mohol byť medzitým ukončený, preto posielame vždy.
      send({ type: 'REMIND', id: reminder.id, at: reminder.at, ...notification(reminder) });
    }

    // Zatvoríme upozornenia na jedlá, ktoré sú už doplnené alebo zmazané.
    for (const shown of await registration.getNotifications()) {
      const record = records.find((item) => item.id === shown.data?.id);
      if (!record || record.po === null || record.po20 !== null) shown.close();
    }
  }

  /** Zosúladí naplánované pripomienky so záznamami. */
  function sync() {
    queue = queue.then(update)
      .catch((error) => console.warn('Pripomienky sa nepodarilo naplánovať:', error));
    return queue;
  }

  return { sync };
}

/* ---------- Nastavenia ---------- */

function createSettingsScreen(db, reminders) {
  const email = byId('settings-email');
  const zone = {
    startOd: byId('settings-start-from'),
    startDo: byId('settings-start-to'),
    stop: byId('settings-stop'),
  };
  const enable = byId('reminder-enable');

  const scores = Array.from({ length: 19 }, (_, i) => 1 + i / 2);
  for (const select of Object.values(zone)) {
    select.append(...scores.map((score) => new Option(formatScore(score), score)));
    select.addEventListener('change', async () => {
      const values = Object.fromEntries(
        Object.entries(zone).map(([key, field]) => [key, Number(field.value)]));
      const problem = zoneProblem(values);
      showError('settings-zone-error', problem ? `${problem} Zmena zatiaľ nie je uložená.` : '');
      if (problem) return;
      try {
        await db.saveSettings(values);
        showToast('Uložené');
      } catch (error) {
        console.error(error);
        showError('settings-zone-error', 'Nastavenie sa nepodarilo uložiť.');
      }
    });
  }

  function showReminderState() {
    const state = notificationsSupported() ? Notification.permission : 'unsupported';
    byId('reminder-status').textContent = {
      default: 'Pripomienky nie sú povolené.',
      granted: 'Pripomienky sú povolené. Vypneš ich v nastaveniach telefónu.',
      denied: 'Notifikácie sú zablokované. Povoľ ich v nastaveniach prehliadača alebo telefónu.',
      unsupported: 'Tento prehliadač notifikácie nepodporuje.',
    }[state];
    enable.hidden = state !== 'default';
  }

  enable.addEventListener('click', async () => {
    await Notification.requestPermission();
    showReminderState();
    await reminders.sync();
  });

  async function showStorageState() {
    const persistent = await ensurePersistentStorage();
    byId('storage-status').textContent = {
      true: 'trvalé',
      false: 'nie je trvalé – systém môže dáta pri nedostatku miesta zmazať',
      null: 'trvalosť sa nedá zistiť',
    }[persistent];
  }

  email.addEventListener('change', async () => {
    email.value = email.value.trim();
    if (!email.checkValidity()) {
      showError('settings-error', 'Zadaj platnú e-mailovú adresu.');
      return;
    }
    showError('settings-error', '');
    try {
      await db.saveSettings({ email: email.value });
      showToast('Uložené');
    } catch (error) {
      console.error(error);
      showError('settings-error', 'Nastavenie sa nepodarilo uložiť.');
    }
  });

  async function show() {
    const settings = await db.getSettings();
    if (document.activeElement !== email) email.value = settings.email;
    for (const [key, select] of Object.entries(zone)) select.value = settings[key];
    showError('settings-error', '');
    showError('settings-zone-error', '');
    showReminderState();
    await showStorageState();
  }

  return { show };
}

/* ---------- Karta ---------- */

// Na karte sú značky pevné, nezávisia od nastavení zóny.
const CARD_MARKS = {
  6: { row: 'is-stop', tag: 'STOP' },
  4: { row: 'is-zone', tag: 'ZAČNI' },
  3: { row: 'is-zone' },
};

function renderCardScale() {
  const rows = SCALE.map(({ value, name, description }) => {
    const mark = CARD_MARKS[value];
    const row = element('li', mark?.row ?? '');
    const text = element('span', 'scale-text');
    text.append(element('span', 'scale-name', name), ' ', element('span', 'scale-desc', description));
    row.append(element('span', 'scale-value', value), text);
    if (mark?.tag) row.append(element('span', 'scale-tag', mark.tag));
    return row;
  });
  byId('card-scale').replaceChildren(...rows);
}

function initCard() {
  const screen = document.querySelector('[data-screen="karta"]');
  const tabs = [...screen.querySelectorAll('[role="tab"]')];

  const select = (index) => {
    tabs.forEach((tab, i) => {
      const selected = i === index;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      byId(tab.getAttribute('aria-controls')).hidden = !selected;
    });
  };

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => select(index));
    tab.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const other = (index + 1) % tabs.length;
      select(other);
      tabs[other].focus();
    });
  });

  // Swipe: potiahnutie doľava ukáže zadnú stranu, doprava prednú.
  let start = null;
  screen.addEventListener('pointerdown', (event) => {
    start = event.isPrimary && event.pointerType !== 'mouse'
      ? { x: event.clientX, y: event.clientY }
      : null;
  });
  screen.addEventListener('pointercancel', () => { start = null; });
  screen.addEventListener('pointerup', (event) => {
    if (!start || !event.isPrimary) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    start = null;
    if (Math.abs(dx) < 50 || Math.abs(dx) < 1.5 * Math.abs(dy)) return;
    select(dx < 0 ? 1 : 0);
  });

  renderCardScale();
}

/* ---------- Prepínanie obrazoviek ---------- */

function currentRoute() {
  const hash = location.hash.slice(1);
  if (hash.startsWith(AFTER_PREFIX)) {
    return { screen: 'zapis', id: hash.slice(AFTER_PREFIX.length) };
  }
  if (hash.startsWith(EDIT_PREFIX)) {
    return { screen: 'zaznamy', id: hash.slice(EDIT_PREFIX.length) };
  }
  return { screen: SCREENS.includes(hash) ? hash : SCREENS[0], id: null };
}

function showScreen(name) {
  for (const section of document.querySelectorAll('[data-screen]')) {
    section.hidden = section.dataset.screen !== name;
  }
  for (const link of document.querySelectorAll('[data-link]')) {
    if (link.dataset.link === name) {
      link.setAttribute('aria-current', 'page');
    } else {
      link.removeAttribute('aria-current');
    }
  }
  byId('main').scrollTop = 0;
}

/**
 * Z úvodnej Karty prepne na Zápis, ak je čas na „po 20 min“. Z iných obrazoviek
 * nepresúvame, aby sa nerušila rozrobená práca.
 */
async function openEntryIfDue(db) {
  const onCard = () => currentRoute().screen === 'karta';
  if (!onCard()) return;
  const records = await db.getAllRecords();
  // Používateľ mohol medzitým prejsť inam.
  if (hasDueRecord(records) && onCard()) location.replace('#zapis');
}

/* ---------- Service worker ---------- */

async function registerServiceWorker() {
  const registration = await navigator.serviceWorker.register('./sw.js');
  const bar = byId('update-bar');
  let updateRequested = false;

  // Stránku obnovíme len vtedy, keď o to používateľ požiadal.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (updateRequested) location.reload();
  });

  byId('update-button').addEventListener('click', () => {
    if (registration.waiting) {
      updateRequested = true;
      // Čakajúce pripomienky by zdržali výmenu verzie; po obnovení sa naplánujú znova.
      registration.active?.postMessage({ type: 'CANCEL_ALL' });
      registration.waiting.postMessage({ type: 'SKIP_WAITING' });
    } else {
      location.reload();
    }
  });

  // Pri prvej inštalácii stránku ešte nič neriadi – vtedy lištu neukazujeme.
  const offerUpdate = () => {
    if (navigator.serviceWorker.controller) bar.hidden = false;
  };
  const watch = (worker) => {
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed') offerUpdate();
    });
  };

  if (registration.waiting) offerUpdate();
  if (registration.installing) watch(registration.installing);
  registration.addEventListener('updatefound', () => watch(registration.installing));
}

/** V Nastaveniach ukáže, že súbory sú v cache, a jej verziu. */
async function showOfflineStatus() {
  const registration = await navigator.serviceWorker.ready;
  const channel = new MessageChannel();
  channel.port1.onmessage = (event) => {
    byId('offline-status').textContent = 'pripravené';
    byId('app-version').textContent = `${APP_VERSION} (cache ${event.data})`;
  };
  registration.active.postMessage({ type: 'GET_VERSION' }, [channel.port2]);
}

/* ---------- Spustenie ---------- */

async function start() {
  // Obrazovky s dátami vzniknú až po otvorení databázy.
  const screens = {};
  const route = () => {
    const { screen, id } = currentRoute();
    showScreen(screen);
    screens[screen]?.show(id).catch((error) => console.error(error));
  };

  window.addEventListener('hashchange', route);
  route();
  initCard();
  byId('app-version').textContent = APP_VERSION;

  if ('serviceWorker' in navigator) {
    registerServiceWorker().catch((error) => {
      console.error('Registrácia service workera zlyhala:', error);
      byId('offline-status').textContent = 'nepodarilo sa pripraviť';
    });
    showOfflineStatus();
    // Ťuknutie na notifikáciu otvorí doplnenie daného jedla.
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'OPEN') location.hash = `#${AFTER_PREFIX}${event.data.id}`;
    });
    navigator.serviceWorker.startMessages();
  } else {
    byId('offline-status').textContent = 'tento prehliadač ho nepodporuje';
  }

  let reminders = null;
  try {
    const db = await openDatabase(undefined, { onChange: () => reminders?.sync() });
    reminders = createReminders(db);
    screens.zapis = createEntryScreen(db);
    screens.zaznamy = createRecordsScreen(db);
    // Po odoslaní obnovíme aktuálnu obrazovku bez posunu na začiatok.
    screens.odoslat = createSendScreen(db, () => {
      const { screen, id } = currentRoute();
      screens[screen]?.show(id).catch((error) => console.error(error));
    });
    screens.nastavenia = createSettingsScreen(db, reminders);
    await openEntryIfDue(db);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) openEntryIfDue(db).catch((error) => console.error(error));
    });
    const { screen, id } = currentRoute();
    await screens[screen]?.show(id);
    // Zápis potrebuje predvyplniť, aj keď sa aplikácia otvorila na inej obrazovke.
    if (screen !== 'zapis') await screens.zapis.show(null);
    for (const content of ['zapis-content', 'records-content', 'send-content', 'settings-content']) {
      byId(content).hidden = false;
    }
  } catch (error) {
    console.error('Databázu sa nepodarilo otvoriť:', error);
    showError('db-error', 'Databázu sa nepodarilo otvoriť. Zavri aplikáciu a skús to znova.');
    return;
  }

  const tick = () => {
    if (!document.hidden && currentRoute().screen === 'zapis') screens.zapis.tick();
  };
  setInterval(tick, 1000);
  document.addEventListener('visibilitychange', () => {
    tick();
    // Po uspaní treba pripomienky naplánovať znova.
    if (!document.hidden) reminders.sync();
  });

  reminders.sync();
  // O trvalé úložisko žiadame pri každom spustení, kým ho nedostaneme.
  await ensurePersistentStorage();
  // Ak systém aplikáciu medzitým ukončil, otázka na odoslanie príde teraz.
  await screens.odoslat.confirmSent();
}

// V test.html sa modul len importuje, aplikácia sa nespúšťa.
if (document.getElementById('main')) start();
