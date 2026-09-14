// Finestra password. Nessun accesso a Node: tutto passa da window.api (preload.js).
const campo = document.getElementById('pass');
const errore = document.getElementById('errorMsg');

async function invia() {
  const ok = await window.api.verificaPassword(campo.value);
  if (ok) return; // il main process chiude la finestra e apre le impostazioni
  errore.style.visibility = 'visible';
  campo.value = '';
  campo.focus();
}

document.getElementById('accedi').addEventListener('click', invia);
document.getElementById('esci').addEventListener('click', () => window.api.chiudi());
document.getElementById('occhio').addEventListener('click', () => {
  campo.type = campo.type === 'password' ? 'text' : 'password';
});
campo.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') invia();
  if (e.key === 'Escape') window.api.chiudi();
});
campo.focus();
