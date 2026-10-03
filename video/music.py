# /// script
# dependencies = ["numpy", "soundfile"]
# ///
"""Synthesize the music bed + sound effects from build/timeline.json → build/music.wav (stereo 48k).

Pad (A minor progression) under everything; an arpeggio pulse from the title on; risers/whooshes at
scene changes; the music freezes (filter + level drop) between "pause" and "resume", drops out for
the tease, and resolves at the outro.
"""
import json, pathlib
import numpy as np
import soundfile as sf

root = pathlib.Path(__file__).parent
tl = json.loads((root / "build/timeline.json").read_text())
SR = 48000
T = tl["total"] + 1.0
N = int(T * SR)
t = np.arange(N) / SR
rng = np.random.default_rng(7)
scene = {s["id"]: s for s in tl["scenes"]}

def phrase_start(sid, i): return scene[sid]["phrases"][i]["start"]

def hz(midi): return 440.0 * 2 ** ((midi - 69) / 12)


def env_points(points):
    """Piecewise-linear automation from [(time, value), ...]."""
    ts, vs = zip(*points)
    return np.interp(t, ts, vs)

# ---------- pad ----------
chords = [[57, 60, 64], [53, 57, 60], [48, 52, 55, 60], [55, 59, 62]]   # Am F C G
bar = 60 / 96 * 4  # 96 bpm, 4/4
chord_len = bar * 2
pad = np.zeros((N, 2))
for ci in range(int(T / chord_len) + 2):
    notes = chords[ci % 4]
    c0 = ci * chord_len
    seg = (t >= c0 - 1.0) & (t < c0 + chord_len + 1.0)
    tt = t[seg] - c0
    # smooth crossfade envelope
    e = np.clip((tt + 1.0) / 1.5, 0, 1) * np.clip((chord_len + 1.0 - tt) / 1.5, 0, 1)
    e = e ** 1.5
    for n in notes:
        for det, pan in ((-0.0025, 0.25), (0.0025, 0.75)):
            f = hz(n) * (1 + det)
            ph = 2 * np.pi * f * t[seg]
            w = np.sin(ph) + 0.35 * np.sin(2 * ph + 0.3) + 0.15 * np.sin(3 * ph + 0.7)
            pad[seg, 0] += w * e * (1 - pan) * 0.05
            pad[seg, 1] += w * e * pan * 0.05
    # sub bass root
    f = hz(notes[0] - 24)
    pad[seg, :] += (np.sin(2 * np.pi * f * t[seg]) * e * 0.10)[:, None]

# ---------- arpeggio pulse (8th notes) ----------
arp = np.zeros((N, 2))
eighth = 60 / 96 / 2
arp_on = scene["title"]["start"] + scene["title"]["phrases"][1]["start"] - scene["title"]["start"]
k = 0
pattern = [0, 2, 1, 2, 0, 2, 1, 3]
start_k = int(arp_on / eighth)
for k in range(start_k, int(T / eighth)):
    on = k * eighth
    ci = int(on / chord_len) % 4
    notes = chords[ci]
    n = notes[pattern[k % 8] % len(notes)] + 12
    L = int(0.45 * SR); i0 = int(on * SR)
    if i0 + L > N: break
    tt = np.arange(L) / SR
    pl = np.sin(2 * np.pi * hz(n) * tt) * np.exp(-tt * 9) + 0.3 * np.sin(4 * np.pi * hz(n) * tt) * np.exp(-tt * 14)
    pan = 0.3 if k % 2 else 0.7
    vel = 0.75 + 0.25 * ((k % 4) == 0)
    arp[i0:i0 + L, 0] += pl * (1 - pan) * 0.06 * vel
    arp[i0:i0 + L, 1] += pl * pan * 0.06 * vel

# ---------- effects ----------
fx = np.zeros((N, 2))
def noise_sweep(at, dur, up=True, gain=0.12):
    L = int(dur * SR); i0 = int(at * SR)
    if i0 < 0: L += i0; i0 = 0
    nz = rng.standard_normal((L, 2))
    tt = np.linspace(0, 1, L)
    # crude band movement: blend low-passed & raw noise by sweep position
    lp = np.cumsum(nz, axis=0); lp -= np.convolve(lp[:, 0], np.ones(200) / 200, mode="same")[:, None]
    lp /= (np.abs(lp).max() + 1e-9)
    mix = tt if up else 1 - tt
    shaped = nz * mix[:, None] * 0.5 + lp * (1 - mix[:, None])
    env = (np.sin(np.pi * tt) ** 2) if not up else tt ** 2 * (1 - np.clip((tt - 0.92) / 0.08, 0, 1))
    fx[i0:i0 + L] += shaped * env[:, None] * gain

def impact(at, gain=0.5):
    L = int(1.8 * SR); i0 = int(at * SR); tt = np.arange(L) / SR
    f = 55 * np.exp(-tt * 3) + 38
    boom = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt * 2.6)
    fx[i0:i0 + L] += (boom * gain)[:, None]

def tick(at, f=1800, gain=0.08):
    L = int(0.05 * SR); i0 = int(at * SR); tt = np.arange(L) / SR
    fx[i0:i0 + L] += (np.sin(2 * np.pi * f * tt) * np.exp(-tt * 120) * gain)[:, None]

for s in tl["scenes"][1:]:
    noise_sweep(s["start"] - 0.45, 0.9, up=False, gain=0.07)
noise_sweep(scene["title"]["start"] - 1.6, 1.6, up=True, gain=0.10)
impact(scene["title"]["start"])
impact(scene["outro"]["start"], gain=0.4)
# counter ticks under the joins race
for i in range(24):
    tick(phrase_start("joins", 1) + 0.15 + i * 0.09, f=1500 + 20 * i, gain=0.035)
for i in range(6):
    tick(phrase_start("joins", 3) + 0.05 + i * 0.12, f=2400, gain=0.05)
# pause / save / resume cues
p_pause, p_save, p_resume = phrase_start("bytecode", 2), phrase_start("bytecode", 3), phrase_start("bytecode", 4)
tick(p_pause + 0.55, f=900, gain=0.12)
noise_sweep(p_save - 0.1, 0.7, up=False, gain=0.06)
tick(p_resume + 0.45, f=1400, gain=0.12)

# ---------- automation ----------
music = pad + arp
# freeze: between "pause" and "resume", tape-stop-ish level drop (arp silent, pad down)
tease = scene["tease"]; outro = scene["outro"]
gain = env_points([
    (0, 0), (1.2, 0.85), (scene["title"]["start"] - 0.2, 0.85), (scene["title"]["start"], 1.0),
    (p_pause + 0.4, 1.0), (p_pause + 0.6, 0.35), (p_resume + 0.35, 0.35), (p_resume + 0.5, 1.0),
    (tease["start"] - 0.1, 1.0), (tease["start"] + 0.15, 0.12), (outro["start"] - 0.05, 0.12),
    (outro["start"], 1.0), (T - 3.0, 0.9), (T, 0)])
arp_gate = env_points([
    (0, 1), (p_pause + 0.4, 1), (p_pause + 0.5, 0), (p_resume + 0.45, 0), (p_resume + 0.5, 1),
    (tease["start"] - 0.05, 1), (tease["start"] + 0.05, 0), (outro["start"], 0), (outro["start"] + 0.01, 1),
    (T - 4.0, 1), (T - 2.0, 0), (T, 0)])
music = pad * gain[:, None] + arp * (gain * arp_gate)[:, None]
out = music + fx
out /= max(1.0, np.abs(out).max() / 0.9)
sf.write(root / "build/music.wav", out.astype(np.float32), SR)
print("music.wav", round(T, 2), "s, peak", round(float(np.abs(out).max()), 3))
