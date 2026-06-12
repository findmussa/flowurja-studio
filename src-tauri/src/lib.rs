use tauri::Manager;
use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};

// ── macOS Cmd+Q interception ──────────────────────────────────────────────────
//
// Cmd+Q calls NSApplication.terminate: which goes through tao's hard-coded
// applicationShouldTerminate: → NSTerminateNow path BEFORE Tauri's RunEvent
// system has a chance to fire.  The only reliable intercept point is to swizzle
// terminate: at the ObjC method level so we can emit "should-quit" to the JS
// frontend first.  If the user confirms, quit_app() calls the original IMP so
// the normal tao shutdown sequence runs to completion.

/// AppHandle stored once in setup so hooked_terminate (an extern "C" fn with
/// no access to Rust closures) can reach the Tauri event system.
#[cfg(target_os = "macos")]
static QUIT_APP_HANDLE: std::sync::OnceLock<tauri::AppHandle<tauri::Wry>> =
    std::sync::OnceLock::new();

/// Original NSApplication.terminate: IMP saved before we replace it.
#[cfg(target_os = "macos")]
static ORIG_TERMINATE: std::sync::OnceLock<
    unsafe extern "C" fn(
        *mut objc::runtime::Object,
        objc::runtime::Sel,
        *mut objc::runtime::Object,
    ),
> = std::sync::OnceLock::new();

/// Replacement for NSApplication.terminate: — called by Cmd+Q / Quit menu.
/// Emits "should-quit" to the JS frontend and returns without terminating.
/// quit_app() calls the saved original IMP to actually exit.
#[cfg(target_os = "macos")]
extern "C" fn hooked_terminate(
    _this: *mut objc::runtime::Object,
    _sel:  objc::runtime::Sel,
    _sender: *mut objc::runtime::Object,
) {
    use tauri::Emitter;
    if let Some(handle) = QUIT_APP_HANDLE.get() {
        let _ = handle.emit("should-quit", ());
    }
}

#[tauri::command]
fn update_sidebar_width(_window: tauri::WebviewWindow, _width: f64) {}

// ── File / process helpers ────────────────────────────────────────────────────
//
// IMPORTANT: Every command that touches the file-system or spawns a subprocess
// MUST be declared `async fn` so that Tauri v2 schedules it on the tokio
// executor.  Synchronous `fn` commands run *on the tokio worker thread itself*
// (no implicit spawn_blocking), so any blocking call — even a fast fs::write —
// can stall the IPC event loop and freeze/crash the WebView.
//
// Pattern: wrap blocking work in `tokio::task::spawn_blocking(move || { ... })`
// so it executes on a dedicated OS thread, leaving tokio's async threads free.

/// Detect a binary by checking PATH (via `which`) then common conda/Homebrew paths.
#[tauri::command]
async fn detect_binary(name: String) -> Option<String> {
    tokio::task::spawn_blocking(move || {
        // 1. Check PATH via `which`
        if let Ok(out) = std::process::Command::new("which").arg(&name).output() {
            if out.status.success() {
                let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !p.is_empty() && std::path::Path::new(&p).exists() {
                    return Some(p);
                }
            }
        }

        // 2. Common install locations
        let home = std::env::var("HOME").unwrap_or_default();
        let candidates = vec![
            format!("/opt/homebrew/bin/{name}"),
            format!("/usr/local/bin/{name}"),
            format!("{home}/mamba/bin/{name}"),
            format!("{home}/mamba/envs/openfast_env/bin/{name}"),
            format!("{home}/mamba/envs/openfast/bin/{name}"),
            format!("{home}/mamba/envs/wt_env/bin/{name}"),
            format!("{home}/miniconda3/bin/{name}"),
            format!("{home}/miniconda3/envs/openfast_env/bin/{name}"),
            format!("{home}/miniconda3/envs/openfast/bin/{name}"),
            format!("{home}/anaconda3/bin/{name}"),
            format!("{home}/anaconda3/envs/openfast_env/bin/{name}"),
            format!("{home}/miniforge3/bin/{name}"),
            format!("{home}/miniforge3/envs/openfast_env/bin/{name}"),
            format!("{home}/openfast/build/glue-codes/turbsim/{name}"),
            format!("/usr/bin/{name}"),
            format!("/usr/local/share/openfast/bin/{name}"),
        ];

        for p in &candidates {
            if std::path::Path::new(p).exists() {
                return Some(p.clone());
            }
        }

        None
    })
    .await
    .unwrap_or(None)
}

#[tauri::command]
async fn read_text_file(path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        std::fs::read_to_string(&path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// List immediate children of a directory (files + dirs), returns absolute paths.
#[tauri::command]
async fn list_dir(path: String) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || {
        let mut entries: Vec<String> = std::fs::read_dir(&path)
            .map_err(|e| e.to_string())?
            .flatten()
            .map(|e| e.path().to_string_lossy().to_string())
            .collect();
        entries.sort();
        Ok(entries)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Recursively copy the contents of `src` directory into `dst` directory.
fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path)?;
        }
    }
    Ok(())
}

// ── OpenFAST input-file helpers ───────────────────────────────────────────────

/// Extract the value for `key` from an OpenFAST input file.
///
/// Lines have the format:  <value>  <KEY>  - description
/// The value may be a quoted string `"..."` or a plain token.
/// Key matching is case-insensitive.
fn parse_openfast_param(content: &str, key: &str) -> Option<String> {
    let key_lc = key.to_lowercase();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('!') || trimmed.is_empty() {
            continue;
        }
        // Split off the value token (quoted or plain) and the remainder of the line.
        let (value_raw, rest) = if trimmed.starts_with('"') {
            if let Some(close_offset) = trimmed[1..].find('"') {
                let close = close_offset + 1; // index of closing '"' in trimmed
                (&trimmed[..close + 1], &trimmed[close + 1..])
            } else {
                continue; // unclosed quote — skip
            }
        } else {
            let idx = trimmed.find(char::is_whitespace).unwrap_or(trimmed.len());
            (&trimmed[..idx], &trimmed[idx..])
        };
        // The key name is the next whitespace token after the value.
        if let Some(k) = rest.trim_start().split_whitespace().next() {
            if k.to_lowercase() == key_lc {
                return Some(value_raw.trim_matches('"').to_string());
            }
        }
    }
    None
}

/// Follow the .fst → ServoFile → DLL_FileName chain and return the directory
/// that contains the controller DLL, or `None` if no Bladed DLL is in use.
///
/// Used to add the DLL's directory to DYLD_LIBRARY_PATH so that sibling
/// dependency libraries placed next to a custom libdiscon.dylib are found.
fn resolve_controller_dll_dir(fst_path: &str) -> Option<String> {
    use std::path::Path;

    let fst = Path::new(fst_path);
    let fst_dir = fst.parent()?;
    let fst_content = std::fs::read_to_string(fst).ok()?;

    // Locate the ServoDyn file.
    let servo_rel = parse_openfast_param(&fst_content, "ServoFile")?;
    let servo_path = if Path::new(&servo_rel).is_absolute() {
        Path::new(&servo_rel).to_path_buf()
    } else {
        fst_dir.join(&servo_rel)
    };
    let servo_content = std::fs::read_to_string(&servo_path).ok()?;

    // Only relevant when PCMode=5 or VSContrl=5 (Bladed DLL interface).
    let pc_mode: i32 = parse_openfast_param(&servo_content, "PCMode")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let vs_contrl: i32 = parse_openfast_param(&servo_content, "VSContrl")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    if pc_mode != 5 && vs_contrl != 5 {
        return None;
    }

    // Extract the DLL path and resolve it relative to the ServoDyn file.
    let dll_file = parse_openfast_param(&servo_content, "DLL_FileName")?;
    if dll_file == "unused" || dll_file.is_empty() {
        return None;
    }
    let servo_dir = servo_path.parent()?;
    let dll_path = if Path::new(&dll_file).is_absolute() {
        Path::new(&dll_file).to_path_buf()
    } else {
        servo_dir.join(&dll_file)
    };

    // Return the directory that houses the DLL (it doesn't need to exist yet —
    // OpenFAST resolves it at load time, but the directory must exist for dlopen).
    dll_path.parent().map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
async fn copy_dir(src: String, dst: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        copy_dir_recursive(
            std::path::Path::new(&src),
            std::path::Path::new(&dst),
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Move (rename) a file, creating the destination parent directory if needed.
#[tauri::command]
async fn rename_file(src: String, dst: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let dst_path = std::path::Path::new(&dst);
        if let Some(parent) = dst_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::rename(&src, &dst).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn remove_dir(path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        std::fs::remove_dir_all(&path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn write_text_file(path: String, content: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        use std::fs;
        use std::path::Path;

        let p = Path::new(&path);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(&path, content).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}


/// Run a binary, capture stdout+stderr, return combined output (capped at 4 KB).
/// Used for lightweight version probing — NOT for long-running simulations.
///
/// IMPORTANT: must be `async` so the blocking `Command::output()` call runs on
/// a `spawn_blocking` thread rather than on the tokio async executor.  A sync
/// `fn` here would block the entire Tauri IPC event loop while waiting for the
/// child process, which freezes the WebView and causes a visible app crash.
#[tauri::command]
async fn query_binary(binary: String, args: Vec<String>) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let out = std::process::Command::new(&binary)
            .args(&args)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output()
            .map_err(|e| format!("Failed to run {binary}: {e}"))?;
        let stdout = String::from_utf8_lossy(&out.stdout).to_string();
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        // Combine and cap at 4 KB — we only need the banner
        let combined = format!("{stdout}{stderr}");
        Ok::<String, String>(combined.chars().take(4096).collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Run a binary and stream stdout/stderr line-by-line to the frontend.
/// `cwd`: optional working directory; defaults to the parent dir of the first arg.
#[tauri::command]
async fn run_binary(
    binary: String,
    args: Vec<String>,
    cwd: Option<String>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    use std::io::BufRead;
    use tauri::Emitter;

    // Resolve working directory: explicit cwd → parent of first arg → current dir
    let working_dir = cwd
        .or_else(|| {
            args.first()
                .and_then(|a| std::path::Path::new(a).parent())
                .map(|p| p.to_string_lossy().into_owned())
        });

    let mut cmd = std::process::Command::new(&binary);
    cmd.args(&args)
       .stdout(std::process::Stdio::piped())
       .stderr(std::process::Stdio::piped());

    if let Some(ref dir) = working_dir {
        cmd.current_dir(dir);
    }

    // ── DYLD_LIBRARY_PATH ────────────────────────────────────────────────────
    // Prepend our bundled lib/ dir so that any controller DLL (libdiscon.dylib
    // or a user-supplied replacement) can resolve its @rpath dependencies —
    // libzmq, libgfortran, Kerberos chain, etc. — without requiring the user
    // to have the right conda env active.
    //
    // This works because OpenFAST is ad-hoc signed only (no Hardened Runtime),
    // so macOS honours DYLD_LIBRARY_PATH for both the binary and every dylib it
    // dlopen()s at runtime.
    //
    // We also append the binary's own conda lib/ dir (if detectable) so that a
    // user-supplied libdiscon built against a different ROSCO install can still
    // find its deps — without overriding the system or our bundled libs.
    {
        let mut lib_dirs: Vec<String> = Vec::new();

        // 1. Our bundled lib/ (highest priority — guaranteed present)
        if let Ok(resource_dir) = app.path().resource_dir() {
            let bundled_lib = resource_dir.join("lib");
            if bundled_lib.exists() {
                lib_dirs.push(bundled_lib.to_string_lossy().into_owned());
            }
        }

        // 2. Conda lib/ next to the binary being run (for user-supplied DLLs)
        if let Some(bin_parent) = std::path::Path::new(&binary).parent() {
            // binary lives in <env>/bin/ → lib/ is <env>/lib/
            let conda_lib = bin_parent.parent().map(|p| p.join("lib"));
            if let Some(cl) = conda_lib {
                if cl.exists() && cl != std::path::Path::new(lib_dirs.first().map(|s| s.as_str()).unwrap_or("")) {
                    lib_dirs.push(cl.to_string_lossy().into_owned());
                }
            }
        }

        // 3. Directory of the controller DLL (resolved from .fst → ServoFile →
        //    DLL_FileName).  Also adds a lib/ sibling if present.  This lets a
        //    user place a custom libdiscon.dylib alongside its own dependency
        //    dylibs (or a lib/ sub-folder) and have everything found automatically.
        if let Some(fst_path) = args.first() {
            if let Some(dll_dir) = resolve_controller_dll_dir(fst_path) {
                if !lib_dirs.iter().any(|d| d == &dll_dir) {
                    lib_dirs.push(dll_dir.clone());
                }
                // Also probe a lib/ sub-folder next to the DLL.
                let sibling_lib = std::path::Path::new(&dll_dir).join("lib");
                if sibling_lib.exists() {
                    let s = sibling_lib.to_string_lossy().into_owned();
                    if !lib_dirs.iter().any(|d| d == &s) {
                        lib_dirs.push(s);
                    }
                }
            }
        }

        if !lib_dirs.is_empty() {
            // Preserve any existing DYLD_LIBRARY_PATH from the environment
            let existing = std::env::var("DYLD_LIBRARY_PATH").unwrap_or_default();
            let combined = if existing.is_empty() {
                lib_dirs.join(":")
            } else {
                format!("{}:{}", lib_dirs.join(":"), existing)
            };
            cmd.env("DYLD_LIBRARY_PATH", combined);
        }
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to run {binary}: {e}"))?;

    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    let app2 = app.clone();
    let app3 = app.clone();

    // Emit the child PID immediately so the UI can call kill_pid if needed.
    let _ = app.emit("binary-pid", child.id());

    // Stream stdout — does NOT emit binary-done (exit code unknown at this point).
    let stdout_thread = std::thread::spawn(move || {
        let reader = std::io::BufReader::new(stdout);
        for line in reader.lines() {
            if let Ok(l) = line {
                let _ = app2.emit("binary-stdout", &l);
            }
        }
    });

    // Stream stderr
    std::thread::spawn(move || {
        let reader = std::io::BufReader::new(stderr);
        for line in reader.lines() {
            if let Ok(l) = line {
                let _ = app3.emit("binary-stderr", &l);
            }
        }
    });

    // Wait for exit, then drain remaining stdout lines before emitting done.
    let status = child.wait().map_err(|e| e.to_string())?;
    let _ = stdout_thread.join();

    // Payload: "ok" on success, "err:<code>" on non-zero exit.
    let payload = if status.success() {
        "ok".to_string()
    } else {
        format!("err:{}", status.code().unwrap_or(-1))
    };
    let _ = app.emit("binary-done", payload);
    Ok(())
}

/// Kill a running process by PID. Used to implement immediate-stop for TurbSim
/// batch runs without waiting for the current case to finish.
#[tauri::command]
async fn kill_pid(pid: u32) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        #[cfg(unix)]
        {
            std::process::Command::new("kill")
                .args(["-TERM", &pid.to_string()])
                .status()
                .map(|_| ())
                .map_err(|e| e.to_string())
        }
        #[cfg(windows)]
        {
            std::process::Command::new("taskkill")
                .args(["/F", "/PID", &pid.to_string()])
                .status()
                .map(|_| ())
                .map_err(|e| e.to_string())
        }
        #[cfg(not(any(unix, windows)))]
        { Ok(()) }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Same as run_binary but emits per-case tagged events for parallel batch runs.
/// Events emitted:  "batch-stdout-{case_id}" and "batch-done-{case_id}"
#[tauri::command]
async fn run_binary_tagged(
    binary: String,
    args: Vec<String>,
    cwd: Option<String>,
    case_id: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    use std::io::BufRead;
    use tauri::Emitter;

    let working_dir = cwd.or_else(|| {
        args.first()
            .and_then(|a| std::path::Path::new(a).parent())
            .map(|p| p.to_string_lossy().into_owned())
    });

    let mut cmd = std::process::Command::new(&binary);
    cmd.args(&args)
       .stdout(std::process::Stdio::piped())
       .stderr(std::process::Stdio::piped());

    if let Some(ref dir) = working_dir {
        cmd.current_dir(dir);
    }

    // Apply the same DYLD_LIBRARY_PATH logic as run_binary
    {
        let mut lib_dirs: Vec<String> = Vec::new();
        if let Ok(resource_dir) = app.path().resource_dir() {
            let bundled_lib = resource_dir.join("lib");
            if bundled_lib.exists() {
                lib_dirs.push(bundled_lib.to_string_lossy().into_owned());
            }
        }
        if let Some(bin_parent) = std::path::Path::new(&binary).parent() {
            let conda_lib = bin_parent.parent().map(|p| p.join("lib"));
            if let Some(cl) = conda_lib {
                if cl.exists() {
                    lib_dirs.push(cl.to_string_lossy().into_owned());
                }
            }
        }
        if let Some(fst_path) = args.first() {
            if let Some(dll_dir) = resolve_controller_dll_dir(fst_path) {
                if !lib_dirs.iter().any(|d| d == &dll_dir) {
                    lib_dirs.push(dll_dir.clone());
                }
            }
        }
        if !lib_dirs.is_empty() {
            let existing = std::env::var("DYLD_LIBRARY_PATH").unwrap_or_default();
            let combined = if existing.is_empty() {
                lib_dirs.join(":")
            } else {
                format!("{}:{}", lib_dirs.join(":"), existing)
            };
            cmd.env("DYLD_LIBRARY_PATH", combined);
        }
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to run {binary}: {e}"))?;

    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    let app2   = app.clone();
    let app3   = app.clone();
    let out_event  = format!("batch-stdout-{case_id}");
    let done_event = format!("batch-done-{case_id}");
    let err_event  = format!("batch-stderr-{case_id}");

    // Emit PID immediately so the frontend can call kill_pid on Stop.
    let pid_event = format!("batch-pid-{case_id}");
    let _ = app.emit(&pid_event, child.id());

    // Stdout reader thread — does NOT emit done_event (exit-code is unknown here).
    let stdout_thread = std::thread::spawn(move || {
        let reader = std::io::BufReader::new(stdout);
        for line in reader.lines() {
            if let Ok(l) = line {
                let _ = app2.emit(&out_event, &l);
            }
        }
    });

    std::thread::spawn(move || {
        let reader = std::io::BufReader::new(stderr);
        for line in reader.lines() {
            if let Ok(l) = line {
                let _ = app3.emit(&err_event, &l);
            }
        }
    });

    // Wait for the process to exit, then drain remaining stdout lines before
    // emitting done — prevents a race where done fires before the last log line.
    let status = child.wait().map_err(|e| e.to_string())?;
    let _ = stdout_thread.join();

    // Payload: "ok" on success, "err:<exit-code>" on failure so the JS side
    // can mark the case as failed without relying solely on keyword scanning.
    let payload = if status.success() {
        "ok".to_string()
    } else {
        format!("err:{}", status.code().unwrap_or(-1))
    };
    let _ = app.emit(&done_event, payload);

    Ok(())
}

/// Write a string payload to the Python sidecar stdin, read one-line JSON response.
// ── Global app settings ───────────────────────────────────────────────────────
//
// Stored in the platform app-config directory (e.g. ~/Library/Application Support/
// FlowWake Studio/settings.json on macOS).  Contains user binary overrides and any
// other machine-level preferences.

/// Read the global settings JSON string.
/// Returns an empty object `{}` when the file does not yet exist.
#[tauri::command]
async fn read_settings(app: tauri::AppHandle) -> Result<String, String> {
    let path = settings_path(&app)?;
    tokio::task::spawn_blocking(move || {
        if path.exists() {
            std::fs::read_to_string(&path).map_err(|e| e.to_string())
        } else {
            Ok("{}".to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Persist the global settings JSON string.
#[tauri::command]
async fn write_settings(app: tauri::AppHandle, content: String) -> Result<(), String> {
    let path = settings_path(&app)?;
    tokio::task::spawn_blocking(move || {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, content).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn settings_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|d| d.join("settings.json"))
        .map_err(|e| e.to_string())
}

// ── Binary resolution ─────────────────────────────────────────────────────────
//
// Resolution chain (first match wins):
//   1. User override path  (from global settings — advanced users)
//   2. Bundled binary      (shipped inside the app bundle under resources/bin/)
//   3. System auto-detect  (which + common conda/Homebrew paths)
//
// Returns: { path: String, source: "override"|"bundled"|"system"|"notfound",
//            bundledVersion?: String }

/// Compile-time known versions for the binaries we ship in resources/bin/.
/// Update this when a new binary is bundled.
/// versions.json in the same directory is also checked at runtime and takes
/// precedence, but this constant is the guaranteed fallback so the UI always
/// has a version to show even in dev mode (where resource_dir resolution may
/// differ from production).
fn bundled_version_constant(name: &str) -> Option<&'static str> {
    match name {
        "openfast" => Some("4.2.0"),
        "turbsim"  => Some("4.2.0"),
        _          => None,
    }
}

#[tauri::command]
async fn resolve_binary(
    name: String,
    override_path: Option<String>,
    app: tauri::AppHandle,
) -> serde_json::Value {
    // 1. User override
    if let Some(ref p) = override_path {
        let p = p.trim();
        if !p.is_empty() && std::path::Path::new(p).exists() {
            return serde_json::json!({ "path": p, "source": "override" });
        }
    }

    // 2. Bundled binary
    //    Layout has two forms:
    //      a) Built app (after CI prep): bin/<name> or bin/<name>.exe at the root
    //      b) Dev from source:           bin/<os-subdir>/<name>  (platform-organized)
    //    We check (a) first so the built app is always fast; (b) is the dev fallback.
    if let Ok(resource_dir) = app.path().resource_dir() {
        let os_subdir = match std::env::consts::OS {
            "windows" => "windows",
            "linux"   => "linux",
            _         => "macos",
        };
        let bin_name = if cfg!(windows) { format!("{}.exe", name) } else { name.clone() };

        let candidates = [
            resource_dir.join("bin").join(&bin_name),                      // built app
            resource_dir.join("bin").join(os_subdir).join(&bin_name),      // dev from source
        ];

        for bundled in &candidates {
            if bundled.exists() {
                let bundled_version: Option<String> = {
                    let vpath = resource_dir.join("bin").join("versions.json");
                    let from_file = std::fs::read_to_string(&vpath)
                        .ok()
                        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
                        .and_then(|v| v.get(&name).and_then(|s| s.as_str()).map(|s| s.to_string()));
                    from_file.or_else(|| bundled_version_constant(&name).map(|s| s.to_string()))
                };
                return serde_json::json!({
                    "path": bundled.to_string_lossy(),
                    "source": "bundled",
                    "bundledVersion": bundled_version,
                });
            }
        }
    }

    // 3. System auto-detect (reuse the detect_binary logic inline)
    let name_clone = name.clone();
    let detected = tokio::task::spawn_blocking(move || {
        // which
        if let Ok(out) = std::process::Command::new("which").arg(&name_clone).output() {
            if out.status.success() {
                let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !p.is_empty() && std::path::Path::new(&p).exists() {
                    return Some(p);
                }
            }
        }
        let home = std::env::var("HOME").unwrap_or_default();
        let candidates = [
            format!("/opt/homebrew/bin/{name_clone}"),
            format!("/usr/local/bin/{name_clone}"),
            format!("{home}/mamba/bin/{name_clone}"),
            format!("{home}/mamba/envs/openfast_env/bin/{name_clone}"),
            format!("{home}/mamba/envs/openfast/bin/{name_clone}"),
            format!("{home}/mamba/envs/wt_env/bin/{name_clone}"),
            format!("{home}/miniconda3/bin/{name_clone}"),
            format!("{home}/miniconda3/envs/openfast_env/bin/{name_clone}"),
            format!("{home}/anaconda3/bin/{name_clone}"),
            format!("{home}/miniforge3/bin/{name_clone}"),
            format!("{home}/miniforge3/envs/openfast_env/bin/{name_clone}"),
            format!("{home}/openfast/build/glue-codes/turbsim/{name_clone}"),
            format!("/usr/bin/{name_clone}"),
        ];
        for p in &candidates {
            if std::path::Path::new(p).exists() { return Some(p.clone()); }
        }
        None
    })
    .await
    .unwrap_or(None);

    match detected {
        Some(p) => serde_json::json!({ "path": p, "source": "system" }),
        None    => serde_json::json!({ "path": "", "source": "notfound" }),
    }
}

// ── libdiscon path patching ───────────────────────────────────────────────────
//
// Templates are authored on macOS so ServoDyn files reference "libdiscon.dylib".
// After copying a template into a new project, this command walks all .dat files
// and rewrites the filename to match the host OS (.dll on Windows, .so on Linux).
// On macOS this is a no-op.

fn patch_libdiscon_recursive(dir: &std::path::Path, target: &str) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            patch_libdiscon_recursive(&path, target)?;
        } else if path.extension().map(|e| e == "dat").unwrap_or(false) {
            if let Ok(content) = std::fs::read_to_string(&path) {
                if content.contains("libdiscon.dylib") {
                    std::fs::write(&path, content.replace("libdiscon.dylib", target))?;
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn patch_libdiscon_paths(dir: String) -> Result<(), String> {
    let target = match std::env::consts::OS {
        "windows" => "libdiscon.dll",
        "linux"   => "libdiscon.so",
        _         => return Ok(()), // macOS — already correct
    };
    patch_libdiscon_recursive(std::path::Path::new(&dir), target)
        .map_err(|e| e.to_string())
}

// ── Turbine templates ─────────────────────────────────────────────────────────
//
// Bundled turbine templates live under resources/turbines/<id>/.
// Each template directory contains:
//   meta.json          — display metadata (name, description, etc.)
//   model/<id>/        — OpenFAST input files (copied to project/model/)
//   wind/default.inp   — TurbSim input file pre-tuned for this turbine
//
// list_turbine_templates scans resources/turbines/ and returns the parsed
// meta.json for each template, augmented with the absolute path to the
// template root so the frontend can pass it to copy_dir.

#[tauri::command]
async fn list_turbine_templates(app: tauri::AppHandle) -> Vec<serde_json::Value> {
    let resource_dir = match app.path().resource_dir() {
        Ok(d) => d,
        Err(_) => return vec![],
    };
    let turbines_dir = resource_dir.join("turbines");

    tokio::task::spawn_blocking(move || {
        let mut templates = vec![];
        let entries = match std::fs::read_dir(&turbines_dir) {
            Ok(e) => e,
            Err(_) => return templates,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() { continue; }
            let meta_path = path.join("meta.json");
            if let Ok(raw) = std::fs::read_to_string(&meta_path) {
                if let Ok(mut meta) = serde_json::from_str::<serde_json::Value>(&raw) {
                    // Inject the absolute template root so the frontend can copy it
                    meta["templatePath"] = serde_json::Value::String(
                        path.to_string_lossy().to_string()
                    );
                    templates.push(meta);
                }
            }
        }
        // Sort by id for stable ordering
        templates.sort_by(|a, b| {
            a["id"].as_str().unwrap_or("").cmp(b["id"].as_str().unwrap_or(""))
        });
        templates
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
fn sidecar_call(payload: String, state: tauri::State<SidecarState>) -> Result<String, String> {
    use std::io::{Write, BufRead};
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let sc = guard.as_mut().ok_or("sidecar not running")?;
    sc.stdin.write_all(format!("{payload}\n").as_bytes()).map_err(|e| e.to_string())?;
    sc.stdin.flush().map_err(|e| e.to_string())?;
    let mut line = String::new();
    sc.stdout.read_line(&mut line).map_err(|e| e.to_string())?;
    Ok(line.trim().to_string())
}

// ── Sidecar ───────────────────────────────────────────────────────────────────
struct Sidecar {
    stdin:  std::process::ChildStdin,
    stdout: std::io::BufReader<std::process::ChildStdout>,
    _child: std::process::Child,
}

type SidecarState = std::sync::Arc<std::sync::Mutex<Option<Sidecar>>>;

fn spawn_sidecar(exe: &str, script: &str) -> Result<Sidecar, String> {
    let mut cmd = std::process::Command::new(exe);
    if !script.is_empty() { cmd.arg(script); }
    let mut child = cmd
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("spawn failed: {e}"))?;
    let stdin  = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    Ok(Sidecar { stdin, stdout: std::io::BufReader::new(stdout), _child: child })
}

/// Called by the frontend after the user confirms they want to quit.
/// On macOS: invokes the original (pre-swizzle) terminate: so tao's event loop
/// shuts down via the normal applicationShouldTerminate: path.
/// On other platforms: calls app.exit(0) directly.
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let _ = app; // suppress unused warning — we use the ObjC path
        unsafe {
            use objc::{class, msg_send, sel, sel_impl};
            use objc::runtime::Object;
            if let Some(orig) = ORIG_TERMINATE.get() {
                let ns_app: *mut Object = msg_send![class!(NSApplication), sharedApplication];
                orig(ns_app, sel!(terminate:), std::ptr::null_mut());
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    app.exit(0);
}

// ── OpenFAST binary output reader (.outb) ─────────────────────────────────────
//
// Supports three FAST binary FileIDs (all little-endian):
//
// FileID 1 / 2  — packed int16 with ColScl/ColOff (legacy + current OpenFAST)
//   i16  FileID
//   i16  NumDOF           (unused marker)
//   i32  NT               number of time steps
//   f64  TimeStep         dt in seconds
//   f64  TimeOut1         first output time
//   f64  TimeEnd          (unused here)
//   i32  NumChannels      output channels, NOT including Time
//   i32  LenDesc          byte length of description string
//   char[LenDesc]         description (skipped)
//   i16  LenName          fixed-width field size for channel names
//   char[LenName × (NumChannels+1)]   channel names (index 0 = "Time")
//   i16  LenUnit          fixed-width field size for unit strings
//   char[LenUnit × (NumChannels+1)]   unit strings
//   f32[NumChannels]      ColScl  (scale factors)
//   f32[NumChannels]      ColOff  (offsets in packed int16 space)
//   i16[NT × NumChannels] PackedData (row-major)
//   Unpack: physical = (packed_i16 − ColOff) / ColScl
//
// FileID 4  — FileFmtID_NoCompressWithoutTime (OpenFAST ≥ 4.x)
//   i16  FileID           = 4
//   i16  NumChannels      output channels (NOT including implicit Time)
//   i32  LenDesc          byte length of description string
//   i32  NT               number of time steps
//   f64  TimeOut1         first output time
//   f64  TimeStep         dt in seconds
//   char[LenDesc]         description text (skipped)
//   i16  LenName          fixed field width for channel names
//   char[(NumChannels+1)×LenName]  channel names (index 0 = "Time")
//   i16  LenUnit          fixed field width for unit strings
//   char[(NumChannels+1)×LenUnit]  unit strings
//   f32[NT × NumChannels] Data (row-major, no ColScl/ColOff compression)
//   Time: time[i] = TimeOut1 + i × TimeStep  (Time column NOT stored in file)

// ── Base64 encoder / decoder (pure Rust, no external crate) ─────────────────
// Encodes raw bytes as standard (RFC 4648) base64 with padding.
// Used to pass large float arrays over the Tauri IPC bridge without the ~2×
// overhead of JSON float serialisation.  The JS side decodes with atob() and
// wraps the result in a Float64Array — roughly 5× faster than JSON.parse for
// the same data.
fn to_base64(data: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let n  = (b0 << 16) | (b1 << 8) | b2;
        out.push(T[((n >> 18) & 63) as usize]);
        out.push(T[((n >> 12) & 63) as usize]);
        out.push(if chunk.len() > 1 { T[((n >> 6) & 63) as usize] } else { b'=' });
        out.push(if chunk.len() > 2 { T[( n        & 63) as usize] } else { b'=' });
    }
    // SAFETY: base64 output contains only ASCII characters — always valid UTF-8.
    unsafe { String::from_utf8_unchecked(out) }
}

/// Decode standard base64 (RFC 4648) back to raw bytes.
/// Used to accept PNG/binary data from the JS frontend for disk writes.
fn from_base64(s: &str) -> Result<Vec<u8>, String> {
    let s = s.trim().as_bytes();
    if s.len() % 4 != 0 {
        return Err(format!("Invalid base64 length: {}", s.len()));
    }
    let decode_c = |c: u8| -> Result<u8, String> {
        match c {
            b'A'..=b'Z' => Ok(c - b'A'),
            b'a'..=b'z' => Ok(c - b'a' + 26),
            b'0'..=b'9' => Ok(c - b'0' + 52),
            b'+'        => Ok(62),
            b'/'        => Ok(63),
            _           => Err(format!("Invalid base64 byte: {c}")),
        }
    };
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let mut i = 0;
    while i < s.len() {
        let b0 = decode_c(s[i])?   as u32;
        let b1 = decode_c(s[i+1])? as u32;
        out.push(((b0 << 2) | (b1 >> 4)) as u8);
        if s[i+2] != b'=' {
            let b2 = decode_c(s[i+2])? as u32;
            out.push(((b1 << 4) | (b2 >> 2)) as u8);
            if s[i+3] != b'=' {
                let b3 = decode_c(s[i+3])? as u32;
                out.push(((b2 << 6) | b3) as u8);
            }
        }
        i += 4;
    }
    Ok(out)
}

/// Write a base64-encoded binary payload to a file.
/// Accepts a base64 string (from `canvas.toBlob` → `FileReader` or `ArrayBuffer`)
/// and writes the decoded bytes to disk, creating parent directories as needed.
/// Used for "Save chart as PNG" and similar export operations.
#[tauri::command]
async fn write_binary_file(path: String, data_b64: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let data = from_base64(&data_b64)
            .map_err(|e| format!("Base64 decode error: {e}"))?;
        let p = std::path::Path::new(&path);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, &data).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── TurbSim BTS wind field reader ─────────────────────────────────────────────
//
// Supports TurbSim binary wind field files (FileID = 7 or 8, little-endian).
//
// Header layout (all little-endian):
//   i16   FileID        = 7 (periodic) or 8 (non-periodic)
//   i16   nz            — number of grid heights
//   i16   ny            — number of grid lateral positions
//   i16   nTwr          — number of tower points (may be 0)
//   i32   nt            — number of time steps
//   f32   dz            — vertical grid spacing (m)
//   f32   dy            — lateral grid spacing (m)
//   f32   dt            — time step (s)
//   f32   UHub          — hub-height mean wind speed (m/s)
//   f32   ZHub          — hub height above ground (m)
//   f32   ZBottom       — height of lowest grid point (m)
//   f32[3] VSlope       — velocity scale factors for u, v, w
//   f32[3] VIntercept   — velocity offsets for u, v, w
//   i16   LenDesc       — length of description string (bytes)
//   u8[LenDesc] Desc    — human-readable description (ASCII)
//
// Velocity data layout (each packed i16 → physical via unpack formula):
//   For it = 0..nt-1:
//     For iz = 0..nz-1  (bottom → top):
//       For iy = 0..ny-1  (left → right):
//         i16 raw_u, i16 raw_v, i16 raw_w
//     For itwr = 0..nTwr-1:   (tower points, after grid)
//       i16 raw_u, i16 raw_v, i16 raw_w
//
// Unpack:  velocity = (raw − VIntercept[c]) / VSlope[c]

fn parse_bts_binary(path: &str) -> Result<serde_json::Value, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("Cannot read file: {e}"))?;

    // Hex dump of the first 48 bytes — shown in every error for diagnostics.
    let hex: String = bytes[..48.min(bytes.len())]
        .iter()
        .enumerate()
        .map(|(i, b)| if i > 0 && i % 8 == 0 { format!("  {:02X}", b) } else { format!("{:02X}", b) })
        .collect::<Vec<_>>()
        .join(" ");

    // ── File ID ─────────────────────────────────────────────────────────────
    if bytes.len() < 2 {
        return Err(format!("File too small ({} bytes)", bytes.len()));
    }
    let file_id = (bytes[0] as i16) | ((bytes[1] as i16) << 8);
    if file_id != 7 && file_id != 8 {
        return Err(format!(
            "Unsupported BTS FileID={file_id} (expected 7 or 8). Hex[0..48]: {hex}"
        ));
    }

    // ── Header auto-detection ────────────────────────────────────────────────
    //
    // Observed layouts:
    //
    //   A — standard TurbSim ≥ v1.5:
    //         i16 FileID | i16 nz @2 | i16 ny @4 | i16 nTwr @6 | i32 nt @8  | f32s @12
    //   B — i32 grid dims variant:
    //         i16 FileID | i32 nz @2 | i32 ny @6 | i16 nTwr @10 | i32 nt @12 | f32s @16
    //   C — extra i16 before nz (old IECturbc field):
    //         i16 FileID | i16 ??? @2 | i16 nz @4 | i16 ny @6 | i16 nTwr @8 | i32 nt @10 | f32s @14
    //   D — i32 grid dims + extra i32 gap between nTwr and nt:
    //         i16 FileID | i32 nz @2 | i32 ny @6 | i16 nTwr @10 | i32 ??? @12 | i32 nt @16 | f32s @20
    //
    // ALL reads use direct from_le_bytes with explicit byte indices — no inner
    // functions, no closures — so offsets are guaranteed correct at compile time.

    // Safety: ensure we have enough bytes for the widest header (32 bytes through f32s@20+12)
    if bytes.len() < 24 {
        return Err(format!("BTS file too small to contain a valid header ({} bytes). Hex: {hex}", bytes.len()));
    }

    // Macros expand to direct byte-array slice reads: no function-call offset ambiguity.
    macro_rules! u16_at {
        ($o:expr) => { u16::from_le_bytes([bytes[$o], bytes[$o + 1]]) as usize }
    }
    macro_rules! u32_at {
        ($o:expr) => { u32::from_le_bytes([bytes[$o], bytes[$o + 1], bytes[$o + 2], bytes[$o + 3]]) as usize }
    }
    macro_rules! f32_at {
        ($o:expr) => { f32::from_le_bytes([bytes[$o], bytes[$o + 1], bytes[$o + 2], bytes[$o + 3]]) }
    }

    // Per-byte diagnostic for the tricky 12..20 window (shown in every error)
    let diag = if bytes.len() >= 20 {
        format!(
            "b[12..20]={:02X}{:02X}{:02X}{:02X}_{:02X}{:02X}{:02X}{:02X}",
            bytes[12], bytes[13], bytes[14], bytes[15],
            bytes[16], bytes[17], bytes[18], bytes[19]
        )
    } else {
        format!("len={}", bytes.len())
    };

    fn dims_ok(nz: usize, ny: usize, nt: usize) -> bool {
        nz > 0 && nz <= 4_096 && ny > 0 && ny <= 4_096 && nt > 0 && nt <= 1_000_000
    }
    fn f32s_sane(dz: f32, dy: f32, dt: f32) -> bool {
        dz > 1e-4 && dz < 5_000.0
            && dy > 1e-4 && dy < 5_000.0
            && dt > 1e-7 && dt < 1_000.0
    }

    // Layout A: i16 nz@2, i16 ny@4, i16 nTwr@6, i32 nt@8, f32s@12
    let (nz_a, ny_a, ntwr_a, nt_a) = (u16_at!(2), u16_at!(4), u16_at!(6), u32_at!(8));
    let ok_a = dims_ok(nz_a, ny_a, nt_a)
        && bytes.len() >= 24
        && f32s_sane(f32_at!(12), f32_at!(16), f32_at!(20));

    // Layout B: i32 nz@2, i32 ny@6, i16 nTwr@10, i32 nt@12, f32s@16
    let (nz_b, ny_b, ntwr_b, nt_b) = if bytes.len() >= 28 {
        (u32_at!(2), u32_at!(6), u16_at!(10), u32_at!(12))
    } else { (0, 0, 0, 0) };
    let ok_b = dims_ok(nz_b, ny_b, nt_b)
        && bytes.len() >= 28
        && f32s_sane(f32_at!(16), f32_at!(20), f32_at!(24));

    // Layout C: skip@2, i16 nz@4, i16 ny@6, i16 nTwr@8, i32 nt@10, f32s@14
    let (nz_c, ny_c, ntwr_c, nt_c) = if bytes.len() >= 26 {
        (u16_at!(4), u16_at!(6), u16_at!(8), u32_at!(10))
    } else { (0, 0, 0, 0) };
    let ok_c = dims_ok(nz_c, ny_c, nt_c)
        && bytes.len() >= 26
        && f32s_sane(f32_at!(14), f32_at!(18), f32_at!(22));

    // Layout D: i32 nz@2, i32 ny@6, i16 nTwr@10, i32 skip@12, i32 nt@16, f32s@20
    let (nz_d, ny_d, ntwr_d, nt_d) = if bytes.len() >= 32 {
        (u32_at!(2), u32_at!(6), u16_at!(10), u32_at!(16))
    } else { (0, 0, 0, 0) };
    let ok_d = dims_ok(nz_d, ny_d, nt_d)
        && bytes.len() >= 32
        && f32s_sane(f32_at!(20), f32_at!(24), f32_at!(28));

    // Layout E: all-i32 grid dims — i32 nz@2, i32 ny@6, i32 nTwr@10, i32 nt@14, f32s@18
    // (nTwr occupies 4 bytes instead of 2, so nt shifts to @14)
    let (nz_e, ny_e, ntwr_e, nt_e) = if bytes.len() >= 30 {
        (u32_at!(2), u32_at!(6), u32_at!(10), u32_at!(14))
    } else { (0, 0, 0, 0) };
    let ok_e = dims_ok(nz_e, ny_e, nt_e)
        && bytes.len() >= 30
        && f32s_sane(f32_at!(18), f32_at!(22), f32_at!(26));

    let (nz, ny, n_twr, nt, f32_start) =
        if ok_a      { (nz_a, ny_a, ntwr_a, nt_a, 12usize) }
        else if ok_b { (nz_b, ny_b, ntwr_b, nt_b, 16usize) }
        else if ok_c { (nz_c, ny_c, ntwr_c, nt_c, 14usize) }
        else if ok_d { (nz_d, ny_d, ntwr_d, nt_d, 20usize) }
        else if ok_e { (nz_e, ny_e, ntwr_e, nt_e, 18usize) }
        else {
            return Err(format!(
                "Cannot decode BTS header (FileID={file_id}). \
                 Tried 5 layouts:\n\
                 • A (i16 grid):   nz={nz_a} ny={ny_a} nTwr={ntwr_a} nt={nt_a}\n\
                 • B (i32 grid):   nz={nz_b} ny={ny_b} nTwr={ntwr_b} nt={nt_b}\n\
                 • C (extra i16):  nz={nz_c} ny={ny_c} nTwr={ntwr_c} nt={nt_c}\n\
                 • D (i32+i16gap): nz={nz_d} ny={ny_d} nTwr={ntwr_d} nt={nt_d}\n\
                 • E (all-i32):    nz={nz_e} ny={ny_e} nTwr={ntwr_e} nt={nt_e}\n\
                 {diag}\n\
                 Hex[0..48]: {hex}"
            ));
        };

    // ── Sequential float reads from f32_start ────────────────────────────────
    let mut pos = f32_start;

    macro_rules! next_f32 {
        () => {{
            if pos + 4 > bytes.len() {
                return Err(format!("Unexpected EOF reading f32 at offset {pos}. Hex: {hex}"));
            }
            let v = f32::from_le_bytes(bytes[pos..pos + 4].try_into().unwrap());
            pos += 4;
            v
        }};
    }
    macro_rules! next_i16 {
        () => {{
            if pos + 2 > bytes.len() {
                return Err(format!("Unexpected EOF reading i16 at offset {pos}. Hex: {hex}"));
            }
            let v = i16::from_le_bytes([bytes[pos], bytes[pos + 1]]);
            pos += 2;
            v
        }};
    }

    let dz      = next_f32!();   // vertical grid spacing (m)
    let dy      = next_f32!();   // lateral grid spacing (m)
    let dt      = next_f32!();   // time step (s)
    let uhub    = next_f32!();   // hub-height mean wind speed (m/s)
    let zhub    = next_f32!();   // hub height AGL (m)
    let zbottom = next_f32!();   // bottom of grid AGL (m)

    let mut vslope     = [0.0f32; 3];
    let mut vintercept = [0.0f32; 3];
    for v in vslope.iter_mut()     { *v = next_f32!(); }
    for v in vintercept.iter_mut() { *v = next_f32!(); }

    // Description string
    let len_desc = next_i16!() as usize;
    let desc = if pos + len_desc <= bytes.len() {
        let s = String::from_utf8_lossy(&bytes[pos..pos + len_desc]).to_string();
        pos += len_desc;
        s
    } else {
        pos = bytes.len();
        String::new()
    };

    // ── Validate data region ─────────────────────────────────────────────────
    let pts_per_step = nz * ny + n_twr;
    let data_bytes   = nt * pts_per_step * 3 * 2; // 3 components × 2 bytes per i16
    if pos + data_bytes > bytes.len() {
        return Err(format!(
            "BTS file too small: need {data_bytes} data bytes at offset {pos}, \
             but only {} bytes remain (file = {} bytes total). \
             Grid: nz={nz} ny={ny} nTwr={n_twr} nt={nt} layout-f32-start={f32_start}. \
             Hex[0..48]: {hex}",
            bytes.len().saturating_sub(pos),
            bytes.len()
        ));
    }

    // ── Decode velocity data → float32 arrays [nt × nz × ny] ────────────────
    let total     = nt * nz * ny;
    let mut u_f32 = vec![0.0f32; total];
    let mut v_f32 = vec![0.0f32; total];
    let mut w_f32 = vec![0.0f32; total];

    for it in 0..nt {
        for iz in 0..nz {
            for iy in 0..ny {
                let raw_u = i16::from_le_bytes([bytes[pos], bytes[pos + 1]]) as f32; pos += 2;
                let raw_v = i16::from_le_bytes([bytes[pos], bytes[pos + 1]]) as f32; pos += 2;
                let raw_w = i16::from_le_bytes([bytes[pos], bytes[pos + 1]]) as f32; pos += 2;
                let idx   = it * nz * ny + iz * ny + iy;
                u_f32[idx] = (raw_u - vintercept[0]) / vslope[0];
                v_f32[idx] = (raw_v - vintercept[1]) / vslope[1];
                w_f32[idx] = (raw_w - vintercept[2]) / vslope[2];
            }
        }
        // Skip tower points for this time step
        pos += n_twr * 3 * 2;
    }

    // ── Encode as base64-wrapped LE float32 bytes ────────────────────────────
    let mut u_buf = Vec::with_capacity(total * 4);
    let mut v_buf = Vec::with_capacity(total * 4);
    let mut w_buf = Vec::with_capacity(total * 4);
    for &v in &u_f32 { u_buf.extend_from_slice(&v.to_le_bytes()); }
    for &v in &v_f32 { v_buf.extend_from_slice(&v.to_le_bytes()); }
    for &v in &w_f32 { w_buf.extend_from_slice(&v.to_le_bytes()); }

    Ok(serde_json::json!({
        "fileId":     file_id,
        "nz":         nz,
        "ny":         ny,
        "nTwr":       n_twr,
        "nt":         nt,
        "dz":         dz,
        "dy":         dy,
        "dt":         dt,
        "uhub":       uhub,
        "zhub":       zhub,
        "zbottom":    zbottom,
        "vslope":     [vslope[0], vslope[1], vslope[2]],
        "vintercept": [vintercept[0], vintercept[1], vintercept[2]],
        "desc":       desc,
        "u":          to_base64(&u_buf),
        "v":          to_base64(&v_buf),
        "w":          to_base64(&w_buf),
    }))
}

#[tauri::command]
async fn read_bts_file(path: String) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || parse_bts_binary(&path))
        .await
        .map_err(|e| e.to_string())?
}

fn parse_fast_binary(path: &str) -> Result<serde_json::Value, String> {

    let bytes = std::fs::read(path).map_err(|e| format!("Cannot read file: {e}"))?;
    let mut pos: usize = 0;

    // ── Byte-level read helpers ─────────────────────────────────────────────
    let read_i16 = |pos: &mut usize| -> Result<i16, String> {
        if *pos + 2 > bytes.len() { return Err("Unexpected end of file (i16)".into()); }
        let v = i16::from_le_bytes([bytes[*pos], bytes[*pos + 1]]);
        *pos += 2; Ok(v)
    };
    let read_i32 = |pos: &mut usize| -> Result<i32, String> {
        if *pos + 4 > bytes.len() { return Err("Unexpected end of file (i32)".into()); }
        let v = i32::from_le_bytes(bytes[*pos..*pos+4].try_into().unwrap());
        *pos += 4; Ok(v)
    };
    let read_f32 = |pos: &mut usize| -> Result<f32, String> {
        if *pos + 4 > bytes.len() { return Err("Unexpected end of file (f32)".into()); }
        let v = f32::from_le_bytes(bytes[*pos..*pos+4].try_into().unwrap());
        *pos += 4; Ok(v)
    };
    let read_f64 = |pos: &mut usize| -> Result<f64, String> {
        if *pos + 8 > bytes.len() { return Err("Unexpected end of file (f64)".into()); }
        let v = f64::from_le_bytes(bytes[*pos..*pos+8].try_into().unwrap());
        *pos += 8; Ok(v)
    };
    let read_str = |pos: &mut usize, len: usize| -> Result<String, String> {
        if *pos + len > bytes.len() { return Err("Unexpected end of file (str)".into()); }
        let s = String::from_utf8_lossy(&bytes[*pos..*pos+len])
            .trim_matches(|c: char| c == '\0' || c.is_ascii_whitespace())
            .to_string();
        *pos += len; Ok(s)
    };

    // ── Dispatch on FileID ──────────────────────────────────────────────────
    let file_id = read_i16(&mut pos)?;

    // ── FileID 4: FileFmtID_ChanLen_In ────────────────────────────────────────
    //
    // Reference: openfast_toolbox/io/fast_output_file.py (FileFmtID_ChanLen_In=4)
    //
    // Binary layout:
    //   bytes  0- 1  i16  FileID    = 4
    //   bytes  2- 3  i16  LenName              ← channel name/unit field width
    //   bytes  4- 7  i32  NumOutChans          ← number of output channels (excl. Time)
    //   bytes  8-11  i32  NT                   ← number of time steps
    //   bytes 12-19  f64  TimeOut1             ← first output time
    //   bytes 20-27  f64  TimeIncr             ← time step
    //   bytes 28 …   f32[NumOutChans]  ColScl  ← per-channel scale factors
    //                f32[NumOutChans]  ColOff  ← per-channel offset factors
    //                i32              LenDesc
    //                u8[LenDesc]      description string
    //                u8[LenName × (NumOutChans+1)]  channel names
    //                u8[LenName × (NumOutChans+1)]  channel units
    //                i16[NT × NumOutChans]  packed data  ← real = (i16 - ColOff) / ColScl
    if file_id == 4 {
        let len_name  = read_i16(&mut pos)? as usize; // bytes 2-3: chars per name field
        let num_chans = read_i32(&mut pos)? as usize; // bytes 4-7: output channels (excl. Time)
        let nt        = read_i32(&mut pos)? as usize; // bytes 8-11
        let time_out1 = read_f64(&mut pos)?;          // bytes 12-19
        let time_step = read_f64(&mut pos)?;          // bytes 20-27
        // pos == 28 here

        if nt == 0 || num_chans == 0 || len_name == 0 {
            return Err(format!(
                "FileID=4: invalid header NT={nt}, NumChans={num_chans}, LenName={len_name}"
            ));
        }

        // ── ColScl and ColOff (per-channel f32) ──────────────────────────────
        let mut col_scl: Vec<f32> = Vec::with_capacity(num_chans);
        let mut col_off: Vec<f32> = Vec::with_capacity(num_chans);
        for _ in 0..num_chans { col_scl.push(read_f32(&mut pos)?); }
        for _ in 0..num_chans { col_off.push(read_f32(&mut pos)?); }

        // ── Skip description string ───────────────────────────────────────────
        let len_desc = read_i32(&mut pos)? as usize;
        pos += len_desc;

        // ── Channel names: (NumOutChans+1) strings of LenName bytes ──────────
        let mut channels: Vec<String> = Vec::with_capacity(num_chans + 1);
        for _ in 0..=num_chans { channels.push(read_str(&mut pos, len_name)?); }

        // ── Channel units: (NumOutChans+1) strings of LenName bytes ──────────
        let mut units: Vec<String> = Vec::with_capacity(num_chans + 1);
        for _ in 0..=num_chans {
            let u = read_str(&mut pos, len_name)?
                .replace('(', "")
                .replace(')', "");
            units.push(u);
        }

        // ── Validate data region ──────────────────────────────────────────────
        let data_bytes = nt * num_chans * 2; // int16
        if pos + data_bytes > bytes.len() {
            return Err(format!(
                "FileID=4: file ({} bytes) too small for data: \
                 NT={nt} × NumChans={num_chans} × 2 = {data_bytes} bytes at offset {pos}",
                bytes.len()
            ));
        }

        // ── Read int16 data and apply real = (i16 - ColOff) / ColScl ─────────
        // Data is stored column-major in the output buffer so the JS side can
        // build per-channel Float64Arrays with a simple slice (no transpose).
        let total_cols = num_chans + 1;
        let mut cols: Vec<Vec<f64>> = (0..total_cols).map(|_| vec![0.0f64; nt]).collect();
        // Time column (index 0) is synthetic
        for t in 0..nt { cols[0][t] = time_out1 + t as f64 * time_step; }

        for t in 0..nt {
            for ch in 0..num_chans {
                let raw = read_i16(&mut pos)? as f64;
                cols[ch + 1][t] = (raw - col_off[ch] as f64) / col_scl[ch] as f64;
            }
        }

        // Serialise as column-major binary (LE f64) → base64.
        // ~2× smaller payload than JSON float arrays; ~5× faster JS decode.
        let mut buf: Vec<u8> = Vec::with_capacity(total_cols * nt * 8);
        for col in &cols { for &v in col { buf.extend_from_slice(&v.to_le_bytes()); } }

        return Ok(serde_json::json!({
            "channels": channels,
            "units":    units,
            "nRows":    nt,
            "nCols":    total_cols,
            "data":     to_base64(&buf),
        }));
    }

    // ── FileID 1 / 2: packed int16 with ColScl / ColOff ────────────────────
    if file_id != 1 && file_id != 2 {
        return Err(format!(
            "Unsupported FAST binary FileID={file_id}. \
             Supported: 1 (packed, with time), 2 (packed, computed time), \
             4 (float32, no compression)."
        ));
    }

    let _num_dof  = read_i16(&mut pos)?;          // unused alignment field
    let nt        = read_i32(&mut pos)? as usize;
    let time_step = read_f64(&mut pos)?;
    let time_out1 = read_f64(&mut pos)?;
    let _time_end = read_f64(&mut pos)?;          // TimeEnd — not needed
    let num_chans = read_i32(&mut pos)? as usize; // excludes Time

    // ── File description (skipped) ──────────────────────────────────────────
    let len_desc = read_i32(&mut pos)? as usize;
    pos += len_desc;

    // ── Channel names (Time is index 0) ─────────────────────────────────────
    let len_name = read_i16(&mut pos)? as usize;
    let mut channels: Vec<String> = Vec::with_capacity(num_chans + 1);
    for _ in 0..=num_chans { channels.push(read_str(&mut pos, len_name)?); }

    // ── Unit strings ─────────────────────────────────────────────────────────
    let len_unit = read_i16(&mut pos)? as usize;
    let mut units: Vec<String> = Vec::with_capacity(num_chans + 1);
    for _ in 0..=num_chans {
        let u = read_str(&mut pos, len_unit)?
            .replace('(', "")
            .replace(')', "");
        units.push(u);
    }

    // ── Per-column output arrays ─────────────────────────────────────────────
    let total_cols = num_chans + 1;
    let mut cols: Vec<Vec<f64>> = (0..total_cols).map(|_| vec![0.0f64; nt]).collect();
    for t in 0..nt { cols[0][t] = time_out1 + t as f64 * time_step; }

    // Scale / offset arrays
    let mut col_scl: Vec<f32> = Vec::with_capacity(num_chans);
    let mut col_off: Vec<f32> = Vec::with_capacity(num_chans);
    for _ in 0..num_chans { col_scl.push(read_f32(&mut pos)?); }
    for _ in 0..num_chans { col_off.push(read_f32(&mut pos)?); }

    // Packed int16 data
    let expected = nt * num_chans * 2;
    if pos + expected > bytes.len() {
        return Err(format!(
            "File too short: need {expected} bytes of packed int16 data, only {} remain.",
            bytes.len() - pos
        ));
    }
    for t in 0..nt {
        for ch in 0..num_chans {
            let packed = i16::from_le_bytes([bytes[pos], bytes[pos + 1]]) as f32;
            pos += 2;
            cols[ch + 1][t] = ((packed - col_off[ch]) / col_scl[ch]) as f64;
        }
    }

    // Column-major binary → base64 (same encoding as FileID=4 path above).
    let mut buf: Vec<u8> = Vec::with_capacity(total_cols * nt * 8);
    for col in &cols { for &v in col { buf.extend_from_slice(&v.to_le_bytes()); } }

    Ok(serde_json::json!({
        "channels": channels,
        "units":    units,
        "nRows":    nt,
        "nCols":    total_cols,
        "data":     to_base64(&buf),
    }))
}

#[tauri::command]
async fn read_outb_file(path: String) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || parse_fast_binary(&path))
        .await
        .map_err(|e| e.to_string())?
}

/// Diagnoses an .outb FileID=4 file, returning parsed header fields and byte
/// samples at key positions — used to verify data_start and layout assumptions.
#[tauri::command]
async fn diagnose_outb_file(path: String) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || {
        let bytes = std::fs::read(&path).map_err(|e| format!("Cannot read: {e}"))?;
        if bytes.len() < 28 { return Err("File too small (< 28 bytes)".into()); }

        let hex_range = |start: usize, n: usize| -> String {
            let end = (start + n).min(bytes.len());
            if start >= bytes.len() { return "(out of range)".into(); }
            bytes[start..end].iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(" ")
        };
        let f32_at = |p: usize| -> String {
            if p + 4 > bytes.len() { return "(eof)".into(); }
            let v = f32::from_le_bytes([bytes[p], bytes[p+1], bytes[p+2], bytes[p+3]]);
            format!("{v:e}")
        };

        let file_id   = i16::from_le_bytes([bytes[0],  bytes[1]]);
        let num_chans = i16::from_le_bytes([bytes[2],  bytes[3]]) as usize;
        let len_desc  = i32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
        let nt        = i32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
        let time_out1 = f64::from_le_bytes(bytes[12..20].try_into().unwrap());
        let time_step = f64::from_le_bytes(bytes[20..28].try_into().unwrap());

        let data_bytes  = nt * num_chans * 4;
        let data_start  = bytes.len().saturating_sub(data_bytes);
        let desc_end    = 28 + len_desc;  // where LenName should be
        let len_name_raw = if desc_end + 2 <= bytes.len() {
            i16::from_le_bytes([bytes[desc_end], bytes[desc_end + 1]]) as i32
        } else { -1 };

        // 8 float32s at computed data_start
        let data_samples: Vec<String> = (0..8).map(|i| f32_at(data_start + i * 4)).collect();
        // 8 float32s 12 bytes before data_start (to catch off-by-one)
        let pre_samples:  Vec<String> = (0..4).map(|i| f32_at(data_start.saturating_sub(12) + i * 4)).collect();

        Ok(serde_json::json!({
            "file_id":      file_id,
            "num_chans":    num_chans,
            "len_desc":     len_desc,
            "nt":           nt,
            "time_out1":    time_out1,
            "time_step":    time_step,
            "file_size":    bytes.len(),
            "data_bytes":   data_bytes,
            "data_start":   data_start,
            "desc_end":     desc_end,
            "len_name_at_desc_end": len_name_raw,
            "hex_at_desc_end_[20B]": hex_range(desc_end, 20),
            "hex_around_data_start_[-8..+8B]": hex_range(data_start.saturating_sub(8), 16),
            "f32_x8_at_data_start":  data_samples,
            "f32_x4_before_data_start": pre_samples,
            "hex_first_32B_of_file": hex_range(0, 32),
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Returns the first `count` bytes of a file as a hex string (space-separated).
/// Used to diagnose binary file format issues during development.
#[tauri::command]
async fn dump_file_hex(path: String, count: usize) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        let n = count.min(bytes.len());
        Ok(bytes[..n]
            .iter()
            .map(|b| format!("{:02X}", b))
            .collect::<Vec<_>>()
            .join(" "))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Output-file scanner ───────────────────────────────────────────────────────

#[derive(serde::Serialize)]
struct OutputFileMeta {
    path:          String,
    name:          String,
    rel_path:      String,   // relative to scan root; "/" separator; used by JS for folder grouping
    size_bytes:    u64,
    modified_secs: u64,
    file_type:     String,   // "out" | "outb"
    nt:            Option<usize>,
    num_chans:     Option<usize>,
    dt:            Option<f64>,
    time_span:     Option<f64>,
}

/// Read just the binary header of a .outb file to extract metadata quickly.
fn outb_header_meta(path: &str) -> Option<(usize, usize, f64, f64)> {
    let bytes = std::fs::read(path).ok()?;
    if bytes.len() < 36 { return None; }
    let file_id = i16::from_le_bytes([bytes[0], bytes[1]]);
    match file_id {
        4 => {
            // bytes 4-7: NumOutChans (i32), bytes 8-11: NT (i32)
            // bytes 12-19: TimeOut1 (f64), bytes 20-27: TimeIncr (f64)
            let nc = i32::from_le_bytes(bytes[4..8].try_into().ok()?) as usize;
            let nt = i32::from_le_bytes(bytes[8..12].try_into().ok()?) as usize;
            let dt = f64::from_le_bytes(bytes[20..28].try_into().ok()?);
            if nc == 0 || nt == 0 || dt <= 0.0 { return None; }
            Some((nt, nc, dt, (nt as f64 - 1.0) * dt))
        }
        1 | 2 => {
            // bytes 2-3: _num_dof (i16), bytes 4-7: NT (i32)
            // bytes 8-15: TimeStep (f64), bytes 32-35: NumChans (i32)
            if bytes.len() < 36 { return None; }
            let nt = i32::from_le_bytes(bytes[4..8].try_into().ok()?) as usize;
            let dt = f64::from_le_bytes(bytes[8..16].try_into().ok()?);
            let nc = i32::from_le_bytes(bytes[32..36].try_into().ok()?) as usize;
            if nc == 0 || nt == 0 || dt <= 0.0 { return None; }
            Some((nt, nc, dt, (nt as f64 - 1.0) * dt))
        }
        _ => None,
    }
}

/// Recursively collect .out / .outb files under `dir` (max depth 8).
fn collect_output_files(dir: &std::path::Path, root: &std::path::Path, results: &mut Vec<OutputFileMeta>, depth: usize) {
    if depth > 8 { return; }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            // Skip hidden directories (e.g. .git)
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            if !name.starts_with('.') {
                collect_output_files(&path, root, results, depth + 1);
            }
            continue;
        }
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if ext != "out" && ext != "outb" { continue; }
        let meta = match std::fs::metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let size_bytes = meta.len();
        let modified_secs = meta.modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let path_str  = path.to_string_lossy().into_owned();
        let name      = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
        let file_type = ext.to_string();
        let rel_path  = path.strip_prefix(root).unwrap_or(&path)
                            .to_string_lossy().replace('\\', "/");
        let (nt, num_chans, dt, time_span) = if ext == "outb" {
            outb_header_meta(&path_str)
                .map(|(nt, nc, dt, ts)| (Some(nt), Some(nc), Some(dt), Some(ts)))
                .unwrap_or((None, None, None, None))
        } else {
            (None, None, None, None)
        };
        results.push(OutputFileMeta { path: path_str, name, rel_path, size_bytes, modified_secs,
            file_type, nt, num_chans, dt, time_span });
    }
}

/// Scan a directory recursively for OpenFAST output files (.out / .outb).
/// Returns metadata for each file, sorted newest-first.
#[tauri::command]
async fn scan_output_files(dir: String) -> Result<Vec<OutputFileMeta>, String> {
    tokio::task::spawn_blocking(move || {
        let root = std::path::Path::new(&dir);
        if !root.is_dir() {
            return Err(format!("Not a directory: {dir}"));
        }
        let mut results = Vec::new();
        collect_output_files(root, root, &mut results, 0);
        results.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
        Ok(results)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── BTS file scanner ──────────────────────────────────────────────────────────

#[derive(serde::Serialize, Clone)]
struct BtsFileMeta {
    path:       String,
    name:       String,
    rel_path:   String,   // relative to scan root; "/" separator; used by JS for folder grouping
    nz:         usize,
    ny:         usize,
    nt:         usize,
    dt:         f32,
    uhub:       f32,
    duration:   f32,
    size_bytes: u64,
}

/// Read the first 200 bytes of a BTS file and extract grid metadata without
/// loading the full velocity data.  Returns None if the file is not a valid BTS.
fn bts_header_quick(path: &str) -> Option<BtsFileMeta> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).ok()?;
    let mut buf = [0u8; 200];
    let n = file.read(&mut buf).ok()?;
    let bytes = &buf[..n];
    if bytes.len() < 24 { return None; }

    let file_id = i16::from_le_bytes([bytes[0], bytes[1]]);
    if file_id != 7 && file_id != 8 { return None; }

    // Same macro-based byte reading as parse_bts_binary
    macro_rules! u16q {
        ($o:expr) => { if ($o) + 2 <= bytes.len() {
            u16::from_le_bytes([bytes[$o], bytes[$o + 1]]) as usize } else { 0 } }
    }
    macro_rules! u32q {
        ($o:expr) => { if ($o) + 4 <= bytes.len() {
            u32::from_le_bytes([bytes[$o], bytes[$o+1], bytes[$o+2], bytes[$o+3]]) as usize
        } else { 0 } }
    }
    macro_rules! f32q {
        ($o:expr) => { if ($o) + 4 <= bytes.len() {
            f32::from_le_bytes([bytes[$o], bytes[$o+1], bytes[$o+2], bytes[$o+3]])
        } else { 0.0f32 } }
    }

    fn dq_ok(nz: usize, ny: usize, nt: usize) -> bool {
        nz > 0 && nz <= 4_096 && ny > 0 && ny <= 4_096 && nt > 0 && nt <= 1_000_000
    }
    fn fq_sane(dz: f32, dy: f32, dt: f32) -> bool {
        dz > 1e-4 && dz < 5_000.0 && dy > 1e-4 && dy < 5_000.0 && dt > 1e-7 && dt < 1_000.0
    }

    // 5-layout auto-detection (mirrors parse_bts_binary)
    let (nz_a, ny_a, nt_a) = (u16q!(2), u16q!(4), u32q!(8));
    let ok_a = dq_ok(nz_a, ny_a, nt_a) && fq_sane(f32q!(12), f32q!(16), f32q!(20));

    let (nz_b, ny_b, nt_b) = (u32q!(2), u32q!(6), u32q!(12));
    let ok_b = dq_ok(nz_b, ny_b, nt_b) && bytes.len() >= 28
        && fq_sane(f32q!(16), f32q!(20), f32q!(24));

    let (nz_c, ny_c, nt_c) = (u16q!(4), u16q!(6), u32q!(10));
    let ok_c = dq_ok(nz_c, ny_c, nt_c) && bytes.len() >= 26
        && fq_sane(f32q!(14), f32q!(18), f32q!(22));

    let (nz_d, ny_d, nt_d) = (u32q!(2), u32q!(6), u32q!(16));
    let ok_d = dq_ok(nz_d, ny_d, nt_d) && bytes.len() >= 32
        && fq_sane(f32q!(20), f32q!(24), f32q!(28));

    let (nz_e, ny_e, nt_e) = (u32q!(2), u32q!(6), u32q!(14));
    let ok_e = dq_ok(nz_e, ny_e, nt_e) && bytes.len() >= 30
        && fq_sane(f32q!(18), f32q!(22), f32q!(26));

    let (nz, ny, nt, f32_start) =
        if ok_a      { (nz_a, ny_a, nt_a, 12usize) }
        else if ok_b { (nz_b, ny_b, nt_b, 16usize) }
        else if ok_c { (nz_c, ny_c, nt_c, 14usize) }
        else if ok_d { (nz_d, ny_d, nt_d, 20usize) }
        else if ok_e { (nz_e, ny_e, nt_e, 18usize) }
        else { return None; };

    // f32_start: dz@+0, dy@+4, dt@+8, uhub@+12
    let dt   = f32q!(f32_start + 8);
    let uhub = f32q!(f32_start + 12);
    if dt <= 0.0 { return None; }

    let size_bytes = std::fs::metadata(path).ok()?.len();
    let name = std::path::Path::new(path)
        .file_name().unwrap_or_default()
        .to_string_lossy().into_owned();

    Some(BtsFileMeta {
        path: path.to_owned(),
        name,
        rel_path: String::new(),   // filled in by collect_bts_files
        nz, ny, nt, dt, uhub,
        duration: (nt as f32 - 1.0) * dt,
        size_bytes,
    })
}

/// Recursively collect .bts files under `dir` (max depth 12).
fn collect_bts_files(
    dir:     &std::path::Path,
    root:    &std::path::Path,
    results: &mut Vec<BtsFileMeta>,
    depth:   usize,
) {
    if depth > 12 { return; }
    let entries = match std::fs::read_dir(dir) { Ok(e) => e, Err(_) => return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            if !name.starts_with('.') {
                collect_bts_files(&path, root, results, depth + 1);
            }
            continue;
        }
        let ext = path.extension()
            .and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
        if ext != "bts" { continue; }
        let path_str = path.to_string_lossy().into_owned();
        if let Some(mut meta) = bts_header_quick(&path_str) {
            meta.rel_path = path.strip_prefix(root).unwrap_or(&path)
                .to_string_lossy().replace('\\', "/");
            results.push(meta);
        }
    }
}

/// Scan a directory recursively for TurbSim wind field files (.bts).
/// Returns metadata for each file, sorted by rel_path.
#[tauri::command]
async fn scan_bts_files(dir: String) -> Result<Vec<BtsFileMeta>, String> {
    tokio::task::spawn_blocking(move || {
        let root = std::path::Path::new(&dir);
        if !root.is_dir() { return Err(format!("Not a directory: {dir}")); }
        let mut results = Vec::new();
        collect_bts_files(root, root, &mut results, 0);
        results.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
        Ok(results)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Return the number of logical CPU cores (for parallelism auto-detect).
#[tauri::command]
fn detect_cpu_cores() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
}

/// Read only the first 64 bytes of a TurbSim BTS file to determine its duration (nt × dt).
/// Supports the same 5 header layouts as read_bts_file but skips all velocity data.
/// Returns the total wind field duration in seconds.
#[tauri::command]
async fn read_bts_duration(path: String) -> Result<f64, String> {
    tokio::task::spawn_blocking(move || {
        use std::io::Read;
        let mut f = std::fs::File::open(&path)
            .map_err(|e| format!("Cannot open BTS: {e}"))?;
        let mut b = [0u8; 64];
        let n = f.read(&mut b).map_err(|e| e.to_string())?;
        let b = &b[..n];

        if b.len() < 24 {
            return Err(format!("BTS file too small ({} bytes)", b.len()));
        }
        let file_id = i16::from_le_bytes([b[0], b[1]]);
        if file_id != 7 && file_id != 8 {
            return Err(format!("Not a TurbSim BTS file (FileID={file_id})"));
        }

        macro_rules! u16_at { ($o:expr) => {
            if $o + 2 <= b.len() { u16::from_le_bytes([b[$o], b[$o+1]]) as usize } else { 0 }
        }}
        macro_rules! u32_at { ($o:expr) => {
            if $o + 4 <= b.len() { u32::from_le_bytes([b[$o], b[$o+1], b[$o+2], b[$o+3]]) as usize } else { 0 }
        }}
        macro_rules! f32_at { ($o:expr) => {
            if $o + 4 <= b.len() { f32::from_le_bytes([b[$o], b[$o+1], b[$o+2], b[$o+3]]) } else { 0.0f32 }
        }}

        fn dims_ok(nz: usize, ny: usize, nt: usize) -> bool {
            nz > 0 && nz <= 4_096 && ny > 0 && ny <= 4_096 && nt > 0 && nt <= 1_000_000
        }
        fn f32s_sane(dz: f32, dy: f32, dt: f32) -> bool {
            dz > 1e-4 && dz < 5_000.0 && dy > 1e-4 && dy < 5_000.0 && dt > 1e-7 && dt < 1_000.0
        }

        // Helper: compute UsableTime from header fields.
        // TurbSim pads AnalysisTime by GridWidth/MeanWS so the frozen-turbulence
        // advection never reads past the array.  OpenFAST needs TMax ≤ UsableTime
        // or it will hit a "GF wind array was exhausted" FATAL ERROR.
        //   UsableTime = nt×dt  −  (ny−1)×dy / MeanWS
        // If MeanWS is unavailable or zero we fall back to nt×dt.
        fn usable_time(nt: usize, dt: f32, ny: usize, dy: f32, mean_ws: f32) -> f64 {
            let analysis_time = nt as f64 * dt as f64;
            if mean_ws > 0.5 {
                let grid_width   = (ny.saturating_sub(1)) as f64 * dy as f64;
                let convect_secs = grid_width / mean_ws as f64;
                (analysis_time - convect_secs).max(1.0)
            } else {
                analysis_time   // degenerate: no MeanWS → return full duration
            }
        }

        // ── Modern TurbSim / OpenFAST layout (confirmed by hex inspection) ─────
        // FileID(i16)@0  nz(i32)@2  ny(i32)@6  nTwr(i32)@10  nt(i32)@14
        // dz(f32)@18  dy(f32)@22  dt(f32)@26  MeanWS(f32)@30
        // TurbSim uses 32-bit integers for all three grid-dimension fields.
        let (nz_m, ny_m, nt_m) = (u32_at!(2), u32_at!(6), u32_at!(14));
        if n >= 30 && dims_ok(nz_m, ny_m, nt_m)
            && f32s_sane(f32_at!(18), f32_at!(22), f32_at!(26))
        {
            let mean_ws_m = f32_at!(30); // 0.0 when n < 34; usable_time handles that
            return Ok(usable_time(nt_m, f32_at!(26), ny_m, f32_at!(22), mean_ws_m));
        }

        // ── Classic / legacy layout (older TurbSim with 16-bit grid dims) ──────
        // FileID(i16)@0  nz(i16)@2  ny(i16)@4  nTwr(i16)@6  nt(i32)@8
        // dz(f32)@12  dy(f32)@16  dt(f32)@20  MeanWS(f32)@24
        let (nz_c, ny_c, nt_c) = (u16_at!(2), u16_at!(4), u32_at!(8));
        if n >= 24 && dims_ok(nz_c, ny_c, nt_c)
            && f32s_sane(f32_at!(12), f32_at!(16), f32_at!(20))
        {
            let mean_ws_c = f32_at!(24);
            return Ok(usable_time(nt_c, f32_at!(20), ny_c, f32_at!(16), mean_ws_c));
        }

        // Unknown layout — dump header bytes for diagnostics
        let hex: String = b.iter().take(32)
            .enumerate()
            .map(|(i, byte)| {
                if i > 0 && i % 4 == 0 { format!(" | {:02X}", byte) }
                else { format!(" {:02X}", byte) }
            })
            .collect();
        Err(format!(
            "Unknown BTS header layout (FileID={file_id}, {n} bytes read). \
             Bytes 0-31:{hex}. \
             Modern-layout check: nz={nz_m} ny={ny_m} nt={nt_m} \
             dz={:.3} dy={:.3} dt={:.6}",
            f32_at!(18), f32_at!(22), f32_at!(26)
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Open a directory (or file) in the native file manager (Finder / Explorer / Nautilus).
#[tauri::command]
async fn open_in_finder(path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open")
                .arg(&path)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
        #[cfg(target_os = "windows")]
        {
            std::process::Command::new("explorer")
                .arg(&path)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
        #[cfg(target_os = "linux")]
        {
            std::process::Command::new("xdg-open")
                .arg(&path)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Entry point ───────────────────────────────────────────────────────────────
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let sidecar_state: SidecarState = std::sync::Arc::new(std::sync::Mutex::new(None));
    let state_clone = sidecar_state.clone();

    tauri::Builder::default()
        .manage(sidecar_state)
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            update_sidebar_width,
            detect_binary, query_binary, run_binary, run_binary_tagged,
            read_settings, write_settings, resolve_binary,
            list_turbine_templates, patch_libdiscon_paths,
            sidecar_call,
            read_text_file, write_text_file, list_dir, copy_dir, rename_file, remove_dir,
            read_outb_file, dump_file_hex, diagnose_outb_file,
            scan_output_files,
            scan_bts_files,
            write_binary_file,
            read_bts_file,
            detect_cpu_cores,
            read_bts_duration,
            open_in_finder, kill_pid,
            quit_app,
        ])
        .setup(move |app| {
            // Create the main window programmatically so we can call
            // traffic_light_position() — a builder-only API with no runtime setter.
            use tauri::{WebviewWindowBuilder, WebviewUrl};

            let builder = WebviewWindowBuilder::new(
                    app, "main", WebviewUrl::App("index.html".into()),
                )
                .title("FlowWake Studio")
                .inner_size(1280.0, 760.0)
                .min_inner_size(720.0, 480.0)
                .resizable(true);

            // macOS: transparent floating window, overlay title bar, custom traffic-light
            // position inside the sidebar card.
            // x=20: 12 px inside the floating sidebar card (card left = 8 px from edge).
            // y=28: card top is at y=8; buttons clear the 18 px corner-radius arc.
            #[cfg(target_os = "macos")]
            let builder = {
                use tauri::{LogicalPosition, TitleBarStyle};
                builder
                    .transparent(true)
                    .hidden_title(true)
                    .title_bar_style(TitleBarStyle::Overlay)
                    .traffic_light_position(LogicalPosition::new(20.0, 28.0))
            };

            // Windows / Linux: standard native decorations — OS provides the title bar,
            // min/max/close buttons, and drag region. No transparency needed.
            #[cfg(not(target_os = "macos"))]
            let builder = builder.decorations(true);

            let window = builder.build().unwrap();

            #[cfg(target_os = "macos")]
            {
                apply_vibrancy(&window, NSVisualEffectMaterial::Sidebar, None, Some(20.0))
                    .expect("vibrancy failed");

                use objc::{msg_send, sel, sel_impl};
                use objc::runtime::Object;
                let ns_win = window.ns_window().unwrap() as *mut Object;
                unsafe {
                    // NSWindowCollectionBehaviorFullScreenPrimary = 1 << 7
                    let _: () = msg_send![ns_win, setCollectionBehavior: 128usize];
                }

                // ── Swizzle NSApplication.terminate: ──────────────────────
                // Save the AppHandle for hooked_terminate, then replace the
                // IMP so Cmd+Q emits "should-quit" instead of quitting.
                let _ = QUIT_APP_HANDLE.set(app.app_handle().clone());
                unsafe {
                    use objc::runtime::{
                        class_getInstanceMethod, method_getImplementation,
                        method_setImplementation, Imp, Method,
                    };
                    use std::mem;
                    let ns_app_class = objc::class!(NSApplication);
                    let terminate_sel = sel!(terminate:);
                    let method =
                        class_getInstanceMethod(ns_app_class, terminate_sel) as *mut Method;
                    if !method.is_null() {
                        let orig_imp = method_getImplementation(method as *const _);
                        let orig: unsafe extern "C" fn(
                            *mut Object, objc::runtime::Sel, *mut Object,
                        ) = mem::transmute(orig_imp);
                        let _ = ORIG_TERMINATE.set(orig);
                        let hooked: Imp = mem::transmute(
                            hooked_terminate
                                as extern "C" fn(*mut Object, objc::runtime::Sel, *mut Object),
                        );
                        method_setImplementation(method, hooked);
                    }
                }
            }

            // Spawn Python sidecar.
            // Production: compiled binary (fws_io / fws_io.exe) produced by PyInstaller in CI.
            // Development: fall back to running fws_io.py directly with the system Python.
            let resource_dir = app.path().resource_dir().unwrap_or_default();
            let compiled = resource_dir.join("sidecar").join(
                if cfg!(windows) { "fws_io.exe" } else { "fws_io" }
            );
            let script = resource_dir.join("sidecar").join("fws_io.py");

            if compiled.exists() {
                match spawn_sidecar(compiled.to_str().unwrap_or(""), "") {
                    Ok(sc) => { *state_clone.lock().unwrap() = Some(sc); }
                    Err(e) => eprintln!("[sidecar] compiled spawn failed: {e}"),
                }
            } else if script.exists() {
                let python = ["python3", "python"]
                    .iter()
                    .find(|p| std::process::Command::new(p).arg("--version").output().is_ok())
                    .map(|s| s.to_string())
                    .unwrap_or("python3".to_string());
                match spawn_sidecar(&python, script.to_str().unwrap_or("")) {
                    Ok(sc) => { *state_clone.lock().unwrap() = Some(sc); }
                    Err(e) => eprintln!("[sidecar] python spawn failed: {e}"),
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Nurja");
}
