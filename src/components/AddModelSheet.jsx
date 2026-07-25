/**
 * AddModelSheet — modal sheet for adding a second (or nth) model to an open project.
 *
 * Key design decisions:
 * - Shows a loading state until list_templates resolves so cards are never
 *   erroneously marked "Coming soon" due to async timing.
 * - alreadyIn uses tmpl.modelDir (present in TURBINE_CATALOG now) so it works
 *   even before live template data arrives.
 * - "Already added" templates are greyed + labelled, not hidden.
 * - Templates not bundled (available=false) show "Coming soon" and are unclickable.
 */
import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { X, FolderOpen, Wind, Loader } from "lucide-react";
import { TURBINE_CATALOG, CONFIG_TYPE, scanModelDependencies } from "./WelcomeScreen";
import s from "./AddModelSheet.module.css";

// ── Template card ──────────────────────────────────────────────────────────────
function ModelCard({ tmpl, selected, alreadyIn, onClick, cardIdx }) {
  const cfg = CONFIG_TYPE[tmpl.configType] || CONFIG_TYPE.onshore;

  // Three states: available & clickable | already added (disabled) | coming soon (unavailable)
  const isAvail   = tmpl.available !== false;
  const clickable = isAvail && !alreadyIn;

  return (
    <div
      className={[
        s.card,
        selected   ? s.cardSelected  : "",
        alreadyIn  ? s.cardAdded     : "",
        !isAvail && !alreadyIn ? s.cardDim : "",
      ].join(" ")}
      style={{ "--accent": cfg.color, "--card-idx": cardIdx ?? 0 }}
      onClick={() => clickable && onClick(tmpl)}
    >
      <div className={s.cardAccent} />
      <div className={s.cardBody}>
        <div className={s.cardTop}>
          <Wind size={13} strokeWidth={1.8} style={{ color: alreadyIn ? "var(--tx-5)" : cfg.color, flexShrink: 0, marginTop: 1 }} />
          <span className={s.cardName}>{tmpl.name}</span>

          {alreadyIn && (
            <span className={s.tagAdded}>Already added</span>
          )}
          {!alreadyIn && isAvail && tmpl.badge && (
            <span className={s.badge} style={{ color: cfg.color, borderColor: cfg.color }}>{tmpl.badge}</span>
          )}
          {!alreadyIn && !isAvail && (
            <span className={s.tagSoon}>Coming soon</span>
          )}
        </div>
        <div className={s.cardSub}>
          <span style={{ color: alreadyIn ? "var(--tx-5)" : cfg.color }}>{cfg.label}</span>
          {tmpl.ratedPower    && <> · {tmpl.ratedPower / 1000} MW</>}
          {tmpl.rotorDiameter && <> · Ø{tmpl.rotorDiameter} m</>}
          {tmpl.hubHeight     && <> · H {tmpl.hubHeight} m</>}
        </div>
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────
export default function AddModelSheet({ project, onModelAdded, onClose }) {
  const [templates,        setTemplates]        = useState([]);
  const [templatesLoaded,  setTemplatesLoaded]  = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState(null);
  const [modelMode,        setModelMode]        = useState("template");
  const [sourceDir,        setSourceDir]        = useState("");
  const [sourceFst,        setSourceFst]        = useState("");
  const [siblingDirs,      setSiblingDirs]      = useState([]);
  const [siblingFiles,     setSiblingFiles]     = useState([]);
  const [adding,           setAdding]           = useState(false);
  const [error,            setError]            = useState("");
  const [closing,          setClosing]          = useState(false);

  const handleClose = () => {
    if (closing) return;
    setClosing(true);
    setTimeout(onClose, 200);
  };

  // Load bundled templates — mark loaded even on error so cards are never stuck
  useEffect(() => {
    invoke("list_turbine_templates")
      .then(list => { setTemplates(list); setTemplatesLoaded(true); })
      .catch(()  => { setTemplatesLoaded(true); });
  }, []);

  // Live template data keyed by catalog id
  const templatesById = Object.fromEntries(templates.map(t => [t.id, t]));

  // Model-directory names already present in this project.
  // Uses the stored model id (= directory name, e.g. "IEA-15-240-RWT-Monopile").
  const existingIds = new Set((project?.models || []).map(m => m.id));

  const canAdd = modelMode === "template"
    ? selectedTemplate != null
    : sourceFst.trim() !== "";

  // ── Import ─────────────────────────────────────────────────────────────────
  const handleBrowseFst = async () => {
    try {
      const file = await openDialog({ multiple: false, filters: [{ name: "OpenFAST", extensions: ["fst"] }] });
      if (!file) return;
      const file2 = file.replace(/\\/g, "/");
      setSourceFst(file2);
      setSourceDir(file2.split("/").slice(0, -1).join("/"));
      setSiblingDirs([]);
      setSiblingFiles([]);
      const { siblingDirs: sibs, siblingFiles: sibFiles } = await scanModelDependencies(file2);
      setSiblingDirs(sibs);
      setSiblingFiles(sibFiles);
    } catch {}
  };

  // ── Copy + .fws update ────────────────────────────────────────────────────
  const handleAdd = async () => {
    if (!canAdd || !project) return;
    setAdding(true);
    setError("");
    try {
      const modelBaseDir = `${project.dir}/model`;
      let modelFstAbs = null;
      let modelId     = null;
      let modelLabel  = null;

      if (modelMode === "template" && selectedTemplate) {
        const tmplPath     = selectedTemplate.templatePath;
        const modelDirName = selectedTemplate.modelDir || selectedTemplate.id;

        await invoke("copy_dir", {
          src: `${tmplPath}/model/${modelDirName}`,
          dst: `${modelBaseDir}/${modelDirName}`,
        });
        for (const sib of (selectedTemplate.siblingDirs || [])) {
          await invoke("copy_dir", {
            src: `${tmplPath}/model/${sib}`,
            dst: `${modelBaseDir}/${sib}`,
          });
        }
        const fstFile = selectedTemplate.fstFile || `${modelDirName}.fst`;
        modelFstAbs = `${modelBaseDir}/${modelDirName}/${fstFile}`;
        modelId     = modelDirName;
        modelLabel  = selectedTemplate.name || modelDirName;

      } else if (modelMode === "import" && sourceDir && sourceFst) {
        const fstDirName = sourceDir.split("/").pop();
        const parentDir  = sourceDir.split("/").slice(0, -1).join("/");
        await invoke("copy_dir", { src: sourceDir, dst: `${modelBaseDir}/${fstDirName}` });
        for (const sib of siblingDirs) {
          await invoke("copy_dir", { src: `${parentDir}/${sib}`, dst: `${modelBaseDir}/${sib}` });
        }
        for (const fileName of siblingFiles) {
          const content = await invoke("read_text_file", { path: `${parentDir}/${fileName}` });
          await invoke("write_text_file", { path: `${modelBaseDir}/${fileName}`, content });
        }
        const fstName = sourceFst.split("/").pop();
        modelFstAbs = `${modelBaseDir}/${fstDirName}/${fstName}`;
        modelId     = fstDirName;
        modelLabel  = fstDirName;
      }

      if (!modelFstAbs) return;

      const fstRelative = modelFstAbs.replace(`${project.dir}/`, "");
      const modelEntry  = { id: modelId, label: modelLabel, fstPath: fstRelative };

      // Read + update .fws
      const raw = await invoke("read_text_file", { path: project.fwsPath });
      const fws = JSON.parse(raw);

      // Migrate old single-model format if needed
      if (!fws.models) {
        if (fws.modelFst) {
          const oldId = fws.modelFst.split("/")[1] || "model";
          fws.models = [{ id: oldId, label: fws.name || oldId, fstPath: fws.modelFst }];
        } else {
          fws.models = [];
        }
        delete fws.modelFst;
      }

      const idx = fws.models.findIndex(m => m.id === modelId);
      if (idx >= 0) fws.models[idx] = modelEntry;
      else fws.models.push(modelEntry);

      fws.activeModelId = modelId;
      await invoke("write_text_file", { path: project.fwsPath, content: JSON.stringify(fws, null, 2) });

      onModelAdded({ ...modelEntry, fstPath: modelFstAbs });
    } catch (e) {
      setError(String(e));
    } finally {
      setAdding(false);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div
      className={[s.overlay, closing ? s.overlayExit : ""].join(" ")}
      onClick={e => e.target === e.currentTarget && handleClose()}
    >
      <div className={[s.sheet, closing ? s.sheetExit : ""].join(" ")}>

        {/* Header */}
        <div className={s.header}>
          <div>
            <h2 className={s.title}>Add model</h2>
            <p className={s.sub}>Add a turbine model to <strong>{project?.name}</strong></p>
          </div>
          <button className={s.closeBtn} onClick={handleClose}><X size={16} strokeWidth={2} /></button>
        </div>

        {/* Mode tabs */}
        <div className={s.tabs}>
          {["template", "import"].map(m => (
            <button
              key={m}
              className={[s.tab, modelMode === m ? s.tabActive : ""].join(" ")}
              onClick={() => setModelMode(m)}
            >
              {m === "template" ? "Template" : "Import .fst"}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className={s.body}>
          {modelMode === "template" ? (
            !templatesLoaded ? (
              <div className={s.loading}>
                <Loader size={16} strokeWidth={1.8} className={s.spinner} />
                <span>Loading templates…</span>
              </div>
            ) : (
              <div className={s.zoo}>
                {(() => { let cardIdx = 0; return TURBINE_CATALOG.map((group) => (
                  <div key={group.group}>
                    <p className={s.groupLabel}>{group.group}</p>
                    <div className={s.zooGrid} style={{ gridTemplateColumns: group.models.length === 1 ? "1fr" : "1fr 1fr" }}>
                      {group.models.map(catalogEntry => {
                        const live      = templatesById[catalogEntry.id];
                        const tmpl      = live
                          ? { ...catalogEntry, ...live }
                          : { ...catalogEntry, available: false };

                        const dirName   = tmpl.modelDir || tmpl.id;
                        const alreadyIn = existingIds.has(dirName);

                        return (
                          <ModelCard
                            key={tmpl.id}
                            tmpl={tmpl}
                            selected={selectedTemplate?.id === tmpl.id}
                            alreadyIn={alreadyIn}
                            onClick={t => setSelectedTemplate(t)}
                            cardIdx={cardIdx++}
                          />
                        );
                      })}
                    </div>
                  </div>
                )); })()}
                {/* Selected template detail */}
                {selectedTemplate && (
                  <div style={{
                    marginTop: 8, padding: "8px 10px",
                    background: "var(--bg-base)", borderRadius: 8,
                    border: "0.5px solid var(--bd)",
                  }}>
                    <div style={{ fontSize: 11.5, fontWeight: 600, color: "var(--tx-1)", marginBottom: 3 }}>
                      {selectedTemplate.name}
                    </div>
                    {selectedTemplate.description && (
                      <p style={{
                        margin: 0, fontSize: 10.5, color: "var(--tx-4)", lineHeight: 1.5,
                        display: "-webkit-box", WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical", overflow: "hidden",
                      }}>
                        {selectedTemplate.description}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )
          ) : (
            <div className={s.importArea}>
              <p className={s.importHint}>Select the folder containing the .fst file and its supporting input files. The entire directory will be copied into this project's <code>model/</code> folder.</p>
              <button className={s.browseBtn} onClick={handleBrowseFst}>
                <FolderOpen size={14} strokeWidth={1.8} />
                {sourceFst ? sourceFst.split("/").pop() : "Browse for .fst file…"}
              </button>
              {sourceDir && <p className={s.importPath}>From: {sourceDir}</p>}
            </div>
          )}
        </div>

        {/* Footer */}
        {error && <p className={s.errorMsg}>{error}</p>}
        <div className={s.footer}>
          <button className={s.cancelBtn} onClick={handleClose} disabled={adding}>Cancel</button>
          <button className={s.addBtn} onClick={handleAdd} disabled={!canAdd || adding}>
            {adding ? "Adding…" : "Add model"}
          </button>
        </div>

      </div>
    </div>
  );
}
