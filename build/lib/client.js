"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var client_exports = {};
__export(client_exports, {
  ApiError: () => ApiError,
  PfSenseClient: () => PfSenseClient,
  certFingerprint: () => certFingerprint,
  fetchFingerprint: () => fetchFingerprint,
  normalizeFingerprint: () => normalizeFingerprint,
  parseResponse: () => parseResponse
});
module.exports = __toCommonJS(client_exports);
var import_node_crypto = require("node:crypto");
var http = __toESM(require("node:http"));
var https = __toESM(require("node:https"));
var import_node_net = require("node:net");
var tls = __toESM(require("node:tls"));
class ApiError extends Error {
  /**
   * @param kind - failure category
   * @param message - human-readable reason
   * @param status - HTTP status, when there was a response
   * @param apiCode - response id from the API envelope
   */
  constructor(kind, message, status, apiCode) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.apiCode = apiCode;
    this.name = "ApiError";
  }
  /** True for failures that mean the firewall as a whole is unreachable or unusable. */
  get isConnectionLevel() {
    return this.kind === "network" || this.kind === "timeout" || this.kind === "tls" || this.kind === "auth" || this.kind === "noApi";
  }
}
function normalizeFingerprint(fp) {
  var _a, _b;
  const hex = fp.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  return (_b = (_a = hex.match(/.{1,2}/g)) == null ? void 0 : _a.join(":")) != null ? _b : "";
}
function certFingerprint(raw) {
  return normalizeFingerprint((0, import_node_crypto.createHash)("sha256").update(raw).digest("hex"));
}
class PinnedAgent extends https.Agent {
  constructor(expected) {
    super({ keepAlive: true, maxSockets: 2 });
    this.expected = expected;
  }
  // Asynchronous form of createConnection: returning undefined makes the agent wait for the callback.
  createConnection(options, callback) {
    const socket = tls.connect({ ...options, rejectUnauthorized: false });
    const onError = (err) => callback(err);
    socket.once("error", onError);
    socket.once("secureConnect", () => {
      socket.removeListener("error", onError);
      const actual = certFingerprint(socket.getPeerCertificate().raw);
      if (actual !== this.expected) {
        socket.destroy();
        callback(
          new ApiError(
            "tls",
            `Certificate fingerprint mismatch: the firewall presented ${actual}, the configuration expects ${this.expected}`
          )
        );
        return;
      }
      callback(null, socket);
    });
    return void 0;
  }
}
class PfSenseClient {
  /** @param opts - connection settings */
  constructor(opts) {
    this.opts = opts;
    if (opts.protocol === "http") {
      this.agent = new http.Agent({ keepAlive: true, maxSockets: 2 });
    } else if (opts.tlsMode === "fingerprint") {
      this.agent = new PinnedAgent(normalizeFingerprint(opts.fingerprint));
    } else {
      this.agent = new https.Agent({
        keepAlive: true,
        maxSockets: 2,
        // Only when the user explicitly picked "do not verify" in the instance settings.
        rejectUnauthorized: opts.tlsMode !== "insecure"
      });
    }
  }
  agent;
  closed = false;
  /** GET a resource; resolves the `data` field of the envelope. */
  get(path, query) {
    return this.request("GET", path, query);
  }
  /** POST a JSON body; resolves the `data` field of the envelope. */
  post(path, body = {}) {
    return this.request("POST", path, void 0, body);
  }
  /** PATCH a resource with a JSON body; resolves the `data` field of the envelope. */
  patch(path, body) {
    return this.request("PATCH", path, void 0, body);
  }
  /** Closes kept-alive sockets. Further requests fail. */
  close() {
    this.closed = true;
    this.agent.destroy();
  }
  request(method, path, query, body) {
    if (this.closed) {
      return Promise.reject(new ApiError("network", "Client closed"));
    }
    const qs = query ? `?${new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString()}` : "";
    const payload = body === void 0 ? void 0 : Buffer.from(JSON.stringify(body));
    const headers = { Accept: "application/json" };
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = payload.length;
    }
    if (this.opts.auth.kind === "key") {
      headers["X-API-Key"] = this.opts.auth.apiKey;
    } else {
      const token = Buffer.from(`${this.opts.auth.username}:${this.opts.auth.password}`).toString("base64");
      headers.Authorization = `Basic ${token}`;
    }
    const transport = this.opts.protocol === "http" ? http : https;
    return new Promise((resolve, reject) => {
      const req = transport.request(
        {
          host: this.opts.host,
          port: this.opts.port,
          method,
          path: `${path}${qs}`,
          headers,
          agent: this.agent,
          timeout: this.opts.timeoutMs,
          signal: AbortSignal.timeout(this.opts.timeoutMs)
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("error", (err) => reject(classifyNetworkError(err)));
          res.on("end", () => {
            var _a;
            try {
              resolve(parseResponse((_a = res.statusCode) != null ? _a : 0, Buffer.concat(chunks).toString("utf8")));
            } catch (err) {
              reject(err instanceof Error ? err : new Error(String(err)));
            }
          });
        }
      );
      req.on("timeout", () => req.destroy(new ApiError("timeout", `No answer within ${this.opts.timeoutMs} ms`)));
      req.on("error", (err) => reject(classifyNetworkError(err)));
      if (payload) {
        req.write(payload);
      }
      req.end();
    });
  }
}
function parseResponse(status, text) {
  let env;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && "code" in parsed && "data" in parsed) {
      env = parsed;
    }
  } catch {
  }
  if (!env) {
    if (status === 401 || status === 403) {
      return fail("auth", status, "Authentication rejected");
    }
    if (status >= 500) {
      return fail("server", status, `Server error (HTTP ${status})`);
    }
    throw new ApiError(
      "noApi",
      `No REST API answer (HTTP ${status}). Is the pfSense REST API package installed and enabled?`,
      status
    );
  }
  if (status >= 200 && status < 300) {
    return env.data;
  }
  const msg = env.message || env.status || `HTTP ${status}`;
  switch (status) {
    case 401:
      return fail("auth", status, msg, env.response_id);
    case 403:
      return fail("forbidden", status, msg, env.response_id);
    case 404:
      return fail("notFound", status, msg, env.response_id);
    case 424:
      return fail("dependency", status, msg, env.response_id);
    default:
      return fail(status >= 500 ? "server" : "validation", status, msg, env.response_id);
  }
}
function fail(kind, status, message, apiCode) {
  throw new ApiError(kind, message, status, apiCode);
}
function classifyNetworkError(err) {
  var _a;
  if (err instanceof ApiError) {
    return err;
  }
  if (err.name === "TimeoutError" || err.name === "AbortError") {
    return new ApiError("timeout", "Request timed out");
  }
  const code = (_a = err.code) != null ? _a : "";
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/i.test(code) || /certificate/i.test(err.message)) {
    return new ApiError(
      "tls",
      `TLS check failed (${code || err.message}). For a self-signed certificate use the fingerprint option.`
    );
  }
  return new ApiError("network", `${code ? `${code}: ` : ""}${err.message}`);
}
function fetchFingerprint(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host,
      port,
      servername: (0, import_node_net.isIP)(host) ? void 0 : host,
      // Nothing is ever sent on this socket: it only reads the certificate so the user can compare and pin it.
      // Verification cannot be on here, because reading an untrusted (self-signed) certificate is the purpose.
      rejectUnauthorized: false
    });
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error(`No TLS handshake within ${timeoutMs} ms`)));
    socket.once("secureConnect", () => {
      const fp = certFingerprint(socket.getPeerCertificate().raw);
      socket.end();
      resolve(fp);
    });
    socket.once("error", reject);
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ApiError,
  PfSenseClient,
  certFingerprint,
  fetchFingerprint,
  normalizeFingerprint,
  parseResponse
});
//# sourceMappingURL=client.js.map
