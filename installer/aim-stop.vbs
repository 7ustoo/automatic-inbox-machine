' Automatic Inbox Machine — stop everything.
'
' Start Menu "Stop" shortcut. Signals the watcher, bot, and dashboard, then
' reports what happened in a dialog, because a Start Menu item that appears to do
' nothing is worse than no Start Menu item.

Option Explicit

Dim shell, fso, appRoot, nodeExe, scriptPath, exitCode

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

appRoot = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))

nodeExe = appRoot & "\runtime\node.exe"
If Not fso.FileExists(nodeExe) Then nodeExe = "node.exe"

scriptPath = appRoot & "\scripts\app.mjs"
shell.CurrentDirectory = appRoot

' Wait here (bWaitOnReturn True) so the dialog reflects the real outcome.
exitCode = shell.Run("""" & nodeExe & """ """ & scriptPath & """ --stop", 0, True)

If exitCode = 0 Then
  MsgBox "Automatic Inbox Machine has been stopped." & vbCrLf & vbCrLf & _
         "Your mail is no longer being watched until you start it again.", _
         64, "Automatic Inbox Machine"
Else
  MsgBox "Stop finished with exit code " & exitCode & "." & vbCrLf & vbCrLf & _
         "See logs\app.log for details.", 48, "Automatic Inbox Machine"
End If
