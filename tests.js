// Hedonist – testy dátovej vrstvy, spúšťajú sa otvorením test.html.

import {
  DB_NAME, DEFAULT_SETTINGS, HLAD_CHUT, JEDLA, TEMPA, ValidationError,
  ensurePersistentStorage, openDatabase,
} from './db.js';

/* ---------- Malý testovací rámec ---------- */

const tests = [];
const test = (name, run) => tests.push({ name, run });

function assert(condition, message = 'Podmienka neplatí') {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message = 'Hodnoty sa líšia') {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}\n  očakávané: ${e}\n  skutočné:  ${a}`);
}

async function assertRejects(run, check, message = 'Očakávala sa chyba') {
  try {
    await run();
  } catch (error) {
    if (check) check(error);
    return;
  }
  throw new Error(message);
}

const isInvalid = (field) => (error) => {
  assert(error instanceof ValidationError, `Nečakaná chyba: ${error}`);
  assertEqual(error.field, field, 'Chyba v inom poli');
};

function deleteDatabase(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error(`Databázu ${name} sa nepodarilo zmazať.`));
  });
}

/** Čistá databáza a ovládateľné hodiny pre jeden test. */
function dbTest(name, run) {
  test(name, async () => {
    const dbName = `${DB_NAME}-test-${crypto.randomUUID()}`;
    const clock = { time: '2026-11-25T11:00:00.000Z' };
    const opened = [];
    const open = async () => {
      const db = await openDatabase(dbName, { now: () => new Date(clock.time) });
      opened.push(db);
      return db;
    };
    try {
      await run({ db: await open(), clock, open, dbName });
    } finally {
      opened.forEach((db) => db.close());
      await deleteDatabase(dbName);
    }
  });
}

const meal = (changes = {}) => ({
  datum: '2026-11-25', cas: '12:00', jedlo: 'Obed', pred: 3.5, hladChut: 'Hlad', ...changes,
});

const T1 = '2026-11-25T11:00:00.000Z';
const T2 = '2026-11-25T11:30:00.000Z';
const T3 = '2026-11-25T11:55:00.000Z';
const T4 = '2026-11-25T12:10:00.000Z';

/* ---------- Záznamy ---------- */

dbTest('databáza má úložiská zaznamy a nastavenia', async ({ dbName }) => {
  const connection = await new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const names = [...connection.objectStoreNames].sort();
  connection.close();
  assertEqual(names, ['nastavenia', 'zaznamy']);
});

dbTest('nový záznam dostane id, časové značky a prázdne voliteľné polia', async ({ db }) => {
  const record = await db.addRecord(meal());
  assert(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(record.id),
    'id nie je UUID');
  assertEqual(await db.getRecord(record.id), {
    id: record.id,
    po: null,
    po20: null,
    tempo: null,
    poznamka: '',
    datum: '2026-11-25',
    cas: '12:00',
    jedlo: 'Obed',
    pred: 3.5,
    hladChut: 'Hlad',
    vytvorene: T1,
    upravene: T1,
    odoslane: null,
    poZapisane: null,
  });
});

dbTest('pri novom zázname sa nedá podstrčiť id ani odoslane', async ({ db }) => {
  const record = await db.addRecord(meal({ id: 'x', odoslane: T4, vytvorene: T4, navyse: 1 }));
  assert(record.id !== 'x');
  assertEqual([record.odoslane, record.vytvorene, 'navyse' in record], [null, T1, false]);
});

dbTest('nový záznam s po má hneď poZapisane', async ({ db }) => {
  const record = await db.addRecord(meal({ po: 7 }));
  assertEqual(record.poZapisane, T1);
});

dbTest('prijme všetky povolené hodnoty vrátane krajných', async ({ db }) => {
  for (const jedlo of JEDLA) await db.addRecord(meal({ jedlo }));
  for (const hladChut of HLAD_CHUT) await db.addRecord(meal({ hladChut }));
  for (const tempo of TEMPA) await db.addRecord(meal({ tempo }));
  await db.addRecord(meal({ pred: 1, po: 10, po20: 9.5, cas: '00:00' }));
  await db.addRecord(meal({ cas: '23:59', datum: '2028-02-29' }));
  assertEqual((await db.getAllRecords()).length,
    JEDLA.length + HLAD_CHUT.length + TEMPA.length + 2);
});

dbTest('neplatné hodnoty odmietne a nič neuloží', async ({ db }) => {
  const cases = [
    ['pred', undefined], ['pred', null], ['pred', 0.5], ['pred', 10.5], ['pred', 3.2],
    ['pred', '3'], ['pred', NaN],
    ['po', 11], ['po', ''], ['po20', 0],
    ['jedlo', 'Brunch'], ['jedlo', undefined],
    ['hladChut', undefined], ['hladChut', null], ['hladChut', 'hlad'],
    ['tempo', 'Stredne'],
    ['datum', '2026-02-30'], ['datum', '25.11.2026'], ['datum', undefined],
    ['cas', '24:00'], ['cas', '9:30'], ['cas', undefined],
    ['poznamka', null],
  ];
  for (const [field, value] of cases) {
    await assertRejects(() => db.addRecord(meal({ [field]: value })), isInvalid(field),
      `Prijaté ${field} = ${String(value)}`);
  }
  assertEqual(await db.getAllRecords(), []);
});

dbTest('neznáme id vráti undefined', async ({ db }) => {
  assertEqual(await db.getRecord('neexistuje'), undefined);
});

dbTest('záznamy sú zoradené podľa dátumu a času vzostupne', async ({ db }) => {
  await db.addRecord(meal({ datum: '2026-11-26', cas: '07:00' }));
  await db.addRecord(meal({ datum: '2026-11-25', cas: '18:30' }));
  await db.addRecord(meal({ datum: '2026-11-25', cas: '12:00' }));
  assertEqual((await db.getAllRecords()).map((r) => `${r.datum} ${r.cas}`),
    ['2026-11-25 12:00', '2026-11-25 18:30', '2026-11-26 07:00']);
});

/* ---------- Úpravy ---------- */

dbTest('úprava mení upravene, nie id a vytvorene', async ({ db, clock }) => {
  const record = await db.addRecord(meal());
  clock.time = T2;
  const updated = await db.updateRecord(record.id,
    { poznamka: 'polievka', id: 'iné', vytvorene: T4, odoslane: T4 });
  assertEqual(
    [updated.id, updated.vytvorene, updated.upravene, updated.odoslane, updated.poznamka],
    [record.id, T1, T2, null, 'polievka']);
  assertEqual(await db.getRecord(record.id), updated);
  assertEqual((await db.getAllRecords()).length, 1);
});

dbTest('poZapisane je čas prvého zápisu po', async ({ db, clock }) => {
  const { id } = await db.addRecord(meal());

  clock.time = T2;
  assertEqual((await db.updateRecord(id, { po: 7 })).poZapisane, T2, 'prvý zápis po');

  clock.time = T3;
  assertEqual((await db.updateRecord(id, { po20: 6.5 })).poZapisane, T2, 'zápis po20');
  assertEqual((await db.updateRecord(id, { po: 6, tempo: 'Pomaly' })).poZapisane, T2,
    'oprava po');

  assertEqual((await db.updateRecord(id, { po: null })).poZapisane, null, 'zmazanie po');

  clock.time = T4;
  assertEqual((await db.updateRecord(id, { po: 7 })).poZapisane, T4, 'nový zápis po');
});

dbTest('poZapisane sa nedá nastaviť zvonka', async ({ db }) => {
  const record = await db.addRecord(meal({ poZapisane: T4 }));
  assertEqual(record.poZapisane, null);
  assertEqual((await db.updateRecord(record.id, { poZapisane: T4 })).poZapisane, null);
});

dbTest('uloženie bez zmeny nechá upravene aj odoslane', async ({ db, clock }) => {
  const { id } = await db.addRecord(meal());
  clock.time = T2;
  await db.markSent([id]);
  clock.time = T3;
  const same = await db.updateRecord(id, meal());
  assertEqual([same.upravene, same.odoslane], [T1, T2]);
});

dbTest('markSent nastaví odoslane len vybraným a nemení upravene', async ({ db, clock }) => {
  const first = await db.addRecord(meal());
  const second = await db.addRecord(meal({ cas: '18:00' }));
  clock.time = T2;
  await db.markSent([first.id, 'neexistuje']);
  assertEqual((await db.getAllRecords()).map((r) => [r.odoslane, r.upravene]),
    [[T2, T1], [null, T1]]);
  assertEqual((await db.getRecord(second.id)).odoslane, null);
  assertEqual(await db.getRecord('neexistuje'), undefined);
});

dbTest('úprava odoslaného záznamu ho vráti medzi neodoslané', async ({ db, clock }) => {
  const { id } = await db.addRecord(meal());
  await db.markSent([id]);
  clock.time = T2;
  assertEqual((await db.updateRecord(id, { po20: 6 })).odoslane, null);
});

dbTest('neplatná úprava záznam nezmení', async ({ db, clock }) => {
  const record = await db.addRecord(meal());
  clock.time = T2;
  await assertRejects(() => db.updateRecord(record.id, { poznamka: 'x', po: 12 }),
    isInvalid('po'));
  await assertRejects(() => db.updateRecord(record.id, { pred: null }), isInvalid('pred'));
  assertEqual(await db.getRecord(record.id), record);
});

dbTest('úprava neexistujúceho záznamu skončí chybou', async ({ db }) => {
  await assertRejects(() => db.updateRecord('neexistuje', { po: 5 }));
  assertEqual(await db.getAllRecords(), []);
});

dbTest('zmazanie odstráni len daný záznam', async ({ db }) => {
  const first = await db.addRecord(meal());
  const second = await db.addRecord(meal({ cas: '18:00' }));
  await db.deleteRecord(first.id);
  assertEqual((await db.getAllRecords()).map((r) => r.id), [second.id]);
});

dbTest('dáta zostanú po zatvorení a opätovnom otvorení', async ({ db, open }) => {
  const record = await db.addRecord(meal({ po: 7, poznamka: 'ľščťžýáíé; „test“' }));
  await db.saveSettings({ email: 'niekto@example.com' });
  db.close();
  const again = await open();
  assertEqual(await again.getRecord(record.id), record);
  assertEqual((await again.getSettings()).email, 'niekto@example.com');
});

/* ---------- Nastavenia ---------- */

dbTest('nastavenia majú predvolené hodnoty', async ({ db }) => {
  assertEqual(await db.getSettings(), { email: '', startOd: 3, startDo: 4, stop: 6 });
  assertEqual({ ...DEFAULT_SETTINGS }, await db.getSettings());
});

dbTest('uloženie časti nastavení nechá ostatné', async ({ db }) => {
  await db.saveSettings({ email: '  niekto@example.com ' });
  await db.saveSettings({ stop: 6.5, navyse: true });
  assertEqual(await db.getSettings(),
    { email: 'niekto@example.com', startOd: 3, startDo: 4, stop: 6.5 });
});

dbTest('neplatné nastavenia odmietne', async ({ db }) => {
  await assertRejects(() => db.saveSettings({ stop: 11 }), isInvalid('stop'));
  await assertRejects(() => db.saveSettings({ startOd: '3' }), isInvalid('startOd'));
  await assertRejects(() => db.saveSettings({ email: null }), isInvalid('email'));
  assertEqual(await db.getSettings(), { ...DEFAULT_SETTINGS });
});

/* ---------- Trvalé úložisko ---------- */

test('žiadosť o trvalé úložisko vráti áno, nie alebo nepodporované', async () => {
  const result = await ensurePersistentStorage();
  assert(result === true || result === false || result === null, `Nečakané: ${result}`);
});

/* ---------- Spustenie ---------- */

const list = document.getElementById('results');
const summary = document.getElementById('summary');
let failed = 0;

for (const { name, run } of tests) {
  const item = document.createElement('li');
  item.textContent = name;
  try {
    await run();
    item.className = 'ok';
  } catch (error) {
    failed += 1;
    item.className = 'fail';
    const detail = document.createElement('pre');
    detail.textContent = error?.stack ?? String(error);
    item.append(detail);
  }
  list.append(item);
}

summary.textContent = failed
  ? `Zlyhalo ${failed} z ${tests.length} testov.`
  : `Všetky testy prešli (${tests.length}).`;
summary.className = failed ? 'fail' : 'ok';
document.body.dataset.done = 'true';
