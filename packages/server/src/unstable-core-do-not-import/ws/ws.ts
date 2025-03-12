// "core" implementation here

import type { TRPCRequestInfo } from '../http/types';
import type { AnyRouter, inferRouterContext } from '../router';
import type { TRPCReconnectNotification } from '../rpc';

// used when context resolution is handled during upgrade phase
// probably not a good idea
interface UpgradeResult {
  clientId: number;

  secWebSocketKey: string;
  secWebSocketProtocol: string;
  secWebSocketExtensions: string;
}

// this conforms to `ws.WebSocket`
// but doesnt involve any listeners
interface WsClient {
  // instead can use BufferLike from "@types/ws"
  send(message: string): void;
  close(code?: number, data?: string | Buffer): void;
  terminate(): void;
}

// this is what is returned from the handler
interface WsConnection {
  // use only when connection params are handled during upgrade
  onMessage(data: string): void;
  onClose(code: number): void;
}

interface TopHandler {
  newConnection(req: Request, wsClient: WsClient): WsConnection;
  broadcastReconnectNotification(): void;
}

// this is the global one
export function applyWsHandler<TRouter extends AnyRouter>(): TopHandler {
  const clients = new Set<WsClient>();

  return {
    newConnection(req, wsClient): WsConnection {
      clients.add(wsClient);

      const subscriptions = new Map<number | string, AbortController>();
      const abortController = new AbortController();

      // this an enum. 0 - not resolved, 1 - resolving, 2 - resolved
      // if client misbehaves we terminate it
      // a timemout to the first message must be set to prevent DDOS.
      // for more complexity, could be done during update.
      // Not to ws standard, but everyone is going, so we are going to do it too
      let contextResolved = 0;
      let ctx: inferRouterContext<TRouter> | undefined = undefined;

      return {
        onMessage(data) {
          // first message MUST be TRPCRequestInfo['connectionParams'] for context resolution.
          // empty message is sent if user doesn't use it.
          // wsLink must not send ANY messages during this to prevent races.
          // the ack that context is resolved is the

          if (contextResolved === 0) {
            contextResolved = 1;

            // do async work set contextResolved to 2
            // createContext?.().then(() => {
            //   contextResolved = 2;
            //respond({
            //   id,
            //   jsonrpc,
            //   result: {
            //     type: 'started',
            //   },
            //  });
            //})
            return;
          } else if (contextResolved === 1) {
            // terminate the connection, protocol violation
            wsClient.terminate();
            return;
          }

          // normal message handling
        },
        onClose(code) {
          //
        },
        onError(cause) {
          //
        },
      };
    },
    broadcastReconnectNotification() {
      const response: TRPCReconnectNotification = {
        id: null,
        method: 'reconnect',
      };
      const data = JSON.stringify(response);
      for (const client of clients) {
        client.send(data);
      }
    },
  };
}
