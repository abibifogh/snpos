import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, Input, Notice, Select, useToast, initialsOf } from '@snpos/ui';
import { loadHiveStaff, setHiveMatch, suggestHiveMatch, loadFeatures, isEnabled, COUNT_CHARGES } from '@snpos/core';
import type { HiveStaff, StaffProfile } from '@snpos/core';
import { useSession } from '../session';
import { humanError } from '../lib';

/**
 * Who is who in HIVE: each person on the POS matched, once, to their record
 * in HIVE, so a final count-difference deduction goes against the right
 * salary.
 *
 * The choices come from HIVE's own staff list, which HIVE sends here, so a
 * name cannot be mistyped. Until HIVE has sent it, the HIVE staff number is
 * typed. A match by the same email, or by a name nobody else has, is
 * suggested and never applied without an admin choosing it. Anybody not
 * matched is flagged, and their deductions are held until they are.
 */
export function HiveMatching({ rows, onSaved }: { rows: StaffProfile[]; onSaved: () => Promise<void> | void }) {
  const { profile } = useSession();
  const toast = useToast();
  const isAdmin = profile?.role === 'admin';
  const [staff, setStaff] = useState<HiveStaff[]>([]);
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState<Record<string, { id: string; name: string }>>({});

  useEffect(() => {
    void loadHiveStaff().then(setStaff);
    void loadFeatures().then((f) => setOn(isEnabled(f, COUNT_CHARGES))).catch(() => undefined);
  }, []);

  const people = useMemo(() => rows.filter((p) => p.active), [rows]);
  const taken = useMemo(() => new Set(people.map((p) => p.hive_staff_id).filter(Boolean) as string[]), [people]);
  const unmatched = people.filter((p) => !p.hive_staff_id);
  // Shown once it matters: the switch is on, or somebody has been matched already.
  if (!on && taken.size === 0 && staff.length === 0) return null;

  const save = async (p: StaffProfile, hive: { id: string; name: string } | null) => {
    setBusy(p.$id);
    setError(null);
    try {
      await setHiveMatch(p.$id, hive);
      toast(hive ? `${p.display_name} matched to ${hive.name || hive.id} in HIVE` : `${p.display_name} is no longer matched`);
      await onSaved();
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card
      title={`Matched to HIVE${unmatched.length ? ` · ${unmatched.length} not matched` : ''}`}
      help={(
        <>
          Final count-difference deductions go to HIVE against the person each one is matched to here. Anybody not
          matched is flagged, and their deductions are held until they are. A suggestion is only a suggestion.
        </>
      )}
    >
      {error && <Notice>{error}</Notice>}
      {staff.length === 0 && (
        <p className="small dim" style={{ marginTop: 0 }}>
          HIVE has not sent its staff list yet, so type each person&rsquo;s HIVE staff number. Once HIVE is connected,
          its list appears here to choose from.
        </p>
      )}
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>On the POS</th><th>Role</th><th>In HIVE</th><th>State</th></tr></thead>
          <tbody>
            {people.map((p) => {
              const hint = !p.hive_staff_id ? suggestHiveMatch(p, staff, taken) : null;
              const t = typed[p.$id] ?? { id: '', name: p.display_name };
              return (
                <tr key={p.$id}>
                  <td>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
                      <span className="who-av" aria-hidden="true">{initialsOf(p.display_name)}</span>
                      {p.display_name}
                    </span>
                  </td>
                  <td className="small dim" style={{ textTransform: 'capitalize' }}>{p.role}</td>
                  <td>
                    {staff.length > 0 ? (
                      <Select
                        aria-label={`${p.display_name} in HIVE`}
                        value={p.hive_staff_id ?? ''}
                        disabled={!isAdmin || busy === p.$id}
                        onChange={(e) => {
                          const h = staff.find((s) => s.hive_id === e.target.value);
                          void save(p, h ? { id: h.hive_id, name: h.name } : null);
                        }}
                      >
                        <option value="">Choose from HIVE…</option>
                        {staff
                          .filter((s) => s.active !== false || s.hive_id === p.hive_staff_id)
                          .map((s) => (
                            <option key={s.hive_id} value={s.hive_id} disabled={taken.has(s.hive_id) && s.hive_id !== p.hive_staff_id}>
                              {s.name} · {s.hive_id}
                            </option>
                          ))}
                        {p.hive_staff_id && !staff.some((s) => s.hive_id === p.hive_staff_id) && (
                          <option value={p.hive_staff_id}>{p.hive_name || p.hive_staff_id} · {p.hive_staff_id}</option>
                        )}
                      </Select>
                    ) : p.hive_staff_id ? (
                      <span>
                        {p.hive_name || p.display_name} · {p.hive_staff_id}{' '}
                        {isAdmin && <Button size="sm" variant="ghost" onClick={() => void save(p, null)}>Clear</Button>}
                      </span>
                    ) : isAdmin ? (
                      <span className="row row-wrap" style={{ gap: '0.4rem' }}>
                        <Input
                          aria-label={`${p.display_name}'s HIVE staff number`}
                          placeholder="HIVE staff number"
                          value={t.id}
                          style={{ maxWidth: '10rem' }}
                          onChange={(e) => setTyped({ ...typed, [p.$id]: { ...t, id: e.target.value } })}
                        />
                        <Button size="sm" disabled={!t.id.trim()} loading={busy === p.$id} onClick={() => void save(p, { id: t.id, name: t.name })}>
                          Match
                        </Button>
                      </span>
                    ) : <span className="dim">—</span>}
                    {hint && isAdmin && (
                      <div className="small" style={{ marginTop: '0.3rem' }}>
                        Suggested: {hint.name} · {hint.hive_id}{' '}
                        <Button size="sm" variant="ghost" onClick={() => void save(p, { id: hint.hive_id, name: hint.name })}>Use it</Button>
                      </div>
                    )}
                  </td>
                  <td>{p.hive_staff_id ? <Badge tone="ok">Matched</Badge> : <Badge tone="warn">Not matched</Badge>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
