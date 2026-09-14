# Changelog

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
