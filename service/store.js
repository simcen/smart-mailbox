/*
 * Ablage für Status, Sitzungen, Rohereignisse und MQTT-Meldungen.
 *   DATABASE_URL oder PGHOST gesetzt -> PostgreSQL (Tabellen werden beim Start angelegt)
 *   sonst                 -> JSONL-Dateien im DATA_DIR
 * Beide Varianten haben dieselbe Schnittstelle. Schreibfehler werden protokolliert, halten den Dienst aber nicht an.
 */
const fs = require('fs');
const path = require('path');

const LOG_SIZE = 40;      // so viele letzte Meldungen werden beim Start wieder geladen
const MAX_SESSIONS = 500;

function emptyCounts() { return {}; }
function count(counts, m) {
  const c = counts[m.sensor] || (counts[m.sensor] = { meldungen: 0, ereignisse: 0, ignoriert: 0, zuletzt: null, ergebnis: null });
  c.meldungen++; if (m.isEvent) c.ereignisse++; else c.ignoriert++;
  c.zuletzt = m.zeit; c.ergebnis = m.ergebnis;
}

// ---------------------------------------------------------------- Dateien
function fileStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const F = n => path.join(dir, n);
  const append = (f, o) => fs.appendFile(F(f), JSON.stringify(o) + '\n', e => e && console.error('Schreibfehler', f, e.message));
  const lines = f => (fs.existsSync(F(f)) ? fs.readFileSync(F(f), 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean) : []);
  return {
    kind: 'Dateien (' + dir + ')',
    async init() {
      let state = null;
      try { state = JSON.parse(fs.readFileSync(F('state.json'), 'utf8')); } catch (e) { /* erster Start */ }
      const byId = new Map();
      for (const l of lines('sessions.jsonl')) {
        if (l.typ === 'feedback') { const s = byId.get(l.id); if (s) s.feedback = l.feedback; } else byId.set(l.id, l);
      }
      const msgs = lines('messages.jsonl'), counts = emptyCounts();
      msgs.forEach(m => count(counts, m));
      return { state, sessions: [...byId.values()].reverse().slice(0, MAX_SESSIONS), messages: msgs.slice(-LOG_SIZE).reverse(), counts };
    },
    saveState(o) { fs.writeFile(F('state.json'), JSON.stringify(o), () => {}); },
    addSession(s) { append('sessions.jsonl', s); },
    setFeedback(id, feedback) { append('sessions.jsonl', { typ: 'feedback', id, feedback }); },
    addEvent(e) { append('events.jsonl', e); },
    addMessage(m) { append('messages.jsonl', m); },
    async eventsNdjson() { return fs.existsSync(F('events.jsonl')) ? fs.readFileSync(F('events.jsonl'), 'utf8') : ''; },
    async messagesSince(since) {
      return lines('messages.jsonl').filter(m => m.t * 1000 >= since.getTime()).map(m => ({ t: m.t, sensor: m.sensor, topic: m.topic, payload: m.payload }));
    },
    async messagesNdjson(since) {
      return lines('messages.jsonl').filter(m => !since || m.t * 1000 >= since.getTime())
        .map(m => JSON.stringify({ ts: new Date(m.t * 1000).toISOString(), sensor: m.sensor, topic: m.topic, payload: m.payload, ergebnis: m.ergebnis, is_event: m.isEvent })).join('\n') + '\n';
    },
    async close() {}
  };
}

// ---------------------------------------------------------------- PostgreSQL
function pgStore(url) {
  const { Pool } = require('pg');
  const pool = new Pool(url ? { connectionString: url, max: 4 } : { max: 4 });   // ohne URL gelten PGHOST, PGUSER, PGPASSWORD, PGDATABASE
  pool.on('error', e => console.error('Datenbankfehler:', e.message));
  const run = (sql, params) => pool.query(sql, params).catch(e => console.error('Datenbank-Schreibfehler:', e.message));
  const ts = t => new Date(t * 1000);
  return {
    kind: 'PostgreSQL',
    async init() {
      for (let i = 1; ; i++) {                          // Datenbank startet evtl. später als der Dienst
        try { await pool.query('select 1'); break; } catch (e) {
          if (i >= 30) throw e;
          console.log('Warte auf Datenbank (' + e.message + ') …'); await new Promise(r => setTimeout(r, 2000));
        }
      }
      await pool.query(`
        create table if not exists messages (
          id bigserial primary key, ts timestamptz not null, zeit text not null, sensor text not null, topic text not null,
          payload text not null, ergebnis text not null, is_event boolean not null);
        create index if not exists messages_ts on messages (ts desc);
        create table if not exists events (
          id bigserial primary key, ts timestamptz not null, t double precision not null, zeit text not null, sensor text not null, open boolean not null);
        create table if not exists sessions (
          id text primary key, started timestamptz not null, data jsonb not null, feedback jsonb);
        create table if not exists kv (key text primary key, value jsonb not null);`);
      const st = await pool.query("select value from kv where key = 'state'");
      const se = await pool.query('select data, feedback from sessions order by started desc limit $1', [MAX_SESSIONS]);
      const ms = await pool.query('select zeit, sensor, topic, payload, ergebnis, is_event from messages order by id desc limit $1', [LOG_SIZE]);
      const ct = await pool.query(`
        select m.sensor, count(*)::int as meldungen, count(*) filter (where is_event)::int as ereignisse,
               (select zeit from messages x where x.sensor = m.sensor order by id desc limit 1) as zuletzt,
               (select ergebnis from messages x where x.sensor = m.sensor order by id desc limit 1) as ergebnis
        from messages m group by m.sensor`);
      const counts = emptyCounts();
      ct.rows.forEach(r => { counts[r.sensor] = { meldungen: r.meldungen, ereignisse: r.ereignisse, ignoriert: r.meldungen - r.ereignisse, zuletzt: r.zuletzt, ergebnis: r.ergebnis }; });
      return {
        state: st.rows[0] ? st.rows[0].value : null,
        sessions: se.rows.map(r => Object.assign(r.data, { feedback: r.feedback })),
        messages: ms.rows.map(r => ({ zeit: r.zeit, sensor: r.sensor, topic: r.topic, payload: r.payload, ergebnis: r.ergebnis, isEvent: r.is_event })),
        counts
      };
    },
    saveState(o) { run("insert into kv (key, value) values ('state', $1) on conflict (key) do update set value = excluded.value", [JSON.stringify(o)]); },
    addSession(s) {
      const data = Object.assign({}, s); delete data.feedback;
      run('insert into sessions (id, started, data, feedback) values ($1, $2, $3, $4) on conflict (id) do nothing', [s.id, s.id, JSON.stringify(data), s.feedback ? JSON.stringify(s.feedback) : null]);
    },
    setFeedback(id, feedback) { run('update sessions set feedback = $2 where id = $1', [id, feedback ? JSON.stringify(feedback) : null]); },
    addEvent(e) { run('insert into events (ts, t, zeit, sensor, open) values ($1, $2, $3, $4, $5)', [ts(e.t), e.t, e.zeit, e.sensor, e.open]); },
    addMessage(m) { run('insert into messages (ts, zeit, sensor, topic, payload, ergebnis, is_event) values ($1, $2, $3, $4, $5, $6, $7)', [ts(m.t), m.zeit, m.sensor, m.topic, m.payload, m.ergebnis, m.isEvent]); },
    async eventsNdjson() {
      const r = await pool.query('select t, zeit, sensor, open from events order by id');
      return r.rows.map(x => JSON.stringify(x)).join('\n') + (r.rows.length ? '\n' : '');
    },
    async messagesSince(since) {
      const r = await pool.query('select extract(epoch from ts)::float8 as t, sensor, topic, payload from messages where ts >= $1 order by id', [since]);
      return r.rows;
    },
    async messagesNdjson(since) {
      const r = await pool.query('select ts, sensor, topic, payload, ergebnis, is_event from messages where ts >= $1 order by id', [since || new Date(0)]);
      return r.rows.map(x => JSON.stringify({ ts: x.ts.toISOString(), sensor: x.sensor, topic: x.topic, payload: x.payload, ergebnis: x.ergebnis, is_event: x.is_event })).join('\n') + (r.rows.length ? '\n' : '');
    },
    async close() { await pool.end(); }
  };
}

module.exports = function createStore(env, dataDir) {
  return env.DATABASE_URL || env.PGHOST ? pgStore(env.DATABASE_URL) : fileStore(dataDir);
};
