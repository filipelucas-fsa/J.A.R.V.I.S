@echo off
rem Lança o J.A.R.V.I.S em modo voz (painel + microfone). Se falhar, a janela
rem fica aberta mostrando o erro em vez de fechar na cara do usuário.
chcp 65001 >nul
cd /d "%~dp0"
npm run voice
if errorlevel 1 pause
