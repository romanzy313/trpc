/**
 * If you're making an adapter for tRPC and looking at this file for reference, you should import types and functions from `@trpc/server` and `@trpc/server/http`
 *
 * @example
 * ```ts
 * import type { AnyTRPCRouter } from '@trpc/server'
 * import type { HTTPBaseHandlerOptions } from '@trpc/server/http'
 * ```
 */
/// <reference types="@fastify/websocket" />
import { type IncomingMessage } from 'http';
// @trpc/server/ws
// eslint-disable-next-line no-restricted-imports
import {
  newWsHandler,
  type WsClient,
  type WSHandlerOptions,
} from '@trpc/server/unstable-core-do-not-import/ws/ws';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
// @trpc/server
import type { AnyRouter } from '../../@trpc/server';
// @trpc/server/http
import {
  incomingMessageToRequestWithoutBody,
  type NodeHTTPCreateContextFnOptions,
} from '../node-http';
import type { FastifyHandlerOptions } from './fastifyRequestHandler';
import { fastifyRequestHandler } from './fastifyRequestHandler';

export interface FastifyTRPCPluginOptions<TRouter extends AnyRouter> {
  prefix?: string;
  useWSS?: boolean;
  trpcOptions: FastifyHandlerOptions<TRouter, FastifyRequest, FastifyReply>;
}

export type CreateFastifyContextOptions = NodeHTTPCreateContextFnOptions<
  FastifyRequest,
  FastifyReply
>;

export function fastifyTRPCPlugin<TRouter extends AnyRouter>(
  fastify: FastifyInstance,
  opts: FastifyTRPCPluginOptions<TRouter>,
  done: (err?: Error) => void,
) {
  fastify.removeContentTypeParser('application/json');
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    function (_, body, _done) {
      _done(null, body);
    },
  );

  let prefix = opts.prefix ?? '';

  // https://github.com/fastify/fastify-plugin/blob/fe079bef6557a83794bf437e14b9b9edb8a74104/plugin.js#L11
  // @ts-expect-error property 'default' does not exists on type ...
  if (typeof fastifyTRPCPlugin.default !== 'function') {
    prefix = ''; // handled by fastify internally
  }

  fastify.all(`${prefix}/:path`, async (req, res) => {
    const path = (req.params as any).path;
    await fastifyRequestHandler({ ...opts.trpcOptions, req, res, path });
  });

  if (opts.useWSS) {
    const trpcOptions =
      opts.trpcOptions as unknown as WSHandlerOptions<TRouter>;

    const handler = newWsHandler({
      ...trpcOptions,
    });

    fastify.get(prefix ?? '/', { websocket: true }, async (socket, req) => {
      const incomingMessage: IncomingMessage = req.raw;

      const fetchReq = incomingMessageToRequestWithoutBody(incomingMessage);

      const wsClient = socket satisfies WsClient;
      const connection = handler.newConnection(fetchReq, wsClient);

      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      socket.on('message', (data) => connection.onMessage(data.toString()));
      socket.on('error', (cause) => connection.onError(cause));
      socket.on('close', (code) => connection.onClose(code));
    });
  }

  done();
}
