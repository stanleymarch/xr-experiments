import * as THREE from 'three';
import * as xb from 'xrblocks';

// CITY//ORBIT — реальное окружение из OpenStreetMap как голограмма.
// Стол: макет 1.2 м на столе перед тобой. 360°: город вокруг тебя.
// Указка лучом + select = карточка с дистанцией. Разведение контроллеров =
// масштаб 200 м → 1 км → 5 км. Никаких моделей — только данные Overpass.

const $ = (id) => document.getElementById(id);

// Публичные Overpass-зеркала. Серверы часто перегружены и банят типовые UA,
// поэтому клиент идёт с контактным UA, держится аккуратно (лёгкие запросы,
// ретраи, кулдаун зеркал, гонка зеркал).
const CONTACT_UA = 'xrblocks-demo/0.1 (+https://stanleymarch.github.io/xrblocks/)';
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.nchc.org.tw/api/interpreter',
];
const QUERIES = [
  // Прямые кешируемые выборки: короткие радиусы первыми, лимиты жёсткие,
  // регексы только там где без них никак (1км+). detail- fallback ниже.
  (lat, lon) => `[out:json][timeout:15];node(around:200,${lat},${lon})[tourism];out body 60;`,
  (lat, lon) => `[out:json][timeout:20];node(around:1000,${lat},${lon})[tourism=museum];out body 120;`,
  (lat, lon) => `[out:json][timeout:25];node(around:5000,${lat},${lon})[tourism=museum];out body 160;`,
];
// Запасной веер точечных запросов: когда сборные выборки упираются в лимит
// сервера, бьём их на мелкие around-запросы с дисперсией по сетке 3×3.
function fanQueries(lat, lon, r, tag, perCell, cells = [-0.004, 0, 0.004]) {
  const out = [];
  for (const dlat of cells) for (const dlon of cells) {
    out.push(`[out:json][timeout:15];node(around:${Math.round(r / 3)},${(lat + dlat).toFixed(5)},${(lon + dlon).toFixed(5)})[${tag}];out body ${perCell};`);
  }
  return out;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postOverpass(base, query, timeoutMs, signal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  const onOuter = () => ctrl.abort(signal?.reason);
  signal?.addEventListener('abort', onOuter, { once: true });
  try {
    // Сервер режет типовые и пустые UA (406/429): шлём контактный UA.
    const r = await fetch(base, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'User-Agent': CONTACT_UA,
      },
      body: 'data=' + encodeURIComponent(query),
      signal: ctrl.signal,
    });
    if (r.status === 429 || r.status === 504) throw new Error(`overpass ${r.status}`);
    if (!r.ok) throw new Error(`overpass ${r.status}`);
    return { json: await r.json(), via: base };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuter);
  }
}

// Гонка зеркал: выигрывает первый успешный ответ, остальные отменяются.
// Зеркало в кулдауне (после 429/504/timeout) пропускается.
const cooldownUntil = new Map();
async function overpassOne(query, { timeoutMs = 25000 } = {}) {
  const now = Date.now();
  const bases = OVERPASS.filter((b) => (cooldownUntil.get(b) || 0) <= now);
  if (!bases.length) throw new Error('все зеркала в кулдауне');
  const ctrl = new AbortController();
  const settled = await Promise.allSettled(bases.map((b) => postOverpass(b, query, timeoutMs, ctrl.signal)));
  ctrl.abort();
  const win = settled.find((s) => s.status === 'fulfilled');
  if (win) return win.value;
  for (const b of bases) cooldownUntil.set(b, Date.now() + 60000);
  throw settled.find((s) => s.status === 'rejected')?.reason || new Error('overpass недоступен');
}

// Каскад: сборный запрос → веер мелких. Между попытками — паузы, чтобы
// не упереться в per-slot лимит сервера.
async function overpass(query, opts = {}) {
  const { backoff = [2000, 5000, 12000], fan = null } = opts;
  let last;
  try {
    return await overpassOne(query, opts);
  } catch (e) { last = e; }
  if (fan) {
    const seen = new Set();
    const merged = [];
    let via = '';
    for (const q of fan) {
      await sleep(1500);
      try {
        const { json, via: v } = await overpassOne(q, opts);
        via = via || v;
        for (const el of json.elements || []) {
          if (!seen.has(el.id)) { seen.add(el.id); merged.push(el); }
        }
      } catch (e) { last = e; }
    }
    if (merged.length) return { json: { elements: merged }, via };
  }
  for (const wait of backoff) {
    await sleep(wait);
    try {
      return await overpassOne(query, opts);
    } catch (e) { last = e; }
  }
  throw last || new Error('overpass недоступен');
}

// Демо-окружение вокруг Эрмитажа — если сеть мертва.
function demoCity() {
  const cx = 59.9398, cy = 30.3146;
  const j = () => (Math.random() - 0.5) * 0.004;
  const names = ['Эрмитаж', 'Дворцовая площадь', 'Атланты', 'Невский просп.', 'Мойка, 12', 'Казанский собор'];
  return {
    elements: names.map((name, i) => ({
      type: 'node', id: 1000 + i,
      lat: cx + j() + (i - 2.5) * 0.0008, lon: cy + j() + (i - 2.5) * 0.0011,
      tags: { name, tourism: i % 2 ? 'museum' : 'attraction' },
    })),
    _demo: true,
  };
}

const KIND_COLORS = [
  [/museum|gallery|monument|artwork/, 0x54d6ff],
  [/cafe|restaurant|bar|fast_food/, 0xffb14a],
  [/university|school|library|itmo/i, 0x7dff9a],
  [/.*/, 0x9aa8c7],
];

class CityOrbit extends xb.Script {
  init() {
    this.add(new THREE.HemisphereLight(0xdfe8ff, 0x223344, 1.5));
    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(1, 3, 1);
    this.add(sun);

    this.group = new THREE.Group();
    this.add(this.group);
    this.base = new THREE.Mesh(
      new THREE.CircleGeometry(0.6, 48),
      new THREE.MeshBasicMaterial({ color: 0x0e2c44, transparent: true, opacity: 0.75 })
    );
    this.base.rotation.x = -Math.PI / 2;
    this.group.add(this.base);
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.585, 0.6, 64),
      new THREE.MeshBasicMaterial({ color: 0x54d6ff, transparent: true, opacity: 0.9, side: THREE.DoubleSide })
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.group.add(this.ring);

    this.you = new THREE.Mesh(
      new THREE.ConeGeometry(0.03, 0.09, 12),
      new THREE.MeshBasicMaterial({ color: 0xffffff })
    );
    this.group.add(this.you);
    this.items = []; // {node mesh, data, dist}
    this.poiGroup = new THREE.Group();
    this.group.add(this.poiGroup);

    // карточка
    this.card = new xb.UICard({
      size: { width: 0.5, height: 'auto' },
      manipulation: true, edge: true,
      style: { flexDirection: 'column', gap: 8, padding: 16 },
      children: [this.cardTitle = new xb.UIText({
        text: '…', style: { fontSize: 22, fontWeight: 'bold', textAlign: 'center' },
      }), this.cardBody = new xb.UIText({
        text: '', style: { fontSize: 15, opacity: 0.8, textAlign: 'center' },
      })],
    });
    this.card.position.set(0.42, 1.35, -0.9);
    this.card.visible = false;
    this.add(this.card);

    this.mode = 'table';       // table | orbit
    this.radiusIdx = 1;        // 1000 м
    this.lat = 59.9343; this.lon = 30.3351;
    this.center = null;
    this.cache = new Map();    // ключ lat,lon,r → данные
    this.selected = null;
    this._o = new THREE.Vector3();
    this._prevPinchDist = 0;

    $('btn-mode').onclick = () => {
      this.mode = this.mode === 'table' ? 'orbit' : 'table';
      this.layout();
    };
    $('btn-geo').onclick = () => this.load(+$('lat').value, +$('lon').value);
    this.layout();

    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (p) => {
          $('lat').value = p.coords.latitude.toFixed(4);
          $('lon').value = p.coords.longitude.toFixed(4);
          this.load(p.coords.latitude, p.coords.longitude);
        },
        () => this.load(this.lat, this.lon),
        { timeout: 6000 }
      );
    } else this.load(this.lat, this.lon);
  }

  stat(s) { $('stat').textContent = s; }

  async load(lat, lon) {
    this.lat = lat; this.lon = lon;
    this.stat(`overpass · ${lat.toFixed(4)}, ${lon.toFixed(4)} …`);
    const r = RADII[this.radiusIdx];
    const key = `${lat.toFixed(3)},${lon.toFixed(3)},${r}`;
    try {
      if (!this.cache.has(key)) {
        const { json, via } = await overpass(QUERIES[this.radiusIdx](lat, lon), {
          fan: fanQueries(lat, lon, r, 'tourism=museum', 20),
        });
        this.cache.set(key, { elements: json.elements, via });
      }
      const got = this.cache.get(key);
      this.center = { lat, lon };
      this._via = got.via;
      this._demo = false;
      this.build(got.elements);
      this.stat(`live · ${got.elements.length} POI в радиусе ${r} м · ${new URL(got.via).host}`);
    } catch (e) {
      this.center = { lat: 59.9398, lon: 30.3146 };
      this._via = 'offline-demo';
      this._demo = true;
      this.build(demoCity().elements);
      this.stat(`офлайн-демо (${e.message}) · Эрмитаж`);
    }
  }

  project(lat, lon) {
    // метры от центра: x — восток, z — юг (−z = север)
    const kx = 111320 * Math.cos(this.center.lat * Math.PI / 180);
    return { x: (lon - this.center.lon) * kx, z: -(lat - this.center.lat) * 110540 };
  }

  build(elements) {
    for (const c of [...this.poiGroup.children]) {
      this.poiGroup.remove(c);
      c.geometry?.dispose?.();
    }
    this.items = [];
    const r = RADII[this.radiusIdx];
    const span = this.mode === 'table' ? 1.2 : 7; // метров сцены
    const k = span / (r * 2);
    const geoS = new THREE.SphereGeometry(0.014, 12, 8);
    for (const el of elements.slice(0, 200)) {
      if (el.lat == null || el.lon == null) continue;
      const { x, z } = this.project(el.lat, el.lon);
      const color = KIND_COLORS.find(([re]) => re.test(JSON.stringify(el.tags || {})))[1];
      const m = new THREE.Mesh(geoS, new THREE.MeshBasicMaterial({ color }));
      m.position.set(x * k, 0.02, z * k);
      m.userData.item = {
        name: el.tags?.name || 'без названия',
        dist: Math.round(Math.hypot(x, z)),
        kind: el.tags?.tourism || el.tags?.amenity || el.tags?.shop || 'место',
        id: el.id,
      };
      m.xb = { pointerEvents: 'auto' };
      this.poiGroup.add(m);
      this.items.push(m);
    }
    this.selected = null;
    this.card.visible = false;
    this.layout();
  }

  layout() {
    const table = this.mode === 'table';
    const cam = xb.core.camera.position;
    if (table) {
      const fwd = new THREE.Vector3();
      xb.core.camera.getWorldDirection(fwd); fwd.y = 0; fwd.normalize();
      this.group.position.copy(cam).addScaledVector(fwd, 1.0);
      this.group.position.y = Math.max(0.7, cam.y - 0.55);
      this.group.scale.setScalar(1);
    } else {
      this.group.position.set(cam.x, 0.02, cam.z);
      this.group.scale.setScalar(1);
    }
    this.you.position.set(0, 0.03, 0);
  }

  pick() {
    // ближайший к лучу контроллера / камеры POI
    try {
      xb.user.getControllerPosition(0, this._o);
      const ray = xb.user.getRay(0, new THREE.Ray());
      if (ray && ray.direction.lengthSq() > 0.5) {
        this.raycaster = this.raycaster || new THREE.Raycaster();
        this.raycaster.set(this._o, ray.direction);
        this.raycaster.far = 12;
        const hits = this.raycaster.intersectObjects(this.items, false);
        return hits[0]?.object || null;
      }
    } catch { /* noop */ }
    return null;
  }

  onSelectEnd() {
    const hit = this.pick();
    if (!hit) { this.card.visible = false; this.selected = null; return; }
    this.selected = hit;
    const d = hit.userData.item;
    this.cardTitle.text = d.name;
    this.cardBody.text = `${d.kind} · ${d.dist} м${this._demo ? ' · demo' : ''}`;
    this.card.visible = true;
    // вырастить выбранный маркер
    for (const m of this.items) m.scale.setScalar(m === hit ? 2.2 : 1);
  }

  update() {
    const dt = Math.min(xb.getDeltaTime(), 0.05);
    this.ring.material.opacity = 0.6 + 0.3 * Math.sin(performance.now() * 0.003);
    // масштаб разведением контроллеров: дистанция между руками
    try {
      const a = xb.user.getControllerPosition(0, new THREE.Vector3());
      const b = xb.user.getControllerPosition(1, new THREE.Vector3());
      const d = a.distanceTo(b);
      if (this._prevPinchDist > 0.05 && d > 0.05) {
        const delta = d - this._prevPinchDist;
        if (Math.abs(delta) > 0.05) {
          this.radiusIdx = Math.min(2, Math.max(0, this.radiusIdx + (delta > 0 ? 1 : -1)));
          this._prevPinchDist = d;
          this.load(this.lat, this.lon);
          this.stat(`масштаб → ${RADII[this.radiusIdx]} м`);
          return;
        }
      }
      this._prevPinchDist = d;
    } catch { /* одна рука / десктоп */ }
    // пульс выбранного
    if (this.selected) {
      const s = 2.2 + Math.sin(performance.now() * 0.008) * 0.3;
      this.selected.scale.setScalar(s);
    }
    void dt;
  }

  dispose() { this.card.dispose?.(); }
}

const options = new xb.Options();
options.enableHands();
options.enableReticles();
options.xrButton.showEnterSimulatorButton = true;
options.setAppTitle('CITY//ORBIT');
options.setAppDescription('Город из OSM как голограмма. Луч + select = карточка.');

document.addEventListener('DOMContentLoaded', () => {
  xb.add(new CityOrbit());
  xb.init(options);
});
