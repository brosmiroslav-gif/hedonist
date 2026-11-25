// Hedonist – ukladanie dát v IndexedDB.

export const DB_NAME = 'hedonist';
const DB_VERSION = 1;
const RECORDS = 'zaznamy';
const SETTINGS = 'nastavenia';
const SETTINGS_KEY = 'app';

export const JEDLA = Object.freeze(
  ['Raňajky', 'Desiata', 'Obed', 'Olovrant', 'Večera', 'Neskoro večer', 'Maškrta']);
export const HLAD_CHUT = Object.freeze(
  ['Hlad', 'Chuť', 'Stres', 'Nuda / únava', 'Zvyk / spoločnosť']);
export const TEMPA = Object.freeze(['Pomaly', 'Normálne', 'Rýchlo']);

export const DEFAULT_SETTINGS = Object.freeze({ email: '', startOd: 3, startDo: 4, stop: 6 });

// Polia, ktoré zadáva používateľ. Ostatné (id, časové značky) spravuje táto vrstva.
const DATA_FIELDS = [
  'datum', 'cas', 'jedlo', 'pred', 'po', 'po20', 'hladChut', 'tempo', 'poznamka'];

export class ValidationError extends Error {
  constructor(field, value) {
    super(`Neplatná hodnota poľa „${field}“: ${JSON.stringify(value)}`);
    this.name = 'ValidationError';
    this.field = field;
  }
}

/* ---------- Kontrola hodnôt ---------- */

/** Hodnota na škále 1–10 s krokom 0,5. */
export function isScore(value) {
  return typeof value === 'number' && value >= 1 && value <= 10 && Number.isInteger(value * 2);
}

function isDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

function isTime(value) {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

const RECORD_RULES = {
  datum: isDate,
  cas: isTime,
  jedlo: (value) => JEDLA.includes(value),
  pred: isScore,
  po: (value) => value === null || isScore(value),
  po20: (value) => value === null || isScore(value),
  hladChut: (value) => HLAD_CHUT.includes(value),
  tempo: (value) => value === null || TEMPA.includes(value),
  poznamka: (value) => typeof value === 'string',
};

const SETTINGS_RULES = {
  email: (value) => typeof value === 'string',
  startOd: isScore,
  startDo: isScore,
  stop: isScore,
};

function validate(object, rules) {
  for (const [field, isValid] of Object.entries(rules)) {
    if (!isValid(object[field])) throw new ValidationError(field, object[field]);
  }
}

/** Vyberie z objektu len uvedené polia; chýbajúce (undefined) vynechá. */
function pick(object, fields) {
  return Object.fromEntries(
    fields.filter((field) => object[field] !== undefined).map((field) => [field, object[field]]));
}

function compareRecords(a, b) {
  return a.datum.localeCompare(b.datum)
    || a.cas.localeCompare(b.cas)
    || a.vytvorene.localeCompare(b.vytvorene);
}

/* ---------- IndexedDB ---------- */

function openConnection(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, DB_VERSION);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(RECORDS, { keyPath: 'id' });
      request.result.createObjectStore(SETTINGS);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Spustí operácie v jednej transakcii. Funkcia `work` dostane object store
 * a `done(výsledok)`. Prísľub sa splní až po zapísaní transakcie; ak `work`
 * alebo jej spätné volanie vyhodí chybu, nezapíše sa nič.
 */
function transact(connection, storeName, mode, work) {
  return new Promise((resolve, reject) => {
    // 'strict': zápis je potvrdený až po uložení na disk.
    const transaction = connection.transaction(storeName, mode, { durability: 'strict' });
    let result;
    let failure;
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(failure ?? transaction.error);

    const guard = (callback) => (...args) => {
      try {
        callback(...args);
      } catch (error) {
        failure = error;
        transaction.abort();
      }
    };
    guard(() => work(
      transaction.objectStore(storeName),
      (value) => { result = value; },
      guard,
    ))();
  });
}

/**
 * Otvorí databázu a vráti operácie nad ňou.
 * Parametre sú určené pre testy: iný názov databázy a vlastné hodiny.
 */
export async function openDatabase(name = DB_NAME, { now = () => new Date() } = {}) {
  const connection = await openConnection(name);
  // Ak sa v budúcnosti otvorí novšia verzia databázy, neblokujeme ju.
  connection.onversionchange = () => connection.close();

  const run = (storeName, mode, work) => transact(connection, storeName, mode, work);
  const timestamp = () => now().toISOString();

  return {
    /** Vytvorí nový záznam a vráti ho. */
    async addRecord(data) {
      const time = timestamp();
      const record = {
        id: crypto.randomUUID(),
        po: null,
        po20: null,
        tempo: null,
        poznamka: '',
        ...pick(data, DATA_FIELDS),
        vytvorene: time,
        upravene: time,
        odoslane: null,
      };
      validate(record, RECORD_RULES);
      record.poZapisane = record.po === null ? null : time;

      return run(RECORDS, 'readwrite', (store, done) => {
        store.add(record);
        done(record);
      });
    },

    /**
     * Zmení údaje záznamu. Pri skutočnej zmene nastaví `upravene` a záznam
     * vráti medzi neodoslané. `poZapisane` je čas prvého zápisu `po`.
     */
    updateRecord(id, changes) {
      return run(RECORDS, 'readwrite', (store, done, guard) => {
        const request = store.get(id);
        request.onsuccess = guard(() => {
          const current = request.result;
          if (!current) throw new Error(`Záznam ${id} neexistuje.`);

          const next = { ...current, ...pick(changes, DATA_FIELDS) };
          validate(next, RECORD_RULES);
          if (DATA_FIELDS.every((field) => next[field] === current[field])) {
            done(current);
            return;
          }

          const time = timestamp();
          if (next.po === null) next.poZapisane = null;
          else if (current.po === null) next.poZapisane = time;
          next.upravene = time;
          next.odoslane = null;
          store.put(next);
          done(next);
        });
      });
    },

    /** Vráti záznam alebo `undefined`. */
    getRecord(id) {
      return run(RECORDS, 'readonly', (store, done) => {
        const request = store.get(id);
        request.onsuccess = () => done(request.result);
      });
    },

    /** Všetky záznamy zoradené podľa dátumu a času vzostupne. */
    async getAllRecords() {
      const records = await run(RECORDS, 'readonly', (store, done) => {
        const request = store.getAll();
        request.onsuccess = () => done(request.result);
      });
      return records.sort(compareRecords);
    },

    deleteRecord(id) {
      return run(RECORDS, 'readwrite', (store) => {
        store.delete(id);
      });
    },

    /** Označí záznamy ako odoslané. `upravene` sa nemení – údaje sú rovnaké. */
    markSent(ids) {
      const time = timestamp();
      return run(RECORDS, 'readwrite', (store, done, guard) => {
        for (const id of ids) {
          const request = store.get(id);
          request.onsuccess = guard(() => {
            if (request.result) store.put({ ...request.result, odoslane: time });
          });
        }
      });
    },

    /** Nastavenia doplnené o predvolené hodnoty. */
    getSettings() {
      return run(SETTINGS, 'readonly', (store, done) => {
        const request = store.get(SETTINGS_KEY);
        request.onsuccess = () => done({ ...DEFAULT_SETTINGS, ...request.result });
      });
    },

    /** Uloží zmenené nastavenia a vráti všetky. */
    saveSettings(changes) {
      return run(SETTINGS, 'readwrite', (store, done, guard) => {
        const request = store.get(SETTINGS_KEY);
        request.onsuccess = guard(() => {
          const next = {
            ...DEFAULT_SETTINGS,
            ...request.result,
            ...pick(changes, Object.keys(DEFAULT_SETTINGS)),
          };
          validate(next, SETTINGS_RULES);
          next.email = next.email.trim();
          store.put(next, SETTINGS_KEY);
          done(next);
        });
      });
    },

    close() {
      connection.close();
    },
  };
}

/* ---------- Trvalé úložisko ---------- */

/**
 * Požiada prehliadač, aby dáta nemazal. Vracia `true` / `false`,
 * alebo `null`, ak to prehliadač nepodporuje.
 */
export async function ensurePersistentStorage() {
  if (!navigator.storage?.persist) return null;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}
