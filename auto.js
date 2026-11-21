/* Автоматические уровни поддержки / сопротивления.
   Экстремумы (±win свечей) на 1ч, 4ч и 1д, близкие склеиваются в зоны шириной tol·ATR, вес = ТФ × свежесть.
   Главное: экстремум известен только после закрытия свечи p+win, поэтому уровни на любой момент времени
   считаются лишь по данным до него (без заглядывания вперёд). Чистая логика: window.Auto, в Node — require('./auto.js'). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Auto = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULTS = { win: 5, tol: 0.6, max: 8, reachAtr: 12, lookDays: 120, halfDays: 30 };
  const SRC = ['1h', '4h', '1d'];
  const TFW = { '1h': 1, '4h': 2, '1d': 3 };
  const r2 = (x) => Math.round(x * 100) / 100;

  // src: {tf: {candles, atr (массив по свечам), sec}}
  function pivotsOf(tf, s, win) {
    const cs = s.candles, n = cs.length, out = [];
    for (let p = win; p + win < n; p++) {
      let h = true, l = true;
      for (let j = p - win; j <= p + win && (h || l); j++) {
        if (j === p) continue;
        if (j < p ? cs[j].high >= cs[p].high : cs[j].high > cs[p].high) h = false;
        if (j < p ? cs[j].low <= cs[p].low : cs[j].low < cs[p].low) l = false;
      }
      const conf = cs[p + win].time + s.sec;                       // экстремум известен, когда закрылась свеча p+win
      if (h) out.push({ price: cs[p].high, t: cs[p].time, conf, w: TFW[tf] });
      if (l) out.push({ price: cs[p].low, t: cs[p].time, conf, w: TFW[tf] });
    }
    return out;
  }

  // цена закрытия и ATR последней закрытой свечи опорного ТФ к моменту T
  function refAt(ref, T) {
    const cs = ref.candles;
    let lo = 0, hi = cs.length - 1, idx = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (cs[m].time + ref.sec <= T) { idx = m; lo = m + 1; } else hi = m - 1; }
    if (idx < 0) return null;
    const a = ref.atr[idx];
    return Number.isFinite(a) && a > 0 ? { close: cs[idx].close, atr: a } : null;
  }

  // кластеры из экстремумов piv (все с conf <= T); берём только значимые: 2+ экстремума или экстремум 4ч / 1д
  function cluster(piv, T, atr, cfg) {
    const tol = cfg.tol * atr, lim = cfg.lookDays * 86400;
    const act = piv.filter(q => T - q.t <= lim).sort((a, b) => a.price - b.price);
    const cl = [];
    for (let i = 0; i < act.length;) {
      let j = i;
      const p0 = act[i].price;
      while (j < act.length && act[j].price - p0 <= tol) j++;
      let sw = 0, sp = 0, strong = false;
      for (let k = i; k < j; k++) {
        const q = act[k], w = q.w * Math.pow(0.5, (T - q.t) / 86400 / cfg.halfDays);
        sw += w; sp += q.price * w; if (q.w >= 2) strong = true;
      }
      if (j - i >= 2 || strong) cl.push({ price: sp / sw, n: j - i, score: sw });
      i = j;
    }
    return cl;
  }

  // из кластеров выбираем у цены price: не дальше reachAtr, по max/2 самых весомых выше и ниже цены
  function pick(cl, price, atr, cfg) {
    const near = cl.filter(c => Math.abs(c.price - price) <= cfg.reachAtr * atr), half = Math.max(1, Math.ceil(cfg.max / 2));
    const top = (arr) => arr.sort((a, b) => b.score - a.score).slice(0, half);
    return top(near.filter(c => c.price >= price)).concat(top(near.filter(c => c.price < price)))
      .sort((a, b) => a.price - b.price)
      .map(c => ({ id: 'auto|' + Math.round(c.price), type: 'sr', price: r2(c.price), auto: true, n: c.n, score: r2(c.score) }));
  }

  // Модель: экстремумы и «эпохи» (набор кластеров после каждого нового подтверждённого экстремума)
  function build(src, cfgIn) {
    const cfg = Object.assign({}, DEFAULTS, cfgIn), piv = [];
    SRC.forEach(tf => { if (src[tf]) piv.push.apply(piv, pivotsOf(tf, src[tf], cfg.win)); });
    piv.sort((a, b) => a.conf - b.conf);
    const ref = src['1h'] || src['4h'] || src['1d'], epochs = [];
    if (ref) {
      for (let k = 0; k < piv.length;) {
        const T = piv[k].conf;
        while (k < piv.length && piv[k].conf === T) k++;
        const rp = refAt(ref, T);
        if (rp) epochs.push({ T, atr: rp.atr, cl: cluster(piv.slice(0, k), T, rp.atr, cfg) });
      }
    }
    return { cfg, piv, epochs, ref };
  }

  // уровни, известные к моменту T (сек), у цены price: кластеры последней эпохи с T_e <= T
  function at(model, T, price) {
    const e = model.epochs;
    let lo = 0, hi = e.length - 1, idx = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (e[m].T <= T) { idx = m; lo = m + 1; } else hi = m - 1; }
    return idx < 0 || !(price > 0) ? [] : pick(e[idx].cl, price, e[idx].atr, model.cfg);
  }

  // свежий набор у текущей цены (для графика): экстремумы, подтверждённые к моменту T
  function now(model, T, price) {
    if (!model || !model.ref || !(price > 0)) return [];
    const rp = refAt(model.ref, T);
    if (!rp) return [];
    let lo = 0, hi = model.piv.length - 1, k = 0;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (model.piv[m].conf <= T) { k = m + 1; lo = m + 1; } else hi = m - 1; }
    return pick(cluster(model.piv.slice(0, k), T, rp.atr, model.cfg), price, rp.atr, model.cfg);
  }

  return { DEFAULTS, build, at, now };
});
