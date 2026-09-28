/**
 * DSH Host plugin: drive Abaqus CAE modelling and solving from a declarative
 * model spec, with an open-source CalculiX backend for offline verification.
 *
 * Pipeline: spec -> (Abaqus/CAE python script | built-in structured mesher)
 *           -> .inp deck -> solver -> .frd/.odb -> extracted extremes.
 *
 * The plugin is dependency-free: it registers plain tool definitions on
 * `ctx.tools` and shells out to the solver executables.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { EXAMPLE_SPEC, SPEC_REFERENCE, parseSpec } from './lib/spec.js';
import { buildMesh } from './lib/mesh.js';
import { buildCalculixDeck } from './lib/inp.js';
import { buildCaeScript, caeJobName } from './lib/cae.js';
import { detectEnvironment } from './lib/detect.js';
import { buildOdbExtractScript, formatOdbSummary, formatSummary, parseFrd, summarizeFrd } from './lib/results.js';
import { ensureDir, fileExists, listDir, num, readTextIfPresent, runCommand, slugify, tail } from './lib/util.js';

/** Stable Loader identity. */
export const name = 'dsh-abaqus';

/** Services used by the modelling tools. */
export const inject = ['tools'];

const OK_SENTINEL = 'DSH_ABAQUS_OK';
const FAIL_SENTINEL = 'DSH_ABAQUS_FAILED';

const block = (text) => [{ type: 'text', text }];

/** Tool results must be plain JSON: this strips undefined and any stray methods. */
const json = (value) => JSON.parse(JSON.stringify(value));

const asText = (value) => (typeof value === 'string' ? value : String(value ?? ''));

/** Error lines the two solvers write into their message/status files. */
const ERROR_PATTERN = /\*\*\*ERROR|\*\*ERROR\b|^\s*ERROR\b|\bERROR in\b|error:|Segmentation fault|not converged/i;
const WARNING_PATTERN = /\*\*\*WARNING|\*\*WARNING\b|^\s*WARNING\b/i;

export function apply(ctx, config = {}) {
  const settings = {
    abaqusCommand: typeof config.abaqusCommand === 'string' && config.abaqusCommand.trim() !== '' ? config.abaqusCommand.trim() : undefined,
    ccxPath: typeof config.ccxPath === 'string' && config.ccxPath.trim() !== '' ? config.ccxPath.trim() : undefined,
    pythonPath: typeof config.pythonPath === 'string' && config.pythonPath.trim() !== '' ? config.pythonPath.trim() : undefined,
    defaultCaseDir: typeof config.defaultCaseDir === 'string' && config.defaultCaseDir.trim() !== '' ? config.defaultCaseDir.trim() : undefined,
    timeoutSec: Number.isFinite(Number(config.timeoutSec)) ? Number(config.timeoutSec) : 900,
  };

  const sessionCwd = (exec) => exec.agent?.session?.header?.cwd ?? process.cwd();

  const caseDirFor = (requested, exec, modelName) => {
    if (typeof requested === 'string' && requested.trim() !== '') {
      return path.resolve(sessionCwd(exec), requested.trim());
    }
    const root = settings.defaultCaseDir ?? path.join(sessionCwd(exec), 'abaqus-cases');
    return path.resolve(root, slugify(modelName));
  };

  /** Resolve both backends once per call: cheap enough and always current. */
  const environment = () => detectEnvironment(settings);

  const pickBackend = (requested, env) => {
    if (requested === 'abaqus' || requested === 'calculix') return requested;
    if (env.abaqus.found) return 'abaqus';
    if (env.calculix.found) return 'calculix';
    return undefined;
  };

  const requireBackend = (requested, env) => {
    const backend = pickBackend(requested, env);
    if (backend === undefined) {
      throw new Error(
        'no solver backend is available: no Abaqus launcher was found and no ccx executable was found. '
        + 'Install one, or set the `abaqusCommand` / `ccxPath` config fields.',
      );
    }
    if (backend === 'abaqus' && !env.abaqus.found) throw new Error('the abaqus backend was requested but no Abaqus launcher was found');
    if (backend === 'calculix' && !env.calculix.found) throw new Error('the calculix backend was requested but no ccx executable was found');
    return backend;
  };

  const readIfPresent = async (target) => {
    try {
      return await fsp.readFile(target, 'utf8');
    } catch {
      return undefined;
    }
  };

  const artifactsIn = async (dir) => {
    const entries = await listDir(dir);
    const rows = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const stats = await fsp.stat(path.join(dir, entry.name));
      rows.push({ name: entry.name, bytes: stats.size, modified: stats.mtime.toISOString() });
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  };

  /** Persist everything needed to reopen a case later without the caller's spec. */
  const writeCase = async (dir, record) => {
    await fsp.writeFile(path.join(dir, `${record.name}.case.json`), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  };

  const readCase = async (dir, modelName) => {
    const candidates = modelName === undefined
      ? (await listDir(dir)).filter((entry) => entry.isFile() && entry.name.endsWith('.case.json')).map((entry) => entry.name)
      : [`${modelName}.case.json`];
    for (const candidate of candidates) {
      const text = await readIfPresent(path.join(dir, candidate));
      if (text === undefined) continue;
      try {
        return JSON.parse(text);
      } catch {
        return undefined;
      }
    }
    return undefined;
  };

  const writeRunRecord = async (dir, record) => {
    await fsp.writeFile(path.join(dir, `${record.name}.run.json`), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  };

  // ---------------------------------------------------------------- abaqus_env
  ctx.tools.register({
    name: 'abaqus_env',
    description:
      'Report which simulation backends this machine has: the Abaqus launcher (abaqus cae / abaqus job), a CalculiX (ccx) solver, and a python interpreter. '
      + 'Call it before the first modelling call, or when a run reports a missing solver.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        refresh: { type: 'boolean', description: 'Re-probe the filesystem, PATH and registry instead of using cached discovery results.' },
      },
    },
    output: { schema: { type: 'object' }, render: (_args, value) => block(value.summary) },
    async execute() {
      const env = await environment();
      const lines = [
        `platform: ${env.platform}`,
        env.abaqus.found
          ? `abaqus: ${env.abaqus.command}${env.abaqus.version === undefined ? '' : ` (release ${env.abaqus.version})`} [via ${env.abaqus.candidates[0]?.source ?? 'unknown'}]`
          : 'abaqus: not found (no launcher on PATH, in the registry, or under the usual SIMULIA directories)',
        env.calculix.found
          ? `calculix: ${env.calculix.path}${env.calculix.version === undefined ? '' : ` (version ${env.calculix.version})`} [via ${env.calculix.source}]`
          : 'calculix: not found (set the `ccxPath` config field to a ccx executable)',
        env.python.found ? `python: ${env.python.command} (${env.python.version})` : 'python: not found (only used for syntax checks)',
      ];
      if (env.abaqus.candidates.length > 1) {
        lines.push(`other abaqus candidates: ${env.abaqus.candidates.slice(1, 6).map((entry) => entry.command).join(', ')}`);
      }
      if (env.calculix.candidates.length > 1) {
        lines.push(`other ccx candidates: ${env.calculix.candidates.slice(1, 6).map((entry) => entry.path).join(', ')}`);
      }
      return json({
        summary: lines.join('\n'),
        environment: {
          platform: env.platform,
          abaqus: { found: env.abaqus.found, command: env.abaqus.command, version: env.abaqus.version, candidateCount: env.abaqus.candidates.length },
          calculix: { found: env.calculix.found, path: env.calculix.path, version: env.calculix.version },
          python: env.python,
          config: { abaqusCommand: settings.abaqusCommand, ccxPath: settings.ccxPath, defaultCaseDir: settings.defaultCaseDir, timeoutSec: settings.timeoutSec },
        },
      });
    },
  });

  // --------------------------------------------------------------- abaqus_spec
  ctx.tools.register({
    name: 'abaqus_spec',
    description:
      'Return the complete reference for the declarative model spec used by abaqus_build, plus a worked example. '
      + 'Call it before writing a spec by hand.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        exampleOnly: { type: 'boolean', description: 'Return only the example spec.' },
      },
    },
    output: { schema: { type: 'object' }, render: (_args, value) => block(value.summary) },
    async execute(args) {
      if (args.exampleOnly === true) {
        return { summary: JSON.stringify(EXAMPLE_SPEC, null, 2), example: EXAMPLE_SPEC };
      }
      return {
        summary: `${SPEC_REFERENCE}\n\n## Example spec\n\n\`\`\`json\n${JSON.stringify(EXAMPLE_SPEC, null, 2)}\n\`\`\``,
        reference: SPEC_REFERENCE,
        example: EXAMPLE_SPEC,
      };
    },
  });

  // -------------------------------------------------------------- abaqus_build
  ctx.tools.register({
    name: 'abaqus_build',
    description:
      'Turn a declarative model spec into solver input files in a case directory. '
      + 'The calculix backend meshes the spec with the built-in structured mesher and writes <name>.inp; '
      + 'the abaqus backend writes build_<name>.py, a CAE script that builds the real geometry, meshes it and writes the same deck '
      + '(set runCae to execute it immediately). '
      + 'Files are written into <caseDir>; call abaqus_run next to solve.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['spec'],
      properties: {
        spec: { type: 'object', description: 'The model spec. Call abaqus_spec for the full reference.' },
        backend: { type: 'string', enum: ['abaqus', 'calculix', 'both'], description: 'Which backend to generate for. Defaults to both when Abaqus is available, otherwise calculix.' },
        caseDir: { type: 'string', description: 'Case directory. Relative paths resolve against the session working directory; defaults to abaqus-cases/<spec name>.' },
        runCae: { type: 'boolean', description: 'Also execute the generated CAE script now (abaqus cae noGUI=...), which writes <name>.inp. Requires Abaqus.' },
      },
    },
    output: { schema: { type: 'object' }, render: (_args, value) => block(value.summary) },
    timeoutMs: 3_600_000,
    async execute(args, exec) {
      const { spec, errors, warnings } = parseSpec(args.spec);
      if (spec === undefined) throw new Error(`the model spec is invalid:\n- ${errors.join('\n- ')}`);

      const env = await environment();
      const wanted = args.backend ?? (env.abaqus.found ? 'both' : 'calculix');
      const jobName = caeJobName(spec.name);
      const dir = caseDirFor(args.caseDir, exec, spec.name);
      await ensureDir(dir);

      const notes = [...warnings];
      const files = [];
      let meshStats;

      if (wanted === 'calculix' || wanted === 'both') {
        if (!env.calculix.found) {
          notes.push('calculix deck skipped: no ccx executable found');
        } else {
          const mesh = buildMesh(spec);
          meshStats = mesh.stats;
          const deck = buildCalculixDeck(spec, mesh);
          if (deck.errors.length > 0) throw new Error(`the model could not be turned into a deck:\n- ${deck.errors.join('\n- ')}`);
          notes.push(...deck.notes);
          const deckPath = path.join(dir, `${spec.name}.inp`);
          await fsp.writeFile(deckPath, deck.inp, 'utf8');
          files.push({ file: deckPath, kind: 'calculix deck', lines: deck.inp.split('\n').length });
        }
      }

      if (wanted === 'abaqus' || wanted === 'both') {
        const { script, notes: caeNotes } = buildCaeScript(spec, { jobName });
        notes.push(...caeNotes);
        const scriptPath = path.join(dir, `build_${spec.name}.py`);
        await fsp.writeFile(scriptPath, script, 'utf8');
        files.push({ file: scriptPath, kind: 'abaqus CAE script', lines: script.split('\n').length });

        if (args.runCae === true) {
          if (!env.abaqus.found) throw new Error('runCae was requested but no Abaqus launcher was found');
          const run = await runCommand(env.abaqus.command, ['cae', `noGUI=build_${spec.name}.py`], {
            cwd: dir,
            timeoutMs: settings.timeoutSec * 1000,
            signal: exec.signal,
          });
          await fsp.writeFile(path.join(dir, `${spec.name}.cae.log`), `${run.stdout}\n${run.stderr}`, 'utf8');
          notes.push(`abaqus cae exited with ${run.code} after ${run.durationMs} ms`);
          if (!run.stdout.includes(OK_SENTINEL)) {
            notes.push(`the CAE script did not report ${OK_SENTINEL}; see ${path.join(dir, `${spec.name}.cae.log`)}`);
          } else if (fileExists(path.join(dir, `${spec.name}.inp`))) {
            files.push({ file: path.join(dir, `${spec.name}.inp`), kind: 'abaqus deck (written by CAE)' });
          }
        }
      }

      await writeCase(dir, {
        name: spec.name,
        jobName,
        spec,
        meshStats,
        generated: files.map((entry) => entry.file),
        createdAt: new Date().toISOString(),
      });

      const summary = [
        `model "${spec.name}" -> ${dir}`,
        `backend: ${wanted}${wanted === 'both' ? ` (deck: calculix, CAE script: abaqus)` : ''}`,
        meshStats === undefined ? '' : `mesh: ${meshStats.elementCount} elements / ${meshStats.nodeCount} nodes (${Object.entries(meshStats.byType).map(([type, count]) => `${type} ${count}`).join(', ')})`,
        ...files.map((entry) => `wrote ${path.basename(entry.file)} (${entry.kind}, ${entry.lines ?? '?'} lines)`),
        notes.length > 0 ? `notes:\n- ${notes.join('\n- ')}` : '',
      ].filter((line) => line !== '').join('\n');

      return json({ summary, caseDir: dir, jobName, backend: wanted, files, mesh: meshStats, notes });
    },
  });

  // ---------------------------------------------------------------- abaqus_run
  ctx.tools.register({
    name: 'abaqus_run',
    description:
      'Run a solver step in a case directory. action "solve" submits <name>.inp to the chosen backend '
      + '(ccx -i <name>, or abaqus job=<name> interactive); "build" runs the generated CAE script; '
      + '"script" runs a python file with the Abaqus interpreter (e.g. an odbAccess extraction); '
      + '"command" runs a raw command line. Output is captured, tailed and written to <name>.stdout.log.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['caseDir'],
      properties: {
        caseDir: { type: 'string', description: 'Case directory produced by abaqus_build.' },
        name: { type: 'string', description: 'Job/model name. Defaults to the one recorded by abaqus_build.' },
        backend: { type: 'string', enum: ['abaqus', 'calculix'], description: 'Solver backend. Defaults to the recorded backend, else Abaqus when available.' },
        action: { type: 'string', enum: ['solve', 'build', 'script', 'command'], description: 'What to run. Defaults to solve.' },
        script: { type: 'string', description: 'Python source for action "script"; written into the case directory and executed with `abaqus python`.' },
        scriptFile: { type: 'string', description: 'Existing python file for action "script" (relative to the case directory).' },
        command: { type: 'string', description: 'Raw command line for action "command".' },
        cpus: { type: 'integer', description: 'Solver process count (abaqus cpus=, CalculiX OMP threads).' },
        timeoutSec: { type: 'integer', description: 'Kill the process after this many seconds.' },
      },
    },
    output: { schema: { type: 'object' }, render: (_args, value) => block(value.summary) },
    timeoutMs: 7_200_000,
    async execute(args, exec) {
      const dir = caseDirFor(args.caseDir, exec, 'case');
      const record = await readCase(dir, args.name);
      const jobName = args.name ?? record?.name ?? path.basename(dir);
      const action = args.action ?? 'solve';
      const env = await environment();
      const backend = pickBackend(args.backend ?? record?.backend, env) ?? requireBackend(undefined, env);
      const timeoutMs = (Number.isFinite(Number(args.timeoutSec)) ? Number(args.timeoutSec) : settings.timeoutSec) * 1000;
      const cpus = Number.isFinite(Number(args.cpus)) ? Math.max(1, Math.trunc(Number(args.cpus))) : undefined;

      let exe;
      let argv;
      let display;
      if (action === 'command') {
        if (typeof args.command !== 'string' || args.command.trim() === '') throw new Error('action "command" needs a command');
        exe = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh';
        argv = process.platform === 'win32' ? ['/d', '/s', '/c', args.command] : ['-c', args.command];
        display = args.command;
      } else if (action === 'build') {
        if (!env.abaqus.found) throw new Error('action "build" needs the abaqus backend, but no Abaqus launcher was found');
        exe = env.abaqus.command;
        argv = ['cae', `noGUI=build_${jobName}.py`];
        display = `abaqus cae noGUI=build_${jobName}.py`;
      } else if (action === 'script') {
        let scriptPath;
        if (typeof args.script === 'string' && args.script.trim() !== '') {
          scriptPath = path.join(dir, `${jobName}_script.py`);
          await fsp.writeFile(scriptPath, args.script, 'utf8');
        } else if (typeof args.scriptFile === 'string' && args.scriptFile.trim() !== '') {
          scriptPath = path.resolve(dir, args.scriptFile.trim());
        } else {
          throw new Error('action "script" needs either `script` or `scriptFile`');
        }
        if (!fileExists(scriptPath)) throw new Error(`script file not found: ${scriptPath}`);
        if (!env.abaqus.found) throw new Error('action "script" needs the abaqus python interpreter, but no Abaqus launcher was found');
        exe = env.abaqus.command;
        argv = ['python', path.basename(scriptPath)];
        display = `abaqus python ${path.basename(scriptPath)}`;
      } else if (backend === 'calculix') {
        const deck = path.join(dir, `${jobName}.inp`);
        if (!fileExists(deck)) throw new Error(`no deck at ${deck}; run abaqus_build first`);
        exe = env.calculix.path;
        argv = ['-i', jobName];
        display = `ccx -i ${jobName}`;
      } else {
        const deck = path.join(dir, `${jobName}.inp`);
        if (!fileExists(deck)) throw new Error(`no deck at ${deck}; run abaqus_build (with runCae) first`);
        exe = env.abaqus.command;
        argv = [`job=${jobName}`, 'interactive', 'ask_delete=OFF', ...(cpus === undefined ? [] : [`cpus=${cpus}`])];
        display = `abaqus job=${jobName} interactive`;
      }

      const started = Date.now();
      const run = await runCommand(exe, argv, {
        cwd: dir,
        timeoutMs,
        signal: exec.signal,
        env: cpus === undefined ? undefined : { OMP_NUM_THREADS: String(cpus), NUMBER_OF_CPUS: String(cpus) },
      });
      const logName = `${jobName}.stdout.log`;
      await fsp.writeFile(path.join(dir, logName), `${run.stdout}\n--- stderr ---\n${run.stderr}`, 'utf8');
      await writeRunRecord(dir, {
        name: jobName,
        backend,
        action,
        commandLine: run.commandLine,
        exitCode: run.code,
        timedOut: run.timedOut,
        durationMs: run.durationMs,
        startedAt: new Date(started).toISOString(),
        log: logName,
      });

      const artifacts = await artifactsIn(dir);
      const problems = `${run.stdout}\n${run.stderr}`.split(/\r?\n/).filter((line) => ERROR_PATTERN.test(line)).slice(0, 8);
      const summary = [
        `${display} -> exit ${run.code}${run.timedOut ? ' (TIMED OUT and was killed)' : ''} in ${(run.durationMs / 1000).toFixed(1)} s`,
        `case: ${dir}`,
        problems.length > 0 ? `problems reported:\n- ${problems.join('\n- ')}` : 'no error lines in the captured output',
        `artifacts: ${artifacts.map((entry) => entry.name).join(', ')}`,
        '--- output tail ---',
        tail(`${run.stdout}${run.stderr === '' ? '' : `\n[stderr]\n${run.stderr}`}`, 25),
      ].join('\n');

      return json({
        summary,
        caseDir: dir,
        jobName,
        backend,
        action,
        exitCode: run.code,
        timedOut: run.timedOut,
        durationMs: run.durationMs,
        commandLine: run.commandLine,
        problems,
        logFile: path.join(dir, logName),
        artifacts,
      });
    },
  });

  // ------------------------------------------------------------- abaqus_status
  ctx.tools.register({
    name: 'abaqus_status',
    description:
      'Report the state of a case: the last run recorded by abaqus_run, solver error/warning lines from .msg/.dat/.log, '
      + 'the increment table from .sta and the artifact list. Use it to check a job before extracting results.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['caseDir'],
      properties: {
        caseDir: { type: 'string', description: 'Case directory.' },
        name: { type: 'string', description: 'Job/model name. Defaults to the one recorded by abaqus_build.' },
        maxLines: { type: 'integer', description: 'How many matching message lines to return per category (default 10).' },
      },
    },
    output: { schema: { type: 'object' }, render: (_args, value) => block(value.summary) },
    async execute(args, exec) {
      const dir = caseDirFor(args.caseDir, exec, 'case');
      const record = await readCase(dir, args.name);
      const jobName = args.name ?? record?.name ?? path.basename(dir);
      const limit = Number.isFinite(Number(args.maxLines)) ? Math.max(1, Math.trunc(Number(args.maxLines))) : 10;

      const runText = await readTextIfPresent(path.join(dir, `${jobName}.run.json`), 64 * 1024);
      let run;
      if (runText !== undefined) {
        try {
          run = JSON.parse(runText);
        } catch {
          run = undefined;
        }
      }
      const messageFiles = ['msg', 'dat', 'log', 'sta', 'cae.log'].map((extension) => `${jobName}.${extension}`);
      const errors = [];
      const warnings = [];
      let increments = [];
      let source;

      for (const file of messageFiles) {
        const text = await readTextIfPresent(path.join(dir, file), 1024 * 1024);
        if (text === undefined) continue;
        source ??= file;
        for (const line of text.split(/\r?\n/)) {
          if (ERROR_PATTERN.test(line)) errors.push(`${file}: ${line.trim()}`);
          else if (WARNING_PATTERN.test(line)) warnings.push(`${file}: ${line.trim()}`);
        }
        if (file.endsWith('.sta')) {
          increments = text.split(/\r?\n/)
            .filter((line) => /^\s*\d+\s+\d+\s+\d+/.test(line))
            .slice(-limit)
            .map((line) => line.trim());
        }
      }

      const frd = (await listDir(dir)).some((entry) => entry.name === `${jobName}.frd`);
      const odb = (await listDir(dir)).some((entry) => entry.name === `${jobName}.odb`);
      let state = 'unknown';
      if (run === undefined) state = 'never-run';
      else if (run.timedOut) state = 'timed-out';
      else if (errors.length > 0) state = 'failed';
      else if (run.exitCode !== 0) state = 'failed';
      else if (frd || odb) state = 'completed';
      else state = 'finished-without-results';

      const artifacts = await artifactsIn(dir);
      const summary = [
        `case ${dir} (job "${jobName}")`,
        `state: ${state}`,
        run === undefined
          ? 'no run record found; call abaqus_run first'
          : `last run: ${run.commandLine} -> exit ${run.exitCode}${run.timedOut ? ' (killed on timeout)' : ''} in ${(run.durationMs / 1000).toFixed(1)} s at ${run.startedAt}`,
        frd ? 'results: .frd present (CalculiX)' : odb ? 'results: .odb present (Abaqus)' : 'results: none yet',
        increments.length > 0 ? `increments (.sta):\n${increments.join('\n')}` : '',
        errors.length > 0 ? `errors (${errors.length}):\n- ${errors.slice(0, limit).join('\n- ')}` : 'errors: none found',
        warnings.length > 0 ? `warnings (${warnings.length}, first ${limit}):\n- ${warnings.slice(0, limit).join('\n- ')}` : '',
        `artifacts: ${artifacts.map((entry) => `${entry.name} (${entry.bytes}B)`).join(', ')}`,
      ].filter((line) => line !== '').join('\n');

      return json({ summary, caseDir: dir, jobName, state, run, errors, warnings, increments, artifacts, scannedFrom: source });
    },
  });

  // ------------------------------------------------------------ abaqus_results
  ctx.tools.register({
    name: 'abaqus_results',
    description:
      'Extract result extremes from a finished case: max/min displacement and max von Mises stress, plus the values on a chosen node set. '
      + 'The calculix backend reads <name>.frd directly; the abaqus backend runs an odbAccess script through `abaqus python`. '
      + 'Use `set` with a mesher set name (e.g. beam_xmax — the same names appear as *NSET in the deck) or `nodeIds` to select specific nodes. '
      + 'Also reports the Zienkiewicz-Zhu stress error estimate that the solver always writes: a mean above ~10% means the mesh is too coarse there.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['caseDir'],
      properties: {
        caseDir: { type: 'string', description: 'Case directory.' },
        name: { type: 'string', description: 'Job/model name. Defaults to the one recorded by abaqus_build.' },
        backend: { type: 'string', enum: ['abaqus', 'calculix'], description: 'Which result file to read. Defaults to whatever exists.' },
        set: { type: 'string', description: 'Node set name from the built-in mesher, e.g. beam_xmin or beam_xmax.' },
        nodeIds: { type: 'array', items: { type: 'integer' }, description: 'Explicit node ids to report.' },
        step: { type: 'integer', description: '1-based result frame to report (for a freq step: the mode number). Defaults to the last one.' },
        maxNodes: { type: 'integer', description: 'How many selected-node rows to list (default 20). Set writeCsv to get every row in a file.' },
        writeCsv: { type: 'boolean', description: 'Also write <name>_results.csv with every selected node value.' },
      },
    },
    output: { schema: { type: 'object' }, render: (_args, value) => block(value.summary) },
    timeoutMs: 1_800_000,
    async execute(args, exec) {
      const dir = caseDirFor(args.caseDir, exec, 'case');
      const record = await readCase(dir, args.name);
      const jobName = args.name ?? record?.name ?? path.basename(dir);
      const env = await environment();
      const maxNodes = Number.isFinite(Number(args.maxNodes)) ? Math.max(1, Math.trunc(Number(args.maxNodes))) : 20;

      const frdPath = path.join(dir, `${jobName}.frd`);
      const odbPath = path.join(dir, `${jobName}.odb`);
      const requested = args.backend;
      const useCalculix = requested === 'calculix' || (requested === undefined && fileExists(frdPath));
      const useAbaqus = requested === 'abaqus' || (requested === undefined && !useCalculix && fileExists(odbPath));

      if (!useCalculix && !useAbaqus) {
        throw new Error(`no result file in ${dir}: neither ${jobName}.frd nor ${jobName}.odb exists, so the job has not produced results yet`);
      }

      // Resolve the node selection from the recorded spec, so set names keep working.
      let selectedNodes;
      if (typeof args.set === 'string' && args.set.trim() !== '') {
        if (record?.spec === undefined) throw new Error('cannot resolve a set name because this case has no recorded spec; pass nodeIds instead');
        const mesh = buildMesh(record.spec);
        const set = mesh.sets[args.set.trim()];
        if (set === undefined) {
          throw new Error(`set "${args.set}" does not exist in this case; available: ${Object.keys(mesh.sets).sort().join(', ')}`);
        }
        selectedNodes = set.nodes;
      } else if (Array.isArray(args.nodeIds) && args.nodeIds.length > 0) {
        selectedNodes = args.nodeIds.map((value) => Math.trunc(Number(value)));
      }

      if (useCalculix) {
        if (!fileExists(frdPath)) throw new Error(`the calculix results file ${frdPath} does not exist`);
        const parsed = parseFrd(await fsp.readFile(frdPath, 'utf8'));
        const summaryData = summarizeFrd(parsed, {
          setNodes: selectedNodes,
          step: Number.isFinite(Number(args.step)) ? Number(args.step) : undefined,
        });
        const lines = [formatSummary(summaryData, path.basename(frdPath))];
        if (selectedNodes !== undefined) {
          const selected = summaryData.displacement?.selected ?? [];
          lines.push(`values on ${selectedNodes.length} selected node(s)${args.set === undefined ? '' : ` (set ${args.set})`}:`);
          for (const entry of selected.slice(0, maxNodes)) {
            const stress = summaryData.stress?.selected.find((candidate) => candidate.nodeId === entry.nodeId);
            lines.push(
              `  node ${entry.nodeId}: U=(${entry.components.slice(0, 3).map((value) => num(value)).join(', ')}) `
              + `|U|=${num(entry.magnitude)}${stress === undefined ? '' : ` vonMises=${num(stress.vonMises)}`}`,
            );
          }
          if (selected.length > maxNodes) lines.push(`  ... ${selected.length - maxNodes} more (raise maxNodes, or set writeCsv for the whole set)`);
        }
        let csvPath;
        if (args.writeCsv === true && selectedNodes !== undefined) {
          const rows = ['nodeId,U1,U2,U3,|U|,SXX,SYY,SZZ,SXY,SYZ,SZX,vonMises'];
          for (const entry of summaryData.displacement?.selected ?? []) {
            const stress = summaryData.stress?.selected.find((candidate) => candidate.nodeId === entry.nodeId);
            rows.push([
              entry.nodeId,
              ...entry.components.slice(0, 3),
              entry.magnitude,
              ...(stress?.components ?? ['', '', '', '', '', '']),
              stress?.vonMises ?? '',
            ].join(','));
          }
          csvPath = path.join(dir, `${jobName}_results.csv`);
          await fsp.writeFile(csvPath, `${rows.join('\n')}\n`, 'utf8');
          lines.push(`wrote ${path.basename(csvPath)}`);
        }
        return json({ summary: lines.join('\n'), caseDir: dir, jobName, backend: 'calculix', results: summaryData, selectedNodes, csv: csvPath });
      }

      if (!env.abaqus.found) throw new Error('reading an .odb needs the abaqus python interpreter, but no Abaqus launcher was found');
      const extractPath = path.join(dir, `${jobName}_extract.py`);
      const outPath = path.join(dir, `${jobName}_results.json`);
      await fsp.writeFile(extractPath, buildOdbExtractScript({
        odbPath,
        outPath,
        fields: record?.spec?.output?.fields ?? ['S', 'U'],
        setNodes: selectedNodes,
      }), 'utf8');
      const run = await runCommand(env.abaqus.command, ['python', path.basename(extractPath)], {
        cwd: dir,
        timeoutMs: settings.timeoutSec * 1000,
        signal: exec.signal,
      });
      const payloadText = await readIfPresent(outPath);
      if (payloadText === undefined) {
        throw new Error(`the odbAccess script produced no output (exit ${run.code}); its log:\n${tail(`${run.stdout}\n${run.stderr}`, 25)}`);
      }
      const payload = JSON.parse(payloadText);
      return json({
        summary: `${formatOdbSummary(payload)}\nwrote ${path.basename(outPath)}`,
        caseDir: dir,
        jobName,
        backend: 'abaqus',
        payload,
        resultsFile: outPath,
      });
    },
  });

  /** Diagnostics for the session log; never fatal. */
  ctx.logger?.info?.(`dsh-abaqus: registered 6 tools (ccxPath=${settings.ccxPath ?? 'auto'}, abaqusCommand=${settings.abaqusCommand ?? 'auto'})`);
}
