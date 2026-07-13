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
; Bundle document.ico into the installer and extract it to $INSTDIR, then
; write DefaultIcon to both HKLM (machine-wide installs) and HKCU (per-user)
; so it wins regardless of install mode.
; ProgID confirmed from registry: "FlowUrja Studio Project"
!macro customInstall
  SetOutPath $INSTDIR
  File "/oname=document.ico" "${__FILEDIR__}\..\icons\document.ico"
  WriteRegStr HKLM "SOFTWARE\Classes\FlowUrja Studio Project\DefaultIcon" "" "$INSTDIR\document.ico,0"
  WriteRegStr HKCU "Software\Classes\FlowUrja Studio Project\DefaultIcon" "" "$INSTDIR\document.ico,0"
!macroend

!macro customUnInstall
  DeleteRegValue HKLM "SOFTWARE\Classes\FlowUrja Studio Project\DefaultIcon" ""
  DeleteRegValue HKCU "Software\Classes\FlowUrja Studio Project\DefaultIcon" ""
  Delete "$INSTDIR\document.ico"
!macroend
