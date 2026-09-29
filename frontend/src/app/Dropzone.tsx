/**
 * The upload target.
 *
 * Drag state is the only motion, and it is a border/background change plus a 1%
 * scale — enough to confirm the browser is listening, small enough not to jump.
 * Dragging a file is a deliberate, occasional act, so this sits in the tier where
 * standard animation is fine.
 *
 * The counter matters: `dragenter`/`dragleave` fire for every child element, so
 * tracking a boolean makes the highlight flicker as the pointer crosses the label.
 */
import clsx from 'clsx';
import { useCallback, useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { bytes } from '../lib/format';

const ACCEPT = 'video/mp4,video/quicktime,video/x-matroska,video/webm,video/*';

export function Dropzone({
  onPick,
  disabled,
  maxSeconds,
}: {
  onPick: (file: File) => void;
  disabled?: boolean;
  /** The plan's length cap. Undefined while the entitlement is still loading, in
   *  which case the cap is left unsaid rather than guessed at. */
  maxSeconds?: number;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const depth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [rejected, setRejected] = useState<string | null>(null);

  const accept = useCallback(
    (files: FileList | null) => {
      setRejected(null);
      const file = files?.[0];
      if (!file) return;
      if (!file.type.startsWith('video/')) {
        setRejected(`${file.name} is not a video file.`);
        return;
      }
      onPick(file);
    },
    [onPick],
  );

  return (
    <div>
      <div
        onDragEnter={(e) => {
          e.preventDefault();
          depth.current += 1;
          setDragging(true);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={(e) => {
          e.preventDefault();
          depth.current -= 1;
          if (depth.current <= 0) {
            depth.current = 0;
            setDragging(false);
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          depth.current = 0;
          setDragging(false);
          if (!disabled) accept(e.dataTransfer.files);
        }}
        className={clsx(
          'relative grid place-items-center rounded-[var(--radius-card)] border-2 border-dashed',
          'px-6 py-14 text-center',
          'transition-[border-color,background-color,transform] duration-[200ms]',
          'ease-[var(--ease-out-strong)] motion-reduce:transition-none',
          disabled && 'pointer-events-none opacity-50',
          dragging
            ? 'scale-[1.01] border-fg-subtle bg-white/[0.04]'
            : 'border-ink-700 bg-ink-900/60 hover:border-ink-750',
        )}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          disabled={disabled}
          className="sr-only"
          onChange={(e) => accept(e.target.files)}
        />

        <div>
          <div
            className={clsx(
              'mx-auto grid size-12 place-items-center rounded-full',
              'transition-[background-color,transform] duration-[200ms] ease-[var(--ease-out-strong)]',
              dragging ? 'scale-110 bg-ink-750' : 'bg-ink-800',
            )}
          >
            <svg viewBox="0 0 24 24" className="size-5 text-fg" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 16V4m0 0L8 8m4-4 4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
            </svg>
          </div>

          <p className="mt-4 text-lead font-medium">
            {dragging ? 'Drop it here' : 'Drag a video in, or choose a file'}
          </p>
          <p className="mt-1.5 text-small text-fg-subtle">
            MP4, MOV, MKV or WebM
            {maxSeconds ? ` · up to ${Math.floor(maxSeconds / 60) || 1} min on your plan` : ''}
          </p>

          <Button
            type="button"
            variant="secondary"
            className="mt-5"
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
          >
            Select a file
          </Button>
        </div>
      </div>

      {rejected && (
        <p role="alert" className="mt-3 text-small text-bad">
          {rejected}
        </p>
      )}
    </div>
  );
}

export function FileSummary({
  file,
  onClear,
}: {
  file: File;
  onClear: () => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-ink-700 bg-ink-850 px-4 py-3">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-ink-800">
        <svg viewBox="0 0 24 24" className="size-4 text-fg" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
          <path d="m10 9 5 3-5 3V9Z" />
          <rect x="3" y="4" width="18" height="16" rx="2" />
        </svg>
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-small font-medium">{file.name}</p>
        <p className="text-tiny text-fg-subtle">{bytes(file.size)}</p>
      </div>
      <button
        type="button"
        onClick={onClear}
        aria-label="Remove this file"
        className="grid size-8 place-items-center rounded-lg text-fg-subtle transition-colors duration-[160ms] hover:bg-ink-800 hover:text-fg"
      >
        <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  );
}
