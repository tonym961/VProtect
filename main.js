const { app, BrowserWindow, globalShortcut, dialog, Menu, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');

// --- OTTIMIZZAZIONE CODEC MISTI ---
app.commandLine.appendSwitch('ignore-certificate-errors');
app.commandLine.appendSwitch('disable-http-cache');
app.commandLine.appendSwitch('enable-accelerated-video-decode');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('disable-features', 'HevcAdapter,HardwareMediaKeyHandling');

let win;
let splash;
let vistaAttiva = 1;
let shuttingDown = false;
const configPath = path.join(app.getPath('userData'), 'viste_config.json');
const iconPath = path.join(__dirname, 'icona.ico');

// Partizione dedicata a UniFi Protect: qui vivono SOLO cookie, token e cache del controller.
// La configurazione (IP/URL delle viste, nomi, password del programma) sta in viste_config.json,
// che e' un file separato e NON viene mai toccato dal logout.
const UNIFI_PARTITION = 'persist:unifi';

// User Agent che simula un browser compatibile H.264
const CHROME_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36";

const defaultConfig = {
  passwordApp: 'Uat07Iot',
  avvioFullScreen: false,
  autoReboot: true,
  oraReboot: '03:00',
  logoutOnExit: true,   // alla chiusura disconnette l'account UniFi
  logoutOnStart: true,  // all'avvio ripulisce comunque la sessione (copre crash e mancanza di corrente)
  viste: {}
};

for(let i=0; i<=9; i++) {
  defaultConfig.viste[i] = { url: 'https://unifi.ui.com/', nome: i === 0 ? 'Registrazioni' : `Vista ${i}`, attiva: i === 0 || i <= 5 };
}

let config = JSON.parse(JSON.stringify(defaultConfig));
if (fs.existsSync(configPath)) {
  try { config = Object.assign({}, defaultConfig, JSON.parse(fs.readFileSync(configPath))); } catch (e) {}
}
// Config salvate da versioni precedenti possono avere viste mancanti: completa i buchi.
for(let i=0; i<=9; i++) { if (!config.viste[i]) config.viste[i] = defaultConfig.viste[i]; }

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
}

// Chiusura ordinata: prima il logout, poi l'uscita. Il flag evita rientri (close -> quit -> before-quit).
function beginShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const esci = () => { try { if (win && !win.isDestroyed()) win.destroy(); } catch (e) {} app.quit(); };
  (config.logoutOnExit ? logoutUnifi({ serverSide: true }) : Promise.resolve()).catch(() => {}).then(esci);
}

function loadVista(i) {
  const v = config.viste[i];
  if (!v || !v.url || !win || win.isDestroyed()) return;
  vistaAttiva = i;
  win.loadURL(v.url, { userAgent: CHROME_USER_AGENT });
}

// Backup, Restore e Svuota Cache
ipcMain.on('export-config', () => {
  const dest = dialog.showSaveDialogSync({ title: 'Esporta', defaultPath: 'unifi_monitor_backup.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (dest) fs.writeFileSync(dest, JSON.stringify(config, null, 2));
});

ipcMain.on('import-config', () => {
  const files = dialog.showOpenDialogSync({ title: 'Importa', filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (files) {
    try {
      config = Object.assign({}, defaultConfig, JSON.parse(fs.readFileSync(files[0])));
      fs.writeFileSync(configPath, JSON.stringify(config));
      app.relaunch(); app.exit();
    } catch(e) { dialog.showErrorBox("Errore", "File non valido"); }
  }
});

ipcMain.on('clear-cache', async () => {
  await getUnifiSession().clearCache();
  if (win && !win.isDestroyed()) win.reload();
  dialog.showMessageBox({ message: "Cache svuotata e pagina ricaricata!" });
});

// Logout manuale dalla finestra Impostazioni
ipcMain.on('logout-now', async (event) => {
  await logoutUnifi({ serverSide: true });
  loadVista(vistaAttiva);
  event.reply('p-res', 'Account disconnesso: al prossimo caricamento verranno richieste le credenziali.');
});

function checkPassword(callback) {
  let promptWin = new BrowserWindow({ width: 400, height: 320, parent: win, modal: true, frame: false, icon: iconPath, resizable: false, webPreferences: { nodeIntegration: true, contextIsolation: false } });
  const html = `
    <body style="font-family:sans-serif; padding:20px; text-align:center; background:#f0f0f0; border:3px solid #333;">
      <h3>🔒 Accesso Protetto</h3>
      <div id="errorMsg" style="color:red; font-size:12px; height:20px; visibility:hidden;">Password Errata!</div>
      <div style="display:flex; align-items:center; background:white; border:1px solid #ccc; border-radius:4px; padding:2px 10px; margin-bottom: 20px;">
        <input type="password" id="pass" style="border:none; outline:none; padding:10px; flex-grow:1; font-size:16px;" autofocus placeholder="Password...">
        <span onclick="const p=document.getElementById('pass'); p.type=p.type==='password'?'text':'password'" style="cursor:pointer; font-size:18px; padding:0 5px; user-select:none;">👁️</span>
      </div>
      <button onclick="ipcRenderer.send('check-pass-val', document.getElementById('pass').value)" style="padding:10px 25px; background:#5cb85c; color:white; border:none; cursor:pointer; font-weight:bold; border-radius:4px;">Accedi</button>
      <button onclick="window.close()" style="padding:10px 25px; background:#777; color:white; border:none; cursor:pointer; border-radius:4px;">Esci</button>
      <script>const { ipcRenderer } = require('electron'); ipcRenderer.on('pass-result', (e, res) => { if(res) window.close(); else { document.getElementById('errorMsg').style.visibility = 'visible'; document.getElementById('pass').value = ''; } });</script>
    </body>`;
  promptWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  ipcMain.removeAllListeners('pass-ok');
  ipcMain.once('pass-ok', callback);
}

ipcMain.on('check-pass-val', (event, p) => { if (p === config.passwordApp) { event.reply('pass-result', true); ipcMain.emit('pass-ok'); } else { event.reply('pass-result', false); } });

function openSettings() {
  const v = app.getVersion();
  let settingsWin = new BrowserWindow({ width: 850, height: 1050, parent: win, modal: true, title: "Configurazione", autoHideMenuBar: true, icon: iconPath, webPreferences: { nodeIntegration: true, contextIsolation: false } });
  const html = `
    <body style="font-family:sans-serif; padding:15px; background:#ececec;">
      <h3>🛠 Gestione Sistema</h3>
      <div style="max-height:350px; overflow-y:auto; background:white; border:1px solid #ccc; padding:10px; border-radius:5px;">
        ${[1,2,3,4,5,6,7,8,9,0].map(num => `<div style="display:flex; gap:10px; align-items:center; margin-bottom:5px; border-bottom:1px solid #eee; padding-bottom:5px;">
            <input type="checkbox" class="v-attiva" data-id="${num}" ${config.viste[num].attiva ? 'checked' : ''}>
            <b style="width:60px;">Ctrl+${num}</b>
            <input type="text" class="v-nome" data-id="${num}" style="width:120px;" value="${config.viste[num].nome}">
            <input type="text" class="v-url" data-id="${num}" style="flex-grow:1;" value="${config.viste[num].url}">
          </div>`).join('')}
      </div>
      <div style="background:#fff; padding:15px; margin-top:10px; border-radius:5px; border:1px solid #ddd; display:flex; justify-content:space-between; align-items:center;">
        <label><input type="checkbox" id="fs" ${config.avvioFullScreen ? 'checked' : ''}> FullScreen</label>
        <div><label>Refresh ore:</label> <input type="time" id="ora" value="${config.oraReboot}"></div>
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
      <div style="margin-top:15px; display:flex; justify-content:space-between; color:#888;"><span>v${v}</span><button onclick="window.close()" style="padding:5px 20px;">Chiudi</button></div>
      <script>
        const { ipcRenderer } = require('electron');
        function saveAll() {
          const vistas = {}; [1,2,3,4,5,6,7,8,9,0].forEach(i => { vistas[i] = { nome: document.querySelector('.v-nome[data-id="'+i+'"]').value, url: document.querySelector('.v-url[data-id="'+i+'"]').value, attiva: document.querySelector('.v-attiva[data-id="'+i+'"]').checked }; });
          ipcRenderer.send('save-all-data', { vistas, fs: document.getElementById('fs').checked, ora: document.getElementById('ora').value, loExit: document.getElementById('loExit').checked, loStart: document.getElementById('loStart').checked });
        }
        function changeP() { ipcRenderer.send('req-p', { oldP: document.getElementById('pOld').value, newP: document.getElementById('p1').value, confP: document.getElementById('p2').value }); }
        ipcRenderer.on('p-res', (e, m) => alert(m));
      </script></body>`;
  settingsWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

ipcMain.on('req-p', (event, d) => {
  if (d.oldP !== config.passwordApp) event.reply('p-res', 'Password attuale errata');
  else if (d.newP !== d.confP) event.reply('p-res', 'Le nuove password non coincidono');
  else { config.passwordApp = d.newP; fs.writeFileSync(configPath, JSON.stringify(config)); event.reply('p-res', 'Password aggiornata!'); }
});

ipcMain.on('save-all-data', (event, d) => { config.viste = d.vistas; config.avvioFullScreen = d.fs; config.oraReboot = d.ora; config.logoutOnExit = !!d.loExit; config.logoutOnStart = !!d.loStart; fs.writeFileSync(configPath, JSON.stringify(config)); dialog.showMessageBox({ message: "Salvato!" }); });

async function createWindows() {
  splash = new BrowserWindow({ width: 500, height: 400, frame: false, alwaysOnTop: true, transparent: true, icon: iconPath });
  splash.loadFile('splash.html');

  // Sessione ripulita prima del primo caricamento: la pagina di login appare sempre.
  if (config.logoutOnStart) { try { await logoutUnifi({ serverSide: false }); } catch (e) {} }

  win = new BrowserWindow({ width: 1280, height: 720, title: "UniFi Protect Monitor", autoHideMenuBar: true, icon: iconPath, show: false, fullscreen: config.avvioFullScreen, webPreferences: { nodeIntegration: false, contextIsolation: true, partition: UNIFI_PARTITION } });
  loadVista(1);
  setTimeout(() => { if (splash) { splash.close(); splash = null; } win.show(); win.focus(); }, 2000);

  // Chiudendo la finestra si passa prima dal logout, poi si esce.
  win.on('close', (e) => { if (!shuttingDown && config.logoutOnExit) { e.preventDefault(); beginShutdown(); } });

  win.webContents.on('context-menu', () => {
    const menuTemplate = [ { label: '⚙️ Impostazioni', click: () => checkPassword(openSettings) }, { type: 'separator' } ];
    [1,2,3,4,5,6,7,8,9].forEach(i => { if (config.viste[i] && config.viste[i].attiva) menuTemplate.push({ label: `🎥 ${config.viste[i].nome} (Ctrl+${i})`, click: () => loadVista(i) }); });
    if (config.viste[0] && config.viste[0].attiva) { menuTemplate.push({ type: 'separator' }, { label: `📂 ${config.viste[0].nome} (Ctrl+0)`, click: () => loadVista(0) }); }
    menuTemplate.push({ type: 'separator' }, { label: '🔓 Disconnetti account', click: async () => { await logoutUnifi({ serverSide: true }); loadVista(vistaAttiva); } });
    menuTemplate.push({ type: 'separator' }, { label: win.isFullScreen() ? "🖥 Esci Full Screen" : "📺 Vai Full Screen", click: () => win.setFullScreen(!win.isFullScreen()) }, { label: '❌ Chiudi', click: () => app.quit() });
    Menu.buildFromTemplate(menuTemplate).popup();
  });

  [0,1,2,3,4,5,6,7,8,9].forEach(i => { globalShortcut.register(`CommandOrControl+${i}`, () => { loadVista(i); }); });
  globalShortcut.register('F10', () => checkPassword(openSettings));
}

app.whenReady().then(createWindows);
app.on('before-quit', (e) => { if (!shuttingDown && config.logoutOnExit) { e.preventDefault(); beginShutdown(); } });
app.on('window-all-closed', () => { app.quit(); });
app.on('will-quit', () => { globalShortcut.unregisterAll(); });
