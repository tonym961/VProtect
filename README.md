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

- Node.js 18+ (consigliato 20 LTS)
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
  "passwordApp": "…",
  "avvioFullScreen": false,
  "autoReboot": true,
  "oraReboot": "03:00",
  "logoutOnExit": true,
  "logoutOnStart": true,
  "viste": {
    "0": { "url": "https://…", "nome": "Registrazioni", "attiva": true },
    "1": { "url": "https://…", "nome": "Vista 1", "attiva": true }
  }
}
```

## Note tecniche note

- `--ignore-certificate-errors` è applicato a tutto il processo per accettare i certificati
  self-signed dei controller UniFi. Va ristretto al solo host configurato (vedi roadmap).
- La password del programma è salvata in chiaro nel JSON.
- `oraReboot` / `autoReboot` sono salvati e mostrati nella UI ma **non** schedulano ancora nulla.
- `wallpaper.html`, `wallpaper.png` e `icona1.ico` non sono referenziati da `main.js`.

Questi punti sono tracciati nella roadmap di miglioramento.

## Licenza

Software proprietario — Iotatau.
