// Spustí zadání v AI části panelu (přes DevTools port z panel/.debug) a počká na dokončení.
// node scripts/panel-run.mjs "zadání"  [maxSekund]
const PORT = 8098;
const prompt = process.argv[2];
const maxSec = Number(process.argv[3] || 300);
if (!prompt) throw new Error('Chybí zadání');

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const ws = new WebSocket(list.find((p) => p.webSocketDebuggerUrl).webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
const evaluate = (expression) => new Promise((r) => {
  const i = ++id;
  pending.set(i, (msg) => r(msg.result?.result?.value));
  ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
});

const start = await evaluate(`(function () {
  document.getElementById('out').innerHTML = '';
  document.getElementById('prompt').value = ${JSON.stringify(prompt)};
  document.getElementById('run').click();
  return document.getElementById('run').disabled;
})()`);
console.log('spuštěno:', start);

const t0 = Date.now();
let lastLen = 0;
while (Date.now() - t0 < maxSec * 1000) {
  await new Promise((r) => setTimeout(r, 3000));
  const s = await evaluate(`JSON.stringify({ running: document.getElementById('run').disabled, out: document.getElementById('out').innerText })`);
  const { running, out } = JSON.parse(s);
  if (out.length > lastLen) { process.stdout.write(out.slice(lastLen)); lastLen = out.length; }
  if (!running) break;
}
console.log(`\n--- konec po ${((Date.now() - t0) / 1000).toFixed(0)} s`);
ws.close();
