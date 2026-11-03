// Тест звена Opus -> PCM: кодируем сигнал opusscript'ом и декодируем через prism,
// как это делает бот. Запуск: node test_decode.js
const OpusScript = require('opusscript');
const prism = require('prism-media');

const encoder = new OpusScript(48000, 2);

// 20 мс "сигнала" (пила), 960 сэмплов * 2 канала * 2 байта
const frame = Buffer.alloc(960 * 2 * 2);
for (let i = 0; i < 960; i++) {
  const v = Math.round(Math.sin(i / 10) * 10000);
  frame.writeInt16LE(v, i * 4);
  frame.writeInt16LE(v, i * 4 + 2);
}

const packet = encoder.encode(frame, 960);
console.log('закодирован пакет, байт:', packet.length);

const decoder = new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 });
let out = 0;
decoder.on('data', (c) => { out += c.length; });
decoder.on('error', (e) => console.log('ОШИБКА декодера:', e.message));
decoder.on('end', () => console.log('декодировано байт PCM:', out));
decoder.write(packet);
decoder.end();

// И отдельно проверим звено ffmpeg (PCM 48k стерео -> 16k моно)
const ffmpeg = new prism.FFmpeg({
  args: [
    '-hide_banner', '-loglevel', 'error',
    '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0',
    '-f', 's16le', '-ar', '16000', '-ac', '1',
  ],
});
let ffOut = 0;
ffmpeg.on('data', (c) => { ffOut += c.length; });
ffmpeg.on('error', (e) => console.log('ОШИБКА ffmpeg:', e.message));
ffmpeg.on('end', () => console.log('ffmpeg выдал байт:', ffOut));
ffmpeg.write(Buffer.concat([frame, frame, frame]));
ffmpeg.end();
