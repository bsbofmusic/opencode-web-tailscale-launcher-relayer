Set shell = CreateObject("WScript.Shell")
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""D:\CODE\opencode-tailscale\start-opencode-tailscale.ps1""", 0, False
