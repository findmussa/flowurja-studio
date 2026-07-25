/**
 * DatFileEditor — generic editable view for any OpenFAST .dat file.
 *
 * Props:
 *   accentColor  {string}   CSS colour for the Save button + selection highlight
 *   moduleName   {string}   e.g. "ElastoDyn" — shown in empty state
 *   filePath     {string}   optional initial file path (from project state)
 *   onLog        {fn}       (level, text) → parent console
 *   onFilePath   {fn}       (path) → called when user picks / changes file
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { invoke }              from "@tauri-apps/api/core";
import { open as openDialog }  from "@tauri-apps/plugin-dialog";
import { FolderOpen, RotateCcw, Save, FileText } from "lucide-react";
import s from "./DatFileEditor.module.css";

export default function DatFileEditor({
  accentColor = "#0891B2",
  moduleName  = "module",
  filePath: propFilePath = "",
  onLog,
  onFilePath,
}) {
  const [filePath, setFilePath] = useState(propFilePath || "");
  const [content,  setContent]  = useState("");
  const [original, setOriginal] = useState("");   // last saved / loaded state
  const [loading,  setLoading]  = useState(false);
  const textRef = useRef(null);

  const isDirty  = content !== original;
  const lineCount = content ? content.split("\n").length : 0;

  // Sync external file path changes (e.g. from OpenFAST import)
  useEffect(() => {
    if (propFilePath && propFilePath !== filePath) {
      setFilePath(propFilePath);
    }
  }, [propFilePath]);

  // Auto-load when filePath changes
  useEffect(() => {
    if (!filePath) return;
    loadFile(filePath);
  }, [filePath]);

  const loadFile = async (path) => {
    setLoading(true);
    try {
      const text = await invoke("read_text_file", { path });
      setContent(text);
      setOriginal(text);
      onLog?.("ok", `Loaded ${path.split("/").pop()}`);
    } catch (err) {
      onLog?.("error", `Could not read ${path}: ${String(err)}`);
      setContent("");
      setOriginal("");
    } finally {
      setLoading(false);
    }
  };

  const handleBrowse = async () => {
    try {
      const f = await openDialog({ multiple: false, directory: false });
      if (!f) return;
      setFilePath(f);
      onFilePath?.(f);
    } catch {}
  };

  const handleReload = () => {
    if (!filePath) return;
    loadFile(filePath);
  };

  const handleSave = useCallback(async () => {
    if (!filePath || !isDirty) return;
    try {
      await invoke("write_text_file", { path: filePath, content });
      setOriginal(content);
      onLog?.("ok", `Saved ${filePath.split("/").pop()}`);
    } catch (err) {
      onLog?.("error", `Save failed: ${String(err)}`);
    }
  }, [filePath, content, isDirty]);

  // Cmd/Ctrl+S to save
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleSave]);

  // Short display path
  const displayPath = filePath
    ? filePath.replace(/\\/g, "/").split("/").slice(-3).join("/")
    : "";

  return (
    <div className={s.editor} style={{ "--accent-color": accentColor }}>

      {/* ── Toolbar ──────────────────────────────────────── */}
      <div className={s.toolbar}>
        <div className={s.filePathBox} onClick={handleBrowse} title={filePath || "Click to open a file"}>
          <FolderOpen size={13} strokeWidth={1.8} style={{ color: "var(--tx-4)", flexShrink: 0 }} />
          {filePath
            ? <span className={s.filePathText}>{displayPath}</span>
            : <span className={s.filePathPlaceholder}>Click to open a {moduleName} file…</span>
          }
        </div>

        {filePath && (
          <button className={s.toolbarBtn} onClick={handleReload} disabled={loading} title="Reload from disk">
            <RotateCcw size={12} strokeWidth={1.8} />
            Reload
          </button>
        )}
      </div>

      {/* ── Body ─────────────────────────────────────────── */}
      {!filePath ? (
        <div className={s.empty}>
          <FileText size={40} strokeWidth={1.2} className={s.emptyIcon} />
          <span className={s.emptyTitle}>No file open</span>
          <p className={s.emptyHint}>
            Browse to an existing <code style={{ fontFamily: "monospace", background: "var(--bg-hover)", padding: "1px 5px", borderRadius: 4 }}>.dat</code> file,
            or import a <code style={{ fontFamily: "monospace", background: "var(--bg-hover)", padding: "1px 5px", borderRadius: 4 }}>.fst</code> in the
            OpenFAST panel to auto-fill the file path.
          </p>
          <button className={s.emptyBtn} onClick={handleBrowse}>
            <FolderOpen size={14} strokeWidth={1.8} />
            Open {moduleName} file…
          </button>
        </div>
      ) : (
        <textarea
          ref={textRef}
          className={s.textArea}
          value={loading ? "Loading…" : content}
          onChange={e => setContent(e.target.value)}
          disabled={loading}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
        />
      )}

      {/* ── Status bar ───────────────────────────────────── */}
      {filePath && (
        <div className={s.statusBar}>
          <span className={s.statusItem}>{lineCount.toLocaleString()} lines</span>
          <span className={s.statusItem}>{content.length.toLocaleString()} chars</span>
          <span className={s.statusSpacer} />
          {isDirty && <span className={s.statusDirty}>● unsaved</span>}
          <button
            className={s.saveBtn}
            onClick={handleSave}
            disabled={!isDirty}
            title="Save (⌘S)"
          >
            <Save size={11} strokeWidth={2} />
            Save
          </button>
        </div>
      )}
    </div>
  );
}
