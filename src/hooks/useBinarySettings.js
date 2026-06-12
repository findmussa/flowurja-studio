/**
 * useBinarySettings — manages the resolved binary path for one tool
 * (openfast, turbsim, …) across the three-tier resolution chain:
 *
 *   1. User override  (saved in global settings.json)
 *   2. Bundled binary (shipped inside the app resources/bin/)
 *   3. System binary  (auto-detected via which / common conda paths)
 *
 * Usage:
 *   const { resolvedPath, source, overridePath, setOverride } =
 *     useBinarySettings("openfast");
 *
 * source values: "override" | "bundled" | "system" | "notfound"
 *
 * setOverride(path) — saves the new override to global settings and
 *   re-runs resolution immediately.  Pass "" to clear the override.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

// Module-level cache so all panels that mount simultaneously share one
// settings read rather than racing to read the same file.
let settingsCache = null;
let settingsListeners = [];

// Per-binary resolution listeners — notified whenever any hook instance
// calls setOverride so that ALL mounted panels update immediately.
// Structure: { id: number, name: string, fn: (result) => void }[]
let resolutionListeners = [];
let nextListenerId = 0;

function getSettings() {
  return new Promise((resolve) => {
    if (settingsCache !== null) { resolve(settingsCache); return; }
    settingsListeners.push(resolve);
    if (settingsListeners.length === 1) {
      invoke("read_settings")
        .then(raw => {
          try { settingsCache = JSON.parse(raw); } catch { settingsCache = {}; }
          settingsListeners.forEach(fn => fn(settingsCache));
          settingsListeners = [];
        })
        .catch(() => {
          settingsCache = {};
          settingsListeners.forEach(fn => fn(settingsCache));
          settingsListeners = [];
        });
    }
  });
}

function invalidateCache() { settingsCache = null; }

function broadcastResolution(binaryName, result) {
  resolutionListeners
    .filter(l => l.name === binaryName)
    .forEach(l => l.fn(result));
}

export function useBinarySettings(binaryName) {
  const [resolvedPath,   setResolvedPath]   = useState("");
  const [source,         setSource]         = useState("notfound");
  const [overridePath,   setOverridePath]   = useState("");
  const [bundledVersion, setBundledVersion] = useState(null);
  const didResolve = useRef(false);

  const applyResult = useCallback((result) => {
    setResolvedPath(result.path ?? "");
    setSource(result.source ?? "notfound");
    setBundledVersion(result.bundledVersion ?? null);
  }, []);

  // Register this instance as a listener so Settings-panel overrides propagate here.
  useEffect(() => {
    const id = ++nextListenerId;
    resolutionListeners.push({ id, name: binaryName, fn: applyResult });
    return () => {
      resolutionListeners = resolutionListeners.filter(l => l.id !== id);
    };
  }, [binaryName, applyResult]);

  // Load settings + resolve on mount (once per component lifetime).
  useEffect(() => {
    if (didResolve.current) return;
    didResolve.current = true;

    getSettings().then(settings => {
      const override = settings?.binaries?.[binaryName] ?? "";
      setOverridePath(override);
      invoke("resolve_binary", { name: binaryName, overridePath: override || null })
        .then(applyResult)
        .catch(() => { setResolvedPath(""); setSource("notfound"); setBundledVersion(null); });
    });
  }, [binaryName, applyResult]);

  // setOverride — persists to settings.json, re-resolves, then broadcasts to
  // all other mounted hook instances for the same binary (OpenFAST panel,
  // TurbSim panel, etc.) so their status cards update without a remount.
  const setOverride = useCallback((newPath) => {
    setOverridePath(newPath);
    invalidateCache();

    getSettings().then(existing => {
      const updated = {
        ...existing,
        binaries: { ...(existing.binaries ?? {}), [binaryName]: newPath },
      };
      settingsCache = updated;
      invoke("write_settings", { content: JSON.stringify(updated, null, 2) }).catch(() => {});

      invoke("resolve_binary", { name: binaryName, overridePath: newPath || null })
        .then(result => broadcastResolution(binaryName, result))
        .catch(() => broadcastResolution(binaryName, { path: "", source: "notfound", bundledVersion: null }));
    });
  }, [binaryName]);

  return { resolvedPath, source, overridePath, bundledVersion, setOverride };
}
