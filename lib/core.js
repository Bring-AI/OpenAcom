'use strict';
// Shared registry + session lookup used by both the CLI and the MCP server.
const ADAPTERS = {
  zcode: require('./adapters/zcode'),
  claude: require('./adapters/claude'),
  codex: require('./adapters/codex'),
};

function adaptersToUse(name) {
  if (!name) return Object.values(ADAPTERS);
  const a = ADAPTERS[name];
  if (!a) throw new Error(`unknown agent "${name}" (expected zcode | claude | codex)`);
  return [a];
}

// Which agents actually know this session id.
function findSession(id, agentName) {
  const hits = [];
  for (const a of adaptersToUse(agentName)) {
    if (!a.available()) continue;
    if (a.name === 'zcode') { if (a.get(id)) hits.push(a); }
    else if (a.list(100000).some((s) => s.id === id)) hits.push(a);
  }
  return hits;
}

module.exports = { ADAPTERS, adaptersToUse, findSession };
