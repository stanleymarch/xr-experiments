import WebSocket from 'ws';
const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
const page = list.find((t) => t.id === '181');
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
let id = 0;
const pending = new Map();
let glyphWarnings = 0;
let otherConsole = 0;
const samples = [];
let windowStart = Date.now();
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 120);
    if (text.includes('Missing glyph')) glyphWarnings++; else otherConsole++;
  }
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});
const send = (method, params = {}) => new Promise((res) => { const myId = ++id; pending.set(myId, res); ws.send(JSON.stringify({ id: myId, method, params })); });
await new Promise((r) => ws.on('open', r));
await send('Runtime.enable');
for (let i = 0; i < 6; i++) {
  glyphWarnings = 0; otherConsole = 0;
  windowStart = Date.now();
  await new Promise((r) => setTimeout(r, 2000));
  samples.push({ seconds: Math.round((Date.now() - windowStart) / 100) / 10, glyphWarnings, otherConsole });
}
console.log(JSON.stringify(samples, null, 1));
ws.close();
