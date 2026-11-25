// Hedonist – logika aplikácie a prepínanie obrazoviek.

import {
  DEFAULT_SETTINGS, HLAD_CHUT, JEDLA, TEMPA, ensurePersistentStorage, openDatabase,
} from './db.js';

const SCREENS = ['zapis', 'karta', 'zaznamy', 'odoslat', 'nastavenia'];
const AFTER_PREFIX = 'doplnit-'; // #doplnit-<id> = doplnenie po jedle

const TIME_ZONE = 'Europe/Bratislava';
const PO20_DELAY_MS = 20 * 60 * 1000;
const PENDING_MAX_AGE_MIN = 6 * 60;
const PENDING_MAX_AHEAD_MIN = 60; // tolerancia pre čas zadaný mierne dopredu
const LONG_PRESS_MS = 450; // skôr, než Android spustí vlastné dlhé podržanie

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
function createScalePicker(list) {
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
      due: record.po20 === null && remainingMs(record, now) === 0,
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
    return { screen: 'zapis', afterId: hash.slice(AFTER_PREFIX.length) };
  }
  return { screen: SCREENS.includes(hash) ? hash : SCREENS[0], afterId: null };
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

// Dočasná kontrola: ukáže, že súbory sú v cache a v akej verzii.
async function showOfflineStatus() {
  const output = byId('check-offline');
  const registration = await navigator.serviceWorker.ready;
  const channel = new MessageChannel();
  channel.port1.onmessage = (event) => {
    output.textContent = `Offline pripravené · cache ${event.data}`;
  };
  registration.active.postMessage({ type: 'GET_VERSION' }, [channel.port2]);
}

// Dočasná kontrola: stav trvalého úložiska.
async function showStorageStatus() {
  const persistent = await ensurePersistentStorage();
  const state = { true: 'trvalé', false: 'zatiaľ nie je trvalé', null: 'trvalosť nepodporovaná' };
  byId('check-storage').textContent = `Úložisko: ${state[persistent]}`;
}

/* ---------- Spustenie ---------- */

async function start() {
  let entry = null;
  const route = () => {
    const { screen, afterId } = currentRoute();
    showScreen(screen);
    if (screen === 'zapis') {
      entry?.show(afterId).catch((error) => console.error(error));
    }
  };

  window.addEventListener('hashchange', route);
  route();
  initCard();

  if ('serviceWorker' in navigator) {
    registerServiceWorker().catch((error) => {
      console.error('Registrácia service workera zlyhala:', error);
      byId('check-offline').textContent = 'Offline režim sa nepodarilo pripraviť.';
    });
    showOfflineStatus();
  } else {
    byId('check-offline').textContent = 'Tento prehliadač nepodporuje offline režim.';
  }

  try {
    const db = await openDatabase();
    entry = createEntryScreen(db);
    const { screen, afterId } = currentRoute();
    if (screen === 'zapis') await entry.show(afterId);
    byId('zapis-content').hidden = false;
  } catch (error) {
    console.error('Databázu sa nepodarilo otvoriť:', error);
    showError('db-error', 'Databázu sa nepodarilo otvoriť. Zavri aplikáciu a skús to znova.');
    return;
  }

  const tick = () => {
    if (!document.hidden && currentRoute().screen === 'zapis') entry.tick();
  };
  setInterval(tick, 1000);
  document.addEventListener('visibilitychange', tick);

  await showStorageStatus();
}

// V test.html sa modul len importuje, aplikácia sa nespúšťa.
if (document.getElementById('main')) start();
