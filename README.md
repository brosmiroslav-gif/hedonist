# Hedonist

Malá offline PWA do Android mobilu na zaznamenávanie hladu a sýtosti (škála 1–10).
Dáta zostávajú v telefóne. Zadanie je v súbore [navod.md](navod.md).

**Aplikácia:** <https://brosmiroslav-gif.github.io/hedonist/>

## Lokálne spustenie

V priečinku projektu:

```
python -m http.server 8000
```

Potom otvor `http://localhost:8000` (nie IP adresu – service worker vyžaduje HTTPS alebo `localhost`).
Nie je potrebný žiadny build ani inštalácia závislostí.

## Testy

Otvor `http://localhost:8000/test.html` (alebo `test.html` na adrese aplikácie).
Testy dátovej vrstvy a výpočtov bežia priamo v prehliadači a používajú vlastnú dočasnú databázu.
Ak je aplikácia v prehliadači už otvorená, najprv ju aktualizuj tlačidlom „Obnoviť“,
inak testy dostanú starý `db.js` z cache.

## Dáta

IndexedDB `hedonist`, object stores `zaznamy` a `nastavenia`. Záznam má polia podľa
sekcie 2 zadania a navyše:

- `poZapisane` – ISO čas prvého zápisu `po` (inak `null`). Slúži pre pripomienku
  po 20 minútach; do CSV v e-maile nepatrí.

Pravidlá nad rámec zadania:

- `hladChut` je povinné, `tempo` môže byť `null`.
- Zmena údajov odoslaného záznamu nastaví `odoslane` späť na `null`.
- Na stupnici zápisu nemá hodnota 1 polovicu. Zóna a STOP na nej sa riadia
  nastaveniami, karta je pevná.

## Nová verzia (cache)

Aplikácia sa servíruje z cache service workera. **Pri každej zmene súborov zvýš
`CACHE_VERSION` v `sw.js`** (napr. `v1` → `v2`). Nové súbory pridaj aj do zoznamu `ASSETS`.

Po nasadení stačí aplikáciu otvoriť s pripojením na internet. Zobrazí sa lišta
„Je dostupná nová verzia – Obnoviť“.

## Licencie

Fonty IBM Plex sú pod licenciou SIL OFL 1.1, pozri [fonts/license.txt](fonts/license.txt).
