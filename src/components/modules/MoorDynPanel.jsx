import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Anchor, FolderOpen, Eye, Save, ChevronDown, ChevronRight } from "lucide-react";
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
    note: "Used when mooring lines touch the seabed. Lower values soften the seafloor contact. Increase if lines bounce off the seabed in an unphysical way.",
  },
  cbot: {
    param: "cbot",
    desc: "Seabed contact damping coefficient.",
    range: ">0 Pa·s/m",
    default: "3.0e5",
    unit: "Pa·s/m",
    note: "Damping for seabed contact. Typically ~10% of kbot. Prevents numerical oscillations when lines contact the seabed.",
  },
  TmaxIC: {
    param: "TmaxIC",
    desc: "Maximum simulation time for initial-condition generation.",
    range: ">0 s",
    default: "60.0",
    unit: "s",
    note: "MoorDyn simulates the mooring system with scaled drag (CdScaleIC) until lines reach equilibrium. Increase if convergence is not reached (check .log). Floating platforms with very long taut lines may need >200 s.",
  },
  CdScaleIC: {
    param: "CdScaleIC",
    desc: "Drag scaling factor during dynamic relaxation for IC generation.",
    range: ">1",
    default: "4.0",
    note: "Higher values damp the mooring system faster to reach static equilibrium. Too high may cause numerical issues. 4.0 is a good starting point.",
  },
  threshIC: {
    param: "threshIC",
    desc: "Convergence threshold for IC generation (fractional change in line tensions).",
    range: "0–1",
    default: "0.001",
    note: "IC generation stops when the change in all line tensions between successive time windows is less than this fraction. 0.001 (0.1%) is typical.",
  },
  dtIC: {
    param: "dtIC",
    desc: "Time interval for IC convergence analysis.",
    range: ">0 s",
    default: "1.0",
    unit: "s",
    note: "Interval at which line tensions are sampled during dynamic relaxation to check for convergence. A value of 1.0 s is typical.",
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

  // ── Count structure entries from table sections ──────────────────────────
  // We count non-empty, non-header, non-unit data rows in each section.
  let section = null; // "linetypes" | "points" | "lines" | "solver" | "outputs" | null
  let skipRows = 0;   // header rows to skip after section start (column names + units)
  let nLineTypes = 0;
  let nPoints = 0;
  let nLines = 0;
  const outLines = [];
  let inOutputs = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Detect MoorDyn section headers (--- SECTION ---)
    if (/^---/.test(line)) {
      const upper = line.toUpperCase();
      inOutputs = false;

      if (/LINE\s+TYPE/.test(upper)) {
        section = "linetypes";
        skipRows = 2; // column names + units rows
      } else if (/POINT/.test(upper) || /CONNECTION/.test(upper)) {
        section = "points";
        skipRows = 2;
      } else if (/^---\s+LINE/.test(upper) && !/TYPE/.test(upper)) {
        // "--- LINES ---" but not "--- LINE TYPES ---"
        section = "lines";
        skipRows = 2;
      } else if (/SOLVER\s+OPT/.test(upper)) {
        section = "solver";
        skipRows = 0;
      } else if (/OUTPUT/.test(upper)) {
        section = "outputs";
        skipRows = 0;
        inOutputs = true;
      } else {
        section = null;
        skipRows = 0;
      }
      continue;
    }

    // Skip blank lines and comment lines
    if (!line || line.startsWith("!")) continue;

    // Handle OUTPUTS section specially
    if (inOutputs) {
      if (line === "END") {
        inOutputs = false;
        continue;
      }
      // Bare channel names (no quotes in MoorDyn)
      outLines.push(line);
      continue;
    }

    // Skip header/unit rows at start of each table section
    if (skipRows > 0) {
      skipRows--;
      continue;
    }

    if (section === "linetypes") { nLineTypes++; continue; }
    if (section === "points")    { nPoints++;    continue; }
    if (section === "lines")     { nLines++;     continue; }

    if (section === "solver") {
      // Format: value  key  - description
      // Split on whitespace: first token = value, second = key
      const parts = line.split(/\s+/);
      if (parts.length >= 2) {
        const value = parts[0];
        const key   = parts[1];
        if (/^[A-Za-z]/.test(key)) {
          kv[key] = value;
        }
      }
      continue;
    }

    // Lines before any section (e.g. Echo line near top of file)
    // Parse as value  key  - description
    const parts = line.split(/\s+/);
    if (parts.length >= 2) {
      const value = parts[0];
      const key   = parts[1];
      if (/^[A-Za-z]/.test(key)) {
        kv[key] = value;
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
  const b = v => typeof v === "string" && v.toLowerCase() === "true";
  const n = v => v !== undefined && !isNaN(Number(v)) ? Number(v) : undefined;

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

// ── File builder: line-by-line substitution ───────────────────────────────────
// Scalar KV params: value  key  - description  (MoorDyn format)
// OUTPUTS section: replace bare channel names between header and END
function buildMoorDynContent(originalContent, p) {
  // Managed scalar keys → value formatter
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

  const lines = originalContent.split(/\r?\n/);
  const result = [];
  let inOutputs = false;
  let outputsInserted = false;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    // ── OUTPUTS section handling ─────────────────────────────────────────
    if (inOutputs) {
      if (trimmed === "END") {
        // Insert new channel list before END (only if not already inserted)
        if (!outputsInserted) {
          const channels = (p.OutList || "")
            .split("\n")
            .map(l => l.trim())
            .filter(l => l);
          result.push(...channels);
          outputsInserted = true;
        }
        result.push(rawLine); // preserve the END line
        inOutputs = false;
      }
      // Skip all original channel lines (they are replaced above)
      continue;
    }

    // Detect OUTPUTS section start
    if (/^---/.test(trimmed) && /OUTPUT/i.test(trimmed)) {
      result.push(rawLine);
      inOutputs = true;
      outputsInserted = false;
      // Insert channels immediately after the header
      const channels = (p.OutList || "")
        .split("\n")
        .map(l => l.trim())
        .filter(l => l);
      result.push(...channels);
      outputsInserted = true;
      continue;
    }

    // Skip blank / comment / section-divider lines — pass through
    if (!trimmed || trimmed.startsWith("!") || /^---/.test(trimmed)) {
      result.push(rawLine);
      continue;
    }

    // Try to parse: value  key  [rest...]
    // MoorDyn format: first token is value, second is key
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

    // Not a substitution target — preserve verbatim (tables, etc.)
    result.push(rawLine);
  }

  return result.join("\n");
}

// ── Sub-components ────────────────────────────────────────────────────────────
function SectionHead({ children }) {
  return <h3 className={s.sectionHead}>{children}</h3>;
}

function SubHead({ children }) {
  return <p className={s.subHead}>{children}</p>;
}

function Field({ label, unit, children, hint, info }) {
  return (
    <div className={s.field}>
      <div className={s.fieldHeader}>
        <span className={s.fieldLabel}>{label}</span>
        {unit && <span className={s.unit}>{unit}</span>}
        {info && <InfoPopover content={info} accentColor={ACCENT} />}
      </div>
      {children}
      {hint && <span className={s.hint}>{hint}</span>}
    </div>
  );
}

function Toggle({ label, value, onChange, note }) {
  return (
    <div className={s.toggleRow}>
      <button
        className={[s.toggle, value ? s.on : ""].join(" ")}
        onClick={() => onChange(!value)}
        type="button"
      >
        <span className={s.toggleThumb} />
      </button>
      <span className={s.toggleLabel}>{label}</span>
      {note && <span className={s.toggleNote}>{note}</span>}
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
// Floating platform box at top-center, three catenary mooring lines going down
// to seabed anchors at bottom-left, bottom-center-right, bottom-right.
function MooringSchematic({ nLines, nPoints }) {
  const c = ACCENT;

  // Platform center
  const px = 100, py = 42;

  // Three anchor positions (seabed level y=155)
  const anchors = [
    { ax: 18,  ay: 155, lx: px - 18, ly: py + 10, cx1: px - 28, cy1: 95, cx2: 30, cy2: 140 },
    { ax: 100, ay: 160, lx: px,      ly: py + 12, cx1: px,       cy1: 100, cx2: 100, cy2: 145 },
    { ax: 182, ay: 155, lx: px + 18, ly: py + 10, cx1: px + 28, cy1: 95, cx2: 170, cy2: 140 },
  ];

  return (
    <svg viewBox="0 0 200 185" width="100%" height="180" style={{ display: "block" }}>
      {/* Water background */}
      <rect x="0" y="0" width="200" height="185" fill="none" />
      <rect x="0" y="28" width="200" height="157" fill={c} fillOpacity="0.05" />

      {/* Seabed */}
      <rect x="0" y="162" width="200" height="23" fill={c} fillOpacity="0.10" rx="0" />
      {/* Seabed texture hatching */}
      {[0,12,24,36,48,60,72,84,96,108,120,132,144,156,168,180,192].map(x => (
        <line key={x} x1={x} y1="162" x2={x - 8} y2="175"
          stroke={c} strokeWidth="0.8" strokeOpacity="0.20" />
      ))}

      {/* Water surface */}
      <path d="M0 28 Q25 25 50 28 Q75 31 100 28 Q125 25 150 28 Q175 31 200 28"
        stroke={c} strokeWidth="1.0" fill="none" strokeOpacity="0.40" />
      <path d="M0 34 Q20 31 40 34 Q60 37 80 34 Q100 31 120 34 Q140 37 160 34 Q180 31 200 34"
        stroke={c} strokeWidth="0.6" fill="none" strokeOpacity="0.20" />

      {/* Three catenary mooring lines */}
      {anchors.map((a, i) => (
        <path
          key={i}
          d={`M ${a.lx} ${a.ly} C ${a.cx1} ${a.cy1}, ${a.cx2} ${a.cy2}, ${a.ax} ${a.ay}`}
          stroke={c}
          strokeWidth="1.8"
          fill="none"
          strokeLinecap="round"
          strokeOpacity="0.85"
        />
      ))}

      {/* Anchor symbols */}
      {anchors.map((a, i) => (
        <g key={i}>
          {/* Anchor ring */}
          <circle cx={a.ax} cy={a.ay - 4} r="3.5"
            fill="none" stroke={c} strokeWidth="1.2" strokeOpacity="0.7" />
          {/* Anchor shank */}
          <line x1={a.ax} y1={a.ay - 0.5} x2={a.ax} y2={a.ay + 6}
            stroke={c} strokeWidth="1.4" strokeOpacity="0.7" />
          {/* Anchor flukes */}
          <line x1={a.ax - 4} y1={a.ay + 4} x2={a.ax} y2={a.ay + 6}
            stroke={c} strokeWidth="1.4" strokeOpacity="0.7" strokeLinecap="round" />
          <line x1={a.ax + 4} y1={a.ay + 4} x2={a.ax} y2={a.ay + 6}
            stroke={c} strokeWidth="1.4" strokeOpacity="0.7" strokeLinecap="round" />
        </g>
      ))}

      {/* Floating platform (semi-sub barge outline) */}
      <rect x={px - 28} y={py - 8} width="56" height="20" rx="4"
        fill={c} fillOpacity="0.18" stroke={c} strokeWidth="1.0" strokeOpacity="0.60" />
      {/* Platform columns */}
      <rect x={px - 24} y={py - 20} width="8" height="14" rx="2"
        fill={c} fillOpacity="0.22" stroke={c} strokeWidth="0.7" strokeOpacity="0.50" />
      <rect x={px - 4}  y={py - 20} width="8" height="14" rx="2"
        fill={c} fillOpacity="0.22" stroke={c} strokeWidth="0.7" strokeOpacity="0.50" />
      <rect x={px + 16} y={py - 20} width="8" height="14" rx="2"
        fill={c} fillOpacity="0.22" stroke={c} strokeWidth="0.7" strokeOpacity="0.50" />
      {/* Tower */}
      <rect x={px - 3} y={py - 48} width="6" height="30" rx="1"
        fill={c} fillOpacity="0.30" stroke={c} strokeWidth="0.7" strokeOpacity="0.55" />
      {/* Nacelle */}
      <rect x={px - 8} y={py - 52} width="16" height="6" rx="2"
        fill={c} fillOpacity="0.38" stroke={c} strokeWidth="0.6" strokeOpacity="0.50" />
      {/* Hub */}
      <circle cx={px} cy={py - 49} r="2.2" fill={c} fillOpacity="0.9" />
      {/* Blades */}
      <line x1={px} y1={py - 51} x2={px}     y2={py - 63}
        stroke={c} strokeWidth="2.2" strokeLinecap="round" strokeOpacity="0.85" />
      <line x1={px - 2} y1={py - 47} x2={px - 11} y2={py - 53}
        stroke={c} strokeWidth="2.2" strokeLinecap="round" strokeOpacity="0.85" />
      <line x1={px + 2} y1={py - 47} x2={px + 11} y2={py - 53}
        stroke={c} strokeWidth="2.2" strokeLinecap="round" strokeOpacity="0.85" />

      {/* Fairlead attachment dots */}
      {anchors.map((a, i) => (
        <circle key={i} cx={a.lx} cy={a.ly} r="2"
          fill={c} fillOpacity="0.75" />
      ))}

      {/* Label */}
      <text x="4" y="179" fontSize="6" fill={c}
        fontFamily="-apple-system,sans-serif" opacity="0.65">
        MoorDyn
      </text>
      {nLines > 0 && (
        <text x="196" y="179" fontSize="6" fill={c}
          fontFamily="-apple-system,sans-serif" opacity="0.65"
          textAnchor="end">
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
  const [tab,         setTab]         = useState("overview");
  const [p,           _setP]          = useState(DEFAULT);
  const [filePath,    setFilePath]    = useState("");
  const [isDirtyFlag, setIsDirtyFlag] = useState(false);
  const [rawOpen,     setRawOpen]     = useState(false);
  const rawContent  = useRef("");
  const originalRef = useRef(null);

  // Dirty-marking wrapper
  const setP = useCallback((updater) => {
    _setP(updater);
    setIsDirtyFlag(true);
  }, []);

  const isDirty =
    !!filePath &&
    isDirtyFlag &&
    originalRef.current !== null &&
    JSON.stringify(p) !== originalRef.current;

  // Revert detection
  useEffect(() => {
    if (!isDirtyFlag || originalRef.current === null) return;
    if (JSON.stringify(p) === originalRef.current) setIsDirtyFlag(false);
  }, [p, isDirtyFlag]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = useCallback((key, val) => setP(prev => ({ ...prev, [key]: val })), [setP]);

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
      onLog?.("info", `Opened ${path.split("/").pop()}`);
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

  // ⌘S shortcut
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

  // ── Project integration ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!filePathFromProject) return;
    loadFileFromPath(filePathFromProject);
  }, [filePathFromProject]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { onDirtyChange?.(isDirty); }, [isDirty]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { onRegisterSave?.(handleSave); }, [handleSave]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Open handler (browse) ────────────────────────────────────────────────────
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
    <div className={s.form}>
      {!filePath ? (
        <div className={s.calloutInfo}>
          Open a MoorDyn .dat file to view and edit solver settings. For floating
          platforms, the mooring file is typically referenced from the .fst via&nbsp;
          <strong>CompMooring=3</strong> and <strong>MooringFile</strong>.
        </div>
      ) : (
        <>
          <div className={s.callout}>
            MoorDyn defines a quasi-static or dynamic mooring system. Line geometry
            (types, attachment points, line connections) is defined in tables within
            the file and preserved when saving. Use <strong>View</strong> to inspect
            or modify the tables.
          </div>

          <SectionHead>File Summary</SectionHead>
          <div className={s.calloutInfo}>
            Parsed from file:&nbsp;<strong>{p.NLineTypes}</strong> line type{p.NLineTypes !== 1 ? "s" : ""},&nbsp;
            <strong>{p.NPoints}</strong> point{p.NPoints !== 1 ? "s" : ""} (connections/fairleads/anchors),&nbsp;
            <strong>{p.NLines}</strong> line{p.NLines !== 1 ? "s" : ""}. All tables are preserved
            verbatim on save — only scalar solver parameters and the output channel list are managed here.
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
    <div className={s.form}>
      <SectionHead>Integration</SectionHead>
      <div className={s.calloutInfo} style={{ marginBottom: 14 }}>
        MoorDyn uses a sub-stepped integration. If dtM is too large relative to line
        natural periods, instabilities can occur. Rule of thumb: dtM &asymp; 0.001 s for
        typical mooring systems.
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

      <SubHead>Initial Condition Generation</SubHead>
      <div className={s.calloutWarn}>
        Initial conditions (IC) are computed by dynamic relaxation. If TmaxIC is too
        small, the mooring system may not converge — check the .log file for IC
        convergence messages.
      </div>
      <div className={s.grid2}>
        <Field label="IC analysis interval (dtIC)" unit="s" info={INFO.dtIC}>
          <input
            className={s.inp}
            value={p.dtIC}
            onChange={e => {
              const v = parseFloat(e.target.value);
              if (!isNaN(v) && v > 0) set("dtIC", v);
              else set("dtIC", e.target.value);
            }}
          />
        </Field>
        <Field label="IC max time (TmaxIC)" unit="s" info={INFO.TmaxIC}>
          <input
            className={s.inp}
            value={p.TmaxIC}
            onChange={e => {
              const v = parseFloat(e.target.value);
              if (!isNaN(v) && v > 0) set("TmaxIC", v);
              else set("TmaxIC", e.target.value);
            }}
          />
        </Field>
        <Field label="Drag scale factor (CdScaleIC)" info={INFO.CdScaleIC}>
          <input
            className={s.inp}
            value={p.CdScaleIC}
            onChange={e => {
              const v = parseFloat(e.target.value);
              if (!isNaN(v) && v > 0) set("CdScaleIC", v);
              else set("CdScaleIC", e.target.value);
            }}
          />
        </Field>
        <Field label="Convergence threshold (threshIC)" info={INFO.threshIC}>
          <input
            className={s.inp}
            value={p.threshIC}
            onChange={e => {
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
    <div className={s.form}>
      <SectionHead>General</SectionHead>
      <div className={s.toggleGrid}>
        <Toggle
          label="Echo input file (Echo)"
          value={p.Echo}
          onChange={v => set("Echo", v)}
          note="Writes a copy of the parsed input to a .ech file"
        />
      </div>

      <SectionHead>Output Channels</SectionHead>
      <Field
        label="Output channel list (OutList)"
        hint="One bare channel name per line — no quotes. Standard channels: FairTen1, FairTen2, FairTen3, AnchTen1, AnchTen2, AnchTen3, Con1fx, Con1fy, Con1fz, fx, fy, fz"
      >
        <textarea
          className={s.outListArea}
          value={p.OutList}
          onChange={e => set("OutList", e.target.value)}
          placeholder={"FairTen1\nFairTen2\nFairTen3\nAnchTen1\nAnchTen2\nAnchTen3"}
        />
      </Field>
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
            onClick={() => setTab(t.id)}
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
          onClose={() => setRawOpen(false)}
        />
      )}
    </div>
  );
}
