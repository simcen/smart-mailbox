/*
 * Lebenszeichen-Auswertung für die Funkdiagnose.
 * Eingabe: gespeicherte Meldungen [{ t (s), sensor, topic, payload }], Ausgabe: Kennzahlen pro Sensor.
 *
 *  - Meldungen eines Sensors, die höchstens BURST s auseinanderliegen, bilden ein «Aufwachen».
 *  - Intervall T = Median der Abstände zwischen Aufwachen im Bereich 30–90 Min. (Aqara: ca. 55 Min.).
 *  - Der Sensor startet seinen Lebenszeichen-Takt nach jeder Übertragung neu (auch nach einem Kontaktereignis).
 *    Jedes Aufwachen zählt deshalb als Lebenszeichen; erwartet wird das nächste T später.
 *  - Lücke = Abstand zwischen zwei Aufwachen > 1,25 × T, fehlend = gerundet(Abstand / T) − 1.
 *  - Schweigen ALLE Sensoren gleichzeitig länger als AUSFALL, liegt es nicht am Funk zum Briefkasten, sondern an der
 *    Empfangskette (Dienst, Broker, Zigbee2MQTT, Coordinator). Solche Zeiten werden separat ausgewiesen und nicht als
 *    Funkverlust gezählt.
 *  - Ampel: rot bei Quote < 70 % oder zuletzt vor > 3 × T, orange bei Quote < 90 % oder zuletzt vor > 1,5 × T, sonst grün.
 */
const BURST = 10;
const TOL = 180;
const DEFAULT_T = 3300;
const AUSFALL = 4 * 3600;

const median = a => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y), m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };

function analyse(rows, { from, to, names = {}, hourOf, dayOf, konfiguriert = [] }) {
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
    // Darstellung: Kontaktereignis = Zustand anders als beim vorherigen Aufwachen oder ausserhalb des Takts
    wakes.forEach((w, i) => {
      if (!i) { w.hb = true; return; }
      const d = w.t - wakes[i - 1].t, k = Math.round(d / T);
      w.hb = w.p.contact === wakes[i - 1].p.contact && k >= 1 && Math.abs(d - k * T) <= TOL + 30 * (k - 1);
    });
    const luecken = [];
    const seq = wakes.map(w => w.t);
    if (seq.length) seq.push(to);
    for (let i = 1; i < seq.length; i++) {
      const d = seq[i] - seq[i - 1];
      if (d > 1.25 * T) luecken.push({ von: seq[i - 1], bis: i === seq.length - 1 ? null : seq[i], dauer: d, fehlend: Math.max(1, Math.round(d / T) - 1), offen: i === seq.length - 1 });
    }
    if (luecken.length && luecken[luecken.length - 1].offen && luecken[luecken.length - 1].dauer <= 1.25 * T) luecken.pop();
    return { key, ms, wakes, T, luecken };
  });
  if (!sensoren.length) return { von: from, bis: to, sensoren: [], ausfaelle: [], gleichzeitig: [] };

  // Ausfälle der Empfangskette: Zeiten, in denen alle Sensoren gleichzeitig schweigen
  let ausfaelle = [{ von: from, bis: to }];
  for (const se of sensoren) {
    const silent = [{ von: from, bis: se.wakes.length ? se.wakes[0].t : to }].concat(se.luecken.map(l => ({ von: l.von, bis: l.bis ?? to })));
    const next = [];
    for (const a of ausfaelle) for (const b of silent) { const v = Math.max(a.von, b.von), e = Math.min(a.bis, b.bis); if (e > v) next.push({ von: v, bis: e }); }
    ausfaelle = next;
  }
  ausfaelle = ausfaelle.filter(a => a.bis - a.von >= AUSFALL && a.von > from).map(a => Object.assign(a, { dauer: a.bis - a.von }));
  const imAusfall = (von, bis) => ausfaelle.reduce((s, a) => s + Math.max(0, Math.min(bis, a.bis) - Math.max(von, a.von)), 0);

  const result = sensoren.map(({ key, ms, wakes, T, luecken }) => {
    const hbs = wakes;
    luecken.forEach(l => {
      const aus = imAusfall(l.von, l.bis ?? to);
      l.ausfall = aus;
      l.fehlend = Math.max(0, Math.round((l.dauer - aus) / T) - 1);   // Funkverlust ohne Ausfallzeit
    });
    const last = wakes.length ? wakes[wakes.length - 1].t : null;
    const start = hbs.length ? hbs[0].t : from;
    const erwartet = Math.max(1, Math.floor((to - start) / T) + 1);
    // pro Tag und pro Tageszeit (nur Funkverluste)
    const tage = {}, stunden = Array.from({ length: 24 }, () => ({ empfangen: 0, fehlend: 0 }));
    hbs.forEach(w => { const d = dayOf(w.t); (tage[d] = tage[d] || { empfangen: 0, fehlend: 0 }).empfangen++; stunden[hourOf(w.t)].empfangen++; });
    luecken.forEach(l => {
      const end = l.bis ?? to;
      for (let t = l.von + T; t < end - T / 2; t += T) {
        if (imAusfall(t - 1, t + 1)) continue;
        const d = dayOf(t); (tage[d] = tage[d] || { empfangen: 0, fehlend: 0 }).fehlend++; stunden[hourOf(t)].fehlend++;
      }
    });
    const lqi = ms.map(m => m.p.linkquality).filter(x => typeof x === 'number');
    const mv = ms.map(m => m.p.voltage).filter(x => typeof x === 'number');
    const fehlend = luecken.reduce((s, l) => s + l.fehlend, 0);
    const alter = last !== null ? to - last : null;
    const quote = hbs.length / (hbs.length + fehlend || 1);
    const gruende = [];
    if (alter === null || alter > 3 * T) gruende.push('rot: seit über 3 Intervallen still');
    else if (alter > 1.5 * T) gruende.push('orange: seit über 1,5 Intervallen still');
    if (quote < 0.7) gruende.push('rot: weniger als 70 % angekommen');
    else if (quote < 0.9) gruende.push('orange: weniger als 90 % angekommen');
    const ampel = gruende.some(g => g.startsWith('rot')) ? 'bad' : gruende.length ? 'warn' : 'ok';
    return {
      key, name: names[key] || key.replace(/^ref:/, ''), referenz: key.startsWith('ref:'), topic: by[key].topic,
      intervall: T, meldungen: ms.length, lebenszeichen: hbs.length, erwartet, fehlend,
      quote, zuletzt: last, alter, ampel, gruende,
      maxLuecke: Math.max(0, ...luecken.filter(l => l.fehlend > 0).map(l => l.dauer - l.ausfall)),
      lqi: lqi.length ? { min: Math.min(...lqi), median: median(lqi), letzte: lqi[lqi.length - 1] } : null,
      spannung: mv.length ? { min: Math.min(...mv), max: Math.max(...mv), letzte: mv[mv.length - 1] } : null,
      lastSeen: ms.length ? ms[ms.length - 1].p.last_seen || null : null,
      luecken, tage, stunden,
      punkte: wakes.map(w => ({ t: w.t, hb: w.hb, lqi: w.p.linkquality ?? null, mv: w.p.voltage ?? null, contact: w.p.contact ?? null, n: w.n }))
    };
  });
  // konfigurierte Sensoren ohne Meldung im Zeitraum trotzdem zeigen
  for (const c of konfiguriert) if (!result.some(r => r.key === c.key)) result.push({
    key: c.key, name: names[c.key] || c.key.replace(/^ref:/, ''), referenz: c.key.startsWith('ref:'), topic: c.topic, leer: true,
    intervall: DEFAULT_T, meldungen: 0, lebenszeichen: 0, erwartet: 0, fehlend: 0, quote: 0, zuletzt: null, alter: null,
    ampel: 'bad', gruende: ['rot: keine Meldung im Zeitraum'], maxLuecke: 0, lqi: null, spannung: null, lastSeen: null,
    luecken: [], tage: {}, stunden: Array.from({ length: 24 }, () => ({ empfangen: 0, fehlend: 0 })), punkte: [] });
  const order = k => ({ slot: 0, parcel: 1, letter: 2 }[k] ?? (k.startsWith('ref:') ? 9 : 5));
  result.sort((a, b) => order(a.key) - order(b.key) || a.key.localeCompare(b.key));
  const sensorenOut = result;

  // Lücken, die bei mehreren Sensoren gleichzeitig offen sind (Hinweis auf Coordinator)
  const S = sensorenOut, gleichzeitig = [];
  for (let i = 0; i < S.length; i++) for (let j = i + 1; j < S.length; j++)
    for (const a of S[i].luecken) for (const b of S[j].luecken) {
      const von = Math.max(a.von, b.von), bis = Math.min(a.bis ?? to, b.bis ?? to);
      if (bis > von && bis - von > imAusfall(von, bis)) gleichzeitig.push({ a: S[i].name, b: S[j].name, von, bis });
    }
  return { von: from, bis: to, sensoren: S, ausfaelle, gleichzeitig };
}

module.exports = { analyse };
