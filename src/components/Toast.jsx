import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { Play, CheckCircle2, XCircle, Square, X } from "lucide-react";
import s from "./Toast.module.css";

function ToastItem({ toast, onDismiss }) {
  const [closing, setClosing] = useState(false);
  const timerRef = useRef(null);

  const dismiss = useCallback(() => {
    if (closing) return;
    setClosing(true);
    setTimeout(() => onDismiss(toast.id), 260);
  }, [closing, onDismiss, toast.id]);

  useEffect(() => {
    if (toast.duration > 0) {
      timerRef.current = setTimeout(dismiss, toast.duration);
    }
    return () => clearTimeout(timerRef.current);
  // dismiss identity is stable within one mount because closing starts false
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const icon = {
    info:    <Play         size={15} strokeWidth={2} style={{ fill: "currentColor", stroke: "none" }} />,
    success: <CheckCircle2 size={15} strokeWidth={2} />,
    error:   <XCircle      size={15} strokeWidth={2} />,
    warn:    <Square       size={14} strokeWidth={2} style={{ fill: "currentColor", stroke: "none" }} />,
  }[toast.type];

  return (
    <div className={[s.toast, s[toast.type], closing ? s.closing : ""].filter(Boolean).join(" ")}>
      <div className={s.iconWrap}>{icon}</div>
      <div className={s.body}>
        <p className={s.title}>{toast.title}</p>
        {toast.message && <p className={s.msg}>{toast.message}</p>}
      </div>
      <button className={s.closeBtn} onClick={dismiss} aria-label="Dismiss">
        <X size={13} strokeWidth={2.5} />
      </button>
      {toast.duration > 0 && (
        <div
          className={s.progress}
          style={{ animation: `progressShrink ${toast.duration}ms linear both` }}
        />
      )}
    </div>
  );
}

export function Toaster({ toasts, onDismiss }) {
  return createPortal(
    <div className={s.container}>
      {toasts.map(t => (
        <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>,
    document.body
  );
}

let _nextId = 1;

export function useToasts() {
  const [toasts, setToasts] = useState([]);

  const remove = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const add = useCallback((type, title, message = "", duration = 4000) => {
    const id = _nextId++;
    setToasts(prev => [...prev, { id, type, title, message, duration }]);
  }, []);

  return { toasts, add, remove };
}
