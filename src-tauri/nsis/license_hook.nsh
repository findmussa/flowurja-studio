; FlowUrja Studio — NSIS installer hook
; Adds a license agreement page before installation begins.
;
; MUI2.nsh pre-defines MUI_ICON/MUI_UNICON with NSIS defaults before this
; hook is included. We override both with our custom icon, register the
; license page, then undef so Tauri's installerIcon/uninstallerIcon config
; can !define them again without an "already defined!" error.
!ifdef MUI_ICON
  !undef MUI_ICON
!endif
!ifdef MUI_UNICON
  !undef MUI_UNICON
!endif
!define MUI_ICON   "${__FILEDIR__}\..\icons\icon.ico"
!define MUI_UNICON "${__FILEDIR__}\..\icons\icon.ico"
!insertmacro MUI_PAGE_LICENSE "${__FILEDIR__}\license.txt"
!undef MUI_ICON
!undef MUI_UNICON

; ── Document icon for .fus file associations ───────────────────────────────
; Tauri registers the file association ProgID under SHCTX (HKCU\Software\Classes
; for per-user installs, HKLM\Software\Classes for machine-wide) using the
; association `name` field as the FILECLASS key ("FlowUrja Studio Project").
; customInstall runs after Tauri's APP_ASSOCIATE call, so this write wins.
!macro customInstall
  WriteRegStr SHCTX "Software\Classes\FlowUrja Studio Project\DefaultIcon" "" "$INSTDIR\document.ico,0"
!macroend

!macro customUnInstall
  DeleteRegValue SHCTX "Software\Classes\FlowUrja Studio Project\DefaultIcon" ""
  Delete "$INSTDIR\document.ico"
!macroend
