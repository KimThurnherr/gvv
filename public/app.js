'use strict';
const $ = (id) => document.getElementById(id);
const S = { state: null, year: null, tab: 'overview', overview: null };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const chf = (n) => n == null ? '–' : 'CHF ' + Number(n).toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const chf0 = (n) => n == null ? '–' : 'CHF ' + Math.round(n).toLocaleString('de-CH');
const fmtDate = (s) => s ? s.slice(0, 10).split('-').reverse().join('.') : '';
function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 3200); }

async function call(method, path, body) {
  const r = await fetch('/api/' + path, { method, headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'x-gvv': '1' }, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  if (r.status === 401) { showLogin(); throw new Error('Nicht angemeldet'); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(d.error || 'Fehler ' + r.status); e.status = r.status; throw e; }
  return d;
}
function showLogin() {
  $('app').hidden = true; $('login').hidden = false;
  const m = new URLSearchParams(location.search).get('login');
  $('loginMsg').textContent = m === 'nicht-erlaubt' ? 'Dieses Google-Konto ist nicht freigeschaltet.' : m === 'fehler' ? 'Anmeldung fehlgeschlagen. Bitte nochmals.' : '';
}

async function load() {
  S.state = await call('GET', 'state');
  $('login').hidden = true; $('app').hidden = false;
  if (!S.year || !S.state.years.includes(S.year)) S.year = S.state.latestYear;
  $('yearSel').innerHTML = S.state.years.map(y => `<option value="${y}"${y === S.year ? ' selected' : ''}>${y}</option>`).join('') || '<option>–</option>';
  $('whoami').textContent = 'Angemeldet als ' + S.state.userName;
  await render();
  if (S.state.importState.running) setTimeout(() => load().catch(() => {}), 8000);
}

function renderStatus() {
  const st = S.state, el = $('status');
  if (!st.latestYear) { el.innerHTML = st.importState.running ? 'Lade die Prämiendaten vom BAG, das dauert etwa eine Minute …' : 'Noch keine Prämiendaten. Unter «Einstellungen» laden.'; return; }
  const ov = S.overview;
  const dl = ov ? ov.daysLeft : null;
  let frist = '';
  if (ov) frist = dl >= 0 ? ` · Kündigung bis <strong>${fmtDate(ov.deadline)}</strong> beim Versicherer, noch ${dl} ${dl === 1 ? 'Tag' : 'Tage'}` : ` · <span class="late">Frist ${fmtDate(ov.deadline)} vorbei</span>`;
  el.innerHTML = `BAG-Prämien ${S.year}${frist}`;
}

async function render() {
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.tab === S.tab);
  for (const t of ['overview', 'persons', 'settings']) $('tab-' + t).hidden = t !== S.tab;
  if (S.year) S.overview = await call('GET', 'overview?year=' + S.year); else S.overview = null;
  renderStatus();
  if (S.tab === 'overview') renderOverview();
  if (S.tab === 'persons') renderPersons();
  if (S.tab === 'settings') renderSettings();
}

// ---------- Übersicht ----------
function recoBadge(c, cs) {
  if (cs.decision?.stay) return '<span class="badge">Bleibt</span>';
  if (cs.decision) return cs.complete ? '<span class="badge good">Wechsel erledigt</span>' : '<span class="badge warn">Wechsel läuft</span>';
  if (c.problems.length) return '<span class="badge bad">Angaben fehlen</span>';
  if (c.recommendation === 'wechseln') return `<span class="badge good">spart ${chf0(c.savingsYearly)} / Jahr</span>`;
  if (c.recommendation === 'bleiben') return '<span class="badge">Bleiben</span>';
  return '<span class="badge warn">Kasse erfassen</span>';
}
function renderOverview() {
  const el = $('tab-overview'), ov = S.overview;
  if (!ov || !ov.persons.length) {
    el.innerHTML = `<div class="card empty"><p>Noch niemand erfasst.</p><button class="btn primary" id="firstPerson">Person erfassen</button></div>`;
    $('firstPerson').onclick = () => editPerson(null);
    return;
  }
  const total = ov.persons.reduce((s, x) => s + (x.case.decision?.stay ? 0 : x.case.decision ? Math.max(0, ((x.case.decision.fromMonthly ?? x.case.decision.monthly) - x.case.decision.monthly) * 12) : x.cmp.recommendation === 'wechseln' ? x.cmp.savingsYearly : 0), 0);
  el.innerHTML = (total > 0 ? `<div class="card"><strong>Sparpotenzial ${S.year}: ${chf0(total)} pro Jahr</strong><div class="muted small">Summe der vorgeschlagenen oder entschiedenen Wechsel im Haushalt.</div></div>` : '') +
    ov.persons.map(({ person: p, cmp: c, case: cs }) => {
      const done = cs.steps.filter(s => s.done).length;
      const lines = [];
      if (cs.applied && cs.decision?.fromInsurerName) lines.push(['Bisher', `${esc(cs.decision.fromInsurerName)}, ${esc(cs.decision.fromTariffName)}${cs.decision.fromMonthly != null ? ' · ' + chf(cs.decision.fromMonthly) : ''}`]);
      else lines.push(['Heute', c.current ? `${esc(c.current.insurerName)}, ${esc(c.current.tariffName)} · ${chf(c.current.monthly)}` : '<span class="muted">nicht erfasst</span>']);
      if (cs.decision && !cs.decision.stay) lines.push(['Neu', `${esc(cs.decision.insurerName)}, ${esc(cs.decision.tariffName)} · ${chf(cs.decision.monthly)}`]);
      else if (c.best && c.recommendation === 'wechseln') lines.push(['Günstigste', `${esc(c.best.insurerName)}, ${esc(c.best.tariffName)} · ${chf(c.best.monthly)}`]);
      if (c.problems.length) lines.push(['Fehlt', esc(c.problems.join(', '))]);
      return `<div class="card pcard" tabindex="0" data-p="${p.id}">
        <div class="head"><span class="name">${esc(p.vorname)} ${esc(p.nachname)}</span>${recoBadge(c, cs)}</div>
        <div class="muted small">${esc(c.ageGroup?.label || '')}${c.region ? ' · ' + esc(c.region.gemeinde) + ', Region ' + esc(c.region.canton) + ' ' + c.region.region : ''} · Franchise ${esc(p.franchise)} · ${p.unfall ? 'mit' : 'ohne'} Unfall</div>
        <dl class="kv">${lines.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
        ${cs.steps.length ? `<div class="progress" title="${done} von ${cs.steps.length} Schritten"><i style="width:${Math.round(done / cs.steps.length * 100)}%"></i></div>` : ''}
      </div>`;
    }).join('');
  for (const c of el.querySelectorAll('.pcard')) {
    c.onclick = () => openCompare(+c.dataset.p);
    c.onkeydown = (e) => { if (e.key === 'Enter') openCompare(+c.dataset.p); };
  }
}

// ---------- Vergleich und Wechsel ----------
function openSheet(title, html) { $('sheetTitle').textContent = title; $('sheetBody').innerHTML = html; $('sheet').hidden = false; document.body.style.overflow = 'hidden'; }
function closeSheet() { $('sheet').hidden = true; $('sheetBody').innerHTML = ''; document.body.style.overflow = ''; }
$('sheetClose').onclick = closeSheet;
$('sheet').addEventListener('click', (e) => { if (e.target === $('sheet')) closeSheet(); });

async function openCompare(pid, limit = 15) {
  const d = await call('GET', `compare?year=${S.year}&person=${pid}&limit=${limit}`);
  const p = d.personData, cs = d.case;
  const name = `${p.vorname} ${p.nachname}`.trim();
  let h = '';
  if (d.problems.length) h += `<div class="notice">${esc(d.problems.join(' · '))}</div>`;
  h += `<div class="card"><dl class="kv">
    <dt>Profil</dt><dd>${esc(d.ageGroup?.label || '–')}, ${d.region ? esc(d.region.gemeinde) + ' (Region ' + esc(d.region.canton) + ' ' + d.region.region + ')' : '–'}</dd>
    <dt>Franchise</dt><dd>CHF ${esc(p.franchise)} · ${p.unfall ? 'mit' : 'ohne'} Unfall</dd>
    <dt>Modelle</dt><dd>${d.models.map(m => esc(S.state.modelTypes[m])).join(', ')}</dd>
    <dt>Heute</dt><dd>${d.current ? `${esc(d.current.insurerName)}, ${esc(d.current.tariffName)} · <strong>${chf(d.current.monthly)}</strong> pro Monat${d.currentRank ? ` · Platz ${d.currentRank} von ${d.matchingOffers}` : ''}` : 'nicht erfasst'}</dd>
  </dl>`;
  if (d.recommendation === 'wechseln' && d.best) h += `<p><strong>Vorschlag:</strong> ${esc(d.best.insurerName)}, ${esc(d.best.tariffName)} für ${chf(d.best.monthly)} pro Monat. Das spart <strong>${chf0(d.savingsYearly)} pro Jahr</strong>.${d.sameInsurer ? ' Gleiche Kasse, nur anderes Modell: keine Kündigung nötig.' : ''}</p>`;
  else if (d.recommendation === 'bleiben' && d.current) h += `<p><strong>Vorschlag: bleiben.</strong> ${d.best && d.savingsYearly > 0 ? `Die günstigste Alternative spart nur ${chf0(d.savingsYearly)} pro Jahr.` : 'Das aktuelle Produkt ist schon das günstigste passende.'}</p>`;
  h += '</div>';

  // Entscheid und Checkliste
  if (cs.decision) {
    h += '<div class="card">';
    if (cs.decision.stay) h += `<h3>Entscheid: bleiben</h3><p class="muted small">${esc(fmtDate(cs.decision.at))}</p>`;
    else {
      const same = cs.decision.insurer === cs.decision.fromInsurer;
      h += `<h3>Entscheid: ${esc(cs.decision.insurerName)}, ${esc(cs.decision.tariffName)}</h3>
      <p class="muted small">${chf(cs.decision.monthly)} pro Monat · entschieden am ${esc(fmtDate(cs.decision.at))}</p>
      <div class="row">
        <a class="btn primary" href="/brief?person=${pid}&year=${S.year}" target="_blank" rel="noopener">${same ? 'Brief Modellwechsel' : 'Kündigungsbrief'}</a>
        ${same ? '' : `<a class="btn" href="/datenblatt?person=${pid}&year=${S.year}" target="_blank" rel="noopener">Antragsdaten</a>`}
        <button class="btn" id="insInfo">Kasse: Adresse und Link</button>
      </div>
      ${same ? '' : `<p class="muted small">Reihenfolge: Antrag bei der neuen Kasse stellen und die Kündigung eingeschrieben schicken, so dass sie bis ${fmtDate(d.deadline)} bei der bisherigen Kasse ist. Die Kündigung wird erst wirksam, wenn die neue Kasse die Aufnahme bestätigt.</p>`}
      <ul class="steps">${cs.steps.map(s => `<li><label class="check"><input type="checkbox" data-step="${s.key}"${s.done ? ' checked' : ''}> ${esc(s.label)}</label>${s.done ? `<div class="when">${esc(fmtDate(s.at))}${s.by ? ' · ' + esc(userName(s.by)) : ''}</div>` : ''}</li>`).join('')}</ul>
      ${cs.complete ? '<p class="small"><strong>Alles erledigt.</strong> Die neue Kasse ist bei der Person als aktuelle Versicherung eingetragen.</p>' : ''}`;
    }
    h += `<label>Notiz <textarea id="caseNote" rows="2" maxlength="2000">${esc(cs.note)}</textarea></label>
      <div class="row"><button class="btn" id="saveNote">Notiz speichern</button><button class="btn ghost" id="clearDecision">Entscheid zurücksetzen</button></div></div>`;
  }

  // Rangliste
  const chosenKey = cs.decision && !cs.decision.stay ? `${cs.decision.insurer}|${cs.decision.tariff}` : '';
  h += `<div class="card"><h3>Günstigste passende Angebote ${S.year}</h3>
    <p class="muted small">${d.matchingOffers ?? 0} passende von ${d.totalOffers ?? 0} Angeboten in deiner Region. Monatsprämien laut BAG.</p>
    <ol class="offers">${(d.list || []).map((o, i) => {
      const k = `${o.insurer}|${o.tariff}`;
      const isCur = d.current && d.current.insurer === o.insurer && d.current.tariff === o.tariff;
      const rank = isCur && d.currentRank ? d.currentRank : i + 1;
      return `<li class="offer${isCur ? ' current' : ''}${k === chosenKey ? ' chosen' : ''}">
        <span class="rank">${rank}</span>
        <span class="what"><span class="ins">${esc(o.insurerName)}</span>${isCur ? ' <span class="badge">heute</span>' : ''}<div class="prod">${esc(o.tariffName)} · ${esc(o.typeLabel)}</div></span>
        <span class="price">${chf(o.monthly)}<small>${d.current && !isCur ? (o.monthly < d.current.monthly ? '−' : '+') + chf0(Math.abs(d.current.monthly - o.monthly) * 12) + '/J.' : chf0(o.yearly) + '/J.'}</small></span>
        <span class="acts">${isCur ? (cs.decision?.stay ? '' : '<button class="btn" data-stay="1">Bleiben</button>') : k === chosenKey ? '' : `<button class="btn" data-pick="${esc(k)}">Wählen</button>`}
          ${isCur ? '' : `<button class="btn ghost" data-exprod="${esc(k)}" title="Produkt künftig ausblenden">Produkt ausblenden</button><button class="btn ghost" data-exins="${o.insurer}" title="Kasse künftig ausblenden">Kasse ausblenden</button>`}</span>
      </li>`;
    }).join('')}</ol>
    ${(d.matchingOffers || 0) > limit ? '<button class="btn" id="more">Alle anzeigen</button>' : ''}
    ${!d.current && !d.problems.length ? '<p class="muted small">Damit ein Vorschlag möglich ist, bei der Person die aktuelle Kasse und das Produkt erfassen.</p>' : ''}
  </div>
  <div class="row"><button class="btn" id="editP">Angaben bearbeiten</button></div>`;
  openSheet(name, h);

  const body = $('sheetBody');
  const reload = () => openCompare(pid, limit).then(() => render()).catch(e => toast(e.message));
  const decide = async (payload) => {
    try { await call('POST', 'decision', { person: pid, year: S.year, ...payload }); }
    catch (e) {
      if (e.status === 409 && confirm(e.message)) await call('POST', 'decision', { person: pid, year: S.year, ...payload, force: true });
      else if (e.status !== 409) return toast(e.message); else return;
    }
    reload();
  };
  body.querySelectorAll('[data-pick]').forEach(b => b.onclick = () => { const [ins, ...t] = b.dataset.pick.split('|'); decide({ insurer: +ins, tariff: t.join('|') }); });
  body.querySelectorAll('[data-stay]').forEach(b => b.onclick = () => decide({ stay: true }));
  body.querySelectorAll('[data-exprod]').forEach(b => b.onclick = () => exclude(p, 'ausgeschlosseneProdukte', b.dataset.exprod).then(reload));
  body.querySelectorAll('[data-exins]').forEach(b => b.onclick = () => exclude(p, 'ausgeschlosseneKassen', +b.dataset.exins).then(reload));
  body.querySelectorAll('[data-step]').forEach(c => c.onchange = async () => {
    try { const r = await call('POST', 'step', { person: pid, year: S.year, key: c.dataset.step, done: c.checked }); if (r.applied) toast('Wechsel abgeschlossen'); reload(); } catch (e) { toast(e.message); c.checked = !c.checked; }
  });
  if ($('more')) $('more').onclick = () => openCompare(pid, 200);
  $('editP').onclick = () => { closeSheet(); editPerson(pid); };
  if ($('saveNote')) $('saveNote').onclick = async () => { await call('POST', 'note', { person: pid, year: S.year, note: $('caseNote').value }); toast('Gespeichert'); };
  if ($('clearDecision')) $('clearDecision').onclick = () => { if (confirm('Entscheid und erledigte Schritte für dieses Jahr zurücksetzen?')) decide({ clear: true }); };
  if ($('insInfo')) $('insInfo').onclick = () => { closeSheet(); S.tab = 'settings'; render().then(() => { $('insSel').value = String(cs.decision.fromInsurer === cs.decision.insurer ? cs.decision.insurer : cs.decision.fromInsurer); $('insSel').dispatchEvent(new Event('change')); }); };
}
const userName = (u) => S.state.users.find(x => x.id === u)?.name || u;
async function exclude(p, field, value) {
  const list = new Set(p[field] || []); list.add(value);
  try { await call('POST', 'persons', { ...p, [field]: [...list] }); toast('Ausgeblendet. Rückgängig unter «Personen».'); } catch (e) { toast(e.message); }
}

// ---------- Personen ----------
function renderPersons() {
  const el = $('tab-persons'), ps = S.state.persons;
  el.innerHTML = ps.map(p => `<div class="card pcard" tabindex="0" data-p="${p.id}"><div class="head"><span class="name">${esc(p.vorname)} ${esc(p.nachname)}</span><span class="muted small">Jg. ${esc(p.jahrgang)}</span></div>
    <div class="muted small">${esc(insName(p.versicherer) || 'Kasse nicht erfasst')} · Franchise ${esc(p.franchise)} · ${p.modelle.map(m => esc(S.state.modelTypes[m])).join(', ')}</div></div>`).join('') +
    '<button class="btn primary" id="addPerson">Person hinzufügen</button>';
  for (const c of el.querySelectorAll('.pcard')) { c.onclick = () => editPerson(+c.dataset.p); c.onkeydown = (e) => { if (e.key === 'Enter') editPerson(+c.dataset.p); }; }
  $('addPerson').onclick = () => editPerson(null);
}
const insName = (nr) => S.state.insurers.find(i => i.nr === +nr)?.short || '';

function editPerson(id) {
  const p = id ? S.state.persons.find(x => x.id === id) : { vorname: '', nachname: '', jahrgang: '', geburtsdatum: '', strasse: '', plz: '', ort: '', bfs: null, versicherer: null, tarif: null, versichertenNr: '', ahvNr: '', franchise: 2500, unfall: false, modelle: Object.keys(S.state.modelTypes), ausgeschlosseneKassen: [], ausgeschlosseneProdukte: [], notiz: '' };
  const mt = S.state.modelTypes;
  const h = `<form id="pf" autocomplete="off">
    <div class="grid2"><label>Vorname <input name="vorname" required maxlength="60" value="${esc(p.vorname)}"></label><label>Nachname <input name="nachname" maxlength="60" value="${esc(p.nachname)}"></label></div>
    <div class="grid2"><label>Jahrgang <input name="jahrgang" type="number" min="1900" max="2100" value="${esc(p.jahrgang)}"></label><label>Geburtsdatum (für Briefe) <input name="geburtsdatum" type="date" value="${esc(p.geburtsdatum)}"></label></div>
    <div class="grid3"><label>Strasse <input name="strasse" maxlength="100" value="${esc(p.strasse)}"></label><label>PLZ <input name="plz" maxlength="4" inputmode="numeric" value="${esc(p.plz)}"></label><label>Ort <input name="ort" maxlength="60" value="${esc(p.ort)}"></label></div>
    <label>Wohngemeinde (bestimmt die Prämienregion) <select name="bfs"><option value="">PLZ eingeben …</option></select></label>
    <div class="grid2"><label>Franchise <select name="franchise"></select></label><label class="check" style="margin-top:34px"><input type="checkbox" name="unfall"${p.unfall ? ' checked' : ''}> Mit Unfalldeckung</label></div>
    <fieldset><legend>Erlaubte Modelle</legend><div class="chips">${Object.entries(mt).map(([k, v]) => `<label class="check"><input type="checkbox" name="modelle" value="${k}"${p.modelle.includes(k) ? ' checked' : ''}> ${esc(v)}</label>`).join('')}</div></fieldset>
    <label>Aktuelle Kasse <select name="versicherer"><option value="">–</option>${S.state.insurers.map(i => `<option value="${i.nr}"${+p.versicherer === i.nr ? ' selected' : ''}>${esc(i.short)}</option>`).join('')}</select></label>
    <label>Aktuelles Produkt <select name="tarif"><option value="">–</option></select></label>
    <div class="grid2"><label>Versicherten-Nr. <input name="versichertenNr" maxlength="40" value="${esc(p.versichertenNr)}"></label><label>AHV-Nr. (für Anträge, optional) <input name="ahvNr" maxlength="20" value="${esc(p.ahvNr)}"></label></div>
    <details${(p.ausgeschlosseneKassen.length || p.ausgeschlosseneProdukte.length) ? ' open' : ''}><summary>Ausgeschlossene Kassen und Produkte (${p.ausgeschlosseneKassen.length + p.ausgeschlosseneProdukte.length})</summary>
      <div class="chips">${S.state.insurers.map(i => `<label class="check"><input type="checkbox" name="exins" value="${i.nr}"${p.ausgeschlosseneKassen.includes(i.nr) ? ' checked' : ''}> ${esc(i.short)}</label>`).join('')}</div>
      ${p.ausgeschlosseneProdukte.length ? `<p class="small muted">Ausgeblendete Produkte (Haken weg = wieder anzeigen):</p><div class="chips">${p.ausgeschlosseneProdukte.map(k => `<label class="check"><input type="checkbox" name="exprod" value="${esc(k)}" checked> ${esc(insName(k.split('|')[0]))}: ${esc(k.split('|').slice(1).join('|'))}</label>`).join('')}</div>` : ''}
    </details>
    <label>Notiz <textarea name="notiz" rows="2" maxlength="1000">${esc(p.notiz)}</textarea></label>
    <div class="row"><button class="btn primary" type="submit">Speichern</button>${id ? '<button class="btn danger" type="button" id="delP">Löschen</button>' : ''}</div>
  </form>`;
  openSheet(id ? `${p.vorname} bearbeiten` : 'Person erfassen', h);
  const f = $('pf');
  const ageSub = () => { const jg = +f.jahrgang.value || (f.geburtsdatum.value ? +f.geburtsdatum.value.slice(0, 4) : 0); if (!jg) return 'E'; const a = (S.year || new Date().getFullYear()) - jg; return a <= 18 ? 'K' : 'E'; };
  const fillFr = () => {
    const opts = ageSub() === 'K' ? [0, 100, 200, 300, 400, 500, 600] : [300, 500, 1000, 1500, 2000, 2500];
    const cur = +f.franchise.value || +p.franchise;
    f.franchise.innerHTML = opts.map(o => `<option value="${o}"${o === cur ? ' selected' : ''}>CHF ${o}</option>`).join('');
  };
  const fillGemeinden = async () => {
    const plz = f.plz.value.trim();
    if (!/^\d{4}$/.test(plz)) { f.bfs.innerHTML = '<option value="">PLZ eingeben …</option>'; return; }
    const list = await call('GET', 'gemeinden?plz=' + plz);
    const cur = +f.bfs.value || +p.bfs;
    f.bfs.innerHTML = list.length ? list.map(g => `<option value="${g.bfs}"${g.bfs === cur ? ' selected' : ''}>${esc(g.gemeinde)} (${esc(g.canton)}, Region ${g.region})</option>`).join('') : '<option value="">PLZ nicht gefunden</option>';
    if (!f.ort.value && list[0]) f.ort.value = list[0].ort;
  };
  const fillProducts = async () => {
    const ins = f.versicherer.value;
    if (!ins) { f.tarif.innerHTML = '<option value="">–</option>'; return; }
    const jg = +f.jahrgang.value || (f.geburtsdatum.value ? +f.geburtsdatum.value.slice(0, 4) : '');
    const qs = new URLSearchParams({ year: S.year, insurer: ins, bfs: f.bfs.value || '', jahrgang: jg || '', franchise: f.franchise.value, unfall: f.unfall.checked ? '1' : '0' });
    const list = await call('GET', 'produkte?' + qs);
    const cur = f.tarif.value || p.tarif;
    f.tarif.innerHTML = '<option value="">–</option>' + list.map(o => `<option value="${esc(o.tariff)}"${o.tariff === cur ? ' selected' : ''}>${esc(o.name)} · ${esc(o.typeLabel)}${o.monthly != null ? ' · ' + chf(o.monthly) : ''}</option>`).join('');
  };
  fillFr(); fillGemeinden().then(fillProducts).catch(() => {});
  f.plz.addEventListener('input', () => { if (/^\d{4}$/.test(f.plz.value.trim())) fillGemeinden().then(fillProducts); });
  f.jahrgang.addEventListener('change', () => { fillFr(); fillProducts(); });
  f.geburtsdatum.addEventListener('change', () => { if (f.geburtsdatum.value) f.jahrgang.value = f.geburtsdatum.value.slice(0, 4); fillFr(); fillProducts(); });
  for (const n of ['bfs', 'versicherer', 'franchise', 'unfall']) f[n].addEventListener('change', fillProducts);
  f.onsubmit = async (e) => {
    e.preventDefault();
    const val = (n) => f[n].value;
    const body = {
      id: id || undefined, vorname: val('vorname'), nachname: val('nachname'), jahrgang: val('jahrgang'), geburtsdatum: val('geburtsdatum'),
      strasse: val('strasse'), plz: val('plz'), ort: val('ort'), bfs: val('bfs'), franchise: val('franchise'), unfall: f.unfall.checked,
      modelle: [...f.querySelectorAll('[name=modelle]:checked')].map(x => x.value), versicherer: val('versicherer'), tarif: val('tarif'),
      versichertenNr: val('versichertenNr'), ahvNr: val('ahvNr'), notiz: val('notiz'),
      ausgeschlosseneKassen: [...f.querySelectorAll('[name=exins]:checked')].map(x => +x.value),
      ausgeschlosseneProdukte: [...f.querySelectorAll('[name=exprod]:checked')].map(x => x.value),
    };
    try { await call('POST', 'persons', body); toast('Gespeichert'); closeSheet(); await load(); } catch (err) { toast(err.message); }
  };
  if ($('delP')) $('delP').onclick = async () => { if (!confirm(`${p.vorname} mit allen Entscheiden löschen?`)) return; await call('DELETE', 'persons/' + id); closeSheet(); toast('Gelöscht'); await load(); };
}

// ---------- Einstellungen ----------
function renderSettings() {
  const st = S.state;
  $('threshold').value = st.settings.threshold;
  $('hhStrasse').value = st.settings.household.strasse || ''; $('hhPlz').value = st.settings.household.plz || ''; $('hhOrt').value = st.settings.household.ort || '';
  const is = st.importState;
  $('dataInfo').textContent = st.latestYear ? `Prämienjahr ${st.latestYear}, geladen am ${fmtDate(st.imported)}.` + (is.running ? ' Aktualisierung läuft …' : '') + (is.lastError ? ' Letzter Fehler: ' + is.lastError : '') : (is.running ? 'Import läuft …' : 'Noch keine Daten.');
  $('importBtn').disabled = is.running;
  if (!$('insSel').options.length) {
    $('insSel').innerHTML = '<option value="">Kasse wählen …</option>' + st.insurers.map(i => `<option value="${i.nr}">${esc(i.short)}</option>`).join('');
  }
  updatePushUi();
}
$('insSel').onchange = async () => {
  const nr = $('insSel').value; $('insEdit').hidden = !nr; if (!nr) return;
  const r = await call('GET', 'insurers/' + nr);
  $('insBag').textContent = 'BAG-Verzeichnis: ' + [r.name, ...r.address].join(', ') + (r.web ? ' · ' + r.web : '');
  $('insAddr').value = r.letter_address || [r.name, ...r.address].join('\n');
  $('insUrl').value = r.apply_url || '';
};
$('saveIns').onclick = async () => { try { await call('POST', 'insurers/' + $('insSel').value, { letter_address: $('insAddr').value, apply_url: $('insUrl').value }); toast('Gespeichert'); } catch (e) { toast(e.message); } };
$('saveSettings').onclick = async () => {
  try { await call('POST', 'settings', { threshold: $('threshold').value, household: { strasse: $('hhStrasse').value, plz: $('hhPlz').value, ort: $('hhOrt').value } }); toast('Gespeichert'); await load(); } catch (e) { toast(e.message); }
};
$('importBtn').onclick = async () => { await call('POST', 'import'); toast('Prüfe beim BAG …'); setTimeout(() => load().catch(() => {}), 4000); };
$('logout').onclick = async () => { await fetch('/auth/logout', { method: 'POST' }); location.href = '/'; };
$('yearSel').onchange = () => { S.year = +$('yearSel').value; render(); };
for (const b of document.querySelectorAll('.tabs button')) b.onclick = () => { S.tab = b.dataset.tab; render().catch(e => toast(e.message)); };

// ---------- Push ----------
const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
function keyBytes(k) { const s = atob(k.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((k.length + 3) % 4)); return Uint8Array.from(s, c => c.charCodeAt(0)); }
async function currentSub() { if (!pushSupported) return null; const reg = await navigator.serviceWorker.ready; return reg.pushManager.getSubscription(); }
async function updatePushUi() {
  const hint = $('pushHint'), st = $('pushState');
  if (isIos && !standalone) {
    hint.hidden = false; hint.textContent = 'Auf dem iPhone: In Safari auf «Teilen», dann «Zum Home-Bildschirm». Danach die App vom Home-Bildschirm öffnen und Push hier aktivieren.';
    st.textContent = 'Push geht auf dem iPhone nur aus der installierten App.'; $('pushOn').disabled = true; $('pushTest').disabled = true; $('pushOff').hidden = true; return;
  }
  if (!pushSupported) { st.textContent = 'Dieser Browser unterstützt keine Push-Nachrichten.'; $('pushOn').disabled = true; $('pushTest').disabled = true; hint.hidden = true; return; }
  const sub = await currentSub(); const denied = Notification.permission === 'denied';
  st.textContent = denied ? 'Mitteilungen sind blockiert. Bitte in den Geräte-Einstellungen erlauben.' : sub ? 'Push ist auf diesem Gerät aktiv.' : 'Push ist auf diesem Gerät noch nicht aktiv.';
  $('pushOn').hidden = !!sub; $('pushOn').disabled = denied; $('pushOff').hidden = !sub; $('pushTest').disabled = !sub; hint.hidden = true;
}
$('pushOn').onclick = async () => {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('Mitteilungen wurden nicht erlaubt'); return updatePushUi(); }
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(S.state.vapidPublicKey) });
    await call('POST', 'push/subscribe', sub.toJSON()); toast('Push aktiviert');
  } catch (e) { toast('Push konnte nicht aktiviert werden: ' + e.message); }
  updatePushUi();
};
$('pushOff').onclick = async () => { const s = await currentSub(); if (s) { await call('POST', 'push/unsubscribe', { endpoint: s.endpoint }).catch(() => {}); await s.unsubscribe(); } toast('Push beendet'); updatePushUi(); };
$('pushTest').onclick = async () => { try { const d = await call('POST', 'push/test'); toast(d.sent ? 'Test-Push gesendet' : 'Kein aktives Gerät gefunden'); } catch (e) { toast(e.message); } };

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
load().catch(e => { if (e.message !== 'Nicht angemeldet') toast(e.message); });
