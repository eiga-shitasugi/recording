const GIB = 1024 ** 3;

function classifyDiskSpace(freeBytes) {
  const bytes = Number(freeBytes);
  if (!Number.isFinite(bytes) || bytes < 0) {
    return {
      level: 'error',
      freeBytes: null,
      freeGb: null,
      message: '空き容量を確認できません',
    };
  }

  const freeGb = Math.round((bytes / GIB) * 10) / 10;
  if (bytes < 20 * GIB) {
    return {
      level: 'error',
      freeBytes: Math.floor(bytes),
      freeGb,
      message: `空き容量が不足しています（${freeGb} GB）`,
    };
  }
  if (bytes < 50 * GIB) {
    return {
      level: 'warning',
      freeBytes: Math.floor(bytes),
      freeGb,
      message: `空き容量が少なくなっています（${freeGb} GB）`,
    };
  }
  return {
    level: 'ok',
    freeBytes: Math.floor(bytes),
    freeGb,
    message: `空き容量 ${freeGb} GB`,
  };
}

module.exports = { GIB, classifyDiskSpace };
