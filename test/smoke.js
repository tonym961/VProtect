// Test delle finestre di servizio: CSP, preload, contextBridge, rendering, escaping, validazione.
// Le finestre sono create con show:false, quindi non compare nulla a schermo.
//   npm test
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const PROJ = path.join(__dirname, '..');
const esiti = [];
let errori = 0;

function ok(nome, valore, atteso) {
  const passa = JSON.stringify(valore) === JSON.stringify(atteso);
  if (!passa) errori++;
  esiti.push((passa ? 'OK   ' : 'FAIL ') + nome + (passa ? '' : '  (atteso ' + JSON.stringify(atteso) + ', ottenuto ' + JSON.stringify(valore) + ')'));
}

// Un nome vista che, se finisse in un template HTML senza escape, diventerebbe markup.
// E' il difetto chiuso nella 1.8.0: qui deve restare testo dentro un value.
const NOME_OSTILE = 'Vista "x" <b>tag</b> \' onerror=alert(1)';
const visteFinte = {};
for (let i = 0; i <= 9; i++) {
  visteFinte[i] = { nome: i === 3 ? NOME_OSTILE : 'Vista ' + i, url: 'https://10.0.0.' + (i + 1) + '/', attiva: i < 5 };
}

ipcMain.handle('settings:get', () => ({
  viste: visteFinte, avvioFullScreen: false, autoReboot: true, oraReboot: '03:00',
  impedisciStandby: true, logoutOnExit: true, logoutOnStart: true,
  accettaTuttiICertificati: false, riallineaSuCambioDisplay: true, accelerazioneHardware: false,
  versione: '0.0.0-test'
}));
ipcMain.handle('auth:check', (e, v) => v === 'segreto');
ipcMain.handle('settings:save', (e, d) => ({ ok: true, message: 'salvato:' + Object.keys(d.viste).length }));
ipcMain.handle('update:check', () => ({ ok: true, aggiornamento: true, versione: '9.9.9', message: 'Disponibile la versione 9.9.9' }));
ipcMain.handle('diagnostica:get', () => ({
  accelerazioneAttiva: false, electron: '44.0.0-test', chrome: '144.0.0.0',
  logPath: 'C:/tmp/monitor.log', configPath: 'C:/tmp/viste_config.json',
  vistaAttiva: 2, nomeVistaAttiva: 'Vista 2', riconnessioneInCorso: true
}));
ipcMain.handle('diagnostica:apri-log', () => ({ ok: true, message: 'Cartella del log aperta.' }));

const aperte = [];

async function apri(file, opzioni) {
  const o = opzioni || {};
  const messaggi = [];
  const win = new BrowserWindow({
    show: false, width: 900, height: 900,
    webPreferences: o.senzaPreload
      // wallpaper.html in produzione gira nella finestra principale, che NON ha preload
      ? { nodeIntegration: false, contextIsolation: true, sandbox: true }
      : { preload: path.join(PROJ, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true }
  });
  aperte.push(win);
  // Da Electron 35 l'evento passa un oggetto: la vecchia forma posizionale e' deprecata.
  win.webContents.on('console-message', (evento) => { messaggi.push(evento.message); });
  await win.loadFile(path.join(PROJ, file), o.query ? { query: o.query } : undefined);
  await new Promise(r => setTimeout(r, 900)); // lascia completare il carica() asincrono
  return { win, messaggi, js: (codice) => win.webContents.executeJavaScript(codice) };
}

app.whenReady().then(async () => {
  const p = await apri('password.html');
  ok('password: window.api esposto', await p.js('typeof window.api'), 'object');
  ok('password: Node non raggiungibile', await p.js('typeof window.require'), 'undefined');
  ok('password: superficie api limitata', await p.js('Object.keys(window.api).length'), 15);
  ok('password: password giusta accettata', await p.js("window.api.verificaPassword('segreto')"), true);
  ok('password: password sbagliata rifiutata', await p.js("window.api.verificaPassword('altro')"), false);
  ok('password: Invio invia il form', await p.js("(() => { const c=document.getElementById('pass'); c.value='x'; c.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter'})); return true })()"), true);
  ok('password: nessun errore in console', p.messaggi, []);

  const s = await apri('settings.html');
  ok('settings: window.api esposto', await s.js('typeof window.api'), 'object');
  ok('settings: Node non raggiungibile', await s.js('typeof window.require'), 'undefined');
  ok('settings: 10 righe vista renderizzate', await s.js('document.querySelectorAll(".vista").length'), 10);
  ok('settings: versione mostrata', await s.js('document.getElementById("versione").textContent'), 'v0.0.0-test');
  ok('settings: 5 viste attive', await s.js('[...document.querySelectorAll(".v-attiva")].filter(c=>c.checked).length'), 5);
  ok('settings: autoReboot letto', await s.js('document.getElementById("autoReboot").checked'), true);
  ok('settings: ora letta', await s.js('document.getElementById("ora").value'), '03:00');
  ok('settings: certTutti letto', await s.js('document.getElementById("certTutti").checked'), false);

  // Le righe sono renderizzate nell'ordine 1..9,0: la vista 3 e' all'indice 2.
  ok('settings: nome ostile resta testo', await s.js('document.querySelectorAll(".v-nome")[2].value'), NOME_OSTILE);
  ok('settings: nessun tag iniettato nella lista', await s.js('document.querySelectorAll("#viste b").length'), 10);
  ok('settings: nessun elemento estraneo iniettato', await s.js('document.querySelectorAll("#viste *:not(input):not(b)").length'), 10);

  ok('settings: URL non valido bloccato', await s.js("(async () => { const u=document.querySelectorAll('.v-url')[0]; u.value='javascript:alert(1)'; document.getElementById('salva').click(); await new Promise(r=>setTimeout(r,200)); return document.getElementById('esito').className })()"), 'ko');
  ok('settings: URL valido accettato', await s.js("(async () => { const u=document.querySelectorAll('.v-url')[0]; u.value='https://10.0.0.99/'; document.getElementById('salva').click(); await new Promise(r=>setTimeout(r,300)); return document.getElementById('esito').className })()"), 'ok');
  ok('settings: riallinea display letto', await s.js('document.getElementById("riallinea").checked'), true);
  ok('settings: accelerazione hardware letta', await s.js('document.getElementById("accelerazione").checked'), false);

  // aggiornamenti: il bottone di installazione resta disabilitato finche' il controllo non trova qualcosa
  ok('settings: installa disabilitato prima del controllo', await s.js('document.getElementById("installa").disabled'), true);
  ok('settings: versione corrente mostrata', await s.js('document.getElementById("versioneCorrente").textContent'), '0.0.0-test');
  ok('settings: controllo abilita l\'installazione', await s.js("(async () => { document.getElementById('controlla').click(); await new Promise(r=>setTimeout(r,400)); return document.getElementById('installa').disabled })()"), false);
  ok('settings: esito del controllo mostrato', await s.js("document.getElementById('esito').textContent"), 'Disponibile la versione 9.9.9');

  ok('settings: diagnostica mostrata', await s.js("document.getElementById('dettagliDiagnostica').textContent.includes('Chromium 144.0.0.0')"), true);
  ok('settings: accelerazione reale distinta da quella in config', await s.js("document.getElementById('dettagliDiagnostica').textContent.includes('in questo avvio: disattivata')"), true);
  ok('settings: riconnessione segnalata', await s.js("document.getElementById('dettagliDiagnostica').textContent.includes('riconnessione in corso')"), true);
  ok('settings: apri log risponde', await s.js("(async () => { document.getElementById('apriLog').click(); await new Promise(r=>setTimeout(r,250)); return document.getElementById('esito').textContent })()"), 'Cartella del log aperta.');
  ok('settings: verdetto codec mostrato', await s.js("document.getElementById('statoCodec').textContent.length > 20"), true);
  ok('settings: nessun errore in console', s.messaggi, []);

  // ---- wallpaper.html: riceve dati dal main via query, senza preload ----
  const URL_OSTILE = 'https://10.0.0.1/"><img src=x onerror=alert(1)>';
  const w = await apri('wallpaper.html', {
    senzaPreload: true,
    query: { errore: '-202 ERR_CERT_AUTHORITY_INVALID', url: URL_OSTILE, vista: 'Ingresso <b>1</b>', riprovo: '5' }
  });
  ok('wallpaper: nessun ponte verso il main', await w.js('typeof window.api'), 'undefined');
  ok('wallpaper: Node non raggiungibile', await w.js('typeof window.require'), 'undefined');
  ok('wallpaper: blocco errore visibile', await w.js("document.getElementById('errore').className"), 'visibile');
  ok('wallpaper: nome vista resta testo', await w.js("document.getElementById('titoloErrore').textContent"), 'Impossibile raggiungere "Ingresso <b>1</b>"');
  ok('wallpaper: URL ostile resta testo', await w.js("document.getElementById('indirizzo').textContent"), URL_OSTILE);
  ok('wallpaper: nessun tag iniettato dalla query', await w.js("document.querySelectorAll('#errore img, #errore b').length"), 0);
  ok('wallpaper: errore certificato spiegato', await w.js("document.getElementById('suggerimento').textContent.includes('Certificato non accettato')"), true);
  ok('wallpaper: conto alla rovescia avviato', await w.js("document.getElementById('attesa').textContent.includes('Nuovo tentativo fra')"), true);
  ok('wallpaper: nessun errore in console', w.messaggi, []);

  console.log('\n' + esiti.join('\n'));
  console.log('\n' + (errori === 0 ? 'TUTTI I TEST PASSATI (' + esiti.length + ')' : errori + ' TEST FALLITI su ' + esiti.length));
  aperte.forEach(w => { try { w.destroy(); } catch (e) {} });
  app.exit(errori === 0 ? 0 : 1);
});
