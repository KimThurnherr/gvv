'use strict';
// gvv - Grundversicherungsvergleich für den Haushalt.
// Vergleicht jedes Jahr die offiziellen BAG-Prämien, schlägt einen Wechsel vor und bereitet
// Kündigung, Antragsdaten und Checkliste vor. Kein automatischer Versand nach aussen.
// Keine externen Abhängigkeiten: node:http, node:sqlite, node:crypto.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const bag = require('./lib/bag');

// ---------- Konfiguration ----------
const env = process.env;
const PORT = +(env.PORT || 8080);
const PUBLIC_URL = (env.PUBLIC_URL || 'http://localhost:8080').replace(/\/$/, '');
const DATA_DIR = env.DATA_DIR || path.join(__dirname, 'data');
const TZ = env.TZ || 'Europe/Zurich';
const GOOGLE_CLIENT_ID = env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = env.GOOGLE_CLIENT_SECRET || '';
const DEV_LOGIN = env.DEV_LOGIN === '1'; // nur lokal zum Testen
const AUTO_IMPORT = env.AUTO_IMPORT !== '0';
const SECURE_COOKIE = PUBLIC_URL.startsWith('https://');
// ALLOWED_USERS="alex:alex@example.com,sam:sam@example.com"
const USERS = Object.fromEntries((env.ALLOWED_USERS || '').split(',').map(s => s.trim()).filter(s => s.includes(':')).map(s => {
  const i = s.indexOf(':'); return [s.slice(0, i).trim().toLowerCase(), s.slice(i + 1).trim().toLowerCase()];
}));
const USER_NAMES = Object.fromEntries((env.USER_NAMES || '').split(',').filter(s => s.includes(':')).map(s => s.split(':').map(x => x.trim())).map(([k, v]) => [k.toLowerCase(), v]));
if (!Object.keys(USERS).length) console.warn('WARNUNG: ALLOWED_USERS ist leer, niemand kann sich anmelden.');

const MODEL_TYPES = { BASE: 'Standard', PRAXIS: 'Hausarzt / HMO', TEL_DIG: 'Telmed / digital', FLEX: 'Kombiniert / flexibel' };

// ---------- Datenbank ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'gvv.db'));
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS premiums (year INTEGER NOT NULL, insurer INTEGER NOT NULL, canton TEXT NOT NULL, region INTEGER NOT NULL, age_class TEXT, age_sub TEXT NOT NULL,
  accident INTEGER NOT NULL, tariff TEXT NOT NULL, tariff_type TEXT, franchise INTEGER NOT NULL, premium REAL NOT NULL, tariff_name TEXT, is_base INTEGER);
CREATE INDEX IF NOT EXISTS premiums_lookup ON premiums(year, canton, region, age_sub, accident, franchise);
CREATE TABLE IF NOT EXISTS tariffs (year INTEGER, insurer INTEGER, category TEXT, tariff TEXT, tariff_type TEXT, name TEXT, PRIMARY KEY (year, insurer, category, tariff));
CREATE TABLE IF NOT EXISTS regions (year INTEGER, plz INTEGER, ort TEXT, canton TEXT, region INTEGER, bfs INTEGER, gemeinde TEXT, PRIMARY KEY (year, plz, ort, bfs));
CREATE TABLE IF NOT EXISTS insurers (nr INTEGER PRIMARY KEY, short TEXT, name TEXT, address TEXT, tel TEXT, email TEXT, web TEXT, updated TEXT,
  letter_address TEXT, apply_url TEXT);
CREATE TABLE IF NOT EXISTS persons (id INTEGER PRIMARY KEY, data TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0, created_by TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS cases (year INTEGER NOT NULL, person_id INTEGER NOT NULL, data TEXT NOT NULL, updated_by TEXT, updated_at TEXT, PRIMARY KEY (year, person_id));
CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY, person_id INTEGER, at TEXT, by TEXT, text TEXT);
CREATE TABLE IF NOT EXISTS subs (endpoint TEXT PRIMARY KEY, user TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at TEXT);
CREATE TABLE IF NOT EXISTS push_sent (key TEXT PRIMARY KEY, at TEXT);
`);
const q = (sql) => db.prepare(sql);
const meta = {
  get: (k, d) => { const r = q('SELECT v FROM meta WHERE k=?').get(k); return r ? r.v : d; },
  set: (k, v) => q('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v)),
};

let SESSION_SECRET = env.SESSION_SECRET || meta.get('session_secret');
if (!SESSION_SECRET) { SESSION_SECRET = crypto.randomBytes(32).toString('hex'); meta.set('session_secret', SESSION_SECRET); }
let vapidJwk = meta.get('vapid_jwk');
if (!vapidJwk) {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  vapidJwk = JSON.stringify(privateKey.export({ format: 'jwk' }));
  meta.set('vapid_jwk', vapidJwk);
}
const VAPID_PRIVATE = crypto.createPrivateKey({ key: JSON.parse(vapidJwk), format: 'jwk' });
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(s, 'base64url');
const VAPID_PUBLIC = (() => { const j = JSON.parse(vapidJwk); return b64u(Buffer.concat([Buffer.from([4]), fromB64u(j.x), fromB64u(j.y)])); })();

const settings = () => {
  const d = { threshold: 120, household: { strasse: '', plz: '', ort: '' } };
  try { return { ...d, ...JSON.parse(meta.get('settings', '{}')) }; } catch { return d; }
};

// ---------- Zeit ----------
function localNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute };
}
const fmtDate = (s) => s ? s.slice(0, 10).split('-').reverse().join('.') : '';
const chf = (n) => n == null ? '' : 'CHF ' + n.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Kündigung der Grundversicherung bei Prämienänderung: muss bis 30.11. beim Versicherer sein (Art. 7 Abs. 2 KVG)
const deadlineFor = (year) => `${year - 1}-11-30`;
const daysUntil = (iso) => { const t = localNow().date; return Math.round((Date.parse(iso + 'T00:00:00Z') - Date.parse(t + 'T00:00:00Z')) / 864e5); };

// ---------- Daten-Helfer ----------
const years = () => q('SELECT DISTINCT year FROM premiums ORDER BY year DESC').all().map(r => r.year);
const latestYear = () => years()[0] || null;
const insurerRow = (nr) => q('SELECT * FROM insurers WHERE nr=?').get(nr);
const insurerShort = (nr) => insurerRow(nr)?.short || `Versicherer ${nr}`;
const loadPersons = () => q('SELECT * FROM persons ORDER BY sort, id').all().map(r => ({ id: r.id, ...JSON.parse(r.data) }));
const loadPerson = (id) => { const r = q('SELECT * FROM persons WHERE id=?').get(id); return r ? { id: r.id, ...JSON.parse(r.data) } : null; };
const loadCase = (year, pid) => { const r = q('SELECT * FROM cases WHERE year=? AND person_id=?').get(year, pid); return r ? { ...JSON.parse(r.data), updated_by: r.updated_by, updated_at: r.updated_at } : null; };
const saveCase = (year, pid, data, user) => q('INSERT INTO cases(year,person_id,data,updated_by,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(year,person_id) DO UPDATE SET data=excluded.data, updated_by=excluded.updated_by, updated_at=excluded.updated_at')
  .run(year, pid, JSON.stringify(data), user, new Date().toISOString());
const addHistory = (pid, user, text) => q('INSERT INTO history(person_id,at,by,text) VALUES(?,?,?,?)').run(pid, new Date().toISOString(), user, text);

const birthYear = (p) => p.geburtsdatum ? +p.geburtsdatum.slice(0, 4) : (+p.jahrgang || null);
function ageGroup(p, year) {
  const by = birthYear(p); if (!by) return null;
  const age = year - by;
  if (age <= 18) return { sub: 'K1', label: 'Kind' };
  if (age <= 25) return { sub: 'J1', label: 'Junge Erwachsene' };
  return { sub: 'E1', label: 'Erwachsene' };
}
// Prämienregion aus der Wohngemeinde; fällt auf das letzte bekannte Jahr zurück
function regionFor(p, year) {
  if (!p.bfs) return null;
  const r = q('SELECT canton, region, gemeinde FROM regions WHERE bfs=? AND year<=? ORDER BY year DESC LIMIT 1').get(+p.bfs, year)
    || q('SELECT canton, region, gemeinde FROM regions WHERE bfs=? ORDER BY year DESC LIMIT 1').get(+p.bfs);
  return r || null;
}
const tariffLabel = (row) => row.tariff_name || row.tariff;

// Kern: Vergleich für eine Person und ein Prämienjahr
function compare(p, year, limit = 15) {
  const out = { year, person: p.id, problems: [] };
  const ag = ageGroup(p, year), reg = regionFor(p, year);
  if (!ag) out.problems.push('Jahrgang fehlt');
  if (!reg) out.problems.push('Wohngemeinde fehlt');
  const fr = +p.franchise;
  if (ag && fr) {
    const allowed = ag.sub === 'K1' ? [0, 100, 200, 300, 400, 500, 600] : [300, 500, 1000, 1500, 2000, 2500];
    if (!allowed.includes(fr)) out.problems.push(`Franchise ${fr} gibt es für ${ag.label} nicht (möglich: ${allowed.join(', ')})`);
  }
  const models = Array.isArray(p.modelle) && p.modelle.length ? p.modelle : Object.keys(MODEL_TYPES);
  out.ageGroup = ag; out.region = reg; out.models = models;
  out.deadline = deadlineFor(year); out.daysLeft = daysUntil(out.deadline);
  if (out.problems.length) return out;

  const rows = q('SELECT insurer, tariff, tariff_type, premium, tariff_name FROM premiums WHERE year=? AND canton=? AND region=? AND age_sub=? AND accident=? AND franchise=? ORDER BY premium, insurer')
    .all(year, reg.canton, reg.region, ag.sub, p.unfall ? 1 : 0, fr);
  const exclI = new Set((p.ausgeschlosseneKassen || []).map(Number));
  const exclP = new Set(p.ausgeschlosseneProdukte || []);
  const shape = (r) => ({ insurer: r.insurer, insurerName: insurerShort(r.insurer), tariff: r.tariff, tariffName: tariffLabel(r), type: r.tariff_type, typeLabel: MODEL_TYPES[r.tariff_type] || r.tariff_type, monthly: r.premium, yearly: Math.round(r.premium * 12 * 100) / 100 });
  const current = p.versicherer && p.tarif ? rows.find(r => r.insurer === +p.versicherer && r.tariff === p.tarif) : null;
  if (p.versicherer && p.tarif && !current) out.problems.push('Aktuelles Produkt ist für dieses Jahr mit diesen Angaben nicht im BAG-Verzeichnis');
  const candidates = rows.filter(r => models.includes(r.tariff_type) && !exclI.has(r.insurer) && !exclP.has(`${r.insurer}|${r.tariff}`));
  out.totalOffers = rows.length; out.matchingOffers = candidates.length;
  out.current = current ? shape(current) : null;
  out.list = candidates.slice(0, limit).map(shape);
  const best = candidates[0] ? shape(candidates[0]) : null;
  out.best = best;
  if (current) {
    const rank = candidates.findIndex(r => r === current);
    out.currentRank = rank >= 0 ? rank + 1 : null;
    if (out.currentRank && out.currentRank > limit) out.list.push(out.current);
  }
  if (best && out.current) {
    out.savingsMonthly = Math.round((out.current.monthly - best.monthly) * 100) / 100;
    out.savingsYearly = Math.round(out.savingsMonthly * 12 * 100) / 100;
    const same = best.insurer === out.current.insurer && best.tariff === out.current.tariff;
    out.recommendation = same || out.savingsYearly < settings().threshold ? 'bleiben' : 'wechseln';
    out.sameInsurer = best.insurer === out.current.insurer;
  } else out.recommendation = out.current ? 'bleiben' : 'unvollständig';
  return out;
}

// Schritte je nach Art des Wechsels
function stepsFor(decision, person) {
  if (!decision || decision.stay) return [];
  if (+decision.insurer === +(decision.fromInsurer ?? person.versicherer)) return [
    { key: 'modellwechsel', label: 'Modellwechsel bei der Kasse beantragt (Brief oder Kundenportal)' },
    { key: 'police', label: 'Neue Police mit dem neuen Modell erhalten' },
  ];
  return [
    { key: 'antrag', label: 'Antrag bei der neuen Kasse gestellt' },
    { key: 'kuendigung', label: 'Kündigung eingeschrieben an die bisherige Kasse geschickt' },
    { key: 'bestaetigungAlt', label: 'Kündigungsbestätigung der bisherigen Kasse erhalten' },
    { key: 'police', label: 'Police der neuen Kasse erhalten' },
  ];
}
function caseView(p, year) {
  const c = loadCase(year, p.id) || {};
  const steps = stepsFor(c.decision, p).map(s => ({ ...s, done: !!c.steps?.[s.key]?.done, at: c.steps?.[s.key]?.at || null, by: c.steps?.[s.key]?.by || null }));
  return { decision: c.decision || null, steps, note: c.note || '', updated_by: c.updated_by || null, updated_at: c.updated_at || null, complete: steps.length > 0 && steps.every(s => s.done), applied: !!c.applied };
}

// ---------- Session ----------
function sign(v) { return crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('base64url'); }
function makeSession(user) { const v = b64u(JSON.stringify({ u: user, exp: Date.now() + 90 * 864e5 })); return v + '.' + sign(v); }
function parseCookies(req) { const o = {}; for (const p of (req.headers.cookie || '').split(';')) { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); } return o; }
function readSession(req) {
  const c = parseCookies(req).gvv_session; if (!c) return null;
  const [v, s] = c.split('.'); if (!v || !s) return null;
  const a = Buffer.from(sign(v)), b = Buffer.from(s);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const d = JSON.parse(fromB64u(v)); if (d.exp < Date.now() || !USERS[d.u]) return null; return d.u; } catch { return null; }
}
function cookie(name, val, maxAge) { return `${name}=${encodeURIComponent(val)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${SECURE_COOKIE ? '; Secure' : ''}`; }

// ---------- HTTP-Helfer ----------
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://accounts.google.com",
};
if (SECURE_COOKIE) SEC_HEADERS['Strict-Transport-Security'] = 'max-age=31536000';
function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...SEC_HEADERS, ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function redirect(res, loc, extra = {}) { res.writeHead(302, { Location: loc, ...SEC_HEADERS, ...extra }); res.end(); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 64 * 1024) { reject(new Error('too_large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch { reject(new Error('bad_json')); } });
    req.on('error', reject);
  });
}
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const int = (v, min, max) => { const n = Math.round(Number(v)); return v !== '' && v != null && Number.isFinite(n) && n >= min && n <= max ? n : null; };
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const rl = new Map();
function rateLimited(ip, limit = 30) { const now = Date.now(); const e = rl.get(ip) || { n: 0, t: now }; if (now - e.t > 6e5) { e.n = 0; e.t = now; } e.n++; rl.set(ip, e); return e.n > limit; }

// ---------- Statische Dateien ----------
const PUB = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
function serveStatic(res, rel) {
  const file = path.normalize(path.join(PUB, rel));
  if (!file.startsWith(PUB + path.sep)) return send(res, 404, 'Nicht gefunden', 'text/plain; charset=utf-8');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Nicht gefunden', 'text/plain; charset=utf-8');
    const ext = path.extname(file);
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': ext === '.png' ? 'public, max-age=86400' : 'no-cache', ...SEC_HEADERS, ...(rel === 'sw.js' ? { 'Service-Worker-Allowed': '/' } : {}) });
    res.end(buf);
  });
}

// ---------- Personen validieren ----------
function cleanPerson(b, old = {}) {
  const p = { ...old };
  p.vorname = str(b.vorname, 60); p.nachname = str(b.nachname, 60);
  if (!p.vorname) throw new Error('Vorname fehlt');
  p.geburtsdatum = isDate(b.geburtsdatum) ? b.geburtsdatum : '';
  p.jahrgang = p.geburtsdatum ? +p.geburtsdatum.slice(0, 4) : int(b.jahrgang, 1900, 2100);
  if (!p.jahrgang) throw new Error('Jahrgang oder Geburtsdatum fehlt');
  p.strasse = str(b.strasse, 100); p.plz = str(b.plz, 4); p.ort = str(b.ort, 60);
  p.bfs = int(b.bfs, 1, 99999);
  if (p.bfs && !q('SELECT 1 FROM regions WHERE bfs=? LIMIT 1').get(p.bfs)) throw new Error('Unbekannte Gemeinde');
  p.versicherer = int(b.versicherer, 1, 99999); p.tarif = str(b.tarif, 60) || null;
  p.versichertenNr = str(b.versichertenNr, 40); p.ahvNr = str(b.ahvNr, 20);
  p.franchise = int(b.franchise, 0, 2500);
  p.unfall = !!b.unfall;
  p.modelle = (Array.isArray(b.modelle) ? b.modelle : []).filter(m => MODEL_TYPES[m]);
  if (!p.modelle.length) throw new Error('Mindestens ein Modell wählen');
  p.ausgeschlosseneKassen = [...new Set((Array.isArray(b.ausgeschlosseneKassen) ? b.ausgeschlosseneKassen : []).map(Number).filter(n => n > 0))].slice(0, 100);
  p.ausgeschlosseneProdukte = [...new Set((Array.isArray(b.ausgeschlosseneProdukte) ? b.ausgeschlosseneProdukte : []).map(s => str(s, 80)).filter(s => /^\d+\|.+/.test(s)))].slice(0, 200);
  p.notiz = str(b.notiz, 1000);
  return p;
}

// ---------- API ----------
async function api(req, res, user, route, url) {
  const m = req.method;
  if (m !== 'GET' && req.headers['x-gvv'] !== '1') return send(res, 403, { error: 'csrf' });
  const yr = int(url.searchParams.get('year'), 2000, 2100) || latestYear();

  if (route === 'state' && m === 'GET') {
    const ys = years();
    return send(res, 200, {
      user, userName: USER_NAMES[user] || user, users: Object.keys(USERS).map(u => ({ id: u, name: USER_NAMES[u] || u })),
      years: ys, latestYear: ys[0] || null, imported: ys[0] ? meta.get('import_' + ys[0]) : null, importState,
      settings: settings(), modelTypes: MODEL_TYPES, vapidPublicKey: VAPID_PUBLIC, today: localNow().date,
      insurers: q('SELECT nr, short FROM insurers ORDER BY short COLLATE NOCASE').all(),
      persons: loadPersons(),
    });
  }
  if (route === 'overview' && m === 'GET') {
    if (!yr) return send(res, 200, { year: null, persons: [] });
    const persons = loadPersons().map(p => {
      const c = compare(p, yr, 3);
      return { person: p, cmp: { problems: c.problems, current: c.current, best: c.best, savingsYearly: c.savingsYearly, recommendation: c.recommendation, region: c.region, ageGroup: c.ageGroup, currentRank: c.currentRank, matchingOffers: c.matchingOffers }, case: caseView(p, yr) };
    });
    return send(res, 200, { year: yr, deadline: deadlineFor(yr), daysLeft: daysUntil(deadlineFor(yr)), persons });
  }
  if (route === 'compare' && m === 'GET') {
    const p = loadPerson(int(url.searchParams.get('person'), 1, 1e9)); if (!p) return send(res, 404, { error: 'Person nicht gefunden' });
    return send(res, 200, { ...compare(p, yr, int(url.searchParams.get('limit'), 1, 200) || 15), case: caseView(p, yr), personData: p });
  }
  if (route === 'gemeinden' && m === 'GET') {
    const plz = int(url.searchParams.get('plz'), 1000, 9999);
    if (!plz) return send(res, 200, []);
    const ly = latestYear();
    return send(res, 200, q('SELECT DISTINCT bfs, gemeinde, canton, region, ort FROM regions WHERE plz=? AND year=? ORDER BY gemeinde').all(plz, ly));
  }
  if (route === 'produkte' && m === 'GET') {
    // Produkte einer Kasse für das Profil (Region/Alter/Franchise/Unfall der Eingabe)
    const ins = int(url.searchParams.get('insurer'), 1, 99999), bfs = int(url.searchParams.get('bfs'), 1, 99999);
    const jg = int(url.searchParams.get('jahrgang'), 1900, 2100), fr = int(url.searchParams.get('franchise'), 0, 2500);
    const unf = url.searchParams.get('unfall') === '1' ? 1 : 0;
    if (!ins || !yr) return send(res, 200, []);
    const reg = bfs ? regionFor({ bfs }, yr) : null; const ag = jg ? ageGroup({ jahrgang: jg }, yr) : null;
    if (reg && ag && fr != null) {
      return send(res, 200, q('SELECT tariff, tariff_type, tariff_name, premium FROM premiums WHERE year=? AND insurer=? AND canton=? AND region=? AND age_sub=? AND accident=? AND franchise=? ORDER BY premium').all(yr, ins, reg.canton, reg.region, ag.sub, unf, fr)
        .map(r => ({ tariff: r.tariff, name: tariffLabel(r), type: r.tariff_type, typeLabel: MODEL_TYPES[r.tariff_type], monthly: r.premium })));
    }
    return send(res, 200, q("SELECT tariff, tariff_type, name FROM tariffs WHERE year=? AND insurer=? AND category='MOD' ORDER BY name").all(yr, ins)
      .map(r => ({ tariff: r.tariff, name: r.name, type: r.tariff_type, typeLabel: MODEL_TYPES[r.tariff_type], monthly: null })));
  }
  if (route === 'persons' && m === 'POST') {
    const b = await readBody(req);
    const id = int(b.id, 1, 1e9);
    try {
      if (id) {
        const old = loadPerson(id); if (!old) return send(res, 404, { error: 'Person nicht gefunden' });
        const { id: _, ...rest } = old;
        const p = cleanPerson(b, rest);
        q('UPDATE persons SET data=?, updated_at=? WHERE id=?').run(JSON.stringify(p), new Date().toISOString(), id);
        addHistory(id, user, 'Angaben geändert');
        return send(res, 200, { ok: true, id });
      }
      const p = cleanPerson(b);
      const sort = (q('SELECT max(sort) AS s FROM persons').get().s || 0) + 1;
      const r = q('INSERT INTO persons(data,sort,created_by,created_at,updated_at) VALUES(?,?,?,?,?)').run(JSON.stringify(p), sort, user, new Date().toISOString(), new Date().toISOString());
      addHistory(Number(r.lastInsertRowid), user, 'Person erfasst');
      return send(res, 200, { ok: true, id: Number(r.lastInsertRowid) });
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (route.startsWith('persons/') && m === 'DELETE') {
    const id = int(route.split('/')[1], 1, 1e9); if (!id) return send(res, 400, { error: 'ID fehlt' });
    q('DELETE FROM cases WHERE person_id=?').run(id); q('DELETE FROM persons WHERE id=?').run(id); q('DELETE FROM history WHERE person_id=?').run(id);
    return send(res, 200, { ok: true });
  }
  if (route === 'decision' && m === 'POST') {
    const b = await readBody(req);
    const p = loadPerson(int(b.person, 1, 1e9)); const year = int(b.year, 2000, 2100);
    if (!p || !year) return send(res, 400, { error: 'Person oder Jahr fehlt' });
    const c = loadCase(year, p.id) || {};
    if (c.steps && Object.values(c.steps).some(s => s.done) && !b.force) return send(res, 409, { error: 'Es sind schon Schritte erledigt. Entscheid trotzdem ändern?' });
    if (b.clear) { saveCase(year, p.id, { note: c.note || '' }, user); addHistory(p.id, user, `Entscheid ${year} zurückgesetzt`); return send(res, 200, { ok: true }); }
    if (b.stay) {
      saveCase(year, p.id, { decision: { stay: true, at: new Date().toISOString(), by: user }, steps: {}, note: c.note || '' }, user);
      addHistory(p.id, user, `Entscheid ${year}: bleiben`); return send(res, 200, { ok: true });
    }
    const cmp = compare(p, year, 500);
    const pick = [...cmp.list, cmp.current].find(x => x && x.insurer === int(b.insurer, 1, 99999) && x.tariff === b.tariff);
    if (!pick) return send(res, 400, { error: 'Angebot nicht gefunden' });
    if (cmp.current && pick.insurer === cmp.current.insurer && pick.tariff === cmp.current.tariff) return send(res, 400, { error: 'Das ist das aktuelle Produkt. Für «bleiben» die entsprechende Schaltfläche nehmen.' });
    saveCase(year, p.id, { decision: { insurer: pick.insurer, insurerName: pick.insurerName, tariff: pick.tariff, tariffName: pick.tariffName, type: pick.type, monthly: pick.monthly, fromInsurer: p.versicherer, fromInsurerName: cmp.current?.insurerName || insurerShort(p.versicherer), fromTariff: p.tarif, fromTariffName: cmp.current?.tariffName || p.tarif, fromVersichertenNr: p.versichertenNr || '', fromMonthly: cmp.current?.monthly ?? null, at: new Date().toISOString(), by: user }, steps: {}, note: c.note || '' }, user);
    addHistory(p.id, user, `Entscheid ${year}: Wechsel zu ${pick.insurerName} ${pick.tariffName}`);
    return send(res, 200, { ok: true });
  }
  if (route === 'step' && m === 'POST') {
    const b = await readBody(req);
    const p = loadPerson(int(b.person, 1, 1e9)); const year = int(b.year, 2000, 2100);
    if (!p || !year) return send(res, 400, { error: 'Person oder Jahr fehlt' });
    const c = loadCase(year, p.id); if (!c?.decision || c.decision.stay) return send(res, 400, { error: 'Kein Wechsel entschieden' });
    const keys = stepsFor(c.decision, p).map(s => s.key); const key = str(b.key, 30);
    if (!keys.includes(key)) return send(res, 400, { error: 'Unbekannter Schritt' });
    c.steps = c.steps || {};
    const at = isDate(b.at) ? b.at : localNow().date;
    c.steps[key] = b.done ? { done: true, at, by: user } : { done: false };
    let applied = false;
    // Ist alles erledigt, gilt die neue Kasse als aktuelle Versicherung der Person
    if (keys.every(k => c.steps[k]?.done) && !c.applied) {
      const { id, ...rest } = p;
      if (+rest.versicherer !== +c.decision.insurer) rest.versichertenNr = ''; // neue Nummer steht auf der neuen Police
      rest.versicherer = c.decision.insurer; rest.tarif = c.decision.tariff;
      q('UPDATE persons SET data=?, updated_at=? WHERE id=?').run(JSON.stringify(rest), new Date().toISOString(), id);
      c.applied = true; applied = true;
      addHistory(id, user, `Wechsel ${year} abgeschlossen: neu bei ${c.decision.insurerName} ${c.decision.tariffName}`);
    }
    const { updated_by, updated_at, ...data } = c;
    saveCase(year, p.id, data, user);
    return send(res, 200, { ok: true, applied });
  }
  if (route === 'note' && m === 'POST') {
    const b = await readBody(req);
    const p = loadPerson(int(b.person, 1, 1e9)); const year = int(b.year, 2000, 2100);
    if (!p || !year) return send(res, 400, { error: 'Person oder Jahr fehlt' });
    const c = loadCase(year, p.id) || {}; const { updated_by, updated_at, ...data } = c;
    data.note = str(b.note, 2000); saveCase(year, p.id, data, user);
    return send(res, 200, { ok: true });
  }
  if (route.startsWith('insurers/') && m === 'GET') {
    const r = insurerRow(int(route.split('/')[1], 1, 99999)); if (!r) return send(res, 404, { error: 'Unbekannt' });
    return send(res, 200, { ...r, address: JSON.parse(r.address || '[]') });
  }
  if (route.startsWith('insurers/') && m === 'POST') {
    const nr = int(route.split('/')[1], 1, 99999); if (!insurerRow(nr)) return send(res, 404, { error: 'Unbekannt' });
    const b = await readBody(req);
    const url2 = str(b.apply_url, 300);
    if (url2 && !/^https:\/\//.test(url2)) return send(res, 400, { error: 'Link muss mit https:// beginnen' });
    q('UPDATE insurers SET letter_address=?, apply_url=? WHERE nr=?').run(str(b.letter_address, 400) || null, url2 || null, nr);
    return send(res, 200, { ok: true });
  }
  if (route === 'settings' && m === 'POST') {
    const b = await readBody(req); const s = settings();
    const t = int(b.threshold, 0, 5000); if (t != null) s.threshold = t;
    if (b.household) s.household = { strasse: str(b.household.strasse, 100), plz: str(b.household.plz, 4), ort: str(b.household.ort, 60) };
    meta.set('settings', JSON.stringify(s));
    return send(res, 200, { ok: true });
  }
  if (route === 'history' && m === 'GET') {
    return send(res, 200, q('SELECT * FROM history WHERE person_id=? ORDER BY id DESC LIMIT 50').all(int(url.searchParams.get('person'), 1, 1e9)));
  }
  if (route === 'import' && m === 'POST') {
    if (importState.running) return send(res, 200, { ok: true, running: true });
    runImport(user).catch(() => {});
    return send(res, 200, { ok: true, started: true });
  }
  if (route === 'push/subscribe' && m === 'POST') {
    const b = await readBody(req);
    const ep = str(b.endpoint, 1000), p256dh = str(b.keys?.p256dh, 200), auth = str(b.keys?.auth, 100);
    if (!/^https:\/\//.test(ep) || !p256dh || !auth) return send(res, 400, { error: 'Ungültiges Abo' });
    q('INSERT INTO subs(endpoint,user,p256dh,auth,created_at) VALUES(?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user=excluded.user, p256dh=excluded.p256dh, auth=excluded.auth').run(ep, user, p256dh, auth, new Date().toISOString());
    return send(res, 200, { ok: true });
  }
  if (route === 'push/unsubscribe' && m === 'POST') { const b = await readBody(req); q('DELETE FROM subs WHERE endpoint=? AND user=?').run(str(b.endpoint, 1000), user); return send(res, 200, { ok: true }); }
  if (route === 'push/test' && m === 'POST') { const n = await pushToUser(user, { title: 'gvv', body: 'Test: Erinnerungen kommen auf diesem Gerät an.', tag: 'test' }); return send(res, 200, { ok: true, sent: n }); }
  return send(res, 404, { error: 'Unbekannt' });
}

// ---------- Druckseiten (Kündigung, Modellwechsel, Datenblatt) ----------
function printPage(title, body) {
  return `<!doctype html><html lang="de-CH"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><link rel="stylesheet" href="/print.css"></head><body>
<div class="noprint bar"><a href="/">Zurück</a><button type="button" id="printBtn">Drucken / als PDF speichern</button></div>${body}<script src="/print.js"></script></body></html>`;
}
function senderBlock(p) {
  const hh = settings().household;
  const strasse = p.strasse || hh.strasse, plz = p.plz || hh.plz, ort = p.ort || hh.ort;
  return [`${p.vorname} ${p.nachname}`.trim(), strasse, `${plz} ${ort}`.trim()].filter(Boolean);
}
function letterAddress(nr) {
  const r = insurerRow(nr); if (!r) return { lines: [`Versicherer ${nr}`], checked: false };
  if (r.letter_address) return { lines: r.letter_address.split(/\r?\n/).map(s => s.trim()).filter(Boolean), checked: true };
  return { lines: [r.name, ...JSON.parse(r.address || '[]')], checked: false };
}
function letterHtml(p, year, kind, d) {
  const sender = senderBlock(p);
  const target = letterAddress(kind === 'kuendigung' ? (d.fromInsurer ?? p.versicherer) : d.insurer);
  const vnr = d.fromVersichertenNr ?? p.versichertenNr;
  const today = localNow();
  const place = (p.ort || settings().household.ort || '').trim();
  const who = `${p.vorname} ${p.nachname}`.trim();
  const ident = [p.geburtsdatum ? `geboren am ${fmtDate(p.geburtsdatum)}` : `Jahrgang ${p.jahrgang}`, vnr ? `Versicherten-Nr. ${vnr}` : null].filter(Boolean).join(', ');
  let subject, text;
  if (kind === 'kuendigung') {
    subject = 'Kündigung der obligatorischen Krankenpflegeversicherung (Grundversicherung)';
    text = `<p>Sehr geehrte Damen und Herren</p>
<p>Hiermit kündige ich die obligatorische Krankenpflegeversicherung nach KVG für die folgende Person fristgerecht per 31. Dezember ${year - 1}:</p>
<p class="ident"><strong>${esc(who)}</strong><br>${esc(ident)}</p>
<p>Die Kündigung betrifft ausschliesslich die Grundversicherung. Allfällige Zusatzversicherungen laufen unverändert weiter.</p>
<p>Die neue Versicherung ab 1. Januar ${year} wird Ihnen der neue Versicherer bestätigen.</p>
<p>Bitte bestätigen Sie mir den Erhalt dieser Kündigung schriftlich.</p>
<p>Freundliche Grüsse</p>`;
  } else {
    subject = 'Wechsel des Versicherungsmodells in der Grundversicherung';
    text = `<p>Sehr geehrte Damen und Herren</p>
<p>Für die folgende Person beantrage ich per 1. Januar ${year} den Wechsel in der obligatorischen Krankenpflegeversicherung auf das Modell <strong>${esc(d.tariffName)}</strong>:</p>
<p class="ident"><strong>${esc(who)}</strong><br>${esc(ident)}</p>
<p>Franchise CHF ${esc(String(p.franchise))}, ${p.unfall ? 'mit' : 'ohne'} Unfalldeckung. Allfällige Zusatzversicherungen bleiben unverändert.</p>
<p>Bitte senden Sie mir die neue Police zu.</p>
<p>Freundliche Grüsse</p>`;
  }
  const warn = target.checked ? '' : `<div class="noprint warn">Adresse aus dem BAG-Verzeichnis (Hauptsitz). Viele Kassen wollen Kündigungen an eine andere Postadresse. Bitte auf der Police oder Webseite prüfen und unter «Einstellungen» bei der Kasse hinterlegen.</div>`;
  return printPage(subject, `${warn}<article class="letter">
<div class="sender">${sender.map(esc).join('<br>')}</div>
<div class="recipient">${kind === 'kuendigung' ? '<div class="mode">Einschreiben</div>' : ''}${target.lines.map(esc).join('<br>')}</div>
<div class="date">${esc(place ? place + ', ' : '')}${today.day}. ${['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'][today.month - 1]} ${today.year}</div>
<h1>${esc(subject)}</h1>${text}
<div class="sign"><div class="line"></div>${esc(who)}</div></article>`);
}
function datasheetHtml(p, year, d) {
  const ins = insurerRow(d.insurer);
  const reg = regionFor(p, year), ag = ageGroup(p, year);
  const rows = [
    ['Neue Kasse', `${ins?.name || d.insurerName} (BAG-Nr. ${d.insurer})`], ['Produkt / Modell', `${d.tariffName} (${MODEL_TYPES[d.type] || d.type})`],
    ['Versicherungsbeginn', `1. Januar ${year}`], ['Franchise', `CHF ${p.franchise}`], ['Unfalldeckung', p.unfall ? 'mit Unfall' : 'ohne Unfall (über Arbeitgeber versichert)'],
    ['Prämie laut BAG', `${chf(d.monthly)} pro Monat`],
    ['Name', `${p.vorname} ${p.nachname}`], ['Geburtsdatum', p.geburtsdatum ? fmtDate(p.geburtsdatum) : `Jahrgang ${p.jahrgang} (Datum ergänzen)`],
    ['AHV-Nummer', p.ahvNr || '(ergänzen, steht auf der Versichertenkarte)'], ['Adresse', senderBlock(p).slice(1).join(', ')],
    ['Wohngemeinde / Region', reg ? `${reg.gemeinde}, ${reg.canton}, Prämienregion ${reg.region}` : ''], ['Altersgruppe', ag?.label || ''],
    ['Bisherige Kasse', `${insurerShort(d.fromInsurer ?? p.versicherer)}${(d.fromVersichertenNr ?? p.versichertenNr) ? ', Versicherten-Nr. ' + (d.fromVersichertenNr ?? p.versichertenNr) : ''}`],
  ];
  const link = ins?.apply_url || ins?.web;
  return printPage('Antragsdaten ' + p.vorname, `<article class="sheet"><h1>Antragsdaten ${esc(p.vorname)} ${esc(p.nachname)} für ${year}</h1>
<table>${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>
${link ? `<p class="noprint">Antrag online: <a href="${esc(link)}" target="_blank" rel="noopener noreferrer">${esc(link)}</a></p>` : ''}
<p class="hint">Die Grundversicherung muss jede Person aufnehmen, ohne Gesundheitsfragen. Fragen nach Zusatzversicherungen kann man ablehnen.</p></article>`);
}
function printRoute(req, res, url, user) {
  const p = loadPerson(int(url.searchParams.get('person'), 1, 1e9)); const year = int(url.searchParams.get('year'), 2000, 2100);
  if (!p || !year) return send(res, 404, 'Nicht gefunden', 'text/plain; charset=utf-8');
  const c = loadCase(year, p.id);
  if (!c?.decision || c.decision.stay) return send(res, 400, 'Für diese Person ist kein Wechsel entschieden.', 'text/plain; charset=utf-8');
  const kind = url.pathname.slice(1);
  const same = +c.decision.insurer === +(c.decision.fromInsurer ?? p.versicherer);
  if (kind === 'brief') return send(res, 200, letterHtml(p, year, same ? 'modell' : 'kuendigung', c.decision), 'text/html; charset=utf-8');
  if (kind === 'datenblatt') return send(res, 200, datasheetHtml(p, year, c.decision), 'text/html; charset=utf-8');
  return send(res, 404, 'Nicht gefunden', 'text/plain; charset=utf-8');
}

// ---------- Web Push (RFC 8291 / RFC 8292) ----------
function hmac(key, data) { return crypto.createHmac('sha256', key).update(data).digest(); }
function encryptPayload(sub, payload) {
  const uaPub = fromB64u(sub.p256dh), authSecret = fromB64u(sub.auth);
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const asPub = ecdh.getPublicKey(); const shared = ecdh.computeSecret(uaPub);
  const salt = crypto.randomBytes(16);
  const prkKey = hmac(authSecret, shared);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPub.length]), asPub, ct]);
}
function vapidAuth(endpoint) {
  const aud = new URL(endpoint).origin;
  const h = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const p = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT || PUBLIC_URL }));
  const sig = crypto.sign('sha256', Buffer.from(h + '.' + p), { key: VAPID_PRIVATE, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${h}.${p}.${b64u(sig)}, k=${VAPID_PUBLIC}`;
}
async function sendPush(sub, data) {
  const body = encryptPayload(sub, JSON.stringify(data));
  const r = await fetch(sub.endpoint, { method: 'POST', headers: { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'normal', Authorization: vapidAuth(sub.endpoint) }, body });
  if (r.status === 404 || r.status === 410) { q('DELETE FROM subs WHERE endpoint=?').run(sub.endpoint); return false; }
  if (!r.ok) { console.error('Push fehlgeschlagen', r.status, (await r.text()).slice(0, 200)); return false; }
  return true;
}
async function pushToUser(user, data) {
  let n = 0;
  for (const s of q('SELECT * FROM subs WHERE user=?').all(user)) { try { if (await sendPush(s, data)) n++; } catch (e) { console.error('Push-Fehler', e.message); } }
  return n;
}
async function pushAll(data) { let n = 0; for (const u of Object.keys(USERS)) n += await pushToUser(u, data); return n; }
// Jede Erinnerung nur einmal (Schlüssel)
async function pushOnce(key, data) {
  if (q('SELECT 1 FROM push_sent WHERE key=?').get(key)) return;
  q('INSERT INTO push_sent(key,at) VALUES(?,?)').run(key, new Date().toISOString());
  await pushAll(data);
}

// ---------- Import und Erinnerungen ----------
const importState = { running: false, lastError: null, lastRun: null, lastResult: null };
async function runImport(by = 'auto') {
  if (importState.running) return;
  importState.running = true; importState.lastError = null;
  const before = latestYear();
  try {
    const r = await bag.importAll(db, (s) => console.log(s));
    importState.lastResult = r;
    if (before && r.year > before) {
      const sav = loadPersons().map(p => ({ p, c: compare(p, r.year) })).filter(x => x.c.recommendation === 'wechseln');
      const body = sav.length ? sav.map(x => `${x.p.vorname}: ${chf(x.c.savingsYearly)} pro Jahr sparen`).join(', ') : 'Kein Wechsel nötig, alle sind schon günstig versichert.';
      await pushOnce('newyear:' + r.year, { title: `Prämien ${r.year} sind da`, body, tag: 'newyear', url: '/' });
    }
  } catch (e) {
    importState.lastError = e.message; console.error('Import-Fehler', e);
  } finally { importState.running = false; importState.lastRun = new Date().toISOString(); console.log('Import beendet durch', by); }
}
async function checkForNewData() {
  if (!AUTO_IMPORT || importState.running) return;
  try {
    const fp = await bag.premiumsFingerprint();
    if (!latestYear() || (fp && fp !== meta.get('premiums_fp', ''))) await runImport('auto');
  } catch (e) { console.error('Prüfung auf neue Prämien fehlgeschlagen', e.message); }
}
// Tage, an denen vor der Frist erinnert wird (Oktober/November), danach täglich in der letzten Woche
const REMIND_DAYS = new Set(['10-15', '11-01', '11-10', '11-17', '11-22', '11-24', '11-25', '11-26', '11-27', '11-28', '11-29', '11-30']);
async function reminders() {
  const now = localNow(); const md = now.date.slice(5);
  const y = latestYear(); if (!y) return;
  const deadline = deadlineFor(y);
  if (now.date <= deadline && REMIND_DAYS.has(md)) {
    const open = [];
    for (const p of loadPersons()) {
      const c = caseView(p, y), cmp = compare(p, y);
      if (!c.decision && cmp.recommendation === 'wechseln') open.push(`${p.vorname}: Entscheid offen (${chf(cmp.savingsYearly)} pro Jahr)`);
      else if (c.decision && !c.decision.stay) {
        const kStep = c.steps.find(s => s.key === 'kuendigung' || s.key === 'modellwechsel');
        if (kStep && !kStep.done) open.push(`${p.vorname}: ${kStep.key === 'kuendigung' ? 'Kündigung' : 'Modellwechsel'} noch nicht verschickt`);
      }
    }
    if (open.length) await pushOnce(`frist:${y}:${now.date}`, { title: `Frist ${fmtDate(deadline)}: noch ${daysUntil(deadline)} Tage`, body: open.join(' · '), tag: 'frist', url: '/' });
  }
  if (['12-15', '12-22'].includes(md) && now.year === y - 1) {
    const open = [];
    for (const p of loadPersons()) {
      const c = caseView(p, y); if (!c.decision || c.decision.stay) continue;
      const s = c.steps.find(x => x.key === 'bestaetigungAlt'); if (s && !s.done && c.steps.find(x => x.key === 'kuendigung')?.done) open.push(`${p.vorname}: Kündigungsbestätigung fehlt noch`);
      const pol = c.steps.find(x => x.key === 'police'); if (pol && !pol.done) open.push(`${p.vorname}: neue Police fehlt noch`);
    }
    if (open.length) await pushOnce(`nachfassen:${y}:${now.date}`, { title: 'Krankenkasse nachfassen', body: open.join(' · '), tag: 'nachfassen', url: '/' });
  }
}
// Einmal pro Tag: um 4 Uhr auf neue BAG-Daten prüfen, ab 9:30 Uhr Erinnerungen (pushOnce verhindert Doppelte)
const ran = { check: '', remind: '' };
setInterval(() => {
  const n = localNow();
  if (n.hour === 4 && ran.check !== n.date) { ran.check = n.date; checkForNewData(); }
  if ((n.hour > 9 || (n.hour === 9 && n.minute >= 30)) && n.hour < 20 && ran.remind !== n.date) { ran.remind = n.date; reminders().catch(e => console.error('Erinnerungen', e)); }
}, 60 * 1000);

// ---------- Google-Login ----------
const REDIRECT_URI = PUBLIC_URL + '/auth/callback';
function loginStart(res) {
  if (!GOOGLE_CLIENT_ID) return send(res, 500, 'Google-Login ist nicht konfiguriert.', 'text/plain; charset=utf-8');
  const st = crypto.randomBytes(16).toString('hex');
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.search = new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: 'code', scope: 'openid email', state: st, prompt: 'select_account' });
  redirect(res, u.toString(), { 'Set-Cookie': cookie('gvv_state', st, 600) });
}
async function loginCallback(req, res, url) {
  const ip = req.headers['x-real-ip'] || req.socket.remoteAddress;
  if (rateLimited(ip)) return send(res, 429, 'Zu viele Versuche. Bitte später nochmals.', 'text/plain; charset=utf-8');
  const st = parseCookies(req).gvv_state, code = url.searchParams.get('code');
  if (!st || st !== url.searchParams.get('state') || !code) return redirect(res, '/?login=fehler');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, redirect_uri: REDIRECT_URI, grant_type: 'authorization_code' }) });
  if (!r.ok) { console.error('Token-Fehler', r.status); return redirect(res, '/?login=fehler'); }
  const tok = await r.json();
  let claims; try { claims = JSON.parse(fromB64u(tok.id_token.split('.')[1])); } catch { return redirect(res, '/?login=fehler'); }
  // id_token kommt direkt von Google über TLS mit Client-Secret: Claims prüfen
  if (claims.aud !== GOOGLE_CLIENT_ID || !['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss) || claims.exp * 1000 < Date.now() || !claims.email_verified) return redirect(res, '/?login=fehler');
  const email = String(claims.email).toLowerCase();
  const user = Object.keys(USERS).find(k => USERS[k] === email);
  if (!user) { console.warn('Login abgelehnt für', email); return redirect(res, '/?login=nicht-erlaubt', { 'Set-Cookie': cookie('gvv_state', '', 0) }); }
  res.setHeader('Set-Cookie', [cookie('gvv_session', makeSession(user), 90 * 86400), cookie('gvv_state', '', 0)]);
  redirect(res, '/');
}

// ---------- Server ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, PUBLIC_URL);
    const p = url.pathname;
    if (p === '/healthz') return send(res, 200, { ok: true });
    if (p === '/auth/login') return loginStart(res);
    if (p === '/auth/callback') return await loginCallback(req, res, url);
    if (p === '/auth/dev' && DEV_LOGIN) { const u = url.searchParams.get('u'); if (USERS[u]) return redirect(res, '/', { 'Set-Cookie': cookie('gvv_session', makeSession(u), 86400) }); }
    if (p === '/auth/logout' && req.method === 'POST') return send(res, 200, { ok: true }, undefined, { 'Set-Cookie': cookie('gvv_session', '', 0) });
    if (p.startsWith('/api/')) {
      const user = readSession(req);
      if (!user) return send(res, 401, { error: 'Nicht angemeldet' });
      return await api(req, res, user, p.slice(5).replace(/\/$/, ''), url);
    }
    if (p === '/brief' || p === '/datenblatt') {
      const user = readSession(req); if (!user) return redirect(res, '/');
      return printRoute(req, res, url, user);
    }
    if (p === '/' || p === '/index.html') return serveStatic(res, 'index.html');
    return serveStatic(res, p.slice(1));
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, e.message === 'too_large' ? 413 : e.message === 'bad_json' ? 400 : 500, { error: 'Fehler' });
  }
});
server.listen(PORT, () => {
  console.log(`gvv läuft auf Port ${PORT} (${PUBLIC_URL})`);
  if (AUTO_IMPORT && !latestYear()) runImport('start');
});

module.exports = { compare, db };
