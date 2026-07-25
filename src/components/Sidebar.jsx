import { useState, useEffect } from "react";
import {
  Gauge, Wind, Cloud, Zap, Activity, Cpu,
  Droplets, LineChart,
  Layers, FolderOpen, ChevronDown, ChevronRight, Check,
  Sun, Moon, Monitor, Plus, X, Waves, Anchor, Snowflake, FileStack,
  Settings,
} from "lucide-react";
import s from "./Sidebar.module.css";

// ── Navigation structure ───────────────────────────────────────────────────────

// Pinned engines — always at top, no section label
const PINNED = [
  { id: "openfast", label: "OpenFAST", color: "var(--c-openfast)", icon: Gauge, enabled: true },
  { id: "turbsim",  label: "TurbSim",  color: "var(--c-turbsim)",  icon: Wind,  enabled: true },
];

// Core OpenFAST sub-module configs
const MODULE_ITEMS = [
  { id: "inflowwind", label: "InflowWind", color: "var(--c-inflow)",    icon: Cloud,    enabled: true },
  { id: "elastodyn",  label: "ElastoDyn",  color: "var(--c-elastodyn)", icon: Activity, enabled: true },
  { id: "aerodyn",    label: "AeroDyn",    color: "var(--c-aerodyn)",   icon: Zap,      enabled: true },
  { id: "servodyn",   label: "ServoDyn",   color: "var(--c-servodyn)",  icon: Cpu,      enabled: true },
];

// Offshore sub-modules — collapsible, closed by default
const OFFSHORE_ITEMS = [
  { id: "seastate", label: "SeaState", color: "var(--c-seastate)", icon: Waves,     enabled: true },
  { id: "hydrodyn", label: "HydroDyn", color: "var(--c-hydrodyn)", icon: Droplets,  enabled: true },
  { id: "subdyn",   label: "SubDyn",   color: "var(--c-subdyn)",   icon: Layers,    enabled: true },
  { id: "moordyn",  label: "MoorDyn",  color: "var(--c-moordyn)",  icon: Anchor,    enabled: true },
  { id: "icedyn",   label: "IceDyn",   color: "var(--c-icedyn)",   icon: Snowflake, enabled: true },
];

// Batch runners
const BATCH_ITEMS = [
  { id: "windbatch", label: "Wind Field Batch", color: "#1D9E75",           icon: Layers, enabled: true },
  { id: "batchrun",  label: "Simulation Batch", color: "var(--c-batchrun)", icon: FileStack, enabled: true },
];

// Post-run inspection
const INSPECT_ITEMS = [
  { id: "windfield", label: "Wind Field", color: "#0891B2", icon: WindFieldIcon, enabled: true },
  { id: "results",   label: "Results",    color: "#E11D48", icon: LineChart,      enabled: true },
];

// Modules that can have a file loaded + dirty state
const FILE_MODULES = new Set([
  "elastodyn", "aerodyn", "servodyn", "inflowwind",
  "hydrodyn", "seastate", "subdyn", "moordyn", "icedyn",
  "windfield", "results",
]);

const OFFSHORE_STORAGE_KEY = "fws-offshore-open";

const isMac = document.documentElement.getAttribute("data-platform") !== "windows";

function shortPath(p) {
  if (!p) return "";
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length <= 2 ? `/${parts.join("/")}` : `…/${parts.slice(-2).join("/")}`;
}

const THEMES = [
  { value: "light",  icon: Sun,     title: "Light"  },
  { value: "system", icon: Monitor, title: "System" },
  { value: "dark",   icon: Moon,    title: "Dark"   },
];

// ── NavItem ────────────────────────────────────────────────────────────────────
function NavItem({ mod, activeModule, onSelect, loadedFstName, fileLoaded, dirty, moduleActive, indent }) {
  const Icon       = mod.icon;
  const isActive   = activeModule === mod.id;
  const isDisabled = !mod.enabled;
  const isCompOff  = !isDisabled && moduleActive !== null && moduleActive !== undefined
                     && moduleActive[mod.id] === false;

  return (
    <li
      className={[
        s.item,
        isActive   ? s.active   : "",
        isDisabled ? s.disabled : "",
        isCompOff  ? s.compOff  : "",
        indent     ? s.itemIndent : "",
      ].join(" ")}
      style={{ "--item-color": mod.color ?? "var(--tx-3)" }}
      onClick={() => { if (!isDisabled) onSelect(mod.id); }}
      title={isCompOff ? `${mod.label} is disabled in the .fst — enable it in OpenFAST → Modules` : undefined}
    >
      <Icon
        size={14} strokeWidth={1.8}
        style={{ color: mod.enabled ? mod.color : "var(--c-disabled)", flexShrink: 0 }}
      />

      {loadedFstName ? (
        <div className={s.itemContent}>
          <span className={s.label}>{mod.label}</span>
          <span className={s.modelTag}>
            <span className={s.modelName}>{loadedFstName}</span>
          </span>
        </div>
      ) : (
        <span className={s.label}>{mod.label}</span>
      )}

      {FILE_MODULES.has(mod.id) && fileLoaded && !isCompOff && dirty && (
        <span className={s.dirtyDot} title="Unsaved changes" />
      )}

      {isActive    && <Check size={11} strokeWidth={2.5} style={{ color: mod.color, flexShrink: 0 }} />}
      {isDisabled  && <span className={s.off}>off</span>}
      {isCompOff   && <span className={s.compOffBadge}>off</span>}
    </li>
  );
}

// ── Wind Field cross-section icon ─────────────────────────────────────────────
function WindFieldIcon({ size = 14, style, className }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none"
         style={style} className={className} aria-hidden="true">
      <rect x="1" y="2.5" width="12" height="9" rx="1.2"
            stroke="currentColor" strokeWidth="1.1"/>
      <circle cx="3.5"  cy="4.75" r="0.75" fill="currentColor"/>
      <circle cx="7"    cy="4.75" r="0.75" fill="currentColor"/>
      <circle cx="10.5" cy="4.75" r="0.75" fill="currentColor"/>
      <circle cx="3.5"  cy="7"    r="0.75" fill="currentColor"/>
      <circle cx="7"    cy="7"    r="1.25" fill="currentColor"/>
      <circle cx="10.5" cy="7"    r="0.75" fill="currentColor"/>
      <circle cx="3.5"  cy="9.25" r="0.75" fill="currentColor"/>
      <circle cx="7"    cy="9.25" r="0.75" fill="currentColor"/>
      <circle cx="10.5" cy="9.25" r="0.75" fill="currentColor"/>
    </svg>
  );
}

// ── .fws project file icon ────────────────────────────────────────────────────
function FwsFileIcon({ size = 14, className }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none"
         className={className} aria-hidden="true">
      <path d="M2.5 1.5h6L11 4.5v8H2.5z"
            stroke="currentColor" strokeWidth="1.15" strokeLinejoin="round"/>
      <path d="M8.5 1.5V4.5H11"
            stroke="currentColor" strokeWidth="1.15" strokeLinejoin="round"/>
      <circle cx="6.75" cy="8.5" r="0.65" fill="currentColor" />
      <line x1="6.75" y1="8.5" x2="6.75" y2="6.6"  stroke="currentColor" strokeWidth="0.95" strokeLinecap="round"/>
      <line x1="6.75" y1="8.5" x2="8.4"  y2="9.45" stroke="currentColor" strokeWidth="0.95" strokeLinecap="round"/>
      <line x1="6.75" y1="8.5" x2="5.1"  y2="9.45" stroke="currentColor" strokeWidth="0.95" strokeLinecap="round"/>
    </svg>
  );
}

// ── Model switcher item ────────────────────────────────────────────────────────
function ModelItem({ model, isActive, canDelete, onClick, onDelete }) {
  return (
    <li
      className={[s.modelItem, isActive ? s.modelItemActive : ""].join(" ")}
      onClick={() => !isActive && onClick(model.id)}
      title={model.label || model.id}
    >
      {isActive && <span className={s.modelDotActive} />}
      <span className={s.modelItemLabel}>{model.label || model.id}</span>
      {canDelete && (
        <button
          className={s.modelDeleteBtn}
          title={`Remove ${model.label || model.id}`}
          onClick={e => { e.stopPropagation(); onDelete(model); }}
        >
          <X size={10} strokeWidth={2.5} />
        </button>
      )}
    </li>
  );
}

// ── Offshore toggle row ────────────────────────────────────────────────────────
function OffshoreToggle({ open, onToggle }) {
  return (
    <li className={s.offshoreToggle} onClick={onToggle}>
      <ChevronRight
        size={9} strokeWidth={2.8}
        className={[s.offshoreChevron, open ? s.offshoreChevronOpen : ""].join(" ")}
      />
      <span className={s.offshoreLabel}>Offshore</span>
      <span className={s.offshoreLine} />
    </li>
  );
}

// ── Section header ─────────────────────────────────────────────────────────────
function SectionHead({ label }) {
  return <span className={s.sectionLabel}>{label}</span>;
}

// ── Main component ────────────────────────────────────────────────────────────
export default function Sidebar({
  activeModule, onModuleSelect,
  project, onOpenProject, onCloseProject,
  theme = "system", onThemeChange,
  moduleFiles,
  moduleDirty,
  moduleActive,
  onSwitchModel,
  onAddModel,
  onRemoveModel,
  onSettings,
}) {
  const loadedFstName = moduleFiles?.fstPath
    ? moduleFiles.fstPath.replace(/\\/g, "/").split("/").pop()
    : null;

  const models        = project?.models || [];
  const activeModelId = project?.activeModelId || null;
  // Show the Models section (with its + button) whenever a project is open,
  // even if no models have been added yet — so the callout message is never a lie.
  const showSwitcher  = !!project;

  // Offshore section open/close — persisted globally in localStorage
  const [offshoreOpen, setOffshoreOpen] = useState(() => {
    try { return localStorage.getItem(OFFSHORE_STORAGE_KEY) === "true"; }
    catch { return false; }
  });

  useEffect(() => {
    try { localStorage.setItem(OFFSHORE_STORAGE_KEY, String(offshoreOpen)); }
    catch {}
  }, [offshoreOpen]);

  // Helper to build NavItem props
  const navProps = (mod) => ({
    mod,
    activeModule,
    onSelect:    onModuleSelect,
    loadedFstName: mod.id === "openfast" ? loadedFstName : null,
    fileLoaded:  FILE_MODULES.has(mod.id) ? !!(moduleFiles?.[mod.id]) : false,
    dirty:       FILE_MODULES.has(mod.id) ? !!(moduleDirty?.[mod.id]) : false,
    moduleActive,
  });

  return (
    <div className={s.card}>
      <div className={s.inner}>

        {/* Title area — drag region for native traffic lights */}
        <div className={s.titleArea} data-tauri-drag-region />

        {/* Context card — Project + Models share a single bordered boundary */}
        <div className={s.contextCard}>

          {/* Project picker */}
          <div className={s.section}>
            <SectionHead label="Project" />
            <div className={s.pickerRow}>
              <button className={s.picker} onClick={onOpenProject}>
                {project
                  ? <FwsFileIcon size={14} className={s.pickerIcon} />
                  : <FolderOpen  size={14} strokeWidth={1.8} className={s.pickerIcon} />
                }
                <span className={s.pickerName}>{project ? project.name : "Open project…"}</span>
                <ChevronDown size={12} strokeWidth={2} className={s.pickerChevron} />
              </button>
              {project && (
                <button
                  className={s.closeProjectBtn}
                  onClick={onCloseProject}
                  title={isMac ? "Close project  ⌘W" : "Close project  Ctrl+W"}
                >
                  <X size={11} strokeWidth={2.5} />
                </button>
              )}
            </div>
            {project && <p className={s.pickerPath}>{shortPath(project.workingDir)}</p>}
          </div>

          {/* Model switcher */}
          {showSwitcher && (
            <div className={s.section}>
              <div className={s.modelHeader}>
                <SectionHead label="Models" />
                <button className={s.addModelBtn} onClick={onAddModel} title="Add model">
                  <Plus size={11} strokeWidth={2.5} />
                </button>
              </div>
              {models.length === 0 ? (
                <p className={s.modelEmptyHint}>
                  Press <strong>+</strong> to add a turbine model (.fst)
                </p>
              ) : (
                <ul className={s.modelList}>
                  {models.map(m => (
                    <ModelItem
                      key={m.id}
                      model={m}
                      isActive={m.id === activeModelId}
                      canDelete={models.length > 1}
                      onClick={onSwitchModel}
                      onDelete={onRemoveModel}
                    />
                  ))}
                </ul>
              )}
            </div>
          )}

        </div>

        {/* ── Scrollable nav ── */}
        <nav className={s.nav}>

          {/* Project-gated sections — hidden until a project is open */}
          {!!project && (
            <>
              <SectionHead label="Engines" />
              <ul className={s.list}>
                {PINNED.map(mod => <NavItem key={mod.id} {...navProps(mod)} />)}
              </ul>

              <div className={s.divider} />

              {/* Modules */}
              <SectionHead label="Modules" />
              <ul className={s.list}>
                {MODULE_ITEMS.map(mod => <NavItem key={mod.id} {...navProps(mod)} />)}

                <OffshoreToggle open={offshoreOpen} onToggle={() => setOffshoreOpen(o => !o)} />
                {offshoreOpen && OFFSHORE_ITEMS.map(mod => (
                  <NavItem key={mod.id} {...navProps(mod)} indent />
                ))}
              </ul>

              <div className={s.divider} />

              {/* Batch */}
              <SectionHead label="Batch" />
              <ul className={s.list}>
                {BATCH_ITEMS.map(mod => <NavItem key={mod.id} {...navProps(mod)} />)}
              </ul>

              <div className={s.divider} />
            </>
          )}

          {/* Inspect — always visible, even without a project */}
          <SectionHead label="Inspect" />
          <ul className={s.list}>
            {INSPECT_ITEMS.map(mod => <NavItem key={mod.id} {...navProps(mod)} />)}
          </ul>

        </nav>

        {/* Footer — theme + settings */}
        <div className={s.footer}>
          <div className={s.footerRow}>
            <div className={s.themeRow}>
              {THEMES.map(t => {
                const Icon = t.icon;
                return (
                  <button
                    key={t.value}
                    className={[s.themeBtn, theme === t.value ? s.themeBtnActive : ""].join(" ")}
                    onClick={() => onThemeChange?.(t.value)}
                    title={t.title}
                  >
                    <Icon size={12} strokeWidth={1.8} />
                    <span>{t.title}</span>
                  </button>
                );
              })}
            </div>
            <button
              className={s.settingsBtn}
              onClick={() => onSettings?.()}
              title="Settings"
            >
              <Settings size={13} strokeWidth={1.8} />
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}
