const { app, BrowserWindow, globalShortcut, dialog, Menu, ipcMain, session, screen, powerSaveBlocker, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const { spawn } = require('child_process');

// Una sola istanza: due processi che scrivono viste_config.json si sovrascrivono a vicenda.
if (!app.requestSingleInstanceLock()) { app.exit(0); }

// --- OTTIMIZZAZIONE CODEC MISTI ---
// Questi switch vengono dalla 1.x e restano invariati: non c'e' modo di riprodurre il sintomo
// per cui erano stati aggiunti, quindi non si toccano.
// NOTA: 'ignore-certificate-errors' e' stato rimosso nella 1.8.0 — disattivava la verifica dei
// certificati per l'intero processo. Ora la deroga vale solo per gli host configurati, vedi
// configuraVerificaCertificati().
app.commandLine.appendSwitch('disable-http-cache');
app.commandLine.appendSwitch('enable-accelerated-video-decode');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('disable-features', 'HevcAdapter,HardwareMediaKeyHandling');

let win;
let splash;
let promptWin;
let settingsWin;
let callbackPassword = null;
let vistaAttiva = 1;
let shuttingDown = false;
let revealed = false;
let retryTimer = null;
let retryDelay = 0;
let caricamentoFallito = false;
let watchdogTimer = null;
let eraSuLogin = false;
let downloadInCorso = false;
let rotazioneAvvioFatta = false;
let rebootTicker = null;
let ultimoRefresh = '';
let blockerId = -1;
let configCorrotta = null;

const userDataPath = app.getPath('userData');
const configPath = path.join(userDataPath, 'viste_config.json');
const logPath = path.join(userDataPath, 'monitor.log');
const iconPath = path.join(__dirname, 'icona.ico');
const preloadPath = path.join(__dirname, 'preload.js');

// Partizione dedicata a UniFi Protect: qui vivono SOLO cookie, token e cache del controller.
// La configurazione (IP/URL delle viste, nomi, password del programma) sta in viste_config.json,
// che e' un file separato e NON viene mai toccato dal logout.
const UNIFI_PARTITION = 'persist:unifi';

// Password di fabbrica delle installazioni storiche: resta il valore iniziale di un impianto
// nuovo, ma non viene piu' salvata in chiaro (vedi assicuraPasswordHash).
const PASSWORD_DEFAULT = 'Uat07Iot';

// User Agent che simula un browser compatibile H.264
const CHROME_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36";

// --- LOG ---
// Senza questo, i recuperi automatici (retry, riavvio del renderer, certificati rifiutati,
// config in quarantena) avvengono in silenzio e un intervento in loco non ha nulla da leggere.
const ARCHIVI_LOG = 5;

// Shift dal piu' alto al piu' basso: partendo dal basso si sovrascriverebbe .2 con .1 prima di
// averlo spostato, perdendo un'esecuzione.
function ruotaArchivi() {
  try {
    for (let i = ARCHIVI_LOG - 1; i >= 1; i--) {
      const da = logPath + '.' + i;
      if (fs.existsSync(da)) fs.renameSync(da, logPath + '.' + (i + 1));
    }
    if (fs.existsSync(logPath)) fs.renameSync(logPath, logPath + '.1');
  } catch (e) {}
}

function log(msg) {
  const riga = '[' + new Date().toISOString() + '] ' + msg + '\n';
  try {
    // Ruota a ogni avvio: su una parete accesa da mesi la sequenza che interessa e' l'ultima
    // partenza, e con un solo archivio finiva sepolta sotto un mega di righe.
    if (!rotazioneAvvioFatta) { rotazioneAvvioFatta = true; ruotaArchivi(); }
    // La soglia resta come rete per le sessioni che non si riavviano mai.
    else if (fs.existsSync(logPath) && fs.statSync(logPath).size > 1048576) ruotaArchivi();
    fs.appendFileSync(logPath, riga);
  } catch (e) {}
}

// --- CONFIG ---
const defaultConfig = {
  passwordHash: null,
  passwordSalt: null,
  avvioFullScreen: false,
  autoReboot: false,    // default off: sugli impianti gia' in campo non deve comparire un evento notturno
  oraReboot: '03:00',
  impedisciStandby: true,
  logoutOnExit: true,   // alla chiusura disconnette l'account UniFi
  logoutOnStart: true,  // all'avvio ripulisce comunque la sessione (copre crash e mancanza di corrente)
  accettaTuttiICertificati: false,
  riallineaSuCambioDisplay: true,
  accelerazioneHardware: true,
  repoAggiornamenti: 'tonym961/VProtect',
  viste: {}
};

for (let i = 0; i <= 9; i++) {
  defaultConfig.viste[i] = { url: 'https://unifi.ui.com/', nome: i === 0 ? 'Registrazioni' : `Vista ${i}`, attiva: i === 0 || i <= 5 };
}

let config = JSON.parse(JSON.stringify(defaultConfig));

if (fs.existsSync(configPath)) {
  try {
    config = Object.assign({}, defaultConfig, JSON.parse(fs.readFileSync(configPath, 'utf8')));
    log('config caricata da ' + configPath);
  } catch (e) {
    // Un file troncato da un blackout riporterebbe in silenzio le viste al cloud UniFi
    // e la password del programma al default di fabbrica. Lo mettiamo da parte e lo diciamo.
    const quarantena = configPath + '.corrupt-' + Date.now();
    try { fs.renameSync(configPath, quarantena); configCorrotta = quarantena; } catch (e2) { configCorrotta = configPath; }
    log('CONFIG ILLEGGIBILE (' + e.message + '), messa da parte in ' + configCorrotta);
  }
}
// Config di versioni precedenti possono avere viste mancanti: completa i buchi.
for (let i = 0; i <= 9; i++) { if (!config.viste[i]) config.viste[i] = defaultConfig.viste[i]; }

// Via di fuga per il flicker: va deciso prima che l'app sia pronta, quindi sta qui e non
// nelle impostazioni a caldo (richiede un riavvio del programma per avere effetto).
if (!config.accelerazioneHardware) {
  app.disableHardwareAcceleration();
  log('accelerazione hardware disattivata da configurazione');
}

// Scrittura atomica: tmp + fsync + rename. Il rename su NTFS e' atomico, quindi un blackout
// a meta' scrittura lascia il file vecchio intatto invece di produrne uno troncato.
function saveConfig() {
  const tmp = configPath + '.tmp';
  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, JSON.stringify(config, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, configPath);
    return true;
  } catch (e) {
    log('rename fallito (' + e.message + '), riprovo con scrittura diretta');
    // Antivirus e backup su Windows possono tenere un handle e far fallire il rename con EPERM.
    try { fs.writeFileSync(configPath, JSON.stringify(config, null, 2)); return true; }
    catch (e2) { log('SALVATAGGIO CONFIG FALLITO: ' + e2.message); return false; }
  }
}

// --- PASSWORD DEL PROGRAMMA ---
function calcolaHash(pw, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  const chiave = crypto.scryptSync(String(pw), salt, 32);
  return { salt: salt.toString('hex'), hash: chiave.toString('hex') };
}

// Fino alla 1.7.x la password stava in chiaro in viste_config.json, sotto 'passwordApp'.
// Alla prima esecuzione viene convertita in scrypt e il campo in chiaro sparisce dal file.
function assicuraPasswordHash() {
  if (config.passwordHash && config.passwordSalt) {
    if (config.passwordApp !== undefined) { delete config.passwordApp; saveConfig(); }
    return;
  }
  const sorgente = (typeof config.passwordApp === 'string' && config.passwordApp) ? config.passwordApp : PASSWORD_DEFAULT;
  const h = calcolaHash(sorgente);
  config.passwordHash = h.hash;
  config.passwordSalt = h.salt;
  delete config.passwordApp;
  saveConfig();
  log('password del programma convertita in hash scrypt');
}

function passwordCorretta(tentativo) {
  if (!config.passwordHash || !config.passwordSalt) return false;
  const h = calcolaHash(tentativo, config.passwordSalt);
  const a = Buffer.from(h.hash, 'hex');
  const b = Buffer.from(config.passwordHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function urlValido(u) {
  try {
    const parsed = new URL(String(u));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (e) { return false; }
}

function hostConfigurati() {
  const host = new Set();
  for (let i = 0; i <= 9; i++) {
    const v = config.viste[i];
    if (!v || !v.url) continue;
    try { host.add(new URL(v.url).hostname.toLowerCase()); } catch (e) {}
  }
  return host;
}

// I controller UniFi rispondono con certificati self-signed. Fino alla 1.7.x il programma
// passava --ignore-certificate-errors, che spegne la verifica per QUALSIASI host: un captive
// portal o un man-in-the-middle sulla rete del cliente passava senza un avviso. Ora la deroga
// vale solo per gli host elencati nelle viste, e ogni rifiuto finisce nel log.
function configuraVerificaCertificati(ses) {
  ses.setCertificateVerifyProc((richiesta, callback) => {
    if (richiesta.errorCode === 0 || richiesta.verificationResult === 'net::OK') return callback(0);
    const host = String(richiesta.hostname || '').toLowerCase();
    if (config.accettaTuttiICertificati) {
      log('certificato non valido accettato in modalita permissiva: ' + host + ' (' + richiesta.verificationResult + ')');
      return callback(0);
    }
    if (hostConfigurati().has(host)) return callback(0);
    log('CERTIFICATO RIFIUTATO per ' + host + ' (' + richiesta.verificationResult + '): host non presente fra le viste configurate');
    // Si restituisce l'errore vero e non -2 (ERR_FAILED generico): altrimenti did-fail-load
    // riceve -2 e la schermata di sfondo non puo' riconoscere un problema di certificato,
    // rendendo muto proprio il guasto piu' probabile dopo la stretta della 1.8.0.
    callback(richiesta.errorCode || -2);
  });
}

// --- SESSIONE UNIFI / LOGOUT ---
function getUnifiSession() { return session.fromPartition(UNIFI_PARTITION); }

function withTimeout(p, ms) {
  return Promise.race([Promise.resolve(p).catch(() => {}), new Promise(r => setTimeout(r, ms))]);
}

// Disconnette l'account UniFi: invalida il token sul controller e cancella cookie/storage/cache
// della sola partizione 'persist:unifi'. viste_config.json (IP, viste, password app) resta intatto.
async function logoutUnifi(opts) {
  const o = opts || {};
  if (o.serverSide && win && !win.isDestroyed()) {
    await withTimeout(win.webContents.executeJavaScript(
      "(async () => { try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }); } catch (e) {} try { localStorage.clear(); sessionStorage.clear(); } catch (e) {} return true; })()",
      true
    ), 3000);
  }
  const ses = getUnifiSession();
  await withTimeout(ses.clearStorageData(), 6000); // cookie, localStorage, IndexedDB, service worker...
  await withTimeout(ses.clearAuthCache(), 3000);   // credenziali HTTP e sessioni TLS
  await withTimeout(ses.clearCache(), 6000);
  log('logout UniFi completato');
}

// Chiusura ordinata: prima il logout, poi l'uscita. Il flag evita rientri (close -> quit -> before-quit).
function beginShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log('chiusura in corso');
  const esci = () => { try { if (win && !win.isDestroyed()) win.destroy(); } catch (e) {} app.quit(); };
  (config.logoutOnExit ? logoutUnifi({ serverSide: true }) : Promise.resolve()).catch(() => {}).then(esci);
}

// --- CARICAMENTO VISTE E RECUPERO ERRORI ---
function annullaRetry() {
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  retryDelay = 0;
}

function annullaWatchdog() {
  if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; }
}

// Un controller che completa l'handshake TCP e poi tace (NVR sotto carico, firewall che fa DROP,
// captive portal) non emette ne' did-fail-load ne' did-finish-load: senza questo la parete resta
// bianca a tempo indefinito. Si disarma su dom-ready, non su did-finish-load: su una griglia con
// molte camere quest'ultimo arriva tardissimo o non arriva affatto.
const ATTESA_CARICAMENTO_MS = 45000;

function armaWatchdog() {
  annullaWatchdog();
  watchdogTimer = setTimeout(() => {
    watchdogTimer = null;
    if (!win || win.isDestroyed()) return;
    log('nessuna risposta dopo ' + (ATTESA_CARICAMENTO_MS / 1000) + 's: interrompo e riprovo');
    try { win.webContents.stop(); } catch (e) {}
    // NIENTE caricamentoFallito qui: quel flag serve a filtrare la pagina d'errore che Chromium
    // committa dopo un did-fail-load, e su questo percorso non esiste (stop() su una navigazione
    // mai committata non emette nulla). Alzarlo faceva uscire in anticipo il did-finish-load del
    // retry RIUSCITO, che quindi non chiamava annullaRetry(): il backoff restava avvelenato a
    // 60s per sempre e il log non diceva mai che la parete era tornata su.
    gestisciErroreCaricamento(-7, 'TIMEOUT');
  }, ATTESA_CARICAMENTO_MS);
}

// Riavvio del programma. Passa dal logout come beginShutdown(): app.exit() salta 'before-quit'
// e lascerebbe la sessione aperta sul controller.
function riavvia() {
  if (shuttingDown) return;
  shuttingDown = true;
  log('riavvio richiesto');
  const riparti = () => { app.relaunch(); app.exit(0); };
  (config.logoutOnExit ? logoutUnifi({ serverSide: true }) : Promise.resolve()).catch(() => {}).then(riparti);
}

function loadVista(i) {
  const v = config.viste[i];
  if (!v || !v.url || !win || win.isDestroyed()) return;
  annullaRetry();
  vistaAttiva = i;
  armaWatchdog();
  win.loadURL(v.url, { userAgent: CHROME_USER_AGENT });
}

// Controller spento, rete giu', switch in riavvio: invece della pagina di errore di Chromium
// si mostra lo sfondo aziendale e si riprova con backoff finche' non torna su.
function gestisciErroreCaricamento(codice, descrizione) {
  if (codice === -3) return; // ABORTED: e' una navigazione annullata, non un guasto
  annullaWatchdog(); // il guasto e' gia' emerso, il watchdog ha finito il suo lavoro
  retryDelay = retryDelay ? Math.min(retryDelay * 2, 60000) : 5000;
  const vistaCorrente = config.viste[vistaAttiva];
  log('caricamento fallito (' + codice + ' ' + descrizione + '), riprovo fra ' + (retryDelay / 1000) + 's');
  if (win && !win.isDestroyed()) {
    // Lo sfondo non e' piu' muto: codice, indirizzo e attesa arrivano alla pagina come query.
    win.loadFile('wallpaper.html', {
      query: {
        errore: codice + ' ' + descrizione,
        url: (vistaCorrente && vistaCorrente.url) || '',
        vista: (vistaCorrente && vistaCorrente.nome) || String(vistaAttiva),
        riprovo: String(retryDelay / 1000)
      }
    }).catch(() => {});
  }
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    const v = config.viste[vistaAttiva];
    if (!v || !v.url || !win || win.isDestroyed()) { log('tentativo annullato: vista o finestra non disponibili'); return; }
    log('nuovo tentativo su ' + v.url);
    armaWatchdog();
    win.loadURL(v.url, { userAgent: CHROME_USER_AGENT });
  }, retryDelay);
}

// --- REFRESH PROGRAMMATO ---
// La UI mostrava "Refresh ore:" fin dalla 1.x ma non esisteva nessun timer dietro.
function armaRefreshProgrammato() {
  if (rebootTicker) { clearInterval(rebootTicker); rebootTicker = null; }
  if (!config.autoReboot) return;
  rebootTicker = setInterval(() => {
    const ora = new Date();
    const hhmm = String(ora.getHours()).padStart(2, '0') + ':' + String(ora.getMinutes()).padStart(2, '0');
    const chiave = ora.toDateString() + ' ' + hhmm;
    if (hhmm === config.oraReboot && chiave !== ultimoRefresh) {
      ultimoRefresh = chiave;
      log('refresh programmato delle ' + hhmm);
      loadVista(vistaAttiva); // la vista corrente, non la 1: la parete non deve cambiare inquadratura
    }
  }, 60000);
}

// --- CAMBIO DI USCITA VIDEO (DisplayPort <-> HDMI) ---
// Passando da un'uscita all'altra Windows emette una raffica di eventi e per qualche istante la
// geometria e' incoerente: e' in quella finestra che si vede lo sfarfallio. Inoltre la finestra
// resta con i bounds del monitor precedente, e soprattutto l'interfaccia di Protect calcola la
// griglia delle camere AL CARICAMENTO: senza un reload resta dimensionata sulla vecchia
// risoluzione anche quando la finestra e' gia' giusta.
let displayTimer = null;

function riallineaAlDisplay(motivo) {
  if (!config.riallineaSuCambioDisplay) return;
  if (!win || win.isDestroyed()) return;
  if (displayTimer) clearTimeout(displayTimer);
  displayTimer = setTimeout(() => {
    displayTimer = null;
    if (!win || win.isDestroyed()) return;
    const target = screen.getDisplayMatching(win.getBounds());
    const eraFullScreen = win.isFullScreen();
    log('display cambiato (' + motivo + '): ' + target.bounds.width + 'x' + target.bounds.height +
        ' @' + target.scaleFactor + 'x, fullscreen=' + eraFullScreen + ' -> riallineo');
    if (eraFullScreen) win.setFullScreen(false);
    const area = target.workArea;
    const attuale = win.getBounds();
    win.setBounds({
      x: area.x, y: area.y,
      width: Math.min(attuale.width, area.width),
      height: Math.min(attuale.height, area.height)
    });
    setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      if (eraFullScreen) win.setFullScreen(true);
      // Il reload e' la parte che fa riadattare davvero la griglia alla nuova risoluzione.
      setTimeout(() => { if (win && !win.isDestroyed()) loadVista(vistaAttiva); }, 600);
    }, 400);
  }, 2000); // attende che la raffica di eventi si assesti
}

function ascoltaCambiDisplay() {
  screen.on('display-added', () => riallineaAlDisplay('monitor aggiunto'));
  screen.on('display-removed', () => riallineaAlDisplay('monitor rimosso'));
  screen.on('display-metrics-changed', (e, display, cambiate) => riallineaAlDisplay('metriche ' + (cambiate || []).join('/')));
}

function aggiornaBloccoStandby() {
  if (config.impedisciStandby) {
    if (blockerId === -1 || !powerSaveBlocker.isStarted(blockerId)) {
      blockerId = powerSaveBlocker.start('prevent-display-sleep');
      log('standby schermo disabilitato');
    }
  } else if (blockerId !== -1 && powerSaveBlocker.isStarted(blockerId)) {
    powerSaveBlocker.stop(blockerId);
    blockerId = -1;
  }
}

// --- IPC ---
// Solo le due finestre di servizio possono parlare con il main process. La finestra che carica
// l'interfaccia del controller non ha preload, quindi non ha alcun canale verso qui.
function mittenteAutorizzato(event) {
  const wc = event.sender;
  if (promptWin && !promptWin.isDestroyed() && wc === promptWin.webContents) return true;
  if (settingsWin && !settingsWin.isDestroyed() && wc === settingsWin.webContents) return true;
  log('messaggio IPC rifiutato da una finestra non autorizzata');
  return false;
}

ipcMain.handle('auth:check', (event, valore) => {
  if (!mittenteAutorizzato(event)) return false;
  if (!passwordCorretta(valore)) { log('password errata'); return false; }
  const callback = callbackPassword;
  callbackPassword = null;
  if (promptWin && !promptWin.isDestroyed()) promptWin.close();
  if (typeof callback === 'function') setImmediate(callback);
  return true;
});

ipcMain.handle('settings:get', (event) => {
  if (!mittenteAutorizzato(event)) return null;
  return {
    viste: config.viste,
    avvioFullScreen: config.avvioFullScreen,
    autoReboot: config.autoReboot,
    oraReboot: config.oraReboot,
    impedisciStandby: config.impedisciStandby,
    logoutOnExit: config.logoutOnExit,
    logoutOnStart: config.logoutOnStart,
    accettaTuttiICertificati: config.accettaTuttiICertificati,
    riallineaSuCambioDisplay: config.riallineaSuCambioDisplay,
    accelerazioneHardware: config.accelerazioneHardware,
    versione: app.getVersion()
  };
});

ipcMain.handle('settings:save', (event, d) => {
  if (!mittenteAutorizzato(event) || !d) return { ok: false, message: 'Richiesta non valida' };
  const viste = {};
  for (let i = 0; i <= 9; i++) {
    const v = (d.viste && d.viste[i]) || config.viste[i] || defaultConfig.viste[i];
    viste[i] = { nome: String(v.nome || '').slice(0, 120), url: String(v.url || ''), attiva: !!v.attiva };
    if (viste[i].attiva && !urlValido(viste[i].url)) return { ok: false, message: 'Indirizzo non valido nella vista ' + i };
  }
  config.viste = viste;
  config.avvioFullScreen = !!d.avvioFullScreen;
  config.impedisciStandby = !!d.impedisciStandby;
  config.autoReboot = !!d.autoReboot;
  config.oraReboot = /^\d{2}:\d{2}$/.test(String(d.oraReboot)) ? d.oraReboot : config.oraReboot;
  config.logoutOnExit = !!d.logoutOnExit;
  config.logoutOnStart = !!d.logoutOnStart;
  config.accettaTuttiICertificati = !!d.accettaTuttiICertificati;
  config.riallineaSuCambioDisplay = !!d.riallineaSuCambioDisplay;
  const accelerazionePrima = config.accelerazioneHardware;
  config.accelerazioneHardware = !!d.accelerazioneHardware;
  const serveRiavvio = accelerazionePrima !== config.accelerazioneHardware;
  const ok = saveConfig();
  armaRefreshProgrammato(); // l'orario nuovo deve valere subito, non dal prossimo avvio
  aggiornaBloccoStandby();
  registraScorciatoie();
  log('configurazione salvata (esito: ' + ok + ')');
  if (!ok) return { ok: false, message: 'SALVATAGGIO FALLITO — le modifiche valgono solo fino alla chiusura.' };
  return { ok: true, message: serveRiavvio ? 'Salvato. L\'accelerazione hardware cambia solo al prossimo avvio del programma.' : 'Salvato.' };
});

ipcMain.handle('settings:change-password', (event, d) => {
  if (!mittenteAutorizzato(event) || !d) return { ok: false, message: 'Richiesta non valida' };
  if (!passwordCorretta(d.oldP)) return { ok: false, message: 'Password attuale errata' };
  if (!d.newP) return { ok: false, message: 'La nuova password non puo\' essere vuota' };
  if (d.newP !== d.confP) return { ok: false, message: 'Le nuove password non coincidono' };
  const vecchioHash = config.passwordHash;
  const vecchioSalt = config.passwordSalt;
  const h = calcolaHash(d.newP);
  config.passwordHash = h.hash;
  config.passwordSalt = h.salt;
  if (!saveConfig()) {
    config.passwordHash = vecchioHash;
    config.passwordSalt = vecchioSalt;
    return { ok: false, message: 'Salvataggio fallito: password NON modificata' };
  }
  log('password del programma aggiornata');
  return { ok: true, message: 'Password aggiornata.' };
});

ipcMain.handle('settings:export', (event) => {
  if (!mittenteAutorizzato(event)) return { ok: false, message: 'Richiesta non valida' };
  const dest = dialog.showSaveDialogSync({ title: 'Esporta', defaultPath: 'unifi_monitor_backup.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (!dest) return { ok: true, message: 'Backup annullato.' };
  try {
    fs.writeFileSync(dest, JSON.stringify(config, null, 2));
    return { ok: true, message: 'Backup salvato in ' + dest };
  } catch (e) {
    return { ok: false, message: 'Impossibile scrivere il backup: ' + e.message };
  }
});

ipcMain.handle('settings:import', (event) => {
  if (!mittenteAutorizzato(event)) return { ok: false, message: 'Richiesta non valida' };
  const files = dialog.showOpenDialogSync({ title: 'Importa', filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (!files) return { ok: true, message: 'Restore annullato.' };
  try {
    const importata = JSON.parse(fs.readFileSync(files[0], 'utf8'));
    // Il file arriva da fuori: si valida prima di accettarlo.
    if (!importata || typeof importata !== 'object' || Array.isArray(importata)) throw new Error('struttura non valida');
    if (importata.viste) {
      for (let i = 0; i <= 9; i++) {
        const v = importata.viste[i];
        if (!v) continue;
        if (!urlValido(v.url)) throw new Error('URL non valido nella vista ' + i);
        if (String(v.nome || '').length > 120) throw new Error('nome troppo lungo nella vista ' + i);
      }
    }
    config = Object.assign({}, defaultConfig, importata);
    for (let i = 0; i <= 9; i++) { if (!config.viste[i]) config.viste[i] = defaultConfig.viste[i]; }
    if (!saveConfig()) throw new Error('salvataggio fallito');
    log('config importata da ' + files[0] + ', riavvio');
    app.relaunch(); app.exit();
    return { ok: true, message: 'Importata, riavvio in corso.' };
  } catch (e) {
    return { ok: false, message: 'File non valido: ' + e.message };
  }
});

ipcMain.handle('settings:clear-cache', async (event) => {
  if (!mittenteAutorizzato(event)) return { ok: false, message: 'Richiesta non valida' };
  await getUnifiSession().clearCache();
  // loadVista e non reload(): reload ricaricherebbe il wallpaper se e' lui a schermo, e sarebbe
  // l'unica navigazione principale senza watchdog, proprio sul percorso che usa il tecnico.
  loadVista(vistaAttiva);
  return { ok: true, message: 'Cache svuotata e pagina ricaricata.' };
});

ipcMain.handle('settings:logout', async (event) => {
  if (!mittenteAutorizzato(event)) return { ok: false, message: 'Richiesta non valida' };
  await logoutUnifi({ serverSide: true });
  loadVista(vistaAttiva);
  return { ok: true, message: 'Account disconnesso: al prossimo caricamento verranno richieste le credenziali.' };
});

// --- AGGIORNAMENTO MANUALE ---
// Scarica l'installer dalla release GitHub e lo lancia. Nessuna dipendenza runtime aggiunta,
// nessun controllo automatico in background: parte solo da un click nelle impostazioni.
const HOST_AGGIORNAMENTI = ['api.github.com', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'];
let aggiornamentoPronto = null;

function richiestaHttps(url, redirezioniRimaste) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('URL non valido')); }
    // Solo HTTPS e solo verso gli host delle release: una config manomessa non puo' far
    // scaricare un eseguibile da un posto qualsiasi.
    if (u.protocol !== 'https:') return reject(new Error('solo HTTPS, ricevuto ' + u.protocol));
    if (HOST_AGGIORNAMENTI.indexOf(u.hostname) === -1) return reject(new Error('host non consentito: ' + u.hostname));
    const req = https.get(u, { headers: { 'User-Agent': 'UniFi-Protect-Monitor', 'Accept': 'application/vnd.github+json' } }, (res) => {
      if ([301, 302, 303, 307, 308].indexOf(res.statusCode) !== -1) {
        res.resume();
        if (redirezioniRimaste <= 0) return reject(new Error('troppi redirect'));
        return resolve(richiestaHttps(res.headers.location, redirezioniRimaste - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        // Lo stato e gli header servono a spiegaErroreRete: senza, ogni guasto diventa una
        // stringa generica e l'operatore va a cercare il problema dalla parte sbagliata.
        const err = new Error('HTTP ' + res.statusCode);
        err.statusCode = res.statusCode;
        err.headers = res.headers;
        return reject(err);
      }
      resolve(res);
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(Object.assign(new Error('timeout di rete'), { code: 'ETIMEDOUT' })));
  });
}

// Traduce il guasto in una frase che dice dove guardare. La nota sul repository privato resta
// solo sul 404: prima veniva appiccicata a qualunque errore, compreso "manca internet".
function spiegaErroreRete(e) {
  const codice = e && e.code;
  const stato = e && e.statusCode;
  if (codice === 'ENOTFOUND' || codice === 'EAI_AGAIN') return 'nessuna risoluzione DNS per github.com: il PC non ha uscita internet o manca il DNS.';
  if (codice === 'ETIMEDOUT' || codice === 'ECONNRESET' || codice === 'ECONNREFUSED') return 'connessione a github.com non riuscita: probabile firewall o proxy della rete del cliente.';
  if (/CERT|SSL/i.test(String(e && e.message))) return 'certificato di github.com non valido: di solito e\' un proxy che ispeziona il traffico.';
  if (stato === 404) return 'release non trovata: verifica il nome del repository, e ricorda che le release di un repository privato non sono raggiungibili senza autenticazione.';
  if (stato === 403) {
    const restanti = e.headers && e.headers['x-ratelimit-remaining'];
    if (String(restanti) === '0') return 'limite di richieste di GitHub raggiunto: riprova fra un\'ora.';
    return 'accesso negato da GitHub (403).';
  }
  if (stato) return 'GitHub ha risposto ' + stato + '.';
  return String((e && e.message) || e);
}

async function leggiJson(url) {
  const res = await richiestaHttps(url, 5);
  const pezzi = [];
  for await (const p of res) pezzi.push(p);
  return JSON.parse(Buffer.concat(pezzi).toString('utf8'));
}

function confrontaVersioni(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); }
  return 0;
}

ipcMain.handle('update:check', async (event) => {
  if (!mittenteAutorizzato(event)) return { ok: false, message: 'Richiesta non valida' };
  // Un secondo controllo durante un download riscriverebbe aggiornamentoPronto sotto i piedi
  // di update:install, che poi annuncerebbe una versione e ne installerebbe un'altra.
  if (downloadInCorso) return { ok: false, message: 'C\'e\' gia\' un download in corso.' };
  const repo = String(config.repoAggiornamenti || '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { ok: false, message: 'Repository di aggiornamento non valido: ' + repo };
  try {
    const dati = await leggiJson('https://api.github.com/repos/' + repo + '/releases/latest');
    const versione = String(dati.tag_name || '').replace(/^v/, '');
    const asset = (dati.assets || []).filter(a => /\.exe$/i.test(a.name))[0];
    if (!versione) return { ok: false, message: 'La risposta non contiene una versione' };
    if (confrontaVersioni(versione, app.getVersion()) <= 0) {
      aggiornamentoPronto = null;
      return { ok: true, aggiornamento: false, message: 'Gia\' aggiornato: hai la ' + app.getVersion() + ', l\'ultima pubblicata e\' la ' + versione + '.' };
    }
    if (!asset) return { ok: false, message: 'La release ' + versione + ' non contiene un installer .exe' };
    aggiornamentoPronto = {
      versione, url: asset.browser_download_url, nome: asset.name, dimensione: asset.size,
      digest: String(asset.digest || '') // GitHub lo espone come "sha256:<hex>" sulle release recenti
    };
    log('aggiornamento disponibile: ' + versione);
    return { ok: true, aggiornamento: true, versione, dimensione: asset.size, message: 'Disponibile la versione ' + versione + ' (' + Math.round(asset.size / 1048576) + ' MB). Hai la ' + app.getVersion() + '.' };
  } catch (e) {
    log('controllo aggiornamenti fallito: ' + e.message);
    return { ok: false, message: 'Controllo fallito: ' + spiegaErroreRete(e) };
  }
});

ipcMain.handle('update:install', async (event) => {
  if (!mittenteAutorizzato(event)) return { ok: false, message: 'Richiesta non valida' };
  if (downloadInCorso) return { ok: false, message: 'C\'e\' gia\' un download in corso.' };
  // Istantanea: aggiornamentoPronto e' una variabile di modulo e un secondo controllo potrebbe
  // riscriverla mentre scarichiamo. Da qui in poi si usa solo il pacchetto congelato.
  const pacchetto = aggiornamentoPronto;
  if (!pacchetto) return { ok: false, message: 'Nessun aggiornamento pronto: esegui prima il controllo.' };

  const finestra = BrowserWindow.fromWebContents(event.sender);
  const dest = path.join(app.getPath('temp'), pacchetto.nome);
  let annullato = false;
  downloadInCorso = true;
  try {
    const res = await richiestaHttps(pacchetto.url, 5);
    const totale = parseInt(res.headers['content-length'], 10) || pacchetto.dimensione || 0;
    const sha = crypto.createHash('sha256');
    let scaricati = 0;
    let ultimoInvio = 0;
    let istanteMisura = Date.now();
    let byteMisura = 0;
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(dest);
      // Chiudendo le impostazioni a meta' il download continuava in sottofondo e il file
      // incompleto restava in %TEMP% per sempre, perche' su Windows l'unlink di uno stream
      // ancora aperto fallisce con EBUSY.
      const suChiusuraFinestra = () => {
        annullato = true;
        try { res.destroy(); } catch (e) {}
        try { out.destroy(); } catch (e) {}
        reject(new Error('download annullato: finestra chiusa'));
      };
      if (finestra) finestra.once('closed', suChiusuraFinestra);
      const pulisci = () => { if (finestra && !finestra.isDestroyed()) finestra.removeListener('closed', suChiusuraFinestra); };

      res.on('data', (c) => {
        scaricati += c.length;
        sha.update(c);
        const ora = Date.now();
        // Cadenza a 250 ms invece che a ogni punto percentuale: fino a cento invii in meno, e
        // su una linea lenta servono i byte e la velocita', non una percentuale che non si muove.
        if (ora - ultimoInvio >= 250) {
          const bps = (scaricati - byteMisura) * 1000 / Math.max(1, ora - istanteMisura);
          ultimoInvio = ora; istanteMisura = ora; byteMisura = scaricati;
          if (!event.sender.isDestroyed()) {
            event.sender.send('update:progress', { pct: totale ? Math.floor(scaricati * 100 / totale) : 0, scaricati, totale, bps });
          }
        }
      });
      res.on('error', (e) => { pulisci(); reject(e); });
      out.on('error', (e) => { pulisci(); reject(e); });
      out.on('finish', () => { pulisci(); resolve(); });
      res.pipe(out);
    });

    // Un download troncato da un proxy inizia comunque per MZ e supererebbe il controllo sotto:
    // verrebbe installato sopra un'app funzionante, su una macchina che magari e' lontana.
    if (totale && scaricati !== totale) throw new Error('download incompleto: ' + scaricati + ' byte su ' + totale);

    // GitHub pubblica l'impronta solo sulle release recenti: si confronta unicamente se c'e',
    // altrimenti un controllo incondizionato bloccherebbe ogni aggiornamento dalle vecchie.
    const atteso = String(pacchetto.digest || '');
    if (atteso.toLowerCase().indexOf('sha256:') === 0) {
      const calcolato = sha.digest('hex');
      if (calcolato !== atteso.slice(7).toLowerCase()) throw new Error('impronta sha256 non corrispondente');
      log('sha256 dell\'installer verificato');
    }

    // Controllo minimo: deve essere un eseguibile Windows, non una pagina di errore salvata.
    const testa = Buffer.alloc(2);
    const fd = fs.openSync(dest, 'r');
    try { fs.readSync(fd, testa, 0, 2, 0); } finally { fs.closeSync(fd); }
    if (testa.toString('latin1') !== 'MZ') throw new Error('il file scaricato non e\' un eseguibile');

    // showMessageBoxSync senza genitore blocca il loop del main (niente retry, niente ticker del
    // refresh, niente riallineamento display finche' nessuno clicca) e lascia la finestra
    // genitore disabilitata al mouse. La forma asincrona con genitore evita entrambi.
    const opzioni = {
      type: 'question', buttons: ['Installa e chiudi', 'Annulla'], defaultId: 0, cancelId: 1,
      title: 'Aggiornamento', message: 'Installare la versione ' + pacchetto.versione + '?',
      detail: 'Il programma si chiude e parte l\'installer.\nWindows chiedera\' i permessi di amministratore.\n\n' + dest
    };
    const genitore = (finestra && !finestra.isDestroyed()) ? finestra : ((win && !win.isDestroyed()) ? win : null);
    const risposta = genitore ? await dialog.showMessageBox(genitore, opzioni) : await dialog.showMessageBox(opzioni);
    if (risposta.response !== 0) return { ok: true, message: 'Installazione annullata. L\'installer resta in ' + dest };

    log('avvio installer ' + dest);
    const installer = spawn(dest, [], { detached: true, stdio: 'ignore' });
    // Senza un ascoltatore su 'error' un avvio fallito (antivirus che mette in quarantena il file
    // appena scaricato, permessi negati) diventa un'eccezione non gestita nel main process,
    // proprio mentre abbiamo appena detto all'utente che l'aggiornamento sta partendo.
    const erroreAvvio = await new Promise((resolve) => {
      let deciso = false;
      const decidi = (v) => { if (!deciso) { deciso = true; resolve(v); } };
      installer.on('error', decidi);
      installer.on('spawn', () => decidi(null));
      setTimeout(() => decidi(null), 2000);
    });
    if (erroreAvvio) {
      log('avvio installer fallito: ' + erroreAvvio.message);
      return { ok: false, message: 'Impossibile avviare l\'installer: ' + erroreAvvio.message + '. Il file resta in ' + dest };
    }
    installer.unref();
    shuttingDown = true; // l'installer deve poter sostituire i file: si esce senza passare dal logout
    setTimeout(() => app.exit(0), 1000);
    // avviato:true e' l'unico caso in cui la pagina NON deve riabilitare il bottone: stiamo
    // chiudendo. Su ogni altro esito, annullamento compreso, l'interfaccia torna utilizzabile.
    return { ok: true, avviato: true, message: 'Installer avviato, il programma si chiude.' };
  } catch (e) {
    // Qualunque sia il guasto, il file parziale non deve restare in giro: al prossimo giro
    // verrebbe riscaricato sopra, e nel frattempo occupa spazio senza servire a niente.
    try { fs.unlinkSync(dest); } catch (e2) {}
    if (annullato) { log('download annullato dall\'utente'); return { ok: false, message: 'Download annullato.' }; }
    log('aggiornamento fallito: ' + e.message);
    return { ok: false, message: 'Aggiornamento fallito: ' + spiegaErroreRete(e) };
  } finally {
    // Senza il finally un errore di rete bloccherebbe gli aggiornamenti fino al riavvio.
    downloadInCorso = false;
  }
});

// --- DIAGNOSTICA ---
// Su un kiosk il log va cercato a memoria in %APPDATA%, e la casella "accelerazione hardware"
// mostrava il valore scritto in config, non se abbia davvero avuto effetto.
ipcMain.handle('diagnostica:get', (event) => {
  if (!mittenteAutorizzato(event)) return null;
  const v = config.viste[vistaAttiva];
  return {
    accelerazioneAttiva: app.isHardwareAccelerationEnabled(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    logPath,
    configPath,
    vistaAttiva,
    nomeVistaAttiva: (v && v.nome) || String(vistaAttiva),
    riconnessioneInCorso: !!retryTimer
  };
});

ipcMain.handle('diagnostica:apri-log', (event) => {
  if (!mittenteAutorizzato(event)) return { ok: false, message: 'Richiesta non valida' };
  // Volutamente diverso dal riferimento: il percorso non arriva dal renderer, si usa la
  // costante di modulo. showItemInFolder e' piu' affidabile di openPath su un .log senza
  // applicazione associata.
  if (!fs.existsSync(logPath)) return { ok: false, message: 'Il file di log non esiste ancora.' };
  shell.showItemInFolder(logPath);
  return { ok: true, message: 'Cartella del log aperta.' };
});

// Il main process non puo' interrogare MediaSource: la rilevazione dei codec la fa la pagina
// impostazioni e la manda qui solo per finire nel log, cosi' basta il log per capire perche' su
// una certa postazione le telecamere H.265 restano nere.
ipcMain.on('diagnostica:codec', (event, dati) => {
  if (!mittenteAutorizzato(event) || !dati) return;
  log('codec supportati dal PC: H.264=' + !!dati.h264 + ' H.265=' + !!dati.h265 +
      (dati.h265 ? (' (accelerazione: ' + (dati.h265Accelerato ? 'si' : 'no') + ')') : ''));
});

ipcMain.on('window:close', (event) => {
  if (!mittenteAutorizzato(event)) return;
  const finestra = BrowserWindow.fromWebContents(event.sender);
  if (finestra && !finestra.isDestroyed()) finestra.close();
});

// --- FINESTRE DI SERVIZIO ---
const webPreferencesServizio = {
  preload: preloadPath,
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true
};

function checkPassword(callback) {
  if (promptWin && !promptWin.isDestroyed()) { promptWin.focus(); return; }
  callbackPassword = callback;
  promptWin = new BrowserWindow({
    width: 400, height: 320, parent: win, modal: true, frame: false,
    icon: iconPath, resizable: false, webPreferences: webPreferencesServizio
  });
  promptWin.loadFile('password.html');
  promptWin.on('closed', () => { promptWin = null; callbackPassword = null; });
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }
  // Su un pannello 1366x768 la finestra da 850x1050 usciva dallo schermo e i bottoni in fondo
  // erano irraggiungibili. Si stringe alla work area del monitor in uso.
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workAreaSize;
  settingsWin = new BrowserWindow({
    width: Math.min(850, Math.max(700, wa.width - 60)),
    height: Math.min(1050, Math.max(400, wa.height - 60)),
    minWidth: 700, minHeight: 400,
    parent: win, modal: true, title: 'Configurazione', autoHideMenuBar: true, icon: iconPath,
    webPreferences: webPreferencesServizio
  });
  settingsWin.loadFile('settings.html');
  settingsWin.on('closed', () => { settingsWin = null; });
}

// Le viste disattivate non registrano l'hotkey: su installazione fresca le 6-9 puntano al
// cloud UniFi e un Ctrl+7 accidentale buttava la parete sulla pagina di login.
// Rieseguita dopo ogni salvataggio, altrimenti attivare una vista non basterebbe ad attivarne il tasto.
function registraScorciatoie() {
  globalShortcut.unregisterAll();
  [0,1,2,3,4,5,6,7,8,9].forEach(i => {
    const v = config.viste[i];
    if (!v || !v.attiva) return;
    globalShortcut.register(`CommandOrControl+${i}`, () => { if (i !== vistaAttiva) loadVista(i); });
  });
  globalShortcut.register('F10', () => checkPassword(openSettings));
}

// --- FINESTRA PRINCIPALE ---
function revealMainWindow() {
  if (revealed) return;
  revealed = true;
  if (splash && !splash.isDestroyed()) { splash.destroy(); }
  splash = null;
  if (win && !win.isDestroyed()) { win.show(); win.focus(); }
}

async function createWindows() {
  Menu.setApplicationMenu(null); // niente menu di default, niente acceleratore per i DevTools
  assicuraPasswordHash();

  splash = new BrowserWindow({ width: 500, height: 400, frame: false, alwaysOnTop: true, transparent: true, icon: iconPath });
  splash.loadFile('splash.html');

  if (configCorrotta) {
    dialog.showErrorBox('Configurazione ripristinata',
      'Il file di configurazione era illeggibile ed e\' stato messo da parte:\n\n' + configCorrotta +
      '\n\nIl programma sta usando i valori di fabbrica: viste e password vanno riconfigurate.');
  }

  // Sessione ripulita prima del primo caricamento: la pagina di login appare sempre.
  if (config.logoutOnStart) { try { await logoutUnifi({ serverSide: false }); } catch (e) {} }

  const ses = getUnifiSession();
  configuraVerificaCertificati(ses);
  // Una parete video non ha motivo di concedere microfono, webcam, posizione o notifiche.
  ses.setPermissionRequestHandler((wc, permission, callback) => {
    const consentito = permission === 'fullscreen';
    if (!consentito) log('permesso negato: ' + permission);
    callback(consentito);
  });

  win = new BrowserWindow({
    width: 1280, height: 720, title: 'UniFi Protect Monitor', autoHideMenuBar: true, icon: iconPath,
    show: false, backgroundColor: '#000000', fullscreen: config.avvioFullScreen,
    // Nessun preload qui: la pagina del controller non deve avere alcun ponte verso il main process.
    webPreferences: { nodeIntegration: false, contextIsolation: true, partition: UNIFI_PARTITION }
  });

  win.webContents.setWindowOpenHandler(({ url }) => { log('popup bloccato: ' + url); return { action: 'deny' }; });

  // dom-ready arriva appena il documento e' utilizzabile: e' il segnale giusto per dire che il
  // controller ha risposto. did-finish-load aspetta anche le immagini di tutte le camere.
  win.webContents.on('dom-ready', () => { annullaWatchdog(); });

  win.webContents.on('did-fail-load', (e, codice, descrizione, url, isMainFrame) => {
    if (!isMainFrame) return;
    if (codice === -3) return; // ABORTED: navigazione annullata, non un guasto
    annullaWatchdog();
    caricamentoFallito = true;
    gestisciErroreCaricamento(codice, descrizione);
  });

  // Se il controller invalida la sessione risponde 200 con il form di login: nulla fallisce e la
  // parete resta su una maschera per ore senza che il log dica niente. Solo diagnosi, nessun
  // ricaricamento automatico: combatterebbe l'operatore che sta digitando le credenziali.
  win.webContents.on('did-navigate', (e, url) => {
    // Il documento e' stato committato: il controller ha risposto, quindi il budget del watchdog
    // riparte da capo. Senza questo un NVR lento ma vivo (HTML + script pesanti oltre i 45s)
    // veniva ucciso da stop(), e con disable-http-cache il tentativo dopo ripartiva da zero per
    // essere ucciso di nuovo: il backoff si inchiodava a 60s e il ciclo non convergeva mai.
    // Il guasto bersaglio — handshake TCP e poi silenzio — non committa nulla, quindi qui non
    // passa e i 45s scattano come previsto.
    if (!String(url).startsWith('file://')) armaWatchdog();

    const suLogin = /\/login(\?|$)|\/signin/i.test(String(url));
    if (suLogin && !eraSuLogin) log('ATTENZIONE: la vista ' + vistaAttiva + ' e\' finita sulla pagina di login (' + url + ')');
    eraSuLogin = suLogin;
  });

  win.webContents.on('did-finish-load', () => {
    const urlCaricato = win.webContents.getURL();
    // wallpaper.html e' la schermata di cortesia locale, non e' il controller tornato su.
    if (urlCaricato.startsWith('file://')) return;
    // Chromium emette did-finish-load ANCHE per la navigazione fallita, perche' committa la
    // propria pagina di errore, e getURL() resta l'indirizzo http originale. Senza questa
    // guardia il tentativo appena programmato veniva cancellato ~5 ms dopo e il recupero non
    // ripartiva mai: il backoff 5/10/20/40/60s era solo una riga di log (bug dalla 1.7.1).
    if (caricamentoFallito) { caricamentoFallito = false; return; }
    // retryTimer e' gia' null qui (lo azzera il callback del retry prima di caricare):
    // la spia di un recupero in corso e' retryDelay, che resta al valore dell'ultimo backoff.
    if (retryDelay) log('controller di nuovo raggiungibile dopo ' + (retryDelay / 1000) + 's di attesa');
    log('pagina caricata: ' + urlCaricato);
    annullaRetry();
  });
  win.webContents.on('render-process-gone', (e, dettagli) => {
    log('renderer terminato (' + dettagli.reason + '), ricarico');
    setTimeout(() => loadVista(vistaAttiva), 2000);
  });
  win.webContents.on('unresponsive', () => { log('finestra non risponde'); });

  loadVista(1);
  win.once('ready-to-show', revealMainWindow);
  setTimeout(revealMainWindow, 20000); // rete giu' all'avvio: la finestra si mostra comunque

  // Chiudendo la finestra si passa prima dal logout, poi si esce.
  win.on('close', (e) => { if (!shuttingDown && config.logoutOnExit) { e.preventDefault(); beginShutdown(); } });

  win.webContents.on('context-menu', () => {
    // Riga di stato: quale vista e' a schermo e se si sta riconnettendo. La guardia sulla vista
    // serve perche' dopo un salvataggio puo' essere svuotata, e il menu andrebbe in eccezione
    // proprio quando lo si apre per capire cosa non va.
    const attiva = config.viste[vistaAttiva];
    const nomeAttiva = (attiva && attiva.nome) || ('Vista ' + vistaAttiva);
    const menuTemplate = [
      { label: nomeAttiva + (retryTimer ? ' — riconnessione in corso…' : ' — connessa'), enabled: false },
      { type: 'separator' },
      { label: '⚙️ Impostazioni', click: () => checkPassword(openSettings) },
      { type: 'separator' }
    ];
    // registerAccelerator:false e' obbligatorio: senza, Electron registrerebbe gli acceleratori
    // sopra a quelli gia' presi da registraScorciatoie().
    [1,2,3,4,5,6,7,8,9].forEach(i => {
      if (!config.viste[i] || !config.viste[i].attiva) return;
      menuTemplate.push({
        label: `🎥 ${config.viste[i].nome}`, type: 'checkbox', checked: i === vistaAttiva,
        accelerator: `CommandOrControl+${i}`, registerAccelerator: false, click: () => loadVista(i)
      });
    });
    if (config.viste[0] && config.viste[0].attiva) {
      menuTemplate.push({ type: 'separator' }, {
        label: `📂 ${config.viste[0].nome}`, type: 'checkbox', checked: vistaAttiva === 0,
        accelerator: 'CommandOrControl+0', registerAccelerator: false, click: () => loadVista(0)
      });
    }
    menuTemplate.push({ type: 'separator' },
      { label: '🔄 Ricarica', click: () => loadVista(vistaAttiva) },
      { label: '🔓 Disconnetti account', click: async () => { await logoutUnifi({ serverSide: true }); loadVista(vistaAttiva); } },
      { label: '♻️ Riavvia il programma', click: () => checkPassword(riavvia) });
    menuTemplate.push({ type: 'separator' },
      { label: win.isFullScreen() ? '🖥 Esci Full Screen' : '📺 Vai Full Screen', click: () => win.setFullScreen(!win.isFullScreen()) },
      { label: '❌ Chiudi', click: () => app.quit() });
    Menu.buildFromTemplate(menuTemplate).popup();
  });

  registraScorciatoie();
  armaRefreshProgrammato();
  aggiornaBloccoStandby();
  ascoltaCambiDisplay();
  log('avviato, versione ' + app.getVersion());
}

app.on('second-instance', () => {
  if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.focus(); }
});

app.whenReady().then(createWindows);
app.on('before-quit', (e) => { if (!shuttingDown && config.logoutOnExit) { e.preventDefault(); beginShutdown(); } });
app.on('window-all-closed', () => { app.quit(); });
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (rebootTicker) clearInterval(rebootTicker);
  if (displayTimer) { clearTimeout(displayTimer); displayTimer = null; }
  annullaWatchdog();
  annullaRetry();
  if (blockerId !== -1 && powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId);
});
