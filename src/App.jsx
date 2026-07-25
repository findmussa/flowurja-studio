import { useState, useRef, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { open as openDialog, ask } from "@tauri-apps/plugin-dialog";
import UpdateDialog   from "./components/UpdateDialog";
import Sidebar        from "./components/Sidebar";
import WelcomeScreen, { saveToRecent } from "./components/WelcomeScreen";
// saveToRecent is also used in handleOpenProject (directory picker path)
import AddModelSheet   from "./components/AddModelSheet";
import OpenFASTPanel   from "./components/modules/OpenFASTPanel";
import TurbSimPanel    from "./components/modules/TurbSimPanel";
import WindFieldBatchPanel from "./components/modules/WindFieldBatchPanel";
import BatchRunPanel   from "./components/modules/BatchRunPanel";
import InflowWindPanel from "./components/modules/InflowWindPanel";
import ElastoDynPanel  from "./components/modules/ElastoDynPanel";
import AeroDynPanel    from "./components/modules/AeroDynPanel";
import ServoDynPanel   from "./components/modules/ServoDynPanel";
import HydroDynPanel   from "./components/modules/HydroDynPanel";
import SeaStatePanel   from "./components/modules/SeaStatePanel";
import SubDynPanel     from "./components/modules/SubDynPanel";
import MoorDynPanel    from "./components/modules/MoorDynPanel";
import IceDynPanel     from "./components/modules/IceDynPanel";
import GenericPanel    from "./components/modules/GenericPanel";
import SettingsPanel   from "./components/modules/SettingsPanel";
import ResultsPanel    from "./components/modules/ResultsPanel";
import WindFieldPanel  from "./components/modules/WindFieldPanel";
import Console      from "./components/Console";
import s from "./App.module.css";

const SIDEBAR_MIN     = 190;
const SIDEBAR_MAX     = 320;
const SIDEBAR_DEFAULT = 230;
const CONSOLE_MIN     = 80;
const CONSOLE_MAX     = 500;
const CONSOLE_DEFAULT = 160;

const SKIP_TAGS = new Set([
  "button","input","select","textarea","a","label","option",
  "h1","h2","h3","h4","h5","h6","p","span","em","strong","small",
  "svg","path","circle","line","polyline","rect","text","tspan",
]);

function isInHeader(e) {
  const el = document.querySelector("[data-drag-main]");
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  return e.clientX >= rect.left && e.clientX <= rect.right &&
         e.clientY >= rect.top  && e.clientY <= rect.top + 52;
}

function isSkippedTarget(el) {
  let node = el;
  while (node && node.tagName) {
    if (SKIP_TAGS.has(node.tagName.toLowerCase())) return true;
    if (node.dataset?.dragMain !== undefined) break;
    node = node.parentElement;
  }
  return false;
}


// Detect platform once at startup and stamp data-platform on <html> so CSS can
// apply platform-specific rules without any JS-in-render logic.
// WebView2 UA contains "Windows"; WebKit on macOS contains "Macintosh".
const platform = navigator.userAgent.includes("Windows") ? "windows" : "macos";
document.documentElement.setAttribute("data-platform", platform);

const APP_VERSION = "1.0.0";
const GITHUB_REPO = "findmussa/flowurja-studio";

function semverGt(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
  }
  return false;
}

export default function App() {
  const [activeModule,      setActiveModule]      = useState("openfast");
  const [updateInfo,        setUpdateInfo]        = useState(null);
  const [sidebarWidth,      setSidebarWidth]      = useState(SIDEBAR_DEFAULT);
  const [project,           setProject]           = useState(null);
  // Welcome screen: show when app opens with no project; dismissed by selecting folder or skipping
  const [welcomeDismissed,  setWelcomeDismissed]  = useState(false);
  // Tab-jump requests for OpenFASTPanel: { tab, seq } — seq increment forces re-trigger
  const [ofTabReq,      setOfTabReq]      = useState({ tab: "simulation", seq: 0 });

  // ── Module file interconnection ──────────────────────────────────────────────
  // Filled when user imports a .fst in OpenFASTPanel; consumed by submodule panels
  const [moduleFiles, setModuleFiles] = useState({
    fstPath: "", fstDir: "", elastodyn: "", aerodyn: "", servodyn: "", inflowwind: "", seastate: "", hydrodyn: "", subdyn: "", moordyn: "", icedyn: "",
    windfield: null, results: null,
  });
  // Auto-populate moduleFiles when a project with a model .fst is loaded
  useEffect(() => {
    if (!project?.modelFst) return;
    invoke("read_text_file", { path: project.modelFst })
      .then(content => {
        // Normalise to forward slashes so dir computation is correct on Windows
        // (Tauri may return native backslash paths on Windows)
        const normFst = project.modelFst.replace(/\\/g, "/");
        const normDir = (project.modelDir || "").replace(/\\/g, "/");
        const dir = normDir || normFst.split("/").slice(0, -1).join("/");
        const kv  = {};
        for (const line of content.split("\n")) {
          const m = line.match(/^\s*"([^"]+)"\s+(\w+)/);
          if (m) kv[m[2]] = m[1];
        }
        const resolve = key => kv[key] ? `${dir}/${kv[key]}` : "";
        setModuleFiles({
          fstPath:    project.modelFst,
          fstDir:     dir,
          elastodyn:  resolve("EDFile"),
          aerodyn:    resolve("AeroFile"),
          servodyn:   resolve("ServoFile"),
          inflowwind: resolve("InflowFile"),
          seastate:   resolve("SeaStFile"),
          hydrodyn:   resolve("HydroFile"),
          subdyn:     resolve("SubFile"),
          moordyn:    resolve("MooringFile"),
          icedyn:     resolve("IceFile"),
        });
      })
      .catch(() => {});
  }, [project?.modelFst]);

  // Tracks which modules are active (Comp* > 0) in the currently loaded .fst.
  // null means no .fst loaded — sidebar shows all enabled modules normally.
  const [moduleActive, setModuleActive] = useState(null);
  const handleModuleActiveChange = useCallback(v => setModuleActive(v), []);

  // Tracks which submodule panels have unsaved edits
  const [moduleDirty, setModuleDirty] = useState({ openfast: false, elastodyn: false, aerodyn: false, servodyn: false, inflowwind: false, seastate: false, hydrodyn: false, subdyn: false, moordyn: false, icedyn: false });
  // Holds the latest handleSave function registered by each submodule panel
  const subSaveFns = useRef({ openfast: null, elastodyn: null, aerodyn: null, servodyn: null, inflowwind: null, seastate: null, hydrodyn: null, subdyn: null, moordyn: null, icedyn: null });
  // Signal to OpenFASTPanel to revert its form to disk (incremented on "Discard")
  const [ofDiscardSeq, setOfDiscardSeq] = useState(0);
  // Pending navigation blocked by a dirty check
  const [navConfirm, setNavConfirm] = useState({ show: false, targetModule: null, tabHint: null });
  // .fus file opened externally while another project is already mounted
  const [pendingFusPath, setPendingFusPath] = useState(null);

  // ── Theme: "system" | "light" | "dark" ──────────────────────────────────
  const [theme, setTheme] = useState(() => localStorage.getItem("fws-theme") || "system");
  useEffect(() => {
    localStorage.setItem("fws-theme", theme);
    if (theme === "system") {
      document.documentElement.removeAttribute("data-theme");
    } else {
      document.documentElement.setAttribute("data-theme", theme);
    }
  }, [theme]);

  // Handle sidebar navigation — intercept if current panel has unsaved changes
  const DIRTY_MODULES = ["openfast", "elastodyn", "aerodyn", "servodyn", "inflowwind", "seastate", "hydrodyn", "subdyn", "moordyn", "icedyn"];
  const handleModuleSelect = (id, tabHint) => {
    if (DIRTY_MODULES.includes(activeModule) && moduleDirty[activeModule] && id !== activeModule) {
      setNavConfirm({ show: true, targetModule: id, tabHint: tabHint || null });
      return;
    }
    setActiveModule(id);
    if (tabHint) setOfTabReq(prev => ({ tab: tabHint, seq: prev.seq + 1 }));
  };

  // Called by WelcomeScreen when a project is created or opened via .fws
  const handleProjectReady = useCallback((projectData) => {
    setProject(projectData);
    setWelcomeDismissed(true);
    if (projectData.ui?.activeModule) {
      setActiveModule(projectData.ui.activeModule);
    }
  }, []);

  // ── Multi-model support ──────────────────────────────────────────────────────
  const [showAddModel, setShowAddModel] = useState(false);

  // Switch the active model — updates project state (modelFst/modelDir) so existing
  // useEffect[project?.modelFst] fires and reloads module files automatically.
  const handleSwitchModel = useCallback(async (modelId) => {
    setProject(prev => {
      if (!prev?.models) return prev;
      const m = prev.models.find(x => x.id === modelId);
      if (!m) return prev;
      const normFst = m.fstPath.replace(/\\/g, "/");
      return {
        ...prev,
        activeModelId: modelId,
        modelFst:  normFst,
        modelDir:  normFst.split("/").slice(0, -1).join("/"),
      };
    });
    // Persist activeModelId to .fus
    setProject(prev => {
      if (prev?.fwsPath) {
        invoke("read_text_file", { path: prev.fwsPath })
          .then(raw => {
            const fws = JSON.parse(raw);
            fws.activeModelId = modelId;
            return invoke("write_text_file", { path: prev.fwsPath, content: JSON.stringify(fws, null, 2) });
          })
          .catch(() => {});
      }
      return prev;
    });
  }, []);

  // ── Remove model ─────────────────────────────────────────────────────────────
  // removeModelConfirm: null | { id, label, dir }
  const [removeModelConfirm, setRemoveModelConfirm] = useState(null);
  const [deleteFiles,        setDeleteFiles]        = useState(false);

  const handleRemoveModel = useCallback((model) => {
    if (!project) return;
    const modelDir = `${project.dir}/model/${model.id}`;
    setDeleteFiles(false);
    setRemoveModelConfirm({ id: model.id, label: model.label || model.id, dir: modelDir });
  }, [project]);

  const executeRemoveModel = useCallback(async () => {
    if (!removeModelConfirm || !project) return;
    const { id, dir } = removeModelConfirm;
    try {
      // 1. Update .fus
      const raw  = await invoke("read_text_file", { path: project.fwsPath });
      const fws  = JSON.parse(raw);
      fws.models = (fws.models || []).filter(m => m.id !== id);
      const nextId = fws.models[0]?.id ?? null;
      fws.activeModelId = nextId;
      await invoke("write_text_file", { path: project.fwsPath, content: JSON.stringify(fws, null, 2) });

      // 2. Optionally delete files (only the model's own directory, not shared siblings)
      if (deleteFiles) {
        await invoke("remove_dir", { path: dir }).catch(() => {});
      }

      // 3. Update React state
      const nextModels = (project.models || []).filter(m => m.id !== id);
      const nextModel  = nextModels.find(m => m.id === nextId) ?? nextModels[0] ?? null;
      setProject(prev => ({
        ...prev,
        models:        nextModels,
        activeModelId: nextModel?.id   ?? null,
        modelFst:      nextModel?.fstPath ?? null,
        modelDir:      nextModel?.fstPath ? nextModel.fstPath.split("/").slice(0, -1).join("/") : `${prev.dir}/model`,
      }));
    } catch (e) {
      console.error("Remove model failed:", e);
    } finally {
      setRemoveModelConfirm(null);
    }
  }, [removeModelConfirm, deleteFiles, project]);

  // Called by AddModelSheet when a model has been copied + .fus updated
  const handleModelAdded = useCallback((modelEntry) => {
    setProject(prev => {
      if (!prev) return prev;
      const exists  = prev.models?.find(m => m.id === modelEntry.id);
      const models  = exists
        ? prev.models.map(m => m.id === modelEntry.id ? modelEntry : m)
        : [...(prev.models || []), modelEntry];
      return {
        ...prev,
        models,
        activeModelId: modelEntry.id,
        modelFst:  modelEntry.fstPath,
        modelDir:  modelEntry.fstPath.split("/").slice(0, -1).join("/"),
      };
    });
    setShowAddModel(false);
  }, []);

  // Sidebar project picker — opens a .fws file directly so the user can
  // switch between projects without hunting through directory listings.
  const handleOpenProject = async () => {
    try {
      const fwsPath = await openDialog({
        directory: false,
        multiple:  false,
        filters:   [{ name: "FlowUrja Studio Project", extensions: ["fus"] }],
      });
      if (!fwsPath) return;

      // Derive the working directory from the .fws file location
      const dir = fwsPath.replace(/\\/g, "/").split("/").slice(0, -1).join("/");

      let projectData = null;
      try {
        const raw = await invoke("read_text_file", { path: fwsPath });
        const fws = JSON.parse(raw);
        const models = fws.models
          ? fws.models.map(m => ({ ...m, fstPath: `${dir}/${m.fstPath}` }))
          : fws.modelFst
            ? [{ id: fws.modelFst.split("/")[1] || "model", label: fws.name || "Model", fstPath: `${dir}/${fws.modelFst}` }]
            : [];
        const activeModelId = fws.activeModelId || models[0]?.id || null;
        const active = models.find(m => m.id === activeModelId) || models[0] || null;
        projectData = {
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
        saveToRecent(projectData);
      } catch {}

      setProject(projectData ?? {
        name: dir.split("/").pop(), workingDir: dir, dir,
        models: [], activeModelId: null,
        modelDir: `${dir}/model`, windDir: `${dir}/wind`,
        resultsDir: `${dir}/results`, modelFst: null, fwsPath,
      });
      setWelcomeDismissed(true);
    } catch {}
  };

  // Open a project directly from a .fus file path (no dialog).
  // Used by double-click file association and startup file argument.
  const openProjectFromPath = useCallback(async (fusPath) => {
    try {
      const fwsPath = fusPath.replace(/\\/g, "/");
      const dir = fwsPath.split("/").slice(0, -1).join("/");
      const raw = await invoke("read_text_file", { path: fwsPath });
      const fws = JSON.parse(raw);
      const models = fws.models
        ? fws.models.map(m => ({ ...m, fstPath: `${dir}/${m.fstPath}` }))
        : fws.modelFst
          ? [{ id: fws.modelFst.split("/")[1] || "model", label: fws.name || "Model", fstPath: `${dir}/${fws.modelFst}` }]
          : [];
      const activeModelId = fws.activeModelId || models[0]?.id || null;
      const active = models.find(m => m.id === activeModelId) || models[0] || null;
      const projectData = {
        name:       fws.name || dir.split("/").pop(),
        dir, fwsPath, models, activeModelId,
        modelFst:   active?.fstPath ?? null,
        modelDir:   active?.fstPath ? active.fstPath.split("/").slice(0, -1).join("/") : `${dir}/model`,
        windDir:    `${dir}/wind`,
        resultsDir: `${dir}/results`,
        workingDir: dir,
        ui:         fws.ui || {},
      };
      saveToRecent(projectData);
      setProject(projectData);
      setWelcomeDismissed(true);
    } catch {}
  }, []);

  // ── Update check ─────────────────────────────────────────────────────────
  const checkForUpdates = useCallback(async (manual = false) => {
    try {
      const res = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
        { headers: { Accept: "application/vnd.github+json" } }
      );
      const data = await res.json();
      const latest = (data.tag_name ?? "").replace(/^v/, "");
      if (semverGt(latest, APP_VERSION)) {
        setUpdateInfo({ latest, releaseUrl: data.html_url ?? "" });
      } else if (manual) {
        // Triggered from Settings button — let the user know they're up to date
        setUpdateInfo({ upToDate: true, latest });
      }
    } catch {}
  }, []);

  // Auto-check 6 seconds after launch (non-blocking, silent on error)
  useEffect(() => {
    const t = setTimeout(() => checkForUpdates(false), 6000);
    return () => clearTimeout(t);
  }, [checkForUpdates]);

  // macOS menu "Check for Updates…" triggers this event
  useEffect(() => {
    let unlisten;
    listen("trigger-update-check", () => checkForUpdates(true))
      .then(fn => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [checkForUpdates]);

  // On startup: open a .fus file passed as CLI arg (Windows) or macOS double-click
  // (emitted as "open-fus-file" by the Rust RunEvent::Opened handler).
  useEffect(() => {
    invoke("get_startup_file").then(path => { if (path) openProjectFromPath(path); });
    let unlisten;
    listen("open-fus-file", e => {
      if (!e.payload) return;
      if (projectRef.current) {
        // A project is already open — ask before replacing it
        setPendingFusPath(e.payload);
      } else {
        openProjectFromPath(e.payload);
      }
    }).then(fn => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [openProjectFromPath]);

  // Callback for OpenFASTPanel: receives resolved absolute paths after .fst import
  const handleModuleFilesDetected = useCallback((files) => {
    setModuleFiles(files);
  }, []);

  // "Save & continue" — save the current dirty panel then navigate
  const handleNavSave = async () => {
    const mod = activeModule;
    const { targetModule, tabHint } = navConfirm;
    setNavConfirm({ show: false, targetModule: null, tabHint: null });
    await subSaveFns.current[mod]?.();
    setActiveModule(targetModule);
    if (tabHint) setOfTabReq(prev => ({ tab: tabHint, seq: prev.seq + 1 }));
  };

  // "Discard" — throw away edits and navigate
  const handleNavDiscard = () => {
    const mod = activeModule;
    const { targetModule, tabHint } = navConfirm;
    setNavConfirm({ show: false, targetModule: null, tabHint: null });
    setModuleDirty(prev => ({ ...prev, [mod]: false }));
    // OpenFAST stays mounted — signal it to revert its form to the saved file
    if (mod === "openfast") setOfDiscardSeq(prev => prev + 1);
    setActiveModule(targetModule);
    if (tabHint) setOfTabReq(prev => ({ tab: tabHint, seq: prev.seq + 1 }));
  };

  // "Stay here" — close the dialog, do nothing
  const handleNavCancel = () => {
    setNavConfirm({ show: false, targetModule: null, tabHint: null });
  };

  // Stable callbacks passed to submodule panels.
  // MUST be useCallback — recreating them on every render causes the auto-load effect
  // inside panels to fire and reload the file, resetting any edits the user made.
  const ofOnDirtyChange    = useCallback(v => setModuleDirty(prev => ({ ...prev, openfast:   v })), []);
  const ofOnRegisterSave   = useCallback(fn => { subSaveFns.current.openfast   = fn; }, []);
  const edOnDirtyChange    = useCallback(v => setModuleDirty(prev => ({ ...prev, elastodyn:  v })), []);
  const adOnDirtyChange    = useCallback(v => setModuleDirty(prev => ({ ...prev, aerodyn:    v })), []);
  const sdOnDirtyChange    = useCallback(v => setModuleDirty(prev => ({ ...prev, servodyn:   v })), []);
  const ifwOnDirtyChange   = useCallback(v => setModuleDirty(prev => ({ ...prev, inflowwind: v })), []);
  const hdOnDirtyChange    = useCallback(v => setModuleDirty(prev => ({ ...prev, hydrodyn:   v })), []);
  const ssOnDirtyChange    = useCallback(v => setModuleDirty(prev => ({ ...prev, seastate:   v })), []);
  const subOnDirtyChange   = useCallback(v => setModuleDirty(prev => ({ ...prev, subdyn:     v })), []);
  const mdOnDirtyChange    = useCallback(v => setModuleDirty(prev => ({ ...prev, moordyn:    v })), []);
  const idOnDirtyChange    = useCallback(v => setModuleDirty(prev => ({ ...prev, icedyn:     v })), []);
  const edOnRegisterSave   = useCallback(fn => { subSaveFns.current.elastodyn  = fn; }, []);
  const adOnRegisterSave   = useCallback(fn => { subSaveFns.current.aerodyn    = fn; }, []);
  const sdOnRegisterSave   = useCallback(fn => { subSaveFns.current.servodyn   = fn; }, []);
  const ifwOnRegisterSave  = useCallback(fn => { subSaveFns.current.inflowwind = fn; }, []);
  const ssOnRegisterSave   = useCallback(fn => { subSaveFns.current.seastate   = fn; }, []);
  const hdOnRegisterSave   = useCallback(fn => { subSaveFns.current.hydrodyn   = fn; }, []);
  const subOnRegisterSave  = useCallback(fn => { subSaveFns.current.subdyn     = fn; }, []);
  const mdOnRegisterSave   = useCallback(fn => { subSaveFns.current.moordyn    = fn; }, []);
  const idOnRegisterSave   = useCallback(fn => { subSaveFns.current.icedyn     = fn; }, []);

  // Sweep passed from Wind Field Batch panel → Simulation Batch panel.
  const [wfbExport,     setWfbExport]     = useState(null);
  const wfbOnSendToSim  = useCallback(sweep => {
    setWfbExport(sweep);
    setActiveModule("batchrun");
  }, []);

  // Live wind params shared from InflowWind panel → OpenFAST run panel.
  // Updated in real-time as user edits WindType / HWindSpeed / FileName_BTS.
  const [sharedInflowParams, setSharedInflowParams] = useState(null);
  const ifwOnWindParamsChange = useCallback((windType, hWindSpeed, btsFile) => {
    setSharedInflowParams({ windType, hWindSpeed, btsFile });
  }, []);

  // Incremented by OpenFASTPanel after it patches inflowwind.dat so InflowWindPanel
  // reloads from disk and shows the updated WindType / FileName_BTS values.
  const [inflowReloadKey, setInflowReloadKey] = useState(0);
  const onInflowPatch = useCallback(() => setInflowReloadKey(k => k + 1), []);

  // Whether OpenFAST binary is actively running.
  // Propagated to all module panels so they can block saves that would corrupt
  // the input files of the in-progress simulation.
  const [simRunning, setSimRunning] = useState(false);
  const handleSimRunningChange = useCallback(v => setSimRunning(v), []);

  // Refs so the onCloseRequested listener (registered once) always sees fresh values
  const simRunningRef  = useRef(false);
  const moduleDirtyRef = useRef({});
  const simPidRef      = useRef(null); // PID of the current OpenFAST run (null when idle)
  const handlePidChange = useCallback(pid => { simPidRef.current = pid; }, []);
  // Guard: prevents two simultaneous confirmation dialogs (React StrictMode
  // mounts effects twice in dev, which would register two listeners).
  const dialogOpenRef  = useRef(false);
  const projectRef     = useRef(null); // always tracks live project for event listeners
  useEffect(() => { simRunningRef.current  = simRunning;   }, [simRunning]);
  useEffect(() => { moduleDirtyRef.current = moduleDirty;  }, [moduleDirty]);
  useEffect(() => { projectRef.current     = project;      }, [project]);

  const [consoleOpen,   setConsoleOpen]   = useState(false);
  const [consoleHeight, setConsoleHeight] = useState(CONSOLE_DEFAULT);
  const [isFullscreen,  setIsFullscreen]  = useState(false);
  // Start with empty logs — modules add their own on mount
  const [consoleLogs, setConsoleLogs] = useState([
    { ts: "00:00:00", level: "info", text: "FlowUrja Studio v1.0.0 — ready." },
  ]);

  const consoleHeightRef = useRef(CONSOLE_DEFAULT);
  const updateConsoleHeight = (h) => {
    consoleHeightRef.current = h;
    setConsoleHeight(h);
  };

  useEffect(() => {
    const noCtx = (e) => e.preventDefault();
    document.addEventListener("contextmenu", noCtx);

    const win = getCurrentWindow();
    let unlistenResize;
    let unlistenClose;
    let unlistenQuit;
    const syncState = async () => {
      const full = await win.isFullscreen();
      setIsFullscreen(full);
    };
    syncState();
    win.onResized(syncState).then(fn => { unlistenResize = fn; });

    // ── Shared confirmation logic ──────────────────────────────────────────
    // Returns true if the caller should proceed with closing/quitting.
    // The dialogOpenRef guard ensures only one dialog can appear at a time,
    // which prevents double-dialogs caused by React StrictMode mounting
    // effects twice (and thus registering two listeners) in development.
    const confirmClose = async () => {
      if (dialogOpenRef.current) return false;
      dialogOpenRef.current = true;
      try {
        if (simRunningRef.current) {
          return await ask(
            "A simulation is currently running. Closing now will abort it.\n\nClose anyway?",
            { title: "FlowUrja Studio", kind: "warning", okLabel: "Close Anyway", cancelLabel: "Cancel" }
          );
        }
        const anyDirty = Object.values(moduleDirtyRef.current).some(Boolean);
        if (anyDirty) {
          return await ask(
            "You have unsaved changes that will be lost.\n\nClose without saving?",
            { title: "FlowUrja Studio", kind: "warning", okLabel: "Close Anyway", cancelLabel: "Cancel" }
          );
        }
        return true; // nothing to confirm — proceed immediately
      } finally {
        dialogOpenRef.current = false;
      }
    };

    const doQuit = async () => {
      if (simPidRef.current !== null) {
        await invoke("kill_pid", { pid: simPidRef.current }).catch(() => {});
      }
      invoke("quit_app").catch(() => {});
    };

    // ── ⊗ button / Cmd+W / Alt+F4 ─────────────────────────────────────────
    // Single-window app: closing the window = quitting the app.
    // We call quit_app (→ original terminate: → tao shutdown) rather than
    // win.destroy() so the quit path is identical to Cmd+Q.
    win.onCloseRequested(async (event) => {
      event.preventDefault(); // must be synchronous
      const ok = await confirmClose();
      if (ok) doQuit();
      else win.setFocus().catch(() => {});
    }).then(fn => { unlistenClose = fn; });

    // ── Cmd+Q (intercepted in Rust via ObjC swizzle — macOS only) ─────────
    // Rust prevents the system quit and emits "should-quit" so we can show
    // the same dialog here. On confirm we call quit_app which calls
    // app.exit(0) — this skips ExitRequested so there is no second dialog.
    listen("should-quit", async () => {
      const ok = await confirmClose();
      if (ok) doQuit();
      else win.setFocus().catch(() => {});
    }).then(fn => { unlistenQuit = fn; });

    // macOS-only global shortcuts — Super = Cmd on macOS, Win key on Windows.
    // Win+M minimizes ALL windows on Windows (system shortcut); don't register there.
    if (platform === "macos") {
      register("Super+M", () => win.minimize().catch(() => {})).catch(() => {});
      register("Super+Control+F", () => {
        win.isFullscreen().then(full => {
          win.setFullscreen(!full);
          setIsFullscreen(!full);
        });
      }).catch(() => {});
    }

    const handleDblClick = (e) => {
      if (!isInHeader(e)) return;
      win.toggleMaximize().catch(() => {});
    };

    const handleMouseDown = (e) => {
      if (e.button !== 0) return;
      if (!isInHeader(e)) return;
      if (isSkippedTarget(e.target)) return;
      const startX = e.clientX, startY = e.clientY;
      let started = false;
      const onMove = (me) => {
        if (started) return;
        if (Math.hypot(me.clientX - startX, me.clientY - startY) > 5) {
          started = true;
          win.startDragging().catch(() => {});
          cleanup();
        }
      };
      const onUp = () => cleanup();
      const cleanup = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    };

    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("dblclick",  handleDblClick);

    return () => {
      document.removeEventListener("contextmenu", noCtx);
      document.removeEventListener("mousedown",   handleMouseDown);
      document.removeEventListener("dblclick",    handleDblClick);
      unlistenResize?.();
      unlistenClose?.();
      unlistenQuit?.();
      unregister("Super+M").catch(() => {});
      unregister("Super+Control+F").catch(() => {});
    };
  }, []);

  const sidebarDrag   = useRef(false);
  const sidebarStartX = useRef(0);
  const sidebarStartW = useRef(0);

  const onSidebarDragStart = useCallback((e) => {
    e.preventDefault();
    sidebarDrag.current   = true;
    sidebarStartX.current = e.clientX;
    sidebarStartW.current = sidebarWidth;
    document.body.style.cursor = "col-resize";
    const onMove = (e) => {
      if (!sidebarDrag.current) return;
      const next = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN,
        sidebarStartW.current + (e.clientX - sidebarStartX.current)));
      setSidebarWidth(next);
      invoke("update_sidebar_width", { width: next }).catch(() => {});
    };
    const onUp = () => {
      sidebarDrag.current = false;
      document.body.style.cursor = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup",   onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup",   onUp);
  }, [sidebarWidth]);

  const consoleDragActive = useRef(false);
  const consoleDragStartY = useRef(0);
  const consoleDragStartH = useRef(0);

  const onConsoleDragStart = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    consoleDragActive.current = true;
    consoleDragStartY.current = e.clientY;
    consoleDragStartH.current = consoleHeightRef.current;
    document.body.style.cursor = "row-resize";
    const onMove = (e) => {
      if (!consoleDragActive.current) return;
      const next = Math.min(CONSOLE_MAX, Math.max(CONSOLE_MIN,
        consoleDragStartH.current - (e.clientY - consoleDragStartY.current)));
      updateConsoleHeight(next);
    };
    const onUp = () => {
      consoleDragActive.current = false;
      document.body.style.cursor = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup",   onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup",   onUp);
  }, []);

  // Stable reference — must not recreate on every render (submodule panels depend on it via onLog)
  const addLog = useCallback((level, text) => {
    const now = new Date();
    const ts  = [now.getHours(), now.getMinutes(), now.getSeconds()]
      .map(n => String(n).padStart(2, "0")).join(":");
    setConsoleLogs(prev => [...prev, { ts, level, text }]);
  }, []);

  const fs = isFullscreen;
  const showWelcome = !welcomeDismissed && !project;

  // Inspect panels work without a project (user picks files from disk).
  // Everything else requires a CWD so files have somewhere to go.
  const INSPECT_MODULES = new Set(["results", "windfield"]);
  const needsProject = !project && !INSPECT_MODULES.has(activeModule);

  return (
    <div className={s.shell} style={{
      borderRadius: fs ? 0 : "20px",
      clipPath:     fs ? "none" : "inset(0 round 20px)",
      boxShadow:    fs ? "none" : undefined,
      background:   fs ? "var(--bg-base)" : "transparent",
    }}>

      {/* ── Update dialog ───────────────────────────────────────────────── */}
      {updateInfo && !updateInfo.upToDate && (
        <UpdateDialog
          currentVersion={APP_VERSION}
          latestVersion={updateInfo.latest}
          releaseUrl={updateInfo.releaseUrl}
          onClose={() => setUpdateInfo(null)}
        />
      )}
      {updateInfo?.upToDate && (
        <UpdateDialog
          currentVersion={APP_VERSION}
          latestVersion={updateInfo.latest}
          upToDate
          onClose={() => setUpdateInfo(null)}
        />
      )}

      {/* ── Welcome screen — shown on first launch until folder is chosen ── */}
      {showWelcome && (
        <WelcomeScreen
          onProjectReady={handleProjectReady}
          onSkip={() => setWelcomeDismissed(true)}
        />
      )}

      {/* ── Main app ────────────────────────────────────────────────────── */}
      {!showWelcome && (
      <div className={s.body}>
        <div className={s.sidebarWrap} style={{ width: sidebarWidth }}>
          <Sidebar
            activeModule={activeModule}
            onModuleSelect={handleModuleSelect}
            project={project}
            onOpenProject={handleOpenProject}
            theme={theme}
            onThemeChange={setTheme}
            moduleFiles={moduleFiles}
            moduleDirty={moduleDirty}
            moduleActive={moduleActive}
            onSwitchModel={handleSwitchModel}
            onAddModel={() => setShowAddModel(true)}
            onRemoveModel={handleRemoveModel}
            onSettings={() => handleModuleSelect("settings")}
          />
        </div>

        <div className={s.resizeHandle} onMouseDown={onSidebarDragStart} />

        <div className={s.mainCol} data-drag-main>
          <main className={s.main}>

            {/* ── No-project gate ───────────────────────────────────────── */}
            {needsProject && (
              <div style={{
                flex: 1, display: "flex", flexDirection: "column",
                alignItems: "center", justifyContent: "center",
                gap: 14, color: "var(--tx-5)", textAlign: "center", padding: 32,
              }}>
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"
                     style={{ opacity: 0.35 }}>
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                </svg>
                <div>
                  <p style={{ fontSize: 14, fontWeight: 600, color: "var(--tx-3)", marginBottom: 4 }}>
                    No project open
                  </p>
                  <p style={{ fontSize: 12, lineHeight: 1.6 }}>
                    Open a project folder to access simulation tools.<br />
                    Results and Wind Field viewers are available without a project.
                  </p>
                </div>
                <button
                  onClick={handleOpenProject}
                  style={{
                    padding: "7px 18px", borderRadius: 8, fontSize: 13, fontWeight: 600,
                    background: "#0891B2", color: "#fff",
                    border: "none", cursor: "pointer",
                  }}
                >
                  Open Project…
                </button>
              </div>
            )}

            {/* OpenFAST stays mounted so .fst import state is preserved across navigation */}
            <div style={activeModule === "openfast" && !!project
              ? { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }
              : { display: "none" }
            }>
              <OpenFASTPanel onLog={addLog} project={project} tabRequest={ofTabReq} onModuleFilesDetected={handleModuleFilesDetected} onModuleActiveChange={handleModuleActiveChange} onDirtyChange={ofOnDirtyChange} onRegisterSave={ofOnRegisterSave} discardSeq={ofDiscardSeq} onModuleSelect={handleModuleSelect} isActive={activeModule === "openfast"} inflowWindParams={sharedInflowParams} onSimRunningChange={handleSimRunningChange} onPidChange={handlePidChange} onInflowPatch={onInflowPatch} />
            </div>

            {activeModule === "turbsim"    && !!project && <TurbSimPanel    onLog={addLog} project={project} moduleFiles={moduleFiles} />}

            {/* Wind Field Batch stays mounted so sweep state survives navigation */}
            <div style={activeModule === "windbatch" && !!project
              ? { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }
              : { display: "none" }
            }>
              <WindFieldBatchPanel
                onLog={addLog}
                project={project}
                moduleFiles={moduleFiles}
                onSendToSimBatch={wfbOnSendToSim}
              />
            </div>
            {/* Simulation Batch stays mounted so run state survives navigation */}
            <div style={activeModule === "batchrun" && !!project
              ? { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }
              : { display: "none" }
            }>
              <BatchRunPanel
                onLog={addLog}
                project={project}
                moduleFiles={moduleFiles}
                simRunning={simRunning}
                externalSweep={wfbExport}
              />
            </div>
            {/* InflowWind stays mounted so OpenFAST run card changes sync immediately via reloadKey */}
            <div style={activeModule === "inflowwind" && !!project
              ? { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }
              : { display: "none" }
            }>
              {!!project && <InflowWindPanel onLog={addLog} project={project}
                filePathFromProject={moduleFiles.inflowwind}
                reloadKey={inflowReloadKey}
                onDirtyChange={ifwOnDirtyChange}
                onRegisterSave={ifwOnRegisterSave}
                onWindParamsChange={ifwOnWindParamsChange}
                simRunning={simRunning}
              />}
            </div>
            {activeModule === "elastodyn"  && !!project && <ElastoDynPanel  onLog={addLog} project={project}
              filePathFromProject={moduleFiles.elastodyn}
              onDirtyChange={edOnDirtyChange}
              onRegisterSave={edOnRegisterSave}
              simRunning={simRunning}
            />}
            {activeModule === "aerodyn"    && !!project && <AeroDynPanel    onLog={addLog} project={project}
              filePathFromProject={moduleFiles.aerodyn}
              onDirtyChange={adOnDirtyChange}
              onRegisterSave={adOnRegisterSave}
              simRunning={simRunning}
            />}
            {activeModule === "servodyn"   && !!project && <ServoDynPanel   onLog={addLog} project={project}
              filePathFromProject={moduleFiles.servodyn}
              onDirtyChange={sdOnDirtyChange}
              onRegisterSave={sdOnRegisterSave}
              simRunning={simRunning}
            />}
            {activeModule === "hydrodyn"   && !!project && <HydroDynPanel   onLog={addLog} project={project}
              filePathFromProject={moduleFiles.hydrodyn}
              onDirtyChange={hdOnDirtyChange}
              onRegisterSave={hdOnRegisterSave}
              simRunning={simRunning}
            />}
            {activeModule === "seastate"   && !!project && <SeaStatePanel   onLog={addLog} project={project}
              filePathFromProject={moduleFiles.seastate}
              onDirtyChange={ssOnDirtyChange}
              onRegisterSave={ssOnRegisterSave}
              simRunning={simRunning}
            />}
            {activeModule === "subdyn"     && !!project && <SubDynPanel     onLog={addLog} project={project}
              filePathFromProject={moduleFiles.subdyn}
              onDirtyChange={subOnDirtyChange}
              onRegisterSave={subOnRegisterSave}
              simRunning={simRunning}
            />}
            {activeModule === "moordyn"    && !!project && <MoorDynPanel    onLog={addLog} project={project}
              filePathFromProject={moduleFiles.moordyn}
              onDirtyChange={mdOnDirtyChange}
              onRegisterSave={mdOnRegisterSave}
              simRunning={simRunning}
            />}
            {activeModule === "icedyn"     && !!project && <IceDynPanel     onLog={addLog} project={project}
              filePathFromProject={moduleFiles.icedyn}
              onDirtyChange={idOnDirtyChange}
              onRegisterSave={idOnRegisterSave}
              simRunning={simRunning}
            />}
            {/* Results stays mounted so loaded runs/channels survive panel navigation */}
            <div style={activeModule === "results"
              ? { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }
              : { display: "none" }
            }>
              <ResultsPanel onLog={addLog} project={project}
                onFileLoaded={v => setModuleFiles(p => ({ ...p, results: v }))} />
            </div>
            {/* Wind Field panel — stays mounted to preserve loaded BTS data */}
            <div style={activeModule === "windfield"
              ? { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }
              : { display: "none" }
            }>
              <WindFieldPanel onLog={addLog} project={project}
                onFileLoaded={v => setModuleFiles(p => ({ ...p, windfield: v }))} />
            </div>
            {activeModule === "settings" && (
              <SettingsPanel onLog={addLog} onCheckForUpdates={() => checkForUpdates(true)} />
            )}
            {!["openfast","turbsim","windbatch","batchrun","inflowwind","elastodyn","aerodyn","servodyn","hydrodyn","seastate","subdyn","moordyn","icedyn","results","windfield","settings"].includes(activeModule)
              && <GenericPanel module={activeModule} />}
          </main>
          <Console
            open={consoleOpen}
            height={consoleHeight}
            onToggle={() => setConsoleOpen(o => !o)}
            onDragStart={onConsoleDragStart}
            logs={consoleLogs}
            onClear={() => setConsoleLogs([])}
          />
        </div>
      </div>
      )} {/* end !showWelcome */}

      {/* ── Unsaved-changes dialog ────────────────────────── */}
      {navConfirm.show && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 9999,
          background: "rgba(0,0,0,0.40)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <div style={{
            background: "var(--bg-surface-hov)", border: "0.5px solid var(--bd)",
            borderRadius: 14, padding: "22px 24px", maxWidth: 380, width: "90%",
            boxShadow: "0 16px 48px rgba(0,0,0,0.30)",
          }}>
            <h3 style={{ margin: "0 0 8px", fontSize: 14, fontWeight: 600, color: "var(--tx-1)" }}>
              Unsaved changes in {{ openfast: "OpenFAST", elastodyn: "ElastoDyn", aerodyn: "AeroDyn", servodyn: "ServoDyn", inflowwind: "InflowWind", seastate: "SeaState", hydrodyn: "HydroDyn", subdyn: "SubDyn", moordyn: "MoorDyn", icedyn: "IceDyn" }[activeModule] ?? activeModule}
            </h3>
            <p style={{ margin: "0 0 20px", fontSize: 12.5, color: "var(--tx-4)", lineHeight: 1.5 }}>
              You have unsaved edits. Save before leaving, discard them, or stay here to keep editing.
            </p>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={handleNavCancel} style={{
                padding: "6px 14px", borderRadius: 7, border: "0.5px solid var(--bd)",
                background: "var(--bg-hover)", color: "var(--tx-3)", cursor: "pointer",
                fontSize: 12.5, fontFamily: "inherit",
              }}>
                Stay here
              </button>
              <button onClick={handleNavDiscard} style={{
                padding: "6px 14px", borderRadius: 7, border: "0.5px solid var(--bd)",
                background: "var(--bg-hover)", color: "var(--tx-3)", cursor: "pointer",
                fontSize: 12.5, fontFamily: "inherit",
              }}>
                Discard
              </button>
              <button onClick={handleNavSave} style={{
                padding: "6px 14px", borderRadius: 7, border: "none",
                background: "#0891B2", color: "#fff", cursor: "pointer",
                fontSize: 12.5, fontWeight: 600, fontFamily: "inherit",
              }}>
                Save &amp; continue
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Open-file-while-project-mounted confirmation */}
      {pendingFusPath && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 9999,
          background: "rgba(0,0,0,0.45)",
          display: "flex", alignItems: "center", justifyContent: "center",
          WebkitBackdropFilter: "blur(4px)", backdropFilter: "blur(4px)",
        }}>
          <div style={{
            background: "var(--bg-surface-hov)", border: "0.5px solid var(--bd)",
            borderRadius: 14, padding: "22px 24px", maxWidth: 380, width: "90%",
            boxShadow: "0 16px 48px rgba(0,0,0,0.30)",
          }}>
            <h3 style={{ margin: "0 0 8px", fontSize: 14, fontWeight: 600, color: "var(--tx-1)" }}>
              A project is already open
            </h3>
            <p style={{ margin: "0 0 20px", fontSize: 12.5, color: "var(--tx-4)", lineHeight: 1.5 }}>
              Close <strong style={{ color: "var(--tx-2)" }}>{project?.name ?? "the current project"}</strong> and
              open <strong style={{ color: "var(--tx-2)" }}>{pendingFusPath.split("/").pop().split("\\").pop()}</strong>?
            </p>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setPendingFusPath(null)} style={{
                padding: "6px 14px", borderRadius: 7, border: "0.5px solid var(--bd)",
                background: "var(--bg-hover)", color: "var(--tx-3)", cursor: "pointer",
                fontSize: 12.5, fontFamily: "inherit",
              }}>
                Cancel
              </button>
              <button onClick={() => { const p = pendingFusPath; setPendingFusPath(null); openProjectFromPath(p); }} style={{
                padding: "6px 14px", borderRadius: 7, border: "none",
                background: "#0891B2", color: "#fff", cursor: "pointer",
                fontSize: 12.5, fontWeight: 600, fontFamily: "inherit",
              }}>
                Open anyway
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add model sheet */}
      {showAddModel && project && (
        <AddModelSheet
          project={project}
          onModelAdded={handleModelAdded}
          onClose={() => setShowAddModel(false)}
        />
      )}

      {/* Remove model confirmation */}
      {removeModelConfirm && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 300,
          background: "rgba(0,0,0,0.45)",
          display: "flex", alignItems: "center", justifyContent: "center",
          WebkitBackdropFilter: "blur(4px)", backdropFilter: "blur(4px)",
        }}>
          <div style={{
            background: "var(--bg-surface-hov)", border: "0.5px solid var(--bd-card)",
            borderRadius: 16, padding: "24px", width: 340,
            boxShadow: "0 20px 50px rgba(0,0,0,0.28), 0 0 0 0.5px var(--bd)",
          }}>
            <h3 style={{ margin: "0 0 8px", fontSize: 15, fontWeight: 700, color: "var(--tx-1)", letterSpacing: "-0.01em" }}>
              Remove model?
            </h3>
            <p style={{ margin: "0 0 18px", fontSize: 13, color: "var(--tx-3)", lineHeight: 1.5 }}>
              <strong style={{ color: "var(--tx-1)" }}>{removeModelConfirm.label}</strong> will be removed from this project.
            </p>

            {/* Delete files option */}
            <label style={{
              display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer",
              padding: "10px 12px", borderRadius: 9,
              background: deleteFiles ? "rgba(239,68,68,0.07)" : "var(--bg-muted)",
              border: `1px solid ${deleteFiles ? "rgba(239,68,68,0.25)" : "var(--bd-subtle)"}`,
              marginBottom: 20, transition: "background 0.12s, border-color 0.12s",
            }}>
              <input
                type="checkbox"
                checked={deleteFiles}
                onChange={e => setDeleteFiles(e.target.checked)}
                style={{ marginTop: 1, accentColor: "#EF4444", flexShrink: 0 }}
              />
              <span style={{ fontSize: 12.5, color: "var(--tx-3)", lineHeight: 1.45 }}>
                <strong style={{ color: deleteFiles ? "#EF4444" : "var(--tx-2)", display: "block", marginBottom: 2 }}>
                  Also delete files from disk
                </strong>
                Permanently removes the <code style={{ fontSize: 11, background: "var(--bg-muted)", padding: "1px 4px", borderRadius: 4 }}>model/{removeModelConfirm.id}/</code> directory. This cannot be undone.
              </span>
            </label>

            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => setRemoveModelConfirm(null)}
                style={{
                  flex: 1, padding: "8px 14px", borderRadius: 9,
                  border: "0.5px solid var(--bd)", background: "var(--bg-surface-hov)",
                  color: "var(--tx-3)", fontSize: 13, fontWeight: 500,
                  fontFamily: "inherit", cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                onClick={executeRemoveModel}
                style={{
                  flex: 1.4, padding: "8px 14px", borderRadius: 9, border: "none",
                  background: deleteFiles ? "#EF4444" : "#1a2b3c",
                  color: "#fff", fontSize: 13, fontWeight: 600,
                  fontFamily: "inherit", cursor: "pointer", transition: "background 0.15s",
                }}
              >
                {deleteFiles ? "Remove & delete" : "Remove"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
