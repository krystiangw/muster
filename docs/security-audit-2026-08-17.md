# Audyt bezpieczeństwa, 2026-08-17

Przeprowadzony na kodzie w commicie `f3e9a01` i na żywej instancji
`muster-web` w dniu wdrożenia. Dwa niezależne przebiegi: własny oraz Codex
z osobnym kontekstem. Każde znalezisko poniżej zostało potwierdzone w kodzie
albo żądaniem do działającego serwera, a każda poprawka ma test regresyjny
w `apps/server/test/security.test.ts`, sprawdzony przeciwko wersji bez niej.

Nic nie wskazuje na to, by którekolwiek zostało wykorzystane: instancja stała
publicznie około trzydziestu minut, a jedynym ruchem był mój własny.

## Znalezione i naprawione

### 1. Klucz `write` mógł przejąć własność projektu (wysokie)

`POST /v1/{project}/claim` i `/claim/verify` wołały `auth()`, nie
`requireAdmin()`. Dokumentacja opisuje rolę `write` jako „wszystko, czego
potrzebuje agent, i nic więcej", a tymczasem klucz wydany jednemu workerowi
mógł powiązać cały projekt z dowolnym adresem, a potem poprosić o link
operatorski i czytać oraz zmieniać wszystko, co widzi człowiek.

Drugi, ostrzejszy wariant: `claimProjectWithEmail()` ustawiał `claimedBy`
bezwarunkowym `$set`. Dwa równoległe potwierdzenia kodu przechodziły obok
siebie i późniejsze po prostu zabierało projekt właścicielowi, który przestawał
go widzieć w swoim widoku.

**Poprawka:** oba endpointy wymagają klucza admina; zapis własności jest
warunkowy (`claimedBy: null` albo ten sam adres), a konflikt to 409
`already_owned`, tak samo jak przy przejmowaniu udostępnionego projektu.

### 2. Wsad JSON-RPC zamieniał jedno żądanie w tysiące operacji (wysokie)

`POST /mcp` wykonywał tablicę żądań bez żadnego limitu długości, a limiter
liczył to jako jedno żądanie HTTP. W megabajcie ciała mieści się kilka tysięcy
wywołań narzędzi. Przy nieprawidłowym tokenie każdy element i tak robił własne
zapytanie uwierzytelniające do bazy.

**Poprawka:** wsad ma najwyżej 25 elementów, a limit czytania i pisania jest
naliczany za każde wywołanie narzędzia, na tych samych kubełkach co REST
i **przed** zapytaniem do bazy, więc zły token nie kupuje sobie zapytania na
element.

### 3. Sfałszowany `X-Forwarded-For` omijał limity (średnie, potwierdzone na produkcji)

Pięć miejsc czytało pierwszy wpis nagłówka `x-forwarded-for`, a router Heroku
**dopisuje** prawdziwy adres do tego, co przyszło od klienta. Zmierzone na
działającej instancji: dziewięć projektów pod rząd, przy opublikowanym limicie
pięciu na godzinę, wystarczyło zmieniać jedną liczbę w nagłówku. To samo
otwierało drogę do nieograniczonych maili z linkiem operatorskim na dowolny
adres, czyli do zasypania czyjejś skrzynki i spalenia limitu Resend.

**Poprawka:** `trustProxy: 1` (dokładnie jeden hop, ten należący do Heroku)
i jeden wspólny helper `clientIp()`, który pyta Fastify zamiast parsować
nagłówek. Żadna trasa nie dotyka już `x-forwarded-for` sama.

### 4. Linki-poświadczenia trafiały do logów (średnie, potwierdzone na produkcji)

Każde żądanie do `/r/<readToken>/...` i `/operator/<token>` zapisywało pełny
URL na poziomie `info`. Kto ma dostęp do `heroku logs` albo do log draina,
dostawał działające poświadczenie, które czyta tablicę, zmienia jej układ,
przesuwa karty i odpowiada agentom.

**Poprawka:** serializer logu podmienia segment z tokenem na `[redacted]`,
odpowiedzi capability dostają `Cache-Control: private, no-store`, a cały serwis
`Referrer-Policy`, bo token siedzi w ścieżce i nagłówek Referer oddaje go
pierwszej stronie, w którą ktoś kliknie.

**Korekta 2026-08-18:** polityką jest `same-origin`, nie `no-referrer`. Pod
`no-referrer` przeglądarka serializuje `Origin` w POST jako `null`, więc
kontrola same-site odmawiała każdemu formularzowi na naszych własnych stronach
capability. `same-origin` ścina nagłówek na wszystkim, co wychodzi poza serwis,
czyli na całym wycieku, o który tu chodzi. Opis w `docs/design-notes.md`.

Dodatkowo doszła **rotacja**: `POST /v1/{project}/read-link/rotate` (admin)
wystawia nowy link i natychmiast unieważnia stary. Wcześniej wyciek linku był
nieodwracalny, co jest gorsze niż sam wyciek.

### 5. Odpowiedź na `/share` mówiła, czy dany adres jest naszym użytkownikiem (średnie)

`operator_has_an_inbox` było prawdą dokładnie wtedy, gdy adres miał już jakiś
projekt. Token projektu jest darmowy i wydawany bez człowieka, więc dowolna
osoba mogła odpytać serwis „czy X jest waszym klientem".

**Poprawka:** odpowiedź jest identyczna dla każdego adresu. Agent i tak robi
to samo w obu przypadkach: podaje człowiekowi link, a jeśli ten ma już widok
operatora, oferta czeka tam równolegle.

### 6. Brak nagłówków bezpieczeństwa (średnie)

Serwis nie wysyłał żadnego. Strony nie mają ani jednej linijki JavaScriptu, co
czyni politykę nietypowo **ostrą**, a nie luźną:

```
default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:;
form-action 'self'; base-uri 'none'; frame-ancestors 'none'
```

`img-src 'self'` doszło razem z ikoną serwisu: przeglądarka pobiera favicon
pod polityką obrazków strony, więc polityka bez `'self'` zostawiała pustą
kartę w każdej zakładce, mimo że trasa ikony odpowiadała 200.

Dwa człony są tu nośne: `frame-ancestors 'none'`, bo strony capability niosą
formularze jednym kliknięciem przyjmujące projekt albo przesuwające kartę,
czyli dokładnie to, po co istnieje clickjacking; oraz `Referrer-Policy`
z punktu 4. Do tego `nosniff`, `Cross-Origin-Opener-Policy` i HSTS na rok,
wysyłane tylko gdy żądanie przyszło po TLS.

### 7. Nieudany mail wypisywał kod OTP i link operatorski do logu (niskie)

Gdy `RESEND_API_KEY` jest pusty, mailer loguje treść wiadomości, żeby lokalny
run i self-host bez poczty dało się dokończyć. Treścią jest sześciocyfrowy kod
albo pełny `/operator/<token>`. Na produkcji wystarczyłaby rotacja klucza
u dostawcy, żeby zacząć wypisywać żywe poświadczenia do logu.

**Poprawka:** poza produkcją bez zmian, na produkcji wiadomość jest odrzucana,
a log dostaje zredagowany adres i informację, że brak klucza to usterka
konfiguracji.

Przegląd samej poprawki wyłapał jej skutek uboczny: pierwsza wersja odrzucała
wiadomość i dalej odpowiadała `ok`, więc `/claim` twierdził, że kod jest
w drodze, choć nie istniał nigdzie. Teraz odrzucenie jest osobnym wynikiem
(`discarded`), `/claim` zwraca 503 `mail_not_configured` i kasuje oczekujący
kod, a strona operatorska mówi wprost, że ta instalacja nie umie wysyłać poczty.
Ta odpowiedź nie zależy od wpisanego adresu, więc nie otwiera z powrotem
enumeracji z punktu 5.

## Sprawdzone i czyste

- **Wstrzyknięcie operatorów Mongo.** Trasy JSON mają schematy, które wymuszają
  typy. Trasy HTML czytają `request.query` bez schematu, ale parser Fastify nie
  rozwija `owner[$ne]=x` w obiekt, tylko traktuje to jako klucz o tej nazwie,
  więc filtr go nie widzi. Sprawdzone żądaniem.
- **XSS.** Przejrzane wszystkie interpolacje w renderowanym HTML, łącznie
  z atrybutami i panelami `:target`. Tytuł i opis strony idą przez `escapeHtml`
  w `layout()`, akcje formularzy operatorskich też. Nie znalazłem nieosłoniętej.
- **CSRF.** Nie dotyczy, i warto wiedzieć dlaczego: nie ma ciasteczek ani innej
  ambientnej autoryzacji. Żądanie z obcej strony nie niesie żadnych uprawnień,
  a atakujący, który zna URL capability, nie potrzebuje ofiary.
- **Izolacja projektów.** Token jednego projektu dostaje 403 na drugim,
  sprawdzone testem i żądaniem.
- **Entropia tokenów.** Token projektu to 160 bitów, link do odczytu 80,
  alfabet 32-znakowy przy 256 bajtach, więc bez obciążenia modulo. Tokeny są
  przechowywane wyłącznie jako sha256 i wyszukiwane po haszu, więc porównanie
  nie ma kanału czasowego.
- **Zależności.** `pnpm audit`: zero znanych podatności. Drzewo produkcyjne to
  Fastify, sterownik Mongo i dwa pluginy Fastify.
- **Otwarte przekierowanie.** Przekierowania budują ścieżkę z segmentu, który
  nigdy nie zaczyna się od `//`, więc nie da się wyjść na obcy host.
- **Enumeracja przez `/operator`.** Odpowiedź jest identyczna dla adresu
  znanego i nieznanego; sprawdzone na produkcji, różnica w rozmiarze to sama
  długość wpisanego adresu.

## Nowa powierzchnia z tego samego dnia: sesje operatora

Po audycie doszła warstwa mailowa dla człowieka i zmienia dwa jego wnioski, więc
zapisuję to tutaj, a nie osobno.

**CSRF zaczyna dotyczyć.** Punkt „nie dotyczy, bo nie ma ciasteczek" przestał
być prawdziwy w chwili, gdy pojawiło się pierwsze ciasteczko. Każdy formularz
operatorski nosi token CSRF sprawdzany porównaniem stałoczasowym, ciasteczko ma
`HttpOnly`, `SameSite=Lax` i `Secure` poza lokalnym runem, a widok zalogowanego
dostaje `Cache-Control: private, no-store`.

**Sekrety w URL-u przestały być jedyną drogą.** Link operatorski był wieczny i
siedział w ścieżce, co audyt wytknął. Teraz wejściem jest adres i kod, sesja
żyje w ciasteczku, a linki wysłane wcześniej działają dokładnie raz i wymieniają
się na sesję. Wymiana wymaga naciśnięcia przycisku, bo skanery poczty pobierają
każdy URL z wiadomości i jednorazowy link, który skaner potrafi spalić, to link,
który nigdy nie działa.

**Kody są atomowe.** Pierwsza wersja czytała, sprawdzała i kasowała w trzech
zapisach: równoległe próby widziały ten sam licznik i przechodziły obok limitu
pięciu, a dwa poprawne zgłoszenia jednorazowego kodu potrafiły oba się udać.
Próba jest teraz wydawana w tym samym zapisie, który czyta kod, a kod zużywa
kasowanie, więc z wyścigu wychodzi dokładnie jedna sesja. Ta sama poprawka
poszła w claim projektu. Wygaśnięcie sprawdza odczyt, a nie indeks TTL, który
sprząta wtedy, kiedy sam uzna.

**Limity rozdzielone.** Proszenie o kod i wpisywanie kodu miały wspólny kubełek
pięciu na godzinę, więc jedno logowanie kosztowało dwa sloty, a biuro za jednym
adresem zamykało się samo. Wpisywanie kodu ma własny limit; sufitem zgadywania
pozostaje pięć prób na kod.

**Prywatność projektu.** `visibility: owner` zamyka link do odczytu dla
wszystkich poza właścicielem, łącznie z kimś, kto skopiował link, gdy projekt
był otwarty. Odmowa to 404 identyczne z tym dla złego linku. Zapisy przez link
zamykają się razem z odczytem.

## Co zostaje na potem

- **Limity są w pamięci procesu.** Przy jednym dynie to jest poprawne. Drugi
  dyno oznacza dwa niezależne liczniki, czyli podwojony limit; wtedy Redis albo
  licznik w Mongo.
- **Sekrety w URL-u to świadomy wybór.** Link do odczytu jest tym, co agent
  wręcza człowiekowi, i ma działać bez logowania. Docelowo warto wymieniać go
  raz na ciasteczko `HttpOnly` i przekierowywać na ścieżkę bez tokenu; rotacja
  z punktu 4 jest tańszym pierwszym krokiem i już jest.
- **Klucz Resend jest wspólny z inną aplikacją.** Osobny klucz na projekt
  ogranicza szkodę, gdy jeden wycieknie.
- **`0.0.0.0/0` na liście dostępu Atlas**, bo dyno Heroku nie ma stałego adresu
  wyjściowego. Użytkownik bazy jest ograniczony do jednej bazy i ma 40-znakowe
  hasło. Docelowo: prywatny endpoint albo statyczne IP.
