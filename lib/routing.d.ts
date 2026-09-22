export type DeliveryRoute = 'auto' | 'session' | 'desktop' | 'desktopcdp' | 'relay' | 'mailbox';
export interface RoutedSendOptions {
  from: string;
  route?: DeliveryRoute;
  id?: string;
  requestId?: string;
  consent?: boolean;
  timeoutMs?: number;
  cdpPort?: number;
  cdpTargetId?: string;
  wait?: boolean;
  noSignature?: boolean;
  mode?: 'submit' | 'draft';
  url?: string;
  token?: string;
}
export interface RoutedSendResult {
  id: string;
  messageId: string;
  from: string;
  to: string;
  route: Exclude<DeliveryRoute, 'auto'>;
  status: 'stored' | 'queued' | 'accepted' | 'refused' | 'uncertain';
  code?: string;
  detail?: string;
  replayed?: boolean;
}
/** Persist first, attempt exactly one selected route. Same ID never sends twice. */
export declare function sendRouted(to: string, text: string, opts: RoutedSendOptions): Promise<RoutedSendResult>;

