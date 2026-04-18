@echo off
echo.
echo  Hebrew-English Job Scraper
echo  ==========================
cd /d "%~dp0"
node scraper.js
echo.
echo  Done! Reload the admin page to see new jobs.
pause
