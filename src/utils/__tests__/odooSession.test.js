// Tests for the Odoo session guard — an expired session makes a multi-DB Odoo
// answer call_kw with a bare 404; the guard must re-login and retry once.

import AsyncStorage from '@react-native-async-storage/async-storage';
import axios, { AxiosError } from 'axios';
import { setOdooBaseUrl } from '@api/config/odooConfig';
import {
  installOdooSessionGuard,
  reauthenticateOdoo,
  SESSION_EXPIRED_MESSAGE,
} from '../odooSession';

const BASE = 'https://odoo.test';
const DB = 'LIVE_DB';
const CALL_KW = `${BASE}/web/dataset/call_kw`;
const RPC = { jsonrpc: '2.0', method: 'call', params: { model: 'hr.employee', method: 'search_read', args: [[]] } };

const OLD_COOKIE = 'session_id=old123; Path=/';
const NEW_COOKIE = 'session_id=new456; Path=/';

// Fake server: a session is valid only if it is in `validSids`.
let validSids;
let authCalls;
let authOk;

const sidOf = (cookie) => (String(cookie || '').match(/session_id=([^;,\s]+)/) || [])[1];

const respond = (config, status, data, headers = {}) => {
  const response = { data, status, statusText: String(status), headers, config, request: {} };
  if (status >= 400) {
    return Promise.reject(new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_REQUEST', config, {}, response));
  }
  return Promise.resolve(response);
};

const adapter = (config) => {
  if (config.url === `${BASE}/web/session/authenticate`) {
    authCalls += 1;
    if (!authOk) return respond(config, 200, { jsonrpc: '2.0', error: { message: 'Access Denied' } });
    validSids.add('new456');
    return respond(config, 200, { jsonrpc: '2.0', result: { uid: 7 } }, { 'set-cookie': [NEW_COOKIE] });
  }
  if (config.url.startsWith(`${BASE}/web/image`)) return respond(config, 404, 'Not Found');
  const sid = sidOf(config.headers.get ? config.headers.get('Cookie') : config.headers.Cookie);
  if (!validSids.has(sid)) return respond(config, 404, '<html>Not Found</html>');
  return respond(config, 200, { jsonrpc: '2.0', result: [{ id: 1, name: 'Ali' }] });
};

const postRpc = async () => {
  const cookie = await AsyncStorage.getItem('odoo_cookie');
  return axios.post(CALL_KW, RPC, { headers: { 'Content-Type': 'application/json', Cookie: cookie } });
};

beforeAll(() => {
  axios.defaults.adapter = adapter;
  installOdooSessionGuard();
});

beforeEach(async () => {
  validSids = new Set();
  authCalls = 0;
  authOk = true;
  await AsyncStorage.clear();
  await setOdooBaseUrl(BASE);
  await AsyncStorage.multiSet([
    ['userData', JSON.stringify({ uid: 7 })],
    ['odoo_db', DB],
    ['odoo_cookie', OLD_COOKIE],
    ['saved_credentials', JSON.stringify({ [`${BASE}|${DB}`]: { username: 'ali', password: 'pw' } })],
  ]);
});

describe('odooSession guard', () => {
  test('valid session passes straight through', async () => {
    validSids.add('old123');
    const resp = await postRpc();
    expect(resp.data.result[0].name).toBe('Ali');
    expect(authCalls).toBe(0);
  });

  test('expired session 404 → re-login with saved credentials and retry once', async () => {
    const resp = await postRpc();
    expect(resp.data.result[0].name).toBe('Ali');
    expect(authCalls).toBe(1);
    expect(await AsyncStorage.getItem('odoo_cookie')).toBe(NEW_COOKIE);
  });

  test('parallel 404s share a single re-login', async () => {
    const results = await Promise.all([postRpc(), postRpc(), postRpc(), postRpc()]);
    results.forEach((r) => expect(r.data.result[0].name).toBe('Ali'));
    expect(authCalls).toBe(1);
  });

  test('re-login impossible → readable message instead of "status code 404"', async () => {
    authOk = false;
    await expect(postRpc()).rejects.toThrow(SESSION_EXPIRED_MESSAGE);
    expect(authCalls).toBe(1);
  });

  test('after logout (no userData / odoo_db) it never logs back in', async () => {
    await AsyncStorage.multiRemove(['userData', 'odoo_db', 'odoo_cookie']);
    await expect(postRpc()).rejects.toThrow(SESSION_EXPIRED_MESSAGE);
    expect(authCalls).toBe(0);
    expect(await reauthenticateOdoo()).toBeNull();
  });

  test('JSON-RPC SessionExpiredException is retried too', async () => {
    const original = axios.defaults.adapter;
    let first = true;
    axios.defaults.adapter = (config) => {
      if (config.url === CALL_KW && first) {
        first = false;
        return respond(config, 200, { jsonrpc: '2.0', error: { data: { name: 'odoo.http.SessionExpiredException' } } });
      }
      return adapter(config);
    };
    try {
      const resp = await postRpc();
      expect(resp.data.result[0].name).toBe('Ali');
      expect(authCalls).toBe(1);
    } finally {
      axios.defaults.adapter = original;
    }
  });

  test('stores a rotated session cookie from a successful call', async () => {
    const original = axios.defaults.adapter;
    axios.defaults.adapter = (config) =>
      respond(config, 200, { jsonrpc: '2.0', result: true }, { 'set-cookie': ['session_id=rot789; Path=/'] });
    try {
      await postRpc();
      expect(await AsyncStorage.getItem('odoo_cookie')).toBe('session_id=rot789; Path=/');
    } finally {
      axios.defaults.adapter = original;
    }
  });

  test('a JSON-RPC 404 (missing model on a live session) is not a lost session', async () => {
    axios.defaults.adapter = (config) =>
      respond(config, 404, { jsonrpc: '2.0', error: { code: 404, message: '404: Not Found' } });
    try {
      await expect(postRpc()).rejects.toThrow('status code 404');
      expect(authCalls).toBe(0);
    } finally {
      axios.defaults.adapter = adapter;
    }
  });

  test('a 404 on a non-RPC GET (missing image) is left alone', async () => {
    await expect(axios.get(`${BASE}/web/image/res.partner/1/image_128`)).rejects.toThrow('status code 404');
    expect(authCalls).toBe(0);
  });

  test('requests to other servers are left alone', async () => {
    axios.defaults.adapter = (config) => respond(config, 404, 'nope');
    try {
      await expect(axios.post('https://other.test/web/dataset/call_kw', RPC)).rejects.toThrow('status code 404');
      expect(authCalls).toBe(0);
    } finally {
      axios.defaults.adapter = adapter;
    }
  });
});
