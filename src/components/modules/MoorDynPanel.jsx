import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Anchor, FolderOpen, Eye, Save, ChevronDown, ChevronRight, List } from "lucide-react";
import RawFileModal from "../RawFileModal";
import InfoPopover from "../InfoPopover";
import s from "./MoorDynPanel.module.css";

const ACCENT = "#B45309";

// ── Tabs ──────────────────────────────────────────────────────────────────────
const TABS = [
  { id: "overview", label: "Overview" },
  { id: "solver",   label: "Solver"   },
  { id: "output",   label: "Output"   },
];

// ── InfoPopover content ───────────────────────────────────────────────────────
const INFO = {
  dtM: {
    param: "dtM",
    desc: "MoorDyn internal time step for mooring integration.",
    range: ">0 s",
    default: "0.001",
    unit: "s",
    note: "Sub-stepped relative to OpenFAST time step. Smaller values increase accuracy and stability but cost more CPU. 0.001 s works for most applications. Very taut lines or snap loads may need 0.0001 s.",
  },
  kbot: {
    param: "kbot",
    desc: "Seabed contact stiffness (seafloor spring constant).",
    range: ">0 Pa/m",
    default: "3.0e6",
    unit: "Pa/m",
    note: "Used when mooring lines touch the seabed. Lower values soften the seafloor contact. Increase if lines bounce off the seabed in an unphysical way. Irrelevant for taut-leg systems where lines never touch the seabed.",
  },
  cbot: {
    param: "cbot",
    desc: "Seabed contact damping coefficient.",
    range: ">0 Pa·s/m",
    default: "3.0e5",
    unit: "Pa·s/m",
    note: "Damping for seabed contact. Typically cbot ≈ kbot/10. Prevents numerical oscillations when lines contact the seabed.",
  },
  TmaxIC: {
    param: "TmaxIC",
    desc: "Maximum simulation time for initial-condition generation.",
    range: "≥0 s",
    default: "60.0",
    unit: "s",
    note: "MoorDyn simulates the mooring system with scaled drag (CdScaleIC) until lines reach equilibrium. Set 0 to skip IC generation. Increase to >200 s for platforms with stiff taut-leg moorings. Check the .log file for convergence.",
  },
  CdScaleIC: {
    param: "CdScaleIC",
    desc: "Drag scaling factor during dynamic relaxation for IC generation.",
    range: ">1",
    default: "4.0",
    note: "Higher values damp the mooring system faster to reach static equilibrium. Too high may cause numerical issues. 4.0 is a good starting point. Only active when TmaxIC > 0.",
  },
  threshIC: {
    param: "threshIC",
    desc: "Convergence threshold for IC generation (fractional change in line tensions).",
    range: "0–1",
    default: "0.001",
    note: "IC generation stops when tension change between successive windows is below this fraction. 0.001 (0.1%) is typical. Only active when TmaxIC > 0.",
  },
  dtIC: {
    param: "dtIC",
    desc: "Time interval for IC convergence analysis.",
    range: ">0 s",
    default: "1.0",
    unit: "s",
    note: "Interval at which line tensions are sampled during dynamic relaxation to check for convergence. 1.0 s is typical. Only active when TmaxIC > 0.",
  },
};

// ── Defaults ─────────────────────────────────────────────────────────────────
const DEFAULT = {
  Echo:       false,
  dtM:        0.001,
  kbot:       3.0e6,
  cbot:       3.0e5,
  dtIC:       1.0,
  TmaxIC:     60.0,
  CdScaleIC:  4.0,
  threshIC:   0.001,
  OutList:    "",
  // Read-only structure counts (from file)
  NLineTypes: 0,
  NPoints:    0,
  NLines:     0,
};

// ── Parser ────────────────────────────────────────────────────────────────────
// MoorDyn v2 format: value  key  - description
// Section headers:   --- SECTION NAME ---
// Solver options come BEFORE the key name on each line.
function parseMoorDynFile(content) {
  const kv = {};
  const lines = content.split(/\r?\n/);

  let section   = null;
  let skipRows  = 0;
  let nLineTypes = 0;
  let nPoints    = 0;
  let nLines     = 0;
  const outLines = [];
  let inOutputs  = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Detect MoorDyn section headers (--- SECTION ---)
    if (/^---/.test(line)) {
      const upper = line.toUpperCase();
      inOutputs = false;

      if (/LINE\s+TYPE/.test(upper)) {
        section = "linetypes"; skipRows = 2;
      } else if (/POINT/.test(upper) || /CONNECTION/.test(upper)) {
        section = "points";    skipRows = 2;
      } else if (/^---\s+LINE/.test(upper) && !/TYPE/.test(upper)) {
        section = "lines";     skipRows = 2;
      } else if (/SOLVER\s+OPT/.test(upper)) {
        section = "solver";    skipRows = 0;
      } else if (/OUTPUT/.test(upper)) {
        section  = "outputs";  skipRows = 0;
        inOutputs = true;
      } else {
        section = null;        skipRows = 0;
      }
      continue;
    }

    if (!line || line.startsWith("!")) continue;

    if (inOutputs) {
      if (/^END\b/i.test(line)) { inOutputs = false; continue; }
      outLines.push(line);
      continue;
    }

    if (skipRows > 0) { skipRows--; continue; }

    if (section === "linetypes") { nLineTypes++; continue; }
    if (section === "points")    { nPoints++;    continue; }
    if (section === "lines")     { nLines++;     continue; }

    if (section === "solver" || section === null) {
      const parts = line.split(/\s+/);
      if (parts.length >= 2) {
        const value = parts[0];
        const key   = parts[1];
        if (/^[A-Za-z]/.test(key)) kv[key] = value;
      }
    }
  }

  kv["__NLineTypes__"] = String(nLineTypes);
  kv["__NPoints__"]    = String(nPoints);
  kv["__NLines__"]     = String(nLines);
  if (outLines.length) kv["__OutList__"] = outLines.join("\n");

  return kv;
}

function mdParsedToState(kv) {
  const st = { ...DEFAULT };
  const b  = v => typeof v === "string" && v.toLowerCase() === "true";
  const n  = v => v !== undefined && !isNaN(Number(v)) ? Number(v) : undefined;

  if (kv["Echo"] !== undefined) st.Echo = b(kv["Echo"]);

  const floatKeys = ["dtM", "kbot", "cbot", "dtIC", "TmaxIC", "CdScaleIC", "threshIC"];
  for (const k of floatKeys) {
    const v = n(kv[k]); if (v !== undefined) st[k] = v;
  }

  if (kv["__NLineTypes__"]) st.NLineTypes = parseInt(kv["__NLineTypes__"]) || 0;
  if (kv["__NPoints__"])    st.NPoints    = parseInt(kv["__NPoints__"])    || 0;
  if (kv["__NLines__"])     st.NLines     = parseInt(kv["__NLines__"])     || 0;
  if (kv["__OutList__"])    st.OutList    = kv["__OutList__"];

  return st;
}

// ── File builder ──────────────────────────────────────────────────────────────
function buildMoorDynContent(originalContent, p) {
  const SUBS = {
    Echo:       () => p.Echo ? "True " : "False",
    dtM:        () => String(p.dtM),
    kbot:       () => String(p.kbot),
    cbot:       () => String(p.cbot),
    dtIC:       () => String(p.dtIC),
    TmaxIC:     () => String(p.TmaxIC),
    CdScaleIC:  () => String(p.CdScaleIC),
    threshIC:   () => String(p.threshIC),
  };

  const lines  = originalContent.split(/\r?\n/);
  const result = [];
  let inOutputs       = false;
  let outputsInserted = false;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    if (inOutputs) {
      if (/^END\b/i.test(trimmed)) {
        if (!outputsInserted) {
          const channels = (p.OutList || "").split("\n").map(l => l.trim()).filter(l => l);
          result.push(...channels);
          outputsInserted = true;
        }
        result.push(rawLine);
        inOutputs = false;
      }
      continue;
    }

    if (/^---/.test(trimmed) && /OUTPUT/i.test(trimmed)) {
      result.push(rawLine);
      inOutputs = true;
      outputsInserted = false;
      const channels = (p.OutList || "").split("\n").map(l => l.trim()).filter(l => l);
      result.push(...channels);
      outputsInserted = true;
      continue;
    }

    if (!trimmed || trimmed.startsWith("!") || /^---/.test(trimmed)) {
      result.push(rawLine);
      continue;
    }

    const m = rawLine.match(/^(\s*)(\S+)(\s+)([A-Za-z]\w*)([\s!].+)?$/);
    if (m) {
      const key = m[4];
      if (Object.prototype.hasOwnProperty.call(SUBS, key)) {
        const newVal = SUBS[key]();
        const oldVal = m[2];
        const padLen = Math.max(oldVal.length, newVal.length);
        const padded = newVal.padEnd(padLen);
        result.push(`${m[1]}${padded}${m[3]}${key}${m[5] || ""}`);
        continue;
      }
    }

    result.push(rawLine);
  }

  return result.join("\n");
}

// ── Dynamic output variable groups ────────────────────────────────────────────
// Channels depend on the number of mooring lines and connection points in the file.
// Falls back to 3-line / 6-point defaults when no file is loaded.
// MoorDyn v2 (OpenFAST 4.x): bare channel names — NO quotes.
function buildMdOutVarGroups(nLines, nPoints) {
  const n = nLines  > 0 ? nLines  : 3;
  const m = nPoints > 0 ? nPoints : 6;

  return [
    {
      group: "Fairlead Tensions",
      vars: Array.from({ length: n }, (_, i) => ({
        name: `FairTen${i + 1}`,
        unit: "kN",
        desc: `Line ${i + 1} — tension magnitude at fairlead (vessel attachment end)`,
      })),
    },
    {
      group: "Anchor Tensions",
      vars: Array.from({ length: n }, (_, i) => ({
        name: `AnchTen${i + 1}`,
        unit: "kN",
        desc: `Line ${i + 1} — tension magnitude at anchor (seabed end)`,
      })),
    },
    {
      group: "Connection / Point Forces",
      vars: Array.from({ length: m }, (_, j) => [
        { name: `Con${j + 1}fx`, unit: "kN", desc: `Point ${j + 1} — net force in global X (inertial frame)` },
        { name: `Con${j + 1}fy`, unit: "kN", desc: `Point ${j + 1} — net force in global Y (inertial frame)` },
        { name: `Con${j + 1}fz`, unit: "kN", desc: `Point ${j + 1} — net force in global Z (inertial frame)` },
      ]).flat(),
    },
    {
      group: "Platform / Body Net Force",
      vars: [
        { name: "fx", unit: "kN", desc: "Total mooring force on platform body — global X" },
        { name: "fy", unit: "kN", desc: "Total mooring force on platform body — global Y" },
        { name: "fz", unit: "kN", desc: "Total mooring force on platform body — global Z" },
      ],
    },
  ];
}

// ── DisabledHintPortal ────────────────────────────────────────────────────────
function DisabledHintPortal({ text, rect }) {
  const tipW = 240;
  const left = Math.min(rect.left + rect.width / 2 - tipW / 2, window.innerWidth - tipW - 10);
  const top  = rect.top - 6;
  return createPortal(
    <div style={{
      position: "fixed", left, top, transform: "translateY(-100%)",
      width: tipW, background: "color-mix(in srgb, var(--bg-surface) 88%, transparent)",
      backdropFilter: "blur(20px) saturate(1.8)", WebkitBackdropFilter: "blur(20px) saturate(1.8)",
      border: "0.5px solid var(--bd)", borderRadius: 9,
      padding: "7px 10px", fontSize: 11.5, color: "var(--tx-3)",
      lineHeight: 1.45, zIndex: 9999, pointerEvents: "none",
      boxShadow: "0 4px 16px rgba(0,0,0,0.18)",
    }}>
      <span style={{ color: ACCENT, fontWeight: 600 }}>Disabled — </span>{text}
    </div>,
    document.body,
  );
}

// ── Output variable picker modal ───────────────────────────────────────────────
// MoorDyn output channels are BARE NAMES (no quotes), e.g. "FairTen1" not '"FairTen1"'
function MdOutVarModal({ current, onClose, onApply, vars }) {
  const [selected,  setSelected]  = useState(() => {
    const names = (current || "").split("\n").map(l => l.trim()).filter(Boolean);
    return new Set(names);
  });
  const [query,     setQuery]     = useState("");
  const [visible,   setVisible]   = useState(false);
  const [collapsed, setCollapsed] = useState(new Set());

  const toggleGroup = (groupName) =>
    setCollapsed(prev => { const n = new Set(prev); n.has(groupName) ? n.delete(groupName) : n.add(groupName); return n; });

  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  const handleClose = () => {
    setVisible(false);
    setTimeout(onClose, 220);
  };

  const handleApply = () => {
    onApply([...selected].join("\n"));
    handleClose();
  };

  const toggle = (name) =>
    setSelected(prev => { const n = new Set(prev); n.has(name) ? n.delete(name) : n.add(name); return n; });

  const q = query.toLowerCase();
  const filteredGroups = vars.map(g => ({
    ...g,
    vars: q ? g.vars.filter(v =>
      v.name.toLowerCase().includes(q) || v.desc.toLowerCase().includes(q) || v.unit.toLowerCase().includes(q)
    ) : g.vars,
  })).filter(g => g.vars.length > 0);

  return createPortal(
    <div
      className={`${s.modalOverlay} ${visible ? s.modalOverlayVisible : ""}`}
      onClick={handleClose}
    >
      <div
        className={`${s.modal} ${visible ? s.modalVisible : ""}`}
        onClick={e => e.stopPropagation()}
      >
        <div className={s.modalHeader}>
          <span className={s.modalTitle}>Output variable picker</span>
          <span className={s.modalCount}>{selected.size} selected</span>
          <div style={{ flex: 1 }} />
          <button className={s.modalClose} onClick={handleClose} type="button">✕</button>
        </div>

        <div className={s.modalSearch}>
          <div className={s.modalSearchBox}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none"
              style={{ flexShrink: 0, opacity: 0.4 }}>
              <circle cx="6.5" cy="6.5" r="5" stroke="currentColor" strokeWidth="1.5"/>
              <line x1="10.5" y1="10.5" x2="14" y2="14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
            <input
              className={s.modalSearchInput}
              placeholder="Search channels… (name, description)"
              value={query}
              onChange={e => setQuery(e.target.value)}
              autoFocus
            />
          </div>
        </div>

        <div className={s.modalBody}>
          {filteredGroups.map(g => {
            const allOn  = g.vars.every(v => selected.has(v.name));
            const someOn = g.vars.some(v => selected.has(v.name));
            const isOpen = q ? true : !collapsed.has(g.group);
            return (
              <div key={g.group} className={s.varGroup}>
                <div className={s.varGroupHead} onClick={() => toggleGroup(g.group)}>
                  <button
                    type="button"
                    className={`${s.groupCheck} ${allOn ? s.groupCheckAll : someOn ? s.groupCheckSome : ""}`}
                    onClick={e => {
                      e.stopPropagation();
                      setSelected(prev => {
                        const n = new Set(prev);
                        if (allOn) g.vars.forEach(v => n.delete(v.name));
                        else       g.vars.forEach(v => n.add(v.name));
                        return n;
                      });
                    }}
                  />
                  <span className={s.groupLabel}>{g.group}</span>
                  <span className={s.varGroupCount}>
                    {g.vars.filter(v => selected.has(v.name)).length}/{g.vars.length}
                  </span>
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
                    className={`${s.groupChevron} ${isOpen ? s.groupChevronOpen : ""}`}>
                    <polyline points="2,4 6,8 10,4" stroke="currentColor" strokeWidth="1.5"
                      strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </div>
                <div className={`${s.varGroupBody} ${!isOpen ? s.varGroupBodyCollapsed : ""}`}>
                  <div className={s.varGroupBodyInner}>
                    {g.vars.map(v => (
                      <label key={v.name}
                        className={`${s.varRow} ${selected.has(v.name) ? s.varRowOn : ""}`}>
                        <input
                          type="checkbox"
                          className={s.varCheck}
                          checked={selected.has(v.name)}
                          onChange={() => toggle(v.name)}
                        />
                        <span className={s.varName}>{v.name}</span>
                        <span className={s.varUnit}>{v.unit}</span>
                        <span className={s.varDesc}>{v.desc}</span>
                        {selected.has(v.name) && (
                          <svg width="11" height="11" viewBox="0 0 12 12" className={s.varCheck__mark}>
                            <polyline points="1.5,6 4.5,9 10.5,3" stroke={ACCENT} strokeWidth="1.8"
                              fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        )}
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
          {filteredGroups.length === 0 && (
            <p className={s.varNoMatch}>No channels match "{query}"</p>
          )}
        </div>

        <div className={s.modalFooter}>
          <button className={s.modalCancelBtn} onClick={handleClose} type="button">Cancel</button>
          <button className={s.modalApplyBtn} onClick={handleApply} type="button">
            Apply {selected.size} channel{selected.size !== 1 ? "s" : ""}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────
function SectionHead({ children }) {
  return <h3 className={s.sectionHead}>{children}</h3>;
}

function SubHead({ children }) {
  return <p className={s.subHead}>{children}</p>;
}

function Field({ label, unit, children, hint, info, disabled = false, disabledHint }) {
  const rowRef = useRef(null);
  const [hintRect, setHintRect] = useState(null);
  const isOff = disabled || !!disabledHint;
  return (
    <div
      ref={rowRef}
      className={[s.field, isOff ? s.fieldDisabled : ""].join(" ")}
      onMouseEnter={() => disabledHint && rowRef.current && setHintRect(rowRef.current.getBoundingClientRect())}
      onMouseLeave={() => setHintRect(null)}
    >
      <div className={s.fieldHeader}>
        <span className={s.fieldLabel}>{label}</span>
        {unit && <span className={s.unit}>{unit}</span>}
        {info && <InfoPopover content={info} accentColor={ACCENT} />}
        {disabled && !disabledHint && <span className={s.naTag}>n/a</span>}
      </div>
      {children}
      {hint && <span className={s.hint}>{hint}</span>}
      {disabledHint && hintRect && <DisabledHintPortal text={disabledHint} rect={hintRect} />}
    </div>
  );
}

function Toggle({ label, value, onChange, note, disabled = false, disabledHint }) {
  const rowRef = useRef(null);
  const [hintRect, setHintRect] = useState(null);
  const isOff = disabled || !!disabledHint;
  return (
    <div
      ref={rowRef}
      className={[s.toggleRow, isOff ? s.fieldDisabled : ""].join(" ")}
      onMouseEnter={() => disabledHint && rowRef.current && setHintRect(rowRef.current.getBoundingClientRect())}
      onMouseLeave={() => setHintRect(null)}
    >
      <button
        className={[s.toggle, value ? s.on : ""].join(" ")}
        onClick={() => !isOff && onChange(!value)}
        type="button"
        style={isOff ? { pointerEvents: "none" } : undefined}
      >
        <span className={s.toggleThumb} />
      </button>
      <span className={s.toggleLabel}>{label}</span>
      {note && <span className={s.toggleNote}>{note}</span>}
      {disabledHint && hintRect && <DisabledHintPortal text={disabledHint} rect={hintRect} />}
    </div>
  );
}

function Collapsible({ title, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={s.collapsible}>
      <button
        className={s.collapsibleHead}
        onClick={() => setOpen(v => !v)}
        type="button"
      >
        {open
          ? <ChevronDown  size={13} strokeWidth={2} />
          : <ChevronRight size={13} strokeWidth={2} />}
        {title}
      </button>
      {open && <div className={s.collapsibleBody}>{children}</div>}
    </div>
  );
}

// ── Mooring schematic SVG ─────────────────────────────────────────────────────
function MooringSchematic({ nLines, nPoints }) {
  const c = ACCENT;
  const px = 100, py = 42;
  const anchors = [
    { ax: 18,  ay: 155, lx: px - 18, ly: py + 10, cx1: px - 28, cy1: 95, cx2: 30,  cy2: 140 },
    { ax: 100, ay: 160, lx: px,      ly: py + 12, cx1: px,       cy1: 100, cx2: 100, cy2: 145 },
    { ax: 182, ay: 155, lx: px + 18, ly: py + 10, cx1: px + 28, cy1: 95, cx2: 170, cy2: 140 },
  ];

  return (
    <svg viewBox="0 0 200 185" width="100%" height="180" style={{ display: "block" }}>
      <rect x="0" y="0" width="200" height="185" fill="none" />
      <rect x="0" y="28" width="200" height="157" fill={c} fillOpacity="0.05" />
      <rect x="0" y="162" width="200" height="23" fill={c} fillOpacity="0.10" />
      {[0,12,24,36,48,60,72,84,96,108,120,132,144,156,168,180,192].map(x => (
        <line key={x} x1={x} y1="162" x2={x - 8} y2="175"
          stroke={c} strokeWidth="0.8" strokeOpacity="0.20" />
      ))}
      <path d="M0 28 Q25 25 50 28 Q75 31 100 28 Q125 25 150 28 Q175 31 200 28"
        stroke={c} strokeWidth="1.0" fill="none" strokeOpacity="0.40" />
      <path d="M0 34 Q20 31 40 34 Q60 37 80 34 Q100 31 120 34 Q140 37 160 34 Q180 31 200 34"
        stroke={c} strokeWidth="0.6" fill="none" strokeOpacity="0.20" />
      {anchors.map((a, i) => (
        <path key={i}
          d={`M ${a.lx} ${a.ly} C ${a.cx1} ${a.cy1}, ${a.cx2} ${a.cy2}, ${a.ax} ${a.ay}`}
          stroke={c} strokeWidth="1.8" fill="none"
          strokeLinecap="round" strokeOpacity="0.85" />
      ))}
      {anchors.map((a, i) => (
        <g key={i}>
          <circle cx={a.ax} cy={a.ay - 4} r="3.5"
            fill="none" stroke={c} strokeWidth="1.2" strokeOpacity="0.7" />
          <line x1={a.ax} y1={a.ay - 0.5} x2={a.ax} y2={a.ay + 6}
            stroke={c} strokeWidth="1.4" strokeOpacity="0.7" />
          <line x1={a.ax - 4} y1={a.ay + 4} x2={a.ax} y2={a.ay + 6}
            stroke={c} strokeWidth="1.4" strokeOpacity="0.7" strokeLinecap="round" />
          <line x1={a.ax + 4} y1={a.ay + 4} x2={a.ax} y2={a.ay + 6}
            stroke={c} strokeWidth="1.4" strokeOpacity="0.7" strokeLinecap="round" />
        </g>
      ))}
      <rect x={px - 28} y={py - 8}  width="56" height="20" rx="4"
        fill={c} fillOpacity="0.18" stroke={c} strokeWidth="1.0" strokeOpacity="0.60" />
      <rect x={px - 24} y={py - 20} width="8"  height="14" rx="2"
        fill={c} fillOpacity="0.22" stroke={c} strokeWidth="0.7" strokeOpacity="0.50" />
      <rect x={px - 4}  y={py - 20} width="8"  height="14" rx="2"
        fill={c} fillOpacity="0.22" stroke={c} strokeWidth="0.7" strokeOpacity="0.50" />
      <rect x={px + 16} y={py - 20} width="8"  height="14" rx="2"
        fill={c} fillOpacity="0.22" stroke={c} strokeWidth="0.7" strokeOpacity="0.50" />
      <rect x={px - 3}  y={py - 48} width="6"  height="30" rx="1"
        fill={c} fillOpacity="0.30" stroke={c} strokeWidth="0.7" strokeOpacity="0.55" />
      <rect x={px - 8}  y={py - 52} width="16" height="6"  rx="2"
        fill={c} fillOpacity="0.38" stroke={c} strokeWidth="0.6" strokeOpacity="0.50" />
      <circle cx={px} cy={py - 49} r="2.2" fill={c} fillOpacity="0.9" />
      <line x1={px}     y1={py - 51} x2={px}     y2={py - 63}
        stroke={c} strokeWidth="2.2" strokeLinecap="round" strokeOpacity="0.85" />
      <line x1={px - 2} y1={py - 47} x2={px - 11} y2={py - 53}
        stroke={c} strokeWidth="2.2" strokeLinecap="round" strokeOpacity="0.85" />
      <line x1={px + 2} y1={py - 47} x2={px + 11} y2={py - 53}
        stroke={c} strokeWidth="2.2" strokeLinecap="round" strokeOpacity="0.85" />
      {anchors.map((a, i) => (
        <circle key={i} cx={a.lx} cy={a.ly} r="2" fill={c} fillOpacity="0.75" />
      ))}
      <text x="4" y="179" fontSize="6" fill={c}
        fontFamily="-apple-system,sans-serif" opacity="0.65">MoorDyn</text>
      {nLines > 0 && (
        <text x="196" y="179" fontSize="6" fill={c}
          fontFamily="-apple-system,sans-serif" opacity="0.65" textAnchor="end">
          {nLines} lines
        </text>
      )}
    </svg>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function MoorDynPanel({
  onLog,
  project,
  filePathFromProject,
  onDirtyChange,
  onRegisterSave,
  simRunning = false,
}) {
  const [tab,              setTab]              = useState("overview");
  const tabDirRef = useRef(1);
  const [p,                _setP]               = useState(DEFAULT);
  const [filePath,         setFilePath]         = useState("");
  const [isDirtyFlag,      setIsDirtyFlag]      = useState(false);
  const [rawOpen,          setRawOpen]          = useState(false);
  const [showOutVarModal,  setShowOutVarModal]  = useState(false);
  const rawContent  = useRef("");
  const originalRef = useRef(null);

  const setP = useCallback((updater) => {
    _setP(updater);
    setIsDirtyFlag(true);
  }, []);

  const isDirty =
    !!filePath && isDirtyFlag &&
    originalRef.current !== null &&
    JSON.stringify(p) !== originalRef.current;

  useEffect(() => {
    if (!isDirtyFlag || originalRef.current === null) return;
    if (JSON.stringify(p) === originalRef.current) setIsDirtyFlag(false);
  }, [p, isDirtyFlag]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = useCallback((key, val) => setP(prev => ({ ...prev, [key]: val })), [setP]);

  // ── IC generation dependency ────────────────────────────────────────────────
  // dtIC / CdScaleIC / threshIC are only used when TmaxIC > 0
  const icGenActive = p.TmaxIC > 0;

  // ── Dynamic output variable groups (memoized on NLines/NPoints) ─────────────
  const mdOutVarGroups = useMemo(
    () => buildMdOutVarGroups(p.NLines, p.NPoints),
    [p.NLines, p.NPoints],
  );

  // ── Core file loader ────────────────────────────────────────────────────────
  const loadFileFromPath = useCallback(async (path) => {
    try {
      const content = await invoke("read_text_file", { path });
      rawContent.current = content;
      const kv     = parseMoorDynFile(content);
      const parsed = mdParsedToState(kv);
      originalRef.current = JSON.stringify(parsed);
      _setP(parsed);
      setIsDirtyFlag(false);
      setFilePath(path);
      onLog?.("ok", `Loaded ${path.split("/").pop()}`);
    } catch (e) {
      onLog?.("error", String(e));
    }
  }, [onLog]);

  // ── Save ────────────────────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (simRunning) {
      onLog?.("warn", "OpenFAST is running — save blocked to protect the active simulation.");
      return;
    }
    if (!filePath) return;
    try {
      const diskContent = await invoke("read_text_file", { path: filePath }).catch(() => rawContent.current);
      const content = buildMoorDynContent(diskContent, p);
      await invoke("write_text_file", { path: filePath, content });
      rawContent.current = content;
      originalRef.current = JSON.stringify(p);
      setIsDirtyFlag(false);
      onLog?.("info", `Saved ${filePath.split("/").pop()}`);
    } catch (e) {
      onLog?.("error", String(e));
    }
  }, [filePath, p, onLog, simRunning]);

  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); handleSave(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleSave]);

  useEffect(() => {
    if (!filePathFromProject) return;
    loadFileFromPath(filePathFromProject);
  }, [filePathFromProject]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { onDirtyChange?.(isDirty); },      [isDirty]);    // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { onRegisterSave?.(handleSave); },  [handleSave]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleOpen = async () => {
    try {
      const f = await openDialog({
        multiple: false,
        filters: [{ name: "MoorDyn", extensions: ["dat", "inp", "txt"] }],
      });
      if (!f) return;
      await loadFileFromPath(f);
    } catch (e) {
      onLog?.("error", String(e));
    }
  };

  // ── Tab renders ─────────────────────────────────────────────────────────────
  const renderOverview = () => (
    <div className={`${s.form} ${s.tabEnterFirst}`}>
      {!filePath ? (
        <div className={s.calloutInfo}>
          Open a MoorDyn .dat file to view and edit solver settings. For floating
          platforms, the mooring file is typically referenced from the .fst via
          CompMooring=3 and MooringFile.
        </div>
      ) : (
        <>
          <div className={s.callout}>
            MoorDyn defines a quasi-static or dynamic mooring system. Line geometry
            (types, attachment points, line connections) is defined in tables within
            the file and preserved verbatim when saving. Use View to inspect or
            modify the tables.
          </div>

          <SectionHead>File Summary</SectionHead>
          <div className={s.calloutInfo}>
            Parsed from file: {p.NLineTypes} line type{p.NLineTypes !== 1 ? "s" : ""},
            {" "}{p.NPoints} point{p.NPoints !== 1 ? "s" : ""} (connections / fairleads / anchors),
            {" "}{p.NLines} line{p.NLines !== 1 ? "s" : ""}. All tables are preserved
            verbatim on save — only scalar solver parameters and the output channel list
            are managed here.
          </div>
        </>
      )}

      <SectionHead>General</SectionHead>
      <div className={s.toggleGrid}>
        <Toggle
          label="Echo input file (Echo)"
          value={p.Echo}
          onChange={v => set("Echo", v)}
          note="Writes a copy of the parsed input to a .ech file — useful for debugging"
        />
      </div>
    </div>
  );

  const renderSolver = () => (
    <div className={`${s.form} ${s.tabEnter}`} style={{ "--tab-dir": tabDirRef.current }}>
      <SectionHead>Integration</SectionHead>
      <div className={s.calloutInfo} style={{ marginBottom: 14 }}>
        MoorDyn uses a sub-stepped integration. If dtM is too large relative to line
        natural periods, instabilities can occur. Rule of thumb: dtM ≈ 0.001 s for
        typical catenary moorings.
      </div>
      <div className={s.grid2}>
        <Field label="Integration time step (dtM)" unit="s" info={INFO.dtM}>
          <input
            className={s.inp}
            value={p.dtM}
            onChange={e => {
              const v = parseFloat(e.target.value);
              if (!isNaN(v) && v > 0) set("dtM", v);
              else set("dtM", e.target.value);
            }}
          />
        </Field>
      </div>

      <SubHead>Seabed Contact</SubHead>
      <div className={s.calloutInfo} style={{ marginBottom: 14 }}>
        Seabed contact is always available in MoorDyn. For deep-water catenary
        moorings where lines never reach the seafloor, these values have no effect on
        the simulation but must still be present in the file.
      </div>
      <div className={s.grid2}>
        <Field label="Seabed stiffness (kbot)" unit="Pa/m" info={INFO.kbot}>
          <input
            className={s.inp}
            value={p.kbot}
            onChange={e => {
              const v = parseFloat(e.target.value);
              if (!isNaN(v)) set("kbot", v);
              else set("kbot", e.target.value);
            }}
          />
        </Field>
        <Field label="Seabed damping (cbot)" unit="Pa·s/m" info={INFO.cbot}>
          <input
            className={s.inp}
            value={p.cbot}
            onChange={e => {
              const v = parseFloat(e.target.value);
              if (!isNaN(v)) set("cbot", v);
              else set("cbot", e.target.value);
            }}
          />
        </Field>
      </div>

      <SubHead>Initial Condition (IC) Generation</SubHead>
      <div className={s.calloutWarn}>
        IC generation uses dynamic relaxation with scaled drag to bring the mooring
        system to static equilibrium before the simulation starts. Set TmaxIC = 0 to
        skip IC generation (start from undeformed geometry). Check the .log file to
        confirm convergence when TmaxIC &gt; 0.
      </div>
      <div className={s.grid2}>
        <Field label="IC max time (TmaxIC)" unit="s" info={INFO.TmaxIC}>
          <input
            className={s.inp}
            value={p.TmaxIC}
            onChange={e => {
              const v = parseFloat(e.target.value);
              if (!isNaN(v) && v >= 0) set("TmaxIC", v);
              else set("TmaxIC", e.target.value);
            }}
          />
        </Field>
        <Field label="IC analysis interval (dtIC)" unit="s" info={INFO.dtIC}
          disabledHint={!icGenActive ? "Set TmaxIC > 0 to enable IC generation and this parameter" : undefined}
        >
          <input
            className={s.inp}
            value={p.dtIC}
            readOnly={!icGenActive}
            onChange={e => {
              if (!icGenActive) return;
              const v = parseFloat(e.target.value);
              if (!isNaN(v) && v > 0) set("dtIC", v);
              else set("dtIC", e.target.value);
            }}
          />
        </Field>
        <Field label="Drag scale factor (CdScaleIC)" info={INFO.CdScaleIC}
          disabledHint={!icGenActive ? "Set TmaxIC > 0 to enable IC generation and this parameter" : undefined}
        >
          <input
            className={s.inp}
            value={p.CdScaleIC}
            readOnly={!icGenActive}
            onChange={e => {
              if (!icGenActive) return;
              const v = parseFloat(e.target.value);
              if (!isNaN(v) && v > 0) set("CdScaleIC", v);
              else set("CdScaleIC", e.target.value);
            }}
          />
        </Field>
        <Field label="Convergence threshold (threshIC)" info={INFO.threshIC}
          disabledHint={!icGenActive ? "Set TmaxIC > 0 to enable IC generation and this parameter" : undefined}
        >
          <input
            className={s.inp}
            value={p.threshIC}
            readOnly={!icGenActive}
            onChange={e => {
              if (!icGenActive) return;
              const v = parseFloat(e.target.value);
              if (!isNaN(v)) set("threshIC", v);
              else set("threshIC", e.target.value);
            }}
          />
        </Field>
      </div>
    </div>
  );

  const renderOutput = () => (
    <div className={`${s.form} ${s.tabEnter}`} style={{ "--tab-dir": tabDirRef.current }}>
      <SectionHead>General</SectionHead>
      <div className={s.toggleGrid}>
        <Toggle
          label="Echo input file (Echo)"
          value={p.Echo}
          onChange={v => set("Echo", v)}
          note="Writes a copy of the parsed input to a .ech file"
        />
      </div>

      <SectionHead>Output Channel List</SectionHead>
      <div className={s.calloutInfo} style={{ marginBottom: 10 }}>
        MoorDyn output channels are bare names (no quotes) — e.g. FairTen1, AnchTen1,
        Con1fx. Channels are generated based on the number of lines
        ({filePath ? p.NLines : "—"}) and points ({filePath ? p.NPoints : "—"}) in
        the loaded file.
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <button
          type="button"
          className={s.pickVarsBtn}
          onClick={() => setShowOutVarModal(true)}
        >
          <List size={12} strokeWidth={2} /> Pick channels…
        </button>
        <span style={{ fontSize: 11.5, color: "var(--tx-4)" }}>
          One bare channel name per line — no quotes
        </span>
      </div>

      <textarea
        className={s.outListArea}
        value={p.OutList}
        onChange={e => set("OutList", e.target.value)}
        placeholder={"FairTen1\nFairTen2\nFairTen3\nAnchTen1\nAnchTen2\nAnchTen3\nfx\nfy\nfz"}
        spellCheck={false}
      />

      {showOutVarModal && (
        <MdOutVarModal
          current={p.OutList}
          vars={mdOutVarGroups}
          onClose={() => setShowOutVarModal(false)}
          onApply={outList => set("OutList", outList)}
        />
      )}
    </div>
  );

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className={s.panel}>
      {/* Header */}
      <div className={s.header}>
        <Anchor size={16} strokeWidth={1.8} style={{ color: ACCENT }} />
        <h1 className={s.title}>MoorDyn</h1>
        <span className={s.desc}>Mooring line dynamics</span>
        <span className={s.badge}>sub-module</span>
        <div style={{ flex: 1 }} />
        <button
          className={`${s.headerBtn} ${s.headerBtnPrimary}`}
          onClick={handleOpen}
          type="button"
        >
          <FolderOpen size={12} strokeWidth={2} /> Open .dat
        </button>
        <button
          className={`${s.headerBtn} ${s.headerBtnSecondary}`}
          type="button"
          onClick={async () => {
            if (!filePath) {
              onLog?.("warn", "Load a MoorDyn file first — then View will show the actual file on disk.");
              return;
            }
            try {
              rawContent.current = await invoke("read_text_file", { path: filePath });
              setRawOpen(true);
            } catch (err) {
              onLog?.("error", `Cannot read file: ${err}`);
            }
          }}
        >
          <Eye size={12} strokeWidth={2} /> View .dat
        </button>
      </div>

      {/* File bar */}
      <div className={[s.fileBar, filePath ? s.fileBarLoaded : ""].join(" ")}>
        <span className={[s.filePath, filePath ? s.filePathSet : ""].join(" ")}>
          {filePath || "No file loaded — open a MoorDyn .dat file"}
        </span>
        <span className={s.dirtyDot} style={{ opacity: isDirty ? 1 : 0 }} />
        <button
          className={[s.saveBtn, (!isDirty || simRunning) ? s.saveBtnInactive : ""].join(" ")}
          onClick={(!isDirty || simRunning) ? undefined : handleSave}
          type="button"
          title={simRunning ? "OpenFAST is running — save blocked" : "Save (⌘S)"}
        >
          <Save size={11} strokeWidth={2} /> Save
        </button>
      </div>

      {simRunning && (
        <div className={s.simBanner}>
          <span style={{ fontSize: 13 }}>&#9888;</span>
          <span>OpenFAST is running — saving is disabled to protect the active simulation</span>
        </div>
      )}

      {/* Tab bar */}
      <div className={s.tabBar}>
        {TABS.map(t => (
          <button
            key={t.id}
            className={[s.tab, tab === t.id ? s.tabActive : ""].join(" ")}
            onClick={() => {
              const oldIdx = TABS.findIndex(x => x.id === tab);
              const newIdx = TABS.findIndex(x => x.id === t.id);
              tabDirRef.current = newIdx >= oldIdx ? 1 : -1;
              setTab(t.id);
            }}
            type="button"
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className={s.contentRow}>
        <div className={s.formArea}>
          {tab === "overview" && renderOverview()}
          {tab === "solver"   && renderSolver()}
          {tab === "output"   && renderOutput()}
        </div>

        {/* Stats panel */}
        <div className={s.statsPanel}>
          <p className={s.statsLabel}>Quick stats</p>
          <div className={s.turbineWrap}>
            <MooringSchematic nLines={p.NLines} nPoints={p.NPoints} />
          </div>
          <div className={s.statsGrid}>
            {[
              ["LineTypes", filePath ? String(p.NLineTypes) : "—"],
              ["Lines",     filePath ? String(p.NLines)     : "—"],
              ["Points",    filePath ? String(p.NPoints)    : "—"],
              ["dtM",       filePath ? String(p.dtM)        : "—"],
              ["TmaxIC",    filePath ? `${p.TmaxIC} s`      : "—"],
              ["threshIC",  filePath ? String(p.threshIC)   : "—"],
            ].map(([k, v]) => (
              <div key={k} className={s.statCard}>
                <span className={s.statKey}>{k}</span>
                <span className={s.statVal}>{v}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {rawOpen && (
        <RawFileModal
          content={rawContent.current}
          filename={filePath ? filePath.split("/").pop() : "MoorDyn.dat"}
          fromDisk={!!filePath}
          hasDirtyWarning={isDirty}
          filePath={filePath}
          onSaved={(newContent) => { rawContent.current = newContent; loadFileFromPath(filePath); }}
          onClose={() => setRawOpen(false)}
        />
      )}
    </div>
  );
}
