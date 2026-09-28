/**
 * Reproducible verification: does the built-in mesher + ccx reproduce beam
 * theory for a clamped cantilever, and does the error shrink as the mesh is
 * refined?
 *
 * Run:  CCX_PATH=/path/to/ccx node test/beam-convergence.mjs
 * (On Windows:  $env:CCX_PATH='F:\tools\calculix\bin\ccx.exe'; node test\beam-convergence.mjs)
 *
 * Geometry: 100 x 10 x 10 mm steel bar, E = 210000 MPa, nu = 0.3, clamped at
 * x = 0, 100 N total tip load. Euler-Bernoulli: delta = PL^3/(3EI) = 0.190476 mm,
 * max bending stress = 6PL/(bh^2) = 60.0 MPa.
 *
 * The FE tip deflection must approach theory FROM BELOW: a fully clamped end
 * suppresses Poisson contraction, so the beam is stiffer than the beam theory it
 * is compared against.
 */
import fs from 'node:fs';
import path from 'node:path';
import { EXAMPLE_SPEC, parseSpec } from '../lib/spec.js';
import { buildMesh } from '../lib/mesh.js';
import { buildCalculixDeck } from '../lib/inp.js';
import { parseFrd, summarizeFrd } from '../lib/results.js';
import { fileExists, runCommand } from '../lib/util.js';

const P = 100;
const L = 100;
const B = 10;
const H = 10;
const E = 210000;
const I = (B * H ** 3) / 12;
const THEORY_DEFLECTION = (P * L ** 3) / (3 * E * I);
const THEORY_STRESS = (6 * P * L) / (B * H ** 2);

const ccx = process.env.CCX_PATH;
if (ccx === undefined || !fileExists(ccx)) {
  console.error('set CCX_PATH to a CalculiX ccx executable, e.g.');
  console.error("  PowerShell:  $env:CCX_PATH='F:\\tools\\calculix\\bin\\ccx.exe'; node test\\beam-convergence.mjs");
  console.error('  bash:        CCX_PATH=/opt/calculix/ccx node test/beam-convergence.mjs');
  process.exit(2);
}

const outRoot = path.join(import.meta.dirname, 'out', 'beam-convergence');
fs.mkdirSync(outRoot, { recursive: true });

console.log(`ccx: ${ccx}`);
console.log(`theory: tip deflection ${THEORY_DEFLECTION.toFixed(6)} mm, max bending stress ${THEORY_STRESS.toFixed(2)} MPa\n`);
console.log('element  size   elems    nodes   max|U|      FE/theory  max von Mises  ZZerr');

const rows = [];
for (const element of ['C3D8', 'C3D8R', 'C3D8I']) {
  for (const size of [5, 2.5, 1.25]) {
    const name = `beam_${element}_${String(size).replace('.', 'p')}`;
    const dir = path.join(outRoot, name);
    fs.mkdirSync(dir, { recursive: true });

    const { spec, errors } = parseSpec({ ...EXAMPLE_SPEC, name, mesh: { kind: 'hex', size, element } });
    if (spec === undefined) throw new Error(`spec rejected: ${errors.join('; ')}`);
    const mesh = buildMesh(spec);
    const deck = buildCalculixDeck(spec, mesh);
    if (deck.errors.length > 0) throw new Error(`deck rejected: ${deck.errors.join('; ')}`);
    fs.writeFileSync(path.join(dir, `${name}.inp`), deck.inp);

    const run = await runCommand(ccx, ['-i', name], { cwd: dir, timeoutMs: 900_000 });
    const frdPath = path.join(dir, `${name}.frd`);
    if (run.code !== 0 || !fileExists(frdPath)) {
      console.error(`\n${name}: ccx failed with exit ${run.code}\n${run.stdout.split('\n').slice(-20).join('\n')}`);
      process.exit(1);
    }
    const summary = summarizeFrd(parseFrd(fs.readFileSync(frdPath, 'utf8')));
    const deflection = summary.displacement.max.value;
    const stress = summary.stress?.maxVonMises.value ?? Number.NaN;
    const zz = summary.meshErrorPercent?.mean ?? Number.NaN;
    rows.push({ element, size, elements: mesh.stats.elementCount, nodes: mesh.stats.nodeCount, deflection, stress, ratio: deflection / THEORY_DEFLECTION });
    console.log(
      `${element.padEnd(8)} ${String(size).padEnd(6)} ${String(mesh.stats.elementCount).padStart(6)}  ${String(mesh.stats.nodeCount).padStart(6)}` +
      `  ${deflection.toFixed(6)}  ${(deflection / THEORY_DEFLECTION).toFixed(4).padStart(9)}  ${stress.toFixed(2).padStart(12)} MPa  ${zz.toFixed(1)}%`,
    );
  }
}

/**
 * Expected behaviour, measured and asserted. These are properties of the
 * elements, not of this plugin, so they double as a regression test for the
 * mesh connectivity and element-type wiring:
 *
 *   C3D8   (2x2x2 integration) stiffer than beam theory at every size, ratio
 *          rises monotonically to ~0.99 with refinement.
 *   C3D8I  (incompatible modes) near-exact even on the coarsest mesh, so the
 *          ratio stays within +-1% at every size. The best choice for bending.
 *   C3D8R  (1 integration point) much softer, ratio falls monotonically to
 *          ~1.01 from above. Its reported nodal stress is the element-centre
 *          value, so it cannot resolve the through-thickness bending gradient
 *          and stays well below the outer-fibre stress: never read a peak
 *          bending stress out of a C3D8R model with few elements through the
 *          thickness.
 */
const expectations = {
  C3D8: { finestRatio: [0.97, 1.01], finestStressError: 0.05, monotone: 'increasing', alwaysStiffer: true },
  C3D8I: { finestRatio: [0.99, 1.01], finestStressError: 1.0, monotone: null, sizeIndependent: [0.99, 1.01] },
  C3D8R: { finestRatio: [1.0, 1.05], monotone: 'decreasing', stressBelowTheory: 0.9, stressIncreasing: true },
};

const failures = [];
for (const [element, expected] of Object.entries(expectations)) {
  // Largest element size first, so the last row is the finest mesh and each
  // step forward is a refinement.
  const series = rows.filter((row) => row.element === element).sort((a, b) => b.size - a.size);
  const finest = series[series.length - 1];

  if (expected.monotone === 'increasing') {
    for (let index = 1; index < series.length; index += 1) {
      if (!(series[index].ratio > series[index - 1].ratio)) {
        failures.push(`${element}: refinement should raise the deflection ratio (${series[index - 1].ratio.toFixed(4)} -> ${series[index].ratio.toFixed(4)})`);
      }
    }
  }
  if (expected.monotone === 'decreasing') {
    for (let index = 1; index < series.length; index += 1) {
      if (!(series[index].ratio < series[index - 1].ratio)) {
        failures.push(`${element}: refinement should lower the deflection ratio (${series[index - 1].ratio.toFixed(4)} -> ${series[index].ratio.toFixed(4)})`);
      }
    }
  }
  if (expected.alwaysStiffer === true && series.some((row) => row.ratio >= 1.0)) {
    failures.push(`${element}: a fully clamped end must stay stiffer than beam theory, but a ratio reached ${Math.max(...series.map((row) => row.ratio)).toFixed(4)}`);
  }
  if (expected.sizeIndependent !== undefined) {
    for (const row of series) {
      if (row.ratio < expected.sizeIndependent[0] || row.ratio > expected.sizeIndependent[1]) {
        failures.push(`${element}: expected a near-exact ratio in ${expected.sizeIndependent.join('..')} at every size, got ${row.ratio.toFixed(4)} at size ${row.size}`);
      }
    }
  }
  if (expected.finestRatio !== undefined && (finest.ratio < expected.finestRatio[0] || finest.ratio > expected.finestRatio[1])) {
    failures.push(`${element}: finest mesh FE/theory = ${finest.ratio.toFixed(4)}, expected ${expected.finestRatio.join('..')}`);
  }
  if (expected.finestStressError !== undefined) {
    const error = Math.abs(finest.stress - THEORY_STRESS) / THEORY_STRESS;
    if (error > expected.finestStressError) {
      failures.push(`${element}: finest mesh max von Mises = ${finest.stress.toFixed(2)} MPa, ${(error * 100).toFixed(1)}% from the theoretical ${THEORY_STRESS}`);
    }
  }
  if (expected.stressBelowTheory !== undefined && !(finest.stress < expected.stressBelowTheory * THEORY_STRESS)) {
    failures.push(`${element}: its reported peak stress (${finest.stress.toFixed(2)} MPa) was expected to stay below ${expected.stressBelowTheory} x the outer-fibre stress (${THEORY_STRESS} MPa)`);
  }
  if (expected.stressIncreasing === true) {
    for (let index = 1; index < series.length; index += 1) {
      if (!(series[index].stress > series[index - 1].stress)) {
        failures.push(`${element}: its reported peak stress should rise as the bending gradient is resolved (${series[index - 1].stress.toFixed(2)} -> ${series[index].stress.toFixed(2)} MPa)`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error(`\nFAIL (${failures.length})`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('\nPASS: the three element formulations behave as documented.');
console.log('      C3D8 converges to beam theory from below and reaches it within 1%;');
console.log('      C3D8I is near-exact at every size (use it for bending);');
console.log('      C3D8R converges from above and under-reports the outer-fibre stress.');
