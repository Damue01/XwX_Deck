export const NATIVE_SIZE_LIMITS = Object.freeze({
  macAppBytes: 18_000_000,
  macDmgBytes: 14_000_000,
  macHelperBytes: 1_500_000,
  windowsExeBytes: 20_000_000,
});

export function checkNativeArtifactSize({ appBytes, dmgBytes, exeBytes, helperBytes }) {
  const results = [];
  for (const [label, value, limit] of [
    ['macOS app', appBytes, NATIVE_SIZE_LIMITS.macAppBytes],
    ['macOS DMG', dmgBytes, NATIVE_SIZE_LIMITS.macDmgBytes],
    ['Windows EXE', exeBytes, NATIVE_SIZE_LIMITS.windowsExeBytes],
    ['macOS updater', helperBytes, NATIVE_SIZE_LIMITS.macHelperBytes],
  ]) {
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value <= 0) throw Error(`${label} 体积无效`);
    if (value > limit) throw Error(`${label} 为 ${(value / 1e6).toFixed(2)} MB，超出 ${(limit / 1e6).toFixed(0)} MB 体积预算；请核对新增资源与依赖`);
    results.push({ artifact: label, bytes: value, limitBytes: limit, passed: true });
  }
  if (!results.length) throw Error('缺少原生制品体积，未登记候选');
  return results;
}
