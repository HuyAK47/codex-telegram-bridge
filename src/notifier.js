'use strict';

const { redactSensitiveText } = require('./security');

function createSessionNotifier(send, logger) {
  const log = logger || console;
  return function notify(chatId, text, options) {
    send(chatId, text, options).catch((error) => {
      log.error(`send failed: ${redactSensitiveText(error.message, process.env)}`);
    });
  };
}

module.exports = { createSessionNotifier };
