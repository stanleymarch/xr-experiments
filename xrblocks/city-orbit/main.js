import * as THREE from 'three';
import * as xb from 'xrblocks';

// CITY//ORBIT — реальное окружение из OpenStreetMap как голограмма.
// Стол: макет 1.2 м на столе перед тобой. 360°: город вокруг тебя.
// Указка лучом + select = карточка с дистанцией. Разведение контроллеров =
// масштаб 200 м → 1 км → 5 км. Никаких моделей — только данные Overpass.

const $ = (id) => document.getElementById(id);

// Публичные Overpass-зеркала. Российский узел VK Maps / Mail.ru идёт
// первым: для основной российской аудитории у него короче сетевой маршрут.
// Остальные — автоматический резерв. Мёртвые и локальные экстракты
// (nchc.org.tw, osm.ch) в список не входят: первый не отвечает, второй знает
// только Швейцарию.
const OVERPASS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const DEMO_CENTER = { lat: 59.9398, lon: 30.3146 };
const poiQuery = (lat, lon, radius, limit) => `[out:json][timeout:20];(`
  + `node(around:${radius},${lat},${lon})[name][tourism];`
  + `node(around:${radius},${lat},${lon})[name][amenity~"^(cafe|restaurant|bar|fast_food|library|university|school)$"];`
  + `node(around:${radius},${lat},${lon})[name][historic];`
  + `);out body ${limit};`;
const QUERIES = [
  (lat, lon) => poiQuery(lat, lon, 200, 80),
  (lat, lon) => poiQuery(lat, lon, 1000, 140),
  (lat, lon) => poiQuery(lat, lon, 5000, 200),
];
const RADII = [200, 1000, 5000];

// GET вместо POST: часть зеркал отдаёт 406 на POST от автоматических
// клиентов, GET с тем же QL проходит. Запросы короткие и кэшируются.
async function fetchOverpass(base, query, timeoutMs, signal) {
  const url = new URL(base);
  url.searchParams.set('data', query);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  const onOuter = () => ctrl.abort(signal?.reason);
  signal?.addEventListener('abort', onOuter, { once: true });
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`overpass ${r.status}`);
    return { json: await r.json(), via: base };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuter);
  }
}

// Гонка зеркал: берём первый успешный ответ и сразу отменяем остальные.
// Зеркало в кулдауне (после 4xx/5xx/таймаута) пропускается.
const cooldownUntil = new Map();
async function overpassOne(query, { timeoutMs = 25000 } = {}) {
  const now = Date.now();
  const bases = OVERPASS.filter((b) => (cooldownUntil.get(b) || 0) <= now);
  if (!bases.length) throw new Error('все зеркала в кулдауне');
  const ctrl = new AbortController();
  try {
    return await Promise.any(
      bases.map((b) => fetchOverpass(b, query, timeoutMs, ctrl.signal))
    );
  } catch (error) {
    for (const b of bases) cooldownUntil.set(b, Date.now() + 60000);
    throw error.errors?.[0] || error;
  } finally {
    ctrl.abort();
  }
}

// Одна короткая попытка через гонку зеркал. Если публичная инфраструктура
// не отвечает — выбираем художественный офлайн-квартал, а не штурмуем API.
async function overpass(query) {
  return overpassOne(query);
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
    this._ray = new THREE.Ray();
    this._handA = new THREE.Vector3();
    this._handB = new THREE.Vector3();
    this._prevPinchDist = 0;
    this.pinchHands = new Set();

    this._gestureStart = (e) => {
      if (e.detail.name === 'pinch') this.pinchHands.add(e.detail.hand);
    };
    this._gestureEnd = (e) => {
      if (e.detail.name === 'pinch') this.pinchHands.delete(e.detail.hand);
    };
    xb.core.gestureRecognition.addEventListener('gesturestart', this._gestureStart);
    xb.core.gestureRecognition.addEventListener('gestureend', this._gestureEnd);

    $('btn-radius').onclick = () => this.setRadius((this.radiusIdx + 1) % RADII.length);
    this.setRadius(this.radiusIdx, false);
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

  setRadius(index, reload = true) {
    this.radiusIdx = index;
    $('btn-radius').textContent = `радиус ${RADII[index] >= 1000 ? `${RADII[index] / 1000} км` : `${RADII[index]} м`}`;
    if (reload && this.center) this.load(this.lat, this.lon);
  }

  async load(lat, lon) {
    this.lat = lat; this.lon = lon;
    const r = RADII[this.radiusIdx];
    const key = `${lat.toFixed(3)},${lon.toFixed(3)},${r}`;
    if (this.cache.has(key)) {
      const got = this.cache.get(key);
      this.center = { lat, lon };
      this._via = got.via;
      this._demo = false;
      this.build(got.elements);
      this.stat(`live · ${got.elements.length} POI в радиусе ${r} м · ${new URL(got.via).host}`);
      return;
    }
    // Публичные зеркала отвечают за секунды, а иногда за десятки секунд:
    // сначала показываем художественный квартал, чтобы опыт начался сразу,
    // и заменяем его живыми данными, как только они придут.
    if (!this.items.length) {
      this.center = DEMO_CENTER;
      this._via = 'demo-quarter';
      this._demo = true;
      this.build(demoCity().elements);
    }
    this.stat(`overpass · ${lat.toFixed(4)}, ${lon.toFixed(4)} · ждём live …`);
    try {
      const { json, via } = await overpass(QUERIES[this.radiusIdx](lat, lon));
      this.cache.set(key, { elements: json.elements, via });
      this.center = { lat, lon };
      this._via = via;
      this._demo = false;
      this.build(json.elements);
      this.stat(`live · ${json.elements.length} POI в радиусе ${r} м · ${new URL(via).host}`);
    } catch (e) {
      if (this.items.length) {
        this.stat(`live недоступен (${e.message}) · оставлен показанный квартал`);
      } else {
        this.center = DEMO_CENTER;
        this._via = 'offline-demo';
        this._demo = true;
        this.build(demoCity().elements);
        this.stat(`офлайн-демо (${e.message}) · Эрмитаж`);
      }
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
      c.material?.dispose?.();
    }
    this.items = [];
    const r = RADII[this.radiusIdx];
    const span = this.mode === 'table' ? 1.2 : 7; // метров сцены
    const k = span / (r * 2);
    for (const el of elements.slice(0, 200)) {
      const lat = el.lat ?? el.center?.lat;
      const lon = el.lon ?? el.center?.lon;
      if (lat == null || lon == null) continue;
      const { x, z } = this.project(lat, lon);
      const color = KIND_COLORS.find(([re]) => re.test(JSON.stringify(el.tags || {})))[1];
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(0.014, 12, 8),
        new THREE.MeshBasicMaterial({ color })
      );
      m.position.set(x * k, 0.02, z * k);
      m.userData.item = {
        name: el.tags?.name || 'без названия',
        dist: Math.round(Math.hypot(x, z)),
        kind: el.tags?.tourism || el.tags?.amenity || el.tags?.historic || 'место',
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
      const ray = xb.user.getRay(0, this._ray);
      if (ray && ray.direction.lengthSq() > 0.5) {
        this.raycaster = this.raycaster || new THREE.Raycaster();
        this.raycaster.set(this._o, ray.direction);
        this.raycaster.far = 12;
        const hits = this.raycaster.intersectObjects(this.items, false);
        return hits[0]?.object || null;
      }
    } catch { /* controller may not exist on this platform */ }
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
    // Масштабирование — только когда обе руки в pinch: обычное движение
    // контроллеров не должно непредсказуемо перезагружать город.
    if (this.pinchHands.has('left') && this.pinchHands.has('right')) {
      try {
        xb.user.getControllerPosition(0, this._handA);
        xb.user.getControllerPosition(1, this._handB);
        const d = this._handA.distanceTo(this._handB);
        if (this._prevPinchDist > 0.05 && Math.abs(d - this._prevPinchDist) > 0.12) {
          this.setRadius(Math.min(2, Math.max(0, this.radiusIdx + (d > this._prevPinchDist ? 1 : -1))));
          this._prevPinchDist = d;
          this.stat(`масштаб → ${RADII[this.radiusIdx]} м`);
          return;
        }
        this._prevPinchDist = d;
      } catch { /* одна рука / десктоп */ }
    } else {
      this._prevPinchDist = 0;
    }
    // пульс выбранного
    if (this.selected) {
      const s = 2.2 + Math.sin(performance.now() * 0.008) * 0.3;
      this.selected.scale.setScalar(s);
    }
    void dt;
  }

  dispose() {
    this.card.dispose?.();
    xb.core.gestureRecognition.removeEventListener('gesturestart', this._gestureStart);
    xb.core.gestureRecognition.removeEventListener('gestureend', this._gestureEnd);
  }
}

const options = new xb.Options();
options.enableHands();
options.enableGestures();
options.gestures.setGestureEnabled('pinch', true);
// Режим симулятора остаётся USER: клик мышью = select, то есть выбор POI и
// масштаб города работают и на десктопе; позы рук — по Left Shift.
options.simulator.modeToggle.enabled = true;
options.enableReticles();
options.xrButton.showEnterSimulatorButton = true;
options.setAppTitle('CITY//ORBIT');
options.setAppDescription('Город из OSM как голограмма. Луч + select = карточка.');

document.addEventListener('DOMContentLoaded', () => {
  xb.add(new CityOrbit());
  xb.init(options);
});
