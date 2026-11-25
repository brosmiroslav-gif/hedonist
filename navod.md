# Hedonist – offline PWA

Zadanie pre Claude Code. Cieľ: malá, rýchla, úplne offline aplikácia do Android mobilu na zaznamenávanie hladu a sýtosti (škála 1–10) so zabudovanou vreckovou kartou a odoslaním záznamov e-mailom.

**Názov aplikácie:** Hedonist (v `manifest.webmanifest`: `name: "Hedonist"`, `short_name: "Hedonist"`, `<title>` v `index.html` tiež „Hedonist“). Podtitul v hlavičke aplikácie: *hlad a sýtosť*.

---

## 0. Repozitár a nasadenie na GitHub Pages (urob ako prvé)

Pracovný priečinok je `Hedonist`. Z neho vytvor nový GitHub repozitár a nastav automatické nasadenie.

1. **Prihlásenie:** over `gh auth status`.
   - Ak `gh` nie je nainštalované, povedz mi to a navrhni inštaláciu pre môj systém.
   - Ak nie som prihlásený, **neprihlasuj ma sám a nepýtaj si heslo ani token.** Požiadaj ma, aby som v termináli spustil `gh auth login --web` (protokol HTTPS) a prihlásil sa v prehliadači. Do GitHubu sa prihlasujem cez svoj Google účet („Continue with Google“). Pokračuj až po mojom potvrdení.
2. **Repozitár:** ak priečinok ešte nie je git repozitár, spusti `git init -b main`. Pridaj `.gitignore` (minimálne `.DS_Store`, `Thumbs.db`, `*.log`, `.env*`, `node_modules/`).
3. Prvý commit s `navod.md` a `README.md` (zatiaľ len krátky popis projektu).
4. **Vytvor repozitár** `hedonist` ako **verejný**: `gh repo create hedonist --public --source=. --remote=origin --push`. GitHub Pages je na bezplatnom účte dostupný len pre verejné repozitáre. V repozitári je len kód, žiadne osobné dáta. Tie zostávajú v telefóne.
5. **Zapni GitHub Pages** z vetvy `main`, priečinok `/`:
   `gh api -X POST repos/{owner}/hedonist/pages -f "source[branch]=main" -f "source[path]=/"`
   (`{owner}` zisti cez `gh api user --jq .login`). Ak to zlyhá, napíš mi, ako to zapnúť ručne v Settings → Pages.
6. Výsledná adresa bude `https://<owner>.github.io/hedonist/`. Napíš mi ju a zapíš ju do README.

**Dôležité pre PWA na podadrese `/hedonist/`:** všetky cesty v aplikácii musia byť **relatívne** (`./app.js`, `./fonts/…`, `./icons/…`). V manifeste nastav `"start_url": "./"` a `"scope": "./"`. Service worker registruj ako `navigator.serviceWorker.register('./sw.js')`. Žiadne absolútne cesty začínajúce `/`.

Po každom ďalšom kroku zo sekcie 9: commit a `git push`, aby som mohol hneď testovať na mobile na adrese z GitHub Pages (nasadenie trvá zvyčajne 1–2 minúty).

---

## 1. Rámec a obmedzenia

- **Typ:** Progressive Web App (PWA), inštalovateľná na plochu Androidu cez Chrome („Pridať na plochu“ / „Inštalovať aplikáciu“).
- **Offline:** po prvom načítaní musí fungovať v režime lietadlo – všetky súbory vrátane fontov a ikon cachuje service worker. Žiadne CDN, žiadne externé requesty.
- **Bez backendu, bez účtov, bez analytiky.** Dáta zostávajú v telefóne.
- **Technológia:** čisté HTML + CSS + vanilla JavaScript (ES modules). Žiadny framework, žiadny build krok, žiadne npm závislosti v runtime.
- **Jazyk UI:** slovenčina (správna diakritika).
- **Cieľové zariadenie:** Android, Chrome, šírka 360–430 px. Na desktope len musí byť použiteľná.
- **Hosting:** statické súbory cez HTTPS (service worker HTTPS vyžaduje). Odporúčané GitHub Pages alebo Forgejo Pages. Lokálne testovanie cez `localhost`.

### Štruktúra súborov

```
/
├── index.html
├── app.js            # logika, routovanie medzi obrazovkami
├── db.js             # ukladanie dát
├── export.js         # tvorba e-mailu / CSV / zálohy
├── styles.css
├── sw.js             # service worker (cache-first)
├── manifest.webmanifest
├── fonts/            # IBM Plex Sans Condensed (400, 600, 700), IBM Plex Mono (500, 600) – woff2, latin + latin-ext
├── icons/            # 192, 512, maskable 512
└── README.md         # ako nasadiť a ako zvýšiť verziu cache
```

Fonty: stiahnuť woff2 z oficiálneho repa IBM Plex (licencia OFL) a pribaliť lokálne. Musia obsahovať latin-ext (ľ, š, č, ť, ž, ý, á, í, é, ú, ä, ô, ň, ĺ, ŕ, ď).

---

## 2. Dátový model

Jeden záznam = jedno jedlo.

```js
{
  id: "uuid",
  datum: "2026-11-25",         // lokálny dátum (Europe/Bratislava)
  cas: "12:00",                // HH:MM
  jedlo: "Obed",               // Raňajky | Desiata | Obed | Olovrant | Večera | Neskoro večer | Maškrta
  pred: 3.5,                   // 1–10, krok 0.5, povinné
  po: 7,                       // 1–10, krok 0.5, voliteľné (doplní sa neskôr)
  po20: null,                  // 1–10, krok 0.5, voliteľné
  hladChut: "Hlad",            // Hlad | Chuť | Stres | Nuda / únava | Zvyk / spoločnosť
  tempo: "Normálne",           // Pomaly | Normálne | Rýchlo
  poznamka: "text",
  vytvorene: "ISO timestamp",
  upravene: "ISO timestamp",
  odoslane: null               // ISO timestamp posledného odoslania, null = neodoslané
}
```

Nastavenia:

```js
{ email: "", startOd: 3, startDo: 4, stop: 6 }
```

**Úložisko:** IndexedDB (jedna object store `zaznamy`, jedna `nastavenia`). Pri prvom spustení zavolať `navigator.storage.persist()`, aby Android dáta nemazal. Na obrazovke Nastavenia zobraziť, či je úložisko trvalé.

**Záloha:** export všetkých dát do JSON súboru (stiahnutie) a import z JSON (zlúčenie podľa `id`, novší `upravene` vyhráva).

---

## 3. Obrazovky

Spodná navigačná lišta so 4 položkami (ikony = jednoduché inline SVG, žiadne emoji):
**Zápis · Karta · Záznamy · Odoslať**. Nastavenia sú ozubené koliesko v hlavičke.

### 3.1 Zápis (úvodná obrazovka)

Najdôležitejšia obrazovka. Zápis „pred jedlom“ musí trvať najviac **3 ťuknutia + Uložiť**.

1. **Rozpracované jedlá** (ak existujú): hore karta pre každý záznam z posledných 6 hodín, ktorý nemá vyplnené `po` alebo `po20`. Napr. „Obed 12:00 · pred 3,5 · chýba: po 20 min“. Ťuknutím sa otvorí doplnenie chýbajúcej hodnoty.
   - Ak bolo `po` zapísané pred viac ako 20 minútami a `po20` chýba, karta je zvýraznená textom **„Teraz: po 20 min“**.
2. **Nový záznam:**
   - Dátum a čas sa predvyplnia aktuálnymi hodnotami (dajú sa zmeniť ťuknutím).
   - **Jedlo:** rad čipov. Predvolený typ podľa času: do 9:30 Raňajky, do 11:00 Desiata, do 14:00 Obed, do 17:00 Olovrant, do 20:30 Večera, potom Neskoro večer.
   - **Pred (1–10):** zvislá stupnica 10 → 1, vizuálne zhodná s kartou (číslo + názov stupňa). Ťuknutie = celé číslo, dlhé podržanie alebo druhé ťuknutie na ten istý riadok = pol stupňa nižšie (napr. 4 → 3,5). Zóna začiatku (3–4) podfarbená, 6 označená STOP.
   - **Hlad / chuť:** čipy. Nad nimi malý text testu: *„Zjedol by som teraz aj obyčajný chlieb?“*
   - **Tempo a poznámka** sa zbalia pod „Viac“ (vypĺňajú sa skôr pri doplnení `po`).
   - **Uložiť.** Po uložení krátke potvrdenie a návrat na Zápis.
3. **Doplnenie po jedle:** rovnaká stupnica pre `po`, potom tempo a poznámka. Po uložení `po` sa zobrazí odpočet **20:00** do zápisu `po20`.

**Pripomienka o 20 minút (best effort):** ak používateľ povolí notifikácie, po uložení `po` naplánovať notifikáciu cez service worker (`setTimeout` v SW / `showNotification`). V README poctivo napísať, že Android môže uspatú PWA zastaviť a notifikácia preto nemusí prísť. Hlavná poistka je zvýraznená karta „Teraz: po 20 min“ v bode 1.

### 3.2 Karta

Dve záložky **Predná / Zadná** (aj swipe). Obsah 1:1 podľa sekcie 5. Žiadne interakcie, len čítanie. Musí sa zmestiť na obrazovku 360 × 640 bez posúvania, prípadne s minimálnym.

### 3.3 Záznamy

- Zoznam zoskupený podľa dní (najnovší hore). V riadku: čas, jedlo, `pred → po → po20`, štítok hlad/chuť, bodka „neodoslané“.
- Indikátor **„V zóne“**: áno, ak `startOd ≤ pred ≤ startDo` a `po ≤ stop`; nie, ak sú obe hodnoty vyplnené a podmienka neplatí; inak nič.
- Ťuknutie = úprava, potiahnutie doľava = vymazanie s potvrdením.
- Hore súhrn za posledných 7 dní: počet jedál, priemer pred, priemer po, % v zóne, počet jedál nie z hladu.

### 3.4 Odoslať

- Výber rozsahu: **Neodoslané** (predvolené) / Dnes / Posledných 7 dní / Vlastný rozsah.
- Náhľad tela e-mailu (needitovateľný, s možnosťou skopírovať).
- Tlačidlo **„Odoslať e-mailom“**: otvorí `mailto:` s predvyplneným adresátom, predmetom a telom (formát v sekcii 4).
  - Ak by `mailto:` URL presiahla 1 800 znakov, použiť `navigator.share({ title, text })` (Android ponúkne Gmail). Ak ani to nie je dostupné, ponúknuť „Kopírovať do schránky“.
- Po návrate do aplikácie dialóg **„Odoslal si e-mail?“ Áno / Nie**. Pri Áno nastaviť `odoslane` na odoslaných záznamoch.
- Tlačidlá **Záloha (JSON)** a **Obnoviť zo zálohy**.

### 3.5 Nastavenia

- E-mailová adresa príjemcu.
- Zóna: začať od – do (predvolene 3–4), STOP (predvolene 6).
- Stav trvalého úložiska, verzia aplikácie.

---

## 4. Formát e-mailu (prísne dodržať, bude sa strojovo spracúvať)

**Predmet:**

```
[HLAD] 2026-11-25 – 2026-11-26 (5 záznamov)
```

Pri jednom dni: `[HLAD] 2026-11-25 (3 záznamy)`. Prefix `[HLAD]` je povinný a vždy na začiatku.

**Telo:** krátky úvodný riadok, prázdny riadok, potom blok CSV ohraničený značkami:

```
Záznamy hladu a sýtosti – export z aplikácie Hedonist v1.0

---BEGIN CSV---
datum;cas;jedlo;pred;po;po20;hlad_chut;tempo;poznamka;id
2026-11-25;12:00;Obed;3.5;7;;Hlad;Normálne;Bez piva by bolo 6;8f1c…
2026-11-25;18:30;Večera;3;6;6.5;Hlad;Pomaly;;a92e…
---END CSV---
```

Pravidlá:
- Oddeľovač `;`, desatinná **bodka**, kódovanie UTF-8.
- Prázdna hodnota = nič medzi oddeľovačmi.
- V poznámke nahradiť `;` čiarkou a zalomenia riadkov medzerou.
- Zoradené podľa dátumu a času vzostupne.
- `id` na konci slúži na rozpoznanie duplicít pri opakovanom odoslaní.

---

## 5. Obsah karty (presný text)

### Predná strana – „Hlad ↔ sýtosť“ (podnadpis: *Ohodnoť sa: pred jedlom · v polovici · 20 min po*)

| # | Názov | Popis | Značka |
|---|---|---|---|
| 10 | Bolestivo prejedený | nevoľnosť, reflux, bolesť | |
| 9 | Prejedený | tlak, ospalosť, povoľujem opasok | |
| 8 | Plný | ťažoba, ďalšie sústo už nechutí | |
| 7 | Spokojne sýty | žalúdok cítim, ťažko mi nie je | |
| 6 | Príjemne nasýtený | hlad zmizol, ešte by šlo, netreba | **STOP** (inverzný riadok: tmavé pozadie, biely text) |
| 5 | Neutrálny | ani hlad, ani sýtosť | |
| 4 | Mierne hladný | „niečo by som zjedol“, vydržím | **ZAČNI** (podfarbená zóna 4–3) |
| 3 | Hladný | prázdno v žalúdku, jasný hlad | (zóna) |
| 2 | Veľmi hladný | kručanie, podráždenosť, myslím na jedlo | |
| 1 | Vyhladovaný | slabosť, triaška, závrat | |

Pätička: **Začni pri 3–4. Prestaň pri 6 — za 20 minút sa to dotiahne na 7.**

### Zadná strana – „Pred · počas · po“

- **PRED** – *Hlad, alebo chuť?* Zjedol by som teraz aj obyčajný chlieb? Áno → hlad. Chcem len to jedno → chuť (stres, únava, nuda, zvyk). Pri 1–2 začni bielkovinou a zeleninou.
- **POČAS** – *V polovici taniera zlož príbor.* Nádych, číslo. Jedz pomaly — signál sýtosti mešká 10–20 minút.
- **PO** – *O 20 minút znova číslo.* Zapíš: pred · po · po 20 min · hlad/chuť.

**Čo sýti (na kalóriu)** – štyri pruhy klesajúcej dĺžky:
- **Najviac:** mäso, ryby, vajcia, tvaroh, strukoviny, zelenina, vývar, varené zemiaky
- **Stredne:** celozrnné prílohy, ovocie, ovsené vločky
- **Málo:** biele pečivo, sladkosti, chipsy, ultraspracované
- **Takmer nič:** tekuté kalórie — džús, sladené nápoje, pivo aj nealko (pruh v akcentovej farbe)

Pätička (malým, sivým): *Blundell 2010 · Rolls 2007 · Holt 1995 · Robinson 2014 · Hall 2019*

---

## 6. Vizuálny štýl

Rovnaký ako tlačená karta – vecný, typografický, bez dekorácií.

- **Fonty:** IBM Plex Sans Condensed (text), IBM Plex Mono (čísla stupnice, štítky STOP/ZAČNI/PRED…).
- **Farby:** pozadie `#ffffff`, text `#1a1a1a`, sekundárny text `#555555`, linky `#e2e2e2`, akcent `#b03a0a`, podfarbenie zóny `#fbe9dd`, STOP riadok `#1a1a1a` s textom `#ffffff` a štítkom `#ffb48a`.
- **Tmavý režim** podľa systému (`prefers-color-scheme`): pozadie `#121212`, text `#ececec`, zóna `#3a2418`, STOP riadok invertovaný (svetlý).
- **Zakázané:** gradienty, tiene na kartách, emoji, ilustrácie, zaoblené „bubliny“, animácie dlhšie ako 150 ms.
- Dotykové plochy aspoň **48 px**. Riadky stupnice na Zápise aspoň 52 px vysoké.
- Kontrast textu aspoň 4.5:1.
- Ikona aplikácie: biely štvorec, v ňom tmavá zvislá stupnica s jedným akcentovým (oranžovým) segmentom. Žiadne písmená.

---

## 7. Service worker a aktualizácie

- Stratégia **cache-first** pre všetky statické súbory. Zoznam súborov v `sw.js` s konštantou `CACHE_VERSION`.
- Pri novej verzii: nový SW sa nainštaluje na pozadí a v aplikácii sa zobrazí lišta „Je dostupná nová verzia – Obnoviť“.
- V README popísať: pri každej zmene zvýš `CACHE_VERSION`.

---

## 8. Akceptačné kritériá

1. Aplikáciu ide nainštalovať na Android plochu, spúšťa sa bez adresného riadku (`display: standalone`).
2. V režime lietadlo: spustenie, zápis, úprava, karta, záznamy aj náhľad e-mailu fungujú.
3. Dáta prežijú zatvorenie aplikácie, reštart telefónu aj aktualizáciu aplikácie.
4. Zápis „pred jedlom“ = najviac 3 ťuknutia + Uložiť.
5. Hodnota 3,5 sa dá zadať a v CSV sa zobrazí ako `3.5`.
6. E-mail presne zodpovedá sekcii 4 (prefix predmetu, značky CSV, hlavička, oddeľovač, bodka).
7. Po potvrdení odoslania majú záznamy nastavené `odoslane` a v zozname zmizne bodka „neodoslané“.
8. Záloha JSON → vymazanie dát → obnova vráti všetky záznamy bez duplicít.
9. Lighthouse: kategória PWA vyhovuje, Accessibility ≥ 95.
10. Žiadny sieťový request po prvom načítaní (overiť v DevTools → Network).

---

## 9. Postup pre Claude Code

0. Repozitár a GitHub Pages podľa sekcie 0.
1. Kostra: `index.html`, `manifest`, `sw.js`, fonty, ikony. Push na GitHub Pages a overenie inštalácie a offline režimu na mobile na prázdnej obrazovke.
2. `db.js` (IndexedDB, persist, nastavenia) a jednotkové testy v prehliadači (jednoduchá stránka `test.html`, bez frameworku).
3. Obrazovka Karta (statická, overí sa vizuál a fonty).
4. Zápis + doplnenie po jedle + rozpracované jedlá.
5. Záznamy + súhrn 7 dní + úprava a mazanie.
6. Odoslať (mailto / share / schránka) + záloha a obnova.
7. Nastavenia, tmavý režim, notifikácia (best effort).
8. README: lokálne spustenie, nasadenie na GitHub Pages, zvýšenie verzie cache, inštalácia na Android.

Mimo rozsahu: kalórie a makroživiny (rieši ich iná aplikácia), účty, synchronizácia, server.
