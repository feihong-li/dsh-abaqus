# dsh-abaqus — Abaqus / CalculiX modelling driver for DeepSeek Harness

A DeepSeek Harness Host plugin that lets the agent build, solve and inspect
finite-element models. One declarative JSON spec drives two backends:

| backend | geometry | meshing | deck | solve | results |
|---|---|---|---|---|---|
| `abaqus` | real CAD features in the CAE kernel | the Abaqus CAE mesher | written by `writeInput` | `abaqus job=<name> interactive` | `.odb` read with `odbAccess` |
| `calculix` | `box` / `cylinder` in the built-in mesher | structured hex (wedge core for a solid cylinder) | written directly | `ccx -i <name>` | `.frd` parsed in-process |

The CalculiX backend is what makes the plugin usable **today, without an Abaqus
licence**: it produces a genuine runnable deck, and the sections, steps, BCs,
loads and set vocabulary are the same ones the Abaqus path writes.

## Install

The plugin manager accepts a package name, a GitHub repository address, or a
local directory path.

**From this repository** — in the DSH Web UI, open Settings → Plugins → install
and paste the repository address, or on the command line:

```bash
dsh plugin --profile <profile> add <this-repo-url>
```

**From a clone** (for development):

```bash
git clone <this-repo-url>
dsh plugin --profile <profile> add /absolute/path/to/dsh-abaqus
```

Then restart DSH: the plugin is loaded at start-up, and its six tools appear
(`abaqus_env`, `abaqus_spec`, `abaqus_build`, `abaqus_run`, `abaqus_status`,
`abaqus_results`). Ask the agent to call `abaqus_env` to see what it found.

### You need a solver

- **CalculiX** (free, GPL) is enough for everything except the CAE backend. Take
  the Windows build from
  [calculix/CalculiX-Windows](https://github.com/calculix/CalculiX-Windows)
  (`releases/CalculiX-2.23.0-win-x64.zip`) or your distro's package, and either
  leave it where the plugin's discovery finds it or set `ccxPath` in the config.
- **Abaqus** is commercial and needs a licence. Set `abaqusCommand` to the
  launcher (`abq2023.bat`) when you have one.

## Tools

| tool | purpose |
|---|---|
| `abaqus_env` | report the detected Abaqus launcher, CalculiX solver and python |
| `abaqus_spec` | the full model-spec reference plus a worked example |
| `abaqus_build` | spec → `<name>.inp` (CalculiX) and/or `build_<name>.py` (CAE) |
| `abaqus_run` | submit the deck, run the CAE script, run a python script or a raw command |
| `abaqus_status` | job state, solver errors/warnings, `.sta` increments, artifacts |
| `abaqus_results` | max/min displacement, max von Mises, per-node-set values, CSV |

A typical session:

```
abaqus_env                                       # what is installed
abaqus_spec                                      # learn the DSL
abaqus_build   { spec: {...}, backend: "both" }   # write the deck + CAE script
abaqus_run     { caseDir: "...", backend: "calculix" }
abaqus_status  { caseDir: "..." }
abaqus_results { caseDir: "...", set: "beam_xmax", writeCsv: true }
```

The spec is a single JSON object:

```json
{
  "name": "cantilever",
  "materials": { "steel": { "E": 210000, "nu": 0.3, "rho": 7.85e-9 } },
  "parts": [{ "name": "beam", "material": "steel",
              "geometry": { "kind": "box", "size": [100, 10, 10] },
              "section": { "type": "solid" } }],
  "steps": [{ "name": "Load", "type": "static",
              "increments": { "initial": 0.1, "period": 1, "min": 1e-5, "max": 0.1 } }],
  "boundaries": [{ "name": "FIX", "step": "Load", "region": { "plane": "x=min" }, "dof": [1, 2, 3] }],
  "loads": [{ "name": "TIP", "step": "Load", "type": "concentrated",
              "region": { "plane": "x=max" }, "vector": [0, -100, 0], "total": true }],
  "mesh": { "size": 2.5, "element": "C3D8" },
  "output": { "fields": ["S", "U"] }
}
```

Call `abaqus_spec` for the complete reference: geometry, sections, steps, load
types, region forms, units, element types, and the meaning of every file a run
leaves behind.

## Named sets: one vocabulary

The built-in mesher creates the sets, the deck writer declares them verbatim as
`*NSET` / `*ELSET`, and `abaqus_results` accepts exactly the same names:

```
NALL, EALL                            every node / every element
<instance>_NALL, <instance>_EALL      one instance
<instance>_{x|y|z}{min|max}           one bounding plane of one instance
```

A spec region `{"plane":"x=max"}` on the instance `beam` resolves to the set
`beam_xmax`, so the `*BOUNDARY`/`*CLOAD` cards reference `beam_xmin`/`beam_xmax`
and a hand-reader can grep the `.inp` for the set name that `abaqus_results`
takes. The test suite asserts this, because an earlier revision had three
mutually inconsistent naming schemes.

## Configuration

The bundle row accepts an unvalidated `config` object:

```yaml
- insert:
    - id: dsh-abaqus
      name: '@local/dsh-abaqus'
      config:
        abaqusCommand: 'C:\SIMULIA\Commands\abq2023.bat'   # optional, else auto-detected
        ccxPath: 'F:\tools\calculix\bin\ccx.exe'            # optional, else auto-detected
        pythonPath: 'D:\Python39\python.exe'                # optional, syntax checks only
        defaultCaseDir: 'F:\cases'                          # optional
        timeoutSec: 900                                     # optional per-run kill timeout
```

Discovery order for Abaqus: `config.abaqusCommand` → `ABAQUS_COMMAND` →
`ABAQUS_HOME\Commands\*.bat` → `where abaqus*` → the SIMULIA registry keys →
`*\SIMULIA*` and `*\Abaqus*` directories on C:/D:/E:/F:/G:.
For CalculiX: `config.ccxPath` → `CCX_PATH` → `where ccx` → common install roots
including a portable `<drive>\<dir>\tools\calculix` layout.

## Verification

Everything below was measured with CalculiX 2.23. Run it yourself — both scripts
solve real models and fail loudly if a number drifts:

```bash
CCX_PATH=/path/to/ccx npm test
```

**`test/pipeline-check.mjs`** — 14 assertions, all passing: the deck vocabulary
equals the vocabulary the results reader accepts, no BC/load card references an
undeclared set, `{"plane":"x=max"}` selects exactly the nodes of `beam_xmax`, and
each deck path reproduces an independent number:

| case | check | result |
|---|---|---|
| box + concentrated load | tip deflection vs Euler-Bernoulli | FE/theory = 0.876 at 20×2×2 (mesh-limited) |
| tube R20/r15, 5 MPa on the annular end | FE σ_zz = −p | **−5.0000 MPa** |
| solid cylinder, y axis, `C3D6` wedge core, gravity | σ vs ρgH = 2.119e-3 MPa | 1.927e-3 MPa |
| clamped bar, `freq` step, 6 modes | f₁ vs Euler-Bernoulli 208.88 Hz | 223.07 Hz (+6.8 %) |

**`test/beam-convergence.mjs`** — a 100×10×10 mm steel cantilever, 100 N tip load,
against theory (tip deflection 0.190476 mm, outer-fibre bending stress 60.0 MPa):

| element | 80 elem | 640 elem | 5120 elem | max von Mises (finest) |
|---|---|---|---|---|
| `C3D8` | 0.878 | 0.968 | **0.994** | 58.96 MPa |
| `C3D8R` | 1.180 | 1.042 | 1.013 | 50.32 MPa (0.84× theory) |
| `C3D8I` | 0.997 | 1.001 | **1.003** | 65.06 MPa |

Numbers are FE/theory for the maximum displacement. Three findings are worth
knowing before you pick an element:

- **`C3D8`** is stiffer than beam theory at every mesh and converges to it from
  below. That direction is physically required: a fully clamped end suppresses
  Poisson contraction, so the beam really is stiffer than Euler-Bernoulli.
- **`C3D8I`** (incompatible modes) is within 0.3 % of theory even on the coarsest
  mesh. For bending-dominated models it is the element to use.
- **`C3D8R`** (one integration point) is much softer and converges from above, and
  its reported nodal stress is the element-centre value: with few elements through
  the thickness it **cannot** resolve the bending gradient, reporting 50 MPa where
  the outer fibre sees 60. Never read a peak bending stress out of a `C3D8R` model
  meshed a couple of elements through the thickness. Its ZZ error estimate also
  degenerates to 0 %.

### Not verified

The **Abaqus/CAE backend has never been executed**. No Abaqus installation or
licence exists on the development machine, so `build_<name>.py` is generated,
confirmed to be valid Python 3 by `py_compile` for four different model shapes,
and reviewed by hand — but the CAE API calls are unproven against a live kernel.
The CalculiX path is verified as described above.

## Limitations (v1)

- `box` and `cylinder` geometry only; tets (`C3D4`) need the Abaqus backend.
- Shell sections are rejected rather than silently solved as solids.
- `traction` loads are Abaqus-only and untested.
- Regions resolve by bounding box: a face sharing a bounding plane with another
  face (a step or shoulder) selects both, and curved faces (a bore, a fillet)
  cannot be addressed at all.
- The `.frd` reader loads the whole file into memory.

## Repository layout

```
index.js                 the plugin: six tool definitions
lib/spec.js              spec validation + the reference text handed to the model
lib/mesh.js              structured box/cylinder mesher and region resolution
lib/inp.js               CalculiX / Abaqus deck writer
lib/cae.js               Abaqus/CAE python generator
lib/results.js           .frd parser, summary maths, .odb extraction script
lib/detect.js            Abaqus / CalculiX / python discovery
lib/util.js              process and filesystem helpers
test/                    the two verification scripts above
cordis.patch.yml         the bundle patch that inserts the plugin row
```

## Operating notes

- DSH loads a module generation at start-up: after editing plugin files, restart
  the Harness. Toggling the plugin entry off and on does **not** re-import it.
- ccx scratch files (`.frd`, `.sta`, `.dat`, `.12d`, `.cvg`, `spooles.out`) land
  in the case directory next to the deck.

## License

MIT — see [LICENSE](LICENSE).
