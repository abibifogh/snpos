import { useEffect, useState } from 'react';
import { themeMode, setThemeMode, type ThemeMode } from './theme';
import { Button } from './components';

/**
 * Light or dark, from the screen it is on.
 *
 * The choice already existed and lived in the admin settings, which is the one
 * place the people who need it never are. A kitchen screen is read across a
 * hot room under strip lights at midday and in a half-dark service area at
 * eleven at night, and the right answer is different at those two moments on
 * the same device. Sending a cook to a settings page on another app to change
 * it means it never gets changed.
 *
 * Three states, not two. "Match my device" is the default and stays the
 * default — a tablet that dims itself at sunset should take the screen with
 * it — and the two fixed choices are overrides for a room whose lighting does
 * not agree with whatever the device thinks. Cycling through all three keeps
 * it one button; a switch with two positions cannot express "follow the
 * device" at all, and that is the setting most screens should be on.
 *
 * Kept on the device, never in the settings document. One cook preferring dark
 * is not a decision for the whole restaurant, and two screens in one building
 * are lit differently.
 */
const NEXT: Record<ThemeMode, ThemeMode> = { system: 'light', light: 'dark', dark: 'system' };

const LABEL: Record<ThemeMode, string> = {
  system: 'Auto',
  light: 'Light',
  dark: 'Dark',
};

const TITLE: Record<ThemeMode, string> = {
  system: 'Following the device. Tap for always light.',
  light: 'Always light. Tap for always dark.',
  dark: 'Always dark. Tap to follow the device.',
};

function Icon({ mode }: { mode: ThemeMode }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  if (mode === 'dark') {
    // A moon, drawn as a crescent rather than a circle with a bite out of it,
    // so it still reads at 16px on a screen somebody is glancing at.
    return <svg {...common}><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" /></svg>;
  }
  if (mode === 'light') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    );
  }
  // Half and half: the device decides, and the icon says so without a word.
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function ThemeButton({ size = 'sm' }: { size?: 'sm' | 'md' }) {
  const [mode, setMode] = useState<ThemeMode>(() => {
    try {
      return themeMode();
    } catch {
      // A browser refusing storage still gets a working screen, following the
      // device, with a button that does nothing until it is reloaded.
      return 'system';
    }
  });

  /*
    The device changing its mind, while set to follow it.

    A tablet that switches to dark at sunset does so without reloading the
    page, and without this the button would keep saying Auto while the screen
    around it had already changed — or worse, not changed, because nothing
    re-applied it.
  */
  useEffect(() => {
    if (mode !== 'system' || !window.matchMedia) return undefined;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const again = () => setThemeMode('system');
    media.addEventListener?.('change', again);
    return () => media.removeEventListener?.('change', again);
  }, [mode]);

  return (
    <Button
      size={size}
      variant="ghost"
      title={TITLE[mode]}
      aria-label={`Screen brightness: ${LABEL[mode]}. ${TITLE[mode]}`}
      onClick={() => {
        const next = NEXT[mode];
        setMode(next);
        try {
          setThemeMode(next);
        } catch {
          // See above. Nothing to tell a cook about.
        }
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
        <Icon mode={mode} />
        {LABEL[mode]}
      </span>
    </Button>
  );
}
