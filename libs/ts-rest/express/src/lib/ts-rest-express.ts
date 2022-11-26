import { IRouter, Request, Response } from 'express';
import { IncomingHttpHeaders } from 'http';
import {
  AppRoute,
  AppRouteMutation,
  AppRouteQuery,
  AppRouter,
  isAppRoute,
  getValue,
  Without,
  ZodInferOrType,
  PathParams,
  checkZodSchema,
  Merge,
} from '@ts-rest/core';

export type ApiRouteResponse<T> = {
  [K in keyof T]: {
    status: K;
    body: ZodInferOrType<T[K]>;
  };
}[keyof T];

type AppRouteQueryImplementation<T extends AppRouteQuery> = (
  input: Without<
    {
      params: PathParamsWithZod<T>;
      query: ZodInferOrType<T['query']>;
      headers: IncomingHttpHeaders;
      req: Request;
    },
    never
  >
) => Promise<ApiRouteResponse<T['responses']>>;

type WithoutFileIfMultiPart<T extends AppRouteMutation> =
  T['contentType'] extends 'multipart/form-data'
    ? Without<ZodInferOrType<T['body']>, File>
    : ZodInferOrType<T['body']>;

/**
 * Merge PathParams<T> with pathParams schema if it exists
 */
type PathParamsWithZod<T extends AppRoute> = T['pathParams'] extends undefined
  ? PathParams<T>
  : Merge<PathParams<T>, ZodInferOrType<T['pathParams']>>;

type AppRouteMutationImplementation<T extends AppRouteMutation> = (
  input: Without<
    {
      params: PathParamsWithZod<T>;
      query: ZodInferOrType<T['query']>;
      body: WithoutFileIfMultiPart<T>;
      headers: IncomingHttpHeaders;
      files: unknown;
      file: unknown;
      req: Request;
    },
    never
  >
) => Promise<ApiRouteResponse<T['responses']>>;

type AppRouteImplementation<T extends AppRoute> = T extends AppRouteMutation
  ? AppRouteMutationImplementation<T>
  : T extends AppRouteQuery
  ? AppRouteQueryImplementation<T>
  : never;

type RecursiveRouterObj<T extends AppRouter> = {
  [TKey in keyof T]: T[TKey] extends AppRouter
    ? RecursiveRouterObj<T[TKey]>
    : T[TKey] extends AppRoute
    ? AppRouteImplementation<T[TKey]>
    : never;
};

export const initServer = () => {
  return {
    router: <T extends AppRouter>(router: T, args: RecursiveRouterObj<T>) =>
      args,
  };
};

const recursivelyApplyExpressRouter = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  router: RecursiveRouterObj<any> | AppRouteImplementation<any>,
  path: string[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  routeTransformer: (route: AppRouteImplementation<any>, path: string[]) => void
): void => {
  if (typeof router === 'object') {
    for (const key in router) {
      recursivelyApplyExpressRouter(
        router[key],
        [...path, key],
        routeTransformer
      );
    }
  } else if (typeof router === 'function') {
    routeTransformer(router, path);
  }
};

const transformAppRouteQueryImplementation = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  route: AppRouteQueryImplementation<any>,
  schema: AppRouteQuery,
  app: IRouter
) => {
  console.log(`[ts-rest] Initialized ${schema.method} ${schema.path}`);

  app.get(schema.path, async (req, res) => {
    const queryResult = checkZodSchema(req.query, schema.query);

    if (!queryResult.success) {
      return res.status(400).send(queryResult.error);
    }

    const paramsResult = checkZodSchema(req.params, schema.pathParams, {
      passThroughExtraKeys: true,
    });

    if (!paramsResult.success) {
      return res.status(400).send(paramsResult.error);
    }

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    const result = await route({
      // @ts-ignore
      params: paramsResult.data,
      query: queryResult.data,
      headers: req.headers,
      req: req,
    });

    return res.status(Number(result.status)).json(result.body);
  });
};

const transformAppRouteMutationImplementation = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  route: AppRouteMutationImplementation<any>,
  schema: AppRouteMutation,
  app: IRouter
) => {
  console.log(`[ts-rest] Initialized ${schema.method} ${schema.path}`);

  const method = schema.method;

  const callback = async (req: Request, res: Response) => {
    try {
      const queryResult = checkZodSchema(req.query, schema.query);

      if (!queryResult.success) {
        return res.status(400).send(queryResult.error);
      }

      const bodyResult = checkZodSchema(req.body, schema.body);

      if (!bodyResult.success) {
        return res.status(400).send(bodyResult.error);
      }

      const result = await route({
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        params: req.params,
        body: bodyResult.data,
        query: queryResult.data,
        headers: req.headers,
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        files: req.files,
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        file: req.file,
        req: req,
      });

      return res.status(Number(result.status)).json(result.body);
    } catch (e) {
      console.error(`[ts-rest] Error on ${method} ${schema.path}`, e);
      return res.status(500).send('Internal Server Error');
    }
  };

  switch (method) {
    case 'DELETE':
      app.delete(schema.path, callback);
      break;
    case 'POST':
      app.post(schema.path, callback);
      break;
    case 'PUT':
      app.put(schema.path, callback);
      break;
    case 'PATCH':
      app.patch(schema.path, callback);
      break;
  }
};

export const createExpressEndpoints = <
  T extends RecursiveRouterObj<TRouter>,
  TRouter extends AppRouter
>(
  schema: TRouter,
  router: T,
  app: IRouter
) => {
  recursivelyApplyExpressRouter(router, [], (route, path) => {
    const routerViaPath = getValue(schema, path.join('.'));

    if (!routerViaPath) {
      throw new Error(`[ts-rest] No router found for path ${path.join('.')}`);
    }

    if (isAppRoute(routerViaPath)) {
      if (routerViaPath.method !== 'GET') {
        transformAppRouteMutationImplementation(route, routerViaPath, app);
      } else {
        transformAppRouteQueryImplementation(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          route as AppRouteQueryImplementation<any>,
          routerViaPath,
          app
        );
      }
    } else {
      throw new Error(
        'Could not find schema route implementation for ' + path.join('.')
      );
    }
  });
};
