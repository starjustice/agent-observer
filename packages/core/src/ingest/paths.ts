/** Splits on both separators so a Windows laptop and a Mac are treated alike. */
const parts = (p: string): string[] => p.split(/[\\/]+/).filter(Boolean);

function relativeInside(file: string, root: string): string | null {
  const f = parts(file);
  const r = parts(root);
  if (r.length === 0 || f.length < r.length) return null;
  for (let i = 0; i < r.length; i += 1) if (f[i] !== r[i]) return null;
  return f.slice(r.length).join('/') || '.';
}

/**
 * Keeps a file path only when it sits inside the session's project folder
 * (stored relative to it) or inside a configured extra root (stored as given).
 * Anything else, and anything using "..", is dropped.
 */
export function filterFilePath(
  filePath: string | undefined,
  projectPath: string | null,
  extraRoots: readonly string[],
): string | null {
  if (!filePath || filePath.length > 1024) return null;
  if (/[\u0000-\u001f]/.test(filePath)) return null;
  const isAbsolute = /^([\\/]|[A-Za-z]:[\\/])/.test(filePath);
  if (!isAbsolute || parts(filePath).includes('..')) return null;
  if (projectPath) {
    const rel = relativeInside(filePath, projectPath);
    if (rel) return rel;
  }
  for (const root of extraRoots) {
    if (relativeInside(filePath, root)) return filePath;
  }
  return null;
}

export function folderName(path: string): string {
  const p = parts(path);
  return p[p.length - 1] ?? path;
}
