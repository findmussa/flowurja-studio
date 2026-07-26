import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { Play, CheckCircle2, XCircle, Square, X } from "lucide-react";
import s from "./Toast.module.css";

// ── Global event bus ─────────────────────────────────────────────────────────
let _nextId = 1;
const _subs  = new Set();

function _emit(type, title, message, duration) {
  const item = { id: _nextId++, type, title, message, duration };
  _subs.forEach(fn => fn(item));
}

export const toast = {
  info:    (title, message = "", duration = 4000) => _emit("info",    title, message, duration),
  success: (title, message = "", duration = 4000) => _emit("success", title, message, duration),
  warn:    (title, message = "", duration = 5000) => _emit("warn",    title, message, duration),
  error:   (title, message = "", duration = 0)    => _emit("error",   title, message, duration),
};

// ── ToastItem ─────────────────────────────────────────────────────────────────
function ToastItem({ toast: t, onDismiss }) {
  const [closing, setClosing] = useState(false);
  const timerRef = useRef(null);

  const dismiss = useCallback(() => {
    if (closing) return;
    setClosing(true);
    setTimeout(() => onDismiss(t.id), 260);
  }, [closing, onDismiss, t.id]);

  useEffect(() => {
    if (t.duration > 0) {
      timerRef.current = setTimeout(dismiss, t.duration);
    }
    return () => clearTimeout(timerRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const icon = {
    info:    <Play         size={15} strokeWidth={2} style={{ fill: "currentColor", stroke: "none" }} />,
    success: <CheckCircle2 size={15} strokeWidth={2} />,
    error:   <XCircle      size={15} strokeWidth={2} />,
    warn:    <Square       size={14} strokeWidth={2} style={{ fill: "currentColor", stroke: "none" }} />,
  }[t.type];

  return (
    <div className={[s.toast, s[t.type], closing ? s.closing : ""].filter(Boolean).join(" ")}>
      <div className={s.iconWrap}>{icon}</div>
      <div className={s.body}>
        <p className={s.title}>{t.title}</p>
        {t.message && <p className={s.msg}>{t.message}</p>}
      </div>
      <button className={s.closeBtn} onClick={dismiss} aria-label="Dismiss">
        <X size={13} strokeWidth={2.5} />
      </button>
      {t.duration > 0 && (
        <div
          className={s.progress}
          style={{ animation: `progressShrink ${t.duration}ms linear both` }}
        />
      )}
    </div>
  );
}

// ── Toaster — global singleton, Sonner-style stacking ────────────────────────
const PEEK = 10;  // px each back-toast peeks below the front in collapsed mode
const STEP = 88;  // px offset per toast in expanded mode (≈ toast height + gap)

export function Toaster() {
  const [items,    setItems]    = useState([]);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const handler = item => setItems(prev => [...prev, item]);
    _subs.add(handler);
    return () => _subs.delete(handler);
  }, []);

  const remove = useCallback(id => {
    setItems(prev => prev.filter(t => t.id !== id));
  }, []);

  if (!items.length) return null;

  // Newest first so index 0 = front card
  const stack = [...items].reverse().slice(0, 3);
  const count = stack.length;

  return createPortal(
    <div
      className={s.container}
      onMouseEnter={() => count > 1 && setExpanded(true)}
      onMouseLeave={() => setExpanded(false)}
    >
      {stack.map((t, idx) => (
        <div
          key={t.id}
          className={s.slot}
          style={{
            transform: expanded
              ? `translateY(${idx * STEP}px) scale(1)`
              : `translateY(${idx * PEEK}px) scale(${(1 - idx * 0.05).toFixed(3)})`,
            opacity: expanded ? 1 : [1, 0.82, 0.64][idx] ?? 0.64,
            zIndex: count - idx,
          }}
        >
          <ToastItem toast={t} onDismiss={remove} />
        </div>
      ))}
    </div>,
    document.body
  );
}

// ── useToasts — backward-compat shim ─────────────────────────────────────────
export function useToasts() {
  const add = useCallback((type, title, message = "", duration) => {
    const defaults = { info: 4000, success: 4000, warn: 5000, error: 0 };
    _emit(type, title, message, duration ?? defaults[type] ?? 4000);
  }, []);
  return { add };
}
