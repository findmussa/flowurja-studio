/**
 * BinaryRow — compact two-line binary selector for narrow module panels.
 *
 * Line 1:  [● Source badge + version]          [Override ▶]
 * Line 2:  /resolved/path  (small, truncated, full path on hover)
 * Expanded: path input + Browse + Apply + Clear
 */

import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FolderOpen, ChevronDown, ChevronRight, Check, X } from "lucide-react";

const SOURCE = {
  bundled:  { label: "Bundled",   dot: "#059669", bg: "rgba(16,185,129,0.12)", color: "#059669" },
  system:   { label: "System",    dot: "#2563EB", bg: "rgba(59,130,246,0.12)", color: "#2563EB" },
  override: { label: "Override",  dot: "#B45309", bg: "rgba(245,158,11,0.12)", color: "#B45309" },
  notfound: { label: "Not found", dot: "#DC2626", bg: "rgba(239,68,68,0.12)",  color: "#DC2626" },
};

export default function BinaryRow({
  resolvedPath,
  source,
  version,
  overridePath,
  onSetOverride,
}) {
  const [expanded,  setExpanded]  = useState(false);
  const [draftPath, setDraftPath] = useState(overridePath ?? "");

  const s = SOURCE[source] ?? SOURCE.notfound;

  const handleBrowse = async () => {
    try {
      const f = await openDialog({ multiple: false, directory: false });
      if (f) { setDraftPath(f); onSetOverride(f); }
    } catch { /* cancelled */ }
  };

  const handleApply = () => onSetOverride(draftPath.trim());

  const handleClear = () => { setDraftPath(""); onSetOverride(""); };

  const toggleExpand = () => {
    setExpanded(e => !e);
    setDraftPath(overridePath ?? "");
  };

  // Shorten path for display: show last 2 segments with leading …
  const shortPath = (() => {
    if (!resolvedPath) return "—";
    const parts = resolvedPath.replace(/\\/g, "/").split("/").filter(Boolean);
    if (parts.length <= 2) return resolvedPath;
    return `…/${parts.slice(-2).join("/")}`;
  })();

  return (
    <div style={{ marginBottom: 8 }}>
      {/* ── Card ── */}
      <div style={{
        background: "var(--bg-hover)",
        border: "0.5px solid var(--bd)",
        borderRadius: expanded ? "8px 8px 0 0" : 8,
        padding: "7px 10px 6px",
      }}>

        {/* Line 1: badge + version + override button */}
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>

          {/* Source badge */}
          <span style={{
            display: "inline-flex", alignItems: "center", gap: 4,
            fontSize: 11, fontWeight: 600,
            padding: "2px 7px", borderRadius: 4,
            background: s.bg, color: s.color,
            flexShrink: 0,
          }}>
            <span style={{
              width: 6, height: 6, borderRadius: "50%",
              background: s.dot, display: "inline-block", flexShrink: 0,
            }} />
            {s.label}
            {/* version: "x.y.z" = known, "…" = probing, null/falsy = hide */}
            {version && version !== "…" && /^[\d]/.test(version) && (
              <span style={{ fontWeight: 400, opacity: 0.8 }}>· v{version}</span>
            )}
            {version === "…" && (
              <span style={{ fontWeight: 400, opacity: 0.5, fontStyle: "italic" }}>· probing…</span>
            )}
          </span>

          <div style={{ flex: 1 }} />

          {/* Override toggle */}
          <button
            onClick={toggleExpand}
            style={{
              display: "flex", alignItems: "center", gap: 3,
              background: "none",
              border: "0.5px solid var(--bd)",
              borderRadius: 5, padding: "2px 7px",
              cursor: "pointer", color: "var(--tx-3)",
              fontSize: 11, flexShrink: 0,
            }}
            title={expanded ? "Close override" : "Use a custom binary"}
          >
            {expanded
              ? <ChevronDown  size={10} strokeWidth={2} />
              : <ChevronRight size={10} strokeWidth={2} />}
            Override
          </button>
        </div>

        {/* Line 2: resolved path */}
        <div style={{
          marginTop: 4,
          fontSize: 10.5,
          color: source === "notfound" ? "#DC2626" : "var(--tx-4)",
          fontFamily: "ui-monospace, 'SF Mono', monospace",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          opacity: source === "notfound" ? 0.7 : 1,
        }} title={resolvedPath || "Binary not found"}>
          {shortPath}
        </div>

        {/* Override-active note */}
        {source === "override" && !expanded && (
          <div style={{
            marginTop: 3, fontSize: 10, color: "#B45309", lineHeight: 1.4,
          }}>
            ⚠ Custom binary active — bundled binary bypassed
          </div>
        )}
      </div>

      {/* ── Override input panel ── */}
      {expanded && (
        <div style={{
          background: "var(--bg-hover)",
          border: "0.5px solid var(--bd)", borderTop: "none",
          borderRadius: "0 0 8px 8px",
          padding: "10px 10px 12px",
        }}>
          <p style={{
            fontSize: 11, color: "var(--tx-4)",
            margin: "0 0 8px", lineHeight: 1.5,
          }}>
            Leave blank to use the <strong>bundled</strong> binary.
            Set a path to run any compatible version on your system.
          </p>

          <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
            <input
              type="text"
              value={draftPath}
              onChange={e => setDraftPath(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleApply()}
              placeholder="/path/to/openfast"
              style={{
                flex: 1, minWidth: 0,
                fontSize: 11.5, padding: "4px 8px",
                background: "var(--bg-base)",
                border: "0.5px solid var(--bd)",
                borderRadius: 6, color: "var(--tx-1)",
                fontFamily: "ui-monospace, 'SF Mono', monospace",
                outline: "none",
              }}
            />
            <button onClick={handleBrowse} style={{
              display: "flex", alignItems: "center", gap: 3,
              padding: "4px 8px", borderRadius: 6,
              border: "0.5px solid var(--bd)",
              background: "var(--bg-hover-md)", color: "var(--tx-2)",
              cursor: "pointer", fontSize: 11, flexShrink: 0,
            }}>
              <FolderOpen size={11} strokeWidth={1.8} />
            </button>
            <button onClick={handleApply} title="Apply" style={{
              display: "flex", alignItems: "center",
              padding: "4px 8px", borderRadius: 6,
              border: "none", background: "#0891B2",
              color: "#fff", cursor: "pointer", flexShrink: 0,
            }}>
              <Check size={11} strokeWidth={2.5} />
            </button>
            {overridePath && (
              <button onClick={handleClear} title="Clear — revert to bundled" style={{
                display: "flex", alignItems: "center",
                padding: "4px 8px", borderRadius: 6,
                border: "0.5px solid var(--bd)",
                background: "var(--bg-hover-md)",
                color: "#DC2626",
                cursor: "pointer", flexShrink: 0,
              }}>
                <X size={11} strokeWidth={2.5} />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
