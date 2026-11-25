// Hedonist – logika aplikácie a prepínanie obrazoviek.

import { ensurePersistentStorage, openDatabase } from './db.js';

const SCREENS = ['zapis', 'karta', 'zaznamy', 'odoslat', 'nastavenia'];

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

function showScreen() {
  const wanted = location.hash.slice(1);
  const name = SCREENS.includes(wanted) ? wanted : SCREENS[0];

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
  document.getElementById('main').scrollTop = 0;
}

/* ---------- Karta ---------- */

// Na karte sú značky pevné, nezávisia od nastavení zóny.
const CARD_MARKS = {
  6: { row: 'is-stop', tag: 'STOP' },
  4: { row: 'is-zone', tag: 'ZAČNI' },
  3: { row: 'is-zone' },
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

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
  document.getElementById('card-scale').replaceChildren(...rows);
}

function initCard() {
  const screen = document.querySelector('[data-screen="karta"]');
  const tabs = [...screen.querySelectorAll('[role="tab"]')];

  const select = (index) => {
    tabs.forEach((tab, i) => {
      const selected = i === index;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      document.getElementById(tab.getAttribute('aria-controls')).hidden = !selected;
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

/* ---------- Service worker ---------- */

async function registerServiceWorker() {
  const registration = await navigator.serviceWorker.register('./sw.js');
  const bar = document.getElementById('update-bar');
  let updateRequested = false;

  // Stránku obnovíme len vtedy, keď o to používateľ požiadal.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (updateRequested) location.reload();
  });

  document.getElementById('update-button').addEventListener('click', () => {
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

// Dočasná kontrola (krok 1): ukáže, že súbory sú v cache a v akej verzii.
async function showOfflineStatus() {
  const output = document.getElementById('check-offline');
  const registration = await navigator.serviceWorker.ready;
  const channel = new MessageChannel();
  channel.port1.onmessage = (event) => {
    output.textContent = `Offline pripravené · cache ${event.data}`;
  };
  registration.active.postMessage({ type: 'GET_VERSION' }, [channel.port2]);
}

async function initStorage() {
  const db = await openDatabase();
  const persistent = await ensurePersistentStorage();

  // Dočasná kontrola (krok 2): stav databázy a trvalého úložiska.
  const records = await db.getAllRecords();
  const state = { true: 'trvalé', false: 'zatiaľ nie je trvalé', null: 'trvalosť nepodporovaná' };
  document.getElementById('check-storage').textContent =
    `Databáza pripravená · záznamov: ${records.length} · úložisko: ${state[persistent]}`;
}

window.addEventListener('hashchange', showScreen);
showScreen();
initCard();

initStorage().catch((error) => {
  console.error('Databázu sa nepodarilo otvoriť:', error);
  document.getElementById('check-storage').textContent = 'Databázu sa nepodarilo otvoriť.';
});

if ('serviceWorker' in navigator) {
  registerServiceWorker().catch((error) => {
    console.error('Registrácia service workera zlyhala:', error);
    document.getElementById('check-offline').textContent = 'Offline režim sa nepodarilo pripraviť.';
  });
  showOfflineStatus();
} else {
  document.getElementById('check-offline').textContent = 'Tento prehliadač nepodporuje offline režim.';
}
