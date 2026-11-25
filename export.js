// Hedonist – tvorba e-mailu, CSV a zálohy.

export const APP_VERSION = '1.0';

/** Dlhší `mailto:` odkaz Android nemusí preniesť celý. */
export const MAILTO_LIMIT = 1800;

const APP_NAME = 'Hedonist';
const BACKUP_FORMAT = 1;
const CSV_HEADER = 'datum;cas;jedlo;pred;po;po20;hlad_chut;tempo;poznamka;id';

/* ---------- E-mail (formát podľa sekcie 4 zadania, strojovo sa spracúva) ---------- */

function compareByTime(a, b) {
  return a.datum.localeCompare(b.datum)
    || a.cas.localeCompare(b.cas)
    || a.vytvorene.localeCompare(b.vytvorene);
}

/** V poznámke nesmie byť oddeľovač ani zalomenie riadku. */
function cleanNote(note) {
  return note
    .replace(/\r\n|[\n\r\v\f\u0085\u2028\u2029]/g, ' ')
    .replace(/;/g, ',');
}

function csvLine(record) {
  // Čísla sa zapisujú s desatinnou bodkou, prázdna hodnota ako nič.
  return [
    record.datum,
    record.cas,
    record.jedlo,
    record.pred,
    record.po,
    record.po20,
    record.hladChut,
    record.tempo,
    cleanNote(record.poznamka),
    record.id,
  ].map((value) => (value === null ? '' : String(value))).join(';');
}

function countLabel(count) {
  if (count === 1) return '1 záznam';
  if (count >= 2 && count <= 4) return `${count} záznamy`;
  return `${count} záznamov`;
}

/** Predmet e-mailu; zoznam záznamov nesmie byť prázdny. */
export function emailSubject(records) {
  const dates = records.map(({ datum }) => datum).sort();
  const first = dates[0];
  const last = dates[dates.length - 1];
  const range = first === last ? first : `${first} – ${last}`;
  return `[HLAD] ${range} (${countLabel(records.length)})`;
}

export function emailBody(records) {
  return [
    `Záznamy hladu a sýtosti – export z aplikácie ${APP_NAME} v${APP_VERSION}`,
    '',
    '---BEGIN CSV---',
    CSV_HEADER,
    ...[...records].sort(compareByTime).map(csvLine),
    '---END CSV---',
  ].join('\n');
}

export function mailtoUrl(email, subject, body) {
  const address = encodeURIComponent(email).replace(/%40/g, '@').replace(/%2C/g, ',');
  // V `mailto:` sa riadky oddeľujú dvojicou CR LF.
  const text = encodeURIComponent(body.replace(/\n/g, '\r\n'));
  return `mailto:${address}?subject=${encodeURIComponent(subject)}&body=${text}`;
}

/* ---------- Záloha ---------- */

export function backupFileName(datum) {
  return `hedonist-zaloha-${datum}.json`;
}

export function createBackup(records, settings, now = new Date()) {
  return JSON.stringify({
    aplikacia: APP_NAME,
    format: BACKUP_FORMAT,
    vytvorene: now.toISOString(),
    nastavenia: settings,
    zaznamy: records,
  }, null, 2);
}

/** Prečíta zálohu. Jednotlivé záznamy skontroluje až databáza pri obnove. */
export function parseBackup(text) {
  let data;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('Súbor nie je platný JSON.');
  }
  if (data?.aplikacia !== APP_NAME || !Array.isArray(data.zaznamy)) {
    throw new Error('Súbor nie je záloha aplikácie Hedonist.');
  }
  if (data.format !== BACKUP_FORMAT) {
    throw new Error('Záloha má neznámy formát. Aktualizuj aplikáciu.');
  }
  return { records: data.zaznamy, settings: data.nastavenia ?? null };
}
