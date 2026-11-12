/**
 * The flags for Assay's own Python helpers (`python <flags> -m analysis_trust ...`). `-I` isolates them from the
 * analysis folder (audit PI-9) but implies `-E`, which ignores PYTHONDONTWRITEBYTECODE, so `-B` is passed too: no
 * bytecode appears in the installed backend (audit UP-1). Not for the kernel, which runs the user's own code.
 */
export const HELPER_PYTHON_FLAGS: readonly string[] = ['-I', '-B']
