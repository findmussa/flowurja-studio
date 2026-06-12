import { useState, useEffect, useRef, useCallback } from "react";
import { invoke }  from "@tauri-apps/api/core";
import { listen }  from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Play, Square, Layers, AlertCircle, CheckCircle2,
  XCircle, Loader2, Trash2, Wind, FolderOpen, RefreshCw,
  ChevronDown, ChevronRight, Download, RotateCcw, FileText,
  Zap, Waves,
} from "lucide-react";
import { useBinarySettings } from "../../hooks/useBinarySettings";
import s from "./BatchRunPanel.module.css";

const ACCENT       = "#7C3AED";
const PROGRESS_RE  = /\s+Time:\s+([\d.]+)\s+of\s+([\d.]+)/i;
const FATAL_RE     = /FATAL\s+ERROR|OpenFAST\s+FATAL|FAST_InitializeAll\s+error/i;
const MAX_LOG      = 120;

// ── Tiny helpers ──────────────────────────────────────────────────────────────

function uid() {
  return `bc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function formatElapsed(ms) {
  if (!ms || ms < 0) return "0:00";
  const totS = Math.floor(ms / 1000);
  const m    = Math.floor(totS / 60);
  const h    = Math.floor(m / 60);
  if (h > 0) return `${h}:${String(m % 60).padStart(2, "0")}:${String(totS % 60).padStart(2, "0")}`;
  return `${m}:${String(totS % 60).padStart(2, "0")}`;
}

function formatETA(doneRatio, elapsedMs) {
  if (!doneRatio || doneRatio <= 0 || doneRatio >= 1) return null;
  const remainMs = elapsedMs / doneRatio - elapsedMs;
  return formatElapsed(remainMs);
}

function shortPath(p) {
  if (!p) return "";
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length <= 2 ? parts.join("/") : `…/${parts.slice(-2).join("/")}`;
}

function sanitizeName(s) {
  return s.replace(/[/\\:*?"<>|]/g, "_").trim();
}

// ── OpenFAST file patching ────────────────────────────────────────────────────

/** Rewrite .fst so all relative file refs are absolute, InflowFile → casedIfw. */
function buildCaseFst(fstContent, fstDir, casedIfwPath) {
  const FILE_KEYS = new Set([
    "EDFile", "AeroFile", "ServoFile", "SubFile",
    "MooringFile", "HydroFile", "SeaStFile", "IceFile", "BDBldFile",
  ]);
  return fstContent.split("\n").map(line => {
    const m = line.match(/^(\s*)"([^"]+)"(\s+)(\w+)/);
    if (!m) return line;
    const [, , val, , key] = m;
    if (key === "InflowFile") {
      return line.replace(`"${val}"`, `"${casedIfwPath}"`);
    }
    if (
      FILE_KEYS.has(key) &&
      !val.startsWith("/") &&
      val.toLowerCase() !== "default" &&
      val.toLowerCase() !== "none"
    ) {
      const abs = `${fstDir}/${val}`.replace(/\\/g, "/");
      return line.replace(`"${val}"`, `"${abs}"`);
    }
    return line;
  }).join("\n");
}

/** Patch InflowWind to WindType=1 (Steady) with given wind speed. */
function buildInflowWindSteady(content, windSpeed, hubHeight = 90, plExp = 0.2) {
  return content.split("\n").map(line => {
    if (line.trimStart().startsWith("!")) return line;
    if (/\bWindType\b/.test(line)) {
      return line.replace(/^(\s*)[+-]?[\d.]+/, "$11");
    }
    if (/\bHWindSpeed\b/i.test(line)) {
      return line.replace(/^(\s*)\S+/, `$1${windSpeed}`);
    }
    if (/\bRefHt\b(?!_Uni|_Hawc)/i.test(line)) {
      return line.replace(/^(\s*)\S+/, `$1${hubHeight}`);
    }
    if (/\bPLexp\b/i.test(line)) {
      return line.replace(/^(\s*)\S+/, `$1${plExp}`);
    }
    return line;
  }).join("\n");
}

/** Patch InflowWind to WindType=3 and point FileName_BTS at the .bts file. */
function buildInflowWindForBTS(content, btsPath) {
  let btsLineFound = false;

  const patched = content.split("\n").map(line => {
    if (line.trimStart().startsWith("!")) return line;
    if (/\bWindType\b/.test(line)) {
      return line.replace(/^(\s*)[+-]?[\d.]+/, "$13");
    }
    if (/\bFileName_BTS\b/i.test(line)) {
      btsLineFound = true;
      if (/"[^"]*"/.test(line)) {
        return line.replace(/"[^"]*"/, `"${btsPath}"`);
      }
      return line.replace(/^(\s*)\S+/, `$1"${btsPath}"`);
    }
    return line;
  });

  if (!btsLineFound) {
    patched.push(`"${btsPath}"    FileName_BTS    - Name of the TurbSim binary wind file`);
  }

  return patched.join("\n");
}

/** Override TMax in a .fst content string. */
function patchTMax(fstContent, tMax) {
  return fstContent.split("\n").map(line => {
    if (/\bTMax\b/.test(line) && !line.trimStart().startsWith("!")) {
      return line.replace(/^(\s*)([\d.eE+\-]+)/, `$1${tMax}`);
    }
    return line;
  }).join("\n");
}

// ── Case preparation ──────────────────────────────────────────────────────────

async function prepareCase(bc, batchName, moduleFiles, project) {
  const fstPath = moduleFiles?.fstPath;
  const ifwPath = moduleFiles?.inflowwind;
  if (!fstPath) throw new Error("No .fst loaded — import one in the OpenFAST panel first.");

  const fstDir   = fstPath.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
  const safeName = sanitizeName(bc.name) || `case_${bc.id}`;

  const resultsDir  = project.resultsDir ?? `${project.workingDir}/results`;
  const batchRoot   = `${resultsDir}/${batchName}`;
  // outb/ — flat folder where OpenFAST writes all .outb files (cwd for the process)
  const outbDir     = `${batchRoot}/outb`;
  // inp/{caseName}/ — reproducibility snapshot: the exact .fst + InflowWind used
  const caseInpDir  = `${batchRoot}/inp/${safeName}`;
  const caseIfwPath = `${caseInpDir}/inflowwind.dat`;
  const caseFstPath = `${caseInpDir}/${safeName}.fst`;

  const rawFst = await invoke("read_text_file", { path: fstPath });
  let caseFst  = buildCaseFst(rawFst, fstDir, caseIfwPath);
  caseFst      = patchTMax(caseFst, Number(bc.tMax) || 660);

  let caseIfw;
  if (bc.windMode === "steady") {
    // Steady wind (WindType=1): no .bts file needed
    if (ifwPath) {
      const rawIfw = await invoke("read_text_file", { path: ifwPath });
      caseIfw = buildInflowWindSteady(rawIfw, bc.windSpeed ?? 12, bc.hubHeight ?? 90);
    } else {
      const v = bc.windSpeed ?? 12;
      const h = bc.hubHeight ?? 90;
      caseIfw = [
        "------- InflowWind v3.01.* INPUT FILE (Nurja — steady) ----------------------",
        `! Batch run: ${bc.name}`,
        `1                  WindType        - steady wind (1)`,
        "0.0                PropagationDir  - propagation direction (deg)",
        "0.0                VFlowAng        - upflow angle (deg)",
        "0                  NWindVel        - number of wind velocity output points",
        "========== Parameters for Steady Wind [WindType=1] ==========================",
        `${String(v).padEnd(19)}HWindSpeed      - horizontal wind speed at reference height (m/s)`,
        `${String(h).padEnd(19)}RefHt           - reference height (m)`,
        "0.2                PLexp           - power law wind shear exponent (-)",
        "========== OUTPUT ===========================================================",
        "OutList",
        "END",
      ].join("\n");
    }
  } else {
    // BTS wind (WindType=3)
    if (ifwPath) {
      const rawIfw = await invoke("read_text_file", { path: ifwPath });
      caseIfw = buildInflowWindForBTS(rawIfw, bc.btsPath);
    } else {
      caseIfw = [
        "------- InflowWind v3.01.* INPUT FILE (generated by Nurja) -------------------",
        `! Batch run: ${bc.name}`,
        "3                  WindType        - switch for wind file type (3=TurbSim binary)",
        "0.0                PropagationDir  - direction of wind propagation (deg)",
        "0.0                VFlowAng        - vertical mean flow (tilt) angle (deg)",
        "0                  NWindVel        - number of wind velocity output points",
        "====== Parameters for TurbSim Binary Files [WindType=3] =====================",
        `"${bc.btsPath}"    FileName_BTS    - Name of the TurbSim full-field binary wind file`,
        "====== OUTPUT ================================================================",
        "OutList",
        "END",
      ].join("\n");
    }
  }

  await invoke("write_text_file", { path: caseIfwPath, content: caseIfw });
  await invoke("write_text_file", { path: caseFstPath, content: caseFst });

  // caseDir = outbDir: OpenFAST runs with this as cwd so it writes {safeName}.outb there.
  // caseInpDir: reproducibility snapshot — the exact inputs used for this case.
  return { caseFstPath, caseDir: outbDir, caseInpDir };
}

// ── CSV export ────────────────────────────────────────────────────────────────
// Tauri WebView does not support blob-URL file downloads, so we write directly
// to disk via write_text_file and then open the file with the default application.

async function exportBatchCSV(cases, batchStatus, batchRootDir, batchName, onLog) {
  const rows = [["#", "Name", "Status", "Duration (s)", "BTS Path", "Details"]];
  cases.forEach((c, idx) => {
    const st = batchStatus[c.id];
    if (!st) return;
    const duration = (st.startTime && st.endTime)
      ? Math.round((st.endTime - st.startTime) / 1000)
      : "";
    rows.push([idx + 1, c.name, st.status, duration, c.btsPath, st.errorMsg ?? ""]);
  });
  const csv  = rows
    .map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(","))
    .join("\n");
  const name = `${batchName || "batch"}_summary.csv`;
  const path = `${batchRootDir}/${name}`;
  try {
    await invoke("write_text_file", { path, content: csv });
    // Open with default app (Numbers / Excel / LibreOffice Calc)
    await invoke("open_in_finder", { path });
    onLog?.("ok", `CSV saved → ${path}`);
  } catch (err) {
    onLog?.("error", `CSV export failed: ${err}`);
  }
}

// ── Spinning turbine SVG ──────────────────────────────────────────────────────

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

// ── Status icon ───────────────────────────────────────────────────────────────

function StatusIcon({ status, size = 13 }) {
  if (status === "done")    return <CheckCircle2 size={size} strokeWidth={2} style={{ color: "#16A34A" }} />;
  if (status === "failed")  return <XCircle      size={size} strokeWidth={2} style={{ color: "#DC2626" }} />;
  if (status === "running") return <Loader2      size={size} strokeWidth={2} style={{ color: ACCENT, animation: "spin 1s linear infinite" }} />;
  return <span className={s.dotQueued} />;
}

// ── Main component ────────────────────────────────────────────────────────────

export default function BatchRunPanel({
  onLog, project, moduleFiles, simRunning,
  // Optional: called by WindFieldBatchPanel "Send to Sim Batch"
  externalSweep,
}) {
  const { resolvedPath: ofBinary } = useBinarySettings("openfast");

  // Wind source
  const [windSource,    setWindSource]    = useState("sweep"); // "sweep" | "steady"
  const [sweeps,        setSweeps]        = useState([]);
  const [sweepsLoading, setSweepsLoading] = useState(false);
  const [steadySpeeds,  setSteadySpeeds]  = useState("4,6,8,10,12,14,16,18,20,22,24");
  const [steadyHubHt,   setSteadyHubHt]  = useState(90);
  const [pendingImport, setPendingImport] = useState(null);

  // UI state
  const [tab,           setTab]           = useState("define");
  const [cases,         setCases]         = useState([]);
  const [workers,       setWorkers]       = useState(() => {
    try { return Number(localStorage.getItem("fws-default-workers")) || 2; }
    catch { return 2; }
  });
  const [batchLabel,    setBatchLabel]    = useState("");
  const [queueFilter,   setQueueFilter]   = useState("all");
  const [expandedLogId, setExpandedLogId] = useState(null);

  // Run state
  const [runStatus,     setRunStatus]     = useState("idle"); // idle | running | done
  const [batchStatus,   setBatchStatus]   = useState({});     // id → { status, pct, logs[], startTime, endTime, caseDir, errorMsg }
  const [workerCaseIds, setWorkerCaseIds] = useState([]);
  const [runStartTime,  setRunStartTime]  = useState(null);
  const [now,           setNow]           = useState(Date.now);

  // Refs
  const caseQueueRef   = useRef([]);
  const stopRef        = useRef(false);
  const listenersRef   = useRef([]);
  const pidsRef        = useRef(new Set()); // PIDs of all running OpenFAST processes
  const batchNameRef   = useRef("");   // active batch folder name — stable across async
  const batchRootRef   = useRef("");   // full path to batch root dir

  // Elapsed ticker
  useEffect(() => {
    if (runStatus !== "running") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [runStatus]);

  // Cleanup listeners on unmount
  useEffect(() => () => {
    listenersRef.current.forEach(fn => fn?.());
    listenersRef.current = [];
  }, []);

  // ── Sweep scanner ──────────────────────────────────────────────────────────
  const loadSweeps = useCallback(async () => {
    if (!project?.workingDir) return;
    setSweepsLoading(true);
    try {
      const raw = await invoke("sidecar_call", {
        payload: JSON.stringify({ cmd: "scan_sweeps", working_dir: project.workingDir }),
      });
      const res = JSON.parse(raw);
      if (res.ok) setSweeps(res.sweeps ?? []);
    } catch { /* ignore */ }
    finally { setSweepsLoading(false); }
  }, [project?.workingDir]);

  useEffect(() => { loadSweeps(); }, [loadSweeps]);

  // Accept sweeps pushed from WindFieldBatchPanel via externalSweep prop
  useEffect(() => {
    if (!externalSweep) return;
    // Same tMax strategy as importSweep: manifest UsableTime clamped to actual BTS duration.
    const load = async () => {
      const newCases = await Promise.all((externalSweep.cases ?? []).map(async c => {
        const manifestTMax = c.t_max ?? c.tMax ?? null;
        let btsDuration = null;
        try {
          const d = await invoke("read_bts_duration", { path: c.bts_path });
          if (d > 0) btsDuration = Math.floor(d);
        } catch { /* file not generated yet */ }
        const tMax = manifestTMax !== null && btsDuration !== null
          ? Math.min(manifestTMax, btsDuration)
          : btsDuration ?? manifestTMax ?? 600;
        return {
          id:       uid(),
          name:     c.id,
          btsPath:  c.bts_path,
          tMax,
          enabled:  true,
          windMode: "bts",
        };
      }));
      if (newCases.length > 0)
        setPendingImport({ count: newCases.length, cases: newCases, label: externalSweep.label || "Wind Field Batch" });
    };
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalSweep]);

  const importSweep = async (sweep) => {
    // tMax strategy for sweep cases:
    //   1. Prefer manifest t_max (= UsableTime the user configured in TurbSim — the intended sim duration).
    //   2. If the .bts file already exists, read its header to get nt×dt (= AnalysisTime).
    //      Use that as a hard upper-bound: clamp manifest value down if somehow it exceeds the file.
    //   3. If neither is available fall back to 600 s.
    const newCases = await Promise.all((sweep.cases ?? []).map(async c => {
      const manifestTMax = c.t_max ?? null;  // UsableTime stored by Python at generation time
      let btsDuration    = null;             // nt×dt from binary header (AnalysisTime)
      try {
        const d = await invoke("read_bts_duration", { path: c.bts_path });
        if (d > 0) btsDuration = Math.floor(d);
      } catch (err) {
        onLog?.("warn", `read_bts_duration failed for ${c.bts_path}: ${err}`);
      }

      let tMax;
      if (manifestTMax !== null && btsDuration !== null) {
        tMax = Math.max(manifestTMax, btsDuration); // use the larger: cover full available data
      } else if (btsDuration !== null) {
        tMax = btsDuration;
      } else if (manifestTMax !== null) {
        tMax = manifestTMax;
      } else {
        tMax = 600;
      }

      return {
        id:       uid(),
        name:     c.id,
        btsPath:  c.bts_path,
        tMax,
        enabled:  true,
        windMode: "bts",
      };
    }));
    if (newCases.length > 0)
      setPendingImport({ count: newCases.length, cases: newCases, label: sweep.label });
  };

  const buildManualBtsCases = async () => {
    try {
      const selected = await openDialog({
        multiple: true,
        filters: [{ name: "TurbSim binary wind file", extensions: ["bts"] }],
        title: "Select .bts wind files",
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      if (paths.length === 0) return;

      // Read duration from each BTS header (reads only 64 bytes — very fast)
      const newCases = await Promise.all(paths.map(async p => {
        const fileName = p.replace(/\\/g, "/").split("/").pop().replace(/\.bts$/i, "");
        let tMax       = 600;       // safe default if header read fails
        let tMaxSource = "fallback"; // "bts" = read from header, "fallback" = default used
        try {
          const duration = await invoke("read_bts_duration", { path: p });
          if (duration > 0) { tMax = Math.floor(duration); tMaxSource = "bts"; }
        } catch { /* non-BTS file or unrecognised layout — keep default */ }
        return {
          id:        uid(),
          name:      fileName,
          btsPath:   p,
          tMax,
          tMaxSource, // surfaced in confirmation strip; not used at runtime
          enabled:   true,
          windMode:  "bts",
        };
      }));

      setPendingImport({ count: newCases.length, cases: newCases, label: "Manual .bts selection", allowAdd: true });
    } catch { /* user cancelled */ }
  };

  const buildSteadyCases = () => {
    const speeds = steadySpeeds.split(",").map(v => parseFloat(v.trim())).filter(v => !isNaN(v) && v > 0);
    if (speeds.length === 0) { onLog?.("warn", "Enter at least one wind speed."); return; }
    const newCases = speeds.map(v => ({
      id:        uid(),
      name:      `Steady_V${String(Math.round(v)).padStart(2,"0")}ms_${steadyHubHt}m`,
      btsPath:   "",
      windSpeed: v,
      hubHeight: Number(steadyHubHt),
      tMax:      660,
      enabled:   true,
      windMode:  "steady",
    }));
    setPendingImport({ count: newCases.length, cases: newCases, label: "Steady wind" });
  };

  const confirmImport = () => {
    if (!pendingImport) return;
    setCases(pendingImport.cases);
    setPendingImport(null);
    onLog?.("info", `Imported ${pendingImport.count} cases into Simulation Batch.`);
  };

  // Add-to-list path (manual .bts picker only — appends instead of replacing)
  const addImport = () => {
    if (!pendingImport) return;
    setCases(prev => [...prev, ...pendingImport.cases]);
    setPendingImport(null);
    onLog?.("info", `Added ${pendingImport.count} .bts file${pendingImport.count !== 1 ? "s" : ""} to the case list.`);
  };

  const cancelImport = () => setPendingImport(null);

  // ── Case table edits ────────────────────────────────────────────────────────
  const updateCase = (id, field, value) =>
    setCases(prev => prev.map(c => c.id === id ? { ...c, [field]: value } : c));
  const deleteCase = (id) => setCases(prev => prev.filter(c => c.id !== id));
  const toggleCase = (id, cur) => updateCase(id, "enabled", !cur);

  // ── Run a single case ───────────────────────────────────────────────────────
  const runSingleCase = useCallback(async (bc, binaryPath, batchName) => {
    setBatchStatus(prev => ({
      ...prev,
      [bc.id]: { status: "running", pct: 0, logs: [], startTime: Date.now(), endTime: null, caseDir: null, caseInpDir: null, errorMsg: null },
    }));

    let caseFstPath, caseDir, caseInpDir;
    try {
      ({ caseFstPath, caseDir, caseInpDir } = await prepareCase(bc, batchName, moduleFiles, project));
      // caseDir = outbDir (where OpenFAST writes the .outb)
      // caseInpDir = inp/{caseName}/ (reproducibility snapshot)
      setBatchStatus(prev => ({
        ...prev,
        [bc.id]: { ...prev[bc.id], caseDir, caseInpDir },
      }));
    } catch (err) {
      setBatchStatus(prev => ({
        ...prev,
        [bc.id]: { ...prev[bc.id], status: "failed", endTime: Date.now(), errorMsg: String(err) },
      }));
      throw err;
    }

    const stdoutEvt = `batch-stdout-${bc.id}`;
    const doneEvt   = `batch-done-${bc.id}`;

    return new Promise(async (resolve, reject) => {
      let settled       = false;
      let hasFatalError = false;   // set when FATAL ERROR seen in stdout
      let fatalMsg      = "";

      const settle = (ok, errMsg) => {
        if (settled) return;
        settled = true;
        ulOut?.();
        ulDone?.();
        ulPid?.();
        listenersRef.current = listenersRef.current.filter(f => f !== ulOut && f !== ulDone && f !== ulPid);
        const endTime = Date.now();

        // Even if Rust reports ok, override with fatal error if we detected one
        const actualOk  = ok && !hasFatalError;
        const actualMsg = !ok ? errMsg : hasFatalError ? (fatalMsg || "OpenFAST FATAL ERROR — check case log") : null;

        if (actualOk) {
          // OpenFAST writes {stem}.outb next to the .fst (in inp/{caseName}/).
          // Move it to outb/ so outputs and inputs live in separate folders.
          const stem    = caseFstPath.replace(/\\/g, "/").split("/").pop().replace(/\.fst$/i, "");
          const srcOutb = `${caseInpDir}/${stem}.outb`;
          const dstOutb = `${caseDir}/${stem}.outb`;
          invoke("rename_file", { src: srcOutb, dst: dstOutb })
            .catch(e => onLog?.("warn", `Could not move ${stem}.outb to outb/: ${e}`));

          setBatchStatus(prev => ({
            ...prev,
            [bc.id]: { ...prev[bc.id], status: "done", pct: 100, endTime },
          }));
          resolve();
        } else {
          setBatchStatus(prev => ({
            ...prev,
            [bc.id]: { ...prev[bc.id], status: "failed", endTime, errorMsg: actualMsg },
          }));
          reject(new Error(actualMsg));
        }
      };

      let ulOut, ulDone, ulPid;

      // Capture the child PID as soon as Rust emits it so Stop can kill it.
      ulPid = await listen(`batch-pid-${bc.id}`, evt => {
        const pid = Number(evt.payload);
        if (pid > 0) pidsRef.current.add(pid);
      });
      listenersRef.current.push(ulPid);

      ulOut = await listen(stdoutEvt, evt => {
        const line = String(evt.payload);
        const m    = PROGRESS_RE.exec(line);
        const pct  = m ? Math.min(100, Math.round((parseFloat(m[1]) / parseFloat(m[2])) * 100)) : null;

        // Detect OpenFAST fatal errors in stdout stream
        if (FATAL_RE.test(line)) {
          hasFatalError = true;
          fatalMsg = line.trim().slice(0, 160);
        }

        setBatchStatus(prev => {
          const cur  = prev[bc.id] ?? {};
          const logs = [...(cur.logs ?? []), line].slice(-MAX_LOG);
          return { ...prev, [bc.id]: { ...cur, logs, pct: pct ?? cur.pct } };
        });
      });
      listenersRef.current.push(ulOut);

      // done_event payload: "ok" on clean exit, "err:<code>" on non-zero exit
      ulDone = await listen(doneEvt, evt => {
        const payload = String(evt.payload ?? "");
        if (payload.startsWith("err:")) {
          const code = payload.slice(4);
          settle(false, hasFatalError ? fatalMsg || "OpenFAST FATAL ERROR" : `OpenFAST exited with code ${code}`);
        } else {
          settle(true, null);   // settle checks hasFatalError internally
        }
      });
      listenersRef.current.push(ulDone);

      invoke("run_binary_tagged", {
        binary: binaryPath,
        args:   [caseFstPath],
        cwd:    caseDir,
        caseId: bc.id,
      }).catch(err => settle(false, String(err)));
    });
  }, [moduleFiles, project]);

  // ── Worker pool runner (shared by Run All and Re-run Failed) ─────────────────
  const runWorkerPool = useCallback(async (enabledCases) => {
    const binary    = ofBinary;
    const batchName = batchNameRef.current;

    setWorkerCaseIds(Array(workers).fill(null));
    caseQueueRef.current = enabledCases.map(c => c.id);
    pidsRef.current.clear();
    stopRef.current      = false;

    setRunStatus("running");
    setRunStartTime(Date.now());
    setTab("run");

    const runWorker = async (idx) => {
      while (true) {
        if (stopRef.current) break;
        const caseId = caseQueueRef.current.shift();
        if (!caseId) break;
        const bc = enabledCases.find(c => c.id === caseId);
        if (!bc) continue;

        setWorkerCaseIds(prev => { const n = [...prev]; n[idx] = caseId; return n; });
        onLog?.("info", `[W${idx + 1}] → ${bc.name}`);
        try {
          await runSingleCase(bc, binary, batchName);
          onLog?.("ok", `[W${idx + 1}] ✓ ${bc.name}`);
        } catch (err) {
          onLog?.("error", `[W${idx + 1}] ✗ ${bc.name}: ${err.message ?? err}`);
        }
      }
      setWorkerCaseIds(prev => { const n = [...prev]; n[idx] = null; return n; });
    };

    await Promise.all(Array.from({ length: workers }, (_, i) => runWorker(i)));

    setRunStatus("done");
    setTab("results");
    onLog?.("ok", `Batch "${batchName}" finished.`);
  }, [ofBinary, workers, runSingleCase, onLog]);

  // ── Run All ─────────────────────────────────────────────────────────────────
  const handleRunAll = useCallback(async () => {
    if (!ofBinary) {
      onLog?.("error", "OpenFAST binary not found — check the binary path in the app settings.");
      return;
    }
    if (!moduleFiles?.fstPath) {
      onLog?.("error", "No .fst file loaded. Import an OpenFAST model in the OpenFAST panel first.");
      return;
    }
    const enabled = cases.filter(c => c.enabled);
    if (enabled.length === 0) {
      onLog?.("warn", "No cases are enabled. Tick the checkbox next to each case you want to run.");
      return;
    }

    // Build batch name from user label + timestamp
    const d  = new Date();
    const ts = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}_${String(d.getHours()).padStart(2,"0")}${String(d.getMinutes()).padStart(2,"0")}${String(d.getSeconds()).padStart(2,"0")}`;
    const label     = sanitizeName(batchLabel);
    const batchName = label ? `${label}_${ts}` : `batch_${ts}`;
    batchNameRef.current = batchName;

    const resultsDir = project.resultsDir ?? `${project.workingDir}/results`;
    batchRootRef.current = `${resultsDir}/${batchName}`;

    // Pre-create the outb/ directory before any worker starts.
    // OpenFAST (cwd=outbDir) will write {caseName}.outb there directly.
    const outbDir = `${batchRootRef.current}/outb`;
    try {
      await invoke("write_text_file", {
        path:    `${outbDir}/.fws_batch`,
        content: `batch: ${batchName}\ncreated: ${new Date().toISOString()}\ncases: ${enabled.length}\n`,
      });
    } catch (e) {
      onLog?.("warn", `Could not pre-create outb/ directory: ${e}`);
    }

    // Init status for all enabled cases
    const initSt = {};
    enabled.forEach(c => {
      initSt[c.id] = { status: "queued", pct: 0, logs: [], startTime: null, endTime: null, caseDir: null, caseInpDir: null, errorMsg: null };
    });
    setBatchStatus(initSt);
    setExpandedLogId(null);

    onLog?.("info", `Starting batch "${batchName}" — ${enabled.length} case(s) · ${workers} worker(s) · outb → results/${batchName}/outb/`);
    await runWorkerPool(enabled);
  }, [cases, workers, batchLabel, ofBinary, moduleFiles, project, runWorkerPool, onLog]);

  // ── Re-run Failed ───────────────────────────────────────────────────────────
  const handleRerunFailed = useCallback(async () => {
    if (!ofBinary || !moduleFiles?.fstPath) return;

    const failedCases = cases.filter(c => {
      const st = batchStatus[c.id];
      return st?.status === "failed" && st?.errorMsg !== "Cancelled" && c.enabled;
    });
    if (failedCases.length === 0) return;

    // Reset failed cases to queued
    setBatchStatus(prev => {
      const next = { ...prev };
      failedCases.forEach(c => {
        next[c.id] = { status: "queued", pct: 0, logs: [], startTime: null, endTime: null, caseDir: null, errorMsg: null };
      });
      return next;
    });

    onLog?.("info", `Re-running ${failedCases.length} failed case(s) in batch "${batchNameRef.current}".`);
    await runWorkerPool(failedCases);
  }, [cases, batchStatus, ofBinary, moduleFiles, runWorkerPool, onLog]);

  // ── Stop ────────────────────────────────────────────────────────────────────
  const handleStop = () => {
    stopRef.current      = true;
    caseQueueRef.current = [];

    // Kill all running OpenFAST child processes immediately
    pidsRef.current.forEach(pid => {
      invoke("kill_pid", { pid }).catch(() => {});
    });
    pidsRef.current.clear();

    setRunStatus("idle");
    setBatchStatus(prev => {
      const next = { ...prev };
      const now  = Date.now();
      Object.entries(next).forEach(([id, st]) => {
        if (st.status === "queued" || st.status === "running") {
          next[id] = { ...st, status: "failed", endTime: now, errorMsg: "Cancelled" };
        }
      });
      return next;
    });
    onLog?.("warn", "Batch run stopped by user — all running processes killed.");
  };

  // ── Reset ───────────────────────────────────────────────────────────────────
  const handleReset = () => {
    setRunStatus("idle");
    setBatchStatus({});
    setExpandedLogId(null);
    setTab("define");
  };

  // ── Derived numbers ──────────────────────────────────────────────────────────
  const enabledCount  = cases.filter(c => c.enabled).length;
  const allSt         = Object.values(batchStatus);
  const totalRun      = Object.keys(batchStatus).length;
  const doneCount     = allSt.filter(v => v.status === "done").length;
  const failedCount   = allSt.filter(v => v.status === "failed" && v.errorMsg !== "Cancelled").length;
  const cancelCount   = allSt.filter(v => v.status === "failed" && v.errorMsg === "Cancelled").length;
  const runningCases  = allSt.filter(v => v.status === "running").length;
  const overallPct    = totalRun > 0 ? Math.round(((doneCount + failedCount + cancelCount) / totalRun) * 100) : 0;
  const elapsedMs     = runStartTime ? now - runStartTime : 0;
  const etaStr        = formatETA((doneCount + failedCount + cancelCount) / Math.max(1, totalRun), elapsedMs);
  const hasFst        = !!(moduleFiles?.fstPath);

  // Filter case objects by their run status (for Run tab queue)
  const filteredCases = Object.entries(batchStatus)
    .map(([id, st]) => ({ id, st }))
    .filter(({ st }) => {
      if (queueFilter === "all")     return true;
      if (queueFilter === "running") return st.status === "running";
      if (queueFilter === "done")    return st.status === "done";
      if (queueFilter === "failed")  return st.status === "failed" || st.status === "queued";
      return true;
    });

  const rerunCount = cases.filter(c => {
    const st = batchStatus[c.id];
    return st?.status === "failed" && st?.errorMsg !== "Cancelled" && c.enabled;
  }).length;

  const TABS = [
    { id: "define",  label: "Define" },
    { id: "run",     label: "Run",
      badge: runStatus === "running"
        ? `${overallPct}%`
        : totalRun > 0 ? `${doneCount}/${totalRun}` : null },
    { id: "results", label: "Results",
      badge: runStatus === "done" && failedCount > 0 ? `${failedCount} failed` : null },
  ];

  // ── JSX ──────────────────────────────────────────────────────────────────────
  return (
    <div className={s.panel}>

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className={s.header}>
        <Play size={14} strokeWidth={1.8} style={{ color: ACCENT, flexShrink: 0 }} />
        <span className={s.title}>Batch Run</span>
        <span className={s.badge}>OpenFAST</span>

        {runStatus === "running" && (
          <span className={s.badge}>{overallPct}%</span>
        )}
        {runStatus === "done" && doneCount > 0 && (
          <span className={s.badge} style={{ background: "rgba(22,163,74,0.12)", color: "#16A34A" }}>
            {doneCount}/{totalRun} done
          </span>
        )}
        {failedCount > 0 && (
          <span className={[s.badge, s.badgeFailed].join(" ")}>{failedCount} failed</span>
        )}

        <span className={s.headerSpacer} />

        {runStatus === "idle" && cases.length > 0 && (
          <button
            className={[s.headerBtn, s.headerBtnPrimary].join(" ")}
            onClick={handleRunAll}
            disabled={!hasFst || enabledCount === 0 || simRunning}
            title={!hasFst ? "Load a .fst in OpenFAST first" : !ofBinary ? "OpenFAST binary not found" : ""}
          >
            <Play size={11} strokeWidth={2} />
            Run {enabledCount} case{enabledCount !== 1 ? "s" : ""}
          </button>
        )}
        {runStatus === "running" && (
          <button className={[s.headerBtn, s.headerBtnSecondary].join(" ")} onClick={handleStop}>
            <Square size={11} strokeWidth={2} />
            Stop
          </button>
        )}
        {runStatus === "done" && (
          <button className={[s.headerBtn, s.headerBtnSecondary].join(" ")} onClick={handleReset}>
            <RefreshCw size={11} strokeWidth={2} />
            Reset
          </button>
        )}
      </div>

      {/* ── Tab bar ─────────────────────────────────────────────────────── */}
      <div className={s.tabBar}>
        {TABS.map(t => (
          <button
            key={t.id}
            className={[s.tab, tab === t.id ? s.tabActive : ""].join(" ")}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.badge && (
              <span style={{
                fontSize: 10,
                background: t.id === "results" && failedCount > 0
                  ? "rgba(220,38,38,0.12)" : "rgba(124,58,237,0.13)",
                color: t.id === "results" && failedCount > 0 ? "#DC2626" : ACCENT,
                borderRadius: 4, padding: "1px 5px", marginLeft: 3,
              }}>
                {t.badge}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── Scrollable content ───────────────────────────────────────────── */}
      <div className={s.content}>

        {/* ════════ DEFINE TAB ════════ */}
        {tab === "define" && (
          <>
            {/* ── Alerts ── */}
            {!ofBinary && (
              <div className={s.calloutWarn}>
                <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>OpenFAST binary not found. Open <strong>Settings</strong> (⚙ in the sidebar footer) to configure the binary path.</span>
              </div>
            )}
            {!hasFst && (
              <div className={s.callout}>
                <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>Load a turbine model in <strong>OpenFAST → Import .fst</strong> before running batch simulations.</span>
              </div>
            )}
            {hasFst && !moduleFiles?.inflowwind && (
              <div className={s.calloutWarn}>
                ⚠ No InflowWind file detected from the loaded .fst — a minimal InflowWind will be generated automatically.{" "}
                <strong>Verify against your turbine settings before trusting results.</strong>
              </div>
            )}

            {/* ── Card 1: Wind Source ── */}
            <div className={s.defineCard}>
              <div className={s.defineCardHead}>
                <Wind size={13} strokeWidth={2} style={{ color: "var(--tx-3)", flexShrink: 0 }} />
                <span className={s.defineCardTitle}>Wind Source</span>
                {hasFst && (
                  <span style={{ fontSize: 11, color: "var(--tx-5)", fontFamily: "'SF Mono',ui-monospace,monospace" }}>
                    {moduleFiles.fstPath.split("/").pop()}
                  </span>
                )}
                {windSource === "sweep" && (
                  <button className={s.defineCardAction} onClick={loadSweeps}>
                    <RefreshCw size={10} strokeWidth={2.5} />
                    Refresh
                  </button>
                )}
              </div>

              {/* Source selector tabs */}
              <div className={s.sourceTabRow}>
                {[
                  { id: "sweep",  label: "Project sweeps", icon: <Layers    size={12} strokeWidth={2} /> },
                  { id: "steady", label: "Steady wind",    icon: <Waves     size={12} strokeWidth={2} /> },
                  { id: "manual", label: "Manual .bts",    icon: <FolderOpen size={12} strokeWidth={2} /> },
                ].map(src => (
                  <button
                    key={src.id}
                    className={[s.sourceTab, windSource === src.id ? s.sourceTabActive : ""].join(" ")}
                    onClick={() => setWindSource(src.id)}
                  >
                    {src.icon}
                    {src.label}
                  </button>
                ))}
              </div>

              {/* Source content */}
              <div className={s.defineCardBody}>

                {/* ── Sweep scanner ── */}
                {windSource === "sweep" && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {sweepsLoading && (
                      <span style={{ fontSize: 12, color: "var(--tx-5)" }}>Scanning…</span>
                    )}
                    {!sweepsLoading && sweeps.length === 0 && (
                      <div className={s.callout} style={{ marginBottom: 0 }}>
                        <Wind size={13} style={{ flexShrink: 0 }} />
                        <span>No sweeps found. Generate .bts files in <strong>Wind Field Batch</strong> first.</span>
                      </div>
                    )}
                    {!sweepsLoading && sweeps.length > 0 && (
                      <span style={{ fontSize: 11.5, color: "var(--tx-4)", marginBottom: 2 }}>
                        {sweeps.length} sweep{sweeps.length !== 1 ? "s" : ""} found in wind/sweeps/
                      </span>
                    )}
                    {sweeps.map(sw => (
                      <div key={sw.batch_id} className={s.sweepCard}>
                        <div className={s.sweepCardInfo}>
                          <div style={{ display: "flex", alignItems: "baseline", gap: 7, flexWrap: "wrap" }}>
                            <span className={s.sweepCardLabel}>
                              {sw.label || (sw.mode === "dlc" ? "IEC DLC sweep" : "Custom sweep")}
                            </span>
                            <span className={s.sweepCardId}>{sw.batch_id}</span>
                          </div>
                          <span className={s.sweepCardMeta}>
                            {sw.mode === "dlc" ? "DLC" : "Custom"} ·{" "}
                            {sw.case_count} cases ·{" "}
                            {sw.bts_count}/{sw.case_count} .bts ready
                            {sw.speeds?.length > 0 && ` · ${sw.speeds[0]}–${sw.speeds[sw.speeds.length - 1]} m/s`}
                          </span>
                          {sw.created && (
                            <span className={s.sweepCardDate}>{new Date(sw.created).toLocaleString()}</span>
                          )}
                        </div>
                        <button
                          className={s.sweepCardImportBtn}
                          onClick={() => importSweep(sw)}
                          disabled={sw.bts_count === 0}
                          title={sw.bts_count === 0 ? "No .bts files ready yet — run TurbSim first" : ""}
                        >
                          Import {sw.bts_count} cases
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {/* ── Steady wind ── */}
                {windSource === "steady" && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    <div className={s.callout} style={{ marginBottom: 0, fontSize: 12 }}>
                      <Waves size={13} style={{ flexShrink: 0 }} />
                      <span>InflowWind WindType=1 — no .bts files needed. One case per wind speed.</span>
                    </div>
                    <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: "var(--tx-3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Wind speeds (m/s)</span>
                      <input
                        className={s.batchNameInput}
                        value={steadySpeeds}
                        onChange={e => setSteadySpeeds(e.target.value)}
                        placeholder="4,6,8,10,12,14,16,18,20,22,24"
                        spellCheck={false}
                      />
                    </label>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: "var(--tx-3)", textTransform: "uppercase", letterSpacing: "0.06em", minWidth: 74 }}>Hub height</span>
                        <input
                          type="number"
                          className={s.tMaxInput}
                          value={steadyHubHt}
                          onChange={e => setSteadyHubHt(e.target.value)}
                          min={10}
                          style={{ width: 72, textAlign: "left" }}
                        />
                        <span style={{ fontSize: 12, color: "var(--tx-5)" }}>m</span>
                      </label>
                      <button
                        className={s.runBtn}
                        onClick={buildSteadyCases}
                        style={{ marginLeft: "auto", height: 30, padding: "0 14px", fontSize: 12 }}
                      >
                        Build {steadySpeeds.split(",").filter(v => !isNaN(parseFloat(v.trim()))).length} cases
                      </button>
                    </div>
                  </div>
                )}

                {/* ── Manual .bts picker ── */}
                {windSource === "manual" && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    <div className={s.callout} style={{ marginBottom: 0, fontSize: 12 }}>
                      <FolderOpen size={13} style={{ flexShrink: 0 }} />
                      <span>Pick any .bts files on disk. T<sub>max</sub> is auto-detected from each file's header. Each file becomes one simulation case.</span>
                    </div>
                    <button
                      className={s.runBtn}
                      onClick={buildManualBtsCases}
                      style={{ alignSelf: "flex-start", height: 30, padding: "0 14px", fontSize: 12 }}
                    >
                      <FolderOpen size={12} strokeWidth={2} />
                      Browse .bts files…
                    </button>
                  </div>
                )}

                {/* ── Import confirmation strip ── */}
                {pendingImport && (
                  <div className={s.previewStrip} style={{ margin: "12px -16px -14px", borderRadius: "0 0 10px 10px" }}>
                    <span className={s.previewText}>
                      <span className={s.previewStrong}>{pendingImport.count} file{pendingImport.count !== 1 ? "s" : ""}</span>
                      {pendingImport.label && ` from "${pendingImport.label}"`}
                      {pendingImport.allowAdd && cases.length > 0
                        ? " — add to the current list or replace it?"
                        : " — this replaces the current list."}
                    </span>

                    {/* Per-file TMax preview — manual picks only */}
                    {pendingImport.allowAdd && pendingImport.cases.some(c => c.tMaxSource) && (() => {
                      const SHOW = 6;
                      const visible     = pendingImport.cases.slice(0, SHOW);
                      const overflow    = pendingImport.cases.length - SHOW;
                      const hasFallback = pendingImport.cases.some(c => c.tMaxSource === "fallback");
                      return (
                        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 2 }}>
                          <span style={{ fontSize: 10.5, color: "var(--tx-4)", fontWeight: 600, letterSpacing: "0.03em", marginBottom: 2 }}>
                            T<sub>max</sub> auto-detected from BTS header — editable in the case table
                          </span>
                          {visible.map(c => (
                            <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
                              <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", flexShrink: 0, background: c.tMaxSource === "bts" ? "#16A34A" : "#F59E0B" }} />
                              <span style={{ color: "var(--tx-3)", fontFamily: "'SF Mono',ui-monospace,monospace", fontSize: 10.5, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {c.name}.bts
                              </span>
                              <span style={{ color: c.tMaxSource === "bts" ? "var(--tx-2)" : "#F59E0B", fontFamily: "'SF Mono',ui-monospace,monospace", fontSize: 10.5, flexShrink: 0 }}>
                                {c.tMax} s{c.tMaxSource === "fallback" ? " ⚠ fallback" : ""}
                              </span>
                            </div>
                          ))}
                          {overflow > 0 && <span style={{ fontSize: 10.5, color: "var(--tx-5)", paddingLeft: 12 }}>+{overflow} more</span>}
                          {hasFallback && (
                            <p style={{ fontSize: 10.5, color: "#F59E0B", marginTop: 4, lineHeight: 1.4 }}>
                              ⚠ Some files couldn't be read — TMax set to 600 s. Adjust in the case table if needed.
                            </p>
                          )}
                        </div>
                      );
                    })()}

                    <div className={s.previewActions}>
                      <button className={s.previewCancel} onClick={cancelImport}>Cancel</button>
                      {pendingImport.allowAdd && cases.length > 0 && (
                        <button className={s.previewAdd} onClick={addImport}>
                          Add ({cases.length + pendingImport.count} total)
                        </button>
                      )}
                      <button className={s.previewConfirm} onClick={confirmImport}>
                        {pendingImport.allowAdd && cases.length > 0 ? "Replace list" : "Import"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* ── Card 2: Run Configuration (workers + batch label) ── */}
            <div className={s.defineCard}>
              <div className={s.defineCardHead}>
                <Zap size={13} strokeWidth={2} style={{ color: "var(--tx-3)", flexShrink: 0 }} />
                <span className={s.defineCardTitle}>Run Configuration</span>
              </div>
              <div className={s.defineConfigGrid}>
                {/* Workers */}
                <div className={s.defineConfigCol}>
                  <p className={s.defineFieldLabel}>Parallel workers</p>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div className={s.workersBtns}>
                      {[1, 2, 3, 4].map(n => (
                        <button
                          key={n}
                          className={[s.workerBtn, workers === n ? s.workerBtnActive : ""].join(" ")}
                          onClick={() => setWorkers(n)}
                        >
                          {n}
                        </button>
                      ))}
                    </div>
                  </div>
                  <p style={{ fontSize: 11.5, color: "var(--tx-4)", marginTop: 6 }}>
                    {workers === 1 ? "Sequential — one case at a time" : `${workers} simultaneous OpenFAST processes`}
                  </p>
                </div>

                {/* Batch label */}
                <div className={s.defineConfigCol}>
                  <p className={s.defineFieldLabel}>Batch label <span style={{ textTransform: "none", fontWeight: 400, letterSpacing: 0, color: "var(--tx-6)" }}>(optional)</span></p>
                  <input
                    className={s.batchNameInput}
                    value={batchLabel}
                    onChange={e => setBatchLabel(e.target.value)}
                    placeholder="e.g. IEA15_DLC11_baseline"
                    spellCheck={false}
                  />
                  <p className={s.batchNameHint} style={{ marginTop: 5 }}>
                    → <code>results/{sanitizeName(batchLabel) || "batch"}_YYYYMMDD_HHMMSS/</code>
                  </p>
                </div>
              </div>
            </div>

            {/* ── Card 3: Case table ── */}
            {cases.length > 0 && (
              <div className={s.defineCard} style={{ overflow: "hidden" }}>
                <div className={s.defineCardHead}>
                  <Layers size={13} strokeWidth={2} style={{ color: "var(--tx-3)", flexShrink: 0 }} />
                  <span className={s.defineCardTitle}>
                    Cases
                    <span style={{ fontWeight: 400, color: "var(--tx-5)", marginLeft: 6 }}>— {enabledCount} enabled</span>
                  </span>
                  {hasFst && moduleFiles?.fstPath && (
                    <span style={{ fontSize: 10.5, fontFamily: "'SF Mono',ui-monospace,monospace", color: "var(--tx-5)" }}>
                      {moduleFiles.fstPath.split("/").pop()}
                    </span>
                  )}
                  <div className={s.tableActions} style={{ marginLeft: 8 }}>
                    <button className={s.tableActionBtn} onClick={() => setCases(prev => prev.map(c => ({ ...c, enabled: true })))}>Select all</button>
                    <button className={s.tableActionBtn} onClick={() => setCases(prev => prev.map(c => ({ ...c, enabled: false })))}>Deselect all</button>
                    <button className={s.tableActionBtn} onClick={() => setCases([])}>Clear all</button>
                    <button
                      className={s.runBtn}
                      onClick={handleRunAll}
                      disabled={!hasFst || !ofBinary || enabledCount === 0 || simRunning || runStatus === "running"}
                      title={!hasFst ? "Load a .fst in OpenFAST first" : !ofBinary ? "OpenFAST binary not found" : ""}
                    >
                      <Play size={11} strokeWidth={2} />
                      Run All
                      <span className={s.runBtnSub}>{workers}×</span>
                    </button>
                  </div>
                </div>

                <table className={s.table}>
                  <thead>
                    <tr>
                      <th className={s.th} style={{ width: 32, textAlign: "center" }}>✓</th>
                      <th className={s.th} style={{ width: 24, textAlign: "center" }}>#</th>
                      <th className={s.th}>Name</th>
                      <th className={s.th}>Wind file (.bts)</th>
                      <th className={s.th} style={{ width: 100, textAlign: "right" }}>T<sub>max</sub> (s)</th>
                      <th className={s.th} style={{ width: 28 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {cases.map((c, idx) => (
                      <tr key={c.id} className={[s.tr, c.enabled ? s.trSelected : ""].join(" ")}>
                        <td className={[s.td, s.tdCb].join(" ")}>
                          <input type="checkbox" checked={c.enabled} onChange={() => toggleCase(c.id, c.enabled)} style={{ accentColor: ACCENT }} />
                        </td>
                        <td className={[s.td, s.tdIdx].join(" ")}>{idx + 1}</td>
                        <td className={s.td}>
                          <div className={s.nameCellInner}>
                            <input className={s.nameInput} value={c.name} onChange={e => updateCase(c.id, "name", e.target.value)} spellCheck={false} />
                          </div>
                        </td>
                        <td className={[s.td, s.tdMono].join(" ")} title={c.btsPath}>{shortPath(c.btsPath)}</td>
                        <td className={[s.td, s.tdNum].join(" ")}>
                          <input className={s.tMaxInput} type="number" value={c.tMax} onChange={e => updateCase(c.id, "tMax", e.target.value)} />
                        </td>
                        <td className={s.td}>
                          <button className={s.deleteRowBtn} onClick={() => deleteCase(c.id)} title="Remove case">
                            <Trash2 size={11} strokeWidth={2} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {cases.length === 0 && (
              <div className={s.emptyState}>
                <Wind size={32} strokeWidth={1.2} className={s.emptyStateIcon} />
                <span>No cases yet — import from a project sweep, build steady-wind cases, or pick .bts files above.</span>
              </div>
            )}
          </>
        )}

        {/* ════════ RUN TAB ════════ */}
        {tab === "run" && (
          <>
            {totalRun === 0 ? (
              <div className={s.emptyState}>
                <Play size={32} strokeWidth={1.2} className={s.emptyStateIcon} />
                <span>No run in progress. Switch to Define and click Run All.</span>
              </div>
            ) : (
              <>
                {/* Overall progress header */}
                <div className={s.runHeader}>
                  <div>
                    <span className={s.runTitle}>
                      {runStatus === "running" && "Running…"}
                      {runStatus === "done"    && "Complete"}
                      {runStatus === "idle"    && "Stopped"}
                    </span>
                    {batchNameRef.current && (
                      <span className={s.runBatchName}>{batchNameRef.current}</span>
                    )}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {elapsedMs > 0 && (
                      <span className={s.etaChip}>
                        {formatElapsed(elapsedMs)}
                        {etaStr && runStatus === "running" && (
                          <span style={{ opacity: 0.7 }}> · ~{etaStr} left</span>
                        )}
                      </span>
                    )}
                    {runStatus === "running" && (
                      <button className={[s.controlBtn, s.controlBtnDanger].join(" ")} onClick={handleStop}>
                        <Square size={11} strokeWidth={2} /> Stop
                      </button>
                    )}
                    {runStatus === "done" && (
                      <button className={s.controlBtn} onClick={() => setTab("results")}>
                        <FileText size={11} strokeWidth={2} /> View results
                      </button>
                    )}
                  </div>
                </div>

                {/* Overall progress bar */}
                <div className={s.overallBar}>
                  <div className={s.overallBarFill} style={{ width: `${overallPct}%` }} />
                </div>
                <p className={s.overallLabel}>
                  {doneCount + failedCount + cancelCount} / {totalRun} cases
                  {doneCount > 0    && ` · ${doneCount} done`}
                  {failedCount > 0  && ` · ${failedCount} failed`}
                  {cancelCount > 0  && ` · ${cancelCount} cancelled`}
                  {runningCases > 0 && ` · ${runningCases} running`}
                </p>

                {/* Turbine hero card */}
                <div className={s.batchTurbineRow}>
                  <div className={s.batchTurbineCard}>
                    {runStatus === "running" && <div className={s.batchTurbinePulse} />}
                    <TurbineIcon
                      spinning={runStatus === "running"}
                      className={[s.batchTurbineIcon, runStatus === "running" ? s.batchTurbineRunning : ""].join(" ")}
                    />
                    <div className={s.batchTurbineStats}>
                      <div className={s.batchTurbineStat}>
                        <span className={s.batchTurbineStatNum}>{overallPct}%</span>
                        <span className={s.batchTurbineStatLabel}>Progress</span>
                      </div>
                      <div className={s.batchTurbineStat}>
                        <span className={s.batchTurbineStatNum}>{doneCount}</span>
                        <span className={s.batchTurbineStatLabel}>Done</span>
                      </div>
                      <div className={s.batchTurbineStat}>
                        <span className={s.batchTurbineStatNum}>{totalRun - doneCount - failedCount - cancelCount}</span>
                        <span className={s.batchTurbineStatLabel}>Remaining</span>
                      </div>
                      <div className={s.batchTurbineStat}>
                        <span className={s.batchTurbineStatNum}>{workers}</span>
                        <span className={s.batchTurbineStatLabel}>Workers</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Worker cards */}
                <div className={s.workerCards}>
                  {workerCaseIds.map((caseId, idx) => {
                    const caseObj = cases.find(c => c.id === caseId);
                    const st      = batchStatus[caseId];
                    const elapsed = st?.startTime ? now - st.startTime : 0;
                    const logs    = st?.logs ?? [];

                    return (
                      <div key={idx} className={s.workerCard}>
                        <div className={s.workerCardHead}>
                          <span className={s.workerCardTitle}>
                            {caseId
                              ? caseObj?.name ?? caseId
                              : <span style={{ fontStyle: "italic", fontWeight: 400, color: "var(--tx-5)" }}>Idle</span>
                            }
                          </span>
                          <span className={s.workerBadge}>W{idx + 1}</span>
                          {elapsed > 0 && <span className={s.workerCardElapsed}>{formatElapsed(elapsed)}</span>}
                        </div>

                        {caseId && st ? (
                          <>
                            <div className={s.caseBar}>
                              <div className={s.caseBarTrack}>
                                <div className={s.caseBarFill} style={{ width: `${st.pct ?? 0}%` }} />
                              </div>
                              <span className={s.caseBarPct}>{st.pct ?? 0}%</span>
                            </div>
                            <div className={s.logBox}>
                              {logs.length === 0 && (
                                <span style={{ color: "var(--tx-6)", fontStyle: "italic" }}>Waiting for output…</span>
                              )}
                              {logs.slice(-8).map((line, li) => {
                                const isTime = PROGRESS_RE.test(line);
                                return (
                                  <div key={li} className={[s.logLine, isTime ? s.logLineTime : ""].join(" ")}>
                                    {line}
                                  </div>
                                );
                              })}
                            </div>
                          </>
                        ) : (
                          <div className={s.workerCardIdle}>
                            <span>Waiting for next case…</span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Queue list with log drawer */}
                <div className={s.queueSection}>
                  <div className={s.queueFilterRow}>
                    <span className={s.queueFilterLabel}>Show</span>
                    <div className={s.queueFilter}>
                      {[
                        { id: "all",     label: "All" },
                        { id: "running", label: "Running" },
                        { id: "done",    label: "Done" },
                        { id: "failed",  label: "Queued / Failed" },
                      ].map(f => (
                        <button
                          key={f.id}
                          className={[s.queueFilterBtn, queueFilter === f.id ? s.queueFilterBtnActive : ""].join(" ")}
                          onClick={() => setQueueFilter(f.id)}
                        >
                          {f.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className={s.queueList}>
                    {filteredCases.length === 0 && (
                      <div className={s.queueItem} style={{ justifyContent: "center", color: "var(--tx-5)", fontStyle: "italic" }}>
                        No cases match this filter
                      </div>
                    )}
                    {filteredCases.map(({ id, st }, qi) => {
                      const caseObj  = cases.find(c => c.id === id);
                      const isExpanded = expandedLogId === id;
                      const hasLogs  = (st.logs?.length ?? 0) > 0;
                      const dotCls   = { queued: s.dotQueued, running: s.dotRunning, done: s.dotDone, failed: s.dotFailed }[st.status] ?? s.dotQueued;
                      const statusCls = { queued: s.statusQueued, running: s.statusRunning, done: s.statusDone, failed: s.statusFailed }[st.status] ?? s.statusQueued;
                      const rowCls   = { running: s.queueItemRunning, done: s.queueItemDone, failed: s.queueItemFailed }[st.status] ?? "";
                      const duration = (st.startTime && st.endTime) ? formatElapsed(st.endTime - st.startTime) : null;

                      return (
                        <div key={id} className={s.queueItemGroup}>
                          <div
                            className={[s.queueItem, rowCls, hasLogs ? s.queueItemClickable : ""].join(" ")}
                            onClick={() => hasLogs && setExpandedLogId(isExpanded ? null : id)}
                          >
                            <span className={s.queueIdx}>{qi + 1}</span>
                            <span className={dotCls} />
                            <span className={s.queueName} title={caseObj?.name ?? id}>
                              {caseObj?.name ?? id}
                            </span>
                            {st.status === "running" && (
                              <span className={s.queueMeta}>{st.pct ?? 0}%</span>
                            )}
                            {duration && st.status === "done" && (
                              <span className={s.queueMeta} style={{ color: "var(--tx-5)" }}>{duration}</span>
                            )}
                            {st.errorMsg && st.status === "failed" && st.errorMsg !== "Cancelled" && (
                              <span className={s.queueMeta} title={st.errorMsg} style={{ color: "#DC2626", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {st.errorMsg}
                              </span>
                            )}
                            <span className={[s.queueStatus, statusCls].join(" ")}>
                              {st.status === "queued"  && "Queued"}
                              {st.status === "running" && "Running"}
                              {st.status === "done"    && "Done"}
                              {st.status === "failed"  && (st.errorMsg === "Cancelled" ? "Cancelled" : "Failed")}
                            </span>
                            {hasLogs && (
                              <span className={s.queueLogToggle} title={isExpanded ? "Hide log" : "Show log"}>
                                {isExpanded ? <ChevronDown size={11} strokeWidth={2} /> : <ChevronRight size={11} strokeWidth={2} />}
                              </span>
                            )}
                          </div>

                          {/* Log drawer */}
                          {isExpanded && hasLogs && (
                            <div className={s.logDrawer}>
                              {st.logs.map((line, li) => {
                                const isTime = PROGRESS_RE.test(line);
                                return (
                                  <div key={li} className={[s.logLine, isTime ? s.logLineTime : ""].join(" ")}>
                                    {line}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </>
        )}

        {/* ════════ RESULTS TAB ════════ */}
        {tab === "results" && (
          <>
            {totalRun === 0 ? (
              <div className={s.emptyState}>
                <FileText size={32} strokeWidth={1.2} className={s.emptyStateIcon} />
                <span>No completed run yet. Define cases and click Run All.</span>
              </div>
            ) : (
              <>
                {/* Summary stats */}
                <div className={s.resultsSummary}>
                  <div className={s.resultsStat}>
                    <span className={s.resultsStatNum}>{totalRun}</span>
                    <span className={s.resultsStatLabel}>Total</span>
                  </div>
                  <div className={[s.resultsStat, s.resultsStatDone].join(" ")}>
                    <span className={s.resultsStatNum}>{doneCount}</span>
                    <span className={s.resultsStatLabel}>Done</span>
                  </div>
                  {failedCount > 0 && (
                    <div className={[s.resultsStat, s.resultsStatFailed].join(" ")}>
                      <span className={s.resultsStatNum}>{failedCount}</span>
                      <span className={s.resultsStatLabel}>Failed</span>
                    </div>
                  )}
                  {cancelCount > 0 && (
                    <div className={s.resultsStat}>
                      <span className={s.resultsStatNum}>{cancelCount}</span>
                      <span className={s.resultsStatLabel}>Cancelled</span>
                    </div>
                  )}
                  {elapsedMs > 0 && (
                    <div className={s.resultsStat}>
                      <span className={s.resultsStatNum}>{formatElapsed(elapsedMs)}</span>
                      <span className={s.resultsStatLabel}>Wall time</span>
                    </div>
                  )}
                </div>

                {/* Batch name + actions row */}
                <div className={s.resultsActionsRow}>
                  {batchNameRef.current && (
                    <span className={s.resultsBatchName}>{batchNameRef.current}</span>
                  )}
                  <div style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
                    {batchRootRef.current && (
                      <button
                        className={s.resultsActionBtn}
                        onClick={() => invoke("open_in_finder", { path: batchRootRef.current }).catch(() => {})}
                        title="Open batch folder in Finder"
                      >
                        <FolderOpen size={12} strokeWidth={2} />
                        Open folder
                      </button>
                    )}
                    <button
                      className={s.resultsActionBtn}
                      onClick={() => exportBatchCSV(cases, batchStatus, batchRootRef.current, batchNameRef.current, onLog)}
                    >
                      <Download size={12} strokeWidth={2} />
                      Export CSV
                    </button>
                    {rerunCount > 0 && (
                      <button
                        className={[s.resultsActionBtn, s.resultsActionBtnRerun].join(" ")}
                        onClick={handleRerunFailed}
                        disabled={runStatus === "running"}
                      >
                        <RotateCcw size={12} strokeWidth={2} />
                        Re-run {rerunCount} failed
                      </button>
                    )}
                  </div>
                </div>

                {/* Results table */}
                <div className={s.resultsTableWrap}>
                  <table className={s.resultsTable}>
                    <thead>
                      <tr>
                        <th className={s.rth} style={{ width: 28, textAlign: "center" }}>#</th>
                        <th className={s.rth} style={{ width: 20 }}></th>
                        <th className={s.rth}>Case name</th>
                        <th className={s.rth} style={{ width: 72, textAlign: "right" }}>Duration</th>
                        <th className={s.rth} style={{ width: 96, textAlign: "center" }}>Folders</th>
                        <th className={s.rth}>Details</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cases.map((c, idx) => {
                        const st = batchStatus[c.id];
                        if (!st) return null;
                        const duration = (st.startTime && st.endTime)
                          ? formatElapsed(st.endTime - st.startTime) : "—";
                        const isFailed   = st.status === "failed" && st.errorMsg !== "Cancelled";
                        const isCancelled = st.status === "failed" && st.errorMsg === "Cancelled";
                        return (
                          <tr key={c.id} className={[
                            s.rtRow,
                            st.status === "done"    ? s.rtRowDone    : "",
                            isFailed                ? s.rtRowFailed  : "",
                            isCancelled             ? s.rtRowCancel  : "",
                          ].join(" ")}>
                            <td className={s.rtd} style={{ textAlign: "center", color: "var(--tx-5)", fontSize: 11 }}>{idx + 1}</td>
                            <td className={s.rtd}>
                              <StatusIcon status={st.status} size={12} />
                            </td>
                            <td className={s.rtd}>
                              <span className={s.rtCaseName}>{c.name}</span>
                            </td>
                            <td className={s.rtd} style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontSize: 11.5 }}>
                              {duration}
                            </td>
                            <td className={s.rtd} style={{ textAlign: "center" }}>
                              {(st.caseDir || st.caseInpDir) ? (
                                <div style={{ display: "flex", gap: 4, justifyContent: "center" }}>
                                  {st.caseDir && (
                                    <button
                                      className={s.openFolderBtn}
                                      onClick={() => invoke("open_in_finder", { path: st.caseDir }).catch(() => {})}
                                      title={`Open output folder (outb/)\n${st.caseDir}`}
                                      style={{ display: "flex", alignItems: "center", gap: 2 }}
                                    >
                                      <FolderOpen size={10} strokeWidth={2} />
                                      <span style={{ fontSize: 9, fontWeight: 600 }}>out</span>
                                    </button>
                                  )}
                                  {st.caseInpDir && (
                                    <button
                                      className={s.openFolderBtn}
                                      onClick={() => invoke("open_in_finder", { path: st.caseInpDir }).catch(() => {})}
                                      title={`Open input snapshot (inp/${st.caseInpDir.split("/").pop()}/)\n${st.caseInpDir}`}
                                      style={{ display: "flex", alignItems: "center", gap: 2 }}
                                    >
                                      <FolderOpen size={10} strokeWidth={2} />
                                      <span style={{ fontSize: 9, fontWeight: 600 }}>inp</span>
                                    </button>
                                  )}
                                </div>
                              ) : <span style={{ color: "var(--tx-6)" }}>—</span>}
                            </td>
                            <td className={s.rtd}>
                              {isFailed && st.errorMsg && (
                                <span className={s.rtError} title={st.errorMsg}>{st.errorMsg}</span>
                              )}
                              {isCancelled && <span className={s.rtCancel}>Cancelled</span>}
                              {st.status === "queued"  && <span style={{ color: "var(--tx-5)", fontSize: 11 }}>Not started</span>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}

      </div>
    </div>
  );
}
