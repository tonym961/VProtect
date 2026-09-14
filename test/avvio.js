// Avvia davvero il main process in una userData temporanea, con una vista che punta a una
// porta chiusa, e verifica dal log che l'avvio sia arrivato in fondo e che il recupero
// dell'errore di caricamento sia scattato. Non installa niente e non tocca la config reale.
//   npm run test:avvio
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const electron = require('electron'); // da Node puro esporta il percorso dell'eseguibile
const PROJ = path.join(__dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'upm-test-'));
const configPath = path.join(userData, 'viste_config.json');
const logPath = path.join(userData, 'monitor.log');

const esiti = [];
let errori = 0;
function ok(nome, condizione, dettaglio) {
  if (!condizione) errori++;
  esiti.push((condizione ? 'OK   ' : 'FAIL ') + nome + (condizione || !dettaglio ? '' : '  -> ' + dettaglio));
}

// Config di partenza: password ancora in chiaro (come le installazioni 1.7.x) e una vista
// verso una porta chiusa, cosi' si esercita anche il ramo did-fail-load.
const viste = {};
for (let i = 0; i <= 9; i++) viste[i] = { nome: 'Vista ' + i, url: 'http://127.0.0.1:49999/', attiva: i < 3 };
fs.writeFileSync(configPath, JSON.stringify({
  passwordApp: 'vecchiaPassword',
  viste,
  logoutOnExit: false,   // niente logout in uscita: il test deve poter chiudere subito
  logoutOnStart: false,
  impedisciStandby: false,
  autoReboot: false
}, null, 2));

console.log('userData di test: ' + userData);

function avvia() {
  const figlio = spawn(electron, ['.', '--user-data-dir=' + userData], { cwd: PROJ, stdio: ['ignore', 'pipe', 'pipe'] });
  const catturato = { stderr: '' };
  figlio.stderr.on('data', (d) => { catturato.stderr += d.toString(); });
  figlio.stdout.on('data', () => {});
  return { figlio, catturato };
}

function chiudi(figlio) {
  spawnSync('taskkill', ['/pid', String(figlio.pid), '/T', '/F'], { stdio: 'ignore' });
}

// Il "controller" si accende a meta' corsa: cosi' si verifica non solo che i tentativi
// ripartano, ma che al primo che riesce il backoff venga davvero azzerato e il log lo dica.
// Prima della correzione quella riga era irraggiungibile (la guardia usava retryTimer, che il
// callback del retry azzera prima di caricare).
const http = require('http');
let server = null;
setTimeout(() => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><head><title>controller finto</title></head><body>ok</body></html>');
  });
  server.on('error', () => {});
  server.listen(49999, '127.0.0.1');
}, 14000);

const primo = avvia();
let stderr = '';

setTimeout(() => {
  chiudi(primo.figlio);
  stderr = primo.catturato.stderr;
  // Seconda esecuzione nella stessa userData: serve a verificare la rotazione del log, che
  // avviene alla prima riga scritta da ogni avvio.
  setTimeout(() => {
    const secondo = avvia();
    setTimeout(() => {
      chiudi(secondo.figlio);
      stderr += secondo.catturato.stderr;
      setTimeout(verifica, 1500);
    }, 7000);
  }, 1500);
}, 20000);

function verifica() {
  const leggi = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
  // Dopo due esecuzioni il log della prima e' stato ruotato in monitor.log.1 e monitor.log
  // contiene solo la seconda: e' esattamente il comportamento da verificare.
  const log = leggi(logPath + '.1');
  const logSecondoAvvio = leggi(logPath);
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  ok('rotazione del log al secondo avvio', log !== '' && logSecondoAvvio !== '',
    'monitor.log.1 vuoto? ' + (log === '') + ' — monitor.log vuoto? ' + (logSecondoAvvio === ''));
  ok('il log ruotato contiene il primo avvio', log.includes('avviato, versione'), 'monitor.log.1:\n' + log);
  ok('il log nuovo contiene solo il secondo avvio', (logSecondoAvvio.match(/avviato, versione/g) || []).length === 1,
    'monitor.log:\n' + logSecondoAvvio);
  ok('la password non viene riconvertita al secondo avvio', !logSecondoAvvio.includes('convertita in hash scrypt'),
    'monitor.log:\n' + logSecondoAvvio);

  ok('il main process arriva in fondo a createWindows', log.includes('avviato, versione'), 'log:\n' + log);
  ok('la config esistente viene letta', log.includes('config caricata da'));
  ok('la password in chiaro viene convertita in scrypt', log.includes('convertita in hash scrypt'));
  ok('passwordApp rimossa dal file', cfg.passwordApp === undefined, 'valore residuo: ' + cfg.passwordApp);
  ok('passwordHash e salt scritti', typeof cfg.passwordHash === 'string' && cfg.passwordHash.length === 64 && typeof cfg.passwordSalt === 'string' && cfg.passwordSalt.length === 32);
  ok('host irraggiungibile: scatta il recupero', log.includes('caricamento fallito'), 'log:\n' + log);
  ok('il recupero programma un nuovo tentativo', /riprovo fra \d+s/.test(log));
  // Il primo tentativo deve DAVVERO ripartire: solo "riprovo fra 5s" nel log non prova nulla,
  // quella riga viene scritta prima di armare il timer. Serve una seconda caduta.
  const cadute = (log.match(/caricamento fallito/g) || []).length;
  ok('il tentativo successivo parte davvero', cadute >= 2, 'cadute registrate: ' + cadute + '\nlog:\n' + log);
  ok('il backoff raddoppia', /riprovo fra 10s/.test(log), 'log:\n' + log);
  // Il controller si e' acceso a 14s: il tentativo successivo deve riuscire, e il recupero
  // deve essere registrato. Senza questo un ritorno in servizio sarebbe invisibile nel log.
  ok('il recupero riuscito viene registrato', /controller di nuovo raggiungibile/.test(log), 'log:\n' + log);
  ok('la pagina caricata viene registrata', /pagina caricata: http:\/\/127\.0\.0\.1:49999/.test(log), 'log:\n' + log);

  const righeSospette = stderr.split('\n').filter(r =>
    /deprecat|Uncaught|UnhandledPromiseRejection|TypeError|ReferenceError|is not a function|Cannot read/i.test(r));
  ok('nessuna deprecazione o eccezione su stderr', righeSospette.length === 0, righeSospette.join('\n'));

  console.log('\n' + esiti.join('\n'));
  console.log('\n' + (errori === 0 ? 'AVVIO OK (' + esiti.length + ' controlli)' : errori + ' CONTROLLI FALLITI su ' + esiti.length));
  try { if (server) server.close(); } catch (e) {}
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch (e) {}
  process.exit(errori === 0 ? 0 : 1);
}
