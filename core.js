/* Чистая логика: индикаторы и сигналы. Работает и в браузере (window.Core), и в Node (require). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Core = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULTS = {
    rsiLen: 14,
    stochLen: 14,
    kLen: 3,
    dLen: 3,
    atrLen: 14,
    overbought: 80,
    oversold: 20,
    proxAtr: 0.5,     // «близость» к уровню, в ATR
    depthAtr: 1.0,    // максимальная глубина выноса плотности, в ATR
    guardAtr: 2.0,    // плотность за уровнем в пределах N ATR гасит сигнал от уровня
    sweepWindow: 6,   // за сколько свечей ищем вынос плотности
    magOn: true,      // сигнал «к плотности»: цена тянется забрать ликвидность и цель — ближний край зоны
    magMax: 3,        // не дальше N ATR до ближнего края плотности (ближе proxAtr — только предупреждение)
    magStop: 1,       // стоп для такого сигнала, в ATR против входа
    magFar: 30,       // если StochRSI уже в крайней зоне по ходу сделки (шорт: K ≥ overbought), плотность может быть дальше: до N ATR
    guardEnter: true, // плотность за уровнем: не ждать возврата, а давать сигнал с лимиткой у её ближнего края (иначе только предупреждение)
    evalMode: 'live'  // 'live' | 'close'
  };

  // ---------- индикаторы ----------

  // RSI по Уайлдеру (как ta.rsi в TradingView)
  function rsi(closes, len) {
    const n = closes.length;
    const out = new Array(n).fill(NaN);
    if (n <= len) return out;
    let g = 0, l = 0;
    for (let i = 1; i <= len; i++) {
      const ch = closes[i] - closes[i - 1];
      if (ch >= 0) g += ch; else l -= ch;
    }
    let avgG = g / len, avgL = l / len;
    out[len] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
    for (let i = len + 1; i < n; i++) {
      const ch = closes[i] - closes[i - 1];
      avgG = (avgG * (len - 1) + (ch > 0 ? ch : 0)) / len;
      avgL = (avgL * (len - 1) + (ch < 0 ? -ch : 0)) / len;
      out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
    }
    return out;
  }

  // Простая скользящая; значение есть, только если все len значений окна конечны
  function sma(arr, len) {
    const n = arr.length;
    const out = new Array(n).fill(NaN);
    for (let i = len - 1; i < n; i++) {
      let s = 0, ok = true;
      for (let j = i - len + 1; j <= i; j++) {
        const v = arr[j];
        if (!Number.isFinite(v)) { ok = false; break; }
        s += v;
      }
      if (ok) out[i] = s / len;
    }
    return out;
  }

  // StochRSI: %K и %D (по умолчанию 14, 14, 3, 3 — как в TradingView)
  function stochRsi(closes, o) {
    o = Object.assign({}, DEFAULTS, o);
    const r = rsi(closes, o.rsiLen);
    const n = r.length;
    const st = new Array(n).fill(NaN);
    for (let i = o.stochLen - 1; i < n; i++) {
      let hi = -Infinity, lo = Infinity, ok = true;
      for (let j = i - o.stochLen + 1; j <= i; j++) {
        const v = r[j];
        if (!Number.isFinite(v)) { ok = false; break; }
        if (v > hi) hi = v;
        if (v < lo) lo = v;
      }
      if (!ok) continue;
      st[i] = hi === lo ? 50 : (100 * (r[i] - lo)) / (hi - lo);
    }
    const k = sma(st, o.kLen);
    const d = sma(k, o.dLen);
    return { rsi: r, k, d };
  }

  // ATR по Уайлдеру
  function atr(candles, len) {
    const n = candles.length;
    const out = new Array(n).fill(NaN);
    if (n < len) return out;
    const tr = new Array(n);
    for (let i = 0; i < n; i++) {
      const c = candles[i];
      tr[i] = i === 0
        ? c.high - c.low
        : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close));
    }
    let s = 0;
    for (let i = 0; i < len; i++) s += tr[i];
    out[len - 1] = s / len;
    for (let i = len; i < n; i++) out[i] = (out[i - 1] * (len - 1) + tr[i]) / len;
    return out;
  }

  function compute(candles, cfg) {
    const c = Object.assign({}, DEFAULTS, cfg);
    const closes = candles.map(x => x.close);
    const s = stochRsi(closes, c);
    return { k: s.k, d: s.d, rsi: s.rsi, atr: atr(candles, c.atrLen) };
  }

  // ---------- сигналы ----------

  function evalIndex(candles, mode) {
    const n = candles.length;
    if (n === 0) return -1;
    if (mode === 'close') return candles[n - 1].closed ? n - 1 : n - 2;
    return n - 1;
  }

  function stochFlags(ind, i, cfg) {
    const k = ind.k[i], d = ind.d[i];
    let minK = Infinity, maxK = -Infinity;
    for (let j = Math.max(0, i - 2); j <= i; j++) {
      const v = ind.k[j];
      if (Number.isFinite(v)) { if (v < minK) minK = v; if (v > maxK) maxK = v; }
    }
    return {
      longStrict: k <= cfg.oversold,
      shortStrict: k >= cfg.overbought,
      // «или разворачивается»: в последних 3 свечах был экстремум и K уже развернулась относительно D
      longTurn: k <= cfg.oversold || (minK <= cfg.oversold && k > d),
      shortTurn: k >= cfg.overbought || (maxK >= cfg.overbought && k < d)
    };
  }

  const TF_SEC = { '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '6h': 21600, '1d': 86400 };
  const fmt = (x) => (Math.round(x * 100) / 100).toLocaleString('en-US');

  // Диапазон плотности: price — нижняя граница, price2 (необязательно) — верхняя.
  // Без price2 плотность — обычная линия (ширина 0).
  function zoneOf(l) {
    const a = l.price;
    const b = Number.isFinite(l.price2) ? l.price2 : a;
    return { lo: Math.min(a, b), hi: Math.max(a, b) };
  }
  const fmtZone = (z) => z.hi > z.lo ? fmt(z.lo) + '–' + fmt(z.hi) : fmt(z.lo);

  // Возвращает список сигналов/предупреждений для одного таймфрейма
  // sig: {tf, kind:'signal'|'warn', dir:'long'|'short'|null, levelId, levelType, levelPrice, price, k, text, stateKey, once, candleTime}
  function evaluate(tf, candles, ind, levels, cfgIn) {
    const cfg = Object.assign({}, DEFAULTS, cfgIn);
    const i = evalIndex(candles, cfg.evalMode);
    const res = [];
    if (i < 1) return res;
    const p = candles[i].close;
    const a = ind.atr[i];
    const k = ind.k[i];
    if (!Number.isFinite(a) || !Number.isFinite(k) || !Number.isFinite(ind.d[i])) return res;
    const prox = cfg.proxAtr * a;
    const sf = stochFlags(ind, i, cfg);
    const candleTime = candles[i].time;
    // Снятая плотность (цена дошла до дальнего края) в защите уровней не участвует
    const liqs = levels.filter(l => l.type === 'liq' && !l.takenAt);
    // План сделки. Выход: подход к ближайшей линии противоположной роли (лонг — к сопротивлению сверху, шорт — к поддержке снизу).
    // Стоп есть только у шорта: за дальним краем ближайшей плотности сверху (+0.1 ATR), без плотности — magStop ATR.
    const nearestOpp = (dir) => {
      let best = null;
      for (const l of levels) {
        if (dir === 'long' ? (l.type === 'resistance' && l.price > p) : (l.type === 'support' && l.price < p)) {
          if (best === null || (dir === 'long' ? l.price < best : l.price > best)) best = l.price;
        }
      }
      return best;
    };
    const stopAbove = () => {
      let z0 = null;
      for (const c of liqs) { if (c.side !== 'above') continue; const z = zoneOf(c); if (z.hi > p && (z0 === null || z.lo < z0.lo)) z0 = z; }
      return z0 ? z0.hi + 0.1 * a : p + cfg.magStop * a;
    };

    const base = (lvl, extra) => Object.assign({
      tf, levelId: lvl.id, levelType: lvl.type, levelPrice: lvl.price, price: p, k, candleTime
    }, extra);

    for (const lvl of levels) {
      const L = lvl.price;
      if (lvl.type === 'support' || lvl.type === 'resistance') {
        const isSup = lvl.type === 'support';
        if (Math.abs(p - L) > prox) continue;
        if (isSup ? !sf.longStrict : !sf.shortStrict) continue;
        const dir = isSup ? 'long' : 'short';
        // Плотность за уровнем (под поддержкой / над сопротивлением), которую ещё не вынесли
        // Для диапазона: зона ещё не вынесена, пока цена не вышла за её дальний край;
        // расстояние до уровня считается до ближнего края зоны.
        const guard = liqs.find(c => {
          const z = zoneOf(c);
          return isSup
            ? (c.side === 'below' && z.lo < L && p > z.lo && Math.max(0, L - z.hi) <= cfg.guardAtr * a)
            : (c.side === 'above' && z.hi > L && p < z.hi && Math.max(0, z.lo - L) <= cfg.guardAtr * a);
        });
        if (guard && !cfg.guardEnter) {
          res.push(base(lvl, {
            kind: 'warn', dir: null,
            text: (isSup ? 'Поддержка ' : 'Сопротивление ') + fmt(L) + ' в экстремуме StochRSI, но ' +
              (isSup ? 'ниже' : 'выше') + ' плотность ' + fmtZone(zoneOf(guard)) + ': возможен вынос, ждём возврат',
            stateKey: [tf, lvl.id, 'guard'].join('|'), once: false
          }));
        } else if (guard) {
          // Не ждём выноса и возврата: сигнал сразу. Лучший вход — лимитка у ближнего края плотности (если её вынесут), не зацепило — по рынку.
          const gz = zoneOf(guard), gnear = isSup ? gz.hi : gz.lo;
          res.push(base(lvl, {
            kind: 'signal', dir, sub: 'guard',
            text: (isSup ? 'ЛОНГ у поддержки ' : 'ШОРТ у сопротивления ') + fmt(L) + ', StochRSI ' + k.toFixed(1) + '. ' + (isSup ? 'Ниже' : 'Выше') + ' плотность ' + fmtZone(gz) +
              ': лимитка ' + (isSup ? 'на лонг' : 'на шорт') + ' у ' + fmt(gnear) + ', не зацепит — вход по рынку',
            stateKey: [tf, lvl.id, dir].join('|'), once: false,
            distAtr: Math.abs(p - L) / a, limitPrice: gnear,
            exitPrice: nearestOpp(dir), stopPrice: dir === 'short' ? stopAbove() : null
          }));
        } else {
          res.push(base(lvl, {
            kind: 'signal', dir,
            text: (isSup ? 'ЛОНГ у поддержки ' : 'ШОРТ у сопротивления ') + fmt(L) + ', StochRSI ' + k.toFixed(1),
            stateKey: [tf, lvl.id, dir].join('|'), once: false,
            distAtr: Math.abs(p - L) / a,      // для диагностики: расстояние до уровня в ATR
            exitPrice: nearestOpp(dir), stopPrice: dir === 'short' ? stopAbove() : null
          }));
        }
      } else if (lvl.type === 'liq') {
        // Снятая плотность живёт в расчётах только пока идёт окно выноса (нужно для сигнала «вынос и возврат»), потом исчезает
        if (lvl.takenAt && candles[i].time >= lvl.takenAt + cfg.sweepWindow * (TF_SEC[tf] || 3600)) continue;
        const above = lvl.side === 'above';
        const dir = above ? 'short' : 'long';
        // Диапазон плотности: ближний край — к нему цена подходит первой,
        // дальний край — плотность считается вынесенной, когда цена вышла за него.
        // Для плотности без ширины оба края совпадают с L.
        const z = zoneOf(lvl);
        const wide = z.hi > z.lo;
        const near = above ? z.lo : z.hi;
        const far = above ? z.hi : z.lo;
        const zt = fmtZone(z);
        // Вынос: первая свеча в окне, зашедшая за дальний край
        const breach = (j) => above ? candles[j].high > far : candles[j].low < far;
        let j0 = -1;
        for (let j = Math.max(0, i - cfg.sweepWindow + 1); j <= i; j++) {
          if (breach(j)) { j0 = j; break; }
        }
        // Начало выноса не должно «ехать» вправо, когда первая свеча выходит из окна: тянем его назад по подряд идущим свечам за краем
        // (иначе ключ сигнала меняется и тот же вынос срабатывает второй раз)
        if (j0 > 0) { const lim = Math.max(0, i - 3 * cfg.sweepWindow); while (j0 > lim && breach(j0 - 1)) j0--; }
        if (j0 < 0) {
          if (wide && (above ? p >= near : p <= near)) {
            // Цена уже внутри зоны, но ещё не прошла её насквозь
            res.push(base(lvl, {
              kind: 'warn', dir: null,
              text: 'Цена внутри плотности ' + zt + (above ? ' (шорты)' : ' (лонги)') + ': идёт набор, вынос ещё не завершён, не входить',
              stateKey: [tf, lvl.id, 'inside'].join('|'), once: false
            }));
            continue;
          }
          // Подход: цена ещё по свою сторону и близко к ближнему краю
          const dist = above ? near - p : p - near;
          // StochRSI уже в крайней зоне по ходу сделки (шорт к плотности вниз при K ≥ overbought, лонг вверх при K ≤ oversold): сигнал можно давать издалека
          const extK = above ? k <= cfg.oversold : k >= cfg.overbought;
          if (dist >= 0 && dist <= prox) {
            res.push(base(lvl, {
              kind: 'warn', dir: null,
              text: 'Подход к плотности ' + zt + (above ? ' (шорты)' : ' (лонги)') + ': возможен вынос, не входить на касании',
              stateKey: [tf, lvl.id, 'approach'].join('|'), once: false
            }));
          } else if (cfg.magOn && dist > prox && dist <= (extK ? Math.max(cfg.magMax, cfg.magFar) : cfg.magMax) * a) {
            // «Магнит»: до плотности ещё есть расстояние. Плотность выше цены (стопы шортов) тянет цену вверх, значит ЛОНГ;
            // плотность ниже (стопы лонгов) тянет вниз, значит ШОРТ. Цель — ближний край зоны. Не входим, если StochRSI уже в крайней зоне по ходу сделки.
            const mdir = above ? 'long' : 'short';
            // Ближняя плотность на пути ещё не снята: цена сначала дойдёт до неё, поэтому сигнал к дальней не даём
            const blocked = liqs.some(o => {
              if (o === lvl || o.side !== lvl.side) return false;
              const oz = zoneOf(o);
              return above ? (oz.lo < near && oz.hi > p) : (oz.hi > near && oz.lo < p);
            });
            if (!blocked && (mdir === 'long' ? k < cfg.overbought : k > cfg.oversold)) {      // не входим, если K уже в крайней зоне по ходу сделки (шорт: K ≤ oversold, лонг: K ≥ overbought)
              const stopP = p + cfg.magStop * a;      // стоп только у шорта
              const tAtr = dist / a;
              res.push(base(lvl, {
                kind: 'signal', dir: mdir, sub: 'mag',
                text: (mdir === 'long' ? 'ЛОНГ' : 'ШОРТ') + ' к плотности ' + zt + (above ? ' ▲' : ' ▼') + ': цель ' + fmt(near) + ' (' + tAtr.toFixed(1) + ' ATR' + (tAtr > cfg.magMax ? ', далеко: StochRSI в экстремуме' : '') + '), ' + (mdir === 'long' ? 'без стопа' : 'стоп ' + fmt(stopP) + ' (' + cfg.magStop + ' ATR)') + ', StochRSI ' + k.toFixed(1),
                stateKey: [tf, lvl.id, 'mag', mdir].join('|'), once: false,
                target: near, exitPrice: near, stopPrice: mdir === 'short' ? stopP : null, targetAtr: tAtr, stopAtr: cfg.magStop,
                zoneAtr: (z.hi - z.lo) / a
              }));
            }
          }
          continue;
        }
        let extreme = above ? -Infinity : Infinity;
        for (let j = j0; j <= i; j++) {
          extreme = above ? Math.max(extreme, candles[j].high) : Math.min(extreme, candles[j].low);
        }
        const depth = above ? extreme - far : far - extreme;
        if (depth > cfg.depthAtr * a) continue; // глубже лимита — это пробой, не вынос
        const back = above ? p < far : p > far;
        const depthTxt = (depth / a).toFixed(2) + ' ATR';
        if (!back) {
          res.push(base(lvl, {
            kind: 'warn', dir: null,
            text: 'Идёт вынос плотности ' + zt + ' (' + depthTxt + '): ждём возврат ' + (above ? 'ниже' : 'выше') + (wide ? ' зоны' : ' уровня'),
            stateKey: [tf, lvl.id, 'sweeping'].join('|'), once: false
          }));
        } else if (above ? sf.shortTurn : sf.longTurn) {
          res.push(base(lvl, {
            kind: 'signal', dir,
            text: (above ? 'ШОРТ: вынос шортов выше ' : 'ЛОНГ: вынос лонгов ниже ') + zt + ' (' + depthTxt + ') и возврат, StochRSI ' + k.toFixed(1),
            stateKey: [tf, lvl.id, dir, 'ep' + candles[j0].time].join('|'), once: true,
            depthAtr: depth / a, zoneAtr: (z.hi - z.lo) / a,   // для диагностики: глубина выноса и ширина зоны в ATR
            exitPrice: nearestOpp(dir), stopPrice: dir === 'short' ? extreme + 0.1 * a : null
          }));
        }
      }
    }
    return res;
  }

  // Какие сигналы новые. state = {active:Set, firedCandle:Map, firedEver:Set}
  function diffSignals(state, current) {
    const fresh = [];
    const nextActive = new Set();
    for (const s of current) {
      nextActive.add(s.stateKey);
      if (s.kind !== 'signal') continue;
      let isNew;
      if (s.once) isNew = !state.firedEver.has(s.stateKey);
      else isNew = !state.active.has(s.stateKey) && state.firedCandle.get(s.stateKey) !== s.candleTime;
      if (isNew) {
        fresh.push(s);
        state.firedEver.add(s.stateKey);
        state.firedCandle.set(s.stateKey, s.candleTime);
      }
    }
    state.active = nextActive;
    return fresh;
  }

  return { DEFAULTS, rsi, sma, stochRsi, atr, compute, evalIndex, stochFlags, evaluate, diffSignals, zoneOf };
});
