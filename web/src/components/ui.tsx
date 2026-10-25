// Shared UI primitives: the segmented control used for every toggle group, and the rolling number
// used for the key figures.
import { useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react';

/*
 * Two pieces adapted from EasyUI (github.com/Surajmaurya1/easyui, MIT): AnimatedTabs' sliding indicator
 * and AnimatedNumber's rolling digits, rewritten with CSS transitions instead of framer-motion.
 */

const ON = ':scope > [aria-pressed="true"], :scope > [aria-selected="true"], :scope > [aria-current="page"]';

/**
 * A row of pill buttons or links. The selected child (aria-pressed, aria-selected or aria-current) gets an
 * ink thumb that slides to it; with `multi`, each pressed child is filled instead and there is no thumb.
 */
export function Seg({ children, className = '', multi = false, as: Tag = 'div', ...rest }:
  { children: ReactNode; multi?: boolean; as?: 'div' | 'fieldset' | 'nav' } & HTMLAttributes<HTMLElement>) {
  const ref = useRef<HTMLElement>(null);
  const thumb = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current, t = thumb.current;
    if (!el || !t) return;
    let first = true;
    const place = () => {
      const on = el.querySelector<HTMLElement>(ON);
      t.style.opacity = on ? '1' : '0';
      if (!on) return;
      // The first placement jumps into place; later ones slide. Reading offsetWidth forces the jump to apply.
      if (first) t.style.transition = 'none';
      t.style.width = `${on.offsetWidth}px`;
      t.style.transform = `translateX(${on.offsetLeft}px)`;
      if (first) { void t.offsetWidth; t.style.transition = ''; first = false; }
    };
    place();
    // Follow selection changes made anywhere (React or not) and changes of the buttons' widths.
    const mo = new MutationObserver(place);
    mo.observe(el, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-pressed', 'aria-selected', 'aria-current'] });
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => { mo.disconnect(); ro.disconnect(); };
  }, [multi]);
  return (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    <Tag ref={ref as any} className={`seg${multi ? ' multi' : ''} ${className}`} {...rest}>
      {!multi && <span ref={thumb} className="seg-thumb" aria-hidden="true" />}
      {children}
    </Tag>
  );
}

const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

/** A formatted number whose digits roll to their value, from zero on first show. */
export function Rolling({ text }: { text: string }) {
  const [shown, setShown] = useState(false);
  useEffect(() => { const r = requestAnimationFrame(() => setShown(true)); return () => cancelAnimationFrame(r); }, []);
  const chars = [...text];
  return (
    <span className="roll">
      <span className="sr-only">{text}</span>
      {chars.map((ch, i) => {
        const key = chars.length - i; // keyed from the right, so units stay units when the length changes
        if (!/\d/.test(ch)) return <span key={key} aria-hidden="true">{ch}</span>;
        return (
          <span key={key} className="roll-d" aria-hidden="true">
            <span style={{ transform: `translateY(-${(shown ? Number(ch) : 0) * 10}%)` }}>
              {DIGITS.map((d) => <i key={d}>{d}</i>)}
            </span>
          </span>
        );
      })}
    </span>
  );
}
