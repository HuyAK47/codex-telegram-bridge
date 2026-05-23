'use strict';

const fs = require('fs');
const path = require('path');

function pickLargestPhoto(photoSizes) {
  if (!Array.isArray(photoSizes) || photoSizes.length === 0) {
    throw new Error('No Telegram photo sizes found');
  }
  return photoSizes.slice().sort((left, right) => {
    const leftArea = Number(left.width || 0) * Number(left.height || 0);
    const rightArea = Number(right.width || 0) * Number(right.height || 0);
    return rightArea - leftArea;
  })[0];
}

function safeAttachmentPath(directory, fileId, filePath) {
  const extension = path.extname(filePath || '') || '.jpg';
  const safeId = String(fileId || 'image').replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(directory, `${Date.now()}-${safeId}${extension}`);
}

async function attachTelegramPhoto(options) {
  if (!options.config.attachmentDir) {
    throw new Error('ATTACHMENT_DIR is not configured');
  }
  const selected = pickLargestPhoto(options.message.photo);
  const file = await options.telegram.getFile(selected.file_id);
  fs.mkdirSync(options.config.attachmentDir, { recursive: true });
  const destination = safeAttachmentPath(options.config.attachmentDir, selected.file_id, file.file_path);
  await options.telegram.downloadFile(file.file_path, destination);
  options.sessionManager.attachImages(options.chatId, [destination]);
  return destination;
}

module.exports = { attachTelegramPhoto, pickLargestPhoto, safeAttachmentPath };
