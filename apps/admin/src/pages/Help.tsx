import { Fragment, useEffect, useState } from 'react';
import { Badge, Button, Card, HelpBook, Notice, Spinner, Toggle, useToast } from '@snpos/ui';
import { db, DB_ID, ID, listAll, humanError } from '../lib';
import {
  HELP_ARTICLES, HELP_AREAS, HELP_ROLES, audienceFor,
  type HelpArticle, type HelpRole, type FeatureFlag,
} from '@snpos/core';

/**
 * The manual, and who may read it.
 *
 * Both on one page on purpose: deciding whether a cook should see the chapter
 * on accounts is a decision you make by reading the chapter, and a settings
 * screen that hides the thing being configured makes that guesswork.
 */
export function HelpPage() {
  const toast = useToast();
  const [tab, setTab] = useState<'manual' | 'who'>('manual');
  const [flag, setFlag] = useState<FeatureFlag | null>(null);
  const [audiences, setAudiences] = useState<Record<string, HelpRole[]>>({});
  const [showOnMenu, setShowOnMenu] = useState(true);
  const [enabled, setEnabled] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const rows = await listAll<FeatureFlag>('feature_flags');
      // The group-wide row is the one edited here; a venue override, if anyone
      // ever adds one, still wins at read time.
      const row = rows.find((r) => r.key === 'help' && !r.venue_id) ?? null;
      setFlag(row);
      const config = row?.config ? (JSON.parse(row.config) as Record<string, unknown>) : {};
      setAudiences((config.audiences as Record<string, HelpRole[]>) ?? {});
      setShowOnMenu(config.show_on_customer_menu !== false);
      setEnabled(row?.enabled ?? true);
    })().catch((e) => setError(humanError(e)));
  }, []);

  const toggle = (article: HelpArticle, role: HelpRole, on: boolean) => {
    setAudiences((prev) => {
      const current = prev[article.id] ?? article.audience;
      const next = on ? [...new Set([...current, role])] : current.filter((r) => r !== role);
      return { ...prev, [article.id]: next };
    });
    setDirty(true);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const config = JSON.stringify({ audiences, show_on_customer_menu: showOnMenu });
      if (flag) {
        await db.updateDocument(DB_ID, 'feature_flags', flag.$id, { enabled, config });
      } else {
        // The row is normally seeded by provisioning; creating it here means an
        // older project that has not been re-provisioned still works.
        const created = await db.createDocument(DB_ID, 'feature_flags', ID.unique(), {
          key: 'help', venue_id: '', enabled, config,
        });
        setFlag(created as unknown as FeatureFlag);
      }
      setDirty(false);
      toast('Saved');
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  const resetOne = (article: HelpArticle) => {
    setAudiences((prev) => {
      const next = { ...prev };
      delete next[article.id];
      return next;
    });
    setDirty(true);
  };

  if (!flag && !error && Object.keys(audiences).length === 0 && tab === 'who' && busy) return <Spinner />;

  return (
    <>
      <div className="spread">
        <h1>Help</h1>
        {tab === 'who' && (
          <Button variant="primary" onClick={save} loading={busy} disabled={!dirty}>
            {dirty ? 'Save changes' : 'Saved'}
          </Button>
        )}
      </div>

      <div className="row" style={{ gap: '0.4rem' }}>
        <Button size="sm" variant={tab === 'manual' ? 'primary' : 'default'} onClick={() => setTab('manual')}>
          The manual
        </Button>
        <Button size="sm" variant={tab === 'who' ? 'primary' : 'default'} onClick={() => setTab('who')}>
          Who can see it
        </Button>
      </div>

      {error && <Notice>{error}</Notice>}

      {tab === 'manual' ? (
        <Card>
          <HelpBook
            articles={HELP_ARTICLES}
            areas={HELP_AREAS}
            intro="This is everything, as an admin sees it. What each job can read is set on the other tab."
          />
        </Card>
      ) : (
        <>
          <Card title="Turn it on or off">
            <Toggle
              checked={enabled}
              onChange={(v) => { setEnabled(v); setDirty(true); }}
              label="Show the help button in the apps"
            />
            <p className="small dim" style={{ marginBottom: 0 }}>
              Off hides it everywhere. The manual is still readable here.
            </p>
            <div style={{ marginTop: '0.8rem' }}>
              <Toggle
                checked={showOnMenu}
                onChange={(v) => { setShowOnMenu(v); setDirty(true); }}
                label="Show customers how to order on the QR menu"
              />
            </div>
          </Card>

          <Card pad={false} title="Who reads what">
            <p className="small dim card-pad" style={{ margin: 0 }}>
              Tick the jobs that should see each chapter. Everyone starts with the chapters written for them; a chapter
              nobody can see simply does not appear.
            </p>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Chapter</th>
                    {HELP_ROLES.map((r) => <th key={r.role} style={{ textAlign: 'center' }}>{r.label}</th>)}
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {HELP_AREAS.map((area) => {
                    const items = HELP_ARTICLES.filter((a) => a.area === area.area);
                    if (items.length === 0) return null;
                    return (
                      <Fragment key={area.area}>
                        <tr>
                          <td colSpan={HELP_ROLES.length + 2} className="small dim" style={{ fontWeight: 600 }}>
                            {area.label}
                          </td>
                        </tr>
                        {items.map((a) => {
                          const shown = audienceFor(a, audiences as Record<string, string[]>);
                          const changed = audiences[a.id] !== undefined;
                          return (
                            <tr key={a.id}>
                              <td>
                                <div style={{ fontWeight: 550 }}>{a.title}</div>
                                <div className="small dim">{a.summary}</div>
                                {shown.length === 0 && <Badge tone="warn">Hidden from everyone</Badge>}
                              </td>
                              {HELP_ROLES.map((r) => (
                                <td key={r.role} style={{ textAlign: 'center' }}>
                                  <Toggle
                                    checked={shown.includes(r.role)}
                                    onChange={(v) => toggle(a, r.role, v)}
                                  />
                                </td>
                              ))}
                              <td className="num">
                                {changed && (
                                  <Button size="sm" variant="ghost" onClick={() => resetOne(a)}>Reset</Button>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </>
  );
}
