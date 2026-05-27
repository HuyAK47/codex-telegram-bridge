'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

function requestJson(method, token, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload || {});
    const url = new URL(`https://api.telegram.org/bot${token}/${method}`);
    const req = https.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          let parsed;
          try {
            parsed = JSON.parse(data || '{}');
          } catch (error) {
            reject(new Error(`Telegram returned invalid JSON: ${error.message}`));
            return;
          }
          if (!parsed.ok) {
            reject(new Error(`Telegram API ${method} failed: ${parsed.description || res.statusCode}`));
            return;
          }
          resolve(parsed.result);
        });
      }
    );

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

class TelegramClient {
  constructor(token) {
    this.token = token;
  }

  getUpdates(offset, timeoutSeconds) {
    return requestJson('getUpdates', this.token, {
      offset,
      timeout: timeoutSeconds || 25,
      allowed_updates: ['message', 'callback_query'],
    });
  }

  sendMessage(chatId, text, options) {
    return requestJson('sendMessage', this.token, Object.assign({ chat_id: chatId, text }, options || {}));
  }

  answerCallbackQuery(callbackQueryId, text) {
    return requestJson('answerCallbackQuery', this.token, {
      callback_query_id: callbackQueryId,
      text,
      show_alert: false,
    });
  }

  setMyCommands(commands) {
    return requestJson('setMyCommands', this.token, { commands });
  }

  getFile(fileId) {
    return requestJson('getFile', this.token, { file_id: fileId });
  }

  downloadFile(filePath, destination) {
    return new Promise((resolve, reject) => {
      const url = new URL(`https://api.telegram.org/file/bot${this.token}/${filePath}`);
      const output = fs.createWriteStream(destination, { flags: 'wx' });
      const req = https.get(url, (res) => {
        if (res.statusCode !== 200) {
          output.destroy();
          reject(new Error(`Telegram file download failed: ${res.statusCode}`));
          return;
        }
        res.pipe(output);
      });
      req.on('error', (error) => {
        output.destroy();
        reject(error);
      });
      output.on('finish', () => output.close(resolve));
      output.on('error', reject);
    });
  }

  sendDocument(chatId, filePath, options) {
    return new Promise((resolve, reject) => {
      const boundary = `----codex-telegram-bridge-${Date.now().toString(16)}`;
      const caption = options && options.caption ? String(options.caption) : '';
      const fileName = path.basename(filePath);
      const header = Buffer.from(
        `--${boundary}\r\n`
        + 'Content-Disposition: form-data; name="chat_id"\r\n\r\n'
        + `${chatId}\r\n`
        + `--${boundary}\r\n`
        + 'Content-Disposition: form-data; name="caption"\r\n\r\n'
        + `${caption}\r\n`
        + `--${boundary}\r\n`
        + `Content-Disposition: form-data; name="document"; filename="${fileName}"\r\n`
        + 'Content-Type: application/octet-stream\r\n\r\n'
      );
      const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
      const stat = fs.statSync(filePath);
      const url = new URL(`https://api.telegram.org/bot${this.token}/sendDocument`);
      const req = https.request(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': header.length + stat.size + footer.length,
          },
        },
        (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => {
            let parsed;
            try {
              parsed = JSON.parse(data || '{}');
            } catch (error) {
              reject(new Error(`Telegram returned invalid JSON: ${error.message}`));
              return;
            }
            if (!parsed.ok) {
              reject(new Error(`Telegram API sendDocument failed: ${parsed.description || res.statusCode}`));
              return;
            }
            resolve(parsed.result);
          });
        }
      );

      req.on('error', reject);
      req.write(header);
      const stream = fs.createReadStream(filePath);
      stream.on('error', reject);
      stream.on('end', () => {
        req.end(footer);
      });
      stream.pipe(req, { end: false });
    });
  }
}

module.exports = { TelegramClient };
