// Schermata mostrata quando il controller non risponde. I dettagli arrivano come query da
// gestisciErroreCaricamento() in main.js. Pagina di sola lettura: la finestra principale non ha
// preload, qui non c'e' nessun canale verso il main process.
// Tutto viene scritto con textContent: i valori includono l'URL configurato dall'utente.
const parametri = new URLSearchParams(window.location.search);
const errore = parametri.get('errore') || '';
const url = parametri.get('url') || '';
const vista = parametri.get('vista') || '';
const riprovo = parametri.get('riprovo') || '';

if (errore || url) {
  document.getElementById('errore').className = 'visibile';
  document.getElementById('titoloErrore').textContent = vista
    ? 'Impossibile raggiungere "' + vista + '"'
    : 'Impossibile raggiungere il controller';
  document.getElementById('indirizzo').textContent = url;
  document.getElementById('codice').textContent = errore;

  // Un errore di certificato ha una causa e una cura diverse da "non risponde": dal 1.8.0 i
  // self-signed passano solo dagli host elencati nelle viste, e chi legge questa schermata
  // deve sapere dove andare a mettere mano.
  let suggerimento = '';
  if (/ERR_CERT_|CERT_|SSL_ERROR|certificate/i.test(errore)) {
    suggerimento = 'Certificato non accettato. Se il controller risponde su un indirizzo diverso da quelli configurati, attiva "Accetta certificati non validi da qualsiasi indirizzo" nelle impostazioni (F10).';
  } else if (/TIMEOUT/i.test(errore)) {
    suggerimento = 'Il controller ha accettato la connessione ma non ha risposto in tempo: di solito e\' sotto carico oppure un firewall sta scartando i pacchetti.';
  } else if (/ERR_NAME_NOT_RESOLVED|ERR_ADDRESS/i.test(errore)) {
    suggerimento = 'Il nome non si risolve: controlla l\'indirizzo della vista nelle impostazioni (F10) o il DNS della postazione.';
  } else if (/ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET/i.test(errore)) {
    suggerimento = 'Connessione rifiutata: verifica che il controller sia acceso e che la porta sia quella giusta.';
  }
  document.getElementById('suggerimento').textContent = suggerimento;

  if (riprovo) {
    const attesa = document.getElementById('attesa');
    let restanti = parseInt(riprovo, 10) || 0;
    const aggiorna = () => {
      attesa.textContent = restanti > 0
        ? 'Nuovo tentativo fra ' + restanti + ' second' + (restanti === 1 ? 'o' : 'i') + '…'
        : 'Nuovo tentativo in corso…';
      if (restanti > 0) { restanti--; setTimeout(aggiorna, 1000); }
    };
    aggiorna();
  }
}
