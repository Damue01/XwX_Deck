// Shared by the renderer, retained backend and embedded dashboard.
;(function install(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = { formatBytes: factory() };
  else root.XwXFormatBytes = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  return function formatBytes(bytes) {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes, unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
    const digits = unit === 0 ? 0 : value < 10 ? 1 : 0;
    return value.toFixed(digits) + ' ' + units[unit];
  };
});
