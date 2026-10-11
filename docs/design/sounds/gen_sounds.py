"""Session Board's three sounds, synthesised (no samples, nothing to license).
Mallet-like tones: a sine plus a few partials, a 4 ms attack and an exponential decay."""
import math, struct, wave, sys
RATE = 44100
OUT = sys.argv[1]

def tone(freq, start, length, amp, tau, partials):
    """partials: (ratio, gain) pairs; tau: decay time constant in seconds"""
    n0, n = int(start * RATE), int(length * RATE)
    out = {}
    for i in range(n):
        t = i / RATE
        env = min(1.0, t / 0.004) * math.exp(-t / tau)
        s = sum(g * math.sin(2 * math.pi * freq * r * t) * math.exp(-t * (r - 1) * 3.0) for r, g in partials)
        out[n0 + i] = amp * env * s
    return out

def write(name, *tones):
    total = max(k for t in tones for k in t) + 1
    buf = [0.0] * (total + int(0.05 * RATE))
    for t in tones:
        for k, v in t.items(): buf[k] += v
    peak = max(abs(x) for x in buf) or 1
    scale = 0.7 / peak
    with wave.open(f'{OUT}/{name}.wav', 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(RATE)
        w.writeframes(b''.join(struct.pack('<h', int(max(-1, min(1, x * scale)) * 32767)) for x in buf))
    print(name, f'{len(buf) / RATE:.2f}s')

MARIMBA = [(1, 1.0), (3.9, 0.35), (9.2, 0.08)]
BELL = [(1, 1.0), (2.76, 0.45), (5.4, 0.2), (8.93, 0.08)]
# Needs you: two quick rising notes (E5 → B5), the most urgent
write('needs-you', tone(659.25, 0.00, 0.40, 1.0, 0.16, MARIMBA), tone(987.77, 0.11, 0.45, 1.0, 0.18, MARIMBA))
# Your turn: two softer notes, falling (G5 → E5)
write('your-turn', tone(783.99, 0.00, 0.45, 0.7, 0.22, MARIMBA), tone(659.25, 0.15, 0.55, 0.7, 0.26, MARIMBA))
# Done: one soft bell (C6)
write('done', tone(1046.5, 0.00, 0.90, 0.5, 0.45, BELL))
