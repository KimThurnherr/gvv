'use strict';
// Minimaler XLSX-Leser ohne Abhängigkeiten: liest die Zip-Struktur, entpackt die
// benötigten XML-Teile mit zlib und liefert die Zellwerte als Text pro Zeile.

const zlib = require('node:zlib');

function unzip(buf) {
  // End of Central Directory suchen
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Keine gültige XLSX-Datei');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Defektes Zip-Verzeichnis');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    files[name] = { method, csize, local };
    p += 46 + nameLen + extraLen + commentLen;
  }
  return (name) => {
    const f = files[name]; if (!f) return null;
    const lnl = buf.readUInt16LE(f.local + 26), lel = buf.readUInt16LE(f.local + 28);
    const start = f.local + 30 + lnl + lel;
    const data = buf.subarray(start, start + f.csize);
    if (f.method === 0) return data.toString('utf8');
    if (f.method === 8) return zlib.inflateRawSync(data).toString('utf8');
    throw new Error('Unbekannte Kompression ' + f.method);
  };
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENT[e] ?? m;
  });
}
const textOf = (xml) => { let out = ''; for (const m of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) out += m[1]; return decode(out); };

function colIndex(ref) {
  const letters = ref.replace(/\d+/g, ''); let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// Liefert { sheetName: [[zelle, ...], ...] } nur für die gewünschten Blätter (oder alle).
function readXlsx(buf, wanted) {
  const get = unzip(buf);
  const shared = [];
  const ss = get('xl/sharedStrings.xml');
  if (ss) for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(textOf(m[1]));
  const wb = get('xl/workbook.xml');
  const rels = get('xl/_rels/workbook.xml.rels') || '';
  const relMap = {};
  for (const m of rels.matchAll(/<Relationship\s[^>]*>/g)) {
    const id = /Id="([^"]+)"/.exec(m[0])?.[1], target = /Target="([^"]+)"/.exec(m[0])?.[1];
    if (id && target) relMap[id] = target.replace(/^\/?xl\//, '').replace(/^\//, '');
  }
  const out = {};
  for (const m of wb.matchAll(/<sheet\s[^>]*\/>/g)) {
    const name = decode(/name="([^"]*)"/.exec(m[0])[1]);
    const rid = /r:id="([^"]+)"/.exec(m[0])[1];
    if (wanted && !wanted.some(w => name.trim() === w)) continue;
    const xml = get('xl/' + relMap[rid]); if (!xml) continue;
    const rows = [];
    for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const row = [];
      for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1], inner = c[2] || '';
        const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1];
        const t = /t="(\w+)"/.exec(attrs)?.[1];
        let v = null;
        const vm = /<v>([\s\S]*?)<\/v>/.exec(inner);
        if (t === 's' && vm) v = shared[+vm[1]];
        else if (t === 'inlineStr') v = textOf(inner);
        else if (vm) v = decode(vm[1]);
        row[ref ? colIndex(ref) : row.length] = v;
      }
      rows.push(row);
    }
    out[name.trim()] = rows;
  }
  return out;
}

module.exports = { readXlsx };
