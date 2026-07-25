import { invoke } from "@tauri-apps/api/core";

export default function UpdateDialog({ currentVersion, latestVersion, releaseUrl, upToDate, onClose }) {
  const download = () => {
    invoke("open_in_finder", { path: releaseUrl }).catch(() => {});
    onClose();
  };

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 9999,
      display: "flex", alignItems: "center", justifyContent: "center",
      background: "rgba(0,0,0,0.45)",
    }}>
      <div style={{
        background: "var(--bg-card)",
        border: "0.5px solid var(--bd)",
        borderRadius: 16,
        padding: "28px 28px 22px",
        width: 360,
        boxShadow: "0 20px 60px rgba(0,0,0,0.25)",
      }}>
        {/* Icon + title */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
          <img src="/app-icon.png" alt="" style={{ width: 44, height: 44, borderRadius: 10 }} />
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: "var(--tx-1)" }}>
              {upToDate ? "You're up to date" : "Update Available"}
            </div>
            <div style={{ fontSize: 12, color: "var(--tx-3)", marginTop: 2 }}>
              FlowUrja Studio
            </div>
          </div>
        </div>

        {upToDate ? (
          <div style={{ fontSize: 12.5, color: "var(--tx-3)", lineHeight: 1.55, marginBottom: 20 }}>
            You're running the latest version — <span style={{ fontFamily: "monospace", color: "var(--tx-2)" }}>v{currentVersion}</span>.
          </div>
        ) : (
          <>
            {/* Version comparison */}
            <div style={{
              background: "var(--bg-soft)", border: "0.5px solid var(--bd-subtle)",
              borderRadius: 10, padding: "12px 14px", marginBottom: 20,
              display: "flex", justifyContent: "space-between", alignItems: "center",
            }}>
              <div style={{ textAlign: "center", flex: 1 }}>
                <div style={{ fontSize: 10.5, color: "var(--tx-4)", marginBottom: 3, textTransform: "uppercase", letterSpacing: "0.06em" }}>Current</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: "var(--tx-2)", fontFamily: "monospace" }}>v{currentVersion}</div>
              </div>
              <div style={{ color: "var(--tx-4)", fontSize: 18, paddingBottom: 2 }}>→</div>
              <div style={{ textAlign: "center", flex: 1 }}>
                <div style={{ fontSize: 10.5, color: "var(--tx-4)", marginBottom: 3, textTransform: "uppercase", letterSpacing: "0.06em" }}>Latest</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#0891B2", fontFamily: "monospace" }}>v{latestVersion}</div>
              </div>
            </div>
            <div style={{ fontSize: 12.5, color: "var(--tx-3)", lineHeight: 1.55, marginBottom: 20 }}>
              A new version of FlowUrja Studio is available. Download the installer and run it to update.
            </div>
          </>
        )}

        {/* Buttons */}
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onClose} style={{
            flex: 1, padding: "8px 0", borderRadius: 8, border: "0.5px solid var(--bd)",
            background: "var(--bg-soft)", color: "var(--tx-2)",
            fontSize: 13, fontWeight: 500, cursor: "pointer",
          }}>
            {upToDate ? "OK" : "Later"}
          </button>
          {!upToDate && (
            <button onClick={download} style={{
              flex: 2, padding: "8px 0", borderRadius: 8, border: "none",
              background: "#0891B2", color: "#fff",
              fontSize: 13, fontWeight: 600, cursor: "pointer",
            }}>
              Download v{latestVersion}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
