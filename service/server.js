/*
 * Briefkasten-Dienst: hört die Sensor-Topics am MQTT-Broker ab, wertet sie mit mailbox-logic.js aus
 * und meldet Status + Diagnose zurück (inkl. Home-Assistant-Discovery).
 * Konfiguration nur über Umgebungsvariablen, siehe .env.example.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const mqtt = require('mqtt');
const { Logic } = require('../mailbox-logic.js');

const env = process.env;
const num = (k, d) => (env[k] !== undefined && env[k] !== '' ? Number(env[k]) : d);
const BASE = env.BASE_TOPIC || 'briefkasten';
const DISC = env.DISCOVERY_PREFIX || 'homeassistant';
const DATA = env.DATA_DIR || path.join(__dirname, '..', 'data');
const TZ = env.TZ || 'Europe/Zurich';
const TOPICS = { slot: env.TOPIC_SLOT, parcel: env.TOPIC_PARCEL, letter: env.TOPIC_LETTER || '' };
const TOPIC_PRESENCE = env.TOPIC_PRESENCE || '';
const CONTACT_FIELD = env.CONTACT_FIELD || 'contact';
const HISTORY = 12;

if (!TOPICS.slot || !TOPICS.parcel) { console.error('TOPIC_SLOT und TOPIC_PARCEL müssen gesetzt sein.'); process.exit(1); }
fs.mkdirSync(DATA, { recursive: true });

const parseWindows = s => s.split(',').map(w => w.trim().split('-').map(x => { const [h, m] = x.split(':').map(Number); return h * 60 + (m || 0); }));
const cfg = {
  letterDoor: !!TOPICS.letter,
  debounce: num('DEBOUNCE', 0.4), peekParcel: num('PEEK_PARCEL', 3), emptyMin: num('EMPTY_MIN', 8),
  peekSlot: num('PEEK_SLOT', 4), quiet: num('QUIET', 10), slotStuck: num('SLOT_STUCK', 20),
  parcelOpenAlarm: num('PARCEL_OPEN_ALARM', 60),
  windows: parseWindows(env.WINDOWS || '05:00-07:00,11:30-14:30')
};

// ---------- Zeit ----------
const now = () => Date.now() / 1000;
const fmtParts = new Intl.DateTimeFormat('de-CH', { timeZone: TZ, hour12: false, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
function local(t) { const p = {}; fmtParts.formatToParts(new Date(t * 1000)).forEach(x => p[x.type] = x.value); return p; }
const minuteOfDay = t => { const p = local(t); return (+p.hour % 24) * 60 + +p.minute; };
const stamp = t => { const p = local(t); return p.day + '.' + p.month + '. ' + p.hour + ':' + p.minute + ':' + p.second; };

// ---------- Dateien ----------
const F = { state: path.join(DATA, 'state.json'), events: path.join(DATA, 'events.jsonl'), sessions: path.join(DATA, 'sessions.jsonl') };
const append = (f, o) => fs.appendFile(f, JSON.stringify(o) + '\n', e => e && console.error('Schreibfehler', f, e.message));
const readLines = f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean) : []);

// ---------- Zustand ----------
const logic = new Logic(cfg, onResult);
let sessions = [];                 // letzte Sitzungen (neueste zuerst)
let curEvents = [];                // Rohereignisse der laufenden Sitzung
let presence = false;
const sensorOpen = { slot: null, parcel: null, letter: null };
const stats = { stimmt: 0, falsch: 0 };
// Empfangsdiagnose: jede Meldung auf den Sensor-Topics, auch die ignorierten
const rx = {};
Object.keys(TOPICS).forEach(k => { if (TOPICS[k]) rx[k] = { topic: TOPICS[k], meldungen: 0, ereignisse: 0, ignoriert: 0, zuletzt: null, zustand: 'unbekannt', ergebnis: 'noch nichts empfangen' }; });
let rxLog = [];                    // letzte Rohmeldungen (neueste zuerst)
function received(sensor, t, buf, ergebnis, isEvent) {
  const r = rx[sensor];
  r.meldungen++; if (isEvent) r.ereignisse++; else r.ignoriert++;
  r.zuletzt = stamp(t); r.ergebnis = ergebnis;
  r.zustand = sensorOpen[sensor] === null ? 'unbekannt' : sensorOpen[sensor] ? 'offen' : 'zu';
  rxLog.unshift({ zeit: stamp(t), sensor: NAME[sensor], ergebnis, payload: buf.toString().slice(0, 160) });
  rxLog = rxLog.slice(0, 40);
  publishRx();
}

try { const s = JSON.parse(fs.readFileSync(F.state, 'utf8')); logic.state.brief = s.brief; logic.state.paket = s.paket; logic.state.last = s.last; } catch (e) { /* erster Start */ }
(function loadSessions() {
  const byId = new Map();
  for (const l of readLines(F.sessions)) {
    if (l.typ === 'feedback') { const s = byId.get(l.id); if (s) s.feedback = l.feedback; if (l.feedback.stimmt) stats.stimmt++; else stats.falsch++; }
    else byId.set(l.id, l);
  }
  sessions = [...byId.values()].reverse().slice(0, 200);
})();

const ctx = t => ({ resident: presence, minuteOfDay: minuteOfDay(t) });
const NAME = { slot: 'Schlitz', parcel: 'Paketfach', letter: 'Türchen' };

function onResult(results, state, final, diag) {
  const t = now();
  fs.writeFile(F.state, JSON.stringify({ brief: state.brief, paket: state.paket, last: state.last }), () => {});
  results.forEach(r => console.log(stamp(t), r.code, '[' + r.konfidenz + ']', r.text));
  if (final && diag) {
    const t0 = diag.start;
    const s = {
      id: new Date(t0 * 1000).toISOString(), zeit: stamp(t0), sensoren: cfg.letterDoor ? 3 : 2,
      ereignisse: curEvents.map(e => ({ t: +(e.t - t0).toFixed(2), sensor: e.sensor, offen: e.open })),
      ablauf: curEvents.map(e => '+' + (e.t - t0).toFixed(1) + 's ' + NAME[e.sensor] + (e.open ? ' auf' : ' zu')).join(', '),
      dauer: diag.dauer, zustellfenster: diag.zustellfenster, bewohner: diag.bewohner,
      vorher: diag.vorher, nachher: diag.nachher,
      ergebnisse: results, code: results.map(r => r.code).join('+'),
      konfidenz: results.some(r => r.konfidenz === 'vermutet') ? 'vermutet' : 'sicher',
      schwellwerte: { debounce: cfg.debounce, peekParcel: cfg.peekParcel, emptyMin: cfg.emptyMin, peekSlot: cfg.peekSlot },
      feedback: null
    };
    curEvents = [];
    sessions.unshift(s); sessions = sessions.slice(0, 200);
    append(F.sessions, s);
  }
  publishAll();
}

// ---------- MQTT ----------
const client = mqtt.connect(env.MQTT_URL || 'mqtt://localhost:1883', {
  username: env.MQTT_USERNAME || undefined, password: env.MQTT_PASSWORD || undefined,
  will: { topic: BASE + '/online', payload: 'offline', retain: true }
});
const pub = (topic, obj, retain = true) => client.publish(topic, typeof obj === 'string' ? obj : JSON.stringify(obj), { retain });

function parseOpen(buf) {
  const txt = buf.toString().trim();
  try {
    const j = JSON.parse(txt);
    if (j && typeof j === 'object') return CONTACT_FIELD in j ? !j[CONTACT_FIELD] : null; // contact:true = geschlossen
    if (typeof j === 'boolean') return j;
    if (typeof j === 'number') return j !== 0;
  } catch (e) { /* kein JSON */ }
  const v = txt.toLowerCase();
  if (['open', 'on', 'offen', 'true'].includes(v)) return true;
  if (['closed', 'off', 'zu', 'false'].includes(v)) return false;
  return null;
}

client.on('connect', () => {
  console.log('MQTT verbunden:', env.MQTT_URL, '| Sensoren:', cfg.letterDoor ? 3 : 2);
  pub(BASE + '/online', 'online');
  Object.values(TOPICS).filter(Boolean).forEach(t => client.subscribe(t));
  if (TOPIC_PRESENCE) client.subscribe(TOPIC_PRESENCE);
  client.subscribe(BASE + '/cmd/#');
  publishDiscovery();
  publishAll();
  publishRx();
});
client.on('error', e => console.error('MQTT-Fehler:', e.message));

client.on('message', (topic, buf) => {
  const t = now();
  if (topic.startsWith(BASE + '/cmd/')) return command(topic.slice(BASE.length + 5), buf.toString().trim(), t);
  if (topic === TOPIC_PRESENCE) { const o = parseOpen(buf); if (o !== null) presence = o; return; }
  const sensor = Object.keys(TOPICS).find(k => TOPICS[k] === topic);
  if (!sensor) return;
  const open = parseOpen(buf);
  if (open === null) return received(sensor, t, buf, 'ignoriert: Zustand nicht lesbar (Feld «' + CONTACT_FIELD + '» fehlt?)', false);
  if (sensorOpen[sensor] === open) return received(sensor, t, buf, 'ignoriert: Zustand unverändert (' + (open ? 'offen' : 'zu') + ')', false);
  const first = sensorOpen[sensor] === null;
  sensorOpen[sensor] = open;
  if (first && !open) return received(sensor, t, buf, 'ignoriert: Startzustand «zu»', false);
  received(sensor, t, buf, 'Ereignis: ' + (open ? 'auf' : 'zu'), true);
  append(F.events, { t: +t.toFixed(3), zeit: stamp(t), sensor, open });
  curEvents.push({ t, sensor, open });
  logic.onContact(sensor, open, t, ctx(t));
  publishAll();
});

function command(cmd, payload, t) {
  if (['brief_leer', 'paket_leer', 'alles_leer'].includes(cmd)) return logic.manual(cmd, t);
  const last = sessions[0];
  if (cmd === 'stimmt') {
    if (!last || last.feedback) return;
    last.feedback = { stimmt: true, zeit: stamp(t) }; stats.stimmt++;
    append(F.sessions, { typ: 'feedback', id: last.id, feedback: last.feedback });
    return publishAll();
  }
  if (cmd === 'real') {                                               // payload "1,0" = Post ja, Paket nein
    const [m, p] = payload.split(',').map(x => x.trim() === '1');
    if (last && !last.feedback) {
      const ok = (last.nachher.brief > 0) === m && (last.nachher.paket > 0) === p;
      last.feedback = { stimmt: ok, real: { post: m, paket: p }, zeit: stamp(t) };
      if (ok) stats.stimmt++; else stats.falsch++;
      append(F.sessions, { typ: 'feedback', id: last.id, feedback: last.feedback });
    }
    return logic.setReal(m, p, t);
  }
}

function publishAll() {
  if (!client.connected) return;
  const t = now(), p = logic.payload(), pend = logic.pending(t);
  pub(BASE + '/status', Object.assign(p, {
    sitzung_aktiv: pend !== null, sensoren: cfg.letterDoor ? 3 : 2,
    zustellfenster: logic.inWindow(minuteOfDay(t)),
    feedback_stimmt: stats.stimmt, feedback_falsch: stats.falsch,
    aktualisiert: stamp(t)
  }));
  const last = sessions[0];
  if (last) pub(BASE + '/sitzung', {
    zeit: last.zeit, code: last.code, konfidenz: last.konfidenz, ablauf: last.ablauf,
    begruendung: last.ergebnisse.map(r => r.text).join(' '),
    vorher: last.vorher, nachher: last.nachher, zustellfenster: last.zustellfenster, bewohner: last.bewohner,
    feedback: last.feedback ? (last.feedback.stimmt ? 'stimmt' : 'falsch') : 'offen'
  });
  pub(BASE + '/verlauf', { anzahl: sessions.length, sitzungen: sessions.slice(0, HISTORY).map(s => ({
    zeit: s.zeit, code: s.code, konfidenz: s.konfidenz, ablauf: s.ablauf,
    vorher: s.vorher.brief + '/' + s.vorher.paket, nachher: s.nachher.brief + '/' + s.nachher.paket,
    begruendung: s.ergebnisse.map(r => r.text).join(' '),
    feedback: s.feedback ? (s.feedback.stimmt ? 'stimmt' : 'falsch') : 'offen'
  })) });
}

function publishRx() {
  if (!client.connected) return;
  const total = Object.values(rx).reduce((a, r) => a + r.meldungen, 0);
  pub(BASE + '/empfang', { meldungen: total, sensoren: Object.keys(rx).map(k => Object.assign({ name: NAME[k] }, rx[k])), letzte: rxLog.slice(0, 10) });
}

function publishDiscovery() {
  const device = { identifiers: ['smart_mailbox'], name: 'Briefkasten', manufacturer: 'Eigenbau', model: 'Huber Alu 400 Logik' };
  const avail = { availability_topic: BASE + '/online' };
  const ent = (type, id, cfgx) => pub(DISC + '/' + type + '/smart_mailbox/' + id + '/config', Object.assign({
    unique_id: 'smart_mailbox_' + id, default_entity_id: type + '.briefkasten_' + (id === 'empfang' ? 'mqtt_empfang' : id), device
  }, avail, cfgx));
  const st = BASE + '/status', tpl = k => '{{ value_json.' + k + ' }}', bin = k => "{{ 'ON' if value_json." + k + " else 'OFF' }}";
  ent('sensor', 'brieffach', { name: 'Brieffach', state_topic: st, value_template: tpl('brieffach'), icon: 'mdi:email' });
  ent('sensor', 'paketfach', { name: 'Paketfach', state_topic: st, value_template: tpl('paketfach'), icon: 'mdi:package-variant-closed' });
  ent('sensor', 'einwuerfe', { name: 'Einwürfe', state_topic: st, value_template: tpl('brieffach_einwuerfe'), icon: 'mdi:counter' });
  ent('sensor', 'pakete', { name: 'Pakete', state_topic: st, value_template: tpl('paketfach_anzahl'), icon: 'mdi:counter' });
  ent('binary_sensor', 'brieffach_unsicher', { name: 'Brieffach vermutet', state_topic: st, value_template: bin('brieffach_unsicher'), icon: 'mdi:help-circle-outline' });
  ent('binary_sensor', 'paketfach_unsicher', { name: 'Paketfach vermutet', state_topic: st, value_template: bin('paketfach_unsicher'), icon: 'mdi:help-circle-outline' });
  ent('binary_sensor', 'schlitz_blockiert', { name: 'Schlitz blockiert', state_topic: st, value_template: bin('alarm_schlitz_blockiert'), device_class: 'problem' });
  ent('binary_sensor', 'paketfach_offen', { name: 'Paketfach steht offen', state_topic: st, value_template: bin('alarm_paketfach_offen'), device_class: 'problem' });
  ent('binary_sensor', 'sitzung_aktiv', { name: 'Sitzung läuft', state_topic: st, value_template: bin('sitzung_aktiv'), icon: 'mdi:timer-sand' });
  ent('binary_sensor', 'zustellfenster', { name: 'Zustellfenster', state_topic: st, value_template: bin('zustellfenster'), icon: 'mdi:clock-outline' });
  ent('sensor', 'feedback_stimmt', { name: 'Rückmeldungen stimmt', state_topic: st, value_template: tpl('feedback_stimmt'), icon: 'mdi:check' });
  ent('sensor', 'feedback_falsch', { name: 'Rückmeldungen falsch', state_topic: st, value_template: tpl('feedback_falsch'), icon: 'mdi:close' });
  ent('sensor', 'letzte_sitzung', { name: 'Letzte Sitzung', state_topic: BASE + '/sitzung', value_template: tpl('code'), json_attributes_topic: BASE + '/sitzung', icon: 'mdi:magnify' });
  ent('sensor', 'verlauf', { name: 'Verlauf', state_topic: BASE + '/verlauf', value_template: tpl('anzahl'), json_attributes_topic: BASE + '/verlauf', icon: 'mdi:history' });
  ent('sensor', 'empfang', { name: 'MQTT-Empfang', state_topic: BASE + '/empfang', value_template: tpl('meldungen'), json_attributes_topic: BASE + '/empfang', icon: 'mdi:access-point' });
  const btn = (id, name, cmd, payload, icon) => ent('button', id, { name, command_topic: BASE + '/cmd/' + cmd, payload_press: payload, icon });
  btn('stimmt', 'Letzte Erkennung stimmt', 'stimmt', '1', 'mdi:check-bold');
  btn('real_leer_leer', 'Real: keine Post, kein Paket', 'real', '0,0', 'mdi:mailbox-open-outline');
  btn('real_post_leer', 'Real: Post, kein Paket', 'real', '1,0', 'mdi:email');
  btn('real_leer_paket', 'Real: keine Post, Paket', 'real', '0,1', 'mdi:package-variant-closed');
  btn('real_post_paket', 'Real: Post und Paket', 'real', '1,1', 'mdi:mailbox-up');
}

setInterval(() => {
  const t = now(), before = logic.pending(t) !== null;
  logic.tick(t, ctx(t));
  if (before !== (logic.pending(t) !== null)) publishAll();
}, 500);
setInterval(publishAll, 60000); // Zustellfenster / Lebenszeichen

// ---------- HTTP: Health + Diagnose ----------
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
http.createServer((req, res) => {
  const send = (code, type, body) => { res.writeHead(code, { 'content-type': type + '; charset=utf-8' }); res.end(body); };
  if (req.url === '/health') return send(client.connected ? 200 : 503, 'application/json', JSON.stringify({ mqtt: client.connected }));
  if (req.url === '/api/sessions') return send(200, 'application/json', JSON.stringify(sessions));
  if (req.url === '/api/empfang') return send(200, 'application/json', JSON.stringify({ sensoren: rx, letzte: rxLog }));
  if (req.url === '/api/status') return send(200, 'application/json', JSON.stringify(logic.payload()));
  if (req.url === '/api/events') return send(200, 'application/x-ndjson', fs.existsSync(F.events) ? fs.readFileSync(F.events) : '');
  if (req.url === '/') {
    const p = logic.payload();
    return send(200, 'text/html', '<!DOCTYPE html><meta charset="utf-8"><title>Briefkasten-Diagnose</title>' +
      '<style>body{font:14px system-ui;margin:20px}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px;text-align:left;vertical-align:top}</style>' +
      '<h1>Briefkasten-Diagnose</h1><p>Brieffach: <b>' + p.brieffach + '</b> (' + p.brieffach_einwuerfe + ') · Paketfach: <b>' + p.paketfach + '</b> (' + p.paketfach_anzahl +
      ') · Rückmeldungen: ' + stats.stimmt + ' stimmt, ' + stats.falsch + ' falsch · <a href="/api/events">Rohereignisse</a> · <a href="/api/sessions">Sitzungen (JSON)</a></p>' +
      '<h2>MQTT-Empfang</h2><p>Broker: ' + (client.connected ? 'verbunden' : '<b>nicht verbunden</b>') + '</p>' +
      '<table><tr><th>Sensor</th><th>Topic</th><th>Meldungen</th><th>davon Ereignisse</th><th>ignoriert</th><th>Zustand</th><th>Zuletzt</th><th>Letztes Ergebnis</th></tr>' +
      Object.keys(rx).map(k => '<tr><td>' + NAME[k] + '</td><td>' + esc(rx[k].topic) + '</td><td>' + rx[k].meldungen + '</td><td>' + rx[k].ereignisse + '</td><td>' + rx[k].ignoriert +
        '</td><td>' + rx[k].zustand + '</td><td>' + (rx[k].zuletzt || '–') + '</td><td>' + esc(rx[k].ergebnis) + '</td></tr>').join('') + '</table>' +
      '<h3>Letzte Rohmeldungen</h3><table><tr><th>Zeit</th><th>Sensor</th><th>Ergebnis</th><th>Payload</th></tr>' +
      rxLog.map(m => '<tr><td>' + m.zeit + '</td><td>' + m.sensor + '</td><td>' + esc(m.ergebnis) + '</td><td><code>' + esc(m.payload) + '</code></td></tr>').join('') + '</table>' +
      '<h2>Sitzungen</h2>' +
      '<table><tr><th>Zeit</th><th>Ablauf</th><th>Erkannt</th><th>Vorher → Nachher (Post/Paket)</th><th>Begründung</th><th>Rückmeldung</th></tr>' +
      sessions.slice(0, 100).map(s => '<tr><td>' + s.zeit + '</td><td>' + esc(s.ablauf) + '</td><td>' + s.code + ' [' + s.konfidenz + ']</td><td>' +
        s.vorher.brief + '/' + s.vorher.paket + ' → ' + s.nachher.brief + '/' + s.nachher.paket + '</td><td>' + esc(s.ergebnisse.map(r => r.text).join(' ')) +
        '</td><td>' + (s.feedback ? (s.feedback.stimmt ? 'stimmt' : 'falsch') : '–') + '</td></tr>').join('') + '</table>');
  }
  send(404, 'text/plain', 'not found');
}).listen(num('PORT', 3000), () => console.log('HTTP auf Port', num('PORT', 3000)));

process.on('SIGTERM', () => { pub(BASE + '/online', 'offline'); client.end(false, {}, () => process.exit(0)); });
