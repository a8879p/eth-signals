/* Режим обучения: события (подход к линии, разворот, контроль), контекст в момент события и исход.
   Чистая логика: window.Learn в браузере, require('./learn.js') в Node (нужны core.js и diag.js рядом). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./core.js'), require('./diag.js'));
  else root.Learn = factory(root.Core, root.Diag);
})(typeof self !== 'undefined' ? self : this, function (Core, Diag) {
  'use strict';

  const TF_SEC = Diag.TF_SEC;
  const MAXBARS = Diag.MAXBARS;
  const HTF = { '15m': '1h', '30m': '1h', '1h': '4h', '4h': '1d', '6h': '1d', '1d': null };   // «старший» ТФ для каждого
  // rev/stop — разворот: ход на rev ATR раньше хода на stop ATR против; bounce/brk — подход: отбой на bounce ATR раньше пробоя на brk ATR
  const DEFAULTS = { rev: 1.5, stop: 1, win: 3, bounce: 1, brk: 0.5, prox: 0.5, horizon: 24, ctlStep: 8 };
  const r1 = (x) => Math.round(x * 10) / 10;
  const r2 = (x) => Math.round(x * 100) / 100;

  const FACTORS = [
    { key: 'ev', label: 'Тип события', buckets: [['appr', 'подход к линии'], ['pivot', 'локальный экстремум'], ['ctl', 'контроль (любая свеча)']] },
    { key: 'tf', label: 'Таймфрейм', buckets: Object.keys(Diag.TF_LABEL).map(id => [id, Diag.TF_LABEL[id]]) },
    { key: 'dir', label: 'Ожидаемый разворот', buckets: [['long', 'вверх'], ['short', 'вниз']] },
    { key: 'kz', label: 'StochRSI (в краю по ходу разворота)', buckets: [['edge', 'в самом краю (до 3)'], ['deep', 'глубоко (3–10)'], ['border', 'у границы (10–20)'], ['mid', 'не в зоне (дальше 20)']] },
    { key: 'stick', label: 'Залипание StochRSI (свечей подряд в зоне)', buckets: [['none', 'не в зоне'], ['new', '1–2 свечи'], ['mid', '3–6 свечей'], ['long', '7 и больше']] },
    { key: 'kd', label: 'K и D', buckets: [['yes', 'K уже развернулась относительно D'], ['no', 'разворота K нет']] },
    { key: 'htf', label: 'StochRSI старшего ТФ', buckets: [['edge', 'в той же зоне'], ['mid', 'в середине'], ['opp', 'в противоположной зоне']] },
    { key: 'lvl', label: 'Расстояние до ближней линии', buckets: [['at', 'у линии (до 0.5 ATR)'], ['near', 'рядом (0.5–1.5)'], ['far', 'далеко (больше 1.5)'], ['none', 'линий нет']] },
    { key: 'role', label: 'Ближняя линия относительно цены', buckets: [['sup', 'ниже цены (поддержка)'], ['res', 'выше цены (сопротивление)']] },
    { key: 'lsrc', label: 'Источник линии', buckets: [['user', 'ваша линия'], ['auto', 'автоуровень']] },
    { key: 'tests', label: 'Тесты линии раньше', buckets: [['first', 'первое касание'], ['few', '1–2 теста'], ['many', '3 и больше']] },
    { key: 'liq', label: 'Плотность рядом (только живые)', buckets: [['in', 'у зоны (до 0.5 ATR)'], ['near', 'рядом (0.5–2)'], ['far', 'далеко (больше 2)'], ['none', 'плотностей нет']] },
    { key: 'trend', label: 'Тренд ТФ (EMA50)', buckets: [['with', 'разворот по тренду'], ['against', 'против тренда'], ['flat', 'боковик']] },
    { key: 'vol', label: 'Волатильность', buckets: [['low', 'низкая'], ['norm', 'обычная'], ['high', 'высокая']] },
    { key: 'volu', label: 'Объём свечи', buckets: [['vlow', 'малый (< 0.7 от среднего)'], ['vnorm', 'обычный'], ['vhigh', 'большой (> 1.5)']] },
    { key: 'candle', label: 'Форма свечи', buckets: [['pin', 'длинная тень против хода'], ['engulf', 'поглощение'], ['with', 'в сторону разворота'], ['against', 'против разворота']] },
    { key: 'hour', label: 'Время (UTC)', buckets: [['asia', '00–08'], ['eu', '08–14'], ['us', '14–21'], ['late', '21–24']] },
    { key: 'dow', label: 'День недели', buckets: [['wd', 'будни'], ['we', 'выходные']] }
  ];

  const RULES_TEXT = 'Каждая запись — событие на закрытой свече. ev: appr — начало подхода цены к линии пользователя (в пределах prox ATR), entry = цена линии; ' +
    'pivot — локальный экстремум среди ±win свечей, entry = закрытие; ctl — контрольная свеча (каждая ctlStep-я), записаны обе стороны. ' +
    'dir: long — ожидаем разворот вверх, short — вниз. path[j] = [лучший ход в сторону dir, худший против, закрытие] на свече j+1 после события, в ATR. ' +
    'Исход (outcome.state): win — ход в сторону dir на tgt ATR раньше хода против на stp ATR (обе цели в одной свече — засчитан stop), loss — наоборот, ' +
    'timeout — ни то ни другое за horizon свечей, open — свечей ещё не хватает. Признаки f посчитаны только по данным до события, ' +
    'но набор pivot отобран по будущим ±win свечам: он описывает развороты, а не предсказывает их, для предсказания сравнивайте с ctl. ' +
    'src: hist — по загруженной истории (ваши линии расставлены задним числом, плотностей нет), live — события после включения сбора (с плотностями). ' +
    'f.lsrc: user — ваша линия, auto — автоуровень, посчитанный только по данным до события (в hist это честнее ваших линий).';

  // ---------- признаки ----------
  function medianAt(arr, i, w) {
    const v = [];
    for (let j = Math.max(0, i - w + 1); j <= i; j++) if (Number.isFinite(arr[j])) v.push(arr[j]);
    if (v.length < 20) return NaN;
    v.sort((x, y) => x - y);
    return v[v.length >> 1];
  }
  function touchEpisodes(candles, i, L, prox) {
    let n = 0, inside = false;
    for (let j = Math.max(0, i - 200); j <= i - 3; j++) {
      const t = candles[j].low <= L + prox && candles[j].high >= L - prox;
      if (t && !inside) n++;
      inside = t;
    }
    return n;
  }
  // K старшего ТФ на последней ЗАКРЫТОЙ к моменту tNow свече (без заглядывания вперёд)
  function htfK(h, tNow) {
    const cs = h.cs;
    let lo = 0, hi = cs.length - 1, idx = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (cs[m].time + h.sec <= tNow) { idx = m; lo = m + 1; } else hi = m - 1; }
    return idx < 0 ? NaN : h.ind.k[idx];
  }

  function feats(tf, candles, ind, i, dir, b) {
    const long = dir === 'long', c = candles[i], a = ind.atr[i], k = ind.k[i], d = ind.d[i];
    if (!(a > 0) || !Number.isFinite(k)) return null;
    const f = { tf, dir };
    const e = long ? k : 100 - k;
    f.kz = e <= 3 ? 'edge' : e <= 10 ? 'deep' : e <= 20 ? 'border' : 'mid';
    let run = 0;                                                    // залипание: свечей подряд K в крайней зоне (20 / 80) по ходу разворота
    for (let j = i; j >= 0; j--) { const v = ind.k[j]; if (Number.isFinite(v) && (long ? v <= 20 : v >= 80)) run++; else break; }
    f.stick = run === 0 ? 'none' : run <= 2 ? 'new' : run <= 6 ? 'mid' : 'long';
    if (Number.isFinite(d)) f.kd = (long ? k > d : k < d) ? 'yes' : 'no';
    if (b.htf) {
      const hk = htfK(b.htf, c.time + (TF_SEC[tf] || 0));
      if (Number.isFinite(hk)) { const x = long ? hk : 100 - hk; f.htf = x <= 30 ? 'edge' : x >= 70 ? 'opp' : 'mid'; }
    }
    let best = null;
    for (const l of (b.pin ? [b.pin] : b.levels)) { const dist = Math.abs(c.close - l.price); if (!best || dist < best.dist) best = { l, dist }; }
    if (best) {
      const x = best.dist / a;
      f.lvl = x <= 0.5 ? 'at' : x <= 1.5 ? 'near' : 'far';
      f.role = c.close >= best.l.price ? 'sup' : 'res';
      f.lsrc = best.l.auto ? 'auto' : 'user';
      if (x <= 1.5) { const t = touchEpisodes(candles, i, best.l.price, b.prox * a); f.tests = t === 0 ? 'first' : t <= 2 ? 'few' : 'many'; }
    } else f.lvl = 'none';
    if (b.liqs) {
      let bd = Infinity;
      for (const l of b.liqs) { const z = Core.zoneOf(l); bd = Math.min(bd, c.close < z.lo ? z.lo - c.close : c.close > z.hi ? c.close - z.hi : 0); }
      f.liq = !b.liqs.length ? 'none' : bd / a <= 0.5 ? 'in' : bd / a <= 2 ? 'near' : 'far';
    }
    if (b.ctx && b.ctx.ema && i >= 10) {
      const e0 = b.ctx.ema[i], e1 = b.ctx.ema[i - 10];
      if (Number.isFinite(e0) && Number.isFinite(e1)) { const s = (e0 - e1) / a; f.trend = Math.abs(s) < 0.3 ? 'flat' : ((s > 0) === long ? 'with' : 'against'); }
    }
    const med = medianAt(ind.atr, i, 100);
    if (Number.isFinite(med) && med > 0) { const q = a / med; f.vol = q < 0.8 ? 'low' : q <= 1.25 ? 'norm' : 'high'; }
    if (c.vol > 0 && i >= 20) {
      let s = 0, m = 0;
      for (let j = i - 20; j < i; j++) if (candles[j].vol > 0) { s += candles[j].vol; m++; }
      if (m >= 10) { const q = c.vol / (s / m); f.volu = q < 0.7 ? 'vlow' : q <= 1.5 ? 'vnorm' : 'vhigh'; }
    }
    const rng = c.high - c.low;
    if (rng > 0 && i > 0) {
      const p0 = candles[i - 1];
      const wick = long ? Math.min(c.open, c.close) - c.low : c.high - Math.max(c.open, c.close);
      const eng = long ? (c.close > c.open && p0.close < p0.open && c.close >= p0.open && c.open <= p0.close)
                       : (c.close < c.open && p0.close > p0.open && c.close <= p0.open && c.open >= p0.close);
      f.candle = wick / rng >= 0.5 ? 'pin' : eng ? 'engulf' : ((long ? c.close > c.open : c.close < c.open) ? 'with' : 'against');
    }
    const dt = new Date(c.time * 1000);
    if (tf !== '1d') { const h = dt.getUTCHours(); f.hour = h < 8 ? 'asia' : h < 14 ? 'eu' : h < 21 ? 'us' : 'late'; }
    f.dow = (dt.getUTCDay() === 0 || dt.getUTCDay() === 6) ? 'we' : 'wd';
    return f;
  }

  // ---------- сбор событий ----------
  // o: {src:'hist'|'live', since (сек: события не раньше этой свечи), htf:{cs,ind,sec}, liqs:[плотности для живых данных],
  //     levelsAt(tСек, цена): автоуровни, известные к моменту t (из auto.js); они добавляются к линиям пользователя}
  function collect(tf, candles, ind, levels, cfgIn, o) {
    o = o || {};
    const cfg = Object.assign({}, DEFAULTS, cfgIn), out = [];
    const n = candles.length;
    if (n < 80) return out;
    const last = candles[n - 1].closed === false ? n - 2 : n - 1;       // только закрытые свечи
    const sec = TF_SEC[tf], warm = 60, w = Math.max(1, cfg.win), since = o.since || 0, src = o.src || 'hist';
    const sr = levels.filter(l => l.type === 'sr');
    const base = { ctx: Diag.prepare(candles), levels: sr, liqs: o.liqs || null, htf: o.htf || null, prox: cfg.prox };
    const autoAt = (i) => o.levelsAt ? o.levelsAt(candles[i].time + sec, candles[i].close) : [];

    const add = (ev, dir, i, entry, tgt, stp, lvl) => {
      const f = feats(tf, candles, ind, i, dir, Object.assign({}, base, { levels: sr.concat(autoAt(i)), pin: lvl }));
      if (!f) return;
      f.ev = ev;
      const a = ind.atr[i], pf = Diag.pathFrom(candles, i, dir, entry, a, MAXBARS);
      out.push({
        id: ['L', src, tf, ev, dir, lvl ? lvl.id : '', candles[i].time].join('|'),
        src, t: (candles[i].time + sec) * 1000, tf, dir, trig: ev,
        levelId: lvl ? lvl.id : '', levelPrice: lvl ? lvl.price : r2(candles[i].close),
        entry: r2(entry), atr: r2(a), k: r1(ind.k[i]), candleTime: candles[i].time,
        f, path: pf.path, closed: pf.closed, tgt, stp
      });
    };

    // 1) подходы к линиям (ваши и автоуровни): первая свеча, зашедшая в зону близости; цена пришла сверху (поддержка) или снизу (сопротивление)
    const lastEv = new Map();
    const inZ = (L, j) => { const a = ind.atr[j]; return Number.isFinite(a) && candles[j].low <= L + cfg.prox * a && candles[j].high >= L - cfg.prox * a; };
    const tryAppr = (l, i) => {
      const L = l.price, from = Math.max(since, l.t || 0);       // у живых линий l.t — когда линию впервые увидели (задним числом событий не бывает)
      const prev = lastEv.has(l.id) ? lastEv.get(l.id) : -99;
      if (candles[i].time < from || !inZ(L, i) || inZ(L, i - 1) || i - prev < 4) return;
      const a = ind.atr[i], c = candles[i], above = candles[i - 1].close >= L;
      // свеча уже закрылась за линией или проколола её глубже порога пробоя: это не подход
      if (above ? (c.close < L || c.low < L - cfg.brk * a) : (c.close > L || c.high > L + cfg.brk * a)) return;
      lastEv.set(l.id, i);
      add('appr', above ? 'long' : 'short', i, L, cfg.bounce, cfg.brk, l);
    };
    for (let i = warm; i <= last; i++) {
      sr.forEach(l => tryAppr(l, i));
      if (o.levelsAt) autoAt(i).forEach(l => { const a = ind.atr[i]; if (!sr.some(u => Math.abs(u.price - l.price) <= 0.3 * a)) tryAppr(l, i); });   // автоуровень рядом с вашей линией не дублируем
    }
    // 2) локальные экстремумы: максимум / минимум среди ±win свечей (нужно win закрытых свечей после)
    for (let p = Math.max(warm, w); p + w <= last; p++) {
      if (candles[p].time < since) continue;
      let isH = true, isL = true;
      for (let j = p - w; j <= p + w; j++) {
        if (j === p) continue;
        const left = j < p;
        if (left ? candles[j].high >= candles[p].high : candles[j].high > candles[p].high) isH = false;
        if (left ? candles[j].low <= candles[p].low : candles[j].low < candles[p].low) isL = false;
      }
      if (isH) add('pivot', 'short', p, candles[p].close, cfg.rev, cfg.stop, null);
      if (isL) add('pivot', 'long', p, candles[p].close, cfg.rev, cfg.stop, null);
    }
    // 3) контроль: каждая ctlStep-я свеча, обе стороны
    for (let i = warm; i <= last; i++) {
      if (candles[i].time < since || Math.round(candles[i].time / sec) % Math.max(1, cfg.ctlStep) !== 0) continue;
      add('ctl', 'long', i, candles[i].close, cfg.rev, cfg.stop, null);
      add('ctl', 'short', i, candles[i].close, cfg.rev, cfg.stop, null);
    }
    return out;
  }

  // ---------- сводка и выгрузка ----------
  function summarize(records, cfgIn) { return Diag.summarize(records, Object.assign({ target: 1, stop: 1 }, cfgIn), FACTORS); }

  // Что чаще бывает в момент разворота (pivot), чем на случайной свече (ctl): доли по группам и z-тест для двух долей
  function freq(records) {
    const A = records.filter(r => r.trig === 'pivot'), B = records.filter(r => r.trig === 'ctl'), rows = [];
    for (const F of FACTORS) {
      if (F.key === 'ev') continue;
      const a = A.filter(r => r.f && r.f[F.key] != null), b = B.filter(r => r.f && r.f[F.key] != null);
      if (a.length < 20 || b.length < 20) continue;
      for (const [id, label] of F.buckets) {
        const ka = a.filter(r => r.f[F.key] === id).length, kb = b.filter(r => r.f[F.key] === id).length;
        if (ka + kb < 20) continue;
        const pa = ka / a.length, pb = kb / b.length, p = (ka + kb) / (a.length + b.length);
        const se = Math.sqrt(p * (1 - p) * (1 / a.length + 1 / b.length)), z = se > 0 ? (pa - pb) / se : 0, d = Math.abs(pa - pb);
        const v = Math.abs(z) >= 2.58 && d >= 0.05 ? (z > 0 ? 'more' : 'less') : Math.abs(z) >= 1.96 && d >= 0.03 ? (z > 0 ? 'maybeMore' : 'maybeLess') : 'none';
        rows.push({ key: F.key, factor: F.label, id, label, ka, kb, na: a.length, nb: b.length, pa, pb, z, v });
      }
    }
    return rows.sort((x, y) => Math.abs(y.z) - Math.abs(x.z));
  }

  // Короткая текстовая сводка для вставки в чат с ИИ
  function digest(records, cfg) {
    const L = [], pc = (x) => x == null ? '—' : Math.round(x * 100) + '%', cf = Object.assign({ minN: 15 }, cfg);
    for (const src of ['hist', 'live']) {
      const rs = records.filter(r => r.src === src);
      if (!rs.length) continue;
      L.push('=== ' + (src === 'hist' ? 'ИСТОРИЯ (линии расставлены задним числом, плотностей нет)' : 'ЖИВЫЕ (после включения сбора)') + ' ===');
      for (const ev of ['appr', 'pivot', 'ctl']) {
        const rr = rs.filter(r => r.trig === ev);
        if (!rr.length) continue;
        const sm = summarize(rr, cf), o = sm.overall, G = sm.groups;
        L.push('[' + ev + '] записей ' + rr.length + ', завершено ' + o.decided + ', win ' + pc(o.wr) + (o.ci ? ' (95%: ' + pc(o.ci[0]) + '–' + pc(o.ci[1]) + ')' : '') + ', безубыточность ' + pc(sm.be));
        const line = (b, t) => '  ' + t + ' ' + b.factor + ': ' + b.label + ' — n=' + b.s.decided + ', win ' + pc(b.s.wr) + ' против остальных ' + pc(b.rest.wr) + ' (z ' + b.z.toFixed(1) + ')';
        G.good.concat(G.maybeGood).slice(0, 8).forEach(b => L.push(line(b, '+')));
        G.bad.concat(G.maybeBad).slice(0, 8).forEach(b => L.push(line(b, '−')));
      }
      const sig = freq(rs).filter(b => b.v !== 'none').slice(0, 15);
      if (sig.length) {
        L.push('[Условия в момент разворота (pivot) против случайной свечи (ctl)]');
        sig.forEach(b => L.push('  ' + b.factor + ': ' + b.label + ' — у разворотов ' + pc(b.pa) + ' (' + b.ka + '), в контроле ' + pc(b.pb) + ' (' + b.kb + ')' + (b.v.indexOf('maybe') === 0 ? ' [слабо]' : '')));
      }
    }
    return L.join('\n');
  }

  // JSON без путей цены (компактно); o.withPath — добавить пути, чтобы пересчитать исходы другими параметрами
  function exportJson(o) {
    const cfg = Object.assign({ target: 1, stop: 1 }, o.cfg);
    return {
      v: 1, kind: 'eth-learn', symbol: 'ETHUSDT', exported: new Date().toISOString(), cfg, rules: RULES_TEXT,
      levels: o.levels.filter(l => l.type === 'sr').map(l => ({ price: l.price })),
      liqs: o.levels.filter(l => l.type === 'liq').map(l => { const z = Core.zoneOf(l); return { lo: z.lo, hi: z.hi, side: l.side, since: l.t || null, takenAt: l.takenAt || null }; }),
      factors: FACTORS.map(f => ({ key: f.key, label: f.label, values: Object.fromEntries(f.buckets) })),
      digest: digest(o.records, cfg),
      records: o.records.map(r => {
        const oc = Diag.outcome(r, cfg);
        const x = { src: r.src, time: new Date(r.t).toISOString(), tf: r.tf, ev: r.trig, dir: r.dir, level: r.levelPrice, entry: r.entry, atr: r.atr, k: r.k, tgt: r.tgt, stp: r.stp, f: r.f, out: oc.state, r: oc.r == null ? null : r2(oc.r), bars: oc.bars, mfe: r2(oc.mfe), mae: r2(oc.mae) };
        if (o.withPath) x.path = r.path;
        return x;
      })
    };
  }

  function toCsv(records, cfg) {
    const c0 = Object.assign({ target: 1, stop: 1 }, cfg);
    const cols = ['source', 'time_utc', 'tf', 'event', 'dir', 'level', 'entry', 'atr', 'stoch_k', 'target_atr', 'stop_atr'].concat(FACTORS.map(F => 'f_' + F.key), ['outcome', 'R', 'bars', 'mfe_atr', 'mae_atr', 'ambiguous']);
    const lines = [cols.join(',')];
    for (const r of records) {
      const oc = Diag.outcome(r, c0);
      lines.push([r.src, new Date(r.t).toISOString(), r.tf, r.trig, r.dir, r.levelPrice, r.entry, r.atr, r.k, r.tgt, r.stp]
        .concat(FACTORS.map(F => (r.f && r.f[F.key] != null ? r.f[F.key] : '')))
        .concat([oc.state, oc.r == null ? '' : r2(oc.r), oc.bars, r2(oc.mfe), r2(oc.mae), oc.ambiguous ? 1 : 0]).join(','));
    }
    return lines.join('\n');
  }

  // Готовый текст для вставки в чат с ИИ: задача + сводка
  function prompt(o) {
    return 'Ниже сводка режима обучения приложения «ETH Сигналы» (ETHUSDT): события разворотов и подходов цены к линиям пользователя, условия на момент события и исход. ' +
      'Записей: ' + o.n + ' (история ' + o.nHist + ', живые ' + o.nLive + ').\n\n' +
      'Правила: ' + RULES_TEXT + '\n' +
      'Значения признаков: ' + FACTORS.map(f => f.key + ' = ' + f.label + ' (' + f.buckets.map(b => b[0] + ': ' + b[1]).join('; ') + ')').join(' | ') + '\n\n' +
      o.digest + '\n\n' +
      'Задачи:\n' +
      '1. Какие условия чаще бывают в момент разворота, чем на случайной свече, и какие из них держатся и в истории, и на живых данных.\n' +
      '2. При каких условиях отбой от линии (appr) чаще побеждает пробой, а при каких растёт шанс пробоя.\n' +
      '3. История и живые данные отдельно: в истории линии расставлены задним числом, результат завышен; проверь, повторяются ли выводы на живых.\n' +
      '4. Что нельзя утверждать: мало данных, зависимые записи (соседние свечи и разные ТФ дают коррелированные события), множественные сравнения.\n\n' +
      'Ответ: короткий список правил «если …, то …» с числом событий и долей win, отдельно что не подтвердилось. Без обещаний прибыли. Если нужны полные записи, скажи, какой срез выгрузить.';
  }

  // Условия на свече i для заданного направления (для журнала сделок): те же признаки, что у событий «Обучения».
  // o: {levels:[{price, auto?}], liqs, htf, prox}
  function featuresAt(tf, candles, ind, i, dir, o) {
    o = o || {};
    const b = { ctx: Diag.prepare(candles), levels: o.levels || [], liqs: o.liqs || null, htf: o.htf || null, prox: o.prox || 0.5 };
    return feats(tf, candles, ind, i, dir, b);
  }

  return { DEFAULTS, FACTORS, HTF, RULES_TEXT, collect, featuresAt, summarize, freq, digest, exportJson, toCsv, prompt };
});
