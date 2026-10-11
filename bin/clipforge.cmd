@echo off
REM Thin wrapper so you can run: clipforge <command> [options]
"%~dp0..\node_modules\.bin\tsx.cmd" "%~dp0..\src\cli.ts" %*
