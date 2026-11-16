// node test.js – spielt alle Szenarien mit 2 und mit 3 Sensoren gegen die Logik und vergleicht mit der Realität.
const { Logic } = require('./mailbox-logic.js');
const scenarios = require('./scenarios.js');

function run(sc, letterDoor) {
  const logic = new Logic({ letterDoor });
  const real = { mail: sc.pre[0], parcel: sc.pre[1] };
  logic.state.brief.count = sc.pre[0]; logic.state.paket.count = sc.pre[1];
  const [h, m] = sc.time.split(':').map(Number);
  const ctx = { resident: sc.resident, minuteOfDay: h * 60 + m };
  const codes = [], konf = [];
  logic.onResult = res => res.forEach(r => { codes.push(r.code); konf.push(r.konfidenz); });
  let i = 0;
  const end = sc.steps[sc.steps.length - 1][0] + logic.cfg.quiet + 1;
  for (let t = 0; t <= end; t += 0.05) {
    while (i < sc.steps.length && sc.steps[i][0] <= t + 1e-9) { logic.onContact(sc.steps[i][1], sc.steps[i][2], 100 + t, ctx); i++; }
    logic.tick(100 + t, ctx);
  }
  sc.truth(real);
  const p = logic.payload();
  const ok = (real.mail > 0) === (p.brieffach === 'post') && (real.parcel > 0) === (p.paketfach === 'belegt');
  return { ok, codes: codes.join('+'), vermutet: konf.includes('vermutet') };
}

const sum = { 2: [0, 0], 3: [0, 0] };
const cell = r => ((r.ok ? 'OK   ' : 'FALSCH ') + r.codes + (r.vermutet ? ' (vermutet)' : '')).padEnd(46);
console.log('Szenario'.padEnd(62) + '2 Sensoren'.padEnd(46) + '3 Sensoren');
for (const sc of scenarios) {
  const a = run(sc, false), b = run(sc, true);
  [[2, a], [3, b]].forEach(([k, r]) => { if (r.ok) sum[k][0]++; if (r.ok && !r.vermutet) sum[k][1]++; });
  console.log(('[' + sc.group + '] ' + sc.name).padEnd(62) + cell(a) + cell(b));
}
for (const k of [2, 3]) console.log(k + ' Sensoren: ' + sum[k][0] + ' von ' + scenarios.length + ' richtig, davon ' + sum[k][1] + ' als «sicher».');
