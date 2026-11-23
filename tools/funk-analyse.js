#!/usr/bin/env node
/*
 * Funkdiagnose für die Briefkasten-Sensoren.
 *
 *   curl -s 'http://172.16.2.10:3180/api/messages?since=2026-11-18T00:00:00Z' > messages.ndjson
 *   node tools/funk-analyse.js messages.ndjson [--temp aussentemp.csv] > bericht.md
 *
 * Eingabe: NDJSON aus /api/messages (ts, sensor, topic, payload, ...).
 * --temp: optional CSV «zeit,temperatur» (ISO-Zeit, °C), z.B. Export der Ecowitt-Aussentemperatur aus Home Assistant.
 *
 * Vorgehen
 *  - Meldungen eines Sensors, die weniger als BURST s auseinanderliegen, bilden ein «Aufwachen».
 *  - Lebenszeichen-Intervall T = Median der Abstände zwischen Aufwachen im Bereich 30–90 Min.
 *  - Ein Aufwachen gilt als Lebenszeichen, wenn es im Raster T (±TOL) nach dem letzten Lebenszeichen liegt.
 *    Alles andere ist ein Kontaktereignis.
 *  - zigbee2mqtt schickt in jeder Meldung den gecachten Zustand mit. Ein Kontaktereignis, dessen «contact»
 *    gleich dem vorherigen Zustand ist, bedeutet: die Gegenmeldung dazwischen fehlt.
 *    contact=true heisst «zu» (zigbee2mqtt-Konvention).
 *  - Ein Lebenszeichen mit anderem Zustand als vorher zeigt: der Sensor meldet beim Lebenszeichen seinen echten
 *    Zustand mit und korrigiert den Cache (dann fehlte ebenfalls eine Meldung).
 */
const fs = require('fs');

const BURST = 10;          // s
const TOL = 3 * 60;        // s Toleranz fürs Lebenszeichen-Raster
const LONG_OPEN = 10 * 60; // s
const LOW_MV = 2900;

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
if (!file) { console.error('Aufruf: node funk-analyse.js messages.ndjson [--temp temp.csv]'); process.exit(1); }
const tIdx = args.indexOf('--temp');
const temps = tIdx >= 0 ? fs.readFileSync(args[tIdx + 1], 'utf8').split('\n').slice(1).filter(Boolean)
  .map(l => l.split(',')).map(([z, v]) => ({ t: Date.parse(z) / 1000, v: +v })).filter(x => !isNaN(x.t) && !isNaN(x.v)).sort((a, b) => a.t - b.t) : [];
const tempAt = t => { if (!temps.length) return null; let best = temps[0]; for (const x of temps) { if (Math.abs(x.t - t) < Math.abs(best.t - t)) best = x; if (x.t > t) break; } return Math.abs(best.t - t) < 3 * 3600 ? best.v : null; };

const TZ = 'Europe/Zurich';
const fmt = new Intl.DateTimeFormat('de-CH', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const fmtDay = new Intl.DateTimeFormat('de-CH', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' });
const fmtHour = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' });
const hourOf = t => +fmtHour.formatToParts(new Date(t * 1000)).find(x => x.type === 'hour').value % 24;
const z = t => fmt.format(new Date(t * 1000)).replace(',', '');
const dur = s => s >= 3600 ? (s / 3600).toFixed(1) + ' h' : s >= 60 ? Math.round(s / 60) + ' min' : s.toFixed(1) + ' s';
const median = a => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y), m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const quant = (a, q) => { const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(q * b.length))]; };

// ---------- einlesen
const bySensor = {};
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  let r; try { r = JSON.parse(line); } catch (e) { continue; }
  let p = {}; try { p = JSON.parse(r.payload); } catch (e) { /* kein JSON */ }
  const name = (r.topic || r.sensor).split('/').pop();
  (bySensor[name] = bySensor[name] || []).push({ t: Date.parse(r.ts) / 1000, p, seen: p.last_seen ? Date.parse(p.last_seen) / 1000 : null });
}
const names = Object.keys(bySensor).sort((a, b) => (a.includes('briefkasten') ? 0 : 1) - (b.includes('briefkasten') ? 0 : 1) || a.localeCompare(b));
if (!names.length) { console.error('Keine Meldungen gefunden.'); process.exit(1); }
const allT = names.flatMap(n => bySensor[n].map(m => m.t));
const T0 = Math.min(...allT), T1 = Math.max(...allT);

// ---------- pro Sensor auswerten
const res = {};
for (const n of names) {
  const ms = bySensor[n].sort((a, b) => a.t - b.t);
  // Aufwachen bilden
  const wakes = [];
  for (const m of ms) {
    const w = wakes[wakes.length - 1];
    if (w && m.t - w.msgs[w.msgs.length - 1].t <= BURST) w.msgs.push(m); else wakes.push({ t: m.t, msgs: [m] });
  }
  wakes.forEach(w => {
    const last = w.msgs[w.msgs.length - 1].p;
    w.contacts = w.msgs.map(m => m.p.contact).filter(c => c !== undefined);
    w.lqi = w.msgs.map(m => m.p.linkquality).filter(x => x !== undefined);
    w.mv = last.voltage;
  });
  // Intervall schätzen
  const gaps = wakes.slice(1).map((w, i) => w.t - wakes[i].t);
  const T = median(gaps.filter(g => g >= 1800 && g <= 5400)) || 3600;
  // Lebenszeichen im Raster erkennen
  let lastHb = null;
  for (const w of wakes) {
    if (lastHb === null) { w.hb = true; lastHb = w.t; continue; }
    const d = w.t - lastHb, k = Math.round(d / T), off = Math.abs(d - k * T);
    w.hb = k >= 1 && off <= TOL + 30 * (k - 1);   // Toleranz wächst leicht mit der Zahl verpasster Lebenszeichen
    if (w.hb) lastHb = w.t;
  }
  const hbs = wakes.filter(w => w.hb);
  const hbGaps = hbs.slice(1).map((w, i) => ({ von: hbs[i].t, bis: w.t, d: w.t - hbs[i].t }));
  const lucken = hbGaps.filter(g => g.d > 1.25 * T).map(g => Object.assign(g, { fehlend: Math.round(g.d / T) - 1 }));
  const expected = Math.floor((T1 - hbs[0].t) / T) + 1;

  // Kontakt-Paaranalyse
  let state = null, openSince = null;
  const verlust = [], korrektur = [], langOffen = [];
  let wechsel = 0;
  for (const w of wakes) {
    for (const [i, c] of w.contacts.entries()) {
      if (state === null) { state = c; if (c === false) openSince = w.t; continue; }
      if (c !== state) {
        if (w.hb) korrektur.push({ t: w.t, nach: c });
        else wechsel++;
        if (c === false) openSince = w.t;
        else if (openSince !== null) { if (w.t - openSince > LONG_OPEN) langOffen.push({ von: openSince, bis: w.t }); openSince = null; }
        state = c;
      } else if (!w.hb && i === 0) {
        // Kontaktereignis mit unverändertem Zustand: Gegenmeldung fehlt
        verlust.push({ t: w.t, typ: c ? 'fehlende Öffnung (zu → zu)' : 'fehlende Schliessung (offen → offen)', lqi: w.lqi });
      }
    }
  }
  if (state === false && openSince !== null && T1 - openSince > LONG_OPEN) langOffen.push({ von: openSince, bis: null });
  korrektur.forEach(k => verlust.push({ t: k.t, typ: k.nach ? 'Schliessung fehlte, Lebenszeichen korrigiert' : 'Öffnung fehlte, Lebenszeichen korrigiert', lqi: [] }));

  // LQI und Spannung
  const lqi = ms.map(m => m.p.linkquality).filter(x => x !== undefined);
  const lqiByHour = Array.from({ length: 24 }, () => []);
  ms.forEach(m => m.p.linkquality !== undefined && lqiByHour[hourOf(m.t)].push(m.p.linkquality));
  const mv = ms.filter(m => m.p.voltage !== undefined);
  const low = mv.filter(m => m.p.voltage < LOW_MV);
  // Meldungen pro Tag
  const perDay = {};
  ms.forEach(m => { const d = fmtDay.format(new Date(m.t * 1000)); perDay[d] = (perDay[d] || 0) + 1; });
  // Verzögerung last_seen vs. Empfang
  const lag = ms.filter(m => m.seen).map(m => m.t - m.seen);

  res[n] = { ms, wakes, T, hbs, hbGaps, lucken, expected, verlust, langOffen, wechsel, korrektur, lqi, lqiByHour, mv, low, perDay, lag,
    medGap: median(gaps), maxGap: Math.max(...gaps, 0) };
}

// ---------- Korrelationen
const overlap = (a, b) => Math.max(0, Math.min(a.bis, b.bis) - Math.max(a.von, b.von));
const gleichzeitig = [];
for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++)
  for (const a of res[names[i]].lucken) for (const b of res[names[j]].lucken)
    if (overlap(a, b) > 0) gleichzeitig.push({ a: names[i], b: names[j], von: Math.max(a.von, b.von), bis: Math.min(a.bis, b.bis) });

// ---------- Bericht
const out = [];
const P = s => out.push(s);
P('# Funkdiagnose Briefkasten-Sensoren');
P('');
P(`Zeitraum: ${z(T0)} – ${z(T1)} (${dur(T1 - T0)}), Sensoren: ${names.join(', ')}`);
P('');
P('## Kennzahlen pro Sensor');
P('');
P('| Kennzahl | ' + names.join(' | ') + ' |');
P('|---|' + names.map(() => '---').join('|') + '|');
const row = (k, f) => P(`| ${k} | ` + names.map(n => f(res[n])).join(' | ') + ' |');
row('Meldungen total', r => r.ms.length);
row('Meldungen pro Tag', r => Object.entries(r.perDay).map(([d, c]) => d.slice(0, 6) + ' ' + c).join('<br>'));
row('Lebenszeichen-Intervall (aus Daten)', r => dur(r.T));
row('Lebenszeichen empfangen / erwartet', r => `${r.hbs.length} / ${r.expected} (${Math.round(100 * r.hbs.length / r.expected)} %)`);
row('Abstand zwischen Meldungen: Median / Max', r => `${dur(r.medGap || 0)} / ${dur(r.maxGap)}`);
row(`Lücken > 1,25 × Intervall`, r => `${r.lucken.length} (≈ ${r.lucken.reduce((s, l) => s + l.fehlend, 0)} fehlende Lebenszeichen)`);
row('LQI Min / Median / 5 %-Quantil', r => r.lqi.length ? `${Math.min(...r.lqi)} / ${median(r.lqi)} / ${quant(r.lqi, 0.05)}` : '–');
row('Spannung Min / Max', r => r.mv.length ? `${Math.min(...r.mv.map(m => m.p.voltage))} / ${Math.max(...r.mv.map(m => m.p.voltage))} mV` : '–');
row(`Meldungen unter ${LOW_MV} mV`, r => r.low.length);
row('Echte Zustandswechsel', r => r.wechsel);
row('Fehlende Öffnungen (zu → zu)', r => r.verlust.filter(v => v.typ.startsWith('fehlende Öffnung') || v.typ.startsWith('Öffnung fehlte')).length);
row('Fehlende Schliessungen (offen → offen)', r => r.verlust.filter(v => v.typ.startsWith('fehlende Schliessung') || v.typ.startsWith('Schliessung fehlte')).length);
row('davon durch Lebenszeichen korrigiert', r => r.korrektur.length);
row(`Länger als ${LONG_OPEN / 60} Min. offen`, r => r.langOffen.length);
row('Verzögerung last_seen → Empfang (Median)', r => r.lag.length ? r.lag.length + ' Meldungen, ' + median(r.lag).toFixed(1) + ' s' : 'kein last_seen');
P('');

for (const n of names) {
  const r = res[n];
  P(`## ${n}`);
  P('');
  P('**Lücken bei den Lebenszeichen**');
  P('');
  if (!r.lucken.length) P('keine'); else {
    P('| Start | Ende | Dauer | fehlend | Aussentemp. |'); P('|---|---|---|---|---|');
    r.lucken.forEach(l => { const tc = tempAt((l.von + l.bis) / 2); P(`| ${z(l.von)} | ${z(l.bis)} | ${dur(l.d)} | ${l.fehlend} | ${tc === null ? '–' : tc.toFixed(1) + ' °C'} |`); });
  }
  P('');
  P('**Verlorene Kontaktmeldungen**');
  P('');
  if (!r.verlust.length) P('keine'); else {
    P('| Zeit | Art | LQI | nächste Lebenszeichen-Lücke | Aussentemp. |'); P('|---|---|---|---|---|');
    r.verlust.sort((a, b) => a.t - b.t).forEach(v => {
      const near = r.lucken.map(l => ({ l, d: v.t >= l.von && v.t <= l.bis ? 0 : Math.min(Math.abs(v.t - l.von), Math.abs(v.t - l.bis)) })).sort((a, b) => a.d - b.d)[0];
      const tc = tempAt(v.t);
      P(`| ${z(v.t)} | ${v.typ} | ${v.lqi.join('/') || '–'} | ${near ? (near.d === 0 ? 'innerhalb' : dur(near.d) + ' entfernt') : '–'} | ${tc === null ? '–' : tc.toFixed(1) + ' °C'} |`);
    });
  }
  P('');
  if (r.langOffen.length) {
    P('**Lange offen**'); P('');
    r.langOffen.forEach(o => P(`- ${z(o.von)} – ${o.bis ? z(o.bis) + ' (' + dur(o.bis - o.von) + ')' : 'bis Ende der Daten (' + dur(T1 - o.von) + ')'}`));
    P('');
  }
  P('**LQI nach Tageszeit** (Median je Stunde, Anzahl Meldungen)'); P('');
  P('| ' + [0, 3, 6, 9, 12, 15, 18, 21].map(h => `${h}–${h + 3} h`).join(' | ') + ' |');
  P('|' + Array(8).fill('---').join('|') + '|');
  P('| ' + [0, 3, 6, 9, 12, 15, 18, 21].map(h => { const v = [].concat(...r.lqiByHour.slice(h, h + 3)); return v.length ? `${median(v)} (${v.length})` : '–'; }).join(' | ') + ' |');
  P('');
  const lostByHour = Array(8).fill(0);
  r.lucken.forEach(l => { for (let t = l.von + r.T; t < l.bis - r.T / 2; t += r.T) lostByHour[hourOf(t) / 3 | 0]++; });
  P('Fehlende Lebenszeichen nach Tageszeit: ' + [0, 3, 6, 9, 12, 15, 18, 21].map((h, i) => `${h}–${h + 3} h: ${lostByHour[i]}`).join(', '));
  P('');
}

P('## Korrelationen');
P('');
P(`Gleichzeitige Lücken (Überlappung bei zwei Sensoren): ${gleichzeitig.length}`);
gleichzeitig.slice(0, 30).forEach(g => P(`- ${g.a} & ${g.b}: ${z(g.von)} – ${z(g.bis)}`));
const ref = names.filter(n => !n.includes('briefkasten'));
P('');
P(ref.length ? `Vergleichssensor(en): ${ref.map(n => `${n} ${res[n].lucken.length} Lücken, ${Math.round(100 * res[n].hbs.length / res[n].expected)} % Lebenszeichen`).join('; ')}` : 'Kein Vergleichssensor in den Daten – Störung am Coordinator lässt sich so nicht ausschliessen.');
P('');

// ---------- Diagnose nach Entscheidungsbaum
const bk = names.filter(n => n.includes('briefkasten'));
const sum = (ns, f) => ns.reduce((s, n) => s + f(res[n]), 0);
const auf = sum(bk, r => r.verlust.filter(v => /Öffnung/.test(v.typ)).length);
const zu = sum(bk, r => r.verlust.filter(v => /Schliessung/.test(v.typ)).length);
const lossBk = sum(bk, r => r.lucken.reduce((s, l) => s + l.fehlend, 0)) / Math.max(1, sum(bk, r => r.expected));
const lossRef = ref.length ? sum(ref, r => r.lucken.reduce((s, l) => s + l.fehlend, 0)) / Math.max(1, sum(ref, r => r.expected)) : null;
const lowAll = sum(bk, r => r.low.length);
P('## Diagnose');
P('');
P(`- Verlorene Kontaktmeldungen Briefkasten: ${auf} Öffnungen, ${zu} Schliessungen`);
P(`- Verlorene Lebenszeichen Briefkasten: ${(100 * lossBk).toFixed(0)} %` + (lossRef !== null ? `, Vergleichssensor: ${(100 * lossRef).toFixed(0)} %` : ''));
P(`- Meldungen unter ${LOW_MV} mV: ${lowAll}`);
let d;
if (lowAll > 0) d = 'Spannungseinbrüche vorhanden – mit den Verlusten abgleichen (Batterie bei Kälte).';
else if (lossRef !== null && lossRef > 0.1 && lossBk > 0.1) d = 'Verluste auch beim Vergleichssensor → Coordinator/Störung am Server (USB-2.0-Verlängerung, Stick aus dem Rack).';
else if (auf > 0 && zu > 0 && lossBk > 0.1) d = 'Verluste in beide Richtungen und Lücken bei den Lebenszeichen nur am Briefkasten → Funk zum Briefkasten (Router in Briefkastennähe).';
else if (auf > 0 && zu > 0) d = 'Verluste in beide Richtungen, Lebenszeichen weitgehend lückenlos → Pakete beim Aufwachen gehen verloren → trotzdem Funk (Router); Spannung nochmals prüfen.';
else if (auf > 0 || zu > 0) d = 'Verluste nur in einer Richtung → Mechanik (' + (auf ? 'Öffnen: Klappe zu kurz offen' : 'Schliessen: Klappe schliesst nicht ganz / Magnetabstand') + ').';
else if (lossBk > 0.1) d = 'Keine verlorenen Kontaktmeldungen erkannt, aber Lücken bei den Lebenszeichen → Funkstrecke ist schwach; weiter beobachten.';
else d = 'Keine Auffälligkeiten.';
P(`- **Befund:** ${d}`);
console.log(out.join('\n'));
