/**
 * Shared InfoPopover — the ⓘ button used across all panels.
 * Usage:
 *   <InfoPopover content={{ param, desc, range, default: def, unit, note }} />
 */
import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";

// Module-level singleton: only one popover open at a time
let _closeCurrentPopover = null;

export default function InfoPopover({ content, accentColor = "#185FA5" }) {
  const [open, setOpen] = useState(false);
  const [pos,  setPos]  = useState({ top: 0, left: 0 });
  const btnRef     = useRef(null);
  const popoverRef = useRef(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const close = (e) => {
      if (e.target.closest?.("[data-fws-popover]")) return;
      if (btnRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const id = setTimeout(() => document.addEventListener("mousedown", close), 10);
    return () => { clearTimeout(id); document.removeEventListener("mousedown", close); };
  }, [open]);

  // After popover mounts, check if it overflows the bottom and flip upward if needed.
  useEffect(() => {
    if (!open || !popoverRef.current) return;
    const pop = popoverRef.current.getBoundingClientRect();
    const overflow = pop.bottom - window.innerHeight;
    if (overflow > 0) {
      // Flip above the button: button top minus popover height minus gap
      const r = btnRef.current.getBoundingClientRect();
      const flippedTop = r.top - pop.height - 6;
      setPos(prev => ({ ...prev, top: Math.max(4, flippedTop) }));
    }
  }, [open]);

  if (!content) return null;

  const POPUP_W = 268;

  const toggle = (e) => {
    e.stopPropagation();
    if (!open) {
      // Close whatever is currently open (another instance)
      if (_closeCurrentPopover && _closeCurrentPopover !== setOpen) {
        _closeCurrentPopover(false);
      }
      _closeCurrentPopover = setOpen;
      const r = btnRef.current.getBoundingClientRect();
      let left = r.left;
      if (left + POPUP_W > window.innerWidth - 8) left = window.innerWidth - POPUP_W - 8;
      if (left < 8) left = 8;
      setPos({ top: r.bottom + 6, left });
      setOpen(true);
    } else {
      if (_closeCurrentPopover === setOpen) _closeCurrentPopover = null;
      setOpen(false);
    }
  };

  return (
    <span style={{ display: "inline-flex", alignItems: "center", flexShrink: 0 }}>
      <button
        ref={btnRef}
        type="button"
        onMouseDown={e => e.stopPropagation()}
        onClick={toggle}
        style={{
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          width: 16, height: 16, border: "none", background: "transparent",
          cursor: "pointer", borderRadius: "50%", color: "var(--tx-5)",
          padding: 0, flexShrink: 0,
        }}
        onMouseEnter={e => e.currentTarget.style.color = accentColor}
        onMouseLeave={e => e.currentTarget.style.color = "var(--tx-5)"}
      >
        <Info size={11} strokeWidth={2.5} />
      </button>

      {open && createPortal(
        <div
          ref={popoverRef}
          data-fws-popover="true"
          onMouseDown={e => e.stopPropagation()}
          style={{
            position: "fixed", top: pos.top, left: pos.left, zIndex: 99999,
            width: POPUP_W,
            background: "var(--bg-popover, rgba(255,255,255,0.82))",
            WebkitBackdropFilter: "blur(20px) saturate(1.8)",
            backdropFilter: "blur(20px) saturate(1.8)",
            border: "0.5px solid var(--bd-popover, rgba(0,0,0,0.10))",
            borderRadius: 10,
            padding: "12px 14px",
            boxShadow: "0 8px 32px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.10)",
            fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
          }}
        >
          {content.param && (
            <p style={{
              fontSize: 11, fontWeight: 700, color: accentColor,
              fontFamily: "'SF Mono','Fira Code',ui-monospace,monospace",
              marginBottom: 5,
            }}>{content.param}</p>
          )}
          <p style={{ fontSize: 11.5, color: "var(--tx-2)", lineHeight: 1.55, marginBottom: 8 }}>
            {content.desc}
          </p>
          {(content.range || content.default || content.unit) && (
            <div style={{
              background: "var(--bg-muted)", borderRadius: 6, padding: "6px 8px",
              marginBottom: content.note ? 6 : 0,
            }}>
              {[
                { l: "Range",   val: content.range   },
                { l: "Default", val: content.default  },
                { l: "Unit",    val: content.unit     },
              ].filter(r => r.val).map(r => (
                <div key={r.l} style={{ display: "flex", gap: 6, fontSize: 11, marginBottom: 2 }}>
                  <span style={{ color: "var(--tx-4)", minWidth: 52, fontWeight: 600, flexShrink: 0 }}>{r.l}:</span>
                  <span style={{ color: "var(--tx-2)", fontFamily: "'SF Mono',ui-monospace,monospace", fontSize: 10.5 }}>{r.val}</span>
                </div>
              ))}
            </div>
          )}
          {content.note && (
            <p style={{
              fontSize: 11, color: "var(--tx-3)", lineHeight: 1.5, fontStyle: "italic",
              paddingTop: 6, borderTop: "0.5px solid var(--bd-subtle)", marginTop: 4,
            }}>{content.note}</p>
          )}
        </div>,
        document.body
      )}
    </span>
  );
}
