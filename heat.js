/* Разбор скриншота карты ликвидаций Coinglass: рамка карты, метки оси цен, яркие (жёлтые) полосы у правого края
   («сейчас») и перевод их в цены. Чистая логика на пикселях {width, height, data: RGBA}: window.Heat, в Node — require('./heat.js'). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Heat = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // шкала цвета карты (viridis): значение 0 (фиолетовый) … 1 (жёлтый)
  const V = [[0, 68, 1, 84], [.1, 72, 36, 117], [.2, 65, 68, 135], [.3, 53, 95, 141], [.4, 42, 120, 142], [.5, 33, 145, 140],
    [.6, 34, 168, 132], [.7, 68, 191, 112], [.8, 122, 209, 81], [.9, 189, 223, 38], [1, 253, 231, 37]];

  // яркость пикселя по шкале: ближайшая точка на ломаной viridis; -1, если цвет не из шкалы (свечи, текст)
  function level(r, g, b) {
    let bt = -1, bd = 1e9;
    for (let i = 0; i < V.length - 1; i++) {
      const p = V[i], q = V[i + 1], dr = q[1] - p[1], dg = q[2] - p[2], db = q[3] - p[3], L = dr * dr + dg * dg + db * db;
      let u = ((r - p[1]) * dr + (g - p[2]) * dg + (b - p[3]) * db) / L;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const x = r - (p[1] + u * dr), y = g - (p[2] + u * dg), z = b - (p[3] + u * db), d = x * x + y * y + z * z;
      if (d < bd) { bd = d; bt = p[0] + u * (q[0] - p[0]); }
    }
    return bd <= 45 * 45 ? bt : -1;
  }

  const sat = (d, i) => Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]);
  const lum = (d, i) => 0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2];

  // Находит карту, метки оси и профиль яркости у правого края. Возвращает {ok, reason, rect, labels, prof, edge}
  function analyze(img, o) {
    o = Object.assign({ edge: 0.04 }, o);
    const W = img.width, H = img.height, d = img.data;
    if (!(W > 100 && H > 100)) return { ok: false, reason: 'картинка слишком маленькая' };
    // доля «цветных» пикселей по строкам (в центральной полосе) и по столбцам
    const rowFrac = (y) => { let n = 0, m = 0; for (let x = Math.floor(W * .35); x < W * .65; x += 2) { n++; if (sat(d, (y * W + x) * 4) > 40) m++; } return m / n; };
    const colFrac = (x) => { let n = 0, m = 0; for (let y = Math.floor(H * .4); y < H * .6; y += 2) { n++; if (sat(d, (y * W + x) * 4) > 40) m++; } return m / n; };
    const cy = H >> 1, cx = W >> 1;
    if (rowFrac(cy) <= .5 || colFrac(cx) <= .5) return { ok: false, reason: 'в центре картинки нет тепловой карты' };
    let y0 = cy, y1 = cy, x0 = cx, x1 = cx;
    while (y0 > 0 && rowFrac(y0 - 1) > .5) y0--;
    while (y1 < H - 1 && rowFrac(y1 + 1) > .5) y1++;
    while (x0 > 0 && colFrac(x0 - 1) > .5) x0--;
    while (x1 < W - 1 && colFrac(x1 + 1) > .5) x1++;
    if (x1 - x0 < W * .4 || y1 - y0 < H * .3) return { ok: false, reason: 'карта найдена не полностью (обрежьте скриншот по карте)' };

    // метки оси цен: «чернила» справа от карты (отличаются от фона), по строкам
    const sx = Math.min(W - 2, x1 + 4), bg = [];
    for (let y = y0; y <= y1; y += 3) for (let x = sx; x < W; x += 3) bg.push(lum(d, (y * W + x) * 4));
    bg.sort((a, b) => a - b);
    const med = bg.length ? bg[bg.length >> 1] : 0, labels = [];
    const ink = (y) => { let n = 0; for (let x = sx; x < W; x++) if (Math.abs(lum(d, (y * W + x) * 4) - med) > 45) { if (++n >= 2) return true; } return false; };
    const minH = Math.max(3, Math.round(H * .006)), lo = Math.max(0, Math.round(y0 - H * .03)), hi = Math.min(H - 1, Math.round(y1 + H * .03));
    let s = -1, gap = 0;
    for (let y = lo; y <= hi + 1; y++) {
      const on = y <= hi && ink(y);
      if (on) { if (s < 0) s = y; gap = 0; }
      else if (s >= 0) {
        if (++gap > 1 || y > hi) { const e = y - gap; if (e - s + 1 >= minH) labels.push((s + e) / 2); s = -1; gap = 0; }
      }
    }

    // профиль яркости по строкам карты: медиана по правым edge·ширины столбцам («сейчас»)
    const xa = Math.max(x0, Math.round(x1 - o.edge * (x1 - x0))), prof = new Float32Array(y1 - y0 + 1);
    for (let y = y0; y <= y1; y++) {
      const v = [];
      for (let x = xa; x < x1; x++) { const i = (y * W + x) * 4, t = level(d[i], d[i + 1], d[i + 2]); if (t >= 0) v.push(t); }
      v.sort((a, b) => a - b);
      prof[y - y0] = v.length >= 3 ? v[v.length >> 1] : 0;
    }
    return { ok: true, W, H, rect: { x0, y0, x1, y1 }, xa, labels, prof };
  }

  // яркие полосы: подряд идущие строки с яркостью >= thr (разрывы до 2 строк склеиваются)
  function bandsAt(an, thr) {
    const { prof, rect, H } = an, out = [], minRows = Math.max(2, Math.round(H * .003));
    let s = -1, gap = 0;
    for (let i = 0; i <= prof.length; i++) {
      const on = i < prof.length && prof[i] >= thr;
      if (on) { if (s < 0) s = i; gap = 0; }
      else if (s >= 0) {
        if (++gap > 2 || i >= prof.length) {
          const e = i - gap;
          if (e - s + 1 >= minRows) {
            let pk = 0, sum = 0;
            for (let k = s; k <= e; k++) { pk = Math.max(pk, prof[k]); sum += prof[k]; }
            out.push({ y0: rect.y0 + s, y1: rect.y0 + e, peak: pk, mean: sum / (e - s + 1) });
          }
          s = -1; gap = 0;
        }
      }
    }
    return out;
  }

  // цена по строке картинки: верхняя и нижняя метки оси (или края карты) = top и bot
  function priceFn(an, top, bot, useEdges) {
    const L = an.labels, two = !useEdges && L.length >= 2;
    const yt = two ? L[0] : an.rect.y0, yb = two ? L[L.length - 1] : an.rect.y1;
    return (y) => top - (y - yt) * (top - bot) / (yb - yt);
  }

  function zones(an, thr, top, bot, useEdges) {
    if (!(top > bot && bot > 0)) return [];
    const P = priceFn(an, top, bot, useEdges);
    return bandsAt(an, thr).map(b => ({ lo: P(b.y1 + .5), hi: P(b.y0 - .5), peak: b.peak, mean: b.mean }))
      .sort((a, b) => b.peak * (b.hi - b.lo) - a.peak * (a.hi - a.lo));
  }

  // зоны с нескольких скриншотов: близкие (до tol $) склеиваются, n = на скольких скриншотах зона видна, берётся самая широкая
  function merge(lists, tol) {
    const all = [];
    lists.forEach((zs, k) => zs.forEach(z => all.push(Object.assign({ k }, z))));
    all.sort((a, b) => a.lo - b.lo);
    const cl = [];
    for (const z of all) {
      const c = cl[cl.length - 1];
      if (c && z.lo <= c.hi + tol) { c.m.push(z); c.hi = Math.max(c.hi, z.hi); } else cl.push({ hi: z.hi, m: [z] });
    }
    return cl.map(c => {
      const pk = Math.max.apply(null, c.m.map(z => z.peak)), top = c.m.filter(z => z.peak >= pk - .05).sort((a, b) => (b.hi - b.lo) - (a.hi - a.lo))[0];
      return { lo: top.lo, hi: top.hi, peak: pk, n: new Set(c.m.map(z => z.k)).size };
    }).sort((a, b) => b.n - a.n || b.peak * (b.hi - b.lo + 1) - a.peak * (a.hi - a.lo + 1));
  }

  return { level, analyze, bandsAt, priceFn, zones, merge };
});
