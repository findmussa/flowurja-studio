import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Layers, Play, CheckCircle, XCircle, Loader, ChevronDown, ChevronUp, Trash2 } from "lucide-react";
import InfoPopover from "../InfoPopover";
import s from "./DLCPanel.module.css";

const ACCENT = "#D97706";

// ── Field info ─────────────────────────────────────────────────────────────
const INFO = {
  vin: {
    param: "Vin — Cut-in wind speed",
    desc:  "Minimum wind speed at which the turbine operates. TurbSim cases below Vin are not generated.",
    unit:  "m/s",
    note:  "IEC 61400-1 §6.3.2: Vin ≤ 0.5 × Vrated is typical.",
  },
  vout: {
    param: "Vout — Cut-out wind speed",
    desc:  "Wind speed at which the turbine shuts down. DLC cases are generated from Vin to Vout.",
    unit:  "m/s",
    note:  "Common values: 20–25 m/s depending on turbine class.",
  },
  hubHeight: {
    param: "HubHt — Hub height",
    desc:  "Height of the rotor centre above ground. Used as the TurbSim reference height and to size the wind field grid.",
    unit:  "m",
    note:  "TurbSim requires HubHt > GridHeight / 2.",
  },
  windClass: {
    param: "IECturbc — Wind turbulence class",
    desc:  "IEC 61400-1 turbulence intensity class. Sets the reference turbulence intensity Iref used in the NTM and ETM formulas.",
    range: "A, B, C",
    note:  "Class A: Iref = 0.16 (high TI)\nClass B: Iref = 0.14 (medium)\nClass C: Iref = 0.12 (low TI)",
  },
  turbModel: {
    param: "TurbModel — Spectral model",
    desc:  "Spectral model used to generate turbulence. IECKAI (Kaimal) is the IEC default and most widely used. IECVKM (von Kármán) is an alternative for specific applications.",
    range: "IECKAI, IECVKM",
    default: "IECKAI",
  },
  windStep: {
    param: "Wind speed step",
    desc:  "Increment between hub-height wind speed cases. A step of 2 m/s is standard practice; smaller steps give finer fatigue load resolution at the cost of more TurbSim runs.",
    unit:  "m/s",
    default: "2",
  },
  seedCount: {
    param: "Seeds per wind speed",
    desc:  "Number of statistically independent turbulent realisations per wind speed. IEC 61400-1 Ed.3 Annex G requires ≥ 6 seeds for fatigue (DLC 1.2) and ≥ 3 for ultimate loads (DLC 1.3).",
    range: "1–12",
    default: "6",
    note:  "More seeds → better statistical convergence but proportionally more compute time.",
  },
  gridHeight: {
    param: "GridHeight",
    desc:  "Vertical extent of the TurbSim wind field grid. Should be at least equal to the rotor diameter. Hard constraint: GridHeight < 2 × HubHt (TurbSim will abort otherwise).",
    unit:  "m",
    note:  "Rule of thumb: GridHeight ≈ RotorDiam × 1.1, capped at 1.9 × HubHt.",
  },
  duration: {
    param: "AnalysisTime",
    desc:  "Total simulated duration per seed. IEC 61400-1 §6.4 specifies a minimum usable duration of 600 s (10 min). The extra 30 s default accounts for start-up transients.",
    unit:  "s",
    default: "630",
    note:  "UsableTime is set to duration − 30 s automatically.",
  },
  dlc11: {
    param: "DLC 1.1 — Normal Turbulence Model",
    desc:  "Power production in normal turbulent conditions. Used for fatigue load analysis across the full operating wind speed range (Vin to Vout).",
    note:  "IEC 61400-1 Ed.3 Table 2, load case 1.1. Partial safety factor γf = 1.0 (fatigue).",
  },
  dlc13: {
    param: "DLC 1.3 — Extreme Turbulence Model",
    desc:  "Power production in extreme turbulence (ETM). The ETM uses a higher turbulence intensity formula to produce conservative ultimate load cases.",
    note:  "IEC 61400-1 Ed.3 Table 2, load case 1.3. Partial safety factor γf = 1.35 (ultimate).",
  },
};

const WIND_CLASSES  = ["A", "B", "C"];
const TURB_MODELS   = ["IECKAI", "IECVKM"];

const DLC_DEFS = [
  { key: "dlc11", id: "DLC1.1", windTypeIdx: 0, tag: "NTM", desc: "Normal Turbulence Model — fatigue" },
  { key: "dlc13", id: "DLC1.3", windTypeIdx: 1, tag: "ETM", desc: "Extreme Turbulence Model — ultimate" },
];

const DEF_TURBINE = { vin: 4, vout: 25, hubHeight: 90, rotorDiam: 126 };

// Grid sized to rotor disk: TurbSim requires HubHt > GridHeight/2
// Safe default: GridHeight = RotorDiam (126 m < 2×90 = 180 m ✓)
const DEF_GRID    = { numY: 15, numZ: 15, gridWidth: 150, gridHeight: 150,
                      duration: 630, useTime: 600, timeStep: 0.05 };

/** Max grid dimension TurbSim will accept for a given hub height */
function maxGrid(hubHeight) { return 2 * Number(hubHeight) - 1; }

// ── Turbine hint parser — reads ElastoDyn KV pairs ─────────────────────────
function parseTurbineHints(content) {
  const kv = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.replace(/!.*$/, "").trim();
    if (!line) continue;
    const tokens = line.split(/\s+/);
    if (tokens.length < 2) continue;
    const val = parseFloat(tokens[0]);
    if (isNaN(val)) continue;
    kv[tokens[1]] = val;
  }
  return kv;
}

function windSpeeds(vin, vout, step) {
  const out = [];
  let v = Number(vin);
  const s = Math.max(0.5, Number(step));
  while (v <= Number(vout) + 1e-6) {
    out.push(Math.round(v * 10) / 10);
    v += s;
  }
  return out;
}

// Status icon component
function StatusIcon({ st }) {
  if (st === "done")    return <CheckCircle size={12} strokeWidth={2}   className={s.iconDone}    />;
  if (st === "error")   return <XCircle     size={12} strokeWidth={2}   className={s.iconError}   />;
  if (st === "running") return <Loader      size={12} strokeWidth={2}   className={s.iconRunning} />;
  return <span className={s.iconPending} />;
}

// Spinning turbine SVG — identical blade paths to OpenFAST panel
function TurbineIcon({ spinning, className }) {
  const bladeClass = [s.turbineBlades, spinning ? s.turbineBladesSpinning : ""].join(" ");
  return (
    <svg className={className} viewBox="0 0 100 140" fill="none" aria-hidden="true">
      <path d="M44 70 L56 70 L60 134 L40 134 Z" fill="currentColor" opacity="0.18" />
      <rect x="32" y="63" width="36" height="12" rx="4.5" fill="currentColor" opacity="0.28" />
      <g transform="translate(50 69)">
        <g className={bladeClass}>
          <path d="M-3 -1 C-4.5 -14 -4 -36 -2.5 -49 A2.5 2.5 0 0 1 2.5 -49 C4 -36 4.5 -14 3 -1 Z" fill="currentColor" opacity="0.82" />
          <path d="M-3 -1 C-4.5 -14 -4 -36 -2.5 -49 A2.5 2.5 0 0 1 2.5 -49 C4 -36 4.5 -14 3 -1 Z" fill="currentColor" opacity="0.82" transform="rotate(120)" />
          <path d="M-3 -1 C-4.5 -14 -4 -36 -2.5 -49 A2.5 2.5 0 0 1 2.5 -49 C4 -36 4.5 -14 3 -1 Z" fill="currentColor" opacity="0.82" transform="rotate(240)" />
        </g>
        <circle cx="0" cy="0" r="6.5" fill="currentColor" />
      </g>
    </svg>
  );
}

// Click-to-edit parameter cell
function EditableParam({ label, unit, value, onChange, step, min }) {
  const [editing, setEditing] = useState(false);
  const [draft,   setDraft]   = useState("");
  const start  = () => { setDraft(String(value)); setEditing(true); };
  const commit = () => {
    setEditing(false);
    const n = parseFloat(draft);
    if (!isNaN(n)) onChange(n);
  };
  return (
    <div className={s.paramCell} onClick={!editing ? start : undefined}>
      <span className={s.paramLabel}>
        {label}{unit && <span className={s.paramUnit}> {unit}</span>}
      </span>
      {editing ? (
        <input
          autoFocus
          className={s.paramInput}
          type="number"
          value={draft}
          step={step}
          min={min}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => {
            if (e.key === "Enter")  { e.preventDefault(); commit(); }
            if (e.key === "Escape") setEditing(false);
          }}
        />
      ) : (
        <span className={s.paramVal}>{value}</span>
      )}
    </div>
  );
}

export default function DLCPanel({ onLog, project, onDLCStateChange, moduleFiles }) {
  // ⓘ label helper
  const Lbl = ({ children, k }) => (
    <span style={{ display:"flex", alignItems:"center", gap:4 }}>
      {children}
      <InfoPopover content={INFO[k]} accentColor={ACCENT} />
    </span>
  );

  const [turbine,    setTurbine]    = useState(DEF_TURBINE);
  const [grid,       setGrid]       = useState(DEF_GRID);
  const [windClass,  setWindClass]  = useState(0);
  const [turbModel,  setTurbModel]  = useState(0);
  const [windStep,   setWindStep]   = useState(2);
  const [seedCount,  setSeedCount]  = useState(6);
  const [selected,   setSelected]   = useState({ dlc11: true, dlc13: false });

  const [cases,         setCases]         = useState([]);
  const [status,        setStatus]        = useState({});   // id → "pending"|"running"|"done"|"error"
  const [running,       setRunning]       = useState(false);
  const [turbsimBin,    setTurbsimBin]    = useState(null);
  const [showAll,       setShowAll]       = useState(false);
  const [dlcBatchLabel, setDlcBatchLabel] = useState("");   // user-editable folder name prefix
  const [turbineHints,  setTurbineHints]  = useState(null);
  const [hintDismissed, setHintDismissed] = useState(false);
  const abortRef          = useRef(false);
  const currentPidRef     = useRef(null);  // PID of the currently running TurbSim process
  const prevElastodynPath = useRef("");

  useEffect(() => {
    invoke("detect_binary", { name: "turbsim" })
      .then(p => { if (p) setTurbsimBin(p); })
      .catch(() => {});
  }, []);

  // Auto-clamp grid height/width when hub height changes so TurbSim never aborts
  useEffect(() => {
    const limit = maxGrid(turbine.hubHeight);
    setGrid(prev => ({
      ...prev,
      gridHeight: Math.min(Number(prev.gridHeight), limit),
      gridWidth:  Math.min(Number(prev.gridWidth),  limit),
    }));
  }, [turbine.hubHeight]);

  // ── Propagate turbine geometry hints from ElastoDyn when moduleFiles changes ──
  useEffect(() => {
    const edPath = moduleFiles?.elastodyn;
    if (!edPath) return;

    const storageKey = `dlc_hint_actioned:${edPath}`;
    const alreadyActioned = sessionStorage.getItem(storageKey) === "1";

    if (edPath === prevElastodynPath.current) {
      if (alreadyActioned) setHintDismissed(true);
      return;
    }
    prevElastodynPath.current = edPath;
    setHintDismissed(alreadyActioned);

    (async () => {
      try {
        const content = await invoke("read_text_file", { path: edPath });
        const kv = parseTurbineHints(content);

        const towerHt  = kv["TowerHt"];
        const twr2shft = kv["Twr2Shft"];
        const tipRad   = kv["TipRad"];

        if (towerHt === undefined && tipRad === undefined) return;

        const hubHt    = (towerHt !== undefined && twr2shft !== undefined)
          ? +(towerHt + twr2shft).toFixed(2) : towerHt;
        const rotorDiam = tipRad !== undefined ? +(2 * tipRad).toFixed(2) : undefined;

        // Grid size: ≈ 1.1× rotor diameter, rounded up to nearest 5 m,
        // capped at maxGrid(hubHt) so TurbSim never aborts.
        let gridSize;
        if (tipRad !== undefined && hubHt !== undefined) {
          const raw = Math.ceil((2.2 * tipRad) / 5) * 5;
          gridSize = Math.min(raw, maxGrid(hubHt));
        }

        const hints = {};
        if (hubHt !== undefined)    hints.HubHt     = hubHt;
        if (rotorDiam !== undefined) hints.RotorDiam = rotorDiam;
        if (gridSize !== undefined)  hints.GridSize  = gridSize;

        if (Object.keys(hints).length > 0) setTurbineHints(hints);
      } catch { /* file unreadable — silently ignore */ }
    })();
  }, [moduleFiles?.elastodyn]);

  const hintStorageKey = moduleFiles?.elastodyn ? `dlc_hint_actioned:${moduleFiles.elastodyn}` : null;

  const applyHints = () => {
    if (!turbineHints) return;
    if (turbineHints.HubHt !== undefined)
      setTurbine(prev => ({ ...prev, hubHeight: turbineHints.HubHt }));
    if (turbineHints.RotorDiam !== undefined)
      setTurbine(prev => ({ ...prev, rotorDiam: turbineHints.RotorDiam }));
    if (turbineHints.GridSize !== undefined)
      setGrid(prev => ({ ...prev, gridHeight: turbineHints.GridSize, gridWidth: turbineHints.GridSize }));
    setHintDismissed(true);
    if (hintStorageKey) sessionStorage.setItem(hintStorageKey, "1");
    onLog?.("info", `DLC ← ElastoDyn: ${Object.entries(turbineHints).map(([k,v])=>`${k}=${v}`).join(", ")}`);
  };

  const handleDismissHints = () => {
    setHintDismissed(true);
    if (hintStorageKey) sessionStorage.setItem(hintStorageKey, "1");
  };

  const reshowHints = () => {
    setHintDismissed(false);
    if (hintStorageKey) sessionStorage.removeItem(hintStorageKey);
  };

  const showPropBar = turbineHints && !hintDismissed;

  const setT = key => e => setTurbine(prev => ({ ...prev, [key]: e.target.value }));
  const setG = key => e => setGrid   (prev => ({ ...prev, [key]: e.target.value }));

  const activeDLCs  = DLC_DEFS.filter(d => selected[d.key]);
  const speeds      = windSpeeds(turbine.vin, turbine.vout, windStep);

  // ── Expose state to Batch Run panel ──────────────────────────────────────────
  useEffect(() => {
    onDLCStateChange?.({
      cases,
      speeds,
      seedCount: Number(seedCount),
      activeDLCs,
      tMax: Number(grid.duration) || 660,
      turbine,
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cases, speeds.join(","), seedCount, activeDLCs.length, grid.duration]);
  const totalCases  = speeds.length * Number(seedCount) * activeDLCs.length;

  // Validation: HubHt must be > GridHeight/2
  const gridTooTall = Number(grid.gridHeight) >= 2 * Number(turbine.hubHeight)
                   || Number(grid.gridWidth)  >= 2 * Number(turbine.hubHeight);

  const doneCnt     = Object.values(status).filter(v => v === "done").length;
  const errorCnt    = Object.values(status).filter(v => v === "error").length;
  const progressPct = cases.length > 0 ? (doneCnt + errorCnt) / cases.length : 0;

  const handleGenerate = async () => {
    if (!project) { onLog?.("warn", "Open a project directory first."); return; }
    if (activeDLCs.length === 0) { onLog?.("warn", "Select at least one DLC."); return; }

    onLog?.("info", `Generating ${totalCases} DLC cases…`);
    try {
      // Build a unique timestamp-based batch ID so repeated DLC generations
      // don't overwrite previous results.
      const now = new Date();
      const ts = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, "0"),
        String(now.getDate()).padStart(2, "0"),
        "_",
        String(now.getHours()).padStart(2, "0"),
        String(now.getMinutes()).padStart(2, "0"),
        String(now.getSeconds()).padStart(2, "0"),
      ].join("");
      // If user provided a label, folder = dlc_<label>_<ts>; otherwise dlc_<ts>
      const safeLabel = dlcBatchLabel.replace(/[/\\:*?"<>|]/g, "_").trim();
      const batchId   = safeLabel ? `${safeLabel}_${ts}` : ts;

      // Wind files live under <project>/wind/dlc_<batchId>/DLC1.x/
      const windDir = project.windDir ?? `${project.workingDir}/wind`;

      const raw = await invoke("sidecar_call", {
        payload: JSON.stringify({
          cmd: "generate_dlc_batch",
          working_dir: project.workingDir,
          wind_dir: windDir,
          batch_id: batchId,
          turbine:  { ...turbine, windClass, turbModel, iecStandard: 0 },
          grid,
          dlcs:     activeDLCs.map(d => ({ id: d.id, windTypeIdx: d.windTypeIdx })),
          seeds_per_speed: Number(seedCount),
          wind_speed_step: Number(windStep),
        })
      });
      const res = JSON.parse(raw);
      if (!res.ok) throw new Error(res.error);
      setCases(res.cases);
      setStatus(Object.fromEntries(res.cases.map(c => [c.id, "pending"])));
      setShowAll(false);
      onLog?.("ok", `Generated ${res.cases.length} .inp files → wind/dlc_${batchId}/`);
    } catch (err) {
      onLog?.("error", `Generate failed: ${err.message ?? err}`);
    }
  };

  const handleRunAll = useCallback(async () => {
    if (!turbsimBin) { onLog?.("error", "TurbSim binary not found."); return; }
    if (cases.length === 0) { onLog?.("warn", "Generate .inp files first."); return; }

    abortRef.current  = false;
    currentPidRef.current = null;
    setRunning(true);
    onLog?.("info", `Starting batch: ${cases.length} cases…`);

    const ulErr = await listen("binary-stderr", evt => {
      const line = evt.payload;
      if (line.trim()) onLog?.("warn", `[TurbSim] ${line}`);
    });

    // Capture PID of each spawned TurbSim process so Stop can kill it immediately.
    const ulPid = await listen("binary-pid", evt => {
      currentPidRef.current = Number(evt.payload);
    });

    let done = 0, errors = 0;
    for (const cas of cases) {
      if (abortRef.current) { onLog?.("warn", "Batch aborted."); break; }
      setStatus(prev => ({ ...prev, [cas.id]: "running" }));
      currentPidRef.current = null;

      const cwd = cas.path.substring(0, cas.path.lastIndexOf("/"));
      try {
        await invoke("run_binary", { binary: turbsimBin, args: [cas.path], cwd });

        // If the user pressed Stop while this case was running, treat it as
        // cancelled rather than done (run_binary resolves even after kill).
        if (abortRef.current) {
          setStatus(prev => ({ ...prev, [cas.id]: "error" }));
          onLog?.("warn", `Cancelled: ${cas.label}`);
          break;
        }
        setStatus(prev => ({ ...prev, [cas.id]: "done" }));
        done++;
      } catch (err) {
        setStatus(prev => ({ ...prev, [cas.id]: "error" }));
        onLog?.("error", `Failed: ${cas.label} — ${err}`);
        errors++;
      }
    }

    ulPid();
    ulErr();
    currentPidRef.current = null;
    setRunning(false);
    onLog?.("ok", `Batch complete — ${done} done, ${errors} errors.`);
  }, [turbsimBin, cases, onLog]);

  const handleStop = () => {
    abortRef.current = true;
    // Kill the currently running TurbSim process immediately if we have its PID.
    if (currentPidRef.current) {
      invoke("kill_pid", { pid: currentPidRef.current }).catch(() => {});
      currentPidRef.current = null;
    }
  };

  const visibleCases = showAll ? cases : cases.slice(0, 24);

  return (
    <div className={s.panel}>

      {/* ── Header ──────────────────────────────────────────── */}
      <div className={s.header}>
        <Layers size={14} strokeWidth={1.8} className={s.headerIcon} />
        <span className={s.title}>DLC Batch Generator</span>
        <span className={s.subtitle}>IEC 61400-1</span>
        {turbineHints && hintDismissed && (
          <button className={s.hintChip} onClick={reshowHints} title="Re-show turbine parameter suggestions">
            <Layers size={10} strokeWidth={2} /> Turbine hints
          </button>
        )}
        {cases.length > 0 && <span className={s.badge}>{cases.length} cases</span>}
      </div>

      {/* ── Turbine hint bar ─────────────────────────────────── */}
      {showPropBar && (
        <div className={s.propBar}>
          <Layers size={12} strokeWidth={1.8} style={{ flexShrink:0, marginTop:1 }} />
          <span className={s.propBarText}>
            <strong>From loaded turbine:</strong>{" "}
            {turbineHints.HubHt     !== undefined && <span className={s.propBadge}>HubHt = {turbineHints.HubHt} m</span>}
            {turbineHints.RotorDiam !== undefined && <span className={s.propBadge}>RotorDiam = {turbineHints.RotorDiam} m</span>}
            {turbineHints.GridSize  !== undefined && <span className={s.propBadge}>GridSize = {turbineHints.GridSize} m</span>}
          </span>
          <button className={s.propApplyBtn} onClick={applyHints}>Apply to case</button>
          <button className={s.propDismissBtn} onClick={handleDismissHints} title="Dismiss">×</button>
        </div>
      )}

      {/* ── Single scrollable page ───────────────────────────── */}
      <div className={s.scroll}>
        <div className={s.form}>

          {/* ── Hero row: turbine params card (left) + turbine SVG card (right) ── */}
          <div className={s.heroCardsRow}>

            {/* Left card: click-to-edit turbine params + DLC pill selectors */}
            <div className={s.card}>
              <p className={s.sectionHead}>Turbine parameters</p>
              <div className={s.paramGrid}>
                <EditableParam label="HubHt" unit="m" value={turbine.hubHeight}
                  onChange={v => setTurbine(prev => ({ ...prev, hubHeight: v }))} step={1} min={10} />
                <EditableParam label="RotorDiam" unit="m" value={turbine.rotorDiam}
                  onChange={v => setTurbine(prev => ({ ...prev, rotorDiam: v }))} step={1} min={1} />
                <EditableParam label="V_in" unit="m/s" value={turbine.vin}
                  onChange={v => setTurbine(prev => ({ ...prev, vin: v }))} step={0.5} min={0} />
                <EditableParam label="V_out" unit="m/s" value={turbine.vout}
                  onChange={v => setTurbine(prev => ({ ...prev, vout: v }))} step={0.5} min={0} />
              </div>

              <p className={s.sectionHead} style={{ marginTop: 14 }}>Load cases</p>
              <div className={s.dlcPillRow}>
                {DLC_DEFS.map(d => (
                  <button key={d.key}
                    className={[s.dlcPill, selected[d.key] ? s.dlcPillActive : ""].join(" ")}
                    onClick={() => setSelected(prev => ({ ...prev, [d.key]: !prev[d.key] }))}
                  >
                    <span className={s.dlcPillId}>{d.id}</span>
                    <span className={s.dlcPillTag}>{d.tag}</span>
                    <InfoPopover content={INFO[d.key]} accentColor={ACCENT} />
                    <span className={s.dlcPillDesc}>{d.desc.split(" — ")[1]}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Right card: spinning turbine SVG + corner stats */}
            <div className={[s.card, s.dlcTurbineCard].join(" ")}>
              <div className={s.dlcTurbineCardInner}>
                {running && <div className={s.dlcHeroPulse} />}
                <TurbineIcon
                  spinning={running}
                  className={[s.dlcTurbineScalable, running ? s.dlcTurbineRunning : ""].join(" ")}
                />
              </div>
              <div className={[s.dlcTcCorner, s.dlcTcTopLeft].join(" ")}>
                <span className={s.dlcTcVal}>{totalCases || "—"}</span>
                <span className={s.dlcTcLabel}>Cases</span>
              </div>
              <div className={[s.dlcTcCorner, s.dlcTcTopRight].join(" ")}>
                <span className={s.dlcTcVal}>{grid.duration}</span>
                <span className={s.dlcTcLabel}>TMax s</span>
              </div>
              <div className={[s.dlcTcCorner, s.dlcTcBottomLeft].join(" ")}>
                <span className={s.dlcTcVal}>{turbine.hubHeight}</span>
                <span className={s.dlcTcLabel}>HubHt m</span>
              </div>
              <div className={[s.dlcTcCorner, s.dlcTcBottomRight].join(" ")}>
                <span className={s.dlcTcVal}>{turbine.vin}–{turbine.vout}</span>
                <span className={s.dlcTcLabel}>Wind m/s</span>
              </div>
              <div className={s.dlcTcBottom}>
                {running ? (
                  <div className={s.dlcHeroRunning}>
                    <span className={s.dlcHeroRunningDot} />
                    {doneCnt}/{cases.length} done
                  </div>
                ) : totalCases > 0 ? (
                  <div className={s.dlcHeroMeta}>
                    <span>{speeds.length} speeds</span>
                    <span>{seedCount} seeds</span>
                    {activeDLCs.length > 0 && <span>{activeDLCs.map(d => d.tag).join("+")}</span>}
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          {/* ── IEC Configuration card ── */}
          <div className={s.card}>
            <p className={s.sectionHead}>IEC Configuration</p>
            <div className={s.grid2}>
              <label className={s.field}>
                <span className={s.fieldLabel}><Lbl k="windClass">Wind class</Lbl></span>
                <select className={s.sel} value={windClass} onChange={e => setWindClass(Number(e.target.value))}>
                  {WIND_CLASSES.map((c, i) => <option key={i} value={i}>Class {c}</option>)}
                </select>
              </label>
              <label className={s.field}>
                <span className={s.fieldLabel}><Lbl k="turbModel">Turbulence model</Lbl></span>
                <select className={s.sel} value={turbModel} onChange={e => setTurbModel(Number(e.target.value))}>
                  {TURB_MODELS.map((m, i) => <option key={i} value={i}>{m}</option>)}
                </select>
              </label>
              <label className={s.field}>
                <span className={s.fieldLabel}><Lbl k="windStep">Wind speed step</Lbl></span>
                <div className={s.inputRow}>
                  <input className={s.inp} type="number" value={windStep}
                    onChange={e => setWindStep(e.target.value)} min="0.5" max="5" step="0.5" />
                  <span className={s.unit}>m/s</span>
                </div>
              </label>
              <label className={s.field}>
                <span className={s.fieldLabel}><Lbl k="seedCount">Seeds per speed</Lbl></span>
                <input className={s.inp} type="number" value={seedCount}
                  onChange={e => setSeedCount(e.target.value)} min="1" max="12" />
              </label>
            </div>
          </div>

          {/* ── Wind Field Grid card ── */}
          <div className={s.card}>
            <p className={s.sectionHead}>Wind Field Grid</p>
            <div className={s.grid2}>
              <label className={s.field}>
                <span className={s.fieldLabel}>Grid points (Y × Z)</span>
                <div className={s.inputRow}>
                  <input className={s.inp} type="number" value={grid.numY} onChange={setG("numY")} style={{width:52}} />
                  <span className={s.sep}>×</span>
                  <input className={s.inp} type="number" value={grid.numZ} onChange={setG("numZ")} style={{width:52}} />
                </div>
              </label>
              <label className={s.field}>
                <span className={s.fieldLabel}>Grid size (W × H)</span>
                <div className={s.inputRow}>
                  <input className={s.inp} type="number" value={grid.gridWidth}  onChange={setG("gridWidth")}  style={{width:52}} />
                  <span className={s.sep}>×</span>
                  <input className={s.inp} type="number" value={grid.gridHeight} onChange={setG("gridHeight")} style={{width:52}} />
                  <span className={s.unit}>m</span>
                </div>
              </label>
              <label className={s.field}>
                <span className={s.fieldLabel}><Lbl k="duration">Duration</Lbl></span>
                <div className={s.inputRow}>
                  <input className={s.inp} type="number" value={grid.duration} onChange={setG("duration")} />
                  <span className={s.unit}>s</span>
                </div>
              </label>
              <label className={s.field}>
                <span className={s.fieldLabel}>Time step</span>
                <div className={s.inputRow}>
                  <input className={s.inp} type="number" value={grid.timeStep} onChange={setG("timeStep")} step="0.01" />
                  <span className={s.unit}>s</span>
                </div>
              </label>
            </div>
          </div>

          {/* ── Preview + validation ── */}
          <div className={s.previewRow}>
            <span className={s.previewText}>
              {speeds.length} speeds × {seedCount} seeds × {activeDLCs.length} DLC{activeDLCs.length !== 1 ? "s" : ""}
              {" = "}<strong>{totalCases}</strong> cases
            </span>
          </div>

          {gridTooTall && (
            <div className={s.validationWarn}>
              ⚠ Grid height/width must be &lt; 2 × hub height ({2 * Number(turbine.hubHeight)} m).
              Reduce grid size or TurbSim will abort.
            </div>
          )}

          {/* ── Batch folder label ── */}
          <p className={s.sectionHead}>Batch label</p>
          <div className={s.batchLabelRow}>
            <input
              className={s.batchLabelInput}
              value={dlcBatchLabel}
              onChange={e => setDlcBatchLabel(e.target.value)}
              placeholder="e.g. NREL5MW_site_A  (optional)"
              spellCheck={false}
              disabled={running}
            />
            <span className={s.batchLabelHint}>
              → <code>wind/dlc_{dlcBatchLabel.replace(/[/\\:*?"<>|]/g,"_").trim() || "<label>"}_YYYYMMDD_HHMMSS/</code>
            </span>
          </div>

          {/* ── Actions ── */}
          <div className={s.actionRow}>
            <button className={s.genBtn} onClick={handleGenerate}
              disabled={running || !project || activeDLCs.length === 0 || gridTooTall}>
              Generate .inp files
            </button>
            {cases.length > 0 && !running && (
              <button className={s.runBtn} onClick={handleRunAll} disabled={!turbsimBin}>
                <Play size={11} strokeWidth={2} fill="currentColor" />
                Run all
              </button>
            )}
            {running && (
              <button className={s.stopBtn} onClick={handleStop}>Stop</button>
            )}
            {!turbsimBin && cases.length > 0 && (
              <span className={s.noBin}>TurbSim not found</span>
            )}
          </div>

          {/* ── Progress bar ── */}
          {cases.length > 0 && (
            <div className={s.progressTrack}>
              <div className={s.progressFill} style={{ width: `${progressPct * 100}%` }} />
            </div>
          )}

          {/* ── Case list ── */}
          {cases.length > 0 && (
            <div className={s.caseSection}>
              <div className={s.caseHeader}>
                <span className={s.caseHeaderLabel}>
                  {doneCnt}/{cases.length} done{errorCnt > 0 ? ` · ${errorCnt} errors` : ""}
                </span>
                <button
                  className={s.clearBtn}
                  onClick={() => { setCases([]); setStatus({}); }}
                  disabled={running}
                  title="Clear list"
                >
                  <Trash2 size={11} strokeWidth={2} /> Clear
                </button>
              </div>
              <div className={s.caseList}>
                {visibleCases.map(cas => (
                  <div key={cas.id} className={`${s.caseRow} ${s["st_" + (status[cas.id] || "pending")]}`}>
                    <StatusIcon st={status[cas.id] || "pending"} />
                    <span className={s.caseLabel}>{cas.label}</span>
                  </div>
                ))}
              </div>
              {cases.length > 24 && (
                <button className={s.showMoreBtn} onClick={() => setShowAll(v => !v)}>
                  {showAll
                    ? <><ChevronUp size={11} /> Show less</>
                    : <><ChevronDown size={11} /> Show {cases.length - 24} more</>}
                </button>
              )}
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
