/*
 * Zugriffsschutz für Diagnose-Seiten und API.
 *
 *   DASHBOARD_USER + DASHBOARD_PASSWORD  -> Basic Auth für alles ausser /health
 *   HEARTBEAT_TOKEN                      -> nur GET /api/heartbeat mit ?token=… oder «Authorization: Bearer …»
 *
 * Direkte Zugriffe im LAN (private Absenderadresse, ohne X-Forwarded-For, also nicht über den Reverse Proxy)
 * brauchen keine Anmeldung. Alles, was über Traefik von aussen kommt, trägt X-Forwarded-For und muss sich anmelden.
 * Sind DASHBOARD_USER/PASSWORD nicht gesetzt, bleibt alles offen (wie bisher).
 */
const crypto = require('crypto');

const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const PRIVATE = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd)/i;

function createAuth(env) {
  const user = env.DASHBOARD_USER || '', pass = env.DASHBOARD_PASSWORD || '', token = env.HEARTBEAT_TOKEN || '';
  const enabled = !!(user && pass);

  function internal(req) {
    if (req.headers['x-forwarded-for'] || req.headers['forwarded'] || req.headers['x-real-ip']) return false;
    const a = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    return PRIVATE.test(a);
  }
  function basicOk(req) {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Basic ')) return false;
    const [u, ...p] = Buffer.from(h.slice(6), 'base64').toString().split(':');
    return same(u, user) & same(p.join(':'), pass) ? true : false;
  }
  function tokenOk(req, url) {
    if (!token || req.method !== 'GET' || url !== '/api/heartbeat') return false;
    const q = new URLSearchParams(req.url.split('?')[1] || '').get('token');
    const h = req.headers.authorization || '';
    return (q && same(q, token)) || (h.startsWith('Bearer ') && same(h.slice(7), token));
  }

  /** true = weiter, false = Antwort 401 wurde gesendet */
  function check(req, res, url) {
    if (!enabled || url === '/health' || internal(req) || basicOk(req) || tokenOk(req, url)) return true;
    res.writeHead(401, { 'www-authenticate': 'Basic realm="Briefkasten-Diagnose", charset="UTF-8"', 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end('Anmeldung erforderlich');
    return false;
  }
  return { check, enabled, internal, tokenOk, basicOk };
}

module.exports = createAuth;
