import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FolderOpen, Plus, ArrowRight, ArrowLeft, Check, Clock, Wind } from "lucide-react";
import logo from "../assets/logo.png";
import s from "./WelcomeScreen.module.css";

// ── Decorative turbine ─────────────────────────────────────────────────────────
function BackgroundTurbine() {
  return (
    <svg className={s.bgTurbine} viewBox="0 0 200 260" fill="none" aria-hidden="true">
      {/* Tower + base */}
      <line x1="100" y1="120" x2="100" y2="240" stroke="currentColor" strokeWidth="10" strokeLinecap="round"/>
      <line x1="76"  y1="241" x2="124" y2="241" stroke="currentColor" strokeWidth="3"/>
      {/* Nacelle */}
      <rect x="84" y="108" width="32" height="16" rx="4" fill="currentColor" fillOpacity="0.6"/>
      {/* Hub */}
      <circle cx="100" cy="116" r="7" fill="currentColor"/>
      {/* Rotating blades — 120° apart, hub at (100,116), radius 88 */}
      <g className={s.bladeGroup}>
        <line x1="100" y1="109" x2="100" y2="28"  stroke="currentColor" strokeWidth="6" strokeLinecap="round"/>
        <line x1="106" y1="120" x2="176" y2="160" stroke="currentColor" strokeWidth="6" strokeLinecap="round"/>
        <line x1="94"  y1="120" x2="24"  y2="160" stroke="currentColor" strokeWidth="6" strokeLinecap="round"/>
      </g>
    </svg>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────────
const RECENT_KEY = "fws-recent-v1";

function getRecent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); }
  catch { return []; }
}

export function saveToRecent(project) {
  const prev = getRecent().filter(r => r.fwsPath !== project.fwsPath);
  const next = [
    { name: project.name, dir: project.dir, fwsPath: project.fwsPath, lastOpened: new Date().toISOString() },
    ...prev,
  ].slice(0, 5);
  localStorage.setItem(RECENT_KEY, JSON.stringify(next));
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const diff = now - d;
  if (diff < 60_000)  return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ── Model zoo catalog ──────────────────────────────────────────────────────────
// Static definition of all known / planned turbine templates, grouped by family.
// The id must match the directory name under resources/turbines/.
// Templates not yet bundled are shown as "Coming soon" automatically.

export const CONFIG_TYPE = {
  onshore:  { color: "#10B981", label: "Onshore"       },
  fixed:    { color: "#3B82F6", label: "Fixed-bottom"  },
  floating: { color: "#8B5CF6", label: "Floating"      },
};

export const TURBINE_CATALOG = [
  {
    group: "NREL Reference",
    models: [
      {
        id:             "NREL-5MW",
        modelDir:       "NREL-5MW",
        name:           "NREL 5MW",
        configType:     "onshore",
        ratedPower:     5000,
        rotorDiameter:  126,
        hubHeight:      90,
      },
    ],
  },
  {
    group: "IEA Reference",
    models: [
      {
        id:             "IEA-10MW",
        modelDir:       "IEA-10-198-RWT",
        name:           "IEA 10MW Monopile",
        configType:     "fixed",
        ratedPower:     10000,
        rotorDiameter:  198,
        hubHeight:      128,
      },
      {
        id:             "IEA-15MW-Mono",
        modelDir:       "IEA-15-240-RWT-Monopile",
        name:           "IEA 15MW Monopile",
        configType:     "fixed",
        ratedPower:     15000,
        rotorDiameter:  240,
        hubHeight:      150,
      },
      {
        id:             "IEA-15MW-UMaine",
        modelDir:       "IEA-15-240-RWT-UMaineSemi",
        name:           "IEA 15MW UMaine",
        configType:     "floating",
        ratedPower:     15000,
        rotorDiameter:  240,
        hubHeight:      150,
      },
      {
        id:             "IEA-15MW-OLAF",
        modelDir:       "IEA-15-240-RWT-OLAF",
        name:           "IEA 15MW OLAF",
        configType:     "fixed",
        ratedPower:     15000,
        rotorDiameter:  240,
        hubHeight:      150,
      },
      {
        id:             "IEA-22MW-Mono",
        modelDir:       "IEA-22-280-RWT-Monopile",
        name:           "IEA 22MW Monopile",
        configType:     "fixed",
        ratedPower:     22000,
        rotorDiameter:  280,
        hubHeight:      169,
      },
      {
        id:             "IEA-22MW-Semi",
        modelDir:       "IEA-22-280-RWT-Semi",
        name:           "IEA 22MW Semisubmersible",
        configType:     "floating",
        ratedPower:     22000,
        rotorDiameter:  280,
        hubHeight:      169,
      },
    ],
  },
];

/** Parse an OpenFAST .fst file and return discovered module file names. */
function parseFstModules(content, fstDir) {
  const kv = {};
  for (const line of content.split("\n")) {
    const m = line.match(/^\s*"([^"]+)"\s+(\w+)/);
    if (m) kv[m[2]] = m[1];
  }
  const resolve = key => kv[key] ? `${fstDir}/${kv[key]}` : null;
  return {
    elastodyn:  resolve("EDFile"),
    aerodyn:    resolve("AeroFile"),
    servodyn:   resolve("ServoFile"),
    inflowwind: resolve("InflowFile"),
  };
}

/**
 * Extract all quoted file/path tokens from an OpenFAST input file line.
 */
function extractQuotedPaths(content) {
  const paths = [];
  const re = /"([^"\r\n]+)"/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const val = m[1].trim();
    if (!val || /^[\d.\s-]+$/.test(val)) continue;
    if (!val.includes("/") && !val.includes(".") && !val.includes("\\")) continue;
    paths.push(val);
  }
  return paths;
}

/**
 * Resolve a relative path against a base directory, handling ../ correctly.
 */
function resolvePath(baseDir, rel) {
  if (rel.startsWith("/")) return rel;
  const isAbsolute = baseDir.startsWith("/");
  const parts = [...baseDir.split("/"), ...rel.split("/")];
  const out = [];
  for (const p of parts) {
    if (p === "..") out.pop();
    else if (p && p !== ".") out.push(p);
  }
  return (isAbsolute ? "/" : "") + out.join("/");
}

/**
 * Recursively scan an OpenFAST model starting from the .fst file.
 * Returns sibling directories and individual sibling files that live outside
 * the model's own directory but inside the parent directory.
 */
export async function scanModelDependencies(fstPath) {
  const fstDir    = fstPath.split("/").slice(0, -1).join("/");
  const parentDir = fstDir.split("/").slice(0, -1).join("/");

  const siblingDirs  = new Set();
  const siblingFiles = new Set();
  const visited      = new Set();
  const queue        = [fstPath];
  let   fstContent   = "";
  let   fstModules   = null;

  const textExts = new Set(["dat","fst","inp","txt","ipt","yaml","dvr","sum"]);

  while (queue.length > 0) {
    const absPath = queue.shift();
    if (visited.has(absPath)) continue;
    visited.add(absPath);

    let content;
    try {
      content = await invoke("read_text_file", { path: absPath });
    } catch {
      continue;
    }

    if (absPath === fstPath) {
      fstContent = content;
      fstModules = parseFstModules(content, fstDir);
    }

    const fileDir = absPath.split("/").slice(0, -1).join("/");

    for (const rawPath of extractQuotedPaths(content)) {
      const abs = resolvePath(fileDir, rawPath);

      // Detect anything outside fstDir but still within parentDir
      if (abs.startsWith(parentDir + "/") && !abs.startsWith(fstDir + "/")) {
        const relFromParent = abs.slice(parentDir.length + 1);
        const firstSegment  = relFromParent.split("/")[0];
        if (relFromParent.includes("/")) {
          // File lives inside a subdirectory of parentDir → sibling directory
          siblingDirs.add(firstSegment);
        } else {
          // File lives directly in parentDir → individual sibling file
          siblingFiles.add(firstSegment);
        }
      }

      // Queue any text file within parentDir scope for recursive scanning
      if (abs.startsWith(parentDir + "/") && !visited.has(abs)) {
        const ext = abs.split(".").pop().toLowerCase();
        if (textExts.has(ext)) queue.push(abs);
      }
    }
  }

  return { fstContent, fstModules, siblingDirs: [...siblingDirs], siblingFiles: [...siblingFiles] };
}

/** Build the canonical project object from a loaded .fws file and its path. */
function buildProjectFromFws(fws, fwsPath) {
  fwsPath = fwsPath.replace(/\\/g, "/"); // normalize Windows backslashes
  const dir = fwsPath.split("/").slice(0, -1).join("/");

  // Normalise to models[] — supports both old "modelFst" and new "models" schema
  let models;
  if (fws.models && fws.models.length > 0) {
    models = fws.models.map(m => ({ ...m, fstPath: `${dir}/${m.fstPath}` }));
  } else if (fws.modelFst) {
    // Legacy single-model project — synthesise a models entry
    const fstAbs = `${dir}/${fws.modelFst}`;
    const id     = fws.modelFst.split("/").slice(1, 2)[0] || "model";
    models = [{ id, label: fws.name || id, fstPath: fstAbs }];
  } else {
    models = [];
  }

  const activeModelId = fws.activeModelId || models[0]?.id || null;
  const active        = models.find(m => m.id === activeModelId) || models[0] || null;

  return {
    name:          fws.name || dir.split("/").pop(),
    dir,
    fwsPath,
    models,
    activeModelId,
    modelFst:   active?.fstPath ?? null,
    modelDir:   active?.fstPath ? active.fstPath.split("/").slice(0, -1).join("/") : `${dir}/model`,
    windDir:    `${dir}/wind`,
    resultsDir: `${dir}/results`,
    workingDir: dir,
    ui:         fws.ui || {},
  };
}

// ── Model zoo: group header ────────────────────────────────────────────────────
function GroupHeader({ label }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "10px 0 5px" }}>
      <span style={{
        fontSize: 11, fontWeight: 700, color: "var(--tx-4)",
        textTransform: "uppercase", letterSpacing: "0.07em", whiteSpace: "nowrap",
      }}>
        {label}
      </span>
      <div style={{ flex: 1, height: 0.5, background: "var(--bd-subtle)" }} />
    </div>
  );
}

// ── Model zoo: turbine card ────────────────────────────────────────────────────
function TemplateCard({ tmpl, selected, onSelect }) {
  const available = tmpl.available !== false;
  const cfg = CONFIG_TYPE[tmpl.configType] || CONFIG_TYPE.onshore;
  const accentColor = available ? cfg.color : "var(--bd)";

  return (
    <button
      onClick={() => available && onSelect(tmpl)}
      className={s.templateCard}
      style={{
        display: "flex", flexDirection: "column", gap: 4,
        textAlign: "left",
        background: selected ? "rgba(8,145,178,0.08)" : "var(--bg-hover)",
        border: selected ? "1.5px solid rgba(8,145,178,0.45)" : "1px solid var(--bd-input)",
        borderLeft: `3px solid ${accentColor}`,
        borderRadius: 8,
        padding: "9px 10px 9px 9px",
        cursor: available ? "pointer" : "default",
        opacity: available ? 1 : 0.5,
        fontFamily: "inherit",
        minWidth: 0,
      }}
    >
      {/* Row 1: name + badge */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 5, minWidth: 0 }}>
        <span style={{
          fontSize: 13, fontWeight: 600,
          color: selected ? "#0891B2" : "var(--tx-1)",
          flex: 1, lineHeight: 1.25,
          wordBreak: "break-word",
          letterSpacing: "-0.01em",
        }}>
          {tmpl.name}
        </span>
        {tmpl.badge && available && (
          <span style={{
            fontSize: 11, fontWeight: 600, flexShrink: 0, marginTop: 1,
            padding: "1.5px 6px", borderRadius: 4,
            background: selected ? "rgba(8,145,178,0.15)" : "rgba(16,185,129,0.1)",
            color: selected ? "#0891B2" : "#059669",
          }}>
            {tmpl.badge}
          </span>
        )}
        {!available && (
          <span style={{
            fontSize: 11, fontWeight: 500, flexShrink: 0, marginTop: 1,
            padding: "1.5px 6px", borderRadius: 4,
            background: "var(--bg-base)", color: "var(--tx-4)",
          }}>
            Coming soon
          </span>
        )}
      </div>

      {/* Row 2: config type · power · diameter */}
      <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, fontWeight: 500, color: available ? cfg.color : "var(--tx-5)" }}>
          {cfg.label}
        </span>
        {tmpl.ratedPower && (
          <>
            <span style={{ fontSize: 11, color: "var(--tx-5)" }}>·</span>
            <span style={{ fontSize: 11, color: "var(--tx-3)" }}>{tmpl.ratedPower / 1000} MW</span>
          </>
        )}
        {tmpl.rotorDiameter && (
          <>
            <span style={{ fontSize: 11, color: "var(--tx-5)" }}>·</span>
            <span style={{ fontSize: 11, color: "var(--tx-3)" }}>Ø{tmpl.rotorDiameter} m</span>
          </>
        )}
        {tmpl.hubHeight && (
          <>
            <span style={{ fontSize: 11, color: "var(--tx-5)" }}>·</span>
            <span style={{ fontSize: 11, color: "var(--tx-3)" }}>H {tmpl.hubHeight} m</span>
          </>
        )}
      </div>

      {/* Row 3: description (2 lines max) */}
      {tmpl.description && (
        <p style={{
          margin: 0, fontSize: 11.5, color: "var(--tx-4)", lineHeight: 1.5,
          display: "-webkit-box", WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical", overflow: "hidden",
        }}>
          {tmpl.description}
        </p>
      )}
    </button>
  );
}

// ── Component ──────────────────────────────────────────────────────────────────
export default function WelcomeScreen({
  onProjectReady,
  onSkip,
}) {
  const [view, setView] = useState("home"); // "home" | "new1" | "new2"
  const [recent, setRecent] = useState(getRecent);

  // Wizard state
  const [projectName,  setProjectName]  = useState("");
  const [projectDir,   setProjectDir]   = useState("");
  const [modelMode,    setModelMode]    = useState("template");
  const [sourceFst,    setSourceFst]    = useState("");
  const [sourceDir,    setSourceDir]    = useState("");
  const [siblingDirs,  setSiblingDirs]  = useState([]);
  const [siblingFiles, setSiblingFiles] = useState([]);
  const [fstModules,   setFstModules]   = useState(null);
  const [creating,     setCreating]     = useState(false);
  const [error,        setError]        = useState("");
  const [dirHasProject, setDirHasProject] = useState("");

  // Template state
  const [templates,        setTemplates]        = useState([]);
  const [templatesLoaded,  setTemplatesLoaded]  = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState(null);

  // Derive a fast id→template lookup (re-computed only when templates changes)
  const templatesById = Object.fromEntries(templates.map(t => [t.id, t]));

  // Load templates once when step 2 is first shown.
  // The zoo renders immediately from TURBINE_CATALOG; live data overlays
  // "available" state and templatePath once the Tauri call resolves.
  useEffect(() => {
    if (view !== "new2" || templatesLoaded) return;
    invoke("list_turbine_templates")
      .then(list => {
        setTemplates(list);
        // Auto-select first available if nothing chosen yet
        const first = list.find(t => t.available !== false);
        if (first && !selectedTemplate) setSelectedTemplate(first);
      })
      .catch(() => {})
      .finally(() => setTemplatesLoaded(true));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // ── Wizard: step 1 actions ────────────────────────────────────────────────
  const browseProjectDir = async () => {
    try {
      const dir = await openDialog({ directory: true, multiple: false, title: "Choose project folder" });
      if (!dir) return;
      const normalized = dir.replace(/\\/g, "/");
      setProjectDir(normalized);
      if (!projectName) setProjectName(normalized.split("/").pop());
      // Check whether this folder already owns a .fws project file
      const entries = await invoke("list_dir", { path: normalized }).catch(() => []);
      const existing = entries
        .map(e => e.replace(/\\/g, "/").split("/").pop())
        .find(name => name.endsWith(".fus"));
      setDirHasProject(existing ?? "");
    } catch {}
  };

  // ── Wizard: step 2 actions ────────────────────────────────────────────────
  const browseSourceFst = async () => {
    try {
      const file = await openDialog({
        multiple: false,
        title: "Select OpenFAST .fst file",
        filters: [{ name: "OpenFAST main file", extensions: ["fst"] }],
      });
      if (!file) return;
      const file2 = file.replace(/\\/g, "/");
      setSourceFst(file2);
      setSourceDir(file2.split("/").slice(0, -1).join("/"));
      setFstModules(null);
      setSiblingDirs([]);
      setSiblingFiles([]);
      const { fstModules: mods, siblingDirs: sibs, siblingFiles: sibling_files } = await scanModelDependencies(file2);
      setFstModules(mods);
      setSiblingDirs(sibs);
      setSiblingFiles(sibling_files);
    } catch {
      setFstModules(null);
      setSiblingDirs([]);
      setSiblingFiles([]);
    }
  };

  // ── Create project ────────────────────────────────────────────────────────
  const handleCreate = async () => {
    if (!projectDir || !projectName) return;
    setCreating(true);
    setError("");
    try {
      // Prevent writing a second .fus into a folder that already has one
      const existing = (await invoke("list_dir", { path: projectDir }).catch(() => []))
        .map(e => e.replace(/\\/g, "/").split("/").pop())
        .find(name => name.endsWith(".fus"));
      if (existing) {
        setError(`Folder already contains a project (${existing}). Choose a different folder or create a subfolder.`);
        setCreating(false);
        return;
      }

      const modelDir   = `${projectDir}/model`;
      const windDir    = `${projectDir}/wind`;
      const resultsDir = `${projectDir}/results`;

      await invoke("create_dir", { path: windDir });
      await invoke("create_dir", { path: resultsDir });

      let modelFst = null;

      if (modelMode === "template" && selectedTemplate) {
        const tmplId      = selectedTemplate.id;
        const tmplPath    = selectedTemplate.templatePath;
        const modelDirName = selectedTemplate.modelDir || tmplId;
        await invoke("copy_dir", {
          src: `${tmplPath}/model/${modelDirName}`,
          dst: `${modelDir}/${modelDirName}`,
        });
        // Patch libdiscon filename in ServoDyn .dat files for the host OS
        await invoke("patch_libdiscon_paths", { dir: `${modelDir}/${modelDirName}` });
        // Copy sibling data directories (e.g. shared IEA-15-240-RWT blade/airfoil data)
        for (const sib of (selectedTemplate.siblingDirs || [])) {
          await invoke("copy_dir", {
            src: `${tmplPath}/model/${sib}`,
            dst: `${modelDir}/${sib}`,
          });
        }
        await invoke("copy_dir", { src: `${tmplPath}/wind`, dst: windDir });
        const fstFile = selectedTemplate.fstFile || `${modelDirName}.fst`;
        modelFst = `${modelDir}/${modelDirName}/${fstFile}`;

      } else if (modelMode === "import" && sourceDir) {
        const fstDirName = sourceDir.split("/").pop();
        const parentDir  = sourceDir.split("/").slice(0, -1).join("/");
        await invoke("copy_dir", { src: sourceDir, dst: `${modelDir}/${fstDirName}` });
        for (const sib of siblingDirs) {
          await invoke("copy_dir", { src: `${parentDir}/${sib}`, dst: `${modelDir}/${sib}` });
        }
        for (const fileName of siblingFiles) {
          const content = await invoke("read_text_file", { path: `${parentDir}/${fileName}` });
          await invoke("write_text_file", { path: `${modelDir}/${fileName}`, content });
        }
        const fstName = sourceFst.split("/").pop();
        modelFst = `${modelDir}/${fstDirName}/${fstName}`;

      } else {
        await invoke("create_dir", { path: modelDir });
      }

      const fstRelative = modelFst ? modelFst.replace(`${projectDir}/`, "") : null;

      // Derive model id = the directory containing the .fst
      // e.g. "model/NREL-5MW/NREL-5MW.fst" → "NREL-5MW"
      const modelId    = fstRelative ? fstRelative.split("/")[1] : null;
      const modelLabel = modelMode === "template" && selectedTemplate
        ? (selectedTemplate.name || modelId)
        : modelId;

      const sourceEntry = modelMode === "template" && selectedTemplate
        ? { template: selectedTemplate.id, templateVersion: selectedTemplate.ratedPower ? `${selectedTemplate.ratedPower/1000}MW` : "", importedAt: new Date().toISOString() }
        : modelMode === "import" && sourceFst
          ? { originalFst: sourceFst, importedAt: new Date().toISOString() }
          : null;

      const modelEntry = modelFst ? { id: modelId, label: modelLabel, fstPath: fstRelative, source: sourceEntry } : null;

      const fws = {
        version:       "1",
        name:          projectName.trim(),
        description:   "",
        created:       new Date().toISOString(),
        models:        modelEntry ? [modelEntry] : [],
        activeModelId: modelId,
        ui: { activeModule: "openfast", lastRunName: "", lastBTS: "" },
      };
      // Name the file after the project (e.g. "IEA Study.fus") so it's
      // identifiable in the OS file picker without opening it.
      // Strip the handful of characters macOS/Windows forbid in filenames.
      const safeName = projectName.trim().replace(/[/\\:*?"<>|]+/g, "_");
      const fwsPath = `${projectDir}/${safeName}.fus`;
      await invoke("write_text_file", { path: fwsPath, content: JSON.stringify(fws, null, 2) });

      const activeModelDir = modelFst
        ? modelFst.split("/").slice(0, -1).join("/")
        : modelDir;

      const modelsAbs = modelEntry ? [{ ...modelEntry, fstPath: modelFst }] : [];

      const project = {
        name:          fws.name,
        dir:           projectDir,
        fwsPath,
        models:        modelsAbs,
        activeModelId: modelId,
        modelFst,
        modelDir:      activeModelDir,
        windDir,
        resultsDir,
        workingDir:    projectDir,
        ui:            fws.ui,
      };
      saveToRecent(project);
      onProjectReady(project);
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  };

  // ── Open existing .fus ────────────────────────────────────────────────────
  const handleOpenFws = async () => {
    try {
      const file = await openDialog({
        multiple: false,
        title: "Open FlowUrja project",
        filters: [{ name: "FlowUrja Studio Project", extensions: ["fus"] }],
      });
      if (!file) return;
      const content = await invoke("read_text_file", { path: file });
      const fws = JSON.parse(content);
      const project = buildProjectFromFws(fws, file);
      saveToRecent(project);
      onProjectReady(project);
    } catch {}
  };

  // ── Open recent ───────────────────────────────────────────────────────────
  const handleOpenRecent = async (item) => {
    try {
      const content = await invoke("read_text_file", { path: item.fwsPath });
      const fws = JSON.parse(content);
      const project = buildProjectFromFws(fws, item.fwsPath);
      saveToRecent(project);
      onProjectReady(project);
    } catch {
      const updated = getRecent().filter(r => r.fwsPath !== item.fwsPath);
      localStorage.setItem(RECENT_KEY, JSON.stringify(updated));
      setRecent(updated);
    }
  };

  const canStep1 = projectName.trim().length > 0 && projectDir.length > 0 && !dirHasProject;
  const canCreate =
    modelMode === "fresh" ||
    (modelMode === "import"   && sourceFst.length > 0) ||
    (modelMode === "template" && !!selectedTemplate);

  const MODULE_LABELS = [
    { key: "elastodyn",  label: "ElastoDyn" },
    { key: "aerodyn",    label: "AeroDyn"   },
    { key: "servodyn",   label: "ServoDyn"  },
    { key: "inflowwind", label: "InflowWind"},
  ];

  // ── Shared tab-button style ───────────────────────────────────────────────
  const modeTab = (mode) => ({
    flex: 1, padding: "6px 0", fontSize: 12, fontWeight: 500,
    border: "none", borderRadius: 5, cursor: "pointer",
    background: modelMode === mode ? "var(--bg-surface)" : "transparent",
    color: modelMode === mode ? "var(--tx-1)" : "var(--tx-3)",
    boxShadow: modelMode === mode ? "0 1px 4px rgba(0,0,0,0.08), 0 0 0 0.5px var(--bd-input)" : "none",
    transition: "background 0.15s, color 0.15s, box-shadow 0.15s, transform 0.45s cubic-bezier(0.34, 1.56, 0.64, 1)",
    fontFamily: "inherit",
    letterSpacing: "-0.01em",
  });

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className={s.root} data-tauri-drag-region>

      <BackgroundTurbine />

      {/* ── HOME view ─────────────────────────────────────────────────────── */}
      {view === "home" && (
        <div className={s.card} data-tauri-drag-region="false">
          <img src={logo} className={s.logo} alt="FlowUrja Studio" draggable={false} />

          <div className={s.nameRow}>
            <h1 className={s.appName}>FlowUrja Studio</h1>
            <span className={s.version}>v1.1.1</span>
          </div>

          <p className={s.tagline}>
            OpenFAST · TurbSim<br />A modern studio for wind turbine simulation
          </p>

          {/* Action buttons — vertical stack, full width */}
          <div style={{ display: "flex", flexDirection: "column", width: "100%", marginTop: 8, marginBottom: 2 }}>
            <button className={s.primaryBtn} onClick={() => setView("new1")}>
              <Plus size={14} strokeWidth={2} />
              New project
              <ArrowRight size={13} strokeWidth={2} className={s.btnArrow} />
            </button>
            <button className={s.secondaryBtn} onClick={handleOpenFws}>
              <FolderOpen size={14} strokeWidth={1.8} />
              Open project
            </button>
          </div>

          {recent.length > 0 && (
            <div style={{ width: "100%", marginTop: 14 }}>
              <p className={s.recentLabel}>Recent</p>
              <div className={s.recentList}>
                {recent.map(item => (
                  <button
                    key={item.fwsPath}
                    className={s.recentItem}
                    onClick={() => handleOpenRecent(item)}
                  >
                    <Clock size={11} strokeWidth={1.8} style={{ flexShrink: 0, opacity: 0.5, marginRight: 7 }} />
                    <span className={s.recentName}>{item.name}</span>
                    <span className={s.recentDate}>{formatDate(item.lastOpened)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <button className={s.skipBtn} onClick={onSkip}>
            Continue without project
            <ArrowRight size={11} strokeWidth={2} style={{ marginLeft: 4 }} />
          </button>
        </div>
      )}

      {/* ── NEW — Step 1: name + folder ───────────────────────────────────── */}
      {view === "new1" && (
        <div className={s.card} data-tauri-drag-region="false">
          <button className={s.wizardBack} onClick={() => setView("home")}>
            <ArrowLeft size={12} strokeWidth={2} /> Back
          </button>

          <p style={{
            fontSize: 12, color: "var(--tx-3)",
            margin: "0 0 18px", alignSelf: "flex-start",
            letterSpacing: "-0.01em",
          }}>
            Step 1 of 2 — Name &amp; location
          </p>

          <div className={s.fieldGroup}>
            <label className={s.fieldLabel}>Project name</label>
            <input
              className={s.fieldInput}
              type="text"
              placeholder="My 5MW simulation"
              value={projectName}
              onChange={e => setProjectName(e.target.value)}
              autoFocus
            />
          </div>

          <div className={s.fieldGroup}>
            <label className={s.fieldLabel}>Project folder</label>
            <div className={s.fileInputRow}>
              <input
                className={s.fieldInput}
                type="text"
                placeholder="/Users/you/simulations/project"
                value={projectDir}
                readOnly
                style={{ flex: 1 }}
              />
              <button className={s.browseBtn}
                style={{ display: "flex", alignItems: "center", gap: 5 }}
                onClick={browseProjectDir}>
                <FolderOpen size={12} strokeWidth={1.8} />
                Browse
              </button>
            </div>
            {dirHasProject && (
              <p style={{ fontSize: 11, color: "var(--c-aerodyn)", marginTop: 4, lineHeight: 1.4 }}>
                This folder already contains a project ({dirHasProject}). Choose a different folder or create a subfolder.
              </p>
            )}
          </div>

          <button
            className={s.primaryBtn}
            style={{ marginTop: 8, width: "auto", alignSelf: "flex-end" }}
            disabled={!canStep1}
            onClick={() => setView("new2")}
          >
            Next
            <ArrowRight size={13} strokeWidth={2} />
          </button>
        </div>
      )}

      {/* ── NEW — Step 2: model source ────────────────────────────────────── */}
      {view === "new2" && (
        <div className={`${s.card} ${s.cardWide}`} data-tauri-drag-region="false">
          <button className={s.wizardBack} onClick={() => setView("new1")}>
            <ArrowLeft size={12} strokeWidth={2} /> Back
          </button>

          <h2 className={s.wizardTitle}>Turbine Model</h2>
          <p style={{
            fontSize: 12, color: "var(--tx-3)",
            margin: "-14px 0 14px", alignSelf: "flex-start",
            letterSpacing: "-0.01em",
          }}>
            Step 2 of 2 — Choose a starting model
          </p>

          {/* Mode tabs */}
          <div style={{
            display: "flex", gap: 2, width: "100%",
            background: "var(--bg-base)",
            border: "1px solid var(--bd-input)",
            borderRadius: 8, padding: 3,
            marginBottom: 14,
          }}>
            <button style={modeTab("template")} onClick={() => setModelMode("template")}>
              Template
            </button>
            <button style={modeTab("import")} onClick={() => setModelMode("import")}>
              Import
            </button>
            <button style={modeTab("fresh")} onClick={() => setModelMode("fresh")}>
              Blank
            </button>
          </div>

          {/* ── Template mode: model zoo ─────────────────────────────────── */}
          {modelMode === "template" && (
            <div className={s.zooScroll}>
              {!templatesLoaded && (
                <p style={{ fontSize: 10.5, color: "var(--tx-5)", textAlign: "center", marginBottom: 6 }}>
                  Loading…
                </p>
              )}

              {TURBINE_CATALOG.map((group) => (
                <div key={group.group}>
                  <GroupHeader label={group.group} />
                  <div style={{ display: "grid", gridTemplateColumns: group.models.length === 1 ? "1fr" : "1fr 1fr", gap: 6 }}>
                    {group.models.map(catalogEntry => {
                      const live = templatesById[catalogEntry.id];
                      const tmpl = live
                        ? { ...catalogEntry, ...live }
                        : { ...catalogEntry, available: false };
                      return (
                        <TemplateCard
                          key={tmpl.id}
                          tmpl={tmpl}
                          selected={selectedTemplate?.id === tmpl.id}
                          onSelect={setSelectedTemplate}
                        />
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ── Import mode ──────────────────────────────────────────────── */}
          {modelMode === "import" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%" }}>
              <p style={{ fontSize: 13, color: "var(--tx-3)", margin: 0, lineHeight: 1.5, letterSpacing: "-0.01em" }}>
                Select an existing <code>.fst</code> file. The model folder and
                any referenced sibling directories will be copied into the project.
              </p>
              <div className={s.fileInputRow}>
                <input
                  className={s.fieldInput}
                  type="text"
                  placeholder="No file selected"
                  value={sourceFst}
                  readOnly
                  style={{ flex: 1, fontSize: 11.5 }}
                />
                <button className={s.browseBtn}
                  style={{ display: "flex", alignItems: "center", gap: 5 }}
                  onClick={browseSourceFst}>
                  <FolderOpen size={12} strokeWidth={1.8} />
                  Browse
                </button>
              </div>
              {fstModules && (
                <div style={{
                  background: "var(--bg-base)", border: "0.5px solid var(--bd)",
                  borderRadius: 6, padding: "8px 10px",
                  display: "flex", flexWrap: "wrap", gap: "4px 10px",
                }}>
                  {MODULE_LABELS.map(({ key, label }) => (
                    <span key={key} style={{ fontSize: 11, color: fstModules[key] ? "#059669" : "var(--tx-4)" }}>
                      <Check size={9} strokeWidth={2.5} style={{ display: "inline", marginRight: 3 }} />
                      {label}
                    </span>
                  ))}
                  {siblingDirs.length > 0 && (
                    <span style={{ fontSize: 11, color: "var(--tx-4)", width: "100%", marginTop: 2 }}>
                      + sibling dirs: {siblingDirs.join(", ")}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── Blank mode ───────────────────────────────────────────────── */}
          {modelMode === "fresh" && (
            <p style={{ fontSize: 13, color: "var(--tx-3)", margin: 0, alignSelf: "flex-start", lineHeight: 1.5, letterSpacing: "-0.01em" }}>
              An empty project will be created. You can add an OpenFAST model later
              from the simulation panel.
            </p>
          )}

          {error && <p className={s.errorMsg}>{error}</p>}

          <button
            className={s.primaryBtn}
            style={{ marginTop: 16, width: "auto", alignSelf: "flex-end" }}
            disabled={!canCreate || creating}
            onClick={handleCreate}
          >
            {creating ? "Creating…" : (
              <>
                <Check size={13} strokeWidth={2.5} />
                Create project
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
