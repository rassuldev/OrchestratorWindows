@echo off
rem Agent tool wrapper for cmd / PowerShell. Same as bin/orch-shot (Git Bash).
node "%~dp0..\node_modules\tsx\dist\cli.mjs" "%~dp0..\src\tools\screenshot.ts" %*
