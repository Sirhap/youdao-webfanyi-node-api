import { handleRequest } from "./luna.js";

/**
 * Worker entry. Only the default export is registered.
 * Named values belong in `luna.js`, because Workers treat entry-point exports as handlers.
 */
export default {
  /**
   * @param {Request} request
   * @param {{ GATEWAY_TOKEN?: string, YOUDAO_ORIGIN?: string, CORS_ORIGIN?: string }} env
   * @returns {Promise<Response>}
   */
  fetch(request, env) {
    return handleRequest(request, env);
  },
};
