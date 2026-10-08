/* Sanctum of Neurology — app logic (shared by PWA, single-file HTML and Electron builds). */
'use strict';
(() => {
const APP_VERSION = '0.7';
// Where online updates come from. PWA: same folder. Single-file/Electron: set in About → Data source.
const SITE_DATA = 'https://tangmonono-cyberagents.github.io/Sanctum-of-neurology/data/';   // GitHub Pages copy of the lexicon
const DEFAULT_SOURCE = (location.protocol === 'http:' || location.protocol === 'https:') && !document.getElementById('inline-data') ? './data/' : SITE_DATA;
const LOC_ORDER = ['cortex','subcortical','basal-ganglia','thalamus','cerebellum','brainstem','cranial-nerve','optic','vestibular','meninges','ventricles-csf','spinal-cord','anterior-horn','root','plexus','nerve','nmj','muscle','autonomic','multifocal','functional'];
const KIND = {pn: '[positive / negative]', side: '(right / left / both)', both: 'side + positive / negative'};

// ------------------------------------------------------------ storage (per device only)
const LS = {
  get(k, d) { try { const v = localStorage.getItem('sanctum.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('sanctum.' + k, JSON.stringify(v)); } catch (e) {} }
};
const idb = {
  open() { return new Promise((res, rej) => { try { const r = indexedDB.open('sanctum', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); } catch (e) { rej(e); } }); },
  async get(k) { try { const db = await idb.open(); return await new Promise(res => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); }); } catch (e) { return undefined; } },
  async set(k, v) { try { const db = await idb.open(); await new Promise(res => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = res; }); } catch (e) {} }
};

// ------------------------------------------------------------ text helpers
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
// norm() must match tools/build.py norm()
function norm(s) {
  s = String(s || '').normalize('NFKD').replace(/([A-Za-z])[̀-ͯ]+/g, '$1').toLowerCase();
  s = s.replace(/[’‘`]/g, "'").replace(/'s\b/g, '').replace(/ae/g, 'e').replace(/oe/g, 'e');
  return s.replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
}
function lev(a, b, max) {   // optimal-string-alignment distance with early exit
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let pp = null, prev = Array.from({length: b.length + 1}, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]; let best = i;
    for (let j = 1; j <= b.length; j++) {
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (pp && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, pp[j - 2] + 1);
      cur.push(v); if (v < best) best = v;
    }
    if (best > max) return max + 1;
    pp = prev; prev = cur;
  }
  return prev[b.length];
}

// ------------------------------------------------------------ data
let D = null;          // {signs, dx, meta, vocab, similar, version}
let byId = new Map();
async function loadBundled() {
  const el = document.getElementById('inline-data');
  if (el) return JSON.parse(el.textContent);
  const get = f => fetch('data/' + f).then(r => { if (!r.ok) throw new Error(f + ' ' + r.status); return r.json(); });
  const [version, signs, dx, meta, index] = await Promise.all(['version.json', 'signs.json', 'diseases.json', 'meta.json', 'index.json'].map(get));
  return {version, signs, dx, meta, vocab: index.vocab, similar: null};
}
function cmpVer(a, b) { return String(a || '').localeCompare(String(b || ''), 'en', {numeric: true}); }
async function loadData() {
  let data = await loadBundled();
  const saved = await idb.get('dataset');   // a newer lexicon downloaded earlier
  if (saved && saved.version && cmpVer(saved.version.version, data.version.version) > 0) data = saved;
  return data;
}
function prepare(data) {
  D = data; byId = new Map();
  D.all = [];
  for (const s of D.signs) { s.t = 'sign'; D.all.push(s); }
  for (const d of D.dx) { d.t = 'dx'; D.all.push(d); }
  D.dx.forEach((d, i) => { d.ix = i; });
  for (const e of D.all) {
    byId.set(e.id, e);
    e._n = ' ' + e.nN + ' ';
    e._a = e.aN ? e.aN.split(' | ') : [];
    e._aj = ' ' + e._a.join(' | ') + ' ';
  }
  D.nea = new Map(D.dx.filter(d => d.nea != null).map(d => [d.nea, d]));
  D.vocabSet = new Set(D.vocab);
  D.syn = new Map();
  for (const g of D.meta.syn) for (const t of g) D.syn.set(t, g);
  D.bodyReady = false;
  const build = (i) => { const end = Math.min(D.all.length, i + 400); for (; i < end; i++) { const e = D.all[i];
      e._b = ' ' + norm([e.formal, e.simple, e.more, e.exam, e.pos, (e.feat || []).join(' '), (e.inv || []).join(' ')].join(' ')) + ' ';
      e._t = e.th ? norm(e.th) : ''; }
    if (i < D.all.length) setTimeout(() => build(i), 0); else { D.bodyReady = true; if (state.q) render(); } };
  build(0);
}
async function similarFor(d) {
  if (!D.similar) {
    const el = document.getElementById('inline-similar');
    if (el) D.similar = JSON.parse(el.textContent);
    else { try { D.similar = D._similar || await fetch('data/similar.json').then(r => r.json()); } catch (e) { D.similar = []; } }
  }
  return (D.similar[d.ix] || []).map(([j, s, terms]) => ({e: D.dx[j], score: s / 100, terms}));
}

// ------------------------------------------------------------ search
function variantsFor(term) {
  const out = [{v: term, w: 1, how: ''}];
  const g = D.syn.get(term);
  if (g) for (const t of g) if (t !== term) out.push({v: t, w: .85, how: 'synonym'});
  const words = term.split(' ');
  if (words.length === 1 && term.length >= 4 && !D.vocabSet.has(term)) {
    // prefix of a known word? then it is just partial typing
    // also try spelling neighbours even when the term is a prefix of some word ("bare" → "barre")
    {
      const max = term.length <= 5 ? 1 : 2, cands = [];
      for (const w of D.vocab) {
        if (Math.abs(w.length - term.length) > max) continue;
        const d = lev(term, w, max);
        if (d <= max) cands.push([d, w]);
      }
      cands.sort((a, b) => a[0] - b[0] || a[1].length - b[1].length);
      for (const [d, w] of cands.slice(0, 4)) out.push({v: w, w: d === 1 ? .7 : .55, how: 'spelling'});
    }
  }
  return out;
}
function fieldScore(e, v) {
  const short = v.length <= 2;
  let s = 0;
  if (e.nN === v) s = 100;
  else if (e.nN.startsWith(v)) s = 72;
  else if (e._n.includes(' ' + v)) s = 56;
  else if (!short && e.nN.includes(v)) s = 34;
  for (const a of e._a) {
    if (a === v) { s = Math.max(s, 92); break; }
    if (a.startsWith(v)) s = Math.max(s, 60);
  }
  if (s < 50 && e._aj.includes(' ' + v)) s = Math.max(s, 46);
  if (!s && !short && e._b && e._b.includes(' ' + v)) s = 12 + (e._b.includes(' ' + v + ' ') ? 3 : 0);
  if (!s && e._t && /[฀-๿]/.test(v) && e._t.includes(v)) s = 14;
  return s;
}
function search(q, limit = 60) {
  const t0 = performance.now();
  const raw = q.trim();
  if (!raw) return null;
  const isCombo = /[+,;]/.test(raw);
  const nq = norm(raw);
  let terms = isCombo ? raw.split(/[+,;]/).map(norm).filter(Boolean) : nq.split(' ').filter(Boolean);
  if (!terms.length) return null;
  // merge tokens that form a synonym phrase (e.g. "double vision")
  if (!isCombo && terms.length > 1 && D.syn.has(nq)) terms = [nq];
  const tv = terms.map(variantsFor);
  const used = new Set();
  const scored = [];
  for (const e of D.all) {
    let total = 0, hits = 0;
    for (let i = 0; i < tv.length; i++) {
      let best = 0, how = '';
      for (const {v, w, how: h} of tv[i]) { const s = fieldScore(e, v) * w; if (s > best) { best = s; how = h ? h + ':' + v : ''; } }
      if (best) { hits++; total += best; if (how) used.add(terms[i] + '→' + how.split(':')[1] + (how.startsWith('syn') ? ' (synonym)' : '')); }
    }
    if (!hits) continue;
    const full = hits === tv.length;
    if (!full && tv.length > 1 && !isCombo) continue;
    if (!isCombo || full || tv.length > 1) {
      // whole-phrase bonus
      if (terms.length > 1) { if (e.nN === nq) total += 120; else if (e._n.includes(' ' + nq)) total += 60; else if (e._aj.includes(' ' + nq)) total += 50; }
      if (e.cur) total += 4;
      scored.push({e, s: total / tv.length + (full ? 40 : 0), full});
    }
  }
  scored.sort((a, b) => b.s - a.s || a.e.name.length - b.e.name.length);
  let res = scored;
  const anyFull = scored.some(x => x.full);
  if (anyFull) res = scored.filter(x => x.full);
  const signs = res.filter(x => x.e.t === 'sign'), dx = res.filter(x => x.e.t === 'dx');
  return {q: raw, terms, signs, dx, partial: !anyFull && tv.length > 1, used: [...used].slice(0, 4), ms: performance.now() - t0, combo: isCombo};
}
function snippet(e, terms) {
  const text = e.formal || e.simple || '';
  let i = -1;
  const low = text.toLowerCase();
  for (const t of terms) { const k = low.indexOf(t.split(' ')[0]); if (k >= 0 && (i < 0 || k < i)) i = k; }
  let s = i > 90 ? '…' + text.slice(i - 70) : text;
  s = s.length > 220 ? s.slice(0, 220) + '…' : s;
  const words = terms.map(t => t.split(' ')[0]).filter(w => w.length >= 3).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!words.length) return esc(s);
  const rx = new RegExp('(' + words.join('|') + ')', 'ig');
  return s.split(rx).map((part, k) => k % 2 ? `<mark>${esc(part)}</mark>` : esc(part)).join('');
}

// ------------------------------------------------------------ state + routing
const state = {
  q: '', resTab: 'dx', lang: LS.get('lang', 'formal'),
  fav: LS.get('fav', []), hist: LS.get('hist', []), cmp: LS.get('cmp', []),
  source: LS.get('source', '') || DEFAULT_SOURCE
};
function saveState() { LS.set('fav', state.fav); LS.set('hist', state.hist); LS.set('cmp', state.cmp); LS.set('lang', state.lang); LS.set('source', state.source); }
function route() {
  let h = location.hash.replace(/^#\/?/, '');
  try { h = decodeURIComponent(h); } catch (e) { h = unescape(h); }
  const [view, ...rest] = h.split('/');
  return {view: view || 'home', arg: rest.join('/')};
}
function go(hash) { if (location.hash !== hash) location.hash = hash; else render(); }
function addHist(e) {
  state.hist = [e.id, ...state.hist.filter(x => x !== e.id)].slice(0, 40); saveState();
}
// Deep links from Neuro Exam Assistant or elsewhere:
//   #/sign/<id>  #/dx/<id>  #/find/<name>  #/q/<query>  #/nea-dx/<index>  or  ?find=<name>  ?q=<query>
function resolveFind(name) {
  const n = norm(name);
  const hit = D.all.find(e => e.nN === n) || D.all.find(e => e._a.includes(n));
  return hit;
}
function handleQueryString() {
  const p = new URLSearchParams(location.search);
  const f = p.get('find'), q = p.get('q'), s = p.get('sign'), d = p.get('dx');
  if (!(f || q || s || d)) return;
  history.replaceState(null, '', location.pathname + (f ? '#/find/' + encodeURIComponent(f) : q ? '#/q/' + encodeURIComponent(q) : s ? '#/sign/' + s : '#/dx/' + d));
}

// ------------------------------------------------------------ rendering helpers
const link = e => `#/${e.t}/${encodeURIComponent(e.id)}`;
const fmtDate = d => { try { const x = new Date(d + 'T00:00:00'); return isNaN(x) ? (d || '') : x.toLocaleDateString('en-GB', {day: 'numeric', month: 'short', year: 'numeric'}); } catch (e) { return d || ''; } };
const statusChip = e => `<span class="st ${e.status === 'reviewed' ? 'reviewed' : 'draft'}" title="${e.status === 'reviewed' ? 'Checked by a neurologist' : 'Awaiting expert review'}"><span class="dot"></span>${e.status === 'reviewed' ? 'Reviewed' : 'Draft'} · ${esc(fmtDate(e.updated))}</span>`;
const ICON = {
  star: '<svg viewBox="0 0 24 24"><path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z"/></svg>',
  starf: '<svg viewBox="0 0 24 24" style="fill:currentColor"><path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z"/></svg>',
  cmp: '<svg viewBox="0 0 24 24"><path d="M7 4v16M17 4v16M4 8h6M14 16h6"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>'
};
const autoChip = (e, f) => (e.auto || []).includes(f) ? `<span class="st auto" title="Derived automatically from the text — not yet checked by an expert">auto</span>` : '';
const isFav = id => state.fav.includes(id);
const locLabel = c => (D.meta.loc[c] || c);
const sysLabel = c => (D.meta.sys[c] || c);
function itemHTML(x, terms, sel) {
  const e = x.e || x;
  const kind = e.t === 'sign' ? 'sign' : (e.cat || 'disease');
  return `<li><a class="item${sel ? ' sel' : ''}" href="${link(e)}" data-id="${esc(e.id)}"><div class="nm">${esc(e.name)} <span class="tag">${esc(kind)}</span>${e.cur ? '<span class="st cur">curated</span>' : ''}</div>
    <div class="sn">${terms ? snippet(e, terms) : esc((e.formal || '').slice(0, 200))}</div>${refLine(e)}</a></li>`;
}
function bookShort(r) { const b = D.meta.books[r.book] || {}; return b.short || b.title || r.book; }
const safeUrl = u => /^https:\/\//.test(u || '') ? u : '';
function refText(r) {   // "Book — where" with a clickable link when the reference is a web page
  const t = esc(bookShort(r)) + (r.where ? ' — ' + esc(r.where) : '');
  const u = safeUrl(r.url);
  return u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${t} ↗</a>` : t;
}
const DET_DX = [['patho', 'Pathophysiology'], ['clinical', 'Clinical picture'], ['diagnosis', 'Diagnosis'], ['treatment', 'Treatment'], ['prognosis', 'Prognosis']];
const DET_SIGN = [['mechanism', 'Mechanism'], ['technique', 'Technique'], ['interpretation', 'Interpretation']];
function detHTML(d, parts, id) {
  if (!d) return '';
  return `<h2 class="sec" id="${id}">In depth <span class="st draft">draft</span></h2><div class="depth">
    ${d.thd ? `<div class="thd" lang="th">${esc(d.thd)}</div>` : ''}
    ${parts.filter(([k]) => d[k]).map(([k, l]) => `<h3>${l}</h3><p class="prose">${esc(d[k])}</p>`).join('')}
    ${d.pearls && d.pearls.length ? `<h3>Pearls</h3><ul class="list pearls">${d.pearls.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</div>`;
}
function refLine(e) {
  const r = (e.read || [])[0];
  if (!r) return '';
  const w = r.where.length > 110 ? r.where.slice(0, 108) + '…' : r.where;
  return `<div class="ref"><span class="reftag">Read</span><span class="rt">${esc(bookShort(r))}${w ? ' — ' + esc(w) : ''}${e.read.length > 1 ? ` <span class="faint">+${e.read.length - 1}</span>` : ''}</span></div>`;
}
// ---- summary shown above search results: a curated overview article, or an auto-summary of the top hits
function pickArticle(r) {
  const arts = D.meta.articles || [];
  const nq = norm(r.q);
  const top = new Set([...r.dx.slice(0, 6), ...r.signs.slice(0, 3)].map(x => x.e.id));
  let best = null, bs = 0;
  for (const a of arts) {
    let s = 0;
    for (const k of a.keys) {
      if (k === nq) s += 6;
      for (const t of r.terms) if (t.length >= 3 && (k === t || (t.length >= 4 && k.startsWith(t)) || (k.length >= 4 && t.includes(k)))) s += 2;
    }
    for (const id of a.entries) if (top.has(id)) s += 1.5;
    if (s > bs) { bs = s; best = a; }
  }
  return bs >= 3 ? best : null;
}
function refsHTML(reads) {
  const seen = new Set(), out = [];
  for (const r of reads) { const k = r.book + r.where; if (seen.has(k)) continue; seen.add(k); out.push(r); }
  return out.length ? `<div class="sumrefs"><span class="reftag">Read</span><ul>${out.slice(0, 5).map(r => `<li>${esc(bookShort(r))}${r.where ? ' — ' + esc(r.where) : ''}</li>`).join('')}</ul></div>` : '';
}
function firstSentence(t) { const m = String(t || '').match(/^.*?[.;](\s|$)/); return (m ? m[0] : t || '').trim(); }
function summaryPanel(r) {
  if (!r.dx.length && !r.signs.length) return '';
  if (LS.get('sumHidden', false)) return `<div class="sumbar"><button class="btn ghost" data-sumtoggle>Show summary</button></div>`;
  const art = pickArticle(r);
  const tools = `<button class="btn ghost" data-sumtoggle>Hide</button>`;
  if (art) {
    const ents = art.entries.map(id => byId.get(id)).filter(Boolean);
    return `<section class="summary"><div class="sumhead"><span class="st draft"><span class="dot"></span>Overview · draft</span><span class="sp"></span>${tools}</div>
      <h2>${esc(art.title)}</h2>${state.lang === 'th' && art.th ? `<p class="th">${esc(art.th)}</p>` : ''}
      <p>${esc(art.body[0])}</p>
      <details${LS.get('sumOpen', false) ? ' open' : ''}><summary class="more-toggle">Read the full overview</summary>${art.body.slice(1).map(p => `<p>${esc(p)}</p>`).join('')}
      <div class="chips">${ents.map(e => `<a class="chip" href="${link(e)}">${esc(e.name)}</a>`).join('')}</div>
      </details>${refsHTML(art.read)}</section>`;
  }
  const dx = r.dx.slice(0, 8).map(x => x.e), lead = dx[0] || r.signs[0].e;
  const count = f => { const m = new Map(); for (const d of dx.slice(0, 10)) for (const k of d[f] || []) m.set(k, (m.get(k) || 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(x => x[0]); };
  const locs = count('loc').map(locLabel), syss = count('sys').map(sysLabel);
  const others = dx.slice(1, 4).map(d => { const pt = (lead.ddx || []).find(x => x.id === d.id); return `<li><a href="${link(d)}">${esc(d.name)}</a>${pt ? ' — ' + esc(pt.pt) : ''}</li>`; }).join('');
  const signs = r.signs.slice(0, 4).map(x => `<a class="chip" href="${link(x.e)}">${esc(x.e.name)}</a>`).join('');
  const reads = [...dx.slice(0, 4), ...r.signs.slice(0, 2).map(x => x.e)].flatMap(e => e.read || []);
  return `<section class="summary auto"><div class="sumhead"><span class="st auto"><span class="dot"></span>Auto-summary</span><span class="sp"></span>${tools}</div>
    <h2>${esc(r.q)}</h2>
    <p><b>Best match:</b> <a href="${link(lead)}">${esc(lead.name)}</a> — ${esc(firstSentence(state.lang === 'simple' ? lead.simple : lead.formal))}</p>
    ${state.lang === 'th' && lead.th ? `<p class="th">${esc(lead.th)}</p>` : ''}
    ${locs.length ? `<p>Matching diseases mostly localize to <b>${esc(locs.join(' and '))}</b>${syss.length ? ` and fall under <b>${esc(syss.join(' / '))}</b>` : ''}.</p>` : ''}
    ${others ? `<p><b>Also consider:</b></p><ul>${others}</ul>` : ''}
    ${lead.inv ? `<p><b>First tests:</b> ${esc(lead.inv.slice(0, 2).join('; '))}.</p>` : ''}
    ${signs ? `<div class="chips"><span class="small muted">Signs to check:</span>${signs}</div>` : ''}
    ${refsHTML(reads)}</section>`;
}
function langSeg() {
  return `<div class="seg lang" role="group" aria-label="Explanation style">${[['formal', 'Formal'], ['simple', 'Simple'], ['th', 'ไทย']].map(([k, l]) => `<button data-lang="${k}" class="${state.lang === k ? 'on' : ''}">${l}</button>`).join('')}</div>`;
}
function defText(e) {
  if (state.lang === 'th') return e.th ? `<p class="def th">${esc(e.th)}</p>` : `<p class="def">${esc(e.simple || e.formal)}</p><p class="small muted">ยังไม่มีคำอธิบายภาษาไทยสำหรับรายการนี้ — แสดงแบบ Simple แทน</p>`;
  return `<p class="def">${esc(state.lang === 'simple' ? (e.simple || e.formal) : (e.formal || e.simple))}</p>`;
}
function axisHTML(locs, inline) {
  const set = new Set(locs || []);
  if (inline) return `<div class="chips">${LOC_ORDER.filter(c => set.has(c)).map(c => `<a class="chip" href="#/browse/loc/${c}">${esc(locLabel(c))}</a>`).join('') || '<span class="muted small">Not specified</span>'}</div>`;
  return `<aside class="rail" aria-label="Localization on the neuraxis"><h4>Where on the neuraxis</h4><ul class="axis">${LOC_ORDER.filter(c => c !== 'multifocal' && c !== 'functional' || set.has(c)).map(c => `<li class="${set.has(c) ? 'on' : ''}">${esc(locLabel(c))}</li>`).join('')}</ul></aside>`;
}
function footer(e) {
  return `<div class="foot"><div>${e.src === 'sanctum' ? 'Added in Sanctum' : 'Imported from Neuro Exam Assistant'}${e.cur ? ' · curated content' : ''} · ${e.status === 'reviewed' ? 'reviewed' : 'draft'}, updated ${esc(fmtDate(e.updated))}</div>
  <div>For education only — not a diagnostic tool. Verify against current guidelines and clinical judgement.</div></div>`;
}


// ------------------------------------------------------------ recently added (from meta.rounds)
const WEEK = 7 * 864e5;
function recentRounds(all) {
  const rounds = (D.meta.rounds || []).filter(r => r.n);
  if (all) return {rounds, fallback: false};
  const now = Date.now();
  const inWeek = rounds.filter(r => now - new Date(r.date + 'T00:00:00').getTime() <= WEEK);
  return inWeek.length ? {rounds: inWeek, fallback: false} : {rounds: rounds.slice(0, 1), fallback: true};
}
const roundEntries = r => D.dx.filter(d => d.round === r.id).sort((a, b) => (b.src === 'sanctum') - (a.src === 'sanctum') || a.name.localeCompare(b.name));
function firstSentence(t) { const m = (t || '').match(/^.{20,}?[.;](\s|$)/); const x = m ? m[0].trim() : (t || ''); return x.length > 170 ? x.slice(0, 167) + '…' : x; }
function recentHomeHTML() {
  const {rounds, fallback} = recentRounds(false);
  if (!rounds.length) return '';
  const total = rounds.reduce((a, r) => a + r.n, 0);
  return `<h2 class="sec">${fallback ? 'Latest additions' : 'Added in the last 7 days'} <span class="count">${total}</span><a class="seclink" href="#/added">See all with summaries</a></h2>
  <div class="recent">${rounds.map(r => { const es = roundEntries(r); return `<a class="rround" href="#/added/${esc(r.id)}"><div class="rhead"><b>${esc(r.title)}</b><span class="faint small">${esc(fmtDate(r.date))} · ${r.n} diseases${r.new ? ` · ${r.new} new` : ''}</span></div>
    <span class="rscope">${esc(r.scope)}</span><span class="rnames">${es.slice(0, 8).map(e => esc(e.name.replace(/\s*\([^)]*\)$/, ''))).join(' · ')}${es.length > 8 ? ` <i>+${es.length - 8} more</i>` : ''}</span></a>`; }).join('')}</div>`;
}
function viewAdded(arg) {
  const all = arg === 'all' || (!!arg && !recentRounds(false).rounds.some(r => r.id === arg));
  const {rounds, fallback} = recentRounds(all);
  const tl = c => (D.meta.tempo && D.meta.tempo[c]) || c;
  const body = rounds.map(r => {
    const es = roundEntries(r);
    const reads = (r.reads || []).map(i => byId.get(i)).filter(Boolean);
    return `<section class="addround" id="${esc(r.id)}"><div class="rhead"><h2>${esc(r.title)}</h2><span class="faint small">${esc(fmtDate(r.date))} · ${r.n} diseases${r.new ? ` · ${r.new} new to the lexicon` : ''}</span></div>
      <p class="rscope">${esc(r.scope)}</p>${r.source ? `<p class="small muted">Studied from: ${esc(r.source)}</p>` : ''}
      <ul class="addlist">${es.map(e => `<li><div class="aname"><a href="${link(e)}">${esc(e.name)}</a> <span class="st ${e.src === 'sanctum' ? 'cur' : 'auto'}">${e.src === 'sanctum' ? 'New entry' : 'Expanded'}</span></div>
        ${e.th ? `<div class="ath">${esc(e.th)}</div>` : ''}<div class="adef">${esc(firstSentence(e.formal || e.simple))}</div>
        <div class="ameta">${[(e.tempo || []).map(tl).join(' / '), (e.loc || []).slice(0, 3).map(locLabel).join(', '), (e.read && e.read[0]) ? bookShort(e.read[0]) : ''].filter(Boolean).map(esc).join(' · ')}</div></li>`).join('')}</ul>
      ${reads.length ? `<h3 class="sec small">Reading references added to existing diseases <span class="count">${reads.length}</span></h3><div class="chips">${reads.map(e => `<a class="chip" href="${link(e)}">${esc(e.name)}</a>`).join('')}</div>` : ''}</section>`;
  }).join('');
  return `<article class="entry added"><div class="ehead"><div class="crumb">Lexicon changelog</div><h1>Recently added</h1>
    <p class="muted">${all ? 'Every round of curated content, newest first.' : fallback ? 'Nothing was added in the last 7 days — showing the most recent round.' : 'Diseases added or expanded in the last 7 days, with a one-line scope for each.'}
    <a href="#/added${all ? '' : '/all'}">${all ? 'Show last 7 days' : 'Show all rounds'}</a></p></div>
    ${body || '<p class="empty">No additions recorded yet.</p>'}
    <div class="foot"><div>Content is draft until reviewed by a specialist. For education only — not a diagnostic tool.</div></div></article>`;
}
// ------------------------------------------------------------ views
function viewHome() {
  const cur = D.dx.filter(d => d.cur);
  const hist = state.hist.map(id => byId.get(id)).filter(Boolean).slice(0, 8);
  const v = D.version;
  const groups = new Map();
  for (const d of cur) { const g = (d.sys || ['other'])[0]; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(d); }
  const topics = [...groups.entries()].sort((a, b) => b[1].length - a[1].length).map(([g, list]) =>
    `<details><summary><span>${esc(sysLabel(g))}</span><span class="faint small">${list.length}</span></summary><div class="chips">${list.sort((a, b) => a.name.localeCompare(b.name)).map(d => `<a class="chip" href="${link(d)}">${esc(d.name.replace(/\s*\([^)]*\)$/, ''))}</a>`).join('')}</div></details>`).join('');
  const arts = (D.meta.articles || []);
  const csigns = D.signs.filter(s => s.cur);
  return `${reminderHTML()}<section class="hello"><h1>What would you like to look up?</h1>
    <p>Type a sign, a disease, an abbreviation or a few findings joined with “+”. Misspellings are fine.</p>
    <div class="tries">${['ptosis + fatigable', 'INO', 'CIDP', 'babinsky', 'thunderclap', 'แขนขาอ่อนแรง'].map(t => `<button data-try="${esc(t)}">${esc(t)}</button>`).join('')}</div></section>
  ${recentHomeHTML()}
  ${hist.length ? `<h2 class="sec">Recently opened</h2><div class="chips">${hist.map(e => `<a class="chip" href="${link(e)}">${esc(e.name)}</a>`).join('')}</div>` : ''}
  ${arts.length ? `<h2 class="sec">Clinical overviews <span class="count">${arts.length}</span></h2><div class="arts">${arts.map(a => `<a class="art" href="#/article/${esc(a.id)}"><b>${esc(a.title)}</b><span>${esc(a.body[0])}</span></a>`).join('')}</div>` : ''}
  <h2 class="sec">Curated diseases <span class="count">${cur.length}</span></h2>
  <div class="topics">${topics}<details><summary><span>Core bedside signs</span><span class="faint small">${csigns.length}</span></summary><div class="chips">${csigns.map(s => `<a class="chip" href="${link(s)}">${esc(s.name)}</a>`).join('')}</div></details></div>
  <div class="homefoot"><span>${D.signs.length.toLocaleString()} signs · ${D.dx.length.toLocaleString()} diseases</span><span>Data ${esc(v.version)}</span><a href="#/install">Install for offline use</a><span>For education only — not a diagnostic tool</span></div>`;
}
function viewArticle(id) {
  const a = (D.meta.articles || []).find(x => x.id === id);
  if (!a) return `<p class="empty">Overview not found. <a href="#/">Back</a></p>`;
  const ents = a.entries.map(i => byId.get(i)).filter(Boolean);
  return `<article class="entry"><div><div class="ehead"><div class="crumb">Clinical overview <span class="st draft"><span class="dot"></span>Draft · ${esc(fmtDate(a.updated))}</span></div><h1>${esc(a.title)}</h1></div>
    <div class="toolrow">${langSeg()}</div>
    ${state.lang === 'th' && a.th ? `<p class="def">${esc(a.th)}</p>` : ''}
    ${a.body.map(p => `<p class="def">${esc(p)}</p>`).join('')}
    <h2 class="sec">Entries in this overview</h2><div class="chips">${ents.map(e => `<a class="chip" href="${link(e)}">${esc(e.name)}</a>`).join('')}</div>
    ${a.read.length ? `<h2 class="sec">Read</h2><ul class="list small">${a.read.map(bookRef).join('')}</ul>` : ''}
    <div class="foot"><div>Written for Sanctum from the curated entries; draft until reviewed.</div><div>For education only — not a diagnostic tool.</div></div></div></article>`;
}
let selIdx = -1;
function viewResults(r) {
  if (!D.bodyReady && !r.signs.length && !r.dx.length) return `<p class="muted">Preparing index…</p>`;
  const cap = n => Math.min(n, 60);
  const fixes = r.used.filter(u => !u.endsWith('(synonym)'));
  const dym = fixes.length ? `<p class="dym">Including spelling matches: ${fixes.map(u => esc(u.split('→')[1])).join(', ')}</p>` : '';
  if (!r.dx.length && r.signs.length) state.resTab = 'sign'; else if (r.dx.length && !r.signs.length) state.resTab = 'dx';
  const part = r.partial ? `<p class="dym muted">No entry matches every finding; showing entries that match some of them.</p>` : '';
  const col = (k, title, list) => `<section class="rescol${state.resTab === k ? ' show' : ''}"><h2 class="sec">${title} <span class="count">${list.length}</span></h2>
    ${list.length ? `<ul class="res">${list.slice(0, cap(list.length)).map(x => itemHTML(x, r.terms)).join('')}</ul>${list.length > 60 ? `<p class="small muted more">Showing 60 of ${list.length}. Add another word to narrow.</p>` : ''}` : '<p class="empty">No matches</p>'}</section>`;
  const tabs = `<div class="seg restabs"><button data-rt="dx" class="${state.resTab === 'dx' ? 'on' : ''}">Diseases ${r.dx.length}</button><button data-rt="sign" class="${state.resTab === 'sign' ? 'on' : ''}">Signs ${r.signs.length}</button></div>`;
  if (!r.dx.length && !r.signs.length) return `<div class="empty"><p><b>No match for “${esc(r.q)}”.</b></p><p class="small">Try fewer words, an abbreviation, or separate findings with “+”.</p></div>`;
  return `${summaryPanel(r)}${dym}${part}${tabs}<div class="rescols one">${col('dx', 'Diseases', r.dx)}${col('sign', 'Signs', r.signs)}</div>`;
}
function entryHead(e) {
  const kind = e.t === 'sign' ? 'Sign' : (e.cat ? e.cat.charAt(0).toUpperCase() + e.cat.slice(1) : 'Disease');
  const group = e.t === 'dx' && e.sys && e.sys[0] ? ` · <a href="#/browse/sys/${e.sys[0]}">${esc(sysLabel(e.sys[0]))}</a>` : '';
  const ab = e.ab || [];
  const waiting = state.cmp.length === 1 && state.cmp[0] !== e.id ? byId.get(state.cmp[0]) : null;
  return `<div class="ehead"><div class="crumb"><span>${kind}${group}</span>${e.cur ? '<span class="st cur">curated</span>' : ''}${statusChip(e)}</div>
    <h1>${esc(e.name)}</h1>
    ${ab.length ? `<div class="aka">Also called ${ab.slice(0, 4).map(esc).join(' · ')}${ab.length > 4 ? ` <span class="faint">+${ab.length - 4}</span>` : ''}</div>` : ''}
    <div class="actions"><button class="btn${isFav(e.id) ? ' on' : ''}" data-fav="${esc(e.id)}">${isFav(e.id) ? ICON.starf + 'Saved' : ICON.star + 'Save'}</button>
    ${e.t === 'dx' ? `<button class="btn" data-cmp="${esc(e.id)}">${ICON.cmp}${waiting ? 'Compare with ' + esc(waiting.name.replace(/\s*\([^)]*\)$/, '')) : 'Compare'}</button>` : ''}
    <button class="btn ghost" data-copy="${esc(e.name)}">${ICON.copy}Copy name</button></div></div>`;
}
function jumpNav(items) {
  return items.length > 2 ? `<nav class="jump" aria-label="On this page">${items.map(([id, l]) => `<button data-jump="${id}">${l}</button>`).join('')}</nav>` : '';
}
function viewSign(e) {
  const dx = (e.dx || []).map(id => byId.get(id)).filter(Boolean);
  const curN = e.dxCur || 0;
  const co = (e.co || []).map(id => byId.get(id)).filter(Boolean);
  const nav = [e.exam && ['s-exam', 'How to examine'], e.pos && ['s-pos', 'Meaning'], e.det && ['s-depth', 'In depth'], ['s-loc', 'Localization'], ['s-dx', 'Seen in'], ['s-co', 'Found with']].filter(Boolean);
  return `<div class="entry"><div>${entryHead(e)}
    <div class="toolrow">${langSeg()}</div>${defText(e)}
    ${jumpNav(nav)}
    ${e.exam ? `<h2 class="sec" id="s-exam">How to examine</h2><p class="prose">${esc(e.exam)}</p>` : ''}
    ${e.pos ? `<h2 class="sec" id="s-pos">What a positive result means</h2><p class="prose">${esc(e.pos)}</p>` : ''}
    ${detHTML(e.det, DET_SIGN, 's-depth')}
    ${!e.exam && !e.pos ? `<p class="small muted" style="margin-top:14px">Examination steps and interpretation have not been written for this sign yet; the definition above includes the key finding.</p>` : ''}
    <h2 class="sec" id="s-loc">Localization ${autoChip(e, 'loc')}</h2>${axisHTML(e.loc, true)}
    <h2 class="sec" id="s-dx">Seen in <span class="count">${dx.length || ''}</span></h2>
    ${dx.length ? `<div class="chips">${dx.map((d, i) => `<a class="chip" href="${link(d)}" title="${i < curN ? 'Curated link' : 'Linked automatically from text'}">${esc(d.name)}${i >= curN ? ' <span class="st auto">auto</span>' : ''}</a>`).join('')}</div>` : '<p class="muted small">No linked diseases yet.</p>'}
    <h2 class="sec" id="s-co">Often found with</h2>
    ${co.length ? `<div class="chips">${co.map(s => `<a class="chip" href="${link(s)}">${esc(s.name)}</a>`).join('')}</div>` : '<p class="muted small">None recorded.</p>'}
    ${e.ref ? `<h2 class="sec">Reference</h2><p class="prose small">${esc(e.ref)}</p>` : ''}
    ${footer(e)}</div>${axisHTML(e.loc)}</div>`;
}
function bookRef(r) {
  const b = D.meta.books[r.book] || {title: r.book};
  const u = safeUrl(r.url);
  return `<li><b>${esc(b.title)}</b>${b.edition ? `, ${esc(b.edition)}` : ''}${b.publisher ? `. ${esc(b.publisher)}` : ''}${r.where ? ` — ${u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(r.where)} ↗</a>` : esc(r.where)}` : ''}</li>`;
}
function viewDx(e) {
  const signs = (e.signs || []).map(id => byId.get(id)).filter(Boolean);
  const c = e.case;
  const ddx = (e.ddx || []).map(x => ({e: byId.get(x.id), pt: x.pt})).filter(x => x.e);
  const variants = (e.variants || []).map(id => byId.get(id)).filter(Boolean);
  const tempo = (e.tempo || []).join(' · ') || 'Not specified';
  const nav = [['d-glance', 'At a glance'], e.feat && ['d-feat', 'Features'], (e.inv || e.more) && ['d-inv', 'Tests'], e.det && ['d-depth', 'In depth'], c && ['d-case', 'Case'], ['d-ddx', 'Differential'], ['d-sim', 'Similar'], ['d-signs', 'Signs'], e.read && e.read.length && ['d-read', 'Read']].filter(Boolean);
  return `<div class="entry"><div>${entryHead(e)}
    <div class="toolrow">${langSeg()}</div>${defText(e)}
    ${jumpNav(nav)}
    <h2 class="sec" id="d-glance">At a glance</h2>
    <dl class="glance">
      <dt>Tempo ${autoChip(e, 'tempo')}</dt><dd>${esc(tempo)}${e.tempoNote ? `<div class="small muted">${esc(e.tempoNote)}</div>` : ''}</dd>
      <dt>Localization ${autoChip(e, 'loc')}</dt><dd><div class="chips">${(e.loc || []).map(l => `<a class="chip" href="#/browse/loc/${l}">${esc(locLabel(l))}</a>`).join('') || '<span class="muted small">Not specified</span>'}</div></dd>
      <dt>Group ${autoChip(e, 'sys')}</dt><dd><div class="chips">${(e.sys || []).map(s => `<a class="chip" href="#/browse/sys/${s}">${esc(sysLabel(s))}</a>`).join('')}</div></dd>
    </dl>
    ${e.feat ? `<h2 class="sec" id="d-feat">Key features</h2><ul class="list">${e.feat.map(f => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
    ${e.inv ? `<h2 class="sec" id="d-inv">Key investigations</h2><ul class="list">${e.inv.map(f => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
    ${!e.inv && e.more ? `<h2 class="sec" id="d-inv">Investigations &amp; management notes</h2><p class="prose">${esc(e.more)}</p>` : ''}
    ${detHTML(e.det, DET_DX, 'd-depth')}
    ${c ? `<h2 class="sec" id="d-case">Illustrative case <span class="st draft">invented for teaching</span></h2>
      <div class="case"><dl><dt>Patient</dt><dd>${esc(c.who)}</dd><dt>Story</dt><dd>${esc(c.story)}</dd><dt>Exam</dt><dd>${esc(c.exam)}</dd><dt>Tests</dt><dd>${esc(c.tests)}</dd></dl>
      <div class="q">${esc(c.q)}</div><button class="btn" data-reveal style="margin-top:10px">Show answer</button><div class="a" hidden>${esc(c.a)}</div>
      ${e.read && e.read.length ? `<div class="readmore"><span class="reftag">Read</span> ${e.read.map(refText).join('; ')}</div>` : ''}</div>` : ''}
    <h2 class="sec" id="d-ddx">Differential — how to tell apart</h2>
    ${ddx.length ? `<ul class="ddx">${ddx.map(x => `<li><a href="${link(x.e)}">${esc(x.e.name)}</a><span class="pt">${esc(x.pt)}</span><button class="btn pair" data-pair="${esc(e.id)}|${esc(x.e.id)}" title="Compare side by side">${ICON.cmp}Compare</button></li>`).join('')}</ul>` : '<p class="small muted">No curated differential yet — see similar entries below.</p>'}
    <h2 class="sec" id="d-sim">Similar entries <span class="st auto">computed</span></h2><div id="simbox"><p class="small muted">Loading…</p></div>
    <h2 class="sec" id="d-signs">Signs linked to this disease</h2>
    ${signs.length ? `<div class="chips">${signs.map(s => `<a class="chip" href="${link(s)}">${esc(s.name)}</a>`).join('')}</div>` : '<p class="muted small">No linked signs yet.</p>'}
    ${e.more && e.inv ? `<details style="margin-top:22px"><summary class="more-toggle">Notes from Neuro Exam Assistant</summary><p class="prose small" style="margin-top:8px">${esc(e.more)}</p></details>` : ''}
    ${e.read && e.read.length ? `<h2 class="sec" id="d-read">Read</h2><ul class="list small">${e.read.map(bookRef).join('')}</ul>` : ''}
    ${variants.length ? `<h2 class="sec">Other entries with this name</h2><div class="chips">${variants.map(v => `<a class="chip" href="${link(v)}">${esc(v.name)}</a>`).join('')}</div>` : ''}
    ${footer(e)}</div>${axisHTML(e.loc)}</div>`;
}
async function fillSimilar(e) {
  const box = $('#simbox'); if (!box) return;
  const sims = (await similarFor(e)).filter(x => !(e.ddx || []).some(d => d.id === x.e.id)).slice(0, 8);
  if (!$('#simbox')) return;
  box.innerHTML = sims.length ? `<ul class="ddx">${sims.map(x => `<li><a href="${link(x.e)}">${esc(x.e.name)}</a><span class="pt auto">Shares ${esc(x.terms || '—')} · ${Math.round(x.score * 100)}% similar</span><button class="btn pair" data-pair="${esc(e.id)}|${esc(x.e.id)}" title="Compare side by side">${ICON.cmp}Compare</button></li>`).join('')}</ul>
    <p class="small muted">Ranked by wording overlap in the definitions; distinguishing points not yet curated.</p>` : '<p class="small muted">No close matches.</p>';
}
function pairPoint(a, b) {
  const x = (a.ddx || []).find(d => d.id === b.id); if (x) return x.pt;
  const y = (b.ddx || []).find(d => d.id === a.id); if (y) return y.pt;
  return '';
}
function viewCompare() {
  const items = state.cmp.map(id => byId.get(id)).filter(Boolean);
  const anchor = items[0];
  const caseCell = e => e.case ? `<b>${esc(e.case.who)}.</b> ${esc(e.case.story)}<div class="small muted">${esc(e.case.tests)}</div>` : '<span class="muted">No case yet</span>';
  const rows = [
    ['How to tell apart', e => e === anchor ? (items.length > 1 ? '<span class="muted">Reference column</span>' : '—') : (pairPoint(anchor, e) ? `<b>${esc(pairPoint(anchor, e))}</b>` : '<span class="muted">Not curated for this pair</span>')],
    ['Tempo / onset', e => esc((e.tempo || []).join(', ') || '—') + (e.tempoNote ? `<div class="small muted">${esc(e.tempoNote)}</div>` : '')],
    ['Localization', e => esc((e.loc || []).map(locLabel).join(', ') || '—')],
    ['Key features', e => e.feat ? `<ul>${e.feat.map(f => `<li>${esc(f)}</li>`).join('')}</ul>` : '<span class="muted">Not curated</span>'],
    ['Signs', e => (e.signs || []).slice(0, 8).map(id => byId.get(id)).filter(Boolean).map(s => `<a href="${link(s)}">${esc(s.name)}</a>`).join(', ') || '—'],
    ['Investigations', e => e.inv ? `<ul>${e.inv.map(f => `<li>${esc(f)}</li>`).join('')}</ul>` : esc(e.more || '—')],
    ['Illustrative case', caseCell],
    ['Group', e => (e.sys || []).map(sysLabel).join(', ')],
    ['Definition', e => esc(e.formal)],
    ['Treatment', e => e.det && e.det.treatment ? `<div class="small">${esc(e.det.treatment)}</div>` : '<span class="muted">—</span>'],
    ['Read', e => (e.read || []).map(r => `<div class="small">${refText(r)}</div>`).join('') || '<span class="muted">—</span>']
  ];
  const quick = anchor ? (anchor.ddx || []).map(x => byId.get(x.id)).filter(d => d && !state.cmp.includes(d.id)).slice(0, 8) : [];
  return `<h2 class="sec">Compare${anchor ? ` <span class="count">${esc(anchor.name)} vs…</span>` : ''}</h2>
    ${anchor && items.length < 4 ? `<div class="quick"><span class="small muted">Pick a disease to compare with:</span><div class="chips">${quick.map(d => `<button class="chip" data-pair="${esc(anchor.id)}|${esc(d.id)}">${esc(d.name)}</button>`).join('')}<span id="quicksim"></span></div></div>` : ''}
    <div class="picker"><input id="cmpq" type="search" placeholder="${anchor ? 'Or search a disease to compare with ' + esc(anchor.name) : 'Pick the first disease…'}" autocomplete="off" ${items.length >= 4 ? 'disabled' : ''}><div class="pickres" id="cmpres" hidden></div></div>
    ${items.length ? `<div class="cmpwrap" style="margin-top:12px"><table class="cmp"><thead><tr><th></th>${items.map((e, i) => `<th class="${i === 0 ? 'anchor' : ''}">${i === 0 ? '<span class="tag">First selected</span><br>' : ''}<div class="cmph"><a href="${link(e)}">${esc(e.name)}</a><button class="rm" data-cmprm="${esc(e.id)}" aria-label="Remove ${esc(e.name)}">×</button></div></th>`).join('')}</tr></thead>
    <tbody>${rows.map(([k, f]) => `<tr><th>${k}</th>${items.map((e, i) => `<td class="${i === 0 ? 'anchor' : ''}">${f(e)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
    ${items.length === 1 ? '<p class="small muted">Choose the second disease above — the table will show both side by side.</p>' : ''}
    <div class="actions" style="margin-top:12px"><button class="btn ghost" data-cmpclear>Clear comparison</button></div>` : '<p class="empty">Open a disease and tap <b>Compare</b> next to any differential — or pick two diseases here.</p>'}`;
}
async function fillQuickSimilar() {
  const box = $('#quicksim'); const anchor = byId.get(state.cmp[0]); if (!box || !anchor) return;
  const sims = (await similarFor(anchor)).filter(x => !state.cmp.includes(x.e.id) && !(anchor.ddx || []).some(d => d.id === x.e.id)).slice(0, 4);
  if ($('#quicksim')) box.outerHTML = sims.map(x => `<button class="chip auto" data-pair="${esc(anchor.id)}|${esc(x.e.id)}" title="Computed similar">${esc(x.e.name)}</button>`).join('');
}
function groupCounts(field) {
  const m = new Map();
  for (const d of D.dx) for (const k of d[field] || []) m.set(k, (m.get(k) || 0) + 1);
  return m;
}
function viewBrowse(arg) {
  const [mode, key] = arg.split('/');
  const modes = [['sys', 'By group'], ['loc', 'By localization'], ['tempo', 'By tempo'], ['az', 'Diseases A–Z'], ['signs', 'Signs A–Z'], ['curated', 'Curated']];
  const m = mode || 'sys';
  let body = '';
  const nav = `<div class="seg">${modes.map(([k, l]) => `<button data-browse="${k}" class="${m === k ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  const list = (arr) => `<ul class="plain">${arr.map(e => `<li><a href="${link(e)}">${esc(e.name)}</a>${e.cur ? '<span class="st cur">curated</span>' : ''}</li>`).join('')}</ul>`;
  if ((m === 'sys' || m === 'loc' || m === 'tempo') && key) {
    const label = m === 'sys' ? sysLabel(key) : m === 'loc' ? locLabel(key) : key;
    const arr = D.dx.filter(d => (d[m] || []).includes(key)).sort((a, b) => (b.cur ? 1 : 0) - (a.cur ? 1 : 0) || a.name.localeCompare(b.name));
    const sg = m === 'loc' ? D.signs.filter(s => (s.loc || []).includes(key)) : [];
    body = `<a class="back" href="#/browse/${m}">${ICON.back}All groups</a><h2 class="sec">${esc(label)} <span class="count">${arr.length} diseases</span></h2>${list(arr)}
      ${sg.length ? `<h2 class="sec">Signs localizing here <span class="count">${sg.length}</span></h2>${list(sg)}` : ''}
      <p class="small muted">Group, localization and tempo are curated for curated entries and derived automatically for the rest.</p>`;
  } else if (m === 'sys' || m === 'loc' || m === 'tempo') {
    const counts = groupCounts(m);
    const keys = m === 'loc' ? LOC_ORDER.filter(k => counts.has(k)) : m === 'tempo' ? D.meta.tempo : [...counts.keys()].sort((a, b) => sysLabel(a).localeCompare(sysLabel(b)));
    body = `<div class="groups">${keys.map(k => `<a href="#/browse/${m}/${k}"><span>${esc(m === 'sys' ? sysLabel(k) : m === 'loc' ? locLabel(k) : k)}</span><span class="c">${counts.get(k) || 0}</span></a>`).join('')}</div>`;
  } else if (m === 'az' || m === 'signs') {
    const pool = m === 'az' ? D.dx : D.signs;
    const first = e => { const c = e.name.normalize('NFKD').replace(/[^A-Za-z0-9]/g, '').charAt(0).toUpperCase(); return /[A-Z]/.test(c) ? c : '#'; };
    const letters = [...new Set(pool.map(first))].sort();
    const L = key && letters.includes(key) ? key : letters[0];
    body = `<div class="az">${letters.map(l => `<a href="#/browse/${m}/${l}" class="${l === L ? 'on' : ''}">${l}</a>`).join('')}</div>${list(pool.filter(e => first(e) === L).sort((a, b) => a.name.localeCompare(b.name)))}`;
  } else if (m === 'curated') {
    body = `<h2 class="sec">Curated diseases <span class="count">${D.dx.filter(d => d.cur).length}</span></h2>${list(D.dx.filter(d => d.cur).sort((a, b) => a.name.localeCompare(b.name)))}
      <h2 class="sec">Curated signs <span class="count">${D.signs.filter(d => d.cur).length}</span></h2>${list(D.signs.filter(d => d.cur).sort((a, b) => a.name.localeCompare(b.name)))}`;
  }
  return `<h2 class="sec">Browse</h2>${nav}${body}`;
}
function viewSaved() {
  const fav = state.fav.map(id => byId.get(id)).filter(Boolean);
  const hist = state.hist.map(id => byId.get(id)).filter(Boolean);
  return `<h2 class="sec">Saved <span class="count">${fav.length || ''}</span></h2>
    ${fav.length ? `<ul class="res">${fav.map(e => itemHTML(e)).join('')}</ul>` : '<p class="empty">Tap <b>Save</b> on any entry to keep it here.</p>'}
    <h2 class="sec">History <span class="count">${hist.length || ''}</span></h2>
    ${hist.length ? `<div class="chips">${hist.map(e => `<a class="chip" href="${link(e)}">${esc(e.name)}</a>`).join('')}</div><div class="actions" style="margin-top:12px"><button class="btn ghost" data-clearhist>Clear history</button></div>` : '<p class="muted small">No history yet.</p>'}
    <p class="small muted" style="margin-top:22px">Saved items and history stay on this device.</p>`;
}
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; });
function platform() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  if (/Mac/.test(ua)) return 'mac';
  if (/Win/.test(ua)) return 'win';
  return 'other';
}
function viewInstall() {
  const p = platform(), isFile = location.protocol === 'file:', hosted = /^https?:/.test(location.protocol) && !document.getElementById('inline-data');
  const block = (key, title, html) => `<section class="card inst${p === key ? ' here' : ''}"><h3>${title}${p === key ? ' <span class="st cur">this device</span>' : ''}</h3>${html}</section>`;
  return `<a class="back" href="#/about" style="margin:0 0 10px">${ICON.back}Settings</a><h2 class="sec">Install for offline use</h2>
  <p class="small muted" style="max-width:70ch">Everything — lexicon, search, cases, compare — runs from one HTML file with no internet. Installing just gives it an icon and its own window. Updates and the literature watch use the internet only when available.</p>
  ${deferredInstall ? '<p><button class="btn primary" data-install>Install app</button></p>' : ''}
  <div class="grid2" style="margin-top:12px">
  ${block('win', 'Windows 10 / 11', `<ol class="list"><li>Download <b>Sanctum-Install-Kit.zip</b> and unzip it.</li><li>Double-click <code>Install-Windows.bat</code>.</li><li>It copies the app to your user folder and adds <b>Sanctum of Neurology</b> to the Desktop and Start menu. It opens in its own Edge window, fully offline.</li><li>Right-click the Start menu icon → <i>Pin to taskbar</i> if you like.</li></ol><p class="small muted">Hosted version: in Edge or Chrome open the site, then ⋯ → Apps → Install.</p>`)}
  ${block('mac', 'macOS', `<ol class="list"><li>Unzip <b>Sanctum-Install-Kit.zip</b>.</li><li>Right-click <code>Install-Mac.command</code> → Open (first time only, to allow it).</li><li>It creates <b>Sanctum of Neurology.app</b> in your Applications folder and adds it to the Dock. It opens in a Chrome/Edge app window if installed, otherwise Safari — offline.</li></ol><p class="small muted">Hosted version: Safari 17+ → File → Add to Dock; Chrome → ⋮ → Cast, save and share → Install page as app.</p>`)}
  ${block('ios', 'iPhone / iPad', `<ol class="list"><li>Open the hosted Sanctum link in <b>Safari</b> once while online.</li><li>Share → <b>Add to Home Screen</b>.</li><li>From then on it opens offline from the home screen.</li></ol>`)}
  ${block('android', 'Android', `<ol class="list"><li>Open the hosted link in Chrome.</li><li>⋮ → <b>Add to Home screen</b> / Install app.</li></ol>`)}
  </div>
  <p class="small muted">${isFile ? 'You are running the offline HTML file now.' : hosted ? 'You are running the hosted (PWA) version.' : ''} Saved items, history and the watch list stay on this device.</p>`;
}
function viewAbout() {
  const v = D.version, b = D.meta.books;
  const last = sync.last();
  return `<h2 class="sec">Settings</h2><div class="settings">
  <section class="card"><h3>Literature watch</h3><p class="small muted">Once a day when online, Sanctum checks recent PubMed titles (including AAN journals) and raises <b>New entities!</b> for disease or sign names that are not in the lexicon. Only fixed search terms leave the device.</p>
    <div class="actions"><button class="btn${sync.enabled() ? ' on' : ''}" data-syncon>${sync.enabled() ? '✓ Daily check on' : 'Daily check off'}</button>
    ${Object.entries(SYNC_SOURCES).map(([k, s]) => `<button class="btn${sync.sources().includes(k) ? ' on' : ''}" data-syncsrc="${k}">${sync.sources().includes(k) ? '✓ ' : ''}${s.label}</button>`).join('')}
    <a class="btn primary" href="#/new">Open watch list${state.newCount ? ` (${state.newCount})` : ''}</a></div>
    <p class="small muted" style="margin:10px 0 6px">${last ? 'Last checked ' + new Date(last).toLocaleString() : 'Not checked on this device yet.'}</p>
    <div class="actions"><span class="small muted">Remind me to go online every</span><div class="seg">${[1, 3, 7, 14].map(n => `<button class="${remindDays() === n ? 'on' : ''}" data-remind="${n}">${n} day${n > 1 ? 's' : ''}</button>`).join('')}</div>
    <button class="btn${LS.get('notify', false) ? ' on' : ''}" data-notifyon>${LS.get('notify', false) ? '✓ Desktop notifications' : 'Allow desktop notifications'}</button></div></section>
  <section class="card"><h3>Lexicon updates</h3><div class="form"><label for="src">Data source (folder with version.json)<input id="src" type="url" placeholder="https://example.org/sanctum/data/" value="${esc(state.source)}"></label>
    <div class="actions"><button class="btn primary" data-update>Check for updates</button><button class="btn ghost" data-savesrc>Save source</button></div>
    <p class="small muted" id="updmsg" style="margin:0">Works offline with the copy on this device; downloads a newer lexicon when one is published.</p></div></section>
  <section class="card"><h3>Install for offline use</h3><p class="small muted">Put Sanctum on your desktop, Dock, Start menu or home screen.</p><a class="btn" href="#/install">How to install</a></section>
  <section class="card"><h3>Appearance</h3><div class="actions"><div class="seg">${['system', 'light', 'dark'].map(t => `<button data-theme-set="${t}" class="${(LS.get('theme', 'system')) === t ? 'on' : ''}">${t.charAt(0).toUpperCase() + t.slice(1)}</button>`).join('')}</div>${langSeg()}</div></section>
  <section class="card"><h3>About</h3><p class="small" style="margin:0 0 8px"><b>For education only — not a diagnostic tool.</b> Entries are drafts until a neurologist marks them reviewed; illustrative cases are invented for teaching.</p>
    <p class="small muted" style="margin:0">App ${APP_VERSION} · data ${esc(v.version)} · ${v.counts.signs} signs · ${v.counts.diseases} diseases · ${v.counts.curatedDiseases} curated diseases · ${v.counts.curatedSigns} curated signs</p>
    <details style="margin-top:12px"><summary class="more-toggle">Study sources</summary><ul class="list small" style="margin-top:8px">${Object.values(b).map(x => `<li>${esc(x.title)}${x.edition ? ', ' + esc(x.edition) : ''}${x.publisher ? '. ' + esc(x.publisher) : ''}</li>`).join('')}</ul>
      <p class="small muted">Text in Sanctum is written independently and checked for 7-word overlaps against these sources.</p></details>
    <details style="margin-top:8px"><summary class="more-toggle">Links from Neuro Exam Assistant</summary><ul class="list small" style="margin-top:8px"><li><code>#/find/Myasthenia gravis (MG)</code> — open by name</li>
      <li><code>#/sign/s_lhermitte_s_sign</code> — open a sign by its NEA id</li><li><code>#/nea-dx/1234</code> — open a diagnosis by NEA index</li><li><code>?q=ptosis+%2B+fatigable</code> — run a search</li></ul></details></section>
  </div>`;
}

// ------------------------------------------------------------ main render
function setTabs(view) {
  document.querySelectorAll('.nav a').forEach(a => a.classList.toggle('on', a.dataset.v === view));
  const ib = $('.iconbtn[data-v=about]'); if (ib) ib.classList.toggle('on', view === 'about');
  const n = $('.nav a[data-v=compare] .n'); if (n) n.textContent = state.cmp.length || '';
  const f = $('.nav a[data-v=saved] .n'); if (f) f.textContent = state.fav.length || '';
  const s = $('.nav a[data-v=home]'); if (s) s.setAttribute('href', state.q ? '#/q/' + encodeURIComponent(state.q) : '#/');
  const c = $('#qclear'); if (c) c.hidden = !$('#q').value;
}
const scrollMemo = new Map();
function render() {
  const main = $('#main');
  const {view, arg} = route();
  let html = '', after = null;
  if (view === 'q') { const q = arg; if ($('#q').value !== q) $('#q').value = q; state.q = q; }
  if (view === 'home' || view === 'q') {
    if (view === 'home') { state.q = $('#q').value = ''; }
    const r = state.q ? search(state.q) : null;
    html = r ? viewResults(r) : viewHome();
    state.lastResults = r; selIdx = -1;
    setTabs('home');
  } else if (view === 'sign' || view === 'dx') {
    const e = byId.get(arg);
    if (!e) html = `<p class="empty">Entry not found. <a href="#/">Back to search</a></p>`;
    else { addHist(e); html = view === 'sign' ? viewSign(e) : viewDx(e); if (view === 'dx') after = () => fillSimilar(e); document.title = e.name + ' · Sanctum of Neurology'; }
    setTabs('');
  } else if (view === 'find') {
    const e = resolveFind(arg);
    if (e) { location.replace(link(e)); return; }
    location.replace('#/q/' + encodeURIComponent(arg)); return;
  } else if (view === 'nea-dx') {
    const e = D.nea.get(+arg); location.replace(e ? link(e) : '#/'); return;
  } else if (view === 'compare') {
    if (arg) { const ids = arg.split('/').filter(id => byId.has(id)); if (ids.length) { state.cmp = ids.slice(0, 4); saveState(); history.replaceState(null, '', '#/compare'); } }
    html = viewCompare(); setTabs('compare'); after = fillQuickSimilar;
  }
  else if (view === 'browse') { html = viewBrowse(arg); setTabs('browse'); }
  else if (view === 'saved') { html = viewSaved(); setTabs('saved'); }
  else if (view === 'about') { html = viewAbout(); setTabs('about'); }
  else if (view === 'install') { html = viewInstall(); setTabs('about'); }
  else if (view === 'article') { html = viewArticle(arg); setTabs(''); }
  else if (view === 'added') { html = viewAdded(arg); setTabs(''); if (arg && arg !== 'all') after = () => { const el = document.getElementById(arg); if (el) el.scrollIntoView(); }; }
  else if (view === 'new') { html = '<p class="muted">Loading…</p>'; setTabs('new'); after = async () => { const h = await viewNew(); if (route().view === 'new') $('#main').innerHTML = h; }; }
  else html = viewHome();
  if (!(view === 'sign' || view === 'dx')) document.title = 'Sanctum of Neurology';
  if (view !== 'q' && view !== 'home') { $('#q').value = ''; if (document.activeElement === $('#q')) $('#q').blur(); }   // the query stays behind the Search tab
  { const c = $('#qclear'); if (c) c.hidden = !$('#q').value; }
  main.innerHTML = html;
  const key = location.hash;
  if (scrollMemo.has(key) && (view === 'q' || view === 'browse' || view === 'saved' || view === 'home')) window.scrollTo(0, scrollMemo.get(key));
  else if (view !== 'q') window.scrollTo(0, 0);
  if (after) after();
}
function toast(msg) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t);
  setTimeout(() => t.remove(), 1800);
}

// ------------------------------------------------------------ updates
async function checkUpdate(manual) {
  const src = (state.source || '').trim();
  const msg = m => { const el = $('#updmsg'); if (el) el.textContent = m; };
  if (!src) { if (manual) msg('Set a data source URL first.'); return; }
  if (!navigator.onLine) { if (manual) msg('Offline — using the lexicon stored on this device.'); return; }
  const base = src.endsWith('/') ? src : src + '/';
  try {
    const v = await fetch(base + 'version.json', {cache: 'no-store'}).then(r => r.json());
    if (cmpVer(v.version, D.version.version) <= 0) { if (manual) msg(`Up to date (${D.version.version}).`); return; }
    msg(`Downloading ${v.version}…`);
    const get = f => fetch(base + f, {cache: 'no-store'}).then(r => { if (!r.ok) throw new Error(f); return r.json(); });
    const [signs, dx, meta, index, similar] = await Promise.all(['signs.json', 'diseases.json', 'meta.json', 'index.json', 'similar.json'].map(get));
    const data = {version: v, signs, dx, meta, vocab: index.vocab, _similar: similar};
    await idb.set('dataset', data);
    showBanner(`Lexicon ${v.version} downloaded.`, 'Use it now', () => { prepare(data); D.similar = similar; render(); });
    msg(`Downloaded ${v.version}. It is stored on this device.`);
  } catch (e) { if (manual) msg('Could not reach the data source: ' + e.message); }
}
function showBanner(text, btn, fn) {
  const b = $('#banner'); b.hidden = false;
  b.innerHTML = `<span>${esc(text)}</span><span class="sp"></span><button class="btn primary">${esc(btn)}</button><button class="btn" aria-label="Dismiss">×</button>`;
  const [ok, x] = b.querySelectorAll('button');
  ok.onclick = () => { b.hidden = true; fn(); }; x.onclick = () => { b.hidden = true; };
}

// ------------------------------------------------------------ events
function wire() {
  const q = $('#q');
  let tmr;
  q.addEventListener('input', () => {
    clearTimeout(tmr);
    tmr = setTimeout(() => {
      state.q = q.value;
      const target = q.value.trim() ? '#/q/' + encodeURIComponent(q.value) : '#/';
      const from = route().view;
      if (from !== 'q' && from !== 'home') { location.hash = target; return; }   // keep the page we came from in history
      if (location.hash !== target) history.replaceState(null, '', target);
      render();
    }, 60);
  });
  q.addEventListener('keydown', ev => {
    const items = [...document.querySelectorAll('.rescol a.item')].filter(a => a.offsetParent);
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      if (!items.length) return; ev.preventDefault();
      selIdx = ev.key === 'ArrowDown' ? Math.min(items.length - 1, selIdx + 1) : Math.max(0, selIdx - 1);
      items.forEach((a, i) => a.classList.toggle('sel', i === selIdx)); items[selIdx].scrollIntoView({block: 'nearest'});
    } else if (ev.key === 'Enter') {
      const a = items[selIdx >= 0 ? selIdx : 0]; if (a) { location.hash = a.getAttribute('href'); q.blur(); }
    } else if (ev.key === 'Escape') { q.value = ''; go('#/'); }
  });
  $('#qclear').onclick = () => { q.value = ''; state.q = ''; go('#/'); q.focus(); };
  document.addEventListener('keydown', ev => {
    if (ev.key === '/' && document.activeElement !== q && !/input|textarea/i.test(document.activeElement.tagName)) { ev.preventDefault(); q.focus(); q.select(); }
  });
  window.addEventListener('scroll', () => { scrollMemo.set(location.hash, window.scrollY); }, {passive: true});
  document.addEventListener('toggle', ev => { if (ev.target.closest && ev.target.closest('.summary')) LS.set('sumOpen', ev.target.open); }, true);
  window.addEventListener('hashchange', render);
  document.addEventListener('click', async ev => {
    const t = ev.target.closest('button'); if (!t) return;
    const d = t.dataset;
    if (d.try) { q.value = d.try; state.q = d.try; go('#/q/' + encodeURIComponent(d.try)); }
    else if (d.lang) { state.lang = d.lang; saveState(); render(); }
    else if (d.rt) { state.resTab = d.rt; render(); }
    else if (d.fav) { state.fav = isFav(d.fav) ? state.fav.filter(x => x !== d.fav) : [d.fav, ...state.fav]; saveState(); render(); toast(isFav(d.fav) ? 'Saved' : 'Removed from saved'); }
    else if (d.cmp) {
      // first press anchors this disease; a press on another disease while one is waiting makes the pair
      if (state.cmp.length === 1 && state.cmp[0] !== d.cmp) state.cmp = [state.cmp[0], d.cmp];
      else state.cmp = [d.cmp];
      saveState(); go('#/compare');
    }
    else if (d.pair) { state.cmp = d.pair.split('|'); saveState(); go('#/compare'); }
    else if ('sumtoggle' in d) { LS.set('sumHidden', !LS.get('sumHidden', false)); render(); }
    else if (d.cmprm) { state.cmp = state.cmp.filter(x => x !== d.cmprm); saveState(); render(); }
    else if ('cmpclear' in d) { state.cmp = []; saveState(); render(); }
    else if ('cmpadd' in d) { if (!state.cmp.includes(d.cmpadd) && state.cmp.length < 4) state.cmp.push(d.cmpadd); saveState(); render(); const i = $('#cmpq'); if (i && !i.disabled) i.focus(); }
    else if (d.jump) { const el = document.getElementById(d.jump); if (el) window.scrollTo({top: el.getBoundingClientRect().top + window.scrollY - ($('.top').offsetHeight + 12), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'}); }
    else if ('reveal' in d) { const a = t.nextElementSibling; a.hidden = !a.hidden; t.textContent = a.hidden ? 'Show answer' : 'Hide answer'; }
    else if (d.copy) { try { await navigator.clipboard.writeText(d.copy); toast('Copied'); } catch (e) { toast(d.copy); } }
    else if (d.browse) go('#/browse/' + d.browse);
    else if ('clearhist' in d) { state.hist = []; saveState(); render(); }
    else if ('update' in d) { state.source = $('#src').value.trim(); saveState(); checkUpdate(true); }
    else if ('savesrc' in d) { state.source = $('#src').value.trim(); saveState(); toast('Source saved'); }
    else if (d.themeSet) { LS.set('theme', d.themeSet); applyTheme(); render(); }
    else if ('syncnow' in d) { t.disabled = true; await sync.run(true); if (route().view === 'new') render(); }
    else if (d.entall) {
      // bulk: every item in the source group (default "new") gets the chosen status; one tap to undo
      const from = d.entallFrom || 'new', m = await sync.all();
      const keys = Object.keys(m).filter(k => m[k].status === from);
      if (!keys.length) return;
      keys.forEach(k => { m[k].status = d.entall; });
      await sync.save(m); await refreshAlarm(); render();
      const label = d.entall === 'accepted' ? `Added ${keys.length} to the queue` : d.entall === 'dismissed' ? `Dismissed ${keys.length}` : `Moved ${keys.length} back to new`;
      showBanner(label + '.', 'Undo', async () => { const mm = await sync.all(); keys.forEach(k => { if (mm[k]) mm[k].status = from; }); await sync.save(mm); await refreshAlarm(); render(); });
    }
    else if (d.ent) { const m = await sync.all(); if (m[d.key]) { m[d.key].status = d.ent; await sync.save(m); } await refreshAlarm(); render(); }
    else if (d.stub) { const m = await sync.all(); const y = yamlStub(m[d.stub]); try { await navigator.clipboard.writeText(y); toast('YAML stub copied'); } catch (e) { toast('Copy blocked — see console'); console.log(y); } }
    else if ('stuball' in d) { const m = await sync.all(); const y = Object.values(m).filter(x => x.status === 'accepted').map(yamlStub).join('\n'); try { await navigator.clipboard.writeText(y); toast('Queued items copied'); } catch (e) { console.log(y); toast('Copy blocked'); } }
    else if ('updateall' in d) { t.disabled = true; await updateAll(); }
    else if ('notifyon' in d) { try { const p = await Notification.requestPermission(); LS.set('notify', p === 'granted'); toast(p === 'granted' ? 'Desktop notifications on' : 'Notifications were not allowed'); } catch (e) { toast('Notifications are not available here'); } render(); }
    else if (d.remind) { LS.set('remindDays', +d.remind); render(); }
    else if ('install' in d) { if (deferredInstall) { deferredInstall.prompt(); deferredInstall = null; } }
    else if ('syncon' in d) { LS.set('syncOn', !sync.enabled()); render(); }
    else if (d.syncsrc) { const cur = sync.sources(); LS.set('syncSrc', cur.includes(d.syncsrc) ? cur.filter(x => x !== d.syncsrc) : [...cur, d.syncsrc]); render(); }
  });
  document.addEventListener('input', ev => {
    if (ev.target.id !== 'cmpq') return;
    const box = $('#cmpres'); const v = ev.target.value.trim();
    if (!v) { box.hidden = true; return; }
    const r = search(v);
    const list = r ? r.dx.filter(x => !state.cmp.includes(x.e.id)).slice(0, 12) : [];
    box.hidden = false;
    box.innerHTML = list.length ? list.map(x => `<button data-cmpadd="${esc(x.e.id)}">${esc(x.e.name)}</button>`).join('') : '<div class="small muted" style="padding:8px 12px">No disease matches</div>';
  });
  window.addEventListener('online', () => { checkUpdate(false); sync.maybeAuto(); if (route().view === 'home') render(); });
  window.addEventListener('offline', () => { if (route().view === 'home') render(); });
}
function applyTheme() {
  const t = LS.get('theme', 'system');
  if (t === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
}

// ------------------------------------------------------------ literature watch (PubMed / AAN journals)
// Runs on the user's device. Sends only fixed search terms to NCBI E-utilities — never user data.
// Finds disease/sign names in recent titles that are not in the lexicon and raises a "New entities!" alarm.
const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/';
const AAN_JOURNALS = ['Neurology', 'Neurol Neuroimmunol Neuroinflamm', 'Neurol Genet', 'Neurol Clin Pract', 'Continuum (Minneap Minn)', 'Ann Clin Transl Neurol'];
const AAN_SET = new Set(AAN_JOURNALS.slice(0, 5).map(j => j.toLowerCase()));
const NOVEL_TI = '(novel[ti] OR new[ti] OR newly[ti] OR "first report"[ti] OR "first description"[ti] OR unrecognized[ti] OR unrecognised[ti] OR "expanding the"[ti] OR emerging[ti] OR "a distinct"[ti])';
const ENTITY_TI = '(syndrome[ti] OR disease[ti] OR disorder[ti] OR sign[ti] OR phenomenon[ti] OR encephalitis[ti] OR encephalopathy[ti] OR neuropathy[ti] OR nodopathy[ti] OR myopathy[ti] OR ataxia[ti] OR leukodystrophy[ti] OR myelitis[ti] OR dystrophy[ti] OR antibody[ti] OR antibodies[ti])';
const SYNC_SOURCES = {
  aan: {label: 'AAN journals', term: () => `(${AAN_JOURNALS.map(j => `"${j}"[ta]`).join(' OR ')}) AND ${ENTITY_TI}`},
  pubmed: {label: 'PubMed neurology', term: () => `${NOVEL_TI} AND ${ENTITY_TI} AND ("Nervous System Diseases"[MeSH] OR neurolog*[tiab]) AND english[la]`}
};
const ENTITY_HEAD = /^(syndrome|disease|disorder|sign|phenomenon|test|reflex|encephalitis|encephalopathy|encephalomyelitis|neuropathy|polyneuropathy|nodopathy|myopathy|ataxia|leukodystrophy|leukoencephalopathy|myelitis|dystrophy|myositis|myasthenia|dystonia|epilepsy|cerebellitis|vasculopathy|radiculopathy|neuronopathy)$/i;
const STOP_LEFT = new Set(['a', 'an', 'the', 'of', 'in', 'with', 'and', 'or', 'for', 'to', 'by', 'from', 'on', 'as', 'is', 'are', 'novel', 'new', 'newly', 'emerging', 'distinct', 'rare', 'possible', 'probable', 'presumed', 'suspected', 'atypical', 'typical', 'unusual', 'first', 'report', 'case', 'cases', 'patient', 'patients', 'adult', 'adults', 'pediatric', 'paediatric', 'childhood', 'among', 'versus', 'vs', 'after', 'during', 'without', 'into', 'than', 'its', 'their', 'this', 'that', 'these', 'expanding', 'phenotype', 'spectrum', 'describing', 'described', 'identifying', 'unrecognized', 'unrecognised', 'previously', 'mimicking', 'presenting', 'due', 'associated', 'like', 'related']);
const GENERIC = new Set(['disease', 'neurological disease', 'neurologic disease', 'neurodegenerative disease', 'autoimmune disease', 'rare disease', 'genetic disease', 'inherited disease', 'neuromuscular disease', 'small vessel disease', 'disorder', 'neurological disorder', 'neurologic disorder', 'neurodevelopmental disorder', 'movement disorder', 'movement disorders', 'sleep disorder', 'syndrome', 'clinical syndrome', 'neurological syndrome', 'test', 'sign', 'phenomenon', 'encephalitis', 'encephalopathy', 'neuropathy', 'myopathy', 'ataxia', 'epilepsy', 'antibody', 'autoimmune encephalitis', 'peripheral neuropathy', 'polyneuropathy', 'dystonia', 'myelitis', 'bedside sign', 'clinical sign', 'physical sign', 'neurological sign', 'paraneoplastic syndrome', 'clinical phenotype', 'genetic disorder', 'rare disorder', 'functional disorder', 'neurological disorders', 'neurological diseases']);

function extractEntities(title) {
  const t = String(title || '').replace(/<[^>]+>/g, '').replace(/[“”"]/g, '');
  const words = t.split(/\s+/);
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const head = words[i].replace(/[^A-Za-z]/g, '');
    if (!ENTITY_HEAD.test(head)) continue;
    // walk left to collect modifiers, stop at punctuation or a stop word
    const parts = [words[i].replace(/[.,;:?!)\]]+$/, '')];
    for (let j = i - 1; j >= 0 && parts.length < 6; j--) {
      const raw = words[j];
      if (/[.,;:?!]$/.test(raw)) break;
      const w = raw.replace(/^[(\[]+|[)\]]+$/g, '');
      if (!w || STOP_LEFT.has(w.toLowerCase())) break;
      parts.unshift(w);
    }
    if (parts.length < 2) continue;
    let name = parts.join(' ').replace(/\s+/g, ' ').trim();
    const n = norm(name);
    if (GENERIC.has(n) || n.length < 6) continue;
    const isSign = /^(sign|phenomenon|test|reflex)$/i.test(head);
    out.push({name: name.charAt(0).toUpperCase() + name.slice(1), n, type: isSign ? 'sign' : 'dx'});
  }
  return out;
}
function knownInLexicon(n) {
  for (const e of D.all) if (e.nN === n || e._a.includes(n)) return e;
  // drop leading "anti " and trailing generic head to catch near-identical names
  const core = n.replace(/^anti /, '');
  for (const e of D.all) if (e.nN.includes(core) || e._a.some(a => a.includes(core))) return e;
  const r = search(n);
  const top = r && [...r.dx, ...r.signs].sort((a, b) => b.s - a.s)[0];
  if (top && top.s >= 150 && top.full) return top.e;
  return null;
}
const sync = {
  async all() { return (await idb.get('entities')) || {}; },
  async save(m) { await idb.set('entities', m); },
  enabled() { return LS.get('syncOn', true); },
  sources() { return LS.get('syncSrc', ['aan', 'pubmed']); },
  last() { return LS.get('syncLast', 0); },
  async fetchJSON(url) {
    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 15000);
    try { const r = await fetch(url, {signal: ctl.signal, cache: 'no-store'}); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
    finally { clearTimeout(tm); }
  },
  async run(manual) {
    const msg = m => { const el = $('#syncmsg'); if (el) el.textContent = m; };
    if (!navigator.onLine) { if (manual) msg('Offline — sync will run when you are back online.'); return; }
    const since = sync.last();
    const days = since ? Math.min(90, Math.max(1, Math.ceil((Date.now() - since) / 864e5) + 1)) : 60;
    msg(`Checking the last ${days} days…`);
    const store = await sync.all();
    let papers = 0, added = 0;
    try {
      for (const key of sync.sources()) {
        const src = SYNC_SOURCES[key]; if (!src) continue;
        const q = encodeURIComponent(src.term());
        const s = await sync.fetchJSON(`${EUTILS}esearch.fcgi?db=pubmed&retmode=json&retmax=200&sort=pub_date&datetype=edat&reldate=${days}&term=${q}&tool=sanctum-of-neurology`);
        const ids = (s.esearchresult && s.esearchresult.idlist) || [];
        if (!ids.length) continue;
        await new Promise(r => setTimeout(r, 400));   // NCBI asks for ≤3 requests/second without a key
        const sum = await sync.fetchJSON(`${EUTILS}esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(',')}&tool=sanctum-of-neurology`);
        const res = sum.result || {};
        for (const id of res.uids || []) {
          const a = res[id]; if (!a) continue;
          papers++;
          const journal = a.source || a.fulljournalname || '';
          const tag = AAN_SET.has(journal.toLowerCase()) ? 'AAN' : 'PubMed';
          for (const ent of extractEntities(a.title)) {
            if (knownInLexicon(ent.n)) continue;
            const ev = {pmid: id, title: a.title, journal, date: a.pubdate || a.sortpubdate || '', src: tag};
            const cur = store[ent.n];
            if (!cur) { store[ent.n] = {name: ent.name, type: ent.type, status: 'new', first: Date.now(), ev: [ev]}; added++; }
            else if (!cur.ev.some(x => x.pmid === id)) cur.ev.push(ev);
          }
        }
        await new Promise(r => setTimeout(r, 400));
      }
      await sync.save(store);
      LS.set('syncLast', Date.now());
      msg(`Scanned ${papers} papers · ${added} new candidate${added === 1 ? '' : 's'} · ${new Date().toLocaleString()}`);
      await refreshAlarm();
      if (added && route().view !== 'new') toast(`New entities! ${added} found`);
      if (added) notifyDesktop(`New entities! ${added} found`, Object.values(store).filter(x => x.status === 'new').slice(0, 3).map(x => x.name).join(', '));
      if (route().view === 'home') render();
    } catch (e) {
      msg(`Sync failed: ${e.name === 'AbortError' ? 'timed out' : e.message}. This needs the installed app or HTML file with internet; the claude.ai preview blocks outside connections.`);
    }
  },
  maybeAuto() { if (sync.enabled() && Date.now() - sync.last() > 864e5) sync.run(false); }
};
function notifyDesktop(title, body) {
  try { if ('Notification' in window && Notification.permission === 'granted' && LS.get('notify', false)) new Notification(title, {body, tag: 'sanctum-new'}); } catch (e) {}
}
function daysSince(t) { return t ? Math.floor((Date.now() - t) / 864e5) : null; }
function remindDays() { return LS.get('remindDays', 7); }
// Banner on the home screen: alarm with an Update button when online, or a reminder to go online when the last check is old.
function reminderHTML() {
  const online = navigator.onLine, d = daysSince(sync.last()), n = state.newCount || 0;
  if (n) return `<div class="alarmbar"><span class="msg"><span class="dot"></span> <b>New entities!</b> ${n} disease/sign name${n > 1 ? 's' : ''} from recent PubMed/AAN papers ${n > 1 ? 'are' : 'is'} not in the lexicon.
    ${online ? '' : ' <span class="muted">Connect to the internet to refresh the evidence and download lexicon updates.</span>'}</span><span class="sp"></span>
    <a class="btn" href="#/new">Review</a>${online ? '<button class="btn primary" data-updateall>Update now</button>' : ''}</div>`;
  if (sync.enabled() && (d == null || d >= remindDays())) return `<div class="remindbar"><span><b>Time to update.</b> ${d == null ? 'The literature watch has not run on this device yet.' : `Last check for new diseases/signs was ${d} day${d === 1 ? '' : 's'} ago.`}
    ${online ? '' : ' Connect to the internet — the app works offline, but updates need a connection.'}</span><span class="sp"></span>${online ? '<button class="btn primary" data-updateall>Update now</button>' : '<span class="st auto">offline</span>'}</div>`;
  return '';
}
async function updateAll() {
  toast('Updating…');
  await checkUpdate(true);
  await sync.run(true);
  render();
}
async function refreshAlarm() {
  const m = await sync.all();
  const n = Object.values(m).filter(x => x.status === 'new').length;
  const b = $('#alarm');
  if (b) { b.hidden = !n; b.querySelector('b').textContent = n; }
  state.newCount = n;
}
function yamlStub(x) {
  const ev = x.ev.slice(0, 3).map(e => `#   PMID ${e.pmid} — ${e.journal} ${e.date}: ${e.title}`).join('\n');
  return x.type === 'sign'
    ? `# candidate from literature watch\n${ev}\n- new: true\n  name: "${x.name}"\n  kind: pn\n  formal: ""\n  simple: ""\n  syn: []\n  exam: ""\n  pos: ""\n  loc: []\n  dx: []\n`
    : `# candidate from literature watch\n${ev}\n- new: true\n  name: "${x.name}"\n  cat: diagnosis\n  formal: ""\n  simple: ""\n  syn: []\n  th: ""\n  tempo: []\n  loc: []\n  sys: []\n  feat: []\n  inv: []\n  ddx: []\n  read: []\n`;
}
async function viewNew() {
  const m = await sync.all();
  const items = Object.entries(m).sort((a, b) => (b[1].ev.length - a[1].ev.length) || b[1].first - a[1].first);
  const group = st => items.filter(([, x]) => x.status === st);
  const card = ([k, x]) => `<li class="newent ${x.status}"><div class="nm"><span>${esc(x.name)}</span> <span class="tag">${x.type === 'sign' ? 'sign?' : 'disease?'}</span>
      ${[...new Set(x.ev.map(e => e.src))].map(s => `<span class="st ${s === 'AAN' ? 'cur' : 'auto'}">${s}</span>`).join('')}<span class="small muted">${x.ev.length} paper${x.ev.length > 1 ? 's' : ''}</span></div>
    <ul class="evid">${x.ev.slice(0, 4).map(e => `<li><a href="https://pubmed.ncbi.nlm.nih.gov/${esc(e.pmid)}/" target="_blank" rel="noopener">${esc(e.title)}</a> <span class="muted small">${esc(e.journal)} · ${esc(e.date)}</span></li>`).join('')}</ul>
    <div class="actions">${x.status !== 'accepted' ? `<button class="btn primary" data-ent="accepted" data-key="${esc(k)}">Add to lexicon queue</button>` : ''}
      ${x.status !== 'dismissed' ? `<button class="btn" data-ent="dismissed" data-key="${esc(k)}">Not new / dismiss</button>` : `<button class="btn" data-ent="new" data-key="${esc(k)}">Restore</button>`}
      <button class="btn" data-stub="${esc(k)}">Copy YAML stub</button><a class="btn" href="#/q/${encodeURIComponent(x.name)}">Search lexicon</a></div></li>`;
  const sec = (title, list, note) => `<h2 class="sec">${title} <span class="count">${list.length}</span></h2>${list.length ? `<ul class="newlist">${list.map(card).join('')}</ul>` : `<p class="muted small">${note}</p>`}`;
  const last = sync.last();
  return `<div class="alarmhead"><h2 class="sec" style="margin:0">Literature watch</h2><span class="sp"></span><button class="btn primary" data-syncnow>Sync now</button></div>
    <p class="small muted" id="syncmsg">${last ? 'Last checked ' + new Date(last).toLocaleString() : 'Not run yet on this device.'} Sources: ${sync.sources().map(k => SYNC_SOURCES[k].label).join(', ')}.</p>
    <p class="small muted">Names are pulled automatically from recent paper titles and compared with the lexicon. Many will be variants or false alarms — a neurologist decides what is added. Accepted items go to the queue; copy their YAML stub into <code>content/</code>, write original text, then build.</p>
    ${group('new').length > 1 ? `<div class="bulk"><button class="btn primary" data-entall="accepted">Add all ${group('new').length} to queue</button><button class="btn ghost" data-entall="dismissed">Dismiss all</button></div>` : ''}
    ${sec('New entities', group('new'), 'Nothing new since the last check.')}
    ${sec('Queued for adding', group('accepted'), 'Accept a candidate to queue it here.')}
    ${group('accepted').length ? `<div class="actions" style="margin-top:10px"><button class="btn" data-stuball>Copy all queued as YAML</button>${group('accepted').length > 1 ? '<button class="btn ghost" data-entall-from="accepted" data-entall="new">Move all back to new</button>' : ''}</div>` : ''}
    ${sec('Dismissed', group('dismissed'), 'None.')}`;
}

// ------------------------------------------------------------ boot
async function boot() {
  applyTheme();
  handleQueryString();
  try { prepare(await loadData()); }
  catch (e) { $('#main').innerHTML = `<p class="empty">Could not load the lexicon (${esc(e.message)}). If you opened index.html directly from disk, use the single-file build or serve the folder over http.</p>`; return; }
  wire();
  render();
  if (!matchMedia('(hover:none)').matches && route().view === 'home') $('#q').focus();
  if ('serviceWorker' in navigator && /^https?:/.test(location.protocol) && !document.getElementById('inline-data')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  setTimeout(() => checkUpdate(false), 1500);
  refreshAlarm().then(() => { if (route().view === 'home') render(); }); setTimeout(() => sync.maybeAuto(), 3000);
  // while the app stays open: re-check every 6 hours when online
  setInterval(() => { if (navigator.onLine) checkUpdate(false); }, 30 * 60e3);   // lexicon: every 30 min while open
  document.addEventListener('visibilitychange', () => { if (!document.hidden && navigator.onLine) checkUpdate(false); });
  setInterval(() => { if (navigator.onLine) sync.maybeAuto(); else if (route().view === 'home') render(); }, 6 * 3600e3);
  window.__sanctum = {search, norm, D: () => D, extractEntities, knownInLexicon, sync, refreshAlarm};
}
boot();
})();
