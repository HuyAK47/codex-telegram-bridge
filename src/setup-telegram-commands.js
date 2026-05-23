'use strict';

const { loadConfig } = require('./config');
const { TelegramClient } = require('./telegram');
const { buildBotCommands } = require('./bot-commands');

async function setupTelegramCommands(env) {
  const config = loadConfig(env || process.env);
  const telegram = new TelegramClient(config.telegramBotToken);
  await telegram.setMyCommands(buildBotCommands());
  return buildBotCommands().length;
}

if (require.main === module) {
  setupTelegramCommands(process.env)
    .then((count) => console.log(`Configured ${count} Telegram bot commands`))
    .catch((error) => {
      console.error(`Failed to configure Telegram bot commands: ${error.message}`);
      process.exit(1);
    });
}

module.exports = { setupTelegramCommands };
