/**
 * Result extraction.
 *
 * CalculiX writes results to a formatted `.frd`; Abaqus writes them to an
 * `.odb`. Both paths end in the same summary shape so a caller does not have to
 * care which backend produced the numbers.
 */
import { num } from './util.js';

/**
 * Fixed-width fields cannot be trusted for the value part: CalculiX prints a
 * three-digit exponent and drops the leading space of a positive value, so
 * `2.46640E+0019.82505E-003` is two values, not one. Values are therefore
 * matched by pattern after the fixed 13-character record prefix, with the
 * exponent pinned to exactly three digits.
 */
const VALUE_PATTERN = /-?\d\.\d+E[-+]\d{3}/g;

const COMPONENT_ORDER = {
  STRESS: null,
  DISP: ['D1', 'D2', 'D3', 'ALL'],
};

function valuesOf(line) {
  const matches = line.slice(13).match(VALUE_PATTERN);
  return matches === null ? [] : matches.map(Number);
}

const nodeIdOf = (line) => Number(line.slice(3, 13).trim());

/**
 * Parse a CalculiX `.frd` file.
 * @param {string} text - file content.
 * @returns {{nodes: Map<number, number[]>, blocks: object[], byName: Record<string, object[]>, stepCount: number}}
 */
export function parseFrd(text) {
  const nodes = new Map();
  const blocks = [];
  const lines = text.split(/\r?\n/);
  let mode = null;
  let pending = null;
  let pstep = 0;

  for (const line of lines) {
    if (line.startsWith('    1PSTEP')) {
      pstep += 1;
      continue;
    }
    if (line.startsWith('    2C')) {
      mode = 'nodes';
      continue;
    }
    if (line.startsWith('    3C')) {
      mode = 'elements';
      continue;
    }
    if (/^\s*100CL/.test(line)) {
      mode = 'results';
      pending = { name: undefined, components: [], nodeIds: [], values: [], pstep, format: Number(line.slice(56, 57)) };
      continue;
    }
    if (line.startsWith(' -3')) {
      if (pending !== undefined && pending !== null) {
        blocks.push(pending);
        pending = null;
      }
      mode = null;
      continue;
    }
    if (line.startsWith(' -4')) {
      if (pending !== null) pending.name = line.slice(5, 13).trim();
      continue;
    }
    if (line.startsWith(' -5')) {
      if (pending !== null) {
        pending.components.push({
          name: line.slice(5, 13).trim(),
          type: Number(line.slice(18, 22).trim()),
          index: Number(line.slice(23, 27).trim()),
        });
      }
      continue;
    }
    if (line.startsWith(' -1') && mode === 'nodes') {
      const id = nodeIdOf(line);
      nodes.set(id, valuesOf(line));
      continue;
    }
    if (line.startsWith(' -1') && mode === 'results' && pending !== null) {
      pending.nodeIds.push(nodeIdOf(line));
      pending.values.push(valuesOf(line));
    }
  }

  const byName = {};
  for (const block of blocks) {
    if (block.name === undefined) continue;
    (byName[block.name] ??= []).push(block);
  }
  const stepCount = Object.values(byName).reduce((max, list) => Math.max(max, list.length), 0);
  return { nodes, blocks, byName, stepCount };
}

const latest = (parsed, name) => {
  const list = parsed.byName[name];
  return list === undefined || list.length === 0 ? undefined : list[list.length - 1];
};

/** Component index by name, falling back to the declared component order. */
function componentIndex(block, name) {
  const found = block.components.findIndex((component) => component.name === name);
  if (found >= 0) return found;
  const order = COMPONENT_ORDER[block.name];
  if (order === null || order === undefined) return -1;
  return order.indexOf(name);
}

/** Von Mises stress from the six FRD stress components. */
function vonMises([sxx, syy, szz, sxy, syz, szx]) {
  return Math.sqrt(0.5 * ((sxx - syy) ** 2 + (syy - szz) ** 2 + (szz - sxx) ** 2 + 6 * (sxy ** 2 + syz ** 2 + szx ** 2)));
}

/**
 * Summarise a CalculiX result file.
 * @param {object} parsed - result of `parseFrd`.
 * @param {{setNodes?: number[], step?: number}} [options] - optional node subset.
 * @returns {object} extremes, per-set values and mesh error statistics.
 */
export function summarizeFrd(parsed, options = {}) {
  const wanted = options.setNodes === undefined ? undefined : new Set(options.setNodes);
  const stepIndex = options.step === undefined ? undefined : Math.max(1, Math.trunc(options.step));
  const pick = (name) => {
    const list = parsed.byName[name];
    if (list === undefined || list.length === 0) return undefined;
    return stepIndex === undefined ? list[list.length - 1] : list[Math.min(stepIndex, list.length) - 1];
  };

  const summary = { stepCount: parsed.stepCount, nodeCount: parsed.nodes.size, fields: Object.keys(parsed.byName) };

  const dispBlock = pick('DISP');
  if (dispBlock !== undefined) {
    const magnitudeIndex = componentIndex(dispBlock, 'ALL');
    let max = { value: -Infinity, nodeId: undefined, components: [] };
    let min = { value: Infinity, nodeId: undefined, components: [] };
    const selected = [];
    for (const [index, nodeId] of dispBlock.nodeIds.entries()) {
      const components = dispBlock.values[index];
      if (components.length === 0) continue;
      const magnitude = magnitudeIndex >= 0 && magnitudeIndex < components.length
        ? components[magnitudeIndex]
        : Math.hypot(...components.slice(0, 3));
      if (magnitude > max.value) max = { value: magnitude, nodeId, components };
      if (magnitude < min.value) min = { value: magnitude, nodeId, components };
      if (wanted !== undefined && wanted.has(nodeId)) selected.push({ nodeId, components, magnitude });
    }
    summary.displacement = { max, min, selected };
  }

  const stressBlock = pick('STRESS');
  if (stressBlock !== undefined) {
    let max = { value: -Infinity, nodeId: undefined, components: [] };
    const selected = [];
    for (const [index, nodeId] of stressBlock.nodeIds.entries()) {
      const components = stressBlock.values[index];
      if (components.length < 6) continue;
      const mises = vonMises(components);
      if (mises > max.value) max = { value: mises, nodeId, components };
      if (wanted !== undefined && wanted.has(nodeId)) selected.push({ nodeId, components, vonMises: mises });
    }
    summary.stress = { maxVonMises: max, selected };
  }

  const errorBlock = pick('ERROR');
  if (errorBlock !== undefined) {
    const values = errorBlock.values.map((components) => components[0]).filter((value) => Number.isFinite(value));
    if (values.length > 0) {
      const mean = values.reduce((total, value) => total + value, 0) / values.length;
      summary.meshErrorPercent = { max: Math.max(...values), mean, nodeCount: values.length };
    }
  }
  return summary;
}

/** Render the summary as the text a tool result carries. */
export function formatSummary(summary, sourceLabel) {
  const lines = [`results from ${sourceLabel}: ${summary.stepCount} result frame(s), ${summary.nodeCount} nodes, fields ${summary.fields.join(', ')}`];
  if (summary.displacement !== undefined) {
    const { max, min } = summary.displacement;
    lines.push(`max |U| = ${num(max.value)} at node ${max.nodeId} (${max.components.slice(0, 3).map((v) => num(v)).join(', ')})`);
    lines.push(`min |U| = ${num(min.value)} at node ${min.nodeId}`);
  }
  if (summary.stress !== undefined) {
    const { maxVonMises } = summary.stress;
    lines.push(`max von Mises = ${num(maxVonMises.value)} at node ${maxVonMises.nodeId} (SXX..SZX: ${maxVonMises.components.map((v) => num(v)).join(', ')})`);
  }
  if (summary.meshErrorPercent !== undefined) {
    lines.push(`ZZ mesh error estimate: max ${num(summary.meshErrorPercent.max)}%, mean ${num(summary.meshErrorPercent.mean)}%`);
  }
  return lines.join('\n');
}

/**
 * Generate the `odbAccess` script the Abaqus backend runs for results.
 * @param {{odbPath: string, outPath: string, fields: string[], setNodes?: number[]}} options
 * @returns {string} python source
 */
export function buildOdbExtractScript(options) {
  const payload = JSON.stringify(JSON.stringify({
    odbPath: options.odbPath,
    outPath: options.outPath,
    fields: options.fields,
    setNodes: options.setNodes ?? [],
  }));
  return `# -*- coding: mbcs -*-
# Generated by dsh-abaqus. Extracts result extremes from an .odb.
from __future__ import print_function
import json
import sys
import traceback

from odbAccess import openOdb
from abaqusConstants import MISES

OPTIONS = json.loads(${payload})


def main():
    odb = openOdb(OPTIONS['odbPath'], readOnly=True)
    result = {'steps': [], 'fields': {}, 'odb': OPTIONS['odbPath']}
    for step_name in odb.steps.keys():
        step = odb.steps[step_name]
        if len(step.frames) == 0:
            continue
        frame = step.frames[-1]
        entry = {'step': step_name, 'frame': frame.frameId, 'time': frame.frameValue}
        if 'U' in frame.fieldOutputs.keys():
            values = frame.fieldOutputs['U'].values
            best = None
            for value in values:
                magnitude = (value.data[0] ** 2 + value.data[1] ** 2 + value.data[2] ** 2) ** 0.5
                if best is None or magnitude > best['magnitude']:
                    best = {'magnitude': magnitude, 'node': value.nodeLabel, 'components': list(value.data)}
            entry['displacement'] = best
        if 'S' in frame.fieldOutputs.keys():
            mises = frame.fieldOutputs['S'].getScalarField(invariant=MISES)
            best = None
            for value in mises.values:
                if best is None or value.data > best['magnitude']:
                    best = {'magnitude': value.data, 'node': value.nodeLabel}
            entry['vonMises'] = best
        result['steps'].append(entry)
    odb.close()
    handle = open(OPTIONS['outPath'], 'w')
    handle.write(json.dumps(result, indent=2))
    handle.close()
    print('DSH_ABAQUS_RESULTS_OK')


try:
    main()
except Exception:
    traceback.print_exc()
    print('DSH_ABAQUS_RESULTS_FAILED')
    sys.exit(2)
`;
}

/** Render the ODB extraction JSON (from `buildOdbExtractScript`) as text. */
export function formatOdbSummary(payload) {
  const lines = [`results from ${payload.odb}: ${payload.steps.length} step(s)`];
  for (const step of payload.steps) {
    const parts = [`step ${step.step} (frame ${step.frame}, time ${num(step.time)})`];
    if (step.displacement !== null && step.displacement !== undefined) {
      parts.push(`max |U| = ${num(step.displacement.magnitude)} at node ${step.displacement.node}`);
    }
    if (step.vonMises !== null && step.vonMises !== undefined) {
      parts.push(`max von Mises = ${num(step.vonMises.magnitude)} at node ${step.vonMises.node}`);
    }
    lines.push(parts.join('; '));
  }
  return lines.join('\n');
}
