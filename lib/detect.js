/**
 * Backend discovery.
 *
 * Abaqus installations are found through the environment, the registry and the
 * usual SIMULIA directories; CalculiX through an explicit config path, PATH and
 * a handful of portable install locations. Nothing is probed at plugin load, so
 * activation stays cheap and a machine without any solver still works.
 */
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileExists, findOnPath, isWindows, runCommand } from './util.js';

const ABAQUS_ROOTS = [
  'C:\\SIMULIA',
  'D:\\SIMULIA',
  'E:\\SIMULIA',
  'F:\\SIMULIA',
  'C:\\Program Files\\SIMULIA',
  'D:\\Program Files\\SIMULIA',
  'C:\\Program Files\\Dassault Systemes',
  'D:\\Program Files\\Dassault Systemes',
];

const CCX_ROOTS = [
  'C:\\Program Files\\bConverged\\CalculiX',
  'C:\\Program Files (x86)\\bConverged\\CalculiX',
  'C:\\CalculiX',
  'D:\\CalculiX',
  'C:\\tools\\calculix',
  'D:\\tools\\calculix',
  'F:\\tools\\calculix',
  'E:\\tools\\calculix',
];

/** Recursively collect files whose base name matches a test, bounded in depth. */
function searchTree(root, test, maxDepth, out = [], depth = 0) {
  if (depth > maxDepth) return out;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) searchTree(full, test, maxDepth, out, depth + 1);
    else if (entry.isFile() && test(entry.name)) out.push(full);
  }
  return out;
}

const LAUNCHER = /^(abaqus|abq\d*|abq\w*)\.(bat|cmd|exe)$/i;

/** Launchers that are clearly not Abaqus entry points. */
const LAUNCHER_EXCLUDE = /^(abqapp|abqinit)/i;

async function registryCandidates() {
  if (!isWindows) return [];
  const keys = [
    'HKLM\\SOFTWARE\\SIMULIA',
    'HKLM\\SOFTWARE\\WOW6432Node\\SIMULIA',
    'HKLM\\SOFTWARE\\Dassault Systemes',
    'HKLM\\SOFTWARE\\WOW6432Node\\Dassault Systemes',
  ];
  const found = new Set();
  for (const key of keys) {
    const result = await runCommand('reg', ['query', key, '/s'], { timeoutMs: 20_000 });
    if (result.code !== 0) continue;
    for (const line of result.stdout.split(/\r?\n/)) {
      const match = /REG_(?:SZ|EXPAND_SZ)\s+(.+)$/.exec(line.trim());
      if (match === null) continue;
      const value = match[1].trim();
      if (value.length > 2 && (value.includes('\\') || value.includes('/'))) found.add(value);
    }
  }
  return [...found];
}

async function whereCandidates() {
  if (!isWindows) {
    const direct = findOnPath('abaqus');
    return direct === undefined ? [] : [direct];
  }
  const result = await runCommand('where', ['abaqus.bat', 'abaqus.cmd', 'abaqus'], { timeoutMs: 20_000 });
  if (result.code !== 0) return [];
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
}

/** Guess the Abaqus release from a launcher path such as abq2023.bat. */
function abaqusVersionOf(command) {
  const base = path.basename(command).toLowerCase();
  const direct = /abq(\d{4})/.exec(base);
  if (direct !== null) return direct[1];
  const fromPath = /[\\/](?:abaqus|simulia)[\\/](\d{4})[\\/]/i.exec(command);
  if (fromPath !== null) return fromPath[1];
  const alt = /[\\/](\d{4})[\\/]commands[\\/]/i.exec(command);
  return alt === null ? undefined : alt[1];
}

/** All plausible Abaqus launchers, best first. */
export async function detectAbaqus(config = {}) {
  const sources = [];
  const candidates = [];
  const push = (command, source) => {
    if (typeof command !== 'string' || command.trim() === '') return;
    const trimmed = command.trim().replace(/^"|"$/g, '');
    if (candidates.some((entry) => entry.command.toLowerCase() === trimmed.toLowerCase())) return;
    if (!fileExists(trimmed)) return;
    candidates.push({ command: trimmed, source, version: abaqusVersionOf(trimmed) });
  };

  push(config.abaqusCommand, 'config');
  push(process.env.ABAQUS_COMMAND, 'ABAQUS_COMMAND');
  if (typeof process.env.ABAQUS_HOME === 'string' && process.env.ABAQUS_HOME !== '') {
    const home = process.env.ABAQUS_HOME;
    for (const name of ['Commands', 'commands']) {
      for (const launcher of ['abaqus.bat', 'abq.bat', 'abaqus.cmd']) {
        push(path.join(home, name, launcher), 'ABAQUS_HOME');
      }
    }
  }
  for (const candidate of await whereCandidates()) push(candidate, 'PATH');
  for (const candidate of await registryCandidates()) {
    if (LAUNCHER.test(path.basename(candidate))) push(candidate, 'registry');
  }
  for (const root of ABAQUS_ROOTS) {
    if (!existsSync(root)) continue;
    for (const file of searchTree(root, (name) => LAUNCHER.test(name) && !LAUNCHER_EXCLUDE.test(name), 5)) {
      push(file, 'filesystem');
    }
  }
  if (isWindows) {
    for (const drive of ['C:', 'D:', 'E:', 'F:']) {
      const root = path.join(drive, '\\');
      if (!existsSync(root)) continue;
      let top;
      try {
        top = readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of top) {
        if (!entry.isDirectory() || !/^(simulia|abaqus)/i.test(entry.name)) continue;
        for (const file of searchTree(path.join(root, entry.name), (name) => LAUNCHER.test(name) && !LAUNCHER_EXCLUDE.test(name), 5)) {
          push(file, 'filesystem');
        }
      }
    }
  }
  void sources;
  const best = candidates.find((entry) => /abq\d+|abaqus/i.test(path.basename(entry.command))) ?? candidates[0];
  return {
    found: candidates.length > 0,
    command: best?.command,
    version: best?.version,
    candidates,
  };
}

/** Locate a CalculiX solver. */
export async function detectCalculix(config = {}) {
  const candidates = [];
  const push = (file, source) => {
    if (typeof file !== 'string' || file.trim() === '') return;
    const trimmed = file.trim().replace(/^"|"$/g, '');
    if (!fileExists(trimmed)) return;
    if (candidates.some((entry) => entry.path.toLowerCase() === trimmed.toLowerCase())) return;
    candidates.push({ path: trimmed, source });
  };

  push(config.ccxPath, 'config');
  push(process.env.CCX_PATH, 'CCX_PATH');
  push(findOnPath('ccx'), 'PATH');
  for (const root of CCX_ROOTS) {
    if (!existsSync(root)) continue;
    for (const file of searchTree(root, (name) => /^ccx(_MT)?\.exe$/i.test(name) || /^ccx$/i.test(name), 4)) push(file, 'filesystem');
  }
  if (isWindows) {
    const roots = [];
    for (const drive of ['C:', 'D:', 'E:', 'F:', 'G:']) {
      const driveRoot = `${drive}\\`;
      if (!existsSync(driveRoot)) continue;
      for (const base of ['tools', 'Tools', 'Program Files', 'Program Files (x86)', '']) {
        roots.push(base === '' ? path.join(driveRoot, 'calculix') : path.join(driveRoot, base, 'calculix'));
      }
      // One level deeper, which covers a portable checkout such as F:\work\tools\calculix.
      let children;
      try {
        children = readdirSync(driveRoot, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of children) {
        if (!child.isDirectory()) continue;
        for (const base of ['tools', 'Tools', '']) {
          roots.push(base === '' ? path.join(driveRoot, child.name, 'calculix') : path.join(driveRoot, child.name, base, 'calculix'));
        }
      }
    }
    for (const root of roots) {
      if (!existsSync(root)) continue;
      for (const file of searchTree(root, (name) => /^ccx(_MT)?\.exe$/i.test(name), 4)) push(file, 'filesystem');
    }
  }

  const best = candidates.find((entry) => /_MT\.exe$/i.test(entry.path)) ?? candidates[0];
  if (best === undefined) return { found: false, candidates };

  const probe = await runCommand(best.path, ['-v'], { timeoutMs: 20_000 });
  const versionMatch = /Version\s+([\d.]+)/i.exec(`${probe.stdout}${probe.stderr}`);
  return {
    found: true,
    path: best.path,
    source: best.source,
    version: versionMatch === null ? undefined : versionMatch[1],
    candidates,
  };
}

/** Any python interpreter that can syntax-check a generated script. */
export async function detectPython(config = {}) {
  const candidates = [config.pythonPath, findOnPath('python'), findOnPath('python3')];
  if (isWindows) {
    for (const guess of ['D:\\Python39\\python.exe', 'C:\\Python39\\python.exe', path.join(os.homedir(), 'AppData\\Local\\Programs\\Python\\Python312\\python.exe')]) {
      candidates.push(guess);
    }
  }
  const found = candidates.find((candidate) => typeof candidate === 'string' && fileExists(candidate));
  if (found === undefined) return { found: false };
  const probe = await runCommand(found, ['--version'], { timeoutMs: 20_000 });
  return { found: true, command: found, version: `${probe.stdout}${probe.stderr}`.trim() };
}

/** Detect every backend in one pass. */
export async function detectEnvironment(config = {}) {
  const [abaqus, calculix, python] = await Promise.all([
    detectAbaqus(config),
    detectCalculix(config),
    detectPython(config),
  ]);
  return { platform: process.platform, abaqus, calculix, python };
}
