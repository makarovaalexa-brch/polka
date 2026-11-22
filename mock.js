'use strict';
/* Demo back end, used only on a local computer (localhost): mirrors the Apps Script actions in
 * backend/Code.gs over localStorage, and reads content from the local drive/ folder instead of Google Drive.
 * It starts with a few weeks of made-up history so every screen has something to show. Demo PIN: 1234. */

const Mock = (() => {
  // ?demo=en: the English profile (an adult learning English), with its own demo data and drive/mum/ content.
  const EN_PATH = /\/en\/(index\.html)?$/.test(location.pathname);
  const EN_DEMO = EN_PATH || /[?&]demo=en(&|$)/.test(location.search);
  const KEY = EN_DEMO ? 'polka_mockdb_en' : 'polka_mockdb3';
  const DRIVE = (EN_PATH ? '../' : '') + (EN_DEMO ? '../drive/mum/' : '../drive/');
  const DEFAULTS = {
    ratio: 0.5, final_pct: 50, blitz_reward: 1, ai_per_day: 0, ai_enabled: true, dob: '2015-09-01',
    lang_months: 112, lang_prog: 0.4, cur_book: 'kasht', locked: true, next_book: 'kur', shortlist: 'kur,timur,deti',
    best_blitz: 9, wpm: 150, wpm_updated: '', pin_hash: 'demo:1234', gemini_model: 'auto', ai_used_date: '', ai_used: 0,
    placement_date: '', vocab_bands: '', vocab_size: 0, bingo_card: 1, placement_count: 0, level_history: '', vt_count: 0, vt_seen: '', lang: 'ru', user_name: '', cefr: '',
  };
  const CHILD_SETTINGS = ['next_book', 'shortlist', 'best_blitz', 'lang_months', 'lang_prog', 'cur_book', 'locked', 'placement_date', 'vocab_bands', 'vocab_size', 'bingo_card', 'placement_count', 'level_history', 'vt_count', 'vt_seen', 'cefr'];
  const KEYS = { Progress: 'book_id', Checks: 'id', Words: 'key', Ledger: 'id' };
  const id = () => 'r' + Math.random().toString(36).slice(2, 9);
  const pad = n => String(n).padStart(2, '0');
  const day = off => { const d = new Date(); d.setDate(d.getDate() + off); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  const today = () => day(0);
  const now = () => today() + 'T' + pad(new Date().getHours()) + ':' + pad(new Date().getMinutes());

  /** A few weeks of history: four short books read, «Каштанка» on chapter 3, a placement test done. */
  function seed() {
    if (EN_DEMO) return { Settings: Object.assign({}, DEFAULTS, { lang: 'en', user_name: 'Larisa', dob: '', cur_book: '', locked: false, next_book: '', shortlist: '', best_blitz: 0, lang_months: 0, lang_prog: 0 }),
      Progress: [], Checks: [], Words: [], Ledger: [], Requests: [], Pages: [], AILog: [] };
    const S = Object.assign({}, DEFAULTS, { placement_date: day(-12), vocab_bands: JSON.stringify([1, 0.96, 0.86, 0.64, 0.4, 0.15]), vocab_size: 7900, placement_count: 1,
      level_history: JSON.stringify([{ d: day(-12), m: 112, t: 112, s: 7900 }]) });
    const done = [['chuk', -40, 5, 'Смешно, как они потеряли телеграмму и молчали. Тайга очень красивая.', '1:Приключения', 7500],
      ['pudel', -28, 4, 'Серёжа очень смелый. Конец хороший, но злой мальчик ничего не понял.', '1:Про животных', 4300],
      ['plen', -16, 5, 'Лучше всего побег. Дина классная.', '1:Про историю', 6000],
      ['dok', -6, 0, '', '1:Рассказ', 2900]];
    const Progress = done.map(([b, d, stars, review, bingo]) => ({ book_id: b, status: 'done', started: day(d - 6), finished: day(d), chapters_passed: 1, final_score: 7, stars, review, bingo, updated: day(d) }));
    Progress.push({ book_id: 'kasht', status: 'reading', started: day(-4), chapters_passed: 2, updated: day(-1) });
    const Checks = [];
    done.forEach(([b, d, , , , words]) => {
      Checks.push({ id: id(), date: day(d - 2), book_id: b, chapter: 1, score: 3, total: 4, passed: true, mins: 3, words });
      Checks.push({ id: id(), date: day(d), book_id: b, chapter: 'final', score: 7, total: 8, passed: true, mins: 2, words: 0 });
    });
    Checks.push({ id: id(), date: day(-3), book_id: 'kasht', chapter: 1, score: 4, total: 4, passed: true, mins: 2, words: 667 });
    Checks.push({ id: id(), date: day(-1), book_id: 'kasht', chapter: 2, score: 3, total: 4, passed: true, mins: 2, words: 712 });
    [[-6, 7], [-4, 9], [-2, 6], [-1, 5]].forEach(([d, sc]) => Checks.push({ id: id(), date: day(d), book_id: 'blitz', chapter: 'blitz', score: sc, total: sc + 2, passed: sc >= 5, mins: 1, words: 0 }));
    const w = (wid, base, st, s, misses, src) => ({ key: 'kasht:' + wid, book_id: 'kasht', word_id: wid, base, st, s, due: st === 'archived' ? day(25) : today(), misses, src, added: day(-3), last: day(-1) });
    const Words = [w('pomes', 'помесь', 'archived', 3, 0, 'tap'), w('dvor', 'дворняжка', 'learning', 1, 1, 'tap'), w('ozy', 'озябший', 'learning', 0, 0, 'tap'),
      w('stol', 'столяр', 'archived', 3, 0, 'book'), w('trakt', 'трактир', 'learning', 2, 0, 'book'), w('izvoz', 'извозчик', 'learning', 0, 2, 'book'),
      w('verst', 'верстак', 'learning', 1, 0, 'book'), w('kalosh', 'калоши', 'learning', 0, 0, 'tap'), w('otchay', 'отчаяние', 'learning', 0, 0, 'book')];
    const Ledger = [['chapter', 9], ['final', 6], ['blitz', 3], ['quest', 7], ['redeem', -15], ['chapter', 4]].map(([kind, mins], i) => ({ id: id(), date: day(-30 + i * 5), kind, mins, ref: '', note: '' }));
    const AILog = [
      { id: id(), date: day(-3) + 'T18:20', book_id: 'kasht', chapter: 1, question: 'Почему столяр не испугался музыки?', answer: 'Мимо шёл полк солдат, и столяр по-солдатски вытянулся и отдал честь — для него это было важно. А как ты думаешь, почему Каштанка этого не поняла?' },
      { id: id(), date: day(-1) + 'T19:05', book_id: 'kasht', chapter: 2, question: 'Что такое цилиндр?', answer: 'Это высокая жёсткая шляпа с ровными полями. Такие носили нарядно одетые господа. Незнакомец в цилиндре — человек непростой.' },
    ];
    // Device-side activity for quests and achievements.
    const stats = {};
    for (let d = -20; d <= -1; d++) if (d % 3 !== 0) stats[day(d)] = { pages: 6 + (d % 5), secs: 900, hours: d % 4 === 0 ? { 8: 3 } : { 19: 4, 20: 2 } };
    try { localStorage.setItem('polka_stats', JSON.stringify(stats)); localStorage.setItem('polka_secrets', JSON.stringify({ 'kasht:1': day(-3) })); } catch (e) { /* ignore */ }
    return { Settings: S, Progress, Checks, Words, Ledger, Requests: [], Pages: [], AILog };
  }

  function db() {
    let d = null;
    try { d = JSON.parse(localStorage.getItem(KEY)); } catch (e) { d = null; }
    if (!d) { d = seed(); put(d); }
    return d;
  }
  function put(d) { try { localStorage.setItem(KEY, JSON.stringify(d)); } catch (e) { /* storage full */ } }

  function state(d) {
    const s = Object.assign({}, d.Settings);
    delete s.pin_hash;
    s.pin_set = !!d.Settings.pin_hash;
    return { settings: s, progress: d.Progress, checks: d.Checks, words: d.Words, ledger: d.Ledger, requests: d.Requests, ai_count: d.AILog.length + 4, ai_log: d.AILog.slice(-30) };
  }
  function upsert(list, rows, key) {
    rows.forEach(r => {
      const i = list.findIndex(x => String(x[key]) === String(r[key]));
      if (i < 0) list.push(Object.assign({}, r)); else list[i] = Object.assign({}, list[i], r);
    });
  }
  const balance = d => d.Ledger.reduce((a, r) => a + (Number(r.mins) || 0), 0);
  const hash = pin => 'demo:' + pin;

  const ACTIONS = {
    bootstrap: d => state(d),
    save: (d, req) => {
      (req.ops || []).forEach(op => {
        if (!KEYS[op.t]) throw new Error('Not allowed: ' + op.t);
        upsert(d[op.t], op.rows || [], KEYS[op.t]);
      });
      Object.keys(req.settings || {}).forEach(k => {
        if (CHILD_SETTINGS.indexOf(k) < 0) throw new Error('Not allowed: ' + k);
        if (k === 'locked' && req.settings[k] !== true) throw new Error('Только родитель может открепить книгу');
        d.Settings[k] = req.settings[k];
      });
      return state(d);
    },
    pages: (d, req) => {
      (req.rows || []).forEach(r => d.Pages.push(Object.assign({ date: today() }, r)));
      d.Pages = d.Pages.slice(-400);
      return { wpm: d.Settings.wpm };
    },
    request: (d, req) => {
      const mins = Number(req.mins);
      if ([15, 60].indexOf(mins) < 0) throw new Error('Можно 15 минут или 1 час');
      if (d.Requests.some(r => r.status === 'pending')) throw new Error('Один запрос уже ждёт');
      if (balance(d) < mins) throw new Error('Не хватает минут');
      d.Requests.push({ id: id(), created: now(), mins, status: 'pending', decided: '' });
      return state(d);
    },
    parent: (d, req) => {
      const s = d.Settings;
      if (req.op === 'pinSet') {
        if (s.pin_hash && hash(req.pin) !== s.pin_hash) throw new Error('Неверный PIN');
        if (!/^\d{4,8}$/.test(String(req.newPin || ''))) throw new Error('PIN — от 4 до 8 цифр');
        s.pin_hash = hash(req.newPin);
        return state(d);
      }
      if (hash(req.pin) !== s.pin_hash) throw new Error('Неверный PIN');
      if (req.op === 'check') return { ok: true };
      if (req.op === 'decide') {
        const r = d.Requests.find(x => x.id === req.id);
        if (!r || r.status !== 'pending') throw new Error('Запрос не найден');
        r.status = req.approve ? 'approved' : 'declined';
        r.decided = now();
        if (req.approve) d.Ledger.push({ id: id(), date: today(), kind: 'redeem', mins: -r.mins, ref: r.id, note: '' });
        return state(d);
      }
      if (req.op === 'settings') {
        Object.keys(req.set || {}).forEach(k => {
          if (k === 'pin_hash' || !(k in DEFAULTS)) throw new Error('Unknown setting: ' + k);
          s[k] = req.set[k];
        });
        return state(d);
      }
      if (req.op === 'adjust') {
        d.Ledger.push({ id: id(), date: today(), kind: 'adjust', mins: Number(req.mins) || 0, ref: '', note: String(req.note || '') });
        return state(d);
      }
      throw new Error('Unknown parent action');
    },
    content: async (d, req) => {
      const res = await fetch(DRIVE + req.name, { cache: 'no-cache' });
      if (!res.ok) throw new Error('Not found in Drive: ' + req.name);
      return res.json();
    },
    assets: (d, req) => {
      const out = {};
      (req.names || []).forEach(n => { out[n] = DRIVE + 'img/' + n; });
      return out;
    },
    ask: (d, req) => {
      const s = d.Settings;
      if (!s.ai_enabled) throw new Error('AI_OFF');
      const used = s.ai_used_date === today() ? Number(s.ai_used) || 0 : 0;
      if (Number(s.ai_per_day) > 0 && used >= Number(s.ai_per_day)) throw new Error('AI_LIMIT');
      s.ai_used_date = today();
      s.ai_used = used + 1;
      const answer = 'Это демо-ответ: в настоящем приложении на вопрос «' + req.question + '» ответит ИИ. Он знает, докуда ты дочитал, и не рассказывает, что будет дальше. А ты сам как думаешь?';
      d.AILog.push({ id: id(), date: now(), book_id: req.book_id || '', chapter: req.chapter || '', question: req.question, answer });
      return { answer, left: Number(s.ai_per_day) > 0 ? Number(s.ai_per_day) - used - 1 : -1 };
    },
  };

  return {
    async call(action, payload) {
      const fn = ACTIONS[action];
      if (!fn) throw new Error('Unknown action: ' + action);
      const d = db();
      const out = await fn(d, payload || {});
      put(d);
      return JSON.parse(JSON.stringify(out));
    },
    reset() { localStorage.removeItem(KEY); },
  };
})();
