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
; Read the ProgID that Tauri's APP_ASSOCIATE just registered for .fus, then
; override its DefaultIcon with our custom document.ico.
; This avoids hard-coding the ProgID format, which varies by Tauri version.
!macro customInstall
  ReadRegStr $R0 SHCTX "Software\Classes\.fus" ""
  StrCmp $R0 "" +2 0
    WriteRegStr SHCTX "Software\Classes\$R0\DefaultIcon" "" "$INSTDIR\document.ico,0"
!macroend

!macro customUnInstall
  ReadRegStr $R0 SHCTX "Software\Classes\.fus" ""
  StrCmp $R0 "" +2 0
    DeleteRegValue SHCTX "Software\Classes\$R0\DefaultIcon" ""
  Delete "$INSTDIR\document.ico"
!macroend
