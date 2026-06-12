; FlowWake Studio — NSIS installer hook
; Injects a license agreement page before the installation begins.
;
; MUI_PAGE_LICENSE internally !defines MUI_ICON with a default value.
; We !undef it immediately after so Tauri's own !define MUI_ICON
; (further down in installer.nsi) can set our custom icon without conflict.
!insertmacro MUI_PAGE_LICENSE "${__FILEDIR__}\license.txt"
!ifdef MUI_ICON
  !undef MUI_ICON
!endif
