@echo off
setlocal
set "RELAY=%~dp0release\local-relay\AMO Relay\AMO Relay.exe"
if not exist "%RELAY%" (
  echo Work relay is not built. See docs/work-relay.md.
  pause
  exit /b 1
)
start "" "%RELAY%"
