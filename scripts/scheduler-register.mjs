#!/usr/bin/env node
/**
 * Registers the agent with the platform scheduler so it survives a reboot.
 *
 * Windows: Task Scheduler, three tasks at logon (watcher, bot, watchdog).
 * macOS:   launchd user agents.
 * Linux:   systemd --user units.
 *
 * The task names are the branding sentinel — anything named `aim-*` belongs to
 * this app and can be safely removed by the uninstaller.
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CMD_EXE, IS_WINDOWS, ROOT, SCHTASKS } from './os-paths.mjs';
import { log } from './log.mjs';

export const TASK_NAMES = { watcher: 'aim-watcher', bot: 'aim-bot', watchdog: 'aim-watchdog' };

const NODE = process.execPath;

function windowsCommand(script) {
  // Wrapped in cmd /c so Task Scheduler starts it in the repo directory and the
  // window stays hidden. Absolute paths throughout: some installs are missing
  // System32 from PATH entirely.
  return `"${CMD_EXE}" /c ""${NODE}" "${join(ROOT, 'scripts', script)}""`;
}

function registerWindows() {
  const results = [];
  const tasks = [
    { name: TASK_NAMES.watcher, script: 'watcher.mjs', schedule: ['/sc', 'onlogon'] },
    { name: TASK_NAMES.bot, script: 'telegram-bot.mjs', schedule: ['/sc', 'onlogon'] },
    { name: TASK_NAMES.watchdog, script: 'watchdog.mjs', schedule: ['/sc', 'minute', '/mo', '5'] }
  ];

  for (const task of tasks) {
    const result = spawnSync(
      SCHTASKS,
      ['/create', '/f', '/tn', task.name, '/tr', windowsCommand(task.script), ...task.schedule, '/rl', 'limited'],
      { encoding: 'utf8', windowsHide: true }
    );
    const ok = result.status === 0;
    results.push({ name: task.name, ok, error: ok ? '' : (result.stderr || result.stdout || '').trim().slice(0, 200) });
    log(`scheduler: ${task.name} ${ok ? 'registered' : 'FAILED'}`, { name: 'scheduler' });
  }
  return results;
}

function registerLaunchd() {
  const dir = join(homedir(), 'Library', 'LaunchAgents');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const results = [];

  const units = [
    { label: 'app.aim.watcher', script: 'watcher.mjs', keepAlive: true, interval: 0 },
    { label: 'app.aim.bot', script: 'telegram-bot.mjs', keepAlive: true, interval: 0 },
    { label: 'app.aim.watchdog', script: 'watchdog.mjs', keepAlive: false, interval: 300 }
  ];

  for (const unit of units) {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${unit.label}</string>
  <key>ProgramArguments</key><array>
    <string>${NODE}</string><string>${join(ROOT, 'scripts', unit.script)}</string>
  </array>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>RunAtLoad</key><true/>
  ${unit.keepAlive ? '<key>KeepAlive</key><true/>' : ''}
  ${unit.interval ? `<key>StartInterval</key><integer>${unit.interval}</integer>` : ''}
  <key>StandardErrorPath</key><string>${join(ROOT, 'logs', `${unit.label}.err.log`)}</string>
</dict></plist>
`;
    const path = join(dir, `${unit.label}.plist`);
    writeFileSync(path, plist, 'utf8');
    const result = spawnSync('launchctl', ['load', '-w', path], { encoding: 'utf8' });
    results.push({ name: unit.label, ok: result.status === 0, error: (result.stderr || '').trim().slice(0, 200) });
  }
  return results;
}

function registerSystemd() {
  const dir = join(homedir(), '.config', 'systemd', 'user');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const results = [];

  const services = [
    { name: 'aim-watcher', script: 'watcher.mjs', timer: 0 },
    { name: 'aim-bot', script: 'telegram-bot.mjs', timer: 0 },
    { name: 'aim-watchdog', script: 'watchdog.mjs', timer: 300 }
  ];

  for (const service of services) {
    writeFileSync(
      join(dir, `${service.name}.service`),
      `[Unit]
Description=Automatic Inbox Machine (${service.name})

[Service]
Type=simple
WorkingDirectory=${ROOT}
ExecStart=${NODE} ${join(ROOT, 'scripts', service.script)}
Restart=${service.timer ? 'no' : 'always'}
RestartSec=15

[Install]
WantedBy=default.target
`,
      'utf8'
    );

    if (service.timer) {
      writeFileSync(
        join(dir, `${service.name}.timer`),
        `[Unit]
Description=Automatic Inbox Machine watchdog timer

[Timer]
OnBootSec=2min
OnUnitActiveSec=${service.timer}s

[Install]
WantedBy=timers.target
`,
        'utf8'
      );
    }
  }

  spawnSync('systemctl', ['--user', 'daemon-reload'], { encoding: 'utf8' });
  for (const service of services) {
    const unit = service.timer ? `${service.name}.timer` : `${service.name}.service`;
    const result = spawnSync('systemctl', ['--user', 'enable', '--now', unit], { encoding: 'utf8' });
    results.push({ name: unit, ok: result.status === 0, error: (result.stderr || '').trim().slice(0, 200) });
  }
  return results;
}

export function register() {
  if (IS_WINDOWS) return registerWindows();
  if (process.platform === 'darwin') return registerLaunchd();
  return registerSystemd();
}

export function unregister() {
  if (IS_WINDOWS) {
    return Object.values(TASK_NAMES).map((name) => {
      const result = spawnSync(SCHTASKS, ['/delete', '/f', '/tn', name], { encoding: 'utf8', windowsHide: true });
      return { name, ok: result.status === 0 };
    });
  }
  if (process.platform === 'darwin') {
    return ['app.aim.watcher', 'app.aim.bot', 'app.aim.watchdog'].map((label) => {
      const result = spawnSync('launchctl', ['unload', '-w', join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`)], { encoding: 'utf8' });
      return { name: label, ok: result.status === 0 };
    });
  }
  return ['aim-watcher.service', 'aim-bot.service', 'aim-watchdog.timer'].map((unit) => {
    const result = spawnSync('systemctl', ['--user', 'disable', '--now', unit], { encoding: 'utf8' });
    return { name: unit, ok: result.status === 0 };
  });
}

const invokedDirectly = process.argv[1] && /scheduler-register\.mjs$/.test(process.argv[1]);
if (invokedDirectly) {
  const remove = process.argv.includes('--remove');
  const results = remove ? unregister() : register();
  for (const result of results) {
    process.stdout.write(`${result.ok ? '  ok  ' : ' FAIL '} ${result.name}${result.error ? ` — ${result.error}` : ''}\n`);
  }
  const failed = results.filter((result) => !result.ok).length;
  process.stdout.write(
    failed
      ? `\n${failed} entr${failed === 1 ? 'y' : 'ies'} failed. On Windows try an elevated shell; on Linux check \`systemctl --user\` is available.\n`
      : `\n${remove ? 'Removed' : 'Registered'}. The agent will start automatically from now on.\n`
  );
  process.exit(failed ? 1 : 0);
}
