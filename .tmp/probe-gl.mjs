import WebSocket from 'ws';
const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
const page = list.find((t) => t.id === '181');
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
let id = 0;
const pending = new Map();
const consoleMsgs = [];
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.method === 'Runtime.consoleAPICalled') consoleMsgs.push({ type: msg.params.type, text: (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300) });
  if (msg.method === 'Runtime.exceptionThrown') consoleMsgs.push({ type: 'exception', text: (msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text ?? '').slice(0, 400) });
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});
const send = (method, params = {}) => new Promise((res) => { const myId = ++id; pending.set(myId, res); ws.send(JSON.stringify({ id: myId, method, params })); });
await new Promise((r) => ws.on('open', r));
await send('Runtime.enable');
await send('Log.enable');
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  return r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description ?? null;
};
const glInfo = await evaluate(`(() => {
  const canvas = document.querySelector('#scene-container canvas');
  if (!canvas) return 'no canvas';
  const gl = canvas.getContext('webgl2');
  if (!gl) return 'no gl';
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    lost: gl.isContextLost(),
    error: gl.getError(),
    drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
    renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
    canvasSize: [canvas.width, canvas.height],
  };
})()`);
const now = await evaluate(`(() => { const t0 = performance.now(); let x = 0; for (let i = 0; i < 3e6; i++) x += i; return { mainThreadResponsiveMs: Math.round(performance.now() - t0), rAFCount: window.__rafCount ?? 'n/a' }; })()`);
// Console history is not replayed, so probe live logs for a moment.
await evaluate(`(() => { const c = document.querySelector('#scene-container canvas'); return c ? 'canvas present' : 'no canvas'; })()`);
await new Promise((r) => setTimeout(r, 3000));
console.log(JSON.stringify({ glInfo, now, consoleMsgs: consoleMsgs.slice(-20) }, null, 1));
ws.close();
