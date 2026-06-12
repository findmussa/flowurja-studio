import { useEffect, useRef } from "react";
import { Terminal, Trash2, ChevronUp, ChevronDown } from "lucide-react";
import s from "./Console.module.css";

const LEVEL_CLASS = { info: s.lvInfo, ok: s.lvOk, warn: s.lvWarn, error: s.lvError };
const LEVEL_ICON  = { info: "·", ok: "✓", warn: "!", error: "✗" };

export default function Console({ open, height, onToggle, onDragStart, logs, onClear }) {
  const bodyRef = useRef(null);

  useEffect(() => {
    if (open && bodyRef.current)
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [logs, open]);

  return (
    <div
      className={s.console}
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
        <Terminal size={12} strokeWidth={1.8} style={{ color:"rgba(0,0,0,0.38)", flexShrink:0 }} />
        <span className={s.barLabel}>Console</span>
        <span className={`${s.statusDot} ${logs.length ? s.dotGreen : s.dotGray}`} />
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
        <div className={s.iconBtn} style={{ pointerEvents:"none" }}>
          {open
            ? <ChevronDown size={13} strokeWidth={2} />
            : <ChevronUp   size={13} strokeWidth={2} />}
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
