# Changelog

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
