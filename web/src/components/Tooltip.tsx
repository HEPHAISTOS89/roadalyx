import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

interface Tip { x: number; y: number; content: ReactNode }
const Ctx = createContext<(t: Tip | null) => void>(() => {});

/** One tooltip for the whole page, placed next to the pointer and kept inside the viewport. */
export function TooltipLayer({ children }: { children: ReactNode }) {
  const [tip, setTip] = useState<Tip | null>(null);
  const flipX = tip && tip.x > window.innerWidth - 280;
  const flipY = tip && tip.y > window.innerHeight - 160;
  return (
    <Ctx.Provider value={setTip}>
      {children}
      {tip && (
        <div className="tip" role="presentation" style={{
          left: flipX ? undefined : tip.x + 14, right: flipX ? window.innerWidth - tip.x + 14 : undefined,
          top: flipY ? undefined : tip.y + 14, bottom: flipY ? window.innerHeight - tip.y + 14 : undefined,
        }}>{tip.content}</div>
      )}
    </Ctx.Provider>
  );
}

export function useTip() {
  const set = useContext(Ctx);
  const show = useCallback((e: { clientX: number; clientY: number }, content: ReactNode) => set({ x: e.clientX, y: e.clientY, content }), [set]);
  const hide = useCallback(() => set(null), [set]);
  return { show, hide };
}
