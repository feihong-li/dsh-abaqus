/**
 * Process and filesystem helpers for the Abaqus driver.
 *
 * Everything here is dependency-free on purpose: a Host-only DSH bundle must
 * load without installing anything, so only node builtins are used.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const isWindows = process.platform === 'win32';

/** Quote one argument for a `cmd.exe /c` command line. */
export function winQuote(value) {
  const text = String(value);
  if (text.length > 0 && !/[\s"^&|<>()%!]/.test(text)) return text;
  return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
}

/** Batch files cannot be spawned directly; they need the command interpreter. */
export function isBatchFile(file) {
  return isWindows && /\.(bat|cmd)$/i.test(file);
}

/** Resolve a bare command name through PATH, honouring PATHEXT on Windows. */
export function findOnPath(name, env = process.env) {
  const candidates = [name];
  if (isWindows && path.extname(name) === '') {
    const exts = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
    for (const ext of exts) candidates.push(name + ext.toLowerCase(), name + ext.toUpperCase());
  }
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const candidate of candidates) {
      const full = path.join(dir, candidate);
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch {
        /* keep looking */
      }
    }
  }
  return undefined;
}

/**
 * Run a command and capture its output.
 * @param {string} exe - executable or batch file.
 * @param {string[]} args - argv (ignored for batch files, which get a command line).
 * @param {{cwd?: string, env?: Record<string,string>, timeoutMs?: number, maxBytes?: number, signal?: AbortSignal}} [opts]
 * @returns {Promise<{code: number|null, stdout: string, stderr: string, timedOut: boolean, truncated: boolean, durationMs: number, commandLine: string}>}
 */
export function runCommand(exe, args = [], opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const maxBytes = opts.maxBytes ?? 512 * 1024;
  const batch = isBatchFile(exe);
  const file = batch ? (process.env.ComSpec ?? 'cmd.exe') : exe;
  const argv = batch ? ['/d', '/s', '/c', [exe, ...args].map(winQuote).join(' ')] : args;
  const commandLine = [exe, ...args].join(' ');
  const started = Date.now();

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(file, argv, {
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.env ?? {}) },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;

    const collect = (target, chunk) => {
      const text = chunk.toString('utf8');
      if ((target === 'out' ? stdout : stderr).length + text.length > maxBytes) {
        truncated = true;
        return target === 'out' ? stdout : stderr;
      }
      return target === 'out' ? (stdout += text) : (stderr += text);
    };

    child.stdout.on('data', (chunk) => { collect('out', chunk); });
    child.stderr.on('data', (chunk) => { collect('err', chunk); });

    const killTree = () => {
      timedOut = true;
      if (!isWindows || child.pid === undefined) {
        child.kill('SIGKILL');
        return;
      }
      try {
        spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      } catch {
        child.kill('SIGKILL');
      }
    };

    const timer = setTimeout(killTree, timeoutMs);
    const onAbort = () => killTree();
    if (opts.signal !== undefined) {
      if (opts.signal.aborted) killTree();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (error) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr, timedOut, truncated, durationMs: Date.now() - started, commandLine });
    });
  });
}

/** True when the path names an existing file. */
export function fileExists(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/** Read a text file, returning undefined when it is missing. */
export async function readTextIfPresent(target, limit = 256 * 1024) {
  try {
    const text = await fsp.readFile(target, 'utf8');
    return text.length > limit ? `${text.slice(0, limit)}\n... [truncated ${text.length - limit} chars]` : text;
  } catch {
    return undefined;
  }
}

/** Directory listing that yields [] instead of throwing. */
export async function listDir(target) {
  try {
    return await fsp.readdir(target, { withFileTypes: true });
  } catch {
    return [];
  }
}

export async function ensureDir(target) {
  await fsp.mkdir(target, { recursive: true });
  return target;
}

/** A short, stable, filesystem-safe slug. */
export function slugify(value, fallback = 'model') {
  const text = String(value ?? '').trim().replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return text.length > 0 ? text.slice(0, 64) : fallback;
}

/** Trailing lines of a long log, with a marker when content was dropped. */
export function tail(text, lines = 40) {
  const all = String(text).replace(/\r\n/g, '\n').split('\n');
  if (all.length <= lines) return all.join('\n');
  return `... [${all.length - lines} earlier lines omitted]\n${all.slice(-lines).join('\n')}`;
}

/** Format a metric number without exponent noise. */
export function num(value, digits = 6) {
  if (!Number.isFinite(value)) return String(value);
  const rounded = Number(value.toPrecision(digits));
  return String(rounded);
}

/** Join lines with the platform newline, guaranteeing one trailing newline. */
export function textFile(lines) {
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

export { fs, fsp, path };
