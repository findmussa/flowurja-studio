import { useEffect, useRef, useState } from "react";
import { Terminal, Trash2, ChevronUp } from "lucide-react";
import s from "./Console.module.css";

const LEVEL_CLASS = { info: s.lvInfo, ok: s.lvOk, warn: s.lvWarn, error: s.lvError };
const DOT_CLASS   = { idle: "dotIdle", active: "dotActive", error: "dotError" };
const LEVEL_ICON  = { info: "·", ok: "✓", warn: "!", error: "✗" };

export default function Console({ open, height, dragging, onToggle, onDragStart, logs, onClear }) {
  const bodyRef    = useRef(null);
  const prevLenRef = useRef(logs.length); // init to current so mount logs don't pulse
  const dotTimer   = useRef(null);
  const [dotState, setDotState] = useState("idle"); // "idle" | "active" | "error"

  useEffect(() => {
    if (open && bodyRef.current)
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [logs, open]);

  // LED dot: pulse on new log, red on error, reset to idle after 2s quiet
  useEffect(() => {
    if (logs.length === 0) {
      prevLenRef.current = 0;
      setDotState("idle");
      clearTimeout(dotTimer.current);
      return;
    }
    if (logs.length <= prevLenRef.current) return;
    prevLenRef.current = logs.length;

    const latest  = logs[logs.length - 1];
    const isError = latest?.level === "error";
    setDotState(isError ? "error" : "active");

    clearTimeout(dotTimer.current);
    dotTimer.current = setTimeout(() => setDotState("idle"), 2000);
  }, [logs]);

  useEffect(() => () => clearTimeout(dotTimer.current), []);

  return (
    <div
      className={`${s.console}${dragging ? ` ${s.consoleDragging}` : ""}`}
      data-no-drag
      style={{ height: open ? height : 28 }}
    >
      {/* Drag handle — only visible when open */}
      {open && (
        <div
          className={s.dragHandle}
          onMouseDown={onDragStart}
        />
      )}

      {/* Bar — click anywhere to toggle */}
      <div className={s.bar} onClick={onToggle}>
        <Terminal size={12} strokeWidth={1.8} style={{ color:"var(--tx-4)", flexShrink:0 }} />
        <div className={`${s.dot} ${s[DOT_CLASS[dotState]]}`} />
        <span className={s.barLabel}>Console</span>
        <span className={s.statusText}>
          {open
            ? `${logs.length} line${logs.length !== 1 ? "s" : ""}`
            : `${logs.length} messages`}
        </span>
        <button
          className={s.iconBtn}
          title="Clear"
          onClick={e => { e.stopPropagation(); onClear(); }}
        >
          <Trash2 size={12} strokeWidth={1.8} />
        </button>
        <div className={`${s.iconBtn} ${s.chevronBtn}`} style={{ pointerEvents:"none" }}>
          <ChevronUp size={13} strokeWidth={2} className={open ? s.chevronOpen : s.chevron} />
        </div>
      </div>

      {/* Log body */}
      {open && (
        <div className={s.body} ref={bodyRef}>
          {logs.length === 0 && (
            <p className={s.empty}>No output yet. Run a simulation to see logs.</p>
          )}
          {logs.map((log, i) => (
            <div key={i} className={s.line}>
              <span className={s.ts}>{log.ts}</span>
              <span className={`${s.lv} ${LEVEL_CLASS[log.level] || s.lvInfo}`}>
                {LEVEL_ICON[log.level] || "·"}
              </span>
              <span className={s.msg}>{log.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
