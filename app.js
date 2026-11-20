'use strict';
/* Книжная полка – iPad reading app. Plain JS, no build step.
 * Progress lives in the Google Sheet behind the Apps Script back end (backend/Code.gs) and is cached in
 * localStorage, so reading works offline; writes queue up and are sent when there is signal.
 * All content – catalogue, book texts, pictures, placement test – lives in the private Google Drive folder
 * that holds the progress Sheet (sub-folders Книги, Картинки) and comes through the back end with the APP_KEY. Without a connection the public site
 * shows only a lock screen. On a local computer (localhost) it runs against Mock (mock.js) and drive/. */

// ------------------------------------------------------------- basics ---

const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v, d) => (isFinite(parseFloat(v)) ? parseFloat(v) : d);
const yes = v => v === true || v === 'true';
const fmt = n => Number(n).toLocaleString('ru-RU');
const IS_LOCAL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);

const store = {
  get(k, d) { try { const v = localStorage.getItem('polka_' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('polka_' + k, JSON.stringify(v)); } catch (e) { /* storage full or blocked */ } },
};

const pad = n => String(n).padStart(2, '0');
function iso(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function today() { return iso(new Date()); }
function parseIso(s) { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return new Date(y, (m || 1) - 1, d || 1); }
function addDays(s, n) { const d = parseIso(s); d.setDate(d.getDate() + n); return iso(d); }
/** Weeks run Monday–Sunday. */
function weekStart(s) { const d = parseIso(s || today()); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return iso(d); }
function monthsBetween(from, to) {
  const a = parseIso(from), b = parseIso(to);
  return (b.getFullYear() - a.getFullYear()) * 12 + b.getMonth() - a.getMonth() - (b.getDate() < a.getDate() ? 1 : 0);
}
function plural(n, one, few, many) {
  const a = n % 10, b = n % 100;
  return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
}
/** 9 лет 3 мес. */
function ym(m) {
  const y = Math.floor(m / 12), r = m % 12;
  return y + ' ' + plural(y, 'год', 'года', 'лет') + (r ? ' ' + r + ' мес.' : '');
}
/** Same pseudo-random order every time for the same seed. */
function seeded(list, seed) {
  let h = 0; for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) { h = (h * 1103515245 + 12345) >>> 0; const j = h % (i + 1); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

let toastTimer;
function toast(msg, err) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (err ? ' err' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, err ? 6000 : 3000);
}

// ---------------------------------------------------------------- api ---

function cfg() { return store.get('cfg', { api: '', key: '' }); }
function connected() { return !!cfg().api; }

async function api(action, payload) {
  const c = cfg();
  if (!c.api) {
    if (!IS_LOCAL) throw new Error('Приложение не подключено');
    return Mock.call(action, JSON.parse(JSON.stringify(payload || {})));
  }
  const res = await fetch(c.api, { method: 'POST', body: JSON.stringify(Object.assign({}, payload, { action, key: c.key })) });
  const j = await res.json();
  if (!j.ok) throw new Error(j.error);
  return j.data;
}

/** Runs an api call, showing errors as a toast. Returns undefined on failure. */
async function run(action, payload) {
  try { return await api(action, payload); } catch (e) { toast(/fetch|network|load/i.test(e.message) ? 'Нет связи. Попробуй ещё раз, когда будет интернет.' : e.message, true); }
}

let D = store.get('cache', null); // everything from bootstrap
const UI = { genre: 'all', len: 'all', shelfSort: 'recent', pin: '', parentOk: false, check: {}, bz: null, r: null, chat: null, test: null };

function S() { return (D && D.settings) || {}; }
function saveCache() { store.set('cache', D); }

/* Writes go into an outbox first (so nothing is lost without wifi) and are sent in order.
   Each op is applied to the local copy straight away. */
const KEYS = { Progress: 'book_id', Checks: 'id', Words: 'key', Ledger: 'id' };
const LOCAL = { Progress: 'progress', Checks: 'checks', Words: 'words', Ledger: 'ledger' };
const OUTBOX = store.get('outbox', []);

function save(ops, settings) {
  (ops || []).forEach(op => {
    const list = D[LOCAL[op.t]];
    op.rows.forEach(r => {
      const i = list.findIndex(x => String(x[KEYS[op.t]]) === String(r[KEYS[op.t]]));
      if (i < 0) list.push(Object.assign({}, r)); else list[i] = Object.assign({}, list[i], r);
    });
  });
  Object.assign(D.settings, settings || {});
  saveCache();
  OUTBOX.push({ ops: ops || [], settings: settings || null });
  store.set('outbox', OUTBOX);
  flush();
}

async function flush() {
  if (flush.on || !OUTBOX.length) return;
  flush.on = true;
  try {
    while (OUTBOX.length) {
      const res = await api('save', OUTBOX[0]);
      OUTBOX.shift();
      store.set('outbox', OUTBOX);
      if (!OUTBOX.length && res) { D = res; saveCache(); }
    }
  } catch (e) { /* no signal – try again later */ } finally { flush.on = false; }
}
window.addEventListener('online', () => { flush(); flushPages(); });

const rid = () => 'r' + Math.random().toString(36).slice(2, 9);
function ledger(kind, mins, ref, note) {
  return { t: 'Ledger', rows: [{ id: rid(), date: today(), kind, mins, ref: ref || '', note: note || '' }] };
}

// ----------------------------------------------------------- content ---

let BOOKS = {}, AUTHORS = {}, LIB_ORDER = [], CASES = [], SECRETS = {};
function useCatalog(c) {
  BOOKS = c.books || {}; AUTHORS = c.authors || {}; LIB_ORDER = c.order || Object.keys(BOOKS);
  CASES = c.cases || []; SECRETS = c.secrets || {};
}
useCatalog(store.get('catalog', {}));

/* Content files (books, placement test) and pictures are kept in the browser's cache storage after the
   first download, so a book that has been opened once reads without wifi. */
const CACHE_NAME = 'polka-content-v1';
const cacheKey = name => location.origin + '/__content/' + name;
// Cache storage can be missing or stall (private browsing, some test browsers): give up after a moment.
let cacheOk = typeof caches !== 'undefined';
const within = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('slow')), ms))]);
async function cacheGet(name) {
  if (!cacheOk) return null;
  try { const c = await within(caches.open(CACHE_NAME), 1500); const r = await within(c.match(cacheKey(name)), 1500); return r || null; } catch (e) { cacheOk = false; return null; }
}
async function cachePut(name, response) {
  if (!cacheOk) return;
  try { const c = await within(caches.open(CACHE_NAME), 1500); await c.put(cacheKey(name), response); } catch (e) { cacheOk = false; }
}

const JSONCACHE = {};
async function content(name, fresh) {
  if (JSONCACHE[name] && !fresh) return JSONCACHE[name];
  try {
    const data = await api('content', { name });
    JSONCACHE[name] = data;
    cachePut(name, new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } }));
    return data;
  } catch (e) {
    const r = await cacheGet(name);
    if (r) { JSONCACHE[name] = await r.json(); return JSONCACHE[name]; }
    throw e;
  }
}
async function loadBook(id) {
  const b = BOOKS[id];
  if (!b || !b.ready) throw new Error('Эту книгу я ещё готовлю');
  return content(id + '.json');
}
function bookNow(id) { return JSONCACHE[id + '.json'] || null; }

/* Pictures: <img data-asset="name"> gets its src filled in after render (from the cache, or in small batches
   from Drive). */
const ASSETS = {};
async function hydrate() {
  const imgs = [...document.querySelectorAll('img[data-asset]')].filter(i => !i.getAttribute('src'));
  if (!imgs.length) return;
  const need = [...new Set(imgs.map(i => i.dataset.asset))];
  const missing = [];
  for (const name of need) {
    if (ASSETS[name]) continue;
    const r = await cacheGet('img/' + name);
    if (r) ASSETS[name] = URL.createObjectURL(await r.blob()); else missing.push(name);
  }
  const fill = () => document.querySelectorAll('img[data-asset]').forEach(i => { if (!i.getAttribute('src') && ASSETS[i.dataset.asset]) i.src = ASSETS[i.dataset.asset]; });
  fill();
  for (let k = 0; k < missing.length; k += 6) {
    let got;
    try { got = await api('assets', { names: missing.slice(k, k + 6) }); } catch (e) { return; }
    for (const name of Object.keys(got)) {
      const v = got[name];
      if (!v) continue;
      if (/^data:/.test(v)) {
        const blob = await (await fetch(v)).blob();
        cachePut('img/' + name, new Response(blob));
        ASSETS[name] = URL.createObjectURL(blob);
      } else ASSETS[name] = v; // demo mode: a plain file URL
    }
    fill();
  }
}
const asset = (name, attrs) => name ? '<img data-asset="' + esc(name) + '" alt="" ' + (attrs || '') + '>' : '';

async function load() {
  if (!connected() && !IS_LOCAL) { render(); return; }
  try {
    const [fresh, cat] = await Promise.all([api('bootstrap', {}), api('content', { name: 'catalog.json' })]);
    useCatalog(cat);
    store.set('catalog', cat);
    if (!OUTBOX.length) { D = fresh; saveCache(); }
    flush();
  } catch (e) {
    if (!D || !Object.keys(BOOKS).length) { $('#view').innerHTML = '<div class="page"><div class="card">Не получилось загрузить данные. Проверь интернет и открой приложение ещё раз.<br><br><span class="small muted">' + esc(e.message) + '</span></div></div>'; return; }
  }
  render();
}

// --------------------------------------------------------- derived ---

function balance() { return (D.ledger || []).reduce((a, r) => a + num(r.mins, 0), 0); }
function pendingReq() { return (D.requests || []).find(r => r.status === 'pending'); }
function progressOf(id) { return (D.progress || []).find(p => p.book_id === id); }
function isDone(id) { const p = progressOf(id); return !!(p && p.status === 'done'); }
function doneRows() { return (D.progress || []).filter(p => p.status === 'done'); }
function doneIds() { return doneRows().map(p => p.book_id); }
function passedCh(id) { const p = progressOf(id); return p ? num(p.chapters_passed, 0) : 0; }
function chapterChecks() { return (D.checks || []).filter(c => c.book_id !== 'blitz' && c.chapter !== 'final'); }
function placed() { return !!S().placement_date; }
function calibrated() { return placed() || chapterChecks().filter(c => yes(c.passed)).length >= 3; }
function langMonths() { return num(S().lang_months, 111); }
function hisMonths() { return S().dob ? monthsBetween(S().dob, today()) : 120; }
function wpm() { return num(S().wpm, 150); }
function aiOn() { return yes(S().ai_enabled); }
function aiLeft() { const s = S(); return num(s.ai_per_day, 20) - (s.ai_used_date === today() ? num(s.ai_used, 0) : 0); }

// Difficulty: harder books pay more (capped at +25%), easier ones less. More than 2 years above: "later".
const MULT = { '-2': 0.75, '-1': 0.9, '0': 1, '1': 1.15, '2': 1.25 };
function ageDiff(b) { return b.age - Math.floor(langMonths() / 12); }
function tooHard(b) { return ageDiff(b) > 2; }
function mult(b) { return MULT[String(Math.max(-2, Math.min(2, ageDiff(b))))]; }
const ru = x => String(x).replace('.', ',');
function readMins(words, b) { return words / wpm() * num(S().ratio, 0.5) * mult(b); }
function chMins(b, words) { return Math.max(1, Math.round(readMins(words, b))); }
function bookMins(b) { return Math.round(readMins(b.words, b)); }
function finalMins(b) { return Math.round(bookMins(b) * num(S().final_pct, 50) / 100); }
// A printed page of a Russian children's book holds about 230 words.
function pagesOf(b) { const n = num(b.words, 0) / 230; return n < 10 ? Math.max(1, Math.round(n)) : Math.round(n / 5) * 5; }
function pagesText(b) { return '≈ ' + pagesOf(b) + ' стр.'; }
function readHours(b) {
  const m = b.words / wpm();
  return m < 60 ? '≈ ' + Math.max(5, Math.round(m / 5) * 5) + ' мин чтения' : '≈ ' + ru(Math.round(m / 30) / 2) + ' ч чтения';
}
function levelChip(b) {
  const d = ageDiff(b);
  if (d > 2) return '<span class="lvl later">' + b.age + '+ лет</span>';
  return '<span class="lvl ' + (d > 0 ? 'up' : d < 0 ? 'down' : 'eq') + '">' + b.age + '+ лет · ×' + ru(mult(b)) + '</span>';
}

/* Word coverage: the share of a book's running words he probably knows, from the placement test
   (how much of each frequency band he knows) and the book's band profile. 98% = easy, 95% = with effort. */
function vocabBands() { try { const v = JSON.parse(S().vocab_bands || 'null'); return Array.isArray(v) ? v : null; } catch (e) { return null; } }
function coverage(b) {
  const p = vocabBands();
  if (!p || !b.bands) return null;
  return b.bands.reduce((a, share, i) => a + share * (p[i] == null ? 0 : p[i]), 0);
}
const pct = x => ru(Math.round(x * 1000) / 10) + '%';

/** Words read in passed chapter checks over the last 90 days → reader title. */
function words90() {
  const from = addDays(today(), -90);
  return (D.checks || []).filter(c => yes(c.passed) && c.book_id !== 'blitz' && c.date >= from).reduce((a, c) => a + num(c.words, 0), 0);
}
function rankIdx(w) { let r = 0; RANKS.forEach((k, i) => { if (w >= k.min) r = i; }); return r; }

function authorOf(b) { return AUTHORS[b.author] || { name: b.author || '', short: b.author || '', years: '', bio: '' }; }
function coverHtml(b, w, h, fs) {
  if (b.cover) return asset(b.cover, 'class="cover" style="width:' + w + ';height:' + h + 'px"');
  return '<div class="cloth" style="width:' + w + ';height:' + h + 'px;background:' + (b.color || '#5B6475') + ';font-size:' + fs + 'px">' + esc(b.short || b.title) + '</div>';
}

// Answer options are written right-answer-first; this rotates them the same way every time.
function shuffle(opts, key) {
  let h = 0; for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 997;
  const k = h % opts.length;
  return { opts: opts.slice(k).concat(opts.slice(0, k)), a: (opts.length - k) % opts.length };
}
const TOKEN = /\{(\w+)\|([^}]+)\}/g;
function hardIds(ch) {
  const ids = [];
  ch.blocks.forEach(bl => { if (typeof bl === 'string') bl.replace(TOKEN, (m, id) => { if (ids.indexOf(id) < 0) ids.push(id); return m; }); });
  return ids;
}

/* Daily activity kept on this device: pages, reading seconds, hours of the day, hearts, Блиц details.
   Used for quests and achievements. */
function stats() { return store.get('stats', {}); }
function bump(field, n) {
  const s = stats(), t = today();
  s[t] = s[t] || {};
  s[t][field] = (s[t][field] || 0) + (n == null ? 1 : n);
  store.set('stats', s);
}
function bumpHour() {
  const s = stats(), t = today(), h = new Date().getHours();
  s[t] = s[t] || {};
  s[t].hours = s[t].hours || {};
  s[t].hours[h] = (s[t].hours[h] || 0) + 1;
  store.set('stats', s);
}
const readDay = d => (d.pages || 0) >= 3;

// ------------------------------------------------------------- words ---

function wordRow(key) { return (D.words || []).find(w => w.key === key); }
function newWord(bookId, id, base, src) {
  return { key: bookId + ':' + id, book_id: bookId, word_id: id, base, st: 'learning', s: 0, due: today(), misses: 0, src, added: today(), last: '' };
}
/** After a right answer: 1 → tomorrow, 2 → in 3 days, 3 → rests for a month. */
function rightAnswer(w) {
  if (w.st === 'archived') return { st: 'learned', s: 3, due: '', last: today() };
  const s = num(w.s, 0) + 1;
  return s >= 3 ? { st: 'archived', s: 3, due: addDays(today(), 30), last: today() } : { s, due: addDays(today(), s === 1 ? 1 : 3), last: today() };
}
function wrongAnswer(w) { return { st: 'learning', s: 0, due: today(), misses: num(w.misses, 0) + 1, last: today() }; }

// ------------------------------------------------------------ router ---

const VIEWS = {};
function route() {
  const h = location.hash.replace(/^#\/?/, '') || 'home';
  const [path, qs] = h.split('?');
  const parts = path.split('/');
  return { name: parts[0], a: decodeURIComponent(parts[1] || ''), b: decodeURIComponent(parts[2] || ''), q: new URLSearchParams(qs || '') };
}
const TABS = ['home', 'library', 'quests', 'collection', 'me'];

function render() {
  const r = route();
  if (r.name === 'connect') return connectFromLink(r.q);
  if (!connected() && !IS_LOCAL) { $('#tabs').hidden = true; $('#view').innerHTML = VIEWS.lock(); return; }
  if (!D) return;
  const view = VIEWS[r.name] || VIEWS.home;
  if (r.name !== 'read') leaveReader();
  const tabs = $('#tabs');
  tabs.hidden = TABS.indexOf(r.name) < 0;
  tabs.querySelectorAll('a').forEach(a => a.classList.toggle('on', a.dataset.tab === r.name));
  const out = view(r);
  const at = location.hash;
  if (out instanceof Promise) out.then(html => { if (html != null && location.hash === at) { $('#view').innerHTML = html; afterRender(r); } });
  else { $('#view').innerHTML = out; afterRender(r); }
}
function afterRender(r) {
  if (r.name === 'read') layoutReader(true);
  hydrate();
}
window.addEventListener('hashchange', () => { closeSheet(); render(); window.scrollTo(0, 0); });

const ICON = {
  back: '<svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M9 18l6-6-6-6"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  chat: '<svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>',
  lock: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  unlock: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/></svg>',
  bolt: '<svg width="20" height="20" viewBox="0 0 24 24" fill="#F0A42C"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg>',
  coin: '<svg width="26" height="26" viewBox="0 0 26 26"><circle cx="13" cy="13" r="12" fill="#F0A42C"/><circle cx="13" cy="13" r="8.5" fill="none" stroke="#B8740F" stroke-width="1.6"/><path d="M13 8.5V13l3 2" fill="none" stroke="#7A4A05" stroke-width="2" stroke-linecap="round"/></svg>',
};
const info = key => '<button class="info" data-act="info" data-k="' + key + '" aria-label="Подробнее">i</button>';
const backBtn = to => '<a class="icon-btn" href="#/' + to + '" aria-label="Назад">' + ICON.back + '</a>';

const INFO = {
  lock: 'Начатую книгу нужно дочитать, прежде чем начать следующую. Сменить её раньше можно с разрешения родителя.',
  mult: 'Книги разложены по возрасту: для какого возраста они обычно у носителей языка. Книга выше твоего уровня даёт больше минут, до ×1,25; ниже — меньше, до ×0,75. Слишком сложные откроются, когда твой уровень вырастет.',
  level: 'Это возраст ребёнка, для которого русский родной и который читает такие же книги, как ты. Он растёт, когда ты проходишь проверки глав (особенно в книгах выше уровня) и учишь новые слова. Это оценка, а не экзамен.',
  cover: 'Сколько слов из книги ты, скорее всего, знаешь — по тесту на уровень. Имена героев не считаются. Чем больше, тем легче читать.',
  ranks: 'Звание считается по словам, прочитанным за последние 3 месяца. Если перестать читать, оно может опуститься — и снова подняться, когда вернёшься к книгам.',
  bingo: 'Каждая прочитанная книга закрывает одну подходящую клетку. Ряд, столбец или диагональ — +10 мин, вся карточка — +30 мин. Потом можно начать новую карточку с другими клетками.',
  blitz: 'Слово уходит из списка после трёх верных ответов в разные дни: значение, слово в предложении, слово по значению. Ошибка — и слово начинает заново и вернётся ещё в этом раунде. После трёх ответов слово отдыхает месяц, потом одна проверка.',
  quiz: 'Для зачёта нужно 3 верных из 4.',
  final: 'Финальная проверка по всей книге: нужно 6 верных из 8.',
  ai: 'Можно спросить о том, что ты уже прочитал: что значит слово или фраза, почему герой так поступил. Ответы не рассказывают, что будет дальше.',
  quests: 'Каждый день — три новых задания, каждую неделю — два недельных. Комбо — если сделать все три задания дня.',
};

// -------------------------------------------------------------- lock ---

VIEWS.lock = () => `<div class="page full" style="max-width:560px;padding-top:120px">
  <div style="font-size:34px;font-weight:700">Книжная полка</div>
  <div class="card stack" style="gap:14px">
    <div style="font-size:18px;line-height:1.5">Чтобы открыть полку, нужна ссылка-приглашение. Её присылает родитель.</div>
    <details><summary class="small muted" style="cursor:pointer">Для родителей: подключить вручную</summary>
      <div class="stack" style="margin-top:12px">
        <input class="field" id="cfgApi" placeholder="Адрес веб-приложения (…/exec)">
        <input class="field" id="cfgKey" placeholder="APP_KEY">
        <button class="btn small" data-act="connect" style="align-self:flex-start">Подключить</button></div></details>
  </div></div>`;

// -------------------------------------------------------------- home ---

function demoBanner() {
  return connected() ? '' : '<div class="demo">Демо-режим на этом компьютере. PIN для родителей — 1234.</div>';
}
function shortlist() { return String(S().shortlist || '').split(',').filter(id => BOOKS[id]); }

VIEWS.home = () => {
  const s = S();
  const bal = balance(), pend = pendingReq();
  const cur = BOOKS[s.cur_book];
  const w90 = words90(), ri = rankIdx(w90), R = RANKS[ri], N = RANKS[ri + 1];
  const cal = calibrated();
  const langPct = cal ? num(s.lang_prog, 0) : chapterChecks().filter(c => yes(c.passed)).length / 3;
  const tracks = `
    <div class="grid2">
      <a class="track" href="#/me"><div class="badge" style="background:#121826;color:#F0A42C">${cal ? Math.floor(langMonths() / 12) : '?'}</div>
        <div class="grow"><div class="row" style="gap:8px;align-items:baseline"><span class="tiny muted">Язык</span><b>${cal ? ym(langMonths()) : 'после 3 проверок'}</b></div>
        <div class="bar amber" style="margin-top:8px"><i style="width:${Math.round(langPct * 100)}%"></i></div></div></a>
      <a class="track" href="#/me"><div class="badge" style="background:${R.bg};color:${R.ink}">${ri + 1}</div>
        <div class="grow"><div class="row" style="gap:8px;align-items:baseline"><span class="tiny muted">Начитанность</span><b>${R.name}</b></div>
        <div class="bar" style="margin-top:8px"><i style="width:${N ? Math.round((w90 - R.min) / (N.min - R.min) * 100) : 100}%"></i></div></div></a>
    </div>`;

  let current;
  if (cur) {
    const passed = passedCh(s.cur_book);
    const allPassed = passed >= (cur.chapters || 1);
    const segs = Array.from({ length: cur.chapters || 1 }, (_, i) => '<i class="' + (i < passed ? 'done' : i === passed ? 'now' : '') + '"></i>').join('');
    const nextCh = Math.min(passed + 1, cur.chapters || 1);
    const bookData = bookNow(s.cur_book);
    const chData = bookData && bookData.chapters[nextCh - 1];
    const line = allPassed ? 'Все главы пройдены · осталась финальная проверка'
      : 'Глава ' + nextCh + ' из ' + cur.chapters + (chData && chData.title ? ' · ' + esc(chData.title) : '');
    const chPay = chData ? chMins(cur, chData.words) : Math.max(1, Math.round(readMins(cur.words / (cur.chapters || 1), cur)));
    current = `
      <section class="card big current">
        <a href="#/book/${s.cur_book}" aria-label="О книге">${coverHtml(cur, '150px', 216, 18)}</a>
        <div class="grow stack" style="gap:8px">
          <div class="row" style="align-items:flex-start;gap:8px">
            <a class="grow" href="#/book/${s.cur_book}" style="font-size:28px;font-weight:700;line-height:1.15">${esc(cur.title)}</a>
            <button class="lockbtn ${yes(s.locked) ? '' : 'open'}" data-act="info" data-k="lock" aria-label="Почему книга закреплена">${yes(s.locked) ? ICON.lock : ICON.unlock}</button>
          </div>
          <div class="muted">${esc(authorOf(cur).short)}</div>
          <div style="line-height:1.45;color:var(--ink2)">${esc(cur.oneLiner || '')}</div>
          <div class="segs" style="margin-top:8px">${segs}</div>
          <div class="small muted">${line}</div>
          <div class="row" style="margin-top:auto;padding-top:6px;gap:16px">
            ${cur.ready ? (allPassed
              ? `<a class="btn" href="#/check/${s.cur_book}/final">Финальная проверка</a>`
              : `<a class="btn" href="#/read/${s.cur_book}/${nextCh}">${passed ? 'Читать главу ' + nextCh : 'Читать'}</a>`)
              : '<span class="muted">Книгу ещё готовлю</span>'}
            <div class="stack" style="gap:2px">
              ${allPassed ? '' : `<b style="font-size:15px">+${chPay} мин за главу</b>`}
              <span class="small" style="color:var(--amber-ink);font-weight:600">+${finalMins(cur)} мин за всю книгу</span>
            </div>
          </div>
        </div>
      </section>`;
    if (cur.ready && !bookData) loadBook(s.cur_book).then(() => { if (route().name === 'home') render(); }).catch(() => {});
  } else {
    current = '<section class="card big stack"><b style="font-size:20px">Выбери, что читать</b><div class="muted">Отметь книги ♡ в библиотеке и выбери одну.</div><a class="btn" href="#/library" style="align-self:flex-start">Библиотека</a></section>';
  }

  const short = shortlist().filter(id => id !== s.cur_book);
  const shortHtml = short.length ? '<div class="row" style="gap:14px;overflow-x:auto;padding-bottom:4px">' + short.map(id => {
    const b = BOOKS[id];
    return `<a class="shortcard ${s.next_book === id ? 'next' : ''}" href="#/book/${id}">${coverHtml(b, '118px', 170, 14)}
      <b style="font-size:14px;line-height:1.25">${esc(b.short)}</b>${s.next_book === id ? '<span class="tiny" style="color:var(--blue);font-weight:700">✓ Следующая</span>' : ''}</a>`;
  }).join('') + '</div>' : '<a class="empty" href="#/library">♡ Отмечай книги в библиотеке</a>';

  const due = dueCount();
  const q = questList(), qDone = q.filter(x => x.p >= x.n).length, nextQ = q.find(x => x.p < x.n);
  return `<div class="page">
    ${demoBanner()}
    <header class="head"><h1>Книжная полка</h1>
      <div class="coin">${ICON.coin}<b>${bal}</b><span class="muted">мин${pend ? ' · ' + pend.mins + ' ждут' : ''}</span></div>
      <button class="btn small dark" data-act="redeem" ${pend || bal < 15 ? 'disabled' : ''}>Потратить</button>
    </header>
    ${tracks}
    ${!placed() ? `<a class="card row" href="#/test" style="gap:14px"><span style="font-size:28px">🧭</span><div class="grow"><b>Тест на уровень · 10 минут</b><div class="small muted">Узнай, какие книги тебе по силам</div></div><span class="pill">Начать ›</span></a>` : ''}
    ${current}
    <section class="stack" style="gap:12px">
      <div class="row"><h2 class="grow" style="margin:0">Хочу прочитать</h2><a class="pill" href="#/library">Библиотека ›</a></div>
      ${shortHtml}
    </section>
    <div class="grid2">
      <a class="tile dark" href="#/blitz"><div class="t">${ICON.bolt}Блиц</div><div style="color:var(--dark-muted)">${due ? 'На сегодня ' + due + ' · +' + num(s.blitz_reward, 1) + ' мин за 5 верных' : 'На сегодня всё'}</div></a>
      <a class="tile light" href="#/quests"><div class="t">Задания<span class="small muted" style="margin-left:auto">${qDone} из ${q.length}</span></div>
        <div class="bar green"><i style="width:${Math.round(qDone / q.length * 100)}%"></i></div>
        <div class="small muted">${nextQ ? esc(nextQ.text.split('.')[0]) + ' · +' + nextQ.r + ' мин' : 'Все задания выполнены'}</div></a>
    </div>
  </div>`;
};

// ----------------------------------------------------------- library ---

VIEWS.library = () => {
  const GENRES = [['all', 'Все'], ['Сказка', 'Сказки'], ['Рассказ', 'Рассказы'], ['Повесть', 'Повести'], ['Роман', 'Романы'], ['Приключения', 'Приключения'], ['Детектив', 'Детективы'], ['Фантастика', 'Фантастика'], ['Юмор', 'Смешное'], ['Война', 'Про войну'], ['Про животных', 'Про животных'], ['Стихи', 'Стихи'], ['Нон-фикшн', 'Нон-фикшн']];
  const LENS = [['all', 'Любой длины'], ['short', 'Короткие'], ['mid', 'Средние'], ['long', 'Длинные']];
  const lenOf = b => (b.words < 8000 ? 'short' : b.words < 25000 ? 'mid' : 'long');
  const match = b => (UI.genre === 'all' || b.genre === UI.genre || has(b.themes, UI.genre)) && (UI.len === 'all' || lenOf(b) === UI.len);
  const ids = LIB_ORDER.concat(Object.keys(BOOKS).filter(id => LIB_ORDER.indexOf(id) < 0)).filter(id => BOOKS[id] && match(BOOKS[id]) && !isDone(id));
  const hearts = shortlist();
  const card = id => {
    const b = BOOKS[id], cur = id === S().cur_book, on = hearts.indexOf(id) > -1;
    return `<div class="libcard ${cur ? 'cur' : ''} ${tooHard(b) ? 'later' : ''}">
      <a href="#/book/${id}">${coverHtml(b, '84px', 122, 12)}</a>
      <a class="main" href="#/book/${id}">
        <b style="font-size:16px;line-height:1.25">${esc(b.short)}</b>
        <span class="small muted">${esc(authorOf(b).short)} · ${b.year}</span>
        <span class="tiny muted">${[b.genre].concat(b.themes || []).map(esc).join(' · ')}</span>
        <span class="row wrap" style="gap:6px;margin-top:2px">${levelChip(b)}<span class="tiny" style="color:var(--ink2)">${pagesText(b)} · ${readHours(b).replace('≈ ', '')}</span>${b.ready ? '' : '<span class="soon">скоро</span>'}</span>
      </a>
      ${cur ? '<span class="heart" style="display:flex;align-items:center;justify-content:center">📖</span>'
        : tooHard(b) ? '' : `<button class="heart ${on ? 'on' : ''}" data-act="heart" data-id="${id}" aria-label="Хочу прочитать">${on ? '♥' : '♡'}</button>`}
    </div>`;
  };
  const groups = [
    ['Твой уровень', 'читаются легко', id => ageDiff(BOOKS[id]) <= 0, 'var(--muted)'],
    ['Вызов', 'больше минут', id => ageDiff(BOOKS[id]) > 0 && !tooHard(BOOKS[id]), 'var(--amber-ink)'],
    ['Позже', 'откроются с уровнем', id => tooHard(BOOKS[id]), 'var(--faint)'],
  ].map(([t, note, f, c]) => {
    const list = ids.filter(f);
    return list.length ? `<section class="stack" style="margin-top:6px"><div class="row" style="align-items:baseline"><h2 style="margin:0">${t}</h2><span class="small" style="color:${c}">${note}</span></div>
      <div class="grid2">${list.map(card).join('')}</div></section>` : '';
  }).join('');
  return `<div class="page">
    <header class="head"><h1>Библиотека</h1>${info('mult')}</header>
    <div class="row wrap" style="gap:8px">${GENRES.map(([k, l]) => `<button class="chip ${UI.genre === k ? 'on' : ''}" data-act="genre" data-k="${k}">${l}</button>`).join('')}</div>
    <div class="row wrap" style="gap:8px">${LENS.map(([k, l]) => `<button class="chip ${UI.len === k ? 'on' : ''}" data-act="len" data-k="${k}">${l}</button>`).join('')}</div>
    ${groups || '<div class="empty">Таких книг пока нет</div>'}
  </div>`;
};

// --------------------------------------------------------- book page ---

VIEWS.book = r => {
  const id = r.a, b = BOOKS[id];
  if (!b) return VIEWS.home();
  const s = S(), A = authorOf(b);
  const isCur = id === s.cur_book, done = isDone(id), hard = tooHard(b);
  const hearted = shortlist().indexOf(id) > -1, isNext = s.next_book === id;
  const p = progressOf(id);
  const canStartNow = !s.cur_book || !yes(s.locked);
  let action = '';
  if (isCur && b.ready) {
    const passed = passedCh(id);
    action = passed >= (b.chapters || 1) ? `<a class="btn" href="#/check/${id}/final" style="align-self:flex-start;margin-top:10px">Финальная проверка</a>`
      : `<a class="btn" href="#/read/${id}/${passed + 1}" style="align-self:flex-start;margin-top:10px">${passed ? 'Читать главу ' + (passed + 1) : 'Читать'}</a>`;
  } else if (!isCur && !done && !hard) {
    action = canStartNow
      ? `<button class="btn" data-act="startBook" data-id="${id}" style="align-self:flex-start;margin-top:10px" ${b.ready ? '' : 'disabled'}>${b.ready ? 'Начать сейчас' : 'Скоро'}</button>`
      : `<button class="btn ${isNext ? 'ghost' : ''}" data-act="pickNext" data-id="${id}" style="align-self:flex-start;margin-top:10px">${isNext ? '✓ Следующая' : 'Читать следующей'}</button>`;
  } else if (hard) {
    action = '<div class="fact" style="margin-top:8px">Откроется, когда твой уровень дойдёт до ' + (b.age - 2) + ' лет</div>';
  }
  const ills = (b.ills || []).map(n => asset(n, 'class="ill" data-act="zoom"')).join('');
  let review = '';
  if (done) {
    if (p && num(p.stars, 0)) {
      review = `<section class="stack" style="padding-top:18px;border-top:1px solid var(--line)"><h2>Твой отзыв</h2>
        <div class="stars">${'★★★★★'.slice(0, num(p.stars, 0))}${'☆☆☆☆☆'.slice(0, 5 - num(p.stars, 0))}</div>
        ${p.review ? '<div class="review">«' + esc(p.review) + '»</div>' : ''}</section>`;
    } else {
      const st = UI.draftStars || 0;
      review = `<section class="stack" id="review" style="padding-top:18px;border-top:1px solid var(--line)"><h2>Оцени книгу</h2>
        <div class="row" style="gap:10px">${[1, 2, 3, 4, 5].map(n => `<button class="starbtn ${n <= st ? 'on' : ''}" data-act="star" data-n="${n}" aria-label="${n} из 5">★</button>`).join('')}</div>
        <textarea class="field" id="reviewText" rows="3" placeholder="Что понравилось, что нет? Можно по-английски."></textarea>
        <button class="btn" data-act="saveReview" data-id="${id}" style="align-self:flex-start" ${st ? '' : 'disabled'}>Сохранить</button></section>`;
    }
  }
  const askBox = aiOn() ? `<section class="card stack" style="background:#EEF2FD;border:0">
      <div class="row"><h2 style="margin:0">Спросить о книге</h2>${info('ai')}<span class="small muted" style="margin-left:auto">Вопросов сегодня: ${aiLeft()}</span></div>
      ${chatThread('book', id)}
      <div class="row"><input class="field grow" id="askBook" placeholder="Например: это страшная книга?" maxlength="300"><button class="btn small" data-act="askBook" data-id="${id}">Спросить</button></div></section>` : '';
  const back = r.q.get('from') || (isCur ? 'home' : 'library');
  return `<div class="page white full">
    <header class="head">${backBtn(back)}<div class="grow"></div>
      ${!isCur && !done && !hard ? `<button class="pill" data-act="heart" data-id="${id}" style="${hearted ? 'background:var(--red-soft);border-color:#F4B7B2;color:#B2352F' : ''}">${hearted ? '♥ В списке' : '♡ Хочу прочитать'}</button>` : ''}
    </header>
    <div class="bookhead">
      ${coverHtml(b, '230px', 330, 24)}
      <div class="grow stack" style="gap:10px">
        <div style="font-size:32px;font-weight:700;line-height:1.15">${esc(b.title)}</div>
        <button class="authorbtn" data-act="author" data-id="${b.author}">
          ${A.portrait ? asset(A.portrait, 'class="avatar"') : `<span class="avatar">${esc((A.name || '?')[0])}</span>`}${esc(A.name)} ›</button>
        <div class="small muted">${b.year} · ${esc(b.genre)}</div>
        <div class="row wrap" style="gap:8px">${(b.themes || []).map(t => '<span class="tag">' + esc(t) + '</span>').join('')}</div>
        <div class="grid3" style="margin-top:6px">
          <div class="fact"><b>${pagesText(b)}</b><span class="tiny muted">${b.counted ? '' : '≈ '}${fmt(b.words)} слов${b.chapters > 1 ? ' · ' + b.chapters + ' ' + plural(b.chapters, 'глава', 'главы', 'глав') : ''} · ${readHours(b).replace('≈ ', '')}</span></div>
          <div class="fact"><b>${b.age}+ лет</b><span class="tiny muted">${hard ? 'пока сложновато' : ageDiff(b) > 0 ? 'выше твоего уровня · ×' + ru(mult(b)) : ageDiff(b) < 0 ? 'ниже твоего уровня · ×' + ru(mult(b)) : 'твой уровень'}</span></div>
          <div class="fact"><b>${hard ? '—' : '≈ ' + (bookMins(b) + finalMins(b)) + ' мин'}</b><span class="tiny muted">${hard ? '' : bookMins(b) + ' за главы + ' + finalMins(b) + ' за всю книгу'}</span></div>
        </div>
        ${action}
      </div>
    </div>
    <section class="stack" style="gap:8px"><h2>О чём</h2><p style="margin:0;font-size:18px;line-height:1.6;color:var(--ink2)">${esc(b.synopsis || b.oneLiner || '')}</p></section>
    ${b.why ? `<section class="stack" style="gap:8px"><h2>Почему её читают</h2>${b.why.map(w => `<div class="row" style="align-items:flex-start;gap:10px;font-size:16px;line-height:1.5;color:var(--ink2)"><b style="color:var(--blue)">•</b><span>${esc(w)}</span></div>`).join('')}</section>` : ''}
    ${ills ? `<section class="stack"><h2>Иллюстрации</h2><div class="row wrap">${ills}</div></section>` : ''}
    ${askBox}
    ${review}
  </div>`;
};

// ------------------------------------------------------------ reader ---

VIEWS.read = async r => {
  const id = r.a, n = Math.max(1, parseInt(r.b, 10) || 1);
  const b = BOOKS[id];
  let book;
  try { book = await loadBook(id); } catch (e) { toast(e.message, true); location.hash = '#/book/' + id; return null; }
  const ch = book.chapters[n - 1];
  if (!ch) { location.hash = '#/home'; return null; }
  const pos = store.get('pos_' + id, null);
  const prefs = store.get('rprefs', { size: 2, font: 'golos', spacing: 'normal', theme: 'light' });
  const keepPage = UI.r && UI.r.id === id && UI.r.n === n ? UI.r.page : null;
  UI.r = { id, n, page: keepPage != null ? keepPage : (pos && pos.n === n ? -1 : 0), frac: pos && pos.n === n ? pos.frac : 0, pages: 1, prefs, shown: Date.now(), aa: false, pop: null };
  if (!UI.chat || UI.chat.key !== 'reader:' + id + ':' + n) UI.chat = { key: 'reader:' + id + ':' + n, msgs: [], busy: false };
  const passed = passedCh(id) >= n;
  const secret = SECRETS[id + ':' + n];
  const html = ch.blocks.map(bl => {
    if (typeof bl === 'object' && bl.img) return `<figure>${asset(bl.img, 'style="width:' + (bl.w || 360) + 'px" data-act="zoom"')}</figure>`;
    // A block with line breaks is a stanza of verse: keep its lines.
    return (bl.indexOf('\n') > -1 ? '<p class="verse">' : '<p>') + esc(bl).replace(/\{(\w+)\|([^}]+)\}/g, (m, wid, text) => `<button class="hw" data-act="word" data-id="${wid}">${text}</button>`).replace(/\n/g, '<br>') + '</p>';
  }).join('');
  const end = n < book.chapters.length || !passed
    ? (passed ? `<div class="end"><a class="btn" href="#/read/${id}/${n + 1}">Глава ${n + 1} ›</a></div>`
      : `<div class="end"><a class="btn" href="#/check/${id}/${n}">Проверка главы · +${chMins(b, ch.words)} мин</a></div>`)
    : `<div class="end"><a class="btn" href="#/check/${id}/final">Финальная проверка · +${finalMins(b)} мин</a></div>`;
  return `<div class="reader ${prefs.theme}" id="reader">
    <header class="r-bar">
      <a class="r-icon" href="#/home" aria-label="На полку">${ICON.back}</a>
      <div class="title">${esc(b.short)} · Глава ${n}${secret && !secretFound(id, n) ? ' · 🔎' : ''}</div>
      ${aiOn() ? `<button class="r-icon" data-act="chat" aria-label="Обсудить">${ICON.chat}</button>` : ''}
      <button class="r-icon" data-act="aa" aria-label="Текст">Aa</button>
    </header>
    <div class="r-body" id="rbody">
      <div class="r-viewport" id="rvp"><div class="r-cols" id="rcols">
        <div class="chno">Глава ${n}</div>${ch.title ? '<h1>' + esc(ch.title) + '</h1>' : ''}${html}${end}
      </div></div>
      <button class="r-tap l" data-act="pg" data-d="-1" aria-label="Назад"></button>
      <button class="r-tap r" data-act="pg" data-d="1" aria-label="Дальше"></button>
    </div>
    <footer class="r-foot">
      <button class="pgbtn" id="pgPrev" data-act="pg" data-d="-1" aria-label="Предыдущая страница">${ICON.back}</button>
      <div class="r-prog"><div class="bar"><i id="pgBar" style="width:0"></i></div><span id="pgText"></span></div>
      <button class="pgbtn" id="pgNext" data-act="pg" data-d="1" aria-label="Следующая страница">${ICON.next}</button>
    </footer>
    <button id="askSel" class="btn small" data-act="askSel" hidden style="position:absolute;left:50%;transform:translateX(-50%);bottom:calc(env(safe-area-inset-bottom) + 96px);z-index:5"></button>
    <div id="rpanel"></div>
  </div>`;
};

/** Lays the chapter out in columns, one column per page, and shows the current page. */
function layoutReader(first) {
  const R = UI.r, cols = $('#rcols'), vp = $('#rvp'), body = $('#rbody');
  if (!R || !cols || !vp) return;
  const sizes = [17, 18, 20, 22, 24, 26];
  const FONTS = { golos: "'Golos Text', system-ui, sans-serif", ptserif: "'PT Serif', Georgia, serif", literata: 'Literata, Georgia, serif' };
  const lh = { tight: 1.45, normal: 1.6, wide: 1.8 }[R.prefs.spacing] || 1.6;
  const bw = body.clientWidth, bh = body.clientHeight;
  const W = Math.min(660, bw - 2 * Math.max(56, Math.round(bw * 0.08)));
  const G = 120;
  vp.style.width = W + 'px';
  vp.style.marginLeft = -(W / 2) + 'px';
  cols.style.width = W + 'px';
  cols.style.columnWidth = W + 'px';
  cols.style.columnGap = G + 'px';
  cols.style.fontFamily = FONTS[R.prefs.font] || FONTS.golos;
  cols.style.fontSize = sizes[R.prefs.size] + 'px';
  cols.style.setProperty('--lh', lh);
  const side = Math.max(40, (bw - W) / 2 - 8);
  document.querySelectorAll('.r-tap').forEach(t => { t.style.width = side + 'px'; });
  vp.style.height = (bh - 26) + 'px';
  const measure = () => {
    if (!UI.r || UI.r !== R) return;
    const frac = R.pages > 1 && R.page >= 0 ? R.page / R.pages : null;
    cols.style.transition = 'none';
    R.pages = Math.max(1, Math.round((cols.scrollWidth + G) / (W + G)));
    if (R.page < 0) R.page = Math.min(R.pages - 1, Math.round(R.frac * R.pages));
    else if (frac != null && !first) R.page = Math.min(R.pages - 1, Math.round(frac * R.pages));
    R.page = Math.min(R.page, R.pages - 1);
    R.W = W; R.G = G;
    showPage();
    requestAnimationFrame(() => { cols.style.transition = ''; });
  };
  measure();
  if (first) {
    // Pictures arrive after the text; each one that loads can change the page count.
    cols.querySelectorAll('img').forEach(img => img.addEventListener('load', measure));
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);
    attachSwipe(body);
  }
}

function showPage() {
  const R = UI.r, cols = $('#rcols');
  if (!R || !cols) return;
  cols.style.transform = 'translateX(' + -(R.page * (R.W + R.G)) + 'px)';
  $('#pgText').textContent = 'Страница ' + (R.page + 1) + ' из ' + R.pages;
  $('#pgBar').style.width = Math.round((R.page + 1) / R.pages * 100) + '%';
  $('#pgPrev').disabled = R.page === 0;
  $('#pgNext').disabled = R.page >= R.pages - 1;
  store.set('pos_' + R.id, { n: R.n, frac: R.pages > 1 ? R.page / R.pages : 0 });
}

function turnPage(d) {
  const R = UI.r;
  if (!R) return;
  const page = Math.max(0, Math.min(R.pages - 1, R.page + d));
  if (page === R.page) return;
  if (d > 0) recordPage(R);
  R.page = page;
  R.shown = Date.now();
  closePanel();
  hideAskSel();
  showPage();
}

/** Text on the page he is looking at (sent with AI questions as context). */
function visibleText() {
  const vp = $('#rvp');
  if (!vp) return '';
  const box = vp.getBoundingClientRect();
  return [...document.querySelectorAll('#rcols p')].filter(p => { const r = p.getBoundingClientRect(); return r.right > box.left + 4 && r.left < box.right - 4; })
    .map(p => p.textContent).join('\n').slice(0, 3000);
}

/* Seconds per page feed the reading-speed estimate (used for book lengths and minutes, never shown).
   Words per page are estimated from the chapter length. */
function recordPage(R) {
  const book = bookNow(R.id);
  if (!book) return;
  const secs = Math.round((Date.now() - R.shown) / 1000);
  const words = Math.round(book.chapters[R.n - 1].words / R.pages);
  const buf = store.get('pagebuf', []);
  buf.push({ book_id: R.id, chapter: R.n, page: R.page + 1, words, secs });
  store.set('pagebuf', buf);
  bump('pages');
  if (secs >= 5 && secs <= 180) bump('secs', secs);
  bumpHour();
  if (buf.length >= 10) flushPages();
}
async function flushPages() {
  const buf = store.get('pagebuf', []);
  if (!buf.length || flushPages.on) return;
  flushPages.on = true;
  try {
    const res = await api('pages', { rows: buf });
    store.set('pagebuf', store.get('pagebuf', []).slice(buf.length));
    if (res && res.wpm) { D.settings.wpm = res.wpm; saveCache(); }
  } catch (e) { /* try later */ } finally { flushPages.on = false; }
}
function leaveReader() { if (UI.r) { flushPages(); UI.r = null; hideAskSel(); } }

function attachSwipe(el) {
  let x0 = null, y0 = null;
  el.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
  el.addEventListener('touchend', e => {
    if (x0 == null) return;
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    const sel = window.getSelection && String(window.getSelection());
    if (!sel && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) turnPage(dx < 0 ? 1 : -1);
    x0 = null;
  }, { passive: true });
}
window.addEventListener('resize', () => { if (UI.r) { UI.r.frac = UI.r.page / UI.r.pages; UI.r.page = -1; layoutReader(false); } });
document.addEventListener('keydown', e => {
  if (!UI.r || /input|textarea/i.test(e.target.tagName)) return;
  if (e.key === 'ArrowRight' || e.key === ' ') turnPage(1);
  if (e.key === 'ArrowLeft') turnPage(-1);
});

/* Selecting any text (long press on the iPad) offers "Спросить про «…»". */
document.addEventListener('selectionchange', () => {
  const btn = $('#askSel');
  if (!btn || !UI.r || !aiOn()) return;
  const sel = window.getSelection();
  const text = sel ? String(sel).trim().replace(/\s+/g, ' ') : '';
  const inside = sel && sel.rangeCount && $('#rcols') && $('#rcols').contains(sel.anchorNode);
  if (inside && text.length >= 2 && text.length <= 200) {
    btn.textContent = 'Спросить про «' + (text.length > 30 ? text.slice(0, 28) + '…' : text) + '»';
    btn.dataset.text = text;
    btn.hidden = false;
  } else if (!text) hideAskSel();
});
function hideAskSel() { const b = $('#askSel'); if (b) b.hidden = true; }

function closePanel() { const p = $('#rpanel'); if (p) p.innerHTML = ''; if (UI.r) { UI.r.aa = false; UI.r.pop = null; UI.r.chat = false; } }

function aaPanel() {
  const P = UI.r.prefs;
  const seg = (key, val, label, style) => `<button class="seg ${P[key] === val ? 'on' : ''}" data-act="pref" data-k="${key}" data-v="${val}" style="${style || ''}">${label}</button>`;
  return `<div class="r-panel r-aa">
    <div class="row"><button class="seg" style="flex:0 0 56px" data-act="fontsize" data-d="-1" aria-label="Мельче">A</button>
      <div class="grow" style="text-align:center">${[17, 18, 20, 22, 24, 26][P.size]}</div>
      <button class="seg" style="flex:0 0 56px;font-size:22px" data-act="fontsize" data-d="1" aria-label="Крупнее">A</button></div>
    <div class="row" style="gap:8px">${seg('font', 'golos', 'Golos', "font-family:'Golos Text'")}${seg('font', 'ptserif', 'PT Serif', "font-family:'PT Serif'")}${seg('font', 'literata', 'Literata', 'font-family:Literata')}</div>
    <div class="row" style="gap:8px">${seg('spacing', 'tight', 'Плотнее')}${seg('spacing', 'normal', 'Обычно')}${seg('spacing', 'wide', 'Шире')}</div>
    <div class="row" style="gap:8px">${seg('theme', 'light', 'Светлый')}${seg('theme', 'sepia', 'Сепия')}${seg('theme', 'dark', 'Тёмный')}</div>
  </div>`;
}

/** Tapping a word shows its explanation and quietly puts it on his list. Nothing changes on the page. */
function tapWord(wid) {
  const R = UI.r, book = bookNow(R.id);
  const g = book && book.glossary[wid];
  if (!g) return;
  if (!g.g && !wordRow(R.id + ':' + wid)) save([{ t: 'Words', rows: [newWord(R.id, wid, g.base, 'tap')] }]);
  const secret = SECRETS[R.id + ':' + R.n];
  if (secret && secret.id === wid && !secretFound(R.id, R.n)) {
    const found = store.get('secrets', {});
    found[R.id + ':' + R.n] = today();
    store.set('secrets', found);
    setTimeout(() => toast('🔎 Тайное слово найдено! Забери награду в «Заданиях».'), 400);
  }
  R.pop = wid;
  $('#rpanel').innerHTML = `<div class="r-panel r-pop">
    <div class="row" style="align-items:flex-start;justify-content:space-between">
      <div><div class="base">${esc(g.base)}</div><div class="gram">${esc(g.gram || '')}</div></div>
      <button class="r-icon" data-act="closePanel" aria-label="Закрыть">${ICON.close}</button></div>
    <div class="ru">${esc(g.ru)}</div>
    ${aiOn() ? `<button data-act="askWord" data-base="${esc(g.base)}" style="align-self:flex-start;padding:8px 0;color:var(--blue);font-size:15px;font-weight:600">Всё равно непонятно — спросить</button>` : ''}</div>`;
}
function secretFound(id, n) { return !!store.get('secrets', {})[id + ':' + n]; }

// --------------------------------------------------------------- AI ---

const AI_ERRORS = {
  AI_OFF: 'Вопросы сейчас выключены.',
  AI_LIMIT: 'На сегодня вопросы закончились. Завтра будут новые!',
  AI_QUOTA: 'Слишком много вопросов сразу. Попробуй через минуту.',
  AI_NOKEY: 'Вопросы ещё не настроены.',
  AI_BUSY: 'ИИ сейчас перегружен. Попробуй через несколько минут — вопрос не потратился.',
};
function chatThread(kind, id) {
  const C = UI.chat && UI.chat.key === kind + ':' + id ? UI.chat : null;
  if (!C || !C.msgs.length) return '';
  return '<div class="stack" style="gap:10px">' + C.msgs.map(m => `<div class="stack" style="gap:6px">
    <div style="align-self:flex-end;max-width:80%;padding:10px 14px;border-radius:14px 14px 4px 14px;background:var(--blue);color:#FFFFFF">${esc(m.q)}</div>
    <div style="max-width:90%;padding:12px 14px;border-radius:14px 14px 14px 4px;background:#FFFFFF;line-height:1.55;white-space:pre-wrap">${m.a ? esc(m.a) : '<span class="muted">Думаю…</span>'}</div></div>`).join('') + '</div>';
}
function chatPanel() {
  const C = UI.chat;
  const starters = C.msgs.length ? '' : `<div class="row wrap" style="gap:8px">${['Объясни, что здесь происходит', 'Почему герой так поступил?', 'Что значит последняя фраза на странице?']
    .map(q => `<button class="chip" data-act="askStarter" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>`;
  return `<div class="r-panel r-pop" style="max-height:70vh;overflow-y:auto">
    <div class="row"><b style="font-size:20px">Обсудить</b>${info('ai')}<span class="small" style="margin-left:auto;color:var(--r-muted)">Вопросов сегодня: ${aiLeft()}</span>
      <button class="r-icon" data-act="closePanel" aria-label="Закрыть">${ICON.close}</button></div>
    ${chatThread('reader', UI.r.id + ':' + UI.r.n)}${starters}
    <div class="row"><input class="field grow" id="askInput" placeholder="Свой вопрос…" maxlength="300" value="${esc(C.draft || '')}"><button class="btn small" data-act="askSend">Спросить</button></div></div>`;
}
function openChat(prefill, send) {
  if (!UI.r) return;
  closePanel();
  UI.r.chat = true;
  UI.chat.draft = prefill || '';
  $('#rpanel').innerHTML = chatPanel();
  if (send && prefill) askAI(prefill);
  else { const i = $('#askInput'); if (i) i.focus(); }
}
async function askAI(q, kind, bookId) {
  q = String(q || '').trim();
  if (!q) return;
  const C = UI.chat;
  if (C.busy) return;
  if (aiLeft() <= 0) return toast(AI_ERRORS.AI_LIMIT, true);
  const isBook = kind === 'book';
  const msg = { q, a: '' };
  const history = C.msgs.filter(m => m.a).map(m => ({ q: m.q, a: m.a }));
  C.msgs.push(msg); C.busy = true; C.draft = '';
  const redraw = () => { if (isBook) render(); else if (UI.r && UI.r.chat) $('#rpanel').innerHTML = chatPanel(); };
  redraw();
  try {
    const res = await api('ask', isBook ? { kind: 'book', book_id: bookId, question: q, history }
      : { kind: 'reader', book_id: UI.r.id, chapter: UI.r.n, page: visibleText(), question: q, history });
    msg.a = res.answer;
    D.settings.ai_used_date = today();
    D.settings.ai_used = num(D.settings.ai_used_date === today() ? D.settings.ai_used : 0, 0) + 1;
    D.ai_count = num(D.ai_count, 0) + 1;
    saveCache();
    bump('asks');
  } catch (e) {
    const code = String(e.message).split(' ')[0];
    msg.a = AI_ERRORS[code] || (/fetch|network/i.test(e.message) ? 'Нет связи. Спроси, когда будет интернет.' : 'Не получилось ответить. Попробуй ещё раз.');
  }
  C.busy = false;
  redraw();
}

// ------------------------------------------------------- chapter check ---

VIEWS.check = async r => {
  const id = r.a, isFinal = r.b === 'final', n = isFinal ? 0 : parseInt(r.b, 10);
  let book;
  try { book = await loadBook(id); } catch (e) { toast(e.message, true); location.hash = '#/home'; return null; }
  const key = id + ':' + r.b;
  if (!UI.check[key]) {
    let qs;
    if (isFinal) qs = book.final.map((q, i) => Object.assign({ text: q.q }, shuffle(q.o, 'f' + i + q.q)));
    else {
      const ch = book.chapters[n - 1];
      const qwIds = Object.keys(ch.qword || {});
      // Question 4: a word he tapped in this chapter if possible, otherwise one not yet on his list.
      const qw = qwIds.find(w => { const row = wordRow(id + ':' + w); return row && row.src === 'tap' && row.st === 'learning'; })
        || qwIds.find(w => !wordRow(id + ':' + w)) || qwIds[0];
      qs = ch.quiz.map((q, i) => Object.assign({ text: q.q }, shuffle(q.o, 'q' + n + i + q.q)));
      if (qw) qs.push(Object.assign({ text: ch.qword[qw].q, qword: qw }, shuffle(ch.qword[qw].o, 'w' + qw)));
    }
    UI.check[key] = { qs, answers: {}, done: false, score: 0, passed: false };
  }
  const C = UI.check[key];
  const need = isFinal ? 6 : 3;
  const qHtml = C.qs.map((q, i) => `<section class="q">
    <div class="qt"><span>${i + 1}</span><span>${esc(q.text)}</span></div>
    <div class="grid2" style="gap:10px">${q.opts.map((o, j) => {
      let cls = 'opt';
      if (C.done && C.passed && j === q.a) cls += ' right';
      else if (C.done && C.passed && C.answers[i] === j) cls += ' wrong';
      else if (C.answers[i] === j) cls += ' sel';
      else if (C.done) cls += ' dim';
      return `<button class="${cls}" data-act="answer" data-key="${key}" data-i="${i}" data-j="${j}" ${C.done ? 'disabled' : ''}>${esc(o)}</button>`;
    }).join('')}</div></section>`).join('');
  const all = C.qs.every((q, i) => C.answers[i] !== undefined);
  let foot;
  if (!C.done) foot = `<button class="btn" data-act="submitCheck" data-key="${key}" style="align-self:flex-start" ${all ? '' : 'disabled'}>Проверить</button>`;
  else if (C.passed) foot = `<section class="result"><div class="grow stack" style="gap:4px"><b style="font-size:20px">${C.score} из ${C.qs.length} · ${isFinal ? 'книга прочитана!' : 'глава засчитана'}</b>
      <span style="color:var(--dark-muted)">${C.mins ? '+' + C.mins + ' мин' : 'Эта глава уже была засчитана'}${C.note ? ' · ' + esc(C.note) : ''}</span></div>
      <a class="btn amber" href="${isFinal ? '#/book/' + id + '?from=home' : n < book.chapters.length ? '#/read/' + id + '/' + (n + 1) : '#/home'}">${isFinal ? 'Оценить книгу' : n < book.chapters.length ? 'Глава ' + (n + 1) + ' ›' : 'На полку'}</a></section>`;
  else foot = `<section class="result fail"><b class="grow" style="font-size:20px">${C.score} из ${C.qs.length} · нужно ${need}</b>
      ${isFinal ? '' : `<a class="btn ghost" href="#/read/${id}/${n}">Перечитать</a>`}<button class="btn" data-act="retryCheck" data-key="${key}">Ещё раз</button></section>`;
  return `<div class="page white full">
    <header class="head">${backBtn(isFinal ? 'home' : 'read/' + id + '/' + n)}<h1>${isFinal ? 'Финальная проверка' : 'Проверка · глава ' + n}</h1>${info(isFinal ? 'final' : 'quiz')}</header>
    ${qHtml}${foot}</div>`;
};

function submitCheck(key) {
  const [id, which] = key.split(':');
  const isFinal = which === 'final', n = isFinal ? 0 : parseInt(which, 10);
  const C = UI.check[key], b = BOOKS[id], book = bookNow(id);
  C.score = C.qs.filter((q, i) => C.answers[i] === q.a).length;
  C.passed = C.score >= (isFinal ? 6 : 3);
  C.done = true;
  const ops = [], set = {};
  const words = [];
  let mins = 0;
  if (!isFinal) {
    const ch = book.chapters[n - 1];
    // Hard words of a finished chapter join his list even if he did not tap them.
    hardIds(ch).forEach(w => {
      const g = book.glossary[w];
      if (g && !g.g && !wordRow(id + ':' + w)) words.push(newWord(id, w, g.base, 'book'));
    });
    const qi = C.qs.findIndex(q => q.qword);
    if (qi > -1) {
      const w = C.qs[qi].qword;
      const row = wordRow(id + ':' + w) || words.find(x => x.word_id === w) || newWord(id, w, book.glossary[w].base, 'book');
      const merged = Object.assign({}, row, C.answers[qi] === C.qs[qi].a ? rightAnswer(row) : wrongAnswer(row));
      const k = words.findIndex(x => x.key === merged.key);
      if (k > -1) words[k] = merged; else words.push(merged);
    }
    const already = passedCh(id) >= n;
    if (C.passed && !already) {
      mins = chMins(b, ch.words);
      C.rankBefore = rankIdx(words90());
      ops.push(ledger('chapter', mins, id + ':' + n));
      ops.push({ t: 'Progress', rows: [Object.assign({ book_id: id, status: 'reading', started: today() }, progressOf(id) || {}, { chapters_passed: n, updated: today() })] });
      // The language age moves a little with every chapter, more for harder books.
      const d = ageDiff(b);
      let prog = num(S().lang_prog, 0) + (d < 0 ? 0.15 : d === 0 ? 0.35 : d === 1 ? 0.5 : 0.6) * (C.score === C.qs.length ? 1.2 : 1);
      let months = langMonths();
      if (prog >= 1) { months += Math.floor(prog); prog %= 1; C.note = 'уровень языка: ' + ym(months); }
      set.lang_months = months; set.lang_prog = Math.round(prog * 100) / 100;
    }
    ops.push({ t: 'Checks', rows: [{ id: rid(), date: today(), book_id: id, chapter: n, score: C.score, total: C.qs.length, passed: C.passed && !already, mins, words: C.passed && !already ? ch.words : 0 }] });
  } else {
    const p = progressOf(id);
    if (C.passed && !(p && p.status === 'done')) {
      mins = finalMins(b);
      ops.push(ledger('final', mins, id));
      const cell = bingoCellFor(b, p);
      ops.push({ t: 'Progress', rows: [Object.assign({ book_id: id, started: today() }, p || {}, { status: 'done', finished: today(), final_score: C.score, bingo: cell || '', updated: today() })] });
      const s = S();
      const next = s.next_book && BOOKS[s.next_book] && BOOKS[s.next_book].ready && !isDone(s.next_book) ? s.next_book : '';
      set.cur_book = next;
      if (next) { set.next_book = ''; set.locked = true; }
      set.shortlist = shortlist().filter(x => x !== id && x !== next).join(',');
      if (cell) C.note = 'бинго: «' + cell.split(':').slice(1).join(':') + '»';
    }
    ops.push({ t: 'Checks', rows: [{ id: rid(), date: today(), book_id: id, chapter: 'final', score: C.score, total: C.qs.length, passed: C.passed, mins, words: 0 }] });
  }
  if (words.length) ops.push({ t: 'Words', rows: words });
  C.mins = mins;
  save(ops, Object.keys(set).length ? set : null);
  if (isFinal && C.passed) bingoRewards();
  if (C.rankBefore != null && rankIdx(words90()) > C.rankBefore) setTimeout(() => toast('Новое звание: ' + RANKS[rankIdx(words90())].name + '!'), 600);
  render();
}

// ------------------------------------------------------------- Блиц ---

function dueWords() {
  const t = today();
  return (D.words || []).filter(w => (w.st === 'learning' || w.st === 'archived') && (!w.due || w.due <= t));
}
function dueCases() {
  return CASES.filter(c => { const w = wordRow('case:' + c.id); return !w || ((w.st === 'learning' || w.st === 'archived') && (!w.due || w.due <= today())); });
}
function dueCount() { return dueWords().filter(w => w.book_id !== 'case').length + Math.min(dueCases().length, 4); }

async function buildRound() {
  const due = dueWords().filter(w => w.book_id !== 'case');
  const books = {};
  for (const bid of new Set(due.map(w => w.book_id))) { try { books[bid] = await loadBook(bid); } catch (e) { /* skip */ } }
  const rank = w => (num(w.misses, 0) > 0 ? 0 : w.src === 'tap' ? 1 : 2);
  const words = due.filter(w => books[w.book_id] && books[w.book_id].glossary[w.word_id]).sort((a, b) => rank(a) - rank(b)).slice(0, 30);
  const pool = Object.keys(books).reduce((a, bid) => a.concat(Object.values(books[bid].glossary).filter(g => !g.g).map(g => g.base)), []);
  const qs = words.map(w => wordQ(w, books[w.book_id].glossary[w.word_id], pool));
  // Up to 4 case questions a day: those due again first, then new ones.
  const cs = dueCases().map(c => ({ c, w: wordRow('case:' + c.id) })).sort((a, b) => (a.w ? 0 : 1) - (b.w ? 0 : 1)).slice(0, 4).map(x => caseQ(x.c));
  const out = [];
  let ci = 0;
  qs.forEach((q, i) => { out.push(q); if (i % 3 === 2 && ci < cs.length) out.push(cs[ci++]); });
  while (ci < cs.length) out.push(cs[ci++]);
  return out;
}
/** s = 0: meaning, 1: in a sentence, 2 (or the month check): the word from its meaning. */
function wordQ(w, g, pool, forceMeaning) {
  const s = forceMeaning ? 0 : w.st === 'archived' ? 2 : num(w.s, 0);
  const base = { key: w.key, kind: 'word', label: g.base, old: num(w.s, 0) >= 1 || w.st === 'archived' };
  if (s === 1) return Object.assign(base, { tag: 'В предложении', prompt: g.c.p, sub: 'Какое слово подходит?' }, shuffle(g.c.o, w.key + 'c'));
  if (s >= 2) {
    const others = pool.filter(x => x !== g.base);
    const pick = [0, 7, 13].map(k => others[(w.key.length * 5 + k) % Math.max(1, others.length)] || '—');
    return Object.assign(base, { tag: 'Слово по значению', prompt: g.m.o[0], sub: 'Какое это слово?' }, shuffle([g.base].concat(pick), w.key + 'r'));
  }
  return Object.assign(base, { tag: 'Значение', prompt: g.base, sub: 'Что это значит?' }, shuffle(g.m.o, w.key + 'm' + (forceMeaning ? '2' : '')));
}
function caseQ(c) { return Object.assign({ key: 'case:' + c.id, kind: 'case', label: c.p.replace('…', c.o[0]), tag: 'Падежи', prompt: c.p, sub: c.sub }, shuffle(c.o, c.id)); }

VIEWS.blitz = async () => {
  const B = UI.bz;
  const s = S();
  const head = `<header class="head"><a class="icon-btn" href="#/home" aria-label="Назад" style="background:transparent;border-color:#2B3344;color:#FFFFFF">${ICON.back}</a>
    <h1 class="row" style="gap:8px">${ICON.bolt}Блиц</h1>${info('blitz')}<span class="small" style="color:var(--dark-muted)">Рекорд ${num(s.best_blitz, 0)}</span></header>`;
  if (!B || B.phase === 'intro') {
    const round = await buildRound();
    UI.bz = { phase: 'intro', round };
    return `<div class="page dark full">${head}
      <section class="stack" style="margin-top:80px;align-items:center;text-align:center;gap:18px">
        <div style="font-size:96px;font-weight:700;line-height:1">${round.length || '✓'}</div>
        <div style="font-size:20px;color:var(--dark-muted)">${round.length ? plural(round.length, 'вопрос', 'вопроса', 'вопросов') + ' на сегодня' : 'На сегодня всё'}</div>
        ${round.length ? '<button class="btn amber" data-act="bzStart" style="margin-top:20px;padding:18px 64px;font-size:20px">Старт · 60 с</button>' : ''}
      </section></div>`;
  }
  if (B.phase === 'run') {
    const q = B.round[B.qi] || B.round[B.round.length - 1];
    return `<div class="page dark full">${head}
      <div class="row" style="gap:18px"><b id="bzT" style="font-size:32px;width:56px;font-variant-numeric:tabular-nums">${B.t}</b>
        <div class="bar amber grow" style="height:10px;background:var(--dark-line)"><i id="bzBar" style="width:${Math.round(B.t / 60 * 100)}%;transition:width 1s linear"></i></div>
        <b style="font-size:20px"><span style="color:#8FE3B5">✓</span> ${B.score}</b></div>
      <section class="stack" style="min-height:240px;padding-top:20px;gap:12px">
        <span class="bz-tag ${q.kind === 'case' ? 'case' : ''}">${q.tag}</span>
        <div style="font-size:34px;font-weight:700;line-height:1.3">${esc(q.prompt)}</div>
        <div style="font-size:19px;color:var(--dark-muted)">${esc(q.sub)}</div></section>
      <div class="grid2" style="gap:12px">${q.opts.map((o, j) => `<button class="bz-opt" data-act="bzPick" data-j="${j}">${esc(o)}</button>`).join('')}</div>
      <div style="min-height:28px;font-size:18px;font-weight:600;color:${B.fbOk ? '#8FE3B5' : '#FF9C97'}">${esc(B.fb || '')}</div></div>`;
  }
  const won = B.score >= 5;
  return `<div class="page dark full">${head}
    <section class="stack" style="margin-top:30px;gap:10px">
      <div style="font-size:64px;font-weight:700;line-height:1">${B.score} верно</div>
      <div style="font-size:20px;color:var(--amber);font-weight:600">${won ? '+' + num(s.blitz_reward, 1) + ' мин' : 'Ещё ' + (5 - B.score) + ' до награды'}</div>
      <div class="stack" style="margin-top:20px;gap:6px">${B.log.map(l => `<div class="row" style="gap:16px;padding:12px 16px;border-radius:12px;background:var(--dark2)">
        <div class="grow" style="font-size:18px">${esc(l.label)}</div>
        <div class="dots">${[0, 1, 2].map(i => '<i class="' + (i < l.s ? 'on' : '') + '"></i>').join('')}</div>
        <div style="width:170px;text-align:right;font-size:14px;color:var(--dark-muted)">${l.s >= 3 ? (l.learned ? 'выучено!' : 'отдыхает месяц') : l.ok ? 'дальше — в другой день' : 'заново'}</div></div>`).join('')}</div>
      <div class="row" style="margin-top:22px"><a class="btn ghost" href="#/home" style="color:#FFFFFF;border-color:#5B6475">На полку</a><button class="btn amber" data-act="bzAgain">Ещё раунд</button></div>
    </section></div>`;
};

function bzStart() {
  const B = UI.bz;
  if (!B || !B.round.length) return;
  Object.assign(B, { phase: 'run', t: 60, qi: 0, score: 0, log: [], changed: {}, fb: '', old: 0, cases: 0 });
  clearInterval(bzStart.timer);
  bzStart.timer = setInterval(() => {
    if (!UI.bz || UI.bz.phase !== 'run' || route().name !== 'blitz') { clearInterval(bzStart.timer); return; }
    UI.bz.t--;
    if (UI.bz.t <= 0) bzEnd();
    else { const t = $('#bzT'), bar = $('#bzBar'); if (t) t.textContent = UI.bz.t; if (bar) bar.style.width = Math.round(UI.bz.t / 60 * 100) + '%'; }
  }, 1000);
  render();
}

function bzPick(j) {
  const B = UI.bz, q = B.round[B.qi];
  if (!q) return;
  const ok = j === q.a;
  const isCase = q.kind === 'case';
  const row = B.changed[q.key] || wordRow(q.key) || (isCase ? { key: q.key, book_id: 'case', word_id: q.key.slice(5), base: q.label, st: 'learning', s: 0, due: today(), misses: 0, src: 'case', added: today(), last: '' } : null);
  if (row) {
    const wasArchived = row.st === 'archived';
    const merged = Object.assign({}, row, ok ? rightAnswer(row) : wrongAnswer(row));
    B.changed[q.key] = merged;
    B.log = B.log.filter(l => l.key !== q.key).concat([{ key: q.key, label: q.label, s: merged.st === 'learned' ? 3 : num(merged.s, 0), ok, learned: wasArchived && ok }]);
  }
  if (ok && q.old) B.old++;
  if (ok && isCase) B.cases++;
  if (!ok) {
    // A missed word comes back later in the same round, from its meaning.
    let again = null;
    if (isCase) again = caseQ(CASES.find(c => 'case:' + c.id === q.key));
    else { const book = bookNow(row.book_id); if (book) again = wordQ(row, book.glossary[row.word_id], [], true); }
    if (again) B.round.splice(Math.min(B.round.length, B.qi + 4), 0, again);
  }
  B.qi++;
  B.score += ok ? 1 : 0;
  B.fb = ok ? 'Верно' : 'Правильно: ' + q.opts[q.a];
  B.fbOk = ok;
  if (B.qi >= B.round.length) bzEnd(); else render();
}

function bzEnd() {
  clearInterval(bzStart.timer);
  const B = UI.bz;
  if (!B || B.phase !== 'run') return;
  B.phase = 'done';
  const s = S();
  const ops = [];
  const rows = Object.values(B.changed);
  if (rows.length) ops.push({ t: 'Words', rows });
  ops.push({ t: 'Checks', rows: [{ id: rid(), date: today(), book_id: 'blitz', chapter: 'blitz', score: B.score, total: B.qi, passed: B.score >= 5, mins: B.score >= 5 ? num(s.blitz_reward, 1) : 0, words: 0 }] });
  if (B.score >= 5) ops.push(ledger('blitz', num(s.blitz_reward, 1)));
  bump('bzOld', B.old); bump('cases', B.cases);
  // Words that went to rest for a month nudge the language age.
  const rested = rows.filter(r => r.st === 'archived' || r.st === 'learned').length;
  const set = {};
  if (B.score > num(s.best_blitz, 0)) set.best_blitz = B.score;
  if (rested) {
    let prog = num(s.lang_prog, 0) + rested * 0.03, months = langMonths();
    if (prog >= 1) { months += 1; prog -= 1; }
    set.lang_months = months; set.lang_prog = Math.round(prog * 100) / 100;
  }
  save(ops, Object.keys(set).length ? set : null);
  render();
}

// ----------------------------------------------------------- quests ---

function claimed(ref) { return (D.ledger || []).some(l => l.kind === 'quest' && l.ref === ref); }
function questCtx() {
  const t = today(), wk = weekStart(t), st = stats(), d = st[t] || {};
  const checks = D.checks || [];
  const chOf = c => c.book_id !== 'blitz' && c.chapter !== 'final' && yes(c.passed);
  const bz = checks.filter(c => c.book_id === 'blitz');
  const weekDates = Object.keys(st).filter(x => x >= wk);
  return {
    ai: aiOn(),
    unreviewed: doneRows().some(p => !num(p.stars, 0)),
    day: {
      checks: checks.filter(c => c.date === t && chOf(c)).length,
      pages: d.pages || 0, secs: d.secs || 0, hearts: d.hearts || 0, asks: d.asks || 0, bzOld: d.bzOld || 0, cases: d.cases || 0,
      bzBest: bz.filter(c => c.date === t).reduce((a, c) => Math.max(a, num(c.score, 0)), 0),
      morning: Object.keys(d.hours || {}).some(h => Number(h) < 9) ? 1 : 0,
    },
    week: {
      days: weekDates.filter(x => readDay(st[x])).length,
      checks: checks.filter(c => c.date >= wk && chOf(c)).length,
      bzDays: new Set(bz.filter(c => c.date >= wk).map(c => c.date)).size,
      bzRight: bz.filter(c => c.date >= wk).reduce((a, c) => a + num(c.score, 0), 0),
      reviews: doneRows().filter(p => p.review && p.updated >= wk).length,
    },
  };
}
function questList() {
  const s = S(), t = today(), wk = weekStart(t), c = questCtx();
  const mk = (g, q, period) => ({ g, id: q.id, icon: q.icon, text: q.text, n: q.n, r: q.r, p: Math.min(q.p(c), q.n), ref: q.id + ':' + period });
  const daily = seeded(DAILY_QUESTS.filter(q => !q.when || q.when(c)), 'd' + t).slice(0, 3).map(q => mk('day', q, t));
  const list = daily.slice();
  list.push({ g: 'combo', id: 'combo', icon: '🔥', text: 'Комбо: все три задания дня', p: daily.filter(q => q.p >= q.n).length, n: 3, r: 3, ref: 'combo:' + t });
  // Secret words: ones found but not yet claimed stay listed, plus the one in the chapter he is on now.
  const cur = BOOKS[s.cur_book];
  const found = store.get('secrets', {});
  const keys = Object.keys(found).filter(k => SECRETS[k] && !claimed('secret:' + k));
  if (cur && cur.ready) {
    const k = s.cur_book + ':' + Math.min(passedCh(s.cur_book) + 1, cur.chapters || 1);
    if (SECRETS[k] && keys.indexOf(k) < 0 && !claimed('secret:' + k)) keys.push(k);
  }
  keys.forEach(k => list.push({ g: 'special', id: 'secret', icon: '🔎', text: 'Тайное слово: в главе ' + k.split(':')[1] + ' есть слово, которое значит «' + SECRETS[k].hint + '». Найди и нажми на него.', p: found[k] ? 1 : 0, n: 1, r: 1, ref: 'secret:' + k }));
  const perfect = (D.checks || []).some(x => x.date === t && x.book_id !== 'blitz' && x.chapter !== 'final' && num(x.total, 0) > 0 && num(x.score, 0) === num(x.total, 0));
  list.push({ g: 'special', id: 'perfect', icon: '🎯', text: 'Проверка главы без единой ошибки', p: perfect ? 1 : 0, n: 1, r: 2, ref: 'perfect:' + t });
  seeded(WEEKLY_QUESTS.filter(q => !q.when || q.when(c)), 'w' + wk).slice(0, 2).forEach(q => list.push(mk('week', q, wk)));
  if (cur && !isDone(s.cur_book)) {
    const end = new Date(); end.setMonth(end.getMonth() + 1, 0);
    list.push({ g: 'week', id: 'book', icon: '🏁', text: 'Дочитай «' + cur.short + '» до ' + end.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }), p: passedCh(s.cur_book), n: (cur.chapters || 1) + 1, r: 5, ref: 'book:' + s.cur_book + ':' + t.slice(0, 7) });
  }
  return list;
}

VIEWS.quests = () => {
  const list = questList();
  const done = list.filter(q => q.p >= q.n).length;
  const card = q => {
    const ok = q.p >= q.n, got = claimed(q.ref);
    return `<div class="quest ${ok && !got ? 'ready' : ''} ${got ? 'claimed' : ''}"><div class="ic">${q.icon}</div>
      <div class="grow stack" style="gap:8px"><b style="font-size:17px;font-weight:600;line-height:1.35">${esc(q.text)}</b>
        <div class="row"><div class="bar grow ${ok ? 'green' : ''}"><i style="width:${Math.round(Math.min(1, q.p / q.n) * 100)}%"></i></div><span class="small muted" style="width:52px;text-align:right">${Math.min(q.p, q.n)} / ${q.n}</span></div></div>
      ${ok && !got ? `<button class="btn amber small" data-act="claim" data-ref="${esc(q.ref)}" data-r="${q.r}">Забрать +${q.r}</button>` : `<span class="reward ${got ? 'got' : ''}">${got ? '✓ +' + q.r : '+' + q.r + ' мин'}</span>`}</div>`;
  };
  const groups = [['day', 'Сегодня'], ['combo', 'Комбо'], ['special', 'Особые'], ['week', 'Неделя и месяц']]
    .map(([g, t]) => { const items = list.filter(q => q.g === g); return items.length ? `<section class="stack"><h2 style="margin:0">${t}</h2>${items.map(card).join('')}</section>` : ''; }).join('');
  return `<div class="page"><header class="head"><h1>Задания</h1>${info('quests')}<span class="muted">${done} из ${list.length}</span></header>${groups}</div>`;
};

// ------------------------------------------------------- collection ---

function bingoCard(n) {
  if (n <= 1) return BINGO_FIRST.slice();
  // Later cards: squares some unread book in the library can fill (or that depend on how he reads).
  const unread = Object.keys(BOOKS).filter(id => !isDone(id)).map(id => BOOKS[id]);
  const ctxAny = { above: true, above2: true, newAuthor: true, sameAuthor: true, fast: true };
  const usable = Object.keys(BINGO_POOL).filter(k => unread.some(b => BINGO_POOL[k](b, ctxAny)));
  return seeded(usable, 'bingo' + n).slice(0, 16);
}
function bingoState(n) {
  n = n || num(S().bingo_card, 1);
  const labels = bingoCard(n);
  const cells = labels.map(label => ({ label, book: null }));
  doneRows().filter(p => p.bingo && String(p.bingo).split(':')[0] === String(n)).forEach(p => {
    const c = cells.find(x => x.label === String(p.bingo).split(':').slice(1).join(':'));
    if (c && !c.book) c.book = p.book_id;
  });
  const lines = [];
  for (let i = 0; i < 4; i++) { lines.push([0, 1, 2, 3].map(k => i * 4 + k)); lines.push([0, 1, 2, 3].map(k => k * 4 + i)); }
  lines.push([0, 5, 10, 15], [3, 6, 9, 12]);
  const full = lines.map((l, i) => ({ i, l })).filter(x => x.l.every(k => cells[k] && cells[k].book));
  return { n, cells, full, complete: cells.length === 16 && cells.every(c => c.book) };
}
function bingoCtx(b, p) {
  const others = doneIds().map(id => BOOKS[id]).filter(x => x && x !== b);
  const started = p && p.started ? p.started : today();
  return {
    above: ageDiff(b) > 0, above2: ageDiff(b) >= 2,
    newAuthor: !others.some(x => x.author === b.author), sameAuthor: others.some(x => x.author === b.author),
    fast: (parseIso(today()) - parseIso(started)) / 864e5 <= 7,
  };
}
function bingoCellFor(b, p) {
  const st = bingoState();
  if (st.complete) return '';
  const ctx = bingoCtx(b, p);
  const free = st.cells.filter(c => !c.book && BINGO_POOL[c.label] && BINGO_POOL[c.label](b, ctx));
  return free.length ? st.n + ':' + free[0].label : '';
}
function bingoRewards() {
  const st = bingoState();
  const ops = st.full.filter(x => !(D.ledger || []).some(l => l.kind === 'bingo' && l.ref === 'c' + st.n + 'l' + x.i)).map(x => ledger('bingo', 10, 'c' + st.n + 'l' + x.i));
  if (st.complete && !(D.ledger || []).some(l => l.kind === 'bingo' && l.ref === 'c' + st.n + 'full')) ops.push(ledger('bingo', 30, 'c' + st.n + 'full'));
  if (ops.length) { save(ops); setTimeout(() => toast(st.complete ? 'Карточка бинго заполнена! +' + (ops.length * 10 + 20) + ' мин' : 'Бинго! +' + ops.length * 10 + ' мин'), 900); }
}

function achievements() {
  const done = doneIds().map(id => BOOKS[id]).filter(Boolean);
  const st = stats();
  const cards = num(S().bingo_card, 1);
  let lines = 0, complete = 0;
  for (let n = 1; n <= cards; n++) { const b = bingoState(n); lines += b.full.length; if (b.complete) complete++; }
  const ctx = {
    count: f => done.filter(f).length,
    longest: done.reduce((a, b) => Math.max(a, num(b.words, 0)), 0),
    month: doneRows().filter(p => p.finished >= addDays(today(), -30)).length,
    above: done.filter(b => ageDiff(b) > 0).length,
    authors: new Set(done.map(b => b.author)).size,
    perfect: chapterChecks().filter(c => num(c.total, 0) > 0 && num(c.score, 0) === num(c.total, 0)).length,
    learned: (D.words || []).filter(w => w.book_id !== 'case' && (w.st === 'archived' || w.st === 'learned')).length,
    cases: (D.words || []).filter(w => w.book_id === 'case' && (w.st === 'archived' || w.st === 'learned')).length,
    blitz: num(S().best_blitz, 0),
    secrets: Object.keys(store.get('secrets', {})).length,
    questions: num(D.ai_count, 0),
    reviews: doneRows().filter(p => p.review).length,
    days: Object.keys(st).filter(x => readDay(st[x])).length,
    mornings: Object.keys(st).filter(x => Object.keys(st[x].hours || {}).some(h => Number(h) < 9)).length,
    evenings: Object.keys(st).filter(x => Object.keys(st[x].hours || {}).some(h => Number(h) >= 20)).length,
    lines, cards: complete,
  };
  return ACHIEVEMENTS.map(([icon, name, value, steps, forms]) => {
    const v = value(ctx), t = steps.filter(x => v >= x).length, next = steps[t];
    const unit = n => plural(n, forms[0], forms[1], forms[2]);
    return { icon, name, t, goal: next ? fmt(v) + ' / ' + fmt(next) + ' · ' + unit(next) : fmt(v) + ' ' + unit(v) + ' · все ступени', pct: next ? Math.min(1, v / next) : 1 };
  });
}

function shelfCard(p, from) {
  const b = BOOKS[p.book_id] || { short: p.book_id, color: '#5B6475' };
  const st = num(p.stars, 0);
  return `<a class="stack" href="#/book/${p.book_id}?from=${from}" style="gap:6px">${coverHtml(b, '100%', 200, 15)}
    <b style="font-size:15px;line-height:1.25">${esc(b.short || p.book_id)}</b>
    ${st ? `<span style="font-size:16px;letter-spacing:2px;color:var(--amber)">${'★★★★★'.slice(0, st)}${'☆☆☆☆☆'.slice(0, 5 - st)}</span>` : '<span class="small" style="color:var(--blue);font-weight:600">Оцени книгу</span>'}</a>`;
}
function bingoGrid(st) {
  const inLine = new Set([].concat(...st.full.map(x => x.l)));
  return '<div class="bingo">' + st.cells.map((c, i) => {
    if (!c.book) return `<div class="bcell"><div class="lbl">${esc(c.label)}</div></div>`;
    const b = BOOKS[c.book] || { short: c.book, color: '#5B6475' };
    return `<div class="bcell on ${inLine.has(i) ? 'line' : ''}">${b.cover ? asset(b.cover) : `<div class="mini" style="background:${b.color}"></div>`}
      <div class="lbl">${esc(c.label)}</div><div class="stamp"><i>✓</i>${esc(b.short)}</div></div>`;
  }).join('') + '</div>';
}

VIEWS.collection = () => {
  const done = doneRows().sort((a, b) => String(b.finished).localeCompare(String(a.finished)));
  const ach = achievements();
  const st = bingoState();
  const n = st.n;
  return `<div class="page">
    <header class="head"><h1>Коллекция</h1></header>
    <section class="stack"><div class="row"><h2 class="grow" style="margin:0">Прочитано · ${done.length}</h2>${done.length > 4 ? '<a class="pill" href="#/shelf">Все ›</a>' : ''}</div>
      ${done.length ? `<div class="grid4">${done.slice(0, 4).map(p => shelfCard(p, 'collection')).join('')}</div>` : '<div class="empty">Здесь появятся книги, которые ты дочитаешь.</div>'}</section>
    <section class="card stack"><div class="row"><h2 style="margin:0">Книжное бинго · карточка ${n}</h2>${info('bingo')}<span class="muted" style="margin-left:auto">${st.cells.filter(c => c.book).length} из 16</span></div>
      ${st.complete ? `<div class="row" style="padding:14px 16px;border-radius:12px;background:var(--green-soft)"><b class="grow">Карточка заполнена! 🎉</b><button class="btn small" data-act="newCard">Начать карточку ${n + 1}</button></div>` : ''}
      ${bingoGrid(st)}
      ${n > 1 ? `<div class="row wrap small muted" style="gap:8px">Заполненные: ${Array.from({ length: n - 1 }, (_, i) => `<a class="pill" href="#/card/${i + 1}">Карточка ${i + 1} ✓</a>`).join('')}</div>` : ''}</section>
    <section class="stack"><h2 style="margin:0">Достижения · ${ach.filter(a => a.t).length} из ${ach.length}</h2>
      <div class="grid3">${ach.map(a => `<div class="ach"><div class="medal t${a.t}">${a.icon}</div><div class="grow"><b style="font-size:15px">${a.name}</b>
        <div class="tiny muted" style="line-height:1.3">${a.goal}</div><div class="bar ${a.t ? 'green' : ''}" style="height:6px;margin-top:6px"><i style="width:${Math.round(a.pct * 100)}%"></i></div></div></div>`).join('')}</div></section>
  </div>`;
};

VIEWS.card = r => {
  const st = bingoState(num(r.a, 1));
  return `<div class="page full"><header class="head">${backBtn('collection')}<h1>Карточка ${st.n}</h1></header>${bingoGrid(st)}</div>`;
};

VIEWS.shelf = () => {
  const sorts = { recent: (a, b) => String(b.finished).localeCompare(String(a.finished)), stars: (a, b) => num(b.stars, 0) - num(a.stars, 0), author: (a, b) => authorOf(BOOKS[a.book_id] || {}).name.localeCompare(authorOf(BOOKS[b.book_id] || {}).name) };
  const done = doneRows().sort(sorts[UI.shelfSort] || sorts.recent);
  const totalWords = done.reduce((a, p) => a + num((BOOKS[p.book_id] || {}).words, 0), 0);
  return `<div class="page full">
    <header class="head">${backBtn('collection')}<h1>Прочитано · ${done.length}</h1></header>
    <div class="small muted">${fmt(totalWords)} слов · ${new Set(done.map(p => (BOOKS[p.book_id] || {}).author)).size} ${plural(new Set(done.map(p => (BOOKS[p.book_id] || {}).author)).size, 'автор', 'автора', 'авторов')}</div>
    <div class="row wrap" style="gap:8px">${[['recent', 'Недавние'], ['stars', 'Лучшие'], ['author', 'По автору']].map(([k, l]) => `<button class="chip ${UI.shelfSort === k ? 'on' : ''}" data-act="shelfSort" data-k="${k}">${l}</button>`).join('')}</div>
    <div class="grid4">${done.map(p => shelfCard(p, 'shelf')).join('')}</div>
  </div>`;
};

// ------------------------------------------------------------ level ---

VIEWS.me = () => {
  const s = S();
  const cal = calibrated();
  const nPassed = chapterChecks().filter(c => yes(c.passed)).length;
  const lm = langMonths(), hm = hisMonths();
  const ageMin = 6, ageMax = 16;
  const pos = m => Math.max(0, Math.min(100, (m / 12 - ageMin) / (ageMax - ageMin) * 100));
  const hero = cal ? `<section class="darkcard stack" style="gap:12px">
      <div class="row" style="gap:10px"><span class="muted">Читаешь как носитель языка в возрасте</span>${info('level')}</div>
      <div style="font-size:44px;font-weight:700;line-height:1.1">${ym(lm)}</div>
      <div class="bar amber" style="height:8px"><i style="width:${Math.round(num(s.lang_prog, 0) * 100)}%"></i></div>
      <div class="small muted">До ${ym(lm + 1)}: проверки глав и новые слова</div>
      <div class="scale"><div class="rail"></div><div class="fill" style="width:${pos(lm)}%"></div>
        <div class="you" style="left:${pos(lm)}%"><b>ты</b><i></i></div>
        <div class="age" style="left:${pos(hm)}%"><span>твой возраст</span><i></i></div>
        <div class="ticks">${Array.from({ length: 11 }, (_, i) => '<span>' + (ageMin + i) + '</span>').join('')}</div></div>
      <div class="small muted">Твой возраст — ${ym(hm)} · сравнение с детьми, для которых русский родной</div></section>`
    : `<section class="darkcard stack" style="gap:14px"><span class="muted">Язык</span>
      <div style="font-size:26px;font-weight:700;line-height:1.25">Уровень появится после трёх проверок глав</div>
      <div class="row" style="gap:8px">${[0, 1, 2].map(i => `<i style="width:64px;height:10px;border-radius:5px;background:${i < nPassed ? 'var(--amber)' : 'var(--dark-line)'}"></i>`).join('')}</div>
      <a class="btn ghost" href="#/test" style="align-self:flex-start;color:#FFFFFF;border-color:#5B6475">Или пройди тест · 10 мин</a></section>`;
  // Coverage: how many of the words in each prepared book he probably knows.
  const covBooks = Object.keys(BOOKS).map(id => BOOKS[id]).filter(b => b.bands && coverage(b) != null).sort((a, b) => a.age - b.age);
  const covHtml = covBooks.length ? `<section class="card stack" style="gap:12px"><div class="row"><b>Сколько слов ты знаешь в книгах</b>${info('cover')}</div>
    ${covBooks.slice(0, 8).map(b => { const v = coverage(b); return `<div class="row" style="gap:12px"><span style="width:200px" class="small">${esc(b.short)} <span class="muted">· ${b.age}+</span></span>
      <span class="grow" style="position:relative;height:16px;border-radius:4px;background:var(--soft)"><i style="position:absolute;left:0;top:0;bottom:0;border-radius:4px;width:${Math.max(0, (v - 0.7) / 0.3 * 100)}%;background:var(--blue)"></i></span>
      <b class="small" style="width:56px;text-align:right">${pct(v)}</b></div>`; }).join('')}
    <div class="tiny muted">Шкала начинается с 70%.</div></section>` : '';
  const checks = chapterChecks();
  const acc = checks.length ? Math.round(checks.reduce((a, c) => a + num(c.score, 0), 0) / checks.reduce((a, c) => a + num(c.total, 0), 0) * 100) : 0;
  const learned = (D.words || []).filter(w => w.book_id !== 'case' && (w.st === 'archived' || w.st === 'learned')).length;
  const w90 = words90(), ri = rankIdx(w90), R = RANKS[ri], N = RANKS[ri + 1];
  const done = doneIds().map(id => BOOKS[id]).filter(Boolean);
  const genres = ['Рассказ', 'Сказка', 'Повесть', 'Роман'].map(g => [g, done.filter(b => b.genre === g).length]);
  const gmax = Math.max(1, ...genres.map(g => g[1]));
  return `<div class="page">
    <header class="head"><h1>Мой уровень</h1><button class="btn ghost small" data-act="parent">Родителям</button></header>
    ${hero}
    <div class="grid3">
      <div class="card stat"><b>${s.vocab_size ? '≈ ' + fmt(Math.round(num(s.vocab_size, 0) / 100) * 100) : done.length}</b><span>${s.vocab_size ? 'слов в словарном запасе' : plural(done.length, 'книга прочитана', 'книги прочитаны', 'книг прочитано')}</span></div>
      <div class="card stat"><b>${checks.length ? acc + '%' : '—'}</b><span>верных ответов в проверках</span></div>
      <div class="card stat"><b>${learned}</b><span>новых слов выучено</span></div>
    </div>
    ${covHtml}
    <section class="card stack" style="gap:14px">
      <div class="row" style="gap:16px"><div class="badge" style="width:56px;height:56px;background:${R.bg};color:${R.ink}">${ri + 1}</div>
        <div class="grow"><div class="row" style="gap:8px"><span class="tiny muted">Начитанность · за 3 месяца</span>${info('ranks')}</div>
          <b style="font-size:19px">${R.name}</b>
          <div class="bar" style="margin-top:8px"><i style="width:${N ? Math.round((w90 - R.min) / (N.min - R.min) * 100) : 100}%"></i></div>
          <div class="tiny muted" style="margin-top:6px">${N ? 'До «' + N.name + '»: ещё ' + fmt(N.min - w90) + ' слов за 3 месяца' : 'Высшее звание!'}</div></div></div>
      <div class="ranks">${RANKS.map((k, i) => `<div class="${i < ri ? 'past' : ''}" style="${i === ri ? 'background:' + k.bg + ';color:' + k.ink + ';border-color:transparent' : ''}">${k.name}<small>${i ? '≈ ' + Math.round(k.min / 6000) + ' кн.' : '0'}</small></div>`).join('')}</div>
    </section>
    <section class="card stack"><b>Что читаю</b>
      ${genres.map(([g, n]) => `<div class="hbar" title="${g}: ${n}"><span class="n">${g}</span><span class="b"><i style="width:${n ? Math.max(6, n / gmax * 100) : 0}%"></i></span><b style="width:20px;text-align:right">${n}</b></div>`).join('')}
    </section>
  </div>`;
};

// ---------------------------------------------------- placement test ---

/* Two parts, about 10 minutes: 64 words «знаю / не знаю» (48 real ones from six frequency bands and 16
   made-up ones that catch guessing), then short passages from easy to hard with three questions each.
   Result: the language age (the hardest passage he understood) and how much of each band he knows. */
VIEWS.test = async () => {
  if (placed() && !(UI.test && UI.test.phase === 'done')) {
    return `<div class="page full">${backBtn('me')}<div class="card big stack"><b style="font-size:22px">Тест уже пройден</b><div class="muted">Пройти его заново может разрешить родитель.</div></div></div>`;
  }
  let P;
  try { P = await content('placement.json'); } catch (e) { toast('Не получилось загрузить тест', true); location.hash = '#/me'; return null; }
  if (!UI.test) {
    const items = seeded(P.real.map(r => ({ w: r.w, band: r.band })).concat(P.fake.map(w => ({ w, band: 0 }))), 'test' + today());
    const passages = P.passages.slice().sort((a, b) => a.age - b.age);
    UI.test = { phase: 'intro', items, i: 0, said: [], passages, pi: 0, answers: {}, scores: [] };
  }
  const T = UI.test;
  const head = `<header class="head">${backBtn('me')}<h1>Тест на уровень</h1></header>`;
  if (T.phase === 'intro') return `<div class="page white full">${head}
    <div class="stack" style="gap:16px;font-size:18px;line-height:1.6;max-width:640px">
      <p style="margin:0">Сначала будут слова: нажимай «Знаю», если понимаешь, что слово значит, и «Не знаю», если нет. Некоторые слова выдуманные — их честно отмечай «Не знаю».</p>
      <p style="margin:0">Потом — несколько коротких текстов с вопросами, от лёгких к трудным. Не спеши и читай внимательно. Это не экзамен: так приложение подберёт книги тебе по силам.</p>
      <button class="btn" data-act="testGo" style="align-self:flex-start">Начать</button></div></div>`;
  if (T.phase === 'vocab') {
    const it = T.items[T.i];
    return `<div class="page white full">${head}
      <div class="bar" style="height:6px"><i style="width:${Math.round(T.i / T.items.length * 100)}%"></i></div>
      <div class="small muted">Слово ${T.i + 1} из ${T.items.length}</div>
      <div style="text-align:center;font-size:52px;font-weight:700;padding:90px 0 70px">${esc(it.w)}</div>
      <div class="grid2" style="max-width:560px;margin:0 auto;width:100%"><button class="btn ghost" style="min-height:76px;font-size:22px" data-act="testWord" data-v="0">Не знаю</button>
        <button class="btn" style="min-height:76px;font-size:22px" data-act="testWord" data-v="1">Знаю</button></div></div>`;
  }
  if (T.phase === 'read') {
    const p = T.passages[T.pi];
    const qs = p.q.map((q, i) => Object.assign({ text: q.q }, shuffle(q.o, 'p' + T.pi + i)));
    T.qs = qs;
    const all = qs.every((q, i) => T.answers[i] !== undefined);
    return `<div class="page white full">${head}
      <div class="small muted">Текст ${T.pi + 1} из ${T.passages.length}</div>
      <article style="font-size:20px;line-height:1.65;max-width:660px">${p.title ? '<h2 style="margin:0 0 12px">' + esc(p.title) + '</h2>' : ''}${String(p.text).split('\n').filter(Boolean).map(x => '<p style="margin:0 0 .8em">' + esc(x) + '</p>').join('')}</article>
      ${qs.map((q, i) => `<section class="q"><div class="qt"><span>${i + 1}</span><span>${esc(q.text)}</span></div>
        <div class="grid2" style="gap:10px">${q.opts.map((o, j) => `<button class="opt ${T.answers[i] === j ? 'sel' : ''}" data-act="testAns" data-i="${i}" data-j="${j}">${esc(o)}</button>`).join('')}</div></section>`).join('')}
      <button class="btn" data-act="testNext" style="align-self:flex-start" ${all ? '' : 'disabled'}>Дальше</button></div>`;
  }
  return `<div class="page white full">${head}
    <div class="darkcard stack" style="gap:12px"><span class="muted">Ты читаешь как носитель языка в возрасте</span>
      <div style="font-size:44px;font-weight:700">${ym(T.result.months)}</div>
      <div class="muted">Словарный запас ≈ ${fmt(Math.round(T.result.size / 100) * 100)} слов · сравнение с детьми, для которых русский родной</div></div>
    <a class="btn" href="#/library" style="align-self:flex-start">Посмотреть книги по силам</a></div>`;
};

function finishTest() {
  const T = UI.test;
  // Vocabulary: share of each band he knows, corrected for guessing with the made-up words.
  const said = T.said;
  const fakes = said.filter(x => x.band === 0);
  const fa = fakes.length ? fakes.filter(x => x.v).length / fakes.length : 0;
  const bands = [1, 2, 3, 4, 5, 6].map(b => {
    const xs = said.filter(x => x.band === b);
    if (!xs.length) return 0;
    const h = xs.filter(x => x.v).length / xs.length;
    return Math.round(Math.max(0, Math.min(1, fa >= 1 ? 0 : (h - fa) / (1 - fa))) * 1000) / 1000;
  });
  // Words per band; the open-ended rarest band is counted as 10 000 (what a young reader could plausibly know).
  const SIZES = [1000, 2000, 3000, 6000, 13000, 10000];
  const size = Math.round(bands.reduce((a, p, i) => a + p * SIZES[i], 0));
  // Reading: the hardest passage he understood (2 of 3), counting up from the easiest; part of the next adds months.
  let base = T.passages[0].age - 2, extra = 0;
  for (let i = 0; i < T.scores.length; i++) {
    if (T.scores[i] >= 2) base = T.passages[i].age;
    else { extra = T.scores[i] / 3; break; }
  }
  const gap = T.passages.length > 1 ? T.passages[1].age - T.passages[0].age : 2;
  const months = Math.round(base * 12 + extra * gap * 12 * 0.75);
  T.result = { months, size, bands, fa };
  T.phase = 'done';
  save([], { placement_date: today(), vocab_bands: JSON.stringify(bands), vocab_size: size, lang_months: months, lang_prog: 0 });
  render();
}

// ----------------------------------------------------------- parent ---

VIEWS.parent = () => {
  if (!UI.parentOk) { setTimeout(() => openPin(), 0); return VIEWS.me(); }
  const s = S();
  const pend = pendingReq();
  const cur = BOOKS[s.cur_book];
  const words = D.words || [];
  const tricky = words.filter(w => num(w.misses, 0) > 0).sort((a, b) => num(b.misses, 0) - num(a.misses, 0)).slice(0, 3).map(w => w.base);
  const reviews = doneRows().filter(p => p.review || num(p.stars, 0));
  const step = (label, key, d, min, max, show) => `<div class="stepper"><span class="grow">${label}</span>
    <button data-act="pset" data-k="${key}" data-d="${-d}" data-min="${min}" data-max="${max}" aria-label="Меньше">−</button><b class="v">${show(num(s[key], 0))}</b>
    <button data-act="pset" data-k="${key}" data-d="${d}" data-min="${min}" data-max="${max}" aria-label="Больше">+</button></div>`;
  const c = cfg();
  const log = (D.ai_log || []).slice().reverse().slice(0, 10);
  return `<div class="page white full">
    <header class="head">${backBtn('me')}<h1>Для родителей</h1></header>
    <section class="card stack" style="background:var(--bg);border:0">
      ${pend ? `<div class="row wrap"><div class="grow"><b style="font-size:18px">Просит ${String(pend.mins) === '60' ? '1 час' : pend.mins + ' мин'}</b>
        <div class="small muted">Баланс ${balance()} мин. После подтверждения здесь одобрите столько же в «Экранном времени».</div></div>
        <button class="btn ghost small" data-act="decide" data-id="${pend.id}" data-ok="0">Отклонить</button>
        <button class="btn small" data-act="decide" data-id="${pend.id}" data-ok="1">Одобрить</button></div>`
        : `<div>Запросов нет. Баланс ${balance()} мин.</div>`}
    </section>
    ${cur ? `<section class="row"><div class="grow"><b>${esc(cur.title)}</b><div class="small muted">${yes(s.locked) ? 'Закреплена до конца. Следующая: ' + (s.next_book && BOOKS[s.next_book] ? '«' + BOOKS[s.next_book].short + '»' : 'пока не выбрана') + '.' : 'Открепили: можно сменить книгу сейчас.'}</div></div>
      <button class="btn ghost small" data-act="toggleLock">${yes(s.locked) ? 'Разрешить сменить' : 'Закрепить снова'}</button></section>` : ''}
    <section class="stack" style="padding-top:18px;border-top:1px solid var(--line)"><h2 style="margin:0">Уровень языка</h2>
      <div class="grid3">
        <div class="fact"><b>${calibrated() ? ym(langMonths()) : 'после 3 проверок'}</b><span class="tiny muted">читает как ребёнок-носитель этого возраста; ему ${ym(hisMonths())}</span></div>
        <div class="fact"><b>${s.vocab_size ? '≈ ' + fmt(num(s.vocab_size, 0)) : '—'}</b><span class="tiny muted">${s.placement_date ? 'словарный запас по тесту от ' + esc(s.placement_date) : 'тест на уровень не пройден'}</span></div>
        <div class="fact"><b>${words.filter(w => w.st === 'learning').length} / ${words.filter(w => w.st === 'archived').length} / ${words.filter(w => w.st === 'learned').length}</b><span class="tiny muted">слов учит / отдыхают / выучено</span></div>
      </div>
      ${tricky.length ? '<div class="small">Чаще всего ошибается: ' + tricky.map(esc).join(', ') + '.</div>' : ''}
      ${step('Уровень языка (поправить)', 'lang_months', 1, 72, 192, v => ym(v))}
      <div class="row"><span class="grow small muted">Скорость чтения (ему не показывается): ${wpm()} сл/мин</span>${s.placement_date ? '<button class="btn ghost small" data-act="retest">Разрешить пройти тест заново</button>' : ''}</div>
    </section>
    <section class="stack" style="padding-top:18px;border-top:1px solid var(--line);gap:0"><h2 style="margin:0 0 6px">Награды</h2>
      ${step('Минут экрана за минуту чтения', 'ratio', 0.1, 0.1, 2, v => ru(v) + ' мин')}
      ${step('Вся книга (финальная проверка)', 'final_pct', 10, 0, 200, v => '+' + v + '% от глав')}
      ${step('Раунд Блица (5+ верных)', 'blitz_reward', 1, 0, 10, v => v + ' мин')}
      <div class="grid4" style="grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;margin-top:14px">${[[-2, 'на 2+ года проще'], [-1, 'на год проще'], [0, 'его уровень'], [1, 'на год сложнее'], [2, 'на 2 года сложнее (предел)']].map(([d, l]) => `<div class="fact" style="text-align:center"><b>×${ru(MULT[String(d)])}</b><span class="tiny muted">${l}</span></div>`).join('')}</div>
      <div class="row" style="margin-top:14px"><span class="grow">Поправить баланс</span><button class="btn ghost small" data-act="adjust" data-m="-5">−5 мин</button><button class="btn ghost small" data-act="adjust" data-m="5">+5 мин</button></div>
    </section>
    <section class="stack" style="padding-top:18px;border-top:1px solid var(--line);gap:0"><h2 style="margin:0 0 6px">Вопросы к ИИ</h2>
      <div class="stepper"><span class="grow">Вопросы о книгах (Gemini)</span><button class="btn small ${aiOn() ? 'ghost' : ''}" data-act="toggleAi" style="width:auto">${aiOn() ? 'Выключить' : 'Включить'}</button></div>
      ${step('Вопросов в день', 'ai_per_day', 1, 0, 30, v => v + '')}
      ${log.length ? '<div class="stack" style="margin-top:12px">' + log.map(l => `<div class="small"><b>${esc((BOOKS[l.book_id] || {}).short || l.book_id)}${l.chapter ? ', гл. ' + esc(l.chapter) : ''}:</b> ${esc(l.question)}<div class="muted" style="margin-top:2px">${esc(String(l.answer).slice(0, 220))}${String(l.answer).length > 220 ? '…' : ''}</div></div>`).join('') + '</div>' : ''}
    </section>
    ${reviews.length ? `<section class="stack" style="padding-top:18px;border-top:1px solid var(--line)"><h2 style="margin:0">Отзывы</h2>${reviews.map(p => `<div><b>${esc((BOOKS[p.book_id] || {}).short || p.book_id)}</b> ${'★'.repeat(num(p.stars, 0))}<div class="review" style="font-size:15px">${p.review ? '«' + esc(p.review) + '»' : ''}</div></div>`).join('')}</section>` : ''}
    <section class="stack" style="padding-top:18px;border-top:1px solid var(--line)"><h2 style="margin:0">Подключение</h2>
      <input class="field" id="cfgApi" placeholder="Адрес веб-приложения (…/exec)" value="${esc(c.api)}">
      <input class="field" id="cfgKey" placeholder="APP_KEY" value="${esc(c.key)}">
      <div class="row wrap"><button class="btn small" data-act="connect">Подключить</button>
        ${c.api ? '<button class="btn ghost small" data-act="copyLink">Скопировать ссылку-приглашение</button>' : ''}
        <button class="btn ghost small" data-act="newPin">Сменить PIN</button></div>
    </section>
  </div>`;
};

// ------------------------------------------------------------ sheets ---

function openSheet(html, center) {
  const w = $('#sheet');
  w.className = 'sheet-wrap' + (center ? ' center' : '');
  w.innerHTML = '<div class="sheet">' + html + '</div>';
  w.hidden = false;
  hydrate();
}
function closeSheet() { const w = $('#sheet'); w.hidden = true; w.innerHTML = ''; }

function openPin(mode) {
  UI.pin = '';
  UI.pinMode = mode || (S().pin_set ? 'enter' : 'new');
  drawPin();
}
function drawPin() {
  const title = { enter: 'PIN для родителей', new: 'Придумайте PIN (4 цифры)', change: 'Новый PIN (4 цифры)' }[UI.pinMode];
  openSheet(`<h3 style="text-align:center">${title}</h3>
    <div class="pindots">${[0, 1, 2, 3].map(i => '<i class="' + (i < UI.pin.length ? 'on' : '') + '"></i>').join('')}</div>
    <div class="pinpad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button data-act="pinKey" data-k="${n}">${n}</button>`).join('')}
      <button data-act="closeSheet" style="font-size:15px">Отмена</button><button data-act="pinKey" data-k="0">0</button><button data-act="pinKey" data-k="del" aria-label="Стереть">⌫</button></div>`, true);
}
async function pinDone() {
  const pin = UI.pin;
  if (UI.pinMode === 'enter') {
    const res = await run('parent', { op: 'check', pin });
    if (res && res.ok) { UI.parentOk = true; UI.parentPin = pin; closeSheet(); location.hash = '#/parent'; render(); }
    else { UI.pin = ''; drawPin(); }
  } else {
    const res = await run('parent', { op: 'pinSet', pin: UI.parentPin || '', newPin: pin });
    if (res) { D = res; saveCache(); UI.parentOk = true; UI.parentPin = pin; closeSheet(); toast('PIN сохранён'); location.hash = '#/parent'; render(); }
    else { UI.pin = ''; drawPin(); }
  }
}
async function parentCall(payload, okMsg) {
  const res = await run('parent', Object.assign({ pin: UI.parentPin }, payload));
  if (res && res.settings) { D = res; saveCache(); if (okMsg) toast(okMsg); render(); }
  return res;
}

/* Parent settings change on screen at once; they are sent together a moment after the last tap,
   so the + and − buttons never wait for the server. */
let pendingSet = {}, setTimer = 0;
function setNow(set, okMsg) {
  Object.assign(D.settings, set);
  Object.assign(pendingSet, set);
  saveCache(); render();
  clearTimeout(setTimer);
  setTimer = setTimeout(async () => {
    const send = pendingSet; pendingSet = {};
    const res = await run('parent', { pin: UI.parentPin, op: 'settings', set: send });
    if (res && res.settings) { D = res; Object.assign(D.settings, pendingSet); saveCache(); if (okMsg) toast(okMsg); }
    else { Object.assign(pendingSet, send); toast('Не сохранилось. Попробуйте ещё раз.', true); }
    if (location.hash.indexOf('parent') > -1) render();
  }, 700);
}

function connectFromLink(q) {
  const api = q.get('api'), key = q.get('key');
  if (api && key) { store.set('cfg', { api, key }); localStorage.removeItem('polka_cache'); D = null; toast('Подключено'); }
  history.replaceState(null, '', location.pathname + '#/home');
  load();
}

// ------------------------------------------------------------ events ---

const ACTS = {
  info: el => openSheet('<div style="font-size:18px;line-height:1.55">' + esc(INFO[el.dataset.k] || '') + '</div><button class="btn dark" data-act="closeSheet" style="align-self:flex-end">Понятно</button>', true),
  closeSheet: () => closeSheet(),
  zoom: el => {
    const w = $('#sheet');
    w.className = 'sheet-wrap';
    w.innerHTML = '<div class="zoom" data-act="closeSheet"><img src="' + esc(el.src) + '" alt=""></div>';
    w.hidden = false;
  },
  author: el => {
    const A = AUTHORS[el.dataset.id];
    if (!A) return;
    const books = Object.keys(BOOKS).filter(id => BOOKS[id].author === el.dataset.id);
    openSheet(`<div class="row" style="align-items:flex-start;gap:20px">
      ${A.portrait ? asset(A.portrait, 'style="width:120px;height:150px;object-fit:cover;object-position:top;border-radius:10px;flex-shrink:0"') : `<div class="avatar" style="width:120px;height:150px;border-radius:10px;font-size:44px;font-weight:700">${esc(A.name[0])}</div>`}
      <div class="grow stack" style="gap:6px"><b style="font-size:26px">${esc(A.name)}</b><span class="muted">${esc(A.years)}</span><div style="font-size:17px;line-height:1.55;color:var(--ink2);margin-top:4px">${esc(A.bio)}</div></div>
      <button class="icon-btn" data-act="closeSheet" aria-label="Закрыть">${ICON.close}</button></div>
      <b>В библиотеке</b><div class="row wrap">${books.map(id => `<a class="pill" href="#/book/${id}">${esc(BOOKS[id].short)}</a>`).join('')}</div>`);
  },
  genre: el => { UI.genre = el.dataset.k; render(); },
  len: el => { UI.len = el.dataset.k; render(); },
  shelfSort: el => { UI.shelfSort = el.dataset.k; render(); },
  heart: el => {
    const id = el.dataset.id, list = shortlist();
    const on = list.indexOf(id) > -1;
    const next = on ? list.filter(x => x !== id) : list.concat([id]);
    const set = { shortlist: next.join(',') };
    if (on && S().next_book === id) set.next_book = '';
    if (!on) bump('hearts');
    save([], set);
    render();
  },
  pickNext: el => {
    const id = el.dataset.id, s = S();
    const set = { next_book: s.next_book === id ? '' : id };
    if (shortlist().indexOf(id) < 0) { set.shortlist = shortlist().concat([id]).join(','); bump('hearts'); }
    save([], set);
    render();
  },
  startBook: el => {
    const id = el.dataset.id;
    if (!BOOKS[id].ready) return toast('Эту книгу я ещё готовлю');
    // Starting a book locks it again until it is finished.
    const set = { cur_book: id, locked: true, shortlist: shortlist().filter(x => x !== id).join(',') };
    if (S().next_book === id) set.next_book = '';
    save([{ t: 'Progress', rows: [Object.assign({ book_id: id, status: 'reading', started: today(), chapters_passed: 0 }, progressOf(id) || {}, { updated: today() })] }], set);
    location.hash = '#/home';
  },
  newCard: () => { save([], { bingo_card: num(S().bingo_card, 1) + 1 }); toast('Новая карточка бинго!'); render(); },
  redeem: () => {
    const bal = balance();
    openSheet(`<h3>Потратить · есть ${bal} мин</h3>
      <div class="grid2">${[[15, '15 мин'], [60, '1 час']].map(([m, l]) => `<button class="btn ${bal < m ? '' : 'ghost'}" style="min-height:72px;font-size:20px" data-act="sendRequest" data-m="${m}" ${bal < m ? 'disabled' : ''}>${l}</button>`).join('')}</div>
      <button class="btn ghost" data-act="closeSheet" style="align-self:flex-end">Отмена</button>`);
  },
  sendRequest: async el => {
    const res = await run('request', { mins: Number(el.dataset.m) });
    if (res) { D = res; saveCache(); closeSheet(); toast('Запрос отправлен родителю'); render(); }
  },
  // reader
  pg: el => turnPage(Number(el.dataset.d)),
  word: el => tapWord(el.dataset.id),
  closePanel: () => closePanel(),
  aa: () => { const p = $('#rpanel'); if (UI.r.aa) closePanel(); else { closePanel(); UI.r.aa = true; p.innerHTML = aaPanel(); } },
  pref: el => {
    UI.r.prefs[el.dataset.k] = el.dataset.v;
    store.set('rprefs', UI.r.prefs);
    if (el.dataset.k === 'theme') $('#reader').className = 'reader ' + el.dataset.v;
    $('#rpanel').innerHTML = aaPanel();
    UI.r.frac = UI.r.page / UI.r.pages; UI.r.page = -1;
    layoutReader(false);
  },
  fontsize: el => {
    UI.r.prefs.size = Math.max(0, Math.min(5, UI.r.prefs.size + Number(el.dataset.d)));
    store.set('rprefs', UI.r.prefs);
    $('#rpanel').innerHTML = aaPanel();
    UI.r.frac = UI.r.page / UI.r.pages; UI.r.page = -1;
    layoutReader(false);
  },
  // AI
  chat: () => (UI.r.chat ? closePanel() : openChat('')),
  askStarter: el => openChat(el.dataset.q, true),
  askSend: () => { const i = $('#askInput'); if (i && i.value.trim()) askAI(i.value); },
  askWord: el => openChat('Что значит «' + el.dataset.base + '» в этом месте?', true),
  askSel: el => { hideAskSel(); const t = el.dataset.text; try { window.getSelection().removeAllRanges(); } catch (e) { /* ignore */ } openChat('Что значит «' + t + '» здесь?', false); },
  askBook: el => {
    const i = $('#askBook');
    if (!i || !i.value.trim()) return;
    if (!UI.chat || UI.chat.key !== 'book:' + el.dataset.id) UI.chat = { key: 'book:' + el.dataset.id, msgs: [], busy: false };
    askAI(i.value, 'book', el.dataset.id);
  },
  // checks
  answer: el => { const C = UI.check[el.dataset.key]; if (C.done) return; C.answers[el.dataset.i] = Number(el.dataset.j); render(); },
  submitCheck: el => submitCheck(el.dataset.key),
  retryCheck: el => { delete UI.check[el.dataset.key]; render(); window.scrollTo(0, 0); },
  // blitz
  bzStart: () => bzStart(),
  bzPick: el => bzPick(Number(el.dataset.j)),
  bzAgain: () => { UI.bz = null; render(); },
  // placement test
  testGo: () => { UI.test.phase = 'vocab'; render(); },
  testWord: el => {
    const T = UI.test, it = T.items[T.i];
    T.said.push({ band: it.band, v: el.dataset.v === '1' });
    T.i++;
    if (T.i >= T.items.length) { T.phase = 'read'; T.pi = 0; T.answers = {}; }
    render();
  },
  testAns: el => { UI.test.answers[el.dataset.i] = Number(el.dataset.j); render(); },
  testNext: () => {
    const T = UI.test;
    const score = T.qs.filter((q, i) => T.answers[i] === q.a).length;
    T.scores.push(score);
    T.pi++; T.answers = {};
    const failedTwice = T.scores.length >= 2 && T.scores.slice(-2).every(x => x < 2);
    if (T.pi >= T.passages.length || failedTwice) finishTest(); else { render(); window.scrollTo(0, 0); }
  },
  // quests, reviews
  claim: el => { save([ledger('quest', Number(el.dataset.r), el.dataset.ref)]); toast('+' + el.dataset.r + ' мин'); render(); },
  star: el => { UI.draftStars = Number(el.dataset.n); const t = $('#reviewText'); const keep = t ? t.value : ''; render(); const t2 = $('#reviewText'); if (t2) t2.value = keep; },
  saveReview: el => {
    const id = el.dataset.id, t = $('#reviewText');
    save([{ t: 'Progress', rows: [Object.assign({}, progressOf(id), { book_id: id, stars: UI.draftStars, review: t ? t.value.trim() : '', updated: today() })] }]);
    UI.draftStars = 0;
    toast('Спасибо!');
    render();
  },
  // parent
  parent: () => (UI.parentOk ? (location.hash = '#/parent') : openPin()),
  pinKey: el => {
    if (el.dataset.k === 'del') UI.pin = UI.pin.slice(0, -1);
    else if (UI.pin.length < 4) UI.pin += el.dataset.k;
    drawPin();
    if (UI.pin.length === 4) setTimeout(pinDone, 150);
  },
  newPin: () => openPin('change'),
  decide: el => parentCall({ op: 'decide', id: el.dataset.id, approve: el.dataset.ok === '1' }, el.dataset.ok === '1' ? 'Одобрено. Теперь одобрите в «Экранном времени».' : 'Отклонено'),
  toggleLock: () => setNow({ locked: !yes(S().locked) }),
  toggleAi: () => setNow({ ai_enabled: !aiOn() }),
  retest: () => { UI.test = null; setNow({ placement_date: '' }, 'Тест можно пройти заново'); },
  pset: el => {
    const k = el.dataset.k, v = Math.round(Math.min(Number(el.dataset.max), Math.max(Number(el.dataset.min), num(S()[k], 0) + Number(el.dataset.d))) * 10) / 10;
    setNow({ [k]: v });
  },
  adjust: el => parentCall({ op: 'adjust', mins: Number(el.dataset.m), note: 'поправка' }, 'Баланс изменён'),
  connect: async () => {
    const api = $('#cfgApi').value.trim(), key = $('#cfgKey').value.trim();
    store.set('cfg', { api, key });
    localStorage.removeItem('polka_cache');
    D = null; UI.parentOk = false;
    toast(api ? 'Подключаю…' : 'Отключено');
    location.hash = '#/home';
    await load();
  },
  copyLink: async () => {
    const c = cfg();
    const link = location.origin + location.pathname + '#/connect?api=' + encodeURIComponent(c.api) + '&key=' + encodeURIComponent(c.key);
    try { await navigator.clipboard.writeText(link); toast('Ссылка скопирована'); } catch (e) { prompt('Ссылка:', link); }
  },
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = ACTS[el.dataset.act];
  if (!fn) return;
  e.preventDefault();
  fn(el, e);
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'askInput') ACTS.askSend();
  if (e.target.id === 'askBook') ACTS.askBook(document.querySelector('[data-act=askBook]'));
});
$('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') closeSheet(); });

// -------------------------------------------------------------- start ---

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js');
if (D && Object.keys(BOOKS).length) render();
load();
