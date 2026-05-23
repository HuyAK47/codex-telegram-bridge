'use strict';

const { loadConfig } = require('./config');
const { buildHealthReport } = require('./health');

function runDoctor(env) {
  const config = loadConfig(env || process.env);
  return buildHealthReport(config);
}

if (require.main === module) {
  try {
    console.log(runDoctor(process.env));
  } catch (error) {
    console.error(`Doctor failed: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { runDoctor };
