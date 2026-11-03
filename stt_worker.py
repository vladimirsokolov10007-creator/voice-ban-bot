"""
STT-воркер на базе faster-whisper для Discord-бота-модератора.

Запускается как дочерний процесс из Node.js и общается бинарным
протоколом через stdin/stdout (little-endian):

  Запрос : [1 байт type][4 байта session_id][4 байта length][payload]
             type 0 - аудиочанк (PCM s16le, 16 кГц, моно)
             type 1 - завершить сессию и распознать накопленное аудио
             type 2 - сбросить сессию без результата
  Ответ  : [1 байт type][4 байта session_id][4 байта length][utf-8 текст]
             type 2 - распознанный текст
             type 255 - служебное сообщение (ready)

Whisper не потоковый, поэтому аудио каждой фразы накапливается
и распознаётся целиком при завершении сессии. Модель загружается
один раз при старте воркера.
"""

import argparse
import struct
import sys

import numpy as np
from faster_whisper import WhisperModel

TYPE_CHUNK = 0
TYPE_FINISH = 1
TYPE_RESET = 2

OUT_TEXT = 2
OUT_READY = 255

# Фразы короче этого порога не распознаём (шум/щелчки)
MIN_AUDIO_SEC = 0.3


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="small", help="Модель Whisper: tiny/base/small/medium или путь")
    parser.add_argument("--language", default="ru", help="Язык распознавания")
    parser.add_argument("--device", default="cpu", help="cpu или cuda")
    parser.add_argument("--compute-type", default="int8", help="int8 / float16 / float32")
    parser.add_argument("--rate", type=int, default=16000, help="Частота входного PCM")
    args = parser.parse_args()

    model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)

    stdin = sys.stdin.buffer
    stdout = sys.stdout.buffer

    def send(msg_type: int, session_id: int, text: str) -> None:
        data = text.encode("utf-8")
        stdout.write(struct.pack("<BII", msg_type, session_id, len(data)))
        stdout.write(data)
        stdout.flush()

    send(OUT_READY, 0, "ready")

    sessions: dict[int, bytearray] = {}

    while True:
        header = stdin.read(9)
        if not header or len(header) < 9:
            break  # родитель закрыл stdin — завершаемся
        msg_type, session_id, length = struct.unpack("<BII", header)
        payload = stdin.read(length) if length else b""
        if len(payload) < length:
            break

        if msg_type == TYPE_CHUNK:
            sessions.setdefault(session_id, bytearray()).extend(payload)

        elif msg_type == TYPE_FINISH:
            pcm = sessions.pop(session_id, None)
            if pcm is None:
                continue
            if len(pcm) < int(MIN_AUDIO_SEC * args.rate) * 2:
                continue  # слишком короткий отрезок
            audio = np.frombuffer(bytes(pcm), dtype=np.int16).astype(np.float32) / 32768.0
            segments, _ = model.transcribe(
                audio,
                language=args.language,
                beam_size=5,
                vad_filter=True,  # отсекает тишину и снижает «галлюцинации»
            )
            text = " ".join(seg.text for seg in segments).strip()
            if text:
                send(OUT_TEXT, session_id, text)

        elif msg_type == TYPE_RESET:
            sessions.pop(session_id, None)


if __name__ == "__main__":
    main()
