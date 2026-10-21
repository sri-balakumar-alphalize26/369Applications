// src/utils/odooSession.js
//
// Keeps the stored Odoo session working for every axios call in the app.
//
// The app logs in once and replays the saved `odoo_cookie` on each request.
// When Odoo expires or rotates that session, the server can no longer tell
// which database the request belongs to. On a multi-database server Odoo then
// answers JSON-RPC routes like /web/dataset/call_kw with a bare HTTP 404
// (not a JSON "session expired" error), which screens used to show as
// "Request failed with status code 404".
//
// installOdooSessionGuard() adds one axios response interceptor that:
//   - re-logs in with the user's own saved credentials and retries the
//     request once when Odoo answers 404 or SessionExpired,
//   - saves the new session cookie whenever Odoo rotates it,
//   - turns an unrecoverable 404 into a readable "session expired" message.

import AsyncStorage from '@react-native-async-storage/async-storage';
import axios from 'axios';
import { getOdooBaseUrl } from '@api/config/odooConfig';

export const SESSION_EXPIRED_MESSAGE = 'Session expired. Please log in again.';

const AUTH_PATH = '/web/session/authenticate';

let _installed = false;
let _reauthInFlight = null;

const _baseUrl = () => (getOdooBaseUrl() || '').replace(/\/+$/, '');

const _sessionIdOf = (cookie) => {
  const m = String(cookie || '').match(/session_id=([^;,\s]+)/);
  return m ? m[1] : null;
};

const _cookieFromResponse = (resp) => {
  const setCookie = resp?.headers?.['set-cookie'] || resp?.headers?.['Set-Cookie'];
  if (!setCookie) return '';
  return Array.isArray(setCookie) ? setCookie.join('; ') : String(setCookie);
};

const _getCookieHeader = (config) => {
  const h = config?.headers;
  if (!h) return null;
  return (typeof h.get === 'function' ? h.get('Cookie') : h.Cookie) || null;
};

const _setCookieHeader = (config, cookie) => {
  const h = config.headers;
  if (typeof h?.set === 'function') {
    if (cookie) h.set('Cookie', cookie);
    else h.delete('Cookie');
  } else {
    config.headers = { ...(h || {}) };
    if (cookie) config.headers.Cookie = cookie;
    else delete config.headers.Cookie;
  }
};

// Only JSON-RPC POSTs to the active Odoo server, never the login call itself.
// GETs such as /web/image are left alone: a 404 there is a real missing file.
const _isOdooJsonRpc = (config) => {
  const base = _baseUrl();
  const url = String(config?.url || '');
  if (!base || !url.toLowerCase().startsWith(base.toLowerCase())) return false;
  if (url.slice(base.length).startsWith(AUTH_PATH)) return false;
  if (String(config?.method || '').toLowerCase() !== 'post') return false;
  const data = config?.data;
  return typeof data === 'string' ? data.includes('"jsonrpc"') : Boolean(data?.jsonrpc);
};

const _isSessionExpiredRpc = (data) => {
  const err = data?.error;
  if (!err) return false;
  const name = String(err?.data?.name || '');
  const msg = String(err?.data?.message || err?.message || '').toLowerCase();
  return /sessionexpired/i.test(name) || msg.includes('session expired');
};

const _doReauthenticate = async () => {
  try {
    const baseUrl = _baseUrl();
    if (!baseUrl) return null;
    // Logout clears userData + odoo_db; never sign a logged-out user back in.
    const userData = await AsyncStorage.getItem('userData');
    const db = await AsyncStorage.getItem('odoo_db');
    const savedRaw = await AsyncStorage.getItem('saved_credentials');
    if (!userData || !db || !savedRaw) return null;
    let map = null;
    try { map = JSON.parse(savedRaw); } catch (_) { return null; }
    if (!map || typeof map !== 'object') return null;
    // Same per-(URL + DB) key the login screen writes.
    const entry = map[`${baseUrl.toLowerCase()}|${db}`];
    if (!entry || !entry.username || !entry.password) return null;
    const resp = await axios.post(
      `${baseUrl}${AUTH_PATH}`,
      { jsonrpc: '2.0', method: 'call', params: { db, login: entry.username, password: entry.password } },
      { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    if (!resp.data?.result?.uid) return null;
    const cookie = _cookieFromResponse(resp);
    if (cookie) await AsyncStorage.setItem('odoo_cookie', cookie);
    console.log('[OdooSession] re-authenticated as', entry.username);
    return cookie;
  } catch (e) {
    console.warn('[OdooSession] re-auth failed:', e?.message);
    return null;
  }
};

// Log in again with the credentials the user last signed in with for the
// current URL + DB. Returns the new cookie string ('' if Odoo sent none), or
// null when re-login is not possible. Concurrent callers share one attempt.
export const reauthenticateOdoo = () => {
  if (!_reauthInFlight) {
    _reauthInFlight = _doReauthenticate().finally(() => { _reauthInFlight = null; });
  }
  return _reauthInFlight;
};

// Re-run `config` on a fresh session. Returns the retried response promise, or
// null when no fresh session could be obtained.
const _retryWithFreshSession = async (config) => {
  config._odooSessionRetried = true;
  const sent = _getCookieHeader(config);
  const stored = await AsyncStorage.getItem('odoo_cookie');
  let cookie;
  if (stored && _sessionIdOf(stored) !== _sessionIdOf(sent)) {
    // Another request already refreshed the session while this one was in flight.
    cookie = stored;
  } else {
    cookie = await reauthenticateOdoo();
    if (cookie === null) return null;
  }
  _setCookieHeader(config, cookie);
  console.log('[OdooSession] retrying', config.url, 'with a fresh session');
  return axios.request(config);
};

const _onFulfilled = async (response) => {
  const config = response?.config;
  if (!_isOdooJsonRpc(config)) return response;

  if (_isSessionExpiredRpc(response.data) && !config._odooSessionRetried) {
    const retried = await _retryWithFreshSession(config);
    return retried || response;
  }

  // Odoo 19 rotates the session id now and then and drops the old one shortly
  // after. Keep the stored cookie current so it never goes stale.
  if (response.data?.result !== undefined && !response.data?.error) {
    const fresh = _cookieFromResponse(response);
    const freshSid = _sessionIdOf(fresh);
    if (freshSid) {
      try {
        const stored = await AsyncStorage.getItem('odoo_cookie');
        if (stored && _sessionIdOf(stored) !== freshSid) {
          await AsyncStorage.setItem('odoo_cookie', fresh);
          console.log('[OdooSession] stored rotated session cookie');
        }
      } catch (_) { /* ignore */ }
    }
  }
  return response;
};

// A lost session's 404 is Odoo's HTML "No database is selected" page. A
// missing model or route on a live session comes back as a JSON-RPC error
// instead, so a JSON body means the session is fine.
const _isNoDbNotFound = (response) => response?.status === 404 && !response?.data?.jsonrpc;

const _onRejected = async (error) => {
  const config = error?.config;
  if (!_isNoDbNotFound(error?.response) || !_isOdooJsonRpc(config)) throw error;
  if (config._odooSessionRetried) throw error;
  const retried = await _retryWithFreshSession(config);
  if (retried) return retried;
  error.message = SESSION_EXPIRED_MESSAGE;
  throw error;
};

// Register the interceptor on the shared axios instance. Safe to call twice.
export const installOdooSessionGuard = () => {
  if (_installed) return;
  _installed = true;
  axios.interceptors.response.use(_onFulfilled, _onRejected);
};
