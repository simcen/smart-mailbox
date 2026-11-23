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
const createStore = require('./store.js');
const heartbeat = require('./heartbeat.js');

const env = process.env;
const num = (k, d) => (env[k] !== undefined && env[k] !== '' ? Number(env[k]) : d);
const BASE = env.BASE_TOPIC || 'briefkasten';
const DISC = env.DISCOVERY_PREFIX || 'homeassistant';
const DATA = env.DATA_DIR || path.join(__dirname, '..', 'data');
const TZ = env.TZ || 'Europe/Zurich';
const TOPICS = { slot: env.TOPIC_SLOT, parcel: env.TOPIC_PARCEL, letter: env.TOPIC_LETTER || '' };
const TOPIC_PRESENCE = env.TOPIC_PRESENCE || '';
// Vergleichssensoren für die Funkdiagnose: nur mitschreiben, nicht auswerten (Komma-Liste, z.B. zigbee2mqtt/w8a-tk-z08-west)
const TOPIC_REFERENCE = (env.TOPIC_REFERENCE || '').split(',').map(s => s.trim()).filter(Boolean);
const CONTACT_FIELD = env.CONTACT_FIELD || 'contact';
const HISTORY = 12;
const LOW_VOLTAGE_MV = num('LOW_VOLTAGE_MV', 2850);   // darunter gilt die Batterie als schwach

if (!TOPICS.slot || !TOPICS.parcel) { console.error('TOPIC_SLOT und TOPIC_PARCEL müssen gesetzt sein.'); process.exit(1); }
const store = createStore(env, DATA);

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
const START = now();
const VERSION = (env.SOURCE_COMMIT || '').slice(0, 7) || 'unbekannt';   // Coolify setzt SOURCE_COMMIT beim Build
const fmtParts = new Intl.DateTimeFormat('de-CH', { timeZone: TZ, hour12: false, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
function local(t) { const p = {}; fmtParts.formatToParts(new Date(t * 1000)).forEach(x => p[x.type] = x.value); return p; }
const minuteOfDay = t => { const p = local(t); return (+p.hour % 24) * 60 + +p.minute; };
const stamp = t => { const p = local(t); return p.day + '.' + p.month + '. ' + p.hour + ':' + p.minute + ':' + p.second; };

// ---------- Zustand ----------
const logic = new Logic(cfg, onResult);
let sessions = [];                 // letzte Sitzungen (neueste zuerst)
let curEvents = [];                // Rohereignisse der laufenden Sitzung
let presence = false;
const sensorOpen = { slot: null, parcel: null, letter: null };
const stats = { stimmt: 0, falsch: 0, offen: 0 };
function recount() {
  stats.stimmt = sessions.filter(s => s.feedback && s.feedback.stimmt).length;
  stats.falsch = sessions.filter(s => s.feedback && !s.feedback.stimmt).length;
  stats.offen = sessions.filter(s => !s.feedback).length;
}
const battery = {};               // pro Sensor: { mv, prozent, temperatur, zeit }
// Empfangsdiagnose: jede Meldung auf den Sensor-Topics, auch die ignorierten
const rx = {};
Object.keys(TOPICS).forEach(k => { if (TOPICS[k]) rx[k] = { topic: TOPICS[k], meldungen: 0, ereignisse: 0, ignoriert: 0, zuletzt: null, zustand: 'unbekannt', ergebnis: 'noch nichts empfangen' }; });
let rxLog = [];                    // letzte Rohmeldungen (neueste zuerst)
function received(sensor, t, buf, ergebnis, isEvent) {
  const r = rx[sensor];
  r.meldungen++; if (isEvent) r.ereignisse++; else r.ignoriert++;
  r.zuletzt = stamp(t); r.ergebnis = ergebnis;
  r.zustand = sensorOpen[sensor] === null ? 'unbekannt' : sensorOpen[sensor] ? 'offen' : 'zu';
  const payload = buf.toString().slice(0, 500);
  rxLog.unshift({ zeit: stamp(t), sensor: NAME[sensor], ergebnis, payload });
  rxLog = rxLog.slice(0, 40);
  store.addMessage({ t: +t.toFixed(3), zeit: stamp(t), sensor, topic: TOPICS[sensor], payload, ergebnis, isEvent });
  publishRx();
}

/** Gespeicherten Stand laden: Status, Sitzungen, Meldungs-Log und Zähler überleben so einen Neustart. */
async function restore() {
  const d = await store.init();
  if (d.state) { logic.state.brief = d.state.brief; logic.state.paket = d.state.paket; logic.state.last = d.state.last; Object.assign(battery, d.state.battery || {}); }
  sessions = d.sessions;
  recount();
  rxLog = d.messages.map(m => ({ zeit: m.zeit, sensor: NAME[m.sensor] || m.sensor, ergebnis: m.ergebnis, payload: m.payload }));
  Object.keys(rx).forEach(k => { const c = d.counts[k]; if (c) Object.assign(rx[k], { meldungen: c.meldungen, ereignisse: c.ereignisse, ignoriert: c.ignoriert, zuletzt: c.zuletzt, ergebnis: c.ergebnis }); });
  console.log('Ablage:', store.kind, '|', sessions.length, 'Sitzungen,', Object.values(rx).reduce((a, r) => a + r.meldungen, 0), 'Meldungen geladen');
}

const ctx = t => ({ resident: presence, minuteOfDay: minuteOfDay(t) });
const NAME = { slot: 'Schlitz', parcel: 'Paketfach', letter: 'Türchen' };

const saveState = () => store.saveState({ brief: logic.state.brief, paket: logic.state.paket, last: logic.state.last, battery });

function onResult(results, state, final, diag) {
  const t = now();
  saveState();
  results.forEach(r => console.log(stamp(t), r.code, '[' + r.konfidenz + ']', r.text));
  if (final && diag) {
    const t0 = diag.start;
    const s = {
      id: new Date(t0 * 1000).toISOString(), zeit: stamp(t0), sensoren: cfg.letterDoor ? 3 : 2,
      ereignisse: curEvents.map(e => ({ t: +(e.t - t0).toFixed(2), sensor: e.sensor, offen: e.open, abgeleitet: !!e.abgeleitet })),
      hinweis: diag.hinweis,
      ablauf: curEvents.map(e => '+' + (e.t - t0).toFixed(1) + 's ' + NAME[e.sensor] + (e.open ? ' auf' : ' zu') + (e.abgeleitet ? ' (abgeleitet)' : '')).join(', '),
      dauer: diag.dauer, zustellfenster: diag.zustellfenster, bewohner: diag.bewohner,
      vorher: diag.vorher, nachher: diag.nachher,
      ergebnisse: results, code: results.map(r => r.code).join('+'),
      konfidenz: results.some(r => r.konfidenz === 'vermutet') ? 'vermutet' : 'sicher',
      schwellwerte: { debounce: cfg.debounce, peekParcel: cfg.peekParcel, emptyMin: cfg.emptyMin, peekSlot: cfg.peekSlot },
      feedback: null
    };
    curEvents = [];
    sessions.unshift(s); sessions = sessions.slice(0, 500);
    store.addSession(s);
    recount();
  }
  publishAll();
}

// ---------- MQTT ----------
const client = mqtt.connect(env.MQTT_URL || 'mqtt://localhost:1883', {
  manualConnect: true,
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
  TOPIC_REFERENCE.forEach(t => client.subscribe(t));
  client.subscribe(BASE + '/cmd/#');
  publishDiscovery();
  publishAll();
  publishRx();
  publishBattery();
});
client.on('error', e => console.error('MQTT-Fehler:', e.message));

client.on('message', (topic, buf) => {
  const t = now();
  if (topic.startsWith(BASE + '/cmd/')) return command(topic.slice(BASE.length + 5), buf.toString().trim(), t);
  if (topic === TOPIC_PRESENCE) { const o = parseOpen(buf); if (o !== null) presence = o; return; }
  if (TOPIC_REFERENCE.includes(topic)) {                // Vergleichssensor: nur ablegen
    return store.addMessage({ t: +t.toFixed(3), zeit: stamp(t), sensor: 'ref:' + topic.split('/').pop(), topic, payload: buf.toString().slice(0, 500), ergebnis: 'Vergleichssensor', isEvent: false });
  }
  const sensor = Object.keys(TOPICS).find(k => TOPICS[k] === topic);
  if (!sensor) return;
  try {
    const j = JSON.parse(buf.toString());
    if (j && typeof j === 'object' && (j.voltage !== undefined || j.battery !== undefined)) {
      const b = battery[sensor] || {};
      const changed = b.mv !== j.voltage || b.prozent !== j.battery;
      battery[sensor] = { mv: j.voltage ?? null, prozent: j.battery ?? null, temperatur: j.device_temperature ?? null, zeit: stamp(t) };
      if (changed) { saveState(); publishBattery(); }
    }
  } catch (e) { /* kein JSON */ }
  const open = parseOpen(buf);
  if (open === null) return received(sensor, t, buf, 'ignoriert: Zustand nicht lesbar (Feld «' + CONTACT_FIELD + '» fehlt?)', false);
  if (sensorOpen[sensor] === open) return received(sensor, t, buf, 'ignoriert: Zustand unverändert (' + (open ? 'offen' : 'zu') + ')', false);
  const first = sensorOpen[sensor] === null;
  sensorOpen[sensor] = open;
  if (first && !open) return received(sensor, t, buf, 'ignoriert: Startzustand «zu»', false);
  if (first && open && sensor === 'letter' && sensorOpen.parcel !== true)
    return received(sensor, t, buf, 'ignoriert: Startzustand «offen» bei geschlossenem Paketfach – unplausibel, Sensor prüfen', false);
  // Paketfach zu, Türchen laut Sensor noch offen: Schliessen des Türchens ableiten (Meldung fehlt)
  if (sensor === 'parcel' && !open && sensorOpen.letter === true) {
    sensorOpen.letter = false;
    const e = 'abgeleitet: zu, weil Paketfach geschlossen wurde – Meldung des Türchens fehlt';
    rx.letter.zustand = 'zu (abgeleitet)'; rx.letter.ergebnis = e; rx.letter.abgeleitet = (rx.letter.abgeleitet || 0) + 1;
    rxLog.unshift({ zeit: stamp(t), sensor: NAME.letter, ergebnis: e, payload: '(keine Meldung)' });
    if (logic.open.letter !== null) {            // nur wenn die Logik das Türchen in dieser Sitzung offen sah
      store.addEvent({ t: +t.toFixed(3), zeit: stamp(t), sensor: 'letter', open: false });
      curEvents.push({ t, sensor: 'letter', open: false, abgeleitet: true });
    }
  }
  received(sensor, t, buf, 'Ereignis: ' + (open ? 'auf' : 'zu'), true);
  store.addEvent({ t: +t.toFixed(3), zeit: stamp(t), sensor, open });
  curEvents.push({ t, sensor, open });
  logic.onContact(sensor, open, t, ctx(t));
  publishAll();
});

function command(cmd, payload, t) {
  if (['brief_leer', 'paket_leer', 'alles_leer'].includes(cmd)) return logic.manual(cmd, t);
  const target = sessions.find(s => !s.feedback);            // MQTT-Knöpfe bewerten die neueste unbewertete Sitzung
  if (cmd === 'stimmt') { if (target) rate(target.id, { stimmt: true }, t); return; }
  if (cmd === 'real') {                                               // payload "1,0" = Post ja, Paket nein
    const [m, p] = payload.split(',').map(x => x.trim() === '1');
    if (target && target === sessions[0]) return rate(target.id, { real: { post: m, paket: p } }, t);
    return logic.setReal(m, p, t);
  }
}

/**
 * Sitzung bewerten. fb = {stimmt:true} | {stimmt:false} | {real:{post,paket}} | null (Bewertung löschen).
 * «real» beschreibt den Inhalt direkt nach dieser Sitzung; daraus ergibt sich stimmt/falsch.
 * Nur bei der neuesten Sitzung wird mit «real» auch der aktuelle Status korrigiert.
 */
function rate(id, fb, t) {
  const s = sessions.find(x => x.id === id);
  if (!s) return false;
  if (fb === null) s.feedback = null;
  else if (fb.real) {
    const ok = (s.nachher.brief > 0) === !!fb.real.post && (s.nachher.paket > 0) === !!fb.real.paket;
    s.feedback = { stimmt: ok, real: { post: !!fb.real.post, paket: !!fb.real.paket }, zeit: stamp(t) };
    if (!ok && s === sessions[0]) { recount(); store.setFeedback(id, s.feedback); logic.setReal(!!fb.real.post, !!fb.real.paket, t); return true; }
  } else { s.feedback = { stimmt: !!fb.stimmt, zeit: stamp(t) }; if (fb.aktion) s.feedback.aktion = String(fb.aktion).slice(0, 40); }
  store.setFeedback(id, s.feedback);
  recount();
  publishAll();
  return true;
}

function publishAll() {
  if (!client.connected) return;
  const t = now(), p = logic.payload(), pend = logic.pending(t);
  pub(BASE + '/status', Object.assign(p, {
    sitzung_aktiv: pend !== null, sensoren: cfg.letterDoor ? 3 : 2,
    zustellfenster: logic.inWindow(minuteOfDay(t)),
    feedback_stimmt: stats.stimmt, feedback_falsch: stats.falsch, feedback_offen: stats.offen,
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

function publishBattery() {
  if (!client.connected) return;
  const o = { schwach: false, schwach_liste: [], grenze_mv: LOW_VOLTAGE_MV };
  Object.keys(rx).forEach(k => {
    const b = battery[k] || {};
    o[k + '_mv'] = b.mv ?? null; o[k + '_prozent'] = b.prozent ?? null; o[k + '_zeit'] = b.zeit ?? null;
    if (typeof b.mv === 'number' && b.mv < LOW_VOLTAGE_MV) { o.schwach = true; o.schwach_liste.push(NAME[k]); }
  });
  o.schwach_text = o.schwach_liste.join(', ');
  pub(BASE + '/batterie', o);
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
  ent('sensor', 'feedback_offen', { name: 'Sitzungen unbewertet', state_topic: st, value_template: tpl('feedback_offen'), icon: 'mdi:help' });
  Object.keys(rx).forEach(k => ent('sensor', 'spannung_' + { slot: 'schlitz', parcel: 'paketfach', letter: 'tuerchen' }[k], {
    name: 'Batteriespannung ' + NAME[k], state_topic: BASE + '/batterie', value_template: '{{ value_json.' + k + '_mv }}',
    device_class: 'voltage', unit_of_measurement: 'mV', state_class: 'measurement', entity_category: 'diagnostic' }));
  ent('binary_sensor', 'batterie_schwach', { name: 'Sensor-Batterien', state_topic: BASE + '/batterie', value_template: bin('schwach'),
    json_attributes_topic: BASE + '/batterie', device_class: 'battery', entity_category: 'diagnostic' });
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

// ---------- HTTP: Health + Diagnose + Bewertung ----------
const PAGE = fs.readFileSync(path.join(__dirname, 'page.html'), 'utf8');
const HB_PAGE = fs.readFileSync(path.join(__dirname, 'heartbeat.html'), 'utf8');
const fmtHour = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' });
const fmtDay = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });   // JJJJ-MM-TT, sortierbar
function body(req) { return new Promise(r => { let d = ''; req.on('data', c => { d += c; if (d.length > 1e5) req.destroy(); }); req.on('end', () => { try { r(JSON.parse(d || '{}')); } catch (e) { r(null); } }); }); }
const server = http.createServer(async (req, res) => {
  const send = (code, type, b) => { res.writeHead(code, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-store' }); res.end(b); };
  const json = (code, o) => send(code, 'application/json', JSON.stringify(o));
  const url = req.url.split('?')[0];
  if (url === '/health') return json(client.connected ? 200 : 503, { mqtt: client.connected, version: VERSION, gestartet: stamp(START) });
  if (req.method === 'POST') {
    const b = await body(req), t = now();
    if (b === null) return json(400, { fehler: 'ungültiges JSON' });
    if (url === '/api/feedback') {                       // {id, stimmt:true} | {id, stimmt:false, aktion:'peek_schlitz'} | {id, loeschen:true}
      const fb = b.loeschen ? null : b.real ? { real: b.real } : { stimmt: !!b.stimmt, aktion: b.aktion };
      return rate(b.id, fb, t) ? json(200, { ok: true }) : json(404, { fehler: 'Sitzung nicht gefunden' });
    }
    if (url === '/api/status') {                         // {post:bool, paket:bool} – aktuellen Status korrigieren
      logic.setReal(!!b.post, !!b.paket, t); return json(200, { ok: true });
    }
    return json(404, { fehler: 'unbekannt' });
  }
  if (url === '/api/overview') {
    const t = now();
    return json(200, { mqtt: client.connected, version: VERSION, gestartet: stamp(START), ablage: store.kind, status: logic.payload(), sitzung_aktiv: logic.pending(t) !== null, stats,
      sensoren: Object.keys(rx).map(k => Object.assign({ key: k, name: NAME[k], batterie: battery[k] || null }, rx[k])),
      grenze_mv: LOW_VOLTAGE_MV, empfang: rxLog, sitzungen: sessions, neueste: sessions[0] ? sessions[0].id : null, zeit: stamp(t) });
  }
  if (url === '/api/sessions') return json(200, sessions);
  if (url === '/api/empfang') return json(200, { sensoren: rx, letzte: rxLog });
  if (url === '/api/status') return json(200, logic.payload());
  if (url === '/api/events') return send(200, 'application/x-ndjson', await store.eventsNdjson());
  if (url === '/api/messages') {                       // Rohmeldungen als NDJSON, optional ?since=2026-11-18T00:00:00Z
    const q = new URLSearchParams(req.url.split('?')[1] || ''), since = q.get('since') ? new Date(q.get('since')) : null;
    if (since && isNaN(since)) return json(400, { fehler: 'since ist kein Datum' });
    res.setHeader('content-disposition', 'attachment; filename="messages.ndjson"');
    return send(200, 'application/x-ndjson', await store.messagesNdjson(since));
  }
  if (url === '/') return send(200, 'text/html', PAGE);
  if (url === '/lebenszeichen') return send(200, 'text/html', HB_PAGE);
  if (url === '/api/heartbeat') {                     // Lebenszeichen-Auswertung, ?tage=7
    const tage = Math.min(60, Math.max(0.25, Number(new URLSearchParams(req.url.split('?')[1] || '').get('tage')) || 7));
    const to = now(), from = to - tage * 86400;
    const rows = await store.messagesSince(new Date(from * 1000));
    return json(200, heartbeat.analyse(rows, { from, to, names: NAME,
      hourOf: t => +fmtHour.formatToParts(new Date(t * 1000)).find(x => x.type === 'hour').value % 24,
      dayOf: t => fmtDay.format(new Date(t * 1000)) }));
  }
  send(404, 'text/plain', 'not found');
});

restore().then(() => {
  server.listen(num('PORT', 3000), () => console.log('HTTP auf Port', num('PORT', 3000)));
  client.connect();
}).catch(e => { console.error('Start fehlgeschlagen:', e.message); process.exit(1); });

process.on('SIGTERM', () => { pub(BASE + '/online', 'offline'); client.end(false, {}, () => store.close().finally(() => process.exit(0))); });
