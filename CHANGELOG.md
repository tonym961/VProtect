# Changelog

## 1.9.0 — Electron 44, cambio monitor, aggiornamento dall'app

**Electron 28.3.3 → 44.3.0** (Chromium 120 → 144)

La 28 era del 2024: due anni di patch di sicurezza Chromium mancanti, su un'app il cui lavoro è
decodificare flussi video. La 44 è la major `latest` e resta supportata più a lungo.
Cambiamenti necessari trovati **dai test**, non a mano:

- `webContents.on('console-message')` passa ora un oggetto evento; la forma posizionale è
  deprecata. Aggiornato in `test/smoke.js`.
- Rimosso l'attributo `autofocus` da `password.html`: Chromium 144 logga *"Autofocus processing
  was blocked because a document already has a focused element"*. Il focus lo mette `password.js`.
- Verificato sul campo: avvio completo, migrazione password, recupero da host irraggiungibile e
  nessuna deprecazione su stderr (`npm run test:avvio`).

**Cambio di uscita video (DisplayPort ↔ HDMI)**

Passando da un'uscita all'altra la finestra restava dimensionata sul monitor precedente e la
griglia di Protect non si riadattava, con sfarfallio durante il passaggio.

- Nuovo `riallineaAlDisplay()`: ascolta `display-added`, `display-removed` e
  `display-metrics-changed`, aspetta 2 secondi che la raffica di eventi si assesti, riporta la
  finestra sul monitor corrente, rifà il fullscreen e **ricarica la vista** — quest'ultimo è il
  passo che fa ricalcolare la griglia, perché Protect la dimensiona al caricamento.
- Opzione *"Riadatta la finestra quando cambia l'uscita video"*, attiva di default.
- Via di fuga: *"Accelerazione hardware"* disattivabile dalle impostazioni. Se lo sfarfallio
  resta anche dopo il riadattamento, la decodifica passa alla CPU e il compositore video non
  viene più reinizializzato. Ha effetto al riavvio del programma.
- Ogni cambio di display finisce in `monitor.log` con risoluzione e fattore di scala, così se il
  problema persiste si vede cosa è successo.

**Aggiornamento manuale dalle impostazioni**

- Nuovo riquadro *Aggiornamenti*: `🔍 Controlla aggiornamenti` interroga le release di
  `tonym961/VProtect`, confronta con la versione installata e, se c'è di nuovo,
  `⬇️ Scarica e installa` scarica l'installer con barra di avanzamento e lo lancia.
- Nessuna dipendenza runtime aggiunta (solo il modulo `https` di Node) e **nessun controllo
  automatico in background**: parte solo da un click.
- Il download accetta solo HTTPS e solo gli host delle release GitHub, segue al massimo 5
  redirect, verifica che il file scaricato inizi con `MZ` (è un eseguibile, non una pagina di
  errore salvata) e chiede conferma esplicita prima di lanciarlo.

**Test**

27 asserzioni sulle finestre di servizio + 8 controlli sull'avvio reale del main process.

## 1.8.0 — refactor di sicurezza

Secondo blocco della [ROADMAP.md](ROADMAP.md). Cambia la struttura, non l'aspetto: le finestre
sono le stesse di prima, ma non girano più con Node in mano al contenuto.

**Le finestre di servizio non hanno più Node**

- `password.html` e `settings.html` sono file veri, caricati con `loadFile`, con
  `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true` e una CSP
  `default-src 'none'`. Prima erano stringhe HTML costruite in `main.js` e caricate come
  `data:text/html` con Node integrato.
- Tutto passa da [preload.js](preload.js): il renderer vede solo `window.api` con 9 metodi e
  nient'altro. I canali IPC accettano messaggi **solo** da queste due finestre
  (`mittenteAutorizzato`); la finestra che carica il controller non ha preload, quindi non ha
  alcun ponte verso il main process.
- Le righe delle viste sono costruite con le API del DOM, non concatenando HTML: un nome vista
  è un valore, non markup. L'escaping della 1.7.1 resta come seconda linea, ma la classe di
  difetto non esiste più per costruzione.

**Password**

- Non è più salvata in chiaro: `scrypt` con salt casuale a 16 byte, confronto in tempo costante.
- Migrazione automatica al primo avvio: il vecchio campo `passwordApp` viene convertito e
  rimosso dal file. Nessuna azione richiesta, la password resta quella che era.

**Certificati**

- ⚠️ **Rimosso `--ignore-certificate-errors`**, che disattivava la verifica TLS per l'intero
  processo — qualunque host, non solo il controller. Al suo posto `setCertificateVerifyProc`
  sulla sessione UniFi: i certificati self-signed sono accettati **solo** dagli host elencati
  nelle viste configurate. Ogni rifiuto finisce in `monitor.log` con host e motivo.
- Se il controller risponde su un indirizzo diverso da quelli configurati (redirect, reverse
  proxy) c'è la casella *"Accetta certificati non validi da qualsiasi indirizzo"* nelle
  impostazioni, che ripristina il comportamento permissivo. **Da verificare in campo**: è il
  cambiamento con più probabilità di comportarsi diversamente dal previsto.

**Test**

- `npm test` carica davvero le due pagine in finestre nascoste e verifica 21 asserzioni:
  preload esposto, Node irraggiungibile, CSP che non blocca gli script, 10 righe renderizzate,
  un nome vista ostile che resta testo, URL `javascript:` rifiutato. Girano in CI prima del
  packaging, insieme a `node --check` su tutti i sorgenti.

## 1.7.1 — correzione bug

Batch di fix dalla [ROADMAP.md](ROADMAP.md), sezione "quick wins".

**Sicurezza**

- `esc()` applicato a ogni valore di configurazione interpolato nelle pagine impostazioni e password.
  Nome e URL delle viste finivano dentro un `data:text/html` caricato con `nodeIntegration: true`:
  un apice nel nome bastava a chiudere l'attributo. Il vettore reale era il Restore di un file di
  backup preparato ad arte → esecuzione di codice con Node completo.
- `import-config` valida il file prima di accettarlo: URL solo `http`/`https` via `new URL()`,
  nomi con lunghezza massima, struttura verificata.
- `Menu.setApplicationMenu(null)`: niente menu di default, niente acceleratore per i DevTools.
  Al suo posto una voce `🔄 Ricarica` nel menu contestuale.
- Permessi negati sulla sessione UniFi (microfono, webcam, posizione, notifiche); resta solo il
  fullscreen. Popup e nuove finestre bloccati con `setWindowOpenHandler`.

**Dati**

- Scrittura della configurazione atomica: tmp → `fsync` → `rename`. Prima un blackout a metà
  scrittura produceva un JSON troncato.
- Un file di configurazione illeggibile viene messo in quarantena
  (`viste_config.json.corrupt-<timestamp>`) e segnalato con un dialog all'avvio. Prima il `catch`
  vuoto riportava in silenzio le viste al cloud UniFi **e la password del programma al default di
  fabbrica**.
- Il dialog "Salvato!" ora compare solo se il salvataggio è davvero riuscito; se il cambio password
  non si scrive, la password in memoria viene ripristinata.

**Affidabilità 24/7**

- `did-fail-load` → mostra `wallpaper.html` e riprova con backoff 5s → 60s finché il controller non
  torna raggiungibile, invece della pagina di errore di Chromium.
- `render-process-gone` → ricarica automatica della vista corrente dopo 2s.
- Lock di istanza singola: due processi non possono più sovrascriversi `viste_config.json`.
- `powerSaveBlocker` (`impedisciStandby`, default on): lo schermo della parete non va in standby.
- Log su `%APPDATA%\unifi-protect-monitor\monitor.log`, con rotazione a 1 MB. Senza, i recuperi
  automatici avvenivano in silenzio.

**Comportamento**

- **`oraReboot` adesso fa qualcosa.** Ticker da 60s con guardia anti-ripetizione che ricarica la
  vista corrente all'orario impostato. Nuova checkbox `autoReboot`, **default off**: sugli impianti
  già in campo non deve comparire un evento notturno non richiesto — va attivata a mano.
- Le scorciatoie `Ctrl+n` vengono registrate solo per le viste attive, e rieseguite dopo ogni
  salvataggio. Prima un `Ctrl+7` accidentale su installazione fresca buttava la parete sulla pagina
  di login del cloud UniFi. Un `Ctrl+n` sulla vista già attiva non forza più un reload.
- Splash con latch idempotente e guardie `isDestroyed()`: chiudere l'app entro i primi 2 secondi
  faceva lanciare il main process. La finestra si rivela su `ready-to-show` (timeout di sicurezza a
  20s) e nasce con sfondo `#1c2b39` invece del flash bianco.
- La finestra impostazioni si adatta alla work area del monitor in uso e il corpo scorre: su pannelli
  1366×768 i pulsanti in fondo erano irraggiungibili.
- Impostazioni e prompt password non si impilano più a ogni F10, e il prompt accetta Invio ed Esc.

## 1.7.0 — logout della sessione UniFi

- **Logout alla chiusura** (`logoutOnExit`, attivo di default): prima di uscire l'app chiama
  `POST /api/auth/logout` sul controller e poi azzera la partizione `persist:unifi`
  (cookie, localStorage, IndexedDB, service worker, cache, credenziali HTTP/TLS).
- **Login richiesto all'avvio** (`logoutOnStart`, attivo di default): la sessione viene ripulita anche
  in apertura, prima del primo `loadURL`. Copre i casi in cui la chiusura ordinata non avviene
  (crash, blackout, kill del processo).
- **`🔓 Disconnetti account`** nel menu contestuale e pulsante equivalente nelle impostazioni.
- Nuova sezione "Sessione UniFi" nella finestra di configurazione con i due interruttori.
- La configurazione (IP/URL delle viste, nomi, password del programma) non viene toccata dal logout:
  vive in `viste_config.json`, fuori dalla partizione di sessione.

Correzioni minori incluse:

- Chiusura ordinata con guardia anti-rientro (`close` → `beginShutdown` → `app.quit`), con timeout su
  ogni fase del logout: l'app non può restare appesa in uscita.
- `loadVista(i)` centralizza il cambio vista e ignora gli indici non configurati — prima
  `Ctrl+<n>` su una vista mancante lanciava un'eccezione.
- Le viste mancanti in una `viste_config.json` vecchia o parziale vengono completate dai default:
  prima `Object.assign` superficiale poteva lasciare `config.viste[i] === undefined` e far esplodere
  la finestra impostazioni.
- `clear-cache` non assume più che la finestra esista e usa la stessa sessione del resto dell'app.
- Aggiunto `window-all-closed`.

## 1.6.4 — versione ricostruita

Stato di partenza, estratto da `UniFi_Monitor_1.6.4.exe` (build del 2026-02-03, Electron 28.3.3).
Sorgenti originali conservati in `_original_1.6.4/`.
