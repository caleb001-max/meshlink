@echo off
setlocal
cd /d "%~dp0"
title MeshLink dev server

if not exist node_modules (
  echo Installing dependencies ^(first run^)...
  call npm install
  if errorlevel 1 exit /b 1
)

node scripts\preflight.mjs
if errorlevel 1 exit /b 1

call npx expo start %*
