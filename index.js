require('dotenv').config();
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { Client, GatewayIntentBits } = require('discord.js');
const {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
  EndBehaviorType,
} = require('@discordjs/voice');
const prism = require('prism-media');
const config = require('./config');

// ---------------------------------------------------------------------------
// Проверка окружения
// ---------------------------------------------------------------------------
if (!config.token) {
  console.error('Не задан DISCORD_TOKEN. Скопируйте .env.example в .env и вставьте токен бота.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// STT-воркер: долгоживущий Python-процесс с загруженной моделью Whisper.
// Протокол описан в stt_worker.py.
// ---------------------------------------------------------------------------
class SttWorker extends EventEmitter {
  constructor(pythonCmd) {
    super();
    this.buffer = Buffer.alloc(0);
    this.nextSessionId = 1;
    this.proc = spawn(
      pythonCmd,
      [
        path.join(__dirname, 'stt_worker.py'),
        '--model', config.whisperModel,
        '--language', config.whisperLanguage,
        '--device', config.whisperDevice,
      ],
      { stdio: ['pipe', 'pipe', 'inherit'] }
    );
    this.proc.stdout.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
    this.proc.on('exit', (code) => this.emit('exit', code));
    this.proc.on('error', (err) => this.emit('error', err));
  }

  drain() {
    for (;;) {
      if (this.buffer.length < 9) return;
      const type = this.buffer.readUInt8(0);
      const sessionId = this.buffer.readUInt32LE(1);
      const len = this.buffer.readUInt32LE(5);
      if (this.buffer.length < 9 + len) return;
      const text = this.buffer.toString('utf8', 9, 9 + len);
      this.buffer = this.buffer.subarray(9 + len);
      if (type === 255) this.emit('ready');
      else this.emit('text', { kind: type === 1 ? 'partial' : 'text', sessionId, text });
    }
  }

  send(type, sessionId, payload = Buffer.alloc(0)) {
    const header = Buffer.alloc(9);
    header.writeUInt8(type, 0);
    header.writeUInt32LE(sessionId, 1);
    header.writeUInt32LE(payload.length, 5);
    this.proc.stdin.write(Buffer.concat([header, payload]));
  }

  openSession() {
    return this.nextSessionId++;
  }

  chunk(sessionId, pcm) {
    this.send(0, sessionId, pcm);
  }

  finish(sessionId) {
    this.send(1, sessionId);
  }

  reset(sessionId) {
    this.send(2, sessionId);
  }
}

// ---------------------------------------------------------------------------
// Groq STT: распознавание через облачный API (бесплатный тариф, без карты).
// PCM каждой фразы оборачивается в WAV и отправляется одним запросом.
// ---------------------------------------------------------------------------
function makeWav(pcm, rate = 16000, channels = 1) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // размер fmt-блока
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels * 2, 28); // байт/сек
  header.writeUInt16LE(channels * 2, 32); // байт на сэмпл-кадр
  header.writeUInt16LE(16, 34); // бит на сэмпл
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

class GroqStt extends EventEmitter {
  constructor(apiKey, model) {
    super();
    this.apiKey = apiKey;
    this.model = model;
    this.buffers = new Map();
    this.nextSessionId = 1;
    queueMicrotask(() => this.emit('ready'));
  }

  openSession() {
    const id = this.nextSessionId++;
    this.buffers.set(id, []);
    return id;
  }

  chunk(sessionId, pcm) {
    const buf = this.buffers.get(sessionId);
    if (buf) buf.push(pcm);
  }

  reset(sessionId) {
    this.buffers.delete(sessionId);
  }

  finish(sessionId) {
    const parts = this.buffers.get(sessionId);
    this.buffers.delete(sessionId);
    if (!parts || parts.length === 0) return;
    const pcm = Buffer.concat(parts);
    if (pcm.length < 16000 * 2 * 0.3) return; // короче 0.3 с — шум
    this.transcribe(pcm)
      .then((text) => {
        if (text) this.emit('text', { kind: 'text', sessionId, text });
      })
      .catch((err) => console.log(`[stt] ошибка Groq: ${err.message}`));
  }

  async transcribe(pcm) {
    const wav = makeWav(pcm);
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
    form.append('model', this.model);
    form.append('language', 'ru');
    form.append('response_format', 'json');
    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    });
    if (res.status === 429) throw new Error('исчерпан лимит бесплатного тарифа (HTTP 429)');
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    return (data.text || '').trim();
  }
}

// ---------------------------------------------------------------------------
// Выбор движка распознавания
// ---------------------------------------------------------------------------
let stt;
if (config.sttEngine === 'groq') {
  if (!config.groqApiKey) {
    console.error('Движок «groq» требует GROQ_API_KEY в .env (console.groq.com -> API Keys),');
    console.error('либо переключитесь на локальный движок: STT_ENGINE=local');
    process.exit(1);
  }
  stt = new GroqStt(config.groqApiKey, config.groqModel);
  stt.on('ready', () => console.log(`STT: облачный Groq, модель «${config.groqModel}».`));
} else {
  stt = new SttWorker(config.pythonPath);
  stt.on('ready', () => console.log(`STT: локальный Whisper «${config.whisperModel}» загружен.`));
  stt.on('exit', (code) => {
    console.error(`STT-воркер завершился с кодом ${code}. Проверьте PYTHON_PATH и 'pip install -r requirements.txt'.`);
  });
  stt.on('error', (err) => {
    console.error(`Не удалось запустить Python (${config.pythonPath}): ${err.message}`);
  });
}

// ---------------------------------------------------------------------------
// Клиент Discord
// ---------------------------------------------------------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent, // нужно включить в Developer Portal!
  ],
});

/** Счётчики нарушений: guildId -> Map<userId, number> */
const warnings = new Map();
/** Кулдаун наказаний: "guildId:userId" -> timestamp */
const cooldowns = new Map();
/** Активное прослушивание: guildId -> { connection, textChannelId } */
const monitored = new Map();
/** Сессия распознавания -> контекст нарушителя */
const sessions = new Map();

function getGuildWarnings(guildId) {
  if (!warnings.has(guildId)) warnings.set(guildId, new Map());
  return warnings.get(guildId);
}

// ---------------------------------------------------------------------------
// Поиск запрещённых слов
// ---------------------------------------------------------------------------
function findBanWord(text) {
  const tokens = String(text)
    .toLowerCase()
    .split(/[^а-яёa-z0-9]+/i)
    .filter(Boolean);
  for (const token of tokens) {
    for (const word of config.banWords) {
      const hit = config.matchMode === 'exact' ? token === word : token.startsWith(word);
      if (hit) return word;
    }
  }
  return null;
}

// Тексты от воркера -> проверка и наказание
stt.on('text', ({ kind, sessionId, text }) => {
  console.log(`[stt] сессия #${sessionId}: «${text}»`);
  const ctx = sessions.get(sessionId);
  if (!ctx || ctx.punished) return;
  if (findBanWord(text)) {
    ctx.punished = true;
    onViolation(ctx.guild, ctx.userId, text);
  }
});

// ---------------------------------------------------------------------------
// Обработка аудиопотока одного высказывания
// ---------------------------------------------------------------------------
function handleUserAudio(guild, userId, opusStream) {
  // Discord отдаёт Opus 48 кГц стерео -> декодируем в PCM
  const decoder = new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 });
  // Whisper ждёт PCM 16 кГц моно s16le -> ресемплируем через ffmpeg.
  // NB: prism сам дописывает выход 'pipe:1', поэтому его здесь нет
  const pcm16k = new prism.FFmpeg({
    args: [
      '-hide_banner', '-loglevel', 'error',
      '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0',
      '-f', 's16le', '-ar', '16000', '-ac', '1',
    ],
  });

  const sessionId = stt.openSession();
  sessions.set(sessionId, { guild, userId, punished: false });

  let opusBytes = 0;
  let decBytes = 0;
  let pcmBytes = 0;
  const dbgPackets = []; // дамп пакетов для диагностики
  opusStream.on('data', (c) => { opusBytes += c.length; dbgPackets.push(c); });
  decoder.on('data', (c) => { decBytes += c.length; });

  const cleanup = () => {
    sessions.delete(sessionId);
    stt.reset(sessionId);
  };

  pcm16k.on('data', (chunk) => { pcmBytes += chunk.length; stt.chunk(sessionId, chunk); });
  pcm16k.on('end', () => {
    console.log(`[audio] конец фразы ${userId}: opus=${opusBytes}Б, dec=${decBytes}Б, pcm=${pcmBytes}Б`);
    if (config.debugDump && dbgPackets.length) {
      const fs = require('fs');
      const parts = dbgPackets.map((p) => {
        const len = Buffer.alloc(4);
        len.writeUInt32LE(p.length, 0);
        return Buffer.concat([len, p]);
      });
      const file = `debug-${sessionId}.opuspkt`;
      fs.writeFileSync(file, Buffer.concat(parts));
      console.log(`[audio] дамп пакетов сохранён: ${file}`);
    }
    stt.finish(sessionId);
  });
  pcm16k.on('error', (e) => { console.log(`[audio] ошибка ffmpeg: ${e.message}`); cleanup(); });
  decoder.on('error', (e) => { console.log(`[audio] ошибка декодера: ${e.message}`); cleanup(); });
  opusStream.on('error', cleanup);

  opusStream.pipe(decoder).pipe(pcm16k);
}

// ---------------------------------------------------------------------------
// Наказание
// ---------------------------------------------------------------------------
async function onViolation(guild, userId, text) {
  const key = `${guild.id}:${userId}`;
  const now = Date.now();
  if (now - (cooldowns.get(key) || 0) < config.cooldownMs) return;
  cooldowns.set(key, now);

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member || member.user.bot) return;

  const map = getGuildWarnings(guild.id);
  const count = (map.get(userId) || 0) + 1;
  map.set(userId, count);

  const action = config.punishments[Math.min(count, config.punishments.length) - 1];
  const info = monitored.get(guild.id);
  const textChannel = info
    ? await guild.channels.fetch(info.textChannelId).catch(() => null)
    : null;

  const reason = 'Запрещённое слово в голосовом канале';
  let actionText = 'предупреждение';
  try {
    switch (action.type) {
      case 'timeout':
        await member.timeout(action.durationMs, reason);
        actionText = `тайм-аут на ${Math.round(action.durationMs / 1000)} сек`;
        break;
      case 'mute':
        if (!member.voice.channel) throw new Error('пользователь не в голосовом канале');
        await member.voice.setMute(true, reason);
        actionText = 'микрофон выключен';
        break;
      case 'disconnect':
        if (!member.voice.channel) throw new Error('пользователь не в голосовом канале');
        await member.voice.disconnect(reason);
        actionText = 'исключён из голосового канала';
        break;
      case 'kick':
        await member.kick(reason);
        actionText = 'кик с сервера';
        break;
      case 'warn':
      default:
        break;
    }
  } catch (err) {
    map.set(userId, count - 1); // откатываем счётчик, наказание не применилось
    if (textChannel) {
      textChannel.send(`⚠️ Не удалось наказать ${member}: ${err.message}. Проверьте права бота и его роль в иерархии.`);
    }
    return;
  }

  console.log(`[${guild.name}] ${member.user.tag}: нарушение #${count} — «${text}» -> ${actionText}`);
  if (textChannel) {
    textChannel.send(`⛔ ${member} произнёс запрещённое слово (нарушение №${count}): «_${text}_» → **${actionText}**.`);
  }
}

// ---------------------------------------------------------------------------
// Прослушивание голосового канала
// ---------------------------------------------------------------------------
function startListening(connection, guild, textChannelId) {
  const active = new Set(); // userId, чей поток уже обрабатывается

  connection.receiver.speaking.on('start', (userId) => {
    if (active.has(userId)) return;
    active.add(userId);
    console.log(`[audio] ${userId} начал говорить`);

    let stream;
    try {
      stream = connection.receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: config.silenceDurationMs },
      });
    } catch {
      active.delete(userId);
      return;
    }
    const release = () => active.delete(userId);
    stream.once('end', release);
    stream.once('close', release);
    stream.once('error', release);

    handleUserAudio(guild, userId, stream);
  });

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5000),
      ]);
    } catch {
      connection.destroy();
      monitored.delete(guild.id);
    }
  });
}

// Голосовое соединение к Discord у некоторых сетей устанавливается не с первой
// попытки (срывы connecting -> signalling). Даём несколько шансов.
async function waitReady(connection, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
      return;
    } catch (err) {
      if (i === attempts - 1) throw err;
      console.log(`[voice] попытка ${i + 1} не удалась (${err.message}), повторяю...`);
    }
  }
}

// ---------------------------------------------------------------------------
// Команды
// ---------------------------------------------------------------------------
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;
  if (!message.content.startsWith(config.prefix)) return;

  const [rawCmd] = message.content.slice(config.prefix.length).trim().split(/\s+/);
  const cmd = (rawCmd || '').toLowerCase();

  if (cmd === 'слушать' || cmd === 'join') {
    const channel = message.member?.voice?.channel;
    if (!channel) {
      await message.reply('Сначала зайдите в голосовой канал — я приду за вами.');
      return;
    }
    try {
      const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: message.guild.id,
        adapterCreator: message.guild.voiceAdapterCreator,
        selfDeaf: false, // глухой бот не слышит участников!
        selfMute: true,
      });
      connection.on('stateChange', (oldS, newS) => {
        console.log(`[voice] ${oldS.status} -> ${newS.status}`);
      });
      await message.reply('Подключаюсь к голосовому каналу — сеть может «подтормаживать», это займёт до минуты…');
      await waitReady(connection);
      startListening(connection, message.guild, message.channel.id);
      monitored.set(message.guild.id, { connection, textChannelId: message.channel.id });
      await message.reply(
        `🎙️ Слушаю канал «${channel.name}». Запрещённые слова: ${config.banWords.map((w) => `«${w}»`).join(', ')}.`
      );
    } catch (err) {
      await message.reply(`Не смог подключиться: ${err.message}`);
    }
  }

  if (cmd === 'стоп' || cmd === 'leave') {
    const info = monitored.get(message.guild.id);
    if (!info) {
      await message.reply('Я и так никого не слушаю.');
      return;
    }
    info.connection.destroy();
    monitored.delete(message.guild.id);
    await message.reply('Выключаюсь. Всем спасибо, все свободны.');
  }

  if (cmd === 'нарушения') {
    const map = getGuildWarnings(message.guild.id);
    if (map.size === 0) {
      await message.reply('Нарушений пока нет. Подозрительно тихо…');
      return;
    }
    const lines = [];
    for (const [userId, count] of map) {
      const member = await message.guild.members.fetch(userId).catch(() => null);
      lines.push(`• ${member ? member.displayName : userId} — ${count}`);
    }
    await message.reply(`📋 Счётчик нарушений:\n${lines.join('\n')}`);
  }

  if (cmd === 'сброс') {
    const target = message.mentions.members.first();
    const map = getGuildWarnings(message.guild.id);
    if (target) {
      map.delete(target.id);
      await message.reply(`Счётчик нарушений ${target} обнулён.`);
    } else {
      map.clear();
      await message.reply('Счётчики всех нарушителей обнулены.');
    }
  }

  if (cmd === 'слова') {
    await message.reply(
      `Запрещённые слова: ${config.banWords.map((w) => `«${w}»`).join(', ')} (режим: ${config.matchMode}).`
    );
  }
});

client.once('clientReady', () => {
  console.log(`Бот запущен как ${client.user.tag}`);
});

// Health-check для хостингов (Koyeb и др.): если задан PORT,
// отвечаем "ok", чтобы платформа считала сервис живым.
if (process.env.PORT) {
  require('http')
    .createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    })
    .listen(process.env.PORT, () => console.log(`Health-check на порту ${process.env.PORT}`));
}

client.login(config.token);
