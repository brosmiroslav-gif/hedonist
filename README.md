# Hedonist

Malá offline PWA do Android mobilu na zaznamenávanie hladu a sýtosti (škála 1–10)
so zabudovanou vreckovou kartou a odoslaním záznamov e-mailom.

**Aplikácia:** <https://brosmiroslav-gif.github.io/hedonist/>

Bez backendu, účtov a analytiky. Dáta zostávajú v telefóne. Čisté HTML, CSS
a JavaScript (ES moduly), bez frameworku, bez buildu a bez externých requestov.
Zadanie je v súbore [navod.md](navod.md).

## Inštalácia na Android

1. S pripojením na internet otvor v **Chrome** adresu aplikácie. Nepoužívaj iný
   prehliadač ani náhľad stránky vnútri inej aplikácie.
2. Cez ozubené koliesko otvor Nastavenia a počkaj, kým je pri **Offline režim**
   napísané „pripravené“.
3. V menu **⋮** zvoľ **Pridať na plochu** (niekde **Inštalovať aplikáciu**)
   a potom **Inštalovať**, nie „Vytvoriť odkaz“.
4. Spusti aplikáciu z plochy. Nemá mať adresný riadok.
5. V Nastaveniach zadaj e-mail príjemcu, prípadne uprav zónu a povoľ pripomienky.
   Pri **Úložisko** má byť „trvalé“.

Potom funguje aj v režime lietadlo.

## Používanie

Po spustení sa otvorí **Karta**. Poradie v menu je Karta · Zápis · Záznamy ·
Odoslať (zmena oproti sekcii 3 zadania, kde je úvodný Zápis).

| Obrazovka | Čo robí |
|---|---|
| **Karta** | Úvodná obrazovka: predná a zadná strana vreckovej karty, prepína sa záložkou alebo potiahnutím. |
| **Zápis** | Nový záznam: ťuknutie na stupnici dá celé číslo, druhé ťuknutie alebo podržanie o pol menej (1 polovicu nemá). Povinné je „pred“ a „Hlad / chuť“. Hore sú rozpracované jedlá za posledných 6 hodín, ktorým chýba „po“ alebo „po 20 min“. |
| **Záznamy** | Súhrn 7 dní a zoznam po dňoch. Ťuknutie = úprava, potiahnutie doľava = vymazanie s potvrdením. Oranžová bodka = neodoslané. |
| **Odoslať** | Export e-mailom, záloha a obnova. |
| **Nastavenia** | E-mail príjemcu, zóna a STOP, pripomienky, stav úložiska, verzia. |

- **V zóne:** `začať od ≤ pred ≤ začať do` a `po ≤ STOP`.
- **Posledných 7 dní:** dnešok a 6 kalendárnych dní pred ním. Percento „V zóne“
  sa počíta len z jedál s vyplneným „po“.
- Zóna a STOP z Nastavení platia pre stupnicu zápisu a vyhodnotenie. Karta je pevná.

## Odoslanie e-mailom

Formát (strojovo spracúvaný) je v sekcii 4 zadania: predmet začína `[HLAD]`, telo
obsahuje CSV medzi `---BEGIN CSV---` a `---END CSV---`. Stĺpec `id` slúži na
rozpoznanie duplicít pri opakovanom odoslaní.

- Kratší export sa otvorí cez `mailto:` s adresátom, predmetom a telom.
- Ak je odkaz dlhší ako 1 800 znakov, otvorí sa **zdieľanie** (vyber Gmail).
  Zdieľanie neprenesie adresáta, preto sa jeho adresa skopíruje do schránky.
- Ak zdieľanie nie je dostupné, telo sa skopíruje do schránky a predmet má
  vlastné tlačidlo.
- Po návrate sa aplikácia opýta, či bol e-mail odoslaný. Až po **Áno** sa záznamy
  označia ako odoslané. Zmena údajov ich vráti medzi neodoslané.

## Záloha a obnova

Dáta sú len v telefóne, preto si rob zálohy: **Odoslať → Záloha (JSON)**. Súbor
sa uloží medzi stiahnuté; ulož si kópiu aj mimo telefónu.

**Obnoviť zo zálohy** záznamy zlúči podľa `id`, pri rozdiele vyhráva novší
`upravene`. Nastavenia zo zálohy sa použijú, len ak sú v telefóne ešte
predvolené.

> **Pozor:** vymazanie dát stránky v Chrome zmaže všetky záznamy. Úložisko je
> spoločné pre celú doménu `brosmiroslav-gif.github.io`, teda aj pre ostatné
> stránky na nej.

## Pripomienka po 20 minútach

Povoľuje sa v Nastaveniach a funguje len **„best effort“**. Android môže uspatú
PWA aj jej service worker zastaviť. Chrome nečinný service worker ukončí
zvyčajne už po desiatkach sekúnd, takže **notifikácia nemusí prísť** alebo príde
neskôr. Spoľahlivá poistka je zvýraznená karta **„Teraz: po 20 min“** na
obrazovke Zápis.

## Lokálne spustenie

V priečinku projektu:

```
python -m http.server 8000
```

Otvor `http://localhost:8000`. IP adresa počítača nestačí – service worker
vyžaduje HTTPS alebo `localhost`. Nie je potrebný žiadny build ani inštalácia
závislostí.

Mobil sa dá k lokálnemu serveru pripojiť cez USB: zapni ladenie USB, na počítači
otvor `chrome://inspect/#devices` a v **Port forwarding** nastav `8000` →
`localhost:8000`.

### Testy

Otvor `http://localhost:8000/test.html` (alebo `test.html` na adrese aplikácie).
Testy bežia priamo v prehliadači a používajú vlastnú dočasnú databázu. Ak je
aplikácia v prehliadači už otvorená, najprv ju aktualizuj tlačidlom „Obnoviť“,
inak testy dostanú staré súbory z cache.

## Nasadenie na GitHub Pages

Pages servuje priamo koreň vetvy `main`. Bežné nasadenie:

```
git push
```

Po 1–2 minútach je nová verzia online.

Prvé nastavenie v novom repozitári (verejnom, lebo na bezplatnom účte Pages iné
nepodporuje), po prihlásení cez `gh auth login --web`:

```
gh repo create hedonist --public --source=. --remote=origin --push
gh api -X POST repos/<owner>/hedonist/pages -f "source[branch]=main" -f "source[path]=/"
```

Ručne: **Settings → Pages → Deploy from a branch → `main`, `/ (root)`**.

Všetky cesty v aplikácii musia zostať **relatívne** (`./app.js`), pretože beží na
podadrese `/hedonist/`. Súbor `.nojekyll` vypína spracovanie Jekyllom.

## Nová verzia (cache)

Aplikácia sa servíruje z cache service workera (cache-first).

1. **Pri každej zmene súborov zvýš `CACHE_VERSION` v [sw.js](sw.js)**
   (napr. `v8` → `v9`). Bez toho telefón ostane na starej verzii.
2. Nový súbor pridaj do zoznamu `ASSETS` v tom istom súbore.
3. Commit a `git push`.
4. V telefóne otvor aplikáciu s internetom a ťukni na **„Obnoviť“** v lište
   „Je dostupná nová verzia“. Ak sa lišta neukáže, aplikáciu zavri a otvor znova.
   Dáta aktualizácia nemaže.

Verzia aplikácie (`1.0`) je v [export.js](export.js) ako `APP_VERSION`. Zobrazuje
sa v Nastaveniach a v úvodnom riadku e-mailu.

## Súbory

| Súbor | Obsah |
|---|---|
| `index.html`, `styles.css` | obrazovky a vzhľad vrátane tmavého režimu |
| `app.js` | logika a prepínanie obrazoviek |
| `db.js` | IndexedDB, kontrola hodnôt, zlúčenie zálohy |
| `export.js` | e-mail, CSV a záloha |
| `sw.js` | service worker: cache a pripomienka |
| `manifest.webmanifest`, `icons/`, `fonts/` | inštalácia PWA, ikony, písma |
| `test.html`, `tests.js` | testy v prehliadači |

## Dátový model

IndexedDB `hedonist`, object stores `zaznamy` a `nastavenia`. Záznam má polia podľa
sekcie 2 zadania a navyše:

- `poZapisane` – ISO čas prvého zápisu `po` (inak `null`). Slúži pre odpočet
  a pripomienku; do CSV v e-maile nepatrí.

`hladChut` je povinné, `tempo` môže byť `null`.

## Licencie

Fonty IBM Plex sú pod licenciou SIL OFL 1.1, pozri [fonts/license.txt](fonts/license.txt).
