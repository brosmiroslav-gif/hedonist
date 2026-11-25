// Hedonist – logika aplikácie a prepínanie obrazoviek.

import { ensurePersistentStorage, openDatabase } from './db.js';

const SCREENS = ['zapis', 'karta', 'zaznamy', 'odoslat', 'nastavenia'];

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
