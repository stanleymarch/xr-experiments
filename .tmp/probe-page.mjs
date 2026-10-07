import WebSocket from 'ws';
const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
const page = list.find((t) => t.id === '181');
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
let id = 0;
const pending = new Map();
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});
const send = (method, params = {}) => new Promise((res) => { const myId = ++id; pending.set(myId, res); ws.send(JSON.stringify({ id: myId, method, params })); });
await new Promise((r) => ws.on('open', r));
await send('Runtime.enable');
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  return r.result?.result?.value ?? r.result?.exceptionDetails?.text ?? null;
};
console.log(JSON.stringify({
  bootError: await evaluate("document.getElementById('boot-error')?.innerText ?? null"),
  panel: await evaluate("!!document.getElementById('weather-browser-panel')"),
  badge: await evaluate("document.querySelector('[data-testid=\\\"mode-badge\\\"]')?.textContent ?? null"),
  visibility: await evaluate("document.visibilityState"),
  xrActive: await evaluate("!!navigator.xr && (document.querySelector('#scene-container') ? true : true)"),
  rafPerSec: await evaluate(`new Promise((res) => { let n = 0; const t0 = performance.now(); const loop = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(loop); else res(n); }; requestAnimationFrame(loop); setTimeout(() => res('TIMEOUT n=' + n), 3000); })`),
  perfNow: await evaluate("performance.now()"),
}, null, 1));
ws.close();
