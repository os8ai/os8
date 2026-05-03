; Phase 4 PR 4.8 — Windows installer customization.
;
; electron-builder writes the os8:// protocol handler entries via
; package.json `build.protocols`, but the default install only writes
; under HKLM (per-machine) when perMachine: true. Our NSIS config sets
; perMachine: false so the user can install without UAC; this means
; the protocol entries land under HKCU (per-user). The blocks below
; ensure SHCTX (which expands to HKCU under perMachine=false) carries
; the entries.

!macro customInstall
  WriteRegStr SHCTX "Software\Classes\os8" "" "URL:OS8 Protocol"
  WriteRegStr SHCTX "Software\Classes\os8" "URL Protocol" ""
  WriteRegStr SHCTX "Software\Classes\os8\DefaultIcon" "" "$INSTDIR\${PRODUCT_FILENAME}.exe,1"
  WriteRegStr SHCTX "Software\Classes\os8\shell\open\command" "" '"$INSTDIR\${PRODUCT_FILENAME}.exe" "%1"'
!macroend

!macro customUnInstall
  DeleteRegKey SHCTX "Software\Classes\os8"
!macroend
