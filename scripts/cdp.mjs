// Ladění CEP panelu přes Chrome DevTools Protocol (port z panel/.debug).
// node scripts/cdp.mjs            -> reload panelu a výpis chyb/konzole
// node scripts/cdp.mjs "výraz"    -> jen vyhodnotí výraz v panelu
const PORT = 8098;
const expr = process.argv[2];

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((p) => p.webSocketDebuggerUrl);
if (!page) throw new Error('Žádná stránka k ladění: ' + JSON.stringify(list));
console.log('page:', page.url);

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    console.log('EXCEPTION:', d.exception?.description || d.text, `@${d.url}:${d.lineNumber}:${d.columnNumber}`);
  } else if (msg.method === 'Runtime.consoleAPICalled') {
    console.log(`console.${msg.params.type}:`, msg.params.args.map((a) => a.value ?? a.description).join(' '));
  } else if (msg.method === 'Log.entryAdded') {
    console.log(`log.${msg.params.entry.level}:`, msg.params.entry.text, msg.params.entry.url || '');
  }
};
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });

await send('Runtime.enable');
await send('Log.enable');
if (expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  console.log(JSON.stringify(r.result?.result?.value ?? r.result, null, 2));
} else {
  await send('Page.enable');
  await send('Page.reload', { ignoreCache: true });
  await new Promise((r) => setTimeout(r, 6000));
  const r = await send('Runtime.evaluate', {
    expression: `JSON.stringify({ stav: document.getElementById('stav')?.textContent, port: document.getElementById('port')?.textContent, log: document.getElementById('log')?.textContent?.slice(0, 1500), require: typeof require, cep: typeof window.__adobe_cep__ })`,
    returnByValue: true,
  });
  console.log('STATE:', r.result?.result?.value);
}
ws.close();
