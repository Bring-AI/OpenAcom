/** Pure, instance-scoped embedded communication. No automatic retries. */
export interface SessionRef {
  id: string; title?: string; agent?: string; mtime?: number;
  address?: string; workspace?: string; worktreeId?: string; branch?: string;
  updatedAt?: number | null; status?: string;
}
export interface Turn { role: string; text: string }
export type SendStatus = 'accepted' | 'refused' | 'uncertain';
/** accepted never proves that the model read or completed a task. */
export interface SendResult { messageId: string; status: SendStatus; code?: string; detail?: string }
export interface SendOpts {
  /** Forwarded unchanged as both id and requestId. Conflicting values are rejected. */
  id?: string; requestId?: string; from?: string | null; timeoutMs?: number;
  mode?: 'submit' | 'draft'; consent?: boolean; desktop?: boolean;
  [key: string]: unknown;
}
/** Host owns routing and execution, including SSH. No default adapter fallback. */
export interface SessionAdapter<TSession extends SessionRef = SessionRef, TRead = Turn[]> {
  name: string;
  list(opts?: { limit?: number; query?: string }): TSession[] | Promise<TSession[]>;
  read(sessionId: string, opts?: { last?: number }): TRead | Promise<TRead>;
  send(sessionId: string, text: string, opts: SendOpts): unknown | Promise<unknown>;
}
export type ParsedAddress =
  | { kind: 'session'; agent?: string; sessionId: string; [key: string]: unknown }
  | { kind: 'node'; nodeId: string; target: string; [key: string]: unknown };
export type AddressResolver = (address: string) => ParsedAddress | null | undefined;
export interface HistoryEntry extends SendResult {
  /** Sender address supplied by the host; omitted if unknown. */
  from?: string | null;
  /** Receiver address supplied to send. */
  to: string;
  /** Unix time in milliseconds when send was called. */
  at: number;
  bytes: number;
  /** First 12 hexadecimal characters of SHA-256 of the complete body. */
  sha12: string;
  /** Owned copy of at most 2000 UTF-16 code units. */
  textPreview: string;
  truncated: boolean;
}
export interface ClientOptions<TSession extends SessionRef = SessionRef, TRead = Turn[]> {
  adapter?: SessionAdapter<TSession, TRead>;
  addressResolver?: AddressResolver | AddressResolver[];
  /** Default 200; 0 disables retention; maximum 10000. */
  historyLimit?: number;
  from?: string | null;
  /** Reserved host metadata. Custom home with built-in sessions is refused. */
  home?: string;
}
export interface ServiceOptions<TSession extends SessionRef = SessionRef, TRead = Turn[]> extends ClientOptions<TSession, TRead> {
  /** Instance-scoped relay connection; omitted values use legacy environment defaults. */
  url?: string;
  token?: string;
}
export interface HistoryFilter { from?: string | null; to?: string; status?: SendStatus; code?: string }
export interface Client<TSession extends SessionRef = SessionRef, TRead = Turn[]> {
  send(to: string, text: string, opts?: SendOpts): Promise<HistoryEntry>;
  list(opts?: { limit?: number; query?: string; agent?: string }): Promise<TSession[]>;
  read(sessionId: string, opts?: { last?: number; agent?: string }): Promise<TRead>;
  history(filter?: HistoryFilter): HistoryEntry[];
  /** Idempotent. Clears history, rejects new work; does not stop host sessions or in-flight sends. */
  dispose(): Promise<void>;
  readonly disposed: boolean;
}
export interface CommunicationService<TSession extends SessionRef = SessionRef, TRead = Turn[]> extends Client<TSession, TRead> {
  relayNodes(): Promise<unknown>;
  relayStatus(id: string): Promise<unknown>;
}
export declare function createClient<TSession extends SessionRef = SessionRef, TRead = Turn[]>(opts?: ClientOptions<TSession, TRead>): Client<TSession, TRead>;
export declare function createCommunicationService<TSession extends SessionRef = SessionRef, TRead = Turn[]>(opts?: ServiceOptions<TSession, TRead>): CommunicationService<TSession, TRead>;
export declare function parseAddress(address: string, resolvers?: AddressResolver[]): ParsedAddress;
export declare const DEFAULT_HISTORY_LIMIT: 200;
export declare const DEFAULT_PREVIEW_LIMIT: 2000;

