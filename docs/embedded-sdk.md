# Embedded SDK

`openacom/embedded` exports `createClient`, `createCommunicationService`,
`parseAddress`, `DEFAULT_HISTORY_LIMIT` (200), and `DEFAULT_PREVIEW_LIMIT` (2000).
The entry is CommonJS with TypeScript declarations and supports ESM named imports.
Importing it loads only Node crypto. Injected session operations do not load the
legacy SDK, native PTY bindings, session scanners, stores, or network clients.

```ts
import { createClient } from 'openacom/embedded'
const client = createClient({
  from: 'pi:sender',
  adapter: {
    name: 'host-runtime',
    list: () => runtime.listSessions(),
    read: (id, options) => runtime.readSession(id, options?.last),
    send: (id, text, options) => runtime.sendMessage(id, text, options.requestId),
  },
})
await client.send('omp:terminal-id', 'Review the patch', { requestId: 'request-42' })
const messages = client.history({ from: 'pi:sender' })
await client.dispose()
```

The host must map its runtime response to `{status: 'accepted' | 'refused' |
'uncertain', code?, detail?}`. `accepted` describes the adapter's confirmed
acceptance only; it never means model read or task completion. For compatibility,
raw `{accepted, prompt:{stages}}` receipts map explicit accepted:false to refused,
turn_started to accepted, and missing or other observed stages to uncertain. Plain text
responses are uncertain. A thrown error is uncertain unless it explicitly has
`uncertain:false`. There are no automatic retries. A relay queue acknowledgement
is uncertain with code RELAY_QUEUED; query relayStatus for durable hub state.

`id` and `requestId` are aliases, forwarded unchanged as both keys. Supplying
conflicting values fails before dispatch. Omitted IDs are UUIDs. The host owns
execution routing, including SSH. All harness names are supported with an injected
adapter. The SDK never falls back from an injected adapter to a local CLI.
Custom address resolvers must produce complete session or node addresses;
unsupported results are refused before dispatch.

Session and read result types are inferred through `SessionAdapter<TSession,
TRead>` and `Client<TSession,TRead>`. The SDK does not reshape list/read results.

History is an in-memory snapshot of completed send attempts, in completion order.
Fields: messageId, from (optional or null), to, at (send-start Unix milliseconds),
status, code/detail (optional), bytes (complete body UTF-8 length), sha12 (first
12 SHA-256 hexadecimal characters), textPreview, truncated. Previews own a copy
of at most 2000 UTF-16 code units; no complete body is retained. Detail is capped
at 500 and code at 200 code units. Sender/receiver strings are limited to 2000.
Default history capacity is 200; historyLimit accepts 0 through 10000, with 0
disabling retention. Queries and send results are independent shallow snapshots.
Filters support from, to, status, and code. History contains outbound calls made
through this instance; the host supplies sender identity and authenticates it.

Dispose is idempotent, clears history, and rejects all future operations except
repeated dispose and reading disposed. Already delegated sends can finish and
return a result, but do not repopulate history. Dispose does not terminate host
sessions, cancel host-owned work, or close host-owned adapters. The client owns
no timers/listeners and does not mutate HOME, environment, or adapter registries.

Without an injected adapter, local operations reuse the existing CLI/MCP SDK.
Legacy adapters do not support per-instance home roots; specifying home refuses
these local operations with HOME_UNSUPPORTED instead of scanning another home.
With an injected adapter, home is reserved metadata and has no storage effect.
Communication services reuse the shared relay SDK with instance url/token options;
if omitted, legacy AGENTRELAY_URL/AGENTRELAY_TOKEN defaults apply. For isolated
hosts, always specify the relay connection explicitly.

## Packaging and verification

Run `npm test`, then `npm pack`. Vendor the resulting versioned tgz in the host
repository and use a relative `file:vendor/openacom-0.12.3.tgz` dependency with a
committed lockfile. Do not use a developer checkout's absolute path. No npm
registry publication is implied. For an embedded-only installation, omit optional
dependencies (`npm install --omit=optional`); the native node-pty dependency is
only used by legacy terminal features. Electron should bundle `openacom/embedded`
or package its JS and declaration files; it needs no native-module rebuild.

Tests cover import isolation, instance ownership, raw and normalized receipt
semantics, unknown transport errors, unchanged request IDs, no retry/fallback,
bounded snapshots, custom addresses, service disposal, and a real HTTP relay
request using the shared SDK. Electron host startup remains a host integration
check, not a guarantee from this package's Node tests.

