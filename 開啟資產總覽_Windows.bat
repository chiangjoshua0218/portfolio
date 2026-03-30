@echo off
setlocal

:: 找 Chrome 路徑
set CHROME=
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" (
  set CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe
) else if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" (
  set CHROME=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe
) else if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" (
  set CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe
)

if "%CHROME%"=="" (
  echo 找不到 Chrome，請確認是否已安裝 Google Chrome。
  pause
  exit /b 1
)

:: 取得腳本所在資料夾
set DIR=%~dp0

:: 用獨立 profile 開啟，關閉 CORS 限制
start "" "%CHROME%" --disable-web-security --user-data-dir="%TEMP%\portfolio-chrome" "%DIR%index.html"
