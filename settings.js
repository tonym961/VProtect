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
  document.getElementById('versione').textContent = 'v' + cfg.versione;
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
    accettaTuttiICertificati: document.getElementById('certTutti').checked
  });
  mostraEsito(res.message, res.ok);
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

carica();
