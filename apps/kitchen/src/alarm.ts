/**
 * The kitchen alarm.
 *
 * Generated with the Web Audio API rather than an audio file: nothing to load,
 * nothing to 404, and the volume and urgency can rise with the escalation
 * level. It stops only when the order leaves PENDING — there is no snooze,
 * because a snooze is how an order gets forgotten.
 *
 * Browsers refuse to play audio before the user has interacted with the page,
 * which is why the app shows a "Start service" gate on load. On the native
 * Android build (doc 12) that restriction does not apply.
 */
let ctx: AudioContext | null = null;
let timer: number | null = null;

export function unlockAudio(): boolean {
  try {
    ctx = ctx ?? new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    if (ctx.state === 'suspended') void ctx.resume();
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

/** One double-beep. Higher levels are louder and higher pitched. */
function beep(level: number): void {
  if (!ctx) return;
  const now = ctx.currentTime;
  const frequency = 660 + level * 180;
  const volume = Math.min(0.18 + level * 0.16, 0.85);

  for (const offset of [0, 0.22]) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0, now + offset);
    gain.gain.linearRampToValueAtTime(volume, now + offset + 0.01);
    gain.gain.linearRampToValueAtTime(0, now + offset + 0.16);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now + offset);
    osc.stop(now + offset + 0.18);
  }
}

/**
 * Start or update the alarm. Repeats faster as the level rises.
 * Passing level 0 stops it.
 */
export function setAlarm(level: number): void {
  if (timer !== null) {
    window.clearInterval(timer);
    timer = null;
  }
  if (level <= 0) return;

  beep(level);
  const gap = Math.max(1600, 6000 - level * 1200);
  timer = window.setInterval(() => beep(level), gap);

  // Vibration is the backstop when a tablet has been muted at the hardware
  // switch — silent failure is the one outcome that must not happen here.
  if ('vibrate' in navigator) navigator.vibrate?.([200, 100, 200]);
}

export const stopAlarm = (): void => setAlarm(0);
