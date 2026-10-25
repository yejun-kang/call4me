/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as crons from "../crons.js";
import type * as http from "../http.js";
import type * as jev from "../jev.js";
import type * as jevWatch from "../jevWatch.js";
import type * as lib_auth from "../lib/auth.js";
import type * as live from "../live.js";
import type * as maintenance from "../maintenance.js";
import type * as managed from "../managed.js";
import type * as phone from "../phone.js";
import type * as site from "../site.js";
import type * as storage from "../storage.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  crons: typeof crons;
  http: typeof http;
  jev: typeof jev;
  jevWatch: typeof jevWatch;
  "lib/auth": typeof lib_auth;
  live: typeof live;
  maintenance: typeof maintenance;
  managed: typeof managed;
  phone: typeof phone;
  site: typeof site;
  storage: typeof storage;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
