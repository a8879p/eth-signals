/* Диагностика сигналов: исход каждого сигнала, факторы, статистика, бэктест по истории.
   Чистая логика: window.Diag в браузере, require('./diag.js') в Node (нужен core.js рядом). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./core.js'));
  else root.Diag = factory(root.Core);
})(typeof self !== 'undefined' ? self : this, function (Core) {
  'use strict';

  // Сколько свечей после сигнала хранится в записи. По этому «пути цены» исход пересчитывается
  // при любых настройках цели, стопа и горизонта, не заглядывая заново в историю.
  const MAXBARS = 48;
  const DEFAULTS = { target: 1, stop: 1, horizon: 24, minN: 15 };
  const TF_LABEL = { '15m': '15м', '30m': '30м', '1h': '1ч', '4h': '4ч', '6h': '6ч', '1d': '1д' };
  const TF_SEC = { '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '6h': 21600, '1d': 86400 };

  const r1 = (x) => Math.round(x * 10) / 10;
  const r2 = (x) => Math.round(x * 100) / 100;
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

  // ---------- факторы: что записываем про каждый сигнал ----------
  // buckets: [id, подпись]. В записи хранится только id.
  const FACTORS = [
    { key: 'tf', label: 'Таймфрейм', buckets: Object.keys(TF_LABEL).map(id => [id, TF_LABEL[id]]) },
    { key: 'dir', label: 'Направление', buckets: [['long', 'ЛОНГ'], ['short', 'ШОРТ']] },
    { key: 'src', label: 'Тип сигнала', buckets: [['sr', 'уровень'], ['liq', 'вынос плотности'], ['mag', 'ход к плотности']] },
    { key: 'kExt', label: 'StochRSI', buckets: [['edge', 'в самом краю (до 3 пунктов)'], ['deep', 'глубоко в зоне (3–10)'], ['border', 'у границы зоны (10–20)'], ['turn', 'уже вышел из зоны']] },
    { key: 'stick', label: 'Залипание StochRSI (свечей подряд в зоне)', buckets: [['none', 'не в зоне'], ['new', '1–2 свечи'], ['mid', '3–6 свечей'], ['long', '7 и больше']] },
    { key: 'turn', label: 'K и D', buckets: [['yes', 'есть разворот'], ['no', 'разворота нет']] },
    { key: 'dist', label: 'Расстояние до уровня', buckets: [['close', 'вплотную (до 0.1 ATR)'], ['near', 'рядом (0.1–0.25)'], ['zone', 'в зоне (0.25–0.5)'], ['far', 'дальше 0.5']] },
    { key: 'touches', label: 'Тесты уровня раньше', buckets: [['first', 'первое касание'], ['few', '1–2 теста'], ['many', '3 и больше']] },
    { key: 'sweep', label: 'Глубина выноса', buckets: [['shallow', 'малая (до 0.25 ATR)'], ['mid', 'средняя (0.25–0.6)'], ['deep', 'большая (больше 0.6)']] },
    { key: 'magDist', label: 'Расстояние до плотности', buckets: [['m1', 'до 1 ATR'], ['m2', '1–2 ATR'], ['m3', '2–3 ATR'], ['m4', '3–10 ATR'], ['m5', 'больше 10 ATR (издалека)']] },
    { key: 'zone', label: 'Ширина плотности', buckets: [['line', 'одна линия'], ['narrow', 'узкая (до 0.5 ATR)'], ['wide', 'широкая (больше 0.5)']] },
    { key: 'conf', label: 'Совпадение ТФ', buckets: [['1', 'только этот ТФ'], ['2', 'ещё один ТФ'], ['3', 'три ТФ и больше']] },
    { key: 'trend', label: 'Тренд ТФ (EMA50)', buckets: [['with', 'по тренду'], ['against', 'против тренда'], ['flat', 'боковик']] },
    { key: 'vol', label: 'Волатильность', buckets: [['low', 'низкая (ATR ниже нормы)'], ['norm', 'обычная'], ['high', 'высокая (ATR выше нормы)']] },
    { key: 'hour', label: 'Время (UTC)', buckets: [['asia', '00–08 (Азия)'], ['eu', '08–14 (Европа)'], ['us', '14–21 (США)'], ['late', '21–24']] },
    { key: 'candle', label: 'Свеча сигнала', buckets: [['with', 'в сторону сигнала'], ['against', 'против сигнала']] }
  ];

  // ---------- вспомогательные индикаторы ----------
  function ema(arr, len) {
    const out = new Array(arr.length).fill(NaN);
    if (arr.length < len) return out;
    const k = 2 / (len + 1);
    let s = 0;
    for (let i = 0; i < len; i++) s += arr[i];
    let prev = s / len;
    out[len - 1] = prev;
    for (let i = len; i < arr.length; i++) { prev = arr[i] * k + prev * (1 - k); out[i] = prev; }
    return out;
  }
  function prepare(candles) { return { ema: ema(candles.map(c => c.close), 50) }; }
  function medianAt(arr, i, w) {
    const v = [];
    for (let j = Math.max(0, i - w + 1); j <= i; j++) if (Number.isFinite(arr[j])) v.push(arr[j]);
    if (v.length < 20) return NaN;
    v.sort((x, y) => x - y);
    return v[v.length >> 1];
  }
  // Сколько раз цена уже заходила в зону близости уровня за последние 200 свечей (подряд идущие свечи = один заход).
  // Последние 3 свечи не считаются: это сам подход, по которому сработал сигнал.
  function touchEpisodes(candles, i, L, prox) {
    let n = 0, inside = false;
    for (let j = Math.max(0, i - 200); j <= i - 3; j++) {
      const t = candles[j].low <= L + prox && candles[j].high >= L - prox;
      if (t && !inside) n++;
      inside = t;
    }
    return n;
  }

  // Контекст сигнала на свече i. Использует только данные до i включительно, без заглядывания вперёд.
  function featuresFor(candles, ind, i, sig, ctx, cfgIn, conf) {
    const cfg = Object.assign({}, Core.DEFAULTS, cfgIn);
    const long = sig.dir === 'long';
    const a = ind.atr[i], k = ind.k[i], d = ind.d[i];
    const f = { tf: sig.tf, dir: sig.dir, src: sig.sub === 'mag' ? 'mag' : sig.levelType === 'liq' ? 'liq' : 'sr' };

    const e = long ? k : 100 - k;                                  // насколько K в «своём» краю: 0 — самый край
    const lim = long ? cfg.oversold : 100 - cfg.overbought;
    f.kExt = e <= 3 ? 'edge' : e <= 10 ? 'deep' : e <= lim ? 'border' : 'turn';
    f.turn = (long ? k > d : k < d) ? 'yes' : 'no';
    let run = 0;                                                    // залипание: сколько свечей подряд K в крайней зоне по ходу сигнала
    for (let j = i; j >= 0; j--) { const v = ind.k[j]; if (Number.isFinite(v) && (long ? v <= cfg.oversold : v >= cfg.overbought)) run++; else break; }
    f.stick = run === 0 ? 'none' : run <= 2 ? 'new' : run <= 6 ? 'mid' : 'long';

    if (f.src === 'sr') {
      if (Number.isFinite(sig.distAtr)) { const x = sig.distAtr; f.dist = x <= 0.1 ? 'close' : x <= 0.25 ? 'near' : x <= 0.5 ? 'zone' : 'far'; }
      const t = touchEpisodes(candles, i, sig.levelPrice, cfg.proxAtr * a);
      f.touches = t === 0 ? 'first' : t <= 2 ? 'few' : 'many';
    } else if (f.src === 'mag') {
      if (Number.isFinite(sig.targetAtr)) { const x = sig.targetAtr; f.magDist = x <= 1 ? 'm1' : x <= 2 ? 'm2' : x <= 3 ? 'm3' : x <= 10 ? 'm4' : 'm5'; }
      if (Number.isFinite(sig.zoneAtr)) { const x = sig.zoneAtr; f.zone = x < 0.01 ? 'line' : x <= 0.5 ? 'narrow' : 'wide'; }
    } else {
      if (Number.isFinite(sig.depthAtr)) { const x = sig.depthAtr; f.sweep = x <= 0.25 ? 'shallow' : x <= 0.6 ? 'mid' : 'deep'; }
      if (Number.isFinite(sig.zoneAtr)) { const x = sig.zoneAtr; f.zone = x < 0.01 ? 'line' : x <= 0.5 ? 'narrow' : 'wide'; }
    }
    if (conf != null && conf >= 1) f.conf = conf >= 3 ? '3' : String(conf);

    if (ctx && ctx.ema && i >= 10) {
      const e0 = ctx.ema[i], e1 = ctx.ema[i - 10];
      if (Number.isFinite(e0) && Number.isFinite(e1) && a > 0) {
        const s = (e0 - e1) / a;                                   // наклон EMA50 за 10 свечей в ATR
        f.trend = Math.abs(s) < 0.3 ? 'flat' : ((s > 0) === long ? 'with' : 'against');
      }
    }
    const med = medianAt(ind.atr, i, 100);
    if (Number.isFinite(med) && med > 0) { const q = a / med; f.vol = q < 0.8 ? 'low' : q <= 1.25 ? 'norm' : 'high'; }

    if (sig.tf !== '1d') {
      const h = new Date(candles[i].time * 1000).getUTCHours();
      f.hour = h < 8 ? 'asia' : h < 14 ? 'eu' : h < 21 ? 'us' : 'late';
    }
    const c = candles[i];
    f.candle = (long ? c.close > c.open : c.close < c.open) ? 'with' : 'against';
    return f;
  }

  // ---------- путь цены и исход ----------
  // Для каждой из следующих за сигналом свечей: [лучшее движение в сторону сигнала, худшее против, закрытие], всё в ATR.
  // seen = [high, low] сигнальной свечи на момент сигнала (если она ещё формировалась): её остаток входит в путь первым элементом,
  // но только движение за эти экстремумы, потому что что было до сигнала, уже известно и в исход не входит.
  function pathFrom(candles, idx, dir, entry, atr, maxBars, seen) {
    const long = dir === 'long';
    const path = [];
    let closed = 0;
    if (seen && candles[idx]) {
      const c = candles[idx];
      const up = c.high > seen[0] ? c.high - entry : 0, dn = c.low < seen[1] ? entry - c.low : 0;
      path.push([
        r2(Math.max(0, long ? up : dn) / atr),
        r2(Math.max(0, long ? dn : up) / atr),
        r2((long ? c.close - entry : entry - c.close) / atr)
      ]);
      if (c.closed !== false) closed++;
    }
    const end = Math.min(candles.length - 1, idx + (maxBars || MAXBARS));
    for (let j = idx + 1; j <= end; j++) {
      const c = candles[j];
      path.push([
        r2((long ? c.high - entry : entry - c.low) / atr),
        r2((long ? entry - c.low : c.high - entry) / atr),
        r2((long ? c.close - entry : entry - c.close) / atr)
      ]);
      if (c.closed !== false) closed++;
    }
    return { path, closed };
  }

  // Исход записи при заданных цели, стопе и горизонте.
  // win: цель достигнута раньше стопа; loss: стоп раньше цели (или обе в одной свече: порядок внутри свечи неизвестен,
  // считаем худшее); timeout: за горизонт не случилось ни того, ни другого; open: свечей ещё не хватает.
  function outcome(rec, cfgIn) {
    const cfg = Object.assign({}, DEFAULTS, cfgIn);
    // Сигнал «к плотности» хранит свои цель (до ближнего края зоны) и стоп в ATR; остальные берут их из настроек
    const T = rec.tgt > 0 ? rec.tgt : cfg.target, S = rec.stp > 0 ? rec.stp : cfg.stop, H = Math.min(cfg.horizon, MAXBARS);
    const p = rec.path || [];
    const n = Math.min(p.length, H);
    let mfe = 0, mae = 0;
    for (let j = 0; j < n; j++) {
      const fav = p[j][0], adv = p[j][1];
      mfe = Math.max(mfe, fav); mae = Math.max(mae, adv);
      const hitT = fav >= T, hitS = adv >= S;
      if (hitT && hitS) return { state: 'loss', r: -1, bars: j + 1, mfe, mae, ambiguous: true };
      if (hitT) return { state: 'win', r: T / S, bars: j + 1, mfe, mae };
      if (hitS) return { state: 'loss', r: -1, bars: j + 1, mfe, mae };
    }
    if (p.length >= H && (rec.closed || 0) >= H) {
      return { state: 'timeout', r: clamp(p[H - 1][2] / S, -1, T / S), bars: H, mfe, mae };
    }
    return { state: 'open', r: null, bars: n, mfe, mae };
  }

  // Запись о сигнале: контекст + путь цены. o: {src:'live'|'bt', t, sig, candles, ind, i, ctx, conf, cfg, entry?}
  function makeRecord(o) {
    const s = o.sig, i = o.i, a = o.ind.atr[i];
    if (!Number.isFinite(a) || a <= 0) return null;
    const entry = o.entry != null ? o.entry : s.price;
    const f = featuresFor(o.candles, o.ind, i, s, o.ctx, o.cfg, o.conf);
    const sc = o.candles[i], s0 = o.src === 'live' && sc.closed === false ? [sc.high, sc.low] : null;
    const pf = pathFrom(o.candles, i, s.dir, entry, a, MAXBARS, s0);
    const rec = {
      id: [o.src, s.tf, s.stateKey, s.candleTime].join('|'),
      src: o.src, t: o.t, tf: s.tf, dir: s.dir, trig: f.src,
      levelId: s.levelId, levelPrice: s.levelPrice,
      entry: r2(entry), atr: r2(a), k: r1(s.k), candleTime: s.candleTime,
      f, path: pf.path, closed: pf.closed
    };
    if (s0) rec.s0 = s0;
    if (s.sub === 'mag' && s.targetAtr > 0) { rec.tgt = r2(s.targetAtr); rec.stp = r2(s.stopAtr > 0 ? s.stopAtr : 1); }
    return rec;
  }

  // ---------- бэктест: текущие уровни по загруженным свечам ----------
  // Только уровни (type 'sr'): плотности ликвидаций живут недолго, их прошлых положений мы не знаем.
  // Роль уровня и гистерезис считаются так же, как в приложении, но по ATR самого таймфрейма.
  function backtest(tf, candles, ind, levels, cfgIn) {
    const out = [];
    const sr = levels.filter(l => l.type === 'sr');
    if (!sr.length || candles.length < 80) return out;
    const cfg = Object.assign({}, Core.DEFAULTS, cfgIn, { evalMode: 'live' });
    const ctx = prepare(candles);
    const state = { active: new Set(), firedCandle: new Map(), firedEver: new Set() };
    const role = {};
    const warm = Math.max(60, cfg.rsiLen + cfg.stochLen + cfg.kLen + cfg.dLen + 5);
    const last = candles[candles.length - 1].closed === false ? candles.length - 2 : candles.length - 1;
    const flip = Math.max(0, Number(cfgIn && cfgIn.flipAtr != null ? cfgIn.flipAtr : 0.5) || 0);
    for (let i = warm; i <= last; i++) {
      const a = ind.atr[i];
      if (!Number.isFinite(a)) continue;
      const p = candles[i].close, band = a * flip;
      const eff = sr.map(l => {
        let r = role[l.id];
        if (!r) r = p >= l.price ? 'support' : 'resistance';
        else if (r === 'resistance' && p > l.price + band) r = 'support';
        else if (r === 'support' && p < l.price - band) r = 'resistance';
        role[l.id] = r;
        return { id: l.id, type: r, price: l.price };
      });
      const sigs = Core.evaluate(tf, candles.slice(0, i + 1), ind, eff, cfg);
      const fresh = Core.diffSignals(state, sigs);
      for (const s of fresh) {
        const rec = makeRecord({ src: 'bt', t: (candles[i].time + (TF_SEC[tf] || 0)) * 1000, sig: s, candles, ind, i, ctx, conf: null, cfg: cfgIn, entry: candles[i].close });
        if (rec) out.push(rec);
      }
    }
    return out;
  }

  // ---------- статистика ----------
  function wilson(k, n, z) {
    z = z || 1.96;
    if (!n) return [0, 1];
    const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n);
    const m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
    return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
  }
  function zTest(k1, n1, k2, n2) {
    if (!n1 || !n2) return 0;
    const p = (k1 + k2) / (n1 + n2), se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
    return se > 0 ? (k1 / n1 - k2 / n2) / se : 0;
  }
  function tally(items) {
    let w = 0, l = 0, t = 0, open = 0, rs = 0, rn = 0, amb = 0;
    for (const it of items) {
      const o = it.o;
      if (o.state === 'win') { w++; rs += o.r; rn++; }
      else if (o.state === 'loss') { l++; rs += o.r; rn++; if (o.ambiguous) amb++; }
      else if (o.state === 'timeout') { t++; rs += o.r; rn++; }
      else open++;
    }
    const dec = w + l;
    return { n: items.length, w, l, t, open, amb, decided: dec, wr: dec ? w / dec : null, ci: dec ? wilson(w, dec) : null, avgR: rn ? rs / rn : null };
  }
  // de — «эффективное число сигналов на событие» (≥ 1): зависимые сигналы завышают z, поэтому делим его на √de
  function verdictOf(b, rest, minN, de) {
    if (b.decided < minN || rest.decided < minN) return { v: 'few', z: 0 };
    const z = zTest(b.w, b.decided, rest.w, rest.decided) / Math.sqrt(de || 1), d = b.wr - rest.wr;
    // Групп десятки, поэтому порог «уверенно» взят строже обычных 95%: z ≥ 2.58 (около 99%) и разница не меньше 6 п.п.
    // «Скорее» — 95% и разница от 4 п.п. Всё остальное — не отличить от случайности.
    if (z >= 2.58 && d >= 0.06) return { v: 'good', z };
    if (z >= 1.96 && d >= 0.04) return { v: 'maybeGood', z };
    if (z <= -2.58 && d <= -0.06) return { v: 'bad', z };
    if (z <= -1.96 && d <= -0.04) return { v: 'maybeBad', z };
    return { v: 'none', z };
  }

  function summarize(records, cfgIn, factorsIn) {
    const cfg = Object.assign({}, DEFAULTS, cfgIn);
    const items = records.map(r => ({ r, o: outcome(r, cfg) }));
    const overall = tally(items);
    // Сигналы на одном уровне, в одну сторону и в одном 4-часовом окне (и на разных ТФ) — почти одно событие
    const cl = new Set();
    items.forEach(it => { if (it.o.state === 'win' || it.o.state === 'loss') cl.add([it.r.levelId, it.r.dir, Math.floor(it.r.candleTime / 14400)].join('|')); });
    const dec = overall.w + overall.l;
    const de = cl.size ? Math.max(1, dec / cl.size) : 1;
    if (dec) { const ne = Math.max(1, dec / de); overall.ci = wilson(overall.w / dec * ne, ne); }
    const groups = { good: [], maybeGood: [], none: [], maybeBad: [], bad: [], few: [] };
    const factors = [];
    for (const F of (factorsIn || FACTORS)) {
      const def = items.filter(it => it.r.f && it.r.f[F.key] != null);
      const by = {};
      def.forEach(it => { (by[it.r.f[F.key]] || (by[it.r.f[F.key]] = [])).push(it); });
      const present = F.buckets.filter(b => by[b[0]]);
      if (present.length < 2) continue;                              // нечего сравнивать: фактор не менялся
      const row = { key: F.key, label: F.label, buckets: [] };
      for (const [id, label] of present) {
        const inB = by[id], rest = def.filter(it => it.r.f[F.key] !== id);
        const s = tally(inB), sr = tally(rest);
        const vz = verdictOf(s, sr, cfg.minN, de);
        const b = { key: F.key, factor: F.label, id, label, s, rest: sr, delta: s.wr != null && sr.wr != null ? s.wr - sr.wr : null, z: vz.z, verdict: vz.v };
        row.buckets.push(b);
        groups[vz.v].push(b);
      }
      factors.push(row);
    }
    groups.good.sort((a, b) => b.z - a.z); groups.maybeGood.sort((a, b) => b.z - a.z);
    groups.bad.sort((a, b) => a.z - b.z); groups.maybeBad.sort((a, b) => a.z - b.z);
    groups.none.sort((a, b) => b.s.decided - a.s.decided); groups.few.sort((a, b) => b.s.decided - a.s.decided);
    let beS = 0, beN = 0;
    for (const r of records) { const T = r.tgt > 0 ? r.tgt : cfg.target, S = r.stp > 0 ? r.stp : cfg.stop; beS += S / (T + S); beN++; }
    return { cfg, de, be: beN ? beS / beN : cfg.stop / (cfg.target + cfg.stop), overall, factors, groups };
  }

  function toCsv(records, cfgIn) {
    const cfg = Object.assign({}, DEFAULTS, cfgIn);
    const cols = ['source', 'time_utc', 'tf', 'dir', 'trigger', 'level', 'entry', 'atr', 'stoch_k', 'target_atr', 'stop_atr'].concat(FACTORS.map(F => 'f_' + F.key), ['outcome', 'R', 'bars', 'mfe_atr', 'mae_atr', 'ambiguous']);
    const lines = [cols.join(',')];
    for (const r of records) {
      const o = outcome(r, cfg);
      lines.push([r.src, new Date(r.t).toISOString(), r.tf, r.dir, r.trig, r.levelPrice, r.entry, r.atr, r.k, r.tgt > 0 ? r.tgt : cfg.target, r.stp > 0 ? r.stp : cfg.stop]
        .concat(FACTORS.map(F => (r.f && r.f[F.key] != null ? r.f[F.key] : '')))
        .concat([o.state, o.r == null ? '' : r2(o.r), o.bars, r2(o.mfe), r2(o.mae), o.ambiguous ? 1 : 0]).join(','));
    }
    return lines.join('\n');
  }

  return { MAXBARS, DEFAULTS, FACTORS, TF_LABEL, TF_SEC, prepare, featuresFor, pathFrom, outcome, makeRecord, backtest, wilson, zTest, tally, verdictOf, summarize, toCsv };
});
