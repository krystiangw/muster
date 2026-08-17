# Warstwa mailowa dla człowieka: sesje, odzyskiwanie, prywatność

Stan: **w trakcie**. Zaczęte 2026-08-17 12:20.

Zasada nadrzędna, której nie wolno złamać żadnym krokiem poniżej: **agent zakłada
projekt bez człowieka**. Poczta jest warstwą dokładaną (odzyskiwanie, prywatność,
przekrój ponadprojektowy), nigdy bramą wejściową. `POST /p` zostaje anonimowe
i wszystkie checki Let Agents In muszą dalej przechodzić.

## Lista kontrolna

Watchdog czyta ten plik i podejmuje pierwszą niezaznaczoną pozycję.

- [x] 1. Sesja mailem zamiast wiecznego linku
  - [x] 1a. Kod jednorazowy dla operatora: `POST /operator` wysyła sześć cyfr zamiast linku
  - [x] 1b. Sesja w ciasteczku `HttpOnly; Secure; SameSite=Lax`, 30 dni, `/operator` bez tokenu w URL
  - [x] 1c. Stary link `/operator/<token>` działa dalej, ale jest jednorazowy i wymienia się na sesję
  - [x] 1d. Token CSRF na każdym formularzu operatorskim (sesja w ciasteczku przywraca tę powierzchnię)
  - [x] 1e. Wylogowanie i "zakończ wszystkie sesje"
  - [x] 1f. Testy: logowanie kodem, wygasanie, CSRF odrzucane, brak enumeracji adresu
- [x] 2. Odzyskanie tokena projektu z widoku operatora
  - [x] 2a. `POST /operator/projects/:id/keys` wystawia nowy token admina właścicielowi
  - [x] 2b. Widoczne w widoku operatora per projekt, z ostrzeżeniem że token pokazuje się raz
  - [x] 2c. Testy: tylko właściciel, tylko z sesją, stare klucze nietknięte
- [x] 3. Prywatność projektu po przejęciu
  - [x] 3a. `visibility: 'link' | 'owner'` na projekcie, domyślnie `link`
  - [x] 3b. `owner` wymaga sesji z adresem równym `claimedBy` na `/r/<token>` i `/r/<token>/board`
  - [x] 3c. Przełącznik w widoku operatora i w API (`PATCH /v1/{project}`)
  - [x] 3d. Testy: obcy z linkiem dostaje 404, właściciel z sesją wchodzi, agent z tokenem nietknięty
- [x] 4. Przekrój "Twoja robota" ponad projektami
  - [x] 4a. Aliasy właściciela na koncie mailowym (na jakie nazwy w polu `owner` odpowiadasz)
  - [x] 4b. Sekcja w widoku operatora: otwarte itemy przypisane do Ciebie, ze wszystkich projektów
  - [x] 4c. Itemy zablokowane i te, których claim wygasł, też tam trafiają
  - [x] 4d. Testy: przekrój obejmuje wiele projektów i nie przecieka między właścicielami
- [ ] 5. Domknięcie
  - [ ] 5a. `/codex-review` na całości, znaleziska naprawione
  - [x] 5b. Dokumentacja: `skill.md`, `/docs`, README, notatki projektowe
  - [ ] 5c. Wdrożone na Heroku i sprawdzone na żywej instancji
  - [x] 5d. Audyt bezpieczeństwa zaktualizowany o nową powierzchnię (ciasteczka, CSRF, sesje)

## Notatki dla wznowienia

- Repo: gałąź `main`, deploy `git push heroku main`.
- Testy: `cd apps/server && node --import tsx --test test/*.test.ts`.
- Lokalnie: `./scripts/dev-local.sh` (port 4600), dane w `.data/`.
- Produkcja: instancja na Heroku, adres w `heroku info`.
- Przed każdym commitem: `pnpm typecheck` i pełny suite.
- Po każdym niebanalnym kroku: `codex review --commit <sha>` i naprawa znalezisk.
