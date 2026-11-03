// Воспроизведение дампа пакетов из бота: прогоняет их через тот же
// декодер и ffmpeg, что и бот, и показывает счётчики байт на каждом звене.
// Запуск: node test_replay.js debug-<N>.opuspkt
const fs = require('fs');
const prism = require('prism-media');

const file = process.argv[2];
if (!file) {
  console.error('Укажите файл дампа: node test_replay.js debug-1.opuspkt');
  process.exit(1);
}

// Разбираем формат: [4 байта длины][пакет]...
const buf = fs.readFileSync(file);
const packets = [];
let off = 0;
while (off + 4 <= buf.length) {
  const len = buf.readUInt32LE(off);
  packets.push(buf.subarray(off + 4, off + 4 + len));
  off += 4 + len;
}
console.log(`пакетов в дампе: ${packets.length}, суммарно ${packets.reduce((s, p) => s + p.length, 0)} байт`);
console.log('первый пакет (hex, 32 байта):', packets[0].subarray(0, 32).toString('hex'));

const decoder = new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 });
const ffmpeg = new prism.FFmpeg({
  args: [
    '-hide_banner', '-loglevel', 'error',
    '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0',
    '-f', 's16le', '-ar', '16000', '-ac', '1',
  ],
});

let decBytes = 0;
let pcmBytes = 0;
decoder.on('data', (c) => { decBytes += c.length; });
decoder.on('error', (e) => console.log('ОШИБКА декодера:', e.message));
ffmpeg.on('data', (c) => { pcmBytes += c.length; });
ffmpeg.on('error', (e) => console.log('ОШИБКА ffmpeg:', e.message));
ffmpeg.on('end', () => {
  console.log(`ИТОГ: dec=${decBytes}Б, pcm=${pcmBytes}Б`);
  process.exit(0);
});

decoder.pipe(ffmpeg);
for (const p of packets) decoder.write(p);
decoder.end();
