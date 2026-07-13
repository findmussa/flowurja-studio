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
; Explicitly bundle document.ico into the installer and extract it to $INSTDIR,
; then point the .fus ProgID DefaultIcon at that file.
; Using File here (rather than relying on Tauri's resource copy) guarantees
; the .ico is present before the registry write.
!macro customInstall
  SetOutPath $INSTDIR
  File "/oname=document.ico" "${__FILEDIR__}\..\icons\document.ico"
  ; Read whichever ProgID Tauri registered for .fus and override DefaultIcon
  ReadRegStr $R0 SHCTX "Software\Classes\.fus" ""
  StrCmp $R0 "" +2 0
    WriteRegStr SHCTX "Software\Classes\$R0\DefaultIcon" "" "$INSTDIR\document.ico,0"
  ; Fallback: write on the extension key itself (Windows also checks here)
  WriteRegStr SHCTX "Software\Classes\.fus\DefaultIcon" "" "$INSTDIR\document.ico,0"
!macroend

!macro customUnInstall
  ReadRegStr $R0 SHCTX "Software\Classes\.fus" ""
  StrCmp $R0 "" +2 0
    DeleteRegValue SHCTX "Software\Classes\$R0\DefaultIcon" ""
  DeleteRegValue SHCTX "Software\Classes\.fus\DefaultIcon" ""
  Delete "$INSTDIR\document.ico"
!macroend
