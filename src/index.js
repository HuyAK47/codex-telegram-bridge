'use strict';

const { loadConfig } = require('./config');
const { createCommandHandler } = require('./commands');
const { SessionManager } = require('./session-manager');
const { TelegramClient } = require('./telegram');
const { chunkTelegramMessage, redactSensitiveText } = require('./security');
const { buildSmartErrorResponse } = require('./smart-errors');
const { createSessionNotifier } = require('./notifier');
const { startDashboard } = require('./dashboard');
const { attachTelegramPhoto } = require('./attachments');

async function main() {
  const config = loadConfig(process.env);
  const telegram = new TelegramClient(config.telegramBotToken);

  async function send(chatId, text, options) {
    const redacted = redactSensitiveText(text, process.env);
    const chunks = chunkTelegramMessage(redacted, config.telegramMessageLimit);
    for (let index = 0; index < chunks.length; index += 1) {
      const messageOptions = Object.assign({ disable_web_page_preview: true }, index === chunks.length - 1 ? options || {} : {});
      await telegram.sendMessage(chatId, chunks[index], messageOptions);
    }
  }

  const sessionManager = new SessionManager(config, createSessionNotifier(send, console));
  startDashboard(config, sessionManager);
  const handleUpdate = createCommandHandler(
    config,
    sessionManager,
    send,
    (callbackId, text) => telegram.answerCallbackQuery(callbackId, text),
    (message, chatId) => attachTelegramPhoto({ telegram, config, sessionManager, message, chatId })
  );

  let offset = 0;
  console.log('Codex Telegram Bridge started');
  console.log(`Sandbox default: ${config.sandboxMode}; write mode enabled: ${config.allowWriteMode}`);

  while (true) {
    try {
      const updates = await telegram.getUpdates(offset, 25);
      for (const update of updates) {
        offset = update.update_id + 1;
        try {
          await handleUpdate(update);
        } catch (error) {
          const chatId = update.message && update.message.chat && update.message.chat.id;
          const safeMessage = redactSensitiveText(error.message, process.env);
          if (chatId) {
            const smart = buildSmartErrorResponse(safeMessage);
            await send(chatId, smart.text, smart.options);
          } else {
            console.error(safeMessage);
          }
        }
      }
    } catch (error) {
      console.error(`poll failed: ${redactSensitiveText(error.message, process.env)}`);
      await delay(config.pollIntervalMs);
    }
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(redactSensitiveText(error.stack || error.message, process.env));
  process.exit(1);
});
