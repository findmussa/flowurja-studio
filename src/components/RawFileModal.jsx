/**
 * Shared RawFileModal — full-screen overlay to view file content.
 *
 * Props:
 *   content          — file text to display
 *   filename         — shown as a monospace chip in the header
 *   fromDisk         — true when content was read from disk (not generated)
 *   hasDirtyWarning  — true when the file has unsaved changes (amber banner)
 *   onClose          — close handler
 */
import { createPortal } from "react-dom";

export default function RawFileModal({ content, filename, fromDisk = false, hasDirtyWarning = false, onClose }) {
  const subtitle = fromDisk
    ? "Actual file on disk"
    : "Preview — not yet saved to disk";

  return createPortal(
    <div
      onMouseDown={e => e.stopPropagation()}
      style={{
        position: "fixed", inset: 0, zIndex: 99998,
        background: "rgba(0,0,0,0.52)",
        display: "flex", alignItems: "center", justifyContent: "center", padding: 24,
      }}
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: "var(--bg-app)", borderRadius: 12, overflow: "hidden",
          width: "min(860px, 90vw)", height: "min(600px, 80vh)",
          display: "flex", flexDirection: "column",
          boxShadow: "0 24px 80px rgba(0,0,0,0.40)",
          border: "0.5px solid var(--bd)",
        }}
      >
        {/* Modal header */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "12px 16px", borderBottom: "0.5px solid var(--bd-subtle)",
          background: "var(--bg-header)", flexShrink: 0,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {filename && (
              <span style={{
                fontSize: 11, fontFamily: "'SF Mono',ui-monospace,monospace",
                background: "var(--bg-pill)", padding: "2px 8px", borderRadius: 5,
                color: "var(--tx-3)",
              }}>{filename}</span>
            )}
            <span style={{ fontSize: 11.5, color: "var(--tx-5)" }}>{subtitle}</span>
          </div>
          <button
            onClick={onClose}
            style={{
              border: "none", background: "var(--bg-pill)", cursor: "pointer",
              borderRadius: 6, padding: "4px 10px", fontSize: 12,
              color: "var(--tx-3)", fontFamily: "inherit",
            }}
          >Close ×</button>
        </div>

        {/* Unsaved changes banner */}
        {hasDirtyWarning && (
          <div style={{
            display: "flex", alignItems: "center", gap: 7,
            padding: "7px 16px",
            background: "rgba(245,158,11,0.10)",
            borderBottom: "0.5px solid rgba(245,158,11,0.30)",
            flexShrink: 0,
          }}>
            <span style={{ fontSize: 13, lineHeight: 1 }}>⚠</span>
            <span style={{ fontSize: 11.5, color: "#B45309", fontWeight: 500 }}>
              You have unsaved changes — this shows the file as last saved to disk
            </span>
          </div>
        )}

        {/* File content */}
        <pre style={{
          flex: 1, overflow: "auto", margin: 0, padding: "14px 18px",
          fontSize: 11.5, lineHeight: 1.65,
          fontFamily: "'SF Mono','Fira Code','JetBrains Mono',ui-monospace,monospace",
          color: "var(--tx-2)", background: "var(--bg-app)", whiteSpace: "pre",
        }}>{content}</pre>
      </div>
    </div>,
    document.body
  );
}
