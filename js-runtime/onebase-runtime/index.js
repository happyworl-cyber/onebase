'use strict';

/**
 * OneBase JavaScript workflow host API.
 *
 * IPC is newline-delimited JSON over the Unix-domain socket named by
 * ONEBASE_HOST_SOCK. Each request is `{id, op, args}` and receives exactly
 * one `{id, ok, result|error}` response line. The public functions are
 * synchronous so they match Lua builtin ergonomics; Node has no synchronous
 * Unix-socket client, so each call launches a tiny non-preloaded Node helper
 * that performs the asynchronous socket exchange and returns its result.
 */
const { spawnSync } = require('child_process');

const HELPER = String.raw`
const net = require('net');
const request = JSON.parse(Buffer.from(process.argv[1], 'base64').toString('utf8'));
const socket = net.createConnection(process.env.ONEBASE_HOST_SOCK);
let buffer = '';
socket.setEncoding('utf8');
socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
socket.on('data', (chunk) => {
  buffer += chunk;
  const newline = buffer.indexOf('\n');
  if (newline < 0) return;
  process.stdout.write(buffer.slice(0, newline));
  socket.destroy();
});
socket.on('error', (error) => {
  process.stderr.write(error.message);
  process.exitCode = 1;
});
`;

let nextId = 1;

function call(op, args) {
  if (!process.env.ONEBASE_HOST_SOCK) {
    throw new Error('ONEBASE_HOST_SOCK is not configured');
  }
  const request = Buffer.from(JSON.stringify({ id: String(nextId++), op, args }), 'utf8').toString('base64');
  const output = spawnSync(process.execPath, ['-e', HELPER, request], {
    env: process.env,
    encoding: 'utf8',
  });
  if (output.error) throw output.error;
  if (output.status !== 0) {
    throw new Error(`OneBase host IPC failed: ${(output.stderr || '').trim()}`);
  }
  let response;
  try {
    response = JSON.parse(output.stdout);
  } catch (error) {
    throw new Error(`OneBase host returned invalid JSON: ${error.message}`);
  }
  if (!response.ok) throw new Error(response.error || `OneBase host operation failed: ${op}`);
  return response.result;
}

function request(method, url, bodyOrOptions, maybeOptions) {
  const hasBody = method === 'post' || method === 'put';
  const body = hasBody ? bodyOrOptions : undefined;
  const options = hasBody ? maybeOptions : bodyOrOptions;
  return call(`http.${method}`, {
    url,
    ...(body === undefined ? {} : { body }),
    ...(options && options.headers ? { headers: options.headers } : {}),
    ...(options && options.timeout !== undefined ? { timeout: options.timeout } : {}),
  });
}

function installGlobal(name, value) {
  // Node 19+ exposes a read-only Web Crypto accessor on globalThis.crypto.
  // Configurable own properties let the workflow-compatible host API replace it.
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

installGlobal('env', { get: (key) => call('env.get', { key }) });
installGlobal('http', {
  get: (url, options) => request('get', url, options),
  post: (url, body, options) => request('post', url, body, options),
  put: (url, body, options) => request('put', url, body, options),
  delete: (url, options) => request('delete', url, options),
});
installGlobal('crypto', {
  sha256: (input) => call('crypto.sha256', { input }),
  hmac_sha256: (key, data) => call('crypto.hmac_sha256', { key, data }),
  uuid: () => call('crypto.uuid', {}),
  base64_encode: (input) => call('crypto.base64_encode', { input }),
  base64_decode: (input) => call('crypto.base64_decode', { input }),
  // Keep the Lua-compatible names visible while their JS bridge
  // implementations are deliberately rejected with the operation name.
  hmac_sha256_raw_key: (...args) => call('crypto.hmac_sha256_raw_key', { args }),
  random_hex: (...args) => call('crypto.random_hex', { args }),
  md5: (...args) => call('crypto.md5', { args }),
  sha1: (...args) => call('crypto.sha1', { args }),
  hmac_sha1: (...args) => call('crypto.hmac_sha1', { args }),
  aes_encrypt: (...args) => call('crypto.aes_encrypt', { args }),
  aes_decrypt: (...args) => call('crypto.aes_decrypt', { args }),
  rsa_encrypt: (...args) => call('crypto.rsa_encrypt', { args }),
  rsa_encrypt_oaep: (...args) => call('crypto.rsa_encrypt_oaep', { args }),
  rsa_decrypt: (...args) => call('crypto.rsa_decrypt', { args }),
  rsa_sign_sha256: (...args) => call('crypto.rsa_sign_sha256', { args }),
  base64url_encode: (...args) => call('crypto.base64url_encode', { args }),
});
installGlobal('log', ['info', 'warn', 'error', 'debug'].reduce((api, level) => {
  api[level] = (message) => call(`log.${level}`, { message });
  return api;
}, {}));
installGlobal('json', {
  encode: (value) => call('json.encode', { value }),
  encode_pretty: (value) => call('json.encode_pretty', { value }),
  decode: (input) => call('json.decode', { input }),
});
installGlobal('time', { now: () => call('time.now', {}), now_ms: () => call('time.now_ms', {}) });
installGlobal('sse', { publish: (topic, event, data) => call('sse.publish', { topic, event, data }) });
installGlobal('google', {
  sa_assertion: (project, scope) => call('google.sa_assertion', { project, scope }),
});
