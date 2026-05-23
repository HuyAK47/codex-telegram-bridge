'use strict';

const fs = require('fs');
const path = require('path');

function cleanupAttachments(directory, maxAgeMs) {
  if (!directory || !fs.existsSync(directory)) {
    return { deleted: 0, scanned: 0 };
  }
  const now = Date.now();
  let deleted = 0;
  let scanned = 0;
  for (const name of fs.readdirSync(directory)) {
    const filePath = path.join(directory, name);
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      continue;
    }
    scanned += 1;
    if (now - stat.mtimeMs > maxAgeMs) {
      fs.unlinkSync(filePath);
      deleted += 1;
    }
  }
  return { deleted, scanned };
}

module.exports = { cleanupAttachments };
