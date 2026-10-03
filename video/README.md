# Trailer

An ~80s promo for the series. Everything is generated locally:

```bash
cd video
# one-time: Kokoro TTS model (≈350 MB, gitignored)
curl -L -o tts/kokoro-v1.0.onnx https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
curl -L -o tts/voices-v1.0.bin  https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
npm install

uv run tts.py af_heart        # script.json → build/vo.wav + build/timeline.json (phrase-level timing)
uv run music.py               # timeline → build/music.wav (pad, arpeggio, risers, freeze on "pause")
printf 'window.TL = %s;\n' "$(cat build/timeline.json)" > build/timeline.js
node capture.mjs stills 12 30 62   # spot-check frames → build/stills/
node capture.mjs video 30          # every frame via headless Chrome → build/silent.mp4
./mix.sh                           # duck music under voice, loudnorm, mux → execution-engine-trailer.mp4
```

`anim.html` is the whole animation: `renderAt(t)` draws the frame at time `t`, deterministically,
keyed to the phrase start times in the timeline. Open it in a browser to preview (`?t=42` for one frame).
