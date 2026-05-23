'use strict';

const fs = require('fs');
const path = require('path');
const { redactSensitiveText } = require('./security');

class AuditLogger {
  constructor(filePath) {
    this.filePath = filePath || '';
  }

  write(event) {
    if (!this.filePath) {
      return;
    }
    const record = Object.assign({ time: new Date().toISOString() }, event || {});
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.appendFileSync(this.filePath, `${redactSensitiveText(JSON.stringify(record), process.env)}\n`);
  }

  readTail(limit) {
    if (!this.filePath || !fs.existsSync(this.filePath)) {
      return [];
    }
    const lines = fs.readFileSync(this.filePath, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-Math.max(1, Number(limit) || 20));
  }
}

module.exports = { AuditLogger };
