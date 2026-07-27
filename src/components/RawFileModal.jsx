/**
 * Shared RawFileModal — full-screen overlay to view (and optionally edit) file content.
 *
 * Props:
 *   content          — file text to display
 *   filename         — shown as a monospace chip in the header
 *   fromDisk         — true when content was read from disk (not generated)
 *   filePath         — absolute path on disk (required to enable edit/save)
 *   hasDirtyWarning  — true when the file has unsaved changes (amber banner)
 *   onClose          — close handler
 *   onSaved          — called with new content string after a successful save
 *   onApply          — when provided: skip disk-save; call onApply(editedContent) on confirm.
 *                      Opens directly in edit mode (no warning dialog).
 */
import { useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import s from "./RawFileModal.module.css";

export default function RawFileModal({
  content,
  filename,
  fromDisk = false,
  filePath,
  hasDirtyWarning = false,
  onClose,
  onSaved,
  onApply,
}) {
  const [closing,      setClosing]      = useState(false);
  const [showWarning,  setShowWarning]  = useState(false);
  const [editing,      setEditing]      = useState(!!onApply);
  const [editContent,  setEditContent]  = useState(content);
  const [saving,       setSaving]       = useState(false);
  const [saveError,    setSaveError]    = useState("");

  const handleClose = () => {
    if (closing) return;
    setClosing(true);
    setTimeout(onClose, 200);
  };

  const handleEditClick = () => {
    if (onApply) {
      setEditing(true);
      setEditContent(content);
    } else {
      setShowWarning(true);
    }
  };

  const handleEditAnyway = () => {
    setShowWarning(false);
    setEditing(true);
    setEditContent(content);
  };

  const handleDiscard = () => {
    setEditing(false);
    setEditContent(content);
    setSaveError("");
  };

  const handleApply = () => {
    let applyErr = null;
    try {
      onApply(editContent);
    } catch (e) {
      applyErr = e;
    }
    if (applyErr) {
      setSaveError(String(applyErr));
      toast.error("Apply failed", { description: String(applyErr).slice(0, 100) });
      return;
    }
    const fn = filename;
    setClosing(true);
    setTimeout(() => {
      toast.success("Applied", { description: fn });
      onClose?.();
    }, 210);
  };

  const handleSave = async () => {
    if (!filePath || saving) return;
    setSaving(true);
    setSaveError("");
    try {
      await invoke("write_text_file", { path: filePath, content: editContent });
      let reloadErr = null;
      try { await onSaved?.(editContent); } catch (e) { reloadErr = e; }
      setSaving(false);
      // Exit animation first, then show toast once the modal is gone
      setClosing(true);
      const saved = filename;
      setTimeout(() => {
        if (!reloadErr) {
          toast.success("Saved", { description: saved });
        } else {
          toast.warning("Saved — validation failed", { description: "UI not updated — see Console for details" });
        }
        onClose?.();
      }, 210);
    } catch (err) {
      setSaveError(String(err));
      toast.error("Save failed", { description: String(err).slice(0, 100) });
      setSaving(false);
    }
  };

  const subtitle = editing
    ? onApply
      ? "Editing — generated preview"
      : "Editing — unsaved changes"
    : fromDisk
      ? "Actual file on disk"
      : "Preview — not yet saved to disk";

  return createPortal(
    <div
      onMouseDown={e => e.stopPropagation()}
      className={`${s.overlay}${closing ? ` ${s.overlayExit}` : ""}`}
      style={{
        position: "fixed", inset: 0, zIndex: 99998,
        background: "rgba(0,0,0,0.46)",
        WebkitBackdropFilter: "blur(4px)",
        backdropFilter: "blur(4px)",
        display: "flex", alignItems: "center", justifyContent: "center", padding: 24,
      }}
      onClick={!editing ? handleClose : undefined}
    >
      <div
        onClick={e => e.stopPropagation()}
        className={`${s.card}${closing ? ` ${s.cardExit}` : ""}`}
        style={{
          background: "var(--bg-app)", borderRadius: 12, overflow: "hidden",
          width: "min(860px, 90vw)", height: "min(600px, 80vh)",
          display: "flex", flexDirection: "column",
          boxShadow: "0 24px 80px rgba(0,0,0,0.40)",
          border: "0.5px solid var(--bd)",
          position: "relative",
        }}
      >
        {/* ── Header ── */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "12px 16px", borderBottom: "0.5px solid var(--bd-subtle)",
          background: "var(--bg-header)", flexShrink: 0, gap: 8,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            {filename && (
              <span style={{
                fontSize: 11, fontFamily: "'SF Mono',ui-monospace,monospace",
                background: "var(--bg-pill)", padding: "2px 8px", borderRadius: 5,
                color: "var(--tx-3)", flexShrink: 0,
              }}>{filename}</span>
            )}
            <span style={{
              fontSize: 11.5,
              color: editing ? "#D97706" : "var(--tx-5)",
              fontWeight: editing ? 500 : 400,
            }}>{subtitle}</span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
            {editing ? (<>
              <button onClick={handleDiscard} className={s.discardBtn} disabled={saving}>
                Discard
              </button>
              {onApply ? (
                <button onClick={handleApply} className={s.saveBtn}>
                  Apply
                </button>
              ) : (
                <button onClick={handleSave} className={s.saveBtn} disabled={saving}>
                  {saving ? "Saving…" : "Save"}
                </button>
              )}
            </>) : (<>
              {(fromDisk && filePath || !!onApply) && (
                <button onClick={handleEditClick} className={s.editBtn}>
                  {onApply ? "Edit" : "Edit file"}
                </button>
              )}
              <button onClick={handleClose} className={s.closeBtn}>
                Close ×
              </button>
            </>)}
          </div>
        </div>

        {/* ── Save error banner ── */}
        {saveError && (
          <div style={{
            display: "flex", alignItems: "center", gap: 7,
            padding: "7px 16px", flexShrink: 0,
            background: "rgba(239,68,68,0.10)",
            borderBottom: "0.5px solid rgba(239,68,68,0.30)",
          }}>
            <span style={{ fontSize: 11.5, color: "#DC2626", fontWeight: 500 }}>
              Save failed: {saveError}
            </span>
          </div>
        )}

        {/* ── Unsaved changes banner (view mode only) ── */}
        {!editing && hasDirtyWarning && (
          <div style={{
            display: "flex", alignItems: "center", gap: 7,
            padding: "7px 16px", flexShrink: 0,
            background: "rgba(245,158,11,0.10)",
            borderBottom: "0.5px solid rgba(245,158,11,0.30)",
          }}>
            <span style={{ fontSize: 13, lineHeight: 1 }}>⚠</span>
            <span style={{ fontSize: 11.5, color: "#B45309", fontWeight: 500 }}>
              You have unsaved changes — this shows the file as last saved to disk
            </span>
          </div>
        )}

        {/* ── Content: view or edit ── */}
        {editing ? (
          <textarea
            className={s.editArea}
            value={editContent}
            onChange={e => setEditContent(e.target.value)}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
        ) : (
          <pre style={{
            flex: 1, overflow: "auto", margin: 0, padding: "14px 18px",
            fontSize: 11.5, lineHeight: 1.65,
            fontFamily: "'SF Mono','Fira Code','JetBrains Mono',ui-monospace,monospace",
            color: "var(--tx-2)", background: "var(--bg-app)", whiteSpace: "pre",
          }}>{content}</pre>
        )}

        {/* ── Warning dialog overlay ── */}
        {showWarning && (
          <div className={s.warnOverlay}>
            <div className={s.warnCard}>
              <div className={s.warnIcon}>
                <AlertTriangle size={22} strokeWidth={1.8} />
              </div>
              <h3 className={s.warnTitle}>Edit with care</h3>
              <p className={s.warnBody}>
                <code className={s.warnCode}>{filename}</code> uses strict whitespace and
                formatting rules. Incorrect spacing, missing values, or broken comments can
                cause OpenFAST to fail silently or crash.
              </p>
              <p className={s.warnBody} style={{ marginTop: 6 }}>
                Only edit if you know exactly what you're changing.
              </p>
              <div className={s.warnFooter}>
                <button className={s.warnCancel} onClick={() => setShowWarning(false)}>
                  Cancel
                </button>
                <button className={s.warnConfirm} onClick={handleEditAnyway}>
                  Edit anyway
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
