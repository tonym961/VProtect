// Unico ponte fra le finestre di servizio (password, impostazioni) e il main process.
// Le pagine girano con nodeIntegration disattivato e contextIsolation attivo: da lato
// renderer esiste solo window.api, con questi metodi e niente altro.
// La finestra principale, che carica l'interfaccia del controller, NON usa questo preload.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // --- password ---
  verificaPassword: (valore) => ipcRenderer.invoke('auth:check', valore),

  // --- impostazioni ---
  leggiConfig: () => ipcRenderer.invoke('settings:get'),
  salvaConfig: (dati) => ipcRenderer.invoke('settings:save', dati),
  cambiaPassword: (dati) => ipcRenderer.invoke('settings:change-password', dati),
  esportaConfig: () => ipcRenderer.invoke('settings:export'),
  importaConfig: () => ipcRenderer.invoke('settings:import'),
  svuotaCache: () => ipcRenderer.invoke('settings:clear-cache'),
  disconnettiAccount: () => ipcRenderer.invoke('settings:logout'),

  // --- aggiornamento manuale ---
  controllaAggiornamenti: () => ipcRenderer.invoke('update:check'),
  installaAggiornamento: () => ipcRenderer.invoke('update:install'),
  suProgressoAggiornamento: (callback) => {
    ipcRenderer.removeAllListeners('update:progress');
    ipcRenderer.on('update:progress', (evento, percentuale) => callback(percentuale));
  },

  // --- diagnostica ---
  leggiDiagnostica: () => ipcRenderer.invoke('diagnostica:get'),
  apriLog: () => ipcRenderer.invoke('diagnostica:apri-log'),
  segnalaCodec: (dati) => ipcRenderer.send('diagnostica:codec', dati),

  chiudi: () => ipcRenderer.send('window:close')
});
