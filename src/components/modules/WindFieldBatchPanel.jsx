/**
 * Wind Field Batch Panel — generates TurbSim .bts files via parameter sweep.
 *
 * Two modes:
 *   DLC mode   — IEC 61400-1 standard load cases (DLC1.1 NTM, DLC1.3 ETM)
 *   Custom     — factorial / paired sweep of wind speed, turbulence model,
 *                wind class, shear exponent, TI asymmetry, and random seeds
 *
 * Outputs: wind/sweeps/{batch_id}/inp/{casename}.inp|.bts
 *          wind/sweeps/{batch_id}/sweep.json   ← read by Simulation Batch
 */

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { invoke }  from "@tauri-apps/api/core";
import { toast } from "sonner";
import { useBinarySettings } from "../../hooks/useBinarySettings";
import { listen }  from "@tauri-apps/api/event";
import {
  Wind, Layers, Play, Square, ChevronDown, ChevronUp,
  Trash2, AlertCircle, ArrowRight, Cpu,
} from "lucide-react";
import { IsolineHero } from "../IsolineAnimation";
import InfoPopover from "../InfoPopover";
import s from "./WindFieldBatchPanel.module.css";

const ACCENT = "#1D9E75";

// ── Field info ────────────────────────────────────────────────────────────────

const INFO = {
  vin:        { param: "V_in — Cut-in speed",          desc: "Minimum hub-height wind speed generated. First speed in the sweep.", range: "3 – 10 m/s", default: "4 m/s", unit: "m/s" },
  vout:       { param: "V_out — Cut-out speed",         desc: "Maximum hub-height wind speed generated. Last speed in the sweep.", range: "15 – 35 m/s", default: "25 m/s", unit: "m/s" },
  hubHeight:  { param: "HubHt — Hub height",            desc: "TurbSim reference height. Must satisfy HubHt > GridHeight/2.", range: "> GridHeight/2", default: "90 m", unit: "m" },
  rotorDiam:  { param: "RotorDiam — Rotor diameter",    desc: "Used to suggest grid dimensions (GridHeight ≈ 1.1× rotor diameter).", range: "> 0 m", default: "126 m", unit: "m" },
  windClass:  { param: "IECturbc — Wind class",         desc: "IEC 61400-1 turbulence class. Sets the reference turbulence intensity for the Normal Turbulence Model.", range: "A (high), B (medium), C (low)", default: "A", note: "A: Iref = 0.16, B: 0.14, C: 0.12. Determines σu = Iref × (0.75 × Vhub + 5.6 m/s)." },
  turbModel:  { param: "TurbModel",                    desc: "Spectral model determining power spectral density shape.", range: "IECKAI, IECVKM, USRVKM, GP_LLJ, NWTCUP, SMOOTH, WF_*, API, NONE", default: "IECKAI", note: "Overridden to USRVKM automatically when gTI ≠ 1.0." },
  windStep:   { param: "Wind speed step",               desc: "Spacing between hub-height wind speeds in the sweep.", range: "1 – 4 m/s", default: "2 m/s", unit: "m/s", note: "2 m/s is the IEC standard step for DLC 1.1 fatigue analysis." },
  seedCount:  { param: "Seeds per condition",           desc: "Independent random realisations per wind speed and type combination.", range: "≥ 1", default: "6", note: "IEC 61400-1 requires ≥ 6 for fatigue (DLC 1.1) and ≥ 3 for ultimate (DLC 1.3)." },
  gridPoints: { param: "NumGrid_Z × NumGrid_Y",         desc: "Number of vertical × lateral grid nodes. Odd values are recommended so a node falls exactly at the hub centre.", range: "3 – 99 (odd recommended)", default: "15 × 15", unit: "nodes" },
  gridSize:   { param: "GridHeight × GridWidth",        desc: "Physical extent of the turbulence grid in metres. Should be ≥ rotor diameter to capture the full swept area.", range: "> 0 m, GridHeight < 2 × HubHt", default: "150 × 150 m", unit: "m" },
  gridHeight: { param: "GridHeight",                   desc: "Vertical grid extent. Must be < 2 × HubHt.", range: "> 0 m, < 2 × HubHt", default: "150 m", unit: "m", note: "Should be ≥ rotor diameter to fully capture the rotor swept area." },
  duration:   { param: "AnalysisTime",                 desc: "Total TurbSim simulation time. AnalysisTime = UsableTime + 30 s (IEC standard transient warm-up excluded from output).", range: "> UsableTime", default: "630 s", unit: "s" },
  useTime:    { param: "UsableTime",                   desc: "Usable output time written to the .bts wind field file. OpenFAST reads this duration; the leading 30 s warm-up is discarded.", range: "> 0 s", default: "600 s", unit: "s" },
  dlc11: {
    param: "DLC 1.1 — Normal Turbulence Model",
    desc:  "Power production in normal turbulent conditions. Fatigue load analysis across Vin–Vout.",
    note:  "IEC 61400-1 Ed.3 §6.3.2.3 / Table 2. γ_f = 1.0 (fatigue).",
  },
  dlc13: {
    param: "DLC 1.3 — Extreme Turbulence Model",
    desc:  "Power production in extreme turbulence (ETM). Conservative ultimate load cases.",
    note:  "IEC 61400-1 Ed.3 Table 2. γ_f = 1.35 (ultimate).",
  },
};

// ── Constants ─────────────────────────────────────────────────────────────────

const WIND_CLASSES  = ["A", "B", "C"];
const TURB_MODELS   = ["IECKAI", "IECVKM"];
const WIND_TYPES    = ["NTM", "1ETM", "EWM1", "EWM50"];

const DLC_DEFS = [
  { key: "dlc11", id: "DLC1.1", windTypeIdx: 0, tag: "NTM",  desc: "Normal Turbulence — fatigue" },
  { key: "dlc13", id: "DLC1.3", windTypeIdx: 1, tag: "ETM",  desc: "Extreme Turbulence — ultimate" },
];

const DEF_TURBINE = { vin: 4, vout: 25, hubHeight: 90, rotorDiam: 126 };
const DEF_GRID    = { numY: 15, numZ: 15, gridWidth: 150, gridHeight: 150,
                      duration: 630, useTime: 600, timeStep: 0.05 };

function maxGrid(hubHeight) { return 2 * Number(hubHeight) - 1; }

function sanitize(str) { return str.replace(/[/\\:*?"<>|]/g, "_").trim(); }

// ── Turbine hint parser ───────────────────────────────────────────────────────

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

// ── Wind speed list helper ────────────────────────────────────────────────────

function buildSpeeds(vin, vout, step) {
  const out = [];
  let v = Number(vin);
  const s = Math.max(0.5, Number(step));
  while (v <= Number(vout) + 1e-6) {
    out.push(Math.round(v * 10) / 10);
    v += s;
  }
  return out;
}

// ── Status icon ───────────────────────────────────────────────────────────────

function StatusIcon({ st }) {
  if (st === "done")    return <span style={{ fontSize: 12, color: "#16A34A" }}>✓</span>;
  if (st === "error")   return <span style={{ fontSize: 12, color: "#DC2626" }}>✗</span>;
  if (st === "running") return (
    <span className={s.iconRunning} style={{ display: "inline-block", width: 10, height: 10,
      border: "1.5px solid #1D9E75", borderTopColor: "transparent", borderRadius: "50%" }} />
  );
  return <span className={s.iconPending} />;
}

// ── Click-to-edit param cell ──────────────────────────────────────────────────

function EditParam({ label, unit, value, onChange, step, min }) {
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
        <input autoFocus className={s.paramInput} type="number"
          value={draft} step={step} min={min}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => {
            if (e.key === "Enter") { e.preventDefault(); commit(); }
            if (e.key === "Escape") setEditing(false);
          }}
        />
      ) : (
        <span className={s.paramVal}>{value}</span>
      )}
    </div>
  );
}

function Lbl({ children, k }) {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
      {children}
      <InfoPopover content={INFO[k]} accentColor={ACCENT} />
    </span>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function WindFieldBatchPanel({
  onLog, project, moduleFiles, onSendToSimBatch, isActive = false,
}) {

  // ── Core state ────────────────────────────────────────────────────────────
  const [mode,         setMode]         = useState("custom");    // "custom" | "dlc"
  const [turbine,      setTurbine]      = useState(DEF_TURBINE);
  const [grid,         setGrid]         = useState(DEF_GRID);
  const [windClass,    setWindClass]    = useState(0);
  const [turbModel,    setTurbModel]    = useState(0);
  const [windStep,     setWindStep]     = useState(2);
  const [seedCount,    setSeedCount]    = useState(6);

  // DLC mode
  const [dlcSelected,  setDlcSelected]  = useState({ dlc11: true, dlc13: false });

  // Custom sweep mode
  const [sweepMode,    setSweepMode]    = useState("factorial");  // "factorial" | "paired"
  const [sweepSpeeds,  setSweepSpeeds]  = useState("4,6,8,10,12,14,16,18,20,22,24");
  const [sweepTypes,   setSweepTypes]   = useState([true, false, false, false]); // NTM 1ETM EWM1 EWM50
  const [sweepClasses, setSweepClasses] = useState([true, false, false]);        // A B C
  // TI% sweep: comma-separated Iref percentages (e.g. "4,14,22,40")
  // When non-empty, overrides wind class chips
  const [sweepTiPct,   setSweepTiPct]   = useState("");           // "" = use class chips
  const [sweepShear,   setSweepShear]   = useState("");           // "0.1,0.2" or empty=default
  const [sweepGti,     setSweepGti]     = useState("");           // "1.0,1.15,1.30" or empty=symmetric

  // Parallelism
  const [workers,      setWorkers]      = useState(2);
  const [cpuCores,     setCpuCores]     = useState(null);

  // Batch label
  const [batchLabel,   setBatchLabel]   = useState("");

  // Run state
  const [cases,        setCases]        = useState([]);
  const [status,       setStatus]       = useState({});
  const [running,      setRunning]      = useState(false);
  const { resolvedPath: turbsimBin } = useBinarySettings("turbsim");
  const [showAll,      setShowAll]      = useState(false);

  // Turbine hints
  const [turbineHints,  setTurbineHints]  = useState(null);

  // Next available batch sequence number — scanned from wind/sweeps/ on project load
  const [nextWfSeq, setNextWfSeq] = useState("001");
  useEffect(() => {
    if (!project?.workingDir) return;
    (async () => {
      try {
        const sweepsDir = `${project.windDir ?? project.workingDir + "/wind"}/sweeps`;
        const entries = await invoke("list_dir", { path: sweepsDir });
        let max = 0;
        for (const e of entries) {
          const name = e.replace(/\\/g, "/").split("/").pop();
          const m = name.match(/_r(\d+)$/i);
          if (m) max = Math.max(max, parseInt(m[1], 10));
        }
        setNextWfSeq(String(max + 1).padStart(3, "0"));
      } catch { /* no sweeps dir yet — default 001 */ }
    })();
  }, [project?.workingDir]);

  const abortRef      = useRef(false);
  const pidsRef       = useRef(new Set()); // all live TurbSim PIDs (one per parallel worker)

  // ── Init ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    invoke("detect_cpu_cores")
      .then(n => {
        setCpuCores(n);
        setWorkers(Math.max(1, Math.floor(n / 2)));
      })
      .catch(() => {});
  }, []);

  // ── Grid clamp when hub height changes ────────────────────────────────────
  useEffect(() => {
    const limit = maxGrid(turbine.hubHeight);
    setGrid(prev => ({
      ...prev,
      gridHeight: Math.min(Number(prev.gridHeight), limit),
      gridWidth:  Math.min(Number(prev.gridWidth),  limit),
    }));
  }, [turbine.hubHeight]);

  // ── Turbine hints from ElastoDyn ──────────────────────────────────────────
  useEffect(() => {
    const edPath = moduleFiles?.elastodyn;
    if (!edPath) return;

    (async () => {
      try {
        const content = await invoke("read_text_file", { path: edPath });
        const kv      = parseTurbineHints(content);
        const towerHt  = kv["TowerHt"];
        const twr2shft = kv["Twr2Shft"];
        const tipRad   = kv["TipRad"];
        if (towerHt === undefined && tipRad === undefined) return;
        const hubHt     = (towerHt !== undefined && twr2shft !== undefined)
          ? +(towerHt + twr2shft).toFixed(2) : towerHt;
        const rotorDiam = tipRad !== undefined ? +(2 * tipRad).toFixed(2) : undefined;
        let gridSize;
        if (tipRad !== undefined && hubHt !== undefined) {
          const raw = Math.ceil((2.2 * tipRad) / 5) * 5;
          gridSize  = Math.min(raw, maxGrid(hubHt));
        }
        const hints = {};
        if (hubHt !== undefined)    hints.HubHt     = hubHt;
        if (rotorDiam !== undefined) hints.RotorDiam = rotorDiam;
        if (gridSize !== undefined)  hints.GridSize  = gridSize;
        if (Object.keys(hints).length > 0) setTurbineHints(hints);
      } catch { /* silently ignore */ }
    })();
  }, [moduleFiles?.elastodyn]);

  // Auto-apply turbine hints silently whenever a new turbine is loaded.
  useEffect(() => {
    if (!turbineHints) return;
    if (turbineHints.HubHt     !== undefined) setTurbine(p => ({ ...p, hubHeight:  turbineHints.HubHt }));
    if (turbineHints.RotorDiam !== undefined) setTurbine(p => ({ ...p, rotorDiam:  turbineHints.RotorDiam }));
    if (turbineHints.GridSize  !== undefined) setGrid(p    => ({ ...p, gridHeight: turbineHints.GridSize, gridWidth: turbineHints.GridSize }));
    onLog?.("info", `Wind Field Batch ← ElastoDyn: ${Object.entries(turbineHints).map(([k,v]) => `${k}=${v}`).join(", ")}`);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turbineHints]);

  // Toast when user navigates to this panel and a turbine is loaded.
  useEffect(() => {
    if (!isActive || !turbineHints) return;
    const parts = [];
    if (turbineHints.HubHt     !== undefined) parts.push(`HubHt = ${turbineHints.HubHt} m`);
    if (turbineHints.RotorDiam !== undefined) parts.push(`RotorDiam = ${turbineHints.RotorDiam} m`);
    if (turbineHints.GridSize  !== undefined) parts.push(`GridSize = ${turbineHints.GridSize} m`);
    if (parts.length > 0) toast.success("Wind Field Batch — applied from turbine model", { description: parts.join("  ·  ") });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive]);

  // ── Derived counts ────────────────────────────────────────────────────────
  const activeDLCs    = DLC_DEFS.filter(d => dlcSelected[d.key]);
  const dlcSpeeds     = buildSpeeds(turbine.vin, turbine.vout, windStep);
  const dlcTotal      = dlcSpeeds.length * Number(seedCount) * activeDLCs.length;

  const customSpeeds    = sweepSpeeds.split(",").map(s => parseFloat(s.trim())).filter(v => !isNaN(v) && v > 0);
  const customTypeIdxs  = sweepTypes.map((on, i) => on ? i : -1).filter(i => i >= 0);
  const customClassIdxs = sweepClasses.map((on, i) => on ? i : -1).filter(i => i >= 0);
  const customShears    = sweepShear.trim()
    ? sweepShear.split(",").map(v => parseFloat(v.trim())).filter(v => !isNaN(v))
    : [null];

  // TI% sweep axis: parse "4,14,22,40" → [0.04, 0.14, 0.22, 0.40]
  const tiPctRaw     = sweepTiPct.trim();
  const customTiVals = tiPctRaw
    ? tiPctRaw.split(",").map(v => parseFloat(v.trim()) / 100).filter(v => !isNaN(v) && v > 0)
    : [];
  const useTiSweep   = customTiVals.length > 0;
  // turbulence axis count (TI% OR wind classes)
  const tiAxisLen    = useTiSweep ? customTiVals.length : Math.max(1, customClassIdxs.length);

  // gTI sweep axis: parse "1.0,1.15,1.30" → [1.0, 1.15, 1.30]; empty → [1.0]
  const customGtiVals = sweepGti.trim()
    ? sweepGti.split(",").map(v => parseFloat(v.trim())).filter(v => !isNaN(v) && v >= 1.0)
    : [1.0];
  const gtiAxisLen = customGtiVals.length;

  // Reactive gTI override state (mirrors sidecar logic: gti != 1.0 → USRVKM+USR)
  const gtiHasOverride = customGtiVals.some(v => v > 1.0);
  const gtiAllOverride = customGtiVals.every(v => v > 1.0);
  const gtiMixed       = gtiHasOverride && !gtiAllOverride;

  let customTotal = 0;
  if (sweepMode === "factorial") {
    customTotal = customSpeeds.length * Math.max(1, customTypeIdxs.length)
      * tiAxisLen * customShears.length * gtiAxisLen * Number(seedCount);
  } else {
    const maxLen = Math.max(customSpeeds.length, customTypeIdxs.length,
      tiAxisLen, customShears.length, gtiAxisLen);
    customTotal = maxLen * Number(seedCount);
  }

  const totalCases = mode === "dlc" ? dlcTotal : customTotal;

  const doneCnt     = Object.values(status).filter(v => v === "done").length;
  const errorCnt    = Object.values(status).filter(v => v === "error").length;
  const progressPct = cases.length > 0 ? (doneCnt + errorCnt) / cases.length : 0;

  const gridTooTall = Number(grid.gridHeight) >= 2 * Number(turbine.hubHeight)
                   || Number(grid.gridWidth)  >= 2 * Number(turbine.hubHeight);

  const safeLabel = sanitize(batchLabel);

  // Clickable name suggestions — short sequential + DLC variant when in DLC mode
  const wfSuggestions = useMemo(() => {
    const base = `wf_r${nextWfSeq}`;
    return mode === "dlc" ? [`dlc_r${nextWfSeq}`, base] : [base];
  }, [nextWfSeq, mode]);

  // ── Generate .inp files ───────────────────────────────────────────────────
  const handleGenerate = async () => {
    if (!project) { onLog?.("warn", "Open a project directory first."); return; }
    if (mode === "dlc" && activeDLCs.length === 0) {
      onLog?.("warn", "Select at least one DLC.");
      return;
    }

    const batchId  = safeLabel || wfSuggestions[0];
    const windDir  = project.windDir ?? `${project.workingDir}/wind`;
    const turbinePayload = { ...turbine, windClass, turbModel, iecStandard: 0 };

    onLog?.("info", `Generating ${totalCases} cases…`);

    try {
      let raw;
      if (mode === "dlc") {
        raw = await invoke("sidecar_call", {
          payload: JSON.stringify({
            cmd:          "generate_dlc_batch",
            working_dir:  project.workingDir,
            wind_dir:     windDir,
            batch_id:     batchId,
            batch_label:  batchLabel,
            turbine:      turbinePayload,
            grid,
            dlcs:         activeDLCs.map(d => ({ id: d.id })),
            seeds_per_speed: Number(seedCount),
            wind_speed_step: Number(windStep),
          }),
        });
      } else {
        raw = await invoke("sidecar_call", {
          payload: JSON.stringify({
            cmd:          "generate_custom_sweep",
            working_dir:  project.workingDir,
            wind_dir:     windDir,
            batch_id:     batchId,
            batch_label:  batchLabel,
            turbine:      turbinePayload,
            grid,
            sweep_mode:   sweepMode,
            sweep_params: {
              wind_speeds:    customSpeeds,
              seeds:          Number(seedCount),
              iec_wind_types: customTypeIdxs,
              wind_classes:   customClassIdxs,
              shear_exps:     customShears,
              gti_values:     customGtiVals,   // gTI sweep axis; [1.0] = symmetric (no gradient)
              ti_values:      customTiVals,    // Iref floats; overrides wind class when non-empty
            },
          }),
        });
      }

      const res = JSON.parse(raw);
      if (!res.ok) throw new Error(res.error);

      setCases(res.cases);
      setStatus(Object.fromEntries(res.cases.map(c => [c.id, "pending"])));
      setShowAll(false);
      setNextWfSeq(s => String(parseInt(s, 10) + 1).padStart(3, "0"));
      onLog?.("ok", `Generated ${res.cases.length} .inp files → wind/sweeps/${batchId}/`);
    } catch (err) {
      onLog?.("error", `Generate failed: ${err.message ?? err}`);
    }
  };

  // ── Run TurbSim (parallel workers) ───────────────────────────────────────
  const handleRunAll = useCallback(async () => {
    if (!turbsimBin) { onLog?.("error", "TurbSim binary not found."); return; }
    if (cases.length === 0) { onLog?.("warn", "Generate .inp files first."); return; }

    abortRef.current = false;
    pidsRef.current.clear();
    setRunning(true);

    const ulPid = await listen("binary-pid", evt => {
      pidsRef.current.add(Number(evt.payload));
    });
    const ulErr = await listen("binary-stderr", evt => {
      const line = String(evt.payload ?? "");
      if (line.trim()) onLog?.("warn", `[TurbSim] ${line}`);
    });

    onLog?.("info", `Running ${cases.length} TurbSim cases with ${workers} worker(s)…`);

    // Worker pool — N workers pulling from shared queue
    const queue = [...cases];
    let done = 0, errors = 0;

    const runWorker = async () => {
      while (queue.length > 0) {
        if (abortRef.current) break;
        const cas = queue.shift();
        if (!cas) break;

        setStatus(prev => ({ ...prev, [cas.id]: "running" }));
        const cwd = cas.inp_path.replace(/\/[^/]+$/, "");
        try {
          await invoke("run_binary", { binary: turbsimBin, args: [cas.inp_path], cwd });
          if (abortRef.current) {
            setStatus(prev => ({ ...prev, [cas.id]: "error" }));
            break;
          }
          setStatus(prev => ({ ...prev, [cas.id]: "done" }));
          done++;
          onLog?.("ok", `✓ ${cas.id}`);
        } catch (err) {
          setStatus(prev => ({ ...prev, [cas.id]: "error" }));
          onLog?.("error", `✗ ${cas.id}: ${err}`);
          errors++;
        }
      }
    };

    await Promise.all(Array.from({ length: workers }, runWorker));

    ulPid();
    ulErr();
    pidsRef.current.clear();
    setRunning(false);
    onLog?.("ok", `TurbSim batch complete — ${done} done, ${errors} errors.`);
  }, [turbsimBin, cases, workers, onLog]);

  const handleStop = () => {
    abortRef.current = true;
    pidsRef.current.forEach(pid => {
      invoke("kill_pid", { pid }).catch(() => {});
    });
    pidsRef.current.clear();
    onLog?.("warn", "Batch stopped.");
  };

  // ── Send to Sim Batch ─────────────────────────────────────────────────────
  const handleSendToSimBatch = () => {
    const ready = cases.filter(c => status[c.id] === "done");
    if (ready.length === 0) {
      onLog?.("warn", "No completed .bts files to send.");
      return;
    }
    onSendToSimBatch?.({
      cases: ready.map(c => ({ ...c, tMax: Number(grid.duration) || 660 })),
      label: batchLabel,
    });
    onLog?.("info", `Sent ${ready.length} completed cases to Simulation Batch.`);
  };

  const visibleCases = showAll ? cases : cases.slice(0, 28);

  // ── Custom sweep toggle helpers ───────────────────────────────────────────
  const toggleSweepType = i => setSweepTypes(prev => {
    const next = [...prev];
    next[i] = !next[i];
    // Ensure at least one selected
    if (next.every(v => !v)) next[i] = true;
    return next;
  });
  const toggleSweepClass = i => setSweepClasses(prev => {
    const next = [...prev];
    next[i] = !next[i];
    if (next.every(v => !v)) next[i] = true;
    return next;
  });

  // ── JSX ───────────────────────────────────────────────────────────────────
  return (
    <div className={s.panel}>

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className={s.header}>
        <Wind size={14} strokeWidth={1.8} className={s.headerIcon} />
        <span className={s.title}>Wind Field Batch</span>
        <span className={s.subtitle}>TurbSim</span>
        <span className={s.headerSpacer} />
        {cases.length > 0 && (
          <span className={s.badge}>{cases.length} cases</span>
        )}
      </div>

      {/* ── Scrollable content ──────────────────────────────────────────── */}
      <div className={s.scroll}>
        <div className={s.form}>

          {!turbsimBin && (
            <div className={s.calloutWarn}>
              <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>TurbSim binary not found. Configure it in <strong>Settings → Binaries</strong>.</span>
            </div>
          )}

          {/* ── Hero row ────────────────────────────────────────────────── */}
          <div className={s.heroRow}>

            {/* Left: turbine params + mode toggle */}
            <div className={s.heroLeft}>
              <p className={s.sectionHead}>Turbine parameters</p>
              <div className={s.paramGrid}>
                <EditParam label="HubHt" unit="m" value={turbine.hubHeight}
                  onChange={v => setTurbine(p => ({ ...p, hubHeight: v }))} step={1} min={10} />
                <EditParam label="RotorDiam" unit="m" value={turbine.rotorDiam}
                  onChange={v => setTurbine(p => ({ ...p, rotorDiam: v }))} step={1} min={1} />
                <EditParam label="V_in" unit="m/s" value={turbine.vin}
                  onChange={v => setTurbine(p => ({ ...p, vin: v }))} step={0.5} min={0} />
                <EditParam label="V_out" unit="m/s" value={turbine.vout}
                  onChange={v => setTurbine(p => ({ ...p, vout: v }))} step={0.5} />
              </div>

              {/* Mode toggle — Custom sweep on the left (default), IEC DLC on the right */}
              <div className={s.modeToggle}>
                <button
                  className={[s.modeBtn, mode === "custom" ? s.modeBtnActive : ""].join(" ")}
                  onClick={() => setMode("custom")}
                >
                  Custom sweep
                </button>
                <button
                  className={[s.modeBtn, mode === "dlc" ? s.modeBtnActive : ""].join(" ")}
                  onClick={() => setMode("dlc")}
                >
                  IEC DLC
                </button>
              </div>
            </div>

            {/* Right: isoline hero + corner stats */}
            <div className={s.heroRight}>
              <IsolineHero running={running} tiAsymmetry={mode === "custom" ? (customGtiVals[customGtiVals.length - 1] ?? 1.0) : 1.0} />

              <div className={[s.tcCorner, s.tcTopLeft].join(" ")}>
                <span className={s.tcVal}>{totalCases || "—"}</span>
                <span className={s.tcLabel}>Cases</span>
              </div>
              <div className={[s.tcCorner, s.tcTopRight].join(" ")}>
                <span className={s.tcVal}>{grid.duration}</span>
                <span className={s.tcLabel}>TMax s</span>
              </div>
              <div className={[s.tcCorner, s.tcBottomLeft].join(" ")}>
                <span className={s.tcVal}>{turbine.hubHeight}</span>
                <span className={s.tcLabel}>HubHt m</span>
              </div>
              <div className={[s.tcCorner, s.tcBottomRight].join(" ")}>
                <span className={s.tcVal}>{grid.numZ}×{grid.numY}</span>
                <span className={s.tcLabel}>Grid pts</span>
              </div>

              {running && (
                <div className={s.tcProgress}>
                  <span className={s.tcProgressDot} />
                  {doneCnt}/{cases.length} done
                </div>
              )}
            </div>
          </div>

          {/* ════ DLC MODE ════ */}
          {mode === "dlc" && (
            <div className={s.card}>
              <p className={s.sectionHead}>Load cases</p>
              <div className={s.dlcPillRow}>
                {DLC_DEFS.map(d => (
                  <button key={d.key}
                    className={[s.dlcPill, dlcSelected[d.key] ? s.dlcPillActive : ""].join(" ")}
                    onClick={() => setDlcSelected(prev => ({ ...prev, [d.key]: !prev[d.key] }))}
                  >
                    <span className={s.dlcPillId}>{d.id}</span>
                    <span className={s.dlcPillTag}>{d.tag}</span>
                    <InfoPopover content={INFO[d.key]} accentColor={ACCENT} />
                    <span className={s.dlcPillDesc}>{d.desc}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ════ CUSTOM MODE ════ */}
          {mode === "custom" && (
            <div className={s.card}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                <p className={s.sectionHead} style={{ margin: 0 }}>Sweep parameters</p>
                <div className={s.sweepModeToggle}>
                  <button
                    className={[s.sweepModeBtn, sweepMode === "factorial" ? s.sweepModeBtnActive : ""].join(" ")}
                    onClick={() => setSweepMode("factorial")}
                  >
                    Factorial
                  </button>
                  <button
                    className={[s.sweepModeBtn, sweepMode === "paired" ? s.sweepModeBtnActive : ""].join(" ")}
                    onClick={() => setSweepMode("paired")}
                  >
                    Paired
                  </button>
                </div>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {/* Wind speeds */}
                <div className={s.sweepRow}>
                  <span className={s.sweepRowLabel}>Wind speeds</span>
                  <input
                    className={s.sweepTextInput}
                    value={sweepSpeeds}
                    onChange={e => setSweepSpeeds(e.target.value)}
                    placeholder="4,6,8,10,12,14,16,18,20,22,24"
                    spellCheck={false}
                  />
                  <span style={{ fontSize: 11, color: "var(--tx-5)", flexShrink: 0 }}>m/s</span>
                </div>

                {/* Wind type (IEC_WindType) */}
                <div className={s.sweepRow}>
                  <span className={s.sweepRowLabel}>Wind type</span>
                  <div className={s.sweepChips}>
                    {WIND_TYPES.map((wt, i) => (
                      <button key={i}
                        className={[s.sweepChip, sweepTypes[i] ? s.sweepChipActive : ""].join(" ")}
                        onClick={() => toggleSweepType(i)}
                      >
                        {wt}
                      </button>
                    ))}
                  </div>
                </div>

                {/* TI% sweep (overrides wind class when set) */}
                <div className={s.sweepRow}>
                  <span className={s.sweepRowLabel}>TI% (Iref)</span>
                  <input
                    className={s.sweepTextInput}
                    value={sweepTiPct}
                    onChange={e => setSweepTiPct(e.target.value)}
                    placeholder="4,14,22,40  (% — empty = use wind class chips)"
                    spellCheck={false}
                  />
                </div>

                {/* Wind class — disabled when TI% sweep is active */}
                <div className={s.sweepRow}>
                  <span className={s.sweepRowLabel}>
                    Wind class
                    {useTiSweep && (
                      <span style={{ fontSize: 10, color: "var(--tx-5)", marginLeft: 5, fontWeight: 400 }}>
                        (TI% active — overridden)
                      </span>
                    )}
                  </span>
                  <div
                    className={s.sweepChips}
                    style={useTiSweep ? { opacity: 0.3, pointerEvents: "none" } : {}}
                  >
                    {WIND_CLASSES.map((wc, i) => (
                      <button key={i}
                        className={[s.sweepChip, sweepClasses[i] ? s.sweepChipActive : ""].join(" ")}
                        onClick={() => !useTiSweep && toggleSweepClass(i)}
                        disabled={useTiSweep}
                      >
                        Class {wc}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Shear exponent (PLExp) */}
                <div className={s.sweepRow}>
                  <span className={s.sweepRowLabel}>Shear exp (α)</span>
                  <input
                    className={s.sweepTextInput}
                    value={sweepShear}
                    onChange={e => setSweepShear(e.target.value)}
                    placeholder="0.1,0.2,0.3  (empty = IEC default)"
                    spellCheck={false}
                  />
                </div>

                {/* TI asymmetry (gTI) sweep */}
                <div className={s.sweepRow}>
                  <span className={s.sweepRowLabel}>TI asymmetry (gTI)</span>
                  <input
                    className={s.sweepTextInput}
                    value={sweepGti}
                    onChange={e => setSweepGti(e.target.value)}
                    placeholder="1.0,1.15,1.30  (empty = symmetric)"
                    spellCheck={false}
                  />
                </div>
              </div>
            </div>
          )}

          {/* ── IEC Configuration ──────────────────────────────────────── */}
          <div className={s.card}>
            <p className={s.sectionHead}>IEC Configuration</p>
            <div className={s.grid2}>
              {/* Wind class only shown in DLC mode — custom mode uses sweep chips above */}
              {mode === "dlc" && (
                <div className={s.field}>
                  <span className={s.fieldLabel}><Lbl k="windClass">Wind class</Lbl></span>
                  <select className={s.sel} value={windClass} onChange={e => setWindClass(Number(e.target.value))}>
                    {WIND_CLASSES.map((c, i) => <option key={i} value={i}>Class {c} (Iref {["0.16","0.14","0.12"][i]})</option>)}
                  </select>
                </div>
              )}
              <div className={s.field}>
                <span className={s.fieldLabel}><Lbl k="turbModel">Turbulence model</Lbl></span>
                {gtiAllOverride ? (
                  <>
                    <div className={s.turbModelLocked}>USRVKM</div>
                    <span className={s.gtiNote} data-variant="locked">
                      All cases: gTI &gt; 1.0 → USRVKM + USR profile (auto)
                    </span>
                  </>
                ) : (
                  <>
                    <select className={s.sel} value={turbModel} onChange={e => setTurbModel(Number(e.target.value))}>
                      {TURB_MODELS.map((m, i) => <option key={i} value={i}>{m}</option>)}
                    </select>
                    {gtiMixed && (
                      <span className={s.gtiNote} data-variant="mixed">
                        Cases with gTI &gt; 1.0 will override to USRVKM + USR profile
                      </span>
                    )}
                  </>
                )}
              </div>
              {mode === "dlc" && (
                <>
                  <div className={s.field}>
                    <span className={s.fieldLabel}><Lbl k="windStep">Wind speed step</Lbl></span>
                    <div className={s.inputRow}>
                      <input className={s.inp} type="number" value={windStep}
                        onChange={e => setWindStep(e.target.value)} min="0.5" max="5" step="0.5" />
                      <span className={s.unit}>m/s</span>
                    </div>
                  </div>
                  <div className={s.field}>
                    <span className={s.fieldLabel}><Lbl k="seedCount">Seeds per speed</Lbl></span>
                    <input className={s.inp} type="number" value={seedCount}
                      onChange={e => setSeedCount(e.target.value)} min="1" max="12" />
                  </div>
                </>
              )}
              {mode === "custom" && (
                <div className={s.field} style={{ gridColumn: "span 1" }}>
                  <span className={s.fieldLabel}><Lbl k="seedCount">Seeds per condition</Lbl></span>
                  <input className={s.inp} type="number" value={seedCount}
                    onChange={e => setSeedCount(e.target.value)} min="1" max="12" />
                </div>
              )}
            </div>
          </div>

          {/* ── Wind Field Grid ────────────────────────────────────────── */}
          <div className={s.card}>
            <p className={s.sectionHead}>Wind Field Grid</p>
            <div className={s.grid2}>
              <div className={s.field}>
                <span className={s.fieldLabel}><Lbl k="gridPoints">Grid points (Z × Y)</Lbl></span>
                <div className={s.inputRow}>
                  <input className={s.inp} type="number" value={grid.numZ}
                    onChange={e => setGrid(p => ({ ...p, numZ: e.target.value }))} style={{ width: 52 }} />
                  <span className={s.sep}>×</span>
                  <input className={s.inp} type="number" value={grid.numY}
                    onChange={e => setGrid(p => ({ ...p, numY: e.target.value }))} style={{ width: 52 }} />
                </div>
              </div>
              <div className={s.field}>
                <span className={s.fieldLabel}><Lbl k="gridSize">Grid size (W × H)</Lbl></span>
                <div className={s.inputRow}>
                  <input className={s.inp} type="number" value={grid.gridWidth}
                    onChange={e => setGrid(p => ({ ...p, gridWidth: e.target.value }))} style={{ width: 52 }} />
                  <span className={s.sep}>×</span>
                  <input className={s.inp} type="number" value={grid.gridHeight}
                    onChange={e => setGrid(p => ({ ...p, gridHeight: e.target.value }))} style={{ width: 52 }} />
                  <span className={s.unit}>m</span>
                </div>
              </div>
              <div className={s.field}>
                <span className={s.fieldLabel}><Lbl k="useTime">Usable time (output)</Lbl></span>
                <div className={s.inputRow}>
                  <input className={s.inp} type="number" value={grid.useTime}
                    onChange={e => setGrid(p => ({
                      ...p,
                      useTime: e.target.value,
                      duration: Number(e.target.value) + 30,
                    }))} />
                  <span className={s.unit}>s</span>
                </div>
              </div>
              <div className={s.field}>
                <span className={s.fieldLabel}><Lbl k="duration">Analysis time</Lbl></span>
                <div className={s.inputRow}>
                  <input className={s.inp} type="number" value={grid.duration}
                    onChange={e => setGrid(p => ({
                      ...p,
                      duration: e.target.value,
                      useTime: Math.max(0, Number(e.target.value) - 30),
                    }))} />
                  <span className={s.unit}>s</span>
                </div>
              </div>
            </div>
          </div>

          {/* ── Parallelism ────────────────────────────────────────────── */}
          <div className={s.card}>
            <p className={s.sectionHead}>Parallelism</p>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <div className={s.stepper}>
                <button className={s.stepperBtn} onClick={() => setWorkers(w => Math.max(1, w - 1))} disabled={workers <= 1}>−</button>
                <div className={s.stepperSep} />
                <div className={s.stepperVal}>{workers}</div>
                <div className={s.stepperSep} />
                <button className={s.stepperBtn} onClick={() => setWorkers(w => Math.min(cpuCores ?? 64, w + 1))} disabled={cpuCores !== null && workers >= cpuCores}>+</button>
              </div>
              <span style={{ fontSize: 12.5, color: "var(--tx-3)", letterSpacing: "-0.005em" }}>
                {workers === 1 ? "sequential — one case at a time" : `${workers} simultaneous TurbSim processes`}
                {cpuCores !== null && (
                  <span style={{ marginLeft: 6, color: "var(--tx-4)" }}>
                    <Cpu size={10} style={{ verticalAlign: "middle", marginRight: 2 }} />
                    {cpuCores} cores detected
                  </span>
                )}
              </span>
            </div>
          </div>

          {/* ── Batch label ────────────────────────────────────────────── */}
          <div className={s.card}>
            <p className={s.sectionHead}>Batch label</p>
            <div className={s.batchLabelRow}>
              <input
                className={s.batchLabelInput}
                value={batchLabel}
                onChange={e => setBatchLabel(e.target.value)}
                placeholder={wfSuggestions[0]}
                spellCheck={false}
                disabled={running}
              />
              <div className={s.suggestions}>
                {wfSuggestions.map(name => (
                  <button key={name} className={s.suggestionChip}
                    onClick={() => setBatchLabel(name)} disabled={running}>
                    {name}
                  </button>
                ))}
              </div>
              <span className={s.batchLabelHint}>
                → <code>wind/sweeps/{safeLabel || wfSuggestions[0]}/</code>
              </span>
            </div>
          </div>

          {/* ── Validation ─────────────────────────────────────────────── */}
          {gridTooTall && (
            <div className={s.validationWarn}>
              ⚠ Grid height/width must be &lt; 2 × HubHt ({(2 * Number(turbine.hubHeight)).toFixed(0)} m).
              Reduce grid dimensions — TurbSim will abort otherwise.
            </div>
          )}

          {/* ── Preview row ────────────────────────────────────────────── */}
          <div className={s.previewRow}>
            {mode === "dlc" && (
              <span>
                {dlcSpeeds.length} speeds × {seedCount} seeds × {activeDLCs.length} DLC
                {activeDLCs.length !== 1 ? "s" : ""} = <strong>{totalCases}</strong> cases
              </span>
            )}
            {mode === "custom" && sweepMode === "factorial" && (
              <span>
                {customSpeeds.length} speed{customSpeeds.length !== 1 ? "s" : ""} ×{" "}
                {Math.max(1, customTypeIdxs.length)} type{customTypeIdxs.length !== 1 ? "s" : ""} ×{" "}
                {useTiSweep
                  ? <>{customTiVals.length} TI%</>
                  : <>{Math.max(1, customClassIdxs.length)} class{customClassIdxs.length !== 1 ? "es" : ""}</>
                } ×{" "}
                {customShears.length} shear × {seedCount} seeds = <strong>{totalCases}</strong> cases
              </span>
            )}
            {mode === "custom" && sweepMode === "paired" && (() => {
              const axisLengths = [
                customSpeeds.length,
                Math.max(1, customTypeIdxs.length),
                useTiSweep ? customTiVals.length : Math.max(1, customClassIdxs.length),
                customShears.length,
              ];
              const maxAxis = Math.max(...axisLengths);
              const axisLabels = [
                `${customSpeeds.length} speed${customSpeeds.length !== 1 ? "s" : ""}`,
                `${Math.max(1, customTypeIdxs.length)} type${customTypeIdxs.length !== 1 ? "s" : ""}`,
                useTiSweep
                  ? `${customTiVals.length} TI%`
                  : `${Math.max(1, customClassIdxs.length)} class${customClassIdxs.length !== 1 ? "es" : ""}`,
                `${customShears.length} shear`,
              ];
              return (
                <span>
                  <span style={{ color: "var(--tx-5)", fontSize: 11 }}>
                    paired — axes: {axisLabels.join(", ")} — shorter axes cycle
                  </span>
                  {" → "}max {maxAxis} conditions × {seedCount} seeds = <strong>{totalCases}</strong> cases
                </span>
              );
            })()}
            {safeLabel && (
              <span className={s.previewPath}>wind/sweeps/{safeLabel || wfSuggestions[0]}/inp/</span>
            )}
          </div>

          {/* ── Action row ─────────────────────────────────────────────── */}
          <div className={s.actionRow}>
            <button
              className={s.genBtn}
              onClick={handleGenerate}
              disabled={running || !project || gridTooTall || totalCases === 0}
            >
              Generate .inp files
            </button>

            {cases.length > 0 && !running && (
              <button
                className={s.runBtn}
                onClick={handleRunAll}
                disabled={!turbsimBin}
                title={!turbsimBin ? "TurbSim binary not found" : ""}
              >
                <Play size={11} strokeWidth={2} fill="currentColor" />
                Run all ({workers}×)
              </button>
            )}

            {running && (
              <button className={s.stopBtn} onClick={handleStop}>
                <Square size={11} strokeWidth={2} style={{ marginRight: 4, verticalAlign: "middle" }} />
                Stop
              </button>
            )}

            {!turbsimBin && cases.length > 0 && !running && (
              <span className={s.noBin}>TurbSim not found</span>
            )}

            {doneCnt > 0 && !running && (
              <button className={s.sendBtn} onClick={handleSendToSimBatch}>
                <ArrowRight size={12} strokeWidth={2} />
                Send {doneCnt} to Sim Batch
              </button>
            )}
          </div>

          {/* ── Progress bar ───────────────────────────────────────────── */}
          {cases.length > 0 && (
            <div className={s.progressTrack}>
              <div className={s.progressFill} style={{ width: `${progressPct * 100}%` }} />
            </div>
          )}

          {/* ── Case list ──────────────────────────────────────────────── */}
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
                >
                  <Trash2 size={11} strokeWidth={2} /> Clear
                </button>
              </div>

              <div className={s.caseList}>
                {visibleCases.map(cas => (
                  <div key={cas.id}
                    className={`${s.caseRow} ${s["st_" + (status[cas.id] || "pending")]}`}
                  >
                    <StatusIcon st={status[cas.id] || "pending"} />
                    <span className={s.caseLabel} title={cas.id}>{cas.id}</span>
                  </div>
                ))}
              </div>

              {cases.length > 28 && (
                <button className={s.showMoreBtn} onClick={() => setShowAll(v => !v)}>
                  {showAll
                    ? <><ChevronUp size={11} /> Show less</>
                    : <><ChevronDown size={11} /> Show {cases.length - 28} more</>}
                </button>
              )}
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
