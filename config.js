require('dotenv').config();

module.exports = {
  // Токен бота из Discord Developer Portal
  token: process.env.DISCORD_TOKEN,

  // Префикс текстовых команд
  prefix: '!',

  // Запрещённые слова (в нижнем регистре)
  banWords: ['вась'],

  // Режим сравнения:
  //  'exact'  — слово совпадает целиком («вась» ловит только «вась»)
  //  'prefix' — слово начинается с запрещённого корня («вась» ловит «васька», «ваську» и т.п.)
  matchMode: 'prefix',

  // Движок распознавания:
  //  'groq'  — облачный Groq API (нужен GROQ_API_KEY, локально ничего не считается)
  //  'local' — локальный Whisper через Python-воркер (нужен Python + requirements.txt)
  // По умолчанию: groq, если задан ключ, иначе local
  sttEngine: process.env.STT_ENGINE || (process.env.GROQ_API_KEY ? 'groq' : 'local'),

  // Настройки Groq (бесплатный тариф: console.groq.com -> API Keys)
  groqApiKey: process.env.GROQ_API_KEY,
  groqModel: process.env.GROQ_MODEL || 'whisper-large-v3-turbo',

  // Команда запуска Python (для движка 'local':
  // распознавание работает в дочернем Python-процессе,
  // туда нужно установить зависимости: pip install -r requirements.txt)
  pythonPath: process.env.PYTHON_PATH || 'python',

  // Настройки локального Whisper (для движка 'local')
  whisperModel: process.env.WHISPER_MODEL || 'small', // tiny/base/small/medium
  whisperLanguage: 'ru',
  whisperDevice: process.env.WHISPER_DEVICE || 'cpu', // 'cuda', если есть GPU

  // Пауза в речи (мс), после которой фраза считается законченной
  silenceDurationMs: 800,

  // Минимальный интервал между наказаниями одного пользователя (мс),
  // чтобы одна фраза не засчитывалась несколько раз
  cooldownMs: 5000,

  // Диагностика: сохранять opus-пакеты каждой фразы в файл debug-*.opuspkt
  debugDump: true,

  // Эскалация наказаний: 1-е нарушение — первый пункт, 2-е — второй и т.д.
  // Типы: 'warn' (сообщение), 'timeout' (тайм-аут), 'mute' (выкл. микрофон),
  // 'disconnect' (выгнать из голосового канала), 'kick' (кик с сервера)
  punishments: [
    { type: 'warn' },
    { type: 'timeout', durationMs: 60_000 },
    { type: 'timeout', durationMs: 600_000 },
    { type: 'kick' },
  ],
};
