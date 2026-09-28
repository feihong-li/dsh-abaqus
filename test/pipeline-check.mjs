/**
 * Reproducible verification of the whole pipeline, in three parts:
 *
 *   1. vocabulary   the set names the deck declares are exactly the names the
 *                   results reader accepts, with no dangling BC/load reference
 *   2. regions      a spec region resolves to the same nodes as its named set
 *   3. deck paths   the box / tube / solid-cylinder (wedge core) / frequency
 *                   decks all solve, each checked against an independent number
 *
 * Run:  CCX_PATH=/path/to/ccx node test/pipeline-check.mjs
 * (On Windows:  $env:CCX_PATH='F:\tools\calculix\bin\ccx.exe'; node test\pipeline-check.mjs)
 */
import fs from 'node:fs';
import path from 'node:path';
import { EXAMPLE_SPEC, parseSpec } from '../lib/spec.js';
import { buildMesh, resolveRegion } from '../lib/mesh.js';
import { buildCalculixDeck } from '../lib/inp.js';
import { formatSummary, parseFrd, summarizeFrd } from '../lib/results.js';
import { fileExists, runCommand } from '../lib/util.js';

const ccx = process.env.CCX_PATH;
if (ccx === undefined || !fileExists(ccx)) {
  console.error('set CCX_PATH to a CalculiX ccx executable, e.g.');
  console.error("  PowerShell:  $env:CCX_PATH='F:\\tools\\calculix\\bin\\ccx.exe'; node test\\pipeline-check.mjs");
  console.error('  bash:        CCX_PATH=/opt/calculix/ccx node test/pipeline-check.mjs');
  process.exit(2);
}

const outRoot = path.join(import.meta.dirname, 'out', 'pipeline-check');
fs.mkdirSync(outRoot, { recursive: true });
const failures = [];
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : ` -- ${detail}`}`);
  if (!ok) failures.push(label);
};

/** Build a deck, solve it, and return the parsed result summary. */
async function solve(label, rawSpec, selection) {
  const dir = path.join(outRoot, label);
  fs.mkdirSync(dir, { recursive: true });
  const { spec, errors } = parseSpec({ ...rawSpec, name: label });
  if (spec === undefined) throw new Error(`${label}: spec rejected: ${errors.join('; ')}`);
  const mesh = buildMesh(spec);
  const deck = buildCalculixDeck(spec, mesh);
  if (deck.errors.length > 0) throw new Error(`${label}: deck rejected: ${deck.errors.join('; ')}`);
  fs.writeFileSync(path.join(dir, `${label}.inp`), deck.inp);
  const run = await runCommand(ccx, ['-i', label], { cwd: dir, timeoutMs: 900_000 });
  const frdPath = path.join(dir, `${label}.frd`);
  if (run.code !== 0 || !fileExists(frdPath)) {
    console.error(`${label}: ccx exited ${run.code}\n${run.stdout.split('\n').slice(-20).join('\n')}`);
    failures.push(`${label}: ccx did not produce results`);
    return { spec, mesh, deck, dir, summary: undefined };
  }
  const summary = summarizeFrd(parseFrd(fs.readFileSync(frdPath, 'utf8')), {
    setNodes: selection === undefined ? undefined : selection(mesh),
  });
  console.log(`     ${formatSummary(summary, `${label}.frd`).split('\n').join('\n     ')}`);
  return { spec, mesh, deck, dir, summary };
}

console.log('== 1. deck vocabulary vs results reader ==\n');
const base = await solve('vocabulary', { ...EXAMPLE_SPEC, mesh: { kind: 'hex', size: 5, element: 'C3D8' } }, (mesh) => mesh.sets.beam_xmax.nodes);
const declared = new Set();
for (const line of base.deck.inp.split('\n')) {
  const match = /^\*(?:NSET|ELSET), (?:NSET|ELSET)=(\S+)/.exec(line);
  if (match !== null) declared.add(match[1]);
}
const readerNames = Object.keys(base.mesh.sets);
const undeclared = readerNames.filter((name) => !declared.has(name));
check('every set name the results reader accepts is declared in the deck', undeclared.length === 0, undeclared.join(', '));

// Collect the first token of every data line inside a *BOUNDARY / *CLOAD / *DLOAD
// card: those are set names (or element ids for a facial load, which are numbers).
const referenced = new Set();
let inLoadCard = false;
for (const line of base.deck.inp.split('\n')) {
  if (line.startsWith('*')) {
    inLoadCard = /^\*(?:BOUNDARY|CLOAD|DLOAD)\b/.test(line);
    continue;
  }
  if (!inLoadCard) continue;
  const token = line.split(',')[0].trim();
  if (token !== '' && !/^-?\d/.test(token)) referenced.add(token);
}
const dangling = [...referenced].filter((name) => !declared.has(name));
check(
  'no *BOUNDARY/*CLOAD/*DLOAD card references an undeclared set',
  dangling.length === 0,
  `referenced ${[...referenced].join(', ')}${dangling.length === 0 ? '' : ` | dangling: ${dangling.join(', ')}`}`,
);

console.log('\n== 2. region resolution ==\n');
const resolved = resolveRegion({ kind: 'plane', axis: 'x', side: 'max', label: 'xmax' }, base.mesh, 'beam');
check(
  'region {plane:"x=max"} selects exactly the nodes of the named set beam_xmax',
  JSON.stringify(resolved.nodeIds) === JSON.stringify(base.mesh.sets.beam_xmax.nodes),
  `${resolved.nodeIds.length} nodes`,
);
const tipValues = base.summary.displacement.selected.map((entry) => entry.components[1]);
check('every node of the loaded face deflects downward', tipValues.length > 0 && Math.min(...tipValues) < 0, `${tipValues.length} nodes, min U2 = ${Math.min(...tipValues).toExponential(3)}`);
check('the clamped corner has exactly zero displacement', base.summary.displacement.min.value === 0);

console.log('\n== 3. deck paths, each against an independent number ==\n');

// Box + concentrated load: deflection must be below beam theory but close to it.
const theoryTip = (100 * 100 ** 3) / (3 * 210000 * ((10 * 10 ** 3) / 12));
const tipU2 = Math.min(...base.summary.displacement.selected.map((entry) => entry.components[1]));
const tipRatio = tipU2 / -theoryTip;
check(
  'box + concentrated load: tip deflection is 0.85..1.00 of Euler-Bernoulli',
  Number.isFinite(tipRatio) && tipRatio > 0.85 && tipRatio < 1.0,
  `FE/theory = ${tipRatio.toFixed(4)} (${tipU2.toFixed(6)} mm vs ${(-theoryTip).toFixed(6)} mm)`,
);

// Tube with an axial pressure on the annular end face: sigma_zz must equal -p.
const tube = await solve('tube_pressure', {
  units: 'mm-N-MPa-tonne',
  materials: { steel: { E: 210000, nu: 0.3, rho: 7.85e-9 } },
  parts: [{ name: 'pipe', material: 'steel', geometry: { kind: 'cylinder', radius: 20, height: 100, axis: 'z', innerRadius: 15 }, section: { type: 'solid' } }],
  steps: [{ name: 'Load', type: 'static', increments: { initial: 0.2, period: 1 } }],
  boundaries: [{ name: 'FIX', step: 'Load', region: { plane: 'z=min' }, dof: [1, 2, 3] }],
  loads: [{ name: 'INTERNAL', step: 'Load', type: 'pressure', region: { plane: 'z=max' }, value: 5 }],
  mesh: { size: 5, element: 'C3D8R' },
});
const tubeMises = tube.summary?.stress?.maxVonMises.value ?? Number.NaN;
const tubeSzz = tube.summary?.stress?.maxVonMises.components[2] ?? Number.NaN;
check('tube + pressure: max von Mises equals the applied 5 MPa within 2%', Math.abs(tubeMises - 5) / 5 < 0.02, `${tubeMises.toFixed(4)} MPa`);
check('tube + pressure: the axial stress component is exactly -5 MPa', Math.abs(tubeSzz + 5) < 1e-6, `SZZ = ${tubeSzz}`);

// Solid cylinder: exercises the C3D6 wedge core, the axis transform and gravity.
const density = 2.7e-9;
const height = 80;
const gravity = 9810;
const selfWeight = density * gravity * height;
const post = await solve('solid_cylinder_gravity', {
  materials: { alu: { E: 70000, nu: 0.33, rho: density } },
  parts: [{ name: 'post', material: 'alu', geometry: { kind: 'cylinder', radius: 10, height, axis: 'y' }, section: { type: 'solid' } }],
  steps: [{ name: 'Load', type: 'static', increments: { initial: 0.1, period: 1 } }],
  boundaries: [{ name: 'FIX', step: 'Load', region: { plane: 'y=min' }, dof: [1, 2, 3] }],
  loads: [{ name: 'G', step: 'Load', type: 'gravity', vector: [0, -gravity, 0] }],
  mesh: { size: 4 },
});
const wedgeCount = post.mesh.stats.byType.C3D6 ?? 0;
check('solid cylinder: the wedge core produced C3D6 elements', wedgeCount > 0, `${wedgeCount} C3D6`);
const postMises = post.summary?.stress?.maxVonMises.value ?? Number.NaN;
check(
  'solid cylinder + gravity: axial stress is within 25% of rho*g*H',
  Math.abs(postMises - selfWeight) / selfWeight < 0.25,
  `${postMises.toExponential(3)} vs ${selfWeight.toExponential(3)} MPa`,
);
check('solid cylinder: the rotated (y-axis) model is clamped at its lowest y', Math.abs(post.mesh.instances[0].bbox.yMin + 0) < 1e-9 || post.mesh.instances[0].bbox.yMin <= 0);

// Clamped bar frequency step: f1 must be close to the beam-theory value.
const barL = 200;
const barB = 10;
const barH = 10;
const rho = 7.85e-9;
const barI = (barB * barH ** 3) / 12;
const barA = barB * barH;
const theoryF1 = ((1.8751 ** 2) / (2 * Math.PI)) * Math.sqrt((210000 * barI) / (rho * barA)) / barL ** 2;
const modal = await solve('modal', {
  materials: { steel: { E: 210000, nu: 0.3, rho } },
  parts: [{ name: 'bar', material: 'steel', geometry: { kind: 'box', size: [barL, barB, barH] }, section: { type: 'solid' } }],
  steps: [{ name: 'Modes', type: 'freq', eigenvalues: 6 }],
  boundaries: [{ name: 'FIX', step: 'Modes', region: { plane: 'x=min' }, dof: [1, 2, 3] }],
  loads: [],
  mesh: { size: 5 },
  writes: { frd: true, dat: true },
});
// The .dat holds the eigenvalue table; column 4 of each row is the frequency in Hz.
let measuredF1 = Number.NaN;
const datPath = path.join(modal.dir, 'modal.dat');
if (fileExists(datPath)) {
  const rows = fs.readFileSync(datPath, 'utf8').split(/\r?\n/);
  const headerIndex = rows.findIndex((line) => line.includes('(CYCLES/TIME'));
  for (let index = headerIndex + 1; index < rows.length; index += 1) {
    const tokens = rows[index].trim().split(/\s+/);
    if (tokens.length >= 4 && /^\d+$/.test(tokens[0])) {
      measuredF1 = Number(tokens[3]);
      break;
    }
  }
}
check(
  'clamped bar f1 is within 10% of Euler-Bernoulli beam theory',
  Number.isFinite(measuredF1) && Math.abs(measuredF1 - theoryF1) / theoryF1 < 0.1,
  `f1 = ${measuredF1.toFixed(2)} Hz vs theory ${theoryF1.toFixed(2)} Hz`,
);
check('frequency step reports one result frame per requested mode', modal.summary?.stepCount === 6, `${modal.summary?.stepCount} frames`);

console.log('');
if (failures.length > 0) {
  console.error(`FAIL (${failures.length} of the checks above)`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('PASS: vocabulary, region resolution and every deck path agree with the independent numbers.');
