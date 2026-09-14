// Finestra impostazioni. Nessun accesso a Node: tutto passa da window.api (preload.js).
// Le righe delle viste sono costruite con le API del DOM, non concatenando HTML: un nome
// vista con apici o tag e' un valore, non markup, e non puo' diventare codice.
const ORDINE = [1, 2, 3, 4, 5, 6, 7, 8, 9, 0];
const esito = document.getElementById('esito');

function mostraEsito(testo, ok) {
  esito.textContent = testo;
  esito.className = ok ? 'ok' : 'ko';
}

function urlValido(u) {
  try {
    const p = new URL(String(u));
    return p.protocol === 'http:' || p.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

function creaRiga(num, vista) {
  const riga = document.createElement('div');
  riga.className = 'vista';

  const attiva = document.createElement('input');
  attiva.type = 'checkbox';
  attiva.className = 'v-attiva';
  attiva.checked = !!vista.attiva;

  const etichetta = document.createElement('b');
  etichetta.textContent = 'Ctrl+' + num;

  const nome = document.createElement('input');
  nome.type = 'text';
  nome.className = 'v-nome';
  nome.maxLength = 120;
  nome.value = vista.nome || '';

  const url = document.createElement('input');
  url.type = 'text';
  url.className = 'v-url';
  url.value = vista.url || '';
  url.addEventListener('input', () => {
    url.classList.toggle('non-valido', url.value !== '' && !urlValido(url.value));
  });

  riga.append(attiva, etichetta, nome, url);
  riga.dataset.id = String(num);
  return riga;
}

function leggiViste() {
  const viste = {};
  document.querySelectorAll('.vista').forEach((riga) => {
    viste[riga.dataset.id] = {
      attiva: riga.querySelector('.v-attiva').checked,
      nome: riga.querySelector('.v-nome').value,
      url: riga.querySelector('.v-url').value
    };
  });
  return viste;
}

async function carica() {
  const cfg = await window.api.leggiConfig();
  const contenitore = document.getElementById('viste');
  contenitore.textContent = '';
  ORDINE.forEach((num) => contenitore.append(creaRiga(num, cfg.viste[num] || {})));
  document.getElementById('fs').checked = !!cfg.avvioFullScreen;
  document.getElementById('standby').checked = !!cfg.impedisciStandby;
  document.getElementById('autoReboot').checked = !!cfg.autoReboot;
  document.getElementById('ora').value = cfg.oraReboot || '03:00';
  document.getElementById('loExit').checked = !!cfg.logoutOnExit;
  document.getElementById('loStart').checked = !!cfg.logoutOnStart;
  document.getElementById('certTutti').checked = !!cfg.accettaTuttiICertificati;
  document.getElementById('riallinea').checked = !!cfg.riallineaSuCambioDisplay;
  document.getElementById('accelerazione').checked = !!cfg.accelerazioneHardware;
  document.getElementById('versione').textContent = 'v' + cfg.versione;
  document.getElementById('versioneCorrente').textContent = cfg.versione;
}

document.getElementById('salva').addEventListener('click', async () => {
  const viste = leggiViste();
  const invalide = Object.keys(viste).filter((k) => viste[k].attiva && !urlValido(viste[k].url));
  if (invalide.length) {
    mostraEsito('Indirizzo non valido nelle viste attive: ' + invalide.join(', ') + '. Servono URL http:// o https://.', false);
    return;
  }
  const res = await window.api.salvaConfig({
    viste,
    avvioFullScreen: document.getElementById('fs').checked,
    impedisciStandby: document.getElementById('standby').checked,
    autoReboot: document.getElementById('autoReboot').checked,
    oraReboot: document.getElementById('ora').value,
    logoutOnExit: document.getElementById('loExit').checked,
    logoutOnStart: document.getElementById('loStart').checked,
    accettaTuttiICertificati: document.getElementById('certTutti').checked,
    riallineaSuCambioDisplay: document.getElementById('riallinea').checked,
    accelerazioneHardware: document.getElementById('accelerazione').checked
  });
  mostraEsito(res.message, res.ok);
});

// --- aggiornamenti ---
const bottoneInstalla = document.getElementById('installa');
const barra = document.getElementById('barra');
const avanzamento = document.getElementById('avanzamento');

function mb(byte) { return (byte / 1048576).toFixed(1); }

// Il main manda { pct, scaricati, totale, bps }: su una linea lenta la sola percentuale non
// distingue "sta scaricando piano" da "si e' piantato".
window.api.suProgressoAggiornamento((p) => {
  const pct = typeof p === 'object' && p ? p.pct : p;
  barra.style.display = 'block';
  avanzamento.style.width = pct + '%';
  if (typeof p === 'object' && p && p.totale) {
    bottoneInstalla.textContent = pct + '% — ' + mb(p.scaricati) + ' / ' + mb(p.totale) + ' MB — ' + mb(p.bps) + ' MB/s';
  } else {
    bottoneInstalla.textContent = 'Scarico… ' + pct + '%';
  }
});

document.getElementById('controlla').addEventListener('click', async () => {
  const bottone = document.getElementById('controlla');
  bottone.disabled = true;
  bottone.textContent = '🔍 Controllo…';
  const res = await window.api.controllaAggiornamenti();
  mostraEsito(res.message, res.ok);
  bottoneInstalla.disabled = !(res.ok && res.aggiornamento);
  bottone.disabled = false;
  bottone.textContent = '🔍 Controlla aggiornamenti';
});

bottoneInstalla.addEventListener('click', async () => {
  bottoneInstalla.disabled = true;
  bottoneInstalla.textContent = 'Scarico…';
  const res = await window.api.installaAggiornamento();
  mostraEsito(res.message, res.ok);
  // Il ripristino vale anche quando l'esito e' ok: premendo "Annulla" nel dialogo di conferma
  // l'handler torna ok:true, e il bottone restava disabilitato con l'etichetta dell'ultimo
  // progresso ("100% — 62.0 / 62.0 MB") e la barra piena, cioe' mentendo. L'unico caso in cui
  // non si ripristina e' l'installazione avviata davvero, dove il programma sta chiudendo.
  if (!res.avviato) {
    bottoneInstalla.disabled = false;
    bottoneInstalla.textContent = '⬇️ Scarica e installa';
    barra.style.display = 'none';
    avanzamento.style.width = '0%';
  }
});

document.getElementById('cambiaPwd').addEventListener('click', async () => {
  const res = await window.api.cambiaPassword({
    oldP: document.getElementById('pOld').value,
    newP: document.getElementById('p1').value,
    confP: document.getElementById('p2').value
  });
  if (res.ok) {
    document.getElementById('pOld').value = '';
    document.getElementById('p1').value = '';
    document.getElementById('p2').value = '';
  }
  mostraEsito(res.message, res.ok);
});

async function azione(idBottone, chiamata, ricaricaDopo) {
  document.getElementById(idBottone).addEventListener('click', async () => {
    const res = await chiamata();
    if (res && res.message) mostraEsito(res.message, res.ok);
    if (ricaricaDopo && res && res.ok) carica();
  });
}

azione('backup', () => window.api.esportaConfig(), false);
azione('restore', () => window.api.importaConfig(), true);
azione('cache', () => window.api.svuotaCache(), false);
azione('logout', () => window.api.disconnettiAccount(), false);

document.getElementById('chiudi').addEventListener('click', () => window.api.chiudi());

// --- diagnostica ---
// accelerazioneAttiva arriva da app.isHardwareAccelerationEnabled(), cioe' lo stato reale del
// processo, non il valore scritto in configurazione: dopo aver tolto la spunta senza riavviare
// i due valori differiscono, ed e' esattamente il momento in cui serve saperlo.
// Chromium su Windows NON ha un decoder H.265 software: per l'HEVC si appoggia alla decodifica
// hardware via Media Foundation. Se la GPU non la offre, o se mancano le "Estensioni video HEVC"
// di Windows, le telecamere impostate su H.265 restano nere mentre quelle H.264 si vedono.
// Va rilevato SUL PC che ha il problema: da un'altra postazione non si vede niente.
async function rilevaCodec() {
  const prova = (tipo) => {
    try { return typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(tipo); }
    catch (e) { return false; }
  };
  const h264 = prova('video/mp4; codecs="avc1.64001f"');
  const h265 = prova('video/mp4; codecs="hvc1.1.6.L93.B0"') || prova('video/mp4; codecs="hev1.1.6.L93.B0"');
  let h265Accelerato = false;
  try {
    const cap = await navigator.mediaCapabilities.decodingInfo({
      type: 'media-source',
      video: { contentType: 'video/mp4; codecs="hvc1.1.6.L93.B0"', width: 1920, height: 1080, bitrate: 4000000, framerate: 30 }
    });
    h265Accelerato = !!(cap && cap.powerEfficient);
  } catch (e) { h265Accelerato = false; }
  const esito = { h264, h265, h265Accelerato };
  window.api.segnalaCodec(esito); // finisce nel log, cosi' basta quello per la diagnosi a distanza
  return esito;
}

async function caricaDiagnostica() {
  const d = await window.api.leggiDiagnostica();
  if (!d) return;
  const codec = await rilevaCodec();
  const righe = [
    'Electron ' + d.electron + ' · Chromium ' + d.chrome,
    'Accelerazione hardware in questo avvio: ' + (d.accelerazioneAttiva ? 'attiva' : 'disattivata'),
    'Vista a schermo: ' + d.nomeVistaAttiva + (d.riconnessioneInCorso ? ' (riconnessione in corso)' : ''),
    'Log: ' + d.logPath,
    'Configurazione: ' + d.configPath
  ];
  const contenitore = document.getElementById('dettagliDiagnostica');
  contenitore.textContent = '';
  righe.forEach((testo) => {
    const riga = document.createElement('div');
    riga.textContent = testo;
    contenitore.append(riga);
  });

  // Il verdetto sui codec sta a parte ed e' evidenziato: e' la risposta alla domanda
  // "perche' su questo PC alcune telecamere non si vedono e altre si".
  const codecRiga = document.createElement('div');
  codecRiga.id = 'statoCodec';
  codecRiga.style.marginTop = '10px';
  codecRiga.style.padding = '8px';
  codecRiga.style.borderRadius = '4px';
  if (codec.h265) {
    codecRiga.style.background = '#dff0d8';
    codecRiga.style.color = '#3c763d';
    codecRiga.textContent = 'H.264 e H.265 supportati da questo PC' +
      (codec.h265Accelerato ? ' (H.265 con accelerazione hardware).' : ' (H.265 senza accelerazione hardware: carico CPU alto con molte camere).');
  } else {
    codecRiga.style.background = '#f2dede';
    codecRiga.style.color = '#a94442';
    codecRiga.textContent = 'Questo PC NON sa decodificare l\'H.265: le telecamere impostate su H.265 resteranno nere, quelle H.264 si vedranno. ' +
      'Rimedi: installa le "Estensioni video HEVC" da Microsoft Store e aggiorna i driver della scheda video, oppure imposta quelle telecamere su H.264 dentro UniFi Protect.';
  }
  contenitore.append(codecRiga);
}

document.getElementById('apriLog').addEventListener('click', async () => {
  const res = await window.api.apriLog();
  if (res && res.message) mostraEsito(res.message, res.ok);
});

carica();
caricaDiagnostica();
