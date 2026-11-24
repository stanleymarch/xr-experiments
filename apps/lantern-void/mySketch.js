/*
 * LANTERN // VOID — практическая работа № 1 / «Крик без адресата»
 * p5.js 2.4.0 + A-Frame 1.8.0. Вся работа — три файла: index.html, mySketch.js, style.css.
 *
 * ЧТО ЭТО. Маленькая генеративная экология: десять «вычислительных тел» обмениваются
 * импульсами, у которых нет адресата. Правила предложены языковой моделью заранее;
 * во время работы опыта обращений к ней нет — последствия правил исполняет этот код.
 *
 * КАК УСТРОЕН ФАЙЛ. Разделы идут от правил к картинке:
 *   01 ПРАВИЛА        числа и операторы, по которым живёт мир
 *   02 МИР            создание мира по seed, шаг симуляции, импульсы
 *   03 СОСТОЯНИЕ      общее состояние опыта и отладка из консоли
 *   04 ЯЗЫК           словарь интерфейса RU/EN
 *   05 ХОЛСТ          холст p5, такт и запасной режим без p5
 *   06 ПЛОСКИЙ ВИД    2D-рисование тел, связей и поля на экране
 *   07 ИНТЕРФЕЙС      пролог, режимы наблюдения, инспектор, правила, звук
 *   08 ПРОСТРАНСТВО   A-Frame: та же симуляция в VR и AR (Quest 3)
 *   09 ЗАПУСК
 *
 * ГЛАВНАЯ ИДЕЯ: один мир — два рендера. Симуляция (02) не знает ни про p5,
 * ни про A-Frame. На экране её рисует p5 (06), в шлеме — A-Frame (08).
 * Это не две симуляции: в каждый момент тела одни и те же.
 *
 * Весь код обёрнут в (() => { … })(), чтобы не засорять глобальную область.
 * p5 работает в режиме instance — new p5(…) вместо глобальных функций.
 */
(() => {
  'use strict';

  // ═══ 01 / ПРАВИЛА ══════════════════════════════════════════════════════════
  // Числа, задающие «жизнь» мира. Их можно менять руками и смотреть, что изменится.

  const RULES = Object.freeze({
    bodies: 10,              // сколько тел в мире
    range: 3.45,             // на каком расстоянии (м) два тела могут быть связаны
    travelSpeed: 1.6,        // скорость импульса по связи (м/с): дальняя связь — долгий путь
    baseLoss: 0.085,         // как быстро тело теряет энергию: сигнал без адресата «дорого» даётся
    spontaneousInput: 0.105, // собственный приток энергии, независимо от соседей
    pulseCost: 0.32,         // какая доля энергии уходит на один импульс
    pulseStrength: 0.21,     // сила импульса, который тело посылает соседу
    presenceGain: 0.28       // насколько присутствие человека подпитывает тела в режиме «Возмущать»
  });

  // Пять программ тел. Это не «виды существ» и не характеры, а стартовые наборы
  // операторов (как они исполняются — см. updateOneStep). Программа задаёт и форму:
  //   ops   — какие операторы исполняет тело;
  //   lobes — число лепестков оболочки; rings — число орбит;
  //   memory — инерция: чем выше, тем дольше тело помнит принятый сигнал и тем реже импульсы.
  const OPERATOR_PROGRAMS = [
    {name:'Резонатор',       ops:['NOISE','FEEDBACK','GATE','EMIT'],  lobes:5, rings:3, memory:.69},
    {name:'Порог',           ops:['SENSE','FILTER','GATE','EMIT'],    lobes:7, rings:2, memory:.21},
    {name:'Отложенный свет', ops:['SENSE','DELAY','MEMORY','EMIT'],   lobes:4, rings:4, memory:.84},
    {name:'Рассеиватель',    ops:['NOISE','FILTER','EMIT'],           lobes:8, rings:2, memory:.33},
    {name:'Петля',           ops:['SENSE','FEEDBACK','MEMORY','EMIT'],lobes:6, rings:4, memory:.92}
  ];
  // Палитра: тёплый — энергия и импульсы; холодный и фиолетовый — строение тел.
  const PALETTE = {
    warm:'#f0bd77', cool:'#8bd3dc', violet:'#a698d5'
  };

  // Помощники.
  const $ = id => document.getElementById(id);
  const clamp = (v,min,max) => Math.max(min,Math.min(max,v));   // удержать значение в диапазоне
  const lerp = (a,b,t) => a+(b-a)*t;                            // линейная интерполяция a→b
  // hash(n) — детерминированный «случайный» шум в [0,1): одно и то же n всегда даёт одно
  // и то же число. Благодаря ему узоры тел воспроизводятся, а мир зависит только от seed.
  const hash = n => { const x=Math.sin(n*127.1+19.19)*43758.5453; return x-Math.floor(x); };
  // seeded(seed) — генератор случайных чисел для конкретного seed: два запуска с одним
  // seed создают одинаковый мир. Так опыт можно воспроизвести и сравнить результаты.
  const seeded = seed => {let n=seed>>>0;return () => ((n=(Math.imul(n,1664525)+1013904223)>>>0)/4294967296);};
  // rgba('#f0bd77',.5) → 'rgba(240,189,119,0.5)': цвет палитры с прозрачностью.
  const rgba = (hex,opacity) => {
    const c=hex.replace('#',''); return `rgba(${parseInt(c.slice(0,2),16)},${parseInt(c.slice(2,4),16)},${parseInt(c.slice(4,6),16)},${opacity})`;
  };
  function distance3(a,b){return Math.hypot(a.x-b.x,a.y-b.y,(a.z||0)-(b.z||0));}   // расстояние в метрах

  // ═══ 02 / МИР ══════════════════════════════════════════════════════════════
  // Всё, что здесь происходит, не знает ни про экран, ни про шлем: только числа.
  // Единицы — метры. Посетитель стоит около (0, 1.65, 0): x — вправо, y — вверх,
  // z — назад (тела перед посетителем имеют отрицательный z).

  // createWorld(seed) строит мир с нуля: тела, их состояние и связи между ними.
  function createWorld(seed){
    const rng=seeded(seed);
    // Расстановка: ближний, средний и дальний слои; два тела — ЗА спиной посетителя.
    // Формат: x, y, z, радиус тела.
    const layouts=[
      [ .54, -.08, -1.14, .50], // на расстоянии вытянутой руки, справа
      [-1.32,  .30, -2.35, .70], // ближний план, слева
      [ 2.05, -.25, -3.35, .82],
      [-2.70, -.63, -3.75, .68],
      [ .15,  1.22, -4.70, .93],
      [ 3.15,  .66, -5.48, .84],
      [-3.45, 1.12, -6.10, .81],
      [ .40,  2.00, -7.15, .73],
      [-2.05, -.14,  2.65, .57], // за спиной
      [ 2.65,  .43,  2.45, .56]  // за спиной
    ];
    const bodies=layouts.slice(0,RULES.bodies).map((layout,i)=>{
      // Первое тело всегда «Резонатор», остальные получают случайную программу.
      const variant=OPERATOR_PROGRAMS[(i===0?0:Math.floor(rng()*OPERATOR_PROGRAMS.length))];
      return {
        // Имя, номер, положение в метрах (с небольшим случайным сдвигом) и радиус size.
        id:`L-${String(i+1).padStart(2,'0')}`, index:i,
        x:layout[0]+(rng()-.5)*.26,y:layout[1]+(rng()-.5)*.26,z:layout[2],size:layout[3]*(.9+rng()*.2),
        // Состояние. energy (0…1) — запас энергии; signal и received — сила последнего
        // отправленного и последнего принятого импульса (обе затухают).
        program:variant,energy:.30+rng()*.34,signal:0,received:0,
        // phase и freq — собственный ритм; threshold — порог излучения;
        // cooldown — оставшаяся пауза после импульса; emitted — счётчик импульсов.
        phase:rng()*Math.PI*2,freq:.34+rng()*.48,
        threshold:.60+rng()*.18,cooldown:rng()*.6,emitted:0,
        tint:i%3===0?'warm':(i%3===1?'cool':'violet'),
        // Внутренняя память операторов FILTER, DELAY и MEMORY.
        filtered:0,delayed:0,delayQueue:[],memoryState:0,
        // morphology — seed узора; links — число связей; visitorInfluence — насколько
        // тело сейчас чувствует посетителя. last… — время и источник последних событий
        // (по ним рисуются волны и заполняется карточка тела).
        morphology:Math.floor(rng()*100000),links:0,visitorInfluence:0,
        lastReceivedAt:-100,lastReceivedFrom:-1,lastReceivedInfluenced:false,lastTouchAt:-100
      };
    });
    // Связи — пары тел ближе RULES.range. Первое тело, самое близкое к посетителю,
    // получает запас в 1.8 м, чтобы обмениваться импульсами чаще других.
    const links=[];
    for(let i=0;i<bodies.length;i++){
      for(let j=i+1;j<bodies.length;j++){
        const d=distance3(bodies[i],bodies[j]);
        if(d<RULES.range+((i===0||j===0)?1.8:0)) links.push({a:i,b:j,dist:d,phase:rng()*6.28});
      }
    }
    // Ни одно тело не остаётся без единственной связи, но и полной «сети знакомств» нет:
    // одиночка получает одну связь с ближайшим соседом.
    for(let i=0;i<bodies.length;i++){
      if(!links.some(l=>l.a===i||l.b===i)){
        let near=-1,min=Infinity;
        for(let j=0;j<bodies.length;j++) if(i!==j){let d=distance3(bodies[i],bodies[j]);if(d<min){min=d;near=j;}}
        if(near>=0&&!links.some(l=>(l.a===i&&l.b===near)||(l.a===near&&l.b===i))) links.push({a:Math.min(i,near),b:Math.max(i,near),dist:min,phase:rng()*6.28});
      }
    }
    for(const link of links){bodies[link.a].links++;bodies[link.b].links++;}
    return {
      seed,bodies,links,
      pulses:[],             // импульсы в полёте
      time:0,accumulator:0,  // время мира и накопитель фиксированного шага (см. advanceWorld)
      emissions:0,           // сколько импульсов испущено за всё время
      // Короткие журналы последних событий: касания, приёмы, излучения.
      contactHistory:[],arrivalHistory:[],emissionHistory:[],
      lastEvent:{type:'first',params:{}},  // последнее событие для строки повествования
      paused:false,
      mode:'observe',        // 'observe' — наблюдение, 'perturb' — возмущение
      visitor:{x:0,y:0,z:0,active:false,points:[]}   // посетитель и его «точки присутствия»
    };
  }

  // emitSignal — тело излучает импульс. Он уходит по КАЖДОЙ связи отдельно и идёт до
  // соседа конечное время: на дальней связи импульс дольше в пути и слабее.
  function emitSignal(world,b){
    const connected=world.links.filter(l=>l.a===b.index||l.b===b.index);
    for(const edge of connected){
      const target=edge.a===b.index?edge.b:edge.a;
      const other=world.bodies[target];
      // Присутствие посетителя меняет условия распространения сигнала,
      // но не то, что сигнал «значит»: он по-прежнему никому не адресован.
      const localField=Math.max(b.visitorInfluence,other.visitorInfluence);
      world.pulses.push({from:b.index,to:target,age:0,
        duration:Math.max(.42,edge.dist/RULES.travelSpeed)*(1+.28*localField),
        strength:RULES.pulseStrength*(.8+hash(world.emissions*17+target)*.4)*(1+.65*localField),
        influenced:localField>.2});
    }
    b.signal=1;b.emitted++;world.emissions++;
    if(world===app.world) playSignalSound(b.index,'emit',b.signal);
    world.emissionHistory.push({from:b.index,t:world.time,influenced:b.visitorInfluence>.2});
    if(world.emissionHistory.length>32)world.emissionHistory.shift();
    if(world.emissions%3===0){
      world.lastEvent={type:'emission',params:{id:b.id,count:connected.length}};
    }
  }

  // Фиксированный шаг симуляции: 1/60 с. Экран может рисоваться с любой частотой,
  // а мир продвигается одинаковыми шагами — поэтому один seed и те же действия
  // посетителя всегда дают одно и то же состояние, на каком бы устройстве ни шёл опыт.
  const SIMULATION_STEP=1/60;
  function advanceWorld(world,dt){
    if(world.paused)return;
    world.accumulator+=clamp(dt,0,.15);
    let count=0;
    while(world.accumulator>=SIMULATION_STEP && count<9){
      updateOneStep(world,SIMULATION_STEP);
      world.accumulator-=SIMULATION_STEP;
      count++;
    }
  }

  // updateOneStep — один шаг мира: каждое тело исполняет свою программу, затем
  // долетают импульсы.
  function updateOneStep(world,dt){
    world.time+=dt;
    for(const b of world.bodies){
      // Всё недавнее затухает: принятый и отправленный сигналы, пауза после импульса.
      // Чем выше memory программы, тем медленнее гаснет принятый сигнал.
      b.received*=Math.exp(-dt*(.8+b.program.memory*.3));
      b.signal*=Math.exp(-dt*2.55);
      b.cooldown=Math.max(0,b.cooldown-dt);
      // Исполнитель операторов. Программа тела — список операторов, и каждый из них
      // здесь ДЕЙСТВУЕТ, а не просто подписан в инспекторе.
      const oscillator=.5+.5*Math.sin(world.time*b.freq*1.8+b.phase);   // собственный ритм тела
      const ops=b.program.ops;
      let input=RULES.spontaneousInput*(.55+oscillator*.7);
      if(ops.includes('NOISE')) input+=.022*Math.sin(world.time*1.7+b.phase*3.0);       // собственные колебания
      if(ops.includes('SENSE')) input+=b.received*.18;                                   // принимает импульсы соседей
      if(ops.includes('FILTER')){b.filtered=lerp(b.filtered,input,.045);input=b.filtered;} // сглаживает вход: реагирует на тенденцию, а не на каждый сигнал
      if(ops.includes('DELAY')){                                                          // откладывает вход на 0.48 с: реагирует на то, что было раньше
        b.delayQueue.push({until:world.time+.48,value:input});
        while(b.delayQueue.length&&b.delayQueue[0].until<=world.time){
          b.delayed=b.delayQueue.shift().value;
        }
        input=b.delayed;
      }
      if(ops.includes('MEMORY')){                                                         // копит среднее входа и подпитывается им
        b.memoryState=lerp(b.memoryState,input,.025);
        input+=b.memoryState*.13;
      }
      if(ops.includes('FEEDBACK'))input+=b.signal*.055+b.energy*.015;                    // собственный импульс и запас энергии возвращаются на вход
      // Присутствие посетителя — слабое поле вокруг головы и более сильное вокруг рук.
      // В режиме наблюдения (observe) оно не влияет на симуляцию.
      let disturbance=0;
      if(world.mode==='perturb'&&world.visitor.active){
        for(const point of world.visitor.points){
          const d=distance3(b,point);
          disturbance+=point.strength*Math.exp(-Math.pow(d/point.range,2));
        }
      }
      b.visitorInfluence=lerp(b.visitorInfluence,clamp(disturbance,0,1),.1);
      disturbance=RULES.presenceGain*b.visitorInfluence;
      // Энергия: приток (input + поле посетителя) минус потери.
      b.energy+=dt*(input+disturbance - RULES.baseLoss*b.energy);
      b.energy=clamp(b.energy,0,1);
      // Импульс: когда энергия (а с MEMORY — ещё и след) выше порога и пауза прошла,
      // тело тратит часть энергии и излучает. У тел без GATE порог на 8% ниже.
      const gating=b.energy + (ops.includes('MEMORY')?b.memoryState*.11:0);
      const threshold=b.threshold*(ops.includes('GATE')?1:.92);
      if(ops.includes('EMIT')&&gating>threshold && b.cooldown<=0){
        b.energy*=1-RULES.pulseCost;
        b.cooldown=.66+(1-b.program.memory)*.75;
        emitSignal(world,b);
      }
    }
    // Долетевшие импульсы: сосед получает сигнал и немного энергии.
    for(let i=world.pulses.length-1;i>=0;i--){
      const p=world.pulses[i];p.age+=dt;
      if(p.age>=p.duration){
        const target=world.bodies[p.to];
        target.received=clamp(target.received+p.strength,0,1);
        target.lastReceivedAt=world.time;target.lastReceivedFrom=p.from;target.lastReceivedInfluenced=p.influenced;
        target.energy=clamp(target.energy+p.strength*.18,0,1);
        if(world===app.world) playSignalSound(p.to,'receive',p.strength);
        world.arrivalHistory.push({from:p.from,to:p.to,t:world.time,influenced:p.influenced});
        if(world.arrivalHistory.length>40)world.arrivalHistory.shift();
        if(p.influenced){
          world.lastEvent={type:'arrival',params:{from:world.bodies[p.from].id,to:target.id}};
        }
        world.pulses.splice(i,1);
      }
    }
  }

  // ═══ 03 / СОСТОЯНИЕ И ОТЛАДКА ═════════════════════════════════════════════
  // app — единственное общее состояние опыта. Симуляция (раздел 02) пишет только
  // в app.world; экранный и пространственный рендеры читают его и складывают сюда
  // ссылки на свои объекты.
  const app={
    world:createWorld(140821),   // стартовый seed: измените число — получится другой мир
    lang:'ru',                   // язык интерфейса: 'ru' | 'en'
    started:false,               // пролог закрыт, показан живой вид
    // XR-сессия: идёт ли она, в каком режиме ('vr' | 'ar'), подготовлена ли и размещён ли мир в AR.
    isXR:false,xrMode:'vr',arPlaced:false,arSessionPrepared:false,
    selected:0,inspectorOpen:false,          // какое тело открыто в инспекторе на экране
    // Плоский холст: элемент canvas, его 2D-контекст, экземпляр p5, размер окна.
    canvas:null,ctx:null,p5Instance:null,canvasFallback:false,
    width:window.innerWidth,height:window.innerHeight,
    hovered:-1,                               // тело под курсором на экране (-1 — никакого)
    pointer:{x:-1000,y:-1000,inside:false},  // координаты курсора и находится ли он на сцене
    // Объекты A-Frame: сцена, корень мира, тела, связи, текстура поля, звёзды и карточки.
    xrScene:null,xrWorld:null,xrBodies:[],xrLinks:[],xrTex:null,xrStars:null,xrLabel:null,xrHoverCard:null,
    // Звук (WebAudio) и таймер обновления строки повествования.
    audio:null,audioActive:false,elapsedNarration:0,
    // Выбор и подсказки в шлеме: выбранное тело; тело под лучом каждого контроллера;
    // какая кнопка меню подсвечена; точки-прицелы и лучи рук; время последнего касания.
    xrSelection:-1,xrHoverBySide:{left:-1,right:-1},xrUiHover:{left:'',right:''},xrHoverCardIndex:-1,
    xrReticles:{},xrHandReticles:{},xrHandRayHits:{left:null,right:null},xrLastContactAt:new Map(),
    // Ходьба: наклон левого стика, защёлка снап-поворота, зажатые grip-кнопки.
    xrMove:{x:0,y:0},xrTurn:{latched:false},xrGrip:{left:false,right:false},
    // Меню в шлеме: объект, видимость, страница ('main' | 'help'), кнопки; xrGuidedModes
    // помечает, для какого режима подсказка при входе уже показывалась.
    xrMenu:null,xrMenuVisible:false,xrMenuPage:'main',xrMenuButtons:[],xrGuidedModes:{vr:false,ar:false},
    tickErrors:[]                             // ошибки, пойманные в кадре A-Frame (см. lanternDebug)
  };

  // ОТЛАДКА. Из консоли браузера можно заглянуть в мир и управлять им, не трогая код:
  //   lanternDebug.getState()                  время, seed, энергия и импульсы каждого тела
  //   lanternDebug.spatialLayout()             координаты тел в метрах
  //   lanternDebug.simulate(600)               прокрутить 600 шагов (10 с) без рисования
  //   lanternDebug.injectPresence(точки,'perturb')  подставить точки присутствия и включить возмущение
  //   lanternDebug.reset(42)                   заменить мир новым с заданным seed
  //   lanternDebug.audioStats()                включён ли звук, сколько сигналов прозвучало
  //   lanternDebug.xrState()                   что выбрано в шлеме; .tickErrors() — ошибки кадров
  //   lanternDebug.xrMenuAudit()               из чего собрано меню в шлеме
  window.lanternDebug={
    getState:()=>({time:app.world.time,seed:app.world.seed,bodies:app.world.bodies.map(b=>({id:b.id,energy:b.energy,emitted:b.emitted})),emissions:app.world.emissions,arrivalHistory:app.world.arrivalHistory.slice(-5),visitor:app.world.visitor,bodiesNear:app.world.bodies.map(b=>({id:b.id,field:+b.visitorInfluence.toFixed(3)})),started:app.started,xr:app.isXR}),
    reset:seed=>{app.world=createWorld(seed);return app.world.seed;},
    injectPresence:(points,mode='perturb')=>{app.world.mode=mode;app.world.visitor={active:mode==='perturb',points};},
    simulate:steps=>{for(let i=0;i<steps;i++)updateOneStep(app.world,SIMULATION_STEP);return{
      emissions:app.world.emissions,arrivals:app.world.arrivalHistory.length,
      energies:app.world.bodies.map(b=>+b.energy.toFixed(6)),
      fields:app.world.bodies.map(b=>+b.visitorInfluence.toFixed(3))};},
    spatialLayout:()=>app.world.bodies.map(b=>({id:b.id,x:b.x,y:b.y+1.7,z:b.z,size:b.size})),
    audioStats:()=>({active:app.audioActive,spatialVoices:app.audio?.spatial?.length||0,
      packetSounds:app.audio?.signalPings||0,filter:app.audio?.filter?.frequency?.value||0}),
    xrState:()=>({selected:app.xrSelection,visitorMode:app.world.mode,contacts:app.world.contactHistory.length,tickErrors:()=>app.tickErrors.slice()}),
    xrMenuAudit:()=>({buttons:app.xrMenuButtons.map(b=>({action:b.action,canvas:[b.label.canvas.width,b.label.canvas.height],hasMesh:!!b.entity.getObject3D('mesh')}))})
  };

  // ═══ 04 / ЯЗЫК ══════════════════════════════════════════════════════════════
  // Двуязычный интерфейс. Исходные тексты в index.html — русские. EN_STATIC —
  // английские соответствия статических надписей разметки (по data-i18n);
  // LANG — строки, которые код собирает сам: подсказки, тосты, карточки.
  const EN_STATIC = {
  "course": "DESIGNING (NON)HUMAN SYSTEMS",
  "practice": "PRACTICAL WORK No. 1 / SYMBOLIC MACHINE",
  "lead": "The world emits signals.<br>But who are they addressed to?",
  "introCopy": "You are about to enter a generative environment inhabited by computational bodies. Their shapes, light and movements are shaped by internal operators and signals from their neighbours. We can see their states — without necessarily understanding <i>what they mean</i>.",
  "principle1": "No prewritten scenario",
  "principle2": "Objects keep changing without you",
  "principle3": "Your presence may change the environment",
  "quote": "“It cries out its existence.”",
  "start": "Enter the environment",
  "rulesOpen": "How it works <span>＋</span>",
  "footnote": "<span class=\"rule-glyph\">◈</span> Observe. Do not rush to find meaning.",
  "sideNote": "AUTONOMOUS ENVIRONMENT",
  "process": "PROCESS 01 / OBSERVATION",
  "inspectorTop": "SELECTED BODY",
  "inspectorDesc": "This body has no name in its own world. We use a provisional label to observe it.",
  "metricEnergy": "ENERGY",
  "metricSignal": "SIGNAL",
  "metricLinks": "LINKS",
  "operatorGraph": "OPERATOR GRAPH",
  "closeInspector": "Hide analysis <span>×</span>",
  "modeTitle": "INTERACTION MODE",
  "observe": "Observe",
  "perturb": "Disturb",
  "regenLabel": "NEW WORLD",
  "rulesLabel": "RULES",
  "xrLabel": "VR WORLD",
  "touchHint": "Touch a body to explore its structure",
  "rulesEyebrow": "<span class=\"eyebrow-line\"></span> PRACTICAL WORK No. 1 / IDEAS AND RULES",
  "rulesTitle": "Why does this world<br><em>behave this way?</em>",
  "rulesIntro": "We began with a simple question: when a technical object flickers, responds to touch or stops working, <strong>is it telling us something — or do we turn its state into a message ourselves?</strong> LANTERN // VOID retains this question, not the original object. Computational bodies take its place: rules become light, motion and relationships.",
  "firstFoundation": "<span>01</span> WHERE THE IDEA COMES FROM",
  "cassirerSource": "CASSIRER / SYMBOLIC FORMS",
  "cassirerTitle": "We see a signal and add meaning",
  "cassirerText": "A flash may look like a plea, a reply or an alarm. Yet the calculations know only thresholds and changes of state. We explore the boundary between <em>what happens in the system</em> and <em>the story an observer tells about it</em>.",
  "wienerSource": "WIENER / CYBERNETICS",
  "wienerTitle": "An effect becomes a new cause",
  "wienerText": "One body emits a pulse, another responds, and the environment changes. The next pulse occurs under different conditions. What matters here are <em>feedback loops</em>, not a prerecorded animation.",
  "simondonSource": "SIMONDON / TECHNICAL INDIVIDUATION",
  "simondonTitle": "A body is never a finished object",
  "simondonText": "A body is not defined by its shape or shell alone. Its internal organisation, event memory, neighbouring connections and environment shape what it becomes. Here a virtual “body” is a temporarily stable process, not a character with a fixed personality.",
  "embodiedSource": "EMBODIMENT / NONHUMAN PERCEPTION",
  "embodiedTitle": "Humans are not the centre of this ecology",
  "embodiedText": "Different systems respond to different signals: some to neighbours, others to delays or accumulation. In WebXR, your head and hands can become part of the environment, but no body is required to recognise or “answer” you.",
  "virtualSource": "VIRTUAL AND ACTUAL / GENERATIVITY",
  "virtualTitle": "Rules create possibilities, not a plot",
  "virtualText": "The same rules can lead to different sequences of events. Not every possibility is realised: some connections emerge, some signals fade, some coincidences look like a dialogue. We observe <em>possibilities unfolding</em> rather than a fixed story.",
  "secondFoundation": "<span>02</span> HOW IDEAS BECOME CODE",
  "modalBridge": "A language model proposed a grammar of simple operators inspired by node-based environments such as TouchDesigner. The author selected and refined the rules; JavaScript now executes them. <strong>The LLM does not generate dialogue for the bodies in real time.</strong> Their behaviour emerges from numbers, connections and feedback.",
  "ruleCard1Title": "OPERATIONS / INTERNAL GRAPH",
  "ruleCard1Text": "<code>NOISE</code> introduces fluctuations; <code>FILTER</code> selects inputs; <code>MEMORY</code> and <code>DELAY</code> retain traces; <code>GATE</code> sets a threshold; <code>EMIT</code> releases a pulse.",
  "ruleCard2Title": "SPATIAL BODIES",
  "ruleCard2Text": "Internal parameters influence rhythm, shape and glow. This is an artistic visualisation of computation, not a claim that code intrinsically “looks” like an organism.",
  "ruleCard3Title": "SIGNALS AND ENVIRONMENT",
  "ruleCard3Text": "Signals travel between bodies with delay and attenuation. An incoming event can alter a neighbour’s next cycle. What looks like conversation is not proof of language or intention.",
  "ruleCard4Title": "YOU AS PART OF THE FIELD",
  "ruleCard4Text": "In Observe mode your actions are excluded from the simulation. In Disturb mode, the pointer — or head and hands in XR — modifies local conditions. Effects may appear in distant bodies that never directly encountered you.",
  "conclusion": "“It cries out its existence.”<span>But a cry does not always have an addressee. This work asks how a technical state becomes, to our eyes, almost a gesture, an address, or a sign of life — and where that interpretation breaks down.</span>",
  "modalDone": "Continue observing",
  "xrGuide": "PINCH / TRIGGER: INSPECT · COME CLOSE / TOUCH: DISTURB · B: CLOSE · WORLD BUTTONS: MODE / SOUND.",
  "xrBack": "← Back to observation",
  "headPractice": "PRACTICE / 01",
  "directXR": "VR world",
  "arLabel": "AR in your room",
  "xrLabel": "VR WORLD"
};
  const LANG = {
    ru:{
      active:'СИСТЕМА АКТИВНА', paused:'ПРОЦЕСС ОСТАНОВЛЕН',
      bodies:'ТЕЛ', emitted:'СИГНАЛОВ', audioOn:'ЗВУК: ВКЛ.', audioOff:'ЗВУК: ВЫКЛ.',
      pause:'ПАУЗА', resume:'ПРОДОЛЖИТЬ',
      observeHint:'Ваше движение не влияет на мир.', disturbHint:'Указатель изменяет локальные условия передачи сигнала.',
      first:'Мир существует до того, как вы начали его наблюдать.',
      emission:'{id} испустил импульс. {count} связей получили возмущение.',
      arrival:'{from} → {to}: сигнал дошёл после изменения среды посетителем.',
      inspectorNone:'Ещё ни одного импульса. Внутренний процесс продолжается.',
      inspectorEmitted:'Зарегистрировано {count} излучений. Это состояние системы — не доказательство намерения.',
      welcome:'Она кричит о своём существовании — но не обязательно вам.',
      regenerate:'Порожден новый мир • seed {seed}', presenceOn:'Ваше присутствие теперь влияет на некоторые процессы',
      audioMuted:'Звуковая среда выключена',audioPlaying:'Звук зависит от состояния среды',audioBlocked:'Браузер не разрешил запуск звука',
      xrMissing:'A-Frame не загрузился. Проверьте сеть и подключение библиотеки.',
      xrReady:'Пространство готово. На Quest 3 используйте кнопку Enter VR.',
      xrInitial:'Среда существует независимо от вас.',
      xrEnergy:'ЭНЕРГИЯ {energy}    ИМПУЛЬС {signal}',
      xrField:'ПОЛЕ ПОСЕТИТЕЛЯ {field}',
      names:['Резонатор','Порог','Отложенный свет','Рассеиватель','Петля']
    },
    en:{
      active:'SYSTEM ACTIVE',paused:'PROCESS PAUSED',
      bodies:'BODIES',emitted:'PULSES',audioOn:'SOUND: ON',audioOff:'SOUND: OFF',
      pause:'PAUSE',resume:'RESUME',
      observeHint:'Your movement has no effect on the world.', disturbHint:'Your pointer changes local conditions for signal propagation.',
      first:'The world existed before you began observing it.',
      emission:'{id} emitted a pulse. {count} connections were disturbed.',
      arrival:'{from} → {to}: a signal arrived after the visitor altered its environment.',
      inspectorNone:'No pulses yet. The internal process continues.',
      inspectorEmitted:'{count} emissions recorded. A change of state does not prove intention.',
      welcome:'It cries out its existence — but not necessarily to you.',
      regenerate:'A new world has emerged • seed {seed}',presenceOn:'Your presence now affects some processes',
      audioMuted:'Soundscape muted',audioPlaying:'Sound follows the environment’s state',audioBlocked:'Browser did not allow audio playback',
      xrMissing:'A-Frame did not load. Check your network connection and script source.',
      xrReady:'Spatial environment ready. On Quest 3, select Enter VR.',
      xrInitial:'The environment exists independently of you.',
      xrEnergy:'ENERGY {energy}    PULSE {signal}',
      xrField:'VISITOR FIELD {field}',
      names:['Resonator','Threshold','Deferred light','Diffuser','Loop']
    }
  };
  // tr('key',{param}) — взять строку из словаря текущего языка и подставить {param}.
  // Если в переводе строки нет, берётся русская — интерфейс не показывает голый ключ.
  function tr(key,params={}){
    let str=LANG[app.lang][key] ?? LANG.ru[key] ?? key;
    return String(str).replace(/\{(\w+)\}/g,(m,k)=>String(params[k]??m));
  }
  // Последнее событие мира → фраза для строки повествования («L-02 испустил импульс…»).
  function formatEvent(event){
    if(!event||typeof event!=='object')return tr('first');
    return tr(event.type,event.params||{});
  }
  // Условное имя тела на текущем языке («Резонатор», «Threshold»…). У тела в его
  // собственной среде имени нет — название нужно только наблюдателю.
  function programName(body){
    const i=OPERATOR_PROGRAMS.indexOf(body.program);
    return (LANG[app.lang].names[i]||body.program.name);
  }
  // refreshLanguage — перевести весь интерфейс на app.lang: статические надписи,
  // заголовок страницы, подписи кнопок, инспектор, карточки и меню в шлеме.
  function refreshLanguage(){
    // Держим место чтения в окне правил, когда длина перевода меняется.
    const readingPanel=document.querySelector('.modal-panel');
    const readingFraction=readingPanel&&readingPanel.scrollHeight>readingPanel.clientHeight?
      readingPanel.scrollTop/(readingPanel.scrollHeight-readingPanel.clientHeight):0;
    document.documentElement.lang=app.lang;
    document.title=app.lang==='ru'?'LANTERN // VOID — Крик без адресата':'LANTERN // VOID — A Cry Without an Addressee';
    document.querySelector('meta[name="description"]').content=app.lang==='ru'?
      'LANTERN // VOID — генеративная экология вычислительных тел. Художественный WebXR-эксперимент о сигналах, присутствии и интерпретации.':
      'LANTERN // VOID — a generative ecology of computational bodies. A WebXR experiment in signals, presence and interpretation.';
    document.querySelectorAll('[data-i18n]').forEach(el=>{
      if(el.__ruOriginal===undefined)el.__ruOriginal=el.innerHTML;
      el.innerHTML=app.lang==='ru'?el.__ruOriginal:(EN_STATIC[el.dataset.i18n]||el.__ruOriginal);
    });
    // Отмечаем активную кнопку языка.
    document.querySelectorAll('.lang-button').forEach(el=>{
      const active=el.dataset.lang===app.lang;
      el.setAttribute('aria-pressed',String(active));
    });
    $('system-status').textContent=tr(app.world.paused?'paused':'active');
    $('pause-label').textContent=tr(app.world.paused?'resume':'pause');
    $('audio-label').textContent=tr(app.audioActive?'audioOn':'audioOff');
    $('mode-hint').textContent=tr(app.world.mode==='perturb'?'disturbHint':'observeHint');
    $('population-readout').textContent=`${String(app.world.bodies.length).padStart(2,'0')} ${tr('bodies')}`;
    $('live-story').textContent=formatEvent(app.world.lastEvent);
    if(app.inspectorOpen)refreshInspector();
    refreshXRLabel();refreshXRMenu();
    $('xr-button').setAttribute('title',app.lang==='ru'?'Открыть VR-мир':'Enter VR world');
    $('ar-button').setAttribute('title',app.lang==='ru'?'AR-экология в комнате':'AR ecology in your room');
    $('regenerate-button').setAttribute('title',app.lang==='ru'?'Пересоздать мир':'Regenerate world');
    $('pause-button').setAttribute('title',app.lang==='ru'?'Пауза':'Pause');
    $('audio-button').setAttribute('title',app.lang==='ru'?'Включить или выключить звук':'Toggle sound');
    $('rules-button').setAttribute('title',app.lang==='ru'?'О правилах мира':'About the world rules');
    $('modal-close').setAttribute('aria-label',app.lang==='ru'?'Закрыть':'Close');
    $('p5-stage').setAttribute('aria-label',app.lang==='ru'?'Генеративная среда вычислительных тел':'Generative environment of computational bodies');
    $('live-ui').setAttribute('aria-label',app.lang==='ru'?'Интерфейс наблюдения':'Observation interface');
    if(readingPanel && !$('rules-modal').classList.contains('is-hidden')){
      readingPanel.scrollTop=readingFraction*Math.max(0,readingPanel.scrollHeight-readingPanel.clientHeight);
    }
  }
  function setLanguage(lang){
    if(lang!=='en'&&lang!=='ru')return;
    app.lang=lang;refreshLanguage();
  }

  // ═══ 05 / ХОЛСТ ════════════════════════════════════════════════════════════
  // Плоский вид рисуется обычным Canvas 2D. p5 даёт три вещи: холст нужного размера
  // и чёткости, такт (p.draw вызывается каждый кадр) и пересоздание при изменении окна.
  // Внутри draw два действия: продвинуть мир и нарисовать его.

  function viewportSize(){
    app.width=Math.max(300,window.innerWidth);app.height=Math.max(300,window.innerHeight);
  }
  function attachP5(){
    if(typeof window.p5!=='function'){setupFallback();return;}
    try{
      app.p5Instance=new window.p5(p=>{
        p.setup=()=>{
          viewportSize();
          // Чёткость не выше 1.6× плотности пикселей: иначе тяжёлые тела замедляют кадр.
          p.pixelDensity(Math.min(window.devicePixelRatio||1,1.6));
          const canvas=p.createCanvas(app.width,app.height);
          canvas.parent('p5-stage');
          p.frameRate(35);
          app.canvas=canvas.elt;app.ctx=p.drawingContext;   // рисуем напрямую через 2D-контекст
          app.canvas.style.touchAction='none';
        };
        // Один кадр: сколько прошло времени → продвинуть мир → нарисовать → обновить подписи.
        // В XR-сессии плоский холст не нужен: там миром управляет lantern-simulation.
        p.draw=()=>{
          if(app.isXR)return;
          const dt=Math.min(.055,p.deltaTime/1000||.025);
          advanceWorld(app.world,dt);
          render2D();updateInfo(dt);
        };
        p.windowResized=()=>{
          viewportSize();p.resizeCanvas(app.width,app.height);
        };
      });
      // p5.js 2.x может запустить setup с задержкой. Если через 1.2 с холста нет —
      // включаем запасной режим, чтобы опыт не остался пустым экраном.
      setTimeout(()=>{if(!app.canvas&&!app.canvasFallback){console.warn('p5 setup did not complete; activating canvas fallback');try{app.p5Instance?.remove();}catch(_){ }app.p5Instance=null;setupFallback();}},1200);
    }catch(e){console.error('p5 initialization failed, using canvas fallback:',e);app.p5Instance=null;setupFallback();}
  }
  // Запасной режим: p5 не загрузился — тот же холст и тот же цикл на голом Canvas 2D.
  function setupFallback(){
    if(app.canvas&&app.canvas.parentNode)app.canvas.remove();
    app.canvasFallback=true;
    app.canvas=document.createElement('canvas');
    $('p5-stage').append(app.canvas);
    app.ctx=app.canvas.getContext('2d');
    const resize=()=>{
      viewportSize();const dpr=Math.min(window.devicePixelRatio||1,1.6);
      app.canvas.width=Math.round(app.width*dpr);app.canvas.height=Math.round(app.height*dpr);
      app.canvas.style.width=app.width+'px';app.canvas.style.height=app.height+'px';
      app.ctx.setTransform(dpr,0,0,dpr,0,0);
    };
    resize();window.addEventListener('resize',resize);
    // Такт вместо p.draw: requestAnimationFrame вызывает frame каждый кадр экрана.
    let old=performance.now();
    const frame=now=>{
      if(!app.isXR){let dt=clamp((now-old)/1000,0,.055);advanceWorld(app.world,dt);render2D();updateInfo(dt);}
      old=now;requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  // ═══ 06 / ПЛОСКИЙ ВИД ═══════════════════════════════════════════════════════
  // Рисует мир на экране. Тела — не значки, а живые оболочки: мембраны, нити,
  // орбиты и свет ядра. Всё берётся из состояния мира:
  //   энергия (energy)  → яркость свечения и плотность света,
  //   сигнал (signal)   → рябь вокруг тела и всплеск яркости,
  //   rings / lobes     → число орбит и лепестков оболочки,
  //   число операторов  → сколько нитей-филаментов у тела.
  // Порядок кадра: фон → поле → связи → тела (дальние раньше ближних).

  // bodyScreen(b) — где тело находится на экране: мировые метры → пиксели.
  // Чем дальше тело (z), тем оно меньше. До входа в опыт композиция сдвинута
  // вправо, чтобы освободить место прологу.
  function bodyScreen(b){
    const w=app.width,h=app.height;
    const centerX=w*(app.started?.52:.715),centerY=h*.475;
    const spread=Math.min(w*.100,h*.185);
    const depth=1/(1+Math.abs(b.z+4.4)*.10);
    return {x:centerX+b.x*spread*depth,y:centerY-b.y*spread*.88*depth,z:depth,r:b.size*Math.min(w*.095,h*.163)*depth*(app.started?1.02:1.20)*(w<700?1.35:1)};
  }
  // glow — радиальный ореол: мягкое свечение без резких краёв.
  function glow(ctx,x,y,r,color,opacity){
    if(r<=0)return;
    const g=ctx.createRadialGradient(x,y,1,x,y,r);
    g.addColorStop(0,rgba(color,opacity));g.addColorStop(.28,rgba(color,opacity*.44));g.addColorStop(1,rgba(color,0));
    ctx.fillStyle=g;ctx.fillRect(x-r,y-r,r*2,r*2);
  }
  // Фон: градиент пустоты, три широких свечения и 150 мерцающих пылинок.
  function drawBackground(ctx,w,h,t){
    const bg=ctx.createLinearGradient(0,0,w,h);
    bg.addColorStop(0,'#050915');bg.addColorStop(.48,'#0c1324');bg.addColorStop(1,'#080c17');
    ctx.fillStyle=bg;ctx.fillRect(0,0,w,h);
    ctx.save();ctx.globalCompositeOperation='screen';
    glow(ctx,w*.67,h*.45,Math.min(w*.48,720),'#56659d',.17);
    glow(ctx,w*.84,h*.23,Math.min(w*.3,460),'#9b6a6e',.10);
    glow(ctx,w*.28,h*.89,Math.min(w*.33,480),'#385d91',.09);
    for(let i=0;i<150;i++){
      const x=hash(i*1.343+91)*w,y=hash(i*3.771+18)*h;
      const twinkle=.28+.26*Math.sin(t*(.18+hash(i)*.65)+i);
      ctx.fillStyle=i%11===0?`rgba(242,206,164,${twinkle})`:`rgba(188,209,225,${twinkle*.55})`;
      ctx.beginPath();ctx.arc(x,y,i%17===0?1.2:.44,0,Math.PI*2);ctx.fill();
    }
    ctx.restore();
  }
  // Поле под телами: интерференционные кольца и «трава» света. Это не декор —
  // по кольцам расходятся реальные недавние излучения.
  function drawField(ctx,w,h,t){
    ctx.save();ctx.globalCompositeOperation='screen';
    const centerX=w*(app.started?.5:.74),centerY=h*.79;
    for(let k=0;k<11;k++){
      const radius=(52+k*51)*(Math.min(w/1400,1.2));
      const shift=(t*5+k*17)%44;
      ctx.beginPath();ctx.ellipse(centerX,centerY+12,radius+shift,(radius+shift)*.21,-.035,0,Math.PI*2);
      const a=.10*(1-k/13)+.03*Math.sin(t*.6+k);
      ctx.strokeStyle=k%3===0?rgba(PALETTE.warm,a):rgba(PALETTE.cool,a*.66);ctx.lineWidth=k%3===0?1.25:.75;ctx.stroke();
    }
    for(let i=0;i<45;i++){
      const v=i/45,x=centerX+(v-.5)*w*.68;
      const y=centerY+Math.sin(i*.83+t*.21)*8;
      ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+Math.sin(i)*6,y-30-hash(i)*42);
      ctx.strokeStyle=rgba(i%3===0?PALETTE.warm:PALETTE.cool,.06+.06*hash(i+12));ctx.lineWidth=.6;ctx.stroke();
    }
    // Недавние излучения: расширяющиеся кольца; холоднее — если событие прошло под влиянием посетителя.
    for(const event of app.world.emissionHistory){
      const age=t-event.t;if(age<0||age>4.4)continue;
      const pos=bodyScreen(app.world.bodies[event.from]);
      ctx.beginPath();ctx.ellipse(pos.x,pos.y,24+age*64,(24+age*64)*.65,0,0,6.283);
      ctx.lineWidth=.7;ctx.strokeStyle=rgba(event.influenced?PALETTE.cool:PALETTE.warm,(1-age/4.4)*.16);
      ctx.stroke();
    }
    glow(ctx,centerX,centerY,Math.min(w*.23,300),PALETTE.warm,.075);
    ctx.restore();
  }
  // Связи между телами — дуги. Светлая точка на дуге — импульс в полёте: её место
  // на дуге равно доле пройденного пути (age / duration).
  function drawLinks(ctx,t){
    ctx.save();ctx.globalCompositeOperation='screen';
    for(const edge of app.world.links){
      const a=bodyScreen(app.world.bodies[edge.a]),b=bodyScreen(app.world.bodies[edge.b]);
      const mx=(a.x+b.x)/2, my=(a.y+b.y)/2-Math.min(65,Math.abs(a.x-b.x)*.09)-20;
      const curve=u=>({x:(1-u)*(1-u)*a.x+2*(1-u)*u*mx+u*u*b.x,y:(1-u)*(1-u)*a.y+2*(1-u)*u*my+u*u*b.y});
      ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.quadraticCurveTo(mx,my,b.x,b.y);
      ctx.strokeStyle=rgba('#a6c6cd',.085+.045*Math.sin(edge.phase+t*.24));ctx.lineWidth=.65;ctx.stroke();
      for(const p of app.world.pulses){
        if(!((p.from===edge.a&&p.to===edge.b)||(p.from===edge.b&&p.to===edge.a)))continue;
        const u=clamp(p.age/p.duration,0,1);
        const at=curve(p.from===edge.a?u:1-u);
        glow(ctx,at.x,at.y,14,PALETTE.warm,.3);
        ctx.fillStyle='#ffeac0';ctx.beginPath();ctx.arc(at.x,at.y,1.9,0,6.29);ctx.fill();
      }
    }
    ctx.restore();
  }
  // contour — форма мембраны в полярных координатах: радиус контура под углом theta.
  // Число лепестков задаёт программа тела (lobes).
  function contour(theta,variant,layer,t){
    const petals=variant.lobes;
    return (1+.11*Math.sin(theta*petals + layer*.68+t*.19)+.07*Math.sin(theta*(petals+3)-t*.31+layer*2))*(1+layer*.04);
  }
  // drawBody — одно тело. Радиус дышит и растёт от последнего импульса.
  function drawBody(ctx,b,t){
    const s=bodyScreen(b);
    const r=s.r*(1+.035*Math.sin(t*b.freq*1.9+b.phase)+b.signal*.055);
    const warm=b.tint==='warm';const c=warm?PALETTE.warm:(b.tint==='cool'?PALETTE.cool:PALETTE.violet);
    const energy=b.energy;
    ctx.save();ctx.translate(s.x,s.y);ctx.rotate(.10*Math.sin(t*.18+b.phase));ctx.globalCompositeOperation='screen';
    glow(ctx,0,0,r*2.1,c,.08+energy*.075);
    glow(ctx,0,0,r*.64,PALETTE.warm,.16+energy*.13);
    // Орбиты (их число — program.rings): сплюснутые кольца с бегущими по ним искрами.
    for(let j=0;j<b.program.rings;j++){
      ctx.save();ctx.rotate(j*1.15+b.phase*.2+t*(j%2?-.045:.025));
      ctx.beginPath();ctx.ellipse(0,0,r*(1.04+j*.14),r*(.31+j*.065),0,0,6.283);
      ctx.strokeStyle=rgba(j%2?PALETTE.warm:PALETTE.cool,.24+.15*energy);ctx.lineWidth=j===0?1.18:.75;ctx.stroke();
      for(let k=0;k<6;k++){
        const a=k*6.283/6+t*(j%2?-.32:.26)+b.phase;
        const x=Math.cos(a)*r*(1.04+j*.14),y=Math.sin(a)*r*(.31+j*.065);
        ctx.fillStyle=rgba(j%2?PALETTE.warm:'#daeff3',.4+.4*energy);
        ctx.beginPath();ctx.arc(x,y,k%3===0?1.45:.7,0,6.283);ctx.fill();
      }
      ctx.restore();
    }
    // Шёлковые ленты — объём тела без 3D-моделей: изогнутые полосы с живой модуляцией.
    for(let k=0;k<4;k++){
      const inner=[],outer=[];
      const start=k*1.52+b.phase*.24+t*(k%2?-.016:.011);
      const span=1.7+hash(b.morphology+k)*.7;
      for(let j=0;j<=48;j++){
        const u=j/48,a=start+u*span;
        const wave=.095*Math.sin(u*6.283+b.phase+k+t*.15);
        const base=r*(.33+u*.51+wave);
        const thickness=r*(.08+.16*Math.sin(Math.PI*u)*Math.sin(Math.PI*u));
        inner.push([Math.cos(a)*base,Math.sin(a)*base*.83]);
        outer.push([Math.cos(a+.04)*(base+thickness),Math.sin(a+.04)*(base+thickness)*.83]);
      }
      ctx.beginPath();ctx.moveTo(inner[0][0],inner[0][1]);
      for(const pos of inner.slice(1))ctx.lineTo(pos[0],pos[1]);
      for(let j=outer.length-1;j>=0;j--)ctx.lineTo(outer[j][0],outer[j][1]);
      ctx.closePath();
      const veil=ctx.createLinearGradient(-r,-r,r,r);
      veil.addColorStop(0,rgba(PALETTE.cool,.025));
      veil.addColorStop(.45,rgba(k%2===0?c:PALETTE.warm,.13+.045*energy));
      veil.addColorStop(1,rgba(PALETTE.cool,.024));
      ctx.fillStyle=veil;ctx.fill();
      ctx.strokeStyle=rgba(k%2===0?PALETTE.cool:PALETTE.warm,.13+energy*.07);
      ctx.lineWidth=.9;ctx.stroke();
    }
    // Полупрозрачные мембраны — четыре слоя контуров (форма — contour) с радиальными прожилками.
    const shells=4;
    for(let layer=shells-1;layer>=0;layer--){
      const layerRadius=r*(.53+layer*.15);
      ctx.save();ctx.rotate(layer*.31+Math.sin(t*.11+b.phase)*.095);
      const fill=ctx.createRadialGradient(0,0,layerRadius*.07,0,0,layerRadius*1.25);
      fill.addColorStop(0,rgba('#dfb992',.055));fill.addColorStop(.68,rgba(c,.055+.012*layer));fill.addColorStop(1,rgba(c,.005));
      ctx.beginPath();
      for(let i=0;i<=112;i++){
        const a=i/112*6.283;
        const rr=layerRadius*contour(a,b.program,layer,t);
        const x=Math.cos(a)*rr,y=Math.sin(a)*rr*(.90+layer*.022);
        if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);
      }
      ctx.closePath();ctx.fillStyle=fill;ctx.fill();
      ctx.strokeStyle=rgba(layer%2?PALETTE.cool:c,.22+.11*energy+layer*.012);
      ctx.lineWidth=layer===3?1.12:.58;ctx.stroke();
      // Тонкие радиальные прожилки: мембрана структурирована, а не гладкая.
      for(let i=0;i<19;i++){
        const a=i/19*6.283;
        ctx.beginPath();
        for(let j=0;j<7;j++){
          const q=j/6,rr=layerRadius*(.12+.89*q)*contour(a+q*.22,b.program,layer,t);
          const x=Math.cos(a+q*.22)*rr,y=Math.sin(a+q*.22)*rr*.89;
          if(j===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);
        }
        ctx.strokeStyle=rgba(layer%2?PALETTE.warm:PALETTE.cool,.09+energy*.055);ctx.lineWidth=.56;ctx.stroke();
      }
      ctx.restore();
    }
    // Нити-филаменты: чем длиннее программа тела, тем их больше.
    const strands=40+b.program.ops.length*9;
    for(let i=0;i<strands;i++){
      const a=i*2.399963+(.1*Math.sin(t*.1+i));
      const length=r*(.25+.68*hash(b.morphology+i*7));
      const startR=r*(.07+.21*hash(i+b.morphology));
      const x0=Math.cos(a)*startR,y0=Math.sin(a)*startR;
      const x1=Math.cos(a)*length,y1=Math.sin(a)*length*(.89+.11*Math.sin(i));
      const curvature=(.12+.23*hash(i*13+b.morphology))*r;
      ctx.beginPath();ctx.moveTo(x0,y0);
      ctx.bezierCurveTo(x0+curvature*Math.sin(a*2),y0-curvature*Math.cos(a),x1-curvature*.4*Math.sin(a),y1+curvature*.5*Math.cos(a),x1,y1);
      ctx.strokeStyle=rgba(i%5===0?PALETTE.warm:c,.12+.24*hash(i*4+b.morphology)*(.55+energy*.5));
      ctx.lineWidth=i%9===0?1.05:.57;ctx.stroke();
      if(i%6===0){ctx.fillStyle=rgba(PALETTE.warm,.28+energy*.42);ctx.beginPath();ctx.arc(x1,y1,.7+energy*.8,0,6.283);ctx.fill();}
    }
    // Взвешенные частицы внутри мембраны.
    for(let i=0;i<36;i++){
      const a=hash(i*21+b.morphology)*6.283,rad=r*Math.sqrt(hash(i*17.7+b.morphology))*.87;
      const px=Math.cos(a)*rad,py=Math.sin(a)*rad*.87;
      const alpha=.07+.24*(.5+.5*Math.sin(t*(.5+hash(i)) + i)) *(.4+energy*.5);
      ctx.fillStyle=rgba(i%3===0?PALETTE.warm:PALETTE.cool,alpha);
      ctx.beginPath();ctx.arc(px,py,.4+hash(i*14)*1.05,0,6.283);ctx.fill();
    }
    // Ядро энергии: несколько слоёв ореола, чтобы не было плоского шара.
    glow(ctx,0,0,r*.55,PALETTE.warm,.28+energy*.24);
    glow(ctx,0,0,r*.27,'#fff0c6',.50+energy*.35);
    ctx.fillStyle=rgba('#fff3d4',.60+energy*.40);ctx.beginPath();ctx.arc(0,0,Math.max(1.5,r*.026),0,6.283);ctx.fill();
    // Рябь последнего импульса.
    if(b.signal>.09){
      const ripple=r*(.45+(1-b.signal)*1.42);
      ctx.beginPath();ctx.ellipse(0,0,ripple,ripple*.85,0,0,6.283);
      ctx.strokeStyle=rgba(PALETTE.warm,b.signal*.32);ctx.lineWidth=1+b.signal*1.1;ctx.stroke();
    }
    // Пунктирный контур и номер — у тела под курсором или открытого в инспекторе.
    if(app.started&&(app.selected===b.index&&app.inspectorOpen||app.hovered===b.index)){
      ctx.beginPath();ctx.ellipse(0,0,r*1.24,r*1.12,-.25,0,6.283);
      ctx.strokeStyle=rgba('#d6e8e9',.32);ctx.setLineDash([3,9]);ctx.lineWidth=.75;ctx.stroke();ctx.setLineDash([]);
      ctx.fillStyle='rgba(218,224,223,.8)';ctx.font='10px Geologica, sans-serif';ctx.fillText(b.id,r*.92,-r*.85);
    }
    ctx.restore();
  }
  function render2D(){
    const ctx=app.ctx;if(!ctx)return;
    const w=app.width,h=app.height,t=app.world.time;
    ctx.clearRect(0,0,w,h);
    drawBackground(ctx,w,h,t);drawField(ctx,w,h,t);drawLinks(ctx,t);
    // Дальние тела раньше, ближние позже: ближние перекрывают дальних.
    for(const b of [...app.world.bodies].sort((a,b)=>a.z-b.z))drawBody(ctx,b,t);
    // В режиме возмущения вокруг курсора расходятся кольца — источник поля посетителя.
    if(app.started&&app.world.mode==='perturb'&&app.pointer.inside){
      ctx.save();ctx.globalCompositeOperation='screen';
      for(let i=0;i<3;i++){
        const rad=(26+i*28+(t*22)%30);
        ctx.beginPath();ctx.ellipse(app.pointer.x,app.pointer.y,rad,rad*.48,0,0,6.283);
        ctx.strokeStyle=rgba(PALETTE.cool,.20-i*.045);ctx.lineWidth=.85;ctx.stroke();
      }
      glow(ctx,app.pointer.x,app.pointer.y,95,PALETTE.cool,.085);
      ctx.restore();
    }
  }

  // ═══ 07 / ИНТЕРФЕЙС ═════════════════════════════════════════════════════════
  // Экранная часть опыта: пролог, живой вид, инспектор тела, окно правил, звук.
  // Элементы разметки ищутся по id из index.html.

  // toast — короткое сообщение внизу экрана (исчезает через 3.3 с).
  function toast(message){
    const box=$('toast');box.textContent=message;box.classList.add('visible');
    clearTimeout(toast.handle);toast.handle=setTimeout(()=>box.classList.remove('visible'),3300);
  }
  // updateInfo — обновляет часы пролога, а в живом виде — seed, число тел, время,
  // строку повествования, инспектор и звук (не чаще, чем раз в 0.25 с).
  function updateInfo(dt){
    app.elapsedNarration+=dt;
    const secs=app.world.time;
    const fmt=v=>String(Math.floor(v)).padStart(2,'0');
    $('intro-time').textContent=`${fmt(secs/3600)}:${fmt(secs/60%60)}:${fmt(secs%60)}`;
    if(!app.started)return;
    if(app.elapsedNarration>.25){
      app.elapsedNarration=0;
      $('seed-readout').textContent=String(app.world.seed);
      $('population-readout').textContent=`${app.world.bodies.length.toString().padStart(2,'0')} ${tr('bodies')}`;
      $('time-readout').textContent=`${fmt(secs/60)}:${fmt(secs%60)}`;
      $('live-story').textContent=formatEvent(app.world.lastEvent);
      if(app.inspectorOpen)refreshInspector();
      updateAudio();
    }
  }
  // Инспектор на экране: энергия, сигнал, число связей и цепочка операторов выбранного тела.
  function refreshInspector(){
    const b=app.world.bodies[app.selected];if(!b)return;
    $('inspector-id').textContent=b.id;
    $('inspector-name').textContent=programName(b);
    $('metric-energy').textContent=b.energy.toFixed(2);
    $('metric-signal').textContent=b.signal.toFixed(2);
    $('metric-links').textContent=String(b.links).padStart(2,'0');
    $('operator-chain').replaceChildren();
    b.program.ops.forEach((op,i)=>{
      if(i){const arrow=document.createElement('i');arrow.textContent='→';$('operator-chain').append(arrow);}
      const node=document.createElement('span');node.textContent=op;$('operator-chain').append(node);
    });
    $('inspector-note').textContent=b.emitted===0?tr('inspectorNone'):tr('inspectorEmitted',{count:b.emitted});
  }
  // Открыть инспектор тела — клик по телу на сцене.
  function showInspector(i){app.selected=i;app.inspectorOpen=true;$('body-inspector').classList.remove('is-hidden');refreshInspector();}
  // setMode — переключить режим наблюдения. 'observe' — присутствие человека не влияет
  // на мир; 'perturb' — курсор (а в шлеме голова и руки) становится источником поля.
  function setMode(mode){
    app.world.mode=mode;
    $('observe-button').classList.toggle('active',mode==='observe');
    $('perturb-button').classList.toggle('active',mode==='perturb');
    $('mode-hint').textContent=tr(mode==='observe'?'observeHint':'disturbHint');
    if(mode==='perturb')toast(tr('presenceOn'));
    else {app.world.visitor.active=false;app.world.visitor.points=[];}
  }
  // Вход из пролога в живой вид. Мир к этому моменту уже идёт: вход не запускает его.
  function startExperience(){
    app.started=true;$('intro').classList.add('is-hidden');$('live-ui').classList.remove('is-hidden');
    $('body-inspector').classList.add('is-hidden');$('live-story').textContent=formatEvent(app.world.lastEvent);
    toast(tr('welcome'));
  }
  // Новый мир со случайным seed (клавиша R). В шлеме тела пересобираются.
  function regenerate(){
    const next=(Math.floor(Math.random()*900000)+100000);
    app.world=createWorld(next);app.selected=0;app.inspectorOpen=false;app.xrLastContactAt.clear();
    $('body-inspector').classList.add('is-hidden');
    if(app.isXR)rebuildXR();
    toast(tr('regenerate',{seed:next}));
  }
  // Пауза (пробел): симуляция останавливается, картинка остаётся.
  function togglePause(){
    app.world.paused=!app.world.paused;
    $('pause-label').textContent=tr(app.world.paused?'resume':'pause');$('pause-icon').textContent=app.world.paused?'▶':'Ⅱ';
    $('system-status').textContent=tr(app.world.paused?'paused':'active');
  }
  // Окно «Как это устроено»: основания работы и правила; Esc закрывает.
  function openRules(){
    $('toast').classList.remove('visible');
    $('rules-modal').classList.remove('is-hidden');$('modal-close').focus();
  }
  function closeRules(){
    $('rules-modal').classList.add('is-hidden');
    (app.started?$('rules-button'):$('read-rules-button')).focus();
  }
  // Движение мыши по сцене: позиция курсора → точка присутствия посетителя в мире
  // (в режиме возмущения) и какое тело сейчас под курсором.
  function updatePointer(e){
    const rect=app.canvas.getBoundingClientRect();
    app.pointer.x=e.clientX-rect.left;app.pointer.y=e.clientY-rect.top;app.pointer.inside=true;
    const cx=app.width*(app.started?.52:.715), cy=app.height*.475;
    const s=Math.min(app.width*.115,app.height*.205);
    const x=(app.pointer.x-cx)/Math.max(1,s), y=(cy-app.pointer.y)/Math.max(1,s*.88);
    app.world.visitor={x,y,z:-3.1,active:app.world.mode==='perturb',points:[{x,y,z:-3.1,range:2.0,strength:.85}]};
    let best=-1,score=Infinity;
    for(const b of app.world.bodies){const pos=bodyScreen(b);const dist=Math.hypot(pos.x-app.pointer.x,pos.y-app.pointer.y);if(dist<pos.r*.95&&dist<score){best=b.index;score=dist;}}
    app.hovered=best;
    app.canvas.style.cursor=app.started&&best>=0?'pointer':'default';
  }
  // initUI — подписать все элементы интерфейса на события. Вызывается один раз при запуске.
  function initUI(){
    document.querySelectorAll('.lang-button').forEach(el=>el.addEventListener('click',()=>setLanguage(el.dataset.lang)));
    $('start-button').addEventListener('click',startExperience);
    const directXR=$('direct-xr-button');
    if(directXR){directXR.classList.remove('is-hidden');directXR.addEventListener('click',()=>openXR('vr'));}
    $('intro-ar-button').addEventListener('click',()=>openXR('ar'));
    // Возможности устройства — по navigator.xr, а не по догадкам о платформе.
    // Кнопки VR/AR прячем, только если WebXR недоступен в принципе: нет API,
    // страница не по HTTPS или политика встраивания запрещает XR. Наличие самой
    // гарнитуры проверяется в момент входа (openXR): эмуляторы и вложенные
    // страницы отвечают «не поддерживается» ещё до готовности устройства.
    const policy=document.permissionsPolicy||document.featurePolicy;
    const xrAllowed=!policy?.allowsFeature || policy.allowsFeature('xr-spatial-tracking');
    if(!window.isSecureContext||!xrAllowed||!navigator.xr?.isSessionSupported){
      for(const id of ['direct-xr-button','xr-button','intro-ar-button','ar-button'])$(id)?.classList.add('xr-not-supported');
    }
    // Окно правил, режимы наблюдения, новый мир, пауза, звук, вход в VR/AR.
    $('read-rules-button').addEventListener('click',openRules);
    $('rules-button').addEventListener('click',openRules);
    $('modal-close').addEventListener('click',closeRules);
    $('modal-done').addEventListener('click',()=>{closeRules();if(!app.started)startExperience();});
    document.querySelectorAll('[data-close-modal]').forEach(el=>el.addEventListener('click',closeRules));
    $('observe-button').addEventListener('click',()=>setMode('observe'));
    $('perturb-button').addEventListener('click',()=>setMode('perturb'));
    $('regenerate-button').addEventListener('click',regenerate);
    $('pause-button').addEventListener('click',togglePause);
    $('audio-button').addEventListener('click',toggleAudio);
    $('xr-button').addEventListener('click',()=>openXR('vr'));
    $('ar-button').addEventListener('click',()=>openXR('ar'));
    $('xr-back-button').addEventListener('click',closeXR);
    $('close-inspector').addEventListener('click',()=>{app.inspectorOpen=false;$('body-inspector').classList.add('is-hidden');});
    // Сцена: движение мыши, клик по телу, уход курсора.
    const stage=$('p5-stage');
    stage.addEventListener('pointermove',updatePointer);
    stage.addEventListener('pointerdown',e=>{
      if(!app.started||app.isXR)return;updatePointer(e);
      if(app.hovered>=0)showInspector(app.hovered);
    });
    stage.addEventListener('pointerleave',()=>{app.pointer.inside=false;app.hovered=-1;app.world.visitor.active=false;});
    // Клавиатура: Esc — закрыть правила; R — новый мир; P — сменить режим; пробел — пауза.
    window.addEventListener('keydown',e=>{
      if(e.key==='Escape'&&!$('rules-modal').classList.contains('is-hidden'))closeRules();
      if(!app.started||!$('rules-modal').classList.contains('is-hidden'))return;
      if(e.key.toLowerCase()==='r')regenerate();
      if(e.key.toLowerCase()==='p')setMode(app.world.mode==='observe'?'perturb':'observe');
      if(e.code==='Space'&&!e.repeat){e.preventDefault();togglePause();}
    });
  }

  // ─── ЗВУК ────────────────────────────────────────────────────────────────
  // Звук собран из осцилляторов WebAudio, без файлов. По умолчанию выключен:
  // браузер разрешает звук только после действия пользователя.
  // toggleAudio — включить/выключить. При первом включении строится аудиограф:
  // четыре низких осциллятора → фильтр низких частот → общий уровень.
  function toggleAudio(){
    if(app.audioActive){app.audioActive=false;if(app.audio)app.audio.master.gain.setTargetAtTime(.0001,app.audio.ctx.currentTime,.12);$('audio-label').textContent=tr('audioOff');toast(tr('audioMuted'));return;}
    try{
      const AudioContext=window.AudioContext||window.webkitAudioContext;if(!AudioContext)throw new Error('AudioContext unavailable');
      if(!app.audio){
        const ctx=new AudioContext(),master=ctx.createGain();master.gain.value=.0001;
        const filter=ctx.createBiquadFilter();filter.type='lowpass';filter.frequency.value=520;filter.Q.value=.3;
        filter.connect(master);master.connect(ctx.destination);
        const oscillators=[55,82.41,110,164.81].map((freq,i)=>{
          const osc=ctx.createOscillator(),gain=ctx.createGain();osc.type=i%2?'sine':'triangle';osc.frequency.value=freq;gain.gain.value=.12/(1+i*.6);osc.connect(gain);gain.connect(filter);osc.start();return{osc,gain};
        });
        const colorFilter=ctx.createBiquadFilter();colorFilter.type='highpass';colorFilter.frequency.value=46;
        // Голоса почти беззвучны; каждый сигнал ниже получает собственную огибающую.
        app.audio={ctx,master,filter,oscillators,colorFilter,lastPingAt:-10,signalPings:0};
      }
      app.audio.ctx.resume();app.audioActive=true;app.audio.master.gain.setTargetAtTime(.17,app.audio.ctx.currentTime,1.0);if(app.isXR)ensureSpatialVoices();$('audio-label').textContent=tr('audioOn');toast(tr('audioPlaying'));
    }catch(e){toast(tr('audioBlocked'));console.warn(e);}
  }
  // Фон следует за миром: энергия тел открывает фильтр (звук ярче), присутствие
  // посетителя повышает тон, число импульсов в полёте добавляет громкости.
  function updateAudio(){
    if(!app.audio||!app.audioActive)return;
    const a=app.audio,mean=app.world.bodies.reduce((s,b)=>s+b.energy,0)/app.world.bodies.length;
    const presence=app.world.bodies.reduce((sum,b)=>sum+b.visitorInfluence,0)/app.world.bodies.length;
    const activity=clamp(app.world.pulses.length/Math.max(1,app.world.links.length),0,1);
    a.filter.frequency.setTargetAtTime(260+mean*610+presence*1700+activity*550,a.ctx.currentTime,.16);
    a.master.gain.setTargetAtTime(app.audioActive?.12+.045*presence:.0001,a.ctx.currentTime,.22);
    a.oscillators.forEach((voice,i)=>{
      const drift=Math.sin(app.world.time*(.18+i*.05))*.018;
      voice.osc.frequency.setTargetAtTime([55,82.41,110,164.81][i]*(1+mean*.014+presence*.045+drift),a.ctx.currentTime,.25);
    });
  }

  // playSignalSound — короткий сигнал тела: излучение (type 'emit') или приём
  // ('receive'). Тон зависит от номера тела и его программы, длительность — от
  // MEMORY. Сигналы слышны как события среды, а не как «реплики» кому-то.
  function playSignalSound(index,type,strength){
    const a=app.audio;if(!a||!app.audioActive||a.ctx.state!=='running')return;
    // Не чаще одного сигнала в 0.105 с — иначе звуки сливаются в треск.
    if(a.ctx.currentTime-a.lastPingAt<.105)return;
    a.lastPingAt=a.ctx.currentTime;a.signalPings++;
    const b=app.world.bodies[index];if(!b)return;
    const ctx=a.ctx,now=ctx.currentTime,osc=ctx.createOscillator(),gain=ctx.createGain();
    const base=[110,146.83,164.81,196,220][index%5];
    const feedback=b.program.ops.includes('FEEDBACK')?1.25:1;
    osc.type=b.program.ops.includes('FILTER')?'sine':(type==='emit'?'triangle':'sine');
    osc.frequency.setValueAtTime(base*feedback*(type==='emit'?1.5:.75),now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(36,base*feedback*(type==='emit'?1.05:.63)),now+.32);
    const amount=.018+Math.min(.03,strength*.02);
    gain.gain.setValueAtTime(.00001,now);
    gain.gain.exponentialRampToValueAtTime(amount,now+.018);
    const duration=b.program.ops.includes('MEMORY')?.68:.43;
    gain.gain.exponentialRampToValueAtTime(.00001,now+duration);
    if(app.isXR){
      const pan=ctx.createPanner();pan.panningModel='HRTF';pan.distanceModel='inverse';
      pan.refDistance=1.2;pan.maxDistance=24;pan.rolloffFactor=1.1;
      if(pan.positionX){pan.positionX.value=b.x;pan.positionY.value=b.y+1.7;pan.positionZ.value=b.z;}
      else pan.setPosition(b.x,b.y+1.7,b.z);
      osc.connect(gain);gain.connect(pan);pan.connect(a.master);
      osc.onended=()=>{osc.disconnect();gain.disconnect();pan.disconnect();};
    }else{
      osc.connect(gain);gain.connect(a.master);
      osc.onended=()=>{osc.disconnect();gain.disconnect();};
    }
    osc.start(now);osc.stop(now+(b.program.ops.includes('MEMORY')?.70:.45));
  }

  // ═══ 08 / ПРОСТРАНСТВО — A-FRAME 1.8 / THREE R184 ═══════════════════════════
  // Тот же мир в VR и AR. p5 здесь не участвует: A-Frame даёт трекинг гарнитуры,
  // контроллеров и рук, стерео-рендер и размещение в комнате. Состояние мира то же
  // самое (app.world) — второй симуляции нет.
  //
  // Что где (порядок в файле):
  //   тело     шейдерные оболочки, нити, орбиты, ядро   (makeXRBody)
  //   поле     Canvas-текстура под ногами               (drawXRField)
  //   панели   карточка тела и подсказка (createPanel); меню (buildXRMenu)
  //   ввод     лучи контроллеров, руки, стики, кнопки    (xrHoverTarget … xrMoveRig)
  //   сцена    разметка a-scene и два компонента: lantern-input и lantern-simulation
  //
  // Голова в шлеме: при входе в сессию A-Frame обнуляет СУЩНОСТЬ #xr-camera, а позу
  // гарнитуры применяет к внутренней THREE-камере. Поэтому голова всегда читается
  // через xrHeadPosition()/xrHeadForward(), а не у сущности.
  let xrRegistered=false;     // компоненты A-Frame регистрируются один раз
  let xrRaycaster=null;       // переиспользуемый рейкастер луча контроллера
  let handRayScratch=null;    // переиспользуемые векторы луча руки

  // Шейдеры оболочки тела. Оболочка деформируется теми же величинами, что порождают
  // импульсы: uEnergy — амплитуда ряби, uSignal — всплеск, uPresence — усиление от
  // посетителя. Это не посторонняя анимация, а видимое состояние тела.
  const SHELL_VERTEX=`
    uniform float uTime, uEnergy, uSignal, uPresence, uLayer, uLobes, uPhase;
    varying vec3 vN, vEye;
    varying float vWave;
    void main(){
      vec3 pos=position;
      float theta=atan(pos.z,pos.x);
      float ripple=sin(theta*uLobes+pos.y*3.8+uTime*.63+uPhase+uLayer*.8);
      float echo=sin(length(pos)*12.0-uTime*2.3+uPhase);
      float deform=(.032+uEnergy*.038)*ripple+.022*echo+uSignal*.032*sin(theta*4.0-uTime*3.1);
      pos+=normal*deform*(1.0+uPresence*.32);
      vec4 mv=modelViewMatrix*vec4(pos,1.0);
      vN=normalize(normalMatrix*normal);
      vEye=normalize(-mv.xyz);
      vWave=.5+.5*ripple;
      gl_Position=projectionMatrix*mv;
    }
  `;
  const SHELL_FRAGMENT=`
    uniform vec3 uTint;
    uniform float uEnergy, uSignal, uPresence, uLayer;
    varying vec3 vN, vEye;
    varying float vWave;
    void main(){
      float rim=pow(1.0-abs(dot(normalize(vN),normalize(vEye))),2.1);
      vec3 cold=vec3(.32,.64,.77);
      vec3 warm=vec3(1.0,.70,.38);
      vec3 c=mix(cold,uTint,.48+.27*vWave);
      c=mix(c,warm,uEnergy*.28+uSignal*.22);
      float filament=pow(vWave,6.0)*.19;
      float alpha=(.037+rim*.30+filament*.24+uSignal*.13+uPresence*.06)*(1.0-uLayer*.09);
      gl_FragColor=vec4(c*(1.1+rim*.35),clamp(alpha,0.02,.66));
    }
  `;
  // makeShellMaterial — материал оболочки: шейдеры выше и переменные (uniforms),
  // которые каждый кадр заполняются состоянием тела (см. tick в lantern-simulation).
  function makeShellMaterial(THREE,b,layer){
    const color=new THREE.Color(b.tint==='warm'?'#f5bf81':b.tint==='cool'?'#91d7dd':'#c5b0ef');
    return new THREE.ShaderMaterial({
      uniforms:{uTime:{value:0},uEnergy:{value:b.energy},uSignal:{value:0},
        uPresence:{value:0},uLayer:{value:layer},uLobes:{value:b.program.lobes},
        uPhase:{value:b.phase},uTint:{value:color}},
      vertexShader:SHELL_VERTEX,fragmentShader:SHELL_FRAGMENT,
      side:THREE.DoubleSide,transparent:true,depthWrite:false,
      blending:THREE.AdditiveBlending
    });
  }

  // makeXRBody — собрать объёмное тело. Возвращает группу и её части, которые тик
  // обновляет каждый кадр. Тело стоит на высоте y + 1.7 м.
  // Состав группы: невидимая сфера-коллайдер (по ней попадает луч), кольца отклика
  // (фокус, приём сигнала, касание), три оболочки, нити, орбиты, ядро, ореол и блики.
  function makeXRBody(THREE,b){
    const group=new THREE.Group();group.position.set(b.x,b.y+1.7,b.z);
    // Невидимая, но «осязаемая» для луча сфера: целиться в тонкие нити невозможно.
    const collider=new THREE.Mesh(new THREE.SphereGeometry(b.size*1.16,16,10),
      new THREE.MeshBasicMaterial({color:0xffffff,transparent:true,opacity:0,
        depthWrite:false,colorWrite:false,side:THREE.DoubleSide}));
    collider.name='lantern-hit-area';group.add(collider);
    const focusRing=new THREE.Mesh(new THREE.TorusGeometry(b.size*1.14,b.size*.017,8,64),
      new THREE.MeshBasicMaterial({color:'#ffe2ad',transparent:true,opacity:.95,
        blending:THREE.AdditiveBlending,depthWrite:false}));
    focusRing.rotation.x=Math.PI/2;focusRing.visible=false;group.add(focusRing);
    const waveMat=new THREE.MeshBasicMaterial({color:'#f8c894',transparent:true,opacity:0,
      depthWrite:false,blending:THREE.AdditiveBlending});
    const arrivalWave=new THREE.Mesh(new THREE.TorusGeometry(b.size*.75,b.size*.02,6,60),waveMat);
    arrivalWave.rotation.x=Math.PI/2;arrivalWave.visible=false;group.add(arrivalWave);
    const touchWave=new THREE.Mesh(new THREE.TorusGeometry(b.size*.8,b.size*.014,6,60),
      new THREE.MeshBasicMaterial({color:'#99e6ee',transparent:true,opacity:0,depthWrite:false,
        blending:THREE.AdditiveBlending}));
    touchWave.rotation.x=Math.PI/2;touchWave.visible=false;group.add(touchWave);
    const warm=b.tint==='warm';const tint=warm?'#f5bd83':b.tint==='cool'?'#96dce4':'#baaaed';
    const shellMaterials=[];
    for(let layer=0;layer<3;layer++){
      const mat=makeShellMaterial(THREE,b,layer);
      group.add(new THREE.Mesh(createShellGeometry(THREE,b,layer),mat));
      shellMaterials.push(mat);
    }
    // Все нити — один объект LineSegments, а не десятки отдельных примитивов.
    const points=[];const paths=66+b.program.ops.length*6;
    for(let i=0;i<paths;i++){
      const a=i*2.399963+hash(b.morphology+i)*.3;
      const r=b.size*(.42+.7*hash(b.morphology+i*7));
      const turn=.21+hash(i*17+b.morphology)*.58;
      const p0=new THREE.Vector3(Math.cos(a)*r*.14,Math.sin(a*1.3)*r*.12,Math.sin(a)*r*.14);
      const p1=new THREE.Vector3(Math.cos(a+turn*.45)*r*.64,Math.sin(a*1.2+turn)*r*.42,Math.sin(a+turn*.45)*r*.61);
      const p2=new THREE.Vector3(Math.cos(a+turn)*r,Math.sin(a*1.1+turn)*r*.78,Math.sin(a+turn)*r);
      const curve=new THREE.QuadraticBezierCurve3(p0,p1,p2);
      const samples=curve.getPoints(8);
      for(let k=0;k<samples.length-1;k++){
        points.push(samples[k].x,samples[k].y,samples[k].z,samples[k+1].x,samples[k+1].y,samples[k+1].z);
      }
    }
    const filGeo=new THREE.BufferGeometry();filGeo.setAttribute('position',new THREE.Float32BufferAttribute(points,3));
    const filMat=new THREE.LineBasicMaterial({color:tint,transparent:true,opacity:.28,depthWrite:false,blending:THREE.AdditiveBlending});
    group.add(new THREE.LineSegments(filGeo,filMat));
    const orbitMaterial=new THREE.LineBasicMaterial({color:warm?'#e5bf84':'#aad7e1',transparent:true,opacity:.43,depthWrite:false,blending:THREE.AdditiveBlending});
    const orbits=[];
    for(let j=0;j<b.program.rings;j++){
      const pts=[];const radius=b.size*(1.14+j*.15);
      for(let k=0;k<=100;k++){
        const a=k/100*Math.PI*2;
        pts.push(new THREE.Vector3(Math.cos(a)*radius,Math.sin(a)*radius*(.21+j*.065),Math.sin(a*2+j)*radius*.17));
      }
      const path=new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),orbitMaterial);
      path.rotation.set(.25+j*.48,j*.72,.18+j*.45);group.add(path);orbits.push(path);
    }
    const coreMat=new THREE.MeshBasicMaterial({color:'#ffe5ae',transparent:true,opacity:.74,depthWrite:false,blending:THREE.AdditiveBlending});
    const core=new THREE.Mesh(new THREE.IcosahedronGeometry(b.size*.115,2),coreMat);group.add(core);
    const innerGlow=new THREE.Mesh(new THREE.SphereGeometry(b.size*.32,16,12),
      new THREE.MeshBasicMaterial({color:'#e7aa74',transparent:true,opacity:.085,depthWrite:false,blending:THREE.AdditiveBlending}));
    group.add(innerGlow);
    const count=10;
    const glintMat=new THREE.MeshBasicMaterial({color:'#a8edf0',transparent:true,opacity:.7,depthWrite:false});
    const glints=new THREE.InstancedMesh(new THREE.IcosahedronGeometry(b.size*.014,0),glintMat,count);
    glints.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    glints.frustumCulled=false;group.add(glints);
    return {index:b.index,group,collider,focusRing,arrivalWave,touchWave,shellMaterials,filMat,orbits,coreMat,core,glints,
      glintScratch:new THREE.Object3D(),count};
  }

  // createShellGeometry — геометрия оболочки: сфера, искажённая лепестками (lobes).
  // У каждого слоя свой радиус — отсюда слоистость тела.
  function createShellGeometry(THREE,b,layer){
    const lat=20,lon=42,verts=[],indices=[];
    const base=b.size*(.54+layer*.14);
    for(let v=0;v<=lat;v++){
      const phi=v/lat*Math.PI;
      for(let u=0;u<=lon;u++){
        const theta=u/lon*Math.PI*2;
        const distortion=1+.13*Math.sin(theta*b.program.lobes+layer*.8)*Math.sin(phi*1.8)+.09*Math.sin(theta*3+phi*4+layer);
        const r=base*distortion;
        verts.push(Math.sin(phi)*Math.cos(theta)*r,Math.cos(phi)*r*.82,Math.sin(phi)*Math.sin(theta)*r);
      }
    }
    for(let v=0;v<lat;v++)for(let u=0;u<lon;u++){
      const a=v*(lon+1)+u,c=a+lon+1;
      indices.push(a,c,a+1,c,c+1,a+1);
    }
    const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(verts,3));g.setIndex(indices);g.computeVertexNormals();return g;
  }

  // drawXRField — текстура поля под ногами (квадрат 18×18 м вокруг посетителя):
  // концентрические круги, проекция связей на пол и волны недавних излучений.
  function drawXRField(ctx,w,h){
    const t=app.world.time;
    ctx.clearRect(0,0,w,h);
    ctx.fillStyle='#0b1521';ctx.fillRect(0,0,w,h);
    const at=(x,z)=>({x:w/2+x*w/18,y:h/2+z*h/18});
    ctx.lineWidth=.65;
    for(let i=0;i<25;i++){
      const d=(i+1)*w/27;
      ctx.strokeStyle=rgba(i%4===0?PALETTE.warm:PALETTE.cool,.036);
      ctx.beginPath();ctx.arc(w/2,h/2,d,0,6.283);ctx.stroke();
    }
    for(const edge of app.world.links){
      const a=app.world.bodies[edge.a],b=app.world.bodies[edge.b];
      const p=at(a.x,a.z),q=at(b.x,b.z);
      ctx.beginPath();ctx.moveTo(p.x,p.y);ctx.lineTo(q.x,q.y);
      ctx.strokeStyle=rgba(PALETTE.cool,.12);ctx.lineWidth=.65;ctx.stroke();
    }
    for(const event of app.world.emissionHistory){
      const age=t-event.t;if(age<0||age>5)continue;
      const b=app.world.bodies[event.from],p=at(b.x,b.z);
      const r=(.14+age*.7)*w/18;
      ctx.beginPath();ctx.arc(p.x,p.y,r,0,6.283);
      ctx.strokeStyle=rgba(event.influenced?PALETTE.cool:PALETTE.warm,(1-age/5)*.52);
      ctx.lineWidth=1.15;ctx.stroke();
    }
    if(app.world.mode==='perturb')for(const point of app.world.visitor.points){
      const p=at(point.x,point.z);ctx.beginPath();ctx.arc(p.x,p.y,point.range*w/18,0,6.283);
      ctx.strokeStyle=rgba(PALETTE.cool,.2*point.strength);ctx.lineWidth=1;ctx.stroke();
    }
    for(let i=0;i<110;i++){
      const x=hash(app.world.seed+i*5.1)*w,y=hash(app.world.seed+i*18.77)*h;
      ctx.fillStyle=rgba(i%4===0?PALETTE.warm:PALETTE.cool,.10+.22*hash(i*3.1));
      ctx.fillRect(x,y,1.2,1.2);
    }
  }

  // paintXRPanel — нарисовать панель на canvas: заголовок, линия-разделитель, до шести строк.
  function paintXRPanel(canvas,header,lines){
    const ctx=canvas.getContext('2d'),w=canvas.width,h=canvas.height;
    ctx.clearRect(0,0,w,h);
    const bg=ctx.createLinearGradient(0,0,w,h);
    bg.addColorStop(0,'rgba(19,34,49,.98)');bg.addColorStop(1,'rgba(7,13,26,.97)');
    ctx.fillStyle=bg;ctx.fillRect(0,0,w,h);
    ctx.strokeStyle='rgba(148,199,209,.62)';ctx.lineWidth=3;ctx.strokeRect(4,4,w-8,h-8);
    ctx.fillStyle='#ecc894';ctx.font='600 30px Geologica, sans-serif';ctx.fillText(header,43,62);
    ctx.beginPath();ctx.moveTo(43,88);ctx.lineTo(w-43,88);
    ctx.strokeStyle='rgba(184,208,219,.35)';ctx.stroke();
    ctx.fillStyle='#dcebf0';ctx.font='500 26px Geologica, sans-serif';
    lines.slice(0,6).forEach((line,i)=>{
      let value=String(line);
      while(ctx.measureText(value).width>w-92&&value.length>2)value=value.slice(0,-2)+'…';
      ctx.fillText(value,43,143+i*68);
    });
  }
  // createPanel — панель в мире: canvas → текстура → плоскость. Возвращает canvas,
  // texture и плоскость sprite; новый текст рисуют в canvas и ставят needsUpdate.
  // Плоскость (а не THREE.Sprite) закреплена в мире и не поворачивается за головой.
  // Плоскость строится ОТ канваса: ширина задаётся, высота выводится из фактической
  // высоты канваса — пропорции совпадают точно, текст не растягивается.
  function createPanel(THREE,w,h){
    const canvas=document.createElement('canvas');canvas.width=1024;canvas.height=Math.round(1024*h/w);
    paintXRPanel(canvas,'LANTERN // VOID',[tr('xrInitial')]);
    const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;
    const material=new THREE.MeshBasicMaterial({map:texture,transparent:true,depthTest:false,
      depthWrite:false,side:THREE.DoubleSide,toneMapped:false});
    const sprite=new THREE.Mesh(new THREE.PlaneGeometry(w,w*canvas.height/canvas.width),material);
    sprite.renderOrder=22;
    return {canvas,texture,sprite};
  }

  // xrBodyWorldPosition(index) — где тело находится в мире, в метрах сцены.
  function xrBodyWorldPosition(index){
    const item=app.xrBodies[index],THREE=window.AFRAME?.THREE;
    return item&&THREE?item.group.getWorldPosition(new THREE.Vector3()):null;
  }
  // Голова наблюдателя — внутренняя THREE-камера. Меню, карточки, поле присутствия
  // и слушатель звука считаются от неё.
  function xrHeadPosition(target){
    const THREE=window.AFRAME?.THREE,cam=app.xrScene?.camera;
    if(!THREE)return null;
    if(cam)return cam.getWorldPosition(target||new THREE.Vector3());
    const el=app.xrScene?.querySelector('#xr-camera');
    return el?el.object3D.getWorldPosition(target||new THREE.Vector3()):null;
  }
  function xrHeadForward(target){
    const THREE=window.AFRAME?.THREE,cam=app.xrScene?.camera;
    if(!THREE)return null;
    if(cam)return cam.getWorldDirection(target||new THREE.Vector3());
    const el=app.xrScene?.querySelector('#xr-camera');
    return el?el.object3D.getWorldDirection(target||new THREE.Vector3()):null;
  }
  // Карточку выбранного тела поставить рядом с самим телом (панель принадлежит телу,
  // а не зрителю) и развернуть к голове.
  function positionInspectorAtSelection(){
    if(!app.xrLabel||!app.xrScene||app.xrSelection<0)return;
    const THREE=window.AFRAME.THREE;
    const target=xrBodyWorldPosition(app.xrSelection);
    const head=xrHeadPosition();
    if(!target||!head)return;
    const direction=new THREE.Vector3().subVectors(head,target).setY(0).normalize();
    if(direction.lengthSq()<.1)direction.set(0,0,1);
    const sideways=new THREE.Vector3(direction.z,0,-direction.x);
    const offset=app.xrMode==='ar'?.28:.62;
    app.xrLabel.sprite.position.copy(target).addScaledVector(sideways,offset);
    app.xrLabel.sprite.position.y+=app.xrMode==='ar'?.12:.25;
    app.xrLabel.sprite.lookAt(head.x,app.xrLabel.sprite.position.y,head.z);
    app.xrLabel.sprite.scale.setScalar(app.xrMode==='ar'?.55:1);
  }
  // pinXRBody — выбрать тело в шлеме (триггер по телу). Карточка остаётся, пока её
  // не закроют или не выберут другое тело; повторный выбор того же тела закрывает.
  function pinXRBody(index){
    if(!app.xrScene||index<0||!app.world.bodies[index])return;
    if(app.xrSelection===index && app.xrLabel?.sprite.visible){closeXRInspector();return;}
    app.xrSelection=index;
    playUiBlip(880);
    if(app.xrMenuVisible)toggleXRMenu(false);
    positionInspectorAtSelection();refreshXRLabel();
  }
  // Снять выбор.
  function closeXRInspector(){
    app.xrSelection=-1;
    if(app.xrLabel)app.xrLabel.sprite.visible=false;
  }
  // refreshXRLabel — перерисовать карточку выбранного тела: операторы, энергия,
  // импульс, поле посетителя и последнее принятое событие.
  function refreshXRLabel(){
    if(!app.xrLabel)return;
    const index=app.xrSelection;
    if(index<0||!app.world.bodies[index]){
      closeXRInspector();return;
    }
    const b=app.world.bodies[index];
    const lines=[
      b.program.ops.join('  ·  '),
      tr('xrEnergy',{energy:b.energy.toFixed(2),signal:b.signal.toFixed(2)}),
      tr('xrField',{field:b.visitorInfluence.toFixed(2)}),
      (()=>{const e=[...app.world.arrivalHistory].reverse().find(e=>e.to===index);
        return e?`${app.world.bodies[e.from].id} → ${b.id}: ${app.lang==='ru'?'принят сигнал':'signal received'}`:
          (app.lang==='ru'?'Принимает и излучает без вас':'Autonomous signalling');})()
    ];
    paintXRPanel(app.xrLabel.canvas,b.id+' / '+programName(b).toUpperCase(),lines);
    app.xrLabel.texture.needsUpdate=true;
    app.xrLabel.sprite.visible=true;
  }
  // updateXRHoverCard — подсказка «триггер — сведения» над телом, на которое наведён луч.
  function updateXRHoverCard(index){
    if(!app.xrHoverCard)return;
    // Подсказка «триггер — сведения» не налезает на карточку выбранного тела.
    if(index<0||!app.world.bodies[index]||app.xrSelection>=0||app.xrMenuVisible){
      app.xrHoverCard.sprite.visible=false;return;
    }
    const where=xrBodyWorldPosition(index),head=xrHeadPosition();
    if(!where||!head)return;
    paintXRPanel(app.xrHoverCard.canvas,app.world.bodies[index].id,[
      app.lang==='ru'?'ТРИГГЕР / PINCH: СВЕДЕНИЯ':'TRIGGER / PINCH: INSPECT']);
    app.xrHoverCard.texture.needsUpdate=true;
    app.xrHoverCard.sprite.position.copy(where);
    app.xrHoverCard.sprite.position.y+=(app.xrMode==='ar'?.18:.5);
    app.xrHoverCard.sprite.lookAt(head.x,app.xrHoverCard.sprite.position.y,head.z);
    app.xrHoverCard.sprite.scale.setScalar(app.xrMode==='ar'?.50:1);
    app.xrHoverCard.sprite.visible=true;
  }

  // Пространственный звук в шлеме: у первых семи тел — свой голос с панорамированием
  // (HRTF). Тон и громкость голоса зависят от состояния тела.
  function ensureSpatialVoices(){
    if(!app.audio||!app.audioActive||app.audio.spatial)return;
    const a=app.audio;const voices=[];
    try{
      for(const b of app.world.bodies.slice(0,7)){
        const osc=a.ctx.createOscillator(),gain=a.ctx.createGain(),pan=a.ctx.createPanner();
        pan.panningModel='HRTF';pan.distanceModel='inverse';pan.refDistance=1.2;
        pan.maxDistance=20;pan.rolloffFactor=1.5;gain.gain.value=.002;
        osc.type='sine';osc.frequency.value=72+b.index*21;
        osc.connect(gain);gain.connect(pan);pan.connect(a.master);osc.start();
        voices.push({osc,gain,pan,index:b.index});
      }
      a.spatial=voices;
    }catch(e){console.warn('Spatial audio unavailable:',e);for(const v of voices)v.osc.stop();a.spatial=[];}
  }
  // updateSpatialVoices — поставить слушателя в голову и обновить голоса тел.
  function updateSpatialVoices(){
    if(!app.audio||!app.audio.spatial||!app.audioActive)return;
    const {ctx,spatial}=app.audio,listener=ctx.listener;
    const pos=xrHeadPosition(),dir=xrHeadForward();
    if(!pos||!dir)return;
    if(listener.positionX){listener.positionX.value=pos.x;listener.positionY.value=pos.y;listener.positionZ.value=pos.z;
      if(listener.forwardX){listener.forwardX.value=dir.x;listener.forwardY.value=dir.y;listener.forwardZ.value=dir.z;}
      if(listener.upX){listener.upX.value=0;listener.upY.value=1;listener.upZ.value=0;}}
    else if(listener.setPosition){listener.setPosition(pos.x,pos.y,pos.z);listener.setOrientation(dir.x,dir.y,dir.z,0,1,0);}
    for(const v of spatial){
      const b=app.world.bodies[v.index];if(!b)continue;
      const bp=xrBodyWorldPosition(v.index);
      const px=bp?.x??b.x,py=bp?.y??(b.y+1.7),pz=bp?.z??b.z;
      if(v.pan.positionX){v.pan.positionX.value=px;v.pan.positionY.value=py;v.pan.positionZ.value=pz;}
      else v.pan.setPosition(px,py,pz);
      v.osc.frequency.setTargetAtTime((72+b.index*21)*(1+b.signal*.09+b.visitorInfluence*.13),ctx.currentTime,.18);
      v.gain.gain.setTargetAtTime(.006+b.signal*.022+b.energy*.012+b.visitorInfluence*.026,ctx.currentTime,.18);
    }
  }

  // modelPointFromWorld — мировые координаты → координаты модели мира. В AR мир
  // уменьшен и поставлен на поверхность, поэтому учитывается его преобразование.
  function modelPointFromWorld(worldPos){
    if(app.xrMode!=='ar'||!app.xrWorld)return {x:worldPos.x,y:worldPos.y-1.7,z:worldPos.z};
    const p=app.xrWorld.object3D.worldToLocal(worldPos.clone());
    return {x:p.x,y:p.y-1.7,z:p.z};
  }
  // chooseNearbyBody — тело, к поверхности которого ближе всего данная точка
  // (для касания рукой), иначе -1.
  function chooseNearbyBody(point,maxSurfaceDistance=.40){
    let index=-1,best=maxSurfaceDistance;
    for(const body of app.world.bodies){
      const d=distance3(point, {x:body.x,y:body.y+1.7,z:body.z})-body.size*.57;
      if(d<best){best=d;index=body.index;}
    }
    return index;
  }
  // Текст в шлеме рисуется на canvas (Canvas2D), а не встроенным <a-text>: в его
  // шрифтовом атласе нет многих глифов, и русский текст превращается в точки.
  // Canvas2D пользуется системным шрифтом и пишет и кириллицу, и латиницу.
  // makeXRMenuText — строка текста на плоскости шириной width метров. setText(msg)
  // перерисовывает текстуру; длинная строка ужимается, а не выходит за плоскость.
  function makeXRMenuText(THREE,width,height,kind='button'){
    const canvas=document.createElement('canvas');
    canvas.width=1024;canvas.height=Math.round(1024*height/width);
    const texture=new THREE.CanvasTexture(canvas);
    texture.colorSpace=THREE.SRGBColorSpace;
    texture.minFilter=THREE.LinearFilter;
    texture.magFilter=THREE.LinearFilter;
    const material=new THREE.MeshBasicMaterial({map:texture,transparent:true,
      depthTest:false,depthWrite:false,side:THREE.DoubleSide,toneMapped:false});
    // Плейн строится ОТ канваса: целевая ширина сохраняется, высота выводится
    // из фактической (округлённой) высоты канваса — аспекты совпадают точно,
    // текст никогда не растягивается округлением на доли процента.
    const mesh=new THREE.Mesh(new THREE.PlaneGeometry(width,width*canvas.height/canvas.width),material);
    mesh.renderOrder=60;
    const color=kind==='header'?'#f0d3a1':kind==='info'?'#b5cfda':'#e5f1f4';
    function setText(message){
      const ctx=canvas.getContext('2d');
      const value=String(message??'');
      ctx.clearRect(0,0,canvas.width,canvas.height);
      ctx.fillStyle=color;
      ctx.textAlign='center';ctx.textBaseline='middle';
      const ch=canvas.height;
      // Кегль следует физической высоте плоскости: текст не растягивается по ширине.
      const family='Geologica, Arial, sans-serif';
      const maxWidth=canvas.width*.90;
      let size=Math.floor(ch*(kind==='info'?.48:.57));
      ctx.font=`${kind==='header'?700:600} ${size}px ${family}`;
      while(ctx.measureText(value).width>maxWidth&&size>Math.floor(ch*.32)){
        size-=2;ctx.font=`600 ${size}px ${family}`;
      }
      // Очень длинная строка переносится на две строки внутри той же высоты.
      if(ctx.measureText(value).width>maxWidth){
        const words=value.split(/\s+/),lines=[''];
        for(const word of words){
          const candidate=(lines[lines.length-1]+' '+word).trim();
          if(ctx.measureText(candidate).width>maxWidth&&lines.length===1&&lines[0])lines.push(word);
          else lines[lines.length-1]=candidate;
        }
        const lineSize=Math.floor(ch*.34);
        ctx.font=`600 ${lineSize}px ${family}`;
        for(let i=0;i<lines.length;i++){
          let line=lines[i];
          while(ctx.measureText(line).width>maxWidth&&line.length>2)line=line.slice(0,-2)+'…';
          ctx.fillText(line,canvas.width/2,ch*(i===0?.35:.69));
        }
      }else ctx.fillText(value,canvas.width/2,ch/2);
      texture.needsUpdate=true;
    }
    return {mesh,canvas,texture,setText};
  }
  // buildXRMenu — собрать меню в шлеме: фон, шапка, строка-подзаголовок и кнопки.
  // Каждая кнопка — настоящая 3D-поверхность (коробка), по которой попадает луч,
  // и подпись на плоскости. Меню одно на всю сцену и вызывается по Y.
  function buildXRMenu(){
    if(app.xrMenu||!app.xrScene)return;
    const THREE=window.AFRAME.THREE;
    const menu=document.createElement('a-entity');menu.id='xr-context-menu';
    menu.setAttribute('visible','false');
    app.xrScene.appendChild(menu);
    const bg=document.createElement('a-entity');
    bg.setAttribute('geometry','primitive:plane;width:1.12;height:1.04');
    bg.setAttribute('material','shader:flat;color:#112333;opacity:.97;transparent:true;side:double');
    menu.appendChild(bg);
    const header=makeXRMenuText(THREE,1.03,.125,'header');
    header.mesh.position.set(0,.425,.026);menu.object3D.add(header.mesh);
    header.setText('LANTERN // VOID');
    const info=makeXRMenuText(THREE,1.035,.09,'info');
    info.mesh.position.set(0,.338,.026);menu.object3D.add(info.mesh);
    app.xrMenu={entity:menu,background:bg,header,info};
    const actions=['mode','audio','help','exit'];
    for(let i=0;i<actions.length;i++){
      const button=document.createElement('a-entity');
      button.dataset.xrMenuAction=actions[i];button.classList.add('xr-ui-target');
      // Настоящая 3D-поверхность для луча: она существует сразу, в отличие от
      // асинхронной геометрии A-Frame.
      const target=new THREE.Mesh(new THREE.BoxGeometry(1.00,.149,.023),
        new THREE.MeshBasicMaterial({color:'#274253',depthTest:true,depthWrite:true}));
      target.name='menu-target-'+actions[i];
      button.setObject3D('mesh',target);
      button.setAttribute('position',`0 ${.215-i*.165} .035`);
      const label=makeXRMenuText(THREE,.93,.115,'button');
      label.mesh.position.z=.024;button.object3D.add(label.mesh);
      menu.appendChild(button);
      app.xrMenuButtons.push({entity:button,label,action:actions[i],target});
    }
    refreshXRMenu();
    // Когда веб-шрифт догрузится, перерисовать текстуры (до этого — системный шрифт).
    if(document.fonts?.ready)document.fonts.ready.then(()=>refreshXRMenu()).catch(()=>{});
  }
  // refreshXRMenu — обновить меню для текущей страницы и языка. На главной странице
  // четыре кнопки; на странице «Управление» строки-подсказки — простой текст, и
  // нажимается только «← К настройкам».
  function refreshXRMenu(){
    if(!app.xrMenu)return;
    const ru=app.lang==='ru',help=app.xrMenuPage==='help';
    app.xrMenu.info.setText(ru?(help?'УПРАВЛЕНИЕ':'СРЕДА / НАСТРОЙКИ  ·  B: ЗАКРЫТЬ'):(help?'HOW TO EXPLORE':'ENVIRONMENT / SETTINGS  ·  B: CLOSE'));
    // Движение — ходьба стиком и снап-повороты; телепорта в меню нет: в космосе
    // нет пола, и случайное переключение на него лишало бы человека ходьбы.
    const titles=help?(app.xrMode==='ar'?
      (ru?['Поверхность: наведите указатель','Триггер / pinch: разместить мир','Приблизьтесь и коснитесь тела','← К НАСТРОЙКАМ']:
        ['Aim at a real surface','Trigger / pinch: place world','Approach and touch a body','← SETTINGS']):
      (ru?['Левый стик: идти · правый: поворот','Триггер: выбор · grip: контакт','Меню не мешает ходить · Y или B: закрыть','← К НАСТРОЙКАМ']:
        ['Left stick: move · right: turn','Trigger: select · grip: contact','The menu does not block walking · Y or B: close','← SETTINGS'])):
      (ru?[`МОЁ ВЛИЯНИЕ: ${app.world.mode==='perturb'?'ВКЛ.':'ВЫКЛ.'}`,`ЗВУК: ${app.audioActive?'ВКЛ.':'ВЫКЛ.'}`,'КАК УПРАВЛЯТЬ','ВЕРНУТЬСЯ В 2D']:
       [`MY INFLUENCE: ${app.world.mode==='perturb'?'ON':'OFF'}`,`AUDIO: ${app.audioActive?'ON':'OFF'}`,'CONTROLS','RETURN TO 2D']);
    let row=0;
    const last=app.xrMenuButtons.length-1;
    app.xrMenuButtons.forEach((b,i)=>{
      b.entity.object3D.visible=true;
      b.entity.setAttribute('visible',true);
      b.label.setText(titles[i]);
      const enabled=help?i===last:true;
      b.entity.dataset.xrMenuAction=enabled?(help?'back':b.action):'noop';
      // Строки-подсказки — текст, а не кнопки: без плашки и спокойнее по тону.
      // Так интерактивность не кодируется одним цветом (Meta: affordances).
      b.target.visible=enabled;
      b.target.material.color.set(i===last?'#374653':'#274253');
      b.label.mesh.material.color.set(enabled?'#ffffff':'#8fa3b8');
      b.entity.object3D.position.y=.215-row*.165;
      row++;
    });
    app.xrMenu.background.setAttribute('geometry','height',row===4?.88:1.04);
    app.xrMenu.background.object3D.position.y=row===4?.07:0;
  }
  // toggleXRMenu — показать или скрыть меню. Вызывается по Y (контроллер) или щипком
  // левой руки в пустоте. Один раз ставится перед глазами и остаётся на месте в мире.
  function toggleXRMenu(force,origin='controller',page='main'){
    if(!app.xrMenu||!app.xrScene)return;
    const show=typeof force==='boolean'?force:!app.xrMenuVisible;
    app.xrMenuVisible=show;app.xrMenuPage=page;
    app.xrMove={x:0,y:0};
    app.xrMenu.entity.setAttribute('visible',show);
    // Выбранное тело остаётся выбранным; его карточка на время скрыта, чтобы две
    // панели не налезали друг на друга.
    if(app.xrLabel?.sprite && app.xrSelection>=0)app.xrLabel.sprite.visible=!show;
    if(show&&app.xrHoverCard?.sprite)app.xrHoverCard.sprite.visible=false;
    if(!show){for(const side of ['left','right'])app.xrUiHover[side]='';return;}
    // Размещение — по правилам комфорта Meta для панелей в VR: 1.4 м от глаз
    // (для рук ближе, 1.0 м), центр на 12° ниже уровня глаз, плоскость повёрнута
    // к глазам. Меню не следует за головой: повернулся — нажми Y снова.
    const head=xrHeadPosition(),gaze=xrHeadForward();
    if(!head||!gaze)return;
    const forward=gaze.clone();forward.y=0;
    if(forward.lengthSq()<.01)forward.set(0,0,-1);forward.normalize();
    const menu=app.xrMenu.entity.object3D;
    const distance=origin==='hand'?1.0:1.4;
    const drop=12*Math.PI/180;
    menu.position.copy(head).addScaledVector(forward,distance*Math.cos(drop));
    menu.position.y-=distance*Math.sin(drop);
    menu.lookAt(head);
    // Масштаб 0.75: зазор между кнопками 12 мм (минимум для наведения), высота
    // текста кнопки около 2° — удобно читается с 1.4 м.
    menu.scale.setScalar(.75);
    refreshXRMenu();
  }
  // playUiBlip — короткий звук подтверждения действия в меню. С руками он особенно
  // важен: у них нет вибрации контроллера, и звук остаётся главным подтверждением,
  // что нажатие принято.
  function playUiBlip(freq=880){
    const a=app.audio;if(!a||!app.audioActive||a.ctx.state!=='running')return;
    try{
      const ctx=a.ctx,now=ctx.currentTime,osc=ctx.createOscillator(),gain=ctx.createGain();
      osc.type='sine';osc.frequency.value=freq;
      gain.gain.setValueAtTime(.00001,now);
      gain.gain.exponentialRampToValueAtTime(.05,now+.012);
      gain.gain.exponentialRampToValueAtTime(.00001,now+.15);
      osc.connect(gain);gain.connect(a.master);
      osc.start(now);osc.stop(now+.17);
      osc.onended=()=>{osc.disconnect();gain.disconnect();};
    }catch(_){}
  }
  // xrMenuAction — выполнить действие кнопки меню.
  function xrMenuAction(action){
    if(!app.xrMenuVisible)return;
    playUiBlip(action==='exit'?520:740);
    if(action==='mode'){setMode(app.world.mode==='perturb'?'observe':'perturb');}
    else if(action==='audio'){toggleAudio();if(app.audioActive)ensureSpatialVoices();}
    else if(action==='help'){app.xrMenuPage='help';}
    else if(action==='back'){app.xrMenuPage='main';}
    else if(action==='exit'){toggleXRMenu(false);closeXR();return;}
    refreshXRMenu();
  }
  // xrHaptic — короткая вибрация контроллера. Не обязательна: если браузер её не
  // даёт, визуальная и звуковая реакция всё равно остаются.
  function xrHaptic(side,strength=.18,duration=35){
    const session=app.xrScene?.renderer?.xr?.getSession?.();
    const input=[...(session?.inputSources||[])].find(i=>i.handedness===side);
    const gp=input?.gamepad;
    try{
      if(gp?.vibrationActuator?.playEffect){
        const effect=gp.vibrationActuator.playEffect('dual-rumble',{duration,strongMagnitude:strength,weakMagnitude:strength});
        if(effect?.catch)effect.catch(()=>{});
      }else if(gp?.hapticActuators?.[0]?.pulse){
        const result=gp.hapticActuators[0].pulse(strength,duration);
        if(result?.catch)result.catch(()=>{});
      }
    }catch(_){} // Optional: Quest/browser may not expose haptics.
  }
  // xrHoverTarget — во что контроллер смотрит прямо сейчас. Пока меню открыто, цели —
  // только его кнопки (тело за меню не перехватывает триггер), иначе — только тела.
  // Пересечения берутся у raycaster A-Frame и продублированы прямым лучом из
  // контроллера, чтобы только что открытое меню отвечало без задержки.
  function xrHoverTarget(side){
    const ctrl=app.xrScene?.querySelector(`#xr-${side}-controller`);
    if(!ctrl||!app.xrScene||!window.AFRAME)return null;
    const THREE=window.AFRAME.THREE;
    const menuOpen=app.xrMenuVisible;
    const active=menuOpen
      ? app.xrMenuButtons.filter(b=>b.entity.dataset.xrMenuAction!=='noop')
          .map(b=>({object:b.target,el:b.entity}))
      : app.xrBodies.map(b=>({object:b.collider,el:b.entity}));
    if(!active.length)return null;
    const rayComponent=ctrl.components?.raycaster;
    const cached=[];
    for(const entry of (rayComponent?.intersectedEls||[])){
      const match=active.find(item=>item.el===entry);
      if(!match)continue;
      const intersection=rayComponent.getIntersection?.(entry);
      if(intersection)cached.push({el:entry,intersection});
    }
    // Прямой луч из контроллера — запасной путь, пока raycaster A-Frame ещё не
    // успел пересчитать пересечения (например, у только что открытого меню).
    if(!xrRaycaster)xrRaycaster=new THREE.Raycaster();
    const r=xrRaycaster;
    ctrl.object3D.updateWorldMatrix(true,false);
    const origin=ctrl.object3D.getWorldPosition(new THREE.Vector3());
    const quat=ctrl.object3D.getWorldQuaternion(new THREE.Quaternion());
    const direction=new THREE.Vector3(0,0,-1).applyQuaternion(quat).normalize();
    r.set(origin,direction);r.near=.035;r.far=12;
    const owners=new Map(active.map(({object,el})=>[object,el]));
    const objects=active.map(item=>item.object);
    for(const hit of r.intersectObjects(objects,false)){
      const el=owners.get(hit.object);
      if(el)cached.push({el,intersection:hit});
    }
    cached.sort((a,b)=>a.intersection.distance-b.intersection.distance);
    return cached[0]||null;
  }
  // xrUpdateHover — наведение одним контроллером: найти цель, запомнить её,
  // подсветить кнопку меню, поставить точку-прицел и поменять цвет луча.
  function xrUpdateHover(side){
    const ctrl=app.xrScene?.querySelector(`#xr-${side}-controller`);
    if(!ctrl)return;
    const hit=xrHoverTarget(side);
    const index=hit?.el?.dataset?.bodyIndex!==undefined?Number(hit.el.dataset.bodyIndex):-1;
    const ui=app.xrMenuVisible?hit?.el?.dataset?.xrMenuAction||'':'';
    if(app.xrHoverBySide[side]!==index || app.xrUiHover[side]!==ui){
      if(index>=0||(ui&&ui!=='noop'))xrHaptic(side,.12,25);
      app.xrHoverBySide[side]=index;app.xrUiHover[side]=ui;
      if(app.xrMenuVisible){
        app.xrMenuButtons.forEach(b=>b.target.material.color.set(
          b.entity.dataset.xrMenuAction===ui&&ui!=='noop'?'#8aaebb':'#274253'));
      }
    }
    // Точка на конце луча: видно, куда попадаешь.
    let dot=app.xrReticles[side];
    if(!dot && window.AFRAME){
      const THREE=window.AFRAME.THREE;
      dot=new THREE.Mesh(new THREE.SphereGeometry(.026,10,8),
        new THREE.MeshBasicMaterial({color:'#fce3ad',transparent:true,opacity:.95,depthWrite:false,depthTest:false}));
      app.xrScene.object3D.add(dot);app.xrReticles[side]=dot;
    }
    if(dot){dot.visible=Boolean(hit);
      if(hit)dot.position.copy(hit.intersection.point);
    }
    const tint=hit?'#f9d69c':'#8cb9d0';
    // Цвет луча меняется при наведении; обновляется только при смене, не каждый кадр.
    if(ctrl.__lanternTint!==tint){
      ctrl.__lanternTint=tint;
      ctrl.setAttribute('line','color',tint);
    }
  }
  // toggleXRHelp — открыть страницу «Управление». Если подключены только руки
  // (без контроллеров), меню ставится ближе — как для рук.
  function toggleXRHelp(force){
    if(!app.xrMenu)return;
    const show=typeof force==='boolean'?force:!app.xrMenuVisible;
    const session=app.xrScene?.renderer?.xr?.getSession?.();
    const handOnly=Array.from(session?.inputSources||[]).some(input=>input.hand) &&
      !Array.from(session?.inputSources||[]).some(input=>input.gamepad?.buttons?.length);
    toggleXRMenu(show,handOnly?'hand':'controller','help');
  }
  // xrSnapTurn — снап-поворот на 30°. Дискретный шаг вместо плавного вращения
  // укачивает меньше.
  function xrSnapTurn(dir){
    const rig=app.xrScene?.querySelector('#xr-rig');
    if(!rig||app.xrMode==='ar')return;
    // Риг поворачивается вокруг своего центра; поправка возвращает голову на место,
    // чтобы человека не увело дугой, если он стоит не в центре.
    const before=xrHeadPosition();
    rig.object3D.rotation.y+=dir*Math.PI/6; // 30° за шаг
    const after=xrHeadPosition();
    if(!before||!after)return;
    rig.object3D.position.add(before.sub(after));
  }
  // Управление по раскладке Meta для Quest: левый стик — ходьба, правый — снап-поворот.
  // Открытое меню НЕ запирает движение: подсказка при входе открывается сама, и
  // человек с первой секунды может идти. Меню стоит в мире; Y закрывает его.
  // xrStickInput — наклон стика (x, y от -1 до 1) для одной руки.
  // Левый стик задаёт направление и скорость ходьбы. Правый стик поворачивает на
  // 30°, но один раз за отклонение: пока стик не вернётся почти в центр, новый
  // поворот не сработает (защёлка latched).
  function xrStickInput(side,x,y){
    if(app.xrMode!=='vr')return;
    if(side==='left')app.xrMove={x,y};
    if(side==='right'){
      if(Math.abs(x)<.38)app.xrTurn.latched=false;
      else if(Math.abs(x)>.76&&!app.xrTurn.latched){
        app.xrTurn.latched=true;xrSnapTurn(-Math.sign(x));xrHaptic(side,.15,30);
      }
    }
  }
  // xrPollGamepads — каждый кадр читает стики контроллеров из XR-сессии. У геймпада
  // Quest первые две оси — сенсорная зона, стик — оси 2 и 3.
  function xrPollGamepads(){
    const session=app.xrScene?.renderer?.xr?.getSession?.();
    if(!session)return;
    for(const input of session.inputSources){
      const axes=input.gamepad?.axes;
      if(!axes||axes.length<2||!['left','right'].includes(input.handedness))continue;
      const x=Number(axes.length>=4?axes[2]:axes[0])||0;
      const y=Number(axes.length>=4?axes[3]:axes[1])||0;
      xrStickInput(input.handedness,x,y);
    }
  }
  // xrMoveRig — ходьба: риг (а с ним и человек) сдвигается по горизонтали взгляда.
  // Наклон стика задаёт направление, скорость — до 1.15 м/с. Предел — 8.3 м от центра.
  function xrMoveRig(delta){
    const rig=app.xrScene?.querySelector('#xr-rig');
    if(!rig||app.xrMode==='ar')return;
    const x=app.xrMove.x,y=app.xrMove.y;
    if(Math.hypot(x,y)<.16)return;
    const THREE=window.AFRAME.THREE;
    const gaze=xrHeadForward();
    const f=gaze?gaze.clone().setY(0):new THREE.Vector3(0,0,-1);
    if(f.lengthSq()<.01)f.set(0,0,-1);f.normalize();
    const right=new THREE.Vector3().crossVectors(f,new THREE.Vector3(0,1,0)).normalize();
    const velocity=f.multiplyScalar(-y).addScaledVector(right,x);
    if(velocity.lengthSq()>1)velocity.normalize();
    rig.object3D.position.addScaledVector(velocity,Math.min(delta,.05)*1.15);
    rig.object3D.position.x=clamp(rig.object3D.position.x,-8.3,8.3);
    rig.object3D.position.z=clamp(rig.object3D.position.z,-8.3,8.3);
  }
  // selectFromController — триггер контроллера: если луч на кнопке меню — нажать её,
  // если на теле — выбрать тело. В AR до размещения мира выбор недоступен.
  function selectFromController(controller){
    const hand=controller?.id?.includes('left')?'left':'right';
    const hit=xrHoverTarget(hand);
    if(!hit)return false;
    const el=hit.el;
    if(app.xrMenuVisible && el.dataset.xrMenuAction){
      xrMenuAction(el.dataset.xrMenuAction);
      xrHaptic(hand,.32,48);return true;
    }
    if(app.xrMode==='ar'&&!app.arPlaced)return false;
    if(el.dataset.bodyIndex!==undefined)pinXRBody(Number(el.dataset.bodyIndex));
    else return false;
    xrHaptic(hand,.38,65);
    return true;
  }
  // updateHandRay — луч от руки. Работает и без контроллеров: рукой указывают на
  // далёкое или высокое тело и щипком выбирают его. Поза луча читается из кадра XR
  // (getPose доступен только в кадре анимации сцены).
  function updateHandRay(side){
    const scene=app.xrScene,THREE=window.AFRAME?.THREE;
    app.xrHandRayHits[side]=null;
    if(!scene||!THREE)return;
    const xr=scene.renderer?.xr,session=xr?.getSession?.();
    const input=[...(session?.inputSources||[])].find(src=>src.hand&&src.handedness===side);
    const frame=xr?.getFrame?.(),ref=xr?.getReferenceSpace?.();
    let state=app.xrHandReticles[side];
    if(!state){
      const dot=new THREE.Mesh(new THREE.SphereGeometry(.021,12,8),
        new THREE.MeshBasicMaterial({color:'#aee8f1',depthTest:false,depthWrite:false}));
      const geom=new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(),new THREE.Vector3()]);
      const line=new THREE.Line(geom,new THREE.LineBasicMaterial({color:'#aee8f1',
        opacity:.53,transparent:true,depthTest:false,depthWrite:false}));
      dot.renderOrder=75;line.renderOrder=74;
      scene.object3D.add(dot,line);state={dot,line};app.xrHandReticles[side]=state;
    }
    state.dot.visible=false;state.line.visible=false;
    if(!input||!frame||!ref)return;
    try{
      const pose=frame.getPose(input.targetRaySpace,ref);
      if(!pose)return;
      // Переиспользуемые векторы и рейкастер: без новых объектов на каждый кадр.
      if(!handRayScratch)handRayScratch={o:new THREE.Vector3(),q:new THREE.Quaternion(),d:new THREE.Vector3(),ray:new THREE.Raycaster()};
      const sc=handRayScratch;
      const p=pose.transform.position,q=pose.transform.orientation;
      const origin=sc.o.set(p.x,p.y,p.z);
      sc.q.set(q.x,q.y,q.z,q.w);
      const direction=sc.d.set(0,0,-1).applyQuaternion(sc.q);
      const rig=scene.querySelector('#xr-rig')?.object3D;
      if(rig){
        rig.updateWorldMatrix(true,false);
        origin.applyMatrix4(rig.matrixWorld);
        direction.transformDirection(rig.matrixWorld);
      }
      const ray=sc.ray;
      ray.ray.set(origin,direction);ray.near=.04;ray.far=10;
      const targets=[],owners=new Map();
      if(!app.xrMenuVisible && (app.xrMode!=='ar'||app.arPlaced)){
        for(const b of app.xrBodies){targets.push(b.collider);owners.set(b.collider,b.entity);}
      }
      if(app.xrMenuVisible){
        for(const b of app.xrMenuButtons){
          if(b.entity.dataset.xrMenuAction==='noop')continue;
          const mesh=b.entity.getObject3D('mesh');
          if(mesh){targets.push(mesh);owners.set(mesh,b.entity);}
        }
      }
      const hit=ray.intersectObjects(targets,false).find(h=>owners.has(h.object));
      if(!hit)return;
      const el=owners.get(hit.object);
      app.xrHandRayHits[side]={el,intersection:hit};
      const position=state.line.geometry.attributes.position;
      position.setXYZ(0,origin.x,origin.y,origin.z);
      position.setXYZ(1,hit.point.x,hit.point.y,hit.point.z);
      position.needsUpdate=true;
      state.dot.position.copy(hit.point);
      state.dot.visible=true;state.line.visible=true;
    }catch(_){/* Трекинг руки может пропасть на кадр — цель не выбираем. */}
  }
  // selectFromHand — щипок рукой. Возле кнопки меню — нажать её; возле тела — выбрать
  // его касанием; на далёкое тело — наведя луч; щипок левой рукой в пустоте — открыть меню.
  function selectFromHand(ev,side){
    if(!app.isXR||!app.xrScene)return;
    const THREE=window.AFRAME.THREE;
    const hand=app.xrScene.querySelector(`#xr-${side}-hand`);
    if(!hand)return;
    const raw=ev?.detail?.position;
    const pos=(raw&&Number.isFinite(raw.x))?new THREE.Vector3(raw.x,raw.y,raw.z):
      hand.object3D.getWorldPosition(new THREE.Vector3());
    if(app.xrMenuVisible){
      // Меню для рук — близкая панель: щипок рядом с кнопкой нажимает её.
      let chosen=null,nearest=.18;
      for(const b of app.xrMenuButtons){
        if(b.entity.dataset.xrMenuAction==='noop')continue;
        const wp=b.entity.object3D.getWorldPosition(new THREE.Vector3());
        const distance=wp.distanceTo(pos);
        if(distance<nearest){chosen=b;nearest=distance;}
      }
      if(chosen){xrMenuAction(chosen.entity.dataset.xrMenuAction);return;}
      const distantMenu=app.xrHandRayHits[side]?.el?.dataset?.xrMenuAction;
      if(distantMenu && distantMenu!=='noop'){xrMenuAction(distantMenu);return;}
      if(side==='left'){toggleXRMenu(false);return;}
    }
    if(app.xrMode==='ar'&&!app.arPlaced)return;
    const point=modelPointFromWorld(pos);
    const picked=chooseNearbyBody(point,app.xrMode==='ar'?.72:.38);
    if(picked>=0){
      if(app.xrSelection===picked)closeXRInspector();
      else pinXRBody(picked);
    } else {
      // Дальнее тело: навести луч руки и щипнуть.
      const farBody=app.xrHandRayHits[side]?.el?.dataset?.bodyIndex;
      if(farBody!==undefined){
        const index=Number(farBody);
        if(app.xrSelection===index)closeXRInspector();else pinXRBody(index);
      } else if(side==='left'&&!app.xrMenuVisible){
        // Щипок левой рукой в пустоте открывает меню.
        toggleXRMenu(true,'hand');
      }
    }
  }

  // registerXR — зарегистрировать два компонента A-Frame. Выполняется один раз.
  function registerXR(){
    if(xrRegistered||!window.AFRAME)return false;
    const AFRAME=window.AFRAME,THREE=AFRAME.THREE;
    // lantern-input — знает, подключён ли контроллер или рука к этой сущности.
    AFRAME.registerComponent('lantern-input',{
      init(){
        this.connected=false;
        this.el.addEventListener('controllerconnected',()=>{this.connected=true;});
        this.el.addEventListener('controllerdisconnected',()=>{this.connected=false;});
      }
    });
    // lantern-simulation — сердце пространственного режима. init подписывает события
    // сессии, tick выполняется каждый кадр: ввод → ходьба → мир → анимация тел → подписи.
    AFRAME.registerComponent('lantern-simulation',{
      init(){
        this.elapsed=0;this.hudClock=0;this.rebased=false;this.ticks=0;this.guideAt=0;
        this.camera=null;this.tmp=new THREE.Vector3();
        this.input=[{hand:'left',id:'xr-left-hand',ctrl:'xr-left-controller'},
                    {hand:'right',id:'xr-right-hand',ctrl:'xr-right-controller'}];
        // prepareAR — вход в AR: мир уменьшается до миниатюры и показывается впереди
        // как предпросмотр, пока устройство ищет поверхность.
        const prepareAR=()=>{
          if(app.arSessionPrepared)return;
          app.arSessionPrepared=true;app.xrMode='ar';app.arPlaced=false;
          if(app.xrWorld){
            app.xrWorld.object3D.scale.setScalar(.125);
            const p=xrHeadPosition()||new THREE.Vector3(0,1.65,0);
            const g=xrHeadForward()||new THREE.Vector3(0,0,-1);
            const f=new THREE.Vector3(g.x,0,g.z);
            if(f.lengthSq()<.01)f.set(0,0,-1);f.normalize();
            app.xrWorld.object3D.position.copy(p).addScaledVector(f,1.2);
            app.xrWorld.object3D.position.y=p.y-.85;
            app.xrWorld.object3D.visible=true;
          }
          this.el.renderer?.setClearColor?.(0x000000,0);
          app.xrTex&&(app.xrTex.floor.visible=false);
          app.xrStars&&(app.xrStars.visible=false);
          closeXRInspector();
          if(!app.xrGuidedModes.ar)this.guideAt=90;
        };
        this.el.addEventListener('enter-vr',()=>{
          if(this.el.is('ar-mode'))prepareAR();
          else {app.xrMode='vr';app.xrWorld&&(app.xrWorld.object3D.visible=true);
            // Подсказка при входе — не сразу, а через 90 кадров: поза гарнитуры
            // должна успеть примениться, иначе меню встанет по устаревшей позе.
            if(!app.xrGuidedModes.vr)this.guideAt=90;}
        });
        // В AR-сессии A-Frame посылает и enter-vr (с состоянием ar-mode), и enter-ar.
        this.el.addEventListener('enter-ar',prepareAR);
        // Триггер ставит мир на место ретикла. Это действие одно: повторные триггеры
        // уже не переносят мир.
        this.el.addEventListener('ar-hit-test-select',()=>{
          if(app.arPlaced)return;
          app.arPlaced=true;app.xrWorld&&(app.xrWorld.object3D.visible=true);
          this.el.setAttribute('ar-hit-test','target',null);
          this.el.setAttribute('ar-hit-test','enabled',false);
          toggleXRMenu(false);
        });
        this.el.addEventListener('exit-vr',()=>{
          // Риг — обратно на нейтральную высоту для десктоп-превью.
          this.rebased=false;this.ticks=0;
          const rig=this.el.querySelector('#xr-rig');
          if(rig)rig.object3D.position.y=0;
          if(app.isXR)closeXR();
        });
      },
      tick(t,dt){
        if(!app.isXR)return;
        const delta=clamp(dt/1000,0,.065);
        if(!this.camera)this.camera=this.el.querySelector('#xr-camera');
        if(!this.camera)return;
        // Кадр под защитой: ошибка внутри тика остановила бы весь рендер A-Frame.
        // Пойманное сохраняется в app.tickErrors (lanternDebug.xrState().tickErrors()).
        try{
        this.ticks++;
        // 1. Подсказка при входе — после того как поза гарнитуры устоялась.
        if(this.guideAt>0&&this.ticks>=this.guideAt){
          this.guideAt=0;
          if(app.xrMode==='ar'?!app.xrGuidedModes.ar:!app.xrGuidedModes.vr){
            (app.xrMode==='ar'?app.xrGuidedModes.ar=true:app.xrGuidedModes.vr=true);
            toggleXRHelp(true);
          }
        }
        // 2. Если у системы нет пола (голова около нуля), поднять риг: мир рассчитан
        // на пол в 1.65 м ниже головы. На Quest с local-floor голова на 1.6–1.9 м —
        // здесь ничего не меняется.
        if(!this.rebased&&this.ticks>=45&&this.el.is('vr-mode')&&app.xrMode!=='ar'){
          const head=xrHeadPosition();
          if(head&&head.y<.8){
            const rig=this.el.querySelector('#xr-rig');
            if(rig)rig.object3D.position.y+=1.65-head.y;
          }
          this.rebased=true;
        }
        // 3. Ходьба и наведение.
        if(app.xrMode!=='ar'){xrPollGamepads();xrMoveRig(delta);}
        if(app.xrMode!=='ar'||app.arPlaced){xrUpdateHover('left');xrUpdateHover('right');}
        updateHandRay('left');updateHandRay('right');
        if(app.xrMode!=='vr'){for(const dot of Object.values(app.xrReticles))dot.visible=false;}   // в AR точка-прицел не нужна
        const hoverIndex=app.xrMode==='ar'&&!app.arPlaced?-1:
          (app.xrHoverBySide.right>=0?app.xrHoverBySide.right:app.xrHoverBySide.left);
        if(hoverIndex!==app.xrHoverCardIndex){
          app.xrHoverCardIndex=hoverIndex;updateXRHoverCard(hoverIndex);
        }
        const cameraPos=xrHeadPosition(new THREE.Vector3());
        if(!cameraPos)return;
        // 4. Присутствие: голова и руки — источники поля. Это влияние на условия
        // среды, а не адресат, которому «говорят».
        const cameraModel=modelPointFromWorld(cameraPos);
        const points=[{...cameraModel,range:2.2,strength:.27,kind:'head'}];
        const handPoints=[];
        for(const slot of this.input){
          for(const id of [slot.id,slot.ctrl]){
            const el=this.el.querySelector('#'+id);if(!el)continue;
            const c=el.components['lantern-input'];
            const handComponent=el.components['hand-tracking-controls'];
            // Если A-Frame даёт позицию кончика указательного пальца — берём её,
            // иначе позу запястья или контроллера.
            const tip=handComponent?.indexTipPosition;
            const pose=(tip&&Number.isFinite(tip.x)&&handComponent.controllerPresent)?tip:
              el.object3D.getWorldPosition(this.tmp);
            const d=pose.distanceTo(cameraPos);
            // Нетрекнутый источник стоит в нуле — не считать его рукой.
            const live=(c?.connected || (el.object3D.visible && d>.16 && d<1.2 && pose.y>.35));
            if(!live || d>1.5)continue;
            handPoints.push({...modelPointFromWorld(pose),range:1.05,strength:app.xrGrip[slot.hand]?1.25:.9,kind:slot.hand});
            break; // для одной стороны предпочитаем руку, а не контроллер
          }
        }
        points.push(...handPoints);
        app.world.visitor={...cameraModel,active:app.world.mode==='perturb' && (app.xrMode!=='ar'||app.arPlaced),
          points:app.world.mode==='perturb'&&(app.xrMode!=='ar'||app.arPlaced)?points:[]};
        // 5. Продвинуть мир — тот же шаг симуляции, что и в плоском виде.
        advanceWorld(app.world,delta);
        // 6. Анимация тел по состоянию: вращение, пульс, оболочки, кольца отклика, ядро, блики.
        for(const item of app.xrBodies){
          const b=app.world.bodies[item.index];if(!b)continue;
          item.group.rotation.y+=delta*(.075+b.freq*.065);
          item.group.rotation.z=.025*Math.sin(app.world.time*.34+b.phase);
          const pulse=1+.016*Math.sin(app.world.time*b.freq*2+b.phase)+b.signal*.052;
          item.group.scale.setScalar(pulse);
          for(const mat of item.shellMaterials){const u=mat.uniforms;
            u.uTime.value=app.world.time;u.uEnergy.value=b.energy;u.uSignal.value=b.signal;u.uPresence.value=b.visitorInfluence;}
          const focus=(app.xrHoverBySide.left===item.index||app.xrHoverBySide.right===item.index);
          const selected=app.xrSelection===item.index;
          item.focusRing.visible=focus||selected;
          item.focusRing.scale.setScalar(1+(focus?.07:0)+.035*Math.sin(app.world.time*2));
          item.focusRing.material.opacity=focus?.92:.43;
          const sinceReceive=app.world.time-b.lastReceivedAt;
          item.arrivalWave.visible=sinceReceive>=0&&sinceReceive<1.4;
          if(item.arrivalWave.visible){
            const u=sinceReceive/1.4;
            item.arrivalWave.scale.setScalar(.85+1.45*u);
            item.arrivalWave.material.opacity=.7*(1-u);
            item.arrivalWave.material.color.set(b.lastReceivedInfluenced?'#a6e6ef':'#f8c894');
          }
          const sinceTouch=app.world.time-b.lastTouchAt;
          item.touchWave.visible=sinceTouch>=0&&sinceTouch<1.1;
          if(item.touchWave.visible){const u=sinceTouch/1.1;
            item.touchWave.scale.setScalar(.8+1.15*u);item.touchWave.material.opacity=.67*(1-u);}

          item.coreMat.opacity=.53+.4*b.energy+(focus?.07:0);
          item.core.scale.setScalar(.8+b.energy*.55+b.signal*.3);
          item.filMat.opacity=.20+b.energy*.12+b.visitorInfluence*.12;
          const scratch=item.glintScratch;
          for(let j=0;j<item.count;j++){
            const a=j*2.399963+app.world.time*(.08+j*.003)+b.phase;
            const r=b.size*(.45+hash(j*4+b.morphology)*.67);
            scratch.position.set(Math.cos(a)*r,Math.sin(a*1.7)*r*.45,Math.sin(a)*r);
            scratch.scale.setScalar(.55+hash(j*.7)*1.3+b.signal*.5);
            scratch.updateMatrix();item.glints.setMatrixAt(j,scratch.matrix);
          }
          item.glints.instanceMatrix.needsUpdate=true;
        }
        // Импульсы в полёте: искра бежит по связи от отправителя к получателю.
        for(const item of app.xrLinks){
          const p=app.world.pulses.find(p=>(p.from===item.a&&p.to===item.b)||(p.from===item.b&&p.to===item.a));
          item.spark.visible=!!p;
          item.line.material.opacity=p?.52:.12;
          if(p){const u=clamp(p.age/p.duration,0,1);item.spark.position.copy(item.curve.getPoint(p.from===item.a?u:1-u));
            item.spark.scale.setScalar(p.influenced?1.9:1.25);
            item.spark.material.color.set(p.influenced?'#a5ecf1':'#ffdeb0');}
        }
        // Касание тела рукой — не выбор, а физическое влияние: рука рядом с телом
        // усиливает поле и оставляет запись в журнале касаний.
        if(app.world.mode==='perturb'){
          for(const point of handPoints){
            for(const b of app.world.bodies){
              const toCore=distance3(point,b);
              if(toCore<b.size*.70+.13){
                point.strength=1.65;point.range=.72;
                const last=app.xrLastContactAt.get(b.index)??-Infinity;
                if(app.world.time-last>.85){
                  app.xrLastContactAt.set(b.index,app.world.time);
                  b.energy=clamp(b.energy+.10,0,1);
                  b.lastTouchAt=app.world.time;
                  app.world.contactHistory.push({index:b.index,time:app.world.time});
                  if(app.world.contactHistory.length>40)app.world.contactHistory.shift();
                }
              }
            }
          }
        }
        // 7. Реже, чем каждый кадр: поле (каждые 0.18 с), карточка и звук (каждые 0.38 с).
        this.elapsed+=delta;this.hudClock+=delta;
        if(this.elapsed>.18){
          this.elapsed=0;
          if(app.xrTex){drawXRField(app.xrTex.canvas.getContext('2d'),512,512);app.xrTex.texture.needsUpdate=true;}
          if(this.hudClock>.38){
            refreshXRLabel();this.hudClock=0;}
          updateSpatialVoices();
        }
        updateInfo(delta);
        }catch(err){
          const msg=String(err&&err.message||err).slice(0,180);
          if(!app.tickErrors.some(e=>e.msg===msg)){
            app.tickErrors.push({msg,at:+app.world.time.toFixed(2)});
            if(app.tickErrors.length>8)app.tickErrors.shift();
            console.error('[lantern] tick error:',err);
          }
        }
      }
    });
    xrRegistered=true;return true;
  }

  // disposeObject — освободить GPU-память геометрий и материалов удаляемого объекта.
  function disposeObject(object){
    object.traverse(o=>{
      if(o.geometry)o.geometry.dispose();
      if(o.material){const mats=Array.isArray(o.material)?o.material:[o.material];
        for(const m of mats)m.dispose();}
    });
  }
  // rebuildXR — (пере)собрать пространство под текущий мир: тела, связи, поле,
  // звёзды, панели и меню. Вызывается при загрузке сцены и при создании нового мира.
  function rebuildXR(){
    if(!app.xrScene||!window.AFRAME)return;
    const THREE=window.AFRAME.THREE;
    const root=app.xrScene.querySelector('#xr-bodies'),linksRoot=app.xrScene.querySelector('#xr-links');
    app.xrWorld=app.xrScene.querySelector('#xr-world');
    if(!root||!linksRoot)return;
    for(const old of Array.from(root.children)){
      if(old.getObject3D('mesh'))disposeObject(old.getObject3D('mesh'));old.remove();
    }
    for(const entry of app.xrLinks){entry.line.geometry.dispose();entry.line.material.dispose();entry.spark.geometry.dispose();entry.spark.material.dispose();}
    linksRoot.object3D.clear();app.xrBodies=[];app.xrLinks=[];closeXRInspector();
    for(const b of app.world.bodies){
      const entity=document.createElement('a-entity');entity.classList.add('xr-body-target');
      root.append(entity);const item=makeXRBody(THREE,b);
      entity.setObject3D('mesh',item.group);
      entity.dataset.bodyIndex=String(b.index);
      // Выбор — только по triggerdown в selectFromController. Синтетический click
      // A-Frame не обрабатываем: два события открыли и сразу закрыли бы карточку.
      item.entity=entity;
      app.xrBodies.push(item);
    }
    for(const edge of app.world.links){
      const a=app.world.bodies[edge.a],b=app.world.bodies[edge.b];
      const va=new THREE.Vector3(a.x,a.y+1.7,a.z),vb=new THREE.Vector3(b.x,b.y+1.7,b.z);
      const mid=va.clone().add(vb).multiplyScalar(.5);mid.y+=.20;
      const curve=new THREE.QuadraticBezierCurve3(va,mid,vb);
      const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(30)),
        new THREE.LineBasicMaterial({color:'#92acb9',transparent:true,opacity:.14,depthWrite:false}));
      const spark=new THREE.Mesh(new THREE.IcosahedronGeometry(.032,0),
        new THREE.MeshBasicMaterial({color:'#ffdeb0',transparent:true,opacity:.94,depthWrite:false}));
      spark.visible=false;linksRoot.object3D.add(line,spark);
      app.xrLinks.push({a:edge.a,b:edge.b,curve,line,spark});
    }
    // Пол: canvas 512×512 → текстура → плоскость 18×18 м.
    if(!app.xrTex){
      const canvas=document.createElement('canvas');canvas.width=512;canvas.height=512;
      drawXRField(canvas.getContext('2d'),512,512);
      const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;
      const floor=new THREE.Mesh(new THREE.PlaneGeometry(18,18),
        new THREE.MeshBasicMaterial({map:texture,transparent:true,opacity:.57,depthWrite:false,side:THREE.DoubleSide}));
      floor.rotation.x=-Math.PI/2;floor.position.set(0,.02,0);
      app.xrTex={texture,canvas,floor};
      app.xrScene.object3D.add(floor);
    }
    // Звёзды вокруг: 460 точек.
    if(!app.xrStars){
      const pos=[];for(let i=0;i<460;i++){
        const a=hash(i*11)*Math.PI*2,r=2.2+hash(i*37)*10.5;
        pos.push(Math.cos(a)*r,.4+hash(i*18)*6.5,Math.sin(a)*r);
      }
      const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));
      const stars=new THREE.Points(g,new THREE.PointsMaterial({color:'#aecbd6',size:.024,sizeAttenuation:true,transparent:true,opacity:.39,depthWrite:false}));
      app.xrScene.object3D.add(stars);app.xrStars=stars;
    }
    if(!app.xrLabel){
      app.xrLabel=createPanel(THREE,.88,.48);
      app.xrScene.object3D.add(app.xrLabel.sprite);
      app.xrLabel.sprite.visible=false;
    }
    if(!app.xrHoverCard){
      app.xrHoverCard=createPanel(THREE,.52,.22);
      app.xrHoverCard.sprite.visible=false;
      app.xrScene.object3D.add(app.xrHoverCard.sprite);
    }
    if(app.audioActive)ensureSpatialVoices();
    buildXRMenu();
  }

  // openXR — вход в VR ('vr') или AR ('ar'). Поддержка проверяется заново при каждом
  // обращении: эмуляторы и вложенные страницы на старте часто отвечают «не поддерживается»
  // ещё до готовности устройства. Отказ честен только по свежему ответу navigator.xr.
  function openXR(mode='vr'){
    if(!navigator.xr){
      toast(mode==='ar'?(app.lang==='ru'?'AR нужен WebXR-совместимый браузер':'AR requires WebXR support')
                       :(app.lang==='ru'?'VR недоступен в этом браузере':'VR unavailable in this browser'));
      return;
    }
    navigator.xr.isSessionSupported(mode==='ar'?'immersive-ar':'immersive-vr').then(ok=>{
      if(ok)openXRLive(mode);
      else toast(mode==='ar'?(app.lang==='ru'?'AR недоступен: нужен совместимый WebXR/ARCore браузер, защищённая страница и разрешение XR.':'AR unavailable: requires compatible WebXR/ARCore device, HTTPS, and XR permission.')
                            :(app.lang==='ru'?'VR недоступен в этом браузере':'VR unavailable in this browser'));
    }).catch(()=>{
      toast(app.lang==='ru'?'Проверка WebXR не удалась. Проверьте защищённое соединение и разрешения.':'WebXR check failed. Check HTTPS and XR permissions.');
    });
  }
  // openXRLive — открыть пространственный режим: при первом входе собрать сцену
  // A-Frame (при повторном — вернуть существующую), включить звук, поставить мир
  // в режим возмущения и запросить сессию.
  function openXRLive(mode='vr'){
    app.xrMode=mode;app.arPlaced=false;app.arSessionPrepared=false;
    if(!window.AFRAME){toast(tr('xrMissing'));return;}
    if(!app.started)startExperience();
    if(!app.audioActive)toggleAudio(); // звук разрешён только после действия пользователя
    registerXR();
    // В шлеме по умолчанию включено возмущение: тела ощущают присутствие человека.
    // Вернуть чистое наблюдение можно кнопкой «Моё влияние» в меню.
    setMode('perturb');
    const xrGuideText=$('xr-overlay').querySelector('[data-i18n="xrGuide"]');
    if(xrGuideText)xrGuideText.textContent=mode==='ar'?
      (app.lang==='ru'?'AR: наведите на поверхность и нажмите триггер для размещения':'AR: aim at a surface and trigger to place'):
      (app.lang==='ru'?'Левый стик: идти · правый: повернуть · триггер: выбор · Y: меню':'Left stick: move · right: turn · trigger: select · Y: menu');
    $('xr-stage').classList.remove('is-hidden');$('xr-overlay').classList.remove('is-hidden');
    if(mode==='ar')toast(app.lang==='ru'?'В AR нажмите системную кнопку Enter AR. Устройство должно поддерживать immersive-ar.':'In AR, use the native Enter AR button. Immersive AR support is required.');
    $('experience').classList.add('is-hidden');app.isXR=true;
    if(app.p5Instance)app.p5Instance.noLoop();
    if(!app.xrScene){
      // Сцена собирается один раз из строки разметки. Что здесь что:
      //   a-scene            lantern-simulation ведёт кадр; webxr просит hit-test (для AR),
      //                      local-floor (пол на y = 0) и трекинг рук; ar-hit-test —
      //                      ретикл 0.14 м, по которому в AR ставится мир.
      //   a-sky              фон; скрывается в AR, чтобы была видна комната.
      //   #xr-world          корень мира: тела и связи. В AR он уменьшен до миниатюры.
      //   #xr-rig            «тело посетителя»: ходьба и поворот двигают риг целиком.
      //     #xr-camera        камера: look-controls (мышь на десктопе), wasd-controls.
      //     #xr-*-hand        отслеживаемые руки: щипок и касание.
      //     #xr-*-controller  контроллеры с лучом (laser-controls): наведение и триггер.
      $('xr-stage').innerHTML=`<a-scene id="xr-scene" embedded lantern-simulation
        webxr="optionalFeatures: hit-test,local-floor,hand-tracking" ar-hit-test="target:#xr-world;enabled:${mode==='ar'};type:map;mapSize:.14 .14"
        renderer="antialias:true; colorManagement:true;alpha:true"
        xr-mode-ui="XRMode:xr" loading-screen="enabled:false">
        <a-sky color="#050a16" hide-on-enter-ar></a-sky>
        <a-entity id="xr-world">
          <a-entity id="xr-bodies"></a-entity><a-entity id="xr-links"></a-entity>
        </a-entity>
        <a-entity id="xr-rig" position="0 0 0">
          <a-entity id="xr-camera" camera="active:true" position="0 1.65 0" look-controls wasd-controls="acceleration:5"></a-entity>
          <a-entity id="xr-left-hand" hand-tracking-controls="hand:left;modelStyle:dots" lantern-input></a-entity>
          <a-entity id="xr-right-hand" hand-tracking-controls="hand:right;modelStyle:dots" lantern-input></a-entity>
          <a-entity id="xr-left-controller" laser-controls="hand:left" raycaster="objects:.xr-body-target,.xr-ui-target;far:12;autoRefresh:true;showLine:true;lineColor:#8cb9d0" lantern-input></a-entity>
          <a-entity id="xr-right-controller" laser-controls="hand:right" raycaster="objects:.xr-body-target,.xr-ui-target;far:12;autoRefresh:true;showLine:true;lineColor:#8cb9d0" lantern-input></a-entity>
        </a-entity>
      </a-scene>`;
      app.xrScene=$('xr-scene');
      const onLoaded=()=>{
        rebuildXR();
        if(app.xrMode==='ar' && app.xrWorld){
          app.xrWorld.object3D.scale.setScalar(.125);
          app.xrWorld.object3D.visible=false;
        }
        // Что делают кнопки Quest:
        //   триггер — выбрать то, на что смотрит луч (в любой руке);
        //   Y (левая) — меню; X (левая) — звук;
        //   B (правая) — закрыть меню или карточку; A (правая) — как триггер;
        //   стики — ходьба и поворот; grip — зажат: рука сильнее влияет на поле.
        const left=app.xrScene.querySelector('#xr-left-controller');
        if(left){
          left.addEventListener('triggerdown',()=>selectFromController(left));
          left.addEventListener('thumbstickmoved',ev=>{
            const source=[...(app.xrScene?.renderer?.xr?.getSession?.()?.inputSources||[])].find(i=>i.handedness==='left');
            if(!source?.gamepad?.axes?.length)xrStickInput('left',ev.detail.x||0,ev.detail.y||0);
          });
          left.addEventListener('controllerdisconnected',()=>{app.xrMove={x:0,y:0};});
          left.addEventListener('gripdown',()=>{app.xrGrip.left=true;});
          left.addEventListener('gripup',()=>{app.xrGrip.left=false;});
          left.addEventListener('xbuttondown',()=>{toggleAudio();if(app.audioActive)ensureSpatialVoices();refreshXRMenu();});
          left.addEventListener('ybuttondown',()=>toggleXRMenu(undefined,'controller','main'));
        }
        const right=app.xrScene.querySelector('#xr-right-controller');
        if(right){
          right.addEventListener('bbuttondown',()=>{if(app.xrMenuVisible)toggleXRMenu(false);else closeXRInspector();});
          right.addEventListener('abuttondown',()=>selectFromController(right));
          right.addEventListener('thumbstickmoved',ev=>{
            const source=[...(app.xrScene?.renderer?.xr?.getSession?.()?.inputSources||[])].find(i=>i.handedness==='right');
            if(!source?.gamepad?.axes?.length)xrStickInput('right',ev.detail.x||0,ev.detail.y||0);
          });
          right.addEventListener('triggerdown',()=>selectFromController(right));
          right.addEventListener('gripdown',()=>{app.xrGrip.right=true;});
          right.addEventListener('gripup',()=>{app.xrGrip.right=false;});
        }
        for(const side of ['left','right']){
          const hand=app.xrScene.querySelector(`#xr-${side}-hand`);
          if(hand)hand.addEventListener('pinchstarted',ev=>selectFromHand(ev,side));
        }
        toast(tr('xrReady'));
      };
      if(app.xrScene.hasLoaded)onLoaded();
      else app.xrScene.addEventListener('loaded',onLoaded,{once:true});
    }else{
      app.xrScene.play();
      app.xrScene.setAttribute('ar-hit-test','target',app.xrScene.querySelector('#xr-world'));
      app.xrScene.setAttribute('ar-hit-test','enabled',mode==='ar');
      const root=app.xrScene.querySelector('#xr-world');
      if(root){root.object3D.scale.setScalar(mode==='ar'?.125:1);root.object3D.position.set(0,0,0);root.object3D.visible=mode!=='ar';}
      if(app.xrTex)app.xrTex.floor.visible=mode!=='ar';
      if(app.xrStars)app.xrStars.visible=mode!=='ar';
    }
    // В AR сессию вводит системная кнопка A-Frame «Enter AR»: сцена могла загрузиться
    // после действия пользователя и не может запросить AR сама. В VR — запрашиваем сразу.
    if(mode==='vr' && app.xrScene?.hasLoaded){
      const enter=app.xrScene.enterVR;
      if(typeof enter==='function'){try{const p=enter.call(app.xrScene);if(p?.catch)p.catch(()=>{});}catch(_){}}
    }
    if(app.audioActive)ensureSpatialVoices();
  }
  // closeXR — выйти из пространственного режима: завершить сессию, спрятать сцену,
  // вернуть плоский холст и сбросить ввод.
  function closeXR(){
    if(!app.isXR)return;
    if(app.xrScene&&app.xrScene.is('vr-mode'))app.xrScene.exitVR();
    if(app.xrScene)app.xrScene.pause();
    app.xrMove={x:0,y:0};app.xrGrip={left:false,right:false};app.xrHoverBySide={left:-1,right:-1};
    for(const dot of Object.values(app.xrReticles))dot.visible=false;
    for(const state of Object.values(app.xrHandReticles)){
      state.dot.visible=false;state.line.visible=false;
    }
    app.xrHandRayHits={left:null,right:null};
    $('xr-stage').classList.add('is-hidden');$('xr-overlay').classList.add('is-hidden');
    $('experience').classList.remove('is-hidden');app.isXR=false;
    app.arPlaced=false;app.arSessionPrepared=false;app.xrMode='vr';
    if(app.xrHoverCard)app.xrHoverCard.sprite.visible=false;
    app.xrHoverCardIndex=-1;
    toggleXRMenu(false);
    if(app.p5Instance)app.p5Instance.loop();
    app.world.visitor.active=false;app.world.visitor.points=[];
    // Если в сессии были ошибки кадров — сказать об этом, а не молчать.
    if(app.tickErrors.length){
      toast(app.lang==='ru'
        ?`XR: сбоев кадра — ${app.tickErrors.length}. Детали: консоль или lanternDebug.xrState().tickErrors()`
        :`XR: ${app.tickErrors.length} frame hiccups. See console or lanternDebug.xrState().tickErrors()`);
    }
  }

  // ═══ 09 / ЗАПУСК ═════════════════════════════════════════════════════════════
  // boot — подключить интерфейс, применить язык и запустить холст. Мир создан раньше
  // (в app) и живёт с первой секунды: пролог его не запускает и не останавливает.
  // window.lanternApp — небольшая публичная ручка для автоматических тестов.
  function boot(){
    try {
      initUI();
      refreshLanguage();
      window.lanternApp={start:startExperience,setLanguage,openRules};
      attachP5();
    } catch(err) {
      console.error('[LANTERN] Boot failed:',err);
      const error=$('boot-error');if(error){error.classList.remove('is-hidden');error.textContent=(app.lang==='en'?'Could not start: ':'Не удалось запустить: ')+err.message;}
    }
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});
  else boot();
})();
