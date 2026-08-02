/**
 * The kitchen alarm.
 *
 * Generated with the Web Audio API rather than an audio file: nothing to load,
 * nothing to 404, and the sound can be shaped to the room. It stops only when
 * the order is acknowledged — there is no snooze, because a snooze is how an
 * order gets forgotten.
 *
 * This is built for a bar. A polite beep loses to a sound system every time, so
 * the alarm carries in three ways at once: a low tone with real energy under
 * 200 Hz that travels through noise, a bright tone on top that cuts through it,
 * and a slight detune between two oscillators that makes the sound beat rather
 * than sit still — a steady tone is exactly what a room full of noise hides
 * best.
 *
 * Browsers refuse to play audio before the user has touched the page, which is
 * what the PIN gate on load is for.
 */
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let timer: number | null = null;
let current = 0;

/** Sounds different so it can be told apart without looking. */
export type AlarmKind = 'new' | 'late';

export function unlockAudio(): boolean {
  try {
    ctx = ctx ?? new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    if (ctx.state === 'suspended') void ctx.resume();

    if (!master) {
      // A compressor across everything. Without it the loud settings clip into
      // a crackle, which a speaker reproduces as quieter, not louder.
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.ratio.value = 12;
      comp.attack.value = 0.002;
      comp.release.value = 0.1;
      master = ctx.createGain();
      master.gain.value = 1;
      master.connect(comp).connect(ctx.destination);
    }

    // A silent blip: this is what actually satisfies the browser's gesture rule.
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    g.gain.value = 0.0001;
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.01);
    return true;
  } catch {
    return false;
  }
}

export const audioReady = (): boolean => !!ctx && ctx.state === 'running';

/** One voice of a chime: a tone with its own shape and envelope. */
function tone(
  at: number,
  freq: number,
  seconds: number,
  volume: number,
  type: OscillatorType,
  detune = 0,
): void {
  if (!ctx || !master) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, at);
  osc.detune.value = detune;
  // A fast attack and a decaying tail reads as a strike rather than a drone,
  // and a strike is what carries across a room.
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(volume, at + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0008, at + seconds);
  osc.connect(gain).connect(master);
  osc.start(at);
  osc.stop(at + seconds + 0.02);
}

/** A thump you feel more than hear. Carries furthest through a noisy room. */
function thump(at: number, volume: number): void {
  if (!ctx || !master) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  // Sweeping down is what makes it read as a drum rather than a hum.
  osc.frequency.setValueAtTime(160, at);
  osc.frequency.exponentialRampToValueAtTime(48, at + 0.18);
  gain.gain.setValueAtTime(volume, at);
  gain.gain.exponentialRampToValueAtTime(0.0008, at + 0.22);
  osc.connect(gain).connect(master);
  osc.start(at);
  osc.stop(at + 0.24);
}

/**
 * A new order: two rising notes over a thump. Friendly, but with weight under
 * it. It should read as "something has arrived", not as an emergency.
 */
function chimeNew(level: number): void {
  if (!ctx) return;
  const t = ctx.currentTime;
  const vol = Math.min(0.5 + level * 0.12, 0.95);
  thump(t, vol);
  tone(t + 0.02, 523.25, 0.3, vol * 0.7, 'triangle');
  tone(t + 0.02, 523.25, 0.3, vol * 0.35, 'sine', 8);
  tone(t + 0.2, 783.99, 0.42, vol * 0.75, 'triangle');
  tone(t + 0.2, 783.99, 0.42, vol * 0.35, 'sine', -8);
}

/**
 * Late: a falling two-tone klaxon, three times, over a heavier thump. Falling
 * intervals are what an ear hears as a warning, and it must be impossible to
 * mistake for the arrival sound from across the kitchen.
 */
function chimeLate(level: number): void {
  if (!ctx) return;
  const t = ctx.currentTime;
  const vol = Math.min(0.62 + level * 0.1, 1);

  for (let i = 0; i < 3; i += 1) {
    const at = t + i * 0.34;
    thump(at, vol);
    // High then low, quickly — the two-tone that says "move".
    tone(at, 880 + level * 60, 0.16, vol * 0.85, 'sawtooth');
    tone(at, 880 + level * 60, 0.16, vol * 0.4, 'square', 12);
    tone(at + 0.16, 587.33 + level * 40, 0.2, vol * 0.85, 'sawtooth');
    tone(at + 0.16, 587.33 + level * 40, 0.2, vol * 0.4, 'square', -12);
  }
}

const play = (kind: AlarmKind, level: number) => (kind === 'late' ? chimeLate(level) : chimeNew(level));

/**
 * Start or update the alarm. Repeats faster as the level rises.
 * Passing level 0 stops it.
 */
export function setAlarm(level: number, kind: AlarmKind = 'new'): void {
  if (timer !== null) {
    window.clearInterval(timer);
    timer = null;
  }
  current = level;
  if (level <= 0) return;

  play(kind, level);
  // Late orders nag sooner than new ones; a new order that nobody has touched
  // becomes a late one soon enough on its own.
  const base = kind === 'late' ? 4200 : 6000;
  const gap = Math.max(kind === 'late' ? 1400 : 2200, base - level * 1100);
  timer = window.setInterval(() => play(kind, level), gap);

  // Vibration is the backstop when a tablet has been muted at the hardware
  // switch — silent failure is the one outcome that must not happen here.
  if ('vibrate' in navigator) {
    navigator.vibrate?.(kind === 'late' ? [300, 90, 300, 90, 300] : [200, 100, 200]);
  }
}

export const stopAlarm = (): void => setAlarm(0);

/** One-off sound, for testing the volume without waiting for a real order. */
export function testAlarm(kind: AlarmKind): void {
  unlockAudio();
  play(kind, 2);
}

export const alarmLevel = (): number => current;
