import * as THREE from 'three';
import * as xb from 'xrblocks';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeHud } from '../common/hud.js?v=spatial-ui-12';
import { enableAutomation, installXrGuards, isAutomation, watchXrButton } from '../common/boot.js';
import { PALETTES } from '../common/fx.js';

// CITY//ORBIT — район из OpenStreetMap как голограмма.
// Стол: макет 1.2 м перед тобой. 360°: город вокруг тебя. Указка/луч камеры +
// select = карточка места. Разведение в pinch = 200 м → 1 км → 5 км.
//
// Один внутренний контракт сцены обслуживает и живой Overpass, и офлайн-демо:
//
//   { demo, roads:[{osm,name,cls,pts:[[lat,lon]…]}],   cls = major|minor|path|water
//     areas:[{osm,kind,name,ring:[[lat,lon]…]}],       kind = water|green
//     buildings:[{osm,levels,height,ring}],
//     pois:[{osm,type,lat,lon,name,cat,tags,dist,mx,mz}] }
//
// Слои строятся в метрах карты (x — восток, z — юг, y — вверх); в масштаб
// сцены их переводит одна матрица группы, поэтому смена стол/360° и радиуса
// не пересобирает геометрию. Высоты домов настоящие: 3.2 м на этаж.
//
// Семантика POI — шесть осмысленных категорий по мотивам poi-toolkit
// (наследие, памятник, религия, музей, достопримечательность, природа).
// Кафе, бары, лавки, отели, парковки и прочая инфраструктура — это negative
// space: они не запрашиваются вовсе и отбрасываются при разборе, поэтому
// «кафе не могут доминировать» — свойство запроса, а не фильтра отрисовки.

// ── Overpass ──────────────────────────────────────────────────────────────

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
const RADII = [200, 1000, 5000];

// У каждого слоя свой радиус и потолок элементов. Радиус данных растёт
// медленнее радиуса обзора: на 5 км нужен читаемый скелет центра, а не
// сорок тысяч полигонов в одном ответе.
const TIERS = [
  { poiR: 200, poiMax: 70, roadR: 200, roadMax: 240, bldR: 200, bldMax: 150, areaR: 200, areaMax: 40 },
  { poiR: 1000, poiMax: 110, roadR: 1000, roadMax: 360, bldR: 600, bldMax: 220, areaR: 1000, areaMax: 60 },
  { poiR: 5000, poiMax: 130, roadR: 1600, roadMax: 400, bldR: 900, bldMax: 220, areaR: 2500, areaMax: 60 },
];

const ROAD_RE = 'motorway|trunk|primary|secondary|tertiary|unclassified|residential'
  + '|living_street|pedestrian|service|track|footway|cycleway|path|steps'
  + '|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link';
const TOURISM_RE = 'museum|gallery|attraction|viewpoint|artwork|theme_park|zoo|aquarium';

// Запрос ориентиров общий для полной сцены и для запасного «только POI».
const poiSelectors = (n) => [
  `${n}[tourism~"^(${TOURISM_RE})$"]`,
  `${n}[historic]`,
  `${n}[heritage]`,
  `${n}[memorial]`,
  `${n}[amenity~"^(place_of_worship|museum)$"]`,
  `${n}[man_made~"^(obelisk|tower|lighthouse|water_tower)$"]`,
  `${n}[leisure~"^(park|garden|nature_reserve)$"]`,
  `${n}[natural~"^(spring|peak|cave_entrance)$"]`,
  `${n}[place=square]`,
].join(';');

// Один запрос на весь район: улицы, корпуса, вода/зелень, ориентиры.
// Каждый слой печатается своим `out geom N` — потолок на слой, а не на ответ.
// `out geom` даёт узлам/веям/релейшенам геометрию (у релейшенов — по ролям
// outer/inner), поэтому полилинии и контуры рисуются без второй выборки.
function sceneQuery(lat, lon, tier) {
  const at = (r) => `(around:${r},${lat},${lon})`;
  const n = `nwr${at(tier.poiR)}[name]`;
  return `[out:json][timeout:25];`
    + `way${at(tier.roadR)}[highway~"^(${ROAD_RE})$"]->.rd;.rd out geom ${tier.roadMax};`
    + `way${at(tier.bldR)}[building]->.bd;.bd out geom ${tier.bldMax};`
    + `(way${at(tier.areaR)}[natural~"^(water|wood|scrub|wetland|bay|beach)$"];`
    + `way${at(tier.areaR)}[waterway~"^(riverbank|dock)$"];`
    + `way${at(tier.areaR)}[leisure~"^(park|garden|nature_reserve|recreation_ground)$"];`
    + `way${at(tier.areaR)}[landuse~"^(forest|grass|meadow|village_green|cemetery)$"];`
    + `way${at(tier.areaR)}[waterway~"^(river|canal|stream)$"];)->.ar;.ar out geom ${tier.areaMax};`
    + `rel${at(tier.areaR)}[natural~"^(water|wood)$"]->.lr;.lr out geom 12;`
    + `(${poiSelectors(n)};)->.pz;.pz out geom ${tier.poiMax};`;
}

// Запасной запрос: только ориентиры. Если полная сцена отвергнута зеркалом
// (или на неё не хватило бюджета времени), опыт всё равно остаётся живым.
function poiQuery(lat, lon, tier) {
  const n = `nwr(around:${tier.poiR},${lat},${lon})[name]`;
  return `[out:json][timeout:20];(${poiSelectors(n)};);out geom ${tier.poiMax};`;
}

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

// ── Разбор геометрии ──────────────────────────────────────────────────────

const okPoint = (p) => !!p && Number.isFinite(p.lat) && Number.isFinite(p.lon);

// Точки вея/узла; у релейшена узлов нет — там работают члены (см. memberRings).
function lineFrom(el) {
  if (el.type === 'node') return okPoint(el) ? [[el.lat, el.lon]] : null;
  if (!Array.isArray(el.geometry)) return null;
  const pts = el.geometry.filter(okPoint).map((g) => [g.lat, g.lon]);
  return pts.length >= 2 ? pts : null;
}

// Контуры релейшена-мультиполигона: `out geom` кладёт геометрию в членов.
// Роль outer — контур, inner — дыра; дыры не рисуем (дешёвая заливка без
// вырезания), поэтому в контракт попадают только внешние кольца.
function memberRings(el) {
  const rings = [];
  if (el.type !== 'relation' || !Array.isArray(el.members)) return rings;
  for (const m of el.members) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role || 'outer';
    if (role !== 'outer' && role !== '') continue;
    if (!Array.isArray(m.geometry)) continue;
    const pts = m.geometry.filter(okPoint).map((g) => [g.lat, g.lon]);
    if (pts.length >= 3) rings.push(pts);
  }
  rings.sort((a, b) => b.length - a.length);
  return rings;
}

// Кольцо без дублирующей последней точки (Overpass отдаёт замкнутые веи с ней).
function ringFrom(pts) {
  if (!pts || pts.length < 3) return null;
  const [a, b] = [pts[0], pts[pts.length - 1]];
  const closed = Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
  const ring = closed ? pts.slice(0, -1) : pts;
  return ring.length >= 3 ? ring : null;
}

function ringsFrom(el, maxRings) {
  const out = [];
  if (el.type === 'way') {
    const ring = ringFrom(lineFrom(el));
    if (ring) out.push(ring);
  } else if (el.type === 'relation') {
    for (const member of memberRings(el)) {
      const ring = ringFrom(member);
      if (ring) out.push(ring);
      if (out.length >= maxRings) break;
    }
  }
  return out;
}

// Одна точка для знака места. Среднее кольца у Г-образного дома вылетает
// наружу, поэтому берём вершину контура, ближайшую к среднему, — это
// дешёвый аналог point-on-surface из poi-toolkit.
function pointOf(el) {
  if (el.type === 'node' && okPoint(el)) return { lat: el.lat, lon: el.lon };
  if (okPoint(el.center)) return { lat: el.center.lat, lon: el.center.lon };
  const line = lineFrom(el);
  const rings = el.type === 'relation' ? memberRings(el) : [];
  const pts = (line && line.length >= 3) ? line : (rings[0] || line);
  if (!pts || !pts.length) return null;
  let sy = 0, sx = 0;
  for (const p of pts) { sy += p[0]; sx += p[1]; }
  const my = sy / pts.length, mx = sx / pts.length;
  let best = pts[0], bestD = Infinity;
  for (const p of pts) {
    const d = (p[0] - my) ** 2 + (p[1] - mx) ** 2;
    if (d < bestD) { bestD = d; best = p; }
  }
  return { lat: best[0], lon: best[1] };
}

// ── Семантика ─────────────────────────────────────────────────────────────

// Шум: кафе, бары, лавки, отели, парковки, конторы, учреждения и городская
// инфраструктура. Такие объекты — фон, а не знак места; poi-toolkit называет
// это negative space и не публикует их вовсе. Мы их и не запрашиваем, а здесь
// стоит вторая линия обороны на случай зеркала со своим набором тегов.
const NOISE_AMENITY = /^(cafe|restaurant|bar|fast_food|pub|biergarten|food_court|ice_cream|juice_bar|tea|nightclub|casino|bank|atm|bureau_de_change|parking|parking_space|fuel|charging_station|car_wash|car_rental|bicycle_rental|taxi|vending_machine|toilets|bench|shelter|waste_basket|recycling|post_box|post_office|pharmacy|dentist|doctors|clinic|hospital|veterinary|kindergarten|school|college|university|library|police|fire_station|ranger_station|prison|courthouse|townhall|marketplace|theatre|cinema|events_venue|conference_centre|social_facility|driving_school|childcare|payment_centre)$/;
const NOISE_TOURISM = /^(hotel|hostel|motel|guest_house|apartment|chalet|camp_site|caravan_site|information)$/;
const NOISE_PLACE = /^(city|town|village|hamlet|suburb|quarter|neighbourhood|locality|isolated_dwelling|farm|allotments|borough)$/;
const NOISE_MEMORIAL = /plaque|board/i;
const LETTER = /\p{L}/u;

function hasName(name) {
  return typeof name === 'string' && name.trim().length >= 2 && LETTER.test(name);
}

function isNoise(t) {
  if (t.amenity && NOISE_AMENITY.test(t.amenity)) return true;
  if (t.tourism && NOISE_TOURISM.test(t.tourism)) return true;
  if (t.shop || t.office) return true;
  if (t.place && NOISE_PLACE.test(t.place)) return true;
  if (t.highway) return true;              // улица — линия, а не знак места
  if (t.memorial && NOISE_MEMORIAL.test(t.memorial)) return true;
  if (t['memorial:type'] && NOISE_MEMORIAL.test(t['memorial:type'])) return true;
  return false;
}

// Категории: метка для карточки, цвет и высота знака. Геометрия знака своя у
// каждой категории (см. glyphGeometry), поэтому «памятник» и «природа» не
// могут слиться в одинаковые шарики.
const CATEGORIES = {
  heritage: { label: 'Heritage', color: 0xffe9a8 },
  monument: { label: 'Monument', color: 0xffc46b },
  religious: { label: 'Religious', color: 0xb9a7ff },
  museum: { label: 'Museum', color: 0x35f2ff },
  sight: { label: 'Sight', color: 0xff7ad0 },
  nature: { label: 'Nature', color: 0x7dff9a },
};

const RELIGIOUS_HISTORIC = /^(church|chapel|cathedral|monastery|mosque|synagogue|temple|shrine|wayside_chapel)$/;
const RELIGIOUS_BUILDING = /^(church|chapel|cathedral|mosque|synagogue|temple|monastery|religious)$/;
const HERITAGE_HISTORIC = /^(building|castle|palace|manor|fort|ruins|archaeological_site|city_gate|tower|walls|gate|farm|yes)$/;
const SIGHT_TOURISM = /^(attraction|viewpoint|artwork|theme_park|zoo|aquarium|gallery)$/;
const SIGHT_MAN_MADE = /^(obelisk|tower|lighthouse|water_tower)$/;
const NATURE_LEISURE = /^(park|garden|nature_reserve)$/;
const NATURE_NATURAL = /^(spring|peak|cave_entrance|wood|water|wetland)$/;

// Классификация: сначала имя, потом теги. Так сделано в poi-toolkit для
// российских реестров: «объект культурного наследия» — это охранный статус,
// а не тип, поэтому тип читается из названия (церковь/памятник/музей/парк).
// Основа ищется с начала слова: «Медный всадник» — не «сад».
const nameHas = (name, stems) => new RegExp(`(?:^|[^а-яё])(${stems})`).test(name);

function classify(t, name) {
  if (!hasName(name) || isNoise(t)) return null;
  const n = name.toLowerCase();
  if (nameHas(n, 'церков|собор|храм|часовн|монастыр|мечет|синагог|костёл|костел|кирх|лавр|базилик')) return 'religious';
  if (nameHas(n, 'памятник|обелиск|монумент|стела|стель|бюст|мемориал|триумфальн|арка')) return 'monument';
  if (nameHas(n, 'музей|галере|кунсткамер|паноптикум')) return 'museum';
  if (nameHas(n, 'площад')) return 'sight';
  if (nameHas(n, 'дворец|усадьб|особняк|кремл|крепост|бастион|замок|палаты|дом\\s')) return 'heritage';
  if (nameHas(n, 'парк|сквер|сад|рощ|заповедн|пруд|озеро|набережн|аллея|мыс|поле')) return 'nature';
  if (t.amenity === 'place_of_worship') return 'religious';
  if (RELIGIOUS_HISTORIC.test(t.historic || '') || RELIGIOUS_BUILDING.test(t.building || '')) return 'religious';
  if (t.tourism === 'museum' || t.amenity === 'museum' || t.museum) return 'museum';
  if (t.historic === 'monument' || t.historic === 'memorial' || t.man_made === 'obelisk' || t.memorial) return 'monument';
  if (t.historic === 'wayside_cross' || t.historic === 'wayside_shrine') return 'monument';
  if (t.heritage || t['heritage:operator'] || HERITAGE_HISTORIC.test(t.historic || '')) return 'heritage';
  if (SIGHT_TOURISM.test(t.tourism || '') || SIGHT_MAN_MADE.test(t.man_made || '')) return 'sight';
  if (t.place === 'square') return 'sight';
  if (NATURE_LEISURE.test(t.leisure || '') || NATURE_NATURAL.test(t.natural || '')) return 'nature';
  return null;
}

// Значимость: у объекта с охранным статусом знак выше — вертикаль кодирует
// важность, а не расстояние до наблюдателя.
function importanceOf(t) {
  if (t.heritage || t['heritage:ref']) return 1.3;
  if (t.wikidata) return 1.15;
  return 1;
}

const WATER_NATURAL = /^(water|wetland|bay|beach|strait|reservoir)$/;
const GREEN_NATURAL = /^(wood|scrub|grassland|heath)$/;
const GREEN_LANDUSE = /^(forest|grass|meadow|village_green|cemetery|recreation_ground|orchard|vineyard)$/;
const GREEN_LEISURE = /^(park|garden|nature_reserve|recreation_ground|common|pitch)$/;

function areaKind(t) {
  if (t.natural === 'water' || (t.natural && WATER_NATURAL.test(t.natural)) || t.water) return 'water';
  if (t.waterway === 'riverbank' || t.waterway === 'dock') return 'water';
  if (t.natural && GREEN_NATURAL.test(t.natural)) return 'green';
  if (t.landuse && GREEN_LANDUSE.test(t.landuse)) return 'green';
  if (t.leisure && GREEN_LEISURE.test(t.leisure)) return 'green';
  return null;
}

function roadClass(highway) {
  if (/^(motorway|trunk|primary|secondary|tertiary)(_link)?$/.test(highway)) return 'major';
  if (/^(footway|cycleway|path|steps|bridleway)$/.test(highway)) return 'path';
  return 'minor';
}

const BUILDING_HEIGHTS = { house: 2, detached: 2, garage: 1, garages: 1, apartments: 5, residential: 4, commercial: 4, retail: 3, office: 5, industrial: 3, warehouse: 2, church: 12, cathedral: 15, chapel: 8, school: 3, hospital: 4, hotel: 5 };

function levelsOf(t) {
  const raw = parseFloat(t['building:levels']);
  const levels = Number.isFinite(raw) && raw > 0
    ? raw
    : (BUILDING_HEIGHTS[t.building] ?? 3);
  return Math.max(1, Math.min(30, Math.round(levels)));
}

// ── Сцена: разбор, обрезка, бюджет вершин ─────────────────────────────────

const MAX_VERTS = 22000;

function decimate(pts, max) {
  if (pts.length <= max) return pts;
  const out = [];
  const step = pts.length / max;
  for (let i = 0; i < max; i++) out.push(pts[Math.floor(i * step)]);
  return out;
}

function parseScene(elements, center, tier) {
  const scene = { demo: false, roads: [], areas: [], buildings: [], pois: [] };
  for (const el of elements || []) {
    if (!el || typeof el !== 'object') continue;
    const t = el.tags && typeof el.tags === 'object' ? el.tags : {};
    const osm = `${el.type}/${el.id}`;
    if (t.highway) {
      const pts = lineFrom(el);
      if (pts) scene.roads.push({ osm, name: t.name || '', cls: roadClass(t.highway), pts });
      continue;
    }
    if (t.waterway && !t.building) {
      // Русло реки — линия; riverbank/dock — уже площадь, её берём кольцом.
      const ring = ringsFrom(el, 1)[0];
      const line = lineFrom(el);
      if (ring && areaKind(t)) scene.areas.push({ osm, kind: 'water', name: t.name || '', ring });
      else if (line) scene.roads.push({ osm, name: t.name || '', cls: 'water', pts: line });
      continue;
    }
    if (t.building && !t['building:part'] && t.building !== 'no') {
      const ring = ringsFrom(el, 1)[0];
      if (ring) scene.buildings.push({ osm, levels: levelsOf(t), ring });
      continue;
    }
    const kind = areaKind(t);
    if (kind) {
      for (const ring of ringsFrom(el, 4)) scene.areas.push({ osm, kind, name: t.name || '', ring });
      continue;
    }
    const at = pointOf(el);
    if (!at) continue;
    const cat = classify(t, t.name);
    if (!cat) continue;
    scene.pois.push({
      osm, type: el.type, lat: at.lat, lon: at.lon, name: t.name,
      cat, tags: t, importance: importanceOf(t),
    });
  }
  return fitScene(scene, center, tier);
}

// Приведение к бюджету: ближнее важнее дальнего, крупное важнее мелкого,
// главные улицы важнее троп. Один и тот же проход обслуживает живой ответ и
// офлайн-демо, поэтому демо выглядит ровно так же, как живой район.
function fitScene(scene, center, tier) {
  const kx = 111320 * Math.cos((center.lat * Math.PI) / 180);
  const kz = 110540;
  const dist = (lat, lon) => Math.hypot((lon - center.lon) * kx, (lat - center.lat) * kz);
  const mid = (pts) => pts[pts.length >> 1];
  const lineDist = (pts) => { const [lat, lon] = mid(pts); return dist(lat, lon); };
  const ringDist = (ring) => {
    let sum = 0;
    for (const [lat, lon] of ring) sum += dist(lat, lon);
    return sum / ring.length;
  };
  const ringArea = (ring) => {
    let sum = 0;
    for (let i = 0; i < ring.length; i++) {
      const [alat, alon] = ring[i];
      const [blat, blon] = ring[(i + 1) % ring.length];
      const x1 = (alon - center.lon) * kx, y1 = (alat - center.lat) * kz;
      const x2 = (blon - center.lon) * kx, y2 = (blat - center.lat) * kz;
      sum += x1 * y2 - x2 * y1;
    }
    return Math.abs(sum) / 2;
  };

  scene.roads = scene.roads.filter((r) => lineDist(r.pts) <= tier.roadR * 1.15);
  scene.buildings = scene.buildings.filter((b) => ringDist(b.ring) <= tier.bldR * 1.1);
  scene.areas = scene.areas.filter((a) => ringDist(a.ring) <= tier.areaR * 1.25);
  scene.pois = scene.pois.filter((p) => dist(p.lat, p.lon) <= tier.poiR * 1.05);

  // Улицы: сперва главные. При обрезке первыми уходят самые дальние из самых
  // младших классов, поэтому центр всегда читается.
  const share = { major: 0.5, minor: 0.42, path: 0.16, water: 0.12 };
  const roads = [];
  for (const cls of ['major', 'minor', 'path', 'water']) {
    const list = scene.roads.filter((r) => r.cls === cls);
    list.sort((a, b) => lineDist(a.pts) - lineDist(b.pts));
    const keep = Math.max(10, Math.round(tier.roadMax * (share[cls] || 0.2)));
    for (const road of list.slice(0, keep)) {
      roads.push({ ...road, pts: decimate(road.pts, 24) });
    }
  }
  scene.roads = roads;

  scene.buildings = scene.buildings
    .map((b) => ({ ...b, area: ringArea(b.ring), dist: ringDist(b.ring) }))
    .filter((b) => b.area >= 30)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, tier.bldMax)
    .map((b) => ({ ...b, height: b.levels * 3.2, ring: decimate(b.ring, 16) }));

  scene.areas = scene.areas
    .map((a) => ({ ...a, area: ringArea(a.ring) }))
    .filter((a) => a.area >= 400)
    .sort((a, b) => b.area - a.area)
    .slice(0, tier.areaMax)
    .map((a) => ({ ...a, ring: decimate(a.ring, 48) }));

  scene.pois = scene.pois
    .map((p) => ({ ...p, dist: Math.round(dist(p.lat, p.lon)) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, tier.poiMax);

  trimScene(scene);
  return scene;
}

// Вершинный бюджет: каким бы щедрым ни был ответ, мобильный GPU получает
// не больше MAX_VERTS точек геометрии.
function trimScene(scene, budget = MAX_VERTS) {
  const layers = [['roads', 'pts'], ['buildings', 'ring'], ['areas', 'ring']];
  const sizes = layers.map(([key, field]) =>
    scene[key].reduce((sum, item) => sum + item[field].length, 0));
  let total = sizes.reduce((a, b) => a + b, 0);
  while (total > budget) {
    let idx = 0;
    for (let i = 1; i < layers.length; i++) if (sizes[i] > sizes[idx]) idx = i;
    const [key, field] = layers[idx];
    const dropped = scene[key].pop();
    if (!dropped) break;
    sizes[idx] -= dropped[field].length;
    total -= dropped[field].length;
  }
}

// ── Офлайн-квартал: Эрмитаж ───────────────────────────────────────────────

// Тот же контракт, что у живого ответа, но собранный вручную — по реальным
// координатам центра Петербурга. Нужен, когда публичные зеркала молчат:
// пользователь видит узнаваемый квартал, а не пустоту.
function demoScene() {
  const lat0 = DEMO_CENTER.lat, lon0 = DEMO_CENTER.lon;
  const roads = [
    { osm: 'way/900000001', name: 'Дворцовая набережная', cls: 'major', pts: [[59.9435, 30.3360], [59.9425, 30.3250], [59.9412, 30.3140], [59.9403, 30.3030], [59.9395, 30.2920]] },
    { osm: 'way/900000002', name: 'Невский проспект', cls: 'major', pts: [[59.9372, 30.3128], [59.9365, 30.3200], [59.9358, 30.3290], [59.9348, 30.3400], [59.9337, 30.3520]] },
    { osm: 'way/900000003', name: 'Гороховая улица', cls: 'major', pts: [[59.9375, 30.3090], [59.9360, 30.3160], [59.9340, 30.3230], [59.9320, 30.3300]] },
    { osm: 'way/900000004', name: 'Садовая улица', cls: 'major', pts: [[59.9330, 30.3020], [59.9320, 30.3130], [59.9308, 30.3240], [59.9300, 30.3350]] },
    { osm: 'way/900000005', name: 'Адмиралтейский проспект', cls: 'major', pts: [[59.9378, 30.3070], [59.9382, 30.3130], [59.9386, 30.3170]] },
    { osm: 'way/900000006', name: 'Большая Морская улица', cls: 'minor', pts: [[59.9370, 30.3080], [59.9360, 30.3170], [59.9352, 30.3240], [59.9342, 30.3320]] },
    { osm: 'way/900000007', name: 'Малая Морская улица', cls: 'minor', pts: [[59.9365, 30.3115], [59.9356, 30.3165], [59.9348, 30.3220]] },
    { osm: 'way/900000008', name: 'Миллионная улица', cls: 'minor', pts: [[59.9412, 30.3130], [59.9405, 30.3180], [59.9398, 30.3240], [59.9390, 30.3300]] },
    { osm: 'way/900000009', name: 'набережная реки Мойки', cls: 'minor', pts: [[59.9415, 30.3120], [59.9400, 30.3180], [59.9385, 30.3230], [59.9365, 30.3280], [59.9345, 30.3310]] },
    { osm: 'way/900000010', name: 'Дворцовая площадь', cls: 'minor', pts: [[59.9393, 30.3152], [59.9386, 30.3172], [59.9378, 30.3170], [59.9374, 30.3155], [59.9383, 30.3140], [59.9391, 30.3142], [59.9393, 30.3152]] },
    { osm: 'way/900000011', name: 'Галерная улица', cls: 'minor', pts: [[59.9350, 30.2940], [59.9355, 30.3010], [59.9360, 30.3080]] },
    { osm: 'way/900000012', name: 'Конногвардейский бульвар', cls: 'minor', pts: [[59.9340, 30.2930], [59.9345, 30.3010], [59.9350, 30.3090]] },
    { osm: 'way/900000013', name: 'Вознесенский проспект', cls: 'minor', pts: [[59.9378, 30.3060], [59.9355, 30.3110], [59.9330, 30.3160], [59.9300, 30.3210]] },
    { osm: 'way/900000014', name: 'Дворцовый мост', cls: 'minor', pts: [[59.9414, 30.3080], [59.9425, 30.3000], [59.9432, 30.2930]] },
    { osm: 'way/900000015', name: 'Троицкий мост', cls: 'minor', pts: [[59.9425, 30.3310], [59.9455, 30.3355], [59.9480, 30.3380]] },
    { osm: 'way/900000016', name: 'Певческий мост', cls: 'minor', pts: [[59.9392, 30.3178], [59.9395, 30.3210], [59.9399, 30.3230]] },
    { osm: 'way/900000017', name: 'река Мойка', cls: 'water', pts: [[59.9420, 30.3125], [59.9405, 30.3175], [59.9390, 30.3230], [59.9368, 30.3285], [59.9345, 30.3315], [59.9330, 30.3350]] },
    { osm: 'way/900000018', name: 'Зимняя канавка', cls: 'water', pts: [[59.9420, 30.3175], [59.9408, 30.3178], [59.9398, 30.3180]] },
    { osm: 'way/900000019', name: 'Лебяжья канавка', cls: 'water', pts: [[59.9436, 30.3340], [59.9443, 30.3358], [59.9440, 30.3372]] },
  ];
  const areas = [
    { osm: 'way/900002001', kind: 'water', name: 'река Нева', ring: [[59.9428, 30.2880], [59.9438, 30.3020], [59.9450, 30.3130], [59.9465, 30.3250], [59.9480, 30.3360], [59.9500, 30.3420], [59.9530, 30.3330], [59.9515, 30.3200], [59.9500, 30.3050], [59.9475, 30.2920], [59.9448, 30.2840]] },
    { osm: 'way/900002002', kind: 'water', name: 'Лебяжья канавка', ring: [[59.9432, 30.3345], [59.9444, 30.3362], [59.9441, 30.3376], [59.9429, 30.3358]] },
    { osm: 'way/900002003', kind: 'green', name: 'Александровский сад', ring: [[59.9378, 30.3088], [59.9372, 30.3136], [59.9358, 30.3132], [59.9363, 30.3086]] },
    { osm: 'way/900002004', kind: 'green', name: 'Марсово поле', ring: [[59.9425, 30.3300], [59.9420, 30.3355], [59.9405, 30.3350], [59.9410, 30.3295]] },
    { osm: 'way/900002005', kind: 'green', name: 'Летний сад', ring: [[59.9455, 30.3320], [59.9450, 30.3380], [59.9430, 30.3375], [59.9435, 30.3315]] },
    { osm: 'way/900002006', kind: 'green', name: 'Михайловский сад', ring: [[59.9390, 30.3310], [59.9385, 30.3350], [59.9372, 30.3345], [59.9378, 30.3308]] },
    { osm: 'way/900002007', kind: 'green', name: 'Исаакиевский сквер', ring: [[59.9348, 30.3040], [59.9344, 30.3082], [59.9332, 30.3078], [59.9336, 30.3036]] },
  ];
  // Ручные контуры знаковых корпусов: сетка кварталов их не трогает.
  const named = [
    { lat: [59.9392, 59.9405], lon: [30.3131, 30.3166], levels: 4 },   // Эрмитаж
    { lat: [59.9358, 59.9367], lon: [30.3111, 30.3188], levels: 4 },   // Главный штаб
    { lat: [59.9367, 59.9390], lon: [30.3182, 30.3190], levels: 4 },   // восточное крыло
    { lat: [59.9338, 59.9352], lon: [30.3010, 30.3072], levels: 3 },   // Сенат и Синод
    { lat: [59.9366, 59.9384], lon: [30.3055, 30.3122], levels: 3 },   // Адмиралтейство
    { lat: [59.9335, 59.9350], lon: [30.3228, 30.3264], levels: 4 },   // Казанский собор
    { lat: [59.9335, 59.9350], lon: [30.3045, 30.3080], levels: 4 },   // Исаакиевский собор
    { lat: [59.9393, 59.9408], lon: [30.3275, 30.3307], levels: 4 },   // Спас на Крови
    { lat: [59.9398, 59.9414], lon: [30.3360, 30.3397], levels: 4 },   // Михайловский замок
    { lat: [59.9383, 59.9397], lon: [30.3305, 30.3337], levels: 3 },   // Русский музей
    { lat: [59.9359, 59.9372], lon: [30.3250, 30.3272], levels: 5 },   // Дом Зингера
  ];
  const buildings = [];
  let n = 0;
  for (const b of named) {
    n += 1;
    buildings.push({ osm: `way/${900010000 + n}`, levels: b.levels, ring: boxRing(b.lat, b.lon) });
  }

  // Сетка кварталов: улицы идут между корпусами, как в городе. Из сетки
  // выпадают вода, площади, сады и контуры уже поставленных зданий.
  const boxes = [
    [[59.9422, 59.9620], [30.2800, 30.3600]],  // Нева
    [[59.9366, 59.9398], [30.3136, 30.3180]],  // Дворцовая площадь
    [[59.9352, 59.9384], [30.3082, 30.3142]],  // Александровский сад
    [[59.9400, 59.9434], [30.3288, 30.3360]],  // Марсово поле
    [[59.9425, 59.9460], [30.3310, 30.3388]],  // Летний сад
    [[59.9368, 59.9394], [30.3305, 30.3352]],  // Михайловский сад
    [[59.9328, 59.9358], [30.3030, 30.3085]],  // Исаакиевский сквер
  ];
  for (const b of named) {
    boxes.push([
      [b.lat[0] - 0.0002, b.lat[1] + 0.0002],
      [b.lon[0] - 0.0003, b.lon[1] + 0.0003],
    ]);
  }
  const moika = roads.find((r) => r.name === 'река Мойка').pts;
  const dLat = 0.0009, dLon = 0.0015;
  for (let i = 0; i * dLat + 59.9300 <= 59.9425; i++) {
    for (let j = 0; j * dLon + 30.2990 <= 30.3420; j++) {
      const lat = 59.9300 + i * dLat;
      const lon = 30.2990 + j * dLon;
      if (boxes.some(([[a, b], [c, d]]) => lat >= a && lat <= b && lon >= c && lon <= d)) continue;
      if (nearPolyline(lat, lon, moika, 35)) continue;
      const r = hash2(i, j);
      if (r < 0.14) continue;                     // разрывы в застройке
      const ha = dLat * (0.26 + r * 0.06);
      const hb = dLon * (0.26 + r * 0.06);
      const cy = lat + (hash2(i + 7, j) - 0.5) * dLat * 0.12;
      const cx = lon + (hash2(i, j + 7) - 0.5) * dLon * 0.12;
      n += 1;
      buildings.push({
        osm: `way/${900010000 + n}`,
        levels: 3 + Math.floor(hash2(i + 3, j + 5) * 5),
        ring: boxRing([cy - ha, cy + ha], [cx - hb, cx + hb]),
      });
    }
  }

  const pois = [
    { osm: 'way/900020001', name: 'Эрмитаж', cat: 'museum', lat: 59.9399, lon: 30.3148, tags: { tourism: 'museum', building: 'yes', wikidata: 'Q132783' } },
    { osm: 'node/900020002', name: 'Александровская колонна', cat: 'monument', lat: 59.9390, lon: 30.3160, tags: { historic: 'monument', man_made: 'obelisk', heritage: '2' } },
    { osm: 'way/900020003', name: 'Дворцовая площадь', cat: 'sight', lat: 59.9387, lon: 30.3160, tags: { place: 'square', wikidata: 'Q1072354' } },
    { osm: 'way/900020004', name: 'Александровский сад', cat: 'nature', lat: 59.9368, lon: 30.3112, tags: { leisure: 'park' } },
    { osm: 'node/900020005', name: 'Медный всадник', cat: 'monument', lat: 59.9364, lon: 30.3022, tags: { historic: 'monument', tourism: 'artwork' } },
    { osm: 'way/900020006', name: 'Исаакиевский собор', cat: 'religious', lat: 59.9342, lon: 30.3062, tags: { amenity: 'place_of_worship', building: 'cathedral', religion: 'christian' } },
    { osm: 'way/900020007', name: 'Казанский собор', cat: 'religious', lat: 59.9343, lon: 30.3245, tags: { amenity: 'place_of_worship', building: 'cathedral', heritage: '2' } },
    { osm: 'way/900020008', name: 'Дом компании «Зингер»', cat: 'heritage', lat: 59.9359, lon: 30.3265, tags: { building: 'commercial', heritage: '2' } },
    { osm: 'way/900020009', name: 'Адмиралтейство', cat: 'heritage', lat: 59.9374, lon: 30.3086, tags: { historic: 'building', building: 'yes', wikidata: 'Q130209' } },
    { osm: 'way/900020010', name: 'Генеральный штаб', cat: 'heritage', lat: 59.9363, lon: 30.3150, tags: { historic: 'building', building: 'yes' } },
    { osm: 'way/900020011', name: 'Русский музей', cat: 'museum', lat: 59.9389, lon: 30.3320, tags: { tourism: 'museum', building: 'yes' } },
    { osm: 'way/900020012', name: 'Спас на Крови', cat: 'religious', lat: 59.9400, lon: 30.3290, tags: { amenity: 'place_of_worship', building: 'church' } },
    { osm: 'node/900020013', name: 'Стрелка Васильевского острова', cat: 'sight', lat: 59.9439, lon: 30.3060, tags: { tourism: 'attraction' } },
    { osm: 'way/900020014', name: 'Михайловский замок', cat: 'heritage', lat: 59.9405, lon: 30.3377, tags: { historic: 'castle', building: 'yes' } },
    { osm: 'way/900020015', name: 'Летний сад', cat: 'nature', lat: 59.9442, lon: 30.3352, tags: { leisure: 'garden' } },
    { osm: 'node/900020016', name: 'Марсово поле', cat: 'nature', lat: 59.9415, lon: 30.3320, tags: { leisure: 'park' } },
    { osm: 'node/900020017', name: 'Памятник Николаю I', cat: 'monument', lat: 59.9345, lon: 30.3035, tags: { historic: 'monument' } },
    { osm: 'way/900020018', name: 'Здание Сената и Синода', cat: 'heritage', lat: 59.9344, lon: 30.3035, tags: { historic: 'building', building: 'yes' } },
    { osm: 'node/900020019', name: 'Памятник Екатерине II', cat: 'monument', lat: 59.9334, lon: 30.3361, tags: { historic: 'monument' } },
    { osm: 'way/900020020', name: 'Петрикирхе', cat: 'religious', lat: 59.9363, lon: 30.3228, tags: { amenity: 'place_of_worship', building: 'church' } },
    { osm: 'way/900020021', name: 'Михайловский сад', cat: 'nature', lat: 59.9382, lon: 30.3328, tags: { leisure: 'garden' } },
    { osm: 'node/900020022', name: 'Певческий мост', cat: 'sight', lat: 59.9392, lon: 30.3178, tags: { tourism: 'attraction' } },
    { osm: 'way/900020023', name: 'Миллионная улица, 5', cat: 'heritage', lat: 59.9404, lon: 30.3172, tags: { historic: 'building', building: 'yes' } },
    { osm: 'node/900020024', name: 'Исаакиевский сквер', cat: 'nature', lat: 59.9341, lon: 30.3058, tags: { leisure: 'garden' } },
  ].map((p) => ({ ...p, type: p.osm.split('/')[0], importance: importanceOf(p.tags) }));

  return { demo: true, roads, areas, buildings, pois };
}

function boxRing(lat, lon) {
  const [a, b] = lat, [c, d] = lon;
  return [[a, c], [a, d], [b, d], [b, c]];
}

// Детерминированный «шум»: демо-квартал не должен меняться между кадрами.
function hash2(i, j) {
  const s = Math.sin(i * 12.9898 + j * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

// Расстояние от точки до полилинии в метрах — сетка кварталов не залезает
// на набережные.
function nearPolyline(lat, lon, pts, metres) {
  const kx = 111320 * Math.cos((DEMO_CENTER.lat * Math.PI) / 180);
  const px = (lon - DEMO_CENTER.lon) * kx, py = (lat - DEMO_CENTER.lat) * 110540;
  for (let i = 1; i < pts.length; i++) {
    const ax = (pts[i - 1][1] - DEMO_CENTER.lon) * kx, ay = (pts[i - 1][0] - DEMO_CENTER.lat) * 110540;
    const bx = (pts[i][1] - DEMO_CENTER.lon) * kx, by = (pts[i][0] - DEMO_CENTER.lat) * 110540;
    const dx = bx - ax, dy = by - ay;
    const len = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len));
    if (Math.hypot(px - (ax + dx * t), py - (ay + dy * t)) < metres) return true;
  }
  return false;
}

// ── Геометрия слоёв ───────────────────────────────────────────────────────

const AREA_Y = 8;    // метры карты: заливки над подложкой, без z-fighting
const ROAD_Y = 18;   // метры карты: линии поверх заливок
const ROAD_STYLE = { major: 0x9ff0ff, minor: 0x3d7f9f, path: 0x1b3b4d, water: 0x6ecbff };
const BUILDING_STYLE = [
  { max: 2, side: 0x0b1a2a, top: 0x1b3d57 },
  { max: 4, side: 0x0e2334, top: 0x22506f },
  { max: 7, side: 0x122c42, top: 0x2a6386 },
  { max: Infinity, side: 0x173851, top: 0x3379a3 },
];
const AREA_STYLE = { water: 0x0d4570, green: 0x123c26 };

function buildingStyle(levels) {
  return BUILDING_STYLE.find((s) => levels <= s.max);
}

// Улицы, русла и водные линии — один LineSegments с цветом на вершине:
// иерархия (главные/второстепенные/тропы/вода) видна, а draw call один.
function roadGeometry(scene, project) {
  const positions = [];
  const colors = [];
  const color = new THREE.Color();
  for (const road of scene.roads) {
    color.setHex(ROAD_STYLE[road.cls] ?? ROAD_STYLE.minor);
    const pts = road.pts.map(([lat, lon]) => project(lat, lon));
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      positions.push(a.x, ROAD_Y, a.z, b.x, ROAD_Y, b.z);
      colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return geo;
}

// Заливки воды и зелени: ShapeGeometry (earcut) корректно триангулирует
// вогнутые контуры вроде русла Невы, в отличие от веера из центроида.
function areaGeometry(scene, project, kind) {
  const parts = [];
  for (const area of scene.areas) {
    if (area.kind !== kind) continue;
    const pts = area.ring.map(([lat, lon]) => project(lat, lon));
    const shape = new THREE.Shape(pts.map((p) => new THREE.Vector2(p.x, p.z)));
    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(Math.PI / 2);
    geo.translate(0, AREA_Y + (kind === 'water' ? 0 : 1), 0);
    parts.push(geo);
  }
  if (!parts.length) return null;
  return mergeGeometries(parts, false);
}

// Корпуса: призмы с настоящей высотой. Крышка строится через ShapeGeometry
// (вогнутые дворы не ломаются), боковины — квады по контуру. Цвет вершины
// кодирует высоту: чем выше этажность, тем светлее верх — так силуэт читается
// без освещения и без единой текстуры.
function buildingGeometry(scene, project) {
  const positions = [];
  const colors = [];
  const side = new THREE.Color();
  const top = new THREE.Color();
  const push = (color, ...verts) => {
    for (const v of verts) {
      positions.push(v[0], v[1], v[2]);
      colors.push(color.r, color.g, color.b);
    }
  };
  for (const building of scene.buildings) {
    const ring = building.ring.map(([lat, lon]) => project(lat, lon));
    const h = building.height;
    const style = buildingStyle(building.levels);
    side.setHex(style.side);
    top.setHex(style.top);
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const a = ring[i], b = ring[(i + 1) % n];
      push(side, [a.x, 0, a.z], [b.x, 0, b.z], [b.x, h, b.z]);
      push(side, [a.x, 0, a.z], [b.x, h, b.z], [a.x, h, a.z]);
    }
    const shape = new THREE.Shape(ring.map((p) => new THREE.Vector2(p.x, p.z)));
    const indexedCap = new THREE.ShapeGeometry(shape);
    // ShapeGeometry is indexed. Appending its raw position array loses the
    // triangle index and connects unrelated polygon vertices into the broken
    // fan seen on phones. Flatten the index before merging into our buffers.
    const cap = indexedCap.index ? indexedCap.toNonIndexed() : indexedCap;
    cap.rotateX(Math.PI / 2);
    cap.translate(0, h, 0);
    const pos = cap.getAttribute('position');
    const col = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      col[i * 3] = top.r; col[i * 3 + 1] = top.g; col[i * 3 + 2] = top.b;
    }
    positions.push(...pos.array);
    colors.push(...col);
    if (cap !== indexedCap) indexedCap.dispose();
    cap.dispose();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return geo;
}

// Настоящий голографический материал: форма остаётся читаемой, но здания
// полупрозрачны, светятся по краям и сканируются горизонтальной строкой.
function buildingHologramMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */`
      attribute vec3 color;
      varying vec3 vColor;
      varying vec3 vNormal;
      varying vec3 vView;
      varying float vHeight;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vColor = color;
        vNormal = normalize(normalMatrix * normal);
        vView = normalize(-mv.xyz);
        vHeight = position.y;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime;
      varying vec3 vColor;
      varying vec3 vNormal;
      varying vec3 vView;
      varying float vHeight;
      void main() {
        float edge = pow(1.0 - abs(dot(normalize(vNormal), normalize(vView))), 1.7);
        float scan = pow(max(0.0, sin(vHeight * 0.72 - uTime * 2.2)), 18.0);
        float pulse = 0.82 + 0.18 * sin(uTime * 0.8);
        vec3 glow = vColor * (0.72 + edge * 1.8 + scan * 1.35) * pulse;
        float alpha = 0.16 + edge * 0.3 + scan * 0.42;
        gl_FragColor = vec4(glow, alpha);
      }`,
  });
}

// Знаки мест: у каждой категории своя форма — ступенчатая пирамида наследия,
// низкий обелиск памятника, купол с крестом, октаэдр музея, мачта с кольцом
// достопримечательности, плоская крона природы. Размеры в метрах сцены.
const U = 0.03;
function glyphGeometry(cat) {
  const parts = [];
  const add = (geo, x, y, z) => {
    // BufferGeometryUtils rejects a mixture of indexed primitives (boxes,
    // cylinders, spheres) and non-indexed ones (octahedron). Normalize every
    // part before merging so one landmark category cannot break the scene.
    const part = geo.index ? geo.toNonIndexed() : geo;
    if (part !== geo) geo.dispose();
    part.translate(x, y, z);
    parts.push(part);
    return part;
  };
  if (cat === 'heritage') {
    add(new THREE.BoxGeometry(0.62 * U, 0.26 * U, 0.62 * U), 0, 0.13 * U, 0);
    add(new THREE.BoxGeometry(0.42 * U, 0.52 * U, 0.42 * U), 0, 0.52 * U, 0);
    add(new THREE.BoxGeometry(0.2 * U, 0.64 * U, 0.2 * U), 0, 1.1 * U, 0);
  } else if (cat === 'monument') {
    add(new THREE.BoxGeometry(0.56 * U, 0.16 * U, 0.56 * U), 0, 0.08 * U, 0);
    add(new THREE.CylinderGeometry(0.1 * U, 0.3 * U, 0.66 * U, 4), 0, 0.49 * U, 0);
  } else if (cat === 'religious') {
    add(new THREE.BoxGeometry(0.5 * U, 0.14 * U, 0.5 * U), 0, 0.07 * U, 0);
    add(new THREE.CylinderGeometry(0.2 * U, 0.24 * U, 0.6 * U, 8), 0, 0.44 * U, 0);
    const dome = new THREE.SphereGeometry(0.27 * U, 10, 8);
    dome.scale(1, 1.35, 1);
    add(dome, 0, 0.84 * U, 0);
    add(new THREE.CylinderGeometry(0.04 * U, 0.04 * U, 0.34 * U, 6), 0, 1.22 * U, 0);
    add(new THREE.BoxGeometry(0.16 * U, 0.035 * U, 0.035 * U), 0, 1.3 * U, 0);
  } else if (cat === 'museum') {
    add(new THREE.BoxGeometry(0.6 * U, 0.16 * U, 0.6 * U), 0, 0.08 * U, 0);
    add(new THREE.OctahedronGeometry(0.4 * U), 0, 0.62 * U, 0);
  } else if (cat === 'sight') {
    add(new THREE.CylinderGeometry(0.06 * U, 0.09 * U, 1.5 * U, 6), 0, 0.75 * U, 0);
    const ring = new THREE.TorusGeometry(0.32 * U, 0.075 * U, 6, 16);
    ring.rotateX(Math.PI / 2);
    add(ring, 0, 1.5 * U, 0);
  } else {
    add(new THREE.CylinderGeometry(0.06 * U, 0.08 * U, 0.3 * U, 6), 0, 0.15 * U, 0);
    add(new THREE.CylinderGeometry(0.44 * U, 0.44 * U, 0.16 * U, 6), 0, 0.38 * U, 0);
  }
  return mergeGeometries(parts, false);
}

// ── Опыт ──────────────────────────────────────────────────────────────────

class CityOrbit extends xb.Script {
  init() {
    // Вся геометрия — unlit MeshBasicMaterial: голограмма не зависит от
    // освещения сцены, поэтому источников света здесь нет.
    this.group = new THREE.Group();
    this.add(this.group);
    this.base = new THREE.Mesh(
      new THREE.CircleGeometry(0.6, 48),
      new THREE.MeshBasicMaterial({ color: 0x0e2c44, transparent: true, opacity: 0.75 })
    );
    this.base.rotation.x = -Math.PI / 2;
    this.base.xb = { pointerEvents: 'none' };
    this.group.add(this.base);
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.585, 0.6, 64),
      new THREE.MeshBasicMaterial({ color: PALETTES.city[1], transparent: true, opacity: 0.9, side: THREE.DoubleSide })
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.xb = { pointerEvents: 'none' };
    this.group.add(this.ring);

    // Центр города = ты: столбик с пульсирующим кольцом.
    this.you = new THREE.Mesh(
      new THREE.CylinderGeometry(0.005, 0.005, 0.07, 8),
      new THREE.MeshBasicMaterial({ color: 0xffffff })
    );
    this.you.position.set(0, 0.035, 0);
    this.group.add(this.you);
    this.youRing = new THREE.Mesh(
      new THREE.RingGeometry(0.05, 0.058, 32),
      new THREE.MeshBasicMaterial({ color: PALETTES.city[2], transparent: true, opacity: 0.8, side: THREE.DoubleSide })
    );
    this.youRing.rotation.x = -Math.PI / 2;
    this.youRing.position.y = 0.002;
    this.group.add(this.youRing);

    // Карта (масштабируется одной матрицей) и знаки мест (фиксированный размер).
    this.map = new THREE.Group();
    this.group.add(this.map);
    this.poiGroup = new THREE.Group();
    this.group.add(this.poiGroup);
    this.glyphMeshes = [];
    this.glyphIndex = new Map();
    this.poiList = [];

    // карточка места
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
    this.scene = null;
    this.cache = new Map();    // ключ lat,lon,r → {scene, via}
    this.selected = null;
    this.k = 1;
    this.pulse = 1;
    this._o = new THREE.Vector3();
    this._ray = new THREE.Ray();
    this._v = new THREE.Vector3();
    this._handA = new THREE.Vector3();
    this._handB = new THREE.Vector3();
    this._matrix = new THREE.Matrix4();
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

    this.hud = makeHud({
      title: 'CITY//ORBIT',
      stat: 'LOCATING…',
      buttons: [
        {id: 'geo', label: 'LOCATE', onTap: () => this.locate()},
        {
          id: 'mode', label: 'TABLE / 360',
          onTap: () => { this.mode = this.mode === 'table' ? 'orbit' : 'table'; this.applyScale(); this.layout(); },
        },
        {id: 'radius', label: 'RADIUS', onTap: () => this.setRadius((this.radiusIdx + 1) % RADII.length)},
      ],
    });
    this.add(this.hud.card);
    this.setRadius(this.radiusIdx, false);
    this.layout();
    this.locate();
  }

  stat(s) { this.hud.setStat(s); }

  get tier() { return TIERS[this.radiusIdx]; }

  get span() { return this.mode === 'table' ? 1.2 : 7; }

  locate() {
    if (!navigator.geolocation) return this.load(this.lat, this.lon);
    this.stat('LOCATING…');
    navigator.geolocation.getCurrentPosition(
      (p) => {
        this.lat = +p.coords.latitude.toFixed(4);
        this.lon = +p.coords.longitude.toFixed(4);
        this.load(this.lat, this.lon);
      },
      () => this.load(this.lat, this.lon),
      { timeout: 6000 }
    );
  }

  setRadius(index, reload = true) {
    this.radiusIdx = index;
    this.hud.setLabel('radius', `R ${RADII[index] >= 1000 ? `${RADII[index] / 1000} km` : `${RADII[index]} m`}`);
    if (reload && this.center) this.load(this.lat, this.lon);
  }

  describe(scene, prefix) {
    return `${prefix} · ${scene.roads.length} улиц · ${scene.buildings.length} домов`
      + ` · ${scene.pois.length} мест`;
  }

  // Сначала кэш, потом живой Overpass. Пока зеркала думают, на столе уже
  // стоит демо-квартал — опыт начинается сразу и не мигает пустотой.
  async load(lat, lon) {
    this.lat = lat; this.lon = lon;
    const r = RADII[this.radiusIdx];
    const tier = this.tier;
    const key = `${lat.toFixed(3)},${lon.toFixed(3)},${r}`;
    if (this.cache.has(key)) {
      const got = this.cache.get(key);
      this.center = { lat, lon };
      this._via = got.via;
      this.build(got.scene);
      this.stat(this.describe(got.scene, `live · ${r} m · ${new URL(got.via).host}`));
      return;
    }
    if (!this.scene) this.showDemo('demo-quarter', 'demo quarter · Hermitage · waiting for live …');
    else this.stat(`overpass · ${lat.toFixed(4)}, ${lon.toFixed(4)} · waiting …`);
    const started = performance.now();
    try {
      const { json, via } = await overpass(sceneQuery(lat, lon, tier));
      const scene = parseScene(json.elements, { lat, lon }, tier);
      if (!this.meaningful(scene)) throw new Error('пустой ответ');
      this.cache.set(key, { scene, via });
      this.center = { lat, lon };
      this._via = via;
      this.build(scene);
      this.stat(this.describe(scene, `live · ${r} m · ${new URL(via).host}`));
    } catch (e) {
      // Быстрый отказ — это отвергнутый запрос, и есть смысл попробовать
      // короткий «только POI». Медленный — это сеть: второй раз не ждём.
      if (performance.now() - started < 8000) {
        cooldownUntil.clear();
        try {
          const { json, via } = await overpass(poiQuery(lat, lon, tier));
          const scene = parseScene(json.elements, { lat, lon }, tier);
          if (scene.pois.length) {
            this.cache.set(key, { scene, via });
            this.center = { lat, lon };
            this._via = via;
            this.build(scene);
            this.stat(this.describe(scene, `live · ${r} m · POI only · ${new URL(via).host}`));
            return;
          }
          throw new Error('no POIs');
        } catch (e2) {
          this.showDemo('offline-demo', `offline demo · Hermitage (${e2.message})`);
          return;
        }
      }
      if (this.scene && !this.scene.demo) {
        this.stat(`live unavailable (${e.message}) · keeping shown quarter`);
      } else {
        this.showDemo('offline-demo', `offline demo (${e.message}) · Hermitage`);
      }
    }
  }

  meaningful(scene) {
    return scene.roads.length + scene.buildings.length + scene.areas.length + scene.pois.length > 12;
  }

  showDemo(via, text) {
    const scene = fitScene(demoScene(), DEMO_CENTER, this.tier);
    this.center = DEMO_CENTER;
    this._via = via;
    this.build(scene);
    this.stat(`${text} · ${scene.roads.length} roads · ${scene.buildings.length} buildings · ${scene.pois.length} places`);
  }

  project(lat, lon) {
    // метры от центра: x — восток, z — юг (−z = север)
    const kx = 111320 * Math.cos(this.center.lat * Math.PI / 180);
    return { x: (lon - this.center.lon) * kx, z: -(lat - this.center.lat) * 110540 };
  }

  clearLayers() {
    for (const root of [this.map, this.poiGroup]) {
      for (const child of [...root.children]) {
        root.remove(child);
        child.geometry?.dispose?.();
        child.material?.dispose?.();
      }
    }
    this.glyphMeshes = [];
    this.glyphIndex = new Map();
    this.poiList = [];
    this.buildingMaterial = null;
  }

  build(scene) {
    this.clearLayers();
    this.scene = scene;
    this.selected = null;
    this.card.visible = false;
    const project = (lat, lon) => this.project(lat, lon);

    const roadGeo = roadGeometry(scene, project);
    if (roadGeo.getAttribute('position').count) {
      const roads = new THREE.LineSegments(roadGeo, new THREE.LineBasicMaterial({
        vertexColors: true, transparent: true, opacity: 0.95,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      roads.renderOrder = 1;
      roads.xb = { pointerEvents: 'none' };
      this.map.add(roads);
    } else {
      roadGeo.dispose();
    }

    for (const kind of ['water', 'green']) {
      const geo = areaGeometry(scene, project, kind);
      if (!geo) continue;
      const areas = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: AREA_STYLE[kind], transparent: true, opacity: kind === 'water' ? 0.85 : 0.7,
        side: THREE.DoubleSide, depthWrite: false,
      }));
      areas.renderOrder = 0;
      areas.xb = { pointerEvents: 'none' };
      this.map.add(areas);
    }

    const bldGeo = buildingGeometry(scene, project);
    if (bldGeo.getAttribute('position').count) {
      this.buildingMaterial = buildingHologramMaterial();
      const buildings = new THREE.Mesh(bldGeo, this.buildingMaterial);
      buildings.renderOrder = 2;
      buildings.xb = { pointerEvents: 'none' };
      this.map.add(buildings);
    } else {
      bldGeo.dispose();
    }

    // Знаки мест: по одному InstancedMesh на категорию — шесть draw call'ов
    // вместо сотни мешей, и при этом у каждой категории своя форма и цвет.
    for (const [cat, meta] of Object.entries(CATEGORIES)) {
      const pois = scene.pois.filter((p) => p.cat === cat);
      if (!pois.length) continue;
      for (const poi of pois) {
        const at = project(poi.lat, poi.lon);
        poi.mx = at.x;
        poi.mz = at.z;
      }
      const mesh = new THREE.InstancedMesh(
        glyphGeometry(cat),
        new THREE.MeshBasicMaterial({ color: meta.color }),
        pois.length
      );
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.userData.category = cat;
      this.glyphIndex.set(mesh, { cat, pois, meta });
      this.glyphMeshes.push({ mesh, pois, meta, cat });
      for (const poi of pois) this.poiList.push(poi);
      this.poiGroup.add(mesh);
    }

    this.applyScale();
    this.layout();
  }

  // Масштаб карты и позиции знаков. Смена режима стол/360° и радиуса — это
  // только эта функция: геометрия слоёв остаётся в метрах и не пересобирается.
  applyScale() {
    this.k = this.span / (2 * RADII[this.radiusIdx]);
    this.map.scale.setScalar(this.k);
    for (const poi of this.poiList) {
      poi.x = poi.mx * this.k;
      poi.z = poi.mz * this.k;
    }
    this.placeGlyphs();
  }

  placeGlyphs() {
    for (const entry of this.glyphMeshes) {
      for (let i = 0; i < entry.pois.length; i++) this.placeGlyph(entry, i);
      entry.mesh.instanceMatrix.needsUpdate = true;
      entry.mesh.computeBoundingSphere();
    }
  }

  placeGlyph(entry, index) {
    const poi = entry.pois[index];
    const scale = poi.importance * (this.selected === poi ? this.pulse : 1);
    this._matrix.makeScale(scale, scale, scale);
    this._matrix.setPosition(poi.x, 0, poi.z);
    entry.mesh.setMatrixAt(index, this._matrix);
  }

  // Пульс только у выбранного знака: переписывать все матрицы каждый кадр
  // незачем.
  placeSelected() {
    if (!this.selected) return;
    for (const entry of this.glyphMeshes) {
      const index = entry.pois.indexOf(this.selected);
      if (index < 0) continue;
      this.placeGlyph(entry, index);
      entry.mesh.instanceMatrix.needsUpdate = true;
      return;
    }
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
    this.you.position.set(0, 0.035, 0);
  }

  // Выбор места. Сначала то, что уже разрешил XR Blocks (луч контроллера,
  // взгляд, тап по экрану телефона, мышь в симуляторе): у события есть и
  // объект, и точка попадания. Если попадания нет — свой луч: контроллер,
  // затем центр камеры (прицел), и ближайший знак вдоль луча. Без этого на
  // телефоне без контроллера карточка не открывалась вовсе.
  resolvePick(event) {
    const hit = event?.intersection;
    const owner = hit?.object || event?.target;
    if (owner && this.glyphIndex.has(owner)) {
      const entry = this.glyphIndex.get(owner);
      const index = Number.isInteger(hit?.instanceId) ? hit.instanceId : -1;
      if (entry.pois[index]) return entry.pois[index];
      if (hit?.point) {
        const near = this.nearestToPoint(hit.point);
        if (near) return near;
      }
    }
    if (owner) return null;   // луч попал в служебный объект/панель — молчим

    const ray = this._ray;
    try {
      xb.user.getRay(0, ray);
      if (ray.direction.lengthSq() > 0.5) {
        const poi = this.pickAlong(ray.origin, ray.direction);
        if (poi) return poi;
      }
    } catch { /* на телефоне контроллера нет */ }
    const cam = xb.core.camera;
    cam.getWorldPosition(this._o);
    cam.getWorldDirection(ray.direction);
    return this.pickAlong(this._o, ray.direction);
  }

  pickAlong(origin, direction) {
    const ray = this._ray.set(origin, direction);
    this.raycaster = this.raycaster || new THREE.Raycaster();
    this.raycaster.set(ray.origin, ray.direction);
    this.raycaster.far = 20;
    const hits = this.raycaster.intersectObjects(this.glyphMeshes.map((e) => e.mesh), false);
    if (hits.length) {
      const entry = this.glyphIndex.get(hits[0].object);
      const poi = entry?.pois[hits[0].instanceId];
      if (poi) return poi;
    }
    // Знаки мелкие: если точного попадания нет, берём ближайший к лучу.
    let best = null;
    let bestT = Infinity;
    const v = this._v;
    for (const poi of this.poiList) {
      v.set(poi.x, 0, poi.z).sub(origin);
      const t = v.dot(direction);
      if (t <= 0.02) continue;
      const perp = Math.sqrt(Math.max(0, v.lengthSq() - t * t));
      if (perp > Math.max(0.03, t * 0.09) || t >= bestT) continue;
      bestT = t;
      best = poi;
    }
    return best;
  }

  nearestToPoint(point) {
    let best = null;
    let bestD = Infinity;
    for (const poi of this.poiList) {
      const d = Math.hypot(poi.x - point.x, poi.z - point.z);
      if (d < bestD) { bestD = d; best = poi; }
    }
    return best && bestD < 0.12 ? best : null;
  }

  onSelectEnd(event) {
    if (this.hud.owns(event?.target)) return;
    const poi = this.resolvePick(event);
    if (!poi) {
      this.card.visible = false;
      this.selected = null;
      this.pulse = 1;
      this.placeGlyphs();
      return;
    }
    this.selected = poi;
    const meta = CATEGORIES[poi.cat];
    this.cardTitle.text = poi.name;
    const parts = [meta.label, `${poi.dist} m`, poi.osm];
    if (poi.tags?.heritage) parts.push(`heritage ${poi.tags.heritage}`);
    if (this.scene?.demo || String(this._via).includes('demo')) parts.push('demo');
    this.cardBody.text = parts.join(' · ');
    this.card.visible = true;
    this.placeGlyphs();
  }

  update() {
    this.ring.material.opacity = 0.6 + 0.3 * Math.sin(performance.now() * 0.003);
    this.youRing.scale.setScalar(1 + 0.12 * Math.sin(performance.now() * 0.004));
    if (this.buildingMaterial) {
      this.buildingMaterial.uniforms.uTime.value = performance.now() * 0.001;
    }
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
          this.stat(`scale -> ${RADII[this.radiusIdx]} m`);
          return;
        }
        this._prevPinchDist = d;
      } catch { /* одна рука / десктоп */ }
    } else {
      this._prevPinchDist = 0;
    }
    if (this.selected) {
      this.pulse = 1.35 + Math.sin(performance.now() * 0.008) * 0.18;
      this.placeSelected();
    }
  }

  dispose() {
    this.card.dispose?.();
    this.clearLayers();
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
options.setAppDescription('OSM-голограмма твоих окрестностей: улицы, корпуса, вода и места. Тап — карточка, две руки — масштаб.');

enableAutomation(options);
installXrGuards();

document.addEventListener('DOMContentLoaded', () => {
  xb.add(new CityOrbit());
  xb.init(options);
  watchXrButton();
});
