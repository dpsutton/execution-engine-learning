# /// script
# dependencies = ["kokoro-onnx>=0.4", "soundfile", "numpy"]
# ///
"""Voiceover + timeline.

Synthesizes every phrase in script.json with Kokoro (local, CPU), trims silence, and lays the
phrases out on a timeline: scene = lead + phrases (each followed by its gap) + tail. Writes
  build/timeline.json   scene starts/durations and absolute phrase start times (drives animation)
  build/vo.wav          the assembled voiceover
"""
import json, sys, pathlib
import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro

root = pathlib.Path(__file__).parent
voice = sys.argv[1] if len(sys.argv) > 1 else "af_heart"
speed = float(sys.argv[2]) if len(sys.argv) > 2 else 1.0
build = root / "build"
build.mkdir(exist_ok=True)
k = Kokoro(str(root / "tts/kokoro-v1.0.onnx"), str(root / "tts/voices-v1.0.bin"))

def trim(x, sr, thresh=0.01, pad=0.03):
    idx = np.where(np.abs(x) > thresh)[0]
    if len(idx) == 0:
        return x
    a = max(0, idx[0] - int(pad * sr)); b = min(len(x), idx[-1] + int(pad * sr))
    return x[a:b]

script = json.loads((root / "script.json").read_text())
t, scenes, clips, sr = 0.0, [], [], 24000
for scene in script:
    start = t
    t += scene["lead"]
    phrases = []
    for text, gap in scene["phrases"]:
        samples, sr = k.create(text, voice=voice, speed=speed, lang="en-us")
        samples = trim(samples, sr)
        dur = len(samples) / sr
        phrases.append({"text": text, "start": round(t, 3), "dur": round(dur, 3)})
        clips.append((t, samples))
        t += dur + gap
    t += scene["tail"]
    scenes.append({"id": scene["id"], "start": round(start, 3), "dur": round(t - start, 3), "phrases": phrases})
    print(f"{scene['id']:9s} start {start:6.2f}  dur {t - start:5.2f}")

total = t
vo = np.zeros(int(total * sr) + sr, dtype=np.float32)
for start, s in clips:
    i = int(start * sr); vo[i:i + len(s)] += s
sf.write(build / "vo.wav", vo, sr)
(build / "timeline.json").write_text(json.dumps({"total": round(total, 3), "scenes": scenes}, indent=1))
print(f"total {total:.2f}s")
