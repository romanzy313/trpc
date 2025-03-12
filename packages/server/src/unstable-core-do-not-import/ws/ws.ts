// "core" implementation here

/**
 * TODO List:
 * - [ ] Implement ws adapter
 * - [ ] Implement keep-alive functionality
 * - [ ] Add timeout for initial context resolution to prevent DOS
 * - [ ] Add client state checking capability on WsConnection (readyState equivalent)
 * - [ ] Review and document protocol changes to account for context resolution acknowledgment behavior
 * - [ ] Discuss and implement WebSocket close codes interpretation according to RFC6455
 * - [ ] Add proper types for 'link_initialized' message to the protocol, implement in WsLink
 * - [ ] Fix import paths
 * - [ ] Add examples for different WebSocket server implementations
 */

import { callTRPCProcedure } from '@trpc/server/@trpc/server';
import type { NodeHTTPCreateContextFnOptions } from '@trpc/server/adapters/node-http';
import {
  isObservable,
  observableToAsyncIterable,
} from '@trpc/server/observable';
import {
  iteratorResource,
  parseTRPCMessage,
  Unpromise,
} from '@trpc/server/unstable-core-do-not-import';
import { getErrorShape } from '../error/getErrorShape';
import { getTRPCErrorFromUnknown, TRPCError } from '../error/TRPCError';
import { parseConnectionParamsFromUnknown } from '../http/parseConnectionParams';
import type { BaseHandlerOptions } from '../http/types';
import type { CreateContextCallback } from '../rootConfig';
import type { AnyRouter, inferRouterContext } from '../router';
import type {
  TRPCClientOutgoingMessage,
  TRPCConnectionParamsMessage,
  TRPCReconnectNotification,
  TRPCResponseMessage,
  TRPCResultMessage,
} from '../rpc';
import { isTrackedEnvelope } from '../stream/tracked';
import { transformTRPCResponse } from '../transformer';
import type { MaybePromise } from '../types';
import { isAsyncIterable, isObject, run } from '../utils';

/**
 * @public
 */
export type CreateWSSContextFnOptions = NodeHTTPCreateContextFnOptions<
  Request,
  WsClient
>;

/**
 * @public
 */
export type CreateWSSContextFn<TRouter extends AnyRouter> = (
  opts: CreateWSSContextFnOptions,
) => MaybePromise<inferRouterContext<TRouter>>;

export type WSConnectionHandlerOptions<TRouter extends AnyRouter> =
  BaseHandlerOptions<TRouter, Request> &
    CreateContextCallback<
      inferRouterContext<TRouter>,
      CreateWSSContextFn<TRouter>
    >;

/**
 * Web socket server handler
 */
export type WSHandlerOptions<TRouter extends AnyRouter> =
  WSConnectionHandlerOptions<TRouter> & {
    // server does not leak its implementation here
    // this domain only handles tRPC websocket protocol
    // wss: ws.WebSocketServer;
    prefix?: string;
    keepAlive?: {
      /**
       * Enable heartbeat messages
       * @default false
       */
      enabled: boolean;
      /**
       * Heartbeat interval in milliseconds
       * @default 30_000
       */
      pingMs?: number;
      /**
       * Terminate the WebSocket if no pong is received after this many milliseconds
       * @default 5_000
       */
      pongWaitMs?: number;
    };
    /**
     * Disable responding to ping messages from the client
     * **Not recommended** - this is mainly used for testing
     * @default false
     */
    dangerouslyDisablePong?: boolean;
  };

// this conforms to `ws.WebSocket`
// but doesnt involve any listeners
export interface WsClient {
  // instead can use BufferLike from "@types/ws"
  send(message: string): void;
  close(code?: number, data?: string | Buffer): void;
  terminate(): void;
}

// used when context resolution is handled during upgrade phase
// probably not a good idea
// interface _UpgradeResult {
//   clientId: number;

//   secWebSocketKey: string;
//   secWebSocketProtocol: string;
//   secWebSocketExtensions: string;
// }

// this is what is returned from the handler
interface WsConnection {
  // use only when connection params are handled during upgrade
  // onUpgrade(req: Request): Promise<_UpgradeResult>;
  onMessage(rawData: string): Promise<void>;
  onClose(code: number): void;
  onError(cause: Error): void;
}

interface WsHandler {
  newConnection(req: Request, wsClient: WsClient): WsConnection;
  broadcastReconnectNotification(): void;
}

const CONTEXT_STATE_NOT_RESOLVED = 0;
const CONTEXT_STATE_RESOLVING = 1;
const CONTEXT_STATE_RESOLVED = 2;

export function newWsHandler<TRouter extends AnyRouter>(
  opts: WSHandlerOptions<TRouter>,
): WsHandler {
  const { createContext, router } = opts;
  const { transformer } = router._def._config;

  const clients = new Set<WsClient>();

  return {
    newConnection(req, client): WsConnection {
      clients.add(client);

      const clientSubscriptions = new Map<number | string, AbortController>();
      const abortController = new AbortController();

      // TODO
      // if (opts.keepAlive?.enabled) {
      //   const { pingMs, pongWaitMs } = opts.keepAlive;
      //   handleKeepAlive(client, pingMs, pongWaitMs);
      // }

      function respond(untransformedJSON: TRPCResponseMessage) {
        client.send(
          JSON.stringify(
            transformTRPCResponse(router._def._config, untransformedJSON),
          ),
        );
      }

      function getConnectionParams(msgStr: string) {
        let msg;
        try {
          msg = JSON.parse(msgStr) as TRPCConnectionParamsMessage;

          if (!isObject(msg)) {
            throw new Error('Message was not an object');
          }
        } catch (cause) {
          throw new TRPCError({
            code: 'PARSE_ERROR',
            message: `Malformed TRPCConnectionParamsMessage`,
            cause,
          });
        }

        const connectionParams = parseConnectionParamsFromUnknown(msg.data);

        return connectionParams;
      }

      // this an enum. 0 - not resolved, 1 - resolving, 2 - resolved
      // if client misbehaves we terminate it
      // a timemout to the first message must be set to prevent DDOS.
      // for more complexity, could be done during update.
      // Not to ws standard, but everyone is going, so we are going to do it too
      let contextResolved = CONTEXT_STATE_NOT_RESOLVED;
      let ctx: inferRouterContext<TRouter> | undefined = undefined;

      async function resolveContext(rawData: string) {
        contextResolved = CONTEXT_STATE_RESOLVING;

        try {
          ctx = await createContext?.({
            req,
            res: client,
            info: {
              connectionParams: getConnectionParams(rawData),
              calls: [],
              isBatchCall: false,
              accept: null,
              type: 'unknown',
              signal: abortController.signal,
              url: null,
            },
          });
          contextResolved = CONTEXT_STATE_RESOLVED;

          respond({
            id: -1,
            jsonrpc: '2.0',
            result: {
              type: 'link_initialized' as any,
            },
          });
        } catch (cause) {
          const error = getTRPCErrorFromUnknown(cause);
          opts.onError?.({
            error,
            path: undefined,
            type: 'unknown',
            ctx,
            req,
            input: undefined,
          });
          respond({
            id: null,
            error: getErrorShape({
              config: router._def._config,
              error,
              type: 'unknown',
              path: undefined,
              input: undefined,
              ctx,
            }),
          });
          // close in next tick
          // this needs testing with various backends
          (globalThis.setImmediate ?? globalThis.setTimeout)(() => {
            client.close();
          });
          // dont rethrow though?
          // throw error;
        }
      }

      async function handleRequest(msg: TRPCClientOutgoingMessage) {
        const { id, jsonrpc } = msg;

        /* istanbul ignore next -- @preserve */
        if (id === null) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: '`id` is required',
          });
        }
        if (msg.method === 'subscription.stop') {
          clientSubscriptions.get(id)?.abort();
          return;
        }
        const { path, lastEventId } = msg.params;
        let { input } = msg.params;
        const type = msg.method;
        try {
          if (lastEventId !== undefined) {
            if (isObject(input)) {
              input = {
                ...input,
                lastEventId: lastEventId,
              };
            } else {
              input ??= {
                lastEventId: lastEventId,
              };
            }
          }

          const abortController = new AbortController();
          const result = await callTRPCProcedure({
            router,
            path,
            getRawInput: async () => input,
            ctx,
            type,
            signal: abortController.signal,
          });

          const isIterableResult =
            isAsyncIterable(result) || isObservable(result);

          if (type !== 'subscription') {
            if (isIterableResult) {
              throw new TRPCError({
                code: 'UNSUPPORTED_MEDIA_TYPE',
                message: `Cannot return an async iterable or observable from a ${type} procedure with WebSockets`,
              });
            }
            // send the value as data if the method is not a subscription
            respond({
              id,
              jsonrpc,
              result: {
                type: 'data',
                data: result,
              },
            });
            return;
          }

          if (!isIterableResult) {
            throw new TRPCError({
              message: `Subscription ${path} did not return an observable or a AsyncGenerator`,
              code: 'INTERNAL_SERVER_ERROR',
            });
          }

          // TODO: add ability to query client status
          /* istanbul ignore next -- @preserve */
          // if (client.readyState !== WEBSOCKET_OPEN) {
          //   // if the client got disconnected whilst initializing the subscription
          //   // no need to send stopped message if the client is disconnected

          //   return;
          // }

          /* istanbul ignore next -- @preserve */
          if (clientSubscriptions.has(id)) {
            // duplicate request ids for client

            throw new TRPCError({
              message: `Duplicate id ${id}`,
              code: 'BAD_REQUEST',
            });
          }

          const iterable = isObservable(result)
            ? observableToAsyncIterable(result, abortController.signal)
            : result;

          run(async () => {
            await using iterator = iteratorResource(iterable);

            const abortPromise = new Promise<'abort'>((resolve) => {
              abortController.signal.onabort = () => resolve('abort');
            });
            // We need those declarations outside the loop for garbage collection reasons. If they
            // were declared inside, they would not be freed until the next value is present.
            let next:
              | null
              | TRPCError
              | Awaited<
                  typeof abortPromise | ReturnType<(typeof iterator)['next']>
                >;
            let result: null | TRPCResultMessage<unknown>['result'];

            while (true) {
              next = await Unpromise.race([
                iterator.next().catch(getTRPCErrorFromUnknown),
                abortPromise,
              ]);

              if (next === 'abort') {
                await iterator.return?.();
                break;
              }
              if (next instanceof Error) {
                const error = getTRPCErrorFromUnknown(next);
                opts.onError?.({ error, path, type, ctx, req, input });
                respond({
                  id,
                  jsonrpc,
                  error: getErrorShape({
                    config: router._def._config,
                    error,
                    type,
                    path,
                    input,
                    ctx,
                  }),
                });
                break;
              }
              if (next.done) {
                break;
              }

              result = {
                type: 'data',
                data: next.value,
              };

              if (isTrackedEnvelope(next.value)) {
                const [id, data] = next.value;
                result.id = id;
                result.data = {
                  id,
                  data,
                };
              }

              respond({
                id,
                jsonrpc,
                result,
              });

              // free up references for garbage collection
              next = null;
              result = null;
            }

            respond({
              id,
              jsonrpc,
              result: {
                type: 'stopped',
              },
            });
            clientSubscriptions.delete(id);
          }).catch((cause) => {
            const error = getTRPCErrorFromUnknown(cause);
            opts.onError?.({ error, path, type, ctx, req, input });
            respond({
              id,
              jsonrpc,
              error: getErrorShape({
                config: router._def._config,
                error,
                type,
                path,
                input,
                ctx,
              }),
            });
            abortController.abort();
          });
          clientSubscriptions.set(id, abortController);

          respond({
            id,
            jsonrpc,
            result: {
              type: 'started',
            },
          });
        } catch (cause) /* istanbul ignore next -- @preserve */ {
          // procedure threw an error
          const error = getTRPCErrorFromUnknown(cause);
          opts.onError?.({ error, path, type, ctx, req, input });
          respond({
            id,
            jsonrpc,
            error: getErrorShape({
              config: router._def._config,
              error,
              type,
              path,
              input,
              ctx,
            }),
          });
        }
      }

      return {
        async onMessage(msgStr) {
          if (msgStr === 'PONG') {
            return;
          }
          if (msgStr === 'PING') {
            if (!opts.dangerouslyDisablePong) {
              // TODO: also do all the timeouts in here
              client.send('PONG');
            }
            return;
          }

          // first message MUST be TRPCRequestInfo['connectionParams'] for context resolution.
          // empty message is sent if user doesn't use it.
          // wsLink must not send ANY messages during this to prevent races.
          // the ack that context is resolved is the
          // normal message handling
          if (contextResolved === CONTEXT_STATE_NOT_RESOLVED) {
            await resolveContext(msgStr);
          } else if (contextResolved === CONTEXT_STATE_RESOLVING) {
            // protocol violation, terminate the connection
            client.terminate();
            return;
          }
          // otherwise just handle the message

          try {
            const msgJSON: unknown = JSON.parse(msgStr);
            const msgs: unknown[] = Array.isArray(msgJSON)
              ? msgJSON
              : [msgJSON];
            const promises = msgs
              .map((raw) => parseTRPCMessage(raw, transformer))
              .map(handleRequest);
            await Promise.all(promises);
          } catch (cause) {
            const error = new TRPCError({
              code: 'PARSE_ERROR',
              cause,
            });

            respond({
              id: null,
              error: getErrorShape({
                config: router._def._config,
                error,
                type: 'unknown',
                path: undefined,
                input: undefined,
                ctx: undefined,
              }),
            });
          }
        },
        onClose(code) {
          // TODO: interpret code. maybe define some concrete values here
          // in accordance with https://datatracker.ietf.org/doc/html/rfc6455#section-7.4
          // or atleast interpret 1000 as normal, and other codes as abnormal
          const _ = code;
          for (const sub of clientSubscriptions.values()) {
            sub.abort();
          }
          clientSubscriptions.clear();
          abortController.abort();
        },
        onError(cause) {
          opts.onError?.({
            ctx,
            error: getTRPCErrorFromUnknown(cause),
            input: undefined,
            path: undefined,
            type: 'unknown',
            req,
          });
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
