@echo off
setlocal
cd /d "%~dp0"
python ..\push_gui.py --app services %*
endlocal
