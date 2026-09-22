'use strict';
// OpenAcom SDK - programmatic access for other Node tools.
//   const relay = require('openacom');
//   await relay.list();  await relay.sendTracked(...);  relay.inbox.list();
// lib/sdk.js holds the implementations; this entry keeps the published 0.11.0 names and adds the relay, mailbox and paths surface.

const { ADAPTERS } = require('./core');
const sdk = require('./sdk');

module.exports = {
  // Store in inbox, then attempt the selected route once; same ID replays without another send.
  sendRouted: sdk.sendRouted,
  listSessions: sdk.listSessions,
  readSession: sdk.readSession,
  send: sdk.send,
  sendTracked: sdk.sendTracked,
  inbox: sdk.mailbox,
  hooks: {
    EVENTS: () => require('./hooks').EVENTS,
    file: () => require('./hooks').hooksFile(),
    load: () => require('./hooks').loadHooks(),
  },
  web: {
    start: (port, opts) => require('./web').startWeb(port, opts),
  },
  adapters: ADAPTERS,
  agents: sdk.agents,
  sendMessage: sdk.sendMessage,
  relaySend: sdk.relaySend,
  relayStatus: sdk.relayStatus,
  relayNodes: sdk.relayNodes,
  inboxMessages: sdk.inboxMessages,
  inboxMessage: sdk.inboxMessage,
  postMessage: sdk.postMessage,
  ackMessage: sdk.ackMessage,
  getPaths: sdk.getPaths,
};
