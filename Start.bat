@echo off
pushd %~dp0
call npm install
call npm run app:dev
pause
popd
