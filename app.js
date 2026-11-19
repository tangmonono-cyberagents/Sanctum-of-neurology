/* Sanctum of Neurology — app logic (shared by PWA, single-file HTML and Electron builds). */
'use strict';
(() => {
const APP_VERSION = '1.7';
// Where online updates come from. PWA: same folder. Single-file/Electron: set in About → Data source.
const SITE_DATA = 'https://tangmonono-cyberagents.github.io/Sanctum-of-neurology/Sanctum-site/data/';   // GitHub Pages copy of the lexicon
const DEFAULT_SOURCE = (location.protocol === 'http:' || location.protocol === 'https:') && !document.getElementById('inline-data') ? './data/' : SITE_DATA;
const LOC_ORDER = ['cortex','subcortical','basal-ganglia','thalamus','cerebellum','brainstem','cranial-nerve','optic','vestibular','meninges','ventricles-csf','spinal-cord','anterior-horn','root','plexus','nerve','nmj','muscle','autonomic','multifocal','functional'];
const KIND = {pn: '[positive / negative]', side: '(right / left / both)', both: 'side + positive / negative'};

// ------------------------------------------------------------ storage (per device only)
const LS = {
  get(k, d) { try { const v = localStorage.getItem('sanctum.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('sanctum.' + k, JSON.stringify(v)); } catch (e) {} try { cloudDirty(k); } catch (e) {} }
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
function lx(fn, v) { try { if (window.__lx) window.__lx[fn](v); } catch (e) {} }   // loading-brain hooks never break the boot
async function loadBundled() {
  const el = document.getElementById('inline-data');
  if (el) return JSON.parse(el.textContent);
  // progress for the loading brain: count bytes as they stream in (sizes in version.json are uncompressed, as the reader sees them)
  let got = 0, total = 0;
  const tick = n => { got += n; if (total) lx('set', .04 + .86 * Math.min(1, got / total)); };
  const get = f => fetch('data/' + f).then(async r => {
    if (!r.ok) throw new Error(f + ' ' + r.status);
    if (!total || !r.body || !r.body.getReader || !window.TextDecoder) return r.json();
    const rd = r.body.getReader(), parts = []; let n = 0;
    for (;;) { const {done, value} = await rd.read(); if (done) break; parts.push(value); n += value.length; tick(value.length); }
    const buf = new Uint8Array(n); let o = 0; for (const c of parts) { buf.set(c, o); o += c.length; }
    return JSON.parse(new TextDecoder().decode(buf));
  });
  const version = await get('version.json');
  const sz = version.sizes || {};
  total = ['signs.json', 'diseases.json', 'meta.json', 'index.json'].reduce((a, k) => a + (sz[k] || 0), 0);
  // a hosting limit on file size can be met by listing version.dxParts (diseases split into several files)
  const dxGet = version.dxParts ? Promise.all(version.dxParts.map(get)).then(p => [].concat(...p)) : get('diseases.json');
  const [signs, dx, meta, index] = await Promise.all([get('signs.json'), dxGet, get('meta.json'), get('index.json')]);
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
  for (const d of D.dx) { d.t = 'dx'; D.all.push(d); }   // d.ph = symptom or phenomenon page: shown as a Sign, never a disease in a differential
  D.dx.forEach((d, i) => { d.ix = i; });
  D.dxAll = D.dx; D.ns = D.dx.filter(d => d.cat === 'neuroscience'); D.dx = D.dx.filter(d => d.cat !== 'neuroscience');
  for (const e of D.all) {
    byId.set(e.id, e);
    e._n = ' ' + e.nN + ' ';
    e._a = e.aN ? e.aN.split(' | ') : [];
    e._aj = ' ' + e._a.join(' | ') + ' ';
  }
  D.nea = new Map(D.dx.filter(d => d.nea != null).map(d => [d.nea, d]));
  for (const d of D.dx) for (const k of d.neaAlt || []) D.nea.set(k, d);           // merged duplicates keep their NEA links
  for (const [a, b] of Object.entries(D.meta.redirects || {})) if (byId.get(b)) byId.set(a, byId.get(b));   // old ids (saved, history, links)
  D.vocabSet = new Set(D.vocab);
  D.syn = new Map();
  for (const g of D.meta.syn) for (const t of g) D.syn.set(t, g);
  D.bodyReady = false;
  const build = (i) => { const end = Math.min(D.all.length, i + 400); for (; i < end; i++) { const e = D.all[i];
      e._b = ' ' + norm([e.formal, e.simple, e.more, e.exam, e.pos, (e.feat || []).join(' '), (e.inv || []).join(' ')].join(' ')) + ' ';
      e._d = ' ' + norm([e.formal, e.simple].join(' ')) + ' ';
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
  return (D.similar[d.ix] || []).map(([j, s, terms]) => ({e: D.dxAll[j], score: s / 100, terms})).filter(x => x.e && (x.e.cat === 'neuroscience') === (d.cat === 'neuroscience'));
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
  if (!s && !short && e._b && e._b.includes(' ' + v)) s = (e._d && e._d.includes(' ' + v) ? 18 : 12) + (e._b.includes(' ' + v + ' ') ? 3 : 0);
  if (!s && e._t && /[฀-๿]/.test(v)) { const i = e._t.indexOf(v); if (i >= 0) s = i < 60 ? 17 : 14; }
  return s;
}
// Thai keyboard (Kedmanee) → QWERTY, for text typed with the wrong keyboard language
const TH_KEYS = (() => {
  const lo = 'ๅ/-ภถุึคตจขช' + 'ๆไำพะัีรนยบลฃ' + 'ฟหกดเ้่าสวง' + 'ผปแอิืทมใฝ';
  const loK = '1234567890-=' + 'qwertyuiop[]\\' + "asdfghjkl;'" + 'zxcvbnm,./';
  const hi = '+๑๒๓๔ู฿๕๖๗๘๙' + '๐"ฎฑธํ๊ณฯญฐ,ฅ' + 'ฤฆฏโฌ็๋ษศซ.' + '()ฉฮฺ์?ฒฬฦ';
  const hiK = '!@#$%^&*()_+' + 'QWERTYUIOP{}|' + 'ASDFGHJKL:"' + 'ZXCVBNM<>?';
  const m = {};
  for (let i = 0; i < lo.length; i++) m[lo[i]] = loK[i];
  for (let i = 0; i < hi.length; i++) if (!(hi[i] in m)) m[hi[i]] = hiK[i];
  return m;
})();
function thaiToEn(v) { return [...v].map(c => TH_KEYS[c] || c).join(''); }
// ------------------------------------------------------------ free-text findings (no "+" needed)
const FREE_STOP = new Set(('a an the of in on at to for from and or with without but also plus patient pt man woman male female boy girl child baby infant adult lady gentleman ' +
  'one two three four five six seven eight nine ten several few couple gradual gradually sudden suddenly insidious slowly side sides both bilateral left right ' +
  'year years yr yrs old y o yo aged age has have had having is are was were be been being presents presented presenting complains complained complaining complaint ' +
  'history hx since about over past last day days week weeks month months hour hours ago onset new noted noticed shows showing showed reports reported c w ' +
  'left right side sided bilateral both his her their he she they it this that there which who after before during when then now some any very more less ' +
  'my me i we you your our mild moderate severe slight slightly gradually suddenly also episode episodes recurrent associated feel feels felt like can cannot could ' +
  'will would do does did not no without other others etc found examination exam on o e signs symptoms symptom sign finding findings case worse better evening morning afternoon daytime').split(' '));
const FREE_NEG = new Set(['no', 'not', 'denies', 'denied', 'deny', 'without', 'absent', 'negative', 'nil', 'none', 'never', 'normal', 'unremarkable']);
let PHR = null;
// ---- v0.84 present or absent is decided by the connective words typed in the case (curator's rule).
// A negative connective (without, negative for, no, denies, neither/nor, does not have, ไม่มี, ปฏิเสธ) makes every item joined to it
// by and / or / nor / commas absent, until a positive connective (with, positive for, has, plus, but, then, มี, ร่วมกับ) or the end
// of the sentence: "without or negative for cognitive involvement and numbness" = both absent; "with headache" = headache present.
// Onset and duration words are not findings: they go in front of the chief complaint in the problem list.
const SC_RULE = 'Decide present versus absent ONLY from the connective words typed in the case: a negative connective (without, negative for, no, denies, neither or nor, does not have, ไม่มี, ปฏิเสธ) makes EVERY item joined to it by and, or, nor or commas absent, until a positive connective (with, positive for, has, plus, but, then, มี, ร่วมกับ) or the end of the sentence. Example: "without or negative for cognitive involvement and numbness" = cognitive involvement absent AND numbness absent; "with headache" = headache present.';
const SC_PROTECT = /\b(worse|better|worsen\w*|improv\w*|eas(?:es|ed|ing)|relieved|aggravated|triggered|provoked|exacerbated|fill(?:ed)?|treated|managed|started|consistent|compatible|associated)\s+with\b/gi;
const SC_SPLIT = /(\bnegative for\b|\bpositive for\b|\bwithout\b|\bno\b|\bneither\b|\bnor\b|\bdenie[sd]\b|\bdeny(?:ing)?\b|\b(?:does|did|do) not (?:have|show|report|complain of)\b|\bfree of\b|\bassociated w\/|\balong with\b|\bas well as\b|\bpresent(?:s|ed|ing)? with\b|\bcomplain(?:s|ed|ing)? of\b|\bwith\b|\bplus\b|\bbut\b|\bhas\b|\bhave\b|\bhad\b|\bthen\b|\blater\b|\bsubsequently\b|\bdeveloped\b|\band\b|\bor\b|,|ไม่มีอาการ|ไม่มี|ไม่พบ|ปฏิเสธ|ร่วมกับ|ต่อมา|และ|หรือ|มีอาการ|มี)/i;
const SC_NEGW = /^(negative for|without|no|neither|nor|denie[sd]|deny(ing)?|(does|did|do) not (have|show|report|complain of)|free of|ไม่มีอาการ|ไม่มี|ไม่พบ|ปฏิเสธ)$/i;
const SC_CONT = /^(and|or|,|และ|หรือ)$/i;
const SC_ONSET = /\b(?:(?:rapidly |slowly )?(?:sudden(?:ly)?|abrupt(?:ly)?|hyperacute|acute(?:ly)?|subacute|gradual(?:ly)?|insidious(?:ly)?|chronic(?:ally)?|progressive(?:ly)?)(?:\s+(?:in\s+)?onset(?:\s+of)?)?|onset(?:\s+of)?)\b|ทันที|ฉับพลัน|เฉียบพลัน|ค่อย ?ๆ/gi;
const SC_DUR = /\b(?:for|over|since|x|past|last|within)?\s*(?:the\s+)?(?:\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|several|few|a few|couple of)\s*(?:-|to)?\s*(?:\d+\s*)?(?:minutes?|mins?|hours?|hrs?|days?|weeks?|wks?|months?|mos?|years?|yrs?)\b(?:\s+ago)?|\b\d+\s*(?:h|d|hr|wk)\b(?:\s+ago)?|\bsince\s+(?:yesterday|today|this morning|last night|this evening|last week|last month|childhood|birth|\w+day)\b|\b(?:yesterday|this morning|last night|today)\b|\bago\b|(?:\d+\s*)?(?:นาที|ชั่วโมง|วัน|สัปดาห์|เดือน|ปี)(?:ก่อน)?/gi;
const SC_FILL = /^(?:(?:of|the|a|an|patient|pt|he|she|they|is|was|were|are|now|also|that|which|new|presented|came|history|any|some|for|over|in|on|at|to|from|x|by|-|–|and|or|w\/)\s+)+|(?:\s+(?:of|the|a|an|for|over|since|in|on|at|to|x|and|or|is|was|-|–))+$/i;
const SC_DROP = /^(?:\d+\s*[- ]?(?:years?|yrs?|y)(?:[- ]old)?|(?:\d+\s*)?(?:years?|yrs?)[- ]old.*|male|female|man|woman|boy|girl|gentleman|lady|worse|better|again|onset|ปี)$/i;
function scSents(tx) {
  return String(tx || '').replace(/^\s*---.*---\s*$/gm, '\n').replace(VITAL_RX, ' ').split(/(?<!\d)\.(?!\d)|[\n;!?()\[\]]+|:(?!\s*\d)/).map(x => x.trim()).filter(Boolean);
}
// each sentence -> ordered segments {raw, pol}; and/or keep a positive item whole ("right arm and leg weakness"), but list negatives one by one
function scSegs(tx) {
  const out = [];
  scSents(tx).forEach((sent, si) => {
    const parts = sent.replace(SC_PROTECT, '$1 w/').split(SC_SPLIT);
    let pol = 'pos', cur = '';
    const flush = () => { const r = cur.replace(/w\//g, 'with').trim(); if (r) out.push({raw: r, pol, si}); cur = ''; };
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]; if (p == null) continue;
      if (i % 2 === 0) { cur += p; continue; }
      const c = p.trim().toLowerCase();
      if (SC_NEGW.test(c)) { flush(); pol = 'neg'; }
      else if (SC_CONT.test(c)) { if (pol === 'neg' || c === ',') flush(); else cur += ' ' + p + ' '; }
      else { flush(); pol = 'pos'; }
    }
    flush();
  });
  return out;
}
const SC_DEMO = /\b\d+\s*[- ]?(?:years?|yrs?|y)[- ]?old\b|\b\d+\s*(?:yo|y\/o)\b|\b(?:male|female|man|woman|boy|girl|gentleman|lady)\b|อายุ\s*\d+\s*ปี|(?:ผู้)?(?:ชาย|หญิง)/gi;
function scClean(raw) {
  let t = ' ' + String(raw || '').replace(SC_DEMO, ' ') + ' ';
  t = t.replace(SC_DUR, ' ').replace(SC_ONSET, ' ').replace(/\s+/g, ' ').trim();
  for (let k = 0; k < 3; k++) t = t.replace(SC_FILL, '').trim();
  if (!t || t.length < 3 || /^\d[\d\s.,%/-]*$/.test(t) || SC_DROP.test(t)) return '';
  return (t.charAt(0).toUpperCase() + t.slice(1)).slice(0, 70);
}
const SC_HIST = /^(known|history of|h\/o|underlying|case of|diagnosed|treated|underwent|undergone|status post|s\/p|post-?op\w*|on (?:\w+ )?(?:treatment|medication)|taking|ประวัติ|เป็นโรค)/i;
function caseFindings(tx) {
  const pos = [], neg = [], bg = [], seen = new Set();
  for (const s of scSegs(tx)) {
    const c = scClean(s.raw); if (!c) continue;
    const hist = s.pol === 'pos' && (SC_HIST.test(c) || PRIOR_RX.test(s.raw));
    const k = (hist ? 'h' : s.pol) + c.toLowerCase(); if (seen.has(k)) continue; seen.add(k);
    (hist ? bg : s.pol === 'neg' ? neg : pos).push(c);
  }
  return {pos: pos.slice(0, 14), neg: neg.slice(0, 14), bg: bg.slice(0, 6)};
}
// the case with every absent item removed (keeps onset and duration words for searching)
function scPosRaw(tx) {
  const by = new Map();
  for (const s of scSegs(tx)) if (s.pol === 'pos') { if (!by.has(s.si)) by.set(s.si, []); by.get(s.si).push(s.raw); }
  return [...by.values()].map(a => a.join(', ')).join('.\n');
}
// how many lexicon pages talk about a symptom (side, limb and severity words left out); under 3 = too little to work up from
const PAGE_STRIP = /\b(left|right|bilateral(?:ly)?|both|unilateral|one|sides?|sided|[a-z]+-sided|upper|lower|arms?|legs?|hands?|feet|foot|face|facial|limbs?|body|whole|half|mild|severe|new|worsening|recurrent|persistent|intermittent|of|the|a|an|on|in|at|my|his|her)\b/gi;
const PAGE_CACHE = new Map();
function lexPages(term) {
  const raw = String(term || '');
  if (/[฀-๿]/.test(raw) || !D.bodyReady) return null;
  const core = norm(raw.replace(PAGE_STRIP, ' ')).replace(/\s+/g, ' ').trim();
  if (!core) return 0;
  if (PAGE_CACHE.has(core)) return PAGE_CACHE.get(core);
  const forms = new Set([core, core + 's', core.replace(/(?<=\w\w)s$/, ''), core.replace(/(?<=\w\w)es$/, '')]);
  for (const g of D.meta.syn || []) { const ng = g.map(norm); if (ng.includes(core)) for (const x of ng) forms.add(x); }
  const pads = [...forms].filter(Boolean).map(f => ' ' + f + ' ');
  let n = 0; for (const e of D.all) if (pads.some(p => (e._b && e._b.includes(p)) || (e._n && e._n.includes(p)))) n++;
  PAGE_CACHE.set(core, n); return n;
}
// symptoms in the order typed (history clauses left out); a side/limb-only piece joins the next one
const SC_MOD = /\s+(?:worse|better|worsen\w*|improv\w*|eas(?:es|ed|ing)|relieved|aggravated|triggered|provoked|exacerbated|brought on|precipitated)\b.*$/i;
function chiefCands(tx) {
  const out = [];
  for (const s of scSegs(tx)) {
    if (s.pol !== 'pos' || SC_HIST.test(s.raw.trim()) || PRIOR_RX.test(s.raw)) continue;
    const bits = s.raw.replace(SC_PROTECT, '$1 w/').split(/\s+(?:and|or)\s+|และ|หรือ/i).map(b => scClean(b.replace(SC_MOD, '').replace(/w\//g, 'with'))).filter(Boolean);
    for (let i = 0; i < bits.length; i++) {
      if (!norm(bits[i].replace(PAGE_STRIP, ' ')).trim() && i + 1 < bits.length) { bits[i + 1] = bits[i] + ' and ' + bits[i + 1].charAt(0).toLowerCase() + bits[i + 1].slice(1); continue; }
      if (!out.some(o => o.term.toLowerCase() === bits[i].toLowerCase())) out.push({term: bits[i], pages: lexPages(bits[i]), raw: s.raw});
    }
  }
  return out.slice(0, 10);
}
const CHIEF_MIN_PAGES = 3;   // curator's rule: under 3 lexicon pages = too little information to work up from
// chief complaint = the first symptom typed, unless it has fewer than 3 lexicon pages: then the next symptom that has 3 or more
function pickChief(tx) {
  const cs = chiefCands(tx); if (!cs.length) return null;
  const i = cs.findIndex(c => c.pages == null || c.pages >= CHIEF_MIN_PAGES);
  if (i <= 0) return Object.assign({skipped: []}, cs[0]);
  return Object.assign({skipped: cs.slice(0, i).map(c => ({symptom: c.term, pages: c.pages}))}, cs[i]);
}
function phraseIndex() {
  if (PHR) return PHR;
  PHR = new Set();
  const add = t => { if (t && t.includes(' ') && t.split(' ').length <= 6) PHR.add(t); };
  for (const sg of D.signs) { add(sg.nN); for (const a of sg._a) add(a); }
  for (const g of D.meta.syn) for (const t of g) add(norm(t));
  return PHR;
}
const FREE_MAP = [
  [/\b(worse|weaker|worsens?|worsening)\s+(in the |in |at |towards? the |by the )?(evening|night|end of the day|later in the day|afternoon)\b/gi, ', fatigable, '],
  [/\b(worse|weaker|worsens?)\s+(with|after|on)\s+(use|exertion|exercise|activity|repetition)\b/gi, ', fatigable, '],
  [/\bworst headache of (my|his|her|their) life\b/gi, ', thunderclap headache, '],
  [/\b(can'?t|cannot|unable to|difficulty) (get up|rising|rise) from (a )?(chair|squat|floor)\b/gi, ', proximal weakness, '],
];
function freeFindings(raw) {
  raw = String(raw || '').replace(/^\s*---.*---\s*$/gm, '\n').replace(/\b(day|week|month)\s*\d+\s*:/gi, ',');
  raw = scPosRaw(raw);
  for (const [rx, to] of FREE_MAP) raw = raw.replace(rx, to);
  const chunks = raw.split(/[\n.;:!?()\[\]]+|,|\band\b|\bwith\b|\bplus\b|\balso\b|\bbut\b|และ|กับ|ร่วมกับ/i).map(norm).filter(Boolean);
  const out = [], phr = phraseIndex();
  for (const c of chunks) {
    if (/[฀-๿]/.test(c)) { for (const t of c.split(' ')) if (t.length > 1) out.push(t); continue; }
    const w = c.split(' ').filter(x => !/^\d+$/.test(x));
    for (let i = 0; i < w.length;) {
      let hit = 0;
      for (let L = Math.min(6, w.length - i); L >= 2; L--) { const ph = w.slice(i, i + L).join(' '), sg = ph.replace(/(?<=\w\w)s$/, ''); if (phr.has(ph)) { out.push(ph); hit = L; break; } if (sg !== ph && phr.has(sg)) { out.push(sg); hit = L; break; } }
      if (hit) { i += hit; continue; }
      // two or three plain words that often appear together in entries ("dark urine", "second wind") stay one finding
      if (D.bodyReady && !FREE_STOP.has(w[i]) && !FREE_NEG.has(w[i])) {
        let got = 0;
        for (let L = Math.min(3, w.length - i); L >= 2 && !got; L--) {
          const parts = w.slice(i, i + L);
          if (parts.some(x => FREE_STOP.has(x) || FREE_NEG.has(x) || x.length < 3)) continue;
          const ph = ' ' + parts.join(' ') + ' ';
          let n = 0; for (const e of D.all) { if (e._b && e._b.includes(ph) && ++n >= 3) break; }
          if (n >= 3) { out.push(parts.join(' ')); got = L; }
        }
        if (got) { i += got; continue; }
      }
      const t = w[i++];
      if (FREE_NEG.has(t)) break;   // "no fever", "denies headache": drop the rest of this phrase
      if (FREE_STOP.has(t) || t.length < 3) continue;
      out.push(t);
    }
  }
  return [...new Set(out)];
}

// ------------------------------------------------------------ search by case (type, dictate, photo; Claude when opened as an artifact)
const ICON_TRAIN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19V9l8-5 8 5v10"/><path d="M9 19v-5h6v5"/><path d="M12 8.5v2.5M10.7 9.8h2.6"/></svg>';
const ICON_CASE = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="3.5" width="14" height="17" rx="2"/><path d="M9 3.5h6v3H9zM8.5 11h7M8.5 14.5h7M8.5 18h4"/></svg>';
const AI = {ok: false, img: false, fn: null};
(async () => {
  try {
    if (!(window.claude && window.claude.use)) return;
    const fn = await window.claude.use('sample');
    if (!fn) return;
    AI.fn = fn; AI.ok = true;
    try { const lim = await fn.limits(); AI.img = !!(lim && lim.images); AI.mt = lim && lim.images ? lim.images.mediaTypes : null; AI.max = lim && lim.images ? lim.images.maxCount || 1 : 0; AI.maxBytes = lim && lim.images ? lim.images.maxInputBytes : 0; } catch (e) {}
    const v = route().view; if (v === 'case' || v === 'home') render();
  } catch (e) {}
})();
const CASE = {photos: [], busy: false, ctl: null, rec: null};
// waiting scene while Claude works on a case: the loading brain (no water) waits beside a pixel Chinese monk who reads a textbook
// Monk: five styles the viewer can pick in Settings (or by tapping the monk while waiting)
const MONK_BODY = ['.....rttttttttr.....','...rrrrrrrrrrrrrr...','..rrrbbbbbbbbbbrrr..','..rrbppppbppppbrr...',
  '..ssbpllpbpllpbss...','...rbppppbppppbr....','...rbbbbbbbbbbbr....','...rrrrrrrrrrrrr....','...RRRRR...RRRRR....','...kkkk.....kkkk....'];
const MONK_FACE = ['...sssssssssssss....','...ssswkwsswkwss....','...sssssssssssss....','...sssssssssssss....','...ssssssmmsssss....','....sssssssssss.....'];
const MONK_STYLES = [
  {id: 1, name: 'Chan monk', note: 'Shaved head with nine ordination dots, amber robe, prayer beads',
    head: ['......hhhhhhhh......', '....hhohhohhohhh....', '...hhssssssssssshh..', '...hsssssssssssssh..'].concat(MONK_FACE), body: MONK_BODY, sw: ['#e6b88c', '#d98a1f', '#4a2c1a']},
  {id: 2, name: 'Pilgrim', note: 'Straw travelling hat and a red kasaya sash, like a Tang-dynasty pilgrim',
    head: ['........aaaa........', '.....aaaaaaaaaa.....', '..AAAAAAAAAAAAAAAA..', '...hsssssssssssh....'].concat(MONK_FACE),
    body: MONK_BODY.map((r, i) => i === 1 ? '...KKKKrrrrrrrrrr...' : i === 2 ? '..KKrbbbbbbbbbbrrr..' : i === 3 ? '..KKbppppbppppbrr...' : r), sw: ['#d9b46a', '#c98a2c', '#b3261e']},
  {id: 3, name: 'Shaolin', note: 'Black headband, strong brows, steel-blue robe and a dark sash',
    head: ['......hhhhhhhh......', '....hhhhhhhhhhhh....', '...hhssssssssssshh..', '...BBBBBBBBBBBBBB...', '...sssssssssssss....', '...ssswkwsswkwss....', '...sssssssssssss....', '...sssssssssssss....', '...ssssssmmsssss....', '....sssssssssss.....'].map((r, i) => i === 4 ? '...sssskkssskkss....' : r),
    body: MONK_BODY.map((r, i) => i === 7 ? '...BBBBBBBBBBBBB....' : r), sw: ['#e6b88c', '#5d7f99', '#222222']},
  {id: 4, name: 'Abbot', note: 'White eyebrows and beard, deep maroon robe with a gold sash',
    head: ['......hhhhhhhh......', '....hhhhhhhhhhhh....', '...hhssssssssssshh..', '...hsssssssssssssh..', '...sssEEEssEEEss....', '...ssswkwsswkwss....', '...sssssssssssss....', '...sssssssssssss....', '...sssEEmmEEsss.....', '....sEEEEEEEEEs.....'],
    body: MONK_BODY.map((r, i) => i === 7 ? '...GGGGGGGGGGGGG....' : r), sw: ['#f4f4f4', '#8e2a2a', '#d4a72c']},
  {id: 5, name: 'Novice', note: 'Round-eyed young novice in a soft grey robe, no beads',
    head: ['......hhhhhhhh......', '....hhhhhhhhhhhh....', '...hhssssssssssshh..', '...hsssssssssssssh..', '...sssssssssssss....', '...ssswkwsswkwss....', '...ssswkwsswkwss....', '...soosssssssoos....', '...ssssssmmsssss....', '....sssssssssss.....'],
    body: MONK_BODY.map((r, i) => i === 0 ? '.....rrrrrrrrrr.....' : r), sw: ['#d8d2c4', '#9aa0a6', '#f49ab2']}];
function monkStyle() { const v = +LS.get('monk', 1); return MONK_STYLES.find(x => x.id === v) || MONK_STYLES[0]; }
const monkPx = (rows, y0) => rows.map((r, y) => [...r].map((c, x) => c === '.' ? '' : `<rect class="bd-${c}" x="${x * 4}" y="${(y + y0) * 4}" width="4" height="4"/>`).join('')).join('');
function buddySVG() {
  const m = monkStyle();
  return `<g class="cw-buddy bs-${m.id}" transform="translate(196 22)" data-monk-cycle="1"><g class="cw-head">${monkPx(m.head, 0)}<rect class="cw-glint" x="20" y="20" width="2" height="2"/><rect class="cw-glint cw-glint2" x="44" y="20" width="2" height="2"/></g>${monkPx(m.body, 10)}<rect class="cw-page" x="40" y="52" width="16" height="12"/></g>`;
}
// ---- Monk stands on the Search by case page waiting to be consulted: a random greeting and a random spot on every visit,
// never over the controls; drag him anywhere (he is startled while held).
const MONK_HELLO = [
  'What troubles bring you to my door, young one? Come, sit, and tell me.',
  'Ah, a seeker. Lay your case before me, and we shall walk the path together.',
  'Speak, friend. Which patient weighs upon your mind today?',
  'Even the longest road begins with a single sign. Show me yours.',
  'Come closer. What puzzle of the nerves have you brought to this old monk?',
  'The brain is a temple of many doors. Which one shall we open today?'];
const MONK_STARTLE = ['Whoa! Easy, easy!', 'Aiya! Gently with this old monk!', 'Hey! Mind my prayer beads!', 'Careful, young one!'];
const MONK_SETTLE = ['Hmm… this spot will do.', 'Very well, I shall wait here.', 'A fine place to meditate.'];
const MONK_AVOID = 'header.top, nav.nav, .casev textarea, .casev button, .casev select, .casev input, .casev label.btn, .casev a, .casev summary, .caseacts, .casephotos, .cwait, #casemsg';
const MONK_SOFT = '.casev h2, .casev p, .casenote, .casev .card, .casework, .rv';   // text he should rather not cover
const MG = {el: null, temple: null, moved: false, hello: '', dismissed: false};
const monkPick = a => a[Math.floor(Math.random() * a.length)];
function monkStartled(head) {
  const h = head.slice(), ei = h.findIndex(r => r.includes('wkw')), mi = h.findIndex(r => r.includes('mm'));
  if (ei > 0) h[ei - 1] = [...h[ei - 1]].map((c, x) => /[wk]/.test(h[ei][x]) ? 'w' : c).join('');
  if (mi >= 0) { const at = h[mi].indexOf('mm'); h[mi] = h[mi].slice(0, at) + 'kk' + h[mi].slice(at + 2);
    if (mi + 1 < h.length && h[mi + 1][at] === 's') h[mi + 1] = h[mi + 1].slice(0, at) + 'kk' + h[mi + 1].slice(at + 2); }
  return h;
}
const TEMPLE_ROWS = ['.........GG.........', '........GGGG........', '..RR....RRRR....RR..', '...RRRRRRRRRRRRRR...', '.RRRRRRRRRRRRRRRRRR.', 'RR..RRRRRRRRRRRR..RR',
  '....wwwwwwwwwwww....', '....wRwwwkkwwwRw....', '..RRRRRRRRRRRRRRRR..', '.RR.RRRRRRRRRRRR.RR.', '....wwwwwwwwwwww....', '....wRwwkkkkwwRw....', '....wRwwkkkkwwRw....', '....wRwwkkkkwwRw....', '..GGGGGGGGGGGGGGGG..', '.GGGGGGGGGGGGGGGGGG.'];
const templeSVG = () => `<svg viewBox="0 0 80 64" aria-hidden="true">${TEMPLE_ROWS.map((r, y) => [...r].map((c, x) => c === '.' ? '' : `<rect class="tp-${c}" x="${x * 4}" y="${y * 4}" width="4" height="4"/>`).join('')).join('')}</svg>`;
function monkGuardHTML() {
  const m = monkStyle();
  return `<div class="mg-say" role="note" aria-live="polite"><span class="mg-txt">${esc(MG.hello)}</span></div>
    <svg class="mg-px cw-buddy bs-${m.id}" viewBox="0 0 80 80" role="img" aria-label="Monk, waiting for your case. Drag to move him.">
      <g class="mg-calm">${monkPx(m.head, 0)}</g><g class="mg-shock">${monkPx(monkStartled(m.head), 0)}</g>${monkPx(m.body, 10)}</svg>
    <span class="mg-bang" aria-hidden="true">!</span>`;
}
function monkRects(sel = MONK_AVOID) { return [...document.querySelectorAll(sel)].map(e => e.getBoundingClientRect()).filter(r => r.width && r.height); }
function monkOverlap(x, y, w, h, rects) {   // viewport coordinates
  let a = 0; for (const r of rects) { const ox = Math.min(x + w, r.right) - Math.max(x, r.left), oy = Math.min(y + h, r.bottom) - Math.max(y, r.top); if (ox > 0 && oy > 0) a += ox * oy; }
  return a;
}
function monkPlace() {
  const el = MG.el; if (!el) return;
  const w = el.offsetWidth, h = el.offsetHeight, vw = document.documentElement.clientWidth, vh = window.innerHeight;
  const top0 = ($('header.top') || {getBoundingClientRect: () => ({bottom: 0})}).getBoundingClientRect().bottom + 6, rects = monkRects();
  const soft = monkRects(MONK_SOFT);
  let best = null;
  for (let i = 0; i < 160; i++) {   // first a spot clear of controls AND text, else clear of controls, else the least overlap
    const x = 6 + Math.random() * Math.max(0, vw - w - 12), y = top0 + Math.random() * Math.max(0, vh - top0 - h - 70);
    const a = monkOverlap(x, y, w, h, rects) * 1000 + monkOverlap(x, y, w, h, soft);
    if (!best || a < best.a) best = {x, y, a};
    if (a === 0) break;
  }
  el.style.left = Math.round(best.x + window.scrollX) + 'px'; el.style.top = Math.round(best.y + window.scrollY) + 'px';
}
function monkSay(t) { const s = MG.el && MG.el.querySelector('.mg-txt'); if (s) s.textContent = t; }
function monkGuard(view) {
  const off = view !== 'case' || !LS.get('monkGuard', true) || MG.dismissed;
  if (view !== 'case') MG.dismissed = false;
  if (off) { if (MG.el) { MG.el.remove(); MG.el = null; } if (MG.temple) { MG.temple.remove(); MG.temple = null; } return; }
  if (MG.el && document.body.contains(MG.el)) {
    MG.el.hidden = !!CASE.busy;
    if (!MG.moved && !CASE.busy) { const r = MG.el.getBoundingClientRect(); if (monkOverlap(r.left, r.top, r.width, r.height, monkRects()) > 0) monkPlace(); }
    return;
  }
  MG.moved = false; MG.hello = monkPick(MONK_HELLO);
  const el = document.createElement('div'); el.className = 'monkguard'; el.innerHTML = monkGuardHTML(); el.hidden = !!CASE.busy;
  document.body.appendChild(el); MG.el = el; monkPlace();
  const tp = document.createElement('div'); tp.className = 'mg-temple'; tp.setAttribute('aria-hidden', 'true');
  tp.innerHTML = templeSVG() + '<span>Drop Monk here to send him home</span>'; document.body.appendChild(tp); MG.temple = tp;
  const overTemple = ev => { const r = tp.getBoundingClientRect(); return ev.clientX >= r.left - 12 && ev.clientX <= r.right + 12 && ev.clientY >= r.top - 12 && ev.clientY <= r.bottom + 12; };
  const px = el.querySelector('.mg-px');
  let drag = null;
  px.addEventListener('pointerdown', ev => {
    ev.preventDefault(); px.setPointerCapture(ev.pointerId);
    drag = {dx: ev.pageX - el.offsetLeft, dy: ev.pageY - el.offsetTop, x0: ev.pageX, y0: ev.pageY};
    el.classList.add('grabbed'); monkSay(monkPick(MONK_STARTLE)); tp.classList.add('show');
  });
  px.addEventListener('pointermove', ev => {
    if (!drag) return;
    const maxX = document.documentElement.scrollWidth - el.offsetWidth - 4;
    el.style.left = Math.max(4, Math.min(maxX, ev.pageX - drag.dx)) + 'px'; el.style.top = Math.max(4, ev.pageY - drag.dy) + 'px';
    const hot = overTemple(ev); tp.classList.toggle('hot', hot); el.classList.toggle('homing', hot); if (hot) monkSay('Ah, the temple… time to rest.');
  });
  const drop = ev => {
    if (!drag) return;
    const moved = Math.abs(ev.pageX - drag.x0) + Math.abs(ev.pageY - drag.y0) > 4; drag = null;
    el.classList.remove('grabbed', 'homing'); if (moved) MG.moved = true;
    if (moved && overTemple(ev)) {   // dropped into the temple: he walks in and is gone until the next visit
      const r = tp.getBoundingClientRect(), mx = r.left + r.width / 2 + window.scrollX - el.offsetWidth / 2, my = r.top + window.scrollY - el.offsetHeight + 40;
      monkSay('Farewell, young one. Call me when you need me.'); el.classList.add('leaving'); el.style.left = mx + 'px'; el.style.top = my + 'px';
      MG.dismissed = true;
      setTimeout(() => { if (MG.el === el) { el.remove(); MG.el = null; } tp.classList.remove('show', 'hot'); setTimeout(() => { tp.remove(); if (MG.temple === tp) MG.temple = null; }, 400);
        toast('Monk went back to the temple. He returns next time; turn him off in Settings.'); }, 900);
      return;
    }
    tp.classList.remove('show', 'hot');
    monkSay(moved ? monkPick(MONK_SETTLE) : MG.hello);
  };
  px.addEventListener('pointerup', drop); px.addEventListener('pointercancel', drop);
}
function monkPreview(m) { return `<svg class="monkpv" viewBox="0 0 80 80" aria-hidden="true"><g class="cw-buddy bs-${m.id}">${monkPx(m.head, 0)}${monkPx(m.body, 10)}</g></svg>`; }
// Think harder (Opus): the monk reads so hard the book catches fire
const FLAME = ['..r..', '.rr..', '.ror.', 'roor.', 'rooor', 'royor', 'ryyor', '.ryr.'];
function flameSVG(x, y, k, d) {
  return `<g transform="translate(${x} ${y}) scale(${k})"><g class="cw-fl" style="animation-delay:${d}s">${FLAME.map((r, j) => [...r].map((c, i) => c === '.' ? '' : `<rect class="fl-${c}" x="${i * 4}" y="${j * 4}" width="4" height="4"/>`).join('')).join('')}</g></g>`;
}
function caseWaitHTML() {
  const hot = !!CASE.deep;
  const B = 'M52 118C30 118 18 102 22 86C10 78 12 58 28 52C26 34 44 22 62 28C70 14 92 10 104 20C116 10 140 12 148 26C166 24 182 40 176 58C190 68 188 90 174 98C176 114 160 124 144 120C136 132 116 134 106 124C96 134 74 134 66 122C61 122 56 121 52 118Z';
  return `<div class="cwait${hot ? ' hot' : ''}" role="img" aria-label="${hot ? 'Waiting while Monk thinks harder' : 'Waiting while Monk reads the case'}">
    <svg viewBox="0 0 300 116" aria-hidden="true">
      <g transform="translate(6 14) scale(.58)"><g class="cw-brain">
        <path class="cw-glass" d="${B}"/>
        <path class="cw-gyri" d="M62 28C66 40 60 50 50 54M104 20C100 32 106 42 118 44M148 26C140 36 146 48 158 52M28 52C40 58 44 68 40 78M176 58C166 64 164 76 172 84M106 124C104 112 112 106 124 106M66 122C70 110 64 102 54 100M84 34C90 42 86 50 92 58"/>
        <path class="cw-edge" d="${B}"/>
        <ellipse class="cw-blush" cx="76" cy="96" rx="7" ry="3.8"/><ellipse class="cw-blush" cx="136" cy="96" rx="7" ry="3.8"/>
        <g class="cw-eyes"><ellipse cx="90" cy="86" rx="4.6" ry="5.4"/><ellipse cx="126" cy="86" rx="4.6" ry="5.4"/></g>
        <circle class="cw-shine" cx="92" cy="84" r="1.5"/><circle class="cw-shine" cx="128" cy="84" r="1.5"/>
        <path class="cw-smile" d="M100 97Q108 104 116 97"/>
      </g></g>
      <g class="cw-dots"><rect x="150" y="40" width="6" height="6"/><rect x="162" y="34" width="6" height="6"/><rect x="174" y="28" width="6" height="6"/></g>
      ${hot ? `<g class="cw-fire">${flameSVG(206, 6, 1, 0)}${flameSVG(232, 0, 1.15, .15)}${flameSVG(256, 8, .95, .3)}</g>` : ''}
      ${buddySVG()}
      ${hot ? `<g class="cw-fire">${flameSVG(176, 70, 1, .1)}${flameSVG(190, 78, .8, .35)}${flameSVG(272, 72, .95, .2)}${flameSVG(286, 80, .75, .05)}</g><path class="cw-sweat" d="M52 22c-4 6-6 9-6 12a6 6 0 0 0 12 0c0-3-2-6-6-12z"/>` : ''}
    </svg>
    <p class="small muted">${hot ? 'Monk is meditating so hard the scroll caught fire · this takes a little longer…' : 'Monk is consulting the sacred texts…'}</p>
  </div>`;
}

function viewCase() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  return `<article class="casev">
    <h2 class="sec">Search by case</h2>
    <p class="small muted" style="margin:0 0 12px">Type or paste a history in English or Thai, or dictate it. You can also add several files at once${AI.img ? ' — photos of each page of the notes, results or charts, and text files' : ' (text files)'}. Sanctum picks out the findings and ranks diseases by how many of them each one explains. You can drop any finding afterwards.</p>
    <label class="sr" for="casetx">Case history</label>
    <textarea id="casetx" rows="7" placeholder="e.g. 45-year-old woman, two months of droopy eyelids and double vision worse in the evening, trouble swallowing, no numbness">${esc(state.caseText || '')}</textarea>
    ${CASE.photos.length ? `<div class="casephotos">${CASE.photos.map((ph, i) => `<figure><img alt="Attached image ${i + 1}" src="${ph.url}"><figcaption class="small">${esc(ph.name)}</figcaption><button class="iconx" data-casedelphoto="${i}" aria-label="Remove ${esc(ph.name)}">×</button></figure>`).join('')}</div><p class="small muted" style="margin:4px 0 0">${CASE.photos.length} image${CASE.photos.length > 1 ? 's' : ''} attached${AI.max ? ` (up to ${AI.max})` : ''}. <button class="linkbtn" data-casenophoto>Remove all</button></p>` : ''}
    <div class="caseacts">
      <button class="btn primary" data-casego${CASE.busy ? ' disabled' : ''}>${CASE.busy ? 'Reading…' : 'Find matching diseases'}</button>
      ${SR ? `<button class="btn" data-casemic aria-pressed="${!!CASE.rec}">${CASE.rec ? 'Stop dictation' : 'Dictate'}</button><select id="caselang" aria-label="Dictation language"><option value="th-TH"${state.caseLang === 'en-US' ? '' : ' selected'}>Thai</option><option value="en-US"${state.caseLang === 'en-US' ? ' selected' : ''}>English</option></select>` : ''}
      ${AI.img ? `<label class="btn">Take photo<input type="file" id="casecam" accept="image/*" capture="environment" hidden></label>` : ''}
      <label class="btn">${AI.img ? 'Add files' : 'Add text files'}<input type="file" id="casefile" multiple accept="${esc((AI.img ? (AI.mt || ['image/*']) : []).concat(['.txt', '.md', 'text/plain', 'text/markdown']).join(','))}" hidden></label>
      <button class="btn ghost" data-caseclear aria-label="Clear the text box, attached files and results">Clear all</button>
      ${CASE.busy ? '<button class="btn ghost" data-casestop>Stop</button>' : ''}
    </div>
    <p class="small" id="casemsg" role="status">${esc(state.caseMsg || '')}</p>
    ${CASE.busy ? caseWaitHTML() : ''}
    ${reviewHTML()}
    <div class="casenote small muted">${AI.ok
      ? 'Reading uses Monk (powered by Claude on your own Claude account; you are asked once). Remove names, hospital numbers and dates before sending. Findings are then matched on this device.'
      : 'Findings are picked out on this device (English works best). When Sanctum is opened as a Claude artifact, Monk can also read Thai text and photos.'}
      ${SR ? '' : ' To dictate, use the microphone key on your phone keyboard.'}</div>
  </article>`;
}
// Emergency and "rare but must not miss" hints for the on-device fallback (no Claude)
const DDX_EMERG = /(subarachnoid|aneurysmal sah|haemorrhag|hemorrhag|ischaemic stroke|ischemic stroke|lvo|basilar artery occlusion|large vessel|carotid dissection|vertebral artery dissection|venous (sinus )?thrombosis|bacterial meningitis|meningococcal|encephalitis|herpes simplex|brain abscess|status epilepticus|guillain|myasthenic crisis|myasthenia gravis|botulism|spinal cord compression|cauda equina|epidural abscess|pituitary apoplexy|giant cell arteritis|hypertensive encephalopathy|posterior reversible|wernicke|serotonin syndrome|neuroleptic malignant|raised intracranial pressure|herniation|transient ischaemic attack|cerebral venous)/i;
const DDX_EMERG_LIST = ['Acute ischaemic stroke', 'Intracerebral haemorrhage (ICH)', 'Subarachnoid haemorrhage', 'Basilar artery occlusion (top of the basilar syndrome)', 'Cervical artery dissection',
  'Transient ischaemic attack (TIA)', 'Bacterial meningitis', 'Herpes simplex encephalitis (HSE)', 'Tuberculous meningitis (TBM)', 'Cryptococcal meningitis', 'Brain abscess', 'Autoimmune encephalitis',
  'Status epilepticus', 'Guillain–Barré syndrome (GBS)', 'Myasthenic crisis', 'Botulism', 'Spinal cord compression', 'Cauda equina syndrome', 'Spinal epidural abscess', 'Transverse myelitis',
  'Giant-cell arteritis (GCA)', 'Pituitary apoplexy', 'Raised intracranial pressure', 'Reversible cerebral vasoconstriction syndrome (RCVS)', 'Posterior reversible encephalopathy syndrome (PRES)',
  'Hypertensive encephalopathy', 'Wernicke’s encephalopathy', 'Hypoglycaemia', 'Carbon monoxide poisoning', 'Organophosphate poisoning', 'Neuroleptic malignant syndrome (NMS)', 'Acute disseminated encephalomyelitis (ADEM)'];
// the differential lists diseases only: a name that resolves to a lexicon sign (or to nothing but a sign) is dropped
function ddxNotDisease(x) {
  if (x.e) return !isDisease(x.e);
  const hit = resolveFind(x.name);
  return !!(hit && !isDisease(hit));
}
function nameMatch(name) {
  const n = norm(name || '');
  if (!n) return null;
  let e = resolveFind(name);
  if (isDisease(e)) return e;
  const r = searchCore(name, 5);
  const top = r && r.dx && r.dx[0];
  return top && (top.e.nN === n || top.e._n.includes(' ' + n + ' ') || top.e._aj.includes(' ' + n) || n.includes(top.e.nN)) ? top.e : (e || null);
}
const VITAL_RX = /(?:\bBT\b|\btemp(?:erature)?\b|\bHR\b|\bPR\b|heart rate|pulse|\bBP\b|blood pressure|\bRR\b|resp(?:iratory)? rate|SpO2|SaO2|O2\s*sat(?:uration)?|vital signs?)\s*(?:[:=]|is|of)?\s*\d{1,3}(?:\.\d)?(?:\s*\/\s*\d{2,3})?\s*(?:°\s*)?(?:C|F|bpm|mmHg|%|\/min)?/gi;
function probFromText(tx) {
  return String(tx || '').replace(VITAL_RX, ' ').replace(/^\s*---.*---\s*$/gm, '\n').replace(/\b(day|week|month)\s*\d+\s*:/gi, ',').split(/[,;.\n]+/).map(x => x.trim()).filter(x => x && !/^(no|not|denies|denied|without|negative)\b/i.test(x) && !/^(worse|better|aggravated|relieved|triggered|precipitated|provoked|brought on|eased|improves?|exacerbated|for \d|since|over \d|lasting)\b/i.test(x) && !/\b(year|yr)s?[- ]old\b|^\d+\s*(y|yo|yrs?)\b|^(male|female|man|woman|boy|girl)$/i.test(x))
    .map(x => x.replace(/^(and|with|also|but)\s+/i, '')).map(x => x.charAt(0).toUpperCase() + x.slice(1)).slice(0, 8);
}
// Structured problem items: onset, duration, character and distribution (side, location), aggravating and relieving factors, pertinent negatives
const PL_ONSET = [[/\b(sudden(ly)?|abrupt(ly)?|thunderclap|instant(ly)?|woke (up )?with|on waking)\b|ทันที|ฉับพลัน|ทันใด/i, 'Sudden'], [/\bacute(ly)?\b|เฉียบพลัน/i, 'Acute'], [/\bsubacute\b/i, 'Subacute'],
  [/\b(gradual(ly)?|insidious(ly)?|slowly|progressive(ly)?|progressing|worsening over|creeping)\b|ค่อยๆ|ค่อย ๆ/i, 'Gradual'], [/\b(episod\w*|attacks?|intermittent|recurrent|comes and goes|spells?|paroxysm\w*|fluctuat\w*)\b|เป็นๆ ?หายๆ|เป็น ๆ หาย ๆ/i, 'Episodic / fluctuating'], [/\bchronic\b|เรื้อรัง/i, 'Chronic']];
const PL_DUR = /\b(?:for|over|since|x|past|last)?\s*((?:\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|several|few|a few|couple of)\s*(?:-|to)?\s*(?:\d+\s*)?(?:minutes?|mins?|hours?|hrs?|days?|weeks?|wks?|months?|mos?|years?|yrs?))\b(?![- ]old)|(\d+\s*(?:นาที|ชั่วโมง|ชม\.?|วัน|สัปดาห์|อาทิตย์|เดือน|ปี))(?!\s*(?:old))/i;
const PL_PART = 'face|facial|forehead|eye|eyes|eyelids?|lips?|mouth|tongue|throat|jaw|head|neck|shoulders?|arms?|upper limbs?|forearms?|elbows?|wrists?|hands?|fingers?|thumbs?|chest|trunk|abdomen|back|lower back|buttocks?|hips?|thighs?|legs?|lower limbs?|knees?|calf|calves|ankles?|feet|foot|toes?|whole body|ใบหน้า|หน้า|ตา|หนังตา|ปาก|ลิ้น|คอ|ไหล่|แขน|มือ|นิ้ว|หลัง|สะโพก|ขา|เท้า';
function plParse(tx, prob) {
  const text = String(tx || '').replace(/^\s*---.*---\s*$/gm, ' ');
  const sents = text.split(/[.\n]+/).map(x => x.trim()).filter(Boolean);
  const pl = prob.toLowerCase().slice(0, 40), sent = sents.find(x => x.toLowerCase().includes(pl)) || prob;
  const pick = (src, list) => { for (const [rx, v] of list) if (rx.test(src)) return v; return ''; };
  const onset = pick(sent, PL_ONSET) || (sents.length <= 2 ? pick(text, PL_ONSET) : '');
  const dm = sent.match(PL_DUR) || (sents.length <= 2 ? text.match(PL_DUR) : null);
  const sideRx = /\b(left|right|bilateral(ly)?|both sides|both|either side|alternating)\b|ซ้าย|ขวา|ทั้งสองข้าง|สองข้าง/gi;
  const sides = [...new Set((sent.match(sideRx) || []).map(x => x.toLowerCase().replace(/^both( sides)?$|^bilateral(ly)?$|ทั้งสองข้าง|สองข้าง/, 'bilateral').replace('ซ้าย', 'left').replace('ขวา', 'right')))];
  const diffuse = /\b(diffuse|generali[sz]ed|all over|whole body|global|holocephalic)\b|ทั้งตัว/i.test(sent);
  const site = sides.length > 1 && !sides.includes('bilateral') ? sides.join(' then ') : sides[0] || (diffuse ? 'diffuse' : '');
  const location = [...new Set((sent.match(new RegExp('\\b(' + PL_PART + ')\\b', 'gi')) || []).map(x => x.toLowerCase()))].join(', ');
  const grab = rx => { const m = sent.match(rx); return m ? m[m.length - 1].trim().replace(/\s+(and|but)$/i, '') : ''; };
  const aggravated = grab(/(?:worse(?:ns|ned|ning)?|aggravated|triggered|precipitated|provoked|brought on|exacerbated|increases?)\s+(?:with|on|when|after|in|at|during|by|from)?\s*([^,;]+?)(?=,|;|$| and (?:better|relieved|improv|eas)| but )/i);
  const relieved = grab(/(?:better|relieved|improv(?:es|ed|ing)?|eas(?:es|ed|ing)|resolv(?:es|ed)|settl(?:es|ed))\s+(?:with|on|after|when|by|in|at|during|from)?\s*([^,;]+?)(?=,|;|$| and | but )/i);
  const without = [];
  for (const m of sent.matchAll(/\b(?:no|denies|denied|without|not)\s+([^,;]+)/gi)) for (const t of m[1].split(/\s+(?:or|and|nor)\s+|\//)) { const v = t.trim(); if (v && v.length < 40) without.push(v); }
  let name = prob;
  if (dm) name = name.replace(dm[0], ' ');
  name = name.replace(/\bsince (yesterday|this (morning|afternoon|evening)|last night|today)\b|\b(this morning|yesterday)\b/gi, ' ').replace(/\b(sudden(ly)?|abrupt(ly)?|acute(ly)?|subacute|gradual(ly)?|insidious(ly)?|slowly|progressive(ly)?|intermittent|recurrent|episodic|chronic)\b/gi, ' ')
    .replace(/\b(on|of|in|at)\s+(the\s+)?(both sides|both|left|right)(\s+side)?\b|\b(left|right)[- ]sided\b|\bbilateral(ly)?\b/gi, ' ')
    .replace(/^\s*(of|for|with|since|over|x)\s+/i, '').replace(/\s+(of|for|with|on|in)\s*$/i, '').replace(/\s{2,}/g, ' ').trim();
  name = name ? name.charAt(0).toUpperCase() + name.slice(1) : prob;
  return {problem: name, onset, duration: dm ? (dm[1] || dm[2] || '').trim().toLowerCase() : '', character: '', site, location, aggravated, relieved, without};
}
function plNegatives(tx) {
  const out = [];
  for (const m of String(tx || '').matchAll(/\b(?:no|denies|denied|without|negative for)\s+([^,;.\n]+)/gi)) for (const t of m[1].split(/\s+(?:or|and|nor)\s+|\//)) { const v = t.trim(); if (v && v.length < 40 && !out.includes(v)) out.push(v); }
  return out.slice(0, 8);
}
// Symptoms that clearly share one timeline (stated together in one sentence, or with matching durations) become ONE problem;
// a symptom with its own, different time course stays a separate problem.
function plGroup(items, probs, tx) {
  const sents = String(tx || '').split(/[.\n]+/).map(x => x.toLowerCase());
  const meta = probs.map(p => { const k = String(p).toLowerCase().slice(0, 30); return {si: sents.findIndex(x => x.includes(k)), d: durOf(tx, p).d}; });
  const groups = [];
  items.forEach((it, i) => {
    const m = meta[i];
    let g = groups.find(g => g.idx.some(j => (m.si >= 0 && meta[j].si === m.si) || (m.d != null && meta[j].d != null && Math.max(m.d, meta[j].d) / Math.max(Math.min(m.d, meta[j].d), 1 / 24) <= 3)));
    // no time words of its own, stated right after a dated symptom: it belongs to that same episode
    if (!g && m.d == null && !it.onset && i > 0 && m.si > 0) { g = groups.find(g => g.idx.some(j => meta[j].si === m.si - 1 && meta[j].d != null)); if (g) m.d = meta[g.idx[0]].d; }
    if (g) g.idx.push(i); else groups.push({idx: [i]});
  });
  return groups.map(g => {
    const its = g.idx.map(i => items[i]), a = Object.assign({}, its[0]);
    if (its.length > 1) {
      const names = its.map(x => x.problem);
      a.problem = names[0] + ' with ' + names.slice(1).map(x => x.toLowerCase()).join(' and ');
      a.includes = names;
      for (const k of ['onset', 'duration', 'character', 'site', 'aggravated', 'relieved']) if (!a[k]) a[k] = (its.find(x => x[k]) || {})[k] || '';
      a.location = [...new Set(its.flatMap(x => String(x.location || '').split(/\s*,\s*/)).filter(Boolean))].join(', ');
      a.without = [...new Set(its.flatMap(x => x.without || []))];
    }
    if (!a.duration) { const du = durOf(tx, probs[g.idx[0]]); if (du.label) a.duration = du.label; }
    return a;
  });
}
function plLocal(tx, probs) {
  const items = plGroup(probs.map(p => plParse(tx, p)), probs, tx);
  const neg = plNegatives(tx), used = new Set(items.flatMap(i => i.without));
  const rest = neg.filter(n => !used.has(n));
  if (items.length && rest.length) items[0].without = items[0].without.concat(rest);
  return items;
}
// the chief complaint is problem 1; its onset and duration go in front of it and lead the etiology
function plChiefFirst(probs, chief) {
  const list = (probs || []).slice(); if (!chief || !chief.complaint) return list;
  const key = s => norm(String(s || '').replace(PAGE_STRIP, ' ')).trim();
  const ck = key(chief.raw || chief.complaint);
  let i = ck ? list.findIndex(p => !p.vital && [p.problem].concat(p.includes || []).some(x => { const k = key(x); return k && (k.includes(ck) || ck.includes(k)); })) : -1;
  if (i < 0) { list.unshift({problem: chief.complaint, onset: chief.onset || '', duration: chief.duration || '', character: '', site: chief.site || '', location: chief.location || '', aggravated: '', relieved: '', without: [], includes: []}); i = 0; }
  const it = Object.assign({}, list.splice(i, 1)[0], {chief: true});
  it.problem = scClean(it.problem) || it.problem;   // onset and duration are shown in front, not inside the name
  if (!it.onset || /not stated/i.test(it.onset)) it.onset = chief.onset || it.onset;
  if (!it.duration || /not stated/i.test(it.duration)) it.duration = chief.duration || it.duration;
  list.unshift(it);
  // a known disease or past treatment is background: it does not take the chief complaint's onset and duration
  return list.map((p, k) => k && !p.vital && SC_HIST.test(String(p.problem || '').trim()) ? Object.assign({}, p, {onset: '', duration: ''}) : p);
}
// curator rule: one timeline, one problem. Problems with the same stated onset AND the same stated duration are merged
// into the first of them (Sonnet sometimes splits them). Vital-sign problems and unstated time courses are left alone. (v1.7)
function plMergeTimeline(list) {
  const out = [], at = new Map(), k = s => norm(String(s || '')).trim(), unknown = s => !k(s) || /not stated|unknown/.test(k(s));
  for (const p of list || []) {
    if (!p || p.vital || unknown(p.onset) || unknown(p.duration)) { out.push(p); continue; }
    const key = k(p.onset) + '|' + k(p.duration), a = at.get(key);
    if (!a) { const c = Object.assign({}, p, {includes: (p.includes && p.includes.length ? p.includes : [p.problem]).slice()}); at.set(key, c); out.push(c); continue; }
    a.problem = a.problem + ' with ' + String(p.problem || '').replace(/^./, c => c.toLowerCase());
    a.includes = [...new Set(a.includes.concat(p.includes && p.includes.length ? p.includes : [p.problem]))];
    const join = (x, y, sep) => [...new Set([x, y].map(v => String(v || '').trim()).filter(v => v && !/^not stated$/i.test(v)))].join(sep);
    a.character = join(a.character, p.character, '; '); a.location = join(a.location, p.location, ', ');
    a.aggravated = join(a.aggravated, p.aggravated, '; '); a.relieved = join(a.relieved, p.relieved, '; ');
    if (!a.site || /not stated/i.test(a.site)) a.site = p.site || a.site;
    a.without = [...new Set((a.without || []).concat(p.without || []))]; a.chief = a.chief || p.chief;
  }
  return out;
}
function plNorm(p) {
  if (typeof p === 'string') return {problem: p};
  if (p && p.vital) return {problem: String(p.problem), vital: true, character: String(p.character || ''), rule: String(p.rule || '')};
  const S = x => String(x == null ? '' : x).trim(), A = x => Array.isArray(x) ? x.map(S).filter(Boolean) : (S(x) ? S(x).split(/\s*[;,]\s*/) : []);
  return {problem: S(p.problem || p.title || p.name), onset: S(p.onset), duration: S(p.duration), character: S(p.character || p.characteristic), site: S(p.site || p.side), location: S(p.location),
    aggravated: S(p.aggravated_by || p.aggravated || p.provoking), relieved: S(p.relieved_by || p.relieved || p.better_by), without: A(p.without || p.negatives), includes: Array.isArray(p.includes) ? p.includes.map(S).filter(Boolean) : [], chief: !!p.chief};
}
// vital signs in the history -> abnormal-vital problems (thresholds are general clinical conventions)
function plVitals(tx) {
  const t = String(tx || ''), out = [], N = '(\\d{2,3}(?:\\.\\d)?)';
  const add = (problem, value, rule) => { if (!out.some(o => o.problem === problem)) out.push({problem, vital: true, character: value, rule}); };
  let m = t.match(new RegExp('(?:\\bBT\\b|\\btemp(?:erature)?\\b|\\bT\\b|อุณหภูมิ|ไข้)\\s*(?:[:=]|is|of|วัดได้)?\\s*' + N + '\\s*(°?\\s*[CF])?', 'i'));
  if (m) { let v = parseFloat(m[1]); const f = (m[2] || '').toUpperCase().includes('F') || v > 45; const c = f ? (v - 32) * 5 / 9 : v;
    if (c >= 20 && c < 45) { const show = 'BT ' + (f ? v + ' °F (' + c.toFixed(1) + ' °C)' : v + ' °C');
      if (c > 37.8) add('Fever', show, 'above 37.8 °C'); else if (c < 35) add('Hypothermia', show, 'below 35 °C'); } }
  m = t.match(new RegExp('(?:\\bHR\\b|\\bPR\\b|heart rate|pulse|ชีพจร)\\s*(?:[:=]|is|of|rate)?\\s*' + N + '\\s*(?:bpm|/min|ครั้ง)?', 'i'));
  if (m) { const v = +m[1]; if (v >= 20 && v < 250) { const show = 'HR ' + v + ' bpm'; if (v < 60) add('Bradycardia', show, 'below 60 bpm'); else if (v > 100) add('Tachycardia', show, 'above 100 bpm'); } }
  m = t.match(/(?:\bBP\b|blood pressure|ความดัน(?:โลหิต)?)\s*(?:[:=]|is|of)?\s*(\d{2,3})\s*\/\s*(\d{2,3})/i);
  if (m) { const a = +m[1], b = +m[2]; if (a > b && a < 300) { const show = 'BP ' + a + '/' + b + ' mmHg';
    if (a < 90 || b < 60) add('Hypotension', show, 'below 90/60 mmHg'); else if (a >= 140 || b >= 90) add('Hypertension', show, '140/90 mmHg or higher'); } }
  m = t.match(/(?:\bRR\b|resp(?:iratory)? rate|อัตราการหายใจ)\s*(?:[:=]|is|of)?\s*(\d{1,2})\b/i);
  if (m) { const v = +m[1]; if (v >= 4 && v < 70) { const show = 'RR ' + v + '/min'; if (v > 20) add('Tachypnoea', show, 'above 20/min'); else if (v < 12) add('Bradypnoea', show, 'below 12/min'); } }
  m = t.match(/(?:SpO2|SaO2|O2\s*sat(?:uration)?|oxygen saturation)\s*(?:[:=]|is|of)?\s*(\d{2,3})\s*%?/i);
  if (m) { const v = +m[1]; if (v >= 40 && v <= 100 && v < 94) add('Hypoxaemia', 'SpO2 ' + v + '%', 'below 94%'); }
  return out;
}
function plAddVitals(probs, tx) {
  const have = (probs || []).map(p => String(p.problem || p).toLowerCase());
  return (probs || []).concat(plVitals(tx).filter(v => !have.some(h => h.includes(v.problem.toLowerCase()) || (v.problem === 'Fever' && /\bfever|pyrexia|febrile|ไข้/.test(h)))));
}
// Follow-up questions to ask, by presenting symptom (localization-driven; draft question set for expert review)
// each rule: [label, trigger regex, [[question, why, skip-if-already-stated regex, [[option label, sentence added to the case], ...]], ...]]
const ASK_RULES = [
  ['Numbness / sensory change', /numb|tingl|pins and needles|paraesth|parest|sensory loss|loss of sensation|burning feet|ชา(?![ยวต])|เหน็บ/i, [
    ['Which parts are numb: face, arm, hand, trunk, leg, foot? Is the leg involved too?', 'Face + arm + leg on one side points to brain or brainstem; one limb or part of it points to root, plexus or nerve', /\b(leg|legs|foot|feet|thigh|calf|toe)\b|ขา|เท้า/i,
      [['Leg numb too', 'The leg is also numb.'], ['No leg numbness', 'No leg numbness.']]],
    ['Does the numb area follow a dermatome strip, a single nerve territory (e.g. thumb to half of ring finger), a whole limb crossing several nerves, glove-and-stocking, or a level on the trunk?', 'Dermatome = root; nerve territory = mononeuropathy; several nerves in one limb = plexopathy; glove-stocking = polyneuropathy; trunk level = spinal cord', /dermatom|glove|stocking|sensory level|nerve territory|median|ulnar|radial|peroneal|plexus/i,
      [['Dermatome', 'The numbness follows a dermatome strip.'], ['Single nerve', 'The numbness is confined to a single nerve territory.'], ['Plexus', 'The numbness covers the whole limb across several nerves, a plexus pattern.'], ['Glove-stocking', 'Glove-and-stocking numbness.'], ['Trunk level', 'There is a sensory level on the trunk.'], ['Hemibody', 'The numbness covers one half of the body (hemibody, not a dermatome).']]],
    ['Is there root pain: sharp or shooting pain from the neck or back radiating along the limb, worse with coughing, sneezing, straining or neck/back movement?', 'Radiating pain provoked by Valsalva or movement suggests radiculopathy', /radiat|shooting|sciatica|root pain|ร้าวลง/i,
      [['Root pain', 'Radiating root pain along the limb, worse with coughing or neck/back movement.'], ['No root pain', 'No radiating root pain.']]],
    ['Is the face involved, and on the same side as the body or the opposite side?', 'Face and body on opposite sides (crossed) localises to the brainstem', /\bface\b|facial|หน้า/i,
      [['Face, same side', 'The face is numb on the same side.'], ['Face, opposite side', 'The face is numb on the opposite side (crossed).'], ['Face spared', 'The face is not involved.']]],
    ['Which sensations are lost: pain and temperature, or vibration and joint position? Unsteady in the dark or with eyes closed?', 'Dissociated loss separates spinothalamic from dorsal column involvement; sensory ataxia suggests large-fibre or dorsal column disease', /vibration|proprioce|temperature/i,
      [['Pain/temperature', 'Loss of pain and temperature sensation.'], ['Vibration/position', 'Loss of vibration and joint position sense, unsteady in the dark.'], ['All modalities', 'Loss of pain, temperature and vibration sense.']]],
    ['Any bladder or bowel change, saddle numbness, or a band-like feeling around the trunk?', 'Sphincter change, saddle loss or a trunk band suggests cord or cauda equina', /bladder|bowel|urin|saddle|incontin|ปัสสาวะ/i,
      [['Bladder/bowel change', 'Bladder and bowel change present.'], ['Saddle numbness', 'Saddle numbness present.'], ['None', 'No bladder or bowel change, no saddle numbness.']]]]],
  ['Weakness', /weak|paresis|plegia|can'?t lift|cannot lift|drop(ping)? things|foot drop|อ่อนแรง|ยกไม่ขึ้น/i, [
    ['What is the weakness pattern: tone and reflexes (stiff and brisk, or floppy and reduced), and which movements are weaker?', 'Spastic with brisk reflexes and Babinski = UMN; floppy with reduced reflexes, wasting or fasciculations = LMN; arm extensors and leg flexors weaker than their opposites = pyramidal distribution', /spastic|brisk|hyperreflex|hyporeflex|areflex|flaccid|babinski|pyramidal|tone|reflex/i,
      [['UMN pattern', 'Stiff, spastic weakness with brisk reflexes and an upgoing plantar response (UMN pattern).'], ['Pyramidal distribution', 'Weakness in pyramidal distribution: arm extensors and leg flexors weaker.'], ['LMN pattern', 'Floppy weakness with reduced reflexes and muscle wasting (LMN pattern).'], ['Reflexes reduced only', 'Reflexes are reduced or absent without spasticity.'], ['Not examined yet', 'Tone and reflexes have not been examined yet.']]],
    ['Is the lower face weak on the same side with the forehead spared, or is the whole half of the face weak?', 'Lower face weak with forehead spared (supranuclear) places the lesion above the upper pons (motor cortex, corona radiata, internal capsule, though peduncle or upper pons can also do it); whole hemiface weak suggests a facial nerve lesion', /forehead|upper face|lower face|facial droop|face droop|face is spared|whole hemiface/i,
      [['Lower face, forehead spared', 'Lower face weak on the same side with the forehead spared (supranuclear pattern).'], ['Whole hemiface weak', 'The whole half of the face is weak, forehead included.'], ['Face spared', 'The face is spared.']]],
    ['Is the weakness in proportion across face, arm and leg, or does one part dominate?', 'Face and arm worse = laterally placed cortico-subcortical lesion (MCA territory); leg worst = paracentral region (ACA territory); equal in face, arm and leg = internal capsule, often pure motor (also basis pontis, peduncle, medullary pyramid)', /faciobrachial|crural|proportionate|disproportionate|equal(ly)? (weak|in)|leg (is )?(worse|weaker)|arm and face (are )?worse|pure motor/i,
      [['Face and arm worse (faciobrachial)', 'Disproportionate weakness: face and arm worse than the leg (faciobrachial predominance).'], ['Leg worst (crural)', 'Disproportionate weakness: the leg is worse than the arm and face (crural predominance).'], ['Equal, pure motor', 'Proportionate weakness of face, arm and leg with no sensory loss (pure motor hemiparesis).'], ['Proportionate with other signs', 'Proportionate weakness of face, arm and leg with sensory loss.']]],
    ['Are there neighbouring cortical or crossed signs: aphasia, neglect or anosognosia, homonymous hemianopia, seizures, or a cranial nerve palsy on the opposite side of the weakness?', 'Aphasia (dominant) or neglect (non-dominant), visual field loss and seizures place it in the hemisphere; a cranial nerve palsy opposite the weak side places it in the brainstem (crossed syndrome, e.g. Weber)', /aphasia|neglect|anosognosia|hemianop|seizure|crossed|weber|cranial nerve palsy/i,
      [['Aphasia', 'Aphasia is present.'], ['Neglect/anosognosia', 'Neglect or anosognosia is present.'], ['Hemianopia', 'Homonymous hemianopia is present.'], ['Seizures', 'There were focal seizures.'], ['Crossed: opposite CN palsy', 'A cranial nerve palsy on the opposite side to the limb weakness (crossed brainstem pattern).'], ['None of these', 'No aphasia, neglect, visual field loss, seizures or cranial nerve palsy.']]],
    ['If one limb only (monoparesis): is there sensory loss, and do the signs suggest UMN (spastic, brisk reflexes) or LMN (wasting, reduced reflexes in a root, plexus or nerve pattern)?', 'Isolated UMN monoparesis = paracentral or ACA cortex or extramedullary cord (Brown-Séquard); LMN monoparesis = root, plexus or nerve', /monopar|monoplegi|single limb|one limb only|brown-s[ée]quard|ipsilateral proprioception/i,
      [['UMN monoparesis', 'Monoparesis of one limb with spasticity and brisk reflexes.'], ['LMN monoparesis', 'Monoparesis of one limb with wasting and reduced reflexes (root, plexus or nerve).'], ['Brown-Séquard pattern', 'Ipsilateral weakness with loss of joint position sense and contralateral loss of pain and temperature (Brown-Séquard pattern).']]],
    ['If both legs (paraparesis): is the face or arm spared, is there a sensory level or bladder change, and are knee and ankle reflexes brisk or reduced?', 'Parasagittal cerebral lesion, thoracic cord or peripheral (e.g. GBS) can all cause paraparesis; a sensory level with brisk reflexes below places it in the cord, while reduced reflexes suggest a peripheral cause', /parapar|paraplegi|both legs|sensory level|knee jerk|ankle jerk/i,
      [['Cord pattern', 'Both legs weak with a sensory level and brisk reflexes below it (spinal cord pattern).'], ['Peripheral pattern', 'Both legs weak with reduced or absent reflexes and no sensory level (peripheral pattern).'], ['Cerebral pattern', 'Both legs weak with preserved arms and urgency (parasagittal cerebral pattern).']]],
    ['Does the weakness look non-organic: equal across all muscle groups, face and plantar responses normal, reflexes normal, and the side-gait test equally poor in both directions?', 'These features favour a functional (conversion) cause', /functional|conversion|side-gait|non-organic|organic pattern|hoover/i,
      [['Looks functional', 'Weakness is equal in all muscle groups with normal reflexes and plantar responses, and the side-gait test is equally poor in both directions (functional features).'], ['Organic signs present', 'Examination shows a Babinski sign with abnormal reflexes, an organic pattern, not functional.']]],
    ['Which limbs: face-arm-leg on one side, both legs, all four limbs, or a single limb?', 'Hemiparesis = brain/brainstem; paraparesis = cord; quadriparesis = high cord, neuropathy, junction or muscle; one limb = root, plexus or nerve', /\b(both legs|all four|hemipar\w*|parapar\w*|quadri\w*|tetra\w*|left side|right side|one side|one limb)\b|ครึ่งซีก/i,
      [['Face-arm-leg, one side', 'Hemiparesis: face, arm and leg on one side.'], ['Both legs', 'Weakness of both legs (paraparesis).'], ['All four limbs', 'Weakness of all four limbs.'], ['One limb', 'Weakness of one limb only.']]],
    ['Is the weakness proximal (rising from a chair, combing hair) or distal (buttons, foot drop)?', 'Proximal symmetric weakness suggests muscle or junction; distal suggests neuropathy', /proximal|distal|rising from|comb|stairs|foot drop|button/i,
      [['Proximal', 'Proximal weakness (rising from a chair, combing hair).'], ['Distal', 'Distal weakness (buttons, foot drop).'], ['Both', 'Both proximal and distal weakness.']]],
    ['Does it get worse with use or later in the day and improve with rest?', 'Fatigable weakness points to the neuromuscular junction', /fatig|evening|worse with use|after rest|ช่วงเย็น/i,
      [['Fatigable', 'Weakness is worse with use and later in the day.'], ['Not fatigable', 'Weakness is not fatigable.']]],
    ['Any muscle wasting, twitching (fasciculations) or cramps?', 'Wasting and fasciculations indicate lower motor neuron disease', /wast|atroph|twitch|fascicul|cramp|ลีบ|กระตุก/i,
      [['Wasting', 'Muscle wasting present.'], ['Fasciculations', 'Fasciculations present.'], ['None', 'No wasting, fasciculations or cramps.']]],
    ['Any numbness, root pain, back pain or bladder change with the weakness?', 'Pure motor weakness narrows to anterior horn, junction or muscle; with sensory loss think root, plexus, nerve or central', /numb|tingl|sensory|bladder|back pain|ชา(?![ยวต])/i,
      [['With numbness', 'Numbness accompanies the weakness.'], ['With back pain', 'Back pain with the weakness.'], ['Pure motor', 'No numbness, no sensory loss, no bladder change.']]],
    ['Any trouble with speech, swallowing or double vision?', 'Bulbar or ocular involvement suggests brainstem, junction or a generalised process', /speech|slur|swallow|diplop|double vision|พูดไม่ชัด|กลืน/i,
      [['Slurred speech', 'Slurred speech present.'], ['Swallowing', 'Difficulty swallowing present.'], ['Double vision', 'Double vision present.'], ['None', 'No speech, swallowing or double vision problems.']]]]],
  ['Double vision', /diplop|double vision|seeing double|ภาพซ้อน|เห็นสองภาพ/i, [
    ['Does it go away when either eye is covered?', 'Binocular diplopia (goes away with one eye covered) is neurological; monocular diplopia is usually ocular', /monocular|binocular|cover/i,
      [['Binocular', 'Binocular diplopia: goes away when either eye is covered.'], ['Monocular', 'Monocular diplopia: persists with one eye covered.']]],
    ['Are the images side by side or one above the other, and worse looking in which direction or at distance versus near?', 'Horizontal worse at distance suggests VI nerve; vertical or tilted suggests III or IV nerve or skew deviation', /horizontal|vertical|side by side|above/i,
      [['Horizontal, worse far', 'Horizontal (side by side) images, worse at distance.'], ['Horizontal, worse near', 'Horizontal images, worse at near.'], ['Vertical/tilted', 'Vertical images, one above the other.']]],
    ['Any droopy eyelid, large pupil, eye pain or headache?', 'Ptosis with a dilated pupil and pain suggests compressive III nerve palsy', /ptosis|droop|pupil|eye pain|หนังตา/i,
      [['Ptosis', 'Droopy eyelid (ptosis) present.'], ['Large pupil', 'Large pupil on the affected side.'], ['Eye pain', 'Eye pain present.'], ['None', 'No ptosis, pupil change or eye pain.']]],
    ['Does it fluctuate or worsen when tired?', 'Fluctuating diplopia suggests myasthenia', /fluctuat|fatig|evening|tired/i,
      [['Fluctuates', 'Diplopia fluctuates and is worse when tired.'], ['Constant', 'Diplopia is constant and does not fluctuate.']]]]],
  ['Droopy eyelid', /ptosis|droop(y|ing)? (eye)?lid|eyelid droop|หนังตาตก/i, [
    ['One eye or both? Is the pupil on that side smaller or larger?', 'Small pupil = Horner syndrome; large pupil = III nerve; normal pupil and fluctuating = myasthenia', /pupil|both|bilateral|one eye/i,
      [['Small pupil', 'One eye; the pupil on that side is smaller.'], ['Large pupil', 'One eye; the pupil on that side is larger.'], ['Pupils normal', 'Pupils are equal and normal.'], ['Both eyes', 'Both eyelids are droopy.']]],
    ['Does it worsen in the evening or with sustained upgaze?', 'Fatigable ptosis suggests myasthenia', /evening|fatig|tired|ช่วงเย็น/i,
      [['Worse in evening', 'Ptosis worse in the evening.'], ['Not fatigable', 'Ptosis is not fatigable.']]],
    ['Any reduced sweating on that side of the face, or neck pain?', 'Anhidrosis and neck pain with Horner syndrome raise carotid dissection', /sweat|neck pain|dissection/i,
      [['Less sweating', 'Reduced sweating on that side of the face.'], ['Neck pain', 'Neck pain present.'], ['None', 'No sweating change or neck pain.']]]]],
  ['Dizziness / vertigo', /vertigo|dizz|spinning|giddy|light-?headed|บ้านหมุน|เวียนหัว|เวียนศีรษะ|มึนหัว/i, [
    ['Is it spinning, lightheaded (about to faint) or unsteady on the feet?', 'Spinning suggests vestibular; presyncope suggests cardiovascular or autonomic; imbalance suggests gait or sensory causes', /spin|faint|presyncop|unsteady|บ้านหมุน/i,
      [['Spinning', 'Spinning vertigo.'], ['Lightheaded', 'Lightheaded, about to faint (presyncope).'], ['Unsteady', 'Unsteady on the feet rather than spinning.']]],
    ['How long does each spell last (seconds, minutes, hours, days) and is it triggered by head position?', 'Seconds with position = BPPV; minutes = TIA or migraine; hours with hearing change = Ménière; days continuous = vestibular neuritis or stroke', /second|minute|hour|day|position|turning|lying/i,
      [['Seconds, positional', 'Spells last seconds, triggered by head position.'], ['Minutes', 'Spells last minutes.'], ['Hours', 'Spells last hours.'], ['Days, continuous', 'Continuous for days.']]],
    ['Any hearing loss, ringing or ear fullness?', 'Auditory symptoms point to the inner ear or the cerebellopontine angle', /hearing|tinnit|ear|หูอื้อ|ได้ยิน/i,
      [['Hearing loss/tinnitus', 'Hearing loss and tinnitus present.'], ['None', 'No hearing loss, tinnitus or ear fullness.']]],
    ['Any double vision, slurred speech, facial numbness, weakness, or inability to walk unaided?', 'Brainstem or cerebellar signs make a central cause likely', /diplop|double|slur|dysarth|numb|weak|cannot walk|เดินไม่ได้/i,
      [['Brainstem signs', 'Double vision, slurred speech or numbness present.'], ['Cannot walk unaided', 'Cannot walk unaided.'], ['None', 'No double vision, slurred speech, numbness or weakness.']]],
    ['Any new headache or neck pain at onset?', 'New neck pain with vertigo raises vertebral artery dissection', /headache|neck pain|ปวดหัว|ปวดคอ/i,
      [['Neck pain', 'New neck pain at onset.'], ['None', 'No headache or neck pain.']]]]],
  ['Headache', /headache|head ache|cephalg|migraine|ปวดหัว|ปวดศีรษะ/i, [
    ['How big is the painful area: a small spot (about a 10-baht coin), a sector or wedge over the face or forehead, one half of the head, or the whole head?', 'Small spot = paracranial (scalp, periosteum, skull); sector = sinus; half or whole head = decide extra-axial versus intra-axial', /coin|nummular|small (area|spot)|sector|wedge|sinus|hemicran|one side of the head|(left|right)[- ]sided head|whole head|holocephal|all over the head|both sides of the head|vertex|เหรียญ|เสี้ยว|ข้างเดียว|ทั้งหัว/i,
      [['Small spot (coin)', 'The pain is in a small spot about the size of a 10-baht coin.'], ['Sector over sinus', 'The pain is sectoral, wedge-shaped over the cheek or forehead (sinus area).'], ['One half of the head', 'The pain is hemicranial, on one side of the head.'], ['Whole head', 'The pain is holocephalic, over the whole head.'], ['Top of the head', 'The pain is at the vertex.']]],
    ['If there is a deficit: did the headache come first and the deficit later, or did they start together (or the deficit first)?', 'Headache before the deficit = extra-axial (dura or meninges, or a midline lesion); together or deficit first = intra-axial (brain parenchyma)', /then|later|followed by|together|at the same time|first|before|ต่อมา|พร้อมกัน/i,
      [['Headache first', 'The headache came first and the deficit followed later.'], ['Together', 'The headache and the deficit started together.'], ['Deficit first', 'The deficit came first and the headache followed.'], ['No deficit', 'There is no neurological deficit.']]],
    ['Any lumbar puncture, spinal anaesthesia or epidural before the headache started?', 'An upright headache after dural puncture is post-dural puncture headache; without it, think spontaneous intracranial hypotension or a posterior fossa mass', /lumbar puncture|\bLP\b|spinal an|epidural|เจาะหลัง|บล็อกหลัง/i,
      [['Recent LP or spinal block', 'There was a recent lumbar puncture or spinal anaesthesia before the headache.'], ['None', 'No lumbar puncture, spinal anaesthesia or epidural.']]],
    ['How fast did it reach peak intensity: within a minute, or over hours?', 'Peak within a minute (thunderclap) needs exclusion of subarachnoid haemorrhage and other vascular causes', /thunderclap|sudden|seconds|worst|builds|gradual|ทันที/i,
      [['Thunderclap', 'Thunderclap: peak within a minute.'], ['Builds over hours', 'Builds gradually over hours.']]],
    ['Is it worse lying down or on standing up?', 'Worse lying and in the morning suggests raised pressure; worse upright suggests low CSF pressure', /lying|standing|upright|position|morning/i,
      [['Worse lying/morning', 'Worse lying down and in the morning.'], ['Worse upright', 'Worse on standing upright.'], ['No positional change', 'No positional change.']]],
    ['Any fever, neck stiffness, rash, confusion or seizures?', 'These point to meningitis or encephalitis', /fever|neck stiff|rash|confus|seizure|ไข้|คอแข็ง/i,
      [['Fever/neck stiffness', 'Fever and neck stiffness present.'], ['None', 'No fever, neck stiffness, rash, confusion or seizures.']]],
    ['Any visual blurring or transient visual blackouts, double vision or pulsatile ringing in the ears?', 'Suggest raised intracranial pressure', /visual|blur|obscur|diplop|double|pulsatile/i,
      [['Visual obscurations', 'Transient visual obscurations present.'], ['None', 'No visual blurring or double vision.']]],
    ['Any weakness, numbness, speech change or new neurological symptoms?', 'Focal deficits need imaging', /weak|numb|speech|aphas|อ่อนแรง|ชา(?![ยวต])/i,
      [['Focal deficit', 'Focal weakness present.'], ['None', 'No weakness, numbness or speech change.']]],
    ['If over 50: jaw pain on chewing, scalp tenderness, visual loss or aching shoulders?', 'Giant cell arteritis', /jaw|scalp|temporal|shoulder|under 50/i,
      [['GCA features', 'Jaw pain on chewing and scalp tenderness.'], ['None', 'No jaw or scalp symptoms.'], ['Under 50', 'Age under 50.']]],
    ['How many days a month is pain-killer used?', 'Frequent use suggests medication-overuse headache', /analgesic|painkiller|paracetamol|ยาแก้ปวด/i,
      [['Under 10 days', 'Analgesic use under 10 days a month.'], ['15+ days', 'Analgesic use 15 or more days a month.']]]]],
  ['Visual loss', /visual loss|vision loss|loss of vision|blurred vision|blurry|cannot see|blind|ตามัว|มองไม่เห็น|ตาบอด/i, [
    ['One eye or both? Did covering each eye show which eye is affected?', 'One eye = in front of the chiasm; both eyes with a hemifield = chiasm or behind', /one eye|both eyes|left eye|right eye|monocular|cover/i,
      [['One eye', 'One eye affected.'], ['Both eyes', 'Both eyes affected.']]],
    ['Is it the whole field, the centre, the top or bottom half, or one side of the field in both eyes?', 'Central = optic nerve; altitudinal = ischaemic optic neuropathy; hemianopia = retrochiasmal', /central|altitud|half|hemianop|field/i,
      [['Central', 'Central field loss.'], ['Top/bottom half', 'Altitudinal (top or bottom half) field loss.'], ['Hemianopia', 'Hemianopia: one side of the field in both eyes.'], ['Whole field', 'Whole field loss.']]],
    ['Transient (minutes) or persistent? Any pain on moving the eye or loss of colour vision?', 'Transient monocular loss = retinal ischaemia; painful with colour loss = optic neuritis', /transient|minutes|pain on|colour|color|persistent|painless/i,
      [['Transient', 'Transient, lasting minutes.'], ['Painful, colour loss', 'Pain on eye movement and colour loss.'], ['Persistent, painless', 'Persistent and painless.']]]]],
  ['Seizure / transient loss of consciousness', /seizure|convuls|fit\b|blackout|faint|syncop|loss of consciousness|passed out|ชัก|หมดสติ|เป็นลม/i, [
    ['What did a witness see: stiffening, jerking, eyes open or closed, colour, how long?', 'Witness account is the key to separating seizure from syncope or functional events', /witness|jerk|stiff|eyes/i,
      [['Stiffening then jerking', 'Witness saw stiffening then jerking.'], ['Brief limp, pale', 'Witness saw brief limpness and pallor.'], ['Unwitnessed', 'Unwitnessed event.']]],
    ['Any warning beforehand (aura, déjà vu, rising feeling, sweating, nausea, light-headedness on standing)?', 'Focal aura points to the seizure onset zone; prodromal sweating and posture point to syncope', /aura|warning|deja|sweat|standing/i,
      [['Aura', 'Aura before the event.'], ['Sweating on standing', 'Sweating and light-headedness on standing beforehand.'], ['No warning', 'No warning beforehand.']]],
    ['Tongue bitten on the side, incontinence, confusion or sleepiness afterward?', 'Lateral tongue bite and post-event confusion favour a seizure', /tongue|incontin|confus|drowsy|post-?ictal/i,
      [['Lateral tongue bite', 'Lateral tongue bite.'], ['Confused afterward', 'Confusion afterward.'], ['None', 'No tongue bite, incontinence or confusion afterward.']]],
    ['Any weakness of one side after the event?', 'Post-ictal (Todd) paresis lateralises the focus', /weak|todd/i,
      [['Todd paresis', 'One-sided weakness afterward (Todd).'], ['None', 'No weakness afterward.']]]]],
  ['Speech difficulty', /slurred|dysarth|aphas|speech|word.finding|cannot speak|พูดไม่ชัด|พูดไม่ได้|พูดไม่ออก/i, [
    ['Is speech slurred (articulation) or are wrong words used, or is understanding impaired?', 'Slurred = dysarthria (brainstem, cerebellum, nerves, junction); wrong words or poor understanding = aphasia (dominant hemisphere)', /slur|dysarth|aphas|wrong word|understand/i,
      [['Slurred', 'Speech is slurred (dysarthria).'], ['Wrong words', 'Uses wrong words (aphasia).'], ['Poor understanding', 'Cannot understand speech.']]],
    ['Any trouble with reading, writing or naming objects?', 'Supports a cortical language disorder', /read|writ|nam/i,
      [['Affected', 'Reading and writing affected.'], ['Intact', 'Reading and writing intact.']]],
    ['Any swallowing difficulty, nasal voice or worsening with talking?', 'Bulbar weakness; fatigable nasal speech suggests myasthenia', /swallow|nasal|fatig|กลืน/i,
      [['Swallowing difficulty', 'Swallowing difficulty present.'], ['Nasal, fatigable', 'Nasal voice that fatigues with talking.'], ['None', 'No swallowing or nasal voice problem.']]]]],
  ['Imbalance / gait', /unsteady|imbalance|ataxi|clums|falls|falling|gait|walk(ing)? difficult|เดินเซ|ทรงตัว|ล้ม/i, [
    ['Worse in the dark or with eyes closed?', 'Sensory ataxia from large-fibre neuropathy or dorsal column disease', /dark|eyes closed|romberg/i,
      [['Worse in dark', 'Worse in the dark.'], ['Not', 'Not worse with eyes closed.']]],
    ['Are the hands clumsy, is speech slurred, or does the room spin?', 'Limb ataxia and dysarthria suggest the cerebellum; vertigo suggests the vestibular system', /clums|slur|spin|vertigo/i,
      [['Clumsy hands', 'Clumsy hands.'], ['Vertigo', 'Vertigo with it.'], ['None', 'No clumsiness, slurring or spinning.']]],
    ['Are steps small and shuffling, or is the leg stiff or dragging?', 'Shuffling suggests parkinsonism or frontal gait; stiff legs suggest spastic (UMN) gait', /shuffl|small steps|stiff|drag/i,
      [['Shuffling', 'Small shuffling steps.'], ['Stiff legs', 'Stiff dragging legs.'], ['Neither', 'Steps not shuffling, legs not stiff.']]],
    ['Any bladder urgency or memory decline with it?', 'Gait, urinary and cognitive change together suggest normal pressure hydrocephalus', /bladder|urin|memory|forget/i,
      [['Bladder + memory', 'Bladder urgency and memory decline.'], ['None', 'No bladder or memory change.']]]]],
  ['Myoclonus / jerks', /myoclon|jerk|startle|กระตุก|สะดุ้ง/i, [
    ['What sets the jerks off: a sudden noise or touch, moving the limb, or nothing at all?', 'Jerks set off by noise, touch or action point to a cortical source; jerks at rest with no trigger are more often subcortical or spinal', /noise|sound|touch|startle|action|on movement|spontaneous|at rest|เสียง|สัมผัส|ตกใจ/i,
      [['Noise or touch', 'Jerks set off by noise or touch.'], ['On movement', 'Jerks on movement (action myoclonus).'], ['No trigger', 'Jerks come with no trigger.']]],
    ['Is it one body part, one side, or the whole body?', 'Focal or segmental jerks suggest a cortical, brainstem or spinal lesion; whole-body jerks suggest a diffuse or metabolic cause', /focal|one (?:arm|leg|hand|side)|segment|whole body|generali[sz]|multifocal|ทั้งตัว|ข้างเดียว/i,
      [['One part', 'Jerks in one body part.'], ['Whole body', 'Jerks of the whole body.'], ['Several places', 'Jerks in several places (multifocal).']]],
    ['Any seizures, blackouts or loss of awareness?', 'Jerks with seizures suggest an epilepsy syndrome or an encephalopathy', /seiz|convuls|blackout|loss of awareness|ชัก/i,
      [['Seizures', 'Seizures as well.'], ['None', 'No seizures or blackouts.']]],
    ['Any new medicine, kidney or liver failure, or a recent cardiac arrest or low oxygen?', 'Drug-induced, uraemic, hepatic and post-hypoxic myoclonus are common and treatable', /drug|medic|kidney|renal|uraem|liver|hepat|hypox|cardiac arrest|ยา/i,
      [['New medicine', 'New medicine started before the jerks.'], ['Kidney or liver failure', 'Kidney or liver failure.'], ['None', 'No new medicine, organ failure or hypoxia.']]],
    ['Is memory or thinking getting worse quickly at the same time?', 'Rapid cognitive decline with myoclonus points to prion disease or autoimmune encephalitis', /memory|forget|cogniti|dementia|confus|MMSE|MoCA|หลงลืม|ขี้ลืม|ความจำ/i,
      [['Rapid decline', 'Memory and thinking getting worse over weeks.'], ['No', 'No change in memory or thinking.']]]]],
  ['Tremor / involuntary movement', /tremor|shak|twitch|chorea|dyston|\btic|involuntary|สั่น/i, [
    ['Is it present at rest, when holding a posture, or during movement toward a target?', 'Rest = parkinsonism; postural = essential or enhanced physiological; intention = cerebellar', /rest|postur|intention|action/i,
      [['At rest', 'Tremor at rest.'], ['Postural', 'Postural tremor.'], ['Intention', 'Intention tremor.']]],
    ['Does alcohol reduce it, and is there a family history?', 'Alcohol response and family history support essential tremor', /alcohol|family/i,
      [['Alcohol helps, family', 'Better with alcohol; family history positive.'], ['No', 'No alcohol response or family history.']]],
    ['Any slowness, stiffness or change in handwriting size?', 'Bradykinesia and micrographia suggest parkinsonism', /slow|stiff|handwrit|microgr/i,
      [['Slowness/stiffness', 'Slowness and stiffness present.'], ['None', 'No slowness or stiffness.']]],
    ['Any new medicines (e.g. antipsychotics, metoclopramide, valproate, lithium, salbutamol)?', 'Drug-induced movement disorders are common and reversible', /drug|medic|metoclopramide|valpro|lithium/i,
      [['Yes', 'Taking a drug that can cause movement disorders.'], ['None', 'No new medicines.']]]]],
  ['Memory / cognitive change', /memory|forget|confus|cognit|dementia|behaviou?r change|ขี้ลืม|ความจำ|สับสน/i, [
    ['How fast has it changed: days, weeks, months or years?', 'Rapid change suggests delirium, encephalitis, prion disease or a structural lesion', /day|week|month|year|rapid/i,
      [['Rapid, weeks', 'Rapid change over weeks.'], ['Gradual, years', 'Gradual over years.']]],
    ['Can the person still manage money, medicines, cooking and travel alone?', 'Loss of independence separates dementia from mild cognitive impairment', /money|medicine|cook|independ|ADL/i,
      [['Independent', 'Still independent in ADL.'], ['Needs help', 'Needs help with money and medicines.']]],
    ['Any hallucinations, fluctuating alertness, acting out dreams, falls, or personality change?', 'Point to Lewy body disease or frontotemporal dementia', /hallucin|fluctuat|dream|personality|disinhib/i,
      [['Hallucinations/fluctuation', 'Visual hallucinations and fluctuating alertness.'], ['Acts out dreams', 'Acts out dreams.'], ['Personality change', 'Personality change.'], ['None', 'No hallucinations, fluctuation or personality change.']]],
    ['Any gait change or urinary incontinence?', 'Suggests normal pressure hydrocephalus or vascular cognitive impairment', /gait|walk|urin|incontin/i,
      [['Gait + urinary', 'Gait change and urinary incontinence.'], ['None', 'No gait or urinary change.']]]]],
  ['Back or neck pain', /back pain|low back|neck pain|sciatica|lumbar|cervical pain|ปวดหลัง|ปวดเอว|ปวดคอ/i, [
    ['Does the pain radiate into the arm or below the knee, along one strip?', 'Dermatomal radiation suggests nerve root compression', /radiat|below the knee|down the leg|down the arm|ร้าว/i,
      [['Radiates below knee', 'Pain radiates down the leg below the knee.'], ['Radiates down arm', 'Pain radiates down the arm.'], ['Local only', 'No radiating pain.']]],
    ['Any numbness around the anus or genitals, urinary retention or incontinence?', 'Cauda equina syndrome is an emergency', /saddle|retention|incontin|bladder|bowel/i,
      [['Saddle/retention', 'Saddle numbness and urinary retention.'], ['None', 'No saddle numbness, retention or incontinence.']]],
    ['Any fever, weight loss, previous cancer, night pain or recent trauma?', 'Red flags for infection, malignancy or fracture', /fever|weight|cancer|night|trauma|ไข้/i,
      [['Red flag present', 'Fever, weight loss or cancer history.'], ['None', 'No fever, weight loss, cancer, night pain or trauma.']]],
    ['Any leg weakness, stiffness or a level below which feeling is changed?', 'Myelopathy rather than radiculopathy', /weak|stiff|level|อ่อนแรง/i,
      [['Leg weakness', 'Leg weakness present.'], ['None', 'No leg weakness, stiffness or sensory level.']]]]],
  ['Facial weakness', /facial (weak|palsy|droop)|face droop|bell'?s|mouth droop|หน้าเบี้ยว|ปากเบี้ยว|ปากตก/i, [
    ['Can the person wrinkle the forehead on the weak side?', 'Forehead sparing suggests an upper motor neuron (central) lesion; forehead involved suggests a facial nerve palsy', /forehead|brow|eye closure/i,
      [['Forehead spared', 'Forehead spared (can wrinkle the forehead).'], ['Forehead involved', 'Forehead involved.']]],
    ['Any taste change, sound sensitivity, ear pain or blisters in the ear?', 'Supports facial nerve involvement; vesicles suggest herpes zoster (Ramsay Hunt)', /taste|hyperacus|ear|vesic/i,
      [['Taste/hyperacusis', 'Taste change and sound sensitivity.'], ['Ear vesicles', 'Ear pain with vesicles.'], ['None', 'No taste change, ear pain or vesicles.']]],
    ['Any arm or leg weakness, numbness, double vision or hearing loss?', 'Other deficits suggest a central or brainstem cause rather than isolated Bell palsy', /arm|leg|limb|numb|diplop|hearing/i,
      [['Limb weakness', 'Arm and leg weakness present.'], ['Isolated', 'No limb weakness, numbness, diplopia or hearing loss.']]]]],
  ['Swallowing difficulty', /dysphag|swallow|choking|กลืนลำบาก|สำลัก/i, [
    ['Trouble starting the swallow or food sticking lower down?', 'Difficulty initiating with nasal regurgitation suggests neurological (oropharyngeal) dysphagia', /initiat|stick|regurg/i,
      [['Starting the swallow', 'Difficulty initiating the swallow with nasal regurgitation.'], ['Food sticks', 'Food sticks lower down.']]],
    ['Does it worsen during a meal?', 'Fatigable dysphagia suggests myasthenia', /fatig|during a meal|worse with/i,
      [['Worse during meal', 'Fatigable: worse during a meal.'], ['Not', 'Not fatigable.']]],
    ['Any tongue wasting or twitching, or voice change?', 'Lower motor neuron bulbar signs suggest motor neuron disease', /tongue|wast|fascicul|voice|hoarse/i,
      [['Tongue wasting', 'Tongue wasting and fasciculations.'], ['Hoarse voice', 'Hoarse voice.'], ['None', 'No tongue wasting or voice change.']]]]],
  ['Hearing loss / tinnitus', /hearing loss|deaf|tinnit|ringing|หูอื้อ|หูตึง|หูดับ|ได้ยินลดลง/i, [
    ['One side or both, sudden or gradual?', 'Sudden one-sided loss is urgent; gradual one-sided loss needs exclusion of a vestibular schwannoma', /one side|both|sudden|gradual|left|right/i,
      [['Sudden, one side', 'Sudden hearing loss on one side.'], ['Gradual, one side', 'Gradual hearing loss on one side.'], ['Both ears', 'Both ears, gradual.']]],
    ['Any vertigo, facial numbness or facial weakness?', 'Suggests the inner ear or cerebellopontine angle', /vertigo|numb|facial/i,
      [['Vertigo', 'Vertigo present.'], ['Facial numbness', 'Facial numbness present.'], ['None', 'No vertigo, facial numbness or weakness.']]]]],
];
// a follow-up question is skipped when the case already states the answer, positive or negative (findings come from the same scope rules as the work-up)
function askKnownTerms(tx) { const f = caseFindings(String(tx || '')); return f.pos.concat(f.neg).map(x => String(x).toLowerCase()).filter(x => x.length >= 5); }
function mergeAsk(rules, ai, tx) {
  const out = (rules || []).slice(), used = new Set(out.map(g => g.topic)), known = askKnownTerms(tx);
  for (const g of ai || []) {
    if (ASK_RULES.some(([label, rx]) => used.has(label) && rx.test(g.topic))) continue;
    const items = (g.items || []).filter(it => { const q = String(it.q || '').toLowerCase(); return !known.some(k => q.includes(k)); });
    if (items.length) out.push(Object.assign({}, g, {items}));
  }
  return out;
}
function caseAskNext(tx) {
  const t = caseOriginal(tx), pos = scSegs(t).filter(sg => sg.pol === 'pos').map(sg => sg.raw).join('. '), out = [];
  // already answered = stated anywhere: the original, its English translation, or a finding name (Thai cases were asked
  // again about what they had said, e.g. slurred speech, because only the Thai text was checked)  (v1.7)
  const fd = caseFindings(String(tx || '')), said = [String(tx || '')].concat(fd.pos, fd.neg).join('. ');
  for (const [label, rx, qs] of ASK_RULES) {
    if (!rx.test(pos)) continue;
    const items = qs.filter(q => !(q[2] && q[2].test(said))).map(q => ({q: q[0], why: q[1], opts: (q[3] || []).map(o => ({label: o[0], text: o[1]}))}));
    if (items.length) out.push({topic: label, items});
  }
  return out;
}
// symptom words → objective finding classes (on-device fallback)
const OBJ_RULES = [
  [/weak|paresis|plegia|palsy of (arm|leg)|cannot (lift|walk|grip)|drop(ped)? (foot|wrist)|foot drop|wrist drop/i, 'Motor weakness'],
  [/numb|tingl|paraesthe|paresthe|sensory loss|pins and needles|burning feet/i, 'Sensory symptoms'],
  [/neck stiff|nuchal|photophob|kernig|brudzinski|meningism/i, 'Meningeal signs'],
  [/headache|head pain|thunderclap/i, 'Headache'],
  [/fever|febrile/i, 'Fever / systemic inflammation'],
  [/diplopia|double vision|ptosis|droopy eyelid|eyelid|ophthalmople/i, 'Ocular motor / eyelid signs'],
  [/monocular|\b(one|left|right) eye\b[^.,;]*(vision|visual|blur|blind|see)|(vision|visual|blur|blind)[^.,;]*\b(one|left|right) eye\b/i, 'Monocular visual loss'],
  [/loss of vision|vision loss|visual loss|blurred vision|blurring of vision|blind|scotoma|hemianop/i, 'Visual loss'],
  [/slur|dysarthri/i, 'Dysarthria'],
  [/aphasi|word finding|cannot speak|speech (arrest|difficult)/i, 'Language disturbance'],
  [/swallow|dysphag|choking/i, 'Dysphagia / bulbar dysfunction'],
  [/ataxi|unsteady|clumsy|incoordinat|vertigo|dizz/i, 'Ataxia / vestibular symptoms'],
  [/seiz|convuls|fit\b|myoclon|(?<!(knee|ankle|jaw|biceps|triceps) )jerk/i, 'Seizure / myoclonus'],
  [/confus|drows|coma|unconscious|altered (mental|conscious)|delirium/i, 'Altered consciousness'],
  [/memory|forget|cogniti|dementia/i, 'Cognitive impairment'],
  [/tremor|rigid|slow(ness)? of movement|bradykines|dystoni|chorea|involuntary/i, 'Movement disorder'],
  [/bladder|urinary|incontinen|retention|bowel/i, 'Sphincter dysfunction'],
  [/fatig|worse in the evening|worse with exertion|fluctuat/i, 'Fatigable weakness'],
  [/areflex|reflexes (absent|lost)|hyporeflex/i, 'Hypo/areflexia (LMN sign)'],
  [/hyperreflex|brisk (\w+ )?(reflex|jerk)|babinski|(?<!myo)clonus|spastic/i, 'Hyperreflexia / spasticity (UMN sign)'],
  [/wasting|atroph|fascicul/i, 'Wasting / fasciculation (LMN sign)'],
  [/cramp|myalg|muscle pain|dark urine|cola/i, 'Myalgia / cramps / pigmenturia'],
  [/back pain|neck pain|radicular|sciatica/i, 'Spinal / radicular pain'],
];
// ---- Step 1: chief complaint first, then UMN or LMN (or central vs peripheral for non-motor complaints) before anything else
// Rules are general clinical conventions (draft for expert review).
const UMN_CUES = [[/hyperreflex|brisk (\w+ )?(reflex|jerk)|(reflexes|jerks) (are )?brisk|babinski|upgoing plantar|extensor plantar|(?<!myo)clonus|hoffmann/i, 'brisk reflexes / Babinski / clonus'],
  [/spastic|spasticity|stiff (leg|legs|limb)|(legs?|limbs?) (are |is )?stiff|scissor/i, 'spasticity'], [/hemipar|hemipleg|one side of the body|face,? arm and leg|arm and leg on the (left|right)|ครึ่งซีก|อ่อนแรงซีก/i, 'hemiparesis (face-arm-leg on one side)'],
  [/pyramidal|arm extensors and leg flexors/i, 'pyramidal distribution'], [/sensory level|level at T\d|(below|up to|to|at) the (nipples?|umbilicus|navel|waist)/i, 'sensory level'],
  [/aphasi|neglect|hemianop|cortical sensory|word.finding/i, 'cortical sign'], [/lower face weak.*forehead spared|forehead spared|supranuclear/i, 'upper motor neuron facial pattern'], [/pseudobulbar|emotional lability|brisk jaw jerk/i, 'pseudobulbar signs']];
const LMN_CUES = [[/wasting|atroph|thin (arm|leg|hand|muscle)|ลีบ/i, 'wasting'], [/fascicul|twitch(ing)? (of|in) (the )?muscle|muscle twitch/i, 'fasciculations'],
  [/areflex|absent (reflex|jerk|ankle|knee)|reflexes (are )?(absent|reduced|lost|depressed)|hyporeflex|reduced reflex/i, 'reduced or absent reflexes'], [/flaccid|floppy|hypoton/i, 'flaccid tone'],
  [/foot drop|wrist drop|claw hand|ข้อเท้าตก|ข้อมือตก/i, 'focal drop (nerve or root)'], [/glove|stocking|length.dependent|distal (weak|numb)|burning feet|(feet|toes) and (hands|fingers)|(hands|fingers) and (feet|toes)/i, 'distal glove-stocking pattern'],
  [/dermatom|radiat\w* (down|into)|sciatica|radicular|root pain|shooting pain down/i, 'root pattern'], [/fatig|worse (with use|in the evening|later in the day)|ptosis.*(worse|evening)|ช่วงเย็น/i, 'fatigable (junction)'],
  [/proximal (weak|muscle)|rising from (a )?chair|climbing stairs|combing (her |his )?hair/i, 'proximal symmetric weakness (muscle or junction)'], [/whole (half of the )?face|hemiface|bell'?s|forehead (is )?(also )?weak/i, 'whole-hemiface (facial nerve) pattern']];
const CC_KIND = [[/weak|paresis|plegia|can'?t (lift|walk|grip)|cannot (lift|walk|grip)|drop(ping)? things|foot drop|wrist drop|อ่อนแรง|ยกไม่ขึ้น|เดินไม่ได้/i, 'motor'],
  [/numb|tingl|pins and needles|paraesth|parest|sensory loss|burning|ชา(?![ยวต])|เหน็บ/i, 'sensory'], [/unsteady|ataxi|imbalance|clums|เดินเซ|ทรงตัว/i, 'ataxia'],
  [/vertigo|dizz|spinning|บ้านหมุน|เวียน/i, 'vertigo'], [/diplop|double vision|ptosis|ภาพซ้อน|หนังตาตก/i, 'ocular'], [/vision|blind|blur|ตามัว|มองไม่เห็น/i, 'visual'],
  [/headache|ปวดหัว|ปวดศีรษะ/i, 'headache'], [/seiz|convuls|fit\b|ชัก/i, 'seizure'], [/slur|dysarth|aphas|speech|พูดไม่ชัด|พูดไม่ได้/i, 'speech'],
  [/memory|forget|confus|ขี้ลืม|สับสน/i, 'cognitive'], [/tremor|shak|jerk|stiff|slow|สั่น|กระตุก/i, 'movement']];
const CC_HINT = {sensory: 'Central (brain, brainstem, cord) or peripheral (root, plexus, nerve)? Face involved, hemi-distribution or a sensory level = central; dermatome, single nerve or glove-stocking = peripheral.',
  ataxia: 'Cerebellar (nystagmus, dysmetria, no change with eyes closed) or sensory (Romberg positive, lost joint position sense) or vestibular?',
  vertigo: 'Peripheral vestibular (positional or brief, hearing change, no other signs) or central (other brainstem or cerebellar signs, unable to walk, abnormal HINTS)?',
  ocular: 'Nerve (III, IV, VI pattern), junction (fatigable, variable, pupils spared) or muscle (symmetric, no diplopia) — or brainstem (with other long-tract signs)?',
  visual: 'One eye (retina or optic nerve; RAPD) or both eyes with a field pattern (chiasm or retrochiasmal)?', headache: 'Primary pattern or red flags pointing to a structural or meningeal cause?',
  seizure: 'Cortical (hemisphere) by definition: does the semiology point to a lobe?', speech: 'Language (aphasia = dominant hemisphere) or articulation (dysarthria: UMN, LMN, cerebellar, extrapyramidal or junction)?',
  cognitive: 'Cortical or subcortical pattern, focal or diffuse?', movement: 'Hypokinetic or hyperkinetic phenomenology (basal ganglia circuit)?'};
function cuesIn(t, list) { return list.filter(([rx]) => rx.test(t)).map(x => x[1]); }
function caseChief(tx) {
  const text = String(tx || ''), pos = text.replace(/\b(?:no|not|without|denies|denied|negative for)\b[^.;,\n]*/gi, ' ');
  const pk = pickChief(text), first = pk ? pk.term : (probFromText(text)[0] || '');
  if (!first) return null;
  const p = plParse(text, pk ? pk.raw : first);
  const kind = (CC_KIND.find(([rx]) => rx.test(first)) || [, 'other'])[1];
  const umn = cuesIn(pos, UMN_CUES), lmn = cuesIn(pos, LMN_CUES);
  let pattern, reasoning;
  if (umn.length && lmn.length) { pattern = 'Mixed UMN + LMN'; reasoning = `UMN cues (${umn.join(', ')}) together with LMN cues (${lmn.join(', ')}): think of one level that can give both, such as motor neuron disease or a cervical cord lesion with root involvement at that level.`; }
  else if (umn.length) { pattern = 'UMN'; reasoning = `UMN cues: ${umn.join(', ')}. The lesion is above the anterior horn cell (brain, brainstem or spinal cord).`; }
  else if (lmn.length) { pattern = 'LMN'; reasoning = `LMN cues: ${lmn.join(', ')}. The lesion is at or below the anterior horn cell (anterior horn, root, plexus, nerve, junction or muscle).`; }
  else { pattern = 'Not yet decided'; reasoning = kind === 'motor' ? 'The history does not yet say whether tone and reflexes are increased or reduced, or whether there is wasting or fasciculation. Examine these first.' : ''; }
  if (kind !== 'motor' && kind !== 'other' && pattern === 'Not yet decided') pattern = kind === 'sensory' ? 'Sensory: central or peripheral?' : 'Not a motor complaint: central or peripheral?';
  else if (kind === 'sensory' && pattern === 'LMN') pattern = 'LMN / peripheral sensory'; else if (kind === 'sensory' && pattern === 'UMN') pattern = 'Central (UMN side)';
  return {complaint: first, raw: first, skipped: pk ? pk.skipped : [], pages: pk ? pk.pages : null, onset: p.onset, duration: p.duration, site: p.site, location: p.location, kind, pattern, reasoning, hint: CC_HINT[kind] || (kind === 'motor' ? 'UMN: spastic, brisk reflexes, Babinski, pyramidal distribution. LMN: flaccid, reduced reflexes, wasting, fasciculation, in a root, plexus, nerve, junction or muscle pattern.' : '')};
}
// ---- Step 4a: UMN localization (the user's rules): brain or spinal cord, tract and side;
// brain → supratentorial (seizure, cortical signs) or infratentorial (crossed signs, first-order Horner, gaze palsy: INO, one-and-a-half, WEBINO), both when no strong sign;
// cord (sensory level) → side, tract, level, extrinsic (bone pain / spinal tenderness, flaccid arms with spastic legs) or intrinsic (funicular pain); paired differential when undecided.
const UMN_SUPRA = [[/seiz|convuls|fit\b|ชัก/i, 'seizure'], [/aphasi|neglect|hemianop|cortical sensory|astereognos|agraphaesth|graphesth|apraxi|agnosi|word.finding|gerstmann|anosognos|อะเฟเซีย/i, 'cortical sign']];
const UMN_INFRA = [[/crossed|alternating hemipleg|(?:ipsilateral|same side)[^.;]{0,40}(?:cranial|facial|vi |6th|third|iii|xii|tongue)/i, 'crossed signs'], [/horner/i, 'Horner syndrome (first-order, central)'],
  [/\bino\b|internuclear|one.and.a.half|webino|gaze palsy|gaze paresis|cannot look (to|up|down)|skew deviation/i, 'gaze palsy (INO, one-and-a-half, WEBINO)']];
const CORD_CUE = /sensory level|level (at|of) [CTL]\d|(?:below|up to|to|at) the (nipples?|umbilicus|navel|waist|clavicles?)|\b[CTL]\d{1,2}\b level|brown.s[eé]quard|ระดับความรู้สึก/i;
const CORD_EXTR = [[/bone pain|back pain|neck pain|spin(al|e) (tender|pain)|tender(ness)? (on|to) (percussion|palpation)|percussion tender|กดเจ็บ|ปวดหลัง|ปวดคอ/i, 'bone pain or spinal tenderness'],
  [/(flaccid|weak and floppy|hypoton)[^.;]{0,40}(arm|upper limb|hand)[^.;]{0,60}spastic|spastic[^.;]{0,40}(leg|lower limb)[^.;]{0,60}flaccid[^.;]{0,30}(arm|upper limb)/i, 'flaccid upper limbs with spastic lower limbs']];
const CORD_INTR = [[/funicular/i, 'funicular pain']];
const CORD_DDX = [['Metastatic spinal cord tumours', 'Transverse myelitis'], ['Cervical spondylotic myelopathy (CSM)', 'Neuromyelitis optica spectrum disorder (NMOSD)'],
  ['Spinal epidural abscess', 'Spinal cord infarction'], ['Spinal epidural haematoma', 'Subacute combined degeneration'], ['Meningiomas', 'Intramedullary spinal tumours']];
function umnSide(t) {
  if (/\b(para|tetra|quadri)(paresis|plegia)|both (legs|arms|lower|upper)|bilateral (leg|arm|limb|weak)|all (four )?limbs|อ่อนแรงสองขา|ขาสองข้าง/i.test(t)) return 'bilateral';
  const m = t.match(/\b(right|left)\b(?:[\s-]+(?:sided?|side|body))?[^.;,]{0,25}(?:hemi|weak|paresis|plegia|arm|leg|limb|face|facial)|(?:hemi\w*|weak\w*|paresis|plegia)[^.;,]{0,20}\b(?:on the )?(right|left)\b|(ขวา|ซ้าย)/i);
  if (!m) return '';
  const w = (m[1] || m[2] || m[3] || '').toLowerCase();
  return w === 'ขวา' ? 'right' : w === 'ซ้าย' ? 'left' : w;
}
function caseUMNLoc(tx, chief) {
  const t = String(tx || ''), pos = scSegs(t).filter(sg => sg.pol === 'pos').map(sg => sg.raw).join('. ');
  const isUMN = chief && /UMN|Central/i.test(chief.pattern || '');
  const supra = cuesIn(pos, UMN_SUPRA), infra = cuesIn(pos, UMN_INFRA), cord = CORD_CUE.test(pos);
  if (!isUMN && !(chief && chief.kind === 'motor' && (cord || supra.length || infra.length))) return null;
  const side = umnSide(pos), opp = side === 'right' ? 'Left' : side === 'left' ? 'Right' : '', same = side ? side.charAt(0).toUpperCase() + side.slice(1) : '';
  const face = /fac(e|ial)|dysarthri|slur|dysphag|swallow|tongue|pseudobulbar|ปากเบี้ยว|หน้าเบี้ยว|พูดไม่ชัด/i.test(pos);
  const brainCue = supra.length || infra.length || face || /hemi(paresis|plegia)|ครึ่งซีก|cranial nerve|diplopia|vertigo|ataxi/i.test(pos);
  if (cord && !supra.length && !infra.length) {
    const extr = cuesIn(pos, CORD_EXTR), intr = cuesIn(pos, CORD_INTR);
    const lv = (pos.match(/\b([CTL])\d{1,2}\b/) || [])[1];
    const level = lv ? {C: 'Cervical', T: 'Thoracic', L: 'Lumbar'}[lv.toUpperCase()] : /clavic|neck|arms? and legs|all (four )?limbs|tetra|quadri|hands/i.test(pos) ? 'Cervical' : /nipple|umbilic|navel|chest|trunk|para/i.test(pos) ? 'Thoracic' : /waist|groin|conus/i.test(pos) ? 'Lumbar' : 'not stated';
    const bil = side === 'bilateral' || !side;
    const tracts = bil ? ['Bilateral lateral corticospinal tracts', 'Bilateral spinothalamic tracts'] : [same + ' lateral corticospinal tract'];
    const type = extr.length && !intr.length ? 'Extrinsic' : intr.length && !extr.length ? 'Intrinsic' : 'Not yet decided';
    return {level: 'Spinal cord', side: side || 'not stated', tracts, cordLevel: level, cordType: type, extr, intr,
      why: `Sensory level → spinal cord.${type === 'Extrinsic' ? ' Extrinsic (compressive): ' + extr.join(', ') + '.' : type === 'Intrinsic' ? ' Intrinsic (intramedullary): ' + intr.join(', ') + '.' : ' No key sign for extrinsic (bone pain, spinal tenderness, flaccid arms with spastic legs) or intrinsic (funicular pain): keep both.'}`,
      cordDdx: type === 'Not yet decided' ? CORD_DDX.map(([a, b], i) => ({rank: i + 1, extrinsic: a, intrinsic: b})) : []};
  }
  const tracts = side === 'bilateral' ? ['Bilateral corticospinal tracts'].concat(face ? ['Bilateral corticobulbar tracts'] : []) : opp ? [opp + ' corticospinal tract'].concat(face ? [opp + ' corticobulbar tract'] : []) : ['Corticospinal tract (side not stated)'];
  const comp = supra.length && !infra.length ? 'Supratentorial' : infra.length && !supra.length ? 'Infratentorial' : supra.length && infra.length ? 'Supratentorial and infratentorial' : 'Both hypotheses';
  return {level: brainCue || !cord ? 'Brain' : 'Spinal cord', side: side || 'not stated', tracts, compartment: comp, supra, infra,
    why: comp === 'Supratentorial' ? 'Supratentorial (cortex): ' + supra.join(', ') + '.' : comp === 'Infratentorial' ? 'Infratentorial (brainstem): ' + infra.join(', ') + '.' : comp === 'Both hypotheses' ? 'No strong sign for cortex (seizure, cortical sign) or brainstem (crossed signs, first-order Horner, gaze palsy such as INO, one-and-a-half or WEBINO): keep both a supratentorial and an infratentorial lesion.' : 'Signs of both compartments: ' + supra.concat(infra).join(', ') + '.',
    supraWhy: comp === 'Both hypotheses' ? 'Hemisphere (cortex, subcortical white matter, internal capsule) lesion contralateral to the weak side.' : '', infraWhy: comp === 'Both hypotheses' ? 'Brainstem (pons, medulla) lesion above the pyramidal decussation; look for crossed cranial nerve signs, Horner or gaze palsy.' : ''};
}
// ---- Step 3: try to explain every finding with ONE lesion first (Occam), and only then accept a second process (Hickam)
const UNI_LEVELS = [
  ['Cerebral hemisphere (cortex / subcortical white matter)', 'central'], ['Deep grey matter (basal ganglia / thalamus)', 'central'], ['Brainstem', 'central'], ['Cerebellum and its connections', 'central'],
  ['Spinal cord', 'central'], ['Motor neuron (anterior horn + corticospinal: UMN and LMN together)', 'both'], ['Cervical cord with roots at the same level (myeloradiculopathy)', 'both'],
  ['Root / cauda equina', 'peripheral'], ['Plexus', 'peripheral'], ['Peripheral nerves (poly- or multiple mononeuropathy)', 'peripheral'], ['Neuromuscular junction', 'peripheral'], ['Muscle', 'peripheral'],
  ['Meninges', 'other'], ['Visual pathway', 'central'], ['Diffuse intracranial process (raised pressure / meninges)', 'central'], ['Optic nerve / retina (one eye)', 'central']];
const UNI_FIT = {'Motor weakness': [0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11], 'Sensory symptoms': [0, 1, 2, 4, 6, 7, 8, 9], 'Meningeal signs': [12, 14], 'Headache': [0, 12, 14],
  'Ocular motor / eyelid signs': [2, 9, 10, 11, 14], 'Visual loss': [0, 13, 14], 'Monocular visual loss': [15], 'Dysarthria': [0, 1, 2, 3, 5, 10, 11], 'Language disturbance': [0], 'Dysphagia / bulbar dysfunction': [0, 2, 5, 10, 11],
  'Ataxia / vestibular symptoms': [2, 3, 4, 9], 'Seizure / myoclonus': [0], 'Altered consciousness': [0, 1, 2, 12, 14], 'Cognitive impairment': [0, 1], 'Movement disorder': [1],
  'Sphincter dysfunction': [0, 4, 6, 7], 'Fatigable weakness': [10], 'Hypo/areflexia (LMN sign)': [5, 6, 7, 8, 9, 11], 'Hyperreflexia / spasticity (UMN sign)': [0, 1, 2, 4, 5, 6],
  'Wasting / fasciculation (LMN sign)': [5, 6, 7, 8, 9], 'Myalgia / cramps / pigmenturia': [5, 9, 11], 'Spinal / radicular pain': [4, 6, 7]};
const UNI_SKIP = new Set(['Fever / systemic inflammation']);
const DUR_UNIT = [[/min|นาที/, 1 / 1440], [/hour|hr|ชั่วโมง|ชม/, 1 / 24], [/day|วัน/, 1], [/week|wk|สัปดาห์|อาทิตย์/, 7], [/month|mo|เดือน/, 30], [/year|yr|ปี/, 365]];
const NUMW = {a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, several: 4, few: 3, 'a few': 3, 'couple of': 2};
function durDays(d) {
  const t = String(d || '').toLowerCase(); if (!t) return null;
  const m = t.match(/(\d+(?:\.\d+)?|a few|couple of|an?|one|two|three|four|five|six|seven|eight|nine|ten|several|few)/); const n = m ? (isNaN(+m[1]) ? NUMW[m[1]] || 1 : +m[1]) : 1;
  const u = DUR_UNIT.find(([rx]) => rx.test(t)); return u ? n * u[1] : null;
}
// A symptom is a separate (standalone) story only when its time course is clearly different from the chief complaint:
// e.g. limb numbness for 10 years versus headache and blurred vision since yesterday. Otherwise keep everything together.
function standalone(dA, dB) { if (dA == null || dB == null) return false; const lo = Math.min(dA, dB), hi = Math.max(dA, dB); return hi >= 180 && hi / Math.max(lo, 1 / 24) >= 12; }
// context cues that make one level more specific than another when several fit the same findings
const UNI_BONUS = [[/sensory level|(below|up to|to|at) the (nipples?|umbilicus|navel|waist)|both legs|parapar|parapleg|retention|saddle/i, [4, 7]],
  [/aphasi|word.finding|hemianop|neglect|seiz|convuls|face,? arm and leg|hemipar|hemipleg|one side of the body|ครึ่งซีก/i, [0]], [/crossed|opposite side of the face|facial (numb|weak)\w* on the (left|right).*(arm|leg)/i, [2]],
  [/glove|stocking|(feet|toes) and (hands|fingers)|(hands|fingers) and (feet|toes)|both feet|length.dependent/i, [9]], [/dermatom|radiat\w* (down|into)|sciatica|radicular/i, [7]],
  [/cross(ing|ed) (his |her )?legs|pressure|after (sleeping|lying) on|wrist drop|foot drop|carpal|ulnar|peroneal|median/i, [9]], [/fatig|worse in the evening|later in the day/i, [10]],
  [/fascicul/i, [5]], [/vomit|papill?o?edema|worse (lying|on lying|in the morning)|cough|strain/i, [14]], [/nystagm|dysmetri|intention tremor|wide.based/i, [3]], [/diplop|double vision/i, [2, 10]]];
function durOf(text, symptom) {
  const sents = String(text || '').split(/[.\n]+/), pl = String(symptom || '').toLowerCase().slice(0, 30), sent = sents.find(x => x.toLowerCase().includes(pl)) || '';
  const m = sent.match(PL_DUR); if (m) return {d: durDays(m[1] || m[2]), label: (m[1] || m[2] || '').trim()};
  if (/yesterday|last night|เมื่อวาน/i.test(sent)) return {d: 1, label: 'since yesterday'};
  if (/this (morning|afternoon|evening)|today|tonight|hours? ago|วันนี้|เมื่อเช้า/i.test(sent)) return {d: .3, label: 'today'};
  if (/since (childhood|birth|youth)|lifelong|for years|ตั้งแต่เด็ก/i.test(sent)) return {d: 3650, label: 'for years'};
  return {d: null, label: ''};
}
function uniBest(cls, pref, text, sides) {
  const bonus = new Map(); for (const [rx, lv] of UNI_BONUS) if (rx.test(text)) for (const l of lv) bonus.set(l, (bonus.get(l) || 0) + .5);
  const sd = sides || {}, sided = cls.filter(c => SIDE_CLS.has(c) && /^[LR]$/.test(sd[c] || '')), first = sided.length ? sd[sided[0]] : '';
  const sideOk = (c, i) => !(i <= 1 && first && SIDE_CLS.has(c) && /^[LR]$/.test(sd[c] || '') && sd[c] !== first);
  const score = UNI_LEVELS.map(([name, side], i) => ({name, side, i, fit: cls.filter(c => UNI_FIT[c].includes(i) && sideOk(c, i))})).map(x => Object.assign(x, {sc: x.fit.length + (x.fit.length ? bonus.get(x.i) || 0 : 0)}));
  score.sort((a, b) => b.fit.length - a.fit.length || b.sc - a.sc || (b.side === pref) - (a.side === pref) || a.i - b.i);
  return score;
}
// metabolic / toxic / systemic clues: the process bathes the whole brain, so the lesion is called DIFFUSE (not multifocal)
const DIFFUSE_RX = /metabolic|toxic|encephalopath|asterixis|uraem|uremi|renal failure|dialysis|hepatic|liver (failure|cirrhosis)|cirrho|jaundice|hypoglyc|hyperglyc|ketoacid|hyponatr|hypernatr|sodium|calcium|hypercalc|hypothyroid|myxoedema|thiamine|wernicke|alcohol|withdrawal|overdose|intoxicat|poison|drug|medication|sedat|opioid|benzodiazep|lithium|sepsis|septic|hypoxi|anoxi|cardiac arrest|hypercapn|fluctuat\w* (confusion|consciousness)|ตับ|ไต|น้ำตาล|เกลือแร่|เหล้า/i;
const DIFFUSE_FIT = new Set(['Altered consciousness', 'Cognitive impairment', 'Seizure / myoclonus', 'Movement disorder', 'Ataxia / vestibular symptoms', 'Visual loss', 'Dysarthria', 'Headache', 'Ocular motor / eyelid signs', 'Language disturbance', 'Motor weakness', 'Sensory symptoms', 'Hyperreflexia / spasticity (UMN sign)']);
const SIDE_CLS = new Set(['Motor weakness', 'Sensory symptoms', 'Hyperreflexia / spasticity (UMN sign)', 'Wasting / fasciculation (LMN sign)', 'Hypo/areflexia (LMN sign)']);
const sideOf = t => /\b(both|bilateral\w*)\b|ทั้งสองข้าง/i.test(t) ? 'B' : /\bleft\b|ซ้าย/i.test(t) && /\bright\b|ขวา/i.test(t) ? 'B' : /\bleft\b|ซ้าย/i.test(t) ? 'L' : /\bright\b|ขวา/i.test(t) ? 'R' : '';
function caseUnify(objective, chief, tx) {
  const text = String(tx || ''), sides = {};
  const mono = new Set((objective || []).filter(o => o.finding === 'Monocular visual loss').map(o => o.symptom));
  objective = (objective || []).filter(o => !(o.finding === 'Visual loss' && mono.has(o.symptom)));
  for (const o of objective) if (!sides[o.finding]) sides[o.finding] = sideOf(o.symptom);
  const chiefDur = chief ? durOf(text, chief.raw || chief.complaint) : {d: null}, chiefD = chiefDur.d;
  const main = new Map(), sep = new Map();
  for (const o of objective || []) {
    if (UNI_SKIP.has(o.finding) || !UNI_FIT[o.finding]) continue;
    const du = durOf(text, o.symptom);
    if (standalone(chiefD, du.d)) { if (!sep.has(o.finding)) sep.set(o.finding, {finding: o.finding, symptom: o.symptom, duration: du.label}); }
    else if (!main.has(o.finding)) main.set(o.finding, o.symptom);
  }
  for (const k of main.keys()) sep.delete(k);
  const cls = [...main.keys()];
  if (!cls.length) return null;
  const pref = chief && /^Mixed/.test(chief.pattern) ? 'both' : chief && /^(UMN|Central)/.test(chief.pattern) ? 'central' : chief && /^LMN/.test(chief.pattern) ? 'peripheral' : '';
  const mainText = text.split(/[.\n]+/).filter(x => !sep.size || ![...sep.values()].some(v => x.toLowerCase().includes(v.symptom.toLowerCase().slice(0, 30)))).join('. ');
  const dif0 = cls.filter(c => DIFFUSE_FIT.has(c)), encephal = cls.some(c => c === 'Altered consciousness' || c === 'Cognitive impairment');
  const diffuseFirst = DIFFUSE_RX.test(mainText) && encephal && dif0.length >= cls.length - 1 && !Object.values(sides).some(v => v === 'L' || v === 'R');
  const score = uniBest(cls, pref, mainText, sides), best = score[0], miss = diffuseFirst ? ['(diffuse)'] : cls.filter(c => !best.fit.includes(c));
  const separate = [...new Map([...sep.values()].map(x => [x.symptom, x])).values()];
  let sepLevel = '';
  if (separate.length) { const sc = uniBest([...new Set(separate.map(x => x.finding))], '', text.split(/[.\n]+/).filter(x => !chief || !x.toLowerCase().includes(String(chief.raw || '').toLowerCase().slice(0, 30))).join('. ')); sepLevel = sc[0].fit.length ? sc[0].name : ''; }
  const sepTxt = separate.length ? ` ${separate.map(x => x.symptom).join(', ')} ${separate.length > 1 ? 'have' : 'has'} a clearly different time course, so ${separate.length > 1 ? 'they form' : 'it forms'} a separate story${sepLevel ? ' (on its own it points to the ' + sepLevel.toLowerCase() + ')' : ''}; the newer story is usually what needs attention now.` : '';
  const cl = c => c.toLowerCase();
  // 1) one man, one lesion
  if (!miss.length && !diffuseFirst) return {type: 'single', single: true, level: best.name, explains: best.fit, notExplained: [], lesions: [{site: best.name, explains: best.fit}], separate, sepLevel,
    statement: `One man, one lesion: a single lesion in the ${cl(best.name)} explains all ${cls.length} finding group${cls.length > 1 ? 's' : ''} of the chief complaint story.` + sepTxt,
    alt: score.slice(1, 3).filter(x => x.fit.length === best.fit.length && x.sc === best.sc).map(x => x.name)};
  // 2) diffuse: a metabolic, toxic or systemic process bathing the brain gives findings at many levels
  const dif = cls.filter(c => DIFFUSE_FIT.has(c));
  if (diffuseFirst || (DIFFUSE_RX.test(mainText) && dif.length >= cls.length - 1 && dif.length >= 2)) return {type: 'diffuse', single: true, level: 'Diffuse (metabolic / toxic / systemic process)', explains: dif, notExplained: cls.filter(c => !dif.includes(c)), lesions: [{site: 'Diffuse brain involvement', explains: dif}], separate, sepLevel,
    statement: `No single focal lesion explains ${cls.map(cl).join(', ')}, and the history has a metabolic, toxic or systemic clue: call it a diffuse process bathing the brain rather than multifocal lesions. Correct the cause first, then re-examine for anything focal that remains.` + sepTxt, alt: []};
  // 3) multifocal: cover the findings with as few lesions as possible and discuss each
  const lesions = [{site: best.name, explains: best.fit}]; let left = miss.slice();
  while (left.length && lesions.length < 4) { const sc = uniBest(left, '', mainText, sides)[0]; if (!sc.fit.length) break; lesions.push({site: sc.name, explains: sc.fit}); left = left.filter(c => !sc.fit.includes(c)); }
  const n = lesions.length;
  return {type: 'multifocal', single: false, level: `Multifocal: ${n} lesions`, explains: best.fit, notExplained: left, lesions, separate, sepLevel,
    statement: `No single site explains every finding (one man, one lesion fails), so this needs ${n} lesions: ${lesions.map((l, k) => `(${k + 1}) ${cl(l.site)} for ${l.explains.map(cl).join(', ')}`).join('; ')}. Before accepting this, re-check whether one disease could cause lesions in several places at once (demyelination, vasculitis, emboli, metastases, infection).` + sepTxt,
    alt: []};
}
// ---- previous procedure or treatment: frame the differential in three groups
const PRIOR_RX = /\b(after|post|following|since)\b[^.;\n]{0,40}\b(surgery|operation|op\b|craniotomy|laminectomy|discectomy|fusion|shunt|biopsy|thrombolysis|alteplase|tenecteplase|tpa\b|thrombectomy|coiling|clipping|stent\w*|angiogra\w*|lumbar puncture|\blp\b|epidural|spinal an\w*|chemo\w*|radio\w*|radiation|transplant|dialysis|vaccin\w*|ivig|plasma exchange|steroid\w*|immunotherap\w*|car-t)|\b(post-?op\w*|postoperative|was (started|put) on|has been (taking|on|treated)|treated with|on (warfarin|apixaban|rivaroxaban|heparin|steroids?|chemotherapy|immunosuppress\w*|antiepileptic\w*|levodopa)|received|underwent)\b|ผ่าตัด|หลังผ่าตัด|ได้รับยา|หลังได้รับ|หลังทำ|ได้รับการรักษา/i;
const KNOWN_RX = /\b(known|history of|diagnosed with|treated for|case of|underlying)\s+([^,.;\n]{3,60})/i;
function casePrior(tx) {
  const t = String(tx || ''); if (!PRIOR_RX.test(t)) return null;
  const sent = t.split(/[.\n]+/).find(x => PRIOR_RX.test(x)) || '', k = t.match(KNOWN_RX);
  return {treatment: sent.trim().slice(0, 140), disease: k ? k[2].trim() : '',
    groups: [{key: 'disease', title: 'Original disease, now worse or complicated', hint: k ? `Has ${k[2].trim()} progressed, relapsed or produced a complication of its own?` : 'Has the original disease progressed, relapsed or produced a complication of its own?'},
      {key: 'treatment', title: 'Complication of the treatment or procedure', hint: 'Bleeding, infection, ischaemia, CSF leak or low pressure, device or shunt problem, drug adverse effect or interaction, withdrawal, immune reaction.'},
      {key: 'new', title: 'A new disease unrelated to the original one', hint: 'Something that happened to arrive now; weigh it by the same localization and tempo as any new case.'}]};
}
// ---- Headache: size, side, sequence -> structure (the curator's bedside approach; draft for expert review)
// First rule: when headache comes with another deficit, the deficit is the first priority and is localized first.
const HD_RX = /headache|head ache|cephalg|migraine|ปวดหัว|ปวดศีรษะ/i;
const HD_AREA = [
  ['small', /coin|10.?baht|nummular|small (area|spot|patch)|one (small )?spot|coin.sized|focal (spot|area)|เหรียญ|จุดเดียว|เฉพาะจุด/i],
  ['sectoral', /sector\w*|wedge|segment\w*|sinus|cheek|maxilla\w*|between the eyes|over the (forehead|bridge of the nose)|เสี้ยว|ไซนัส|โหนกแก้ม/i],
  ['vertex', /vertex|top of the head|crown|กลางกระหม่อม|กระหม่อม/i],
  ['hemicranial', /hemicran\w*|one side of the (head|skull)|(left|right)[- ]sided head|(left|right) side of (the|his|her|my) head|(left|right) (temporal|frontal|parietal|occipital|hemicranial) (head|pain)|side.locked|unilateral (head|pain)|alternating side|ปวดหัวข้างเดียว|ปวดศีรษะข้าง|ปวดหัวข้าง(ซ้าย|ขวา)/i],
  ['holocephalic', /holocephal\w*|whole head|all over the head|entire head|diffuse head|generali[sz]ed head|bilateral head|both sides of the head|band.like|tight band|ปวดทั้งหัว|ทั่วศีรษะ|ปวดทั้งศีรษะ/i]];
const HD_DEFICIT = /weak|paresis|plegia|numb|tingl|diplop|double vision|ptosis|visual loss|loss of vision|blind|hemianop|slur|dysarth|aphas|word.finding|ataxi|unsteady|seiz|convuls|confus|drows|stupor|coma|palsy|facial droop|deviat|อ่อนแรง|ชา(?![ยวต])|ภาพซ้อน|ตามัว|พูดไม่ชัด|ชัก|ซึม/i;
const HD_ICP = /papill?o?edema|papilloedema|pulsatile tinnitus|visual obscuration|worse (on |when |with )?(lying|lie|bending|cough\w*|strain\w*)|morning|wakes? (him|her|me) (up|from sleep)|projectile|vomit/i;
const HD_UPRIGHT = /worse (on |when |with |after )?(sitting|standing|getting up|upright|being upright)|better (on |when |with |after )?(lying|lie|recumbent)|relieved (by|on|when) lying|orthostatic|postural headache|ปวดมากขึ้นเมื่อ(นั่ง|ยืน|ลุก)|นอน(ลง)?แล้ว(ดีขึ้น|หาย)/i;
const HD_LP = /lumbar puncture|\bLP\b|spinal (an(a)?esthesia|block)|epidural|myelogra\w*|intrathecal|เจาะหลัง|เจาะน้ำไขสันหลัง|บล็อกหลัง|ฉีดยาชาเข้าไขสันหลัง/i;
function hdSentIdx(sents, rx) { return sents.findIndex(x => rx.test(x)); }
function caseHeadache(tx, chiefIsHeadache) {
  const t = String(tx || ''), pos = posText(t);
  if (!HD_RX.test(pos)) return null;
  const sents = pos.split(/[.\n;]+/), hs = hdSentIdx(sents, HD_RX), hsent = sents[hs] || '';
  const area = (HD_AREA.find(([, rx]) => rx.test(hsent)) || HD_AREA.find(([, rx]) => rx.test(pos)) || ['not stated'])[0];
  const occ = /occipit|back of the head|nape|ท้ายทอย/i.test(pos);
  const icp = HD_ICP.test(pos), upright = HD_UPRIGHT.test(pos), lp = HD_LP.test(pos);
  // sequence: headache first (extra-axial) or headache with / after the deficit (intra-axial); work clause by clause
  const cl = pos.split(/[.;,\n]+|\b(?=then\b|later\b|followed by\b)|ต่อมา|หลังจากนั้น/i).map(x => x.trim()).filter(Boolean);
  const cdur = c => { const m = c.match(PL_DUR); if (m) return durDays(m[1] || m[2]); if (/yesterday|last night|เมื่อวาน/i.test(c)) return 1; if (/this (morning|afternoon|evening)|today|hours? ago|วันนี้/i.test(c)) return .3; return null; };
  const hc = cl.findIndex(c => HD_RX.test(c)), dc = cl.findIndex(c => HD_DEFICIT.test(c.replace(HD_RX, ' ')));
  let seq = 'no deficit', axis = '';
  if (dc >= 0) {
    const hd = cdur(cl[hc] || ''), dd = cdur(cl[dc] || '');
    const together = /together|at the same time|simultaneous|พร้อมกัน/i.test(pos) || (dc === hc);
    const later = dc > hc && /^(then|later|followed by)\b|ต่อมา|หลังจากนั้น/i.test(cl[dc]) ;
    if (!together && ((hd != null && dd != null && hd >= 2 * dd) || (later && !(hd != null && dd != null && dd >= hd)))) { seq = 'headache first, deficit later'; axis = 'extra-axial'; }
    else if (!together && ((hd != null && dd != null && dd >= 2 * hd) || dc < hc)) { seq = 'deficit first'; axis = 'intra-axial'; }
    else { seq = 'headache and deficit together'; axis = 'intra-axial'; }
  }
  const defIdx = dc;
  let structure = '', why = '', think = [];
  if (area === 'small') { structure = 'Paracranial structure (scalp, periosteum, skull)'; why = 'A small area of pain (about the size of a 10-baht coin) points to a paracranial lesion rather than an intracranial one; it is almost always secondary and needs work-up, not just pain control.'; think = ['Nummular headache', 'Pott’s disease', 'Intracranial subdural empyema']; }
  else if (area === 'sectoral') { structure = 'Paranasal sinus'; why = 'A sector or wedge-shaped area over the face and forehead points to the paranasal sinuses.'; think = ['Headache attributed to rhinosinusitis (sinus headache)', 'Acute angle-closure glaucoma (headache mimic)']; }
  else if (area === 'vertex') { structure = 'Midline structure'; why = 'An isolated vertex (or alternating) headache suggests a midline lesion.'; think = ['Colloid cyst of the third ventricle', 'Obstructive hydrocephalus']; }
  else if (area === 'hemicranial' || area === 'holocephalic' || area === 'not stated') {
    const hemi = area === 'hemicranial';
    if (axis === 'intra-axial') { structure = 'Intra-axial (brain parenchyma)'; why = 'The headache came together with or after the deficit, so the lesion is in the brain itself; localize by the deficit (pyramidal or brainstem signs).'; think = /sudden|abrupt|thunderclap|hours? ago|minutes|this morning|today|ทันที/i.test(pos) ? ['Intracerebral haemorrhage (ICH)', 'Subarachnoid haemorrhage', 'Cerebral venous thrombosis (CVT)'] : ['Brain tumour', 'Brain abscess', 'Cerebral venous thrombosis (CVT)']; }
    else if (axis === 'extra-axial' && hemi) { structure = 'Extra-axial: pachymeninges (dura, periosteum, skull base)'; why = 'Side-locked headache that came before the deficit points to the dura; look for cranial nerve palsies.'; think = ['Pachymeningitis', 'Chronic subdural haematoma', 'Subdural and extradural haematoma']; }
    else if (axis === 'extra-axial') { structure = icp ? 'Extra-axial: leptomeninges / venous sinuses / CSF pathway (raised pressure)' : 'Extra-axial: leptomeninges or midline lesion'; why = 'Diffuse headache that came before the deficit points to the leptomeninges or a midline lesion' + (icp ? '; signs of raised pressure point to meningeal, venous or CSF-flow (hydrocephalus) causes.' : '.'); think = icp ? ['Cerebral venous thrombosis (CVT)', 'Leptomeningeal metastases', 'Obstructive hydrocephalus', 'Idiopathic intracranial hypertension (IIH)'] : ['Leptomeningeal metastases', 'Colloid cyst of the third ventricle']; }
    else if (hemi) { structure = occ ? 'Lateralized: think infratentorial or cervical' : 'Lateralized (side-locked) headache'; why = 'A side-locked headache needs an intracranial or cervical cause excluded; supratentorial lesions rarely cause occipital pain, infratentorial lesions often start with occipital pain.'; think = occ ? ['Cervicogenic headache', 'Chiari I malformation'] : []; }
    else if (area === 'holocephalic') { structure = icp ? 'Diffuse: raised intracranial pressure' : 'Diffuse headache'; why = icp ? 'Bilateral headache with signs of raised pressure (papilloedema, pulsatile tinnitus, worse lying or in the morning) points to meningeal, venous or CSF-flow causes.' : 'Bilateral headache without raised-pressure signs: consider a midline lesion if anything else is suspicious.'; think = icp ? ['Idiopathic intracranial hypertension (IIH)', 'Cerebral venous thrombosis (CVT)', 'Obstructive hydrocephalus'] : []; }
  }
  let posture = '';
  if (upright) { if (lp) { posture = 'Worse sitting or standing after a lumbar puncture or spinal block: post-dural puncture headache (a treatment complication).'; think = ['Post-dural puncture headache'].concat(think); }
    else { posture = 'Worse sitting or standing and better lying, without a lumbar puncture or spinal block: think of two things, low-pressure headache (spontaneous intracranial hypotension from a CSF leak) and a posterior fossa mass.'; think = ['Spontaneous intracranial hypotension (SIH)', 'Posterior fossa mass', 'Chiari I malformation'].concat(think); } }
  else if (icp && /worse (on |when |with )?(lying|lie)|morning|wakes/i.test(pos)) posture = 'Worse lying down or in the morning: raised intracranial pressure; look for false localizing signs (bilateral sixth nerve palsy, ataxia, hearing change).';
  return {area, sequence: seq, axis, structure, why, posture, deficitFirst: defIdx >= 0 && chiefIsHeadache, think: [...new Set(think)].slice(0, 5).map(n => ({name: n, e: nameMatch(n)}))};
}
const LOC_PATH = {
  'cortex': ['UMN', 'Brain', 'Cortical'], 'subcortical': ['UMN', 'Brain', 'Subcortical'], 'basal-ganglia': ['Brain', 'Subcortical', 'Basal ganglia circuit'],
  'thalamus': ['Brain', 'Subcortical', 'Thalamus'], 'cerebellum': ['Brain', 'Cerebellum / cerebellar circuit'], 'brainstem': ['UMN', 'Brain', 'Brainstem'],
  'cranial-nerve': ['LMN', 'Cranial nerve'], 'optic': ['Brain', 'Visual pathway'], 'vestibular': ['Vestibular system'], 'meninges': ['Meninges'],
  'ventricles-csf': ['Brain', 'Ventricles / CSF pressure'], 'spinal-cord': ['UMN', 'Spinal cord'], 'anterior-horn': ['LMN', 'Anterior horn cell'],
  'root': ['LMN', 'Root'], 'plexus': ['LMN', 'Plexus'], 'nerve': ['LMN', 'Nerve'], 'nmj': ['LMN', 'NMJ'], 'muscle': ['LMN', 'Muscle'],
  'autonomic': ['Autonomic nervous system'], 'multifocal': ['Multifocal / diffuse'], 'functional': ['Functional (no structural lesion)']};
// ---- r51 reasoning rules: tempo → etiology, reduced consciousness, dizziness, and reading CSF / electrodiagnostic results.
// Tempo rules are the curator's own; coma, dizziness and test-result rules are drawn (in our words) from Plum and Posner's
// Stupor and Coma, the curator's vertigo tutorial, Cerebrospinal Fluid in Clinical Neurology, Kimura's Electrodiagnosis and
// Daube's Clinical Neurophysiology. Points marked (agent) are general conventions for expert review.
// English negation runs to the end of the clause; Thai ไม่มี / ปฏิเสธ runs to the next space (Thai clauses are space-separated;
// plain ไม่ is left alone because พูดไม่ชัด, เดินไม่ได้ are positive findings)  (v1.7)
const NEG_RX = /\b(?:no|not|without|denies|denied|negative for|absent)\b[^.;,\n]*|(?:ไม่มี|ปฏิเสธ)[^\s.;,]*/gi;
function posText(tx) { return String(tx || '').replace(NEG_RX, ' '); }
const T_RR = /relaps|remission|remitt|recovered (?:fully|completely)|back to (?:normal|baseline)|full recovery|previous (?:attack|episode)s?[^.]*(?:resolved|recovered)|กลับเป็นปกติ|หายสนิท|กำเริบ/i;
const T_UHT = /uhthoff|worse (?:with|after|in) (?:heat|hot|exercise|a hot (?:bath|shower))|hot (?:bath|shower)[^.]*worse/i;
const T_PULF = /pulfrich/i;
const T_TRIG = /fever|febrile|infection|uti|urinary tract|pneumonia|sepsis|flu|cold|illness|ไข้|ติดเชื้อ/i;
const T_FLUCT = /fluctuat|comes and goes|on and off|intermittent|episod|attacks?\b|spells?\b|paroxysm|transient|worse (?:in|by|towards) the evening|fatigab|after exertion|recurrent|เป็นๆ ?หายๆ|เป็น ๆ หาย ๆ|เป็นพัก/i;
const T_STEP = /stepwise|step-wise|in steps|step by step|stuttering|worsen\w* (?:again|further) (?:over|after)|ทีละขั้น/i;
const T_MAX = /maximal at onset|maximum (?:at|from) (?:the )?onset|spectacular|instantly|in an instant|all at once|ทันทีทันใด/i;
const T_HYPER = /\bsudden\w*|abrupt\w*|thunderclap|instant\w*|within (?:seconds|a minute)|woke up with|on waking|ทันที|ฉับพลัน/i;
const T_RAPID = /rapid\w* progress|progress\w* (?:rapidly|quickly|fast)|worsen\w* (?:rapidly|quickly|daily|day by day)|over (?:\d+|a few|several|two|three) (?:days|weeks)[^.]*(?:worse|progress|declin)|แย่ลงเร็ว/i;
const T_ICP = /papill|vomit|morning headache|headache[^.]*worse (?:lying|in the morning)|sixth nerve|vi(?:th)? nerve palsy|raised (?:intracranial|icp)|ปวดหัวตอนเช้า|อาเจียน/i;
const T_PSYCHO = /confus|drows|personality|behaviou?r|apath|cognit|memory|slow(?:ing|ed) (?:thinking|mentation)|psychomotor|ซึม|สับสน|ความจำ/i;
const T_IMMUNO = /\bhiv\b|aids|immunosupp|immunocompromis|transplant|chemotherap|steroid|rituximab|cd4|ภูมิคุ้มกันต่ำ/i;
const T_FEVER = /fever|febrile|ไข้/i;
function caseTempo(tx) {
  const t = String(tx || ''), pos = posText(t);
  const dm = pos.match(new RegExp(PL_DUR.source, 'gi')) || [], days = dm.map(x => durDays(x)).filter(x => x != null);
  const dmax = days.length ? Math.max(...days) : null;
  const out = {pattern: '', why: '', etiology: [], think: [], clues: []};
  const add = (category, detail) => out.etiology.push({category, detail});
  if (T_RR.test(pos) || T_UHT.test(pos) || T_PULF.test(pos)) {
    out.pattern = 'Relapsing–remitting';
    out.why = 'Attacks separated by remissions. A true remission returns to the previous baseline; that pattern points to demyelinating disease.';
    if (T_UHT.test(pos)) out.clues.push('Uhthoff phenomenon (worse with heat or exercise) supports demyelination');
    if (T_PULF.test(pos)) out.clues.push('Pulfrich phenomenon (moving objects seem to travel in an ellipse) supports optic nerve demyelination');
    add('Inflammatory', 'Demyelinating disease (MS, NMOSD, MOGAD)');
    if (T_TRIG.test(pos)) { out.clues.push('A fever, infection or other illness came first: consider a pseudorelapse — not a true relapse; it usually settles within 24 hours of treating the trigger'); add('Pseudorelapse', 'Old deficits unmasked by fever, infection or heat'); }
    out.think = ['Multiple sclerosis (MS)', 'Neuromyelitis optica spectrum disorder (NMOSD)'];
  } else if (T_FLUCT.test(pos) && !T_STEP.test(pos)) {
    out.pattern = 'Fluctuating / episodic';
    out.why = 'Symptoms come and go. Fluctuation points to a channel-related (paroxysmal) disorder rather than a fixed lesion.';
    add('Paroxysmal / channel-related', 'Channelopathy, migraine, seizure, myasthenia gravis');
    if (/evening|fatigab|exertion|ptosis|diplop|double vision/i.test(pos)) out.clues.push('Worse with use or towards evening: neuromuscular junction (myasthenia gravis)');
    if (/headache|aura|migrain|ปวดหัว/i.test(pos)) out.clues.push('With headache or aura: migraine');
    if (/jerk|stiff|unresponsive|tongue bit|incontinen|staring|ชัก|เกร็ง/i.test(pos)) out.clues.push('With stereotyped motor or awareness change: seizure');
    if (/paraly|weak\w* after (?:rest|meal|carbo)|potassium|kalaem/i.test(pos)) out.clues.push('Episodic weakness after rest or a carbohydrate meal: periodic paralysis (channelopathy)');
    out.think = ['Myasthenia gravis (MG)', 'Migraine', 'Epilepsy', 'Periodic paralysis'];
  } else if (T_STEP.test(pos)) {
    out.pattern = 'Stepwise';
    out.why = 'Worsening in steps is a vascular pattern; a stuttering, stepwise course suggests atherosclerotic (large-artery or branch) disease.';
    add('Vascular', 'Ischaemic — atherosclerosis (large-artery or branch disease)');
    out.think = ['Lacunar infarct', 'Symptomatic carotid stenosis'];
  } else if (T_HYPER.test(pos) || (dmax != null && dmax <= 1 / 24)) {
    out.pattern = T_MAX.test(pos) ? 'Hyperacute, maximal at onset' : 'Hyperacute (seconds to minutes)';
    out.why = 'Onset in seconds or minutes is vascular until proved otherwise; the main causes are embolism and haemorrhage, more than thrombotic ischaemia.' + (T_MAX.test(pos) ? ' A deficit that is spectacular (maximal) at onset suggests cardioembolism.' : '');
    add('Vascular', T_MAX.test(pos) ? 'Embolic — cardioembolic' : 'Embolic or haemorrhagic (more than thrombotic ischaemia)');
    out.think = ['Intracerebral haemorrhage (ICH)', 'Subarachnoid haemorrhage'];
  } else if (T_RAPID.test(pos) || (dmax != null && dmax > 2 && dmax <= 42 && /progress|worse|worsen|declin|แย่ลง/i.test(pos))) {
    out.pattern = 'Rapidly progressive (days to weeks)';
    out.why = 'Steady worsening over days to weeks.';
    add('Neoplastic', 'Decompensated tumour — vasogenic oedema or bleeding into the tumour');
    if (T_ICP.test(pos)) out.clues.push('Raised-pressure features favour a decompensating mass');
    if (T_PSYCHO.test(pos)) out.clues.push('Rapid psychomotor decline also fits a decompensating mass or a CNS infection');
    if (T_IMMUNO.test(pos)) { add('Infection (immunocompromised)', 'HIV with retroviral syndrome, CMV, toxoplasmosis, cryptococcal infection'); out.clues.push('Immunocompromised host: opportunistic CNS infection'); }
    else add('Infection (immunocompetent)', 'TB, viral (VZV, HSV), syphilis, parasites');
    if (T_FEVER.test(pos)) out.clues.push('Fever favours infection');
    out.think = ['Brain tumour', 'Tuberculous meningitis (TBM)', 'Herpes simplex encephalitis (HSE)'];
  } else if (dmax != null && dmax <= 2) {
    out.pattern = 'Acute (hours to 2 days)'; out.why = 'Onset over hours to a couple of days: vascular first, then acute inflammatory, infective, toxic or metabolic causes.';
    add('Vascular', 'Ischaemic or haemorrhagic');
  } else if (dmax != null && dmax <= 60) {
    out.pattern = 'Subacute (days to weeks)'; out.why = 'Inflammatory or infective causes first; also a decompensating mass.';
    add('Inflammatory / infective', ''); add('Neoplastic', 'if raised-pressure features');
  } else if (dmax != null) {
    out.pattern = 'Chronic progressive (months to years)'; out.why = 'Degenerative, neoplastic or genetic causes first.';
    add('Degenerative', ''); add('Neoplastic', ''); add('Genetic', '');
  } else return null;
  return out;
}
// ---- reduced consciousness: structural versus metabolic/toxic (Plum and Posner)
const K_RX = /\bcoma\w*|stupor\w*|obtund|unrespons|unconscious|drows\w*|somnolen|lethargic|decreased (?:level of )?consciousness|altered (?:mental|consciousness|sensorium)|confus\w*|deliri\w*|\bgcs\b|e\d\s*v\d\s*m\d|ซึม|ไม่รู้สึกตัว|หมดสติ|สับสน/i;
const K_STRUCT = [
  [/hemipar|hemipleg|weak\w* (?:of )?(?:the )?(?:left|right)|(?:left|right)[- ]sided weak|lateraliz|asymmetric/i, 'Lateralized motor signs'],
  [/(?:unequal|asymmetric|anisocor)\w* pupil|blown pupil|fixed (?:and )?dilated|dilated (?:and )?fixed|non-?reactive pupil|unreactive pupil|pupil[^.]*(?:not|non|un)reactive|third nerve palsy|iii(?:rd)? nerve/i, 'Unequal or unreactive pupil (if no anticholinergic drug or eye disease)'],
  [/gaze (?:deviation|preference)|eyes? deviat|forced (?:gaze|deviation)|skew deviation|dysconjugate|disconjugate/i, 'Sustained gaze deviation or dysconjugate eyes'],
  [/(?:absent|lost|impaired|no) (?:doll|oculocephalic|caloric|vestibulo-?ocular|corneal)/i, 'Lost brainstem reflex (oculocephalic, caloric or corneal)'],
  [/decerebrat|decorticat|extensor posturing|flexor posturing/i, 'Posturing (asymmetric posturing is strongly structural)'],
  [/papill/i, 'Papilloedema'],
  [/apneustic|ataxic breathing|biot|central neurogenic hyperventilation/i, 'Breathing pattern that points to a brainstem level'],
  [/babinski|extensor plantar|upgoing toe/i, 'Babinski sign (more telling when one-sided)'],
];
const K_META = [
  [/reactive pupils?|pupils? (?:equal and )?reactive|pupils? (?:are )?(?:equal|normal|brisk)|perrla?/i, 'Pupils still react to light — the single most useful sign of metabolic coma'],
  [/asterixis|flap/i, 'Asterixis'],
  [/multifocal myoclon|myoclon/i, 'Multifocal myoclonus'],
  [/tremor/i, 'Tremor'],
  [/fluctuat|inattent|deliri/i, 'Fluctuating inattention (delirium) before drowsiness'],
  [/hypoglyc|hyperglyc|glucose|sugar|dka|hyperosmolar/i, 'Glucose disturbance'],
  [/sodium|hyponat|hypernat|calcium|hypercalc/i, 'Electrolyte disturbance'],
  [/liver|hepatic|cirrho|ammonia|jaundice/i, 'Liver failure'],
  [/renal|uraemi|uremi|kidney|creatinine|dialysis/i, 'Kidney failure'],
  [/sepsis|septic|fever|febrile/i, 'Sepsis or fever'],
  [/hypox|spo2|desatur|co2|hypercap|carbon monoxide/i, 'Hypoxia or carbon dioxide retention'],
  [/overdose|intoxic|alcohol|drunk|opioid|benzodiaz|sedat|poison|toxin|drug/i, 'Drug, alcohol or toxin'],
  [/post-?ictal|after (?:a |the )?seizure|convuls/i, 'After a seizure (post-ictal)'],
];
const K_PSYCH = /resist\w* (?:eye|lid) opening|eyes? (?:deviate|look) (?:to|towards) the (?:ground|floor)|avoid\w* (?:the )?(?:ground|floor)|arm drop[^.]*(?:avoid|miss)|nystagmus on caloric|psychogenic/i;
function caseComa(tx) {
  const t = String(tx || ''), pos = posText(t);
  if (!K_RX.test(pos)) return null;
  const gcs = (t.match(/\bgcs\D{0,5}(\d{1,2})/i) || [])[1];
  const s = K_STRUCT.filter(([rx]) => rx.test(pos)).map(x => x[1]), m = K_META.filter(([rx]) => rx.test(pos)).map(x => x[1]);
  if (/pupils?[^.;]{0,25}\b(?:not|non|un)[- ]?reactive|pupils?[^.;]{0,25}no (?:light )?(?:reaction|response)/i.test(t) && !s.some(x => /pupil/.test(x))) s.push(K_STRUCT[1][1]);
  if (/(?:no|absent) (?:doll'?s?|oculocephalic|caloric|corneal)/i.test(t) && !s.some(x => /brainstem reflex/.test(x))) s.push(K_STRUCT[3][1]);
  const psych = K_PSYCH.test(pos);
  if (psych) { const i = s.findIndex(x => /gaze deviation/.test(x)); if (i >= 0) s.splice(i, 1); }
  let verdict, why;
  if (psych) { verdict = 'Consider psychogenic unresponsiveness'; why = 'Active resistance to eyelid opening, eyes turning to the ground, or brisk nystagmus on caloric testing mean the brainstem and cortex are working. Diagnose only after a full examination and EEG if any doubt remains.'; }
  else if (s.length) { verdict = 'Structural (focal) cause likely'; why = 'Focal or brainstem signs mean a structural lesion until proved otherwise: image the brain now (CT, or CT angiography if stroke is suspected), and treat raised pressure before transfer when signs of herniation are present.'; }
  else if (m.length) { verdict = 'Metabolic / toxic (diffuse) cause likely'; why = 'No focal signs, with reactive pupils or systemic clues: a diffuse metabolic or toxic encephalopathy. Still image the brain if the cause is not found quickly — bilateral subdural haematomas or diffuse small-vessel plugging can look metabolic.'; }
  else { verdict = 'Not yet decided'; why = 'Examine pupils, eye movements (oculocephalic or caloric), motor responses and breathing to separate a structural from a metabolic cause; image urgently if unsure.'; }
  const steps = ['Stabilize airway, breathing and circulation; check glucose at once (give thiamine with glucose) (agent)',
    'Is it true reduced arousal? Exclude locked-in state (vertical eye movements and blinking preserved), akinetic mutism or abulia, psychogenic unresponsiveness, and a focal cognitive deficit that looks like confusion (Wernicke aphasia, neglect, Balint or Anton syndrome)',
    'Pupils: reactive pupils despite other brainstem failure = metabolic; a fixed dilated pupil = third nerve or uncal herniation; pinpoint reactive pupils = pons or opioids',
    'Eye movements and brainstem reflexes, motor response (symmetric or not) and breathing pattern',
    'Look for rostral–caudal worsening (herniation) — a neurosurgical emergency'];
  const pitfalls = [];
  if (/anticholinerg|atropin|datura|tricyclic/i.test(pos)) pitfalls.push('Anticholinergic drugs dilate and fix the pupils without a structural lesion');
  if (/opioid|morphine|heroin|fentanyl|pinpoint/i.test(pos)) pitfalls.push('Opioids give pinpoint pupils that still react with a bright light');
  if (/hypoglyc/i.test(pos)) pitfalls.push('Hypoglycaemia can cause focal signs that resolve with glucose');
  return {gcs: gcs || '', verdict, why, structural: s, metabolic: m, steps, pitfalls,
    think: s.length ? ['Intracerebral haemorrhage (ICH)', 'Subdural and extradural haematoma'] : ['Metabolic encephalopathy', 'Toxic encephalopathy']};
}
// ---- dizziness and vertigo (curator's 6-step approach)
const V_RX = /vertig|dizz|giddy|lightheaded|light-headed|spinning|room (?:is )?(?:spinning|moving)|unsteady|imbalance|off balance|เวียนหัว|เวียนศีรษะ|บ้านหมุน|มึนหัว|เดินเซ/i;
// the dizziness block opens only when the patient complains of dizziness itself, not of an unsteady gait alone (curator 2026-11-19)
const V_COMPLAINT = /vertig|dizz|giddy|light-?headed|spinning|room (?:is )?(?:spinning|moving)|swaying|rocking|เวียน|บ้านหมุน|มึน|โคลงเคลง/i;
// Sonnet answered the block with {} = it judged the block does not apply: trust it over the on-device guess (v1.7)
const aiSaysNone = o => !!o && typeof o === 'object' && !Array.isArray(o) && !Object.keys(o).length;
function caseDizzy(tx) {
  const t = String(tx || ''), pos = posText(t);
  if (!V_COMPLAINT.test(pos)) return null;
  const name = /spinning|vertig|room (?:is )?(?:spinning|moving)|rotat|บ้านหมุน/i.test(pos) ? 'Vertigo (false sense of motion)'
    : /visual|scrolling|busy (?:shop|supermarket|place)|screen|moving traffic/i.test(pos) ? 'Vestibulovisual symptoms (triggered by visual motion)'
    : /unsteady|imbalance|off balance|veer|เดินเซ/i.test(pos) && !/dizz|เวียน|มึน/i.test(pos) ? 'Unsteadiness (balance)'
    : 'Dizziness (no false sense of motion)';
  const dm = pos.match(new RegExp(PL_DUR.source, 'gi')) || [], days = dm.map(x => durDays(x)).filter(x => x != null);
  const dmax = days.length ? Math.max(...days) : null;
  const positional = /position|turn\w* (?:over )?in bed|lying down|roll\w* over|looking up|bending|getting (?:up|out of bed)|head movement|พลิกตัว|ล้มตัวนอน|เงยหน้า|ก้ม/i.test(pos);
  const episodic = /episod|attacks?|spells?|recurrent|comes and goes|bouts?|เป็นๆ ?หายๆ|เป็นพัก/i.test(pos);
  const continuous = /continuous|constant|persistent|all the time|for (?:\d+|two|three|several) days|since (?:yesterday|\d+ days)/i.test(pos);
  let pattern, think = [];
  if (dmax != null && dmax >= 60 && !episodic) { pattern = 'Chronic vestibular syndrome (months to years)'; think = ['Persistent postural-perceptual dizziness (PPPD)', 'Bilateral vestibular failure (BVF)', 'Cerebellar ataxia, neuropathy and vestibular areflexia syndrome (CANVAS)']; }
  else if (episodic && positional) { pattern = 'Episodic positional (triggered, seconds to minutes)'; think = ['Benign paroxysmal positional vertigo (BPPV)', 'Vestibular migraine', 'Vestibular paroxysmia', 'Central positional nystagmus']; }
  else if (episodic || (dmax != null && dmax < 1)) { pattern = 'Episodic spontaneous (minutes to hours)'; think = ['Vestibular migraine', 'Ménière’s disease', 'Vestibular paroxysmia', 'Transient ischaemic attack (TIA)', 'Episodic ataxia type 2']; }
  else if (continuous || (dmax != null && dmax >= 1)) { pattern = 'Acute vestibular syndrome (continuous, days to weeks)'; think = ['Vestibular neuritis', 'Lateral medullary syndrome (Wallenberg syndrome)', 'Labyrinthitis']; }
  else if (positional) { pattern = 'Episodic positional (triggered, seconds to minutes)'; think = ['Benign paroxysmal positional vertigo (BPPV)']; }
  else pattern = 'Not yet decided — ask how long each spell lasts and what sets it off';
  const C = [], P = [];
  const mixVT = /(?:up|down)beat(?:ing)?[- ](?:and )?torsional|torsional[- ](?:and )?(?:up|down)beat/i.test(pos);
  if (/vertical nystagmus|downbeat|upbeat|pure torsional/i.test(pos) && !(mixVT && positional)) C.push('Vertical or pure torsional nystagmus');
  if (mixVT && positional) P.push('Mixed vertical-torsional positional nystagmus (posterior canal: upbeat-torsional; anterior canal: downbeat-torsional)');
  if (/direction[- ]chang|bidirectional|gaze[- ]evoked|multidirectional/i.test(pos)) C.push('Direction-changing or gaze-evoked nystagmus');
  if (/skew/i.test(pos)) C.push('Skew deviation (seen in both, but favours central in an acute vestibular syndrome)');
  if (/(?:no|without (?:a )?)corrective saccade/i.test(t)) C.push('Normal head impulse test (no corrective saccade) during continuous vertigo');
  if (/(?:normal|negative) (?:head impulse|hit)|head impulse (?:test )?(?:is )?normal/i.test(pos)) C.push('Normal head impulse test during continuous vertigo');
  if (/cannot (?:stand|walk)|unable to (?:stand|walk|sit)|truncal ataxia|severe (?:gait )?ataxia/i.test(pos)) C.push('Cannot stand or walk unaided (truncal ataxia)');
  if (/dysarth|diplop|double vision|dysphag|facial numb|horner|hiccup|limb ataxia|dysmetr|weak|numb|พูดไม่ชัด|ภาพซ้อน|กลืนลำบาก/i.test(pos)) C.push('Other brainstem or cerebellar signs');
  if (/(?:sudden|new|acute) (?:hearing loss|deafness)|hearing loss[^.]*sudden/i.test(pos) && /continuous|constant|days|since/i.test(pos)) C.push('New hearing loss with acute vertigo (can be AICA stroke)');
  if (/horizontal(?:-torsional)? nystagmus|unidirectional|beats? (?:to|towards) the (?:left|right)/i.test(pos)) P.push('Unidirectional horizontal-torsional nystagmus');
  if (/corrective saccade|(?:positive|abnormal) (?:head impulse|hit)/i.test(pos)) P.push('Head impulse test with a corrective saccade');
  if (/latency|fatig|dix-?hallpike[^.]*(?:positive|torsional|upbeat)/i.test(pos)) P.push('Positional nystagmus with latency and fatigue (Dix-Hallpike)');
  if (/ear fullness|aural fullness|tinnitus|hearing loss|หูอื้อ|เสียงในหู/i.test(pos)) P.push('Ear symptoms (fullness, tinnitus, hearing loss)');
  const verdict = C.length ? 'Central features — treat as posterior circulation stroke or other central cause until imaged' : P.length ? 'Peripheral pattern' : 'Central or peripheral not yet decided';
  const extra = /orthostat|postural (?:drop|hypotension)|on standing|stand(?:ing)? up|syncope|faint|palpitat|chest pain|hypoglyc|เป็นลม|ใจสั่น/i.test(pos);
  return {name, pattern, verdict, central: C, peripheral: P, extra,
    first: 'Rule out orthostatic hypotension, hypoglycaemia and low cardiac output (arrhythmia, heart failure, severe aortic stenosis) first: extracranial causes can mimic any vestibular pattern.',
    caveats: 'A positive Dix-Hallpike does not exclude a central cause, and HINTS is better than early MRI but not perfect. Stroke is the cause to exclude, yet inner-ear causes remain the commonest.',
    think: think.map(n => ({name: n}))};
}
// ---- reading CSF and electrodiagnostic results in the case text
function numAfter(t, rx) { const m = t.match(rx); return m ? parseFloat(m[1].replace(/,/g, '')) : null; }
function caseResults(tx) {
  const t = String(tx || ''), out = {};
  if (/\bcsf\b|lumbar puncture|\blp\b|spinal tap|น้ำไขสันหลัง/i.test(t)) {
    const seg = (t.match(/(?:csf|lumbar puncture|\blp\b|spinal tap|น้ำไขสันหลัง)[\s\S]{0,400}/i) || [t])[0];
    const wbc = numAfter(seg, /(?:wbc|white (?:blood )?cells?|leukocytes?|cell count)\D{0,12}(\d[\d,]*)/i);
    const prot = (() => { const g = seg.match(/protein\D{0,10}(\d+(?:\.\d+)?)\s*(g\/l|mg\/dl|mg%)?/i); if (!g) return null; let v = +g[1]; if ((g[2] || '').toLowerCase() === 'g/l' || (!g[2] && v < 10)) v *= 100; return v; })();
    const ratio = numAfter(seg, /(?:ratio|csf\/(?:serum|blood) glucose)\D{0,8}(0?\.\d+)/i);
    const cg = numAfter(seg, /(?:csf )?(?:glucose|sugar)\D{0,8}(\d+(?:\.\d+)?)/i), sg = numAfter(t, /(?:serum|blood|plasma|capillary) (?:glucose|sugar)\D{0,8}(\d+(?:\.\d+)?)/i);
    const r = ratio != null ? ratio : (cg != null && sg ? cg / sg : null);
    const op = numAfter(seg, /(?:opening pressure|\bop\b)\D{0,8}(\d+(?:\.\d+)?)/i);
    const pmn = /neutrophil|polymorph|\bpmn\b|\bn\s*\d{2,3}\s*%|predominantly neutrophil/i.test(seg), lym = /lymphocyt|mononuclear|\bl\s*\d{2,3}\s*%|predominantly lymph/i.test(seg), eos = /eosinophil/i.test(seg);
    const rbc = numAfter(seg, /(?:rbc|red cells?)\D{0,8}(\d[\d,]*)/i), xan = /xanthochrom/i.test(seg) && !/no xanthochrom|without xanthochrom/i.test(seg);
    const ocb = /(?:positive|present)\D{0,20}oligoclonal|oligoclonal\D{0,20}(?:positive|present)|\bocb\b\D{0,8}(?:positive|\+)/i.test(seg);
    const F = [], think = []; let pattern = '';
    if (wbc != null) F.push(`White cells ${wbc}/µL${wbc > 5 ? ' (raised)' : ' (normal ≤5)'}${pmn ? ', neutrophil-predominant' : lym ? ', lymphocyte-predominant' : ''}${eos ? ', eosinophils present' : ''}`);
    if (prot != null) F.push(`Protein ${Math.round(prot)} mg/dL${prot > 45 ? ' (raised)' : ' (normal 15–45)'}`);
    if (r != null) F.push(`CSF/serum glucose ${r.toFixed(2)}${r < .5 ? ' (low)' : ' (normal ≥0.5–0.6)'}`);
    if (op != null) F.push(`Opening pressure ${op} cm H₂O${op > 25 ? ' (high)' : op < 6 ? ' (low)' : ' (normal 6–25)'}`);
    if (rbc != null || xan) F.push(`Red cells${rbc != null ? ' ' + rbc + '/µL' : ''}${xan ? ', xanthochromia' : ''}`);
    if (ocb) F.push('CSF-specific oligoclonal bands');
    const hiW = wbc != null && wbc > 5, lowG = r != null && r < .5, hiP = prot != null && prot > 45;
    if (eos && hiW) { pattern = 'Eosinophilic meningitis: parasitic (Angiostrongylus, Gnathostoma) (agent)'; think.push('Angiostrongylus cantonensis eosinophilic meningitis (neuroangiostrongyliasis)'); }
    else if (hiW && (pmn || wbc > 1000) && (lowG || wbc > 1000)) { pattern = 'Bacterial pattern: neutrophilic, low glucose, high protein'; think.push('Bacterial meningitis'); }
    else if (hiW && lowG) { pattern = 'Lymphocytic with low glucose: TB, fungal (cryptococcal) or carcinomatous meningitis'; think.push('Tuberculous meningitis (TBM)', 'Cryptococcal meningitis', 'Leptomeningeal metastases'); }
    else if (hiW) { pattern = 'Lymphocytic with normal glucose: viral (aseptic) or autoimmune; also early or partly treated bacterial'; think.push('Viral meningitis', 'Autoimmune encephalitis'); }
    else if (!hiW && hiP && wbc != null) { pattern = 'Albuminocytological dissociation (raised protein, normal cells)'; think.push('Guillain–Barré syndrome (GBS)', 'Chronic inflammatory demyelinating polyneuropathy'); }
    if ((xan || (rbc != null && rbc > 1000)) && !pattern) { pattern = 'Blood in CSF: xanthochromia or red cells that do not clear across tubes suggest subarachnoid haemorrhage rather than a traumatic tap'; think.push('Subarachnoid haemorrhage'); }
    if (op != null && op > 25 && !hiW && !hiP) { pattern = pattern || 'High pressure with normal contents'; think.push('Idiopathic intracranial hypertension (IIH)', 'Cerebral venous thrombosis (CVT)'); }
    if (op != null && op < 6) think.push('Spontaneous intracranial hypotension (SIH)');
    if (ocb) think.push('Multiple sclerosis (MS)');
    if (F.length) out.csf = {findings: F, pattern: pattern || 'No clear pattern from the values given', think: [...new Set(think)].map(n => ({name: n}))};
  }
  if (/\bncs\b|nerve conduction|\bemg\b|electromyog|\bedx\b|repetitive (?:nerve )?stim|\brns\b|\bsfemg\b|single[- ]fib/i.test(t)) {
    const F = []; let pattern = '', loc = ''; const think = [];
    const demy = /conduction block|temporal dispersion|slow\w* (?:conduction|cv|velocit)|(?:prolonged|delayed) (?:distal|motor|f[- ]?wave)|(?:absent|prolonged) f[- ]?waves?|demyelinat/i.test(t);
    const axon = /(?:low|reduced|decreased|small|absent) (?:cmap|snap|amplitude|sensory|motor)|axonal/i.test(t);
    const snapN = /(?:normal|preserved) snaps?|snaps? (?:are |were )?(?:normal|preserved)/i.test(t);
    const snapLow = /(?:low|reduced|absent) snaps?|snaps? (?:are |were )?(?:low|reduced|absent)|(?:low|reduced|absent) sensory/i.test(t);
    const dec = /decrement/i.test(t), inc = /increment|facilitation/i.test(t);
    const fib = /fibrillat|positive sharp|\bpsw\b|denervation/i.test(t);
    const neuro = /(?:large|long[- ]duration|high[- ]amplitude|polyphasic)\w*[^.]*(?:mup|muap|motor unit)|reduced recruitment|neurogenic/i.test(t);
    const myo = /(?:small|short[- ]duration|low[- ]amplitude)\w*[^.]*(?:mup|muap|motor unit)|early recruitment|myopathic/i.test(t);
    const myot = /myotonic discharge|myotonia on emg/i.test(t), fasc = /fascicul/i.test(t), myok = /myokymi/i.test(t), crd = /complex repetitive/i.test(t);
    if (demy) F.push('Demyelinating features (slow velocity, prolonged latencies or F waves, conduction block, temporal dispersion)');
    if (axon) F.push('Axonal features (low amplitudes with relatively preserved velocity)');
    if (snapN) F.push('Normal sensory potentials'); if (snapLow) F.push('Low or absent sensory potentials');
    if (dec) F.push('Decrement on repetitive stimulation'); if (inc) F.push('Increment or facilitation after exercise or fast stimulation');
    if (fib) F.push('Fibrillations or positive sharp waves (active denervation)'); if (neuro) F.push('Large, long, polyphasic motor units with reduced recruitment (neurogenic)');
    if (myo) F.push('Small, short motor units with early recruitment (myopathic)'); if (myot) F.push('Myotonic discharges'); if (fasc) F.push('Fasciculations'); if (myok) F.push('Myokymic discharges'); if (crd) F.push('Complex repetitive discharges (chronic)');
    if (dec && inc) { pattern = 'Low motor amplitude with marked increment (>100%) after exercise: presynaptic junction'; loc = 'NMJ — presynaptic'; think.push('Lambert–Eaton myasthenic syndrome (LEMS)'); }
    else if (dec) { pattern = 'Decrement (>10% at 2–3 Hz): postsynaptic junction'; loc = 'NMJ — postsynaptic'; think.push('Myasthenia gravis (MG)'); }
    else if (inc) { pattern = 'Increment after exercise or fast stimulation: presynaptic junction'; loc = 'NMJ — presynaptic'; think.push('Lambert–Eaton myasthenic syndrome (LEMS)'); }
    else if (myot) { pattern = 'Myotonic discharges: myotonic dystrophy or a muscle channelopathy'; loc = 'Muscle'; think.push('Myotonic dystrophy type 1 (DM1)', 'Myotonia congenita'); }
    else if (myo) { pattern = 'Myopathic motor units' + (fib ? ' with fibrillations: inflammatory or necrotizing myopathy' : ''); loc = 'Muscle'; if (fib) think.push('Idiopathic inflammatory myopathy'); }
    else if (demy) { const cb = /conduction block|temporal dispersion|non-?uniform|patchy/i.test(t); pattern = cb ? 'Acquired demyelinating neuropathy (non-uniform: conduction block or dispersion)' : 'Demyelinating neuropathy (uniform slowing suggests an inherited type)'; loc = 'Nerve — demyelinating'; think.push(...(cb ? ['Guillain–Barré syndrome (GBS)', 'Chronic inflammatory demyelinating polyneuropathy', 'Multifocal motor neuropathy (MMN)'] : ['Charcot–Marie–Tooth (CMT) disease'])); }
    else if (snapN && (fib || neuro || axon)) { pattern = 'Neurogenic changes with normal sensory potentials: a lesion proximal to the dorsal root ganglion (anterior horn cell or root); sensory loss with normal SNAPs also means a preganglionic lesion'; loc = 'Root or anterior horn cell'; think.push('Amyotrophic lateral sclerosis (ALS)'); }
    else if (axon && snapLow) { pattern = 'Axonal sensorimotor pattern: length-dependent polyneuropathy if distal and symmetric, mononeuritis multiplex if patchy'; loc = 'Nerve — axonal'; think.push('Vasculitic neuropathies'); }
    else if (neuro) { pattern = 'Neurogenic motor units: denervation with reinnervation'; loc = 'LMN (anterior horn, root or nerve)'; if (fasc) think.push('Amyotrophic lateral sclerosis (ALS)'); }
    if (fasc && fib && neuro && !think.includes('Amyotrophic lateral sclerosis (ALS)')) think.push('Amyotrophic lateral sclerosis (ALS)');
    if (myok) think.push('Radiation-induced plexopathy');
    if (F.length) out.edx = {findings: F, pattern: pattern || 'No clear pattern from the description', loc, think: [...new Set(think)].map(n => ({name: n}))};
  }
  if (/\beeg\b|electroenceph/i.test(t)) {
    const F = [];
    if (/triphasic/i.test(t)) F.push(['Triphasic waves', 'Metabolic (hepatic, renal) or toxic encephalopathy']);
    if (/\blpds?\b|\bpleds?\b|lateralized periodic/i.test(t)) F.push(['Lateralized periodic discharges', 'Acute focal structural lesion — e.g. herpes simplex encephalitis, stroke']);
    if (/periodic sharp wave|psw?c|periodic complexes/i.test(t)) F.push(['Periodic sharp-wave complexes', 'Creutzfeldt-Jakob disease']);
    if (/extreme delta brush/i.test(t)) F.push(['Extreme delta brush', 'Anti-NMDA receptor encephalitis']);
    if (/burst[- ]suppression/i.test(t)) F.push(['Burst suppression', 'Severe diffuse dysfunction (anoxia, deep anaesthesia)']);
    if (/(?:diffuse|generalized) slowing/i.test(t)) F.push(['Diffuse slowing', 'Diffuse encephalopathy (non-specific)']);
    if (/focal slowing/i.test(t)) F.push(['Focal slowing', 'Focal structural lesion']);
    if (F.length) out.eeg = {findings: F.map(x => x[0]), pattern: F.map(x => x[0] + ': ' + x[1]).join('; '), think: []};
  }
  return Object.keys(out).length ? out : null;
}

// Differential: every item = a disease CATEGORY with numbered member DISEASES (1, 1.1, 1.2 …); symptoms, signs and
// phenomenon pages are dropped as categories or members (curator rule 2026-11-06).
const DDX_NOT_CAT = /^(gait|tremor|dystonia|parkinsonism|ataxia|chorea|ballism|myoclonus|tics?|headache|seizures?|dementia|encephalopathy|neuropathy|myopathy|myelopathy|weakness|numbness|pain|vertigo|dizziness|syncope|nystagmus|corticospinal|corticobulbar|cerebell|spinothalamic|dorsal column|pyramidal|tract)\b/i;
function ddxNormalize(list, kinds) {
  const S = x => String(x == null ? '' : x).trim(), A = x => Array.isArray(x) ? x : [];
  return list.slice(0, 5).map(d => {
    const rank = Math.max(1, Math.min(5, +d.rank || 1));
    let mem = A(d.members).map(m => typeof m === 'string' ? {name: S(m)} : {name: S(m && m.name), why: S(m && m.why), next: S(m && m.next)}).filter(m => m.name).slice(0, 5);
    let cat = S(d.category || d.group || '');
    if (!mem.length && S(d.name)) {   // single disease given: it becomes the only member of its category
      mem = [{name: S(d.name), why: S(d.why), next: S(d.next)}];
    } else if (!cat && S(d.name)) cat = S(d.name);
    mem = mem.map(m => ({...m, e: nameMatch(m.name)})).filter(m => !ddxNotDisease(m) && !DDX_NOT_CAT.test(m.name));
    if (!cat || DDX_NOT_CAT.test(cat) || (resolveFind(cat) && !isDisease(resolveFind(cat)) && resolveFind(cat).cat !== 'neuroscience' && isSignLike(resolveFind(cat)))) {
      const e0 = mem[0] && mem[0].e; cat = e0 && e0.sys && e0.sys[0] ? sysLabel(e0.sys[0]) : (cat && !DDX_NOT_CAT.test(cat) ? cat : 'Other');
    }
    return {rank, kind: kinds[rank] || 'likely', cat, name: cat, e: null, members: mem, why: S(d.why) || (mem.length === 1 ? mem[0].why : ''), next: mem.length === 1 ? S(mem[0].next || d.next) : S(d.next)};
  }).filter(d => d.members.length).sort((a, b) => a.rank - b.rank).reduce((acc, d) => {
    // a disease appears once: the later tier (emergency, rare) loses a member already listed above (v1.7)
    const seen = acc.seen, mem = d.members.filter(m => { const k = m.e ? 'id:' + m.e.id : 'n:' + norm(m.name); if (seen.has(k)) return false; seen.add(k); return true; });
    if (mem.length) acc.out.push(Object.assign(d, {members: mem, why: mem.length === 1 && d.members.length > 1 ? (mem[0].why || d.why) : d.why}));
    return acc;
  }, {seen: new Set(), out: []}).out;
}
// ---- curator 2026-11-19: on the device, diseases that fit the case's time course and age come first (stable re-order)
const CASE_AGE_RX = /(\d{1,3})\s*(?:-|\s)?(?:years?|yrs?)[- ]old|(\d{1,3})\s*(?:y\/o|yo)\b|(?:ชาย|หญิง|ผู้ป่วย(?:ชาย|หญิง)?|อายุ|เด็ก(?:ชาย|หญิง)?)\s*(\d{1,3})\s*(?:ปี|ขวบ)|\b(?:aged?|age)\s*(\d{1,3})\b|(\d{1,3})\s*(?:M|F)\b/i;
function caseAge(tx) { const m = String(tx || '').match(CASE_AGE_RX); const a = m ? +(m[1] || m[2] || m[3] || m[4] || m[5]) : NaN; return a > 0 && a < 120 ? a : null; }
function caseTempoCat(tx) {
  const t = String(tx || '').replace(new RegExp(CASE_AGE_RX.source, 'gi'), ' ');
  if (/episod|attacks?\b|spells?\b|recurrent|comes and goes|เป็นๆ ?หายๆ|เป็นพัก/i.test(t)) return 'episodic';
  const ds = [...t.matchAll(new RegExp(PL_DUR.source, 'gi'))].map(m => durDays(m[1] || m[2])).filter(x => x != null);
  const d = ds.length ? Math.max(...ds) : null;
  if (d != null) return d <= 2 ? 'acute' : d <= 90 ? 'subacute' : 'chronic';
  if (/sudden|abrupt|thunderclap|ทันที|ฉับพลัน/i.test(t)) return 'acute';
  if (/rapidly progressive|over (?:days|weeks)|subacute/i.test(t)) return 'subacute';
  if (/gradual|insidious|over (?:months|years)|chronic|ค่อยๆ/i.test(t)) return 'chronic';
  return '';
}
const AGE_YOUNG = /\b(?:infan\w*|neonat\w*|newborn|childhood|in children|juvenile|adolescen\w*|teenage\w*|congenital|first (?:or second )?decade|second decade|paediatric|pediatric|school[- ]age)\b/i;
const AGE_ADULT = /\b(?:adults?|adulthood|elderly|older (?:adults|people|patients)|late[- ]onset|any age|all ages|middle[- ]aged?|(?:fifth|sixth|seventh|eighth) decade|after (?:age )?(?:30|40|50|60)|over (?:40|50|60|65))\b/i;
const AGE_OLD = /\b(?:elderly|older (?:adults|people|patients)|(?:sixth|seventh|eighth) decade|after (?:age )?(?:50|60)|over (?:50|60|65))\b/i;
function dxAgeClass(e) {   // 'young' when the page speaks only of children or adolescents, 'old' only of older adults; '' otherwise
  const t = [e.formal, (e.feat || []).join(' '), e.tempoNote, e.det && e.det.clinical].filter(Boolean).join(' ');
  if (AGE_YOUNG.test(t) && !AGE_ADULT.test(t)) return 'young';
  if (AGE_OLD.test(t) && !AGE_YOUNG.test(t)) return 'old';
  return '';
}
function caseFitSort(rows, tx) {
  const tc = caseTempoCat(tx), age = caseAge(tx);
  if (!tc && age == null) return rows;
  const miss = e => { let n = 0; const t = e.tempo || [];
    if (tc && t.length && !t.includes(tc) && !(tc === 'subacute' && t.includes('progressive')) && !(tc === 'acute' && t.includes('hyperacute'))) n++;
    const ac = age != null ? dxAgeClass(e) : ''; if ((ac === 'young' && age >= 25) || (ac === 'old' && age < 18)) n++;
    return n; };
  return rows.map((x, i) => [x, miss(x.e), i]).sort((a, b) => a[1] - b[1] || a[2] - b[2]).map(x => x[0]);
}
function caseLocalWorkup(qq, f, tx) {
  const r = search(qq);
  const rows = caseFitSort((r && r.dx || []), tx), best = rows.length ? rows[0].hits || 1 : 1, need = Math.max(2, Math.ceil(best / 2));
  const pick = [], used = new Set();
  for (const x of rows) { if (pick.length >= 3) break; pick.push({rank: pick.length + 1, kind: 'likely', e: x.e, why: `Explains ${x.hits || '?'} of ${f.length} findings`}); used.add(x.e.id); }
  const fv = f.map(variantsFor), hitsOf = e => fv.reduce((n, vs) => n + (vs.some(({v}) => fieldScore(e, v) > 0) ? 1 : 0), 0);
  let em = null, emH = 0;
  for (const nm of DDX_EMERG_LIST) { const e = resolveFind(nm); if (!isDisease(e) || used.has(e.id)) continue; const core = e.nN.split(' ').slice(0, 2).join(' '); if (pick.some(x => x.e._n.includes(' ' + core) || x.e._aj.includes(' ' + core))) continue; const h = hitsOf(e); if (h > emH) { em = e; emH = h; } }
  if (em && emH >= Math.min(2, f.length)) { pick.push({rank: 4, kind: 'emergency', e: em, why: `Time-critical; explains ${emH} of ${f.length} findings`}); used.add(em.id); }
  const sys1 = new Set((rows[0] && rows[0].e.sys) || []);
  const rare = rows.slice(0, 120).find(x => !used.has(x.e.id) && (x.hits || 0) >= need && x.e.cur && !x.e.bk && (x.e.sys || []).some(k => sys1.has(k)) && x.e._d && / (rare|very rare|uncommon) /.test(x.e._d));
  if (rare) pick.push({rank: 5, kind: 'rare', e: rare.e, why: `Rare; explains ${rare.hits} of ${f.length} findings`});
  // objective findings from the words used
  tx = caseEnglish(tx);   // with a translation block, the on-device rules read the English part
  const text = String(tx || qq), objective = [];
  for (const ph of probFromText(text).concat(f)) for (const [rx, cls] of OBJ_RULES) if (rx.test(ph) && !objective.some(o => o.finding === cls)) objective.push({symptom: ph, finding: cls});
  // localization and etiology: weighted vote of the best-matching entries
  const lv = new Map(), sv = new Map();
  rows.slice(0, 25).forEach((x, i) => { const w = (x.hits || 1) / (1 + i / 8); for (const l of x.e.loc || []) lv.set(l, (lv.get(l) || 0) + w); for (const k of x.e.sys || []) if (!['genetic', 'paediatric', 'other'].includes(k)) sv.set(k, (sv.get(k) || 0) + w); });
  const top = [...lv].sort((a, b) => b[1] - a[1]), tot = top.reduce((n, x) => n + x[1], 0) || 1;
  const localization = top.slice(0, 3).filter(x => x[1] / tot > .12).map(x => ({path: LOC_PATH[x[0]] || [x[0]], label: D.meta.loc[x[0]] || x[0], share: Math.round(100 * x[1] / tot)}));
  const etiology = [...sv].sort((a, b) => b[1] - a[1]).slice(0, 3).map(x => ({category: D.meta.sys[x[0]] || x[0]}));
  const probs = probFromText(tx);
  const chief = caseChief(text), unify = caseUnify(objective, chief, text), prior = casePrior(text), headache = caseHeadache(text, chief && chief.kind === 'headache');
  const tempo = caseTempo(text), coma = caseComa(text), dizzy = caseDizzy(text), results = caseResults(text);
  if (tempo) for (const e of tempo.etiology.slice().reverse()) if (!etiology.some(x => x.category === e.category)) etiology.unshift({category: e.category, subcategory: e.detail});
  if (etiology.length > 4) etiology.length = 4;
  if (headache && unify && chief && chief.kind === 'headache' && headache.structure && (!headache.axis || headache.axis === 'extra-axial')) { unify.level = headache.structure; unify.statement = `One man, one lesion: ${headache.structure.toLowerCase()} — ${headache.why}` + (unify.separate && unify.separate.length ? ' ' + unify.statement.split('. ').filter(x => /separate story/.test(x)).join('. ') : ''); unify.type = 'single'; unify.single = true; }
  if (prior) prior.groups[2].items = pick.filter(x => x.kind === 'likely').map(x => ({name: x.e.name, e: x.e, why: x.why}));
  const umn = caseUMNLoc(caseOriginal(text), chief);
  const staff = staffLocal({chief, tempo, unify, localization, etiology, findings: caseFindings(text), pick, terms: f});
  return {q: qq, staff, chief, headache, tempo, coma, dizzy, results, objective, unify, prior, localization, umn, etiology, findings: caseFindings(text), problems: plChiefFirst(plAddVitals(plLocal(tx, probs.length ? probs : f.slice(0, 8)), tx), chief), ask: caseAskNext(tx), ddx: pick.map(x => ({rank: x.rank, kind: x.kind, cat: x.e.sys && x.e.sys[0] ? sysLabel(x.e.sys[0]) : 'Other', name: x.e.sys && x.e.sys[0] ? sysLabel(x.e.sys[0]) : 'Other', e: null, members: [{name: x.e.name, e: x.e, why: x.why}], why: x.why})), ai: false};
}
// ---- Staff formulation: how a senior neurologist closes the case (summary statement, evidence for the site, etiology sieve,
//      for/against table for each disease, tiered plan, missing data, impression). Claude fills it (step 7); staffLocal is the on-device version.
const STAFF_SIEVE = ['Vascular', 'Infectious', 'Inflammatory, autoimmune or demyelinating', 'Neoplastic or paraneoplastic', 'Degenerative', 'Metabolic, toxic or nutritional', 'Genetic or congenital', 'Traumatic or structural', 'Paroxysmal or functional'];
const STAFF_SYS = {vascular: 0, infection: 1, demyelinating: 2, autoimmune: 2, oncology: 3, neurodegenerative: 4, dementia: 4, movement: 4, metabolic: 5, 'toxic-nutritional': 5, genetic: 6, paediatric: 6, trauma: 7, 'spinal-cord': 7, csf: 7, epilepsy: 8, headache: 8, functional: 8, sleep: 8};
function staffNorm(o, ddx) {
  if (!o || typeof o !== 'object') return null;
  const S = x => String(x == null ? '' : x).trim(), A = x => Array.isArray(x) ? x : [], L = x => A(x).map(S).filter(v => v && !/^(none|n\/a|not stated|-)$/i.test(v));
  const members = new Set((ddx || []).flatMap(d => (d.members || []).map(m => norm(m.name))));
  const verdict = v => /unlikely|against|no\b/i.test(v) ? 'unlikely' : /likely|probable|yes/i.test(v) ? 'likely' : 'possible';
  const out = {statement: S(o.statement), impression: S(o.impression), locTest: S(o.loc_test), locAgainst: L(o.loc_against).slice(0, 5), missing: L(o.missing).slice(0, 6),
    evidence: A(o.loc_evidence).map(r => ({finding: S(r && r.finding), to: S(r && r.points_to), weight: /non/i.test(S(r && r.weight)) ? 'non-localizing' : /support/i.test(S(r && r.weight)) ? 'supportive' : 'localizing'})).filter(r => r.finding && r.to).slice(0, 8),
    sieve: A(o.sieve).map(r => ({category: S(r && r.category), verdict: verdict(S(r && r.verdict)), why: S(r && r.why)})).filter(r => r.category).slice(0, 10),
    table: A(o.ddx_table).map(r => ({name: S(r && r.name), e: nameMatch(S(r && r.name)), pro: L(r && r['for']).slice(0, 5), con: L(r && r.against).slice(0, 5), confirm: S(r && r.confirm)})).filter(r => r.name && (!members.size || members.has(norm(r.name)) || (r.e && isDisease(r.e)))).filter(r => !r.e || isDisease(r.e)).slice(0, 8),
    plan: {now: L(o.plan && o.plan.now).slice(0, 5), localize: L(o.plan && o.plan.localize).slice(0, 5), etiology: L(o.plan && o.plan.etiology).slice(0, 5)}};
  return out.statement || out.evidence.length || out.sieve.length || out.table.length ? out : null;
}
function staffLocal(w) {
  const pos = (w.findings && w.findings.pos) || [], neg = (w.findings && w.findings.neg) || [], ch = w.chief || {};
  const when = [ch.onset, ch.duration].filter(x => x && !/not stated/i.test(x)).join(', ');
  const statement = pos.length ? `${when ? when[0].toUpperCase() + when.slice(1) + ': ' : ''}${pos.slice(0, 5).join(', ')}${neg.length ? '; without ' + neg.slice(0, 3).join(', ') : ''}.` : '';
  const likely = new Set((w.tempo && w.tempo.etiology || []).map(e => norm(e.category)));
  const voted = new Set((w.pick || []).filter(x => x.kind === 'likely').map(x => STAFF_SYS[(x.e.sys || [])[0]]).filter(x => x != null));
  const sieve = STAFF_SIEVE.map((c, i) => { const byTempo = [...likely].some(k => norm(c).includes(k.split(' ')[0])), byPage = voted.has(i);
    return {category: c, verdict: byTempo ? 'likely' : byPage && !likely.size ? 'possible' : 'unlikely', why: byTempo ? `The time course (${w.tempo.pattern}) points here.` : byPage ? 'The best-matching pages belong to this group.' : 'Nothing in the time course or the matching pages points here (on-device estimate).'}; });
  const fv = (w.terms && w.terms.length ? w.terms : pos).map(f => ({f, vs: variantsFor(f)}));
  const fitsTempo = x => sieve[STAFF_SYS[(x.e.sys || [])[0]]] && sieve[STAFF_SYS[(x.e.sys || [])[0]]].verdict === 'likely';
  const picks = (w.pick || []).some(fitsTempo) ? (w.pick || []).filter(x => fitsTempo(x) || x.kind === 'emergency') : (w.pick || []);   // the time course outranks word matches
  const table = picks.slice(0, 5).map(x => { const pro = fv.filter(v => v.vs.some(({v: t}) => fieldScore(x.e, t) > 0)).map(v => v.f), con = [];   // on the device only matches are known; what argues against needs Monk
    return {name: x.e.name, e: x.e, pro: pro.slice(0, 5), con: con.slice(0, 4), confirm: (x.e.inv || [])[0] || ''}; });
  const L = (w.localization || [])[0], site = (w.unify && w.unify.level) || (L && (L.label || (L.path || []).join(' › '))) || '';
  const top = picks[0], second = picks[1];
  const impression = top ? `${site ? site + ': ' : ''}most in keeping with ${top.e.name}${second ? ', then ' + second.e.name : ''} (on-device estimate; ask Monk for the reasoned version).` : '';
  const em = (w.pick || []).find(x => x.kind === 'emergency');
  return {statement, impression, locTest: '', locAgainst: [], missing: [], evidence: [], sieve, table,
    plan: {now: em ? [`Exclude ${em.e.name}: ${(em.e.inv || [])[0] || 'urgent assessment'}`] : [], localize: [], etiology: table.map(t => t.confirm).filter(Boolean).slice(0, 3)}};
}
function staffHTML(st, ent) {
  if (!st) return '';
  const li = a => a.map(x => `<li>${esc(x)}</li>`).join('');
  const V = {likely: 'Likely', possible: 'Possible', unlikely: 'Unlikely'};
  return `<div class="staff">
    ${st.statement ? `<p class="staff__sum"><b>Summary statement.</b> ${esc(st.statement)}</p>` : ''}
    ${st.evidence.length ? `<h5>Evidence for the site</h5><table class="stafft"><thead><tr><th>Finding</th><th>Points to</th><th>Weight</th></tr></thead><tbody>${st.evidence.map(r => `<tr><td>${esc(r.finding)}</td><td>${esc(r.to)}</td><td><span class="stw ${r.weight[0]}">${esc(r.weight)}</span></td></tr>`).join('')}</tbody></table>` : ''}
    ${st.locAgainst.length ? `<p class="small"><b>Does not fit the site:</b> ${esc(st.locAgainst.join('; '))}</p>` : ''}
    ${st.locTest ? `<p class="small"><b>What separates the first from the second localization:</b> ${esc(st.locTest)}</p>` : ''}
    ${st.sieve.length ? `<h5>Etiology sieve (every category considered)</h5><ul class="sieve">${st.sieve.map(r => `<li class="${r.verdict}"><span class="sv">${V[r.verdict]}</span><b>${esc(r.category)}</b>${r.why ? ` — ${esc(r.why)}` : ''}</li>`).join('')}</ul>` : ''}
    ${st.table.length ? `<h5>For and against each disease</h5><div class="staffdx">${st.table.map(r => `<div class="staffd"><div class="staffd__n">${ent(r.e, r.name)}</div>${r.pro.length ? `<p><b class="pro">For</b> ${esc(r.pro.join('; '))}</p>` : ''}${r.con.length ? `<p><b class="con">Against</b> ${esc(r.con.join('; '))}</p>` : ''}${r.confirm ? `<p><b>Confirm with</b> ${esc(r.confirm)}</p>` : ''}</div>`).join('')}</div>` : ''}
    ${st.plan.now.length || st.plan.localize.length || st.plan.etiology.length ? `<h5>Plan</h5><ol class="staffplan">${st.plan.now.length ? `<li><b>Now (time-critical):</b> ${esc(st.plan.now.join('; '))}</li>` : ''}${st.plan.localize.length ? `<li><b>Prove the site:</b> ${esc(st.plan.localize.join('; '))}</li>` : ''}${st.plan.etiology.length ? `<li><b>Prove the cause:</b> ${esc(st.plan.etiology.join('; '))}</li>` : ''}</ol>` : ''}
    ${st.missing.length ? `<p class="small"><b>Data still missing that would change the ranking:</b> ${esc(st.missing.join('; '))}</p>` : ''}
    ${st.impression ? `<p class="staff__imp"><b>Impression.</b> ${esc(st.impression)}</p>` : ''}</div>`;
}
function caseRun(findings, ai) {
  if (!findings.length) { state.caseMsg = 'No findings recognised. Add a few symptoms or signs.'; render(); return; }
  actLog('case');
  const qq = findings.join(', ');
  state.caseWork = ai || caseLocalWorkup(qq, findings, state.caseText); state.caseQA = [];
  state.caseWork.q = qq;
  state.caseMsg = ''; $('#q').value = qq; state.q = qq; go('#/q/' + encodeURIComponent(qq));
}
const LOC_TREE = `UMN (always name the tract and its side, e.g. "Left corticospinal tract", "Right corticobulbar tract")
  Brain: supratentorial (cortex: seizure, cortical signs | subcortical white matter, basal ganglia, thalamus, internal capsule) | infratentorial (brainstem: crossed signs, first-order Horner, gaze palsy such as INO, one-and-a-half, WEBINO | cerebellum)
  Spinal cord (key sign: sensory level; give side, tract and level cervical | thoracic | lumbar): extrinsic (compressive: bone pain, spinal tenderness, flaccid upper limbs with spastic lower limbs) | intrinsic (intramedullary: funicular pain)
LMN
  Anterior horn cell: pure UMN signs | pure LMN signs | mixed UMN and LMN
  Root: name the dermatome / myotome
  Plexus: brachial (upper | lower) | lumbosacral (upper | lower)
  Nerve: mononeuropathy | multiple mononeuropathy (axonal | demyelinating) | polyneuropathy (axonal | demyelinating)
  NMJ: presynaptic | postsynaptic
  Muscle: inherited | acquired
Other: meninges | multifocal | functional`;
// ---- model choice: Sonnet by default, Opus only when the user taps "Think harder"; warn when the answer came from Haiku
const AI_MODEL = {std: {model: 'claude-sonnet-5-5', modelTier: 'default'}, deep: {model: 'claude-opus-5-5', modelTier: 'complex', effort: 'high'}};
const AI_READ = {model: 'claude-haiku-5-5', modelTier: 'quick'};
const TIER_NAME = {quick: 'Haiku', default: 'Sonnet', complex: 'Opus'};
function aiOpts(deep, extra) { return Object.assign({}, deep ? AI_MODEL.deep : AI_MODEL.std, extra || {}); }
function modelLabel(r) { const m = r && r.modelApplied && String(r.modelApplied).match(/opus|sonnet|haiku/i); return m ? m[0][0].toUpperCase() + m[0].slice(1).toLowerCase() : TIER_NAME[r && r.modelTierApplied] || ''; }
function noteModel(r) { state.aiLabel = modelLabel(r); }
async function aiJSON(prompt, opts) {
  const r = await AI.fn(prompt, opts), t = String(r && r.text || ''); noteModel(r);
  const tryParse = x => { try { return {v: JSON.parse(x)}; } catch (e) { return null; } };
  let p = tryParse(t);
  if (!p) { const m = t.match(/```(?:json)?\s*([\s\S]*?)```/); p = m && tryParse(m[1]); }
  if (!p) { const a = t.indexOf('{'), b = t.lastIndexOf('}'); p = a >= 0 && b > a && tryParse(t.slice(a, b + 1)); }
  if (!p) throw {code: 'invalid_json', message: 'unreadable answer', text: t};
  return p.v;
}
const HAIKU_WARN = 'Monk answered with Haiku, the smallest model, because your Claude usage is nearly used up or your plan does not include the larger one. It can miss findings and mislocalize more often: check this carefully, or try again later.';
async function caseWorkupAI(qq, f, summary, tx, ctl, deep) {
  const r = search(qq);
  const cands = (r && r.dx || []).slice(0, 40).map(x => x.e.name);
  const tE = caseEnglish(tx), ccands = chiefCands(tE);
  const pages = ccands.map(c => `${c.term}: ${c.pages == null ? 'unknown' : c.pages} page${c.pages === 1 ? '' : 's'}`).join('; ');
  const prompt = `You support a neurologist using a teaching lexicon. Reason like a neurologist presenting a long case, in this order, and reply with JSON only. Write every value in English (translate any Thai).
F. "findings": first list what is present and what is absent, as short English clinical terms: {"positive": ["..."], "negative": ["..."], "background": ["known diseases, previous treatments or procedures"]}. ${SC_RULE} Onset and duration words (sudden, acute onset, gradual, for 2 days, since yesterday) are NOT findings: leave them out of both lists; they belong to the chief complaint.
A. "chief": the CHIEF COMPLAINT is the problem the patient came with: the first symptom of the history, read from the first sentence (in "acute onset right side weakness with global aphasia" it is right side weakness). Exception: when that first symptom has fewer than ${CHIEF_MIN_PAGES} pages in the lexicon (page counts below), it carries too little information to work up from, so take the next symptom that has ${CHIEF_MIN_PAGES} or more pages (in "acute onset hiccup with diplopia", when hiccup has under ${CHIEF_MIN_PAGES} pages, work up diplopia) and list what you passed over in "skipped". The onset and duration of the case belong to the chief complaint. Analyse that symptom alone before anything else: {"complaint": "short name", "skipped": [{"symptom": "...", "pages": 0}], "onset": "...", "duration": "...", "pattern": "UMN | LMN | Mixed UMN + LMN | Not yet decided", "reasoning": "which features of this symptom (distribution, tone, reflexes, wasting, fasciculation, plantar, sensory pattern) make it UMN or LMN; for a non-motor complaint say whether it is central (brain, brainstem, cord) or peripheral (root, plexus, nerve, junction, muscle)", "check": ["the one or two examination points that would settle UMN versus LMN if the history does not"]}.
B. "unify": then apply ONE MAN, ONE LESION: try to explain EVERY symptom with a single lesion and a single disease before considering more. Split symptoms into separate stories ONLY when one is clearly standalone with its own unrelated time course (for example numb limbs for 10 years while headache and blurred vision began yesterday: the old numbness is a separate story). "type" is "single" when one lesion explains everything; "multifocal" only when it truly cannot, and then list each lesion with what it explains and a short discussion of why one site fails and which single disease could still make several lesions (demyelination, vasculitis, emboli, metastases, infection); "diffuse" when a metabolic, toxic or systemic process bathes the brain and gives findings at many levels (always say diffuse, never multifocal, for these). {"type": "single | multifocal | diffuse", "level": "the one site, or 'Multifocal: N lesions', or 'Diffuse (metabolic / toxic / systemic process)'", "statement": "one or two sentences", "lesions": [{"site": "...", "explains": ["symptoms"], "discussion": "one sentence"}], "explains": ["symptoms"], "not_explained": ["symptoms that do not fit; empty if none"], "separate": [{"symptom": "...", "why": "different time course or clearly unrelated"}]}.
H. "headache": ONLY when headache is present, apply size, side and sequence to find the structure. First rule: if a neurological deficit is present, the deficit is the first priority and is localized first. Area: small (about a 10-baht coin, nummular) = paracranial structure (scalp, periosteum, skull, e.g. subgaleal abscess), almost always secondary; sectoral or wedge-shaped = paranasal sinus; hemicranial or holocephalic = decide extra-axial versus intra-axial. Extra-axial = headache came BEFORE the deficit: hemicranial → pachymeninges (dura, periosteum, skull base; cranial nerve palsy); holocephalic → leptomeninges or a midline lesion (with raised-pressure signs: meningeal, venous sinus or CSF-flow/hydrocephalus). Intra-axial = headache and deficit together, or the deficit first: the deficit follows the localization (pyramidal, brainstem signs). Isolated vertex or alternating headache suggests a midline lesion; first-onset occipital pain suggests an infratentorial or cervical cause. Worse sitting or standing and better lying: after a lumbar puncture or spinal anaesthesia think post-dural puncture headache; without them think of two things, spontaneous intracranial hypotension (CSF leak) and a posterior fossa mass. Worse lying or in the morning: raised pressure, look for false localizing signs (bilateral VI palsy, ataxia, hearing change). {"area": "small | sectoral | hemicranial | holocephalic | vertex | not stated", "sequence": "headache first | together | deficit first | no deficit", "axis": "extra-axial | intra-axial | not applicable", "structure": "...", "why": "one sentence", "posture": "positional reasoning or empty", "think_of": ["up to 5 diseases"]}. Otherwise return {}.
T. "tempo": classify the time course and let it drive etiology: hyperacute (seconds to minutes) = vascular, mainly embolic or haemorrhagic (more than thrombotic ischaemia); a deficit maximal ("spectacular") at onset = cardioembolic; stepwise worsening = atherosclerosis; relapsing–remitting (each remission returns to baseline) = demyelinating disease, and if a fever, infection or other illness came first think of a pseudorelapse that settles within 24 hours of treating the trigger (Uhthoff and Pulfrich phenomena support demyelination); fluctuating = channel-related disorders (channelopathy, migraine, seizure, myasthenia gravis); rapidly progressive over days to weeks = decompensated tumour (vasogenic oedema or bleeding; raised-pressure signs or fast psychomotor decline) or infection (immunocompetent: TB, VZV or HSV, syphilis, parasites; immunocompromised: HIV with retroviral syndrome, CMV, toxoplasmosis, cryptococcus); subacute = inflammatory or infective; chronic progressive = degenerative, neoplastic or genetic. {"pattern": "...", "why": "one sentence", "clues": ["..."]}
K. "coma": ONLY when consciousness is reduced (drowsy, confused, stupor, coma). First exclude mimics (locked-in, akinetic mutism, psychogenic unresponsiveness, a focal cognitive deficit such as Wernicke aphasia or neglect). Then decide structural versus metabolic/toxic: preserved pupillary light reflexes despite other brainstem failure = metabolic (except anticholinergic or opioid drugs); lateralized motor signs, unequal or unreactive pupils, sustained gaze deviation or dysconjugate eyes, lost oculocephalic or caloric responses, asymmetric posturing, papilloedema or a brainstem breathing pattern = structural; asterixis, multifocal myoclonus, tremor, fluctuating inattention and systemic clues = metabolic. Image urgently whenever unsure. {"verdict": "Structural | Metabolic / toxic | Psychogenic | Not yet decided", "why": "...", "structural": ["..."], "metabolic": ["..."]}
V. "dizzy": ONLY when the patient complains of dizziness, vertigo or light-headedness (an unsteady gait or ataxia alone is not dizziness: return {}). Step 1 give the real name (vertigo = false sense of motion; dizziness = no false motion; unsteadiness; vestibulovisual). Step 2 the pattern by duration and trigger: acute vestibular syndrome (continuous, days to weeks), episodic positional (seconds to minutes, triggered), episodic spontaneous (minutes to hours), chronic (months to years). Step 3 exclude orthostatic hypotension, hypoglycaemia and low cardiac output first. Step 4 central versus peripheral: peripheral = unidirectional horizontal-torsional nystagmus, never pure vertical, fatigable, positional with latency (~20 s) lasting 10–40 s, corrective saccade on head impulse; central = direction-changing, gaze-evoked or pure vertical/torsional nystagmus, no latency or fatigue, normal head impulse in continuous vertigo, skew, other brainstem or cerebellar signs, cannot stand. A positive Dix-Hallpike does not exclude central causes. {"name": "...", "pattern": "...", "verdict": "Central | Peripheral | Not yet decided", "central": ["..."], "peripheral": ["..."], "think_of": ["exact lexicon names"]}
R. "results": ONLY when CSF, NCS/EMG or EEG results are given, interpret them: CSF (cells, predominance, protein, CSF/serum glucose, opening pressure, red cells, xanthochromia, oligoclonal bands) into a pattern (bacterial; lymphocytic with normal glucose; lymphocytic with low glucose = TB, fungal or carcinomatous; albuminocytological dissociation; subarachnoid blood; high or low pressure); NCS/EMG into axonal versus demyelinating (uniform versus conduction block/dispersion), pre- versus postganglionic (SNAPs), postsynaptic (decrement) versus presynaptic (increment) junction, neurogenic versus myopathic motor units, myotonic discharges; EEG into its usual meaning. {"csf": {"pattern": "...", "think_of": []}, "edx": {"pattern": "...", "localization": "...", "think_of": []}, "eeg": {"pattern": "..."}}
C. "framework": ONLY when the patient has had a procedure, operation or treatment before the current problem, frame the differential in three groups, each with 1 to 3 items {"name": "...", "why": "one sentence"}: {"disease": [original disease now worse or complicated], "treatment": [complication of the treatment or procedure], "new": [a newly arising disease unrelated to the original one]}. Otherwise return {}.
U. "umn": ONLY when the chief complaint is UMN (or central motor), localize the UMN lesion by the user's rules: first Brain or Spinal cord, always with the tract and its side ("Left corticospinal tract", "Right corticobulbar tract" when face or bulbar muscles are involved; a brain lesion above the decussation is contralateral to the weak side, a cord lesion is ipsilateral). Brain → "compartment": "Supratentorial" (cortex: seizure, cortical signs) or "Infratentorial" (crossed signs, first-order Horner syndrome, gaze palsy such as INO, one-and-a-half or WEBINO); when there is no strong sign, "Both hypotheses" and give a sentence for each in "supratentorial" and "infratentorial". Spinal cord (key sign: sensory level) → side, tract, "cord_level" (Cervical | Thoracic | Lumbar) and "cord_type": "Extrinsic" (bone pain, spinal tenderness on percussion, flaccid upper limbs with spastic lower limbs), "Intrinsic" (funicular pain) or "Not yet decided"; when not decided, give "cord_ddx": 5 ranked pairs of DISEASES [{"rank": 1, "extrinsic": "...", "intrinsic": "..."}]. {"level": "Brain | Spinal cord", "side": "left | right | bilateral | not stated", "tracts": ["..."], "compartment": "", "supratentorial": "", "infratentorial": "", "cord_level": "", "cord_type": "", "cord_ddx": [], "why": "one or two sentences naming the deciding signs"}. Otherwise {}.
1. "objective": translate each symptom the patient reports into an objective neurological finding class (for example weakness, numbness/sensory loss, meningeal signs, ataxia, dysarthria, UMN signs, LMN signs). Items: {"symptom": "...", "finding": "..."}. Only symptoms that are PRESENT (findings.positive) are mapped; never map an absent item, and never add a symptom, body part or side that the case does not state.
2. "localization": localize the chief complaint first (UMN branch or LMN branch from step A), then refine to the single site from step B, using this hierarchy and choosing the most specific level the data support:
${LOC_TREE}
Give {"path": ["UMN","Brain","Cortical","Left frontal lobe, corticospinal tract"], "side": "left|right|bilateral|midline|not stated", "reasoning": "one or two sentences naming the findings that place it there", "alternatives": ["second most likely localization as a short path string"]}.
3. "etiology": the likely cause categories, each from big to small: {"category": "Vascular", "subcategory": "Ischaemic", "detail": "Large-artery atherosclerosis or cardioembolism"}. 1 to 4 items, most likely first; start from the onset and duration of the chief complaint (step A), then the tempo pattern from step T and any results from step R.
4. "problems": 3 to 8 clinical problems. Problem 1 is ALWAYS the chief complaint from step A, with the case's onset and duration as its own "onset" and "duration" (they are shown in front of it). Then the other problems, most important first; each also starts from its own onset and duration. Pertinent negatives are not repeated here: they are in findings.negative. Each item is an object built from the history: {"problem": "short name, e.g. Weakness", "onset": "sudden | acute | subacute | gradual | episodic | not stated", "duration": "e.g. 3 days, or not stated", "character": "quality and pattern of the symptom", "site": "left | right | bilateral | diffuse | midline | not stated", "location": "body part or region, e.g. arm and leg, face", "aggravated_by": "provoking factor or empty", "relieved_by": "what makes it better or empty", "includes": ["the symptoms merged into this problem"]}. When several symptoms cluster on the same timeline (similar onset and duration, appeared or worsened together), merge them into ONE problem that names them together (for example "Headache with blurred vision and vomiting") and list them in "includes"; keep a symptom as its own problem when its time course is clearly different. Same onset and same duration = the same timeline: never split such symptoms into separate problems (curator rule: one timeline, one problem). Use only what the text states: never invent or complete a site, side, location, character or associated body part (for example do not write "face, arm and leg" when the case says only "right side weakness"); use "not stated" or "" instead.
5. "ddx": up to 5 items, no duplicates, built from the large heading to the small. Every item starts with a disease CATEGORY (for example "Vascular", "Demyelinating disease", "Inflammatory myopathy", "Infectious", "Neoplastic", "Degenerative disease", "Metabolic or toxic", "Genetic") and then lists the member DISEASES you are thinking of in that category, ranked by fit (for example Vascular → "Cardioembolic stroke", "Large-artery atherosclerosis"; Degenerative disease → "Sporadic Creutzfeldt–Jakob disease (sCJD)", "Alzheimer’s disease (AD)"; Demyelinating disease → "Multiple sclerosis (MS)", "Neuromyelitis optica spectrum disorder (NMOSD)", "MOG antibody-associated disease (MOGAD)"; Inflammatory myopathy → "Dermatomyositis" with anti-TIF1-γ or anti-NXP2, "Immune mediated necrotising myopathy"). Every member is a DISEASE. NEVER put a symptom, sign, phenomenon, syndrome of findings, examination finding, tract or anatomical structure as a category or a member: not "Gait disorder", "Tremor", "Dystonia", "Parkinsonism", "Ataxia", "Chorea", "Headache", "Seizure", "Dementia", "Neuropathy", "Corticospinal tract", "Cerebellum". A named disease such as "Essential tremor" or "Parkinson’s disease (PD)" is allowed. CJD that is not variant CJD belongs to Degenerative disease; variant CJD belongs to Infectious. Every category and member must be able to sit at the localization (step 2) and explain problem 1 and the unified story (step B); if the localization is uncertain, follow the first and then the second localization. Ranks 1 to 3 are the most likely categories in order; rank 4 is the most important EMERGENCY that must not be missed (time-critical, treatable), different from 1-3; rank 5 is a RARE disease that should not be missed. A disease may appear only once in the whole list: ranks 4 and 5 must name diseases that are not already in ranks 1-3 (if the only emergency is already listed above, choose the next time-critical treatable disease). Each: {"rank": 1, "category": "Demyelinating disease", "why": "one sentence linking the category to the findings and the localization", "members": [{"name": "Multiple sclerosis (MS)", "why": "one sentence for this disease", "next": "single most useful next test"}]}. 1 to 5 members per category. Prefer exact names from the candidate list. Leave out a slot if no reasonable candidate exists.
6. "ask": follow-up questions the clinician should ask next to sharpen localization, grouped by presenting symptom. Do not ask about anything the history already states or that is already in findings.positive or findings.negative (absent items are answered too). For example, for numbness ask whether the leg is involved, whether the area follows a dermatome, a single nerve, a plexus or a glove-stocking pattern, and whether there is radiating root pain. Each group: {"topic": "Numbness", "items": [{"q": "question", "why": "what the answer localizes", "options": [{"label": "Dermatome", "text": "The numbness follows a dermatome strip."}]}]}. Give 2 to 6 options per question covering the likely answer patterns; each "text" is a short English sentence that will be added to the case history when tapped, and must itself answer the question; 1 to 6 groups, 2 to 5 items each.
7. "staff": finish as a senior neurologist would at the bedside, using only what the case states. {"statement": "ONE sentence summary statement: tempo, the syndrome in neurological terms, the key positive and the pertinent negative findings; no diagnosis and no patient name", "loc_evidence": [{"finding": "a finding from findings.positive or negative", "points_to": "the tract, structure or level it implicates", "weight": "localizing | supportive | non-localizing"}], "loc_against": ["a finding that the chosen site does not explain well, or leave empty"], "loc_test": "the one bedside sign or test that separates the first localization from the second", "sieve": [{"category": "...", "verdict": "likely | possible | unlikely", "why": "a short argument from the tempo, the site and the findings"}], "ddx_table": [{"name": "exactly a member disease from step 5", "for": ["case findings that support it"], "against": ["case findings or missing features that argue against it"], "confirm": "the test that confirms or refutes it and the expected result"}], "plan": {"now": ["time-critical actions or tests, if any"], "localize": ["tests that prove the site"], "etiology": ["tests that prove the cause"]}, "missing": ["history or examination data not yet given that would change the ranking most"], "impression": "one sentence: the syndrome, the site, the most likely cause and the main alternative"}. In "sieve" go through EVERY one of these categories in this order, each once: Vascular; Infectious; Inflammatory, autoimmune or demyelinating; Neoplastic or paraneoplastic; Degenerative; Metabolic, toxic or nutritional; Genetic or congenital; Traumatic or structural; Paroxysmal (seizure, migraine) or functional. "loc_evidence" has 3 to 8 rows; "ddx_table" has one row for each member disease of the first three differential items. Never add a finding the case does not state.
The differential (step 5) must explain the unified story from step B; mention a separate story only as a separate problem.
Reply with only JSON: {"findings": {}, "chief": {}, "headache": {}, "tempo": {}, "coma": {}, "dizzy": {}, "results": {}, "unify": {}, "framework": {}, "umn": {}, "objective": [], "localization": {}, "etiology": [], "problems": [], "ddx": [], "ask": [], "staff": {}}

Case summary: ${summary || ''}
Findings: ${f.join('; ')}
Lexicon page counts for the symptoms, in the order typed: ${pages || 'none'}
Case text: ${(tx || '').slice(0, 4000)}
Candidates from the lexicon search: ${cands.join('; ')}`;
  const out = await aiJSON(prompt, aiOpts(deep, {signal: ctl.signal}));
  const S = x => String(x == null ? '' : x).trim(), A = x => Array.isArray(x) ? x : [];
  const kinds = {4: 'emergency', 5: 'rare'};
  const ddx = ddxNormalize(A(out && out.ddx), kinds);
  const L = out && out.localization || {};
  const localization = L && A(L.path).length ? [{path: A(L.path).map(S).filter(Boolean), side: S(L.side), reasoning: S(L.reasoning), alternatives: A(L.alternatives).map(S).filter(Boolean)}] : [];
  const aiAsk = A(out && out.ask).map(g => ({topic: S(g.topic), items: A(g.items).map(i => ({q: S(typeof i === 'string' ? i : (i.q || i.question)), why: S(i && i.why), opts: A(i && i.options).map(o => ({label: S(o && (o.label || o.text) || o), text: S(o && (o.text || o.label) || o)})).filter(o => o.label).slice(0, 6)})).filter(i => i.q).slice(0, 5)})).filter(g => g.topic && g.items.length).slice(0, 6);
  const problems = plMergeTimeline(A(out && out.problems).map(plNorm).filter(p => p.problem)).slice(0, 8);
  const C = out && out.chief || {}, U = out && out.unify || {}, chief0 = caseChief(tE);
  const chief = S(C.complaint) ? {complaint: S(C.complaint), raw: S(C.complaint), onset: S(C.onset), duration: S(C.duration), pattern: S(C.pattern) || 'Not yet decided', reasoning: S(C.reasoning), hint: A(C.check).map(S).filter(Boolean).join(' ') || (chief0 && chief0.hint) || '',
    skipped: A(C.skipped).map(x => typeof x === 'string' ? {symptom: S(x), pages: null} : {symptom: S(x && x.symptom), pages: x && x.pages != null && isFinite(+x.pages) ? +x.pages : null}).filter(x => x.symptom)} : chief0;
  const FF = out && out.findings || {}, ff0 = caseFindings(tE), fl = x => A(x).map(v => S(typeof v === 'string' ? v : v && (v.term || v.finding))).filter(Boolean).slice(0, 14);
  const findings = fl(FF.positive).length || fl(FF.negative).length ? {pos: fl(FF.positive), neg: fl(FF.negative), bg: fl(FF.background).length ? fl(FF.background) : ff0.bg} : ff0;
  const objective = A(out && out.objective).map(o => ({symptom: S(o.symptom), finding: S(o.finding)})).filter(o => o.finding).slice(0, 12);
  const utype = /multi/i.test(S(U.type)) ? 'multifocal' : /diffuse/i.test(S(U.type)) ? 'diffuse' : 'single';
  const unify = S(U.level) || S(U.statement) ? {type: utype, single: utype !== 'multifocal', level: S(U.level), statement: S(U.statement), explains: A(U.explains).map(S).filter(Boolean), notExplained: A(U.not_explained).map(S).filter(Boolean),
    lesions: A(U.lesions).map(l => ({site: S(l && l.site), explains: A(l && l.explains).map(S).filter(Boolean), discussion: S(l && l.discussion)})).filter(l => l.site),
    separate: A(U.separate).map(x => typeof x === 'string' ? {symptom: S(x)} : {symptom: S(x.symptom), why: S(x.why)}).filter(x => x.symptom), alt: []} : caseUnify(objective, chief0, tx);
  const FW = out && out.framework || {}, prior0 = casePrior(tx);
  const fwItems = k => A(FW[k]).map(x => typeof x === 'string' ? {name: S(x)} : {name: S(x.name), why: S(x.why)}).filter(x => x.name).map(x => Object.assign(x, {e: nameMatch(x.name)})).slice(0, 3);
  let prior = null;
  if (['disease', 'treatment', 'new'].some(k => A(FW[k]).length) || prior0) { prior = prior0 || casePrior('treated with'); prior.treatment = prior0 ? prior0.treatment : ''; for (const g of prior.groups) g.items = fwItems(g.key); }
  const HH = out && out.headache || {}, hd0 = caseHeadache(tx, chief && /headache|ปวดหัว|ปวดศีรษะ/i.test(chief.complaint || ''));
  const headache = S(HH.structure) || S(HH.area) ? {area: S(HH.area) || 'not stated', sequence: S(HH.sequence), axis: S(HH.axis), structure: S(HH.structure), why: S(HH.why), posture: S(HH.posture), deficitFirst: hd0 ? hd0.deficitFirst : false,
    think: A(HH.think_of).map(S).filter(Boolean).slice(0, 5).map(n => ({name: n, e: nameMatch(n)}))} : aiSaysNone(out && out.headache) ? null : hd0;
  const TT = out && out.tempo || {}, tp0 = caseTempo(tx);
  const tempo = S(TT.pattern) ? {pattern: S(TT.pattern), why: S(TT.why), clues: A(TT.clues).map(S).filter(Boolean), etiology: [], think: []} : tp0;
  const KK = out && out.coma || {}, km0 = caseComa(tx);
  const coma = S(KK.verdict) && !/^(n\/a|none|not applicable)$/i.test(S(KK.verdict)) ? Object.assign({}, km0 || {steps: [], pitfalls: [], think: []}, {verdict: S(KK.verdict), why: S(KK.why), structural: A(KK.structural).map(S).filter(Boolean), metabolic: A(KK.metabolic).map(S).filter(Boolean)}) : km0;
  const VV = out && out.dizzy || {}, dz0 = caseDizzy(tx);
  const dizzy = S(VV.pattern) ? Object.assign({}, dz0 || {first: '', caveats: ''}, {name: S(VV.name) || (dz0 && dz0.name) || '', pattern: S(VV.pattern), verdict: S(VV.verdict), central: A(VV.central).map(S).filter(Boolean), peripheral: A(VV.peripheral).map(S).filter(Boolean), think: A(VV.think_of).map(S).filter(Boolean).slice(0, 5).map(n => ({name: n}))}) : aiSaysNone(out && out.dizzy) ? null : dz0;
  const RR = out && out.results || {}, rs0 = caseResults(tx) || {};
  const rsPart = (k, base) => { const o = RR[k] || {}; if (!S(o.pattern)) return base; return Object.assign({}, base || {findings: []}, {pattern: S(o.pattern), loc: S(o.localization) || (base && base.loc) || '', think: A(o.think_of).map(S).filter(Boolean).slice(0, 5).map(n => ({name: n}))}); };
  const results0 = {csf: rsPart('csf', rs0.csf), edx: rsPart('edx', rs0.edx), eeg: rsPart('eeg', rs0.eeg)};
  const results = Object.values(results0).some(Boolean) ? results0 : null;
  const UM = out && out.umn || {}, umn0 = caseUMNLoc(caseOriginal(tE), chief);
  const umn = S(UM.level) ? {level: S(UM.level), side: S(UM.side) || 'not stated', tracts: A(UM.tracts).map(S).filter(Boolean).slice(0, 4), compartment: S(UM.compartment), why: S(UM.why),
    supraWhy: S(UM.supratentorial), infraWhy: S(UM.infratentorial), cordLevel: S(UM.cord_level), cordType: S(UM.cord_type),
    cordDdx: A(UM.cord_ddx).slice(0, 5).map((r, i) => ({rank: +r.rank || i + 1, extrinsic: S(r.extrinsic), intrinsic: S(r.intrinsic)})).filter(r => r.extrinsic || r.intrinsic)} : umn0;
  const staff = staffNorm(out && out.staff, ddx);
  return {chief, headache, tempo, coma, dizzy, results, unify, prior, objective, umn, staff,
    localization, etiology: A(out && out.etiology).map(e => ({category: S(e.category), subcategory: S(e.subcategory), detail: S(e.detail)})).filter(e => e.category).slice(0, 4),
    findings, problems: plChiefFirst(plAddVitals(problems.length ? problems : plLocal(tx, f.slice(0, 8)), tx), chief), ask: mergeAsk(caseAskNext(tx), aiAsk, tx), ddx, ai: true, deep: !!deep, label: state.aiLabel || '', summary: summary || ''};
}
function caseWorkHTML(r) {
  const w = state.caseWork;
  if (!w || w.q !== r.q) return '';
  const lab = {likely: 'Most likely', emergency: 'Emergency — do not miss', rare: 'Rare — should not miss'};
  const crumb = p => p.map((x, i) => `<span${i === p.length - 1 ? ' class="last"' : ''}>${esc(x)}</span>`).join('<i aria-hidden="true">›</i>');
  const ent = (e, name) => e ? `<a href="${link(e)}">${esc(e.name)}</a>` : `<b>${esc(name)}</b> <span class="small muted">(no page yet)</span>`;
  const sec = (n, t, body) => body ? `<div class="cwsec"><h4><span class="n">${n}</span>${t}</h4>${body}</div>` : '';
  const C = w.chief, U = w.unify;
  const pcls = p => /^Mixed/.test(p) ? 'mix' : /^UMN/.test(p) ? 'umn' : /^LMN/.test(p) ? 'lmn' : 'und';
  const chief = C ? `<div class="cwcc"><p><b>${esc(C.complaint)}</b>${[C.onset, C.duration].filter(x => x && !/not stated/i.test(x)).length ? ` <span class="small muted">${esc([C.onset, C.duration].filter(x => x && !/not stated/i.test(x)).join(', '))}</span>` : ''}</p>
      ${(C.skipped || []).length ? `<p class="small muted cwskip">First symptom: ${C.skipped.map(x => esc(x.symptom) + (x.pages != null ? ` (${x.pages} page${x.pages === 1 ? '' : 's'} in Sanctum)` : '')).join(', ')} — too little information to work up from, so the work-up starts from <b>${esc(C.complaint)}</b>.</p>` : ''}
      ${C.pattern ? `<p><span class="ccpat ${pcls(C.pattern)}">${esc(C.pattern)}</span></p>` : ''}${C.reasoning ? `<p class="small">${esc(C.reasoning)}</p>` : ''}${C.hint ? `<p class="small muted">To decide: ${esc(C.hint)}</p>` : ''}</div>` : '';
  const utl = {single: 'One man, one lesion', multifocal: 'Multifocal', diffuse: 'Diffuse'};
  const uni = U ? `<div class="cwuni ${U.type || (U.single ? 'single' : 'multifocal')}"><p><span class="ccpat ut">${esc(utl[U.type] || (U.single ? utl.single : utl.multifocal))}</span> ${U.level ? `<b>${esc(U.level)}</b>` : ''}</p><p>${esc(U.statement || '')}</p>
      ${U.type === 'multifocal' && (U.lesions || []).length > 1 ? `<ol class="cwles">${U.lesions.map(l => `<li><b>${esc(l.site)}</b>${(l.explains || []).length ? ` <span class="small">— ${l.explains.map(esc).join(', ')}</span>` : ''}${l.discussion ? `<p class="small muted">${esc(l.discussion)}</p>` : ''}</li>`).join('')}</ol>` : ''}
      ${(U.explains || []).length ? `<p class="small">Explains: ${U.explains.map(esc).join(', ')}</p>` : ''}${(U.notExplained || []).length ? `<p class="small">Does not fit yet: ${U.notExplained.map(esc).join(', ')}</p>` : ''}
      ${(U.separate || []).length ? `<p class="small">Separate story (own time course): ${U.separate.map(x => esc(x.symptom) + (x.duration ? ' (' + esc(x.duration) + ')' : '') + (x.why ? ' — ' + esc(x.why) : '')).join('; ')}</p>` : ''}
      ${(U.alt || []).length ? `<p class="small muted">Equally good: ${U.alt.map(esc).join('; ')}</p>` : ''}</div>` : '';
  const P = w.prior;
  const fw = P ? `<div class="cwfw">${P.treatment ? `<p class="small muted">Previous treatment or procedure: ${esc(P.treatment)}</p>` : ''}<ol>${P.groups.map(g => `<li><b>${esc(g.title)}</b>${(g.items || []).length ? `<ul>${g.items.map(x => `<li>${ent(x.e, x.name)}${x.why ? ` <span class="small muted">— ${esc(x.why)}</span>` : ''}</li>`).join('')}</ul>` : ''}${g.hint && !(g.items || []).length ? `<p class="small muted">${esc(g.hint)}</p>` : ''}</li>`).join('')}</ol></div>` : '';
  const obj = (w.objective || []).length ? `<ul class="cwobj">${w.objective.map(o => `<li><span class="muted">${esc(o.symptom)}</span> → <b>${esc(o.finding)}</b></li>`).join('')}</ul>` : '';
  const loc = (w.localization || []).length ? w.localization.map((l, i) => `<div class="cwloc${i ? ' alt' : ''}"><div class="crumbs">${crumb(l.path)}</div>
      ${l.side && !/not stated/i.test(l.side) ? `<span class="small">Side: ${esc(l.side)}</span>` : ''}${l.share ? `<span class="small muted">${l.share}% of matching entries</span>` : ''}
      ${l.reasoning ? `<p>${esc(l.reasoning)}</p>` : ''}${(l.alternatives || []).length ? `<p class="small muted">Also consider: ${l.alternatives.map(esc).join('; ')}</p>` : ''}</div>`).join('') : '';
  const ns = v => !v || /^(not (?:stated|known|given|specified|documented|mentioned)\b.*|unknown|unspecified|n\/a|na|none|nil|-+|–)$/i.test(String(v).trim());
  const UM = w.umn;
  const umnHTML = UM ? `<div class="cwumn"><p><span class="ccpat">UMN</span> <b>${esc(UM.level)}</b>${UM.compartment ? ` · <b>${esc(UM.compartment)}</b>` : ''}${UM.level === 'Spinal cord' && UM.cordLevel && !ns(UM.cordLevel) ? ` · ${esc(UM.cordLevel)} cord` : ''}${UM.cordType ? ` · ${esc(UM.cordType)}` : ''}</p>
      ${(UM.tracts || []).length ? `<p class="small">Tract: <b>${UM.tracts.map(esc).join('; ')}</b>${UM.side && !ns(UM.side) ? ` <span class="muted">(weak side: ${esc(UM.side)})</span>` : ''}</p>` : ''}
      ${UM.why ? `<p class="small">${esc(UM.why)}</p>` : ''}
      ${UM.supraWhy || UM.infraWhy ? `<ul class="small cwhyp">${UM.supraWhy ? `<li><b>Supratentorial:</b> ${esc(UM.supraWhy)}</li>` : ''}${UM.infraWhy ? `<li><b>Infratentorial:</b> ${esc(UM.infraWhy)}</li>` : ''}</ul>` : ''}
      ${(UM.cordDdx || []).length ? `<table class="cwpair"><caption class="small muted">Extrinsic or intrinsic not decided: differential for both${w.ai ? '' : ' (agent draft for expert review)'}</caption><thead><tr><th>#</th><th>Extrinsic (compressive)</th><th>Intrinsic (intramedullary)</th></tr></thead><tbody>${UM.cordDdx.map(r => `<tr><td>${r.rank}</td><td>${r.extrinsic ? ent(nameMatch(r.extrinsic), r.extrinsic) : ''}</td><td>${r.intrinsic ? ent(nameMatch(r.intrinsic), r.intrinsic) : ''}</td></tr>`).join('')}</tbody></table>` : ''}</div>` : '';
  const eti = (w.etiology || []).length ? `<ol class="cweti">${w.etiology.map(e => `<li><div class="crumbs">${crumb([e.category, e.subcategory, e.detail].filter(Boolean))}</div></li>`).join('')}</ol>` : '';
  const plSentence = p => { const bits = [];
    const head0 = (ns(p.onset) ? 'onset not stated' : p.onset.toLowerCase() + ' onset') + ', ' + (ns(p.duration) ? 'duration not stated' : p.duration), head = head0 + ':';
    const nm = (p.character && p.character !== p.problem ? p.character : p.problem).toLowerCase();
    const loc = ns(p.location) ? '' : p.location.split(/\s*,\s*/).filter(x => !nm.includes(x.toLowerCase())).join(', ');
    const where = [loc ? 'of the ' + loc : '', ns(p.site) ? '' : '(' + p.site + ')'].filter(Boolean).join(' ');
    bits.push([head, nm, where].filter(Boolean).join(' '));
    if (!ns(p.aggravated)) bits.push('aggravated by ' + p.aggravated); if (!ns(p.relieved)) bits.push('relieved by ' + p.relieved);
    const t = bits.join(', '); return t.charAt(0).toUpperCase() + t.slice(1); };
  const fld = (k, v) => `<span class="pf${ns(v) ? ' miss' : ''}"><i>${k}</i>${esc(ns(v) ? 'not stated' : v)}</span>`;
  const HDa = w.headache;
  const hdb = HDa ? `<div class="cwhd"><p class="small"><b>Headache: size, side, sequence → structure</b></p>
      ${HDa.deficitFirst ? `<p class="small aiwarn">Headache with a neurological deficit: the deficit is the first priority. Localize the deficit first, then fit the headache to it.</p>` : ''}
      <div class="pfs">${fld('Area', HDa.area)}${fld('Sequence', HDa.sequence)}${fld('Axis', HDa.axis)}</div>
      ${HDa.structure ? `<p><b>${esc(HDa.structure)}</b></p>` : ''}${HDa.why ? `<p class="small">${esc(HDa.why)}</p>` : ''}${HDa.posture ? `<p class="small">${esc(HDa.posture)}</p>` : ''}
      ${(HDa.think || []).length ? `<p class="small">Think of: ${HDa.think.map(x => ent(x.e, x.name)).join('<span class="sep">·</span>')}</p>` : ''}</div>` : '';
  const nm = x => ent(nameMatch(x.name) || x.e, x.name);
  const TP = w.tempo, KM = w.coma, DZ = w.dizzy, RS = w.results;
  const odHead = (o, d) => { const nsv = v => !v || /^(not (?:stated|known|given|specified|documented|mentioned)\b.*|unknown|unspecified|n\/a|na|none|nil|-+|–)$/i.test(String(v).trim()); return [nsv(o) ? '' : (/onset/i.test(o) ? o : o + ' onset'), nsv(d) ? '' : d].filter(Boolean).map(x => x.charAt(0).toUpperCase() + x.slice(1)).join(' · '); };
  const ccTempo = C ? `<p class="small cwcct">Start from the chief complaint: <b>${esc(odHead(C.onset, C.duration) || 'onset and duration not stated')}</b> — ${esc(C.complaint)}</p>` : '';
  const tpb = TP ? `<div class="cwtempo"><p><span class="ccpat tp">Tempo</span> <b>${esc(TP.pattern)}</b></p>${TP.why ? `<p class="small">${esc(TP.why)}</p>` : ''}${(TP.clues || []).length ? `<ul class="small">${TP.clues.map(c => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}</div>` : '';
  const kmb = KM ? `<div class="cwcoma"><p class="small"><b>Reduced consciousness: structural or metabolic?</b>${KM.gcs ? ` <span class="muted">GCS ${esc(KM.gcs)}</span>` : ''}</p>
      <p><b>${esc(KM.verdict)}</b></p>${KM.why ? `<p class="small">${esc(KM.why)}</p>` : ''}
      ${(KM.structural || []).length ? `<p class="small">Structural clues: ${KM.structural.map(esc).join('; ')}</p>` : ''}${(KM.metabolic || []).length ? `<p class="small">Metabolic / toxic clues: ${KM.metabolic.map(esc).join('; ')}</p>` : ''}
      ${(KM.pitfalls || []).length ? `<p class="small aiwarn">${KM.pitfalls.map(esc).join('. ')}.</p>` : ''}
      ${(KM.steps || []).length ? `<details class="small"><summary>Order of examination</summary><ol>${KM.steps.map(x => `<li>${esc(x)}</li>`).join('')}</ol></details>` : ''}</div>` : '';
  const dzb = DZ ? `<div class="cwdz"><p class="small"><b>Dizziness: real name → pattern → central or peripheral</b></p>
      <div class="pfs">${fld('Real name', DZ.name)}${fld('Pattern', DZ.pattern)}</div>
      ${DZ.first ? `<p class="small${DZ.extra ? ' aiwarn' : ''}">${esc(DZ.first)}</p>` : ''}
      <p><b>${esc(DZ.verdict || '')}</b></p>${(DZ.central || []).length ? `<p class="small">Central clues: ${DZ.central.map(esc).join('; ')}</p>` : ''}${(DZ.peripheral || []).length ? `<p class="small">Peripheral clues: ${DZ.peripheral.map(esc).join('; ')}</p>` : ''}
      ${(DZ.think || []).length ? `<p class="small">Think of: ${DZ.think.map(nm).join('<span class="sep">·</span>')}</p>` : ''}${DZ.caveats ? `<p class="small muted">${esc(DZ.caveats)}</p>` : ''}</div>` : '';
  const rsOne = (t, o) => o ? `<div class="cwres1"><p class="small"><b>${t}</b></p>${(o.findings || []).length ? `<ul class="small">${o.findings.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}<p>${esc(o.pattern || '')}</p>${o.loc ? `<p class="small">Localizes to: ${esc(o.loc)}</p>` : ''}${(o.think || []).length ? `<p class="small">Think of: ${o.think.map(nm).join('<span class="sep">·</span>')}</p>` : ''}</div>` : '';
  const rsb = RS ? `<div class="cwres">${rsOne('CSF', RS.csf)}${rsOne('Nerve conduction / EMG', RS.edx)}${rsOne('EEG', RS.eeg)}</div>` : '';
  const FN = w.findings || {pos: [], neg: [], bg: []};
  const pn = `<div class="cwpn"><div class="pn pos"><p class="small"><b>Positive findings</b> <span class="muted">(present)</span></p>${(FN.pos || []).length ? `<ul>${FN.pos.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="small muted">None stated.</p>'}</div>
      <div class="pn neg"><p class="small"><b>Negative findings</b> <span class="muted">(absent)</span></p>${(FN.neg || []).length ? `<ul>${FN.neg.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="small muted">None stated.</p>'}</div>
      ${(FN.bg || []).length ? `<p class="small muted pnbg">Background: ${FN.bg.map(esc).join('; ')}</p>` : ''}</div>`;
  const tempoHead = p => odHead(p.onset, p.duration);
  const prob = pn + `<ol class="cwprob">${(w.problems || []).map(plNorm).map(p => p.vital ? `<li class="vit"><b>${esc(p.problem)}</b> <span class="st auto">vital sign</span><p class="pls">${esc(p.character)}${p.rule ? ' (' + esc(p.rule) + ')' : ''}</p></li>` : `<li${p.chief ? ' class="cc"' : ''}>${p.chief ? '<span class="st auto">Chief complaint</span> ' : ''}<b>${tempoHead(p) ? `<span class="plt">${esc(tempoHead(p))}</span> — ` : ''}${esc(p.problem)}</b>${(p.includes || []).length > 1 ? ` <span class="st auto">one timeline: ${p.includes.length} symptoms</span>` : ''}<p class="pls">${esc(plSentence(p))}</p>
      <div class="pfs">${fld('Onset', p.onset)}${fld('Duration', p.duration)}${fld('Character', p.character && p.character !== p.problem ? p.character : '')}${fld('Site', p.site)}${fld('Location', p.location)}${fld('Aggravated by', p.aggravated)}${fld('Relieved by', p.relieved)}</div></li>`).join('')}</ol>
      <p class="small muted" style="margin:6px 0 0">Fields marked "not stated" are worth asking about.</p>`;
  const ddx = w.ddx.length ? `<ol class="cwddx">${w.ddx.map((d, i) => `<li class="k-${d.kind}"><span class="rk">${i + 1}</span><div><span class="kl">${lab[d.kind]}</span>
      <b class="ddcat">${i + 1}. ${esc(d.cat || d.name)}</b>${d.why && (d.members || []).length > 1 ? `<p>${esc(d.why)}</p>` : ''}
      <ol class="ddmem">${(d.members || []).map((m, j) => `<li><span class="ddn">${i + 1}.${j + 1}</span> ${ent(m.e, m.name)}${(m.why || ((d.members || []).length === 1 ? d.why : '')) ? `<p>${esc(m.why || d.why)}</p>` : ''}${(m.next || ((d.members || []).length === 1 ? d.next : '')) ? `<p class="small muted">Next: ${esc(m.next || d.next)}</p>` : ''}</li>`).join('')}</ol></div></li>`).join('')}</ol>` : '<p class="small muted">No differential could be drafted.</p>';
  const ask = (w.ask || []).length ? `<div class="cwask">${w.ask.map(g => `<div class="askg"><b>${esc(g.topic)}</b><ul>${g.items.map(i => `<li>${esc(i.q)}${i.why ? `<span class="small muted">${esc(i.why)}</span>` : ''}${(i.opts || []).length ? `<div class="askopts">${i.opts.map(o => `<button type="button" class="askopt" aria-pressed="false" data-askadd="${esc(o.text)}" title="${esc(o.text)}">${esc(o.label)}</button>`).join('')}</div>` : ''}</li>`).join('')}</ul></div>`).join('')}<p class="small muted" style="margin:6px 0 0">${w.ai ? 'Suggested by Claude.' : 'Draft question set for expert review.'} Tap one or more answers (tap again to cancel), then add them to the case. Questions already answered are left out.</p><button class="btn primary" id="askupd" data-askgo hidden>Add answers and update work-up</button></div>` : '';
  return `<section class="card casework"><h3>Case work-up <span class="st ${w.ai ? 'auto' : 'draft'}">${w.ai ? 'reasoned by Monk' + (w.label ? ' · ' + esc(w.label) : '') : 'on-device estimate'}</span>${AI.ok ? ` <button class="btn ghost thinkbtn" data-casethink${CASE.busy ? ' disabled' : ''} title="Re-run the work-up with Monk on Opus: slower and uses more of your Claude usage">${CASE.busy ? 'Thinking…' : w.deep ? 'Think harder again (Opus)' : 'Think harder (Opus)'}</button>` : ''}</h3>${CASE.busy ? caseWaitHTML() : ''}
    ${w.ai && w.label === 'Haiku' ? `<p class="aiwarn small">${esc(HAIKU_WARN)}</p>` : ''}${state.aiNote ? `<p class="aiwarn small">${esc(state.aiNote)}</p>` : ''}${CASE.busy && state.caseMsg ? `<p class="small muted">${esc(state.caseMsg)}</p>` : ''}
    ${w.summary ? `<p class="small" style="margin:0 0 8px">${esc(w.summary)}</p>` : ''}
    ${state.caseText ? `<details class="cwcase small"><summary>Case as entered</summary><p>${esc(state.caseText)}</p><a href="#/case">Edit the case</a></details>` : ''}
    ${sec(1, 'Chief complaint → UMN or LMN?', chief + kmb + hdb + dzb)}
    ${sec(2, 'Symptoms → objective findings', obj + rsb)}
    ${sec(3, 'One lesion for everything?', uni)}
    ${sec(4, w.ai ? 'Localization' : 'Localization (from matching entries)', umnHTML + loc)}
    ${sec(5, w.ai ? 'Etiology (broad → specific)' : 'Etiology groups (tempo + matching entries)', ccTempo + tpb + eti)}
    ${sec(6, 'Problem list', prob)}
    ${sec(7, 'Ask next', ask)}
    ${fw ? sec(8, 'After treatment: three ways to explain it', fw) : ''}
    ${sec(fw ? 9 : 8, 'Differential diagnosis', ddx)}
    ${sec(fw ? 10 : 9, 'Staff formulation', staffHTML(w.staff, ent))}
    ${sec(fw ? 11 : 10, 'Any question?', qaBoxHTML())}
    <p class="small muted" style="margin:10px 0 0">For education only — verify against the full clinical picture. ${w.ai ? '' : 'Open Sanctum as a Claude artifact to let Monk reason the localization and differential. '}The full ranked list follows.</p></section>`;
}
// ---- "Any question?" after the differential: why (not) disease X, answered from the case and the lexicon text
function qaFindDx(q) {
  const n = ' ' + norm(q) + ' '; let best = null, bl = 0;
  for (const e of D.dx) {
    const names = [e.nN].concat(String(e.aN || '').split(' | ')).filter(x => x && x.length >= 3);
    for (const a of names) if (a.length > bl && n.includes(' ' + a + ' ')) { best = e; bl = a.length; }
  }
  return best;
}
function qaListHTML() {
  return (state.caseQA || []).map(x => `<div class="qa"><p class="qa-q"><b>Q:</b> ${esc(x.q)}</p><div class="qa-a">${x.e ? `<p class="small muted" style="margin:0 0 4px">About <a href="${link(x.e)}">${esc(x.e.name)}</a></p>` : ''}<p>${esc(x.a).replace(/\n/g, '<br>')}</p><span class="st ${x.ai ? 'auto' : 'draft'}">${x.busy ? (x.deep ? 'Opus is thinking…' : 'thinking…') : x.ai ? 'reasoned by Monk' + (x.label ? ' · ' + esc(x.label) : '') : 'on-device comparison'}</span>${!x.busy && x.ai && x.label === 'Haiku' ? `<p class="aiwarn small">${esc(HAIKU_WARN)}</p>` : ''}</div></div>`).join('');
}
function qaBoxHTML() {
  return `<div class="caseqa"><div id="qalist">${qaListHTML()}</div>
    <label class="sr" for="caseqa">Ask about this case</label>
    <textarea id="caseqa" rows="2" placeholder="e.g. Why not Guillain–Barré syndrome? / Could this be myasthenia gravis? / Why not a stroke?"></textarea>
    <button class="btn primary" data-caseask="std">Ask</button>${AI.ok ? ' <button class="btn" data-caseask="deep" title="Use Monk with Opus: slower and uses more of your Claude usage">Think harder (Opus)</button>' : ''}
    <p class="small muted" style="margin:6px 0 0">${AI.ok ? 'Monk (Sonnet) answers from this case and the lexicon pages. Think harder uses Opus: slower, and uses more of your Claude usage.' : 'Answered on this device by comparing the case with the lexicon page of the disease you name.'}</p></div>`;
}
const QA_STOP = new Set('with without from that this have been were their there which while after before into than then also only more most less some such very other each same both does when where what your about over under between through along across onset'.split(' '));
function qaWords(t) { return norm(t).split(' ').filter(w => w.length > 3 && !QA_STOP.has(w)); }
function qaLocal(q, e, w, tx) {
  if (!e) return 'Name a disease in the question (for example "Why not myasthenia gravis?") and the answer compares its lexicon page with this case.';
  const QA_SYN = [[/droop\w* (eye)?lid|eyelid droop|หนังตาตก/i, 'ptosis'], [/double vision|seeing double|ภาพซ้อน/i, 'diplopia'], [/worse (in|by|towards?) (the )?evening|worse with (use|exertion)|better (after|with) rest|fatigu|ช่วงเย็น/i, 'fatigable fatigue'],
    [/numb|tingl|ชา(?![ยวต])/i, 'sensory sensation numbness'], [/weak|อ่อนแรง/i, 'weakness paresis'], [/slurred|nasal (voice|speech)/i, 'dysarthria bulbar speech'], [/swallow|กลืน/i, 'dysphagia bulbar'],
    [/unsteady|ataxi|เดินเซ/i, 'ataxia gait'], [/headache|ปวดหัว/i, 'headache'], [/fever|ไข้/i, 'fever infection'], [/sudden|ทันที/i, 'sudden acute'], [/both sides|bilateral|symmetric/i, 'bilateral symmetric']];
  const extra = QA_SYN.filter(([rx]) => rx.test(tx)).map(x => x[1]).join(' ') + ' ' + (w.objective || []).map(o => o.finding).join(' ');
  const case_ = ' ' + norm(tx + ' ' + extra + ' ' + (w.problems || []).map(p => typeof p === 'string' ? p : [p.problem, p.character, p.location, p.site, p.onset].join(' ')).join(' ')) + ' ';
  const fit = [], miss = [];
  for (const f of (e.feat || []).slice(0, 8)) { const ws = qaWords(f); if (!ws.length) continue; const hit = ws.filter(x => case_.includes(' ' + x) ).length; (hit / ws.length >= 0.34 ? fit : miss).push(f); }
  const inDdx = (w.ddx || []).find(d => (d.e && d.e.id === e.id) || (d.members || []).some(m => m.e && m.e.id === e.id));
  const caseTempo = /sudden|abrupt|acute|ทันที|ฉับพลัน/i.test(tx) ? 'acute' : /gradual|progressive|months|years|chronic|ค่อยๆ/i.test(tx) ? 'chronic' : /fluctuat|episod|attack|recurrent/i.test(tx) ? 'episodic' : '';
  const t = e.tempo || [], tempoOk = !caseTempo || !t.length || t.includes(caseTempo) || (caseTempo === 'acute' && t.includes('hyperacute')) || (caseTempo === 'chronic' && t.includes('subacute'));
  const L = (w.localization || [])[0], locTxt = L ? norm((L.path || []).join(' ')) : '', eloc = (e.loc || []).map(x => String(x).replace(/-/g, ' '));
  const locOk = !locTxt || !eloc.length || eloc.some(x => locTxt.includes(norm(x).split(' ')[0]));
  const out = [];
  out.push(inDdx ? `${e.name} is on the differential at rank ${inDdx.rank}.` : `${e.name} is not on the differential above.`);
  if (fit.length) out.push('In keeping with this case: ' + fit.join('; ') + '.');
  if (miss.length) out.push('Typical features not found in the history: ' + miss.slice(0, 5).join('; ') + '.');
  if (caseTempo) out.push(tempoOk ? `Tempo fits (case ${caseTempo}; usual ${t.join(', ') || 'not stated'}).` : `Tempo argues against it: the case is ${caseTempo}, while it is usually ${t.join(', ')}.`);
  if (locTxt && eloc.length) out.push(locOk ? `Localization fits (${eloc.join(', ')}).` : `Localization differs: the case points to ${L.path.join(' › ')}, while it usually involves ${eloc.join(', ')}.`);
  if ((e.inv || []).length) out.push('To settle it: ' + e.inv.slice(0, 2).join('; ') + '.');
  return out.join('\n');
}
async function caseAsk(deep) {
  const el = $('#caseqa'), q = (el && el.value || '').trim(), w = state.caseWork;
  if (!q || !w) return;
  const e = qaFindDx(q), tx = state.caseText || w.q || '', item = {q, e, a: '', ai: AI.ok, busy: AI.ok, deep: !!deep, label: ''};
  state.caseQA = (state.caseQA || []).concat([item]); if (el) el.value = '';
  const paint = () => { const L = $('#qalist'); if (L) L.innerHTML = qaListHTML(); };
  if (!AI.ok) { item.a = qaLocal(q, e, w, tx); paint(); return; }
  item.a = 'Thinking…'; paint();
  const page = x => x ? `${x.name}: ${x.formal || ''} Tempo: ${(x.tempo || []).join(', ')} ${x.tempoNote || ''}. Localization: ${(x.loc || []).join(', ')}. Features: ${(x.feat || []).join('; ')}. Investigations: ${(x.inv || []).join('; ')}. ${x.det && x.det.clinical ? 'Clinical: ' + x.det.clinical : ''} ${x.det && x.det.diagnosis ? 'Diagnosis: ' + x.det.diagnosis : ''}` : '';
  const top = (w.ddx || [])[0], topE = top && (top.e || ((top.members || [])[0] || {}).e);
  const prompt = `You are helping a neurologist review a case work-up in a teaching lexicon. Answer the user's question with clinical reasoning.
Rules: answer in English, even when the question is in Thai; use only the case facts given, never invent findings; say what in the case fits, what argues against, and what examination or test would settle it; keep it under 160 words; plain text, no markdown headings.
CASE: ${tx}
WORK-UP SUMMARY: ${w.summary || ''}
CHIEF COMPLAINT: ${w.chief ? w.chief.complaint + ' (' + w.chief.pattern + ')' : ''}
UNIFYING LESION: ${w.unify ? '[' + (w.unify.type || '') + '] ' + (w.unify.level || '') + ' — ' + (w.unify.statement || '') + ((w.unify.separate || []).length ? ' Separate story: ' + w.unify.separate.map(x => x.symptom).join(', ') : '') : ''}
LOCALIZATION: ${(w.localization || []).map(l => (l.path || []).join(' > ') + (l.side ? ' (' + l.side + ')' : '')).join(' | ')}
DIFFERENTIAL: ${(w.ddx || []).map((d, i) => (i + 1) + '. ' + (d.cat || d.name) + ': ' + (d.members || []).map((m, j) => (i + 1) + '.' + (j + 1) + ' ' + (m.e ? m.e.name : m.name)).join(', ') + (d.why ? ' — ' + d.why : '')).join(' | ')}
${e ? 'LEXICON PAGE OF THE DISEASE ASKED ABOUT: ' + page(e) : ''}
${topE && (!e || topE.id !== e.id) ? 'LEXICON PAGE OF THE TOP DIFFERENTIAL: ' + page(topE) : ''}
QUESTION: ${q}`;
  try {
    const r = await AI.fn(prompt, aiOpts(deep, {cache: false, onText: ({text}) => { item.a = text; paint(); }}));
    item.a = (r && r.text) || item.a; item.label = modelLabel(r);
  } catch (err) { item.ai = false; item.a = qaLocal(q, e, w, tx) + (err && err.code === 'rate_limited' ? '\n(Your Claude usage limit was reached, so this is the on-device comparison.)' : err && err.code === 'not_granted' ? '' : '\n(Monk could not answer, so this is the on-device comparison.)'); }
  item.busy = false; paint();
}
// text read from a file or photo stays in its own language; the English translation goes at the end of the box
const TR_HEAD = '--- English translation ---';
function withTranslation(tx, tr) { const base = String(tx || '').split(TR_HEAD)[0].replace(/\s*$/, ''); return base + '\n\n' + TR_HEAD + '\n' + tr; }
function caseEnglish(tx) { const t = String(tx || ''), i = t.indexOf(TR_HEAD); return i >= 0 ? t.slice(i + TR_HEAD.length) : t; }
function caseOriginal(tx) { return String(tx || '').split(TR_HEAD)[0]; }
async function caseGo(deep) {
  deep = deep === true;
  const el = $('#casetx'), tx = el ? el.value : (state.caseText || '');
  state.caseText = tx;
  if (!tx.trim() && !CASE.photos.length) { state.caseMsg = 'Type, dictate or add a file first.'; render(); return; }
  if (!AI.ok) { caseRun(freeFindings(tx)); return; }
  if (deep && state.caseConfirmed && state.caseConfirmed.tx === (state.caseText || tx)) { caseContinue(true, state.caseConfirmed); return; }
  state.caseReview = null;
  CASE.busy = true; CASE.deep = !!deep; state.aiNote = ''; state.caseMsg = (deep ? 'Opus is reading the case…' : 'Monk is reading the case…'); render();
  const ctl = CASE.ctl = new AbortController();
  const vocab = D.signs.map(x => x.name).join('; ').slice(0, 30000);
  const prompt = `You help a neurologist search a lexicon of neurological diseases. Read the case below${CASE.photos.length ? ` and the ${CASE.photos.length} attached image${CASE.photos.length > 1 ? 's' : ''} (clinical notes, charts, results or scans; treat them together as one case)` : ''} (it may be in Thai or English).
Write everything in English (translate Thai), except "quote" and "transcript", which keep the original language.
Pick out the POSITIVE clinical findings that help a differential diagnosis: symptoms, examination signs, tempo (for example "sudden onset", "fluctuating", "progressive"), and key test results. Write each as a short English clinical term of 1 to 4 words ("term"). Name what the case actually says and do not upgrade a complaint into a stronger technical term (for example \"forgetfulness\" or \"memory decline\" for หลงลืม or forgetful, not \"amnesia\"; \"unsteady gait\", not \"ataxia\", unless the examiner wrote ataxia). Prefer the exact wording of a lexicon sign name from the list below when one fits. Leave out names, ID numbers, dates, drug doses, normal results and anything absent. At most 12 findings, in the order they appear in the case.
${SC_RULE} Absent items go in "negatives" (English term plus the quote), never in "findings".
For every finding also give "quote": the exact words copied from the case${CASE.photos.length ? ' (or from the text you read in the images)' : ''} that support it, in the original language, at most 12 words, never reworded; and "onset" and "duration" as short phrases taken from the case, or "" when the case does not say.
Reply with only JSON: {"findings": [{"term": "...", "quote": "...", "onset": "", "duration": ""}], "negatives": [{"term": "...", "quote": "..."}], "summary": "one-line English summary of the case", "transcript": "${CASE.photos.length ? 'the text you read from the images, in order, as plain text in its original language' : ''}", "translation": "an English translation of the whole case (typed text, text files${CASE.photos.length ? ' and the text read from the images' : ''}) when any of it is not in English, otherwise an empty string"}

Lexicon sign names: ${vocab}

Case:
${caseOriginal(tx).trim() || '(see photo)'}`;
  try {
    const out = await aiJSON(prompt, Object.assign({}, AI_READ, {signal: ctl.signal, images: CASE.photos.length ? CASE.photos.map(ph => ph.file) : undefined}));
    if (out && out.transcript && !tx.trim()) state.caseText = String(out.transcript);
    if (out && String(out.translation || '').trim() && /[฀-๿]/.test(state.caseText || tx)) state.caseText = withTranslation(state.caseText || tx, String(out.translation).trim());
    const src = state.caseText || tx, transcript = out && out.transcript ? String(out.transcript) : '';
    const rev = reviewBuild(out && Array.isArray(out.findings) ? out.findings : [], src + '\n' + transcript, !!CASE.photos.length && !(src + transcript).trim());
    if (!rev.items.length && !rev.missed.length) { CASE.busy = false; state.caseMsg = 'Monk found no findings in this text. Try adding symptoms or signs.'; render(); return; }
    rev.summary = out && out.summary || ''; rev.deep = deep; rev.tx = src;
    state.caseReview = rev; CASE.busy = false; state.caseMsg = 'Check what Monk read, then continue.'; render();
  } catch (e) {
    CASE.busy = false;
    const m = {cancelled: '', not_granted: 'Monk was not allowed, so findings were picked out on this device.', sampling_disabled: 'Monk is not available on this account; findings were picked out on this device.',
      rate_limited: 'Monk is busy or your usage limit was reached. Try again later.', image_rejected: 'That photo could not be read. Try a clearer or smaller picture.', images_unavailable: 'Photos cannot be sent here.',
      refused: 'Monk declined this text. Edit it and try again.', invalid_json: 'Monk’s answer could not be read. Try again.'}[e && e.code];
    if (e && (e.code === 'not_granted' || e.code === 'sampling_disabled')) { AI.ok = false; AI.img = false; caseRun(freeFindings(tx)); return; }
    state.caseMsg = m == null ? 'Could not reach Monk. Try again.' : m; render();
  }
}
const RV_NEG = /\b(no|not|denies|denied|without|negative|nil|normal|unremarkable)\b|ไม่|ปฏิเสธ|ปกติ/i;
// a normal examination result ("power full", "plantar flexor") is a negative finding, not text Monk failed to capture (v1.7)
const RV_NORMAL = /\b(?:power|strength|motor|reflex(?:es)?|jerks?|plantars?|sensation|sensory|tone|pupils?|cranial nerves?|fundi|fundus|coordination|cerebellar|meningeal|neck)\b[^.;,\n]{0,20}\b(?:full|intact|normal|flexor|downgoing|equal|reactive|preserved|symmetric(?:al)?|unremarkable|negative|5\/5)\b|\b(?:full|intact|normal)\b[^.;,\n]{0,12}\b(?:power|strength|reflex(?:es)?|sensation|tone|pupils?)\b|ปกติ/i;
function rvNorm(t) { return String(t || '').toLowerCase().replace(/[\s​]+/g, ' ').trim(); }
// Turns Claude's findings into a checklist: each finding is checked against the words it quotes, and clauses of the case that no finding quotes are listed as "not captured"
function reviewBuild(raw, src, fromImageOnly) {
  const body = caseOriginal(src), nsrc = rvNorm(body), items = [];
  for (const x of raw.slice(0, 12)) {
    const o = typeof x === 'string' ? {term: x} : (x || {});
    const t = String(o.term || o.finding || '').trim(); if (!t) continue;
    const quote = String(o.quote || '').trim(), nq = rvNorm(quote);
    const ok = fromImageOnly ? null : !!(nq.length >= 3 && nsrc.includes(nq));
    items.push({t, quote, onset: String(o.onset || '').trim(), duration: String(o.duration || '').trim(), ok, on: ok !== false});
  }
  const quotes = items.filter(i => i.ok).map(i => rvNorm(i.quote)), missed = [], normals = [];
  if (!fromImageOnly) {
    // same present/absent scoping as the work-up: absent items (after without / negative for / no ...) are never "not captured"
    for (const sg of scSegs(body)) {
      if (sg.pol !== 'pos') continue;
      const seg = sg.raw.trim(), ns = rvNorm(seg);
      if (RV_NORMAL.test(seg) && seg.length < 60) { if (!normals.includes(seg)) normals.push(seg); continue; }
      if (seg.length < 8 || !/[A-Za-z\u0e00-\u0e7f]{3}/.test(seg) || RV_NEG.test(seg) || /^\d+[\s-]*(year|yr|y\/o|ปี)/i.test(seg)) continue;
      if (quotes.some(q => q.includes(ns) || ns.includes(q))) continue;
      if (!missed.some(m => m.s === seg)) missed.push({s: seg.slice(0, 90)});
    }
  }
  return {items, missed: missed.slice(0, 8), normals: normals.slice(0, 8)};
}
function reviewHTML() {
  const r = state.caseReview; if (!r) return '';
  const n = r.items.filter(i => i.on).length;
  return `<section class="card casereview" aria-label="Check the findings"><h3>Check what Monk read</h3>
    <p class="small muted" style="margin:0 0 8px">Tap a finding to leave it out or put it back. Findings marked <b>!</b> quote words that are not in your text, so they start switched off.</p>
    <div class="rvlist">${r.items.map((i, k) => `<button class="rvopt${i.on ? ' on' : ''}${i.ok === false ? ' unver' : ''}" data-rvtog="${k}" aria-pressed="${i.on}"><b>${i.ok === false ? '! ' : ''}${esc(i.t)}</b>${i.onset || i.duration ? `<span class="rvm"> · ${esc([i.onset, i.duration].filter(Boolean).join(', '))}</span>` : ''}${i.quote ? `<span class="rvq">“${esc(i.quote)}”</span>` : ''}</button>`).join('') || '<p class="small muted">No findings picked out.</p>'}</div>
    ${r.missed.length ? `<p class="small" style="margin:10px 0 4px"><b>Not captured</b> <span class="muted">(parts of the text no finding quotes — tap to add)</span></p><div class="rvlist">${r.missed.map((m, k) => `<button class="rvopt miss" data-rvmiss="${k}">+ ${esc(m.s)}</button>`).join('')}</div>` : ''}
    ${(r.normals || []).length ? `<p class="small rvnormal" style="margin:10px 0 4px"><b>Normal findings</b> <span class="muted">(kept as negative findings)</span>: ${r.normals.map(esc).join(' · ')}</p>` : ''}
    <div class="rvadd"><label class="sr" for="rvadd">Add a finding</label><input id="rvadd" type="text" placeholder="Add a finding, e.g. neck stiffness" autocomplete="off"><button class="btn" data-rvadd>Add</button></div>
    <div class="caseacts"><button class="btn primary" data-casecont${n ? '' : ' disabled'}>Continue to work-up (${n} finding${n === 1 ? '' : 's'})</button></div></section>`;
}
async function caseContinue(deep, pre) {
  const rv = state.caseReview;
  const conf = pre || (rv && {f: rv.items.filter(i => i.on).map(i => i.t), summary: rv.summary, tx: rv.tx});
  if (!conf || !conf.f.length) { state.caseMsg = 'Switch on at least one finding.'; render(); return; }
  deep = deep === true || (!pre && !!(rv && rv.deep));
  state.caseConfirmed = conf; state.caseReview = null;
  CASE.busy = true; CASE.deep = !!deep; state.aiNote = ''; state.caseMsg = 'Findings: ' + conf.f.join(', ') + '. Monk is localizing and drafting the differential…'; render();
  const ctl = CASE.ctl = new AbortController();
  let work = null;
  try { work = await caseWorkupAI(conf.f.join(', '), conf.f, conf.summary, conf.tx, ctl, deep); } catch (e2) { if (e2 && e2.code === 'cancelled') { CASE.busy = false; state.caseMsg = ''; render(); return; } state.aiNote = e2 && e2.code === 'rate_limited' ? 'Your Claude usage limit was reached, so this work-up is the on-device estimate. Try again later.' : 'Claude could not finish the work-up, so this is the on-device estimate.'; }
  CASE.busy = false;
  caseRun(conf.f, work);
}
async function caseAddFiles(files) {
  const ta = $('#casetx'); if (ta) state.caseText = ta.value;
  const isText = f => /^text\//.test(f.type) || /\.(txt|md|markdown)$/i.test(f.name || '');
  const okImg = f => AI.img && (AI.mt ? AI.mt.includes(f.type) : /^image\//.test(f.type));
  const notes = []; let added = 0, texts = 0;
  for (const f of files) {
    if (isText(f)) {
      try { const t = (await f.text()).trim(); if (t) { state.caseText = (state.caseText ? state.caseText.replace(/\s*$/, '\n\n') : '') + `--- ${f.name} ---\n` + t.slice(0, 20000); texts++; } } catch (e) { notes.push(f.name + ' could not be read'); }
    } else if (okImg(f)) {
      if (CASE.photos.length >= (AI.max || 1)) { notes.push(`${f.name} skipped (limit ${AI.max || 1} images)`); continue; }
      if (AI.maxBytes && f.size > AI.maxBytes) { notes.push(`${f.name} is too large`); continue; }
      CASE.photos.push({file: f, name: f.name || 'image', url: URL.createObjectURL(f)}); added++;
    } else notes.push(`${f.name || 'file'} not supported${/pdf|word|officedocument/.test(f.type) ? ' (save pages as photos or copy the text)' : ''}`);
  }
  state.caseMsg = [added ? `${added} image${added > 1 ? 's' : ''} added` : '', texts ? `${texts} text file${texts > 1 ? 's' : ''} added to the case text` : '', ...notes].filter(Boolean).join('. ') + '.';
  render();
}
function caseMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (CASE.rec) { try { CASE.rec.stop(); } catch (e) {} CASE.rec = null; render(); return; }
  const ta = $('#casetx'); state.caseText = ta ? ta.value : '';
  const lang = ($('#caselang') || {}).value || 'th-TH'; state.caseLang = lang;
  let rec;
  try { rec = new SR(); } catch (e) { state.caseMsg = 'Dictation is not available here. Use the microphone key on your keyboard.'; render(); return; }
  rec.lang = lang; rec.continuous = true; rec.interimResults = true;
  const base = state.caseText ? state.caseText.replace(/\s*$/, ' ') : '';
  rec.onresult = ev => { let t = ''; for (let i = 0; i < ev.results.length; i++) t += ev.results[i][0].transcript; const el = $('#casetx'); state.caseText = base + t; if (el) el.value = state.caseText; };
  rec.onerror = ev => { CASE.rec = null; state.caseMsg = ev.error === 'not-allowed' || ev.error === 'service-not-allowed' ? 'Microphone is blocked here. Use the microphone key on your keyboard instead.' : 'Dictation stopped (' + ev.error + ').'; render(); };
  rec.onend = () => { if (CASE.rec === rec) { CASE.rec = null; render(); } };
  try { rec.start(); CASE.rec = rec; state.caseMsg = 'Listening… speak the history, then press Stop dictation.'; } catch (e) { state.caseMsg = 'Dictation could not start. Use the microphone key on your keyboard.'; }
  render();
}
function search(q, limit = 60) {
  const r = searchCore(q, limit);
  if (/[฀-๿]/.test(q) && !(r && (r.dx.length || r.signs.length))) {
    const fixed = thaiToEn(q);
    if (fixed !== q) { const r2 = searchCore(fixed, limit); if (r2 && (r2.dx.length || r2.signs.length)) { r2.fixedFrom = q; r2.fixed = fixed; return r2; } }
  }
  return r;
}
function searchCore(q, limit = 60) {
  const t0 = performance.now();
  const raw = q.trim();
  if (!raw) return null;
  // a list separated by commas, semicolons or new lines is read as findings and ranked by how many each entry explains;
  // "+" keeps the strict mode (every finding must match)
  if (!raw.includes('+') && /[,;\n]/.test(raw)) { const f = freeFindings(raw); if (f.length >= 2) { const r2 = findingsSearch(raw, f); if (r2) return r2; } }
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
      if (e.cur) total += e.bk ? 1 : 8;   // hand-curated core topics outrank bulk-written pages
      scored.push({e, s: total / tv.length + (full ? 40 : 0), full});
    }
  }
  scored.sort((a, b) => b.s - a.s || a.e.name.length - b.e.name.length);
  let res = scored;
  const anyFull = scored.some(x => x.full);
  if (anyFull) res = scored.filter(x => x.full);
  const signs = res.filter(x => isSignLike(x.e)), dx = res.filter(x => isDisease(x.e)), ns = res.filter(x => x.e.cat === 'neuroscience');
  const out = {q: raw, terms, signs, ns, dx, partial: !anyFull && tv.length > 1, used: [...used].slice(0, 4), ms: performance.now() - t0, combo: isCombo};
  // free text: several words that are not one name → read them as separate findings and rank by how many each entry explains
  if (!isCombo && nq.split(' ').length >= 3 && !/[฀-๿]/.test(raw)) {
    const top = (dx[0] || signs[0] || {}).e;
    const named = top && (top.nN === nq || top._n.includes(' ' + nq + ' ') || top._aj.includes(' ' + nq));
    const f = named ? [] : freeFindings(raw);
    if (f.length >= 2) { const r2 = findingsSearch(raw, f); if (r2) return r2; }
  }
  return out;
}
function findingsSearch(raw, f) {
  const t0 = performance.now();
  const tv = f.map(variantsFor), scored = [];
  for (const e of D.all) {
    let total = 0, hits = 0;
    for (const vs of tv) { let best = 0; for (const {v, w} of vs) { const sc = fieldScore(e, v) * w; if (sc > best) best = sc; } if (best) { hits++; total += best; } }
    if (!hits) continue;
    if (isDisease(e) && hits < Math.min(2, f.length)) continue;
    scored.push({e, s: hits * 60 + total / f.length + (e.cur ? (e.bk ? 1 : 8) : 0), full: hits === f.length, hits});
  }
  scored.sort((a, b) => b.s - a.s || a.e.name.length - b.e.name.length);
  const signs = scored.filter(x => isSignLike(x.e)), dx = scored.filter(x => isDisease(x.e)), ns = scored.filter(x => x.e.cat === 'neuroscience');
  if (!dx.length && !signs.length) return null;
  return {q: raw, terms: f, signs, ns, dx, partial: !dx.some(x => x.full), used: [], ms: performance.now() - t0, combo: true, free: f};
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
const isSignLike = e => !!e && (e.t === 'sign' || !!e.ph);   // curator rule 2026-11-06: tremor, dystonia, headache… are signs, not diseases
const isDisease = e => !!e && e.t === 'dx' && !e.ph && e.cat !== 'neuroscience';
const locLabel = c => (D.meta.loc[c] || c);
const sysLabel = c => (D.meta.sys[c] || c);
function itemHTML(x, terms, sel) {
  const e = x.e || x;
  const kind = isSignLike(e) ? 'sign' : (e.cat || 'disease');
  return `<li><a class="item${sel ? ' sel' : ''}" href="${link(e)}" data-id="${esc(e.id)}"><div class="nm">${stDot(e)}${esc(e.name)} <span class="tag">${esc(kind)}</span>${e.cur ? '<span class="st cur">curated</span>' : ''}</div>
    <div class="sn">${terms ? snippet(e, terms) : esc((e.formal || '').slice(0, 200))}</div>${refLine(e)}</a></li>`;
}
function bookShort(r) { const b = D.meta.books[r.book] || {}; return b.short || b.title || r.book; }
const statpearlsSearch = name => 'https://www.ncbi.nlm.nih.gov/books/?term=' + encodeURIComponent('statpearls[book] ' + name.replace(/\s*\([^)]*\)\s*$/, '').replace(/[’']s\b/g, ''));
const safeUrl = u => /^https:\/\//.test(u || '') ? u : '';
function refText(r) {   // "Book — where" with a clickable link when the reference is a web page
  const t = esc(bookShort(r)) + (r.where ? ' — ' + esc(r.where) : '');
  const u = safeUrl(r.url);
  return u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${t} ↗</a>` : t;
}
const DET_DX = [['patho', 'Pathophysiology'], ['clinical', 'Clinical picture'], ['diagnosis', 'Diagnosis'], ['treatment', 'Treatment'], ['prognosis', 'Prognosis']];
const DET_SIGN = [['mechanism', 'Mechanism'], ['technique', 'Technique'], ['interpretation', 'Interpretation']];
const SRC_LEVEL = {strong: ['reviewed', 'Supported by your files'], partial: ['draft', 'Partly supported — more sources welcome'], none: ['auto', 'Not found in your files — please upload a source']};
function srcHTML(m) {
  if (!m) return '';
  const [cls, lab] = SRC_LEVEL[m.level] || SRC_LEVEL.none;
  const files = (m.files || []).map(f => `<li>${esc(bookShort({book: f.book}))}${f.chapter ? ' — ' + esc(f.chapter) : ''}${f.pdfpages ? ` <span class="faint">(PDF p. ${esc(f.pdfpages)})</span>` : ''}</li>`);
  const web = (m.web || []).map(w => `<li>${refText(w)}</li>`);
  return `<div class="srcbox"><div class="srch"><b>Sources for this summary</b> <span class="st ${cls}">${esc(lab)}</span></div>
    ${files.length || web.length ? `<ul class="list small">${files.join('')}${web.join('')}</ul>` : ''}
    <p class="small muted">Written by Monk in original wording and cross-checked against the sources above (nothing copied). ${m.level === 'none' ? 'None of your uploaded files cover this topic yet — the text relies on general medical knowledge.' : ''}</p></div>`;
}
function detHTML(d, parts, id, m) {
  if (!d) return '';
  return `<h2 class="sec" id="${id}">In depth <span class="st draft">draft</span></h2><div class="depth">
    ${d.thd ? `<div class="thd" lang="th">${esc(d.thd)}</div>` : ''}
    ${parts.filter(([k]) => d[k]).map(([k, l]) => `<h3>${l}</h3><p class="prose">${esc(d[k])}</p>`).join('')}
    ${d.pearls && d.pearls.length ? `<h3>Pearls</h3><ul class="list pearls">${d.pearls.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}${srcHTML(m)}</div>`;
}
// 🟢 / 🟡 data status (build.py: st = g | y)
const ST_LABEL = {g: '🟢 In depth', y: '🟡 Awaiting more data'};
const ST_TIP = {g: 'In-depth page backed by a source in the library', y: 'Waiting for a disease-specific monograph article'};
const stBadge = e => e && e.t === 'dx' && !e.ph && e.st ? `<a class="st ds ${e.st}" href="#/browse/status/${e.st}" title="${ST_TIP[e.st]}">${ST_LABEL[e.st]}</a>` : '';
const stDot = e => e && e.t === 'dx' && !e.ph && e.st ? `<span class="sdot ${e.st}" title="${ST_LABEL[e.st]}">${e.st === 'g' ? '🟢' : '🟡'}</span>` : '';
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
function setRow(label, hint, ctl, cls) {
  return `<div class="setrow${cls ? ' ' + cls : ''}"><div class="setlbl"><b>${label}</b>${hint ? `<span>${hint}</span>` : ''}</div><div class="setctl">${ctl}</div></div>`;
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
const WEEK = 3 * 864e5;   // 'recently added' window: 3 days
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
  return `<h2 class="sec">${fallback ? 'Latest additions' : 'Added in the last 3 days'} <span class="count">${total}</span><a class="seclink" href="#/added">See all with summaries</a></h2>
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
    <p class="muted">${all ? 'Every round of curated content, newest first.' : fallback ? 'Nothing was added in the last 3 days — showing the most recent round.' : 'Diseases added or expanded in the last 3 days, with a one-line scope for each.'}
    <a href="#/added${all ? '' : '/all'}">${all ? 'Show last 3 days' : 'Show all rounds'}</a></p></div>
    ${body || '<p class="empty">No additions recorded yet.</p>'}
    <div class="foot"><div>Content is draft until reviewed by a specialist. For education only — not a diagnostic tool.</div></div></article>`;
}

// ------------------------------------------------------------ flashcards & quiz from illustrative cases
// Leitner boxes per case kept in this browser only: box 1 = see again soon … box 5 = known
const QZ = {mode: LS.get('qzMode', 'cards'), sys: LS.get('qzSys', ''), cur: null, opts: null, done: false, n: 0, ok: 0};
const qzBoxes = () => LS.get('qzBox', {});
const qzDeck = () => D.dx.filter(d => d.cur && d.case && d.case.q && (!QZ.sys || (d.sys || []).includes(QZ.sys)));
function qzPick() {
  const deck = qzDeck(), box = qzBoxes(), now = Date.now();
  if (!deck.length) return null;
  const due = deck.filter(d => !box[d.id] || box[d.id].due <= now);
  const pool = due.length ? due : deck;
  const w = pool.map(d => 6 - ((box[d.id] || {}).b || 0));   // lower boxes come up more often
  let r = Math.random() * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < pool.length; i++) { r -= w[i]; if (r <= 0 && pool[i].id !== (QZ.cur || {}).id) return pool[i]; }
  return pool[0];
}
const bdDeck = () => D.dx.filter(d => d.qx && (!QZ.sys || (d.sys || []).includes(QZ.sys))).flatMap(d => d.qx.map(x => ({d, x})));
function bdPick() {
  const deck = bdDeck(), box = qzBoxes(), now = Date.now();
  if (!deck.length) return null;
  const due = deck.filter(o => !box['q:' + o.x.id] || box['q:' + o.x.id].due <= now), pool = due.length ? due : deck;
  const cand = pool.filter(o => !QZ.cur || o.x.id !== (QZ.cur.x || {}).id);
  return (cand.length ? cand : pool)[Math.floor(Math.random() * (cand.length ? cand : pool).length)];
}
const LET = 'ABCDEF';
function bdHTML(o, picked, done) {
  const x = o.x;
  return `<div class="case bd"><p class="prose">${esc(x.stem)}</p><div class="q">${esc(x.q)}</div>
    <div class="qzopts">${x.opts.map((t, i) => `<button class="qzopt${done ? (i === x.ans ? ' right' : (i === picked ? ' wrong' : '')) : ''}" data-bdpick="${i}"${done ? ' disabled' : ''}><b>${LET[i]}.</b> ${esc(t)}</button>`).join('')}</div>
    ${done ? `<div class="qzans"><div class="qzdx"><span class="muted small">Answer ${LET[x.ans]} · topic</span><a href="${link(o.d)}"><b>${esc(o.d.name)}</b></a></div><p class="a">${esc(x.why)}</p>${x.src ? `<div class="readmore"><span class="reftag">Read</span> ${refText(x.src)}</div>` : ''}</div>
      <div class="qzact"><button class="btn primary" data-qznext>Next question</button></div>` : ''}</div>`;
}
function qzOptions(d) {
  const ids = new Set([d.id]), out = [d];
  const cand = [...(d.ddx || []).map(x => byId.get(x.id)), ...D.dx.filter(x => x.cur && x.id !== d.id && (x.sys || [])[0] === (d.sys || [])[0])].filter(Boolean);
  for (const c of cand) { if (out.length >= 4) break; if (!ids.has(c.id)) { ids.add(c.id); out.push(c); } }
  while (out.length < 4) { const x = D.dx[Math.floor(Math.random() * D.dx.length)]; if (x.cur && !ids.has(x.id)) { ids.add(x.id); out.push(x); } }
  return out.sort(() => Math.random() - 0.5);
}
function qzGrade(id, good) {
  const box = qzBoxes(), b = good ? Math.min(5, ((box[id] || {}).b || 0) + 1) : 1;
  const days = [0, 0, 1, 3, 7, 21][b];
  box[id] = {b, due: Date.now() + days * 864e5 - 6e4}; LS.set('qzBox', box);
  try { srGrade(id, good ? 3 : 1); } catch (e) {}
}
function qzStats() { const box = qzBoxes(), deck = qzDeck(); const seen = deck.filter(d => box[d.id]).length, known = deck.filter(d => (box[d.id] || {}).b >= 4).length; return {total: deck.length, seen, known}; }
function qzCase(c) {
  return `<dl><dt>Patient</dt><dd>${esc(c.who)}</dd><dt>Story</dt><dd>${esc(c.story)}</dd><dt>Examination</dt><dd>${esc(c.exam)}</dd><dt>Tests</dt><dd>${esc(c.tests)}</dd></dl>`;
}
function viewQuiz() {
  const board = QZ.mode === 'board';
  if (!QZ.cur) { QZ.cur = board ? bdPick() : qzPick(); QZ.opts = !board && QZ.cur && qzOptions(QZ.cur); QZ.done = false; QZ.picked = null; }
  const d = QZ.cur, st = board ? (() => { const box = qzBoxes(), deck = bdDeck(); return {total: deck.length, seen: deck.filter(o => box['q:' + o.x.id]).length, known: deck.filter(o => (box['q:' + o.x.id] || {}).b >= 4).length}; })() : qzStats();
  const groups = [...new Set(D.dx.filter(x => x.cur && x.case).map(x => (x.sys || [])[0]).filter(Boolean))].sort((a, b) => sysLabel(a).localeCompare(sysLabel(b)));
  LS.set('trainLast', 'quiz');
  const head = `${trainBar(QZ.mode)}<div class="ehead"><div class="crumb">Train</div><h1>${board ? 'Board-style questions' : QZ.mode === 'mcq' ? 'Case quiz' : 'Flashcards'}</h1>
    <p class="muted">${board ? 'Invented board-style vignettes (single best answer), written for this app.' : 'Invented teaching cases from the curated diseases. ' + (QZ.mode === 'mcq' ? 'Pick the diagnosis.' : 'Think of the diagnosis and the answer to the question, then reveal.')}</p></div>
    <div class="qzbar">
    <label class="qzsel">Group <select id="qzsys"><option value="">All groups (${D.dx.filter(x => x.cur && x.case).length})</option>${groups.map(g => `<option value="${esc(g)}"${QZ.sys === g ? ' selected' : ''}>${esc(sysLabel(g))}</option>`).join('')}</select></label>
    <span class="qzstat">${QZ.mode !== 'cards' && QZ.n ? `Score <b>${QZ.ok}/${QZ.n}</b> · ` : ''}${st.seen}/${st.total} seen · ${st.known} known</span></div>`;
  if (!d) return `<article class="entry quiz">${head}<p class="empty">${board ? 'No board-style questions in this group yet.' : 'No cases in this group yet.'}</p></article>`;
  if (board) return `<article class="entry quiz">${head}${bdHTML(d, QZ.picked, QZ.done)}<div class="foot"><div>Progress is stored only on this device. For education only — not a diagnostic tool.</div></div></article>`;
  const c = d.case;
  const answer = `<div class="qzans"><div class="qzdx"><span class="muted small">Diagnosis</span><a href="${link(d)}"><b>${esc(d.name)}</b></a>${d.th ? `<div class="small" lang="th">${esc(d.th)}</div>` : ''}</div>
    <div class="q">${esc(c.q)}</div><p class="a">${esc(c.a)}</p>${d.read && d.read.length ? `<div class="readmore"><span class="reftag">Read</span> ${d.read.map(refText).join('; ')}</div>` : ''}</div>`;
  let body;
  if (QZ.mode === 'mcq') {
    body = `<div class="case">${qzCase(c)}<div class="q">What is the most likely diagnosis?</div>
      <div class="qzopts">${QZ.opts.map(o => `<button class="qzopt${QZ.done ? (o.id === d.id ? ' right' : (o.id === QZ.picked ? ' wrong' : '')) : ''}" data-qzpick="${esc(o.id)}"${QZ.done ? ' disabled' : ''}>${esc(o.name)}</button>`).join('')}</div>
      ${QZ.done ? answer + `<div class="qzact"><button class="btn primary" data-qznext>Next case</button></div>` : ''}</div>`;
  } else {
    body = `<div class="case">${qzCase(c)}<div class="q">${esc(c.q)}</div>
      ${QZ.done ? answer + `<div class="qzact"><span class="muted small">How did you do?</span><button class="btn" data-qzgrade="0">Again</button><button class="btn primary" data-qzgrade="1">Got it</button></div>`
        : `<div class="qzact"><button class="btn primary" data-qzshow>Show diagnosis &amp; answer</button><button class="btn" data-qznext>Skip</button></div>`}</div>`;
  }
  return `<article class="entry quiz">${head}${body}<div class="foot"><div>Progress is stored only on this device. For education only — not a diagnostic tool.</div></div></article>`;
}
// ------------------------------------------------------------ Train: Rounds (staged ward-round cases), Review (spaced repetition), Neuro-watch
// The learner commits at every step before Monk shows the expert's answer and the reasoning. Progress stays on this device.
const TEMPO_OPTS = [['hyper', 'Hyperacute — seconds to minutes'], ['acute', 'Acute — hours to days'], ['subacute', 'Subacute — days to weeks'], ['chronic', 'Chronic progressive — months to years'], ['relapsing', 'Relapsing–remitting'], ['fluct', 'Fluctuating or episodic']];
const PATTERN_OPTS = [['umn', 'Upper motor neuron (UMN)'], ['lmn', 'Lower motor neuron (anterior horn, root, plexus, nerve, junction, muscle)'], ['both', 'Both UMN and LMN'], ['neither', 'Neither: sensory, cerebellar, cognitive or other']];
const RD_STAGE = {history: 'History', exam: 'Examination', findings: 'Findings', pattern: 'UMN or LMN', loc: 'Localization', tempo: 'Tempo', cat: 'Etiology', ddx: 'Differential', next: 'Next test', done: 'Debrief'};
const YIELD = ['Low yield now', 'Useful', 'High yield'];
const asList = a => Array.isArray(a) ? a : [a];
const wardCases = () => (D.meta && D.meta.ward) || [];
const wardById = id => wardCases().find(c => c.id === id);
function rdStages(c) { return ['history', 'exam', 'findings', c.pattern && 'pattern', 'loc', 'tempo', 'cat', 'ddx', 'next', 'done'].filter(Boolean); }
const rdRuns = () => LS.get('rdRuns', {});
const rdSkill = () => LS.get('rdSkill', {});
function rdNew(c) { return {id: c.id, i: 0, sel: {history: [], exam: [], ddx: []}, ok: {}, sc: {}, note: '', fnote: '', from: ''}; }
function rdCur(c) { let r = LS.get('rdCur', null); if (!r || r.id !== c.id) { r = rdNew(c); LS.set('rdCur', r); } return r; }
function rdSave(r) { LS.set('rdCur', r); }
function rdPickScore(items, chosen, n) {   // share of the best possible yield for the number of picks allowed
  const best = items.map(x => x.y).sort((a, b) => b - a).slice(0, n).reduce((a, b) => a + b, 0) || 1;
  return Math.min(1, chosen.reduce((a, i) => a + items[i].y, 0) / best);
}
function rdDdxScore(c, chosen) {
  const key = new Set(c.ddx.key.flatMap(g => g.items));
  const hits = chosen.filter(n => key.has(n)).length, wrong = chosen.length - hits;
  return Math.max(0, (hits - 0.5 * wrong) / Math.min(c.ddx.pick, key.size));
}
const pct = x => Math.round((x || 0) * 100) + '%';
function rdChart(c, r, stages) {   // what the learner has uncovered so far
  const at = stages.indexOf(stages[r.i]);
  const past = s => stages.indexOf(s) < at || (stages.indexOf(s) === at && r.ok[s] !== undefined);
  const qa = (st, items) => `<ul class="rdqa">${items.map((x, i) => `<li class="${r.sel[st].includes(i) ? 'mine' : ''}"><span class="rdq">${esc(x.q)}</span><span class="rda">${esc(x.a)}</span></li>`).join('')}</ul>`;
  return `<div class="case rdchart"><dl><dt>Setting</dt><dd>${esc(c.setting || '')}</dd><dt>Presenting</dt><dd>${esc(c.cc)}</dd></dl>
    ${past('history') ? `<details class="rdfold"${at <= stages.indexOf('exam') ? ' open' : ''}><summary><h4>History</h4><span class="faint small">${c.history.items.length} answers</span></summary>${qa('history', c.history.items)}</details>` : ''}
    ${past('exam') ? `<details class="rdfold"${at <= stages.indexOf('findings') ? ' open' : ''}><summary><h4>Examination</h4><span class="faint small">${c.exam.items.length} findings</span></summary>${qa('exam', c.exam.items)}</details>` : ''}
    ${past('findings') ? `<h4>Objective findings</h4><div class="rdfind"><div><b>Positive</b><ul>${c.findings.pos.map(t => `<li>${esc(t)}</li>`).join('')}</ul></div><div><b>Negative</b><ul>${c.findings.neg.map(t => `<li>${esc(t)}</li>`).join('')}</ul></div></div>` : ''}</div>`;
}
function rdMonk(html) { return `<div class="rdmonk"><span class="rdmonk-h">Monk’s feedback</span>${html}</div>`; }
function rdPickStage(c, r, st) {
  const blk = c[st], done = r.ok[st] !== undefined, sel = r.sel[st];
  const items = blk.items.map((x, i) => {
    const on = sel.includes(i), cls = done ? (on ? (x.y === 2 ? ' right' : x.y === 0 ? ' wrong' : ' mid') : (x.y === 2 ? ' missed' : '')) : (on ? ' on' : '');
    return `<button class="qzopt rdpick${cls}" data-rdtog="${st}:${i}"${done ? ' disabled' : ''}>${esc(x.q)}${done ? `<span class="rdy y${x.y}">${YIELD[x.y]}${on ? ' · chosen' : x.y === 2 ? ' · missed' : ''}</span><span class="rdwhy">${esc(x.why)}</span>` : ''}</button>`;
  }).join('');
  const head = st === 'history' ? `Which ${blk.pick} questions would you ask first?` : `Which ${blk.pick} parts of the examination matter most now?`;
  return `<div class="rdstage"><div class="q">${head}</div><p class="small muted">Choose up to ${blk.pick}. Pick the questions or manoeuvres whose answers change the localization or the cause.</p>
    <div class="qzopts">${items}</div>
    ${done ? rdMonk(`<p>Your choices earned <b>${pct(r.sc[st])}</b> of the best possible yield.</p><p class="small">The answers to every ${st === 'history' ? 'question' : 'manoeuvre'} are now in the chart above, including those you did not choose.</p>`) + `<div class="qzact"><button class="btn primary" data-rdnext>Continue</button></div>`
      : `<div class="qzact"><span class="small muted">${sel.length} of ${blk.pick} chosen</span><button class="btn primary" data-rdsubmit="${st}"${sel.length ? '' : ' disabled'}>Ask / examine</button></div>`}</div>`;
}
function rdChoice(c, r, st, opts, prompt, why, extra) {   // single-best-answer stage; opts = [[value, label]]
  const done = r.ok[st] !== undefined, acc = asList(c[st].ans).map(String);
  return `<div class="rdstage"><div class="q">${prompt}</div>${extra || ''}
    <div class="qzopts">${opts.map(([v, t]) => `<button class="qzopt${done ? (acc.includes(String(v)) ? ' right' : (String(r.sel[st]) === String(v) ? ' wrong' : '')) : ''}" data-rdpick="${st}:${esc(v)}"${done ? ' disabled' : ''}>${esc(t)}</button>`).join('')}</div>
    ${done ? rdMonk(`<p><b>${r.ok[st] ? 'Right.' : 'Not quite.'}</b> ${esc(why)}</p>`) + `<div class="qzact"><button class="btn primary" data-rdnext>Continue</button></div>` : ''}</div>`;
}
function rdDdxStage(c, r) {
  const done = r.ok.ddx !== undefined, sel = r.sel.ddx, keyN = new Set(c.ddx.key.flatMap(g => g.items));
  const opt = o => {
    const on = sel.includes(o.n), k = keyN.has(o.n), cls = done ? (on ? (k ? ' right' : ' wrong') : (k ? ' missed' : '')) : (on ? ' on' : '');
    return `<button class="qzopt rdpick${cls}" data-rdtog="ddx:${esc(o.n)}"${done ? ' disabled' : ''}>${esc(o.n)}${done && !k ? `<span class="rdwhy">${esc(o.w)}</span>` : ''}</button>`;
  };
  const keyHTML = `<ol class="rdkey">${c.ddx.key.map((g, gi) => `<li><b>${gi + 1}. ${esc(g.cat)}</b><ul>${g.items.map((n, ni) => { const o = c.ddx.options.find(x => x.n === n) || {}; const e = o.id && byId.get(o.id); return `<li><span class="rdnum">${gi + 1}.${ni + 1}</span> ${e ? `<a href="${link(e)}">${esc(n)}</a>` : esc(n)}${sel.includes(n) ? ' <span class="st reviewed">you chose</span>' : ''}</li>`; }).join('')}</ul></li>`).join('')}</ol>`;
  return `<div class="rdstage"><div class="q">Build the differential: choose up to ${c.ddx.pick} diseases</div><p class="small muted">Diseases only, never a symptom or a tract. Monk then shows them grouped as category → disease (1, 1.1, 1.2).</p>
    <div class="qzopts">${c.ddx.options.map(opt).join('')}</div>
    ${done ? rdMonk(`<p>Score <b>${pct(r.sc.ddx)}</b>.</p>${keyHTML}<p class="small">${esc(c.ddx.why)}</p>`) + `<div class="qzact"><button class="btn primary" data-rdnext>Continue</button></div>`
      : `<div class="qzact"><span class="small muted">${sel.length} of ${c.ddx.pick} chosen</span><button class="btn primary" data-rdsubmit="ddx"${sel.length ? '' : ' disabled'}>Commit differential</button></div>`}</div>`;
}
function rdFindStage(c, r) {
  const done = r.ok.findings !== undefined;
  return `<div class="rdstage"><div class="q">Write your positive and negative findings before you look</div><p class="small muted">Objective findings only: no onset or duration, no diagnosis. Optional, but it is the habit that makes the rest work.</p>
    <textarea id="rdfnote" class="rdnote" rows="4" placeholder="Positive: … / Negative: …"${done ? ' disabled' : ''}>${esc(r.fnote)}</textarea>
    ${done ? rdMonk(`<p>The expert list is now in the chart. Compare: did you keep the pertinent negatives, and leave out interpretation?</p>`) + `<div class="qzact"><button class="btn primary" data-rdnext>Continue</button></div>`
      : `<div class="qzact"><button class="btn primary" data-rdsubmit="findings">Show the expert list</button></div>`}</div>`;
}
function rdScore(c, r) {
  const st = rdStages(c).filter(s => s !== 'done' && s !== 'findings');
  const v = st.map(s => r.sc[s] != null ? r.sc[s] : (r.ok[s] ? 1 : 0));
  return v.reduce((a, b) => a + b, 0) / (v.length || 1);
}
function rdFinish(c, r) {
  if (r.fin) return;
  r.fin = Date.now(); const total = rdScore(c, r); r.total = total;
  const runs = rdRuns(), p = runs[c.id] || {n: 0, best: 0};
  runs[c.id] = {n: p.n + 1, best: Math.max(p.best, total), last: total, at: r.fin}; LS.set('rdRuns', runs);
  const sk = rdSkill(), bump = (k, v, ok) => { sk[k] = sk[k] || {}; const s = sk[k][v] || {n: 0, ok: 0}; s.n++; if (ok) s.ok++; sk[k][v] = s; };
  bump('loc', c.tags.loc, r.ok.loc); bump('cat', c.tags.cat, r.ok.cat); bump('tempo', asList(c.tempo.ans)[0], r.ok.tempo);
  LS.set('rdSkill', sk);
  srGrade('w:' + c.id, total >= 0.9 ? 4 : total >= 0.7 ? 3 : total >= 0.5 ? 2 : 1);
  actLog('ward', {score: total});
  rsnWard(c, r);
  rdSave(r);
}
function rdDebrief(c, r) {
  rdFinish(c, r);
  const stages = rdStages(c).filter(s => s !== 'done' && s !== 'findings');
  const pages = (c.pages || []).map(id => byId.get(id)).filter(Boolean);
  const m = SR.get()['w:' + c.id];
  return `<div class="rdstage"><div class="q">Debrief</div>
    <table class="rdtab">${stages.map(s => `<tr><td>${RD_STAGE[s]}</td><td>${r.sc[s] != null ? pct(r.sc[s]) : (r.ok[s] ? '✓' : '✗')}</td></tr>`).join('')}<tr class="tot"><td>Overall</td><td>${pct(r.total)}</td></tr></table>
    ${rdMonk(`<p class="rdchain">${esc(c.monk)}</p>${c.monk_th ? `<p class="small" lang="th">${esc(c.monk_th)}</p>` : ''}`)}
    ${r.note ? `<div class="small"><b>Your localization reasoning:</b> ${esc(r.note)}</div>` : ''}
    <div id="rdai">${AI.ok ? `<button class="btn" data-rdai>Ask Monk (Claude) to critique my reasoning</button>` : ''}</div>
    ${pages.length ? `<h4>Read next</h4><div class="chips">${pages.map(e => `<a class="chip" href="${link(e)}">${esc(e.name)}</a>`).join('')}</div>` : ''}
    <p class="small muted">${m ? `Comes back for review ${m.iv ? `in ${m.iv} day${m.iv > 1 ? 's' : ''}` : 'later today'}.` : ''}</p>
    <div class="qzact">${r.from === 'review' ? `<a class="btn primary" href="#/review">Back to review</a>` : `<button class="btn primary" data-rdgo="${esc(rdNextCase(c.id) || '')}">Next case</button>`}<button class="btn" data-rdredo="${esc(c.id)}">Redo this case</button><a class="btn ghost" href="#/rounds">All cases</a></div></div>`;
}
function rdNextCase(id) { const all = wardCases(), runs = rdRuns(); const i = all.findIndex(c => c.id === id); const after = all.slice(i + 1).concat(all.slice(0, i)); return (after.find(c => !runs[c.id]) || after[0] || {}).id; }
function rdStageHTML(c, r) {
  const stages = rdStages(c), st = stages[r.i];
  if (st === 'history' || st === 'exam') return rdPickStage(c, r, st);
  if (st === 'findings') return rdFindStage(c, r);
  if (st === 'pattern') return rdChoice(c, r, 'pattern', PATTERN_OPTS, 'The main complaint: upper or lower motor neuron, both, or neither?', c.pattern.why);
  if (st === 'loc') return rdChoice(c, r, 'loc', c.loc.options.map((t, i) => [i, t]), 'Where is the lesion? Choose the most specific level the findings support.', c.loc.why,
    `<textarea id="rdnote" class="rdnote" rows="2" placeholder="Optional: your reasoning in one line (which finding put you there?)"${r.ok.loc !== undefined ? ' disabled' : ''}>${esc(r.note)}</textarea>`);
  if (st === 'tempo') return rdChoice(c, r, 'tempo', TEMPO_OPTS, 'What is the tempo of the main problem?', c.tempo.why);
  if (st === 'cat') return rdChoice(c, r, 'cat', c.cat.options.map((t, i) => [i, t]), 'Which etiology category comes first?', c.cat.why);
  if (st === 'ddx') return rdDdxStage(c, r);
  if (st === 'next') return rdChoice(c, r, 'next', c.next.options.map((t, i) => [i, t]), 'What is the most useful next step?', c.next.why);
  return rdDebrief(c, r);
}
function rdPlayer(c) {
  const r = rdCur(c), stages = rdStages(c);
  const dots = stages.map((s, i) => `<span class="rddot${i < r.i ? ' done' : i === r.i ? ' now' : ''}" title="${RD_STAGE[s]}">${RD_STAGE[s]}</span>`).join('');
  return `<article class="entry quiz rounds"><div class="trainwrap">${trainBar('rounds')}
    <div class="ehead"><div class="crumb"><a href="#/rounds">Ward rounds</a> · Level ${c.level} · <span class="st draft">invented case, draft for expert review</span></div><h1>${esc(c.title)}</h1></div>
    <div class="rddots">${dots}</div>
    ${rdChart(c, r, stages)}
    ${rdStageHTML(c, r)}
    <div class="foot"><div>Progress is stored only on this device. For education only — not a diagnostic tool.</div></div></div></article>`;
}
const LOC_TAG = {cortex: 'Cortex', subcortical: 'Subcortical', brainstem: 'Brainstem', cerebellum: 'Cerebellum', cord: 'Spinal cord', root: 'Root / cauda equina', plexus: 'Plexus', nerve: 'Peripheral nerve', polyneuropathy: 'Polyneuropathy', nmj: 'Neuromuscular junction', muscle: 'Muscle', meninges: 'Meninges', 'frontal-subcortical': 'Frontal–subcortical'};
const APPROACH_HTML = `<details class="card rdapproach"><summary><b>The approach</b> — six steps Monk uses in every case</summary>
  <ol class="list">
    <li><b>Chief complaint first</b> with onset and duration; for weakness decide UMN or LMN before anything else.</li>
    <li><b>Objective findings</b>: positive and negative lists, no interpretation; pertinent negatives count.</li>
    <li><b>One man, one lesion</b>: can one site explain everything? If not, think multifocal or diffuse (demyelinating, metastatic, infective, toxic).</li>
    <li><b>Localization</b>: the most specific level the data support — cortex, subcortical, brainstem, cerebellum, cord, root, plexus, nerve, junction, muscle.</li>
    <li><b>Tempo → etiology</b>: hyperacute → vascular (maximal at onset → embolic; stepwise → atherosclerotic); relapsing–remitting → demyelinating; fluctuating → channel, junction, seizure, migraine; subacute → inflammatory or infective; chronic progressive → degenerative, neoplastic or genetic.</li>
    <li><b>Differential</b>: diseases only, category → members (1, 1.1, 1.2), each with the test that separates it. It must match the localization and the problem list.</li>
  </ol>
  <div class="rdgrid"><div><b>Systematic history</b><ul class="list small"><li>Onset, course, worst point, triggers</li><li>Associated symptoms that localize</li><li>Red flags and pertinent negatives</li><li>Background, drugs, toxins, travel, raw food</li><li>Family history: ask, never assume "negative"</li></ul></div>
  <div><b>Systematic examination</b><ul class="list small"><li>Mental status and language</li><li>Cranial nerves (fields, pupils, eye movements, face, bulbar)</li><li>Motor: bulk, tone, power by pattern, reflexes, plantars</li><li>Sensory: modalities and the pattern (level, dermatome, nerve, glove–stocking, crossed)</li><li>Coordination, gait, Romberg</li></ul></div></div></details>`;
function rdList() {
  const all = wardCases(), runs = rdRuns(), sk = rdSkill(), m = SR.get(), now = Date.now();
  const weak = Object.entries(sk.loc || {}).filter(([, s]) => s.n >= 1).map(([k, s]) => [k, s.ok / s.n, s.n]).sort((a, b) => a[1] - b[1]);
  const card = c => { const run = runs[c.id], s = m['w:' + c.id]; const due = s && s.due <= now;
    return `<a class="rdcase" href="#/rounds/${esc(c.id)}"><span class="rdlvl l${c.level}">L${c.level}</span><span class="rdct"><b>${esc(c.title)}</b><small>${esc(LOC_TAG[c.tags.loc] || c.tags.loc)} · ${esc(c.setting || '')}</small></span>
      <span class="rdst">${run ? `<span class="st ${run.best >= 0.8 ? 'reviewed' : 'draft'}">best ${pct(run.best)}</span>` : '<span class="st cur">new</span>'}${due ? ' <span class="st auto">due</span>' : ''}</span></a>`; };
  return `<article class="entry quiz rounds"><div class="trainwrap">${trainBar('rounds')}
    <div class="ehead"><div class="crumb">Train</div><h1>Ward rounds</h1>
    <p class="muted">Staged cases: you ask, examine, localize and build the differential, committing at every step. Monk then shows what an expert chose and why. The aim is your reasoning, not the answer.</p></div>
    ${meqListHTML()}
    ${APPROACH_HTML}
    ${weak.length ? `<section class="card stcard"><h3>Your localization record</h3><div class="chips">${weak.map(([k, v, n]) => `<span class="chip ${v < 0.7 ? 'weak' : ''}">${esc(LOC_TAG[k] || k)} ${pct(v)} <span class="faint">(${n})</span></span>`).join('')}</div><p class="small muted" style="margin:6px 0 0">Areas under 70% are marked; Review brings those cases back sooner.</p></section>` : ''}
    ${[1, 2, 3].map(l => { const list = all.filter(c => c.level === l); return list.length ? `<h2 class="sec">Level ${l} <span class="count">${list.length}</span></h2><div class="rdcases">${list.map(card).join('')}</div>` : ''; }).join('')}
    <div class="foot"><div>Cases are invented for teaching and are drafts for expert review. Progress is stored only on this device.</div></div></div></article>`;
}
function viewRounds(arg) {
  LS.set('trainLast', 'rounds');
  if (arg) { const c = wardById(arg); if (c) return rdPlayer(c); }
  return rdList();
}
async function rdCritique() {
  const r = LS.get('rdCur', null), c = r && wardById(r.id), box = $('#rdai'); if (!c || !box || !AI.ok) return;
  box.innerHTML = '<p class="small muted">Monk is reading your answers…</p>';
  const mine = {history: r.sel.history.map(i => c.history.items[i].q), exam: r.sel.exam.map(i => c.exam.items[i].q), findings_written: r.fnote, pattern: r.sel.pattern, localization: c.loc.options[r.sel.loc], localization_reasoning: r.note, tempo: r.sel.tempo, category: c.cat.options[r.sel.cat], differential: r.sel.ddx, next_test: c.next.options[r.sel.next]};
  const expert = {findings: c.findings, pattern: c.pattern && c.pattern.ans, localization: c.loc.options[asList(c.loc.ans)[0]], localization_why: c.loc.why, tempo: c.tempo.ans, category: asList(c.cat.ans).map(i => c.cat.options[i]), differential: c.ddx.key, next: c.next.options[c.next.ans], chain: c.monk};
  const prompt = `You are Monk, a senior neurologist teaching a junior doctor on ward rounds. The goal is to improve the learner's reasoning, not to give answers they already have.
Case: ${c.cc}
Expert answer key (JSON): ${JSON.stringify(expert)}
Learner's choices (JSON): ${JSON.stringify(mine)}
Give feedback on the learner's THINKING: which choices show good localization habits, where the reasoning slipped (e.g. skipped pertinent negatives, did not test one-lesion, put a symptom in the differential, ignored tempo), and one concrete habit to practise next. Be specific to this case, kind and brief.
Return JSON only: {"strengths": ["…"], "gaps": ["…"], "habit": "…", "th": "one-sentence summary in Thai"}`;
  try {
    const j = await aiJSON(prompt, aiOpts(false));
    box.innerHTML = rdMonk(`${(j.strengths || []).length ? `<p><b>Good habits</b></p><ul class="list small">${j.strengths.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}${(j.gaps || []).length ? `<p><b>Where the reasoning slipped</b></p><ul class="list small">${j.gaps.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}${j.habit ? `<p><b>Practise next:</b> ${esc(j.habit)}</p>` : ''}${j.th ? `<p class="small" lang="th">${esc(j.th)}</p>` : ''}<p class="small muted">Written by Claude${state.aiLabel ? ' (' + esc(state.aiLabel) + ')' : ''}; check it against the case.</p>`);
  } catch (e) { box.innerHTML = `<p class="small muted">Monk could not answer just now (${esc(e.code || e.message || 'error')}). Try again later.</p><button class="btn" data-rdai>Try again</button>`; }
}
function rdAct(d) {   // returns true when handled
  const r = LS.get('rdCur', null), c = r && wardById(r.id);
  if (d.rdredo) { LS.set('rdCur', Object.assign(rdNew(wardById(d.rdredo)), {from: (r && r.from) || ''})); render(); window.scrollTo(0, 0); return true; }
  if (d.rdgo !== undefined) { if (d.rdgo) { LS.set('rdCur', null); go('#/rounds/' + d.rdgo); } else go('#/rounds'); return true; }
  if ('rdai' in d) { rdCritique(); return true; }
  if (!c) return false;
  const stages = rdStages(c), st = stages[r.i];
  if (d.rdtog) {
    const [s, v] = [d.rdtog.slice(0, d.rdtog.indexOf(':')), d.rdtog.slice(d.rdtog.indexOf(':') + 1)];
    if (s !== st || r.ok[s] !== undefined) return true;
    const val = s === 'ddx' ? v : +v, list = r.sel[s], lim = s === 'ddx' ? c.ddx.pick : c[s].pick, k = list.indexOf(val);
    if (k >= 0) list.splice(k, 1); else if (list.length < lim) list.push(val); else { toast(`Choose up to ${lim}`); return true; }
    rdSave(r); render(); return true;
  }
  if (d.rdsubmit) {
    const s = d.rdsubmit; if (s !== st) return true;
    if (s === 'history' || s === 'exam') { r.sc[s] = rdPickScore(c[s].items, r.sel[s], c[s].pick); r.ok[s] = r.sc[s] >= 0.7; }
    else if (s === 'findings') { const t = $('#rdfnote'); r.fnote = t ? t.value : ''; r.ok.findings = true; }
    else if (s === 'ddx') { r.sc.ddx = rdDdxScore(c, r.sel.ddx); r.ok.ddx = r.sc.ddx >= 0.7; }
    rdSave(r); render(); return true;
  }
  if (d.rdpick) {
    const s = d.rdpick.slice(0, d.rdpick.indexOf(':')), v = d.rdpick.slice(d.rdpick.indexOf(':') + 1);
    if (s !== st || r.ok[s] !== undefined) return true;
    if (s === 'loc') { const t = $('#rdnote'); r.note = t ? t.value : ''; }
    r.sel[s] = v; r.ok[s] = asList(c[s].ans).map(String).includes(String(v)); rdSave(r); render(); return true;
  }
  if ('rdnext' in d) { r.i = Math.min(stages.length - 1, r.i + 1); rdSave(r); render(); const el = $('.rdstage'); if (el) el.scrollIntoView({block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'}); return true; }
  return false;
}

// ---- spaced repetition (one scheduler for board questions, case flashcards and ward-round cases)
// grade 1 Again (back in 10 min) · 2 Hard · 3 Good · 4 Easy; interval grows by the item's ease (SM-2 style, 1.3–3.0)
const SR = {get: () => LS.get('srs', {}), set: m => LS.set('srs', m)};
const dayKey = (t = Date.now()) => { const d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
function srNext(s, g, now) {
  s = Object.assign({iv: 0, ef: 2.5, reps: 0, lapses: 0}, s || {});
  if (g === 1) { s.lapses++; s.reps = 0; s.ef = Math.max(1.3, s.ef - 0.2); s.iv = 0; s.due = now + 10 * 6e4; }
  else {
    if (g === 2) { s.iv = s.reps === 0 ? 1 : Math.max(1, Math.round(s.iv * 1.2)); s.ef = Math.max(1.3, s.ef - 0.15); }
    else if (g === 3) s.iv = s.reps === 0 ? 1 : s.reps === 1 ? 3 : Math.round(s.iv * s.ef);
    else { s.iv = s.reps === 0 ? 4 : Math.round(Math.max(1, s.iv) * s.ef * 1.3); s.ef = Math.min(3, s.ef + 0.15); }
    s.iv = Math.min(365, Math.max(1, s.iv)); s.reps++;
    const fuzz = s.iv >= 4 ? Math.round(s.iv * 0.05 * (Math.random() * 2 - 1)) : 0;
    s.due = now + (s.iv + fuzz) * 864e5 - 36e5;
  }
  s.last = now; s.g = g; return s;
}
function srPreview(key, g) { const s = srNext(Object.assign({}, SR.get()[key]), g, Date.now()); return g === 1 ? '10 min' : s.iv + ' d'; }
function srGrade(key, g) {
  const m = SR.get(), isNew = !m[key]; m[key] = srNext(m[key], g, Date.now()); SR.set(m);
  const day = LS.get('srDay', {}), today = dayKey();
  if (day.d !== today) { day.d = today; day.n = 0; day.rev = 0; }
  if (isNew) day.n++; day.rev++; LS.set('srDay', day);
  if (!String(key).startsWith('w:')) actLog('review', {good: g >= 3});
  const sk = LS.get('srStreak', {n: 0, d: ''});
  if (sk.d !== today) { const y = dayKey(Date.now() - 864e5); sk.n = sk.d === y ? sk.n + 1 : 1; sk.d = today; LS.set('srStreak', sk); }
}
function srDecks() {
  const out = [];
  for (const c of wardCases()) out.push({key: 'w:' + c.id, kind: 'ward', c});
  { const m = SR.get(); for (const c of meqCases()) if (m['m:' + c.id]) out.push({key: 'm:' + c.id, kind: 'meq', c}); }   // MEQ cases enter review only after a first attempt
  for (const d of D.dx) { if (d.qx) for (const x of d.qx) out.push({key: 'q:' + x.id, kind: 'board', d, x}); if (d.cur && d.case && d.case.q) out.push({key: d.id, kind: 'card', d}); }
  return out;
}
function srMigrate() {   // one time: carry Leitner boxes from the old Quiz into the new scheduler
  if (LS.get('srMig', 0)) return; const box = LS.get('qzBox', {}), m = SR.get();
  for (const [k, v] of Object.entries(box)) if (!m[k] && v && v.b) m[k] = {iv: [0, 0, 1, 3, 7, 21][v.b] || 0, ef: 2.5, reps: v.b, lapses: 0, due: v.due || Date.now()};
  SR.set(m); LS.set('srMig', 1);
}
const srNewCap = () => LS.get('srNew', 10);
function srQueue() {
  srMigrate();
  const m = SR.get(), now = Date.now(), all = srDecks(), day = LS.get('srDay', {}), today = dayKey();
  const doneNew = day.d === today ? day.n || 0 : 0;
  const due = all.filter(o => m[o.key] && m[o.key].due <= now).sort((a, b) => (now - m[b.key].due) / Math.max(1, m[b.key].iv) - (now - m[a.key].due) / Math.max(1, m[a.key].iv));
  const read = new Set(state.hist), sk = rdSkill().loc || {};
  const weakLoc = new Set(Object.entries(sk).filter(([, s]) => s.n && s.ok / s.n < 0.7).map(([k]) => k));
  const cap = Math.max(0, srNewCap() - doneNew), wardToday = Object.entries(m).filter(([k, v]) => k.startsWith('w:') && v.reps === 1 && dayKey(v.last) === today).length;
  const rank = list => list.map(o => ({o, w: (o.kind === 'ward' ? (weakLoc.has(o.c.tags.loc) ? 2 : 0) - o.c.level * 0.5 : 0) + (o.d && read.has(o.d.id) ? 4 : 0) + (o.kind === 'board' ? 1 : 0) + Math.random()})).sort((a, b) => b.w - a.w).map(x => x.o);
  const newWard = rank(all.filter(o => o.kind === 'ward' && !m[o.key])).slice(0, Math.max(0, Math.min(2, cap) - wardToday));   // whole cases are long: at most 2 new a day
  const newOther = rank(all.filter(o => o.kind !== 'ward' && !m[o.key])).slice(0, cap - newWard.length);
  const fresh = newOther.slice(); newWard.forEach((o, k) => fresh.splice(Math.min(fresh.length, 3 + k * 4), 0, o));
  const q = [], nd = due.length, nf = fresh.length;   // interleave new items among reviews
  let i = 0, j = 0; while (i < nd || j < nf) { if (i < nd) q.push(due[i++]); if (i < nd && j < nf && q.length % 4 === 3) q.push(fresh[j++]); else if (i >= nd && j < nf) q.push(fresh[j++]); }
  return q.slice(0, 120);
}
function srForecast() { const m = SR.get(), now = Date.now(); return [1, 2, 3, 4, 5, 6, 7].map(k => Object.values(m).filter(s => s.due > now + (k - 1) * 864e5 && s.due <= now + k * 864e5).length); }
const RV = {q: null, i: 0, n: 0, ok: 0, picked: null, shown: false};
function rvGradeBtns(key, wrong) {
  return wrong ? `<button class="btn primary" data-rvgrade="1">Again <span class="faint small">${srPreview(key, 1)}</span></button>`
    : [[1, 'Again'], [2, 'Hard'], [3, 'Good'], [4, 'Easy']].map(([g, t]) => `<button class="btn${g === 3 ? ' primary' : ''}" data-rvgrade="${g}">${t} <span class="faint small">${srPreview(key, g)}</span></button>`).join('');
}
function rvItemHTML(o) {
  if (o.kind === 'meq') { const run = meqRuns()[o.c.id];
    return `<div class="case"><div class="small muted">MEQ case · ${o.c.steps.length} steps</div><div class="q">${esc(o.c.title)}</div><p class="prose">${esc(o.c.stem)}</p>${run ? `<p class="small muted">Last ${run.last}% · best ${run.best}%</p>` : ''}
      <div class="qzact"><button class="btn primary" data-rvmeq="${esc(o.c.id)}">Retake the case</button><button class="btn ghost" data-rvskip>Skip for now</button></div></div>`; }
  if (o.kind === 'ward') { const run = rdRuns()[o.c.id];
    return `<div class="case"><div class="small muted">Ward-round case · Level ${o.c.level} · ${esc(LOC_TAG[o.c.tags.loc] || '')}</div><div class="q">${esc(o.c.title)}</div><p class="prose">${esc(o.c.cc)}</p>${run ? `<p class="small muted">Last score ${pct(run.last)}</p>` : ''}
      <div class="qzact"><button class="btn primary" data-rvward="${esc(o.c.id)}">Start the case</button><button class="btn ghost" data-rvskip>Skip for now</button></div></div>`; }
  if (o.kind === 'board') { const x = o.x, done = RV.picked != null;
    return `<div class="case bd"><div class="small muted">Board question · ${esc(o.d.name)}</div><p class="prose">${esc(x.stem)}</p><div class="q">${esc(x.q)}</div>
      <div class="qzopts">${x.opts.map((t, i) => `<button class="qzopt${done ? (i === x.ans ? ' right' : (i === RV.picked ? ' wrong' : '')) : ''}" data-rvpick="${i}"${done ? ' disabled' : ''}><b>${LET[i]}.</b> ${esc(t)}</button>`).join('')}</div>
      ${done ? `<div class="qzans"><p class="a">${esc(x.why)}</p><div class="readmore"><a href="${link(o.d)}">Open ${esc(o.d.name)}</a></div></div><div class="qzact"><span class="small muted">${RV.picked === x.ans ? 'How sure were you?' : 'It will come back soon.'}</span>${rvGradeBtns(o.key, RV.picked !== x.ans)}</div>` : ''}</div>`; }
  const c = o.d.case;
  return `<div class="case"><div class="small muted">Case flashcard</div>${qzCase(c)}<div class="q">${esc(c.q)}</div>
    ${RV.shown ? `<div class="qzans"><div class="qzdx"><span class="muted small">Diagnosis</span><a href="${link(o.d)}"><b>${esc(o.d.name)}</b></a></div><p class="a">${esc(c.a)}</p></div><div class="qzact"><span class="small muted">How well did you recall it?</span>${rvGradeBtns(o.key, false)}</div>`
      : `<div class="qzact"><button class="btn primary" data-rvshow>Show answer</button></div>`}</div>`;
}
function viewReview() {
  LS.set('trainLast', 'review');
  if (!RV.q) { RV.q = srQueue(); RV.i = 0; RV.picked = null; RV.shown = false; }
  const m = SR.get(), sk = LS.get('srStreak', {n: 0, d: ''}), streak = (sk.d === dayKey() || sk.d === dayKey(Date.now() - 864e5)) ? sk.n : 0;
  const fc = srForecast(), mx = Math.max(1, ...fc), left = RV.q.length - RV.i;
  const leech = srDecks().filter(o => (m[o.key] || {}).lapses >= 4).slice(0, 8);
  const head = `<div class="ehead"><div class="crumb">Train</div><h1>Review</h1><p class="muted">Retrieval with spacing: each item returns just before you would forget it. Short daily sessions beat long weekly ones.</p></div>
    <div class="qzbar"><span class="qzstat" style="margin-left:0">${left} to do · ${RV.n ? `${RV.ok}/${RV.n} right · ` : ''}streak ${streak} day${streak === 1 ? '' : 's'}</span>
    <label class="qzsel">New per day <select id="srnew">${[5, 10, 20, 30].map(n => `<option${srNewCap() === n ? ' selected' : ''}>${n}</option>`).join('')}</select></label></div>`;
  const o = RV.q[RV.i];
  const body = o ? rvItemHTML(o) : `<div class="case"><div class="q">All done for now</div><p class="prose">${RV.n ? `You reviewed ${RV.n} item${RV.n > 1 ? 's' : ''} (${pct(RV.ok / RV.n)} right). ` : ''}Come back tomorrow; the next week looks like this:</p>
      <div class="srfc">${fc.map((n, k) => `<div><span style="height:${Math.round(4 + 56 * n / mx)}px"></span><b>${n}</b><small>${k === 0 ? 'tmrw' : '+' + (k + 1) + 'd'}</small></div>`).join('')}</div>
      <div class="qzact"><button class="btn" data-rvmore>Study 10 more new items</button><a class="btn ghost" href="#/rounds">Ward rounds</a></div></div>`;
  return `<article class="entry quiz"><div class="trainwrap">${trainBar('review')}${head}${body}
    ${leech.length ? `<section class="card stcard" style="margin-top:16px"><h3>Trouble spots</h3><p class="small muted" style="margin:0 0 6px">Missed four times or more. Re-read these pages before the next review.</p><div class="chips">${leech.map(x => { const e = x.d || null; return e ? `<a class="chip" href="${link(e)}">${esc(e.name)}</a>` : `<a class="chip" href="#/rounds/${esc(x.c.id)}">${esc(x.c.title)}</a>`; }).join('')}</div></section>` : ''}
    <div class="foot"><div>Progress is stored only on this device. For education only — not a diagnostic tool.</div></div></div></article>`;
}
function rvAct(d) {
  const o = RV.q && RV.q[RV.i];
  if (d.rvpick !== undefined && o && o.kind === 'board' && RV.picked == null) { RV.picked = +d.rvpick; RV.n++; if (RV.picked === o.x.ans) RV.ok++; render(); return true; }
  if ('rvshow' in d) { RV.shown = true; render(); return true; }
  if (d.rvgrade && o) { const g = +d.rvgrade; if (o.kind === 'card') { RV.n++; if (g > 1) RV.ok++; } srGrade(o.key, g); if (g === 1) RV.q.push(o); RV.i++; RV.picked = null; RV.shown = false; render(); window.scrollTo(0, 0); return true; }
  if ('rvskip' in d && o) { RV.q.push(o); RV.i++; render(); return true; }
  if (d.rvmeq) { LS.set('meqCur', null); RV.i++; go('#/meq/' + d.rvmeq); return true; }
  if (d.rvward) { const c = wardById(d.rvward); if (c) { LS.set('rdCur', Object.assign(rdNew(c), {from: 'review'})); RV.i++; go('#/rounds/' + c.id); } return true; }
  if ('rvmore' in d) { const day = LS.get('srDay', {}); day.d = dayKey(); day.n = Math.max(0, (day.n || 0) - 10); LS.set('srDay', day); RV.q = null; render(); return true; }
  return false;
}
function trainBar(active) {
  const due = (() => { try { const m = SR.get(), now = Date.now(); return Object.values(m).filter(s => s.due <= now).length; } catch (e) { return 0; } })();
  return `<nav class="trainbar" aria-label="Train modes"><div class="seg">${[['stats', 'Progress'], ['rounds', 'Rounds'], ['review', 'Review' + (due ? ` <i class="n">${due}</i>` : '')], ['cards', 'Flashcards'], ['mcq', 'Quiz'], ['board', 'Board MCQ'], ['curriculum', 'Curriculum']].map(([k, t]) => `<button data-train="${k}" class="${active === k ? 'on' : ''}">${t}</button>`).join('')}</div></nav>`;
}
function trainGo(k) {
  if (k === 'stats') { go('#/stats'); return; }
  if (k === 'rounds') { go('#/rounds'); return; }
  if (k === 'curriculum') { go('#/curriculum'); return; }
  if (k === 'review') { RV.q = null; go('#/review'); return; }
  QZ.mode = k; LS.set('qzMode', k); LS.set('trainLast', 'quiz'); QZ.cur = null; QZ.n = QZ.ok = 0; go('#/quiz');
}

// ------------------------------------------------------------ Train: Progress dashboard (personal score, game-style; this device only)
// Every study action earns XP; XP climbs monk ranks. The learner races only their own past self ("ghost"), never other people.
// Monk coaches with gentle, specific next steps. Nothing leaves the device unless the learner exports it.
const XP_PTS = {view: 1, newp: 5, search: 1, case: 10, review: 3, good: 2, ward: 20, watch: 2};
const RANKS = [[0, 'Novice', 'สามเณร'], [100, 'Acolyte', 'ผู้ฝึกตน'], [300, 'Pilgrim', 'ผู้จาริก'], [700, 'Disciple', 'ศิษย์'], [1500, 'Brother', 'ภราดา'],
  [3000, 'Teacher', 'อาจารย์'], [6000, 'Elder', 'พระเถระ'], [12000, 'Abbot', 'เจ้าอาวาส'], [25000, 'Grandmaster', 'ปรมาจารย์']];
const DS_NODES = [['cortex', 'Cortex', ['cortex']], ['deep', 'Subcortical and deep grey', ['subcortical', 'basal-ganglia', 'thalamus', 'frontal-subcortical']],
  ['cerebellum', 'Cerebellum', ['cerebellum']], ['brainstem', 'Brainstem', ['brainstem']], ['cn', 'Cranial nerves and eye', ['cranial-nerve', 'optic', 'vestibular']],
  ['meninges', 'Meninges and CSF', ['meninges', 'ventricles-csf']], ['cord', 'Spinal cord', ['spinal-cord', 'cord']], ['ah', 'Anterior horn', ['anterior-horn']],
  ['root', 'Root', ['root']], ['plexus', 'Plexus', ['plexus']], ['nerve', 'Peripheral nerve', ['nerve', 'polyneuropathy']], ['nmj', 'Neuromuscular junction', ['nmj']], ['muscle', 'Muscle', ['muscle']]];
const DS = {node: '', day: '', arm: false, ai: null, busy: false};
const ACTM = {view: '', q: '', qt: 0, watch: ''};
function actGet() {
  const a = LS.get('act', null) || {};
  a.days = a.days || {}; a.seen = a.seen || {}; a.best = a.best || {}; a.xp = a.xp || 0;
  if (!a.mig) { a.mig = 1; try { for (const id of state.hist || []) if (!a.seen[id]) a.seen[id] = 1; } catch (e) {} LS.set('act', a); }   // pages read before the log existed count as read (no XP)
  return a;
}
function actStreak(a, now = Date.now()) { let n = 0, t = now; if (!((a.days[dayKey(t)] || {}).xp > 0)) t -= 864e5; while ((a.days[dayKey(t)] || {}).xp > 0) { n++; t -= 864e5; } return n; }
function rankOf(xp) {
  let i = 0; while (i + 1 < RANKS.length && xp >= RANKS[i + 1][0]) i++;
  const lo = RANKS[i][0], hi = i + 1 < RANKS.length ? RANKS[i + 1][0] : null;
  return {i, name: RANKS[i][1], th: RANKS[i][2], lo, hi, next: hi != null ? RANKS[i + 1][1] : '', frac: hi != null ? (xp - lo) / (hi - lo) : 1};
}
function actLog(kind, o = {}) {
  try {
    const a = actGet(), day = a.days[dayKey()] || (a.days[dayKey()] = {xp: 0});
    let xp = XP_PTS[kind] || 0;
    day[kind] = (day[kind] || 0) + 1;
    if (kind === 'view' && o.id && !a.seen[o.id]) { a.seen[o.id] = Date.now(); day.newp = (day.newp || 0) + 1; xp = XP_PTS.newp; }
    if (kind === 'review' && o.good) { day.good = (day.good || 0) + 1; xp += XP_PTS.good; }
    if (kind === 'ward') { const s = Math.max(0, Math.min(1, +o.score || 0)); day.wardSum = (day.wardSum || 0) + s; xp += Math.round(30 * s); a.best.ward = Math.max(a.best.ward || 0, s); }
    const before = rankOf(a.xp).i;
    day.xp += xp; a.xp += xp;
    a.best.dayXP = Math.max(a.best.dayXP || 0, day.xp); a.best.streak = Math.max(a.best.streak || 0, actStreak(a));
    const keys = Object.keys(a.days).sort(); if (keys.length > 400) keys.slice(0, keys.length - 400).forEach(k => delete a.days[k]);
    LS.set('act', a);
    const r = rankOf(a.xp); if (r.i > before) setTimeout(() => toast(`Monk bows: you are now ${r.name} (${r.th})`), 50);
  } catch (e) {}
}
function actSearch(q) {   // a search counts once the query has rested for 1.5 s
  clearTimeout(ACTM.qt);
  if (!q || q.length < 3) return;
  ACTM.qt = setTimeout(() => { if (state.q === q && q !== ACTM.q) { ACTM.q = q; actLog('search'); } }, 1500);
}
const dsGoal = () => +LS.get('dsGoal', 50) || 50;
const dsCalm = () => !!LS.get('dsCalm', false);
const dsPct = x => Math.round(100 * (x || 0)) + '%';
function dsWeek(a, back) {   // totals for the 7 days ending (back*7) days ago
  const o = {xp: 0, newp: 0, review: 0, good: 0, ward: 0, wardSum: 0, search: 0, case: 0, days: 0};
  for (let i = 0; i < 7; i++) { const d = a.days[dayKey(Date.now() - (i + 7 * back) * 864e5)]; if (!d) continue; if (d.xp > 0) o.days++; for (const k in o) if (k !== 'days' && d[k]) o[k] += d[k]; }
  return o;
}
function dsData() {
  const a = actGet(), now = Date.now(), today = a.days[dayKey()] || {xp: 0};
  const runs = rdRuns(), sk = rdSkill(), m = SR.get(), cases = wardCases();
  const all = Object.values(a.days).reduce((o, d) => { for (const k in d) o[k] = (o[k] || 0) + d[k]; return o; }, {});
  // recall by localization and by group, from graded disease cards (key = page id)
  const recLoc = {}, recSys = {};
  for (const [k, s] of Object.entries(m)) {
    const e = byId.get(k); if (!e || !s.g) continue;
    const ok = s.g >= 3 ? 1 : 0;
    for (const l of e.loc || []) { const r = recLoc[l] || (recLoc[l] = {n: 0, ok: 0}); r.n++; r.ok += ok; }
    const g = (e.sys || [])[0]; if (g) { const r = recSys[g] || (recSys[g] = {n: 0, ok: 0}); r.n++; r.ok += ok; }
  }
  const nodes = DS_NODES.map(([id, name, locs]) => {
    const w = locs.reduce((o, l) => { const s = (sk.loc || {})[l]; if (s) { o.n += s.n; o.ok += s.ok; } return o; }, {n: 0, ok: 0});
    const r = locs.reduce((o, l) => { const s = recLoc[l]; if (s) { o.n += s.n; o.ok += s.ok; } return o; }, {n: 0, ok: 0});
    const n = w.n * 3 + r.n, score = n ? (w.ok * 3 + r.ok) / n : null;   // a full ward case weighs three graded cards
    const cs = cases.filter(c => locs.includes(c.tags.loc));
    return {id, name, w, r, score, n, cases: cs, todo: cs.find(c => !runs[c.id]) || cs.slice().sort((x, y) => (runs[x.id].best || 0) - (runs[y.id].best || 0))[0]};
  });
  const sysCodes = Object.keys(D.meta.sys || {}).filter(c => !['genetic', 'paediatric', 'other'].includes(c));
  const groups = sysCodes.map(c => { const ds = D.dx.filter(e => isDisease(e) && (e.sys || [])[0] === c); return {c, name: sysLabel(c), total: ds.length, seen: ds.filter(e => a.seen[e.id]).length, rec: recSys[c]}; }).filter(g => g.total > 0).sort((x, y) => y.total - x.total);
  const due = Object.values(m).filter(s => s.due <= now).length, trouble = Object.entries(m).filter(([, s]) => s.lapses >= 4).length;
  const wardDone = Object.keys(runs).length, wardBest = Object.values(runs).reduce((x, r) => Math.max(x, r.best || 0), 0);
  const locTot = Object.values(sk.loc || {}).reduce((o, s) => ({n: o.n + s.n, ok: o.ok + s.ok}), {n: 0, ok: 0});
  const pagesRead = Object.keys(a.seen).filter(id => byId.has(id)).length;
  return {a, today, all, nodes, groups, due, trouble, wardDone, wardBest, cases, runs, locTot, pagesRead, streak: actStreak(a), rank: rankOf(a.xp),
    wk: dsWeek(a, 0), lw: dsWeek(a, 1), totalPages: D.all.length, sk};
}
const DS_BADGES = [
  ['first', 'First page', 'Read your first page', d => d.pagesRead >= 1],
  ['p50', 'Bookworm', 'Read 50 different pages', d => d.pagesRead >= 50],
  ['p250', 'Scholar', 'Read 250 different pages', d => d.pagesRead >= 250],
  ['p1000', 'Librarian', 'Read 1,000 different pages', d => d.pagesRead >= 1000],
  ['ward1', 'First round', 'Finish a ward-round case', d => d.wardDone >= 1],
  ['ward90', 'Sharp eye', 'Score 90% or more on a ward round', d => d.wardBest >= 0.9],
  ['wardall', 'Chief resident', 'Finish every ward-round case', d => d.cases.length && d.wardDone >= d.cases.length],
  ['axis', 'Neuraxis walker', 'Localize correctly at 6 different levels', d => d.nodes.filter(n => n.w.ok > 0).length >= 6],
  ['rev100', 'Steady mind', 'Grade 100 recall cards', d => (d.all.review || 0) >= 100],
  ['rev1000', 'Iron memory', 'Grade 1,000 recall cards', d => (d.all.review || 0) >= 1000],
  ['s3', 'Three days', 'Study 3 days in a row', d => (d.a.best.streak || 0) >= 3],
  ['s7', 'One week', 'Study 7 days in a row', d => (d.a.best.streak || 0) >= 7],
  ['s30', 'Monastery life', 'Study 30 days in a row', d => (d.a.best.streak || 0) >= 30],
  ['case5', 'Detective', 'Use Search by case 5 times', d => (d.all.case || 0) >= 5],
  ['watch', 'On the watch', 'Read Neuro-watch on 3 days', d => (d.all.watch || 0) >= 3],
  ['groups', 'Every corridor', 'Read a page in every disease group', d => d.groups.every(g => g.seen > 0)]];
function dsNext(d) {   // gentle, concrete next steps (max 4), most useful first
  const out = [];
  if (d.due) out.push({t: `${d.due} card${d.due > 1 ? 's are' : ' is'} ready for review`, s: `About ${Math.max(1, Math.round(d.due * 0.4))} minutes. Memory grows best right at the edge of forgetting.`, href: '#/review', b: 'Review now'});
  const weak = d.nodes.filter(n => n.score != null && n.n >= 3 && n.score < 0.65).sort((x, y) => x.score - y.score)[0];
  if (weak) out.push({t: `${weak.name}: still growing (${dsPct(weak.score)})`, s: weak.todo ? `Try “${weak.todo.title}” — one case there steadies this level.` : 'Read two pages that localize here and grade the cards.', href: weak.todo ? '#/rounds/' + weak.todo.id : '#/browse/sys', b: weak.todo ? 'Open the case' : 'Browse'});
  const fresh = d.cases.filter(c => !d.runs[c.id]);
  if (fresh.length && !(weak && weak.todo && fresh[0].id === weak.todo.id)) out.push({t: `${fresh.length} ward-round case${fresh.length > 1 ? 's' : ''} not yet tried`, s: `Next up: “${fresh[0].title}”.`, href: '#/rounds/' + fresh[0].id, b: 'Start'});
  if (d.trouble) out.push({t: `${d.trouble} trouble spot${d.trouble > 1 ? 's' : ''}`, s: 'Cards missed 4 or more times. Re-read the page once, slowly, then let them come back.', href: '#/review', b: 'See them'});
  const empty = d.groups.filter(g => !g.seen).sort((x, y) => y.total - x.total)[0];
  if (empty) out.push({t: `Not yet explored: ${empty.name}`, s: `${empty.total} disease pages waiting. Read one that interests you.`, href: '#/browse/sys/' + empty.c, b: 'Explore'});
  if (!(d.all.case > 0)) out.push({t: 'Try Search by case', s: 'Paste a real history (no names) and compare your localization with the engine.', href: '#/case', b: 'Open'});
  return out.slice(0, 4);
}
function dsMonkLine(d) {   // [English, Thai] — never scolds; celebrates effort, then points to one small step
  const g = dsGoal(), t = d.today.xp || 0, y = (d.a.days[dayKey(Date.now() - 864e5)] || {}).xp || 0;
  if (!d.a.xp) return ['Welcome, young one. Every master was once a novice. Read one page or walk one ward round, and our path begins.', 'ยินดีต้อนรับ เริ่มจากอ่านหนึ่งหน้า หรือลองราวด์หนึ่งเคส ก้าวแรกสำคัญที่สุด'];
  if (t >= g * 2) return ['A full day of practice. Now rest: memory settles while you sleep.', 'วันนี้ฝึกมาเยอะมากแล้ว พักผ่อนบ้าง ความจำจะตกผลึกตอนนอนหลับ'];
  if (t >= g) return [`Today's practice is complete (${t} XP). Anything more is a gift, not a duty.`, 'วันนี้ครบเป้าแล้ว จะทำต่อก็ได้ หรือพักก็ดี'];
  if (d.streak >= 7) return [`${d.streak} days without a break. The river cuts stone by patience, not force.`, `ต่อเนื่อง ${d.streak} วันแล้ว ความสม่ำเสมอชนะความหักโหม`];
  if (!t && !y && d.a.xp) return ['You were away for a while. No matter — the temple door is always open. One small card today is enough.', 'ห่างไปหลายวันไม่เป็นไร วันนี้ทำแค่การ์ดเดียวก็พอ'];
  const weak = d.nodes.filter(n => n.score != null && n.n >= 3).sort((x, y) => x.score - y.score)[0], strong = d.nodes.filter(n => n.score != null && n.n >= 3).sort((x, y) => y.score - x.score)[0];
  if (strong && weak && strong !== weak && strong.score >= 0.8) return [`Your ${strong.name.toLowerCase()} localization is strong. ${weak.name} is where the next step of growth waits.`, `ด้าน ${strong.name} แม่นแล้ว ลองฝึก ${weak.name} เพิ่มอีกนิด`];
  if (d.due) return [`${d.due} cards are knocking at the gate. A few minutes now saves an hour of rereading later.`, 'มีการ์ดถึงรอบทบทวน ใช้เวลาไม่กี่นาที'];
  return [`${g - t} XP to today's goal. One ward round or a short review will get you there.`, `อีก ${g - t} XP ถึงเป้าวันนี้`];
}
// ---- drawing helpers (inline SVG; colours from the theme tokens)
function dsRing(frac, size, stroke, cls) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r, f = Math.max(0, Math.min(1, frac || 0));
  return `<svg class="ds-ring ${cls || ''}" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="ds-ring-bg" stroke-width="${stroke}"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="ds-ring-fg" stroke-width="${stroke}" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - f)).toFixed(1)}" style="--c:${c.toFixed(1)}" transform="rotate(-90 ${size / 2} ${size / 2})"/></svg>`;
}
function dsSpark(a, key, n = 14) {
  const v = []; for (let i = n - 1; i >= 0; i--) v.push(+((a.days[dayKey(Date.now() - i * 864e5)] || {})[key] || 0));
  const mx = Math.max(1, ...v), w = 84, h = 22, step = w / (n - 1);
  const pts = v.map((x, i) => `${(i * step).toFixed(1)},${(h - 2 - (x / mx) * (h - 4)).toFixed(1)}`).join(' ');
  return `<svg class="ds-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polyline points="0,${h} ${pts} ${w},${h}" class="ds-spark-a"/><polyline points="${pts}" class="ds-spark-l"/></svg>`;
}
const dsLvl = s => s == null ? 0 : s < 0.5 ? 1 : s < 0.75 ? 2 : 3;   // 0 untried, 1 growing, 2 solid, 3 strong
function dsHeat(a) {
  const weeks = 18, end = new Date(); end.setHours(12, 0, 0, 0);
  const dow = (end.getDay() + 6) % 7, start = end.getTime() - (dow + 7 * (weeks - 1)) * 864e5, cell = 13, gap = 3, cells = [], months = [];
  for (let w = 0; w < weeks; w++) for (let d = 0; d < 7; d++) {
    const t = start + (w * 7 + d) * 864e5; if (t > end.getTime()) continue;
    const k = dayKey(t), xp = (a.days[k] || {}).xp || 0, lv = !xp ? 0 : xp < 20 ? 1 : xp < 50 ? 2 : xp < 100 ? 3 : 4;
    cells.push(`<rect x="${w * (cell + gap)}" y="${16 + d * (cell + gap)}" width="${cell}" height="${cell}" rx="3" class="ds-h${lv}${k === DS.day ? ' sel' : ''}" data-dsday="${k}" tabindex="0" role="button" aria-label="${k}: ${xp} XP"><title>${k}: ${xp} XP</title></rect>`);
    const dt = new Date(t); if (d === 0 && dt.getDate() <= 7) months.push(`<text x="${w * (cell + gap)}" y="10" class="ds-hm">${dt.toLocaleString('en', {month: 'short'})}</text>`);
  }
  const W = weeks * (cell + gap);
  return `<svg class="ds-heat" viewBox="0 0 ${W} ${16 + 7 * (cell + gap)}" role="group" aria-label="Study days, last ${weeks} weeks">${months.join('')}${cells.join('')}</svg>`;
}
function dsAxis(d) {   // the neuraxis as a skill ladder: brain at the top, muscle at the bottom
  const row = 32, W = 400, H = DS_NODES.length * row + 8, x0 = 190;
  const g = d.nodes.map((n, i) => {
    const y = 18 + i * row, lv = dsLvl(n.score), bw = n.score == null ? 0 : Math.max(6, n.score * (W - x0 - 62));
    return `<g class="ds-node l${lv}${DS.node === n.id ? ' sel' : ''}" data-dsnode="${n.id}" tabindex="0" role="button" aria-label="${esc(n.name)}: ${n.score == null ? 'not tried yet' : dsPct(n.score)}">
      <rect x="0" y="${y - 14}" width="${W}" height="${row - 4}" rx="8" class="ds-node-hit"/>
      <text x="${x0 - 22}" y="${y + 4}" text-anchor="end" class="ds-node-t">${esc(n.name)}</text>
      <circle cx="${x0}" cy="${y}" r="${n.score == null ? 5 : 8}" class="ds-dot"/>
      <rect x="${x0 + 16}" y="${y - 4}" width="${W - x0 - 62}" height="8" rx="4" class="ds-bar-bg"/>
      ${bw ? `<rect x="${x0 + 16}" y="${y - 4}" width="${bw.toFixed(1)}" height="8" rx="4" class="ds-bar"/>` : ''}
      <text x="${W - 2}" y="${y + 4}" text-anchor="end" class="ds-node-v">${n.score == null ? '·' : dsPct(n.score)}</text></g>`;
  }).join('');
  return `<svg class="ds-axis" viewBox="0 0 ${W} ${H}" role="group" aria-label="Localization skill along the neuraxis"><line x1="${x0}" y1="10" x2="${x0}" y2="${H - 12}" class="ds-spine"/>${g}</svg>`;
}
function dsRadar(d) {
  const gs = d.groups.slice(0, 8); if (gs.length < 3) return '';
  const R = 78, cx = 180, cy = 122, n = gs.length, pt = (i, r) => [cx + r * Math.sin(2 * Math.PI * i / n), cy - r * Math.cos(2 * Math.PI * i / n)];
  const poly = vals => vals.map((v, i) => pt(i, R * v).map(z => z.toFixed(1)).join(',')).join(' ');
  const cover = gs.map(g => g.total ? Math.min(1, g.seen / Math.min(g.total, 40)) : 0), recall = gs.map(g => g.rec && g.rec.n ? g.rec.ok / g.rec.n : 0);
  const rings = [0.25, 0.5, 0.75, 1].map(f => `<polygon points="${poly(gs.map(() => f))}" class="ds-rgrid"/>`).join('');
  const spokes = gs.map((g, i) => { const [x, y] = pt(i, R), [lx, ly] = pt(i, R + 16); return `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" class="ds-rgrid"/><text x="${lx.toFixed(1)}" y="${(ly + 4).toFixed(1)}" text-anchor="${Math.abs(lx - cx) < 8 ? 'middle' : lx > cx ? 'start' : 'end'}" class="ds-rlab">${esc(g.name.replace(/ (&|and) .*/, '').replace(/^Autoimmune encephalitis.*/, 'Autoimmune'))}</text>`; }).join('');
  return `<svg class="ds-radar" viewBox="0 0 360 250" role="img" aria-label="Reading coverage and recall across the 8 largest disease groups">${rings}${spokes}
    <polygon points="${poly(cover)}" class="ds-rcov"/><polygon points="${poly(recall)}" class="ds-rrec"/></svg>
    <div class="ds-legend"><span><i class="k cov"></i>Pages read (of the first 40)</span><span><i class="k rec"></i>Cards recalled</span></div>`;
}
function dsMonk() {
  const m = monkStyle();
  return `<svg class="ds-monk cw-buddy bs-${m.id}" viewBox="0 0 80 80" role="img" aria-label="Monk, your coach"><g>${monkPx(m.head, 0)}</g>${monkPx(m.body, 10)}</svg>`;
}
function dsVs(d) {   // you this week vs your own ghost from last week, like match statistics
  const rows = [['XP', 'xp'], ['New pages', 'newp'], ['Cards graded', 'review'], ['Ward rounds', 'ward'], ['Study days', 'days']];
  return `<div class="ds-vs"><div class="ds-vs-h"><span>Last week</span><b>vs</b><span>This week</span></div>${rows.map(([t, k]) => {
    const a = d.lw[k] || 0, b = d.wk[k] || 0, mx = Math.max(1, a, b);
    return `<div class="ds-vs-r"><span class="ds-vs-n${a > b ? ' win' : ''}">${a}</span><div class="ds-vs-b l"><i style="width:${(100 * a / mx).toFixed(0)}%"></i></div><span class="ds-vs-t">${t}</span><div class="ds-vs-b r"><i style="width:${(100 * b / mx).toFixed(0)}%"></i></div><span class="ds-vs-n${b >= a && b ? ' win' : ''}">${b}</span></div>`;
  }).join('')}<p class="small faint">Your only rival is yesterday’s you. Being a little behind your ghost is normal; the line over months is what counts.</p></div>`;
}
function dsNodeDetail(d) {
  const n = d.nodes.find(x => x.id === DS.node); if (!n) return '<p class="small faint">Tap a level of the neuraxis to see how you are doing there.</p>';
  return `<div class="ds-detail"><b>${esc(n.name)}</b>
    <p class="small">Ward rounds: ${n.w.n ? `${n.w.ok} of ${n.w.n} localized correctly` : 'not tried yet'} · Recall cards: ${n.r.n ? `${n.r.ok} of ${n.r.n} remembered` : 'none graded yet'}</p>
    ${n.cases.length ? `<div class="chips">${n.cases.map(c => `<a class="chip" href="#/rounds/${esc(c.id)}">${d.runs[c.id] ? '✓ ' : ''}${esc(c.title)}${d.runs[c.id] ? ` · best ${dsPct(d.runs[c.id].best)}` : ''}</a>`).join('')}</div>` : '<p class="small faint">No ward-round case at this level yet — more are coming.</p>'}</div>`;
}
function dsDayDetail(a) {
  if (!DS.day) return '';
  const x = a.days[DS.day];
  if (!x || !x.xp) return `<p class="small faint">${esc(fmtDate(DS.day))}: a rest day.</p>`;
  const parts = [[x.newp, 'new pages'], [x.view, 'page visits'], [x.search, 'searches'], [x.case, 'case searches'], [x.review, 'cards graded'], [x.ward, 'ward rounds'], [x.watch, 'Neuro-watch visits']].filter(p => p[0]);
  return `<p class="small"><b>${esc(fmtDate(DS.day))}</b> · ${x.xp} XP · ${parts.map(p => `${p[0]} ${p[1]}`).join(' · ')}</p>`;
}
function viewStats() {
  LS.set('trainLast', 'stats');
  const d = dsData(), a = d.a, g = dsGoal(), calm = dsCalm(), [say, sayTh] = dsMonkLine(d), next = dsNext(d), r = d.rank;
  const badges = DS_BADGES.map(([id, t, s, f]) => ({id, t, s, ok: (() => { try { return !!f(d); } catch (e) { return false; } })()}));
  const earned = badges.filter(b => b.ok).length;
  const acc = d.locTot.n ? d.locTot.ok / d.locTot.n : null, recall = d.all.review ? (d.all.good || 0) / d.all.review : null;
  const tiles = [
    ['Pages read', d.pagesRead, `of ${d.totalPages.toLocaleString()}`, 'newp', '#/saved'],
    ['Ward rounds', d.wardDone, `of ${d.cases.length} cases`, 'ward', '#/rounds'],
    ['Localization', acc == null ? '–' : dsPct(acc), d.locTot.n ? `${d.locTot.n} answers` : 'no rounds yet', 'ward', '#/rounds'],
    ['Recall', recall == null ? '–' : dsPct(recall), `${d.all.review || 0} cards graded`, 'review', '#/review'],
    ['Searches', (d.all.search || 0) + (d.all.case || 0), `${d.all.case || 0} by case`, 'search', '#/'],
    ['Best streak', d.a.best.streak || 0, 'days', 'xp', '#/stats']];
  return `<article class="entry trainwrap dash">${trainBar('stats')}
    <section class="ds-hero">
      <div class="ds-hero-l">${dsMonk()}<div class="ds-say" role="note"><p>${esc(say)}</p><p class="th" lang="th">${esc(sayTh)}</p>
        ${AI.ok ? `<button class="btn ghost ds-aibtn" data-dsai${DS.busy ? ' disabled' : ''}>${DS.busy ? 'Monk is thinking…' : 'Ask Monk for this week’s coaching note'}</button>` : ''}</div></div>
      <div class="ds-hero-r">
        <div class="ds-rank"><div class="ds-ringwrap">${dsRing(r.frac, 104, 9, 'rank')}<div class="ds-ringtxt"><b>${r.i + 1}</b><span>rank</span></div></div>
          <div><div class="ds-rname">${esc(r.name)} <span lang="th">${esc(r.th)}</span></div><div class="ds-xp"><b data-count="${a.xp}">${a.xp.toLocaleString()}</b> XP</div>
          <div class="small ds-sub">${r.hi != null ? `${(r.hi - a.xp).toLocaleString()} XP to ${esc(r.next)}` : 'Highest rank reached'}</div></div></div>
        <div class="ds-today"><div class="ds-ringwrap sm">${dsRing((d.today.xp || 0) / g, 64, 7, 'today')}<div class="ds-ringtxt"><b>${Math.min(999, Math.round(100 * (d.today.xp || 0) / g))}%</b></div></div>
          <div><b>Today</b><div class="small ds-sub">${d.today.xp || 0} of ${g} XP</div></div>
          <div class="ds-flame${d.streak ? ' on' : ''}" title="Days in a row"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3c1 3.5 5 5.5 5 10a5 5 0 0 1-10 0c0-2 1-3.5 2-4.5.3 1.6 1.2 2.5 2 2.8C10.5 9 11 6 12 3z"/></svg><b>${d.streak}</b><span>day${d.streak === 1 ? '' : 's'}</span></div></div>
      </div>
    </section>
    ${DS.ai ? `<section class="ds-card ds-ai">${DS.ai}</section>` : ''}
    ${planCardHTML(d)}
    <section class="ds-tiles">${tiles.map(([t, v, s, k, h]) => `<a class="ds-tile" href="${h}"><span class="ds-tl">${t}</span><b class="ds-tv"${typeof v === 'number' ? ` data-count="${v}"` : ''}>${typeof v === 'number' ? v.toLocaleString() : v}</b><span class="ds-ts">${s}</span>${dsSpark(a, k)}</a>`).join('')}</section>
    <section class="ds-card"><h2 class="ds-h">Monk’s next steps <span class="faint small">small, doable, in this order</span></h2>
      ${next.length ? `<ol class="ds-next">${next.map(x => `<li><div><b>${esc(x.t)}</b><p class="small">${esc(x.s)}</p></div><a class="btn" href="${x.href}">${esc(x.b)}</a></li>`).join('')}</ol>` : '<p class="small">Nothing pressing. Read something that makes you curious.</p>'}</section>
    <div class="ds-grid">
      <section class="ds-card"><h2 class="ds-h">Neuraxis skill map <span class="faint small">ward rounds + recall cards</span></h2>${dsAxis(d)}
        <div class="ds-legend"><span><i class="k l0"></i>Not tried</span><span><i class="k l1"></i>Growing</span><span><i class="k l2"></i>Solid</span><span><i class="k l3"></i>Strong</span></div>
        <div id="dsnode">${dsNodeDetail(d)}</div></section>
      <section class="ds-card"><h2 class="ds-h">Across the disease groups</h2>${dsRadar(d) || '<p class="small faint">Read a few pages in different groups to see your shape.</p>'}
        <ul class="ds-groups">${d.groups.slice(0, 10).map(x => `<li><a href="#/browse/sys/${esc(x.c)}"><span>${esc(x.name)}</span><span class="ds-gb"><i style="width:${(100 * x.seen / x.total).toFixed(1)}%"></i></span><span class="faint">${x.seen}/${x.total}</span></a></li>`).join('')}</ul></section>
    </div>
    <section class="ds-card"><h2 class="ds-h">Study days <span class="faint small">last 18 weeks · tap a day</span></h2><div class="ds-heatwrap">${dsHeat(a)}</div>
      <div class="ds-legend"><span>Less</span><i class="k h0"></i><i class="k h1"></i><i class="k h2"></i><i class="k h3"></i><i class="k h4"></i><span>More</span></div><div id="dsday">${dsDayDetail(a)}</div></section>
    <div class="ds-grid">
      ${calm ? '' : `<section class="ds-card"><h2 class="ds-h">Match stats</h2>${dsVs(d)}</section>`}
      <section class="ds-card"><h2 class="ds-h">Personal bests</h2><div class="ds-records">
        <div><b>${d.a.best.dayXP || 0}</b><span>XP in one day</span></div><div><b>${d.a.best.streak || 0}</b><span>days in a row</span></div>
        <div><b>${d.wardBest ? dsPct(d.wardBest) : '–'}</b><span>best ward round</span></div><div><b>${(d.all.review || 0).toLocaleString()}</b><span>cards graded, all time</span></div></div></section>
    </div>
    <section class="ds-card"><h2 class="ds-h">Badges <span class="faint small">${earned} of ${badges.length}</span></h2>
      <div class="ds-badges">${badges.map(b => `<div class="ds-badge${b.ok ? ' ok' : ''}" title="${esc(b.s)}"><span class="ds-bi">${b.ok ? '★' : '☆'}</span><b>${esc(b.t)}</b><span class="small">${esc(b.s)}</span></div>`).join('')}</div></section>
    ${cloudCardHTML()}
    <section class="ds-card ds-set"><h2 class="ds-h">Settings</h2>
      <label>Daily goal <select id="dsgoal">${[20, 30, 50, 80, 120].map(v => `<option value="${v}"${v === g ? ' selected' : ''}>${v} XP</option>`).join('')}</select></label>
      <label class="ds-chk"><input type="checkbox" id="dscalm"${calm ? ' checked' : ''}> Calm mode (hide match stats against last week)</label>
      <div class="ds-xpkey small faint">How XP is earned: new page 5 · revisit 1 · search 1 · Search by case 10 · recall card 3 (+2 if remembered) · ward round 20 + up to 30 for the score · Neuro-watch 2.</div>
      <div class="actions"><button class="btn" data-dsexport>Download my progress (JSON)</button><button class="btn ghost" data-dsreset>${DS.arm ? (CLOUD.p ? 'Tap again to erase progress here and in your account' : 'Tap again to erase all progress') : 'Reset progress'}</button></div>
    </section>
    <div class="foot"><div>Your progress is stored only on this device. For education only — not a diagnostic tool.</div></div>
  </article>`;
}
async function dsCoach() {
  if (!AI.ok || DS.busy) return;
  const d = dsData(); DS.busy = true; render();
  const facts = {rank: d.rank.name, xp: d.a.xp, streak: d.streak, this_week: d.wk, last_week: d.lw, pages_read: d.pagesRead, ward_cases_done: d.wardDone, ward_cases_total: d.cases.length,
    localization_by_level: d.nodes.filter(n => n.n).map(n => ({level: n.name, score: Math.round(100 * n.score), ward_answers: n.w.n, recall_cards: n.r.n})), due_cards: d.due, trouble_spots: d.trouble,
    groups_read: d.groups.slice(0, 12).map(g => ({group: g.name, read: g.seen, total: g.total}))};
  const prompt = `You are Monk, a warm, wise senior neurologist coaching a junior doctor who studies with the Sanctum of Neurology app. Here is their study record (JSON): ${JSON.stringify(facts)}
Write a short weekly coaching note. Rules: be kind and specific; praise real effort first; never shame, never compare with other people, never use pressure words like "must" or "behind"; give at most 3 small, concrete steps for the coming week that use the app (ward-round cases, review, reading a group, Search by case); if there is little data, encourage a gentle start. Keep it under 120 words.
Return JSON only: {"praise": "…", "steps": ["…"], "pearl": "one short line of wisdom about learning", "th": "the whole note summarised in 1-2 Thai sentences"}`;
  try {
    const j = await aiJSON(prompt, aiOpts(false));
    DS.ai = rdMonk(`${j.praise ? `<p>${esc(j.praise)}</p>` : ''}${(j.steps || []).length ? `<ol class="list small">${j.steps.slice(0, 3).map(s => `<li>${esc(s)}</li>`).join('')}</ol>` : ''}${j.pearl ? `<p class="small"><i>${esc(j.pearl)}</i></p>` : ''}${j.th ? `<p class="small" lang="th">${esc(j.th)}</p>` : ''}`);
  } catch (e) { DS.ai = `<p class="small muted">Monk could not answer just now (${esc(e.code || e.message || 'error')}). Try again later.</p>`; }
  DS.busy = false; render();
}
function dsAct(d) {   // returns true when handled
  if (d.dsnode) { DS.node = DS.node === d.dsnode ? '' : d.dsnode; render(); return true; }
  if (d.dsday) { DS.day = DS.day === d.dsday ? '' : d.dsday; render(); return true; }
  if ('dsai' in d) { dsCoach(); return true; }
  if ('dsexport' in d) {
    const keys = SYNC_KEYS, o = {app: 'Sanctum of Neurology', version: APP_VERSION, exported: new Date().toISOString()};
    for (const k of keys) o[k] = LS.get(k, null);
    const url = URL.createObjectURL(new Blob([JSON.stringify(o, null, 1)], {type: 'application/json'})), el = document.createElement('a');
    el.href = url; el.download = 'sanctum-progress-' + dayKey() + '.json'; document.body.appendChild(el); el.click(); el.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000);
    return true;
  }
  if ('dsreset' in d) {
    if (!DS.arm) { DS.arm = true; render(); setTimeout(() => { if (DS.arm) { DS.arm = false; if (route().view === 'stats') render(); } }, 5000); return true; }
    DS.arm = false; for (const k of ['act', 'srs', 'rdRuns', 'rdSkill', 'srStreak', 'srDay', 'rdCur', 'plan', 'planDay']) LS.set(k, null);
    DS.ai = null; toast('Progress erased. A fresh start.'); render(); return true;
  }
  return false;
}
function dsAfter() {   // count-up numbers and ring sweep, once per visit
  if (DS.anim) return; DS.anim = true;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const el of $$('.dash [data-count]')) {
    const to = +el.dataset.count; if (!(to > 0)) continue;
    const t0 = performance.now(), dur = 700;
    const step = t => { const k = Math.min(1, (t - t0) / dur), v = Math.round(to * (1 - Math.pow(1 - k, 3))); el.textContent = v.toLocaleString(); if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }
  for (const c of $$('.dash .ds-ring-fg')) { const off = c.getAttribute('stroke-dashoffset'); c.style.strokeDashoffset = c.style.getPropertyValue('--c'); requestAnimationFrame(() => requestAnimationFrame(() => { c.style.strokeDashoffset = off; })); }
}

// ------------------------------------------------------------ Accounts and private sync (v1.0)
// Each learner's progress (Progress XP, recall cards, ward rounds, plan, saved pages) can follow them across devices.
// Two sign-in routes, both PRIVATE TO THE LEARNER (no teacher or owner view by design):
//  1. Claude account — when Sanctum runs as the published claude.ai page: data lives in data/users/<id>/, which the platform
//     keeps private even from the page owner.
//  2. Email (magic link) — on the GitHub/PWA site, when content/cloud.yaml names a Supabase project; row-level security
//     restricts every row to auth.uid() = user_id (see tools/cloud_schema.sql).
// Without either, everything stays on this device exactly as before.
const SYNC_KEYS = ['meqRuns', 'meqCur', 'act', 'srs', 'rdRuns', 'rdSkill', 'srStreak', 'srDay', 'srNew', 'qzBox', 'gushBox', 'fav', 'hist', 'dsGoal', 'dsCalm', 'plan', 'planDay', 'trainLast'];
const CLOUD = {kind: '', name: '', email: '', state: 'local', msg: '', dirty: new Set(), t: 0, busy: false, last: 0, p: null, cfg: null};
function cloudDirty(k) {   // called by LS.set for every synced key
  if (!SYNC_KEYS.includes(k) || CLOUD.pulling) return;
  const m = LS.get('syncMeta', {}); m[k] = Date.now(); try { localStorage.setItem('sanctum.syncMeta', JSON.stringify(m)); } catch (e) {}
  if (!CLOUD.p) return;
  CLOUD.dirty.add(k); clearTimeout(CLOUD.t); CLOUD.t = setTimeout(cloudPush, 4000);
}
// ---- merging: never lose study done on another device
function mergeKey(k, a, b) {   // a = local, b = cloud; returns merged value
  if (a == null) return b; if (b == null) return a;
  if (k === 'act') {
    const o = {days: {}, seen: {...(a.seen || {}), ...(b.seen || {})}, best: {}, mig: 1, xp: Math.max(a.xp || 0, b.xp || 0)};
    for (const s of [a.seen || {}, b.seen || {}]) for (const id in s) o.seen[id] = Math.min(o.seen[id] || Infinity, s[id]);
    for (const d of new Set([...Object.keys(a.days || {}), ...Object.keys(b.days || {})])) {
      const x = (a.days || {})[d] || {}, y = (b.days || {})[d] || {}, z = {};
      for (const f of new Set([...Object.keys(x), ...Object.keys(y)])) z[f] = Math.max(+x[f] || 0, +y[f] || 0);
      o.days[d] = z;
    }
    for (const f of new Set([...Object.keys(a.best || {}), ...Object.keys(b.best || {})])) o.best[f] = Math.max(+(a.best || {})[f] || 0, +(b.best || {})[f] || 0);
    return o;
  }
  if (k === 'srs') { const o = {...a}; for (const id in b) if (!o[id] || (b[id].last || 0) > (o[id].last || 0)) o[id] = b[id]; return o; }
  if (k === 'rdRuns') { const o = {...a}; for (const id in b) { const x = o[id], y = b[id]; o[id] = !x ? y : {...((y.at || 0) > (x.at || 0) ? y : x), n: Math.max(x.n || 0, y.n || 0), best: Math.max(x.best || 0, y.best || 0)}; } return o; }
  if (k === 'rdSkill') { const o = {}; for (const g of new Set([...Object.keys(a), ...Object.keys(b)])) { o[g] = {}; const x = a[g] || {}, y = b[g] || {}; for (const t of new Set([...Object.keys(x), ...Object.keys(y)])) { const p = x[t] || {n: 0, ok: 0}, q = y[t] || {n: 0, ok: 0}; o[g][t] = p.n >= q.n ? p : q; } } return o; }
  if (k === 'fav' || k === 'hist') return [...new Set([...(a || []), ...(b || [])])].slice(0, k === 'hist' ? 40 : 2000);
  if (k === 'qzBox' || k === 'gushBox') return {...b, ...a};
  return a;   // simple settings: the caller decides by timestamp
}
function cloudApply(remote) {   // remote: {key: {v, t}}
  const meta = LS.get('syncMeta', {}); CLOUD.pulling = true;
  try {
    for (const k of SYNC_KEYS) {
      const r = remote[k]; if (!r) continue;
      const loc = LS.get(k, null);
      let v;
      if (['act', 'srs', 'rdRuns', 'rdSkill', 'fav', 'hist', 'qzBox', 'gushBox'].includes(k)) v = mergeKey(k, loc, r.v);
      else v = (r.t || 0) > (meta[k] || 0) || loc == null ? r.v : loc;
      LS.set(k, v); meta[k] = Math.max(meta[k] || 0, r.t || 0);
      if (JSON.stringify(v) !== JSON.stringify(r.v)) CLOUD.dirty.add(k);
    }
    localStorage.setItem('sanctum.syncMeta', JSON.stringify(meta));
  } catch (e) {} finally { CLOUD.pulling = false; }
  state.fav = LS.get('fav', []); state.hist = LS.get('hist', []);
}
async function cloudPush() {
  if (!CLOUD.p || CLOUD.busy || !CLOUD.dirty.size) return;
  CLOUD.busy = true; const keys = [...CLOUD.dirty]; CLOUD.dirty.clear(); const meta = LS.get('syncMeta', {});
  try { for (const k of keys) await CLOUD.p.push(k, LS.get(k, null), meta[k] || Date.now()); CLOUD.state = 'synced'; CLOUD.last = Date.now(); CLOUD.msg = ''; }
  catch (e) { keys.forEach(k => CLOUD.dirty.add(k)); CLOUD.state = 'error'; CLOUD.msg = cloudErr(e); }
  CLOUD.busy = false; if (route().view === 'stats') cloudPaint();
}
async function cloudSyncNow() {
  if (!CLOUD.p) return; CLOUD.state = 'syncing'; cloudPaint();
  try { cloudApply(await CLOUD.p.pull()); SYNC_KEYS.forEach(k => { if (LS.get(k, null) != null) CLOUD.dirty.add(k); }); CLOUD.busy = false; await cloudPush(); if (CLOUD.state !== 'error') CLOUD.state = 'synced'; }
  catch (e) { CLOUD.state = 'error'; CLOUD.msg = cloudErr(e); }
  if (['stats', 'review', 'rounds', 'saved'].includes(route().view)) render(); else cloudPaint();
}
const cloudErr = e => e && e.code === 'invalid_argument' ? 'This account can view Sanctum but cannot save to it. Ask the owner to share the page with you as a Contributor.' : e && e.code === 'quota_exceeded' ? 'Cloud storage is full.' : 'Could not reach the cloud just now; your work is safe on this device and will sync later.';
// ---- provider 1: Claude account (published claude.ai page)
const claudeProvider = {
  kind: 'claude', db: null, uid: '',
  async init() {
    if (!(window.claude && window.claude.use)) return null;
    const [db, user] = await Promise.all([window.claude.use('db'), window.claude.use('user')]);
    if (!db || !user) return null;
    const uid = await user.id(); if (!uid) return null;
    let me = null; try { me = await user.me(); } catch (e) {}
    this.db = db; this.uid = uid;
    return {name: (me && me.name) || 'you', email: (me && me.email) || ''};
  },
  col() { return this.db.collection('data/users/' + this.uid); },
  async pull() {
    const snap = await this.col().get(), parts = {}, out = {};
    for (const d of snap.docs) { const x = d.data() || {}; if (!x.k) continue; (parts[x.k] = parts[x.k] || []).push(x); }
    for (const k in parts) { const ps = parts[k].sort((p, q) => (p.i || 0) - (q.i || 0)), t = ps[0].t || 0; if (ps.some(p => p.t !== t) || ps.length !== (ps[0].n || 1)) continue; try { out[k] = {v: JSON.parse(ps.map(p => p.j).join('')), t}; } catch (e) {} }
    return out;
  },
  async push(k, v, t) {
    const j = JSON.stringify(v), size = 200000, n = Math.max(1, Math.ceil(j.length / size));
    for (let i = 0; i < n; i++) await this.col().doc('p_' + k + (i ? '~' + i : '')).set({k, i, n, t, j: j.slice(i * size, (i + 1) * size)});
    for (let i = n; i < n + 3; i++) { const r = this.col().doc('p_' + k + '~' + i); const s = await r.get(); if (s.exists) await r.delete(); else break; }
  }
};
// ---- provider 2: email magic link (Supabase project named in content/cloud.yaml)
const emailProvider = {
  kind: 'email', s: null,
  cfg() { const c = (D && D.meta && D.meta.cloud) || {}; return c.supabase_url && c.supabase_anon_key ? {url: String(c.supabase_url).replace(/\/$/, ''), key: c.supabase_anon_key} : null; },
  async api(path, opt = {}) {
    const c = this.cfg(), h = {apikey: c.key, 'Content-Type': 'application/json', ...(opt.headers || {})};
    if (this.s && !opt.anon) h.Authorization = 'Bearer ' + this.s.access_token;
    const r = await fetch(c.url + path, {...opt, headers: h});
    if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
    return r.status === 204 ? null : r.json().catch(() => null);
  },
  async refresh() {
    if (!this.s) return false;
    if ((this.s.expires_at || 0) * 1000 - Date.now() > 60e3) return true;
    try { const j = await this.api('/auth/v1/token?grant_type=refresh_token', {method: 'POST', anon: true, body: JSON.stringify({refresh_token: this.s.refresh_token})}); this.s = {...this.s, ...j, expires_at: Math.floor(Date.now() / 1000) + (j.expires_in || 3600)}; LS.set('sbSession', this.s); return true; }
    catch (e) { if (e.status === 400 || e.status === 401) { this.s = null; LS.set('sbSession', null); } return false; }
  },
  async init() {
    if (!this.cfg()) return null;
    this.s = LS.get('sbSession', null); if (!this.s || !(await this.refresh())) return null;
    try { const u = await this.api('/auth/v1/user'); this.uid = u.id; return {name: (u.email || '').split('@')[0], email: u.email || ''}; } catch (e) { return null; }
  },
  async sendLink(email) {
    const back = location.href.split('#')[0];
    await this.api('/auth/v1/otp?redirect_to=' + encodeURIComponent(back), {method: 'POST', anon: true, body: JSON.stringify({email, create_user: true})});
  },
  async pull() { await this.refresh(); const rows = await this.api('/rest/v1/progress?select=key,value,updated_at'); const o = {}; for (const r of rows || []) { try { o[r.key] = {v: JSON.parse(r.value), t: Date.parse(r.updated_at) || 0}; } catch (e) {} } return o; },
  async push(k, v, t) { await this.refresh(); await this.api('/rest/v1/progress?on_conflict=user_id,key', {method: 'POST', headers: {Prefer: 'resolution=merge-duplicates,return=minimal'}, body: JSON.stringify({user_id: this.uid, key: k, value: JSON.stringify(v), updated_at: new Date(t).toISOString()})}); },
  async signOut() { try { await this.api('/auth/v1/logout', {method: 'POST'}); } catch (e) {} this.s = null; LS.set('sbSession', null); }
};
function cloudCatchLink() {   // the magic link returns as #access_token=...; take the session and restore a normal route
  const h = location.hash || '';
  if (!/access_token=/.test(h)) return false;
  const q = new URLSearchParams(h.replace(/^#\/?/, ''));
  const s = {access_token: q.get('access_token'), refresh_token: q.get('refresh_token'), expires_at: +q.get('expires_at') || Math.floor(Date.now() / 1000) + (+q.get('expires_in') || 3600)};
  if (s.access_token && s.refresh_token) LS.set('sbSession', s);
  history.replaceState(null, '', location.pathname + location.search + '#/stats');
  return true;
}
async function cloudStart() {
  for (const p of [claudeProvider, emailProvider]) {
    try { const u = await p.init(); if (u) { CLOUD.p = p; CLOUD.kind = p.kind; CLOUD.name = u.name; CLOUD.email = u.email; break; } } catch (e) {}
  }
  if (!CLOUD.p) { CLOUD.state = 'local'; cloudPaint(); return; }
  await cloudSyncNow();
  window.addEventListener('pagehide', () => { if (CLOUD.dirty.size) cloudPush(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) cloudPush(); else if (Date.now() - CLOUD.last > 10 * 60e3) cloudSyncNow(); });
}
function cloudCardHTML() {
  const cfg = emailProvider.cfg(), inClaude = !!(window.claude && window.claude.use);
  const when = CLOUD.last ? new Date(CLOUD.last).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) : '';
  let body;
  if (CLOUD.p) body = `<div class="ac-row"><span class="ac-av" aria-hidden="true">${esc((CLOUD.name || '?').slice(0, 1).toUpperCase())}</span><div><b>${esc(CLOUD.name)}</b>${CLOUD.email ? ` <span class="faint small">${esc(CLOUD.email)}</span>` : ''}
      <div class="small">${CLOUD.kind === 'claude' ? 'Signed in with your Claude account' : 'Signed in by email'} · <span class="ac-st ${CLOUD.state}">${CLOUD.state === 'synced' ? `synced${when ? ' at ' + when : ''}` : CLOUD.state === 'syncing' ? 'syncing…' : CLOUD.state === 'error' ? 'not synced' : 'ready'}</span></div></div>
      <div class="ac-btns"><button class="btn ghost" data-acsync>Sync now</button>${CLOUD.kind === 'email' ? '<button class="btn ghost" data-acout>Sign out</button>' : ''}</div></div>
      ${CLOUD.msg ? `<p class="small ac-warn">${esc(CLOUD.msg)}</p>` : ''}<p class="small faint">Your progress and plan are private to you: no teacher, owner or other learner can see them.</p>`;
  else if (cfg) body = CLOUD.sent ? `<p>Check <b>${esc(CLOUD.sent)}</b> for a sign-in link, then open it on this device.</p><button class="btn ghost" data-acagain>Use another email</button>`
      : `<p class="small">Sign in to keep your progress and personal plan on every device. Private to you.</p><form class="ac-form" data-acform><input type="email" id="acemail" required placeholder="you@hospital.ac.th" autocomplete="email"><button class="btn" type="submit">Email me a sign-in link</button></form>${CLOUD.msg ? `<p class="small ac-warn">${esc(CLOUD.msg)}</p>` : ''}`;
  else body = `<p class="small">Saved on this device only.${inClaude ? ' Sign in to claude.ai and open Sanctum there to save your progress to your Claude account.' : ' Open Sanctum as the claude.ai page to sign in with your Claude account.'}</p>`;
  return `<section class="ds-card ac-card" id="accard"><h2 class="ds-h">Your account</h2>${body}</section>`;
}
function cloudPaint() { const el = document.getElementById('accard'); if (el) el.outerHTML = cloudCardHTML(); }
function cloudAct(d) {
  if ('acsync' in d) { cloudSyncNow(); return true; }
  if ('acout' in d) { (async () => { await emailProvider.signOut(); CLOUD.p = null; CLOUD.state = 'local'; render(); })(); return true; }
  if ('acagain' in d) { CLOUD.sent = ''; cloudPaint(); return true; }
  return false;
}
async function cloudSubmit(form) {
  const email = (form.querySelector('#acemail') || {}).value || '';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return;
  try { await emailProvider.sendLink(email.trim()); CLOUD.sent = email.trim(); CLOUD.msg = ''; } catch (e) { CLOUD.msg = 'Could not send the link just now. Try again in a minute.'; }
  cloudPaint();
}
// ------------------------------------------------------------ My plan: each learner's own training program
// The learner chooses role, goal, minutes a day and focus groups; Monk turns that plus their own weak spots into today's
// short checklist (fixed for the day), ticked automatically from what they actually did.
const PLAN_ROLES = [['student', 'Medical student'], ['intern', 'Intern / GP'], ['resident', 'Neurology resident'], ['fellow', 'Fellow'], ['neurologist', 'Neurologist']];
const planGet = () => LS.get('plan', null);
function planHash(s) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function planBuild(d) {   // returns today's tasks [{id, t, s, href, need, kind}]
  const p = planGet(); if (!p) return [];
  const mins = +p.minutes || 20, seed = planHash(dayKey() + (p.role || '')), tasks = [];
  const focus = (p.focus || []).length ? p.focus : d.groups.slice().sort((x, y) => (x.seen / x.total) - (y.seen / y.total)).slice(0, 2).map(g => g.c);
  const nRev = Math.max(5, Math.min(d.due || 0, Math.round(mins * 0.8))) || 5;
  tasks.push({id: 'rev', kind: 'review', need: Math.min(nRev, 60), t: `Review ${Math.min(nRev, 60)} cards`, s: d.due ? `${d.due} are due; start with those.` : 'New cards will be mixed in.', href: '#/review'});
  if (mins >= 15) {
    const weak = d.nodes.filter(n => n.score != null && n.score < 0.75 && n.todo).sort((x, y) => x.score - y.score)[0];
    const c = (weak && weak.todo) || d.cases.find(x => !d.runs[x.id]) || d.cases[seed % Math.max(1, d.cases.length)];
    if (c) tasks.push({id: 'ward:' + c.id, kind: 'ward', t: `Ward round: “${c.title}”`, s: weak ? `Builds your ${weak.name.toLowerCase()} localization.` : 'One full case, step by step.', href: '#/rounds/' + c.id});
  }
  const nRead = mins >= 45 ? 3 : mins >= 20 ? 2 : 1, a = d.a;
  const pool = D.dx.filter(e => isDisease(e) && focus.includes((e.sys || [])[0]) && !a.seen[e.id]);
  for (let i = 0; i < nRead && pool.length; i++) { const e = pool.splice((seed + i * 7919) % pool.length, 1)[0]; tasks.push({id: 'read:' + e.id, kind: 'read', t: `Read: ${e.name}`, s: sysLabel((e.sys || [])[0]), href: '#/dx/' + encodeURIComponent(e.id)}); }
  if (p.goal === 'exam' || mins >= 45) tasks.push({id: 'mcq', kind: 'review', need: 10, t: 'Answer 10 board questions', s: p.goal === 'exam' ? 'Exam practice: timed, then read every explanation.' : 'Keeps knowledge test-ready.', href: '#/quiz'});
  if (new Date().getDay() === 6 && !(d.wk.case > 0)) tasks.push({id: 'case', kind: 'case', t: 'Weekly: try Search by case once', s: 'Use a real history (no names) and compare.', href: '#/case'});
  return tasks;
}
function planToday(d) {   // fixed for the day once made
  const pd = LS.get('planDay', null), p = planGet();
  if (!p) return [];
  if (pd && pd.d === dayKey() && pd.v === p.v) return pd.tasks;
  const tasks = planBuild(d); LS.set('planDay', {d: dayKey(), v: p.v, tasks}); return tasks;
}
function planDone(x, d) {
  const day = d.today || {}, since = new Date(); since.setHours(0, 0, 0, 0);
  if (x.id === 'rev') return (day.review || 0) >= x.need;
  if (x.id === 'mcq') return (day.review || 0) >= x.need + ((planToday(d).find(y => y.id === 'rev') || {}).need || 0);
  if (x.kind === 'ward') { const r = d.runs[x.id.slice(5)]; return !!(r && (r.at || 0) >= since.getTime()); }
  if (x.kind === 'read') { const t = d.a.seen[x.id.slice(5)]; return t > 1 && t >= since.getTime(); }
  if (x.kind === 'case') return (day.case || 0) > 0;
  return false;
}
function planCardHTML(d) {
  const p = planGet();
  if (!p || DS.planEdit) {
    const q = p || {role: 'resident', goal: 'daily', minutes: 20, focus: []};
    return `<section class="ds-card pl-card" id="plancard"><h2 class="ds-h">My training plan <span class="faint small">your own program, private to you</span></h2>
      <form data-planform class="pl-form">
        <label>I am a <select name="role">${PLAN_ROLES.map(([v, t]) => `<option value="${v}"${q.role === v ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
        <label>Goal <select name="goal"><option value="daily"${q.goal !== 'exam' ? ' selected' : ''}>Steady daily practice</option><option value="exam"${q.goal === 'exam' ? ' selected' : ''}>Board exam</option></select></label>
        <label>Exam date <input type="date" name="exam" value="${esc(q.exam || '')}"></label>
        <label>Minutes a day <select name="minutes">${[10, 20, 30, 45, 60].map(v => `<option value="${v}"${+q.minutes === v ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
        <fieldset><legend>Focus groups <span class="faint small">(none = Monk picks your least-read groups)</span></legend><div class="chips">${d.groups.map(g => `<label class="chip pl-chip"><input type="checkbox" name="focus" value="${esc(g.c)}"${(q.focus || []).includes(g.c) ? ' checked' : ''}> ${esc(g.name)}</label>`).join('')}</div></fieldset>
        <div class="actions"><button class="btn" type="submit">${p ? 'Save plan' : 'Make my plan'}</button>${p ? '<button class="btn ghost" type="button" data-plancancel>Cancel</button>' : ''}</div>
      </form></section>`;
  }
  const tasks = planToday(d), done = tasks.filter(x => planDone(x, d)).length, role = (PLAN_ROLES.find(r => r[0] === p.role) || [, ''])[1];
  const days = p.goal === 'exam' && p.exam ? Math.ceil((new Date(p.exam + 'T00:00:00') - Date.now()) / 864e5) : null;
  return `<section class="ds-card pl-card" id="plancard"><h2 class="ds-h">Today’s plan <span class="faint small">${esc(role)} · ${p.minutes} min a day${days != null && days >= 0 ? ` · exam in ${days} day${days === 1 ? '' : 's'}` : ''}</span></h2>
    <div class="pl-prog"><div class="pl-bar"><i style="width:${tasks.length ? (100 * done / tasks.length).toFixed(0) : 0}%"></i></div><span>${done} of ${tasks.length}</span></div>
    <ul class="pl-list">${tasks.map(x => { const ok = planDone(x, d); return `<li class="${ok ? 'ok' : ''}"><span class="pl-tick" aria-hidden="true">${ok ? '✓' : ''}</span><div><b>${esc(x.t)}</b><p class="small">${esc(x.s)}</p></div>${ok ? '<span class="faint small">done</span>' : `<a class="btn ghost" href="${esc(x.href)}">Go</a>`}</li>`; }).join('')}</ul>
    ${done === tasks.length && tasks.length ? '<p class="small pl-done">All done for today. Monk is pleased; rest well.</p>' : ''}
    <div class="actions"><button class="btn ghost" data-planedit>Change my plan</button></div></section>`;
}
function planSubmit(form) {
  const f = new FormData(form), old = planGet() || {};
  LS.set('plan', {v: (old.v || 0) + 1, role: f.get('role'), goal: f.get('goal'), exam: f.get('exam') || '', minutes: +f.get('minutes') || 20, focus: f.getAll('focus'), made: old.made || Date.now()});
  LS.set('planDay', null); DS.planEdit = false; render();
}
function planAct(d) {
  if ('planedit' in d) { DS.planEdit = true; render(); return true; }
  if ('plancancel' in d) { DS.planEdit = false; render(); return true; }
  return false;
}

// ------------------------------------------------------------ Train: MEQ cases (modified essay questions)
// Cases rewritten in our own words from published teaching cases (same final diagnosis, new details). Information is released
// step by step; the learner TYPES each answer (Thai or English), then sees the key, a % match, what was missed and Monk's
// reasoning, together with a running recap of the case so far. A revealed step is locked: there is no going back.
// Scoring: Claude judges meaning when available; otherwise a keyword match on the key's concepts (Thai and English synonyms).
const meqCases = () => (D.meta && D.meta.meq) || [];
const meqById = id => meqCases().find(c => c.id === id);
const meqRuns = () => LS.get('meqRuns', {});
const MEQ = {busy: false, draw: null};
function meqNorm(s) { return String(s || '').toLowerCase().normalize('NFKC').replace(/[‘’]/g, "'").replace(/[^\p{L}\p{N}\s'+/-]/gu, ' ').replace(/\s+/g, ' ').trim(); }
function meqKeyword(step, text) {   // offline score: share of key concepts mentioned (any synonym, Thai or English)
  const t = ' ' + meqNorm(text) + ' ', pts = step.points || [];
  if (!pts.length || !t.trim()) return {pct: 0, hit: [], missed: pts.map(p => p.c), by: 'keywords'};
  const hit = [], missed = [];
  let got = 0, tot = 0;
  for (const p of pts) {
    const w = +p.w || 1; tot += w;
    const ok = (p.kw || [p.c]).some(k => { const n = meqNorm(k); return n && (/[฀-๿]/.test(n) ? t.includes(n) : new RegExp('(^|[^a-z0-9])' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z0-9]|$)').test(t)); });
    if (ok) { got += w; hit.push(p.c); } else missed.push(p.c);
  }
  return {pct: Math.round(100 * got / tot), hit, missed, by: 'keywords'};
}
async function meqGrade(c, step, text) {
  const kw = meqKeyword(step, text);
  if (!AI.ok || !String(text || '').trim()) return kw;
  const prompt = `You are grading one step of a neurology MEQ (modified essay question) for a doctor in training. The answer may be in Thai, English or both; judge MEANING, not wording or spelling. Accept correct synonyms and abbreviations.
Question: ${step.q}
Model answer: ${step.key}
Key concepts with weights: ${JSON.stringify((step.points || []).map(p => ({concept: p.c, weight: +p.w || 1})))}
Learner's answer: """${String(text).slice(0, 2000)}"""
Score = weighted share of key concepts the learner clearly stated (partial credit allowed for partly correct concepts). Do not give credit for vague or contradictory statements. Do not penalise extra correct points; if the learner adds something wrong or dangerous, mention it in "note".
Return JSON only: {"pct": 0-100, "hit": ["concepts covered"], "missed": ["concepts missed"], "note": "one short, kind sentence of feedback (English), optional"}`;
  try {
    const j = await Promise.race([aiJSON(prompt, aiOpts(false)), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 25000))]);
    const pct = Math.max(0, Math.min(100, Math.round(+j.pct)));
    if (!isFinite(pct)) return kw;
    return {pct, hit: (j.hit || []).slice(0, 8), missed: (j.missed || []).slice(0, 8), note: j.note || '', by: 'Claude'};
  } catch (e) { return kw; }
}
function meqRecap(c, upto) {   // the case so far: stem + revealed information + the agreed answers of finished steps
  const parts = [`<p>${esc(c.stem)}</p>`];
  c.steps.slice(0, upto).forEach((s, i) => {
    if (s.info) parts.push(`<p>${esc(s.info)}</p>`);
    parts.push(`<p class="meq-rk"><b>${esc(s.label || 'Step ' + (i + 1))}:</b> ${esc(s.short || s.key)}</p>`);
  });
  return parts.join('');
}
const meqPctCls = p => p >= 80 ? 'hi' : p >= 50 ? 'mid' : 'lo';
function meqPlayer(c) {
  let r = LS.get('meqCur', null);
  if (!r || r.id !== c.id) r = null;
  const n = c.steps.length;
  if (!r) return `<article class="entry trainwrap meq">${trainBar('rounds')}<div class="ehead"><div class="crumb"><a href="#/rounds">Rounds</a> › MEQ</div><h1>${esc(c.title)}</h1>
      <p class="muted">${n} steps. Type each answer in Thai or English. Once a step is revealed it is locked: you cannot go back.</p></div>
      <section class="card meq-stem"><h3>The case</h3><p>${esc(c.stem)}</p></section>
      ${meqRuns()[c.id] ? `<p class="small">Your best so far: <b>${meqRuns()[c.id].best}%</b> (${meqRuns()[c.id].n} attempt${meqRuns()[c.id].n > 1 ? 's' : ''}).</p>` : ''}
      <div class="actions"><button class="btn" data-meqstart="${esc(c.id)}">Start the case</button></div>
      <p class="small faint">Rewritten for teaching from a published case (${esc(c.src.label)}); details differ from the original.${c.review === 'approved' ? ' Approved by the curator.' : ' Draft for expert review.'}</p></article>`;
  if (r.done) return meqEnd(c, r);
  const i = r.step, s = c.steps[i], a = r.ans[i];
  return `<article class="entry trainwrap meq">${trainBar('rounds')}<div class="ehead"><div class="crumb"><a href="#/rounds">Rounds</a> › MEQ</div><h1>${esc(c.title)}</h1>
    <div class="meq-prog" aria-label="Step ${i + 1} of ${n}">${c.steps.map((x, k) => `<span class="${k < i ? 'done' : k === i ? 'cur' : ''}"${r.ans[k] && r.ans[k].pct != null ? ` title="${r.ans[k].pct}%"` : ''}></span>`).join('')}<b>Step ${i + 1} of ${n}</b></div></div>
    <details class="card meq-sofar"${i === 0 ? ' open' : ''}><summary>The case so far</summary>${meqRecap(c, i)}</details>
    ${s.info ? `<section class="card meq-info"><h3>${esc(s.infoTitle || 'New information')}</h3><p>${esc(s.info)}</p></section>` : ''}
    <section class="card meq-q"><h3>${esc(s.label || 'Question')}</h3><p class="meq-qt">${esc(s.q)}</p>
      ${s.basis ? `<p class="small meq-basis"><b>Answer according to:</b> ${esc(s.basis)}</p>` : ''}
      <textarea id="meqans" rows="5" placeholder="Type your answer (ไทยหรืออังกฤษก็ได้)…" ${a ? 'disabled' : ''}>${esc(a ? a.text : r.draft || '')}</textarea>
      ${a ? '' : `<div class="actions"><button class="btn" data-meqsubmit${MEQ.busy ? ' disabled' : ''}>${MEQ.busy ? 'Checking…' : 'Reveal the answer'}</button><span class="small faint">This locks your answer.</span></div>`}
    </section>
    ${a ? `<section class="card meq-key"><div class="meq-score ${meqPctCls(a.pct)}"><b>${a.pct}%</b><span>match with the key<br><small>scored by ${esc(a.by)}</small></span></div>
      <h3>Answer</h3><p>${esc(s.key)}</p>
      ${(a.hit || []).length ? `<p class="small"><b>You covered:</b> ${a.hit.map(esc).join('; ')}</p>` : ''}${(a.missed || []).length ? `<p class="small meq-miss"><b>Missed:</b> ${a.missed.map(esc).join('; ')}</p>` : ''}${a.note ? `<p class="small"><i>${esc(a.note)}</i></p>` : ''}
      ${rdMonk(`<p>${esc(s.why)}</p>`)}
      ${s.tests ? `<p class="small faint">Tests named here are described on the answer page.</p>` : ''}
      <div class="meq-recap"><h4>Recap so far</h4>${meqRecap(c, i + 1)}</div>
      <div class="actions"><button class="btn" data-meqnext>${i + 1 < n ? 'Next step →' : 'See the final summary'}</button></div></section>` : ''}
  </article>`;
}
function meqEnd(c, r) {
  const tot = Math.round(r.ans.reduce((x, a) => x + (a ? a.pct : 0), 0) / c.steps.length);
  const ans = byId.get(c.answerId) || resolveFind(c.answer), cmp = (c.compareIds || []).map(id => byId.get(id)).filter(Boolean).slice(0, 4);
  return `<article class="entry trainwrap meq">${trainBar('rounds')}<div class="ehead"><div class="crumb"><a href="#/rounds">Rounds</a> › MEQ</div><h1>${esc(c.title)}</h1></div>
    <section class="card meq-final"><div class="meq-score big ${meqPctCls(tot)}"><b>${tot}%</b><span>overall</span></div>
      <h3>Final diagnosis</h3><p class="meq-dx">${ans ? `<a href="#/dx/${esc(ans.id)}">${esc(c.answer)}</a>` : esc(c.answer)}</p>
      <table class="meq-tab"><thead><tr><th>Step</th><th>Your match</th></tr></thead><tbody>${c.steps.map((s, k) => `<tr><td>${esc(s.label || 'Step ' + (k + 1))}</td><td><span class="meq-pill ${meqPctCls(r.ans[k].pct)}">${r.ans[k].pct}%</span></td></tr>`).join('')}</tbody></table>
      ${rdMonk(`<p>${esc(c.monk)}</p>${c.monk_th ? `<p lang="th">${esc(c.monk_th)}</p>` : ''}`)}
      <div class="actions meq-links">
        ${ans ? `<a class="btn" href="#/dx/${esc(ans.id)}">Read the full page: ${esc(ans.name)}</a>` : ''}
        ${cmp.length > 1 ? `<a class="btn" href="#/compare/${cmp.map(e => encodeURIComponent(e.id)).join('/')}">Compare with look-alikes</a>` : ''}
        <button class="btn ghost" data-meqretake="${esc(c.id)}">Retake later from step 1</button>
      </div>
      ${cmp.length > 1 ? `<p class="small">Look-alikes: ${cmp.slice(1).map(e => `<a href="#/dx/${esc(e.id)}">${esc(e.name)}</a>`).join(', ')}</p>` : ''}
      <p class="small faint">Source idea: ${esc(c.src.label)} · <a href="https://pubmed.ncbi.nlm.nih.gov/${esc(c.src.pmid)}/" target="_blank" rel="noopener">PubMed ${esc(c.src.pmid)}</a> · <a href="https://doi.org/${esc(c.src.doi)}" target="_blank" rel="noopener">DOI</a>. This case was rewritten with different details; it is a teaching draft for expert review.</p>
    </section>
    <details class="card meq-sofar" open><summary>The whole case</summary>${meqRecap(c, c.steps.length)}</details></article>`;
}
function meqFinish(c, r) {
  const tot = Math.round(r.ans.reduce((x, a) => x + (a ? a.pct : 0), 0) / c.steps.length);
  const runs = meqRuns(), o = runs[c.id] || {n: 0, best: 0, hist: []};
  o.n++; o.best = Math.max(o.best, tot); o.last = tot; o.at = Date.now(); o.hist = [...(o.hist || []), tot].slice(-20); runs[c.id] = o; LS.set('meqRuns', runs);
  srGrade('m:' + c.id, tot >= 85 ? 4 : tot >= 65 ? 3 : tot >= 45 ? 2 : 1);
  actLog('ward', {score: tot / 100});
  rsnMeq(c, r);
}
function meqAct(d) {
  if (d.meqstart) { LS.set('meqCur', {id: d.meqstart, step: 0, ans: [], at: Date.now()}); render(); window.scrollTo(0, 0); return true; }
  if ('meqsubmit' in d) {
    const r = LS.get('meqCur', null), c = r && meqById(r.id), box = $('#meqans'); if (!c || !box || MEQ.busy || r.ans[r.step]) return true;
    const text = box.value.trim();
    if (!text) { box.focus(); box.placeholder = 'Write something first — even a guess. Committing is how reasoning grows.'; return true; }
    MEQ.busy = true; render();
    (async () => {
      const g = await meqGrade(c, c.steps[r.step], text);
      const cur = LS.get('meqCur', null); if (!cur || cur.id !== c.id || cur.step !== r.step) { MEQ.busy = false; return; }
      cur.ans[cur.step] = {text, ...g}; cur.draft = ''; LS.set('meqCur', cur); MEQ.busy = false; render();
      const k = document.querySelector('.meq-key'); if (k) k.scrollIntoView({behavior: 'smooth', block: 'start'});
    })();
    return true;
  }
  if ('meqnext' in d) {
    const r = LS.get('meqCur', null), c = r && meqById(r.id); if (!c || !r.ans[r.step]) return true;
    if (r.step + 1 < c.steps.length) r.step++; else { r.done = true; meqFinish(c, r); }
    LS.set('meqCur', r); render(); window.scrollTo(0, 0); return true;
  }
  if (d.meqretake) { LS.set('meqCur', null); go('#/meq/' + d.meqretake); return true; }
  if (d.meqshuffle) { MEQ.draw = meqDraw(); render(); const x = $('#meqdraw'); if (x) x.scrollIntoView({block: 'start'}); return true; }
  return false;
}
// Rounds draw: 4 approved MEQ cases at random, one per primary theme (theme is never shown: it would hint at the answer).
// New cases and cases due for spaced review come first. A fresh draw on every visit to Rounds, or on "Draw again".
function meqDraw() {
  const runs = meqRuns(), m = SR.get(), now = Date.now(), cur = LS.get('meqCur', null);
  const pool = meqCases().filter(c => c.review === 'approved' && !(cur && cur.id === c.id && !cur.done));
  const fresh = c => { const s = m['m:' + c.id]; return !runs[c.id] || (s && s.due <= now); };
  const sh = pool.map(c => [Math.random(), c]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
  const order = [...sh.filter(fresh), ...sh.filter(c => !fresh(c))], seen = new Set(), out = [];
  for (const c of order) { const t = c.theme || c.id; if (seen.has(t)) continue; seen.add(t); out.push(c.id); if (out.length === 4) break; }
  return out;
}
const MEQ_REVIEW = {approved: ['', ''], pending: ['awaiting curator review', 'draft'], changes: ['being revised', 'draft']};
function meqCard(c) {
  const runs = meqRuns(), m = SR.get(), now = Date.now(), cur = LS.get('meqCur', null);
  const run = runs[c.id], s = m['m:' + c.id], due = s && s.due <= now, going = cur && cur.id === c.id && !cur.done, rv = MEQ_REVIEW[c.review] || MEQ_REVIEW.pending;
  return `<a class="rdcase" href="#/meq/${esc(c.id)}"><span class="rdlvl meqb">MEQ</span><span class="rdct"><b>${esc(c.title)}</b><small>${c.steps.length} steps${rv[0] ? ` · <span class="st ${rv[1]}">${rv[0]}</span>` : ''}</small></span>
      <span class="rdst">${going ? '<span class="st cur">in progress</span>' : run ? `<span class="st ${run.best >= 80 ? 'reviewed' : 'draft'}">best ${run.best}%</span>` : '<span class="st cur">new</span>'}${due ? ' <span class="st auto">due</span>' : ''}</span></a>`;
}
function meqListHTML() {
  const all = meqCases(); if (!all.length) return '';
  const cur = LS.get('meqCur', null), going = cur && !cur.done && meqById(cur.id);
  if (!MEQ.draw) MEQ.draw = meqDraw();
  const drawn = MEQ.draw.map(meqById).filter(Boolean), nApp = all.filter(c => c.review === 'approved').length;
  return `<section class="meq-draw" id="meqdraw"><h2 class="sec">MEQ cases <span class="count">${nApp} approved</span></h2>
    <p class="small muted">Step-by-step written answers, exam style. Four cases are drawn at random each time you open Rounds; new cases and cases due for review come first.</p>
    ${going ? `<p class="small"><b>Continue:</b></p><div class="rdcases">${meqCard(going)}</div>` : ''}
    ${drawn.length ? `<div class="rdcases">${drawn.map(meqCard).join('')}</div>` : `<p class="small muted">No approved cases ${nApp ? 'left to draw' : 'yet'}. Cases join the draw after the curator approves them; drafts are in the full list below.</p>`}
    <div class="actions"><button class="btn ghost" data-meqshuffle="1">Draw again</button></div>
    <details class="meq-all"${nApp ? '' : ' open'}><summary>All MEQ cases (${all.length})</summary><div class="rdcases">${all.map(meqCard).join('')}</div></details></section>`;
}
function viewMeq(arg) {
  LS.set('trainLast', 'rounds');
  const c = meqById(arg); if (!c) return rdList();
  return meqPlayer(c);
}

// ---- Neuro-watch: curated, referenced updates (tier: practice / likely / watch / new)
const NW_TIER = {practice: ['Practice now', 'reviewed'], likely: ['Likely standard', 'cur'], watch: ['Watch', 'auto'], new: ['New disease / criteria', 'draft']};
const NW = {tier: '', age: ''};
const watchList = () => (D.meta && D.meta.watch) || [];
function nwItem(x) {
  const t = NW_TIER[x.tier] || [x.tier, 'auto'], pages = (x.pages || []).map(id => byId.get(id)).filter(Boolean);
  return `<li class="nwitem" id="${esc(x.id)}"><div class="nwmeta"><span class="st ${t[1]}">${t[0]}</span><span class="tag">${esc(x.area)} · ${x.age === 'paeds' ? 'Children' : x.age === 'both' ? 'Adults and children' : 'Adults'} · ${esc(x.date)}</span>${x.review === 'approved' ? '' : ' <span class="st draft">awaiting curator approval</span>'}</div>
    <b class="nwt">${esc(x.title)}</b><p class="prose">${esc(x.what)}</p>${x.why ? `<p class="small"><b>Why it matters:</b> ${esc(x.why)}</p>` : ''}
    <div class="small nwrefs">${(x.refs || []).map(r => `<a href="https://pubmed.ncbi.nlm.nih.gov/${esc(r.pmid)}/" target="_blank" rel="noopener">${esc(r.label || 'PMID ' + r.pmid)} ↗</a>${r.doi ? ` <span class="faint">doi ${esc(r.doi)}</span>` : ''}`).join(' · ')}</div>
    ${pages.length ? `<div class="chips" style="margin-top:6px">${pages.map(e => `<a class="chip" href="${link(e)}">${esc(e.name)}</a>`).join('')}</div>` : ''}</li>`;
}
function viewWatch() {
  const all = watchList(), list = all.filter(x => (!NW.tier || x.tier === NW.tier) && (!NW.age || x.age === NW.age || x.age === 'both'));
  return `<article class="entry"><div class="trainwrap"><div class="ehead"><div class="crumb">Keeping current</div><h1>Neuro-watch</h1>
    <p class="muted">What is changing in neurology, adults and children: practice-changing trials and guidelines, treatments likely to become standard, negative trials worth knowing, and new diseases. Summaries are original wording with PubMed links; each item is approved by the curator before it is final.</p></div>
    <div class="qzbar"><div class="seg">${[['', 'All'], ['practice', 'Practice now'], ['likely', 'Likely standard'], ['watch', 'Watch'], ['new', 'New disease']].map(([k, t]) => `<button data-nwtier="${k}" class="${NW.tier === k ? 'on' : ''}">${t}</button>`).join('')}</div>
    <div class="seg">${[['', 'All ages'], ['adult', 'Adults'], ['paeds', 'Children']].map(([k, t]) => `<button data-nwage="${k}" class="${NW.age === k ? 'on' : ''}">${t}</button>`).join('')}</div><span class="qzstat">${list.length} of ${all.length}</span></div>
    ${list.length ? `<ul class="nwlist">${list.map(nwItem).join('')}</ul>` : '<p class="empty">Nothing in this filter.</p>'}
    <div class="foot"><div>Summaries of published abstracts for education; read the source before changing practice. Not medical advice.</div></div></div></article>`;
}
function nwForPage(e) {
  const xs = watchList().filter(x => (x.pages || []).includes(e.id)); if (!xs.length) return '';
  return `<section class="card nwbox"><h3>What’s changing <span class="count">${xs.length}</span></h3><ul class="list small">${xs.map(x => `<li><span class="st ${(NW_TIER[x.tier] || [])[1] || 'auto'}">${(NW_TIER[x.tier] || [x.tier])[0]}</span> <a href="#/watch/${esc(x.id)}">${esc(x.title)}</a> <span class="faint">${esc(x.date)}</span></li>`).join('')}</ul></section>`;
}
function nwHomeHTML() {
  const xs = watchList(); if (!xs.length) return '';
  return `<section class="card stcard"><h3><a href="#/watch">Neuro-watch</a> <span class="count">${xs.length}</span></h3><ul class="list small" style="margin:0">${xs.slice(0, 3).map(x => `<li><a href="#/watch/${esc(x.id)}">${esc(x.title)}</a> <span class="faint">${esc(x.date)}</span></li>`).join('')}</ul></section>`;
}
// ------------------------------------------------------------ Gush! — swipe-to-review flash cards (mobile first)
// Leitner boxes kept on this device only (LS gushBox). Unsure cards come back within the session and sooner next time.
const GUSH_TYPES = [['dx', 'Diseases', 'name + a rotating question'], ['case', 'Case quiz', 'short vignette on the front'], ['sign', 'Signs', 'bedside signs'], ['ns', 'Neuroscience', 'tracts and circuits']];
const G = {fam: new Set(), tq: [], lastQ: '', pace: 0, tIdx: -1, tId: 0, open: false, cards: [], cur: 0, pend: [], recent: [], seen: 0, known: 0, unsure: 0, blockStart: 0, pool: null, gate: false};
const gCfg = () => Object.assign({types: ['dx', 'case', 'sign', 'ns'], sys: [], yellow: false, every: 25, paceOn: false, pace: 8}, LS.get('gushCfg', {}));
const gBox = () => LS.get('gushBox', {});
const gKey = e => 'g:' + e.id;
function gSigSys(s) { const out = new Set(); for (const id of (s.dx || []).slice(0, 12)) { const d = byId.get(id); if (d) (d.sys || []).forEach(x => out.add(x)); } return [...out]; }
// Umbrella terms ("Myopathy", "Cerebellar disorders", "Toxic neuropathies") are skipped: every card names a disease, sign or structure.
const G_HEAD = new Set(('myopathy neuropathy encephalopathy myelopathy radiculopathy monoradiculopathy plexopathy polyneuropathy mononeuropathy polyradiculopathy ganglionopathy channelopathy axonopathy neuronopathy cardiomyopathy ' +
  'dementia ataxia chorea dystonia tremor myoclonus parkinsonism dyskinesia akathisia akinesia athetosis ballism tic seizure epilepsy spasm cramp stereotypy myotonia ' +
  'encephalitis meningitis meningoencephalitis encephalomyelitis myelitis myositis vasculitis arteritis stroke headache vertigo aphasia apraxia agnosia amnesia coma delirium catatonia insomnia hypersomnia ' +
  'disease disorder syndrome condition state tumour tumor neoplasm infection lesion malformation aneurysm leukodystrophy leukoencephalopathy hydrocephalus metastasis metastase lymphoma degeneration failure ' +
  'haemorrhage hemorrhage infarction atrophy dystrophy palsy paralysis weakness pain abnormality complication problem deficiency toxicity poisoning').split(' '));
const G_ADJ = new Set(('acute chronic subacute hyperacute cerebellar cortical subcortical central peripheral autoimmune autonomic cerebrovascular cognitive behavioral behavioural balance congenital cranial focal generalized generalised ' +
  'hereditary inherited familial acquired idiopathic symptomatic inflammatory immune-mediated metabolic toxic nutritional primary secondary spinal brainstem cerebral neuromuscular neurological neurologic movement motor sensory sensorimotor ' +
  'other action rest postural kinetic intention arm leg limb chin head vocal jaw distal proximal axonal paediatric pediatric childhood adult neonatal infantile episodic paroxysmal progressive degenerative neurodegenerative ' +
  'drug-induced drug induced muscle muscular nerve neuron neuronal brain cord cervical thoracic lumbar lumbosacral multiple mixed painful large-fibre small-fibre fibre psychiatric functional organic intracranial extracranial ' +
  'ocular visual auditory gait sleep mood personality mental and or of the with in a an non to related associated type').split(' '));
const G_KEEP = new Set(['cerebral palsy', 'motor neuron disease', 'idiopathic hypersomnia', 'central cord syndrome', 'spinal cord infarction', 'episodic ataxia', 'sleep paralysis']);
const gStem = w => /ies$/.test(w) && w.length > 5 ? w.slice(0, -3) + 'y' : /e?s$/.test(w) && G_HEAD.has(w.replace(/e?s$/, '')) ? w.replace(/e?s$/, '') : /s$/.test(w) && !/(is|us|ss|as|os)$/.test(w) ? w.slice(0, -1) : w;
const gWords = n => n.toLowerCase().replace(/[’']s\b/g, '').split(/[^a-z0-9+\-]+/).filter(Boolean);
function gGeneric(e) {
  if (e.t === 'sign' || e.cat === 'neuroscience') return false;
  if (e._gen != null) return e._gen;
  let n = e.name.split(/\s+[—–]\s+/)[0]; const g = () => {
    if (G_KEEP.has(n.toLowerCase())) return false;
    const comma = n.includes(','); if (comma && /\(/.test(n)) return false; if (comma) n = n.split(',')[0];
    const abbr = /\([^)]*\)/.test(n), ws = gWords(n.replace(/\([^)]*\)/g, ' '));
    if (!ws.length) return false;
    const st = ws.map(gStem);
    if (!ws.every((w, i) => G_HEAD.has(w) || G_ADJ.has(w) || G_HEAD.has(st[i]) || G_ADJ.has(st[i]))) return false;
    return !abbr || st[st.length - 1] !== ws[ws.length - 1];   // a specific abbreviation keeps a singular name (AIDP); plural umbrellas go
  };
  return (e._gen = g());
}
// Family keys: entries that share a distinctive word or abbreviation (NMOSD / NMO-ON / ...) count as one group, so a deck holds one of each.
const G_FSTOP = new Set('antibody antibodies onset status benign system systemic autosomal dominant recessive artery arterial pathway immune anterior posterior spectrum associated related induced traumatic variant variants classic early late adult'.split(' '));
function gFam(e) {
  if (e._fam) return e._fam;
  const ks = new Set(), n = e.name;
  for (const a of [...(n.match(/\(([^)]*)\)/g) || []).map(x => x.slice(1, -1)), ...(e.ab || []).filter(a => /^[A-Z0-9\-]{2,8}$/.test(a))])
    for (const t of a.split(/[\s\/,;\-]+/)) if (/^[A-Z][A-Z0-9]{1,7}$/.test(t)) ks.add('A:' + t.slice(0, 3).toLowerCase());
  for (const w of gWords(n.replace(/\([^)]*\)/g, ' ')))
    if (w.length >= 5 && !G_HEAD.has(w) && !G_ADJ.has(w) && !G_HEAD.has(gStem(w)) && !G_ADJ.has(gStem(w)) && !G_FSTOP.has(w) && !G_FSTOP.has(gStem(w))) ks.add('W:' + w.slice(0, 7));
  return (e._fam = [...ks]);
}
const gClash = e => gFam(e).some(k => G.fam.has(k));
function gEligible(e) {
  if (e.t === 'sign') return !!(e.cur || (e.simple && (e.dx || []).length));
  if (e.cat === 'neuroscience') return !!((e.feat || []).length >= 2 || (e.ns || {}).function);
  return (e.feat || []).length >= 2 && !gGeneric(e);
}
function gPool(cfg) {
  const T = new Set(cfg.types), S = new Set(cfg.sys);
  const okSys = list => !S.size || (list || []).some(x => S.has(x));
  const out = [];
  if (T.has('dx') || T.has('case')) for (const d of D.dx) {
    if (!gEligible(d) || !okSys(d.sys) || (!cfg.yellow && d.st !== 'g')) continue;
    const modes = []; if (T.has('dx')) modes.push('dx'); if (T.has('case') && d.case && d.case.story) modes.push('case');
    if (modes.length) out.push({e: d, modes});
  }
  if (T.has('sign')) for (const s of D.signs) { if (gEligible(s) && (cfg.yellow || s.cur) && okSys(gSigSys(s))) out.push({e: s, modes: ['sign']}); }
  if (T.has('ns')) for (const n of D.ns) { if (gEligible(n) && (!S.size || !(n.sys || []).length || okSys(n.sys))) out.push({e: n, modes: ['ns']}); }
  return out;
}
function gGroups() {
  const m = new Map();
  for (const d of D.dx) if (gEligible(d)) for (const s of (d.sys || []).slice(0, 2)) m.set(s, (m.get(s) || 0) + (d.st === 'g' ? 1 : 0));
  return [...m.entries()].filter(([, n]) => n).sort((a, b) => sysLabel(a[0]).localeCompare(sysLabel(b[0])));
}
function gPick() {
  const pos = G.cards.length;
  const pi = G.pend.findIndex(p => p.at <= pos);
  if (pi >= 0) { const p = G.pend.splice(pi, 1)[0]; if (p.mode !== 'case') G.lastQ = p.q; return {it: p.it, mode: p.mode, q: p.q, again: true}; }
  const pool = G.pool; if (!pool.length) return null;
  const box = gBox(), now = Date.now(), recent = new Set(G.recent);
  const fresh = pool.filter(o => !gClash(o.e));   // one card per disease family in each deck
  let cand = fresh.filter(o => !recent.has(o.e.id) && (!box[gKey(o.e)] || box[gKey(o.e)].due <= now));
  if (!cand.length) cand = fresh.filter(o => !recent.has(o.e.id));
  if (!cand.length) cand = fresh.length ? fresh : pool.filter(o => !recent.has(o.e.id));
  if (!cand.length) cand = pool;
  const w = cand.map(o => { const b = box[gKey(o.e)]; return b ? 6 - b.b : 3; });   // new = 3, unsure (box 1) = 5, known (box 5) = 1
  let r = Math.random() * w.reduce((a, b) => a + b, 0), it = cand[cand.length - 1];
  for (let i = 0; i < cand.length; i++) { r -= w[i]; if (r <= 0) { it = cand[i]; break; } }
  const mode = it.modes[Math.floor(Math.random() * it.modes.length)];
  gFam(it.e).forEach(k => G.fam.add(k));
  return {it, mode, q: mode === 'case' ? 'case' : gNextQ(it.e)};
}
// Rotating questions: the back answers exactly what the front asks, drawn from that section of the page.
const GQ_ORDER = ['feat', 'patho', 'inv', 'clin', 'tx'];
const GQ = {
  dx:   {feat: ['Key features', 'What are the key features?'], patho: ['Pathophysiology', 'What is the pathophysiology?'], inv: ['Key investigations', 'What are the key investigations?'], clin: ['Clinical picture', 'What is the typical clinical picture?'], tx: ['Treatment', 'How is it treated?']},
  sign: {feat: ['Key features', 'What are the key features of this sign?'], patho: ['Pathophysiology', 'What is the mechanism behind this sign?'], inv: ['How to elicit', 'How do you elicit it?'], clin: ['Clinical meaning', 'What does a positive sign mean, and where is the lesion?']},
  ns:   {feat: ['Key features', 'What are the key features?'], patho: ['Anatomy & physiology', 'Describe its anatomy and function.'], inv: ['Bedside testing', 'How do you test it at the bedside?'], clin: ['Lesion picture', 'What happens when it is damaged?'], tx: ['Clinical correlation', 'Which syndromes or treatments relate to it?']},
};
const gKind = e => e.t === 'sign' ? 'sign' : e.cat === 'neuroscience' ? 'ns' : 'dx';
const gSent = t => String(t || '').split(/(?<=[.!?])\s+(?=[A-Z0-9(“"])/).map(x => x.trim()).filter(Boolean).slice(0, 5);
function gAnswer(e, q) {
  const det = e.det || {}, k = gKind(e);
  if (q === 'case' || q === 'feat') {
    if (k === 'sign') { const p = (det.pearls || []).slice(0, 4); return p.length ? p : gSent(e.formal).slice(0, 3); }
    return (e.gush || e.feat || []).slice(0, 5);
  }
  if (q === 'patho') return gSent(k === 'sign' ? det.mechanism : det.patho);
  if (q === 'inv') return k === 'sign' ? gSent(det.technique || e.exam) : (e.inv || []).slice(0, 5);
  if (q === 'clin') {
    if (k !== 'sign') return gSent(det.clinical);
    const seen = (e.dx || []).map(id => byId.get(id)).filter(Boolean).slice(0, 5).map(d => d.name);
    return [...gSent(det.interpretation || e.pos).slice(0, 3), ...(seen.length ? ['Seen in: ' + seen.join('; ')] : [])];
  }
  if (q === 'tx') return k === 'sign' ? [] : gSent(det.treatment);
  return [];
}
function gNextQ(e) {
  const k = gKind(e), ok = GQ_ORDER.filter(q => GQ[k][q] && gAnswer(e, q).length);
  if (!ok.length) return 'feat';
  for (let tries = 0; tries < 2; tries++) {
    if (!G.tq.length) { const s = [...GQ_ORDER].sort(() => Math.random() - 0.5); if (s[0] === G.lastQ) s.push(s.shift()); G.tq = s; }
    const i = G.tq.findIndex(q => ok.includes(q) && q !== G.lastQ);
    if (i >= 0) { const q = G.tq.splice(i, 1)[0]; G.lastQ = q; return q; }
    G.tq = [];
  }
  const q = ok.find(x => x !== G.lastQ) || ok[0]; G.lastQ = q; return q;
}
function gBullets(e) {
  const f = (e.gush || e.feat || []).slice(0, 5);   // optional hand-written card bullets win
  if (f.length) return f;
  if (e.t === 'sign') { const p = ((e.det || {}).pearls || []).slice(0, 4); return p.length ? p : [firstSentence(e.simple || e.formal)]; }
  return [firstSentence(e.simple || e.formal)];
}
function gMeta(e) {
  if (e.t === 'sign') return [(e.loc || []).slice(0, 3).map(locLabel).join(', ')].filter(Boolean).join(' · ');
  if (e.cat === 'neuroscience') return NS_KIND[(e.ns || {}).kind] || 'Neuroscience';
  return [(e.tempo || []).map(c => (D.meta.tempo && D.meta.tempo[c]) || c).join(' / '), (e.loc || []).slice(0, 3).map(locLabel).join(', ')].filter(Boolean).join(' · ');
}
function gTag(e, mode) { return mode === 'case' ? 'Case quiz' : isSignLike(e) ? 'Sign' : e.cat === 'neuroscience' ? 'Neuroscience' : sysLabel((e.sys || ['disease'])[0]); }
function gCardHTML(c, i) {   // front: name + question only (English); back: the answer to that question
  const e = c.it.e, mode = c.mode, q = c.q || 'feat', L = mode === 'case' ? ['Diagnosis', 'What is the diagnosis?'] : (GQ[gKind(e)][q] || GQ.dx.feat);
  let front;
  if (mode === 'case') {
    const k = e.case;
    front = `<div class="gcase"><p><b>${esc(k.who || '')}</b></p><p>${esc(k.story || '')}</p>${k.exam ? `<p>${esc(k.exam)}</p>` : ''}</div><div class="gq">${e.cat === 'biomarker' ? 'Which antibody fits this picture?' : e.cat === 'pathogen' ? 'Which organism is it?' : L[1]}</div>`;
  } else front = `<h2 class="gname">${esc(e.name)}</h2><div class="gq">${esc(L[1])}</div>`;
  const ans = gAnswer(e, q);
  const back = `<div class="gslow"${c.slow ? '' : ' hidden'}>Too slow!</div><h2 class="gname sm">${esc(e.name)}</h2><div class="gqlabel">${esc(L[0])}</div>
    <ul class="gfeat">${ans.map(b => `<li>${esc(b)}</li>`).join('')}</ul>
    <a class="gmore" href="${link(e)}" data-gopen><span>Read the full page<small>${e.t === 'sign' ? 'technique, localisation, diseases' : e.cat === 'neuroscience' ? 'pathway, lesions, clinical correlation' : 'case, differentials, investigations, references'}</small></span><b aria-hidden="true">→</b></a>
    <div class="ggrade"><button class="btn" data-ggrade="0" data-gi="${i}" title="Not sure (1)">Not sure</button><button class="btn primary" data-ggrade="1" data-gi="${i}" title="Gotcha! (2)">Gotcha!</button></div>`;
  return `<section class="gslide" data-gi="${i}"><div class="gcard${c.flip ? ' flip' : ''}${c.graded != null ? ' graded' : ''}" data-gflip="${i}" data-gq="${mode === 'case' ? 'case' : q}" role="button" tabindex="0" aria-label="Flash card ${i + 1}, tap to flip">
    <div class="gface gfront">${G.pace && !c.flip ? '<div class="ghurry" hidden>“Hurry up!”</div>' : ''}${front}<div class="ghint">${c.again ? '↻ coming back · ' : ''}Tap to flip</div>${G.pace && !c.flip ? `<div class="gtimer" aria-hidden="true"><i></i><b></b></div>` : ''}</div>
    <div class="gface gback">${back}</div></div></section>`;
}
function gSummaryHTML() {
  const n = G.cards.length - G.blockStart;
  const k = G.cards.slice(G.blockStart).filter(c => c.graded === 1).length, u = G.cards.slice(G.blockStart).filter(c => c.graded === 0).length;
  return `<section class="gslide gsum" id="gsum"><div class="gsumcard"><div class="gtag">Break point</div><h2>${n} cards reviewed</h2>
    <p class="gbig"><span><b>${k}</b> Gotcha!</span><span><b>${u}</b> not sure</span><span><b>${n - k - u}</b> skipped</span></p>
    <p class="muted">Deck complete. Carry on with a new deck or rest your eyes. Cards you were not sure about will come back.</p>
    <div class="ggrade"><button class="btn" data-gstop>Take a break</button><button class="btn primary" data-gmore>${gCfg().every} more</button></div>
    <p class="small muted">Today: ${G.seen} seen · ${G.known} Gotcha! · ${G.unsure} not sure</p></div></section>`;
}
function gEnsure() {   // keep three cards ready ahead of the current one; stop at the break point
  const feed = $('#gfeed'); if (!feed) return;
  const every = gCfg().every;
  while (!G.gate && G.cards.length < G.cur + 4) {
    if (G.cards.length - G.blockStart >= every) { G.gate = true; feed.insertAdjacentHTML('beforeend', gSummaryHTML()); break; }
    const c = gPick(); if (!c) break;
    G.cards.push(c); G.recent = [c.it.e.id, ...G.recent].slice(0, Math.min(20, Math.floor(G.pool.length / 2)));
    feed.insertAdjacentHTML('beforeend', gCardHTML(c, G.cards.length - 1));
  }
  const s = $('#gsum'); if (s && G.gate) s.outerHTML = gSummaryHTML();
  const p = $('#gprog'); if (p) p.textContent = `${Math.min(G.cur - G.blockStart + 1, every)} / ${every}`;
}
function gGrade(i, good) {
  const c = G.cards[i]; if (!c) return;
  const id = gKey(c.it.e), box = gBox();
  if (c.graded == null) { if (good) G.known++; else G.unsure++; }
  else { if (c.graded === 1) G.known--; else G.unsure--; if (good) G.known++; else G.unsure++; }
  c.graded = good ? 1 : 0;
  const b = good ? Math.min(5, ((box[id] || {}).b || 0) + 1) : 1;
  box[id] = {b, due: Date.now() + [0, 0, 1, 3, 7, 21][b] * 864e5 - 6e4}; LS.set('gushBox', box);
  actLog('review', {good});
  if (!good && !G.pend.some(p => p.it === c.it)) G.pend.push({it: c.it, mode: c.mode, q: c.q, at: G.cards.length + 4 + Math.floor(Math.random() * 3)});
  const el = document.querySelector(`.gcard[data-gflip="${i}"]`); if (el) el.classList.add('graded');
  setTimeout(() => gGo(i + 1), 220);
}
function gGo(i) { const el = document.querySelector(`.gslide[data-gi="${i}"]`) || (i >= G.cards.length && $('#gsum')); if (el) el.scrollIntoView({behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'}); }
function gFlip(i) { const c = G.cards[i]; if (!c) return; if (G.tIdx === i) { gTimerStop(); c.timed = true; const t = document.querySelector(`.gcard[data-gflip="${i}"] .gtimer`); if (t) t.remove(); } c.flip = !c.flip; const el = document.querySelector(`.gcard[data-gflip="${i}"]`); if (el) el.classList.toggle('flip', c.flip); }
// Pick up the pace: countdown on the front; at zero the card flips and shows "Too slow!"
function gTimerStop() { clearInterval(G.tId); if (G.tIdx >= 0) { const c = G.cards[G.tIdx]; if (c && !c.flip && !c.slow) c.timed = false; } G.tId = 0; G.tIdx = -1; }   // a countdown cut short (card hidden) may run again
function gTimerStart(i) {
  if (!G.pace || G.tIdx === i) return;
  gTimerStop();
  const c = G.cards[i], card = document.querySelector(`.gcard[data-gflip="${i}"]`);
  if (!c || c.flip || c.graded != null || c.timed || !card) return;
  const box = card.querySelector('.gtimer'); if (!box) return;
  const bar = box.querySelector('i'), num = box.querySelector('b'), end = Date.now() + G.pace * 1000;
  c.timed = true; G.tIdx = i;
  bar.style.transition = 'none'; bar.style.transform = 'scaleX(1)';
  requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.transition = `transform ${G.pace}s linear`; bar.style.transform = 'scaleX(0)'; }));
  const tick = () => {
    const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
    num.textContent = left; box.classList.toggle('hurry', left <= 3);
    const h = card.querySelector('.ghurry'); if (h) h.hidden = !(left <= 5 && left > 0 && G.pace > 5);
    if (Date.now() >= end) {
      gTimerStop(); c.slow = true;
      const s = card.querySelector('.gslow'); if (s) s.hidden = false;
      box.remove(); const h = card.querySelector('.ghurry'); if (h) h.remove(); c.flip = true; card.classList.add('flip');
      if (navigator.vibrate) try { navigator.vibrate(60); } catch (e) {}
    }
  };
  tick(); G.tId = setInterval(tick, 100);
}
function gushOpen() {
  const cfg = gCfg(); G.pool = gPool(cfg);
  if (!G.pool.length) { toast('No cards for this selection'); return false; }
  gTimerStop(); G.pace = cfg.paceOn ? cfg.pace : 0;
  Object.assign(G, {fam: new Set(), tq: [], lastQ: '', open: true, cards: [], cur: 0, pend: [], recent: [], seen: 0, known: 0, unsure: 0, blockStart: 0, gate: false});
  let ov = $('#gush'); if (ov) ov.remove();
  ov = document.createElement('div'); ov.id = 'gush'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-label', 'Gush flash cards');
  ov.innerHTML = `<div class="gtop"><span class="gbrand">Gush!</span><span class="gprog" id="gprog"></span>${G.pace ? `<span class="gpacetag">⏱ ${G.pace} s</span>` : ''}<span class="sp"></span><a class="gset" href="#/gush" data-gclose aria-label="Change decks">Decks</a><button class="iconbtn gx" data-gclose aria-label="Close">×</button></div><div class="gfeed" id="gfeed"></div>`;
  document.body.appendChild(ov); document.documentElement.classList.add('gushing');
  const feed = $('#gfeed');
  const io = new IntersectionObserver(es => { for (const x of es) if (x.isIntersecting && x.target.dataset.gi != null) { const i = +x.target.dataset.gi; if (i + 1 > G.seen) G.seen = i + 1; G.cur = i; gEnsure(); gTimerStart(i); } }, {root: feed, threshold: 0.6});
  new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => { if (n.nodeType === 1 && n.classList.contains('gslide')) io.observe(n); }))).observe(feed, {childList: true});
  gEnsure();
  ov.addEventListener('click', ev => {
    const t = ev.target;
    if (t.closest('[data-gclose]')) { ev.preventDefault(); gushClose(t.closest('a') ? '#/gush' : null); return; }
    if (t.closest('[data-gopen]')) { gTimerStop(); ov.hidden = true; document.documentElement.classList.remove('gushing'); return; }   // keep the feed to come back to
    const g = t.closest('[data-ggrade]'); if (g) { ev.stopPropagation(); gGrade(+g.dataset.gi, g.dataset.ggrade === '1'); return; }
    if (t.closest('[data-gstop]')) { gushClose('#/'); return; }
    if (t.closest('[data-gmore]')) { const s = $('#gsum'); G.fam = new Set(); G.blockStart = G.cards.length; G.gate = false; if (s) { s.removeAttribute('id'); s.classList.add('done'); } gEnsure(); gGo(G.blockStart); return; }
    const f = t.closest('[data-gflip]'); if (f && !t.closest('a,button')) gFlip(+f.dataset.gflip);
  });
  ov.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') { gushClose(null); return; }
    if (ev.key === ' ' || ev.key === 'Enter') { if (!ev.target.closest('button,a')) { ev.preventDefault(); gFlip(G.cur); } }
    else if (ev.key === 'ArrowDown' || ev.key === 'j') { ev.preventDefault(); gGo(G.cur + 1); }
    else if (ev.key === 'ArrowUp' || ev.key === 'k') { ev.preventDefault(); gGo(G.cur - 1); }
    else if (ev.key === '1') gGrade(G.cur, false); else if (ev.key === '2') gGrade(G.cur, true);
  });
  setTimeout(() => { const c = $('.gcard', ov); if (c) c.focus({preventScroll: true}); }, 50);
  return true;
}
function gushClose(to, keep) {
  gTimerStop();
  const ov = $('#gush'); if (ov) ov.remove(); document.documentElement.classList.remove('gushing'); G.open = false;
  if (keep) return;   // the link inside the card navigates on its own
  if (route().view === 'gush' && route().arg === 'play') { if (to || !(window.__navI > 0)) location.replace(to || '#/gush'); else history.back(); }
  else if (to) go(to);
}
function viewGush(arg) {
  const cfg = gCfg(), groups = gGroups(), S = new Set(cfg.sys), n = gPool(cfg).length, box = gBox();
  const known = Object.values(box).filter(b => b.b >= 4).length, unsure = Object.values(box).filter(b => b.b === 1).length;
  return `<article class="entry gushset"><div class="ehead"><div class="crumb">Swipe to review</div><h1>Gush!</h1>
    <p class="muted">Short flash cards you can swipe through like a feed: tap to flip, swipe up for the next one. Questions rotate between key features, pathophysiology, key investigations, clinical picture and treatment, and each deck holds only one disease from a family. Cards you are not sure about come back sooner. A break point appears every ${cfg.every} cards.</p></div>
    <section class="card"><h3>Cards</h3><div class="gchecks">${GUSH_TYPES.map(([k, l, h]) => `<label class="gchk"><input type="checkbox" data-gtype="${k}"${cfg.types.includes(k) ? ' checked' : ''}><span><b>${l}</b><small>${h}</small></span></label>`).join('')}</div></section>
    <section class="card"><h3>Groups <span class="faint small">${S.size ? S.size + ' selected' : 'all groups'}</span></h3>
      <div class="actions" style="margin-bottom:10px"><button class="btn${S.size ? '' : ' on'}" data-gsysall>All groups</button>${S.size ? '<button class="btn ghost" data-gsysnone>Clear</button>' : ''}</div>
      <div class="gchecks sys">${groups.map(([g, c]) => `<label class="gchk"><input type="checkbox" data-gsys="${esc(g)}"${S.has(g) ? ' checked' : ''}><span><b>${esc(sysLabel(g))}</b><small>${c}</small></span></label>`).join('')}</div></section>
    <section class="card"><h3>Options</h3><label class="gchk wide"><input type="checkbox" data-gyellow${cfg.yellow ? ' checked' : ''}><span><b>Include 🟡 pages</b><small>pages still waiting for a disease-specific source (bullets may be thinner)</small></span></label>
      <div class="gpace${cfg.paceOn ? ' on' : ''}"><label class="gchk wide"><input type="checkbox" data-gpace${cfg.paceOn ? ' checked' : ''}><span><b>⏱ Pick up the pace</b><small>countdown on every card — when time runs out the card flips by itself: Too slow!</small></span></label>
        <div class="seg" role="group" aria-label="Seconds per card">${[6, 8, 10, 15, 18].map(v => `<button data-gpacesec="${v}" class="${cfg.pace === v ? 'on' : ''}"${cfg.paceOn ? '' : ' disabled'}>${v} s</button>`).join('')}</div></div>
      <div class="actions" style="margin-top:10px"><span class="small muted">Break every</span><div class="seg">${[20, 25, 30].map(v => `<button data-gevery="${v}" class="${cfg.every === v ? 'on' : ''}">${v}</button>`).join('')}</div></div></section>
    <div class="gstart"><button class="btn primary big" data-gstart${n ? '' : ' disabled'}>Start Gush! · ${n.toLocaleString()} cards${cfg.paceOn ? ` · ⏱ ${cfg.pace} s` : ''}</button>
      <span class="small muted">On this device: ${known} known · ${unsure} not sure${Object.keys(box).length ? ` · <button class="linkbtn" data-greset>reset progress</button>` : ''}</span></div>
    <div class="foot"><div>Progress is stored only on this device. For education only — not a diagnostic tool.</div></div></article>`;
}
function gushEvents() {
  document.addEventListener('change', ev => {
    const t = ev.target; if (!t.closest || !t.closest('.gushset')) return;
    const cfg = gCfg();
    if (t.dataset.gtype) { const s = new Set(cfg.types); t.checked ? s.add(t.dataset.gtype) : s.delete(t.dataset.gtype); cfg.types = GUSH_TYPES.map(x => x[0]).filter(k => s.has(k)); }
    else if (t.dataset.gsys) { const s = new Set(cfg.sys); t.checked ? s.add(t.dataset.gsys) : s.delete(t.dataset.gsys); cfg.sys = [...s]; }
    else if ('gyellow' in t.dataset) cfg.yellow = t.checked;
    else if ('gpace' in t.dataset) cfg.paceOn = t.checked;
    else return;
    LS.set('gushCfg', cfg); const y = window.scrollY; render(); window.scrollTo(0, y);
  });
  document.addEventListener('click', ev => {
    const t = ev.target.closest('button'); if (!t || !t.closest('.gushset')) return;
    const cfg = gCfg(), d = t.dataset;
    if ('gstart' in d) { if (gushOpen()) location.hash = '#/gush/play'; return; }
    if ('gsysall' in d || 'gsysnone' in d) cfg.sys = [];
    else if (d.gevery) cfg.every = +d.gevery;
    else if (d.gpacesec) { cfg.pace = +d.gpacesec; cfg.paceOn = true; }
    else if ('greset' in d) { if (!confirmReset()) return; LS.set('gushBox', {}); }
    else return;
    LS.set('gushCfg', cfg); const y = window.scrollY; render(); window.scrollTo(0, y);
  });
}
function confirmReset() { const b = $('[data-greset]'); if (b && b.dataset.armed) return true; if (b) { b.dataset.armed = 1; b.textContent = 'tap again to reset'; } return false; }
function gushRoute(view, arg) {   // called from render(): show, restore or drop the overlay to match the URL
  const ov = $('#gush');
  if (view === 'gush' && arg === 'play') {
    if (ov && ov.hidden) { ov.hidden = false; document.documentElement.classList.add('gushing'); G.open = true; setTimeout(() => { gGo(G.cur); gTimerStart(G.cur); }, 0); }
    else if (!ov && !gushOpen()) location.replace('#/gush');
  } else if (ov && !ov.hidden) { ov.remove(); document.documentElement.classList.remove('gushing'); G.open = false; }
  else if (ov && ov.hidden && view === 'gush') { ov.remove(); G.open = false; }
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
    <p>Type a sign, a disease, an abbreviation, or several findings in plain words. Misspellings are fine.</p>
    <div class="tries">${['droopy eyelid double vision worse in evening', 'INO', 'CIDP', 'babinsky', 'thunderclap', 'arm and leg weakness'].map(t => `<button data-try="${esc(t)}">${esc(t)}</button>`).join('')}</div>
    <a class="casecta" href="#/case">${ICON_CASE}<span><b>Describe a whole case</b><small>Type, dictate${AI.ok ? ' or photograph' : ''} a history and get matching diseases</small></span><i aria-hidden="true">→</i></a></section>
  ${D.ns.length ? `<section class="card stcard"><h3>Neuroscience</h3><p class="small" style="margin:0"><a href="#/browse/ns">Tracts, circuits and neuroanatomy <b>${D.ns.length}</b> pages</a> — pathway, function, bedside test and lesion for each.</p></section>` : ''}
  <a class="casecta" href="#/rounds">${ICON_TRAIN}<span><b>Ward rounds with Monk</b><small>Ask, examine, localize and build the differential step by step, with feedback on your reasoning</small></span><i aria-hidden="true">→</i></a>
  ${typeof podHomeHTML === 'function' ? podHomeHTML() : ''}
  ${nwHomeHTML()}
  ${recentHomeHTML()}
  <section class="card stcard"><h3>Data status</h3><p class="small" style="margin:0"><a href="#/browse/status/g">🟢 In depth <b>${D.dx.filter(d => d.st === 'g').length}</b></a> · <a href="#/browse/status/y">🟡 Awaiting more data <b>${D.dx.filter(d => d.st === 'y').length}</b></a> <span class="muted">— 🟡 pages are waiting for a disease-specific monograph article.</span></p></section>
  ${hist.length ? `<h2 class="sec">Recently opened</h2><div class="chips">${hist.map(e => `<a class="chip" href="${link(e)}">${esc(e.name)}</a>`).join('')}</div>` : ''}
  ${arts.length ? `<h2 class="sec">Clinical overviews <span class="count">${arts.length}</span></h2><div class="arts">${arts.map(a => `<a class="art" href="#/article/${esc(a.id)}"><b>${esc(a.title)}</b><span>${esc(a.body[0])}</span></a>`).join('')}</div>` : ''}
  <h2 class="sec">Curated diseases <span class="count">${cur.length}</span></h2>
  <div class="topics">${topics}<details><summary><span>Core bedside signs</span><span class="faint small">${csigns.length}</span></summary><div class="chips">${csigns.map(s => `<a class="chip" href="${link(s)}">${esc(s.name)}</a>`).join('')}</div></details></div>
  <div class="homefoot"><span>${D.signs.length.toLocaleString()} signs · ${D.dx.length.toLocaleString()} diseases${D.ns.length ? ` · ${D.ns.length} neuroscience` : ''}</span><span>Data ${esc(v.version)}</span><a href="#/install">Install for offline use</a><span>For education only — not a diagnostic tool</span></div>`;
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
  const nsL = r.ns || [];
  if (state.resTabQ !== r.q) { state.resTab = 'dx'; state.resTabQ = r.q; }
  if (state.resTab === 'ns' && !nsL.length) state.resTab = 'dx';
  if (D.bodyReady && !r.dx.length && r.signs.length) state.resTab = 'sign'; else if (r.dx.length && !r.signs.length && state.resTab !== 'ns') state.resTab = 'dx';
  if (!r.dx.length && !r.signs.length && nsL.length) state.resTab = 'ns';
  const kb = r.fixed ? `<p class="dym kbfix">Thai keyboard detected. Showing results for “<b>${esc(r.fixed)}</b>”. <span class="muted">Suggestions:</span> ${r.dx.concat(r.signs).slice(0, 5).map(x => `<a class="chip" href="${link(x.e)}">${esc(x.e.name)}</a>`).join(' ')}</p>` : '';
  const part = r.partial ? `<p class="dym muted">No entry matches every finding; showing entries that match some of them.</p>` : '';
  const readas = r.free ? `<p class="dym readas"><span class="muted">Read as ${r.free.length} findings:</span> ${r.free.map((t, i) => `<button class="fchip" data-dropf="${i}" title="Remove this finding">${esc(t)}<span aria-hidden="true">×</span></button>`).join(' ')} <span class="small muted">Ranked by how many findings each entry explains. Tap a finding to drop it.</span></p>` : '';
  const col = (k, title, list) => `<section class="rescol${state.resTab === k ? ' show' : ''}"><h2 class="sec">${title} <span class="count">${list.length}</span></h2>
    ${list.length ? `<ul class="res">${list.slice(0, cap(list.length)).map(x => itemHTML(x, r.terms)).join('')}</ul>${list.length > 60 ? `<p class="small muted more">Showing 60 of ${list.length}. Add another word to narrow.</p>` : ''}` : '<p class="empty">No matches</p>'}</section>`;
  const tabs = `<div class="seg restabs"><button data-rt="dx" class="${state.resTab === 'dx' ? 'on' : ''}">Diseases ${r.dx.length}</button><button data-rt="sign" class="${state.resTab === 'sign' ? 'on' : ''}">Signs ${r.signs.length}</button><button data-rt="ns" class="${state.resTab === 'ns' ? 'on' : ''}">Neuroscience ${nsL.length}</button></div>`;
  if (!r.dx.length && !r.signs.length && !nsL.length) return `<div class="empty"><p><b>No match for “${esc(r.q)}”.</b></p><p class="small">Try fewer words or an abbreviation. You can type findings in plain words, for example “droopy eyelid, double vision worse in the evening”.</p></div>`;
  if (state.caseWork && state.caseWork.q === r.q && r.dx.length) r = Object.assign({}, r, {dx: caseFitSort(r.dx, state.caseText || '')});   // case results: time course and age first (v1.7)
  return `${kb}${caseWorkHTML(r)}${readas}${summaryPanel(r)}${dym}${part}${tabs}<div class="rescols one">${col('dx', 'Diseases', r.dx)}${col('sign', 'Signs', r.signs)}${col('ns', 'Neuroscience', nsL)}</div>`;
}
function entryHead(e) {
  const kind = isSignLike(e) ? 'Sign' : (e.cat ? e.cat.charAt(0).toUpperCase() + e.cat.slice(1) : 'Disease');
  const group = e.t === 'dx' && e.sys && e.sys[0] ? ` · <a href="#/browse/sys/${e.sys[0]}">${esc(sysLabel(e.sys[0]))}</a>` : '';
  const ab = e.ab || [];
  const waiting = state.cmp.length === 1 && state.cmp[0] !== e.id ? byId.get(state.cmp[0]) : null;
  return `<div class="ehead"><div class="crumb"><span>${kind}${group}</span>${e.cur ? '<span class="st cur">curated</span>' : ''}${statusChip(e)}${stBadge(e)}</div>
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
    ${nsChips(e)}
    ${detHTML(e.det, DET_SIGN, 's-depth', e.srcmap)}
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
  return `<li><b>${esc(b.title)}</b>${b.edition ? `, ${esc(b.edition)}` : ''}${b.publisher ? `. ${esc(b.publisher)}` : ''}${r.where ? ` — ${u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(r.where)} ↗</a>` : esc(r.where)}` : ''}${r.auto ? ' <span class="st auto" title="Found by scanning the books in the library">also covered</span>' : ''} <a class="shlink" href="#/browse/shadow/${encodeURIComponent(r.book)}" title="See every page that uses this book, by chapter">Shadow</a></li>`;
}

// biomarker pages that a disease page mentions (by antibody short name) or that point to it
let BM_KEYS = null;
function bmKeys() {
  if (BM_KEYS) return BM_KEYS;
  const rx = k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  BM_KEYS = D.dx.filter(d => d.cat === 'biomarker').map(b => {
    const core = b.name.replace(/^Anti-/, '').replace(/ antibod(y|ies).*$/, '').trim();
    const ks = [...new Set([core, ...(b.ab || []).map(a => a.replace(/^anti-?/i, '').replace(/ antibody$/i, '').trim())])].filter(k => k.length >= 2 && k.length <= 24);
    const strong = ks.filter(k => k.length >= 3 && (/\d/.test(k) || (k.match(/[A-Z]/g) || []).length >= 2) && !/\s/.test(k));
    const reAnti = new RegExp('anti-?\\s?(' + ks.map(rx).join('|') + ')(?![A-Za-z0-9])', 'i');
    const reStrong = strong.length ? new RegExp('(^|[^A-Za-z0-9-])(' + strong.map(rx).join('|') + ')(?![A-Za-z0-9])') : null;
    return {b, test: t => reAnti.test(t) || (reStrong ? reStrong.test(t) : false)};
  });
  return BM_KEYS;
}
// fungal / infectious pathogen pages, linked from disease pages that name the organism
let PG_KEYS = null;
function pgKeys() {
  if (PG_KEYS) return PG_KEYS;
  const extra = {dematiaceous: ['cladophialophora', 'exserohilum', 'dematiaceous', 'phaeohyphomycosis'], mucorales: ['mucor', 'mucormycosis', 'rhizopus'], scedosporium: ['scedospor', 'lomentospora']};
  PG_KEYS = D.dx.filter(d => d.cat === 'pathogen').map(b => {
    const base = b.name.replace(/\s*\(pathogen\)\s*$/i, '').trim();
    const g = base.split(/[\s/]+/)[0].toLowerCase();
    const sp = base.split(/\s+/)[1] || '';
    let ks = extra[g] || [g.slice(0, Math.max(6, g.length - 2))];
    if (/^(neoformans|gattii)$/i.test(sp)) ks = [sp.toLowerCase()];
    const re = new RegExp('\\b(' + ks.join('|') + ')', 'i');
    return {b, test: t => re.test(t)};
  });
  return PG_KEYS;
}
function pgFor(e) {
  const txt = [e.name, e.formal, e.simple, ...(e.feat || []), ...(e.inv || []), e.more, e.det ? JSON.stringify(e.det) : ''].filter(Boolean).join(' \n ');
  return pgKeys().filter(({b, test}) => b !== e && test(txt)).map(x => x.b);
}
function bmFor(e) {
  if (e.cat === 'biomarker') return [];
  const txt = [e.formal, e.simple, ...(e.feat || []), ...(e.inv || []), e.more, e.det ? JSON.stringify(e.det) : ''].filter(Boolean).join(' \n ');
  return bmKeys().filter(({test}) => test(txt)).map(x => x.b);
}
const NS_KIND = {tract: 'Tracts and pathways', reflex: 'Reflex arcs', nucleus: 'Nuclei and grey matter', region: 'Regions and lobes', circuit: 'Circuits and networks', system: 'Functional systems', vascular: 'Blood supply and CSF', transmitter: 'Neurotransmitter systems', physiology: 'Cellular physiology', cognition: 'Cognitive and behavioural networks', development: 'Development'};
const DET_NS = [['patho', 'Anatomy and physiology'], ['clinical', 'Clinical correlation'], ['diagnosis', 'Testing at the bedside and in the lab'], ['treatment', 'Lesion syndromes'], ['prognosis', 'Development, plasticity and recovery']];
function nsLinks(names) { return (names || []).map(n => resolveFind(n)).filter(Boolean); }
function nsChips(e) {
  if (!D.ns || !D.ns.length || e.cat === 'neuroscience') return '';
  const n = norm(e.name);
  const hits = D.ns.filter(x => x.ns && [...(x.ns.dx || []), ...(x.ns.signs || [])].some(k => norm(k) === n));
  return hits.length ? `<h2 class="sec" id="d-ns">Neuroscience behind it <span class="count">${hits.length}</span></h2><div class="chips">${hits.map(b => `<a class="chip" href="${link(b)}">${esc(b.name)}</a>`).join('')}</div>` : '';
}
function viewNs(e) {
  const x = e.ns || {}, c = e.case;
  const rel = (e.ddx || []).map(d => ({e: byId.get(d.id), pt: d.pt})).filter(d => d.e);
  const dxs = nsLinks(x.dx), sgs = nsLinks(x.signs);
  const steps = [['Origin', x.origin], ['Course', x.course], ['Decussation', x.decussation], ['Termination', x.termination]].filter(s => s[1]);
  const nav = [['n-glance', 'At a glance'], steps.length && ['n-path', 'Pathway'], x.lesions && ['n-les', 'Lesions'], e.feat && ['n-feat', 'Key facts'], e.inv && ['n-test', 'How to test'], e.det && ['n-depth', 'In depth'], c && ['n-case', 'Case'], e.qx && e.qx.length && ['n-qx', 'Questions'], ['n-rel', 'Related'], ['n-read', 'Read']].filter(Boolean);
  return `<div class="entry"><div>${entryHead(e)}
    <div class="toolrow">${langSeg()}</div>${defText(e)}
    ${jumpNav(nav)}
    <h2 class="sec" id="n-glance">At a glance</h2>
    <dl class="glance">
      ${x.kind ? `<dt>Type</dt><dd><a class="chip" href="#/browse/ns">${esc(NS_KIND[x.kind] || x.kind)}</a></dd>` : ''}
      ${x.level ? `<dt>Level</dt><dd>${esc(x.level)}</dd>` : ''}
      ${x.function ? `<dt>Function</dt><dd>${esc(x.function)}</dd>` : ''}
      ${x.blood ? `<dt>Blood supply</dt><dd>${esc(x.blood)}</dd>` : ''}
      ${x.transmitter ? `<dt>Transmitter</dt><dd>${esc(x.transmitter)}</dd>` : ''}
      <dt>Localization</dt><dd><div class="chips">${(e.loc || []).map(l => `<a class="chip" href="#/browse/loc/${l}">${esc(locLabel(l))}</a>`).join('') || '<span class="muted small">—</span>'}</div></dd>
    </dl>
    ${steps.length ? `<h2 class="sec" id="n-path">Pathway</h2><ol class="nspath">${steps.map(([k, v]) => `<li><b>${k}</b><span>${esc(v)}</span></li>`).join('')}</ol>` : ''}
    ${x.lesions && x.lesions.length ? `<h2 class="sec" id="n-les">What a lesion does</h2><div class="tw"><table class="nsles"><thead><tr><th>Lesion site</th><th>Result</th></tr></thead><tbody>${x.lesions.map(l => `<tr><td>${esc(l.site)}</td><td>${esc(l.effect)}</td></tr>`).join('')}</tbody></table></div>` : ''}
    ${e.feat ? `<h2 class="sec" id="n-feat">Key facts</h2><ul class="list">${e.feat.map(f => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
    ${e.inv ? `<h2 class="sec" id="n-test">How to test it</h2><ul class="list">${e.inv.map(f => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
    ${detHTML(e.det, DET_NS, 'n-depth', e.srcmap)}
    ${c ? `<h2 class="sec" id="n-case">Localization case <span class="st draft">invented for teaching</span></h2>
      <div class="case"><dl><dt>Patient</dt><dd>${esc(c.who)}</dd><dt>Story</dt><dd>${esc(c.story)}</dd><dt>Exam</dt><dd>${esc(c.exam)}</dd><dt>Tests</dt><dd>${esc(c.tests)}</dd></dl>
      <div class="q">${esc(c.q)}</div><button class="btn" data-reveal style="margin-top:10px">Show answer</button><div class="a" hidden>${esc(c.a)}</div></div>` : ''}
    ${e.qx && e.qx.length ? `<h2 class="sec" id="n-qx">Board-style questions <span class="st draft">invented for teaching</span></h2>
      ${e.qx.map(q => `<div class="case bd"><p class="prose">${esc(q.stem)}</p><div class="q">${esc(q.q)}</div><ol class="opts" type="A">${q.opts.map(t => `<li>${esc(t)}</li>`).join('')}</ol>
      <button class="btn" data-reveal style="margin-top:6px">Show answer</button><div class="a" hidden><b>${LET[q.ans]}. ${esc(q.opts[q.ans])}</b> — ${esc(q.why)}</div></div>`).join('')}` : ''}
    <h2 class="sec" id="n-rel">Related</h2>
    ${rel.length ? `<ul class="ddx">${rel.map(r => `<li><a href="${link(r.e)}">${esc(r.e.name)}</a><span class="pt">${esc(r.pt)}</span></li>`).join('')}</ul>` : ''}
    ${dxs.length ? `<h3 class="sec">Diseases that involve it</h3><div class="chips">${dxs.map(d => `<a class="chip" href="${link(d)}">${esc(d.name)}</a>`).join('')}</div>` : ''}
    ${sgs.length ? `<h3 class="sec">Signs that test it</h3><div class="chips">${sgs.map(d => `<a class="chip" href="${link(d)}">${esc(d.name)}</a>`).join('')}</div>` : ''}
    <h2 class="sec" id="n-read">Read</h2>${e.read && e.read.length ? `<ul class="list small">${e.read.map(bookRef).join('')}</ul>` : ''}
    ${footer(e)}</div>${axisHTML(e.loc)}</div>`;
}
function viewDx(e) {
  if (e.cat === 'neuroscience') return viewNs(e);
  const signs = (e.signs || []).map(id => byId.get(id)).filter(Boolean);
  const c = e.case;
  const ddx = (e.ddx || []).map(x => ({e: byId.get(x.id), pt: x.pt})).filter(x => x.e);
  const variants = (e.variants || []).map(id => byId.get(id)).filter(Boolean);
  const tempo = (e.tempo || []).join(' · ') || 'Not specified';
  const nav = [['d-glance', 'At a glance'], e.feat && ['d-feat', 'Features'], (e.inv || e.more) && ['d-inv', 'Tests'], e.det && ['d-depth', 'In depth'], c && ['d-case', 'Case'], e.qx && e.qx.length && ['d-qx', 'Questions'], ['d-ddx', 'Differential'], ['d-sim', 'Similar'], ['d-signs', 'Signs'], ['d-read', 'Read']].filter(Boolean);
  return `<div class="entry"><div>${entryHead(e)}
    <div class="toolrow">${langSeg()}</div>${defText(e)}
    ${jumpNav(nav)}
    ${nwForPage(e)}
    <h2 class="sec" id="d-glance">At a glance</h2>
    <dl class="glance">
      <dt>Tempo ${autoChip(e, 'tempo')}</dt><dd>${esc(tempo)}${e.tempoNote ? `<div class="small muted">${esc(e.tempoNote)}</div>` : ''}</dd>
      <dt>Localization ${autoChip(e, 'loc')}</dt><dd><div class="chips">${(e.loc || []).map(l => `<a class="chip" href="#/browse/loc/${l}">${esc(locLabel(l))}</a>`).join('') || '<span class="muted small">Not specified</span>'}</div></dd>
      ${e.ichd ? `<dt>ICHD-3 (2018)</dt><dd><b>${esc(e.ichd.code)}</b> ${esc(e.ichd.title || '')}${/^A/.test(e.ichd.code) ? ' <span class="st auto">appendix</span>' : ''}${e.ichd.note ? `<div class="small muted">${esc(e.ichd.note)}</div>` : ''}</dd>` : ''}
      <dt>Group ${autoChip(e, 'sys')}</dt><dd><div class="chips">${(e.sys || []).map(s => `<a class="chip" href="#/browse/sys/${s}">${esc(sysLabel(s))}</a>`).join('')}</div></dd>
    </dl>
    ${e.feat ? `<h2 class="sec" id="d-feat">Key features</h2><ul class="list">${e.feat.map(f => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
    ${e.inv ? `<h2 class="sec" id="d-inv">Key investigations</h2><ul class="list">${e.inv.map(f => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
    ${!e.inv && e.more ? `<h2 class="sec" id="d-inv">Investigations &amp; management notes</h2><p class="prose">${esc(e.more)}</p>` : ''}
    ${(() => { const bm = bmFor(e); return bm.length ? `<h2 class="sec" id="d-bm">Antibody / biomarker pages <span class="count">${bm.length}</span></h2><div class="chips">${bm.map(b => `<a class="chip" href="${link(b)}">${esc(b.name)}</a>`).join('')}</div>` : ''; })()}
    ${(() => { const pg = pgFor(e); return pg.length ? `<h2 class="sec" id="d-pg">Pathogen pages <span class="count">${pg.length}</span></h2><div class="chips">${pg.map(b => `<a class="chip" href="${link(b)}">${esc(b.name.replace(/ \(pathogen\)$/, ''))}</a>`).join('')}</div>` : ''; })()}
    ${nsChips(e)}
    ${detHTML(e.det, DET_DX, 'd-depth', e.srcmap)}
    ${e.mx && e.mx.length ? `<h2 class="sec" id="d-mx">Work-up and management in practice <span class="st draft">agent summary for expert review</span></h2><ul class="list">${e.mx.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${(() => { const ms = meqCases().filter(m => m.answerId === e.id); return ms.length ? `<h2 class="sec" id="d-meq">MEQ case on this disease</h2><div class="chips">${ms.map(m => `<a class="chip" href="#/meq/${esc(m.id)}">${esc(m.title)}</a>`).join('')}</div><p class="small faint">Try the case before reading on: the answer is this page.</p>` : ''; })()}
    ${c ? `<h2 class="sec" id="d-case">Illustrative case <span class="st draft">invented for teaching</span></h2>
      <div class="case"><dl><dt>Patient</dt><dd>${esc(c.who)}</dd><dt>Story</dt><dd>${esc(c.story)}</dd><dt>Exam</dt><dd>${esc(c.exam)}</dd><dt>Tests</dt><dd>${esc(c.tests)}</dd></dl>
      <div class="q">${esc(c.q)}</div><button class="btn" data-reveal style="margin-top:10px">Show answer</button><div class="a" hidden>${esc(c.a)}</div>
      ${e.read && e.read.length ? `<div class="readmore"><span class="reftag">Read</span> ${e.read.map(refText).join('; ')}</div>` : ''}</div>` : ''}
    ${e.qx && e.qx.length ? `<h2 class="sec" id="d-qx">Board-style questions <span class="st draft">invented for teaching</span></h2>
      ${e.qx.map(x => `<div class="case bd"><p class="prose">${esc(x.stem)}</p><div class="q">${esc(x.q)}</div><ol class="opts" type="A">${x.opts.map(t => `<li>${esc(t)}</li>`).join('')}</ol>
      <button class="btn" data-reveal style="margin-top:6px">Show answer</button><div class="a" hidden><b>${LET[x.ans]}. ${esc(x.opts[x.ans])}</b> — ${esc(x.why)}</div></div>`).join('')}` : ''}
    <h2 class="sec" id="d-ddx">Differential — how to tell apart</h2>
    ${ddx.length ? `<ul class="ddx">${ddx.map(x => `<li><a href="${link(x.e)}">${esc(x.e.name)}</a><span class="pt">${esc(x.pt)}</span><button class="btn pair" data-pair="${esc(e.id)}|${esc(x.e.id)}" title="Compare side by side">${ICON.cmp}Compare</button></li>`).join('')}</ul>` : '<p class="small muted">No curated differential yet — see similar entries below.</p>'}
    <h2 class="sec" id="d-sim">Similar entries <span class="st auto">computed</span></h2><div id="simbox"><p class="small muted">Loading…</p></div>
    <h2 class="sec" id="d-signs">Signs linked to this disease</h2>
    ${signs.length ? `<div class="chips">${signs.map(s => `<a class="chip" href="${link(s)}">${esc(s.name)}</a>`).join('')}</div>` : '<p class="muted small">No linked signs yet.</p>'}
    ${e.more && e.inv ? `<details style="margin-top:22px"><summary class="more-toggle">Notes from Neuro Exam Assistant</summary><p class="prose small" style="margin-top:8px">${esc(e.more)}</p></details>` : ''}
    <h2 class="sec" id="d-read">Read</h2>${e.read && e.read.length ? `<ul class="list small">${e.read.map(bookRef).join('')}</ul>` : ''}${(e.read || []).some(r => r.book === 'statpearls') ? '' : `<p class="small"><a href="${esc(statpearlsSearch(e.name))}" target="_blank" rel="noopener">Search StatPearls (NCBI Bookshelf) for this topic ↗</a></p>`}
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
// Shadow a book: every page that cites a given book, grouped by the chapter / section it points to
let SHADOW = null;
// A Read entry may cite several chapters/cases ("Case 1 …; Case 21 …"): give each its own group so diseases sharing a case sit together.
function shParts(w) {
  w = (w || '').trim();
  return w ? w.split(/\s*;\s*(?=(?:Case|Chapter|Ch\.?|Section|Part|Topic|บทที่)\s*\d)/i).map(x => x.trim()).filter(Boolean) : [''];
}
function shadowIndex() {
  if (SHADOW) return SHADOW;
  SHADOW = new Map();
  for (const e of [...D.dx, ...D.ns]) {
    const seen = new Set();
    for (const r of e.read || []) {
      const k = r.book + '|' + (r.where || '') + '|' + (r.auto ? 1 : 0);
      if (!r.book || seen.has(k)) continue; seen.add(k);
      if (!SHADOW.has(r.book)) SHADOW.set(r.book, {refs: [], pages: new Set(), direct: new Set()});
      const s = SHADOW.get(r.book);
      for (const w of shParts(r.where)) s.refs.push({e, where: w, auto: !!r.auto});
      s.pages.add(e.id); if (!r.auto) s.direct.add(e.id);
    }
  }
  return SHADOW;
}
const shadowPins = () => LS.get('shadowBooks', []).filter(k => shadowIndex().has(k));
function shadowList(v) {
  const fold = t => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const toks = fold(v).split(/[\s,;.]+/).filter(Boolean);
  const rows = [...shadowIndex().entries()].map(([k, s]) => ({k, s, b: D.meta.books[k] || {}}))
    .filter(x => { if (!toks.length) return true; const hay = fold([x.k, x.b.short, x.b.title, x.b.author, x.b.edition, x.b.publisher].join(' ')); return toks.every(t => hay.includes(t)); })
    .sort((a, b) => b.s.pages.size - a.s.pages.size || (a.b.short || a.k).localeCompare(b.b.short || b.k));
  return rows.length ? `<div class="groups shbooks">${rows.map(x => `<a href="#/browse/shadow/${encodeURIComponent(x.k)}"><span>${esc(x.b.short || x.b.title || x.k)}${x.b.edition ? ` <span class="faint small">${esc(x.b.edition)}</span>` : ''}</span><span class="c" title="${x.s.direct.size} cited directly · ${x.s.pages.size} pages in all">${x.s.pages.size}</span></a>`).join('')}</div>` : '<p class="empty">No book matches.</p>';
}
function viewShadow(key) {
  const idx = shadowIndex();
  if (!key) {
    return `<div class="shadowintro"><span class="shtag">Shadow</span> <span class="small muted">Pick a book that the lexicon uses as a reference. Its pages appear grouped by chapter, so you can read the book alongside the lexicon and see which diseases it covers. The book is then added to Browse as a grey <b>Shadow</b> tab.</span></div>
      <input id="shq" class="shq" type="search" placeholder="Search a book, author, publisher or university… (${idx.size} books)" autocomplete="off" aria-label="Search reference books">
      <div id="shlist">${shadowList('')}</div>`;
  }
  const s = idx.get(key), b = D.meta.books[key] || {};
  if (!s) return `<p class="empty">This book is not cited by any page.</p><p><a href="#/browse/shadow">Choose another book</a></p>`;
  const groups = new Map();
  for (const r of s.refs) { const g = r.where || ''; if (!groups.has(g)) groups.set(g, new Map()); const gm = groups.get(g); if (!gm.has(r.e.id) || !r.auto) gm.set(r.e.id, r); }
  const named = [...groups.keys()].filter(Boolean).sort((a, b) => a.localeCompare(b, undefined, {numeric: true, sensitivity: 'base'}));
  const row = r => `<li><a href="${link(r.e)}">${stDot(r.e)}${esc(r.e.name)}</a>${r.auto ? ' <span class="st auto" title="Found by scanning the book">also covered</span>' : ''}</li>`;
  const sortR = m => [...m.values()].sort((a, b) => (a.auto - b.auto) || a.e.name.localeCompare(b.e.name));
  const loose = groups.get('');
  return `<section class="shadowbox">
      <div class="shhead"><span class="shtag">Shadow</span><a class="small" href="#/browse/shadow">Choose another book</a></div>
      <h3 class="shtitle">${esc(b.title || b.short || key)}</h3>
      <p class="small muted" style="margin:2px 0 8px">${[b.edition, b.publisher].filter(Boolean).map(esc).join(' · ')}</p>
      <p class="small" style="margin:0"><b>${s.pages.size}</b> pages use this book — <b>${s.direct.size}</b> cite it directly${s.pages.size > s.direct.size ? `, ${s.pages.size - s.direct.size} more were found by scanning its text` : ''} · <b>${named.length}</b> chapters / sections</p>
      <div class="actions" style="margin-top:10px"><button class="btn ghost" data-shunpin="${esc(key)}">Remove from Browse</button></div>
    </section>
    ${named.length > 6 ? `<details class="shtoc"><summary>Chapters in this book (${named.length})</summary><ol class="small">${named.map((g, i) => `<li><a href="#" data-jump="sh-${i}">${esc(g)}</a> <span class="faint">${groups.get(g).size}</span></li>`).join('')}</ol></details>` : ''}
    ${named.map((g, i) => `<h3 class="sec shsec" id="sh-${i}">${esc(g)} <span class="count">${groups.get(g).size}</span></h3><ul class="plain">${sortR(groups.get(g)).map(row).join('')}</ul>`).join('')}
    ${loose ? `<details class="shloose"><summary>Pages without a chapter reference <span class="count">${loose.size}</span></summary><ul class="plain">${sortR(loose).map(row).join('')}</ul></details>` : ''}`;
}

// ---- Biomarker finder: markers mentioned in the investigation / diagnosis text of every disease page, grouped by kind (built on first use) ----
const BM_LEX = [
  ['Autoantibodies (neural)', [
    ['AQP4-IgG (aquaporin-4)', 'aqp4|aquaporin'], ['MOG-IgG', '\\bmog\\b'], ['GFAP-IgG', 'gfap (igg|antibod|astrocytopath)|anti-gfap'], ['NMDA receptor (NMDAR)', 'nmda'], ['LGI1', '\\blgi1'], ['CASPR2', 'caspr2'],
    ['AMPA receptor', 'ampa'], ['GABA-B / GABA-A receptor', 'gaba-?b|gaba-?a (receptor|antib)'], ['GAD65', 'gad ?65|\\bgad\\b antib'], ['DPPX', 'dppx'], ['IgLON5', 'iglon5'], ['Glycine receptor', 'glycine receptor|glyr'],
    ['mGluR5 / mGluR1', 'mglur'], ['Amphiphysin', 'amphiphysin'], ['Anti-Hu (ANNA-1)', 'anti-hu\\b|anna-?1'], ['Anti-Yo (PCA-1)', 'anti-yo\\b|pca-?1'], ['Anti-Ri (ANNA-2)', 'anti-ri\\b|anna-?2'], ['Anti-Ma2 / Ta', 'ma2'], ['CV2 / CRMP5', 'crmp-?5|cv2'],
    ['SOX1', '\\bsox1'], ['Anti-Tr (DNER)', 'anti-tr\\b|dner'], ['VGKC complex', 'vgkc|voltage-gated potassium'], ['P/Q-type VGCC', 'vgcc|p/q'], ['Neurexin-3α / contactin / others', 'neurexin|contactin-?2'],
    ['Paraneoplastic antibody panel', 'paraneoplastic (antibody|panel|screen)|onconeural']]],
  ['Autoantibodies (neuromuscular)', [
    ['AChR antibody', 'achr|acetylcholine receptor antib'], ['MuSK', '\\bmusk'], ['LRP4', 'lrp4'], ['Anti-GQ1b', 'gq1b'], ['Anti-GM1', '\\bgm1\\b'], ['Anti-MAG', 'anti-mag|\\bmag\\b antib'], ['Neurofascin-155 / contactin-1 (nodal-paranodal)', 'neurofascin|\\bnf155|contactin-?1|caspr1'],
    ['Anti-ganglioside panel', 'ganglioside'], ['Anti-SRP', 'anti-srp|\\bsrp\\b'], ['Anti-HMGCR', 'hmgcr'], ['Anti-Jo-1 / synthetase', 'jo-?1|synthetase antib'], ['Anti-Mi-2', 'mi-?2'], ['Anti-MDA5', 'mda-?5'], ['Anti-TIF1γ', 'tif-?1'], ['Anti-NXP2', 'nxp-?2'], ['Anti-cN1A', 'cn-?1a'],
    ['Anti-titin / RyR', 'titin|ryanodine'], ['Anti-Sm / Ro / La', 'anti-ro\\b|anti-ssa|ssa/ro|anti-la\\b|anti-ssb']]],
  ['Autoimmune and inflammatory serology', [
    ['ANA', '\\bana\\b|antinuclear'], ['Anti-dsDNA', 'dsdna|double-stranded dna'], ['ANCA (MPO / PR3)', 'anca|mpo-|pr3'], ['Antiphospholipid antibodies', 'antiphospholipid|lupus anticoagulant|anticardiolipin|β2-?glycoprotein'], ['Rheumatoid factor / anti-CCP', 'rheumatoid factor|anti-ccp'],
    ['Complement (C3 / C4 / CH50)', '\\bc3\\b|\\bc4\\b|complement level|ch50'], ['ESR / CRP', '\\besr\\b|\\bcrp\\b|c-reactive'], ['IgG4', 'igg4'], ['Cryoglobulins', 'cryoglobulin'], ['Anti-thyroid antibodies (TPO)', 'anti-tpo|thyroid peroxidase|thyroid antib'], ['Coeliac serology (tTG)', 'ttg|transglutaminase|gliadin'],
    ['HLA typing', '\\bhla-?[a-z]']]],
  ['CSF', [
    ['Oligoclonal bands / IgG index', 'oligoclonal|igg index|intrathecal igg'], ['14-3-3 protein', '14-3-3'], ['RT-QuIC', 'rt-?quic|real-time quaking'], ['Neurofilament light (NfL)', 'neurofilament|\\bnfl\\b'], ['Total tau / phospho-tau', 'p-?tau|phospho-?tau|total tau|\\bt-?tau'],
    ['Amyloid-β 42 (and ratio)', 'aβ ?42|amyloid-?β ?42|abeta|ab42|amyloid ratio'], ['CSF cell count (pleocytosis)', 'pleocytosis|csf (cell count|white cell|leucocyt|leukocyt)'], ['CSF protein / albuminocytological dissociation', 'albuminocytolog|albumino-cytolog|csf protein'], ['CSF glucose (hypoglycorrhachia)', 'hypoglycorrhachia|csf glucose|low csf glucose|csf:serum glucose'],
    ['CSF lactate', 'csf lactate'], ['Adenosine deaminase (ADA)', '\\bada\\b|adenosine deaminase'], ['Cryptococcal antigen / India ink', 'cryptococcal antigen|crag|india ink'], ['Xanthochromia', 'xanthochromia'], ['CSF neopterin / biogenic amines', 'neopterin|biogenic amine|5-htp|homovanillic'],
    ['CSF opening pressure', 'opening pressure'], ['CSF cytology / flow cytometry', 'csf cytology|flow cytometry'], ['CSF PCR (viral / bacterial)', 'csf pcr|pcr of csf|hsv pcr|vzv pcr|multiplex pcr|metagenomic'], ['CSF IL-6 / IL-10 / CXCL13', 'cxcl13|il-?10|il-?6']]],
  ['Blood and urine chemistry', [
    ['Creatine kinase (CK)', '\\bck\\b|creatine kinase|\\bcpk'], ['Lactate (blood)', 'serum lactate|blood lactate|lactate level|raised lactate|elevated lactate'], ['Ammonia', 'ammonia'], ['Vitamin B12 / methylmalonic acid / homocysteine', 'b12|cobalamin|methylmalonic|homocysteine'], ['Folate', 'folate'],
    ['Copper / ceruloplasmin', 'ceruloplasmin|serum copper|24-?h(our)? urinary copper|urine copper'], ['Thiamine (B1)', 'thiamine'], ['Vitamin E', 'vitamin e\\b'], ['Vitamin D / calcium / PTH', 'vitamin d|parathyroid|\\bpth\\b|hypocalc|hypercalc'], ['Thyroid function (TSH / T4)', '\\btsh\\b|thyroid function|free t4'],
    ['HbA1c / glucose tolerance', 'hba1c|glucose tolerance|fasting glucose|haemoglobin a1c'], ['Serum and urine electrophoresis / free light chains', 'immunofixation|protein electrophoresis|spep|free light chain|paraprotein|m-?protein'], ['Serum ACE / soluble IL-2R', '\\bace\\b|serum ace|il-2 receptor|il-2r'],
    ['Very-long-chain fatty acids', 'very long chain fatty|vlcfa'], ['Lysosomal enzyme assays', 'lysosomal enzyme|leukocyte enzyme|β-?galactosidase|arylsulfatase|hexosaminidase|α-?galactosidase|glucocerebrosidase'], ['Plasma / urine amino acids and organic acids', 'plasma amino|urine organic|organic acid|acylcarnitine|amino acid'],
    ['Urine porphobilinogen / porphyrins', 'porphobilinogen|porphyrin|\\bala\\b|delta-aminolevulinic'], ['Serum sodium / osmolality', 'hyponatr|serum sodium|osmolality'], ['Troponin / BNP', 'troponin|\\bbnp\\b'], ['D-dimer / coagulation', 'd-dimer|coagulation screen|inr\\b|fibrinogen'], ['Ferritin / iron studies', 'ferritin|iron studies|transferrin saturation'],
    ['Lactate : pyruvate / mitochondrial markers (GDF-15, FGF-21)', 'gdf-?15|fgf-?21|lactate[: /]pyruvate'], ['Heavy-metal levels (lead, arsenic, mercury, thallium, manganese)', 'blood lead|lead level|urine arsenic|arsenic level|mercury level|thallium level|heavy metal|manganese level'], ['Toxicology screen / drug levels', 'toxicology|toxicological screen|drug level|serum level of']]],
  ['Haematology and infection tests', [
    ['Blood film / smear', 'blood film|peripheral smear|blood smear'], ['Eosinophil count', 'eosinophil'], ['HIV test (Ag/Ab, viral load, CD4)', '\\bhiv\\b'], ['Syphilis serology (VDRL / TPHA / RPR)', 'vdrl|tpha|\\brpr\\b|syphilis serology|treponem'], ['Tuberculosis tests (IGRA, Xpert, AFB)', 'igra|xpert|afb|tuberculin|mycobacter'],
    ['Hepatitis B / C serology', 'hepatitis [bc]|\\bhbsag|hcv'], ['Autoimmune / viral PCR panels', 'serology|pcr']]],
  ['Genetic tests', [
    ['PMP22 duplication/deletion', 'pmp22'], ['GJB1 (Cx32)', 'gjb1'], ['MPZ / MFN2 (CMT)', '\\bmpz\\b|mfn2'], ['SMN1', 'smn1'], ['SOD1 / C9orf72 / TARDBP / FUS', 'sod1|c9orf72|tardbp|\\bfus\\b'], ['HTT (CAG repeat)', '\\bhtt\\b|cag repeat'], ['DMPK / CNBP (myotonic dystrophy)', 'dmpk|cnbp'], ['DMD (dystrophin)', 'dystrophin gene|\\bdmd\\b gene|dmd mutation'],
    ['FXN (Friedreich)', '\\bfxn|frataxin'], ['Spinocerebellar ataxia (ATXN / CACNA1A)', 'atxn\\d|cacna1a|spinocerebellar ataxia (panel|testing)'], ['NOTCH3 (CADASIL)', 'notch3'], ['HTRA1 / COL4A1', 'htra1|col4a1'], ['MT-TL1 / mtDNA / POLG', 'mt-?tl1|mtdna|polg|m\\.3243'],
    ['APP / PSEN1 / PSEN2 / APOE', 'psen1|psen2|\\bapp\\b gene|apoe'], ['GBA / LRRK2 / SNCA / PRKN / PINK1', '\\bgba\\b|lrrk2|snca|prkn|parkin gene|pink1'], ['MAPT / GRN / TBK1', '\\bmapt|\\bgrn\\b|tbk1'], ['PRNP', 'prnp'], ['SCN1A / SCN2A / KCNQ2 / epilepsy gene panel', 'scn1a|scn2a|kcnq2|epilepsy gene|epilepsy panel'],
    ['CACNA1A / ATP1A3 / KCNA1', 'atp1a3|kcna1'], ['TTR (hereditary amyloid)', '\\bttr\\b|transthyretin'], ['GLA (Fabry)', '\\bgla\\b|fabry'], ['GAA (Pompe)', '\\bgaa\\b|acid α-?glucosidase|acid alpha-?glucosidase'], ['Exome / genome sequencing', 'exome|genome sequencing|next-generation sequencing|gene panel'],
    ['Chromosomal microarray / karyotype', 'microarray|karyotype'], ['Triplet / repeat expansion testing', 'repeat expansion|repeat-primed']]],
  ['Imaging and tracer biomarkers', [
    ['Amyloid PET', 'amyloid pet|amyloid imaging'], ['Tau PET', 'tau pet'], ['FDG-PET', 'fdg|\\bfdg-?pet'], ['DaTscan (dopamine transporter SPECT)', 'datscan|dat-?spect|dopamine transporter'], ['MIBG cardiac scintigraphy', 'mibg'], ['Perfusion / SPECT / ictal SPECT', 'spect'],
    ['MRI DWI / ADC', '\\bdwi\\b|diffusion-?weighted'], ['MRI FLAIR / T2 lesion pattern', 'flair'], ['MR spectroscopy', 'spectroscopy|\\bmrs\\b'], ['Susceptibility imaging (SWI / T2*)', '\\bswi\\b|susceptibility|t2\\*'], ['CT / MR angiography', '\\bcta\\b|\\bmra\\b|angiograph'],
    ['Transcranial Doppler / carotid duplex', 'transcranial doppler|\\btcd\\b|carotid duplex|carotid ultrasound'], ['Nerve / muscle ultrasound', 'nerve ultrasound|muscle ultrasound'], ['Muscle MRI', 'muscle mri'], ['Optical coherence tomography (OCT)', '\\boct\\b|optical coherence'], ['Visual-evoked potentials', 'visual-?evoked|\\bvep\\b']]],
  ['Neurophysiology and tissue', [
    ['EEG pattern (e.g. periodic discharges, extreme delta brush, hypsarrhythmia)', 'hypsarrhythmia|periodic (sharp|discharge|complex)|extreme delta brush|burst-suppression|triphasic'], ['Nerve conduction studies', 'nerve conduction|\\bncs\\b'], ['EMG (needle)', '\\bemg\\b|needle electromyography'], ['Repetitive stimulation / single-fibre EMG', 'repetitive (nerve )?stimulation|single-?fibre|jitter'],
    ['Autonomic function tests (QSART, tilt, sudomotor)', 'qsart|tilt|sudomotor|autonomic function'], ['Skin biopsy (IENFD / α-synuclein)', 'skin biopsy|intra-?epidermal|synuclein seed'], ['Nerve biopsy', 'nerve biopsy|sural'], ['Muscle biopsy', 'muscle biopsy'], ['Brain biopsy / histology', 'brain biopsy'],
    ['Polysomnography / MSLT', 'polysomnograph|\\bpsg\\b|\\bmslt\\b'], ['Neuropsychological testing (MoCA / MMSE)', 'moca|mmse|neuropsycholog']]],
];
let BM_IDX = null;
function bmIndex() {
  if (BM_IDX) return BM_IDX;
  const rx = BM_LEX.map(([g, arr]) => arr.map(([name, src]) => ({g, name, re: new RegExp(src, 'i'), dx: []}))).flat();
  for (const d of D.dx) {
    if (d.cat === 'biomarker') continue;
    const dd = d.det || {};
    const t = [(d.inv || []).join(' \n '), (d.feat || []).join(' \n '), dd.diagnosis || ''].join(' \n ');
    if (!t.trim()) continue;
    for (const m of rx) if (m.re.test(t)) m.dx.push(d);
  }
  BM_IDX = rx.filter(m => m.dx.length);
  return BM_IDX;
}
function bmView() {
  const idx = bmIndex(), groups = new Map();
  for (const m of idx) { if (!groups.has(m.g)) groups.set(m.g, []); groups.get(m.g).push(m); }
  const row = m => {
    const names = m.dx.map(d => d.name.toLowerCase()).join('|');
    const sorted = [...m.dx].sort((a, b) => a.name.localeCompare(b.name));
    return `<details class="bmrow" data-bms="${esc((m.name + '|' + names).toLowerCase())}"><summary>${esc(m.name)} <span class="count">${m.dx.length}</span></summary><div class="chips">${sorted.map(d => `<a class="chip" href="${link(d)}">${esc(d.name)}</a>`).join('')}</div></details>`;
  };
  return `<p class="small muted">Every marker, test or gene that the investigation and diagnosis text of a disease page names, listed across all specialties with the diseases that use it. Type a marker or a disease to filter. Matching is by wording on each page, so open a page to confirm the context.</p>
    <input id="bmq" class="bmq" type="search" placeholder="Filter markers or diseases (e.g. AQP4, CK, 14-3-3, PMP22, EEG)" autocomplete="off">
    <p class="small muted" id="bmcount">${idx.length} markers</p>
    ${[...groups.entries()].map(([g, l]) => `<div class="bmgrp"><h3 class="sec">${esc(g)} <span class="count">${l.length}</span></h3>${l.sort((a, b) => b.dx.length - a.dx.length).map(row).join('')}</div>`).join('')}`;
}
function viewBrowse(arg) {
  const [mode, rawKey] = arg.split('/');
  const key = rawKey ? decodeURIComponent(rawKey) : rawKey;
  const modes = [['sys', 'By group'], ['loc', 'By localization'], ['tempo', 'By tempo'], ['az', 'Diseases A–Z'], ['signs', 'Signs A–Z'], ['bm', 'Biomarkers'], ['pg', 'Pathogens'], ['ns', 'Neuroscience'], ['curated', 'Curated'], ['status', 'Status 🟢/🟡'], ['shadow', 'Shadow a book']];
  const m = mode || 'sys';
  if (m === 'shadow' && key && shadowIndex().has(key)) { const p = LS.get('shadowBooks', []); if (!p.includes(key)) LS.set('shadowBooks', [...p, key]); }
  let body = '';
  const pins = shadowPins();
  const nav = `<div class="seg">${modes.map(([k, l]) => `<button data-browse="${k}" class="${m === k && !(k === 'shadow' && key) ? 'on' : ''}${k === 'shadow' ? ' shpick' : ''}">${l}</button>`).join('')}${pins.map(k => { const sh = (D.meta.books[k] || {}).short || k; return `<span class="shwrap${m === 'shadow' && key === k ? ' on' : ''}"><button class="shadow" data-go="#/browse/shadow/${encodeURIComponent(k)}" title="${esc((D.meta.books[k] || {}).title || k)}">Shadow · ${esc(sh.slice(0, 30))}${sh.length > 30 ? '…' : ''}</button><button class="shx" data-shunpin="${esc(k)}" aria-label="Remove this book from Browse" title="Remove this book — then pick another">×</button></span>`; }).join('')}</div>`;
  if (m === 'shadow') return `<h2 class="sec">Browse</h2>${nav}${viewShadow(key)}`;
  const list = (arr) => `<ul class="plain">${arr.map(e => `<li><a href="${link(e)}">${stDot(e)}${esc(e.name)}</a>${e.cur ? '<span class="st cur">curated</span>' : ''}</li>`).join('')}</ul>`;
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
  } else if (m === 'status') {
    const S = key === 'g' ? 'g' : 'y', arr = D.dx.filter(d => d.st === S);
    const nG = D.dx.filter(d => d.st === 'g').length, nY = D.dx.filter(d => d.st === 'y').length;
    const groups = new Map();
    for (const d of arr) { const g = (d.sys || ['other'])[0]; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(d); }
    body = `<div class="seg" style="margin:10px 0"><button data-go="#/browse/status/y" class="${S === 'y' ? 'on' : ''}">🟡 Awaiting more data (${nY})</button><button data-go="#/browse/status/g" class="${S === 'g' ? 'on' : ''}">🟢 In depth (${nG})</button></div>
      <p class="small muted">${S === 'y' ? '🟡 = the in-depth page was written without a disease-specific source in the library. Add a monograph article for the disease to the “please update” folder and it will be enriched and turn 🟢.' : '🟢 = the in-depth page is backed by at least one source in the library (or was hand-curated with references).'}</p>
      ${[...groups.entries()].sort((a, b) => sysLabel(a[0]).localeCompare(sysLabel(b[0]))).map(([g, l]) => `<h3 class="sec">${esc(sysLabel(g))} <span class="count">${l.length}</span></h3>${list(l.sort((a, b) => a.name.localeCompare(b.name)))}`).join('')}`;
  } else if (m === 'bm') {
    const arr = D.dx.filter(d => d.cat === 'biomarker');
    const grp = d => (d.sys || []).includes('myopathy') ? 'Myositis antibodies' : (d.sys || [])[0] === 'neurodegenerative' ? 'Prion disease markers' : 'Neural antibodies (encephalitis and related)';
    const groups = new Map();
    for (const d of arr) { const g = grp(d); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(d); }
    body = `<div class="seg" style="margin:10px 0"><button data-bmtab="all" class="${state.bmTab !== 'pages' ? 'on' : ''}">Marker finder</button><button data-bmtab="pages" class="${state.bmTab === 'pages' ? 'on' : ''}">Antibody pages (${arr.length})</button></div>
      ${state.bmTab !== 'pages' ? bmView() : ''}
      <div ${state.bmTab !== 'pages' ? 'hidden' : ''}><p class="small muted">One page per antibody: what it targets, the syndrome it marks, cancer and organ risks, and how it changes management.</p>
      ${[...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([g, l]) => `<h3 class="sec">${esc(g)} <span class="count">${l.length}</span></h3>${list(l.sort((a, b) => a.name.localeCompare(b.name)))}`).join('') || '<p class="empty">No biomarker pages yet.</p>'}</div>`;
  } else if (m === 'ns') {
    const groups = new Map();
    for (const d of D.ns) { const g = NS_KIND[(d.ns || {}).kind] || 'Other topics'; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(d); }
    const order = Object.values(NS_KIND);
    body = `<p class="small muted">Neuroanatomy, tracts, circuits and physiology: where each pathway runs, what it does, how to test it at the bedside and what a lesion looks like.</p>
      ${[...groups.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([g, l]) => `<h3 class="sec">${esc(g)} <span class="count">${l.length}</span></h3>${list(l.sort((a, b) => a.name.localeCompare(b.name)))}`).join('') || '<p class="empty">No neuroscience pages yet.</p>'}`;
  } else if (m === 'pg') {
    const arr = D.dx.filter(d => d.cat === 'pathogen').sort((a, b) => a.name.localeCompare(b.name));
    body = `<p class="small muted">One page per organism: where it lives, who gets it, the CNS syndromes it causes, how to confirm it and how to treat it.</p>
      <h3 class="sec">Fungi (neuromycoses) <span class="count">${arr.length}</span></h3>${arr.length ? list(arr) : '<p class="empty">No pathogen pages yet.</p>'}`;
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
  <section class="card appear"><h3>Appearance</h3>
    <p class="small muted" style="margin:0 0 4px">Nothing extra is downloaded. Your choices are remembered on this device.</p>
    ${setRow('Theme', 'Colour and heading type', `<div class="skins">${SKINS.map(x => `<button class="skin" data-skin-set="${x[0]}" aria-pressed="${LS.get('skin', 'oxford') === x[0]}"><span class="sw">${x[3].map(c => `<i style="background:${c}"></i>`).join('')}</span><b>${x[1]}</b><span class="n">${x[2]}</span></button>`).join('')}</div>`, 'wide')}
    ${setRow('Mode', 'Auto follows your device', `<div class="seg" role="group" aria-label="Mode">${['system', 'light', 'dark'].map(t => `<button data-theme-set="${t}" class="${(LS.get('theme', 'system')) === t ? 'on' : ''}">${t === 'system' ? 'Auto' : t.charAt(0).toUpperCase() + t.slice(1)}</button>`).join('')}</div>`)}
    ${setRow('Layout', LS.get('layout', 'min') === 'max' ? 'Wide page, side rail, compact spacing' : 'One airy reading column', `<div class="seg" role="group" aria-label="Layout">${[['min', 'Minimalist'], ['max', 'Maximized']].map(x => `<button data-layout-set="${x[0]}" class="${LS.get('layout', 'min') === x[0] ? 'on' : ''}">${x[1]}</button>`).join('')}</div>`)}
    ${setRow('Sections', LS.get('sections', 'open') === 'fold' ? 'Fold under headings on disease pages' : 'Every section open on disease pages', `<div class="seg" role="group" aria-label="Disease page sections">${[['open', 'Expanded'], ['fold', 'Toggled']].map(x => `<button data-sec-set="${x[0]}" class="${LS.get('sections', 'open') === x[0] ? 'on' : ''}">${x[1]}</button>`).join('')}</div>`)}
    ${setRow('Text size', '', `<div class="seg" role="group" aria-label="Text size">${[['s', 'Small'], ['m', 'Medium'], ['l', 'Large']].map(x => `<button data-size-set="${x[0]}" class="${LS.get('size', 'm') === x[0] ? 'on' : ''}">${x[1]}</button>`).join('')}</div>`)}
    ${setRow('Explanations', 'Default wording on entry pages', langSeg())}
    ${setRow('Monk on Search by case', LS.get('monkGuard', true) ? 'Monk waits for your case (drag him into the temple to send him home)' : 'Off: Monk stays in the temple', `<div class="seg" role="group" aria-label="Monk on Search by case">${[[1, 'On'], [0, 'Off']].map(x => `<button data-monkg-set="${x[0]}" class="${!!LS.get('monkGuard', true) === !!x[0] ? 'on' : ''}" aria-pressed="${!!LS.get('monkGuard', true) === !!x[0]}">${x[1]}</button>`).join('')}</div>`)}
    ${setRow('Monk', monkStyle().name + ' — ' + monkStyle().note, `<div class="skins monks">${MONK_STYLES.map(m => `<button class="skin monk" data-monk-set="${m.id}" aria-pressed="${monkStyle().id === m.id}" aria-label="Monk style ${esc(m.name)}">${monkPreview(m)}<b>${esc(m.name)}</b></button>`).join('')}</div>`, 'wide')}
  </section>
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
  const gb = $('.gushbtn'); if (gb) gb.classList.toggle('on', view === 'gush');
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
  if (view !== 'stats') DS.anim = false;
  if (view === 'q') { const q = arg; if ($('#q').value !== q) $('#q').value = q; state.q = q; }
  if (view === 'home' || view === 'q') {
    if (view === 'home') { state.q = $('#q').value = ''; }
    const r = state.q ? search(state.q) : null;
    html = r ? viewResults(r) : viewHome(); if (state.q) actSearch(state.q);
    state.lastResults = r; selIdx = -1;
    setTabs('home');
  } else if (view === 'sign' || view === 'dx') {
    const e = byId.get(arg);
    if (!e) html = `<p class="empty">Entry not found. <a href="#/">Back to search</a></p>`;
    else { if (ACTM.view !== e.id) { ACTM.view = e.id; actLog('view', {id: e.id}); } addHist(e); html = view === 'sign' ? viewSign(e) : viewDx(e); if (view === 'dx') after = () => fillSimilar(e); document.title = e.name + ' · Sanctum of Neurology'; }
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
  else if (view === 'quiz') { html = viewQuiz(); setTabs('quiz'); }
  else if (view === 'train') { const k = LS.get('trainLast', 'rounds'); location.replace(k === 'review' ? '#/review' : k === 'quiz' ? '#/quiz' : k === 'stats' ? '#/stats' : '#/rounds'); return; }
  else if (view === 'stats') { html = viewStats(); setTabs('quiz'); after = dsAfter; }
  else if (view === 'rounds') { html = viewRounds(arg); setTabs('quiz'); }
  else if (view === 'meq') { html = viewMeq(arg); setTabs('quiz'); }
  else if (view === 'review') { html = viewReview(); setTabs('quiz'); }
  else if (view === 'watch') { if (ACTM.watch !== dayKey()) { ACTM.watch = dayKey(); actLog('watch'); } html = viewWatch(); setTabs(''); if (arg) after = () => { const el = document.getElementById(arg); if (el) { el.scrollIntoView(); el.classList.add('flash'); } }; }
  else if (view === 'case') { html = viewCase(); setTabs('home'); }
  else if (view === 'gush') { html = viewGush(arg); setTabs('gush'); }
  else if (view === 'curriculum') { CU.who = ''; html = viewCurriculum(); setTabs('quiz'); }
  else if (view === 'faculty') { html = viewFaculty(arg); setTabs('quiz'); }
  else if (view === 'podcast') { html = viewPodcast(arg); setTabs('podcast'); }
  else if (view === 'added') { html = viewAdded(arg); setTabs(''); if (arg && arg !== 'all') after = () => { const el = document.getElementById(arg); if (el) el.scrollIntoView(); }; }
  else html = viewHome();
  if (!(view === 'sign' || view === 'dx')) document.title = 'Sanctum of Neurology';
  if (view !== 'q' && view !== 'home') { $('#q').value = ''; if (document.activeElement === $('#q')) $('#q').blur(); }   // the query stays behind the Search tab
  { const c = $('#qclear'); if (c) c.hidden = !$('#q').value; }
  main.innerHTML = html;
  gushRoute(view, arg);
  const key = location.hash;
  if (scrollMemo.has(key) && (view === 'q' || view === 'browse' || view === 'saved' || view === 'home')) window.scrollTo(0, scrollMemo.get(key));
  else if (view !== 'q') window.scrollTo(0, 0);
  foldSections(view);
  if (after) after();
  clozeApply(view);
  monkGuard(view);
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
    if (ev.key === '/' && !G.open && document.activeElement !== q && !/input|textarea/i.test(document.activeElement.tagName)) { ev.preventDefault(); q.focus(); q.select(); }
  });
  /* back-to-top button (v0.95): appears after scrolling down, one tap returns to the top of the page */
  const topBtn = document.createElement('button');
  topBtn.id = 'totop'; topBtn.type = 'button'; topBtn.setAttribute('aria-label', 'Back to top'); topBtn.title = 'Back to top';
  topBtn.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 5l-7 7m7-7l7 7M12 5v14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  topBtn.onclick = () => window.scrollTo({top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'});
  document.body.appendChild(topBtn);
  const topShow = () => topBtn.classList.toggle('on', window.scrollY > 500);
  window.addEventListener('scroll', () => { scrollMemo.set(location.hash, window.scrollY); topShow(); }, {passive: true});
  topShow();
  document.addEventListener('toggle', ev => { if (ev.target.closest && ev.target.closest('.summary')) LS.set('sumOpen', ev.target.open); }, true);
  /* back / forward buttons: track position in our own history entries */
  let navMax = 0;
  function navSync() {
    let i = history.state && typeof history.state.i === 'number' ? history.state.i : null;
    if (i === null) { const prev = window.__navI; i = prev === undefined ? 0 : prev + 1; navMax = i; try { history.replaceState({i}, ''); } catch (e) {} }
    window.__navI = i;
    const b = $('#navback'), f = $('#navfwd');
    if (b) b.disabled = i <= 0;
    if (f) f.disabled = i >= navMax;
  }
  $('#navback').onclick = () => history.back();
  $('#navfwd').onclick = () => history.forward();
  document.addEventListener('keydown', ev => { if (ev.altKey && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') && !/input|textarea/i.test(document.activeElement.tagName)) { ev.preventDefault(); ev.key === 'ArrowLeft' ? history.back() : history.forward(); } });
  window.addEventListener('hashchange', () => { if (/^#\/rounds\/?$/.test(location.hash)) MEQ.draw = null; render(); navSync(); });
  gushEvents();
  navSync();
  document.addEventListener('change', ev => {
    if (ev.target.id === 'casefile' || ev.target.id === 'casecam') { caseAddFiles([...(ev.target.files || [])]); ev.target.value = ''; }
    if (ev.target.id === 'caselang') state.caseLang = ev.target.value;
  });
  document.addEventListener('input', ev => { if (ev.target.id === 'casetx') state.caseText = ev.target.value; });
  document.addEventListener('submit', ev => { const f = ev.target; if (f.matches && f.matches('[data-acform]')) { ev.preventDefault(); cloudSubmit(f); } else if (f.matches && f.matches('[data-planform]')) { ev.preventDefault(); planSubmit(f); } });
  { const dsTap = ev => { const t = ev.target.closest && ev.target.closest('[data-dsnode],[data-dsday]'); if (!t || t.tagName === 'BUTTON') return; if (ev.type === 'keydown' && ev.key !== 'Enter' && ev.key !== ' ') return; ev.preventDefault(); dsAct(t.dataset); };
    document.addEventListener('click', dsTap); document.addEventListener('keydown', dsTap); }
  document.addEventListener('change', ev => { if (ev.target.id === 'dsgoal') { LS.set('dsGoal', +ev.target.value); render(); } else if (ev.target.id === 'dscalm') { LS.set('dsCalm', ev.target.checked); render(); } });
  document.addEventListener('change', ev => { if (ev.target.id === 'srnew') { LS.set('srNew', +ev.target.value); RV.q = null; render(); } });
  document.addEventListener('input', ev => { if (ev.target.id !== 'meqans') return; const r = LS.get('meqCur', null); if (r && !r.ans[r.step]) { r.draft = ev.target.value; LS.set('meqCur', r); } });
  document.addEventListener('input', ev => { const r = LS.get('rdCur', null); if (!r) return; if (ev.target.id === 'rdnote') { r.note = ev.target.value; LS.set('rdCur', r); } if (ev.target.id === 'rdfnote') { r.fnote = ev.target.value; LS.set('rdCur', r); } });
  document.addEventListener('change', ev => { if (ev.target.id === 'qzsys') { QZ.sys = ev.target.value; LS.set('qzSys', QZ.sys); QZ.cur = null; render(); } });
  document.addEventListener('click', ev => { const h = ev.target.closest && ev.target.closest('h2.sec.fold'); if (h && !ev.target.closest('a')) foldToggle(h); });
  document.addEventListener('keydown', ev => { if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.matches && ev.target.matches('h2.sec.fold')) { ev.preventDefault(); foldToggle(ev.target); } });
  document.addEventListener('click', async ev => {
    const t = ev.target.closest('button'); if (!t) return;
    const d = t.dataset;
    if (d.dropf != null && state.lastResults && state.lastResults.free) { const f = state.lastResults.free.filter((_, i) => i !== +d.dropf); const nq = f.join(' + '); q.value = nq; state.q = nq; go('#/q/' + encodeURIComponent(nq)); return; }
    if ('casego' in d) { caseGo(); return; }
    if (d.rvtog != null && state.caseReview) { const i = state.caseReview.items[+d.rvtog]; if (i) { i.on = !i.on; render(); } return; }
    if (d.rvmiss != null && state.caseReview) { const m = state.caseReview.missed.splice(+d.rvmiss, 1)[0]; if (m) state.caseReview.items.push({t: m.s, quote: m.s, onset: '', duration: '', ok: true, on: true}); render(); return; }
    if ('rvadd' in d && state.caseReview) { const inp = $('#rvadd'), v = inp ? inp.value.trim() : ''; if (v) { state.caseReview.items.push({t: v, quote: '', onset: '', duration: '', ok: null, on: true}); render(); } return; }
    if ('casecont' in d) { if (!CASE.busy) caseContinue(); return; }
    if ('askadd' in d) {
      t.classList.toggle('on'); t.setAttribute('aria-pressed', t.classList.contains('on') ? 'true' : 'false');
      const n = document.querySelectorAll('.askopt.on').length, up = $('#askupd');
      if (up) { up.hidden = !n; up.textContent = 'Add ' + n + ' answer' + (n > 1 ? 's' : '') + ' and update work-up'; }
      return;
    }
    if ('caseask' in d) { caseAsk(d.caseask === 'deep'); return; }
    if ('casethink' in d) { if (!CASE.busy) caseGo(true); return; }
    if ('askgo' in d) {
      const adds = [...document.querySelectorAll('.askopt.on')].map(b => b.dataset.askadd.trim()).filter(Boolean);
      if (!adds.length) return;
      const ta = $('#casetx'), cur = (ta ? ta.value : state.caseText || '').replace(/\s+$/, '');
      const nx = (cur ? cur + (/[.!?]$/.test(cur) ? ' ' : '. ') : '') + adds.join(' ');
      state.caseText = nx; if (ta) ta.value = nx;
      caseGo(); return;
    }
    if ('caseclear' in d) {
      if (CASE.ctl) { try { CASE.ctl.abort(); } catch (e) {} }
      if (CASE.rec) { try { CASE.rec.stop(); } catch (e) {} CASE.rec = null; }
      CASE.photos.forEach(ph => URL.revokeObjectURL(ph.url)); CASE.photos = []; CASE.busy = false;
      state.caseText = ''; state.caseMsg = ''; state.caseWork = null; state.caseReview = null; state.caseConfirmed = null;
      const ta = $('#casetx'); if (ta) ta.value = '';
      render(); const t2 = $('#casetx'); if (t2) t2.focus(); return;
    }
    if ('casestop' in d) { if (CASE.ctl) CASE.ctl.abort(); return; }
    if ('casemic' in d) { caseMic(); return; }
    if ('casenophoto' in d) { CASE.photos.forEach(ph => URL.revokeObjectURL(ph.url)); CASE.photos = []; state.caseMsg = ''; render(); return; }
    if (d.casedelphoto != null) { const ph = CASE.photos.splice(+d.casedelphoto, 1)[0]; if (ph) URL.revokeObjectURL(ph.url); state.caseMsg = ''; render(); return; }
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
    else if (d.jump) { const el = document.getElementById(d.jump); if (el && el.classList.contains('fold')) foldToggle(el, true); if (el) window.scrollTo({top: el.getBoundingClientRect().top + window.scrollY - ($('.top').offsetHeight + 12), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'}); }
    else if (d.go) { go(d.go); }
    else if (d.train) trainGo(d.train);
    else if (d.nwtier !== undefined) { NW.tier = d.nwtier; render(); }
    else if (d.nwage !== undefined) { NW.age = d.nwage; render(); }
    else if (rdAct(d) || rvAct(d) || dsAct(d) || cloudAct(d) || planAct(d) || meqAct(d)) {}
    else if (d.qzmode) { QZ.mode = d.qzmode; LS.set('qzMode', QZ.mode); QZ.cur = null; QZ.n = QZ.ok = 0; render(); }
    else if ('qzshow' in d) { QZ.done = true; render(); }
    else if ('qznext' in d) { QZ.cur = null; render(); window.scrollTo(0, 0); }
    else if (d.qzgrade) { qzGrade(QZ.cur.id, d.qzgrade === '1'); QZ.cur = null; render(); window.scrollTo(0, 0); }
    else if (d.bdpick !== undefined && QZ.mode === 'board') { if (!QZ.done) { const i = +d.bdpick, ok = i === QZ.cur.x.ans; QZ.done = true; QZ.picked = i; QZ.n++; if (ok) QZ.ok++; qzGrade('q:' + QZ.cur.x.id, ok); render(); } }
    else if (d.qzpick) { if (!QZ.done) { QZ.done = true; QZ.picked = d.qzpick; QZ.n++; const ok = d.qzpick === QZ.cur.id; if (ok) QZ.ok++; qzGrade(QZ.cur.id, ok); render(); } }
    else if ('reveal' in d) { const a = t.nextElementSibling; a.hidden = !a.hidden; t.textContent = a.hidden ? 'Show answer' : 'Hide answer'; }
    else if (d.copy) { try { await navigator.clipboard.writeText(d.copy); toast('Copied'); } catch (e) { toast(d.copy); } }
    else if (d.shunpin) { LS.set('shadowBooks', LS.get('shadowBooks', []).filter(x => x !== d.shunpin)); toast('Book removed — choose another'); go('#/browse/shadow'); }
    else if (d.browse) go('#/browse/' + d.browse);
    else if ('clearhist' in d) { state.hist = []; saveState(); render(); }
    else if ('update' in d) { state.source = $('#src').value.trim(); saveState(); checkUpdate(true); }
    else if ('savesrc' in d) { state.source = $('#src').value.trim(); saveState(); toast('Source saved'); }
    else if (d.themeSet) { LS.set('theme', d.themeSet); applyTheme(); render(); }
    else if (d.skinSet) { LS.set('skin', d.skinSet); applyTheme(); render(); }
    else if (d.monkgSet != null) { LS.set('monkGuard', d.monkgSet === '1'); MG.dismissed = false; render(); }
    else if (d.monkSet) { LS.set('monk', +d.monkSet); render(); }
    else if (d.monkCycle) { LS.set('monk', monkStyle().id % MONK_STYLES.length + 1); render(); toast('Monk: ' + monkStyle().name); }
    else if (d.foldall != null) { document.querySelectorAll('h2.sec.fold').forEach(h => foldToggle(h, d.foldall === '1')); }
    else if (d.secSet) { LS.set('sections', d.secSet); render(); }
    else if (d.layoutSet) { LS.set('layout', d.layoutSet); applyTheme(); render(); }
    else if (d.sizeSet) { LS.set('size', d.sizeSet); applyTheme(); render(); }
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
    else if (d.bmtab) { state.bmTab = d.bmtab; render(); }
    else if ('install' in d) { if (deferredInstall) { deferredInstall.prompt(); deferredInstall = null; } }
    else if ('syncon' in d) { LS.set('syncOn', !sync.enabled()); render(); }
    else if (d.syncsrc) { const cur = sync.sources(); LS.set('syncSrc', cur.includes(d.syncsrc) ? cur.filter(x => x !== d.syncsrc) : [...cur, d.syncsrc]); render(); }
  });
  document.addEventListener('input', ev => {
    if (ev.target.id === 'bmq') {
      const v = ev.target.value.trim().toLowerCase(); let n = 0;
      document.querySelectorAll('.bmrow').forEach(r => { const hit = !v || r.dataset.bms.includes(v); r.hidden = !hit; if (hit) n++; });
      document.querySelectorAll('.bmgrp').forEach(g => { g.hidden = ![...g.querySelectorAll('.bmrow')].some(r => !r.hidden); });
      const c = $('#bmcount'); if (c) c.textContent = v ? n + ' markers match' : document.querySelectorAll('.bmrow').length + ' markers'; return;
    }
    if (ev.target.id === 'shq') { $('#shlist').innerHTML = shadowList(ev.target.value); return; }
    if (ev.target.id !== 'cmpq') return;
    const box = $('#cmpres'); const v = ev.target.value.trim();
    if (!v) { box.hidden = true; return; }
    const r = search(v);
    const list = r ? r.dx.filter(x => !state.cmp.includes(x.e.id)).slice(0, 12) : [];
    box.hidden = false;
    box.innerHTML = list.length ? list.map(x => `<button data-cmpadd="${esc(x.e.id)}">${esc(x.e.name)}</button>`).join('') : '<div class="small muted" style="padding:8px 12px">No disease matches</div>';
  });
  window.addEventListener('online', () => { checkUpdate(false); if (route().view === 'home') render(); });
  window.addEventListener('offline', () => { if (route().view === 'home') render(); });
}
const SKINS = [
  ['oxford', 'Oxford', 'Oxford blue on warm white with antique gold. Quiet and scholarly.', ['#FBFAF6', '#002147', '#8A6A1C']],
  ['ivy', 'Ivy League', 'Crimson on ivory. Formal and traditional.', ['#FBFAF7', '#8C1D2F', '#6B5B3E']],
  ['cambridge', 'Cambridge', 'Deep green with pale blue. Warm and calm.', ['#F8FAF7', '#1F4D3A', '#3F6E8F']],
  ['karolinska', 'Karolinska', 'Plum on white, one clean sans. Modern and airy.', ['#FAF9F8', '#4F0433', '#8A5A78']]
];
function applyTheme() {
  const root = document.documentElement, t = LS.get('theme', 'system'), k = LS.get('skin', 'oxford'), z = LS.get('size', 'm');
  if (t === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', t);
  root.setAttribute('data-skin', SKINS.some(x => x[0] === k) ? k : 'oxford');
  if (z === 'm') root.removeAttribute('data-size'); else root.setAttribute('data-size', z);
  root.setAttribute('data-layout', LS.get('layout', 'min') === 'max' ? 'max' : 'min');
  try { const bg = getComputedStyle(root).getPropertyValue('--bg').trim(); if (bg) document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.setAttribute('content', bg)); } catch (e) {}
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
  return '';
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
// ------------------------------------------------------------ Neuro Rounds podcast (AI teams). Only in the podcast edition:
// the feature switches on when data/podcast.json exists (bundled days) or the artifact's db holds collection "podcast" (daily days).
// Speech uses the device's own voices (speechSynthesis); one line at a time so long scripts are not cut off.
const POD_CAST = {
  jane: {name: 'Jane', role: 'Attending · Vascular', g: 'f', pitch: 1.05, rate: 1.12, c: '#C8483B', hair: '#2B1B14', skin: '#E9B98F', style: 'bob'},
  kyne: {name: 'Kyne', role: 'Attending · Movement disorder', g: 'm', pitch: 1.18, rate: 1.04, c: '#8E4BB8', hair: '#D9A441', skin: '#F0C7A0', style: 'quiff'},
  nina: {name: 'Nina', role: 'Attending · Neuroimmunology', g: 'f', pitch: 0.92, rate: 0.95, c: '#2D7D7A', hair: '#111', skin: '#D9A27A', style: 'bun'},
  sam: {name: 'Sam', role: 'Attending · Dementia & cognitive', g: 'm', pitch: 0.8, rate: 0.9, c: '#5C6F2E', hair: '#9A9A9A', skin: '#E3B48C', style: 'bald'},
  max: {name: 'Max', role: 'R3 · Epilepsy', g: 'm', pitch: 1.0, rate: 1.15, c: '#2F62C9', hair: '#1A1A1A', skin: '#C98F63', style: 'spike'},
  mint: {name: 'Mint', role: 'R2 · Pediatric neurology', g: 'f', pitch: 1.3, rate: 1.1, c: '#2FA37A', hair: '#4A2A1A', skin: '#F2CBA6', style: 'pony'},
  alex: {name: 'Alex', role: 'R1 · Genetic disease', g: 'x', pitch: 1.12, rate: 1.0, c: '#D1792B', hair: '#3E7BD6', skin: '#E0AA80', style: 'long'}
};
const POD_TEAM = {vascular: 'Vascular', movement: 'Movement disorder', neuroimmunology: 'Neuroimmunology', dementia: 'Dementia & cognitive', epilepsy: 'Epilepsy', pediatric: 'Pediatric neurology', genetic: 'Genetic disease'};
const POD_TEAMC = {vascular: '#C8483B', movement: '#8E4BB8', neuroimmunology: '#2D7D7A', dementia: '#5C6F2E', epilepsy: '#2F62C9', pediatric: '#2FA37A', genetic: '#D1792B'};
const PC = {on: false, days: [], lang: 'en',   // English only for now (curator 2026-11-15: device Thai voices sound wrong)
  ep: null, i: 0, playing: false, voices: [], timer: 0};
function podFace(k, size = 44) {
  const p = POD_CAST[k] || POD_CAST.sam, s = p.skin, h = p.hair;
  const hair = {
    bob: `<path d="M10 24c0-11 6-17 14-17s14 6 14 17v8h-5V21c-3-3-14-3-18 0v11h-5z" fill="${h}"/>`,
    quiff: `<path d="M12 20c0-9 6-14 13-14 6 0 12 3 12 11-4-4-10-5-16-3-4 1-6 4-9 6z" fill="${h}"/><path d="M22 6c4-4 10-3 12 1-4-1-8 0-12-1z" fill="${h}"/>`,
    bun: `<circle cx="24" cy="6" r="5" fill="${h}"/><path d="M11 22c0-9 6-14 13-14s13 5 13 14c-5-5-21-5-26 0z" fill="${h}"/>`,
    bald: `<path d="M11 22c1-3 2-5 4-6M37 22c-1-3-2-5-4-6" stroke="${h}" stroke-width="3" fill="none" stroke-linecap="round"/>`,
    spike: `<path d="M11 20l3-9 3 5 3-8 3 6 3-8 3 7 3-6 2 6 3-1-1 8c-6-3-20-3-26 0z" fill="${h}"/>`,
    pony: `<path d="M11 21c0-9 6-13 13-13s13 4 13 13c-6-4-20-4-26 0z" fill="${h}"/><path d="M36 15c6 2 7 10 4 15-1-5-3-8-5-10z" fill="${h}"/>`,
    long: `<path d="M10 22c0-10 6-15 14-15s14 5 14 15v14h-5V22c-4-4-14-4-18 0v14h-5z" fill="${h}"/>`
  }[p.style] || '';
  const glasses = k === 'nina' || k === 'sam' ? `<g fill="none" stroke="#222" stroke-width="1.4"><circle cx="19" cy="25" r="3.6"/><circle cx="29" cy="25" r="3.6"/><path d="M22.6 25h2.8"/></g>` : '';
  const extra = k === 'max' ? `<path d="M15 31q2 2 4 0M29 31q2 2 4 0" stroke="#7a5a44" stroke-width="1" fill="none" opacity=".6"/>` : k === 'kyne' ? `<circle cx="36.5" cy="29" r="1.4" fill="#F2C94C"/>` : k === 'jane' ? `<path d="M33 38h6v5h-6z" fill="#6B4226"/><path d="M39 39h2v3h-2" stroke="#6B4226" fill="none"/>` : '';
  return `<svg class="podface" viewBox="0 0 48 48" width="${size}" height="${size}" aria-hidden="true"><circle cx="24" cy="24" r="24" fill="${p.c}" opacity=".18"/>
    <path d="M8 48c2-8 8-11 16-11s14 3 16 11z" fill="${p.c}"/><ellipse cx="24" cy="24" rx="12" ry="13" fill="${s}"/>${hair}
    <circle cx="19" cy="25" r="1.5" fill="#222"/><circle cx="29" cy="25" r="1.5" fill="#222"/>${glasses}<path d="M20 31q4 3 8 0" stroke="#7a3b2e" stroke-width="1.6" fill="none" stroke-linecap="round"/>${extra}</svg>`;
}
function podCover(ep, big) {
  const c = POD_TEAMC[ep.team] || '#555', t = (ep.title && (ep.title[PC.lang] || ep.title.en)) || ep.page;
  const faces = (ep.cast || []).map(k => `<span class="podcov__f">${podFace(k, big ? 64 : 40)}<i>${esc((POD_CAST[k] || {}).name || k)}</i></span>`).join('');
  return `<div class="podcov${big ? ' big' : ''}" style="--pc:${c}"><div class="podcov__top"><span class="podcov__brand">Neuro Rounds</span><span class="podcov__team">${esc(POD_TEAM[ep.team] || ep.team)}</span></div>
    <div class="podcov__t">${esc(t)}</div><div class="podcov__faces">${faces}</div><span class="podcov__ai">AI teams</span></div>`;
}
async function podInit() {
  let days = [];
  if (D.version && D.version.podcast) try { const r = await fetch('data/podcast.json', {cache: 'no-store'}); if (r.ok) days = ((await r.json()).days || []); } catch (e) {}
  if (!days.length) { const el = document.getElementById('inline-podcast'); if (el) try { days = JSON.parse(el.textContent).days || []; } catch (e) {} }
  if (!days.length) return;          // normal edition: no podcast at all
  PC.on = true; PC.days = days; podSort(); podNav();
  if (route().view === 'home' || route().view === 'podcast') render();
  try {   // daily days written by the scheduled task into the artifact's database
    if (window.claude && window.claude.use) {
      const db = await window.claude.use('db');
      if (db) { const s = await db.collection('podcast').get(); const more = s.docs.map(d => d.data()).filter(x => x && x.date && Array.isArray(x.eps));
        if (more.length) { const have = new Map(PC.days.map(d => [d.date, d])); more.forEach(d => have.set(d.date, d)); PC.days = [...have.values()]; podSort(); if (route().view === 'home' || route().view === 'podcast') render(); } }
    }
  } catch (e) {}
}
function podSort() { PC.days.sort((a, b) => (a.date < b.date ? 1 : -1)); }
function podNav() {
  const nav = $('.nav'); if (!nav || nav.querySelector('[data-v=podcast]')) return;
  const a = document.createElement('a'); a.href = '#/podcast'; a.dataset.v = 'podcast';
  a.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M8.5 21h7"/></svg><span>Podcast</span>';
  nav.appendChild(a);
}
function podToday() { const t = dayKey(); return PC.days.find(d => d.date <= t) || PC.days[PC.days.length - 1]; }
const podEp = id => { for (const d of PC.days) for (const e of d.eps) if (e.id === id) return [e, d]; return [null, null]; };
function podMins(ep) { if (ep && ep.audio && ep.audio.secs > 0 && PC.lang === 'en') return Math.max(1, Math.round(ep.audio.secs / 60)); const L = ep[PC.lang] || ep.en || []; const w = L.reduce((a, [, s]) => a + (PC.lang === 'th' ? s.length / 4.2 : s.split(/\s+/).length), 0); return Math.max(1, Math.round(w / 150)); }
function podHomeHTML() {
  if (!PC.on) return '';
  const d = podToday(); if (!d) return '';
  return `<section class="podhome"><h2 class="sec">Neuro Rounds podcast <span class="count">${d.eps.length}</span><a class="seclink" href="#/podcast">All episodes</a></h2>
    <div class="podrow">${d.eps.map(e => `<a class="podcard" href="#/podcast/${esc(e.id)}">${podCover(e)}</a>`).join('')}</div></section>`;
}
function podLangSeg() { return ''; }
function viewPodcast(arg) {
  if (!PC.on) return `<p class="empty">The podcast is not part of this edition. <a href="#/">Back</a></p>`;
  if (arg) {
    const [ep, day] = podEp(arg); if (!ep) return `<p class="empty">Episode not found. <a href="#/podcast">All episodes</a></p>`;
    if (PC.ep !== ep.id) { podStop(); PC.ep = ep.id; PC.i = 0; }
    const L = ep[PC.lang] || ep.en || [];
    const pg = ep.page && resolveFind(ep.page);
    return `<article class="entry podep"><div class="ehead"><div class="crumb"><a href="#/podcast">Neuro Rounds</a> · ${esc(fmtDate(day.date))} · <span class="st draft"><span class="dot"></span>AI teams</span></div></div>
      ${podCover(ep, true)}
      <div class="podctl">${podLangSeg()}<button type="button" class="btn primary" data-podplay>${PC.playing ? 'Pause' : (PC.i ? 'Resume' : 'Play')}</button><button type="button" class="btn ghost" data-podrestart>Restart</button><span class="faint small">about ${podMins(ep)} min · <span data-podvoice>${podVoiceLabel(ep)}</span></span></div>
      ${!podAudioOK(ep) && !('speechSynthesis' in window) ? `<p class="small muted">This browser has no speech voice; read the script below.</p>` : ''}
      <ol class="podscript">${L.map(([k, s], i) => `<li class="podline${i === PC.i && PC.playing ? ' now' : ''}" data-podline="${i}">${podFace(k, 34)}<div><b style="color:${(POD_CAST[k] || {}).c}">${esc((POD_CAST[k] || {}).name || k)}</b><p>${esc(s)}</p></div></li>`).join('')}</ol>
      ${pg ? `<p class="small">Read the page: <a href="${link(pg)}">${esc(pg.name)}</a></p>` : ''}
      <p class="small muted">Scripts are written daily by AI (Claude) from Sanctum pages and published without prior review; the curator corrects them afterwards. Educational use only.</p></article>`;
  }
  const team = Object.entries(POD_CAST).map(([k, p]) => `<div class="podmember">${podFace(k, 52)}<b>${esc(p.name)}</b><small>${esc(p.role)}</small></div>`).join('');
  return `<article class="entry podlist"><div class="ehead"><div class="crumb">Podcast · <span class="st draft"><span class="dot"></span>AI teams</span></div><h1>Neuro Rounds</h1>
      <p class="muted">Five topics a day, each under ten minutes. Formal like a conference, then easy-going like a senior teaching a junior.</p></div>
    <div class="podctl">${podLangSeg()}</div>
    ${PC.days.map((d, j) => `<h2 class="sec">${j === 0 && d === podToday() ? 'Today · ' : ''}${esc(fmtDate(d.date))}</h2><div class="podrow">${d.eps.map(e => `<a class="podcard" href="#/podcast/${esc(e.id)}">${podCover(e)}<span class="faint small">${podMins(e)} min</span></a>`).join('')}</div>`).join('')}
    <h2 class="sec">The team</h2><div class="podteam">${team}</div></article>`;
}
// Audio first: an episode may carry ep.audio = {url, marks: [start second of each line], secs} (Kokoro voices, rendered by the
// daily task). Without it, or if the file fails, the device's own voices read the script line by line.
const POD_BAD_VOICE = /\b(albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|deranged|hysterical|eddy|flo|grandma|grandpa|reed|rocko|sandy|shelley|fred|junior|kathy|ralph|espeak|mbrola|novelty)\b/i;
const POD_FEM = /female|woman|samantha|karen|moira|tessa|fiona|victoria|serena|kate|susan|zira|hazel|aria|jenny|ava|emma|michelle|sonia|libby|allison|nicky|joanna|salli|kimberly|ivy|amy|olivia|natasha|clara|emily|ana\b|google us english/i;
const POD_MALE = /\bmale\b|\bman\b|daniel|\balex\b|\btom\b|oliver|arthur|aaron|\bguy\b|andrew|brian|christopher|eric|roger|ryan|david|mark|george|james|thomas|william|matthew|joey|justin|liam|gordon|lee\b|rishi/i;
function podVoiceScore(v) {
  const n = v.name || '';
  return (/natural|neural|online/i.test(n) ? 8 : 0) + (/premium/i.test(n) ? 6 : 0) + (/enhanced/i.test(n) ? 5 : 0) + (/siri/i.test(n) ? 4 : 0)
    + (/google/i.test(n) ? 3 : 0) + (/^en[-_](us|gb)/i.test(v.lang || '') ? 1 : 0);
}
function podVoiceGender(v) { const n = v.name || ''; return /female/i.test(n) ? 'f' : /\bmale\b/i.test(n) ? 'm' : POD_FEM.test(n) ? 'f' : POD_MALE.test(n) ? 'm' : ''; }
// Pure: give each speaker a voice, best quality first, distinct while the device has enough, never a novelty/robot voice.
function podPickVoices(voices, lang = 'en') {
  const want = lang === 'th' ? /^th/i : /^en/i;
  let vs = (voices || []).filter(v => want.test(v.lang || ''));
  vs = vs.filter(v => !POD_BAD_VOICE.test(v.name || ''));   // only robots left: none, so the browser's default voice speaks
  vs = vs.map((v, i) => [v, podVoiceScore(v), i]).sort((a, b) => b[1] - a[1] || a[2] - b[2]).map(x => x[0]);
  const out = {}, used = new Set();
  for (const k of Object.keys(POD_CAST)) {
    const g = POD_CAST[k].g;
    const fits = v => g === 'x' || !podVoiceGender(v) || podVoiceGender(v) === g;
    out[k] = vs.find(v => fits(v) && !used.has(v)) || vs.find(fits) || vs.find(v => !used.has(v)) || vs[0] || null;
    if (out[k]) used.add(out[k]);
  }
  return out;
}
const podPitch = p => Math.min(1.1, Math.max(0.9, p || 1));
function podVoiceMap() {
  if (!('speechSynthesis' in window)) return {};
  if (!PC.voices.length) PC.voices = speechSynthesis.getVoices();
  if (!PC.vmap || PC.vmapN !== PC.voices.length) { PC.vmap = podPickVoices(PC.voices, PC.lang); PC.vmapN = PC.voices.length; }
  return PC.vmap;
}
// Pure: which line is being heard at second t.
function podLineAt(marks, t) { let i = 0; for (let j = 0; j < (marks || []).length; j++) if (marks[j] <= t + 0.05) i = j; else break; return i; }
function podAudioOK(ep) {
  const L = (ep && (ep[PC.lang] || ep.en)) || [], a = ep && ep.audio;
  return !!(a && typeof a.url === 'string' && a.url && Array.isArray(a.marks) && a.marks.length === L.length && !(PC.bad || new Set()).has(ep.id));
}
function podAudioEl() {
  if (PC.au) return PC.au;
  const a = PC.au = new Audio(); a.preload = 'metadata';
  a.addEventListener('timeupdate', () => { const [ep] = podEp(PC.ep); if (!ep || !PC.playing || PC.mode !== 'audio') return;
    const i = podLineAt(ep.audio.marks, a.currentTime); if (i !== PC.i) { PC.i = i; podMark(); } });
  a.addEventListener('ended', () => { if (PC.mode !== 'audio') return; PC.playing = false; PC.i = 0; podMark(); podBtn(); });
  a.addEventListener('error', () => { if (PC.mode !== 'audio' || !PC.playing) return;   // file missing or unplayable: fall back to device voices
    (PC.bad = PC.bad || new Set()).add(PC.ep); PC.mode = 'tts'; podCtlNote(); podSpeak(); });
  return a;
}
function podPlay() {
  const [ep] = podEp(PC.ep); if (!ep) return;
  PC.playing = true; podBtn();
  if (podAudioOK(ep)) {
    PC.mode = 'audio'; const a = podAudioEl();
    if (a.dataset.ep !== ep.id) { a.src = ep.audio.url; a.dataset.ep = ep.id; }
    const at = ep.audio.marks[PC.i] || 0;
    const go = () => { try { a.currentTime = at; } catch (e) {} const pr = a.play(); if (pr && pr.catch) pr.catch(() => { if (PC.mode === 'audio' && PC.playing && a.error) a.dispatchEvent(new Event('error')); else { PC.playing = false; podBtn(); podMark(); } }); };
    if (a.readyState >= 1) go(); else a.addEventListener('loadedmetadata', go, {once: true}), a.load();
    podMark(); return;
  }
  if (!('speechSynthesis' in window)) { PC.playing = false; podBtn(); return; }
  PC.mode = 'tts'; podSpeak();
}
function podSpeak() {
  const [ep] = podEp(PC.ep); if (!ep) return;
  const L = ep[PC.lang] || ep.en || [];
  if (PC.i >= L.length) { PC.playing = false; PC.i = 0; podMark(); podBtn(); return; }
  const [k, s] = L[PC.i], p = POD_CAST[k] || {};
  const u = new SpeechSynthesisUtterance(s), v = podVoiceMap()[k];
  if (v) u.voice = v;
  u.lang = PC.lang === 'th' ? 'th-TH' : 'en-US'; u.pitch = podPitch(p.pitch); u.rate = (p.rate || 1) * (PC.lang === 'th' ? 0.95 : 1);
  u.onend = () => { if (!PC.playing || PC.mode !== 'tts') return; PC.i++; podMark(); PC.timer = setTimeout(podSpeak, 250); };
  u.onerror = () => { if (!PC.playing || PC.mode !== 'tts') return; PC.i++; podMark(); PC.timer = setTimeout(podSpeak, 250); };
  podMark(); speechSynthesis.speak(u);
}
function podMark() {
  $$('.podline').forEach(li => li.classList.toggle('now', PC.playing && +li.dataset.podline === PC.i));
  const cur = $('.podline.now'); if (cur && cur.scrollIntoView) cur.scrollIntoView({block: 'center', behavior: 'smooth'});
}
function podBtn() { const b = $('[data-podplay]'); if (b) b.textContent = PC.playing ? 'Pause' : (PC.i ? 'Resume' : 'Play'); }
function podCtlNote() { const n = $('[data-podvoice]'); const [ep] = podEp(PC.ep); if (n && ep) n.textContent = podVoiceLabel(ep); }
const podVoiceLabel = ep => podAudioOK(ep) ? 'AI voices (Kokoro)' : 'device voice';
function podStop() { PC.playing = false; clearTimeout(PC.timer); try { if (PC.au) PC.au.pause(); } catch (e) {} try { if ('speechSynthesis' in window) speechSynthesis.cancel(); } catch (e) {} }
document.addEventListener('click', ev => {
  const t = ev.target.closest && ev.target.closest('[data-podplay],[data-podrestart],[data-podlang],[data-podline]'); if (!t) return;
  if (t.dataset.podlang) { podStop(); PC.lang = t.dataset.podlang; LS.set('podLang', PC.lang); PC.i = 0; PC.vmap = null; render(); return; }
  const [ep] = podEp(PC.ep); if (!ep || (!podAudioOK(ep) && !('speechSynthesis' in window))) return;
  if (t.hasAttribute('data-podrestart')) { podStop(); PC.i = 0; podPlay(); return; }
  if (t.hasAttribute('data-podline')) { podStop(); PC.i = +t.dataset.podline; podPlay(); return; }
  if (PC.playing) { podStop(); podBtn(); podMark(); } else podPlay();
});
if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = () => { PC.voices = speechSynthesis.getVoices(); PC.vmap = null; };
window.addEventListener('hashchange', () => { if (route().view !== 'podcast') podStop(); });

// ------------------------------------------------------------ Residency curriculum and faculty tracking (no accounts: report file or code)
// Residents: every finished Ward-round case and MEQ case logs a score for each reasoning step. #/curriculum shows it by block and exports a report.
// Faculty: #/faculty imports residents' reports, shows a reasoning-skill matrix, and edits the curriculum (blocks, targets) for the institution.
const CUR_SKILLS = [['gather', 'History & examination'], ['pattern', 'UMN / LMN pattern'], ['loc', 'Localization'], ['tempo', 'Tempo'], ['etiology', 'Etiology category'], ['ddx', 'Differential diagnosis'], ['inv', 'Investigation'], ['mgmt', 'Management'], ['counsel', 'Counselling']];
const CUR_DEFAULT = {name: 'Default neurology residency', pass: 70, blocks: [
  {id: 'vascular', name: 'Vascular neurology', cats: ['vascular'], target: 5},
  {id: 'movement', name: 'Movement disorders', cats: ['movement'], target: 5},
  {id: 'epilepsy', name: 'Epilepsy', cats: ['epilepsy'], target: 5},
  {id: 'dementia', name: 'Dementia & cognitive', cats: ['dementia', 'neurodegenerative'], target: 5},
  {id: 'neuromuscular', name: 'Neuromuscular disease', cats: ['neuromuscular', 'myopathy'], target: 5},
  {id: 'sleep', name: 'Sleep medicine', cats: ['sleep'], target: 3},
  {id: 'headache', name: 'Headache', cats: ['headache', 'csf'], target: 3},
  {id: 'neurosurgery', name: 'Neurosurgery', cats: ['trauma', 'oncology', 'spinal-cord', 'neurocritical-care'], target: 3}]};
const MEQ_SKILL = [[/initial approach/i, 'gather'], [/locali[sz]ation/i, 'loc'], [/tempo/i, 'etiology'], [/differential|final diagnosis/i, 'ddx'], [/investigation/i, 'inv'], [/treatment|management/i, 'mgmt'], [/counsel/i, 'counsel']];
const curPlan = () => { const p = LS.get('curPlan', null); return p && Array.isArray(p.blocks) && p.blocks.length ? p : CUR_DEFAULT; };
const curProfile = () => LS.get('curProfile', {name: '', year: '', inst: '', rid: ''});
const rsnLog = () => LS.get('rsnLog', []);
function rsnAdd(k, c, s) {
  const clean = {}; for (const [a, v] of Object.entries(s)) if (v != null && isFinite(v)) clean[a] = Math.round(Math.max(0, Math.min(1, v)) * 100) / 100;
  if (!Object.keys(clean).length) return;
  const sys = [...new Set((k === 'w' ? (c.pages || []) : [c.answerId]).map(i => byId.get(i)).filter(Boolean).flatMap(e => e.sys || []))];
  const log = rsnLog(); log.push({k, id: c.id, t: c.title, at: Date.now(), sys, s: clean}); LS.set('rsnLog', log.slice(-400));
}
function rsnWard(c, r) {
  const v = st => r.sc[st] != null ? r.sc[st] : (r.ok[st] === undefined ? null : (r.ok[st] ? 1 : 0)), g = [v('history'), v('exam')].filter(x => x != null);
  rsnAdd('w', c, {gather: g.length ? g.reduce((a, b) => a + b, 0) / g.length : null, pattern: c.pattern ? v('pattern') : null, loc: v('loc'), tempo: v('tempo'), etiology: v('cat'), ddx: v('ddx'), inv: v('next')});
}
function rsnMeq(c, r) {
  const acc = {};
  c.steps.forEach((st, i) => { const a = r.ans[i]; if (!a || a.pct == null) return; const m = MEQ_SKILL.find(([rx]) => rx.test(st.label || '')); if (!m) return; (acc[m[1]] = acc[m[1]] || []).push(a.pct / 100); });
  const s = {}; for (const [k, v] of Object.entries(acc)) s[k] = v.reduce((a, b) => a + b, 0) / v.length;
  rsnAdd('m', c, s);
}
const curBlockOf = (x, plan) => { const b = plan.blocks.find(b => (b.cats || []).some(c => (x.sys || []).includes(c))); return b ? b.id : 'other'; };
function curSummary(log, plan) {   // {skills: {k: {n, avg}}, blocks: {id: {n, cases, avg, skills}}}
  const mk = () => ({n: 0, sum: 0}), skills = {}, blocks = {};
  for (const x of log) {
    const b = curBlockOf(x, plan), B = blocks[b] || (blocks[b] = {ids: new Set(), n: 0, sum: 0, skills: {}});
    const vals = Object.values(x.s); B.ids.add(x.k + x.id); B.n++; B.sum += vals.reduce((a, v) => a + v, 0) / vals.length;
    for (const [k, v] of Object.entries(x.s)) { const S = skills[k] || (skills[k] = mk()); S.n++; S.sum += v; const T = B.skills[k] || (B.skills[k] = mk()); T.n++; T.sum += v; }
  }
  const avg = o => o && o.n ? Math.round(100 * o.sum / o.n) : null;
  return {skills: Object.fromEntries(Object.entries(skills).map(([k, o]) => [k, {n: o.n, avg: avg(o)}])),
    blocks: Object.fromEntries(Object.entries(blocks).map(([k, o]) => [k, {cases: o.ids.size, n: o.n, avg: avg(o), skills: Object.fromEntries(Object.entries(o.skills).map(([s, v]) => [s, {n: v.n, avg: avg(v)}]))}]))};
}
const curHash = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(36); };
const curEnc = o => btoa(unescape(encodeURIComponent(JSON.stringify(o))));
const curDec = t => { t = String(t || '').trim(); try { return JSON.parse(t[0] === '{' ? t : decodeURIComponent(escape(atob(t.replace(/\s+/g, ''))))); } catch (e) { return null; } };
function curReport() {
  const body = {v: 1, app: 'sanctum-report', made: Date.now(), profile: curProfile(), plan: curPlan().name, log: rsnLog()};
  body.sum = curHash(JSON.stringify(body.log) + body.profile.name + body.profile.rid); return body;
}
function curDownload(name, text) { try { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], {type: 'application/json'})); a.download = name; document.body.appendChild(a); a.click(); a.remove(); } catch (e) {} }
const curCell = (v, pass) => v == null ? '<td class="cu0">–</td>' : `<td class="${v >= pass ? 'cu3' : v >= pass - 20 ? 'cu2' : 'cu1'}">${v}</td>`;
const CU = {msg: '', code: '', who: ''};
function viewCurriculum() {
  const plan = curPlan(), pr = curProfile(), log = rsnLog(), sm = curSummary(log, plan), custom = plan !== CUR_DEFAULT;
  const blocks = plan.blocks.concat(sm.blocks.other ? [{id: 'other', name: 'Outside the curriculum blocks', target: 0}] : []);
  const weak = CUR_SKILLS.map(([k, n]) => [k, n, sm.skills[k]]).filter(x => x[2] && x[2].n >= 2 && x[2].avg < plan.pass).sort((a, b) => a[2].avg - b[2].avg).slice(0, 3);
  return `<article class="entry trainwrap cur">${trainBar('curriculum')}<div class="ehead"><div class="crumb">Train · Curriculum</div><h1>${esc(plan.name)}</h1>
    <p class="muted small">${custom ? 'Curriculum set by your institution.' : 'Default blocks. Your institution can send its own curriculum file.'} Scores come from the reasoning steps of Ward rounds and MEQ cases on this device.</p></div>
    <section class="card stcard"><h3>Resident</h3><div class="curform"><label>Name<input data-curp="name" value="${esc(pr.name)}" autocomplete="off"></label><label>Year<select data-curp="year">${['', 'R1', 'R2', 'R3', 'Fellow', 'Other'].map(y => `<option${pr.year === y ? ' selected' : ''}>${y}</option>`).join('')}</select></label><label>Institution<input data-curp="inst" value="${esc(pr.inst)}" autocomplete="off"></label><label>ID (optional)<input data-curp="rid" value="${esc(pr.rid)}" autocomplete="off"></label></div></section>
    <h2 class="sec">Reasoning skills <span class="count">${log.length} cases</span></h2>
    ${log.length ? `<div class="curskills">${CUR_SKILLS.map(([k, n]) => { const s = sm.skills[k]; return `<div class="curskill"><span>${esc(n)}</span><span class="curbar"><i class="${s && s.avg >= plan.pass ? 'ok' : ''}" style="width:${s ? s.avg : 0}%"></i></span><b>${s ? s.avg + '%' : '–'}</b><small>${s ? s.n : 0}</small></div>`; }).join('')}</div>
      ${weak.length ? `<p class="small"><b>Work on next:</b> ${weak.map(x => `${esc(x[1])} (${x[2].avg}%)`).join(', ')}. Pass mark ${plan.pass}%.</p>` : ''}` : `<p class="empty">No cases finished yet. Do a <a href="#/rounds">Ward round or MEQ case</a>; each step you commit is scored here.</p>`}
    <h2 class="sec">Blocks</h2><div class="stafftw"><table class="stafft curtab"><thead><tr><th>Block</th><th>Cases</th><th>Average</th></tr></thead><tbody>${blocks.map(b => { const s = sm.blocks[b.id]; return `<tr><td>${esc(b.name)}</td><td>${s ? s.cases : 0}${b.target ? ' / ' + b.target : ''}</td>${curCell(s ? s.avg : null, plan.pass)}</tr>`; }).join('')}</tbody></table></div>
    <h2 class="sec">Send to your teacher</h2>
    <div class="qzact"><button class="btn primary" data-curexport="file">Save report file</button><button class="btn" data-curexport="code">Show report code</button></div>
    ${CU.code ? `<textarea class="curcode" readonly rows="5">${esc(CU.code)}</textarea><p class="small muted">Copy all of this text and send it to your teacher (chat or e-mail).</p>` : ''}
    <h2 class="sec">Curriculum from your institution</h2>
    <p class="small muted">Paste the curriculum code from your teacher, or choose the file.</p>
    <textarea id="curin" class="curcode" rows="3" placeholder="Curriculum code"></textarea>
    <div class="qzact"><button class="btn" data-curload>Use this curriculum</button><label class="btn ghost">Choose file<input type="file" id="curfile" accept=".json,application/json" hidden></label>${custom ? '<button class="btn ghost" data-curreset>Back to default</button>' : ''}<a class="btn ghost" href="#/faculty">I am a teacher</a></div>
    ${CU.msg ? `<p class="small"><b>${esc(CU.msg)}</b></p>` : ''}</article>`;
}
const facReports = () => LS.get('facReports', {});
function facAdd(o) {
  if (!o || o.app !== 'sanctum-report' || !Array.isArray(o.log)) return 'This is not a Sanctum report.';
  const ok = o.sum === curHash(JSON.stringify(o.log) + ((o.profile || {}).name || '') + ((o.profile || {}).rid || ''));
  const key = norm(((o.profile || {}).rid || '') + ' ' + ((o.profile || {}).name || '')) || 'unnamed', all = facReports();
  all[key] = {profile: o.profile || {}, made: o.made, log: o.log.filter(x => x && x.s && x.id).slice(-400), ok}; LS.set('facReports', all);
  return `Imported ${(o.profile || {}).name || 'unnamed resident'} (${o.log.length} cases)${ok ? '' : ' — checksum does not match: the file was edited or damaged'}.`;
}
function viewFaculty(arg) {
  const plan = curPlan(), all = facReports(), keys = Object.keys(all).sort();
  const head = `<article class="entry trainwrap cur fac">${trainBar('curriculum')}<div class="ehead"><div class="crumb"><a href="#/curriculum">Curriculum</a> · Teacher view</div><h1>Resident reasoning tracker</h1>
    <p class="muted small">Reports stay on this device. Nothing is sent anywhere. A report shows what the resident did in Sanctum; it is a teaching aid, not a formal assessment.</p></div>`;
  if (arg && all[arg]) {
    const r = all[arg], sm = curSummary(r.log, plan), blocks = plan.blocks.concat(sm.blocks.other ? [{id: 'other', name: 'Other'}] : []), used = CUR_SKILLS.filter(([k]) => sm.skills[k]);
    return head + `<p><a href="#/faculty">← All residents</a></p><h2 class="sec">${esc(r.profile.name || 'Unnamed')} <span class="count">${esc([r.profile.year, r.profile.inst].filter(Boolean).join(' · '))}</span></h2>
      <p class="small muted">Report made ${esc(fmtDate(dayKey(r.made)))} · ${r.log.length} cases${r.ok ? '' : ' · <b>checksum mismatch</b>'}</p>
      <div class="stafftw"><table class="stafft curtab"><thead><tr><th>Block</th><th>Cases</th>${used.map(([, n]) => `<th>${esc(n)}</th>`).join('')}</tr></thead><tbody>
      ${blocks.map(b => { const s = sm.blocks[b.id]; return `<tr><td>${esc(b.name)}</td><td>${s ? s.cases : 0}${b.target ? ' / ' + b.target : ''}</td>${used.map(([k]) => curCell(s && s.skills[k] ? s.skills[k].avg : null, plan.pass)).join('')}</tr>`; }).join('')}
      <tr class="tot"><td>All</td><td>${r.log.length}</td>${used.map(([k]) => curCell(sm.skills[k].avg, plan.pass)).join('')}</tr></tbody></table></div>
      <h2 class="sec">Recent cases</h2><ul class="list">${r.log.slice(-15).reverse().map(x => `<li>${esc(fmtDate(dayKey(x.at)))} · ${x.k === 'w' ? 'Ward round' : 'MEQ'} · ${esc(x.t || x.id)} — ${Object.entries(x.s).map(([k, v]) => `${esc((CUR_SKILLS.find(s => s[0] === k) || [k, k])[1])} ${Math.round(v * 100)}%`).join(', ')}</li>`).join('')}</ul>
      <div class="qzact"><button class="btn ghost" data-facdel="${esc(arg)}">Remove this resident</button></div></article>`;
  }
  const rows = keys.map(k => { const r = all[k], sm = curSummary(r.log, plan); return `<tr><td><a href="#/faculty/${encodeURIComponent(k)}">${esc(r.profile.name || 'Unnamed')}</a><br><small class="faint">${esc([r.profile.year, fmtDate(dayKey(r.made))].filter(Boolean).join(' · '))}</small></td><td>${r.log.length}</td>${CUR_SKILLS.map(([s]) => curCell(sm.skills[s] ? sm.skills[s].avg : null, plan.pass)).join('')}</tr>`; }).join('');
  const sysAll = Object.keys(D.meta.sys || {});
  return head + `<h2 class="sec">Residents <span class="count">${keys.length}</span></h2>
    ${keys.length ? `<div class="stafftw"><table class="stafft curtab"><thead><tr><th>Resident</th><th>Cases</th>${CUR_SKILLS.map(([, n]) => `<th>${esc(n)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>
      <p class="small muted">Green = at or above the pass mark (${plan.pass}%), amber = within 20 points, red = below. Tap a name for blocks and cases.</p><div class="qzact"><button class="btn ghost" data-faccsv>Save table as CSV</button></div>` : '<p class="empty">No reports yet. Ask residents to send their report file or code from Train › Curriculum.</p>'}
    <h2 class="sec">Add a report</h2><textarea id="facin" class="curcode" rows="3" placeholder="Paste a report code"></textarea>
    <div class="qzact"><button class="btn primary" data-facadd>Add report</button><label class="btn">Choose files<input type="file" id="facfile" accept=".json,application/json" multiple hidden></label></div>
    ${CU.msg ? `<p class="small"><b>${esc(CU.msg)}</b></p>` : ''}
    <h2 class="sec">Curriculum for your institution</h2>
    <div class="curform"><label>Name<input data-curplan="name" value="${esc(plan.name)}"></label><label>Pass mark %<input data-curplan="pass" type="number" min="30" max="100" value="${plan.pass}"></label></div>
    ${plan.blocks.map((b, i) => `<details class="card curblock"><summary><b>${esc(b.name)}</b> <span class="faint small">${(b.cats || []).length} categories · target ${b.target || 0} cases</span></summary>
      <div class="curform"><label>Block name<input data-curb="${i}:name" value="${esc(b.name)}"></label><label>Target cases<input data-curb="${i}:target" type="number" min="0" max="99" value="${b.target || 0}"></label></div>
      <div class="chips">${sysAll.map(c => `<button type="button" class="chip${(b.cats || []).includes(c) ? ' on' : ''}" data-curcat="${i}:${esc(c)}">${esc(sysLabel(c))}</button>`).join('')}</div>
      <div class="qzact"><button class="btn ghost" data-curbdel="${i}">Remove block</button></div></details>`).join('')}
    <div class="qzact"><button class="btn" data-curbadd>Add a block</button><button class="btn primary" data-curpexport="file">Save curriculum file</button><button class="btn" data-curpexport="code">Show curriculum code</button><button class="btn ghost" data-curreset>Reset to default</button></div>
    ${CU.code ? `<textarea class="curcode" readonly rows="4">${esc(CU.code)}</textarea><p class="small muted">Send this code or the file to your residents; they load it in Train › Curriculum.</p>` : ''}</article>`;
}
function curPlanEdit(fn) { const p = JSON.parse(JSON.stringify(curPlan())); fn(p); LS.set('curPlan', p); }
function curLoadPlan(o) { if (!o || o.app !== 'sanctum-curriculum' || !Array.isArray(o.blocks) || !o.blocks.length) return 'This is not a Sanctum curriculum.';
  LS.set('curPlan', {name: String(o.name || 'Curriculum').slice(0, 80), pass: Math.max(30, Math.min(100, +o.pass || 70)), blocks: o.blocks.slice(0, 30).map((b, i) => ({id: String(b.id || 'b' + i).slice(0, 40), name: String(b.name || 'Block').slice(0, 60), cats: (b.cats || []).map(String).slice(0, 30), target: Math.max(0, Math.min(99, +b.target || 0))}))});
  return 'Curriculum loaded.'; }
document.addEventListener('click', ev => {
  const t = ev.target.closest && ev.target.closest('[data-curexport],[data-curload],[data-curreset],[data-facadd],[data-facdel],[data-faccsv],[data-curcat],[data-curbdel],[data-curbadd],[data-curpexport]'); if (!t) return;
  const d = t.dataset; CU.msg = '';
  if (d.curexport) { const r = curReport(); if (d.curexport === 'file') { curDownload(`sanctum-report-${(r.profile.name || 'resident').replace(/[^\w฀-๿]+/g, '-')}-${dayKey()}.json`, JSON.stringify(r)); CU.msg = 'Report file saved. If nothing was saved, use the report code instead.'; } else CU.code = curEnc(r); }
  else if (d.curpexport) { const p = Object.assign({app: 'sanctum-curriculum', v: 1}, curPlan()); if (d.curpexport === 'file') curDownload('sanctum-curriculum.json', JSON.stringify(p)); else CU.code = curEnc(p); }
  else if ('curload' in d) { CU.msg = curLoadPlan(curDec(($('#curin') || {}).value)); }
  else if ('curreset' in d) { LS.set('curPlan', null); CU.msg = 'Default curriculum restored.'; }
  else if ('facadd' in d) { CU.msg = facAdd(curDec(($('#facin') || {}).value)); }
  else if (d.facdel) { const a = facReports(); delete a[d.facdel]; LS.set('facReports', a); go('#/faculty'); return; }
  else if ('faccsv' in d) { const plan = curPlan(), a = facReports(); curDownload('sanctum-residents.csv', [['Resident', 'Year', 'Institution', 'Cases', ...CUR_SKILLS.map(s => s[1])].join(',')].concat(Object.values(a).map(r => { const sm = curSummary(r.log, plan); return [r.profile.name, r.profile.year, r.profile.inst, r.log.length, ...CUR_SKILLS.map(([k]) => sm.skills[k] ? sm.skills[k].avg : '')].map(x => '"' + String(x == null ? '' : x).replace(/"/g, '""') + '"').join(','); })).join('\n')); }
  else if (d.curcat) { const [i, c] = d.curcat.split(':'); curPlanEdit(p => { const b = p.blocks[+i]; b.cats = (b.cats || []).includes(c) ? b.cats.filter(x => x !== c) : (b.cats || []).concat(c); }); const open = [...$$('.curblock')].map(x => x.open); render(); $$('.curblock').forEach((x, j) => x.open = !!open[j]); return; }
  else if (d.curbdel) curPlanEdit(p => { if (p.blocks.length > 1) p.blocks.splice(+d.curbdel, 1); });
  else if ('curbadd' in d) curPlanEdit(p => p.blocks.push({id: 'b' + Date.now().toString(36), name: 'New block', cats: [], target: 3}));
  render();
});
document.addEventListener('change', ev => {
  const t = ev.target, d = t.dataset || {};
  if (d.curp) { const p = curProfile(); p[d.curp] = String(t.value).slice(0, 80); LS.set('curProfile', p); }
  else if (d.curplan) curPlanEdit(p => { if (d.curplan === 'pass') p.pass = Math.max(30, Math.min(100, +t.value || 70)); else p.name = String(t.value).slice(0, 80) || 'Curriculum'; });
  else if (d.curb) { const [i, k] = d.curb.split(':'); curPlanEdit(p => { p.blocks[+i][k] = k === 'target' ? Math.max(0, Math.min(99, +t.value || 0)) : String(t.value).slice(0, 60) || 'Block'; }); }
  else if (t.id === 'curfile' || t.id === 'facfile') { const fs = [...t.files]; Promise.all(fs.map(f => f.text())).then(ts => { CU.msg = ts.map(x => t.id === 'curfile' ? curLoadPlan(curDec(x)) : facAdd(curDec(x))).join(' '); render(); }); }
});

async function boot() {
  applyTheme();
  clozeSwitch();
  cloudCatchLink();
  handleQueryString();
  try { const data = await loadData(); lx('set', .94); prepare(data); lx('done'); }
  catch (e) { lx('fail'); $('#main').innerHTML = `<p class="empty">Could not load the lexicon (${esc(e.message)}). If you opened index.html directly from disk, use the single-file build or serve the folder over http.</p>`; return; }
  wire();
  render();
  cloudStart();
  podInit();
  if (!matchMedia('(hover:none)').matches && route().view === 'home') $('#q').focus();
  if ('serviceWorker' in navigator && /^https?:/.test(location.protocol) && !document.getElementById('inline-data')) {
    const hadCtl = !!navigator.serviceWorker.controller; let reloaded = false;
    navigator.serviceWorker.register('sw.js', {updateViaCache: 'none'}).then(reg => {
      document.addEventListener('visibilitychange', () => { if (!document.hidden && navigator.onLine) reg.update().catch(() => {}); });
    }).catch(() => {});
    // a new app version took over: reload once so the new screens/buttons (e.g. Quiz tab) appear
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadCtl && !reloaded) { reloaded = true; location.reload(); } });
  }
  setTimeout(() => checkUpdate(false), 1500);
  
  // while the app stays open: re-check every 6 hours when online
  setInterval(() => { if (navigator.onLine) checkUpdate(false); }, 30 * 60e3);   // lexicon: every 30 min while open
  document.addEventListener('visibilitychange', () => { if (!document.hidden && navigator.onLine) checkUpdate(false); });
  window.__sanctum = {checkUpdate, monkHello: MONK_HELLO, monkAvoid: MONK_AVOID, monkStyles: MONK_STYLES, waitHTML: d => { CASE.deep = !!d; return caseWaitHTML(); }, caseUMNLoc, ddxNotDisease, ddxNormalize, isSignLike, isDisease, nameMatch, reviewBuild, caseAskNext, mergeAsk, search, norm, D: () => D, caseChief, caseUnify, casePrior, caseHeadache, caseTempo, caseComa, caseDizzy, caseResults, probFromText, train: {srNext, srQueue, srGrade, SR, rdPickScore, rdDdxScore, rdStages, wardCases, watchList, dayKey, actLog, actGet, dsData, rankOf, DS_BADGES, meqCases, meqKeyword, meqRecap, meqDraw}, cloud: {mergeKey, planBuild, planToday, planDone, planGet, cloudCatchLink, cloudApply, CLOUD, SYNC_KEYS, emailProvider}, OBJ_RULES, plLocal, caseFindings, pickChief, chiefCands, lexPages, scSegs, freeFindings, extractEntities, knownInLexicon, sync, refreshAlarm, gush: {G, gFam, GQ, gKind, gEligible}, pod: {podPickVoices, podLineAt, podPitch, podAudioOK, POD_BAD_VOICE, PC, podEp}};
  window.__sanctum.v17 = {plMergeTimeline, caseFitSort, caseTempoCat, caseAge, dxAgeClass, aiSaysNone, ddxNormalize, reviewBuild, caseHeadache, caseDizzy, caseAskNext, mergeAsk, posText};
  window.__sanctum.cur = {rsnWard, curLoadPlan, curDec, curPlan, LS, ward: wardCases, render};
}
// ------------------------------------------------------------ Cloze it
// Active-recall mode: key words on disease and sign pages become blanks; tap one blank to reveal only that word.
// The words are NOT guessed here: build.py (tools/cloze_terms.py) stores the exact strings per entry in e.cz
// {d: disease names, f: features, i: investigations, t: treatments}; this code only finds those listed strings.
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const CZ_TYPE = {d: 'disease', f: 'feature', i: 'investigation', t: 'treatment'};
const CZ_SEL = '.entry .def, .entry .list li, .entry .prose, .entry .thd, .entry .case dd, .entry .case .q, .entry .case .a, .entry .ddx .pt';
const CZ_SKIP = 'a, button, h1, h2, h3, .bd, .chips, .foot, .readmore, .small, .opts, .cz';
let clozeOn = LS.get('cloze', false) === true;          // default OFF
function clozeSwitch() {
  const b = $('#czsw'); if (!b) return;
  b.setAttribute('aria-checked', String(clozeOn));
  b.classList.toggle('on', clozeOn);
}
function clozeTerms(e) {
  const out = [];
  for (const k of ['d', 'f', 'i', 't']) for (const t of ((e.cz || {})[k] || [])) if (t && t.length >= 2) out.push([t, k]);
  return out.sort((a, b) => b[0].length - a[0].length);
}
function foldSections(view) {
  if (!(view === 'dx' || view === 'sign') || LS.get('sections', 'open') !== 'fold') return;
  const root = document.querySelector('.entry > div:first-child'); if (!root) return;
  const heads = [...root.querySelectorAll(':scope > h2.sec')]; if (heads.length < 3) return;
  heads.forEach((h, i) => {
    const body = document.createElement('div'); body.className = 'secbody';
    let n = h.nextElementSibling;
    while (n && !n.matches('h2.sec') && !n.matches('.foot')) { const nx = n.nextElementSibling; body.appendChild(n); n = nx; }
    h.after(body);
    const open = i < 2;
    h.classList.add('fold'); h.tabIndex = 0; h.setAttribute('role', 'button'); h.setAttribute('aria-expanded', open ? 'true' : 'false');
    body.hidden = !open;
  });
  const bar = document.createElement('div'); bar.className = 'foldbar';
  bar.innerHTML = '<button type="button" data-foldall="1">Expand all</button><button type="button" data-foldall="0">Collapse all</button>';
  heads[0].before(bar);
}
function foldToggle(h, force) {
  const body = h.nextElementSibling; if (!body || !body.classList.contains('secbody')) return;
  const open = force == null ? body.hidden : force;
  body.hidden = !open; h.setAttribute('aria-expanded', open ? 'true' : 'false');
}
function clozeApply(view) {
  const bar = $('#czbar'); if (bar) bar.remove();
  if (!clozeOn || !(view === 'dx' || view === 'sign')) return;
  const e = byId.get(route().arg); if (!e) return;
  const terms = clozeTerms(e); if (!terms.length) return;
  const kind = new Map(terms.map(([t, k]) => [t.toLowerCase(), [t, k]]));
  const lit = terms.map(([t]) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const rx = new RegExp(`(?<![\\w-])(?:${lit.join('|')})(?![\\w-])`, 'gi');
  let n = 0;
  document.querySelectorAll(CZ_SEL).forEach(root => {
    if (root.closest(CZ_SKIP)) return;
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {acceptNode: t => t.parentElement.closest(CZ_SKIP) && t.parentElement.closest(CZ_SKIP) !== root.closest(CZ_SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT});
    const nodes = []; while (tw.nextNode()) nodes.push(tw.currentNode);
    for (const tn of nodes) {
      if (tn.parentElement.closest(CZ_SKIP)) continue;
      const txt = tn.nodeValue; rx.lastIndex = 0;
      let m, last = 0, frag = null;
      while ((m = rx.exec(txt))) {
        const hit = kind.get(m[0].toLowerCase());
        if (!hit || (hit[0].length <= 4 && m[0] !== hit[0])) continue;   // short abbreviations: exact case only (MG ≠ mg)
        frag = frag || document.createDocumentFragment();
        if (m.index > last) frag.appendChild(document.createTextNode(txt.slice(last, m.index)));
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'cz'; b.dataset.type = CZ_TYPE[hit[1]]; b.dataset.state = 'hidden';
        b.setAttribute('aria-pressed', 'false'); b.setAttribute('aria-label', `Hidden ${CZ_TYPE[hit[1]]}. Press to reveal.`);
        const sp = document.createElement('span'); sp.className = 'cz__t'; sp.textContent = m[0]; sp.setAttribute('aria-hidden', 'true');
        b.appendChild(sp); frag.appendChild(b); n++; last = m.index + m[0].length;
      }
      if (frag) { if (last < txt.length) frag.appendChild(document.createTextNode(txt.slice(last))); tn.parentNode.replaceChild(frag, tn); }
    }
  });
  if (!n) return;
  const anchor = $('.entry .toolrow'); if (!anchor) return;
  const el = document.createElement('div'); el.id = 'czbar'; el.className = 'czbar'; el.setAttribute('aria-live', 'polite');
  el.innerHTML = `<span class="czbar__lbl">Cloze it</span><span class="czbar__track"><i style="--p:0"></i></span><span class="czbar__n" data-czn>0 / ${n}</span><span class="czbar__acts"><button type="button" class="czbar__btn" data-czall>Reveal all</button><button type="button" class="czbar__btn" data-czhide disabled>Hide all</button></span>`;
  anchor.insertAdjacentElement('afterend', el);
}
function clozeCount() {
  const all = $$('#main .cz'), shown = all.filter(b => b.dataset.state === 'revealed').length;
  const n = $('[data-czn]'); if (!n) return;
  n.textContent = `${shown} / ${all.length}`;
  $('#czbar i').style.setProperty('--p', all.length ? shown / all.length : 0);
  $('[data-czhide]').disabled = !shown; $('[data-czall]').disabled = shown === all.length;
}
function clozeSet(b, on) {
  b.dataset.state = on ? 'revealed' : 'hidden'; b.setAttribute('aria-pressed', String(on));
  b.setAttribute('aria-label', on ? `${b.textContent} (${b.dataset.type}). Press to hide again.` : `Hidden ${b.dataset.type}. Press to reveal.`);
}
// "Peek": press and hold a blank to lift the cover a little; drag sideways to peel it further.
// Let go and it falls back — unless you peeled it almost all the way, then the word stays revealed.
const czPeek = {el: null, x0: 0, y0: 0, w: 1, timer: 0, on: false, swallow: false};
function czPeekSet(el, p) { el.style.setProperty('--pk', Math.max(0, Math.min(1, p)).toFixed(3)); }
function czPeekEnd(keep) {
  const P = czPeek, el = P.el; clearTimeout(P.timer); P.el = null;
  if (!el || !P.on) return;
  P.on = false; P.swallow = true; setTimeout(() => { P.swallow = false; }, 400);   // the click that follows a peek is not a tap
  const pk = parseFloat(el.style.getPropertyValue('--pk')) || 0;
  el.classList.remove('peeking');
  if (keep && pk >= 0.8) { clozeSet(el, true); clozeCount(); }
  el.style.removeProperty('--pk');
}
document.addEventListener('pointerdown', ev => {
  const el = ev.target.closest('#main .cz[data-state="hidden"]'); if (!el || ev.button > 0) return;
  const P = czPeek; P.el = el; P.x0 = ev.clientX; P.y0 = ev.clientY; P.w = Math.max(40, el.getBoundingClientRect().width); P.on = false;
  P.timer = setTimeout(() => { if (P.el !== el) return; P.on = true; el.classList.add('peeking'); czPeekSet(el, .38); try { navigator.vibrate && navigator.vibrate(8); } catch (e) {} }, 220);
});
document.addEventListener('pointermove', ev => {
  const P = czPeek, el = P.el; if (!el) return;
  const dx = ev.clientX - P.x0, dy = ev.clientY - P.y0;
  if (!P.on) {
    if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { clearTimeout(P.timer); P.el = null; return; }   // the user is scrolling
    if (dx > 6) { clearTimeout(P.timer); P.on = true; el.classList.add('peeking'); }
    else return;
  }
  czPeekSet(el, Math.max(.38 * (dx < 6 ? 1 : 0), dx / P.w));
});
document.addEventListener('pointerup', () => czPeekEnd(true));
document.addEventListener('pointercancel', () => czPeekEnd(false));
document.addEventListener('contextmenu', ev => { if (ev.target.closest('#main .cz')) ev.preventDefault(); });
document.addEventListener('click', ev => {
  const t = ev.target;
  if (t.closest('#czsw')) { clozeOn = !clozeOn; LS.set('cloze', clozeOn); clozeSwitch(); const y = window.scrollY; render(); window.scrollTo(0, y); toast(clozeOn ? 'Cloze it on — tap a blank to reveal it' : 'Cloze it off'); return; }
  const b = t.closest('#main .cz');
  if (b) { ev.preventDefault(); if (czPeek.swallow) { czPeek.swallow = false; return; } clozeSet(b, b.dataset.state !== 'revealed'); clozeCount(); return; }
  if (t.closest('[data-czall]')) { $$('#main .cz').forEach(x => clozeSet(x, true)); clozeCount(); return; }
  if (t.closest('[data-czhide]')) { $$('#main .cz').forEach(x => clozeSet(x, false)); clozeCount(); }
});
boot();
})();
