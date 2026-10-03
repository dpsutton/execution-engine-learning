#!/usr/bin/env bash
# Mix voiceover over the music bed (music ducks under the voice), normalize, mux with the video.
set -euo pipefail
cd "$(dirname "$0")"
ffmpeg -y -loglevel error -i build/silent.mp4 -i build/vo.wav -i build/music.wav -filter_complex "
  [1:a]aresample=48000,pan=stereo|c0=c0|c1=c0,asplit=2[vo][key];
  [2:a]volume=0.6[mus];
  [mus][key]sidechaincompress=threshold=0.02:ratio=5:attack=15:release=400[ducked];
  [ducked][vo]amix=inputs=2:normalize=0:duration=first,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[a]" \
  -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart execution-engine-trailer.mp4
ffprobe -v error -show_entries format=duration,size -of default=nw=1 execution-engine-trailer.mp4
