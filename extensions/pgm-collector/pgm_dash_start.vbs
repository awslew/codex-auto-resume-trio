' PGM Dashboard launcher - taskbar shortcut target
' If already running: just open browser. Otherwise start dashboard + open browser.
Set ws = CreateObject("Wscript.Shell")
' Check port 5101: findstr exit code 0 = listening (running), 1 = not running
isRunning = ws.Run("cmd /c netstat -ano | findstr :5101 >nul 2>&1", 0, True)
If isRunning = 0 Then
    ws.Run "cmd /c start http://127.0.0.1:5101", 0, False
Else
    ws.Run """C:\Users\user\AppData\Local\Programs\Python\Python311\python.exe"" D:\codex-auto-resume\pgm-board\pgm_dash.py 5101", 1, False
    WScript.Sleep 3000
    ws.Run "cmd /c start http://127.0.0.1:5101", 0, False
End If
