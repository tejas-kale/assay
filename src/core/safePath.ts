import { isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * Resolves `target` against `folder` and returns the absolute path, or undefined when it is
 * empty, holds a NUL byte, names the folder itself, or lands outside the folder. Purely lexical:
 * the caller must also check the real paths (symlinks) before reading.
 */
export function resolveInside(folder: string, target: string): string | undefined {
  if (target === '' || target.includes('\0')) return undefined
  const absolute = resolve(folder, target)
  const rel = relative(resolve(folder), absolute)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined
  return absolute
}
