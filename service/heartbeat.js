/*
 * Lebenszeichen-Auswertung für die Funkdiagnose.
 * Eingabe: gespeicherte Meldungen [{ t (s), sensor, topic, payload }], Ausgabe: Kennzahlen pro Sensor.
 *
 *  - Meldungen eines Sensors, die höchstens BURST s auseinanderliegen, bilden ein «Aufwachen».
 *  - Intervall T = Median der Abstände zwischen Aufwachen im Bereich 30–90 Min. (Aqara: ca. 55 Min.).
 *  - Ein Aufwachen im Raster T (± Toleranz) nach dem letzten Lebenszeichen gilt als Lebenszeichen, sonst als Kontaktereignis.
 *  - Lücke = Abstand zwischen zwei Lebenszeichen > 1,25 × T.
 */
const BURST = 10;
const TOL = 180;
const DEFAULT_T = 3300;

const median = a => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y), m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };

function analyse(rows, { from, to, names = {}, hourOf, dayOf }) {
  const by = {};
  for (const r of rows) {
    let p = {}; try { p = JSON.parse(r.payload); } catch (e) { /* kein JSON */ }
    (by[r.sensor] = by[r.sensor] || { topic: r.topic, ms: [] }).ms.push({ t: r.t, p });
  }
  const sensoren = Object.keys(by).map(key => {
    const ms = by[key].ms.sort((a, b) => a.t - b.t);
    const wakes = [];
    for (const m of ms) {
      const w = wakes[wakes.length - 1];
      if (w && m.t - w.last <= BURST) { w.n++; w.last = m.t; Object.assign(w.p, m.p); }
      else wakes.push({ t: m.t, last: m.t, n: 1, p: Object.assign({}, m.p) });
    }
    const gaps = wakes.slice(1).map((w, i) => w.t - wakes[i].t);
    const T = median(gaps.filter(g => g >= 1800 && g <= 5400)) || DEFAULT_T;
    let lastHb = null;
    for (const w of wakes) {
      if (lastHb === null) { w.hb = true; lastHb = w.t; continue; }
      const d = w.t - lastHb, k = Math.round(d / T);
      w.hb = k >= 1 && Math.abs(d - k * T) <= TOL + 30 * (k - 1);
      if (w.hb) lastHb = w.t;
    }
    const hbs = wakes.filter(w => w.hb);
    const luecken = [];
    for (let i = 1; i < hbs.length; i++) {
      const d = hbs[i].t - hbs[i - 1].t;
      if (d > 1.25 * T) luecken.push({ von: hbs[i - 1].t, bis: hbs[i].t, dauer: d, fehlend: Math.max(1, Math.round(d / T) - 1) });
    }
    const last = wakes.length ? wakes[wakes.length - 1].t : null;
    // offene Lücke bis jetzt
    const lastHbT = hbs.length ? hbs[hbs.length - 1].t : null;
    if (lastHbT !== null && to - lastHbT > 1.25 * T) luecken.push({ von: lastHbT, bis: null, dauer: to - lastHbT, fehlend: Math.floor((to - lastHbT) / T), offen: true });
    const start = hbs.length ? hbs[0].t : from;
    const erwartet = Math.max(1, Math.floor((to - start) / T) + 1);
    // pro Tag und pro Tageszeit
    const tage = {}, stunden = Array.from({ length: 24 }, () => ({ empfangen: 0, fehlend: 0 }));
    hbs.forEach(w => { const d = dayOf(w.t); (tage[d] = tage[d] || { empfangen: 0, fehlend: 0 }).empfangen++; stunden[hourOf(w.t)].empfangen++; });
    luecken.forEach(l => {
      const end = l.bis ?? to;
      for (let t = l.von + T, k = 0; k < l.fehlend && t < end; t += T, k++) {
        const d = dayOf(t); (tage[d] = tage[d] || { empfangen: 0, fehlend: 0 }).fehlend++; stunden[hourOf(t)].fehlend++;
      }
    });
    const lqi = ms.map(m => m.p.linkquality).filter(x => typeof x === 'number');
    const mv = ms.map(m => m.p.voltage).filter(x => typeof x === 'number');
    const fehlend = luecken.reduce((s, l) => s + l.fehlend, 0);
    const alter = last !== null ? to - last : null;
    return {
      key, name: names[key] || key.replace(/^ref:/, ''), referenz: key.startsWith('ref:'), topic: by[key].topic,
      intervall: T, meldungen: ms.length, lebenszeichen: hbs.length, erwartet, fehlend,
      quote: hbs.length / (hbs.length + fehlend || 1),
      zuletzt: last, alter, ampel: alter === null ? 'bad' : alter < 1.5 * T ? 'ok' : alter < 3 * T ? 'warn' : 'bad',
      maxLuecke: Math.max(0, ...luecken.map(l => l.dauer)),
      lqi: lqi.length ? { min: Math.min(...lqi), median: median(lqi), letzte: lqi[lqi.length - 1] } : null,
      spannung: mv.length ? { min: Math.min(...mv), max: Math.max(...mv), letzte: mv[mv.length - 1] } : null,
      lastSeen: ms.length ? ms[ms.length - 1].p.last_seen || null : null,
      luecken, tage, stunden,
      punkte: wakes.map(w => ({ t: w.t, hb: w.hb, lqi: w.p.linkquality ?? null, mv: w.p.voltage ?? null, contact: w.p.contact ?? null, n: w.n }))
    };
  });
  const order = k => ({ slot: 0, parcel: 1, letter: 2 }[k] ?? (k.startsWith('ref:') ? 9 : 5));
  sensoren.sort((a, b) => order(a.key) - order(b.key) || a.key.localeCompare(b.key));

  // Lücken, die bei mehreren Sensoren gleichzeitig offen sind (Hinweis auf Coordinator)
  const gleichzeitig = [];
  for (let i = 0; i < sensoren.length; i++) for (let j = i + 1; j < sensoren.length; j++)
    for (const a of sensoren[i].luecken) for (const b of sensoren[j].luecken) {
      const von = Math.max(a.von, b.von), bis = Math.min(a.bis ?? to, b.bis ?? to);
      if (bis > von) gleichzeitig.push({ a: sensoren[i].name, b: sensoren[j].name, von, bis });
    }
  return { von: from, bis: to, sensoren, gleichzeitig };
}

module.exports = { analyse };
