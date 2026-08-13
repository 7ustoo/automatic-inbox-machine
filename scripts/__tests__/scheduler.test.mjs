import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windowsTaskCommand } from '../scheduler-register.mjs';

test('Windows scheduled tasks launch the GUI wrapper, never a terminal host', () => {
  const aimExe = 'C:\\Users\\Test User\\AppData\\Local\\automatic-inbox-machine\\wrapper\\dist\\AIM.exe';
  for (const role of ['watcher', 'bot', 'watchdog']) {
    const command = windowsTaskCommand(role, aimExe);
    assert.equal(command, `"${aimExe}" --background ${role}`);
    assert.doesNotMatch(command, /(?:powershell|pwsh|cmd\.exe|conhost)/i);
  }
});

test('unknown scheduled roles are rejected', () => {
  assert.throws(() => windowsTaskCommand('terminal'), /unknown scheduled role/);
});
