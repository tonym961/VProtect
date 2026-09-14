const { app, BrowserWindow, globalShortcut, dialog, Menu, ipcMain, session, screen, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');

// Una sola istanza: due processi che scrivono viste_config.json si sovrascrivono a vicenda.
if (!app.requestSingleInstanceLock()) { app.exit(0); }

// --- OTTIMIZZAZIONE CODEC MISTI ---
// Questi switch vengono dalla 1.x e restano invariati: non sono stati toccati perche'
// non c'e' modo di riprodurre il sintomo per cui erano stati aggiunti.
app.commandLine.appendSwitch('ignore-certificate-errors');
app.commandLine.appendSwitch('disable-http-cache');
app.commandLine.appendSwitch('enable-accelerated-video-decode');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('disable-features', 'HevcAdapter,HardwareMediaKeyHandling');

let win;
let splash;
let promptWin;
let settingsWin;
let vistaAttiva = 1;
let shuttingDown = false;
let revealed = false;
let retryTimer = null;
let retryDelay = 0;
let rebootTicker = null;
let ultimoRefresh = '';
let blockerId = -1;
let configCorrotta = null;

const userDataPath = app.getPath('userData');
const configPath = path.join(userDataPath, 'viste_config.json');
const logPath = path.join(userDataPath, 'monitor.log');
const iconPath = path.join(__dirname, 'icona.ico');

// Partizione dedicata a UniFi Protect: qui vivono SOLO cookie, token e cache del controller.
// La configurazione (IP/URL delle viste, nomi, password del programma) sta in viste_config.json,
// che e' un file separato e NON viene mai toccato dal logout.
const UNIFI_PARTITION = 'persist:unifi';

// User Agent che simula un browser compatibile H.264
const CHROME_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36";

// --- LOG ---
// Senza questo, i recuperi automatici (retry, riavvio del renderer, config in quarantena)
// avvengono in silenzio e un intervento in loco non ha nulla da leggere.
function log(msg) {
  const riga = '[' + new Date().toISOString() + '] ' + msg + '\n';
  try {
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > 1048576) {
      fs.renameSync(logPath, logPath + '.1');
    }
    fs.appendFileSync(logPath, riga);
  } catch (e) {}
}

// --- CONFIG ---
const defaultConfig = {
  passwordApp: 'Uat07Iot',
  avvioFullScreen: false,
  autoReboot: false,    // default off: sugli impianti gia' in campo non deve comparire un evento notturno
  oraReboot: '03:00',
  impedisciStandby: true,
  logoutOnExit: true,   // alla chiusura disconnette l'account UniFi
  logoutOnStart: true,  // all'avvio ripulisce comunque la sessione (copre crash e mancanza di corrente)
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

// Ogni valore di config che finisce in una pagina HTML passa da qui. Le pagine impostazioni
// girano con nodeIntegration attivo: un nome vista con un apice chiuderebbe l'attributo e
// aprirebbe la strada a codice arbitrario (vettore: un file di Backup preparato ad arte).
function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function urlValido(u) {
  try {
    const parsed = new URL(String(u));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (e) { return false; }
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

function loadVista(i) {
  const v = config.viste[i];
  if (!v || !v.url || !win || win.isDestroyed()) return;
  annullaRetry();
  vistaAttiva = i;
  win.loadURL(v.url, { userAgent: CHROME_USER_AGENT });
}

// Controller spento, rete giu', switch in riavvio: invece della pagina di errore di Chromium
// si mostra lo sfondo aziendale e si riprova con backoff finche' non torna su.
function gestisciErroreCaricamento(codice, descrizione) {
  if (codice === -3) return; // ABORTED: e' una navigazione annullata, non un guasto
  retryDelay = retryDelay ? Math.min(retryDelay * 2, 60000) : 5000;
  log('caricamento fallito (' + codice + ' ' + descrizione + '), riprovo fra ' + (retryDelay / 1000) + 's');
  if (win && !win.isDestroyed()) { win.loadFile('wallpaper.html').catch(() => {}); }
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    const v = config.viste[vistaAttiva];
    if (v && v.url && win && !win.isDestroyed()) win.loadURL(v.url, { userAgent: CHROME_USER_AGENT });
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

// --- IPC: BACKUP, RESTORE, CACHE, LOGOUT ---
ipcMain.on('export-config', () => {
  const dest = dialog.showSaveDialogSync({ title: 'Esporta', defaultPath: 'unifi_monitor_backup.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (!dest) return;
  try { fs.writeFileSync(dest, JSON.stringify(config, null, 2)); }
  catch (e) { dialog.showErrorBox('Errore', 'Impossibile scrivere il backup:\n' + e.message); }
});

ipcMain.on('import-config', () => {
  const files = dialog.showOpenDialogSync({ title: 'Importa', filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (!files) return;
  try {
    const importata = JSON.parse(fs.readFileSync(files[0], 'utf8'));
    // Il file arriva da fuori: le viste finiscono dentro la pagina impostazioni, quindi si valida.
    if (!importata || typeof importata !== 'object') throw new Error('struttura non valida');
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
    log('config importata da ' + files[0]);
    app.relaunch(); app.exit();
  } catch (e) {
    dialog.showErrorBox('Errore', 'File non valido:\n' + e.message);
  }
});

ipcMain.on('clear-cache', async () => {
  await getUnifiSession().clearCache();
  if (win && !win.isDestroyed()) win.reload();
  dialog.showMessageBox({ message: 'Cache svuotata e pagina ricaricata!' });
});

ipcMain.on('logout-now', async (event) => {
  await logoutUnifi({ serverSide: true });
  loadVista(vistaAttiva);
  event.reply('p-res', 'Account disconnesso: al prossimo caricamento verranno richieste le credenziali.');
});

// --- PASSWORD ---
function checkPassword(callback) {
  if (promptWin && !promptWin.isDestroyed()) { promptWin.focus(); return; }
  promptWin = new BrowserWindow({ width: 400, height: 320, parent: win, modal: true, frame: false, icon: iconPath, resizable: false, webPreferences: { nodeIntegration: true, contextIsolation: false } });
  const html = `
    <body style="font-family:sans-serif; padding:20px; text-align:center; background:#f0f0f0; border:3px solid #333;">
      <h3>🔒 Accesso Protetto</h3>
      <div id="errorMsg" style="color:red; font-size:12px; height:20px; visibility:hidden;">Password Errata!</div>
      <div style="display:flex; align-items:center; background:white; border:1px solid #ccc; border-radius:4px; padding:2px 10px; margin-bottom: 20px;">
        <input type="password" id="pass" style="border:none; outline:none; padding:10px; flex-grow:1; font-size:16px;" autofocus placeholder="Password..." onkeydown="if(event.key==='Enter'){submitPass()} if(event.key==='Escape'){window.close()}">
        <span onclick="const p=document.getElementById('pass'); p.type=p.type==='password'?'text':'password'" style="cursor:pointer; font-size:18px; padding:0 5px; user-select:none;">👁️</span>
      </div>
      <button onclick="submitPass()" style="padding:10px 25px; background:#5cb85c; color:white; border:none; cursor:pointer; font-weight:bold; border-radius:4px;">Accedi</button>
      <button onclick="window.close()" style="padding:10px 25px; background:#777; color:white; border:none; cursor:pointer; border-radius:4px;">Esci</button>
      <script>
        const { ipcRenderer } = require('electron');
        function submitPass() { ipcRenderer.send('check-pass-val', document.getElementById('pass').value); }
        ipcRenderer.on('pass-result', (e, res) => { if(res) window.close(); else { document.getElementById('errorMsg').style.visibility = 'visible'; document.getElementById('pass').value = ''; document.getElementById('pass').focus(); } });
      </script>
    </body>`;
  promptWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  // Un prompt abbandonato lasciava un listener 'pass-ok' armato fino alla chiamata successiva.
  ipcMain.removeAllListeners('pass-ok');
  ipcMain.once('pass-ok', callback);
  promptWin.on('closed', () => { promptWin = null; ipcMain.removeAllListeners('pass-ok'); });
}

ipcMain.on('check-pass-val', (event, p) => {
  if (p === config.passwordApp) { event.reply('pass-result', true); ipcMain.emit('pass-ok'); }
  else { log('password errata'); event.reply('pass-result', false); }
});

// --- IMPOSTAZIONI ---
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }
  const v = app.getVersion();
  // Su un pannello 1366x768 la finestra da 850x1050 usciva dallo schermo e i bottoni in fondo
  // (Chiudi, cambio password) erano irraggiungibili. Si stringe alla work area del monitor in uso.
  const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const wa = disp.workAreaSize;
  settingsWin = new BrowserWindow({
    width: Math.min(850, Math.max(700, wa.width - 60)),
    height: Math.min(1050, Math.max(400, wa.height - 60)),
    minWidth: 700, minHeight: 400,
    parent: win, modal: true, title: 'Configurazione', autoHideMenuBar: true, icon: iconPath,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  settingsWin.on('closed', () => { settingsWin = null; });
  const html = `
    <body style="font-family:sans-serif; padding:15px; margin:0; height:100vh; box-sizing:border-box; overflow-y:auto; background:#ececec;">
      <h3>🛠 Gestione Sistema</h3>
      <div style="max-height:40vh; overflow-y:auto; background:white; border:1px solid #ccc; padding:10px; border-radius:5px;">
        ${[1,2,3,4,5,6,7,8,9,0].map(num => `<div style="display:flex; gap:10px; align-items:center; margin-bottom:5px; border-bottom:1px solid #eee; padding-bottom:5px;">
            <input type="checkbox" class="v-attiva" data-id="${num}" ${config.viste[num].attiva ? 'checked' : ''}>
            <b style="width:60px;">Ctrl+${num}</b>
            <input type="text" class="v-nome" data-id="${num}" style="width:120px;" value="${esc(config.viste[num].nome)}">
            <input type="text" class="v-url" data-id="${num}" style="flex-grow:1;" value="${esc(config.viste[num].url)}">
          </div>`).join('')}
      </div>
      <div style="background:#fff; padding:15px; margin-top:10px; border-radius:5px; border:1px solid #ddd; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
        <label><input type="checkbox" id="fs" ${config.avvioFullScreen ? 'checked' : ''}> FullScreen</label>
        <label><input type="checkbox" id="standby" ${config.impedisciStandby ? 'checked' : ''}> Schermo sempre acceso</label>
        <div><label><input type="checkbox" id="autoReboot" ${config.autoReboot ? 'checked' : ''}> Refresh ore:</label> <input type="time" id="ora" value="${esc(config.oraReboot)}"></div>
        <button onclick="saveAll()" style="background:#5cb85c; color:white; border:none; padding:10px 20px; font-weight:bold; cursor:pointer; border-radius:4px;">💾 SALVA</button>
      </div>

      <div style="background:#fff; padding:15px; margin-top:10px; border-radius:5px; border:1px solid #ddd;">
        <h4 style="margin:0 0 10px 0;">🔓 Sessione UniFi</h4>
        <label style="display:block; margin-bottom:6px;"><input type="checkbox" id="loExit" ${config.logoutOnExit ? 'checked' : ''}> Disconnetti l'account alla chiusura del programma</label>
        <label style="display:block; margin-bottom:10px;"><input type="checkbox" id="loStart" ${config.logoutOnStart ? 'checked' : ''}> Richiedi sempre le credenziali all'avvio (vale anche dopo un blackout)</label>
        <div style="font-size:11px; color:#777; margin-bottom:10px;">Il logout cancella solo cookie e token del controller: indirizzi IP, nomi delle viste e password del programma restano salvati.</div>
        <button onclick="ipcRenderer.send('logout-now')" style="width:100%; padding:8px; background:#d9534f; color:white; border:none; cursor:pointer; border-radius:4px;">🔓 Disconnetti account adesso</button>
      </div>

      <div style="background:#f9f9f9; padding:15px; margin-top:10px; border-radius:5px; border:1px solid #ccc; display:flex; justify-content:space-around; gap:10px;">
        <button onclick="ipcRenderer.send('export-config')" style="flex:1; padding:10px; background:#337ab7; color:white; border:none; border-radius:4px; cursor:pointer;">📤 Backup</button>
        <button onclick="ipcRenderer.send('import-config')" style="flex:1; padding:10px; background:#f0ad4e; color:white; border:none; border-radius:4px; cursor:pointer;">📥 Restore</button>
        <button onclick="ipcRenderer.send('clear-cache')" style="flex:1; padding:10px; background:#777; color:white; border:none; border-radius:4px; cursor:pointer;">🧹 Svuota Cache</button>
      </div>

      <div style="background:#f9f9f9; padding:15px; margin-top:10px; border-radius:5px; border:1px solid #ccc;">
        <h4 style="margin:0 0 10px 0;">🔐 Modifica Password</h4>
        <table style="width:100%; border-spacing: 0 5px;">
          <tr><td style="width:120px;">Attuale:</td><td><input type="password" id="pOld" style="width:100%;"></td></tr>
          <tr><td>Nuova:</td><td><input type="password" id="p1" style="width:100%;"></td></tr>
          <tr><td>Conferma:</td><td><input type="password" id="p2" style="width:100%;"></td></tr>
        </table>
        <button onclick="changeP()" style="width:100%; margin-top:10px; padding:8px; background:#333; color:white; border:none; cursor:pointer;">Aggiorna Password</button>
      </div>
      <div style="margin-top:15px; display:flex; justify-content:space-between; color:#888;"><span>v${esc(v)}</span><button onclick="window.close()" style="padding:5px 20px;">Chiudi</button></div>
      <script>
        const { ipcRenderer } = require('electron');
        function saveAll() {
          const vistas = {}; [1,2,3,4,5,6,7,8,9,0].forEach(i => { vistas[i] = { nome: document.querySelector('.v-nome[data-id="'+i+'"]').value, url: document.querySelector('.v-url[data-id="'+i+'"]').value, attiva: document.querySelector('.v-attiva[data-id="'+i+'"]').checked }; });
          ipcRenderer.send('save-all-data', {
            vistas,
            fs: document.getElementById('fs').checked,
            ora: document.getElementById('ora').value,
            autoReboot: document.getElementById('autoReboot').checked,
            standby: document.getElementById('standby').checked,
            loExit: document.getElementById('loExit').checked,
            loStart: document.getElementById('loStart').checked
          });
        }
        function changeP() { ipcRenderer.send('req-p', { oldP: document.getElementById('pOld').value, newP: document.getElementById('p1').value, confP: document.getElementById('p2').value }); }
        ipcRenderer.on('p-res', (e, m) => alert(m));
      </script></body>`;
  settingsWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

ipcMain.on('req-p', (event, d) => {
  if (d.oldP !== config.passwordApp) event.reply('p-res', 'Password attuale errata');
  else if (!d.newP) event.reply('p-res', 'La nuova password non puo\' essere vuota');
  else if (d.newP !== d.confP) event.reply('p-res', 'Le nuove password non coincidono');
  else {
    const vecchia = config.passwordApp;
    config.passwordApp = d.newP;
    if (saveConfig()) { log('password del programma aggiornata'); event.reply('p-res', 'Password aggiornata!'); }
    else { config.passwordApp = vecchia; event.reply('p-res', 'Salvataggio fallito: password NON modificata'); }
  }
});

ipcMain.on('save-all-data', (event, d) => {
  config.viste = d.vistas;
  config.avvioFullScreen = d.fs;
  config.oraReboot = d.ora;
  config.autoReboot = !!d.autoReboot;
  config.impedisciStandby = !!d.standby;
  config.logoutOnExit = !!d.loExit;
  config.logoutOnStart = !!d.loStart;
  for (let i = 0; i <= 9; i++) { if (!config.viste[i]) config.viste[i] = defaultConfig.viste[i]; }
  const ok = saveConfig();
  armaRefreshProgrammato(); // l'orario nuovo deve valere subito, non dal prossimo avvio
  aggiornaBloccoStandby();
  registraScorciatoie();
  dialog.showMessageBox({ message: ok ? 'Salvato!' : 'SALVATAGGIO FALLITO — le modifiche valgono solo fino alla chiusura.' });
});

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

// --- FINESTRE ---
function revealMainWindow() {
  if (revealed) return;
  revealed = true;
  if (splash && !splash.isDestroyed()) { splash.destroy(); }
  splash = null;
  if (win && !win.isDestroyed()) { win.show(); win.focus(); }
}

async function createWindows() {
  Menu.setApplicationMenu(null); // niente menu di default, niente acceleratore per i DevTools

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
  // Una parete video non ha motivo di concedere microfono, webcam, posizione o notifiche.
  ses.setPermissionRequestHandler((wc, permission, callback) => {
    const consentito = permission === 'fullscreen';
    if (!consentito) log('permesso negato: ' + permission);
    callback(consentito);
  });

  win = new BrowserWindow({
    width: 1280, height: 720, title: 'UniFi Protect Monitor', autoHideMenuBar: true, icon: iconPath,
    show: false, backgroundColor: '#1c2b39', fullscreen: config.avvioFullScreen,
    webPreferences: { nodeIntegration: false, contextIsolation: true, partition: UNIFI_PARTITION }
  });

  win.webContents.setWindowOpenHandler(({ url }) => { log('popup bloccato: ' + url); return { action: 'deny' }; });

  win.webContents.on('did-fail-load', (e, codice, descrizione, url, isMainFrame) => {
    if (isMainFrame) gestisciErroreCaricamento(codice, descrizione);
  });
  win.webContents.on('did-finish-load', () => { annullaRetry(); });
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
    const menuTemplate = [{ label: '⚙️ Impostazioni', click: () => checkPassword(openSettings) }, { type: 'separator' }];
    [1,2,3,4,5,6,7,8,9].forEach(i => { if (config.viste[i] && config.viste[i].attiva) menuTemplate.push({ label: `🎥 ${config.viste[i].nome} (Ctrl+${i})`, click: () => loadVista(i) }); });
    if (config.viste[0] && config.viste[0].attiva) { menuTemplate.push({ type: 'separator' }, { label: `📂 ${config.viste[0].nome} (Ctrl+0)`, click: () => loadVista(0) }); }
    menuTemplate.push({ type: 'separator' },
      { label: '🔄 Ricarica', click: () => loadVista(vistaAttiva) },
      { label: '🔓 Disconnetti account', click: async () => { await logoutUnifi({ serverSide: true }); loadVista(vistaAttiva); } });
    menuTemplate.push({ type: 'separator' },
      { label: win.isFullScreen() ? '🖥 Esci Full Screen' : '📺 Vai Full Screen', click: () => win.setFullScreen(!win.isFullScreen()) },
      { label: '❌ Chiudi', click: () => app.quit() });
    Menu.buildFromTemplate(menuTemplate).popup();
  });

  registraScorciatoie();
  armaRefreshProgrammato();
  aggiornaBloccoStandby();
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
  annullaRetry();
  if (blockerId !== -1 && powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId);
});
