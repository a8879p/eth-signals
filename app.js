/* ETH Сигналы — интерфейс, данные Binance, график, ручные линии, уведомления */
(() => {
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const SYMBOL = 'ETHUSDT';
const LIMIT = 1000;   // максимум Binance за один запрос
const TFS = [
  { id: '15m', label: '15м', sec: 900 },
  { id: '30m', label: '30м', sec: 1800 },
  { id: '1h', label: '1ч', sec: 3600 },
  { id: '4h', label: '4ч', sec: 14400 },
  { id: '6h', label: '6ч', sec: 21600 },
  { id: '1d', label: '1д', sec: 86400 }
];
const TF = Object.fromEntries(TFS.map(t => [t.id, t]));
const REST_HOSTS = ['https://api.binance.com', 'https://data-api.binance.vision', 'https://api1.binance.com', 'https://api2.binance.com'];
const WS_HOSTS = ['wss://stream.binance.com:9443', 'wss://data-stream.binance.vision', 'wss://stream.binance.com:443'];

// ---------- хранилище ----------
const LS = {
  get(k, def) { try { const v = localStorage.getItem('ethsig.' + k); return v == null ? def : JSON.parse(v); } catch (e) { return def; } },
  set(k, v) { try { localStorage.setItem('ethsig.' + k, JSON.stringify(v)); } catch (e) { /* приватный режим */ } }
};
const UI_DEFAULTS = { sound: true, vibrate: true, keepAwake: false, tf: '1h', liqOpacity: 0.9, flipAtr: 0.5,
  diagTarget: 1, diagStop: 1, diagHorizon: 24, diagMinN: 15, diagSrc: 'auto', tgOn: false, tgToken: '', tgChat: '', tgLiq: true, tgStoch: true, tgSq: true, tgOther: false, tgKHi: 90, tgKLo: 20,
  autoOn: true, autoSig: false, autoWin: 5, autoTol: 0.6, autoMax: 8,
  learnOn: false, learnRev: 1.5, learnStop: 1, learnWin: 3, learnBounce: 1, learnBreak: 0.5, learnProx: 0.5, learnH: 24, learnCtl: 8, learnSrc: 'hist', learnEv: 'all' };
let settings = Object.assign({}, Core.DEFAULTS, UI_DEFAULTS, LS.get('settings', {}));
if (!TF[settings.tf]) settings.tf = '1h';
const validLevel = (l) => l && typeof l.id === 'string' && ['sr', 'support', 'resistance', 'liq'].includes(l.type) && Number.isFinite(l.price) && l.price > 0;
// Тип 'sr' — обычный уровень, роль (поддержка / сопротивление) определяется автоматически по цене.
// Старые линии с ручным выбором 'support' / 'resistance' превращаются в 'sr'.
// price2 — верхняя граница диапазона плотности (price — нижняя). У остальных линий его нет.
const normLevel = (l) => {
  if (l.type === 'support' || l.type === 'resistance') l.type = 'sr';
  if (l.type === 'liq' && Number.isFinite(l.price2) && l.price2 > 0 && l.price2 !== l.price) {
    const lo = Math.min(l.price, l.price2), hi = Math.max(l.price, l.price2);
    l.price = lo; l.price2 = hi;
  } else delete l.price2;
  return l;
};
let levels = (LS.get('levels', []) || []).filter(validLevel).map(normLevel);
let history = LS.get('history', []) || [];
const saveSettings = () => LS.set('settings', settings);
const saveLevels = () => { LS.set('levels', levels); diagInvalidateBt(); learnInvalidate(); };

// ---------- снятие плотностей ----------
// Плотность «снята», когда цена дошла до неё. t — время, с которого следим (создание или правка), reach — самая дальняя
// цена после t (для плотности ниже цены — минимум, выше — максимум), takenAt — время свечи, когда цена прошла зону насквозь.
// Снятая часть зоны на графике и в расчётах не участвует: остаётся только то, до чего цена ещё не дошла.
const isTaken = (l) => l.type === 'liq' && !!l.takenAt;
function shownZone(l) {
  const z = Core.zoneOf(l);
  if (l.type !== 'liq' || !Number.isFinite(l.reach)) return z;
  if (l.side === 'above') return l.reach > z.lo ? { lo: Math.min(l.reach, z.hi), hi: z.hi } : z;
  return l.reach < z.hi ? { lo: z.lo, hi: Math.max(l.reach, z.lo) } : z;
}
const isPartial = (l) => { const z = Core.zoneOf(l), s = shownZone(l); return l.type === 'liq' && !l.takenAt && (s.lo !== z.lo || s.hi !== z.hi); };
function resetTake(l) { l.t = Math.floor(Date.now() / 1000); delete l.reach; delete l.reachAt; delete l.takenAt; }
// Возвращает список плотностей, снятых только что; обновляет reach у частично снятых (true в .changed)
function updateTaken() {
  const out = { newly: [], changed: false };
  const d = data['15m'];
  if (!d || !d.candles.length) return out;
  const nowSec = Math.floor(Date.now() / 1000), cs = d.candles;
  levels.forEach(l => {
    if (l.type !== 'liq' || l.takenAt) return;
    if (!l.t) { l.t = nowSec; out.changed = true; }      // плотности, добавленные до этой версии: следим с момента обновления
    const z = Core.zoneOf(l), below = l.side !== 'above';
    const far = below ? z.lo : z.hi;
    let ext = Number.isFinite(l.reach) ? l.reach : (below ? Infinity : -Infinity), extAt = l.reachAt || null, at = null;
    for (let j = cs.length - 1; j >= 0 && cs[j].time >= l.t; j--) {   // с конца, пока свечи не старше t
      const v = below ? cs[j].low : cs[j].high;
      if (below ? v < ext : v > ext) { ext = v; extAt = cs[j].time; }
      if (below ? v <= far : v >= far) at = cs[j].time;                // самая ранняя свеча, где зону прошли насквозь
    }
    if (lastPrice != null) {                                           // цена прямо сейчас (на случай свечи, начатой до t)
      if (below ? lastPrice < ext : lastPrice > ext) { ext = lastPrice; extAt = cs[cs.length - 1].time; }
      if (at == null && (below ? lastPrice <= far : lastPrice >= far)) at = cs[cs.length - 1].time;
    }
    if (Number.isFinite(ext) && ext !== l.reach) { l.reach = ext; l.reachAt = extAt; out.changed = true; }
    if (at != null) { l.takenAt = at; out.newly.push(l); out.changed = true; }
  });
  return out;
}

// ---------- диагностика: хранение ----------
// Живые записи: каждый новый сигнал + контекст + путь цены после него. Исход (победа / стоп / по времени)
// всегда считается заново по пути цены и текущим настройкам, поэтому цель, стоп и горизонт можно менять задним числом.
const HAS_DIAG = typeof Diag !== 'undefined';
const DIAG_CAP = 500;
const validDiag = (r) => r && typeof r.id === 'string' && TF[r.tf] && (r.dir === 'long' || r.dir === 'short') && Array.isArray(r.path) &&
  r.f && typeof r.f === 'object' && Number.isFinite(r.entry) && Number.isFinite(r.atr) && r.atr > 0;
let diagRecs = (LS.get('diag', []) || []).filter(validDiag);
let diagBt = null;          // результат бэктеста по истории (в памяти; null — нужно пересчитать)
let diagVersion = 0, diagMemo = null, diagDirty = false, diagLastPath = 0, diagBtBusy = false;
// Режим обучения: события «подход к линии» / «разворот» / «контроль» + условия + исход (см. learn.js).
// История считается в памяти по загруженным свечам, живые события копятся в браузере после включения сбора.
const HAS_AUTO = typeof Auto !== 'undefined';
let autoHidden = LS.get('autoHidden', []) || [];   // цены автоуровней, которые пользователь перетащил (закрепил как свою линию): их заново не рисуем
let autoModel = null, autoKey = '', autoLevels = [], autoSigKey = '', autoLineObjs = [], autoLastRun = 0;   // автоуровни (auto.js): не сохраняются, считаются по свечам
const HAS_LEARN = typeof Learn !== 'undefined';
const LEARN_CAP = 1500;
const validLearn = (r) => validDiag(r) && typeof r.trig === 'string';
let learnLive = (LS.get('learn', []) || []).filter(validLearn);
let learnSince = LS.get('learnSince', 0) || 0;       // с какой свечи собираем живые события
let learnLines = LS.get('learnLines', {}) || {};      // «id@цена» линии -> когда её впервые увидели (события раньше не считаются)
let learnHist = null, learnVersion = 0, learnMemo = null, learnBusy = false, learnLastScan = 0, learnDirty = false, learnSavedAt = 0;
const diagOpen = new Set(); // какие раскрывающиеся блоки открыты (чтобы не схлопывались при обновлении)

// ---------- состояние ----------
const data = {};              // tf -> {candles, ind}
const sigState = {};          // tf -> состояние дедупликации
const seeded = new Set();     // таймфреймы, по которым первый проход уже сделан молча
const dirty = new Set();
// ТФ, по которому идёт «последняя цена»: 15м, а если он не загрузился, то самый мелкий из загруженных
const priceTf = () => data['15m'] ? '15m' : (TFS.find(t => data[t.id]) || {}).id;
let currentTf = settings.tf;
let lastPrice = null;
let activeSignals = [];
let editMode = false;
let placing = null;           // {cb}
let chartLastTime = 0;
let chartReady = false;

const pad = (n) => String(n).padStart(2, '0');
const round2 = (x) => Math.round(x * 100) / 100;
const fmtP = (x) => (x == null || !Number.isFinite(x)) ? '—' : x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtK = (x) => Number.isFinite(x) ? x.toFixed(1) : '—';
const uid = () => Math.random().toString(36).slice(2, 9);
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
function fmtDT(ts) { const d = new Date(ts * 1000); return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }
function fmtTime(ts) {
  const d = new Date(ts * 1000);
  const base = pad(d.getDate()) + '.' + pad(d.getMonth() + 1);
  return currentTf === '1d' ? base : base + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
function tickFmt(ts, type) {
  const d = new Date(ts * 1000);
  if (type === 0) return String(d.getFullYear());
  if (type === 1) return MONTHS[d.getMonth()];
  if (type === 2) return String(d.getDate());
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}
const fmtStamp = (ms) => { const d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ' ' + pad(d.getDate()) + '.' + pad(d.getMonth() + 1); };

function indexOfTime(arr, t) {
  let lo = 0, hi = arr.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1, v = arr[m].time;
    if (v === t) return m;
    if (v < t) lo = m + 1; else hi = m - 1;
  }
  return -1;
}

// ---------- графики ----------
let priceChart, stochChart, candleSeries, kSeries, dSeries;
const lineObjs = new Map();   // id -> [линии цены]; у диапазона плотности две (верх и низ)
let obLine = null, osLine = null, hiLine = null, loLine = null, band = null, zones = null;

// прозрачная заливка между порогами перепроданности и перекупленности
class BandPrimitive {
  attached(p) { this.series = p.series; this.req = p.requestUpdate; }
  detached() { this.series = null; }
  update() { if (this.req) this.req(); }
  paneViews() {
    const self = this;
    return [{
      zOrder() { return 'bottom'; },
      renderer() {
        return {
          draw() {},
          drawBackground(target) {
            if (!self.series) return;
            const y1 = self.series.priceToCoordinate(settings.overbought), y2 = self.series.priceToCoordinate(settings.oversold);
            if (y1 == null || y2 == null) return;
            target.useMediaCoordinateSpace(({ context, mediaSize }) => {
              context.fillStyle = 'rgba(74,163,255,0.08)';
              context.fillRect(0, Math.min(y1, y2), mediaSize.width, Math.abs(y2 - y1));
            });
          }
        };
      }
    }];
  }
}

// заливка плотностей на графике: горизонтальный отрезок от времени размещения до момента снятия (или до правого края)
class ZonesPrimitive {
  attached(p) { this.series = p.series; this.chart = p.chart; this.req = p.requestUpdate; }
  detached() { this.series = null; this.chart = null; }
  update() { if (this.req) this.req(); }
  // x-координата времени t на текущем ТФ: свеча, в которую оно попало; левее данных — 0, правее — последняя свеча
  xOf(t, width) {
    const d = data[currentTf];
    if (!d || !d.candles.length || !this.chart) return null;
    const cs = d.candles;
    if (t <= cs[0].time) return 0;
    let lo = 0, hi = cs.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (cs[m].time <= t) lo = m; else hi = m - 1; }
    const x = this.chart.timeScale().timeToCoordinate(cs[lo].time);
    return x == null ? null : Math.min(width, Math.max(0, x));
  }
  paneViews() {
    const self = this;
    return [{
      zOrder() { return 'bottom'; },
      renderer() {
        return {
          draw() {},
          drawBackground(target) {
            if (!self.series) return;
            const o = Math.min(1, Math.max(0.1, Number(settings.liqOpacity) || 0.9));
            target.useMediaCoordinateSpace(({ context, mediaSize }) => {
              const W = mediaSize.width;
              const rect = (lo, hi, xa, xb, k) => {
                const yLo = self.series.priceToCoordinate(lo), yHi = self.series.priceToCoordinate(hi);
                if (yLo == null || yHi == null || xb <= xa) return;
                const top = Math.min(yLo, yHi), h = Math.abs(yLo - yHi);
                if (hi > lo) {
                  context.fillStyle = 'rgba(255,221,0,' + (0.2 * o * k).toFixed(3) + ')';
                  context.fillRect(xa, top, xb - xa, Math.max(1, h));
                }
                context.strokeStyle = 'rgba(255,221,0,' + (o * k).toFixed(3) + ')';
                context.lineWidth = hi > lo ? 1 : 2;
                context.beginPath();
                context.moveTo(xa, yLo); context.lineTo(xb, yLo);
                if (hi > lo) { context.moveTo(xa, yHi); context.lineTo(xb, yHi); }
                context.stroke();
              };
              levels.forEach(l => {
                if (l.type !== 'liq') return;
                const z = Core.zoneOf(l);
                const xa = l.t ? self.xOf(l.t, W) : 0;
                if (xa == null) return;
                if (isTaken(l)) {                       // снятая: отрезок от размещения до снятия, бледный
                  const xb = self.xOf(l.takenAt, W);
                  if (xb != null) rect(z.lo, z.hi, xa, xb, 0.45);
                  return;
                }
                const s = shownZone(l);
                rect(s.lo, s.hi, xa, W, 1);            // оставшаяся часть тянется вправо
                if (isPartial(l)) {                     // снятая часть доходит до момента, когда цена её прошла
                  const xb = self.xOf(l.reachAt || l.t, W);
                  if (xb == null) return;
                  if (l.side === 'above') rect(z.lo, s.lo, xa, xb, 0.45); else rect(s.hi, z.hi, xa, xb, 0.45);
                }
              });
            });
          }
        };
      }
    }];
  }
}

function chartOptions(showTime) {
  return {
    autoSize: true,
    layout: { background: { type: LightweightCharts.ColorType.Solid, color: '#0e1117' }, textColor: '#9aa4b2', fontSize: 11 },
    grid: { vertLines: { color: '#151b25' }, horzLines: { color: '#151b25' } },
    rightPriceScale: { borderColor: '#232b38', minimumWidth: 74 },
    timeScale: { visible: showTime, borderColor: '#232b38', rightOffset: 6, timeVisible: true, secondsVisible: false, tickMarkFormatter: tickFmt },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    localization: { timeFormatter: fmtTime }
  };
}

function createCharts() {
  priceChart = LightweightCharts.createChart($('#priceChart'), chartOptions(false));
  candleSeries = priceChart.addCandlestickSeries({
    upColor: '#2ecc71', downColor: '#ff5b5b', borderVisible: false, wickUpColor: '#2ecc71', wickDownColor: '#ff5b5b'
  });
  zones = new ZonesPrimitive();
  candleSeries.attachPrimitive(zones);
  stochChart = LightweightCharts.createChart($('#stochChart'), chartOptions(true));
  stochChart.applyOptions({ rightPriceScale: { borderColor: '#232b38', minimumWidth: 74, scaleMargins: { top: 0.1, bottom: 0.1 } } });
  const fixed = () => ({ priceRange: { minValue: 0, maxValue: 100 } });
  kSeries = stochChart.addLineSeries({ color: '#4aa3ff', lineWidth: 2, priceLineVisible: false, autoscaleInfoProvider: fixed });
  dSeries = stochChart.addLineSeries({ color: '#ff9f43', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, autoscaleInfoProvider: fixed });
  band = new BandPrimitive();
  kSeries.attachPrimitive(band);
  drawStochRefs();

  // синхронизация шкал времени
  let syncing = false;
  const link = (from, to) => from.timeScale().subscribeVisibleLogicalRangeChange(r => {
    if (syncing || !r) return;
    syncing = true;
    try { to.timeScale().setVisibleLogicalRange(r); } finally { syncing = false; }
  });
  link(priceChart, stochChart);
  link(stochChart, priceChart);

  // синхронизация перекрестия. Слушаем только тот график, над которым сейчас курсор: иначе перекрестие, которое
  // мы сами выставили на другом графике, возвращалось бы эхом и сдвигало линию курсора на уровень закрытия свечи
  // (а потом она «ползла» вместе с автошкалой, пока курсор стоит на месте).
  let xhLock = false, hover = null;
  const track = (el, id) => {
    const on = () => { hover = id; }, off = () => { if (hover === id) hover = null; };
    ['pointerenter', 'pointermove', 'pointerdown'].forEach(ev => el.addEventListener(ev, on, true));
    ['pointerleave', 'pointercancel'].forEach(ev => el.addEventListener(ev, off, true));
  };
  track($('#priceChart'), 'p'); track($('#stochChart'), 's');
  const xh = (src, dst, dstSeries, valueOf, id) => src.subscribeCrosshairMove(param => {
    if (xhLock || (hover != null && hover !== id)) return;
    const d = data[currentTf];
    if (!d || !d.ind) return;
    xhLock = true;
    try {
      if (!param.time) { dst.clearCrosshairPosition(); updateStochLegend(d.candles.length - 1); return; }
      const i = indexOfTime(d.candles, param.time);
      if (i < 0) return;
      const v = valueOf(d, i);
      if (Number.isFinite(v)) dst.setCrosshairPosition(v, param.time, dstSeries);
      updateStochLegend(i);
    } finally { xhLock = false; }
  });
  xh(priceChart, stochChart, kSeries, (d, i) => d.ind.k[i], 'p');
  xh(stochChart, priceChart, candleSeries, (d, i) => d.candles[i].close, 's');

  // Постановка линии. Встроенный click графика не срабатывает, если палец удержан дольше ~0.25 с
  // (включается режим перекрестия), поэтому тап любой длины ловим сами по pointerup.
  const placeAt = (y) => {
    if (!placing) return;
    const price = candleSeries.coordinateToPrice(y);
    if (price == null || !(price > 0)) return;
    const cb = placing.cb;
    setPlacing(null);
    cb(round2(price));
  };
  priceChart.subscribeClick(param => { if (param.point) placeAt(param.point.y); });
  const pc = $('#priceChart');
  let pdown = null;
  pc.addEventListener('pointerdown', (e) => { pdown = placing && e.isPrimary ? { x: e.clientX, y: e.clientY } : null; }, true);
  pc.addEventListener('pointerup', (e) => {
    const d = pdown; pdown = null;
    if (!placing || !d || !e.isPrimary) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 10) return;   // палец сдвинулся — это прокрутка графика, не тап
    placeAt(e.clientY - pc.getBoundingClientRect().top);
  }, true);
  bindDrag();
}

function drawStochRefs() {
  if (obLine) kSeries.removePriceLine(obLine);
  if (osLine) kSeries.removePriceLine(osLine);
  const o = { color: '#5b6577', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '' };
  obLine = kSeries.createPriceLine(Object.assign({ price: settings.overbought }, o));
  osLine = kSeries.createPriceLine(Object.assign({ price: settings.oversold }, o));
  if (!hiLine) {
    const e = { lineWidth: 1, lineStyle: 0, axisLabelVisible: false, title: '' };
    hiLine = kSeries.createPriceLine(Object.assign({ price: 100, color: 'rgba(255,91,91,0.3)' }, e));
    loLine = kSeries.createPriceLine(Object.assign({ price: 0, color: 'rgba(46,204,113,0.3)' }, e));
  }
  if (band) band.update();
}

// Линии 100 (красная) и 0 (зелёная) мигают тем чаще и ярче, чем ближе K к краю
let pulseLast = '';
function pulse() {
  const d = data[currentTf];
  if (!d || !d.ind || !hiLine) return;
  const k = d.ind.k[d.candles.length - 1];
  const ob = settings.overbought, os = settings.oversold;
  const clamp = (x) => Math.min(1, Math.max(0, x));
  const iHi = Number.isFinite(k) ? clamp((k - ob) / (100 - ob)) : 0;
  const iLo = Number.isFinite(k) ? clamp((os - k) / os) : 0;
  const t = performance.now() / 1000;
  const calc = (i) => {
    const base = 0.3;
    if (i <= 0) return { a: base, w: 1 };
    const w = 0.5 + 0.5 * Math.sin(2 * Math.PI * (0.8 + 3 * i) * t);
    return { a: base + (1 - base) * i * w, w: Math.round(1 + 2 * i) };
  };
  const h = calc(iHi), l = calc(iLo);
  const sig = h.a.toFixed(2) + h.w + l.a.toFixed(2) + l.w;
  if (sig === pulseLast) return;
  pulseLast = sig;
  hiLine.applyOptions({ color: 'rgba(255,91,91,' + h.a.toFixed(2) + ')', lineWidth: h.w });
  loLine.applyOptions({ color: 'rgba(46,204,113,' + l.a.toFixed(2) + ')', lineWidth: l.w });
}

const toBar = (c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close });
const pt = (time, v) => Number.isFinite(v) ? { time, value: v } : { time };

function renderChart(resetView) {
  const d = data[currentTf];
  if (!d || !d.candles.length) return;
  candleSeries.setData(d.candles.map(toBar));
  kSeries.setData(d.candles.map((c, i) => pt(c.time, d.ind.k[i])));
  dSeries.setData(d.candles.map((c, i) => pt(c.time, d.ind.d[i])));
  chartLastTime = d.candles[d.candles.length - 1].time;
  if (resetView) {
    const n = d.candles.length;
    priceChart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 130), to: n + 8 });
  }
  updateMarkers();
  updateLegends();
  chartReady = true;
}

function updateChartTail() {
  const d = data[currentTf];
  if (!d || !d.candles.length) return;
  const n = d.candles.length, c = d.candles[n - 1];
  const prevTime = n > 1 ? d.candles[n - 2].time : 0;
  if (!chartReady || (c.time !== chartLastTime && prevTime !== chartLastTime)) { renderChart(false); return; }
  candleSeries.update(toBar(c));
  kSeries.update(pt(c.time, d.ind.k[n - 1]));
  dSeries.update(pt(c.time, d.ind.d[n - 1]));
  chartLastTime = c.time;
  updateLegends();
}

// Стрелки на графике: прошлые сигналы из истории — статичные, а стрелки АКТИВНЫХ сейчас сигналов
// (лонг и шорт) мигают, пока условие держится.
let markerList = [];      // [{time, dir, live}]
let markerSig = '';
let liveKey = '';
function buildMarkers() {
  const d = data[currentTf];
  markerList = [];
  if (!d) return;
  const map = new Map();
  history.filter(h => h.tf === currentTf && h.dir && indexOfTime(d.candles, h.candleTime) >= 0)
    .forEach(h => map.set(h.candleTime + h.dir, { time: h.candleTime, dir: h.dir, live: false }));
  activeSignals.filter(s => s.kind === 'signal' && s.tf === currentTf && indexOfTime(d.candles, s.candleTime) >= 0)
    .forEach(s => map.set(s.candleTime + s.dir, { time: s.candleTime, dir: s.dir, live: true }));
  levels.filter(isTaken).forEach(l => {
    const sec = TF[currentTf].sec, t = Math.min(l.takenAt - l.takenAt % sec, d.candles[d.candles.length - 1].time);   // свеча этого ТФ, в которую попало снятие
    if (indexOfTime(d.candles, t) >= 0) map.set('taken' + l.id, { time: t, taken: true, below: l.side !== 'above', text: 'снята ' + fmtP(l.side === 'above' ? Core.zoneOf(l).lo : Core.zoneOf(l).hi).replace(/\.00$/, '') });
  });
  markerList = Array.from(map.values()).sort((a, b) => a.time - b.time);
}
function applyMarkers(alpha) {
  candleSeries.setMarkers(markerList.map(m => {
    if (m.taken) return { time: m.time, position: m.below ? 'belowBar' : 'aboveBar', color: '#ffdd00', shape: 'square', text: m.text, size: 1 };
    const long = m.dir === 'long', rgb = long ? '46,204,113' : '255,91,91';
    return {
      time: m.time,
      position: long ? 'belowBar' : 'aboveBar',
      color: m.live ? 'rgba(' + rgb + ',' + alpha.toFixed(2) + ')' : 'rgb(' + rgb + ')',
      shape: long ? 'arrowUp' : 'arrowDown',
      text: long ? 'L' : 'S',
      size: m.live ? 1.5 : 1
    };
  }));
}
function updateMarkers() {
  if (!data[currentTf]) return;
  buildMarkers();
  markerSig = '';
  applyMarkers(1);
}
function pulseMarkers() {
  if (document.hidden || !markerList.some(m => m.live)) return;
  const w = 0.5 + 0.5 * Math.sin(2 * Math.PI * 1.4 * performance.now() / 1000);   // ~1.4 вспышки в секунду
  const alpha = Math.round((0.12 + 0.88 * w) * 10) / 10;
  const sig = alpha.toFixed(1);
  if (sig === markerSig) return;
  markerSig = sig;
  applyMarkers(alpha);
}
// перестроить стрелки, только если изменился набор активных сигналов на текущем ТФ
function refreshLiveMarkers() {
  const key = activeSignals.filter(s => s.kind === 'signal' && s.tf === currentTf).map(s => s.candleTime + s.dir + s.levelId).join(',') + '|' + levels.filter(isTaken).map(l => l.id + l.takenAt).join(',');
  if (key === liveKey) return;
  liveKey = key;
  updateMarkers();
}

function updateLegends() {
  const d = data[currentTf];
  if (!d || !d.ind) return;
  const n = d.candles.length, a = d.ind.atr[n - 1], p = d.candles[n - 1].close;
  $('#legend').innerHTML = 'ETH/USDT · <b>' + TF[currentTf].label + '</b> · ATR <b>' + fmtP(a) + '</b>' +
    (Number.isFinite(a) ? ' (' + (a / p * 100).toFixed(2) + '%)' : '');
  updateStochLegend(n - 1);
}
function updateStochLegend(i) {
  const d = data[currentTf];
  if (!d || !d.ind || i < 0) return;
  const k = d.ind.k[i], dv = d.ind.d[i];
  $('#stochLegend').innerHTML = 'StochRSI ' + settings.rsiLen + ',' + settings.stochLen + ',' + settings.kLen + ',' + settings.dLen +
    ' · K <b style="color:#4aa3ff">' + fmtK(k) + '</b> · D <b style="color:#ff9f43">' + fmtK(dv) + '</b>';
}

// ---------- авто-роль уровня: поддержка или сопротивление ----------
// Цена ниже линии (подходит снизу) — линия сопротивление, красная.
// Цена выше линии (опустилась сверху) — линия поддержка, зелёная. Пробой меняет роль.
// Чтобы цвет и сигналы не дёргались от проколов вокруг линии, роль меняется, только когда цена
// ушла за линию дальше settings.flipAtr × ATR (берётся ATR 1ч); при 0 меняется сразу.
const roles = {};   // id -> {role, price}; price нужен, чтобы после переноса линии роль назначилась заново
const sideRole = (price) => lastPrice == null ? null : (lastPrice >= price ? 'support' : 'resistance');
function roleOf(l) {
  if (l.type === 'support' || l.type === 'resistance') return l.type;
  const r = roles[l.id];
  return r && r.price === l.price ? r.role : sideRole(l.price);
}
function refAtr() {
  for (const id of ['1h', '15m', '30m', '4h', '6h', '1d']) {
    const d = data[id];
    if (d && d.ind) { const a = d.ind.atr[d.candles.length - 1]; if (Number.isFinite(a)) return a; }
  }
  return NaN;
}
// true, если какая-то роль назначена заново или сменилась (нужно перекрасить линии)
function updateRoles() {
  if (lastPrice == null) return false;
  const a = refAtr();
  const band = Number.isFinite(a) ? a * Math.max(0, Number(settings.flipAtr) || 0) : 0;
  let changed = false;
  levels.concat(settings.autoOn ? autoLevels : []).forEach(l => {
    if (l.type !== 'sr') return;
    const r = roles[l.id];
    let role;
    if (!r || r.price !== l.price) role = sideRole(l.price);
    else if (r.role === 'resistance' && lastPrice > l.price + band) role = 'support';
    else if (r.role === 'support' && lastPrice < l.price - band) role = 'resistance';
    else role = r.role;
    if (!r || r.price !== l.price || r.role !== role) changed = true;
    roles[l.id] = { role, price: l.price };
  });
  return changed;
}
// уровни для Core.evaluate: 'sr' превращается в 'support' или 'resistance'
function effLevels() {
  const out = [];
  levels.forEach(l => {
    if (l.type === 'liq') {
      // снятая — как есть (в расчётах доживает только окно выноса); частично снятая — только оставшаяся часть
      if (l.takenAt || !isPartial(l)) { out.push(l); return; }
      const s = shownZone(l), c = Object.assign({}, l, { price: s.lo });
      if (s.hi > s.lo) c.price2 = s.hi; else delete c.price2;
      out.push(c); return;
    }
    if (l.type !== 'sr') { out.push(l); return; }
    const r = roleOf(l);
    if (r) out.push(Object.assign({}, l, { type: r }));
  });
  if (HAS_AUTO && settings.autoOn && settings.autoSig) {           // автоуровни, если включены сигналы по ним (рядом с вашей линией не дублируем)
    const a = refAtr();
    autoLevels.forEach(l => {
      if (levels.some(u => u.type === 'sr' && Math.abs(u.price - l.price) <= 0.3 * a)) return;
      const r = roleOf(l);
      if (r) out.push(Object.assign({}, l, { type: r }));
    });
  }
  return out;
}

// ---------- автоуровни ----------
const autoCfg = () => ({ win: settings.autoWin, tol: settings.autoTol, max: settings.autoMax });
function autoEnsureModel() {
  if (!HAS_AUTO || !settings.autoOn) return null;
  const s = {};
  ['1h', '4h', '1d'].forEach(tf => { const d = data[tf]; if (d && d.ind && d.candles.length) s[tf] = { candles: d.candles, atr: d.ind.atr, sec: TF[tf].sec }; });
  if (!s['1h']) return null;
  const key = Object.keys(s).map(tf => tf + ':' + s[tf].candles.length + ':' + s[tf].candles[s[tf].candles.length - 1].time).join(',') + '|' + settings.autoWin + '|' + settings.autoTol + '|' + settings.autoMax;
  if (key !== autoKey) { autoModel = Auto.build(s, autoCfg()); autoKey = key; }
  return autoModel;
}
function renderAutoLines() {
  if (typeof candleSeries === 'undefined' || !candleSeries) return;
  autoLineObjs.forEach(h => { try { candleSeries.removePriceLine(h); } catch (e) { /* уже нет */ } });
  autoLineObjs = [];
  if (!settings.autoOn) return;
  autoLevels.forEach(l => {
    const r = roleOf(l);
    autoLineObjs.push(candleSeries.createPriceLine({ price: l.price, color: 'rgba(110,170,255,0.8)', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, axisLabelColor: '#0e1117', axisLabelTextColor: 'rgba(130,180,255,0.95)', title: 'А·' + (r === 'support' ? 'ПОДД' : r === 'resistance' ? 'СОПР' : 'ур.') }));
  });
}
// пересчёт автоуровней у текущей цены; линия, сместившаяся меньше чем на 0.25 ATR, остаётся той же (id и цена)
function autoRefresh(force) {
  if (!HAS_AUTO) return;
  const now = Date.now();
  if (!force && now - autoLastRun < 4000) return;
  autoLastRun = now;
  if (!settings.autoOn) { if (autoLevels.length || autoSigKey) { autoLevels = []; autoSigKey = ''; renderAutoLines(); evaluateAll(); } return; }
  const m = autoEnsureModel(), a = refAtr();
  if (!m || lastPrice == null || !Number.isFinite(a)) return;
  const used = new Set();
  const nl = Auto.now(m, Math.floor(now / 1000), lastPrice).filter(l => !autoHidden.some(h => Math.abs(h - l.price) <= 0.3 * a)).map(l => {
    const p = autoLevels.find(x => !used.has(x.id) && Math.abs(x.price - l.price) <= 0.25 * a);
    if (!p) { used.add(l.id); return l; }
    used.add(p.id);
    return Math.abs(p.price - l.price) <= 0.05 * a ? p : Object.assign({}, l, { id: p.id });
  });
  autoLevels = nl;
  updateRoles();
  const sig = nl.map(l => l.id + '@' + l.price + (roleOf(l) || '')).join('|');
  if (sig === autoSigKey) return;
  autoSigKey = sig;
  renderAutoLines();
  if (settings.autoSig) evaluateAll();
  renderPanel();
}

// ---------- линии уровней ----------
function levelStyle(l) {
  if (l.type === 'liq') {
    const o = Math.min(1, Math.max(0.1, Number(settings.liqOpacity) || 0.9));
    return { color: 'rgba(255,221,0,' + o + ')', labelColor: '#0e1117', labelText: 'rgba(255,221,0,0.9)', lineStyle: 0, lineWidth: 2,
      title: (l.side === 'above' ? 'ЛИКВ ▲' : 'ЛИКВ ▼') + (l.volume ? ' ' + l.volume + 'M' : '') + (l.n > 1 ? ' ×' + l.n : '') };
  }
  const role = roleOf(l);
  if (role === 'resistance') return { color: 'rgba(255,255,255,0.9)', labelColor: '#0e1117', labelText: 'rgba(242,244,248,0.85)', lineStyle: 0, lineWidth: 1, title: 'СОПР' };
  if (role === 'support') return { color: 'rgba(255,255,255,0.9)', labelColor: '#0e1117', labelText: 'rgba(242,244,248,0.85)', lineStyle: 0, lineWidth: 1, title: 'ПОДД' };
  return { color: 'rgba(255,255,255,0.85)', labelColor: '#0e1117', labelText: 'rgba(242,244,248,0.85)', lineStyle: 0, lineWidth: 1, title: 'УРОВЕНЬ' };   // цена ещё не загружена
}
function renderLines() {
  lineObjs.forEach(arr => arr.forEach(h => candleSeries.removePriceLine(h)));
  lineObjs.clear();
  levels.forEach(l => {
    if (isTaken(l)) return;                  // снятая плотность с графика исчезает
    const s = levelStyle(l);
    const z = shownZone(l);
    const mk = (price, title, width) => candleSeries.createPriceLine({ price, color: s.color, lineWidth: width, lineStyle: s.lineStyle, lineVisible: l.type !== 'liq', axisLabelVisible: true, axisLabelColor: s.labelColor, axisLabelTextColor: s.labelText, title });
    // диапазон плотности: две границы тонкими линиями + заливка между ними (ZonesPrimitive)
    lineObjs.set(l.id, z.hi > z.lo ? [mk(z.hi, s.title, 1), mk(z.lo, '', 1)] : [mk(l.price, s.title, s.lineWidth)]);
  });
  $('#lineCount').textContent = levels.filter(l => !isTaken(l)).length;
  if (zones) zones.update();
  renderAutoLines();
}
// перекрасить линии уровней (роль сменилась), не пересоздавая их
function restyleLines() {
  levels.forEach(l => {
    if (l.type !== 'sr') return;
    const hs = lineObjs.get(l.id);
    if (!hs) return;
    const s = levelStyle(l);
    hs.forEach(h => h.applyOptions({ color: s.color, axisLabelColor: s.labelColor, axisLabelTextColor: s.labelText, title: s.title }));
  });
}
function syncLinePrices(l) {
  const hs = lineObjs.get(l.id);
  if (!hs) return;
  const z = shownZone(l);
  if (hs.length === 2) { hs[0].applyOptions({ price: z.hi }); hs[1].applyOptions({ price: z.lo }); }
  else hs[0].applyOptions({ price: l.price });
  if (zones) zones.update();
}

// перетаскивание линий (режим «Правка»)
let drag = null;
function pointY(e) { const p = e.touches && e.touches.length ? e.touches[0] : (e.changedTouches && e.changedTouches.length ? e.changedTouches[0] : e); return p.clientY; }
// Что под пальцем: {l, part}. part: 'p' — обычная линия; для диапазона плотности
// 'hi' / 'lo' — верхняя / нижняя граница, 'all' — вся зона целиком (тянуть за заливку).
function hitLevel(clientY) {
  const rect = $('#priceChart').getBoundingClientRect();
  const y = clientY - rect.top;
  let best = null, bd = 18;
  for (const l of levels) {
    if (isTaken(l)) continue;
    const sz = shownZone(l);
    if (l.type === 'liq' && sz.hi > sz.lo) {
      const yHi = candleSeries.priceToCoordinate(sz.hi), yLo = candleSeries.priceToCoordinate(sz.lo);
      if (yHi == null || yLo == null) continue;
      const dHi = Math.abs(y - yHi), dLo = Math.abs(y - yLo);
      const inside = y > yHi && y < yLo;
      let part = null, dd = 0;
      if (yLo - yHi >= 30) {                  // зона высокая: края и середина различимы
        if (dHi < 12) { part = 'hi'; dd = dHi; }
        else if (dLo < 12) { part = 'lo'; dd = dLo; }
        else if (inside) { part = 'all'; dd = 8; }
      } else if (inside || Math.min(dHi, dLo) < 12) {   // узкая зона: двигаем целиком
        part = 'all'; dd = inside ? 0 : Math.min(dHi, dLo);
      }
      if (part && dd < bd) { bd = dd; best = { l, part }; }
      continue;
    }
    const ly = candleSeries.priceToCoordinate(l.type === 'liq' ? sz.lo : l.price);
    if (ly == null) continue;
    const dd = Math.abs(ly - y);
    if (dd < bd) { bd = dd; best = { l, part: 'p' }; }
  }
  if (settings.autoOn) {                    // автоуровни тоже можно тянуть: при перетаскивании они становятся вашей линией
    for (const l of autoLevels) {
      const ly = candleSeries.priceToCoordinate(l.price);
      if (ly == null) continue;
      const dd = Math.abs(ly - y);
      if (dd < bd) { bd = dd; best = { l, part: 'p', auto: true }; }
    }
  }
  return best;
}
function bindDrag() {
  const el = $('#priceChart');
  const down = (e) => {
    if (!editMode || placing) return;
    const hit = hitLevel(pointY(e));
    if (!hit) return;
    e.stopPropagation();
    if (e.cancelable) e.preventDefault();
    const sy = pointY(e);
    drag = { l: hit.l, part: hit.part, auto: !!hit.auto, moved: false, startY: sy,
      startPrice: candleSeries.coordinateToPrice(sy - el.getBoundingClientRect().top), orig: { price: hit.l.price, price2: hit.l.price2 } };
    window.addEventListener('mousemove', move, true);
    window.addEventListener('mouseup', up, true);
    window.addEventListener('touchmove', move, { capture: true, passive: false });
    window.addEventListener('touchend', up, true);
    window.addEventListener('touchcancel', up, true);
  };
  const move = (e) => {
    if (!drag) return;
    e.stopPropagation();
    if (e.cancelable) e.preventDefault();
    const y = pointY(e);
    if (Math.abs(y - drag.startY) > 4) drag.moved = true;
    if (!drag.moved) return;
    const price = candleSeries.coordinateToPrice(y - el.getBoundingClientRect().top);
    if (price == null || price <= 0) return;
    if (drag.auto) {                         // автоуровень сдвинули: он становится обычной линией, а на старом месте больше не рисуется
      const a0 = drag.l, nl = { id: uid(), type: 'sr', price: a0.price };
      levels.push(nl);
      autoHidden.push(a0.price); if (autoHidden.length > 200) autoHidden.shift();
      LS.set('autoHidden', autoHidden);
      autoLevels = autoLevels.filter(x => x !== a0); autoSigKey = '';
      drag.l = nl; drag.auto = false;
      renderLines();
    }
    const l = drag.l, p = round2(price);
    if (l.type === 'liq' && !drag.reset) { drag.reset = true; const t0 = l.t; resetTake(l); if (t0) l.t = t0; renderLines(); }   // начало плотности остаётся, счёт сноса начинается заново   // зону двигают заново: снятие считаем с этого момента
    if (drag.part === 'hi') l.price2 = Math.max(p, l.price + 0.01);
    else if (drag.part === 'lo') l.price = Math.min(p, l.price2 - 0.01);
    else if (drag.part === 'all') {
      const delta = price - drag.startPrice;
      const w = drag.orig.price2 - drag.orig.price;       // ширина зоны не меняется
      l.price = round2(drag.orig.price + delta);
      l.price2 = round2(l.price + w);
      if (l.price <= 0) { l.price = drag.orig.price; l.price2 = drag.orig.price2; return; }
    } else l.price = p;
    syncLinePrices(l);
    if (updateRoles()) restyleLines();   // цвет меняется прямо во время перетаскивания через цену
  };
  const up = (e) => {
    if (!drag) return;
    e.stopPropagation();
    window.removeEventListener('mousemove', move, true);
    window.removeEventListener('mouseup', up, true);
    window.removeEventListener('touchmove', move, true);
    window.removeEventListener('touchend', up, true);
    window.removeEventListener('touchcancel', up, true);
    const d = drag; drag = null;
    if (d.moved) { saveLevels(); evaluateAll(); renderPanel(); }
    else if (d.auto) toast('Автоуровень: потяните его, чтобы закрепить как свою линию');
    else openLevelModal(d.l);
  };
  el.addEventListener('mousedown', down, true);
  el.addEventListener('touchstart', down, { capture: true, passive: false });
  el.addEventListener('mousemove', (e) => {
    if (!editMode || drag) { el.style.cursor = ''; return; }
    const hit = hitLevel(e.clientY);
    el.style.cursor = hit ? (hit.part === 'all' ? 'grab' : 'ns-resize') : '';
  });
}

function setPlacing(p) {
  placing = p;
  $('#hint').hidden = !p;
}

// ---------- загрузка и поток данных ----------
let restIdx = 0;
async function fetchKlines(tf) {
  let lastErr = new Error('нет ответа');
  for (let i = 0; i < REST_HOSTS.length; i++) {
    const host = REST_HOSTS[(restIdx + i) % REST_HOSTS.length];
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10000);
    try {
      const r = await fetch(host + '/api/v3/klines?symbol=' + SYMBOL + '&interval=' + tf + '&limit=' + LIMIT, { cache: 'no-store', signal: ctl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const a = await r.json();
      if (!Array.isArray(a) || !a.length) throw new Error('пустой ответ');
      restIdx = (restIdx + i) % REST_HOSTS.length;
      const now = Date.now();
      return a.map(k => ({ time: Math.floor(k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], vol: +k[5], closed: k[6] < now }));
    } catch (e) { lastErr = e; } finally { clearTimeout(timer); }
  }
  throw lastErr;
}

async function loadTf(tf) {
  const candles = await fetchKlines(tf);
  data[tf] = { candles, ind: Core.compute(candles, settings) };
  if (tf === currentTf) {
    $('#loading').hidden = true;
    renderChart(!chartReady);
  }
  if (tf === priceTf()) {   // «последняя цена» всегда берётся с самого мелкого ТФ
    lastPrice = data[tf].candles[data[tf].candles.length - 1].close;
    updateHeader();
  }
}

async function loadAll() {
  const errs = await Promise.all(TFS.map(t => loadTf(t.id).then(() => null, e => e)));
  if (!data[currentTf]) {
    const msg = errs.find(Boolean);
    showLoadError(msg && msg.message);
    return false;
  }
  try { autoRefresh(true); } catch (e) { console.error('автоуровни:', e); }
  evaluateAll();
  try { heatRemind(); } catch (e) { console.error('плотности:', e); }
  try { diagUpdatePaths(true); } catch (e) { console.error('диагностика:', e); }
  return true;
}

function showLoadError(detail) {
  const el = $('#loading');
  el.hidden = false;
  el.innerHTML = '<div class="err">Не удалось получить данные Binance' + (detail ? ' (' + esc(detail) + ')' : '') +
    '.<br>Проверьте интернет. Если api.binance.com недоступен в вашей сети, включите VPN.</div><button class="btn primary" id="retry">Повторить</button>';
  $('#retry').onclick = () => { el.innerHTML = '<div>Загрузка данных Binance…</div>'; boot(); };
}

let ws = null, wsTry = 0, wsHostIdx = 0, lastMsg = 0, reconTimer = null;
function setConn(state) { $('#conn').className = state; $('#conn').title = { live: 'Онлайн', connecting: 'Подключение…', off: 'Нет соединения' }[state]; }

function connectWS() {
  clearTimeout(reconTimer);
  const streams = TFS.map(t => SYMBOL.toLowerCase() + '@kline_' + t.id).join('/');
  const url = WS_HOSTS[wsHostIdx % WS_HOSTS.length] + '/stream?streams=' + streams;
  setConn('connecting');
  let sock;
  try { sock = new WebSocket(url); } catch (e) { scheduleReconnect(); return; }
  ws = sock;
  sock.onopen = () => { if (ws !== sock) return; wsTry = 0; lastMsg = Date.now(); setConn('live'); };
  sock.onmessage = (ev) => {
    if (ws !== sock) return;
    lastMsg = Date.now();
    try { const m = JSON.parse(ev.data); if (m.data && m.data.k) applyKline(m.data.k); } catch (e) { /* пропускаем мусор */ }
  };
  sock.onerror = () => { try { sock.close(); } catch (e) { /* */ } };
  sock.onclose = () => { if (ws !== sock) return; setConn('off'); scheduleReconnect(); };
}
function scheduleReconnect() {
  clearTimeout(reconTimer);
  wsHostIdx++;
  const delay = Math.min(30000, 1000 * Math.pow(2, Math.min(wsTry++, 5)));
  reconTimer = setTimeout(async () => { await loadAll(); connectWS(); }, delay);
}
function forceReconnect() {
  if (ws) { const s = ws; ws = null; try { s.close(); } catch (e) { /* */ } }
  setConn('off');
  scheduleReconnect();
}

function applyKline(k) {
  const tf = k.i, d = data[tf];
  if (!d || !d.candles.length) return;
  const c = { time: Math.floor(k.t / 1000), open: +k.o, high: +k.h, low: +k.l, close: +k.c, vol: +k.v, closed: !!k.x };
  const arr = d.candles, last = arr[arr.length - 1];
  if (c.time === last.time) arr[arr.length - 1] = c;
  else if (c.time > last.time) {
    last.closed = true;
    arr.push(c);
    if (arr.length > 3000) arr.shift();
    if (c.time > last.time + TF[tf].sec * 1.5) loadTf(tf).then(() => dirty.add(tf), () => { /* догрузим при следующем событии */ });
  } else return;
  if (tf === priceTf()) lastPrice = c.close;
  dirty.add(tf);
}

function flush() {
  if (!dirty.size) return;
  const tfs = Array.from(dirty); dirty.clear();
  tfs.forEach(tf => { const d = data[tf]; if (d) d.ind = Core.compute(d.candles, settings); });
  if (tfs.includes(currentTf)) updateChartTail();
  updateHeader();
  evaluateAll();
  try { diagUpdatePaths(); } catch (e) { console.error('диагностика:', e); }
}

let prevShown = null;
function updateHeader() {
  const el = $('#price');
  if (lastPrice == null) return;
  el.textContent = fmtP(lastPrice);
  if (prevShown != null && lastPrice !== prevShown) el.className = lastPrice > prevShown ? 'up' : 'down';
  prevShown = lastPrice;
}

// ---------- сигналы ----------
// ---------- сделки ----------
// Сигнал открывает «сделку» на своём ТФ; пока она не завершена, новые сигналы на этом ТФ не открываются.
// Лонг: без стопа, завершается подходом к ближайшему сопротивлению (в пределах «Близость к уровню») или K > 90.
// Шорт: со стопом (за дальним краем плотности сверху), завершается подходом к поддержке или K < 10.
// Автозакрытия по времени нет: сделку можно закрыть вручную кнопкой «Закрыть».
const EXIT_K_HI = 90, EXIT_K_LO = 10, TRADE_MAX_BARS = 48;   // TRADE_MAX_BARS нужен только для старых записей «время вышло»
let trades = LS.get('trades', []) || [];
const saveTrades = () => { if (trades.length > 200) trades = trades.slice(-200); LS.set('trades', trades); };
const openTradeOf = (tf) => trades.find(t => t.tf === tf && t.st === 'open');
const tradeFor = (s) => { for (let i = trades.length - 1; i >= 0; i--) if (trades[i].tf === s.tf && trades[i].sk === s.stateKey) return trades[i]; return null; };
function openTrade(sig) {
  const d = data[sig.tf], i = d ? indexOfTime(d.candles, sig.candleTime) : -1;
  const atr = i >= 0 && d.ind ? d.ind.atr[i] : NaN;
  if (!Number.isFinite(atr)) return;
  const sc = d.candles[i];   // s0: экстремумы сигнальной свечи на момент сигнала (если она ещё формируется), чтобы учесть её остаток
  trades.push({ rid: ridOf(sig), sk: sig.stateKey, tf: sig.tf, dir: sig.dir, t: Date.now(), candleTime: sig.candleTime, entry: sig.price, atr, ex: sig.sub === 'mag', s0: sc.closed === false ? [sc.high, sc.low] : null,
    exit: Number.isFinite(sig.exitPrice) ? sig.exitPrice : null, stop: sig.dir === 'short' && Number.isFinite(sig.stopPrice) ? sig.stopPrice : null, st: 'open' });
  saveTrades();
}
function updateTrades() {
  let changed = false;
  trades.forEach(tr => {
    if (tr.st !== 'open') return;
    const d = data[tr.tf];
    if (!d || !d.ind) return;
    const cs = d.candles, i0 = indexOfTime(cs, tr.candleTime);
    if (i0 < 0) return;
    const prox = (tr.ex ? 0 : settings.proxAtr) * tr.atr, long = tr.dir === 'long';
    let res = null;
    for (let j = tr.s0 ? i0 : i0 + 1; j < cs.length && !res; j++) {
      const own = j === i0, c0 = cs[j];   // сигнальная свеча: считаем только выход за экстремумы, что были на момент сигнала
      const c = own ? { high: c0.high > tr.s0[0] ? c0.high : -Infinity, low: c0.low < tr.s0[1] ? c0.low : Infinity } : c0, k = own ? NaN : d.ind.k[j];
      if (!long && tr.stop != null && c.high >= tr.stop) res = { st: 'stopped', why: 'stop' };
      else if (tr.exit != null && (long ? c.high >= tr.exit - prox : c.low <= tr.exit + prox)) res = { st: 'done', why: 'level' };
      else if (Number.isFinite(k) && (long ? k > EXIT_K_HI : k < EXIT_K_LO)) res = { st: 'done', why: 'stoch' };
    }
    if (!res) return;
    Object.assign(tr, res, { at: Date.now() });
    changed = true;
    if (tr.tg) tgSend('Сделка завершена · ETH ' + TF[tr.tf].label + '\n' + (long ? 'ЛОНГ' : 'ШОРТ') + ': ' + tradeHtml(tr, '').replace(/<[^>]+>/g, ''));   // только по тем сделкам, о входе в которые писали
    toast('<b>Сделка завершена · ' + TF[tr.tf].label + '</b><br>' + (long ? 'ЛОНГ' : 'ШОРТ') + ': ' + tradeHtml(tr, '').replace(/<[^>]+>/g, ''));
  });
  if (changed) saveTrades();
  return changed;
}
// ручное закрытие открытой сделки (кнопка «Закрыть» в строке над графиком и во вкладке «Сигналы»)
document.addEventListener('click', (e) => {
  const b = e.target.closest ? e.target.closest('[data-close-trade]') : null;
  if (!b) return;
  const tr = openTradeOf(b.dataset.closeTrade);
  if (!tr) return;
  if (!confirm('Закрыть сделку вручную? ' + (tr.dir === 'long' ? 'ЛОНГ' : 'ШОРТ') + ' ' + TF[tr.tf].label + ', вход ' + fmtP(tr.entry))) return;
  tr.st = 'closed'; tr.why = 'manual'; tr.at = Date.now();
  saveTrades();
  evaluateAll();
});
function tradeHtml(tr, lead) {
  const f = fmtP, L = tr.dir === 'long';
  const rule = (tr.exit != null ? (tr.ex ? 'подход к краю плотности ' : L ? 'подход к сопротивлению ' : 'подход к поддержке ') + f(tr.exit) + ' или ' : '') + (L ? 'K > ' + EXIT_K_HI : 'K < ' + EXIT_K_LO);
  const stop = tr.stop != null ? 'стоп ' + f(tr.stop) : 'без стопа';
  if (tr.st === 'open') return lead + '⏳ в сделке: ждём ' + rule + ' · ' + stop + ' <button class="btn ico danger" data-close-trade="' + tr.tf + '">Закрыть</button>';
  const when = fmtStamp(tr.at);
  if (tr.st === 'done') return lead + '<b style="color:var(--up)">✓ завершена</b>: ' + (tr.why === 'level' ? 'подход к ' + f(tr.exit) : 'стохастик ' + (L ? '> ' + EXIT_K_HI : '< ' + EXIT_K_LO)) + ' · ' + when;
  if (tr.st === 'stopped') return lead + '<b style="color:var(--down)">✕ закрыта по стопу</b> ' + f(tr.stop) + ' · ' + when;
  if (tr.st === 'closed') return lead + '○ закрыта вручную · ' + when;
  return lead + '○ время вышло (' + TRADE_MAX_BARS + ' св.) · ' + when;
}

function evaluateAll() {
  if (updateRoles()) restyleLines();
  const tk = updateTaken();
  if (tk.changed) {
    LS.set('levels', levels);
    if (tk.newly.length || levels.some(isPartial)) { renderLines(); updateMarkers(); }
    tk.newly.forEach(l => { tgTaken(l); const z = Core.zoneOf(l); toast('<b>Плотность снята</b><br>' + (l.side === 'above' ? 'выше цены ' : 'ниже цены ') + lvlPriceTxt(l) + ': цена дошла до неё. На графике она заканчивается на этой свече, в расчётах больше не участвует.' + (l.src === 'img' ? '<br><b>Обновите плотности из скриншота.</b>' : '')); });
  }
  updateTrades();
  const eff = effLevels();
  const all = [];
  const newOnes = [];
  const silent = new Set();   // ТФ, у которых это первый проход: Telegram и сквизы молчат
  for (const t of TFS) {
    const d = data[t.id];
    if (!d || !d.ind) continue;
    let sigs = Core.evaluate(t.id, d.candles, d.ind, eff, settings);
    const st = sigState[t.id] || (sigState[t.id] = { active: new Set(), firedCandle: new Map(), firedEver: new Set() });
    let fresh = Core.diffSignals(st, sigs);
    // одна сделка на ТФ: пока она открыта, чужие сигналы не открываем и не показываем
    const open = openTradeOf(t.id), first = seeded.has(t.id);
    // сигналы «один раз» (вынос плотности), которые не стали сделкой, возвращаем в «неотработанные», чтобы не потерять их навсегда
    const dropOnce = (list) => list.forEach(x => { if (x.once) { st.firedEver.delete(x.stateKey); st.firedCandle.delete(x.stateKey); } });
    if (open) { sigs = sigs.filter(x => x.kind !== 'signal' || x.stateKey === open.sk); dropOnce(fresh); fresh = []; }
    else if (first && fresh.length) {
      dropOnce(fresh.slice(1));
      fresh = fresh.slice(0, 1);
      openTrade(fresh[0]);
      sigs = sigs.filter(x => x.kind !== 'signal' || x.stateKey === fresh[0].stateKey);
    }
    all.push.apply(all, sigs);
    if (!first) { seeded.add(t.id); silent.add(t.id); }   // первый проход — молча, чтобы не сыпать старыми сигналами при открытии
    else newOnes.push.apply(newOnes, fresh);
  }
  if (newOnes.length) notifyFresh(newOnes);
  try { tgScan(all, silent); sqScan(silent); } catch (e) { console.error('Telegram:', e); }
  activeSignals = all;
  if (newOnes.length) { try { diagRecordFresh(newOnes); } catch (e) { console.error('диагностика:', e); } }   // сбой диагностики не должен ломать сигналы
  refreshLiveMarkers();
  renderBanner();
  renderPanel();
  const n = all.filter(s => s.kind === 'signal').length;
  const b = $('#sigCount'); b.textContent = n; b.className = n ? 'hot' : '';
}

const DIR_NAME = { long: 'ЛОНГ', short: 'ШОРТ' };
function notifyFresh(list) {
  list.forEach(sig => history.unshift({ rid: ridOf(sig), t: Date.now(), tf: sig.tf, dir: sig.dir, levelType: sig.levelType, levelPrice: sig.levelPrice, price: sig.price, k: sig.k, text: sig.text, candleTime: sig.candleTime }));
  history.length = Math.min(history.length, 200);
  LS.set('history', history);
  const first = list[0];
  const tfs = list.map(s => TF[s.tf].label).join(', ');
  toast('<b>' + DIR_NAME[first.dir] + ' · ' + (list.length > 1 ? tfs : TF[first.tf].label) + '</b><br>' + esc(first.text) +
    (list.length > 1 ? '<br><span class="muted">и ещё сигналов: ' + (list.length - 1) + '</span>' : ''), first.dir);
  if (settings.sound) beep(first.dir);
  if (settings.vibrate && navigator.vibrate) navigator.vibrate([200, 100, 200]);
  if (document.hidden) osNotify(DIR_NAME[first.dir] + ' ETH · ' + tfs, first.text, first.stateKey);
  if (list.some(s => s.tf === currentTf)) updateMarkers();
}

function confluence() {
  const c = { long: new Set(), short: new Set() };
  activeSignals.forEach(s => { if (s.kind === 'signal') c[s.dir].add(s.tf); });
  return c;
}
const tfSort = (a, b) => (a.kind === 'signal' ? 0 : 1) - (b.kind === 'signal' ? 0 : 1) || TF[b.tf].sec - TF[a.tf].sec;

// ---------- время сигнала и ожидание результата ----------
const ridOf = (s) => ['live', s.tf, s.stateKey, s.candleTime].join('|');
function sigTimeTxt(s) {
  const tr = tradeFor(s), h = tr ? { t: tr.t } : history.find(x => x.rid === ridOf(s));
  return 'сигнал в ' + (h ? fmtStamp(h.t) : fmtDT(s.candleTime) + ' (свеча)');
}
// статус прогноза по записи диагностики: ждём цель, исполнен (цель раньше стопа), отменён (стоп раньше цели) или время вышло
function sigStatusHtml(s, rid) {
  const tr = rid ? trades.find(x => x.rid === rid) : tradeFor(s);
  if (tr) return tradeHtml(tr, s ? ' · ' : '');
  if (!HAS_DIAG) return '';
  const r = diagRecs.find(x => x.id === (rid || ridOf(s)));
  if (!r) return rid ? 'статус неизвестен (запись не сохранена)' : '';
  const cfg = diagCfg(), o = Diag.outcome(r, cfg);
  const T = r.tgt > 0 ? r.tgt : cfg.target, S = r.stp > 0 ? r.stp : cfg.stop, sg = r.dir === 'long' ? 1 : -1;
  const tp = fmtP(r.entry + sg * T * r.atr), sp = fmtP(r.entry - sg * S * r.atr);
  const hz = Math.min(cfg.horizon, Diag.MAXBARS);
  if (o.state === 'win') return (s ? ' · ' : '') + '<b style="color:var(--up)">✓ исполнен</b>: цель ' + tp + ' достигнута за ' + o.bars + ' св.';
  if (o.state === 'loss') return (s ? ' · ' : '') + '<b style="color:var(--down)">✕ отменён</b>: сработал стоп ' + sp + ' за ' + o.bars + ' св.';
  if (o.state === 'timeout') return (s ? ' · ' : '') + '○ время вышло (' + hz + ' св.): ни цели ' + tp + ', ни стопа ' + sp;
  return (s ? ' · ' : '') + '⏳ ждём: цель ' + tp + ', отмена при ' + sp + ' (прошло ' + o.bars + ' из ' + hz + ' св.)';
}

// кнопки таймфреймов дублируют сообщения: жёлтая рамка — предупреждение, зелёная / красная — сигнал ЛОНГ / ШОРТ на этом ТФ
function markTfBar() {
  const st = {};
  activeSignals.forEach(s => {
    const v = s.kind === 'signal' ? s.dir : 'warn';
    if (!st[s.tf] || (st[s.tf] === 'warn' && v !== 'warn')) st[s.tf] = v;       // сигнал важнее предупреждения
  });
  $$('#tfbar button').forEach(b => {
    b.classList.remove('s-long', 's-short', 's-warn');
    const v = st[b.dataset.tf];
    if (v) b.classList.add('s-' + v);
  });
}
function renderBanner() {
  markTfBar();
  const el = $('#banner');
  // Сообщение относится к выбранному таймфрейму: сигналы других ТФ только считаются в хвосте строки
  const list = activeSignals.filter(s => s.tf === currentTf).sort((a, b) => (a.kind === 'signal' ? 0 : 1) - (b.kind === 'signal' ? 0 : 1));
  const other = activeSignals.filter(s => s.tf !== currentTf && s.kind === 'signal').length;
  const ot = openTradeOf(currentTf);
  if (!list.length && ot) {
    el.hidden = false; el.className = ot.dir;
    el.innerHTML = '<span class="badge ' + ot.dir + '">' + DIR_NAME[ot.dir] + ' ' + TF[ot.tf].label + '</span><span>Сделка открыта в ' + fmtStamp(ot.t) + ' по ' + fmtP(ot.entry) + '<br><span class="small">' + tradeHtml(ot, '') + '</span></span>';
    return;
  }
  if (!list.length) { el.hidden = true; return; }
  const s = list[0];
  const conf = s.kind === 'signal' ? confluence()[s.dir] : null;
  el.hidden = false;
  el.className = s.kind === 'signal' ? s.dir : 'warn';
  el.innerHTML = '<span class="badge ' + (s.kind === 'signal' ? s.dir : 'warn') + '">' + (s.kind === 'signal' ? DIR_NAME[s.dir] : '!') + ' ' + TF[s.tf].label + '</span><span>' + esc(s.text) +
    (conf && conf.size > 1 ? ' · совпало на ' + conf.size + ' ТФ' : '') + (list.length > 1 ? ' · ещё на этом ТФ: ' + (list.length - 1) : '') + (other ? ' · на других ТФ: ' + other : '') +
    (s.kind === 'signal' ? '<br><span class="small">' + sigTimeTxt(s) + sigStatusHtml(s) + '</span>' : '') + '</span>';
}

// ---------- Telegram ----------
// Отправка прямо из браузера: токен и chat id хранятся только на этом устройстве, сообщения идут, пока приложение открыто.
let tgErrAt = 0;
async function tgSend(text, force) {
  if ((!settings.tgOn && !force) || !settings.tgToken || !settings.tgChat) return false;
  try {
    const body = new URLSearchParams({ chat_id: settings.tgChat, text, disable_web_page_preview: 'true' });   // форма, а не JSON: запрос без предзапроса CORS
    const r = await fetch('https://api.telegram.org/bot' + settings.tgToken + '/sendMessage', { method: 'POST', body });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) throw new Error(j.description || 'HTTP ' + r.status);
    return true;
  } catch (e) {
    if (force || Date.now() - tgErrAt > 60000) { tgErrAt = Date.now(); toast('Telegram: не отправлено (' + esc(e.message || e) + ')'); }
    return false;
  }
}
// Что уходит в Telegram: снос плотности (снята + вынос с возвратом), сигнал у линии при K ≥ tgKHi (шорт) / ≤ tgKLo (лонг), сильные сквизы.
// Остальные сигналы (в том числе «к плотности») остаются в приложении; их можно включить переключателем «Остальные».
const tgSent = new Set(), tgOnce = new Set(), tgSq = new Set();   // что уже отправлено (для «один раз» и сквизов — навсегда, для остальных — пока сигнал активен)
const capSet = (s, n) => { while (s.size > n) s.delete(s.values().next().value); };
function tgPass(s) {
  if (s.kind !== 'signal') return false;
  let ok = false;
  if (s.sub === 'mag') ok = false;
  else if (s.levelType === 'liq') ok = !!settings.tgLiq;
  else if (s.levelType === 'support' || s.levelType === 'resistance') ok = !!settings.tgStoch && (s.dir === 'short' ? s.k >= settings.tgKHi : s.k <= settings.tgKLo);
  return ok || !!settings.tgOther;
}
function tgScan(all, silent) {
  const sigs = all.filter(s => s.kind === 'signal');
  const alive = new Set(sigs.map(s => s.stateKey));
  tgSent.forEach(k => { if (!alive.has(k)) tgSent.delete(k); });   // сигнал погас: при повторе отправим снова
  const out = [];
  sigs.forEach(s => {
    if (!tgPass(s)) return;
    const set = s.once ? tgOnce : tgSent;
    if (set.has(s.stateKey)) return;
    set.add(s.stateKey);
    if (!silent.has(s.tf)) out.push(s);
  });
  capSet(tgOnce, 500);
  if (!out.length || !settings.tgOn) return;
  const tfs = out.map(s => TF[s.tf].label).join(', ');
  out.forEach(s => {
    const tr = tradeFor(s);
    if (tr && !tr.tg) { tr.tg = true; saveTrades(); }
    const L = s.dir === 'long';
    let t = (L ? '🟢 ЛОНГ' : '🔴 ШОРТ') + ' ETH · ' + TF[s.tf].label + '\n' + s.text + '\nЦена ' + fmtP(s.price);
    if (Number.isFinite(s.limitPrice)) t += ' · лимитка ' + fmtP(s.limitPrice);
    if (Number.isFinite(s.exitPrice)) t += ' · выход ' + fmtP(s.exitPrice);
    t += !L && Number.isFinite(s.stopPrice) ? ' · стоп ' + fmtP(s.stopPrice) : ' · без стопа';
    if (out.length > 1) t += '\nОдновременно на ТФ: ' + tfs;
    tgSend(t);
  });
}
// плотность снята только что (свежее часа: при открытии приложения старые не пересказываем)
function tgTaken(l) {
  if (!settings.tgOn || !settings.tgLiq || !l.takenAt || Date.now() / 1000 - l.takenAt > 3600) return;
  tgSend('🧲 СНОС ПЛОТНОСТИ ETH\n' + (l.side === 'above' ? 'Плотность выше ' : 'Плотность ниже ') + lvlPriceTxt(l) + (l.volume ? ' ($' + l.volume + 'M)' : '') + ' снята: цена дошла до дальнего края. Цена ' + fmtP(lastPrice));
}
// сильный сквиз: импульс на объёме (информация, не вход); уведомляем один раз на свечу
function sqScan(silent) {
  if (!settings.tgSq) return;
  TFS.forEach(t => {
    const d = data[t.id];
    if (!d || !d.ind) return;
    const q = Core.squeeze(d.candles, d.ind, settings);
    if (!q) return;
    const key = t.id + '|' + q.dir + '|' + q.time;
    if (tgSq.has(key)) return;
    tgSq.add(key); capSet(tgSq, 300);
    if (silent.has(t.id)) return;
    const up = q.dir === 'up';
    const swept = levels.filter(l => l.type === 'liq' && l.takenAt && l.takenAt >= q.from).map(l => lvlPriceTxt(l, true));
    const head = (up ? 'СКВИЗ ШОРТОВ ▲' : 'СКВИЗ ЛОНГОВ ▼') + ' · ' + TF[t.id].label;
    const body = (up ? '+' : '−') + Math.abs(q.move).toFixed(1) + '$ (' + q.moveAtr.toFixed(1) + ' ATR) за ' + q.n + ' св., объём ×' + q.volX.toFixed(1) + ' от среднего' + (swept.length ? ', снесена плотность ' + swept.join(', ') : '') + '. Цена ' + fmtP(q.price);
    toast('<b>' + head + '</b><br>' + esc(body), up ? 'long' : 'short');
    if (settings.tgOn) tgSend('⚡ ' + head.replace(' · ', ' ETH · ') + '\n' + body);
  });
}
async function tgTest() {
  if (!settings.tgToken || !settings.tgChat) { toast('Telegram: введите токен бота и Chat ID'); return; }
  if (await tgSend('✅ ETH Сигналы: тестовое сообщение', true)) toast('Telegram: тест отправлен');
}

// звук / уведомления / экран
let audioCtx = null;
function unlockAudio() {
  try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === 'suspended') audioCtx.resume(); } catch (e) { /* */ }
}
['pointerdown', 'keydown', 'touchstart'].forEach(ev => window.addEventListener(ev, unlockAudio, { passive: true }));
function beep(dir) {
  if (!audioCtx) return;
  const t0 = audioCtx.currentTime;
  (dir === 'long' ? [660, 880, 1100] : [1100, 880, 660]).forEach((f, i) => {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain(), s = t0 + i * 0.16;
    o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, s);
    g.gain.exponentialRampToValueAtTime(0.25, s + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, s + 0.15);
    o.connect(g); g.connect(audioCtx.destination);
    o.start(s); o.stop(s + 0.16);
  });
}
async function osNotify(title, body, tag) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
    const opts = { body, icon: 'icon-192.png', badge: 'icon-192.png', tag, vibrate: [200, 100, 200] };
    if (reg && reg.showNotification) reg.showNotification(title, opts); else new Notification(title, opts);
  } catch (e) { /* */ }
}
let wakeLock = null;
async function applyWakeLock() {
  try {
    if (settings.keepAwake && 'wakeLock' in navigator && !document.hidden && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!settings.keepAwake && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) { wakeLock = null; }
}

function toast(html, cls) {
  const el = document.createElement('div');
  el.className = 'toast ' + (cls || '');
  el.innerHTML = html;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 9000);
}

// ---------- панель ----------
let tab = null;
const isDesktop = () => matchMedia('(min-width:980px)').matches;
let lastPanelHtml = '';
let panelBusyUntil = 0;   // пока палец на панели, не перерисовываем её, чтобы не потерять тап

function setTab(t) {
  const side = $('#side');
  if (!isDesktop() && tab === t && side.classList.contains('open')) { side.classList.remove('open'); $$('#tabs button').forEach(b => b.classList.remove('on')); return; }
  tab = t;
  side.classList.add('open');
  $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  renderPanel(true);
}

function renderPanel(force) {
  if (!tab) return;
  if (tab === 'settings' && !force) return;
  if (!force && Date.now() < panelBusyUntil) return;
  const html = tab === 'signals' ? viewSignals() : tab === 'lines' ? viewLines() : tab === 'diag' ? viewDiag() : tab === 'learn' ? viewLearn() : viewSettings();
  if (html === lastPanelHtml && !force) return;
  lastPanelHtml = html;
  const panel = $('#panel');
  const top = panel.scrollTop;
  panel.innerHTML = html;
  panel.scrollTop = top;
}

function lvlName(l) {
  if (l.type === 'liq') return l.side === 'above' ? 'ЛИКВ ▲' : 'ЛИКВ ▼';
  const r = roleOf(l);
  return r === 'support' ? 'ПОДД' : r === 'resistance' ? 'СОПР' : 'УРОВЕНЬ';
}
const isZone = (l) => l.type === 'liq' && l.price2 > l.price;
// цена или диапазон текстом; расстояние от цены до уровня (до ближнего края зоны, внутри зоны — 0)
const lvlPriceTxt = (l, short) => {
  const f = (x) => short ? fmtP(x).replace(/\.00$/, '') : fmtP(x);
  return isZone(l) ? f(l.price) + ' – ' + f(l.price2) : f(l.price);
};
const distTo = (l, p) => { const z = Core.zoneOf(l); return p < z.lo ? z.lo - p : p > z.hi ? p - z.hi : 0; };

function viewSignals() {
  const conf = confluence();
  const cur = activeSignals.slice().sort(tfSort);
  let h = '';
  const ots = trades.filter(t => t.st === 'open');
  if (ots.length) {
    h += '<h3>Открытые сделки</h3>';
    ots.forEach(t => { h += '<div class="card ' + t.dir + '"><div class="top"><span class="badge ' + t.dir + '">' + DIR_NAME[t.dir] + '</span><b>' + TF[t.tf].label + '</b><span class="muted small right">с ' + fmtStamp(t.t) + ' по ' + fmtP(t.entry) + '</span></div><div class="small">' + tradeHtml(t, '') + '</div></div>'; });
  }
  h += '<h3>Сейчас</h3>';
  if (!cur.length) h += '<div class="muted small" style="margin-bottom:8px">Сигналов нет. Добавьте линии на вкладке «Линии» — приложение само следит за всеми таймфреймами.</div>';
  cur.forEach(s => {
    const c = s.kind === 'signal' ? s.dir : 'warn';
    const n = s.kind === 'signal' ? conf[s.dir].size : 0;
    h += '<div class="card ' + c + '"><div class="top"><span class="badge ' + c + '">' + (s.kind === 'signal' ? DIR_NAME[s.dir] : 'ВНИМАНИЕ') + '</span><b>' + TF[s.tf].label + '</b>' +
      (n > 1 ? '<span class="badge">×' + n + ' ТФ</span>' : '') + '<span class="muted small right">K ' + fmtK(s.k) + '</span></div><div class="small">' + esc(s.text) + '</div>' +
      (s.kind === 'signal' ? '<div class="small muted">' + sigTimeTxt(s) + sigStatusHtml(s) + '</div>' : '') + '</div>';
  });
  h += '<h3>Таймфреймы</h3><table><tr><th>ТФ<th>K<th>D<th>Ближайший уровень<th></tr>';
  TFS.forEach(t => {
    const d = data[t.id];
    if (!d || !d.ind) { h += '<tr><td>' + t.label + '<td colspan="4" class="muted">нет данных</tr>'; return; }
    const n = d.candles.length - 1;
    const k = d.ind.k[n], dv = d.ind.d[n], a = d.ind.atr[n], p = d.candles[n].close;
    const kc = k >= settings.overbought ? 'ob' : k <= settings.oversold ? 'os' : '';
    let near = '<span class="muted">—</span>';
    if (levels.some(l => !isTaken(l)) && Number.isFinite(a)) {
      let best = null;
      levels.filter(l => !isTaken(l)).forEach(l => { const dist = distTo(l, p); if (!best || dist < best.dist) best = { l, dist }; });
      near = lvlName(best.l) + ' ' + lvlPriceTxt(best.l, true).replace(' – ', '–') + ' <span class="muted">· ' + (best.dist === 0 && isZone(best.l) ? 'внутри' :(best.dist / a).toFixed(1) + ' ATR') + '</span>';
    }
    const mine = activeSignals.filter(s => s.tf === t.id);
    const sg = mine.find(s => s.kind === 'signal');
    const mark = sg ? '<span class="badge ' + sg.dir + '">' + (sg.dir === 'long' ? '▲' : '▼') + '</span>' : (mine.length ? '<span class="badge warn">!</span>' : '');
    h += '<tr data-tf="' + t.id + '"' + (t.id === currentTf ? ' class="cur"' : '') + '><td><b>' + t.label + '</b><td class="' + kc + '">' + fmtK(k) + '<td>' + fmtK(dv) + '<td class="small">' + near + '<td>' + mark + '</tr>';
  });
  h += '</table>';
  h += '<h3>История сигналов</h3>';
  const hist = history.filter(x => x.dir).slice(0, 40);
  if (!hist.length) h += '<div class="muted small">Пока пусто. Сигналы сохраняются на этом устройстве.</div>';
  hist.forEach(x => {
    h += '<div class="card ' + x.dir + '"><div class="top"><span class="badge ' + x.dir + '">' + DIR_NAME[x.dir] + '</span><b>' + (TF[x.tf] ? TF[x.tf].label : x.tf) + '</b><span class="muted small right">' + fmtStamp(x.t) + '</span></div>' +
      '<div class="small">' + esc(x.text) + ' · цена ' + fmtP(x.price) + '</div>' + (x.rid ? '<div class="small muted">' + sigStatusHtml(null, x.rid) + '</div>' : '') + '</div>';
  });
  if (hist.length) h += '<button class="btn full" data-act="clearHist" style="margin-top:6px">Очистить историю</button>';
  return h;
}

function viewLines() {
  let h = '<button class="btn primary full" data-act="addLine">＋ Добавить линию</button>' + (HAS_HEAT ? '<button class="btn full" data-act="heatOpen" style="margin-top:8px">Плотности из скриншота</button>' + heatStatusHtml() : '<div class="muted small" style="margin-top:6px;color:var(--down)">Файл heat.js не загружен: плотности из скриншота недоступны.</div>') + '<h3>Уровни и плотности</h3>';
  if (!levels.length) h += '<div class="muted small">Линий пока нет. Добавьте уровень (поддержка или сопротивление определятся сами по положению цены) или плотность ликвидаций (смотрите на Coinglass, вводите цену вручную).</div>';
  const items = levels.filter(l => !isTaken(l)).map(l => ({ price: (l.price + (isZone(l) ? l.price2 : l.price)) / 2, l })).concat(lastPrice != null ? [{ price: lastPrice, now: true }] : []).sort((a, b) => b.price - a.price);
  const d = data[currentTf], atrv = d && d.ind ? d.ind.atr[d.candles.length - 1] : NaN;
  items.forEach(it => {
    if (it.now) { h += '<div class="muted small" style="text-align:center;padding:4px 0">── цена ' + fmtP(lastPrice) + ' ──</div>'; return; }
    const l = it.l, col = levelStyle(l).color;
    const dist = lastPrice ? distTo(l, lastPrice) : NaN;
    const z = Core.zoneOf(l);
    const sign = lastPrice && z.lo > lastPrice ? 1 : -1;     // зона выше цены или ниже
    const pct = lastPrice ? sign * dist / lastPrice * 100 : NaN;
    const wTxt = isZone(l) ? 'ширина ' + fmtP(l.price2 - l.price) + (Number.isFinite(atrv) ? ' (' + ((l.price2 - l.price) / atrv).toFixed(1) + ' ATR)' : '') : '';
    h += '<div class="card"><div class="lvl"><span class="dot" style="background:' + col + '"></span><div><div class="p">' + lvlPriceTxt(l) + ' <span class="muted small">' + lvlName(l) + (l.volume ? ' · $' + l.volume + 'M' : '') + '</span></div>' +
      '<div class="muted small">' + (l.type === 'liq' && l.t ? 'с ' + fmtDT(l.t) + ' · ' : '') + (isPartial(l) ? 'снята часть, осталось ' + fmtP(shownZone(l).lo) + ' – ' + fmtP(shownZone(l).hi) + ' · ' : '') + (dist === 0 && isZone(l) ? 'цена внутри зоны' : (Number.isFinite(pct) ? (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%' : '') + (Number.isFinite(atrv) && lastPrice ? ' · ' + (dist / atrv).toFixed(1) + ' ATR' : '')) + (wTxt ? ' · ' + wTxt : '') + '</div></div>' +
      '<span class="right"></span><button class="btn ico" data-edit="' + l.id + '">Изм.</button><button class="btn ico danger" data-del="' + l.id + '">✕</button></div></div>';
  });
  const taken = levels.filter(isTaken);
  if (taken.length) {
    h += '<h3>Снятые плотности</h3><div class="muted small" style="margin-bottom:6px">Цена дошла до них: на графике они заканчиваются на свече снятия, в расчётах не участвуют. «Изм.» возвращает плотность в работу.</div>';
    taken.forEach(l => {
      h += '<div class="card" style="opacity:.65"><div class="lvl"><span class="dot" style="background:#6b7280"></span><div><div class="p">' + lvlPriceTxt(l) + ' <span class="muted small">' + lvlName(l) + '</span></div>' +
        '<div class="muted small">с ' + fmtDT(l.t || l.takenAt) + ', снята ' + fmtDT(l.takenAt) + '</div></div><span class="right"></span><button class="btn ico" data-edit="' + l.id + '">Изм.</button><button class="btn ico danger" data-del="' + l.id + '">✕</button></div></div>';
    });
  }
  if (!HAS_AUTO) h += '<div class="muted small" style="color:var(--down);margin-top:8px">Файл auto.js не загружен: автоуровни не строятся. Положите его рядом с app.js, замените index.html и sw.js, обновите страницу (Ctrl+F5).</div>';
  if (HAS_AUTO && settings.autoOn) {
    h += '<h3>Автоуровни (' + autoLevels.length + ')</h3>';
    if (!autoLevels.length) h += '<div class="muted small">Считаю по экстремумам 1ч / 4ч / 1д…</div>';
    autoLevels.slice().sort((a, b) => b.price - a.price).forEach(l => {
      const r = roleOf(l), dist = lastPrice ? (l.price - lastPrice) / lastPrice * 100 : NaN;
      h += '<div class="card"><div class="lvl"><span class="dot" style="background:rgba(110,170,255,.9)"></span><div><div class="p">' + fmtP(l.price) + ' <span class="muted small">' + (r === 'support' ? 'ПОДД' : r === 'resistance' ? 'СОПР' : 'УРОВЕНЬ') + ' · авто</span></div>' +
        '<div class="muted small">экстремумов ' + l.n + ' · вес ' + l.score + (Number.isFinite(dist) ? ' · ' + (dist >= 0 ? '+' : '') + dist.toFixed(2) + '%' : '') + '</div></div></div></div>';
    });
    h += '<div class="muted small">Строятся сами по экстремумам, не редактируются. Настройки → Автоуровни.</div>';
  }
  return h;
}

function numField(key, label, step) {
  return '<label class="f">' + label + '<input type="number" inputmode="decimal" step="' + (step || 1) + '" data-set="' + key + '" value="' + settings[key] + '"></label>';
}
function textField(key, label, type) {
  return '<label class="f">' + label + '<input type="' + (type || 'text') + '" autocomplete="off" autocapitalize="off" spellcheck="false" data-set="' + key + '" value="' + esc(settings[key] || '') + '"></label>';
}
function swField(key, label) {
  return '<div class="sw"><span>' + label + '</span><input type="checkbox" data-set="' + key + '"' + (settings[key] ? ' checked' : '') + '></div>';
}
function viewSettings() {
  const perm = ('Notification' in window) ? Notification.permission : 'unsupported';
  return '<h3>StochRSI</h3><div class="grid2">' + numField('rsiLen', 'Период RSI') + numField('stochLen', 'Период Stoch') + numField('kLen', 'Сглаживание K') + numField('dLen', 'Сглаживание D') +
    numField('overbought', 'Перекупленность') + numField('oversold', 'Перепроданность') + '</div>' +
    '<h3>Сигналы</h3><div class="grid2">' + numField('proxAtr', 'Близость к уровню, ATR', 0.05) + numField('depthAtr', 'Глубина выноса плотности, ATR', 0.1) +
    numField('guardAtr', 'Плотность за уровнем гасит сигнал, ATR', 0.1) + numField('sweepWindow', 'Окно выноса, свечей') +
    numField('flipAtr', 'Смена роли уровня после пробоя, ATR (1ч); 0 — сразу', 0.05) + '</div>' +
    '<h3>Сигнал «к плотности»</h3>' + swField('magOn', 'Сигнал на ход к плотности (цель — ближний край)') + '<div class="grid2">' + numField('magMax', 'Не дальше от плотности, ATR', 0.1) + numField('magStop', 'Стоп в сигнале, ATR', 0.1) + numField('magFar', 'При K в экстремуме — до, ATR', 1) + '</div>' +
    swField('guardEnter', 'Плотность за уровнем: не ждать возврата, сразу сигнал с лимиткой') +
    '<div class="muted small">Плотность ниже цены даёт ШОРТ, выше цены — ЛОНГ. Ближе чем «Близость к уровню» — только предупреждение. Во вкладке «Диагностика» такие сигналы считаются отдельно: цель — край плотности, а расстояние до неё входит в список факторов.</div>' +
    '<h3>Автоуровни</h3>' + (HAS_AUTO ? '' : '<div class="muted small" style="color:var(--down)">Файл auto.js не загружен: положите его рядом с app.js, замените index.html и sw.js и обновите страницу (Ctrl+F5). Без него автоуровни не строятся.</div>') + swField('autoOn', 'Автоматические уровни (пунктир на графике)') + swField('autoSig', 'Давать сигналы по автоуровням') + '<div class="grid2">' + numField('autoWin', 'Окно экстремума, свечей') + numField('autoTol', 'Ширина зоны, ATR', 0.1) + numField('autoMax', 'Сколько линий') + '</div>' +
    (autoHidden.length ? '<button class="btn" data-act="autoUnhide" style="margin:6px 0">Вернуть перетащенные автоуровни (' + autoHidden.length + ')</button>' : '') + (HAS_AUTO && settings.autoOn ? '<div class="muted small">Сейчас построено линий: <b>' + autoLevels.length + '</b>' + (autoLevels.length ? '' : ' (ждём загрузки свечей 1ч / 4ч / 1д)') + '</div>' : '') + '<div class="muted small">Уровни строятся по экстремумам 1ч, 4ч и 1д: близкие склеиваются, весомее частые, старшие ТФ и свежие. Экстремум известен только после закрытия свечи за ним, поэтому на истории уровни считаются без заглядывания вперёд. Сигналы по ним выключены по умолчанию: во вкладке «Обучение» они идут отдельным источником линии.</div>' +
    '<h3>Диагностика</h3><div class="grid2">' + numField('diagTarget', 'Цель сигнала, ATR', 0.1) + numField('diagStop', 'Стоп, ATR', 0.1) +
    numField('diagHorizon', 'Горизонт, свечей (до 48)') + numField('diagMinN', 'Мин. сигналов для вывода') + '</div>' +
    '<div class="muted small">Сигнал считается удачным, если цена прошла цель раньше стопа за горизонт. Влияет только на вкладку «Диагностика».</div>' +
    '<h3>Обучение</h3><div class="grid2">' + numField('learnRev', 'Разворот: ход, ATR', 0.1) + numField('learnStop', 'Разворот: стоп, ATR', 0.1) +
    numField('learnWin', 'Экстремум: окно ±свечей') + numField('learnCtl', 'Контроль: каждая N-я свеча') +
    numField('learnBounce', 'Подход: отбой, ATR', 0.1) + numField('learnBreak', 'Подход: пробой, ATR', 0.1) +
    numField('learnProx', 'Подход: зона у линии, ATR', 0.1) + numField('learnH', 'Горизонт, свечей (до 48)') + '</div>' +
    '<div class="muted small">Влияет только на вкладку «Обучение». Изменение пересчитывает историю; уже собранные живые события хранят свои цель и стоп.</div>' +
    '<h3>Вид</h3>' + numField('liqOpacity', 'Прозрачность линии плотности (0.1–1)', 0.05) +
    '<label class="f">Когда проверять условия<select data-set="evalMode"><option value="live"' + (settings.evalMode === 'live' ? ' selected' : '') + '>По текущей цене (быстро)</option><option value="close"' + (settings.evalMode === 'close' ? ' selected' : '') + '>По закрытию свечи (надёжнее)</option></select></label>' +
    '<h3>Telegram</h3>' + swField('tgOn', 'Слать сигналы в Telegram') + textField('tgToken', 'Токен бота (от @BotFather)', 'password') + textField('tgChat', 'Chat ID') +
    '<div class="row" style="margin-top:8px"><button class="btn" data-act="tgTest">Отправить тест</button></div>' +
    '<h3>Что слать в Telegram</h3>' + swField('tgLiq', 'Снос плотности (снята + вынос с возвратом)') + swField('tgStoch', 'Сигнал у линии при крайнем StochRSI') +
    '<div class="grid2">' + numField('tgKHi', 'Шорт: K не ниже') + numField('tgKLo', 'Лонг: K не выше') + '</div>' +
    swField('tgSq', 'Сильные сквизы (импульс на объёме)') + '<div class="grid2">' + numField('sqAtr', 'Сквиз: ход, ATR', 0.5) + numField('sqN', 'за свечей') + numField('sqVol', 'Объём, × от среднего', 0.5) + '</div>' +
    swField('tgOther', 'Остальные сигналы (к плотности и прочие)') +
    '<div class="muted small">Остальные сигналы остаются в приложении. Сквиз — информация, не вход: рост на объёме = сквиз шортов, падение = сквиз лонгов. Сделка завершается в Telegram только если о её входе писали.</div>' +
    '<div class="muted small" style="margin-top:6px">Токен хранится только на этом устройстве. Сообщения идут, пока приложение открыто; если открыть его на двух устройствах с включённой отправкой, придут дубли.</div>' +
    '<h3>Оповещения</h3>' + swField('sound', 'Звук') + swField('vibrate', 'Вибрация (Android)') + swField('keepAwake', 'Не гасить экран') +
    '<div class="sw"><span>Системные уведомления<br><span class="muted small">' + (perm === 'granted' ? 'включены' : perm === 'denied' ? 'запрещены в браузере' : perm === 'unsupported' ? 'не поддерживаются' : 'выключены') + '</span></span>' +
    (perm === 'default' ? '<button class="btn" data-act="notif">Включить</button>' : '') + '</div>' +
    '<div class="muted small" style="margin:6px 0">Сигналы приходят, пока приложение открыто. Для работы в фоне нужен сервер (следующий этап, Telegram).</div>' +
    '<h3>Резервная копия линий</h3><textarea id="ioBox" placeholder="Здесь появится JSON. Вставьте сюда копию и нажмите «Импорт»."></textarea>' +
    '<div class="row" style="margin-top:8px"><button class="btn" data-act="export">Экспорт</button><button class="btn" data-act="import">Импорт</button></div>' +
    '<button class="btn full danger" data-act="resetSettings" style="margin-top:14px">Сбросить настройки</button>';
}

// ---------- диагностика: запись, исходы, бэктест ----------
const diagCfg = () => ({ target: settings.diagTarget, stop: settings.diagStop, horizon: settings.diagHorizon, minN: settings.diagMinN });
const diagTouch = () => { diagDirty = true; diagVersion++; };
function diagFlushSave() { if (diagDirty) { diagDirty = false; LS.set('diag', diagRecs); } }
function diagInvalidateBt() { diagBt = null; diagVersion++; }

// новый сигнал: сохраняем контекст (факторы) и начинаем копить путь цены
function diagRecordFresh(list) {
  if (!HAS_DIAG) return;
  const conf = confluence();
  let added = 0;
  list.forEach(s => {
    const d = data[s.tf];
    if (!d || !d.ind) return;
    const i = indexOfTime(d.candles, s.candleTime);
    if (i < 0) return;
    const rec = Diag.makeRecord({ src: 'live', t: Date.now(), sig: s, candles: d.candles, ind: d.ind, i, ctx: Diag.prepare(d.candles), conf: conf[s.dir].size, cfg: settings });
    if (!rec || diagRecs.some(r => r.id === rec.id)) return;
    diagRecs.push(rec); added++;
  });
  if (!added) return;
  if (diagRecs.length > DIAG_CAP) diagRecs.splice(0, diagRecs.length - DIAG_CAP);
  diagTouch(); diagFlushSave();
}

// дописываем путь цены к записям, у которых ещё не набралось свечей (раз в несколько секунд)
function diagUpdatePaths(force) {
  if (!HAS_DIAG) return;
  const now = Date.now();
  if (!force && now - diagLastPath < 4000) return;
  diagLastPath = now;
  let changed = false;
  diagRecs.forEach(r => {
    if ((r.closed || 0) >= Diag.MAXBARS) return;
    const d = data[r.tf];
    if (!d) return;
    const i = indexOfTime(d.candles, r.candleTime);
    if (i < 0) return;
    const pf = Diag.pathFrom(d.candles, i, r.dir, r.entry, r.atr, Diag.MAXBARS, r.s0);
    const a = pf.path[pf.path.length - 1], b = r.path[r.path.length - 1];
    if (pf.path.length !== r.path.length || pf.closed !== r.closed || (a && b && (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]))) {
      r.path = pf.path; r.closed = pf.closed; changed = true;
    }
  });
  if (changed) diagTouch();
}

// текущие уровни по всем загруженным свечам
function diagRunBacktest() {
  const out = [];
  TFS.forEach(t => { const d = data[t.id]; if (d && d.ind) out.push.apply(out, Diag.backtest(t.id, d.candles, d.ind, levels, settings)); });
  diagBt = out; diagVersion++;
  return out.length;
}
function diagEnsureBt() {
  if (!HAS_DIAG || diagBt !== null || diagBtBusy) return;
  if (!levels.some(l => l.type === 'sr')) { diagBt = []; return; }
  if (!TFS.every(t => data[t.id] && data[t.id].ind)) return;
  diagBtBusy = true;
  setTimeout(() => {
    try { diagRunBacktest(); } catch (e) { diagBt = []; console.error('бэктест:', e); }
    diagBtBusy = false;
    renderPanel(true);
  }, 30);
}

function downloadText(name, text, mime) {
  try {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast('Файл ' + esc(name) + ' сохранён');
  } catch (e) { toast('Не удалось сохранить файл'); }
}
const diagFileStamp = () => { const d = new Date(); return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()); };

// ---------- обучение: сбор ----------
const learnCfg = () => ({ rev: settings.learnRev, stop: settings.learnStop, win: settings.learnWin, bounce: settings.learnBounce, brk: settings.learnBreak, prox: settings.learnProx, horizon: settings.learnH, ctlStep: settings.learnCtl });
const learnOutCfg = () => Object.assign({ target: 1, minN: settings.diagMinN }, learnCfg());
const learnRecs = (src) => src === 'live' ? learnLive : src === 'hist' ? (learnHist || []) : learnLive.concat(learnHist || []);
function learnAutoFn() { const m = HAS_AUTO && settings.autoOn ? autoEnsureModel() : null; return m ? (T, px) => Auto.at(m, T, px) : undefined; }
function learnInvalidate() { learnHist = null; learnVersion++; }
function learnHtf(tf) { const h = HAS_LEARN && Learn.HTF[tf], d = h && data[h]; return d && d.ind ? { cs: d.candles, ind: d.ind, sec: TF[h].sec } : null; }

// история: те же события по уже загруженным свечам (линии пользователя задним числом, плотностей нет)
function learnRunHistory() {
  const out = [], cfg = learnCfg(), la = learnAutoFn();
  TFS.forEach(t => { const d = data[t.id]; if (d && d.ind) out.push.apply(out, Learn.collect(t.id, d.candles, d.ind, levels, cfg, { src: 'hist', htf: learnHtf(t.id), levelsAt: la })); });
  learnHist = out; learnVersion++;
  return out.length;
}
function learnEnsureHist() {
  if (!HAS_LEARN || learnHist !== null || learnBusy) return;
  if (!TFS.every(t => data[t.id] && data[t.id].ind)) return;
  learnBusy = true;
  setTimeout(() => {
    try { learnRunHistory(); } catch (e) { learnHist = []; console.error('обучение:', e); }
    learnBusy = false;
    renderPanel(true);
  }, 30);
}

// живые события: раз в 20 с ищем новые закрытые свечи после включения сбора, у прежних дописываем путь цены
function learnScan(force) {
  if (!HAS_LEARN || !settings.learnOn) return;
  const now = Date.now();
  if (!force && now - learnLastScan < 20000) return;
  if (!TFS.every(t => data[t.id] && data[t.id].ind)) return;
  learnLastScan = now;
  const sec = Math.floor(now / 1000);
  if (!learnSince) { learnSince = sec; LS.set('learnSince', learnSince); }
  // линия считается с момента, когда её впервые увидели: задним числом событий у живых данных не бывает
  const seen = {};
  levels.forEach(l => { if (l.type === 'sr') { const key = l.id + '@' + l.price; seen[key] = learnLines[key] || sec; } });
  if (Object.keys(seen).length !== Object.keys(learnLines).length || Object.keys(seen).some(k => seen[k] !== learnLines[k])) { learnLines = seen; LS.set('learnLines', learnLines); }
  const lv = levels.map(l => l.type === 'sr' ? Object.assign({}, l, { t: seen[l.id + '@' + l.price] }) : l);
  const liqs = levels.filter(l => l.type === 'liq' && !l.takenAt);
  const cfg = learnCfg(), la = learnAutoFn(), have = new Set(learnLive.map(r => r.id));
  let added = 0, ch = false;
  for (const t of TFS) {
    const d = data[t.id];
    Learn.collect(t.id, d.candles, d.ind, lv, cfg, { src: 'live', since: learnSince, htf: learnHtf(t.id), liqs, levelsAt: la }).forEach(r => {
      if (have.has(r.id) || learnLive.length >= LEARN_CAP) return;
      learnLive.push(r); have.add(r.id); added++;
    });
  }
  if (added) ch = true;
  learnLive.forEach(r => {
    if ((r.closed || 0) >= Diag.MAXBARS) return;
    const d = data[r.tf];
    if (!d) return;
    const i = indexOfTime(d.candles, r.candleTime);
    if (i < 0) return;
    const pf = Diag.pathFrom(d.candles, i, r.dir, r.entry, r.atr, Diag.MAXBARS);
    const a = pf.path[pf.path.length - 1], b = r.path[r.path.length - 1];
    if (pf.path.length !== r.path.length || pf.closed !== r.closed || (a && b && (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]))) { r.path = pf.path; r.closed = pf.closed; ch = true; }
  });
  if (ch) { learnDirty = true; learnVersion++; }
  if (learnDirty && (added || now - learnSavedAt > 60000)) { learnDirty = false; learnSavedAt = now; LS.set('learn', learnLive); }
}

function learnExport(withPath) {
  if (learnHist === null) { try { learnRunHistory(); } catch (e) { learnHist = []; } }
  return Learn.exportJson({ cfg: learnOutCfg(), levels, records: learnRecs('all'), withPath });
}
function learnCopyPrompt() {
  if (learnHist === null) { try { learnRunHistory(); } catch (e) { learnHist = []; } }
  const recs = learnRecs('all');
  if (!recs.length) { toast('Нет данных для выгрузки'); return; }
  const txt = Learn.prompt({ n: recs.length, nHist: (learnHist || []).length, nLive: learnLive.length, digest: Learn.digest(recs, learnOutCfg()) });
  const save = () => downloadText('eth-learn-prompt-' + diagFileStamp() + '.txt', txt, 'text/plain;charset=utf-8');
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(() => toast('Сводка скопирована (' + Math.round(txt.length / 1000) + ' тыс. символов): вставьте в чат с ИИ'), save);
  else save();
}

// ---------- диагностика: вкладка ----------
const pc = (x, d) => (x == null || !Number.isFinite(x)) ? '—' : (x * 100).toFixed(d || 0) + '%';
const sgn = (x, d) => (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(d);

function diagSrcEff() {
  const s = settings.diagSrc;
  if (s === 'live' || s === 'bt' || s === 'all') return s;
  return diagRecs.length >= 20 || !(diagBt && diagBt.length) ? 'live' : 'bt';   // авто: живые, когда их хватает, иначе история
}
const diagRecsFor = (src) => src === 'live' ? diagRecs : src === 'bt' ? (diagBt || []) : diagRecs.concat(diagBt || []);
function diagSummary(src) {
  const cfg = diagCfg();
  const key = [diagVersion, src, cfg.target, cfg.stop, cfg.horizon, cfg.minN].join('|');
  if (!diagMemo || diagMemo.key !== key) diagMemo = { key, sum: Diag.summarize(diagRecsFor(src), cfg) };
  return diagMemo.sum;
}

// строка фактора: название, цифры, и полоска «насколько выше / ниже остальных сигналов»
function diagRow(b, soft, neutral) {
  const dp = b.delta == null ? 0 : b.delta * 100;
  const w = Math.min(50, Math.abs(dp) * 2);                               // 25 п.п. = полная половина полоски
  const col = neutral ? 'var(--muted)' : dp >= 0 ? 'var(--up)' : 'var(--down)';
  return '<div class="drow"><div class="dtxt"><b>' + esc(b.factor) + '</b>: ' + esc(b.label) + (soft ? ' <span class="badge">скорее</span>' : '') +
    '<div class="muted small">' + b.s.decided + ' сигн. · побед ' + pc(b.s.wr) + ' · у остальных ' + pc(b.rest.wr) + (b.s.avgR != null ? ' · ' + sgn(b.s.avgR, 2) + ' R' : '') + '</div></div>' +
    '<div class="dright"><div class="dbar"><i style="' + (dp >= 0 ? 'left:50%' : 'right:50%') + ';width:' + w.toFixed(1) + '%;background:' + col + '"></i></div><div class="small">' + sgn(dp, 0) + ' п.п.</div></div></div>';
}
function diagDetails(id, title, body) {
  return '<details data-d="' + id + '"' + (diagOpen.has(id) ? ' open' : '') + '><summary>' + title + '</summary>' + body + '</details>';
}

function diagOutcomeTxt(r, o, H) {
  if (o.state === 'win') return '<b style="color:var(--up)">✓ цель</b> за ' + o.bars + ' св. · ' + sgn(o.r, 1) + ' R';
  if (o.state === 'loss') return '<b style="color:var(--down)">✗ ' + (r.dir === 'long' ? 'условный стоп' : 'стоп') + '</b> за ' + o.bars + ' св. · −1 R' + (o.ambiguous ? ' <span class="muted">(цель и стоп в одной свече)</span>' : '');
  if (o.state === 'timeout') return '<b>⏱ по времени</b> · ' + sgn(o.r, 2) + ' R';
  return '<b style="color:var(--warn)">⏳ идёт</b> · свечей ' + o.bars + ' из ' + H + ' · ход до ' + o.mfe.toFixed(1) + ' / против ' + o.mae.toFixed(1) + ' ATR';
}

function viewDiag() {
  if (!HAS_DIAG) return '<div class="muted small">Файл diag.js не загружен. Положите его рядом с app.js и обновите страницу.</div>';
  diagEnsureBt();
  const src = diagSrcEff(), cfg = diagCfg();
  const nLive = diagRecs.length, nBt = (diagBt || []).length;
  let h = '<div class="seg" style="margin-bottom:10px">' +
    [['live', 'Живые', nLive], ['bt', 'История', nBt], ['all', 'Все', nLive + nBt]].map(x => '<button data-act="diagSrc" data-v="' + x[0] + '"' + (src === x[0] ? ' class="on"' : '') + '>' + x[1] + ' · ' + x[2] + '</button>').join('') + '</div>';
  if (diagBtBusy) h += '<div class="muted small" style="margin-bottom:8px">Считаю историю по загруженным свечам…</div>';

  const sum = diagSummary(src), o = sum.overall;
  if (!o.n) {
    h += '<div class="card"><b>Пока нет данных</b><div class="small muted" style="margin-top:4px">' +
      (src === 'live' ? 'Живые записи появятся с первым новым сигналом: приложение запомнит условия и дальше следит, чем всё кончилось.' : 'Для проверки по истории нужны линии типа «Уровень»: добавьте их на вкладке «Линии».') +
      ' Можно переключиться на «История»: уровни прогоняются по уже загруженным свечам, и результат виден сразу.</div></div>';
  } else {
    let verdict = 'мало данных', vcls = '';
    if (o.decided >= 10) {
      if (o.ci[0] > sum.be) { verdict = 'значимо выше безубыточности'; vcls = 'long'; }
      else if (o.ci[1] < sum.be) { verdict = 'значимо ниже безубыточности'; vcls = 'short'; }
      else verdict = 'от случайного не отличить';
    }
    h += '<div class="card"><div class="muted small">Точность прогноза (цель раньше стопа)</div>' +
      '<div class="row sp" style="align-items:center"><div class="dbig">' + pc(o.wr) + '</div><span class="badge ' + vcls + '" style="flex:none">' + verdict + '</span></div>' +
      '<div class="muted small">' + (o.ci ? '95% диапазон ' + pc(o.ci[0]) + '–' + pc(o.ci[1]) + ' · ' : '') + 'безубыточность ' + pc(sum.be) + ' (цель ' + cfg.target + ' / стоп ' + cfg.stop + ' ATR; у сигналов «к плотности» цель — край зоны)</div>' +
      '<div class="small" style="margin-top:6px">Цель <b>' + o.w + '</b> · стоп <b>' + o.l + '</b> · по времени <b>' + o.t + '</b> · идёт <b>' + o.open + '</b></div>' +
      '<div class="small">Средний результат: <b>' + (o.avgR == null ? '—' : sgn(o.avgR, 2) + ' R') + '</b> на сигнал <span class="muted">(1 R = размер стопа)</span></div>' +
      (o.amb ? '<div class="muted small">В ' + o.amb + ' стопах цель и стоп были в одной свече: порядок неизвестен, засчитан стоп.</div>' : '') +
      '</div>';

    const G = sum.groups;
    const helps = G.good.map(b => diagRow(b, false)).concat(G.maybeGood.map(b => diagRow(b, true)));
    const hurts = G.bad.map(b => diagRow(b, false)).concat(G.maybeBad.map(b => diagRow(b, true)));
    const empty = (t) => '<div class="muted small">' + t + '</div>';
    h += '<h3>Помогает</h3>' + (helps.length ? helps.slice(0, 12).join('') : empty('Пока ничего достоверного: нужно больше сигналов или различия слишком малы.'));
    h += '<h3>Мешает</h3>' + (hurts.length ? hurts.slice(0, 12).join('') : empty('Пока ничего достоверного.'));
    if (G.none.length) h += diagDetails('none', 'Не влияет (' + G.none.length + ')', G.none.map(b => diagRow(b, false, true)).join(''));
    if (G.few.length) h += diagDetails('few', 'Мало данных (' + G.few.length + ')',
      '<div class="muted small" style="margin:4px 0">Меньше ' + cfg.minN + ' завершённых сигналов в группе или в остальных: делать выводы рано.</div>' +
      G.few.map(b => '<div class="small" style="padding:3px 0"><b>' + esc(b.factor) + '</b>: ' + esc(b.label) + ' <span class="muted">· ' + b.s.decided + ' сигн.' + (b.s.wr != null ? ' · побед ' + pc(b.s.wr) : '') + '</span></div>').join(''));
  }

  if (nLive) {
    const hz = Math.min(cfg.horizon, Diag.MAXBARS);
    h += '<h3>Журнал живых сигналов</h3>' + diagRecs.slice(-15).reverse().map(r => {
      const oc = Diag.outcome(r, cfg);
      return '<div class="card ' + r.dir + '"><div class="top"><span class="badge ' + r.dir + '">' + DIR_NAME[r.dir] + '</span><b>' + TF[r.tf].label + '</b><span class="muted small right">' + fmtStamp(r.t) + '</span></div>' +
        '<div class="small">' + (r.trig === 'mag' ? 'к плотности ' + fmtP(r.levelPrice) + ' · цель ' + (r.tgt || '—') + ' ATR' : r.trig === 'liq' ? 'вынос плотности' : 'уровень ' + fmtP(r.levelPrice)) + ' · вход ' + fmtP(r.entry) + ' · K ' + fmtK(r.k) + '</div><div class="small">' + diagOutcomeTxt(r, oc, hz) + '</div></div>';
    }).join('');
  }

  h += '<h3>Данные</h3><button class="btn full" data-act="diagBt">Пересчитать историю</button>' +
    '<div class="row" style="margin-top:8px"><button class="btn" data-act="diagCsv">Скачать CSV</button><button class="btn" data-act="diagJson">Скачать JSON</button></div>' +
    (nLive ? '<button class="btn full danger" data-act="diagClear" style="margin-top:8px">Очистить живые записи (' + nLive + ')</button>' : '');

  h += diagDetails('how', 'Как это считается',
    '<div class="small muted" style="line-height:1.5">' +
    '<p><b>Победа.</b> Цена прошла в сторону сигнала на ' + cfg.target + ' ATR раньше, чем против него на ' + cfg.stop + ' ATR, в пределах ' + cfg.horizon + ' свечей своего таймфрейма. ATR берётся на момент сигнала. Если за этот срок не случилось ни того, ни другого, исход «по времени», результат берётся по закрытию. Если цель и стоп оказались в одной свече, засчитывается стоп. Значения меняются в «Настройки → Диагностика», исходы пересчитываются сразу. В реальных сделках у ЛОНГа стопа нет, а в диагностике он условный: нужен, чтобы мерить точность.</p>' +
    '<p><b>Точность</b> = цели / (цели + стопы). Безубыточность — какая доля побед нужна при такой цели и таком стопе, чтобы остаться в нуле.</p>' +
    '<p><b>Помогает / мешает.</b> Доля побед в группе сравнивается с остальными сигналами. «Скорее» — различие на уровне 95% уверенности, без пометки — около 99%, и в обоих случаях не меньше 4–6 п.п. Групп много, поэтому часть случайных совпадений неизбежна: верьте тем, где сигналов много и вывод повторяется и на живых, и на исторических данных.</p>' +
    '<p><b>Живые</b> — реальные сигналы, пришедшие, пока приложение было открыто. <b>История</b> — текущие линии-уровни, прогнанные по загруженным свечам (1000 на таймфрейм). Линии вы ставили, уже видя график, поэтому история обычно завышает результат. Плотности ликвидаций в историю не входят: их прошлых положений нет, статистика по ним копится только из живых сигналов. «Совпадение ТФ» тоже есть только у живых.</p>' +
    '<p><b>Зависимые сигналы.</b> Сигналы на одном уровне, в одну сторону и в одном 4-часовом окне (в том числе на разных ТФ) почти одно событие. Значимость делится на √' + (sum.de || 1).toFixed(1) + ' (во столько раз сигналов больше, чем независимых событий), доверительный интервал точности считается по числу событий.</p>' +
    '<p>Это сводка по прошлым сигналам, а не обещание на будущее.</p></div>');
  return h;
}

// ---------- обучение: вкладка ----------
const LEARN_EV = { appr: 'Подходы к линии', pivot: 'Экстремумы', ctl: 'Контроль' };
function learnStat(recs) { const cfg = learnOutCfg(); return Diag.tally(recs.map(r => ({ r, o: Diag.outcome(r, cfg) }))); }
function learnSummary(src, ev) {
  const cfg = learnOutCfg(), key = [learnVersion, src, ev, cfg.horizon, cfg.minN].join('|');
  if (!learnMemo || learnMemo.key !== key) {
    const all = learnRecs(src);
    learnMemo = { key, sum: Learn.summarize(all.filter(r => ev === 'all' || r.trig === ev), cfg), fr: Learn.freq(all) };
  }
  return learnMemo;
}
function learnFreqRow(b) {
  const dp = (b.pa - b.pb) * 100, w = Math.min(50, Math.abs(dp) * 2), more = b.v === 'more' || b.v === 'maybeMore';
  return '<div class="drow"><div class="dtxt"><b>' + esc(b.factor) + '</b>: ' + esc(b.label) + (b.v.indexOf('maybe') === 0 ? ' <span class="badge">скорее</span>' : '') +
    '<div class="muted small">у разворотов ' + pc(b.pa) + ' (' + b.ka + ') · на обычной свече ' + pc(b.pb) + ' (' + b.kb + ')</div></div>' +
    '<div class="dright"><div class="dbar"><i style="' + (dp >= 0 ? 'left:50%' : 'right:50%') + ';width:' + w.toFixed(1) + '%;background:' + (more ? 'var(--accent)' : 'var(--muted)') + '"></i></div><div class="small">' + sgn(dp, 0) + ' п.п.</div></div></div>';
}

function viewLearn() {
  if (!HAS_LEARN) return '<div class="muted small">Файл learn.js не загружен. Положите его рядом с app.js и обновите страницу.</div>';
  learnEnsureHist();
  const src = ['hist', 'live', 'all'].includes(settings.learnSrc) ? settings.learnSrc : 'hist';
  const ev = ['all', 'appr', 'pivot', 'ctl'].includes(settings.learnEv) ? settings.learnEv : 'all';
  const hist = learnHist || [], nH = hist.length, nL = learnLive.length, cfg = learnOutCfg();
  const empty = (t) => '<div class="muted small">' + t + '</div>';
  const seg = (act, cur, items) => '<div class="seg" style="margin-bottom:8px">' + items.map(x => '<button data-act="' + act + '" data-v="' + x[0] + '"' + (cur === x[0] ? ' class="on"' : '') + '>' + x[1] + '</button>').join('') + '</div>';

  let h = '<div class="card"><div class="sw"><span>Собирать живые события<br><span class="muted small">' +
    (settings.learnOn ? (nL >= LEARN_CAP ? 'лимит ' + LEARN_CAP + ' записей: выгрузите и очистите' : 'собрано ' + nL + (learnSince ? ' с ' + fmtStamp(learnSince * 1000) : '')) : 'выключено, собрано ' + nL) + '</span></span>' +
    '<input type="checkbox" data-set="learnOn"' + (settings.learnOn ? ' checked' : '') + '></div>' +
    '<div class="muted small">Приложение запоминает подходы цены к вашим линиям и развороты вместе с условиями рядом. Копится, пока оно открыто. Для сравнения с историей нужны недели.</div></div>';
  h += seg('learnSrc', src, [['hist', 'История · ' + nH], ['live', 'Живые · ' + nL], ['all', 'Все · ' + (nH + nL)]]);
  h += seg('learnEv', ev, [['all', 'Все'], ['appr', 'Подходы'], ['pivot', 'Экстремумы'], ['ctl', 'Контроль']]);
  if (learnBusy || (learnHist === null && src !== 'live')) h += '<div class="muted small" style="margin-bottom:8px">Считаю историю по загруженным свечам…</div>';

  // История против живых: если выводы настоящие, цифры по типам событий должны быть близки
  const cell = (s) => s.n ? s.n + ' · ' + pc(s.wr) : '—';
  h += '<h3>История и живые</h3><div class="small" style="display:grid;grid-template-columns:1.3fr 1fr 1fr;gap:4px 8px"><span class="muted">событий · побед</span><b>История</b><b>Живые</b>' +
    ['appr', 'pivot', 'ctl'].map(e => '<span>' + LEARN_EV[e] + '</span><span>' + cell(learnStat(hist.filter(r => r.trig === e))) + '</span><span>' + cell(learnStat(learnLive.filter(r => r.trig === e))) + '</span>').join('') + '</div>' +
    '<div class="muted small" style="margin:4px 0 8px">Победа: подход — отбой на ' + cfg.bounce + ' ATR раньше пробоя на ' + cfg.brk + '; экстремум и контроль — ход на ' + cfg.rev + ' ATR в сторону разворота раньше хода на ' + cfg.stop + ' против. У ваших линий история завышена: вы ставили их, уже видя график; автоуровни считаются без заглядывания (фактор «Источник линии»).</div>';

  const m = learnSummary(src, ev), sum = m.sum, o = sum.overall;
  if (!learnRecs(src).length) {
    h += '<div class="card"><b>Пока нет данных</b><div class="small muted" style="margin-top:4px">' + (src === 'live' ? 'Включите сбор: живые события появятся после закрытия ближайших свечей.' : 'Дождитесь загрузки свечей. Подходы к линиям считаются, когда на вкладке «Линии» есть линии типа «Уровень».') + '</div></div>';
  } else {
    h += '<h3>Условия в момент разворота</h3>';
    const fr = m.fr.filter(b => b.v !== 'none'), frNone = m.fr.filter(b => b.v === 'none');
    if (!m.fr.length) h += empty('Нужно не меньше 20 экстремумов и 20 контрольных событий в выбранном источнике.');
    else {
      h += '<div class="muted small" style="margin-bottom:4px">Что чаще встречается у локальных экстремумов, чем на обычной свече. Экстремум отбирается по будущим свечам, поэтому это описание, а не прогноз.</div>' +
        (fr.length ? fr.slice(0, 14).map(learnFreqRow).join('') : empty('Достоверных отличий нет.'));
      if (frNone.length) h += diagDetails('l-fnone', 'Не отличается (' + frNone.length + ')', frNone.map(b => learnFreqRow(b)).join(''));
    }

    h += '<h3>Что помогает победе' + (ev === 'all' ? '' : ': ' + LEARN_EV[ev].toLowerCase()) + '</h3>';
    if (ev === 'all') h += '<div class="muted small" style="margin-bottom:4px">У разных типов событий разные цели: для чистой картины выберите один тип.</div>';
    if (!o.n) h += empty('Нет событий выбранного типа.');
    else {
      const G = sum.groups;
      h += '<div class="card"><div class="row sp" style="align-items:center"><div class="dbig">' + pc(o.wr) + '</div><div class="small muted" style="text-align:right">' + o.decided + ' завершённых · безубыточность ' + pc(sum.be) + (o.ci ? '<br>95% диапазон ' + pc(o.ci[0]) + '–' + pc(o.ci[1]) : '') + '</div></div>' +
        '<div class="small">Победы <b>' + o.w + '</b> · стопы <b>' + o.l + '</b> · по времени <b>' + o.t + '</b> · идёт <b>' + o.open + '</b></div></div>';
      const helps = G.good.map(b => diagRow(b, false)).concat(G.maybeGood.map(b => diagRow(b, true)));
      const hurts = G.bad.map(b => diagRow(b, false)).concat(G.maybeBad.map(b => diagRow(b, true)));
      h += '<div class="muted small" style="margin:6px 0 2px"><b>Помогает</b></div>' + (helps.length ? helps.slice(0, 10).join('') : empty('Пока ничего достоверного.'));
      h += '<div class="muted small" style="margin:6px 0 2px"><b>Мешает</b></div>' + (hurts.length ? hurts.slice(0, 10).join('') : empty('Пока ничего достоверного.'));
      if (G.none.length) h += diagDetails('l-none', 'Не влияет (' + G.none.length + ')', G.none.map(b => diagRow(b, false, true)).join(''));
      if (G.few.length) h += diagDetails('l-few', 'Мало данных (' + G.few.length + ')', G.few.map(b => '<div class="small" style="padding:3px 0"><b>' + esc(b.factor) + '</b>: ' + esc(b.label) + ' <span class="muted">· ' + b.s.decided + ' соб.' + (b.s.wr != null ? ' · побед ' + pc(b.s.wr) : '') + '</span></div>').join(''));
    }
  }

  h += '<h3>Данные для анализа</h3><button class="btn full" data-act="learnPrompt">Скопировать сводку для ИИ</button>' +
    '<div class="row" style="margin-top:8px"><button class="btn" data-act="learnJson">Скачать JSON</button><button class="btn" data-act="learnCsv">Скачать CSV</button></div>' +
    '<div class="row" style="margin-top:8px"><button class="btn" data-act="learnJson" data-v="path">JSON с путями цены</button><button class="btn" data-act="learnRun">Пересчитать историю</button></div>' +
    (nL ? '<button class="btn full danger" data-act="learnClear" style="margin-top:8px">Очистить живые записи (' + nL + ')</button>' : '');

  h += diagDetails('l-how', 'Как это считается',
    '<div class="small muted" style="line-height:1.5">' +
    '<p><b>Подход</b> — первая свеча, зашедшая в зону ' + cfg.prox + ' ATR у вашей линии (цена пришла сверху — ждём отбой вверх, снизу — вниз). <b>Экстремум</b> — свеча, чей максимум или минимум не перекрыт соседями на ±' + cfg.win + ' свечей. <b>Контроль</b> — каждая ' + cfg.ctlStep + '-я свеча в обе стороны: с ней сравниваются экстремумы, чтобы понять, что именно особенного было в момент разворота.</p>' +
    '<p><b>Условия</b> считаются только по данным до события: StochRSI и его разворот, StochRSI старшего ТФ, расстояние до ближней линии и число её тестов, плотность рядом (только живые), тренд по EMA50, волатильность, объём, форма свечи, время суток и день недели.</p>' +
    '<p><b>Ограничения.</b> В истории линии расставлены задним числом, плотностей нет, поэтому она завышает результат; живые события этого лишены, но копятся медленно. События на соседних свечах и разных ТФ зависимы, а групп много: часть совпадений случайна. Верить стоит тому, что повторяется и в истории, и на живых данных.</p>' +
    '<p>Это сбор статистики для анализа, а не торговый сигнал.</p></div>');
  return h;
}

const RULES = {
  rsiLen: [2, 100, 1], stochLen: [2, 100, 1], kLen: [1, 20, 1], dLen: [1, 20, 1], overbought: [50, 99, 0], oversold: [1, 50, 0],
  liqOpacity: [0.1, 1, 0], proxAtr: [0.05, 5, 0], depthAtr: [0.1, 5, 0], guardAtr: [0, 10, 0], sweepWindow: [1, 30, 1], flipAtr: [0, 5, 0], magMax: [0.5, 10, 0], magStop: [0.2, 5, 0], magFar: [3, 100, 0],
  tgKHi: [50, 99, 0], tgKLo: [1, 50, 0], sqAtr: [1, 20, 0], sqN: [1, 10, 1], sqVol: [1, 20, 0],
  diagTarget: [0.2, 10, 0], diagStop: [0.2, 10, 0], diagHorizon: [1, 48, 1], diagMinN: [5, 200, 1],
  autoWin: [2, 15, 1], autoTol: [0.2, 3, 0], autoMax: [2, 16, 1],
  learnRev: [0.5, 10, 0], learnStop: [0.3, 5, 0], learnWin: [1, 10, 1], learnBounce: [0.3, 5, 0], learnBreak: [0.2, 3, 0], learnProx: [0.1, 2, 0], learnH: [4, 48, 1], learnCtl: [2, 50, 1]
};
const BT_KEYS = new Set(['rsiLen', 'stochLen', 'kLen', 'dLen', 'overbought', 'oversold', 'proxAtr', 'depthAtr', 'guardAtr', 'sweepWindow', 'flipAtr']);
const RECOMPUTE = new Set(['rsiLen', 'stochLen', 'kLen', 'dLen']);

function onSetting(el) {
  const k = el.dataset.set;
  let v;
  if (el.type === 'checkbox') v = el.checked;
  else if (el.tagName === 'SELECT') v = el.value;
  else if (el.type === 'text' || el.type === 'password') v = String(el.value).trim();
  else {
    v = parseFloat(String(el.value).replace(',', '.'));
    const r = RULES[k];
    if (!Number.isFinite(v)) v = (k in Core.DEFAULTS) ? Core.DEFAULTS[k] : UI_DEFAULTS[k];
    if (r) { v = Math.min(r[1], Math.max(r[0], v)); if (r[2]) v = Math.round(v); }
  }
  settings[k] = v;
  saveSettings();
  if (RECOMPUTE.has(k)) { TFS.forEach(t => { const d = data[t.id]; if (d) d.ind = Core.compute(d.candles, settings); }); renderChart(false); }
  if (k === 'overbought' || k === 'oversold') drawStochRefs();
  if (k === 'keepAwake') applyWakeLock();
  if (k === 'liqOpacity') renderLines();
  if (BT_KEYS.has(k)) diagInvalidateBt(); else if (k.indexOf('diag') === 0) diagVersion++;   // история устарела / пересчитать исходы
  if (k.indexOf('auto') === 0) { autoKey = ''; autoSigKey = ''; autoRefresh(true); learnInvalidate(); }
  if (k.indexOf('learn') === 0) { learnInvalidate(); if (k === 'learnOn' && v) learnScan(true); }
  evaluateAll();
  renderPanel(true);
}

function onAct(act, el) {
  if (act === 'tgTest') tgTest();
  else if (act === 'autoUnhide') { autoHidden = []; LS.set('autoHidden', autoHidden); autoSigKey = ''; autoRefresh(true); renderPanel(true); }
  else if (act === 'heatOpen') heatOpen();
  else if (act === 'learnSrc') { settings.learnSrc = el.dataset.v; saveSettings(); learnVersion++; renderPanel(true); }
  else if (act === 'learnEv') { settings.learnEv = el.dataset.v; saveSettings(); learnVersion++; renderPanel(true); }
  else if (act === 'learnRun') { learnInvalidate(); renderPanel(true); }
  else if (act === 'learnJson') downloadText('eth-learn-' + diagFileStamp() + '.json', JSON.stringify(learnExport(el.dataset.v === 'path')), 'application/json');
  else if (act === 'learnCsv') downloadText('eth-learn-' + diagFileStamp() + '.csv', Learn.toCsv(learnRecs('all'), learnOutCfg()), 'text/csv;charset=utf-8');
  else if (act === 'learnPrompt') learnCopyPrompt();
  else if (act === 'learnClear') {
    if (confirm('Удалить все живые записи обучения (' + learnLive.length + ')? Сбор начнётся заново с этого момента.')) {
      learnLive = []; learnSince = Math.floor(Date.now() / 1000); learnLines = {}; LS.set('learn', learnLive); LS.set('learnSince', learnSince); LS.set('learnLines', learnLines);
      learnVersion++; renderPanel(true);
    }
  }
  else if (act === 'diagSrc') { settings.diagSrc = el.dataset.v; saveSettings(); diagVersion++; renderPanel(true); }
  else if (act === 'diagBt') {
    if (!levels.some(l => l.type === 'sr')) { toast('Нет линий-уровней: проверять по истории нечего'); return; }
    const n = diagRunBacktest(); renderPanel(true);
    toast('История пересчитана: сигналов ' + n);
  }
  else if (act === 'diagCsv') downloadText('eth-diag-' + diagFileStamp() + '.csv', Diag.toCsv(diagRecs.concat(diagBt || []), diagCfg()), 'text/csv;charset=utf-8');
  else if (act === 'diagJson') downloadText('eth-diag-' + diagFileStamp() + '.json', JSON.stringify({ v: 1, exported: new Date().toISOString(), cfg: diagCfg(), live: diagRecs, history: diagBt || [] }), 'application/json');
  else if (act === 'diagClear') { if (confirm('Удалить все живые записи диагностики (' + diagRecs.length + ')?')) { diagRecs = []; diagTouch(); diagFlushSave(); renderPanel(true); } }
  else if (act === 'addLine') openLevelModal(null);
  else if (act === 'clearHist') { if (confirm('Очистить историю сигналов?')) { history = []; LS.set('history', history); updateMarkers(); renderPanel(true); } }
  else if (act === 'notif') {
    Notification.requestPermission().then(() => renderPanel(true));
  }
  else if (act === 'export') {
    $('#ioBox').value = JSON.stringify({ v: 1, levels }, null, 1);
  } else if (act === 'import') {
    try {
      const o = JSON.parse($('#ioBox').value);
      const arr = (o.levels || []).filter(validLevel).map(normLevel);
      if (!arr.length && !confirm('В копии нет линий. Удалить все текущие линии?')) return;
      levels = arr; saveLevels(); renderLines(); evaluateAll(); renderPanel(true);
      toast('Импортировано линий: ' + arr.length);
    } catch (e) { toast('Не удалось прочитать JSON'); }
  } else if (act === 'resetSettings') {
    if (!confirm('Сбросить все настройки (линии останутся)?')) return;
    settings = Object.assign({}, Core.DEFAULTS, UI_DEFAULTS, { tf: currentTf, tgOn: settings.tgOn, tgToken: settings.tgToken, tgChat: settings.tgChat });
    saveSettings();
    diagInvalidateBt();
    TFS.forEach(t => { const d = data[t.id]; if (d) d.ind = Core.compute(d.candles, settings); });
    renderChart(false); drawStochRefs(); evaluateAll(); renderPanel(true);
  }
}

// ---------- плотности из скриншота (heat.js) ----------
// Скриншот карты ликвидаций Coinglass → жёлтые полосы у правого края → плотности на графике.
// Прежние плотности из скриншота (src:'img') при новом импорте заменяются, ручные не трогаются.
const HAS_HEAT = typeof Heat !== 'undefined';
let heat = null;                         // {items:[{name, canvas, img, an, top, bot, edges, zones}], thr, merged, sel}
let heatAt = LS.get('heatAt', 0) || 0;   // когда плотности из скриншота обновляли последний раз (сек)
let heatReminded = false;
const HEAT_W = 1200;                     // скриншот сжимается до этой ширины: быстрее, а детали полос не теряются

function heatStale() {
  if (!heatAt) return null;
  const taken = levels.some(l => l.src === 'img' && l.takenAt && l.takenAt >= heatAt);
  const old = Date.now() / 1000 - heatAt > 86400;
  return (taken || old) ? (taken ? 'часть снята ценой' : 'старше суток') : '';
}
function heatStatusHtml() {
  if (!heatAt) return '<div class="muted small" style="margin:6px 0">Скриншот карты ликвидаций Coinglass превращается в плотности на графике.</div>';
  const st = heatStale();
  return '<div class="small" style="margin:6px 0;color:' + (st ? 'var(--warn)' : 'var(--muted)') + '">Плотности из скриншота: ' + fmtDT(heatAt) + (st ? ' · пора обновить (' + st + ')' : '') + '</div>';
}
function heatRemind() {
  if (heatReminded || !heatAt) return;
  const st = heatStale();
  if (st) { heatReminded = true; toast('<b>Обновите плотности</b><br>Плотности из скриншота: ' + st + '. Вкладка «Линии» → «Плотности из скриншота».'); }
}

async function heatLoadFile(file) {
  let bmp;
  if (window.createImageBitmap) bmp = await createImageBitmap(file);
  else bmp = await new Promise((ok, bad) => { const im = new Image(), u = URL.createObjectURL(file); im.onload = () => { URL.revokeObjectURL(u); ok(im); }; im.onerror = bad; im.src = u; });
  const w0 = bmp.width, h0 = bmp.height, k = Math.min(1, HEAT_W / w0);
  const c = document.createElement('canvas');
  c.width = Math.round(w0 * k); c.height = Math.round(h0 * k);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0, c.width, c.height);
  const img = g.getImageData(0, 0, c.width, c.height);
  return { name: file.name || 'скриншот', canvas: c, img, an: Heat.analyze(img), top: '', bot: '', edges: false, zones: [] };
}
async function heatAddFiles(files) {
  if (!heat) return;
  for (const f of files) {
    if (!/^image\//.test(f.type)) continue;
    try { heat.items.push(await heatLoadFile(f)); } catch (e) { toast('Не удалось открыть ' + esc(f.name || 'картинку')); }
  }
  heatDraw();
}

function heatOpen() {
  if (!HAS_HEAT) { toast('Файл heat.js не загружен'); return; }
  heat = { items: [], thr: 0.8, merged: [], sel: new Set() };
  heatDraw();
  $('#heatModal').hidden = false;
}
function heatClose() { $('#heatModal').hidden = true; heat = null; }

// пересчёт зон по всем скриншотам, у кого введены обе метки оси
function heatCompute() {
  const lists = [];
  heat.items.forEach(it => {
    it.zones = it.an.ok ? Heat.zones(it.an, heat.thr, num(it.top), num(it.bot), it.edges) : [];
    if (it.zones.length) lists.push(it.zones);
  });
  const a = refAtr();
  heat.merged = Heat.merge(lists, Number.isFinite(a) ? 0.3 * a : 2);
  heat.sel = new Set(heat.merged.slice(0, 8).map((_, i) => i));      // по умолчанию отмечены до 8 самых значимых
}

function heatPaint(it, cv) {
  if (!cv) return;
  cv.width = it.canvas.width; cv.height = it.canvas.height;
  const g = cv.getContext('2d');
  g.drawImage(it.canvas, 0, 0);
  if (!it.an.ok) return;
  const r = it.an.rect, lw = Math.max(2, cv.width / 400);
  g.lineWidth = lw; g.strokeStyle = 'rgba(0,200,255,.9)'; g.strokeRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
  g.fillStyle = '#fff';
  it.an.labels.forEach(y => g.fillRect(r.x1 + 2, y - lw / 2, cv.width * 0.012, lw));       // найденные метки оси
  g.strokeStyle = 'rgba(255,0,200,.95)';
  Heat.bandsAt(it.an, heat.thr).forEach(b => g.strokeRect(r.x0, b.y0 - 1, r.x1 - r.x0, b.y1 - b.y0 + 2));   // найденные полосы
}

function heatZonesHtml() {
  const a = refAtr(), m = heat.merged;
  const filled = heat.items.filter(it => it.an.ok && num(it.top) > num(it.bot) && num(it.bot) > 0);
  let h = '';
  const out = filled.filter(it => lastPrice != null && (lastPrice > num(it.top) * 1.02 || lastPrice < num(it.bot) * 0.98));
  if (out.length) h += '<div class="small" style="color:var(--warn);margin:6px 0">Текущая цена ' + fmtP(lastPrice) + ' вне оси на скриншоте «' + esc(out[0].name) + '»: проверьте числа или галочку «по краям карты».</div>';
  if (!filled.length) return h + '<div class="muted small" style="margin:6px 0">Впишите значения самой верхней и самой нижней отметки оси цен для каждого скриншота: зоны появятся здесь.</div>';
  if (!m.length) return h + '<div class="muted small" style="margin:6px 0">Ярких полос у правого края не найдено. Попробуйте порог «+ зелёные».</div>';
  h += '<div class="muted small" style="margin:8px 0 4px">Найдено зон: ' + m.length + '. Отметьте, какие добавить.</div>';
  m.forEach((z, i) => {
    const mid = (z.lo + z.hi) / 2, w = z.hi - z.lo, pct = lastPrice ? (mid - lastPrice) / lastPrice * 100 : NaN;
    h += '<div class="sw"><span>' + fmtP(z.lo) + ' – ' + fmtP(z.hi) + ' <span class="muted small">' + (mid >= (lastPrice || 0) ? 'выше цены' : 'ниже цены') + (Number.isFinite(pct) ? ' ' + (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%' : '') +
      ' · ширина $' + w.toFixed(1) + (Number.isFinite(a) ? ' (' + (w / a).toFixed(1) + ' ATR)' : '') + ' · яркость ' + Math.round(z.peak * 100) + '%' + (z.n > 1 ? ' · <b>×' + z.n + ' скрина</b>' : '') + '</span></span>' +
      '<input type="checkbox" data-heat="pick" data-i="' + i + '"' + (heat.sel.has(i) ? ' checked' : '') + '></div>';
  });
  return h;
}

function heatDraw() {
  if (!heat) return;
  heatCompute();
  const items = heat.items.map((it, i) =>
    '<div class="card"><div class="top"><b class="small">' + esc(it.name) + '</b><span class="right"></span><button class="btn ico danger" data-heat-act="del" data-i="' + i + '">✕</button></div>' +
    '<canvas id="heatCv' + i + '"></canvas>' +
    (it.an.ok
      ? '<div class="muted small" style="margin:4px 0">Голубая рамка — найденная карта, белые чёрточки — метки оси, розовые рамки — яркие полосы.</div>' +
        '<div class="grid2"><label class="f">Верхняя метка оси<input type="number" inputmode="decimal" data-heat="top" data-i="' + i + '" value="' + esc(it.top) + '" placeholder="например 1996"></label>' +
        '<label class="f">Нижняя метка оси<input type="number" inputmode="decimal" data-heat="bot" data-i="' + i + '" value="' + esc(it.bot) + '" placeholder="например 1400"></label></div>' +
        '<div class="sw"><span class="small">Считать по краям карты (если метки найдены неверно)</span><input type="checkbox" data-heat="edges" data-i="' + i + '"' + (it.edges ? ' checked' : '') + '></div>'
      : '<div class="small" style="color:var(--down);margin-top:6px">' + esc(it.an.reason) + '</div>') + '</div>').join('');
  $('#heatBody').innerHTML =
    '<h2>Плотности из скриншота</h2>' +
    '<div class="muted small">Карта ликвидаций Coinglass (Liquidation Heatmap): снимайте на нужных периодах (12ч, 48ч, 7д), можно несколько. Лучше с видимой осью цен справа.</div>' +
    '<div class="row" style="margin:10px 0"><label class="btn primary" style="text-align:center;cursor:pointer">Выбрать скриншоты<input type="file" id="heatFile" accept="image/*" multiple hidden></label></div>' +
    '<div class="muted small" style="margin-bottom:8px">На компьютере можно вставить из буфера: Ctrl+V.</div>' + items +
    '<label class="f">Яркость полос</label><div class="seg" id="heatThr">' +
    [[0.9, 'только самые яркие'], [0.8, 'яркие'], [0.7, '+ зелёные']].map(x => '<button data-heat-act="thr" data-v="' + x[0] + '"' + (heat.thr === x[0] ? ' class="on"' : '') + '>' + x[1] + '</button>').join('') + '</div>' +
    '<div id="heatZones">' + heatZonesHtml() + '</div>' +
    '<div class="muted small" style="margin-top:8px">Прежние плотности из скриншота заменятся, ручные останутся.</div>' +
    '<div class="row" style="margin-top:12px"><button class="btn" data-heat-act="close">Отмена</button><button class="btn primary" data-heat-act="apply">Добавить на график</button></div>';
  heat.items.forEach((it, i) => heatPaint(it, $('#heatCv' + i)));
}
// при вводе чисел обновляем только зоны и рамки, не перерисовывая окно (иначе слетает фокус)
function heatRefresh() {
  heatCompute();
  $('#heatZones').innerHTML = heatZonesHtml();
  heat.items.forEach((it, i) => heatPaint(it, $('#heatCv' + i)));
}

function heatApply() {
  const picks = heat.merged.filter((_, i) => heat.sel.has(i));
  if (!picks.length) { toast('Не отмечено ни одной зоны'); return; }
  const now = Math.floor(Date.now() / 1000), a = refAtr();
  const keep = levels.filter(l => !(l.src === 'img' && !isTaken(l)));
  const added = picks.map(z => {
    const mid = (z.lo + z.hi) / 2, line = Number.isFinite(a) && z.hi - z.lo < 0.15 * a;
    const o = { id: uid(), type: 'liq', price: round2(line ? mid : z.lo), side: mid >= (lastPrice || 0) ? 'above' : 'below', t: now, src: 'img' };
    if (!line) o.price2 = round2(z.hi);
    if (z.n > 1) o.n = z.n;
    return o;
  });
  levels = keep.concat(added);
  heatAt = now; LS.set('heatAt', heatAt); heatReminded = false;
  afterLevelsChange();
  heatClose();
  toast('Плотности из скриншота добавлены: ' + added.length);
}

function heatBind() {
  const root = $('#heatModal');
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-heat-act]');
    if (!b || !heat) return;
    const act = b.dataset.heatAct;
    if (act === 'close') heatClose();
    else if (act === 'apply') heatApply();
    else if (act === 'del') { heat.items.splice(+b.dataset.i, 1); heatDraw(); }
    else if (act === 'thr') { heat.thr = +b.dataset.v; heatDraw(); }
  });
  root.addEventListener('input', (e) => {
    const t = e.target;
    if (!heat || !t.dataset || (t.dataset.heat !== 'top' && t.dataset.heat !== 'bot')) return;
    heat.items[+t.dataset.i][t.dataset.heat] = t.value;
    heatRefresh();
  });
  root.addEventListener('change', (e) => {
    const t = e.target;
    if (!heat) return;
    if (t.id === 'heatFile') { heatAddFiles(Array.from(t.files || [])); t.value = ''; }
    else if (t.dataset && t.dataset.heat === 'edges') { heat.items[+t.dataset.i].edges = t.checked; heatRefresh(); }
    else if (t.dataset && t.dataset.heat === 'pick') { const i = +t.dataset.i; if (t.checked) heat.sel.add(i); else heat.sel.delete(i); }
  });
  document.addEventListener('paste', (e) => {
    if (!heat || !e.clipboardData) return;
    const files = Array.from(e.clipboardData.files || []).filter(f => /^image\//.test(f.type));
    if (files.length) { e.preventDefault(); heatAddFiles(files); }
  });
}

// ---------- окно добавления / правки линии ----------
const num = (v) => parseFloat(String(v).replace(',', '.'));
let ms = null;
let modalShownAt = 0;
const toLocalInput = (sec) => { const d = new Date(sec * 1000); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()); };
function openLevelModal(l) {
  const startSec = l && l.t && !l.takenAt ? l.t : Math.floor(Date.now() / 1000);   // у снятой («Изм.» = вернуть в работу) начало — сейчас
  ms = l ? { id: l.id, type: l.type, price: l.price, price2: l.price2 || '', start: toLocalInput(startSec),
             side: l.side || (lastPrice && (l.price + (l.price2 || l.price)) / 2 < lastPrice ? 'below' : 'above'), volume: l.volume || '', sideTouched: true }
         : { id: null, type: 'sr', price: lastPrice ? round2(lastPrice) : '', price2: '', side: 'above', volume: '', start: toLocalInput(startSec), sideTouched: false };
  drawModal();
}
function roleHintHtml(price) {
  const base = 'Роль назначается автоматически: линия выше цены — сопротивление, ниже — поддержка. ';
  const p = num(price);
  if (!(p > 0) || lastPrice == null) return base;
  return base + 'Сейчас: ' + (lastPrice >= p ? '<b style="color:var(--up)">поддержка</b> (цена выше линии)' : '<b style="color:var(--down)">сопротивление</b> (цена ниже линии)') + '.';
}
// ширина диапазона плотности по полям «От» и «До» (0, если задана одна цена)
function zoneWidth() {
  const a = num(ms.price), b = num(ms.price2);
  return a > 0 && b > 0 ? Math.abs(b - a) : 0;
}
function autoSide() {
  if (ms.sideTouched || !lastPrice) return;
  const a = num(ms.price), b = num(ms.price2);
  if (!(a > 0)) return;
  const lo = b > 0 ? Math.min(a, b) : a, hi = b > 0 ? Math.max(a, b) : a;
  ms.side = lo > lastPrice ? 'above' : hi < lastPrice ? 'below' : ((lo + hi) / 2 > lastPrice ? 'above' : 'below');
}
function drawModal() {
  autoSide();
  const m = ms, liq = m.type === 'liq', w = zoneWidth();
  const priceBlock = liq
    ? '<div class="grid2"><label class="f">От (низ диапазона)<input id="mPrice" type="number" inputmode="decimal" step="0.01" value="' + m.price + '"></label>' +
      '<label class="f">До (верх диапазона)<input id="mPrice2" type="number" inputmode="decimal" step="0.01" placeholder="можно пусто" value="' + m.price2 + '"></label></div>' +
      '<label class="f">Ширина диапазона, $<input id="mWidth" type="number" inputmode="decimal" step="0.01" placeholder="0 — одна линия" value="' + (w > 0 ? round2(w) : '') + '"></label>' +
      '<div class="row" style="margin-top:8px"><button class="btn" id="mPick">Низ на графике</button><button class="btn" id="mPick2">Верх на графике</button></div>' +
      '<div class="muted small" style="margin-top:6px">Ширина считается из «От» и «До». Если ввести ширину, «До» = «От» + ширина. Пустое «До» — плотность одной линией.</div>'
    : '<div class="row" style="align-items:flex-end"><label class="f">Цена<input id="mPrice" type="number" inputmode="decimal" step="0.01" value="' + m.price + '"></label><button class="btn" id="mPick" style="flex:none;margin-top:10px">На графике</button></div>' +
      '<div class="muted small" id="mRole" style="margin-top:8px">' + roleHintHtml(m.price) + '</div>';
  $('#modalBody').innerHTML =
    '<h2>' + (m.id ? 'Изменить линию' : 'Новая линия') + '</h2>' +
    '<div class="seg" id="mType"><button data-v="sr" class="' + (liq ? '' : 'on') + '">Уровень</button><button data-v="liq" class="liq' + (liq ? ' on' : '') + '">Плотность</button></div>' +
    priceBlock +
    (liq ? '<label class="f">Где плотность относительно цены</label><div class="seg" id="mSide"><button data-v="above" class="' + (m.side === 'above' ? 'on liq' : '') + '">Выше (шорты)</button><button data-v="below" class="' + (m.side === 'below' ? 'on liq' : '') + '">Ниже (лонги)</button></div>' +
      '<label class="f">Объём, млн $ (по желанию)<input id="mVol" type="number" inputmode="decimal" step="0.1" value="' + m.volume + '"></label>' +
      '<label class="f">Начало плотности (время размещения)<input id="mStart" type="datetime-local" value="' + m.start + '"></label>' +
      '<div class="muted small">Плотность рисуется от этого времени вправо, пока цена её не снесёт. Можно указать время из прошлого: тогда снос посчитается по свечам с этого момента.</div>' : '') +
    '<div class="row" style="margin-top:14px">' + (m.id ? '<button class="btn danger" id="mDel">Удалить</button>' : '') + '<button class="btn" id="mCancel">Отмена</button><button class="btn primary" id="mSave">Сохранить</button></div>';
  $('#modal').hidden = false;
}
function readModal() {
  const p = $('#mPrice'), p2 = $('#mPrice2'), v = $('#mVol'), st = $('#mStart');
  if (st) ms.start = st.value;
  if (p) ms.price = p.value;
  if (p2) ms.price2 = p2.value;
  if (v) ms.volume = v.value;
}
function closeModal() { $('#modal').hidden = true; ms = null; }

// обновляем кнопки стороны на месте, не перерисовывая окно, чтобы не терять фокус в полях
function refreshSide() {
  autoSide();
  $$('#mSide button').forEach(b => { const on = b.dataset.v === ms.side; b.classList.toggle('on', on); b.classList.toggle('liq', on); });
}

function bindModal() {
  $('#modal').addEventListener('click', (e) => {
    // сразу после показа окна игнорируем клики: «хвост» тапа по графику иногда прилетает уже в окно
    if (Date.now() - modalShownAt < 450) return;
    if (e.target.id === 'modal') { closeModal(); return; }
    const b = e.target.closest('button');
    if (!b || !ms) return;
    if (b.parentElement.id === 'mType') { readModal(); ms.type = b.dataset.v; drawModal(); }
    else if (b.parentElement.id === 'mSide') { readModal(); ms.side = b.dataset.v; ms.sideTouched = true; drawModal(); }
    else if (b.id === 'mCancel') closeModal();
    else if (b.id === 'mDel') { levels = levels.filter(x => x.id !== ms.id); afterLevelsChange(); closeModal(); }
    else if (b.id === 'mPick' || b.id === 'mPick2') {
      readModal();
      const saved = ms, field = b.id === 'mPick2' ? 'price2' : 'price';
      $('#modal').hidden = true;
      setPlacing({ cb: (price) => { ms = saved; ms[field] = price; modalShownAt = Date.now(); drawModal(); } });
    } else if (b.id === 'mSave') {
      readModal();
      const liq = ms.type === 'liq';
      const a = num(ms.price), c = liq ? num(ms.price2) : NaN;
      const vals = [a, c].filter(x => x > 0);
      if (liq ? !vals.length : !(a > 0)) { $('#mPrice').style.borderColor = '#ff5b5b'; return; }
      const lo = liq ? Math.min.apply(null, vals) : a, hi = liq ? Math.max.apply(null, vals) : a;
      const obj = { id: ms.id || uid(), type: ms.type, price: round2(lo) };
      if (liq) {
        obj.side = ms.side;
        if (round2(hi) > round2(lo)) obj.price2 = round2(hi);   // диапазон; иначе плотность — одна линия
        const vol = num(ms.volume);
        if (vol > 0) obj.volume = vol;
        const nowSec = Math.floor(Date.now() / 1000), st = ms.start ? Math.floor(new Date(ms.start).getTime() / 1000) : NaN;
        obj.t = Number.isFinite(st) && st > 0 && st <= nowSec ? st : nowSec;   // с этого времени плотность рисуется и считается снесённой или нет
      }
      levels = ms.id ? levels.map(x => x.id === ms.id ? obj : x) : levels.concat(obj);
      afterLevelsChange();
      closeModal();
    }
  });
  $('#modal').addEventListener('input', (e) => {
    if (!ms) return;
    const id = e.target.id;
    if (ms.type === 'sr') {
      if (id === 'mPrice') { const hint = $('#mRole'); if (hint) hint.innerHTML = roleHintHtml(e.target.value); }
      return;
    }
    if (ms.type !== 'liq') return;
    if (id === 'mPrice' || id === 'mPrice2') {
      ms[id === 'mPrice' ? 'price' : 'price2'] = e.target.value;
      const w = zoneWidth(), wi = $('#mWidth');
      if (wi) wi.value = w > 0 ? round2(w) : '';
      refreshSide();
    } else if (id === 'mWidth') {
      const lo = num(ms.price), w = num(e.target.value);
      const p2 = $('#mPrice2');
      if (lo > 0 && w > 0) { ms.price2 = round2(lo + w); if (p2) p2.value = ms.price2; }
      else if (!(w > 0)) { ms.price2 = ''; if (p2) p2.value = ''; }
      refreshSide();
    }
  });
}
function afterLevelsChange() {
  saveLevels();
  renderLines();
  evaluateAll();
  renderPanel(true);
}

// ---------- интерфейс ----------
function buildTfBar() {
  $('#tfbar').innerHTML = TFS.map(t => '<button data-tf="' + t.id + '"' + (t.id === currentTf ? ' class="on"' : '') + '>' + t.label + '</button>').join('');
}
function setTf(id) {
  if (!TF[id] || id === currentTf) return;
  currentTf = id;
  settings.tf = id; saveSettings();
  $$('#tfbar button').forEach(b => b.classList.toggle('on', b.dataset.tf === id));
  chartReady = false;
  if (data[id]) { renderChart(true); } else { $('#loading').hidden = false; }
  renderBanner();
  renderPanel(true);
}

function bindUI() {
  $('#tfbar').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setTf(b.dataset.tf); });
  $('#tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setTab(b.dataset.tab); });
  $('#banner').addEventListener('click', () => setTab('signals'));
  $('#hintCancel').addEventListener('click', () => { const p = placing; setPlacing(null); if (p && ms) drawModal(); });
  $('#btnAdd').addEventListener('click', () => openLevelModal(null));
  $('#btnEdit').addEventListener('click', (e) => {
    editMode = !editMode;
    e.currentTarget.classList.toggle('on', editMode);
    if (editMode) toast('Режим правки: перетащите линию, тап по линии — изменить или удалить');
  });
  const panel = $('#panel');
  panel.addEventListener('pointerdown', () => { panelBusyUntil = Date.now() + 900; }, { passive: true });
  panel.addEventListener('click', (e) => {
    const t = e.target;
    const row = t.closest('tr[data-tf]');
    if (row) { setTf(row.dataset.tf); return; }
    const ed = t.closest('[data-edit]');
    if (ed) { openLevelModal(levels.find(l => l.id === ed.dataset.edit)); return; }
    const del = t.closest('[data-del]');
    if (del) { if (confirm('Удалить линию?')) { levels = levels.filter(l => l.id !== del.dataset.del); afterLevelsChange(); } return; }
    const act = t.closest('[data-act]');
    if (act) onAct(act.dataset.act, act);
  });
  // раскрывающиеся блоки диагностики помнят, открыты ли они, чтобы не схлопываться при обновлении данных
  panel.addEventListener('toggle', (e) => {
    const d = e.target;
    if (d && d.tagName === 'DETAILS' && d.dataset.d) { if (d.open) diagOpen.add(d.dataset.d); else diagOpen.delete(d.dataset.d); }
  }, true);
  panel.addEventListener('change', (e) => { if (e.target.dataset && e.target.dataset.set) onSetting(e.target); });
  bindModal();

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { diagFlushSave(); return; }
    applyWakeLock();
    if (!ws || ws.readyState !== 1 || Date.now() - lastMsg > 20000) forceReconnect();
  });
  setInterval(() => { if (ws && ws.readyState === 1 && Date.now() - lastMsg > 45000) forceReconnect(); }, 15000);
  setInterval(flush, 300);
  setInterval(() => { try { autoRefresh(); learnScan(); } catch (e) { console.error('обучение:', e); } }, 5000);
  setInterval(diagFlushSave, 15000);
  window.addEventListener('pagehide', diagFlushSave);
  setInterval(pulse, 90);
  setInterval(pulseMarkers, 90);
  matchMedia('(min-width:980px)').addEventListener('change', () => { if (isDesktop() && !tab) setTab('signals'); });
}

async function boot() {
  const ok = await loadAll();
  if (ok) { connectWS(); applyWakeLock(); }
}

function start() {
  buildTfBar();
  if (HAS_HEAT) heatBind();
  createCharts();
  renderLines();
  bindUI();
  if (isDesktop()) setTab('signals');
  boot();
  if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* офлайн-режим недоступен */ });
  }
}
start();

// для отладки и тестов
window.__eth = { data, get trades() { return trades; }, get levels() { return levels; }, get markerList() { return markerList; }, updateTaken, get activeSignals() { return activeSignals; }, applyKline, flush, evaluateAll, roleOf, lineObjs,
  get diagRecs() { return diagRecs; }, get diagBt() { return diagBt; }, diagRunBacktest, diagUpdatePaths };
})();
