' Automatic Inbox Machine — hidden launcher.
'
' Start Menu and desktop shortcuts point here rather than at node.exe directly.
' Without this shim, every launch flashes a console window and leaves one on the
' taskbar for as long as the app runs, which makes a background agent look like a
' script someone forgot to close.
'
' WScript.Shell.Run with intWindowStyle 0 and bWaitOnReturn False is the only
' reliable way to start a console program with no window on Windows, from
' something a .lnk can invoke.
'
' Everything real happens in scripts/app.mjs — this file stays deliberately
' trivial so there is no logic living in VBScript.

Option Explicit

Dim shell, fso, appRoot, nodeExe, scriptPath, command

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' This file lives in <app>\installer\, so the app root is one level up.
appRoot = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))

nodeExe = appRoot & "\runtime\node.exe"
If Not fso.FileExists(nodeExe) Then
  ' No bundled runtime (a git checkout rather than an installed copy). Fall back
  ' to whatever Node is on PATH.
  nodeExe = "node.exe"
End If

scriptPath = appRoot & "\scripts\app.mjs"
If Not fso.FileExists(scriptPath) Then
  MsgBox "Automatic Inbox Machine looks incomplete — scripts\app.mjs is missing." & vbCrLf & vbCrLf & _
         "Reinstall from https://github.com/7ustoo/automatic-inbox-machine/releases", _
         16, "Automatic Inbox Machine"
  WScript.Quit 1
End If

shell.CurrentDirectory = appRoot

command = """" & nodeExe & """ """ & scriptPath & """"
If WScript.Arguments.Count > 0 Then
  Dim i
  For i = 0 To WScript.Arguments.Count - 1
    command = command & " " & WScript.Arguments(i)
  Next
End If

shell.Run command, 0, False
