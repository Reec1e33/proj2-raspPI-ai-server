import { Eye, EyeOff, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type SubmitEvent } from 'react';
import { getApiKey, setApiKey } from '../lib/settings';

function SettingsForm({ titleId, onDone }: { titleId: string; onDone: () => void }) {
  const [value, setValue] = useState(getApiKey);
  const [visible, setVisible] = useState(false);
  const inputId = useId();
  const hintId = useId();

  const save = (event: SubmitEvent) => {
    event.preventDefault();
    setApiKey(value);
    onDone();
  };

  return (
    <form onSubmit={save} className="flex flex-col gap-4 p-5">
      <div className="flex items-start justify-between gap-4">
        <h2 id={titleId} className="text-base font-semibold">
          Settings
        </h2>
        <button type="button" className="btn-ghost -m-1.5 p-1.5" onClick={onDone}>
          <X aria-hidden className="size-4" />
          <span className="sr-only">Close</span>
        </button>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={inputId} className="text-sm font-medium">
          API key
        </label>
        <div className="flex gap-2">
          <input
            id={inputId}
            type={visible ? 'text' : 'password'}
            className="input min-w-0 flex-1 font-mono"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            aria-describedby={hintId}
          />
          <button
            type="button"
            className="btn-ghost border border-line-strong"
            aria-pressed={visible}
            onClick={() => setVisible((v) => !v)}
          >
            {visible ? (
              <EyeOff aria-hidden className="size-4" />
            ) : (
              <Eye aria-hidden className="size-4" />
            )}
            <span className="sr-only">Show key</span>
          </button>
        </div>
        <p id={hintId} className="text-xs text-ink-secondary">
          Only needed when the server sets <code className="font-mono">PICLOUD_API_KEY</code>. The
          key stays in this browser (localStorage) and is sent as the{' '}
          <code className="font-mono">X-API-Key</code> header with chat requests.
        </p>
      </div>

      <div className="flex justify-end gap-2">
        <button
          type="button"
          className="btn-ghost mr-auto"
          onClick={() => {
            setApiKey('');
            onDone();
          }}
        >
          Remove key
        </button>
        <button type="button" className="btn-ghost" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="btn-primary">
          Save
        </button>
      </div>
    </form>
  );
}

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

/** Modal settings. The native <dialog> provides focus trapping and Escape to close. */
export function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      className="panel m-auto w-[min(28rem,calc(100%-2rem))] p-0 text-ink backdrop:bg-[rgb(0_0_0/0.6)]"
    >
      {/* Mounted only while open, so the form starts from the stored key each time. */}
      {open && <SettingsForm titleId={titleId} onDone={() => ref.current?.close()} />}
    </dialog>
  );
}
