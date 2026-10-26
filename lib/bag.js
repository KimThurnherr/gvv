'use strict';
// Import der offiziellen Prämiendaten des BAG (opendata.swiss / priminfo.admin.ch).
// Quellen:
//  - Prämien_CH.csv und Tarife.csv über den Download-Server des BAG (opendata.bagnet.ch)
//  - Prämienregionen-XLSX und Verzeichnis der zugelassenen Krankenversicherer von priminfo.admin.ch

const { readXlsx } = require('./xlsx');

const BAGNET = 'https://opendata.bagnet.ch/?r=/download&path=';
const bagnetUrl = (p) => BAGNET + encodeURIComponent(Buffer.from(p, 'utf8').toString('base64'));
const SOURCES = {
  premiums: bagnetUrl('/Praemien/Prämien_CH.csv'),
  tariffs: bagnetUrl('/Praemien/Tarife.csv'),
  priminfo: 'https://www.priminfo.admin.ch/de/downloads/aktuell',
};
const UA = { 'User-Agent': 'gvv/1.0 (Prämienvergleich für den Eigengebrauch)' };

async function fetchBuf(url, timeoutMs = 300000) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`Download fehlgeschlagen (${r.status}): ${url}`);
  return Buffer.from(await r.arrayBuffer());
}

// Kopf der Prämiendatei abfragen, um Änderungen zu erkennen, ohne 25 MB zu laden
async function premiumsFingerprint() {
  const r = await fetch(SOURCES.premiums, { method: 'HEAD', headers: UA, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('HEAD ' + r.status);
  return [r.headers.get('etag'), r.headers.get('last-modified'), r.headers.get('content-length')].filter(Boolean).join('|');
}

// Einfacher CSV-Parser (Komma, Anführungszeichen, BOM)
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur.replace(/\r$/, '')); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur.length || row.length) { row.push(cur.replace(/\r$/, '')); rows.push(row); }
  return rows;
}
function objects(rows) {
  const head = rows[0].map(h => h.trim());
  return rows.slice(1).filter(r => r.length > 1).map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}

// Links zu den aktuellen XLSX-Dateien auf priminfo suchen
async function priminfoLinks() {
  const html = (await fetchBuf(SOURCES.priminfo, 60000)).toString('utf8');
  const abs = (p) => new URL(p, 'https://www.priminfo.admin.ch/').toString();
  const regionen = [...html.matchAll(/href="([^"]*praemienregionen-(\d{4})\.xlsx)"/g)].sort((a, b) => b[2] - a[2])[0];
  const kassen = [...html.matchAll(/href="([^"]*zugelassene-krankenversicherer-([\d-]+)\.xlsx)"/g)].sort((a, b) => b[2].localeCompare(a[2]))[0];
  if (!regionen || !kassen) throw new Error('Download-Links auf priminfo.admin.ch nicht gefunden');
  return { regionen: abs(regionen[1]), regionenJahr: +regionen[2], kassen: abs(kassen[1]) };
}

const franchiseAmount = (code) => { const m = /_(\d{4})$/.exec(code); return m ? +m[1] : null; };

// Adresse aus dem BAG-Verzeichnis aufbereiten: alles vor Tel./Fax/E-Mail/Web
function splitAddress(raw) {
  const lines = String(raw || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const addr = [], extra = {};
  for (const l of lines) {
    if (/^tel\.?/i.test(l)) extra.tel = l.replace(/^tel\.?\s*/i, '');
    else if (/^fax/i.test(l)) continue;
    else if (/@/.test(l)) extra.email = l;
    else if (/^www\.|^https?:/i.test(l)) extra.web = l.startsWith('http') ? l : 'https://' + l;
    else addr.push(l);
  }
  return { lines: addr, ...extra };
}
const cleanName = (s) => String(s || '').replace(/-\r?\n/g, '').replace(/\s*\r?\n\s*/g, ' ').trim();

// Kompletter Import; schreibt in die übergebene SQLite-Datenbank. Gibt eine Zusammenfassung zurück.
async function importAll(db, log = console.log) {
  log('BAG-Import: lade Prämien_CH.csv');
  const fp = await premiumsFingerprint().catch(() => '');
  const prem = objects(parseCsv((await fetchBuf(SOURCES.premiums)).toString('utf8')));
  if (!prem.length || !('Prämie' in prem[0]) || !('Tarifbezeichnung' in prem[0])) throw new Error('Unerwartetes Format der Prämiendatei');
  const years = [...new Set(prem.map(r => +r['Geschäftsjahr']))];
  if (years.length !== 1 || !years[0]) throw new Error('Prämiendatei enthält kein eindeutiges Jahr: ' + years.join(','));
  const year = years[0];

  log('BAG-Import: lade Tarife.csv');
  const tar = objects(parseCsv((await fetchBuf(SOURCES.tariffs, 60000)).toString('utf8')));

  log('BAG-Import: lade Regionen und Versichererverzeichnis');
  const links = await priminfoLinks();
  const reg = readXlsx(await fetchBuf(links.regionen, 120000), ['B_NPA']).B_NPA || [];
  const kas = readXlsx(await fetchBuf(links.kassen, 120000), ['Zugelassene Krankenversicherer', 'Index']);

  // Plausibilitätsprüfung vor dem Schreiben
  const regRows = reg.filter(r => /^\d{4}$/.test(r[1] || '') && /^[A-Z]{2}$/.test(r[3] || ''));
  if (regRows.length < 3000) throw new Error('Regionen-Datei unvollständig');
  if (links.regionenJahr !== year) log(`Hinweis: Regionen-Datei ist für ${links.regionenJahr}, Prämien für ${year}`);

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM premiums WHERE year=?').run(year);
    const ins = db.prepare('INSERT INTO premiums(year,insurer,canton,region,age_class,age_sub,accident,tariff,tariff_type,franchise,premium,tariff_name,is_base) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const r of prem) {
      ins.run(year, +r['Versicherer'], r['Kanton'], +String(r['Region']).replace(/\D/g, ''), r['Altersklasse'], r['Altersuntergruppe'],
        r['Unfalleinschluss'] === 'MIT_UNF' ? 1 : 0, r['Tarif'], r['Tariftyp'], franchiseAmount(r['Franchise']), +r['Prämie'], r['Tarifbezeichnung'],
        r['isBaseP'] === '1' && r['isBaseF'] === '1' ? 1 : 0);
    }
    db.prepare('DELETE FROM tariffs WHERE year=?').run(year);
    const it = db.prepare('INSERT OR REPLACE INTO tariffs(year,insurer,category,tariff,tariff_type,name) VALUES(?,?,?,?,?,?)');
    for (const t of tar) if (+t['Geschäftsjahr'] === year) it.run(year, +t['Versicherer'], t['Kategorie'], t['Tarif'], t['Tariftyp'], t['Name_DE']);

    db.prepare('DELETE FROM regions WHERE year=?').run(year);
    const ir = db.prepare('INSERT OR IGNORE INTO regions(year,plz,ort,canton,region,bfs,gemeinde) VALUES(?,?,?,?,?,?,?)');
    for (const r of regRows) ir.run(year, +r[1], r[2], r[3], +r[4], +r[5], r[6]);

    const idx = {};
    for (const r of (kas['Index'] || [])) if (/^\d+$/.test(String(r[1] || ''))) idx[+r[1]] = r[3];
    const iu = db.prepare('INSERT INTO insurers(nr,short,name,address,tel,email,web,updated) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(nr) DO UPDATE SET short=excluded.short, name=excluded.name, address=excluded.address, tel=excluded.tel, email=excluded.email, web=excluded.web, updated=excluded.updated');
    let nIns = 0;
    for (const r of (kas['Zugelassene Krankenversicherer'] || [])) {
      if (!/^\d+$/.test(String(r[0] || ''))) continue;
      const a = splitAddress(r[3]);
      iu.run(+r[0], cleanName(idx[+r[0]] || r[2]), cleanName(r[2]), JSON.stringify(a.lines), a.tel || null, a.email || null, a.web || null, new Date().toISOString());
      nIns++;
    }
    db.prepare("INSERT INTO meta(k,v) VALUES('premiums_fp',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(fp);
    db.prepare("INSERT INTO meta(k,v) VALUES('import_' || ?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(String(year), new Date().toISOString());
    db.exec('COMMIT');
    log(`BAG-Import fertig: Jahr ${year}, ${prem.length} Prämien, ${tar.length} Tarife, ${regRows.length} PLZ-Einträge, ${nIns} Versicherer`);
    return { year, premiums: prem.length, tariffs: tar.length, regions: regRows.length, insurers: nIns };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { importAll, premiumsFingerprint, SOURCES, parseCsv, splitAddress };
