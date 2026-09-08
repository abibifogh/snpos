import { useCallback, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IdleScreen } from '@snpos/ui';
import type { Unlocker } from '@snpos/core';

/**
 * The till's lock screen, wired exactly as apps/pos/src/App.tsx wires it.
 *
 * The screen is the real one. What is stubbed is the app around it — the two
 * callbacks that lock and unlock, and a staff list with known PINs — because
 * the fault this exists to catch lived in the conversation between the two:
 * the screen opening the door and the app closing it again in the same
 * instant. No test of either side on its own could see that.
 */

/** Regina's PIN is 1234; Betty's is 13795. Hashed the way the staff form does it. */
const STAFF: Unlocker[] = [
  {
    $id: 'u1',
    display_name: 'Regina',
    active: true,
    pin_hash: 'abcdef0123456789abcdef01$1b60c5c20c317061a53b5d6680884c2323e9740da9be46d67031d3ba65828346',
  },
  {
    $id: 'u2',
    display_name: 'Betty',
    active: true,
    pin_hash: 'af9a8eb110995bc1f508791b$af4398164e2ab94503c49babcdfb8ef26eeabf16d910bdb00a62adc406532c7e',
  },
];

declare global {
  interface Window { __log: string[] }
}

window.__log = [];
const say = (what: string) => { window.__log.push(`${Date.now()} ${what}`); };

function Till() {
  const [locked, setLocked] = useState(false);
  const identified = useRef(false);

  // What the till does on lock and unlock. The parts that matter to the
  // screen: `locked` flips, and nothing else the screen can see changes.
  const lock = () => { say('onLock'); setLocked(true); };
  const unlock = (who?: Unlocker) => {
    say(`onUnlock ${who?.display_name ?? '?'}`);
    identified.current = true;
    setLocked(false);
  };
  const refreshStaff = useCallback(async () => { say('refreshStaff'); return STAFF; }, []);

  return (
    <div>
      <div id="state">{locked ? 'LOCKED' : 'OPEN'}</div>
      <button id="lock" type="button" onClick={lock}>Lock</button>
      <IdleScreen
        afterMinutes={1}
        hasOpenShift
        module="bar"
        locked={locked}
        staff={STAFF}
        firstUse={!identified.current}
        onLock={lock}
        onUnlock={unlock}
        refreshStaff={refreshStaff}
      />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Till />);
