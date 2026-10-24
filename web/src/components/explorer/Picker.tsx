import { useCallback, useId, useMemo, useRef, useState } from 'react';
import { CaretDownIcon, CheckIcon } from '@phosphor-icons/react';
import { useDismiss } from '../../lib/hooks';
import { int } from '../../lib/format';
import type { Choice } from '../../lib/types';

interface Props {
  label: string;
  choices: Choice[];
  selected: string[];
  onChange: (values: string[]) => void;
  multiple?: boolean;
  search?: boolean;
  format?: (label: string) => string;
}

/** A filter button that opens a checkable, searchable list of values with their crash counts. */
export default function Picker({ label, choices, selected, onChange, multiple = true, search = false, format = (s) => s }: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();
  const close = useCallback(() => { setOpen(false); setQ(''); }, []);
  useDismiss(open, close, root);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? choices.filter((c) => c.label.toLowerCase().includes(needle)) : choices;
  }, [choices, q]);
  const pick = (v: string) => {
    if (multiple) onChange(selected.includes(v) ? selected.filter((s) => s !== v) : [...selected, v]);
    else { onChange(selected[0] === v ? [] : [v]); close(); }
  };
  const summary = selected.length === 0 ? 'All'
    : selected.length === 1 ? format(choices.find((c) => c.value === selected[0])?.label ?? selected[0])
      : `${selected.length} selected`;

  // Arrow keys move between options; the list is a group of checkboxes, so Space toggles natively.
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...(list.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  };

  return (
    <div className="picker" ref={root} onKeyDown={onKey}>
      <button type="button" className={`picker-btn${selected.length ? ' on' : ''}`} aria-expanded={open} aria-controls={id} title={summary}
        onClick={() => (open ? close() : setOpen(true))}>
        <span className="picker-label">{label}</span>
        <span className="picker-value">{summary}</span>
        <CaretDownIcon aria-hidden="true" />
      </button>
      {open && (
        <div className="picker-pop" id={id} role="dialog" aria-label={`${label} filter`}>
          {search && (
            <input className="picker-search" type="search" placeholder={`Search ${label.toLowerCase()}`} value={q}
              onChange={(e) => setQ(e.target.value)} autoFocus aria-label={`Search ${label.toLowerCase()}`} />
          )}
          <ul ref={list} role="group" aria-label={label}>
            {shown.map((c) => {
              const on = selected.includes(c.value);
              return (
                <li key={c.value}>
                  <button type="button" role={multiple ? 'checkbox' : 'radio'} aria-checked={on} onClick={() => pick(c.value)}
                    autoFocus={!search && on}>
                    <span className="check" aria-hidden="true">{on && <CheckIcon weight="bold" />}</span>
                    <span className="picker-name">{format(c.label)}</span>
                    <span className="picker-count num">{int(c.crashes)}</span>
                  </button>
                </li>
              );
            })}
            {shown.length === 0 && <li className="picker-empty">No match for “{q}”.</li>}
          </ul>
          {selected.length > 0 && (
            <button type="button" className="picker-clear" onClick={() => { onChange([]); close(); }}>Clear {label.toLowerCase()}</button>
          )}
        </div>
      )}
    </div>
  );
}
