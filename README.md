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

## Nová verzia (cache)

Aplikácia sa servíruje z cache service workera. **Pri každej zmene súborov zvýš
`CACHE_VERSION` v `sw.js`** (napr. `v1` → `v2`). Nové súbory pridaj aj do zoznamu `ASSETS`.

Po nasadení stačí aplikáciu otvoriť s pripojením na internet. Zobrazí sa lišta
„Je dostupná nová verzia – Obnoviť“.

## Licencie

Fonty IBM Plex sú pod licenciou SIL OFL 1.1, pozri [fonts/license.txt](fonts/license.txt).
