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
; Tauri registers "FlowUrja Studio.fus\DefaultIcon" pointing to exe,0.
; These macros override it with our custom document.ico after the default
; install runs, and clean it up on uninstall.
!macro customInstall
  WriteRegStr HKCR "FlowUrja Studio.fus\DefaultIcon" "" "$INSTDIR\document.ico,0"
!macroend

!macro customUnInstall
  Delete "$INSTDIR\document.ico"
!macroend
