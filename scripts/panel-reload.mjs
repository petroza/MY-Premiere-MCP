// Znovu načte stránku panelu (main.js/index.html) přes DevTools port z panel/.debug – bez restartu Premiere.
// node scripts/panel-reload.mjs
const list = await (await fetch('http://127.0.0.1:8098/json/list')).json();
const ws = new WebSocket(list.find((p) => p.webSocketDebuggerUrl).webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'location.reload(); true' } }));
await new Promise((r) => setTimeout(r, 1500));
ws.close();
console.log('panel znovu načten');
