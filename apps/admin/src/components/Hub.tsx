import { createContext, Fragment, useCallback, useContext, useLayoutEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ViewTabs } from '@snpos/ui';

/**
 * One page made of several, with a row of underlined tabs.
 *
 * Tables, Stations, Payouts, Waste and the rest were pages of their own,
 * each reached by a link on another page or by a line in the sidebar. Most
 * of them are part of one job: tables and stations are setting up a venue,
 * goods received and payouts are dealing with makers. So they are tabs of
 * that page now, and the sidebar is shorter by every one of them.
 *
 * Permission is untouched. Each tab is still the page it was, behind the
 * grant it had, and a tab somebody may not open is simply not offered. A
 * person given one tab and not the page it sits on gets that tab alone, under
 * its own name and with no strip, which is what they had before.
 *
 * The tab is in the address (?tab=), so a link, a bookmark and the back
 * button all land on the same one, and the old addresses redirect to it.
 */
export interface HubTab {
  id: string;
  label: string;
  /** Whether this person may open it. */
  open: boolean;
  render: () => ReactNode;
  /**
   * Tabs sharing a group are one screen underneath, and keep what has been
   * typed when moving between them. Settings is one form split five ways;
   * switching from Money to Tips must not throw the Money edits away.
   */
  group?: string;
}

interface HubState {
  /** The page's own name, shown in place of the tab's while there is a strip. */
  title?: string;
  strip: ReactNode | null;
  place: () => () => void;
}

const HubContext = createContext<HubState | null>(null);

/**
 * A control that belongs under the tabs rather than above the title: the
 * Bistro · Bar · Shop switch on Products, which a tab's page supplies.
 */
export const UnderTabs = createContext<ReactNode>(null);

export function Hub({ title, tabs, ariaLabel }: { title?: string; tabs: HubTab[]; ariaLabel?: string }) {
  const [params, setParams] = useSearchParams();
  const [placed, setPlaced] = useState(0);
  const place = useCallback(() => {
    setPlaced((n) => n + 1);
    return () => setPlaced((n) => n - 1);
  }, []);

  const shown = tabs.filter((t) => t.open);
  const current = shown.find((t) => t.id === params.get('tab')) ?? shown[0];
  if (!current) return null;

  const pick = (id: string) => setParams((p) => {
    // The side carries over; anything one tab put in the address does not.
    const next = new URLSearchParams();
    const side = p.get('side');
    if (side) next.set('side', side);
    next.set('tab', id);
    return next;
  });

  const strip = shown.length > 1 ? (
    <ViewTabs<string>
      value={current.id}
      onChange={pick}
      ariaLabel={ariaLabel ?? title ?? 'Which part of this page'}
      options={shown.map((t) => ({ value: t.id, label: t.label }))}
    />
  ) : null;

  return (
    <HubContext.Provider value={{ title: strip ? title : undefined, strip, place }}>
      {/* Until the page has drawn its own header (it may still be loading),
          the strip sits at the top so the tabs never vanish. */}
      {strip && placed === 0 && <div className="hub-tabs">{strip}</div>}
      <Fragment key={current.group ?? current.id}>{current.render()}</Fragment>
    </HubContext.Provider>
  );
}

/** Where a page puts the strip: under its header. Nothing outside a hub. */
export function HubTabs() {
  const hub = useContext(HubContext);
  const place = hub?.place;
  const under = useContext(UnderTabs);
  useLayoutEffect(() => (place ? place() : undefined), [place]);
  if (!hub?.strip && !under) return null;
  return (
    <div className="hub-tabs">
      {hub?.strip}
      {under && <div className="hub-under">{under}</div>}
    </div>
  );
}

/** The page's title: the hub's name while it has tabs, the page's own otherwise. */
export function HubTitle({ children }: { children: ReactNode }) {
  const hub = useContext(HubContext);
  return <>{hub?.title ?? children}</>;
}

/** Whether this page is one tab among several, for the few that lay out differently then. */
export function useInHub(): boolean {
  return !!useContext(HubContext)?.strip;
}
