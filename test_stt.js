// Автономный тест STT-воркера: скармливает PCM-файл и печатает распознанный текст.
// Использование: node test_stt.js <файл s16le 16k mono> [модель whisper]
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const pcmPath = process.argv[2];
if (!pcmPath) {
  console.error('Укажите PCM-файл: node test_stt.js file.pcm [модель whisper]');
  process.exit(1);
}
const pcm = fs.readFileSync(pcmPath);

const worker = spawn('.venv/Scripts/python.exe', [
  path.join(__dirname, 'stt_worker.py'),
  '--model', process.argv[3] || 'small',
  '--language', 'ru',
], { stdio: ['pipe', 'pipe', 'inherit'] });

let buffer = Buffer.alloc(0);
const texts = [];
let ready = false;

worker.stdout.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    if (buffer.length < 9) return;
    const type = buffer.readUInt8(0);
    const len = buffer.readUInt32LE(5);
    if (buffer.length < 9 + len) return;
    const text = buffer.toString('utf8', 9, 9 + len);
    buffer = buffer.subarray(9 + len);
    if (type === 255) {
      ready = true;
      feed();
    } else if (type === 2) {
      texts.push(text);
      console.log('ТЕКСТ:', JSON.stringify(text));
    }
  }
});

function send(type, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(9);
  header.writeUInt8(type, 0);
  header.writeUInt32LE(1, 1);
  header.writeUInt32LE(payload.length, 5);
  worker.stdin.write(Buffer.concat([header, payload]));
}

function feed() {
  const CHUNK = 8000;
  for (let off = 0; off < pcm.length; off += CHUNK) {
    send(0, pcm.subarray(off, off + CHUNK));
  }
  send(1); // finish
  setTimeout(() => {
    const full = texts.join(' ');
    console.log('ИТОГ:', JSON.stringify(full));
    worker.kill();
    process.exit(0);
  }, 3000);
}

setTimeout(() => {
  if (!ready) {
    console.error('Воркер не подал сигнал ready за 180 секунд');
    process.exit(1);
  }
}, 180000);
