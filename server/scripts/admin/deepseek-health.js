'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/deepseek-health
// Which model DeepSeek actually served, by day; unreadable answers (tool-call
// markup) by day and where; DeepSeek payment/key/quota failures; and last
// night's DeepSeek calls by site. Read-only.
//   /api/admin/scripts/deepseek-health?text=1
const def = { file: 'scripts/deepseek-health.js', args: () => [] };

module.exports = { name: 'deepseek-health', file: def.file, args: def.args };
