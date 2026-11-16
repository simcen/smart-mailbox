// Spielt aufgezeichnete Rohereignisse (events.jsonl) erneut durch die Logik – zum Nachstellen der Schwellwerte.
//   node service/replay.js data/events.jsonl                      (Standardwerte, 3 Sensoren wenn letter vorkommt)
//   EMPTY_MIN=6 PEEK_SLOT=3 node service/replay.js data/events.jsonl
const fs = require('fs');
const { Logic } = require('../mailbox-logic.js');
const file = process.argv[2];
if (!file) { console.error('Aufruf: node service/replay.js <events.jsonl>'); process.exit(1); }
const ev = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const env = process.env, num = (k, d) => (env[k] ? Number(env[k]) : d);
const TZ = env.TZ || 'Europe/Zurich';
const fmt = new Intl.DateTimeFormat('de-CH', { timeZone: TZ, hour12: false, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const mod = t => { const p = {}; fmt.formatToParts(new Date(t * 1000)).forEach(x => p[x.type] = x.value); return (+p.hour % 24) * 60 + +p.minute; };
const cfg = { letterDoor: env.LETTER_DOOR ? env.LETTER_DOOR === '1' : ev.some(e => e.sensor === 'letter') };
[['DEBOUNCE', 'debounce'], ['PEEK_PARCEL', 'peekParcel'], ['EMPTY_MIN', 'emptyMin'], ['PEEK_SLOT', 'peekSlot'], ['QUIET', 'quiet']]
  .forEach(([e, k]) => { if (env[e]) cfg[k] = Number(env[e]); });
const logic = new Logic(cfg, (res, st, final, diag) => {
  if (!final) return;
  console.log(fmt.format(new Date(diag.start * 1000)), '|', res.map(r => r.code + '[' + r.konfidenz + ']').join('+'),
    '| Post/Paket', diag.vorher.brief + '/' + diag.vorher.paket, '->', diag.nachher.brief + '/' + diag.nachher.paket,
    '| Schlitz', JSON.stringify(diag.dauer.slot.map(d => +d.toFixed(1))), 'Paketfach', JSON.stringify(diag.dauer.parcel.map(d => +d.toFixed(1))),
    'Türchen', JSON.stringify(diag.dauer.letter.map(d => +d.toFixed(1))));
});
let t = ev.length ? ev[0].t : 0;
for (const e of ev) {
  for (; t < e.t; t += 0.5) logic.tick(t, { minuteOfDay: mod(t) });
  logic.onContact(e.sensor, e.open, e.t, { minuteOfDay: mod(e.t) });
  t = e.t;
}
for (let k = 0; k < 400; k++) { t += 0.5; logic.tick(t, { minuteOfDay: mod(t) }); }
