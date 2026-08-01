import { useRef, useState } from 'react';
import { Button, Notice } from '@snpos/ui';
import { uploadFile, deleteFile, previewUrl, validateImage } from '@snpos/core';
import type { FilePurpose, Settings } from '@snpos/core';
import { humanError } from '../lib';

/**
 * Upload one image and hand back its file ID.
 *
 * The previous file is removed after the new one is stored, never before — a
 * failed upload should not leave a record with no picture at all.
 */
export function ImageField({
  fileId,
  purpose,
  settings,
  onChange,
  label = 'Photo',
  hint,
}: {
  fileId?: string;
  purpose: FilePurpose;
  settings: Settings | null;
  onChange: (fileId: string | undefined) => void;
  label?: string;
  hint?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preview = previewUrl(fileId, purpose, settings, 240, 240);

  const pick = async (file: File) => {
    const problem = validateImage(file);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    const previous = fileId;
    try {
      const { fileId: newId } = await uploadFile(file, purpose, settings);
      onChange(newId);
      if (previous) await deleteFile(previous, purpose, settings).catch(() => undefined);
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <div className="field">
      <label>{label}</label>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div
          style={{
            width: 88, height: 88, flex: 'none', borderRadius: 'var(--radius-sm)',
            border: '1px dashed var(--border)', background: 'var(--surface-2)',
            display: 'grid', placeItems: 'center', overflow: 'hidden',
          }}
        >
          {preview ? (
            <img src={preview} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <span className="dim small">No photo</span>
          )}
        </div>
        <div className="stack" style={{ gap: '0.4rem' }}>
          <div className="row">
            <Button size="sm" onClick={() => input.current?.click()} loading={busy} type="button">
              {fileId ? 'Replace' : 'Upload'}
            </Button>
            {fileId && (
              <Button
                size="sm"
                variant="ghost"
                type="button"
                onClick={async () => {
                  const id = fileId;
                  onChange(undefined);
                  await deleteFile(id, purpose, settings).catch(() => undefined);
                }}
              >
                Remove
              </Button>
            )}
          </div>
          <span className="hint">{hint ?? 'JPG, PNG or WebP, up to 10 MB. Square photos look best.'}</span>
        </div>
      </div>
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/avif"
        style={{ display: 'none' }}
        onChange={(e) => e.target.files?.[0] && pick(e.target.files[0])}
      />
      {error && <div style={{ marginTop: '0.5rem' }}><Notice>{error}</Notice></div>}
    </div>
  );
}
