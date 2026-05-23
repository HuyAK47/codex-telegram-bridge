'use strict';

function promptNeedsWrite(prompt) {
  return /\b(sửa|fix|implement|refactor|update|change|edit|write|commit|apply|thêm|xóa|xoá|chạy test|run test|build)\b/i.test(String(prompt || ''));
}

module.exports = { promptNeedsWrite };
