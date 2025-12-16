import { Bot, InlineKeyboard, InputFile } from 'grammy';
import ky from 'ky';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/* ================== CONFIG ================== */
const TELEGRAM_BOT_TOKEN = '8331003914:AAHMgfsbYu5v39qxpaLVwYrbzg9bp7rTjLo';
const GROQ_API_KEY = 'gsk_aWZMmWcWOT7NPBixSU8dWGdyb3';
const OPENROUTER_API_KEY = 'PASTE_NEW_OPENROUTER_API_KEY_HERE';
/* ============================================ */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const bot = new Bot(TELEGRAM_BOT_TOKEN);

// JSON вместо SQLite
const DB_FILE = 'bot_db.json';
const VOICE_DIR = path.join(__dirname, 'voice_messages');

if (!fs.existsSync(VOICE_DIR)) {
  fs.mkdirSync(VOICE_DIR, { recursive: true });
}

function initDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({
      users: {},
      stats: { total_messages: 0, total_voice: 0 },
      user_settings: {}
    }, null, 2));
  }
}

function readDB() {
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

initDB();

const userContexts = new Map();

const GROQ_MODEL = 'llama-3.3-70b-versatile';
const WHISPER_MODEL = 'whisper-large-v3-turbo';

function getOrCreateUser(id, username, firstName) {
  const db = readDB();
  if (!db.users[id]) {
    db.users[id] = { username, firstName, created_at: Date.now() };
    writeDB(db);
  }
}

function updateStats(type) {
  const db = readDB();
  if (type === 'message') db.stats.total_messages++;
  if (type === 'voice') db.stats.total_voice++;
  writeDB(db);
}

function getUserSettings(id) {
  const db = readDB();
  if (!db.user_settings[id]) {
    db.user_settings[id] = { voice_response: false };
    writeDB(db);
  }
  return db.user_settings[id];
}

function setUserSettings(id, settings) {
  const db = readDB();
  db.user_settings[id] = { ...getUserSettings(id), ...settings };
  writeDB(db);
}

function getMainMenu(id) {
  const s = getUserSettings(id);
  return new InlineKeyboard()
    .text('🆕 Новый диалог', 'new_chat')
    .text('📊 Статистика', 'stats').row()
    .text(s.voice_response ? '🔊 Голос' : '🔇 Голос', 'toggle_voice')
    .text('❓ Помощь', 'help').row()
    .text('ℹ️ О боте', 'about');
}

async function transcribeVoice(filePath) {
  const form = new FormData();
  const buffer = fs.readFileSync(filePath);
  form.append('file', new Blob([buffer]), 'audio.ogg');
  form.append('model', WHISPER_MODEL);
  form.append('language', 'ru');

  const res = await ky.post(
    'https://api.groq.com/openai/v1/audio/transcriptions',
    {
      headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
      body: form,
      timeout: 60000
    }
  ).json();

  return res.text;
}

async function askGroq(text, userId) {
  if (!userContexts.has(userId)) userContexts.set(userId, []);
  const ctx = userContexts.get(userId);

  ctx.push({ role: 'user', content: text });
  if (ctx.length > 20) ctx.splice(0, ctx.length - 20);

  const res = await ky.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      json: {
        model: GROQ_MODEL,
        messages: ctx,
        temperature: 0.7,
        max_tokens: 2048
      },
      timeout: 60000
    }
  ).json();

  const answer = res.choices[0].message.content;
  ctx.push({ role: 'assistant', content: answer });
  return answer;
}

bot.command('start', async (ctx) => {
  getOrCreateUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  await ctx.reply(
    '🤖 Привет! Я AI-бот.\n\nВыбирай действие 👇',
    { reply_markup: getMainMenu(ctx.from.id) }
  );
});

bot.on('callback_query:data', async (ctx) => {
  const id = ctx.from.id;
  const a = ctx.callbackQuery.data;

  if (a === 'new_chat') {
    userContexts.delete(id);
    await ctx.answerCallbackQuery({ text: 'История очищена' });
  }

  if (a === 'toggle_voice') {
    const s = getUserSettings(id);
    s.voice_response = !s.voice_response;
    setUserSettings(id, s);
    await ctx.answerCallbackQuery({
      text: s.voice_response ? 'Голос ВКЛ' : 'Голос ВЫКЛ'
    });
  }

  await ctx.editMessageReplyMarkup({ reply_markup: getMainMenu(id) });
});

bot.on('message:voice', async (ctx) => {
  updateStats('voice');
  const id = ctx.from.id;

  const file = await ctx.api.getFile(ctx.message.voice.file_id);
  const voicePath = path.join(VOICE_DIR, `${id}_${Date.now()}.ogg`);

  const url =
    `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`;

  fs.writeFileSync(voicePath, Buffer.from(await ky.get(url).arrayBuffer()));

  const text = await transcribeVoice(voicePath);
  fs.unlinkSync(voicePath);

  const answer = await askGroq(text, id);
  await ctx.reply(answer);
});

bot.on('message:text', async (ctx) => {
  if (ctx.message.text.startsWith('/')) return;
  updateStats('message');

  const answer = await askGroq(ctx.message.text, ctx.from.id);
  await ctx.reply(answer);
});

bot.start();
console.log('🤖 BOT STARTED');
