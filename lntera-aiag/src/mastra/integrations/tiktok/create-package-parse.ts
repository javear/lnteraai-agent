/**
 * Pure helpers for TikTok Create Package API response shapes (no network / clients).
 */

function extractIdsFromPackageLike(obj: unknown): string[] {
  if (!obj || typeof obj !== 'object') return [];
  const o = obj as Record<string, unknown>;
  const single = o.package_id ?? o.id;
  if (typeof single === 'string' && single.trim()) return [single.trim()];
  return [];
}

/** Parse package id(s) from Create Package `data` payload (or equivalent). */
export function extractPackageIdsFromTiktokCreatePackagesData(data: unknown): string[] {
  if (!data || typeof data !== 'object') return [];
  const d = data as Record<string, unknown>;
  const direct = extractIdsFromPackageLike(d);
  if (direct.length) return direct;

  const lists = [d.packages, d.package_list, d.package_info_list] as const;
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    const ids: string[] = [];
    for (const item of list) {
      ids.push(...extractIdsFromPackageLike(item));
    }
    if (ids.length) return [...new Set(ids)];
  }
  return [];
}
