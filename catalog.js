'use strict';
/* Game rules that live in the code: reader titles, the bingo pool, achievements and quests.
 * The books themselves (catalogue, texts, pictures, case questions, secret words) are NOT here:
 * they live in the Google Drive folder "Bookshelf content" and are loaded through the back end. */

function has(list, x) { return (list || []).indexOf(x) > -1; }

// Reader titles: words read in passed chapters over the last 90 days. One book is about 6 000 words.
let RANKS = [
  { name: 'Новичок', min: 0, bg: '#E9EDF3', ink: '#121826' },
  { name: 'Читатель', min: 10000, bg: '#DCE6FF', ink: '#2D5BE3' },
  { name: 'Книгочей', min: 30000, bg: '#2D5BE3', ink: '#FFFFFF' },
  { name: 'Библиофил', min: 60000, bg: '#1E9E62', ink: '#FFFFFF' },
  { name: 'Книжный червь', min: 100000, bg: '#F0A42C', ink: '#121826' },
  { name: 'Мудрец', min: 150000, bg: '#7A3B5C', ink: '#FFFFFF' },
  { name: 'Легенда', min: 220000, bg: '#121826', ink: '#F0A42C' },
];

/* Bingo. Each finished book stamps one free matching square on the current card.
   A line pays +10 min, a full card +30 min, and then he starts the next card when he wants.
   Card 1 is fixed; later cards draw 16 squares from the pool, only ones some unread book can fill.
   ctx: above (book above his level), above2 (2 years above), newAuthor, sameAuthor, fast (read within a week). */
let BINGO_COLS = 4, BINGO_ROWS = 4; // her card is smaller (useEnglishRules)
let BINGO_POOL = {
  'Рассказ': b => b.genre === 'Рассказ',
  'Повесть': b => b.genre === 'Повесть',
  'Роман': b => b.genre === 'Роман',
  'Сказка': b => b.genre === 'Сказка',
  'Стихи': b => has(b.flags, 'poetry'),
  'Про животных': b => has(b.themes, 'Про животных'),
  'Фантастика': b => has(b.themes, 'Фантастика'),
  'Приключения': b => has(b.themes, 'Приключения'),
  'Волшебство': b => has(b.themes, 'Волшебство'),
  'Про дружбу': b => has(b.themes, 'Дружба'),
  'Про историю': b => has(b.themes, 'История'),
  'Про природу': b => has(b.themes, 'Про природу'),
  'Про войну': b => has(b.themes, 'Война'),
  'Про школу': b => has(b.themes, 'Школа'),
  'Детектив': b => has(b.flags, 'detective'),
  'Смешная книга': b => has(b.themes, 'Юмор'),
  'Про море': b => has(b.themes, 'Море'),
  'Нон-фикшн': b => b.genre === 'Нон-фикшн',
  'Герой — ребёнок': b => has(b.flags, 'kid'),
  'XIX век': b => b.year < 1900,
  'Начало XX века': b => b.year >= 1900 && b.year < 1922,
  'Советская классика': b => b.year >= 1922 && b.year < 1991,
  'Новая книга (после 1991)': b => b.year >= 1991,
  'Старше 150 лет': b => b.year <= new Date().getFullYear() - 150,
  'Короче 3 000 слов': b => b.words < 3000,
  'Больше 20 000 слов': b => b.words > 20000,
  'Больше 50 000 слов': b => b.words > 50000,
  'Есть экранизация': b => has(b.flags, 'film'),
  'Автор жив': b => has(b.flags, 'alive'),
  'Писательница': b => has(b.flags, 'woman'),
  'Выше твоего уровня': (b, c) => c.above,
  'На 2 года выше уровня': (b, c) => c.above2,
  'Новый для тебя автор': (b, c) => c.newAuthor,
  'Ещё одна книга того же автора': (b, c) => c.sameAuthor,
  'Прочитана за неделю': (b, c) => c.fast,
};
let BINGO_FIRST = ['Рассказ', 'Повесть', 'Роман', 'Сказка', 'Про животных', 'Фантастика', 'Приключения', 'Детектив',
  'XIX век', 'Советская классика', 'Про историю', 'Стихи', 'Выше твоего уровня', 'Больше 20 000 слов', 'Есть экранизация', 'Новый для тебя автор'];

/* Achievements: three steps each. value(ctx) gives the current count. */
let ACHIEVEMENTS = [
  ['🕵️', 'Сыщик', c => c.count(b => has(b.flags, 'detective')), [1, 3, 5], ['детектив', 'детектива', 'детективов']],
  ['🧚', 'Сказочник', c => c.count(b => b.genre === 'Сказка'), [1, 3, 5], ['сказка', 'сказки', 'сказок']],
  ['🐾', 'Натуралист', c => c.count(b => has(b.themes, 'Про животных') || has(b.themes, 'Про природу')), [1, 3, 5], ['книга про животных', 'книги про животных', 'книг про животных']],
  ['🚀', 'Фантаст', c => c.count(b => has(b.themes, 'Фантастика')), [1, 3, 5], ['фантастика', 'фантастики', 'фантастики']],
  ['🧭', 'Путешественник', c => c.count(b => has(b.themes, 'Приключения')), [1, 3, 5], ['приключение', 'приключения', 'приключений']],
  ['🏛️', 'Историк', c => c.count(b => has(b.themes, 'История') || has(b.themes, 'Война')), [1, 3, 5], ['книга об истории', 'книги об истории', 'книг об истории']],
  ['🪶', 'Поэт', c => c.count(b => has(b.flags, 'poetry')), [1, 3, 5], ['книга в стихах', 'книги в стихах', 'книг в стихах']],
  ['🎩', 'XIX век', c => c.count(b => b.year < 1900), [1, 5, 10], ['книга', 'книги', 'книг']],
  ['🐘', 'Великан', c => c.longest, [10000, 25000, 50000], ['слово в самой длинной книге', 'слова в самой длинной книге', 'слов в самой длинной книге']],
  ['📚', 'Марафон', c => c.month, [3, 5, 8], ['книга за месяц', 'книги за месяц', 'книг за месяц']],
  ['⛰️', 'Покоритель', c => c.above, [1, 3, 5], ['книга выше уровня', 'книги выше уровня', 'книг выше уровня']],
  ['✍️', 'Знаток авторов', c => c.authors, [3, 6, 10], ['автор', 'автора', 'авторов']],
  ['🎯', 'Отличник', c => c.perfect, [5, 20, 50], ['проверка без ошибок', 'проверки без ошибок', 'проверок без ошибок']],
  ['🔤', 'Словарь', c => c.learned, [25, 100, 300], ['слово выучено', 'слова выучено', 'слов выучено']],
  ['⚡', 'Блиц-ас', c => c.blitz, [10, 15, 20], ['верный ответ в раунде', 'верных ответа в раунде', 'верных ответов в раунде']],
  ['🔎', 'Охотник за словами', c => c.secrets, [1, 5, 10], ['тайное слово', 'тайных слова', 'тайных слов']],
  ['💬', 'Почемучка', c => c.questions, [10, 50, 150], ['вопрос', 'вопроса', 'вопросов']],
  ['🖋️', 'Критик', c => c.reviews, [1, 5, 15], ['отзыв', 'отзыва', 'отзывов']],
  ['📅', 'Верный читатель', c => c.days, [10, 50, 150], ['день чтения', 'дня чтения', 'дней чтения']],
  ['🌅', 'Ранняя пташка', c => c.mornings, [3, 10, 30], ['утро с книгой', 'утра с книгой', 'утр с книгой']],
  ['🦉', 'Сова', c => c.evenings, [3, 10, 30], ['вечер с книгой', 'вечера с книгой', 'вечеров с книгой']],
  ['🎲', 'Бинго', c => c.lines, [1, 4, 8], ['линия', 'линии', 'линий']],
  ['🗂️', 'Коллекционер', c => c.cards, [1, 2, 3], ['карточка', 'карточки', 'карточек']],
];

/* Quests. Three daily quests rotate each day (picked from this pool by date), two weekly ones each week.
   p(ctx) = progress, n = goal, r = reward minutes. when(ctx) hides a quest that makes no sense today. */
let DAILY_QUESTS = [
  { id: 'ch', icon: '📖', text: 'Пройди проверку главы', n: 1, r: 1, p: c => c.day.checks },
  { id: 'pg', icon: '📄', text: 'Прочитай 10 страниц', n: 10, r: 1, p: c => c.day.pages },
  { id: 'min', icon: '⏳', text: 'Почитай 15 минут', n: 15, r: 1, p: c => Math.floor(c.day.secs / 60) },
  { id: 'bz', icon: '⚡', text: 'Блиц: 15 верных за раунд', n: 15, r: 1, p: c => c.day.bzBest },
  { id: 'old', icon: '🔁', text: 'Блиц: ответь правильно на 5 слов, которые учишь давно', n: 5, r: 1, p: c => c.day.bzOld },
  { id: 'ask', icon: '💬', text: 'Задай вопрос о книге', n: 1, r: 1, p: c => c.day.asks, when: c => c.ai },
  { id: 'heart', icon: '♡', text: 'Загляни в библиотеку и отметь книгу, которую хочешь прочитать', n: 1, r: 1, p: c => c.day.hearts },
  { id: 'morning', icon: '🌅', text: 'Почитай до 9 утра', n: 1, r: 1, p: c => c.day.morning },
];
let WEEKLY_QUESTS = [
  { id: 'days', icon: '📅', text: 'Читай 5 дней из 7', n: 5, r: 5, p: c => c.week.days },
  { id: 'chw', icon: '📚', text: 'Пройди 3 главы за неделю', n: 3, r: 4, p: c => c.week.checks },
  { id: 'bzw', icon: '⚡', text: 'Сыграй в Блиц 4 дня из 7', n: 4, r: 4, p: c => c.week.bzDays },
  { id: 'words', icon: '🔤', text: '30 верных ответов в Блице за неделю', n: 30, r: 4, p: c => c.week.bzRight },
  { id: 'review', icon: '🖋️', text: 'Напиши отзыв о прочитанной книге', n: 1, r: 3, p: c => c.week.reviews, when: c => c.unreviewed },
];

/* The English profile (an adult reading short English stories) plays by the same rules with its own
   titles, bingo squares, achievements and quests, in English. Stories are about 1 000 words, so the
   reader titles count a story where his count a book. useEnglishRules() swaps the tables in. */
const RANKS_EN = [
  { name: 'Newcomer', min: 0, bg: '#E9EDF3', ink: '#121826' },
  { name: 'Reader', min: 3000, bg: '#DCE6FF', ink: '#2D5BE3' },
  { name: 'Story lover', min: 8000, bg: '#2D5BE3', ink: '#FFFFFF' },
  { name: 'Book club star', min: 15000, bg: '#1E9E62', ink: '#FFFFFF' },
  { name: 'Bookworm', min: 25000, bg: '#F0A42C', ink: '#121826' },
  { name: 'Literary lady', min: 40000, bg: '#7A3B5C', ink: '#FFFFFF' },
  { name: 'Legend', min: 60000, bg: '#121826', ink: '#F0A42C' },
];
const BINGO_POOL_EN = {
  'Love story': b => has(b.themes, 'Love'),
  'Later in life': b => has(b.themes, 'Later life'),
  'Gossip': b => has(b.themes, 'Gossip'),
  'By the sea': b => has(b.themes, 'Sea'),
  'Letters': b => has(b.themes, 'Letters'),
  'A wedding': b => has(b.themes, 'Wedding'),
  'Music': b => has(b.themes, 'Music'),
  'Food and baking': b => has(b.themes, 'Food'),
  'A secret': b => has(b.themes, 'Secret'),
  'Friendship': b => has(b.themes, 'Friendship'),
  'Easier (A2)': b => b.level === 'A2',
  'Medium (A2+)': b => b.level === 'A2+',
  'Harder (B1)': b => b.level === 'B1',
  'B1+ or harder': b => ['B1+', 'B2', 'C1'].indexOf(b.level) > -1,
  'Adapted classic': b => has(b.flags, 'classic'),
  'Happy ending': b => has(b.flags, 'happy'),
  'Over 1,000 words': b => b.words > 1000,
  'Over 5,000 words': b => b.words > 5000,
  'Read within a week': (b, c) => c.fast,
  'New author for you': (b, c) => c.newAuthor,
  'Same author again': (b, c) => c.sameAuthor,
};
// 3 x 2: a theme, some gossip, a secret; then a setting, a step up, and a pace square.
const BINGO_FIRST_EN = ['Love story', 'Gossip', 'A secret', 'By the sea', 'Harder (B1)', 'Read within a week'];
const ACHIEVEMENTS_EN = [
  ['💌', 'Romantic', c => c.count(b => has(b.themes, 'Love')), [1, 5, 10], ['love story', 'love stories']],
  ['☕', 'Gossip queen', c => c.count(b => has(b.themes, 'Gossip')), [1, 3, 5], ['gossip story', 'gossip stories']],
  ['🕰️', 'Golden years', c => c.count(b => has(b.themes, 'Later life')), [1, 5, 10], ['story about later life', 'stories about later life']],
  ['🌊', 'Seaside', c => c.count(b => has(b.themes, 'Sea')), [1, 3, 5], ['story by the sea', 'stories by the sea']],
  ['💍', 'Wedding bells', c => c.count(b => has(b.themes, 'Wedding')), [1, 3, 5], ['wedding story', 'wedding stories']],
  ['✉️', 'Letter writer', c => c.count(b => has(b.themes, 'Letters')), [1, 3, 5], ['story with letters', 'stories with letters']],
  ['📜', 'Classic', c => c.count(b => has(b.flags, 'classic')), [1, 3, 5], ['adapted classic', 'adapted classics']],
  ['🐘', 'Long read', c => c.longest, [1000, 3000, 10000], ['word in the longest story', 'words in the longest story']],
  ['📚', 'Marathon', c => c.month, [3, 5, 8], ['story in a month', 'stories in a month']],
  ['⛰️', 'Climber', c => c.count(b => ['B1', 'B1+', 'B2', 'C1'].indexOf(b.level) > -1), [1, 3, 5], ['B1 story', 'B1 stories']],
  ['✍️', 'Author fan', c => c.authors, [3, 6, 10], ['author', 'authors']],
  ['🎯', 'Top marks', c => c.perfect, [5, 20, 50], ['check with no mistakes', 'checks with no mistakes']],
  ['🔤', 'Vocabulary', c => c.learned, [25, 100, 300], ['word learned', 'words learned']],
  ['⚡', 'Blitz ace', c => c.blitz, [10, 15, 20], ['right answer in a round', 'right answers in a round']],
  ['🖋️', 'Critic', c => c.reviews, [1, 5, 15], ['review', 'reviews']],
  ['📅', 'Faithful reader', c => c.days, [10, 50, 150], ['reading day', 'reading days']],
  ['🌅', 'Early bird', c => c.mornings, [3, 10, 30], ['morning with a story', 'mornings with a story']],
  ['🦉', 'Night owl', c => c.evenings, [3, 10, 30], ['evening with a story', 'evenings with a story']],
  ['🎲', 'Bingo', c => c.lines, [1, 4, 8], ['line', 'lines']],
  ['🗂️', 'Collector', c => c.cards, [1, 2, 3], ['card', 'cards']],
  ['💬', 'Chatterbox', c => c.questions, [10, 50, 150], ['message to the AI', 'messages to the AI']],
];
const DAILY_QUESTS_EN = [
  { id: 'ch', icon: '📖', text: 'Pass the questions on a story', n: 1, r: 1, p: c => c.day.checks },
  { id: 'pg', icon: '📄', text: 'Read 10 pages', n: 10, r: 1, p: c => c.day.pages },
  { id: 'min', icon: '⏳', text: 'Read for 15 minutes', n: 15, r: 1, p: c => Math.floor(c.day.secs / 60) },
  { id: 'bz', icon: '⚡', text: 'Blitz: 15 right answers in one round', n: 15, r: 1, p: c => c.day.bzBest },
  { id: 'old', icon: '🔁', text: 'Blitz: get 5 words right that you have been learning for a while', n: 5, r: 1, p: c => c.day.bzOld },
  { id: 'heart', icon: '♡', text: 'Visit the library and mark a story you want to read', n: 1, r: 1, p: c => c.day.hearts },
  { id: 'morning', icon: '🌅', text: 'Read before 9 in the morning', n: 1, r: 1, p: c => c.day.morning },
  { id: 'ask', icon: '💬', text: 'Talk to the AI about a story, in English', n: 1, r: 1, p: c => c.day.asks, when: c => c.ai },
];
const WEEKLY_QUESTS_EN = [
  { id: 'days', icon: '📅', text: 'Read on 5 days out of 7', n: 5, r: 5, p: c => c.week.days },
  { id: 'chw', icon: '📚', text: 'Finish 2 stories this week', n: 2, r: 4, p: c => c.week.checks },
  { id: 'bzw', icon: '⚡', text: 'Play Blitz on 4 days out of 7', n: 4, r: 4, p: c => c.week.bzDays },
  { id: 'words', icon: '🔤', text: '30 right answers in Blitz this week', n: 30, r: 4, p: c => c.week.bzRight },
  { id: 'review', icon: '🖋️', text: 'Write a review of a story you have read', n: 1, r: 3, p: c => c.week.reviews, when: c => c.unreviewed },
];
function useEnglishRules() {
  if (RANKS === RANKS_EN) return;
  RANKS = RANKS_EN; BINGO_POOL = BINGO_POOL_EN; BINGO_FIRST = BINGO_FIRST_EN; ACHIEVEMENTS = ACHIEVEMENTS_EN;
  BINGO_COLS = 3; BINGO_ROWS = 2;
  DAILY_QUESTS = DAILY_QUESTS_EN; WEEKLY_QUESTS = WEEKLY_QUESTS_EN;
}
