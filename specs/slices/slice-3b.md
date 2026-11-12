# Slice 3b: venv-assay, one shared Python environment

Fixed points: assay `65de381`, config `bbdd751`.

## Why

Claude's Python came from the nearest `.venv` above the analysis (`~/Code/notes-src/.venv`). That venv is built from
`~/Code/notes-src/pyproject.toml`, which is a hand-merged copy of the mod's own `notes-src/pyproject.toml`, and the mod's
helpers (`analysis_trust.py`, `analysis_kernel.py`, ...) had to be copied there too. The copies drifted: `/an trust`
failed with `No module named 'sqlglot'`, and the python tool would have been `missing` (no `ipykernel`).

After this slice the mod owns one Linux venv, **venv-assay**, built from the config repo and used by every analysis in
every repo. Nothing is copied or merged by hand.

## The contract

| What | Where |
| --- | --- |
| The venv | Podman named volume `venv-assay`, mounted at `/opt/venv-assay` |
| Its python | `/opt/venv-assay/bin/python` |
| Built from | `~/Code/config/claude/analysis/notes-src/pyproject.toml` + `uv.lock` (the mod's copy, now the only one) |
| Helpers | installed editable from `/opt/analysis/notes-src` (the mod's mount), so an edit to a helper needs no rebuild |
| Kernel runner | `/opt/analysis/notes-src/analysis_kernel.py`, run by path from the mod's mount |
| Build command (Mac) | `claude-pkg venv-assay` |

`/opt/analysis/notes-src` is the same path in the session container and in the build container, so the editable
install's paths resolve in both.

## Config repo: the wrapper and claude-pkg

1. `claude/bin/claude`: add `-v venv-assay:/opt/venv-assay:ro` to the session's `podman run`. Podman creates the volume
   empty if it does not exist yet; the mod then reports it as not built (below).
2. `claude/bin/claude-pkg venv-assay`: a new subcommand. It works from any directory (it must not need a project root).
   It runs, in the same pkg container setup as the other subcommands (registry-only egress, `pi-cache:/cache`):
   - mounts `$CLAUDE_DIR/analysis/notes-src` read-write at `/opt/analysis/notes-src` and `venv-assay` at `/opt/venv-assay`
   - runs `uv sync --project /opt/analysis/notes-src` with `UV_PROJECT_ENVIRONMENT=/opt/venv-assay` and
     `UV_LINK_MODE=copy` (the uv cache is on another volume)
   - the venv's python must be one the session image also has (check where the image's uv puts managed pythons; the
     old `~/Code/notes-src/.venv` points at `/opt/uv-python/...`)
   - updates `uv.lock` when `pyproject.toml` changed; the lock is committed
   - prints one line at the end: which python, and that the venv is ready
3. Update the usage comment at the top of `claude-pkg`.

## Config repo: the mod

1. Constants in `model.ts`: `VENV_ASSAY = '/opt/venv-assay'`, its python, and the runner path under the mod's own folder
   (`/opt/analysis/notes-src/analysis_kernel.py`). If the mod API exposes the mod's own folder, derive the runner path
   from it; otherwise use the constant. Tests may override these the way the existing tests fake paths.
2. **Tools python** (`python -m analysis_trust`, the dictionary, calculations): always venv-assay's python. If it does
   not exist: `{ error: 'venv-assay is not built. On the Mac, run: claude-pkg venv-assay' }`. This hint replaces
   `NO_VENV_HINT` everywhere.
3. **Kernel python**: the nearest `.venv/bin/python` from the analysis up, used only if
   `<python> -c "import ipykernel"` exits 0 (run once per kernel start, timeout 20 s). Otherwise venv-assay's python.
   Neither usable: kernel `missing`, message as in 2.
   - The runner is always the mod's copy; drop the "copy analysis_kernel.py into notes-src" check and message.
   - `serve` runs under the kernel python (jupyter_client starts the kernel with `sys.executable`).
   - `MISSING_MESSAGE` in `analysis_kernel.py` says to run `claude-pkg venv-assay` (it fires only when the chosen
     python lacks ipykernel, which after 3 means venv-assay does).
4. **Rules for Claude** (`analysisRules`): name the kernel python and say the pytest line uses it
   (`<kernel python> -m pytest tests`). Say once, plainly, that venv-assay is the only Python for the mod's tools and
   that if a package is missing the fix is adding it to the config repo's `notes-src/pyproject.toml` and running
   `claude-pkg venv-assay`, never a Bash `pip install` and never another venv.
5. `notesHome` (where the dictionary and trusted calculations live) keeps its meaning: the nearest folder named
   `notes-src`, else the folder holding the nearest `.venv`. It must not depend on venv-assay.
6. Nothing in the app changes: `runs.json` and the request/reply files keep their shapes.

## Docs

- `claude/analysis/README.md`: the setup section becomes one step, `claude-pkg venv-assay`, plus: rerun it after
  changing `notes-src/pyproject.toml`; a project `.venv` with `ipykernel` overrides the kernel only; `.venv-mac` for
  Molten is unchanged and separate. Remove "merge these lines into ~/Code/notes-src/pyproject.toml" from the
  pyproject's header comment.
- `claude/analysis/HANDOFF.md`: a short "venv-assay" entry.

## Tests

- Mod (`claude plugin test .`): tools python is venv-assay; missing venv-assay gives the hint; the kernel picks a project
  `.venv` that imports ipykernel, falls back to venv-assay when the import fails or there is no `.venv`, and is
  `missing` with the hint when neither works; the runner path is the mod's copy; the rules name the kernel python.
- Runner (`<venv>/bin/python -m pytest notes-src/tests`): still passes; `MISSING_MESSAGE` text.

## Decisions

- A named volume, not a host folder: a Linux venv is no use on the Mac, and a volume outlives image rebuilds.
- Mounted read-only in sessions: only `claude-pkg venv-assay` changes it, so Claude cannot `pip install` into it.
- Editable helpers: an edit to `analysis_*.py` in the config repo is live in the next session without a rebuild.
- A project `.venv` overrides the kernel only, and only when it has `ipykernel`; the mod's tools never use it.
- `~/Code/notes-src/pyproject.toml` stops being the mod's concern. Its `.venv` keeps working as a kernel override once
  it has `ipykernel`.
