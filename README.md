# VProtect — UniFi Protect Monitor

Client kiosk Electron per UniFi Protect. Apre l'interfaccia web del controller a tutto schermo e
permette di passare fra 10 "viste" configurabili (URL diversi dello stesso controller o di controller
diversi) con `Ctrl+0..9` o dal menu contestuale, il tutto dietro una password di accesso alle impostazioni.

Autore originale: **Iotatau** — versione ricostruita e mantenuta in questo repository.

---

## Origine di questo repository

Il codice qui dentro è stato **ricostruito dall'installer** `UniFi_Monitor_1.6.4.exe`
(NSIS → `app-64.7z` → `resources/app.asar`). I sorgenti estratti sono byte-identici a quelli
impacchettati nella release 1.6.4 e sono conservati intatti in [`_original_1.6.4/`](_original_1.6.4)
come riferimento.

Quello che **non** era contenuto nell'asar e quindi è stato ricostruito per inferenza:

| Elemento | Come è stato determinato |
| --- | --- |
| `devDependencies` → `electron 28.3.3` | stringhe `Chrome/120.0.6099.291 Electron/28.3.3` e `node.js/v18.18.2` dentro `unifi-protect-monitor.exe` |
| `electron-builder` + target NSIS | `$PLUGINSDIR` con `nsis7z.dll` / `StdUtils.dll`, `resources/elevate.exe`, layout `app-64.7z` |
| `artifactName: UniFi_Monitor_${version}.${ext}` | nome del file dell'installer |
| `copyright` / `author` | version info del PE: `CompanyName=Iotatau`, `Copyright © 2026 Iotatau` |
| `files` | elenco esatto delle 8 voci nell'header dell'asar |
| `appId`, `oneClick`, `perMachine`, shortcut | **non ricavabili** dall'installer compilato: sono valori plausibili, da correggere se si ha la `package.json` originale |

Data di build della 1.6.4: **2026-02-03**.

## Requisiti

- Node.js 22+ (la CI usa la 22)
- Windows x64 per il target NSIS

```bash
npm install
npm start        # avvia in sviluppo
npm run dist     # genera dist/UniFi_Monitor_<versione>.exe
```

## Uso

| Comando | Azione |
| --- | --- |
| `Ctrl+1` … `Ctrl+9` | carica la vista corrispondente |
| `Ctrl+0` | carica la vista "Registrazioni" |
| `F10` | apre le impostazioni (chiede la password) |
| Click destro | menu con viste attive, logout, fullscreen, chiudi |

Le impostazioni permettono di configurare nome/URL/attivazione delle 10 viste, l'avvio in fullscreen,
l'orario di refresh, backup/restore della configurazione, svuotamento cache e cambio password.

## Sessione UniFi e logout (dalla 1.7.0)

La sessione del controller vive in una partizione Electron dedicata (`persist:unifi`), **separata**
dal file di configurazione. Due opzioni nelle impostazioni:

- **Disconnetti l'account alla chiusura** — alla chiusura chiama `POST /api/auth/logout` sul controller
  e poi cancella cookie, localStorage, IndexedDB, service worker, cache HTTP e credenziali salvate.
- **Richiedi sempre le credenziali all'avvio** — ripulisce la sessione anche in apertura, così il login
  viene richiesto anche se il PC è stato spento di colpo e la chiusura ordinata non è mai avvenuta.

C'è anche un `🔓 Disconnetti account` nel menu contestuale e un pulsante nelle impostazioni.

> **Gli indirizzi IP non si perdono.** Il logout tocca solo la partizione di sessione. Nomi, URL/IP
> delle viste, password del programma e tutte le altre preferenze stanno in
> `%APPDATA%\unifi-protect-monitor\viste_config.json`, che non viene mai toccato.

## Configurazione

File: `%APPDATA%\unifi-protect-monitor\viste_config.json`

```json
{
  "passwordHash": "…64 caratteri esadecimali…",
  "passwordSalt": "…32 caratteri esadecimali…",
  "avvioFullScreen": false,
  "autoReboot": false,
  "oraReboot": "03:00",
  "impedisciStandby": true,
  "logoutOnExit": true,
  "logoutOnStart": true,
  "accettaTuttiICertificati": false,
  "riallineaSuCambioDisplay": true,
  "accelerazioneHardware": true,
  "repoAggiornamenti": "tonym961/VProtect",
  "viste": {
    "0": { "url": "https://…", "nome": "Registrazioni", "attiva": true },
    "1": { "url": "https://…", "nome": "Vista 1", "attiva": true }
  }
}
```

Il file viene scritto in modo atomico (tmp → `fsync` → `rename`). Se risulta illeggibile all'avvio
viene rinominato in `viste_config.json.corrupt-<timestamp>` e segnalato con un dialog, invece di
essere sovrascritto in silenzio con i valori di fabbrica.

`passwordApp` era il campo in chiaro fino alla 1.7.x: viene convertito in `passwordHash` +
`passwordSalt` al primo avvio della 1.8.0 e rimosso dal file.

## Note tecniche

- I certificati self-signed sono accettati **solo** dagli host elencati nelle viste. Ogni rifiuto
  finisce in `monitor.log`. La casella *"Accetta certificati non validi da qualsiasi indirizzo"*
  ripristina il comportamento permissivo dove serve (redirect, reverse proxy).
- Le finestre di servizio (password, impostazioni) girano con `nodeIntegration: false`,
  `contextIsolation: true`, `sandbox: true` e CSP `default-src 'none'`. La finestra che carica il
  controller non ha preload, quindi non ha alcun canale verso il main process.
- Log in `%APPDATA%\unifi-protect-monitor\monitor.log`, rotazione a 1 MB.
- `icona1.ico` non è referenziato dal codice: resta impacchettato come asset storico.
  `wallpaper.html` / `wallpaper.png` sono la schermata mostrata quando il controller è irraggiungibile.

## Test

```bash
npm test           # 27 asserzioni sulle finestre di servizio, in finestre nascoste
npm run test:avvio # avvia il main process in una userData temporanea e ne verifica il log
```

Girano entrambi in CI prima del packaging, insieme a `node --check` su tutti i sorgenti.


## Versionamento

**Solo patch.** Dopo la 1.9.0 viene la 1.9.1, poi la 1.9.2, e così via — anche quando la release
introduce funzionalità nuove. Il numero identifica una build consegnata, non la semantica del
cambiamento. Non far scattare il minor senza chiederlo.

Le release 1.8.0 e 1.9.0 sono uno strascico storico: avrebbero dovuto essere 1.7.2 e 1.7.3, ma erano
già pubblicate con i loro installer quando ce ne siamo accorti.

## Build automatica

Il workflow [.github/workflows/build.yml](.github/workflows/build.yml) compila l'installer NSIS su un
runner Windows di GitHub, quindi non serve avere Node.js sul PC locale.

- **Release**: `git tag v1.9.0 && git push origin v1.9.0` → compila e allega `UniFi_Monitor_1.9.0.exe`
  alla release del tag.
- **Prova**: Actions → "Build installer" → *Run workflow* → l'exe resta come artifact per 90 giorni.

## Aggiornamento

Dalle impostazioni, riquadro *Aggiornamenti*: **Controlla aggiornamenti** interroga le release di
questo repository e, se ce n'è una più recente, **Scarica e installa** scarica l'installer con barra
di avanzamento e lo lancia. Non serve passare dal browser.

Nessun controllo automatico in background: parte solo da un click. Il download accetta solo HTTPS
verso gli host delle release GitHub, verifica che il file sia davvero un eseguibile e chiede conferma
prima di lanciarlo (Windows chiederà i permessi di amministratore).

## Cambio di monitor

Passando da DisplayPort a HDMI (o viceversa) il programma aspetta 2 secondi che la raffica di eventi
si assesti, riporta la finestra sul monitor corrente e **ricarica la vista** — quest'ultimo passo
serve perché l'interfaccia di Protect calcola la griglia delle camere al caricamento e non si
riadatta da sola.

Se lo sfarfallio persiste, nelle impostazioni si può togliere l'accelerazione hardware (effetto al
riavvio del programma). Ogni cambio di display finisce in `monitor.log` con risoluzione e fattore di
scala.

## Roadmap

Vedi [ROADMAP.md](ROADMAP.md): analisi comparata con `digital195/unifi-protect-viewer` e audit di
`main.js`. 139 proposte generate, 67 confermate da doppia verifica avversariale.

## Licenza

Software proprietario — Iotatau.
