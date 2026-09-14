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
const figlio = spawn(electron, ['.', '--user-data-dir=' + userData], { cwd: PROJ, stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = '';
figlio.stderr.on('data', (d) => { stderr += d.toString(); });
figlio.stdout.on('data', () => {});

setTimeout(() => {
  spawnSync('taskkill', ['/pid', String(figlio.pid), '/T', '/F'], { stdio: 'ignore' });
  setTimeout(verifica, 1500);
}, 20000);

function verifica() {
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));

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

  const righeSospette = stderr.split('\n').filter(r =>
    /deprecat|Uncaught|UnhandledPromiseRejection|TypeError|ReferenceError|is not a function|Cannot read/i.test(r));
  ok('nessuna deprecazione o eccezione su stderr', righeSospette.length === 0, righeSospette.join('\n'));

  console.log('\n' + esiti.join('\n'));
  console.log('\n' + (errori === 0 ? 'AVVIO OK (' + esiti.length + ' controlli)' : errori + ' CONTROLLI FALLITI su ' + esiti.length));
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch (e) {}
  process.exit(errori === 0 ? 0 : 1);
}
