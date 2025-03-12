/* eslint-disable no-restricted-imports */

import type ws from 'ws';
import type { AnyRouter } from '../unstable-core-do-not-import';
import {
  newWsHandler,
  type WsClient,
  type WSHandlerOptions,
} from '../unstable-core-do-not-import/ws/ws';
import { incomingMessageToRequestNoBody } from './node-http';

// import { incomingMessageToRequest } from './node-http';
// lighter version of the above

export type WSSHandlerOptions<TRouter extends AnyRouter> =
  WSHandlerOptions<TRouter> & {
    wss: ws.WebSocketServer;
  };

export function applyWSSHandlerV2<TRouter extends AnyRouter>(
  opts: WSSHandlerOptions<TRouter>,
) {
  // incomingMessageToRequest(req, res, opts);

  const handler = newWsHandler(opts);

  // const onConnection = getWSConnectionHandler(opts);
  opts.wss.on('connection', (client, req) => {
    if (opts.prefix && !req.url?.startsWith(opts.prefix)) {
      return;
    }

    const fetchReq = incomingMessageToRequestNoBody(req);
    const wsClient = client as WsClient;

    const connection = handler.newConnection(fetchReq, wsClient);

    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    client.on('message', (data) => connection.onMessage(data.toString()));
    client.on('error', (cause) => connection.onError(cause));
    client.on('close', (code) => connection.onClose(code));
  });
  return {
    broadcastReconnectNotification: () =>
      handler.broadcastReconnectNotification(),
  };
}
