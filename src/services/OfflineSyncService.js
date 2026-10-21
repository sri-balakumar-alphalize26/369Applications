// src/services/OfflineSyncService.js
//
// Auto-flushes the on-device offline queue directly to Odoo when online.
//
// Instead of routing through /offline_sync/api/submit, we call Odoo's
// standard /web/dataset/call_kw directly — the same endpoint the online
// check-in uses. This avoids any dependency on the offline_sync Odoo module
// being correctly configured.

import AsyncStorage from '@react-native-async-storage/async-storage';
import axios from 'axios';
import { AppState } from 'react-native';
import offlineQueue from '@utils/offlineQueue';
import networkStatus from '@utils/networkStatus';
import { reauthenticateOdoo } from '@utils/odooSession';
import { getOdooBaseUrl } from '@api/config/odooConfig';

let started = false;
let unsubscribe = null;
let appStateSub = null;
let flushing = false;

// Resolves pending `waitForFlush()` callers the moment `flushing` flips
// back to false. Lets the pull-side auto-refresh (OfflineBanner onOnline,
// screen-level network subscribers) wait until offline-queued writes have
// been uploaded, so the subsequent fetch sees the real Odoo ids + names.
const _flushIdleWaiters = [];
const _notifyFlushIdle = () => {
    while (_flushIdleWaiters.length) {
        try { _flushIdleWaiters.shift()(); } catch (_) {}
    }
};

/**
 * Wait until the offline queue has drained AND no flush is in progress, or
 * resolve immediately if already idle. Bounded by `timeoutMs` so the UI can
 * never hang on a stuck flush. Polls every 250 ms because the scheduler's
 * own 500 ms debounce may start a flush AFTER the caller began waiting —
 * relying only on the `flushing` flag would let us resolve before the push
 * has even started.
 */
export const waitForFlush = async (timeoutMs = 8000) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        try {
            const pending = await offlineQueue.getPendingCount();
            if (pending === 0 && !flushing) return;
        } catch (_) { return; }
        // Tight 80ms poll — snappier reconnect wake-up than the original 250ms.
        await new Promise((r) => setTimeout(r, 80));
    }
};
let retryTimer = null;

const OFFLINE_ID_MAP_KEY = '@offline_id_map';

const getAuthHeaders = async () => {
    const headers = { 'Content-Type': 'application/json' };
    try {
        const cookie = await AsyncStorage.getItem('odoo_cookie');
        if (cookie) headers.Cookie = cookie;
    } catch (_) {}
    return headers;
};

// Detect whether an Odoo RPC response indicates an expired/invalid session
// (happens after an idle period — stored cookie is accepted but the server
// has garbage-collected the session). Caller should re-authenticate and retry.
const _looksLikeSessionExpired = (errData) => {
    if (!errData) return false;
    const msg = String(errData?.data?.message || errData?.message || '').toLowerCase();
    const name = String(errData?.data?.name || '').toLowerCase();
    return (
        msg.includes('session expired') ||
        msg.includes('access denied') ||
        msg.includes('not authenticated') ||
        msg.includes('user does not have access') ||
        name.includes('sessionexpired') ||
        name.includes('accessdenied')
    );
};

// Force-refresh the Odoo session cookie using the credentials the user most
// recently logged in with (shared helper in @utils/odooSession). Returns
// updated headers including the new Cookie, or null if the attempt fails.
const _reauthenticateForSync = async () => {
    const cookieStr = await reauthenticateOdoo();
    if (cookieStr === null) return null;
    console.log('[OfflineSyncService] re-authenticated session for sync');
    return { 'Content-Type': 'application/json', Cookie: cookieStr };
};

// Persistent map of offline placeholder ids ("offline_<queueItemId>") to real
// Odoo ids. Used so that a product queued offline that references a newly
// created offline category can resolve the category's real id once the
// category has itself been synced.
const readOfflineIdMap = async () => {
    try {
        const raw = await AsyncStorage.getItem(OFFLINE_ID_MAP_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch (_) { return {}; }
};

const saveOfflineIdMapping = async (offlineId, realId) => {
    try {
        const map = await readOfflineIdMap();
        map[offlineId] = realId;
        await AsyncStorage.setItem(OFFLINE_ID_MAP_KEY, JSON.stringify(map));
    } catch (_) {}
};

// Resolve any "offline_<id>" references inside a product's values to their
// real Odoo ids. Throws if a reference has no mapping yet — the queue will
// retry after the dependency syncs.
const resolveOfflineCategoryRefs = async (values) => {
    const map = await readOfflineIdMap();
    const resolve = (val) => {
        if (typeof val !== 'string' || !val.startsWith('offline_')) return val;
        const real = map[val];
        if (real === undefined) throw new Error(`Dependency ${val} not yet synced`);
        return real;
    };
    const out = { ...values };
    if (typeof out.categ_id === 'string' && out.categ_id.startsWith('offline_')) {
        out.categ_id = resolve(out.categ_id);
    }
    if (Array.isArray(out.pos_categ_ids)) {
        out.pos_categ_ids = out.pos_categ_ids.map((cmd) => {
            if (Array.isArray(cmd) && cmd[0] === 6 && Array.isArray(cmd[2])) {
                return [6, 0, cmd[2].map((id) => resolve(id))];
            }
            return cmd;
        });
    }
    return out;
};

// After a category syncs, replace any offline placeholder entry in the cached
// category list with the real id so the form dropdown stops showing it twice.
// Also rename the category-keyed product cache so filter still finds products
// that were queued under the offline id.
const replaceOfflineCategoryInCache = async (offlineId, realId) => {
    try {
        const raw = await AsyncStorage.getItem('@cache:categories');
        if (raw) {
            const list = JSON.parse(raw);
            let changed = false;
            const next = list.map((c) => {
                if (c._id === offlineId || c.id === offlineId) {
                    changed = true;
                    return { ...c, _id: realId, id: realId, offline: false };
                }
                return c;
            });
            if (changed) await AsyncStorage.setItem('@cache:categories', JSON.stringify(next));
        }

        // Rename @cache:products:cat:<offlineId> -> @cache:products:cat:<realId>
        const oldKey = `@cache:products:cat:${offlineId}`;
        const newKey = `@cache:products:cat:${realId}`;
        const oldProducts = await AsyncStorage.getItem(oldKey);
        if (oldProducts) {
            await AsyncStorage.setItem(newKey, oldProducts);
            await AsyncStorage.removeItem(oldKey);
        }
    } catch (_) {}
};

// After a product syncs, update its placeholder in the cached product lists
// so the real id replaces the offline id and downstream navigation works.
const replaceOfflineProductInCache = async (offlineId, realId) => {
    try {
        const keys = await AsyncStorage.getAllKeys();
        const productKeys = keys.filter((k) => k.startsWith('@cache:products'));
        for (const key of productKeys) {
            try {
                const raw = await AsyncStorage.getItem(key);
                if (!raw) continue;
                const list = JSON.parse(raw);
                let changed = false;
                const next = list.map((p) => {
                    if (p.id === offlineId) {
                        changed = true;
                        return { ...p, id: realId, offline: false };
                    }
                    return p;
                });
                if (changed) await AsyncStorage.setItem(key, JSON.stringify(next));
            } catch (_) {}
        }
    } catch (_) {}
};

// Log a completed sync into Odoo's offline.sync.queue as 'synced' so the
// history appears in Odoo's Sync Queue view and app's dashboard stats update.
// Fire-and-forget — if logging fails, the actual record is still created.
const logSyncHistory = async (baseUrl, headers, { model, operation, values, syncedRecordId }) => {
    try {
        // Find ir.model id for the target model
        const modelResp = await axios.post(
            `${baseUrl}/web/dataset/call_kw`,
            {
                jsonrpc: '2.0', method: 'call',
                params: {
                    model: 'ir.model', method: 'search_read',
                    args: [[['model', '=', model]]],
                    kwargs: { fields: ['id'], limit: 1 },
                },
            },
            { headers, timeout: 8000 }
        );
        const modelId = modelResp.data?.result?.[0]?.id;
        if (!modelId) return;

        // Format synced_at for Odoo (YYYY-MM-DD HH:MM:SS UTC)
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const syncedAt = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`;

        await axios.post(
            `${baseUrl}/web/dataset/call_kw`,
            {
                jsonrpc: '2.0', method: 'call',
                params: {
                    model: 'offline.sync.queue', method: 'create',
                    args: [{
                        model_id: modelId,
                        record_data: JSON.stringify(values || {}),
                        operation: operation || 'create',
                        state: 'synced',
                        synced_record_id: syncedRecordId || 0,
                        synced_at: syncedAt,
                    }],
                    kwargs: {},
                },
            },
            { headers, timeout: 8000 }
        );
        console.log('[OfflineSyncService] Logged sync history for', model, 'recordId:', syncedRecordId);
    } catch (e) {
        // Non-fatal — the actual record was already created successfully
        console.warn('[OfflineSyncService] history log failed:', e?.message);
    }
};

// Directly create/write an hr.attendance record in Odoo — same as
// checkInByEmployeeId does online.
const syncItemDirectly = async (item) => {
    const baseUrl = (getOdooBaseUrl() || '').replace(/\/+$/, '');
    if (!baseUrl) throw new Error('No Odoo URL configured');

    const headers = await getAuthHeaders();
    const values = item.values || {};

    if (item.model === 'hr.attendance' && item.operation === 'create') {
        // Standard attendance create with check_in (and optionally check_out).
        // Placeholder `late_reason` ('.') so any server-side ValidationError
        // requiring a non-empty reason on late records is satisfied at sync
        // time — the user can still update it later from the app.
        console.log('[sync-create-att] queue item values:', JSON.stringify(values));
        console.log('[sync-create-att] late_reason resolved to:',
            (values.late_reason && String(values.late_reason).trim())
                ? String(values.late_reason).trim()
                : "'.' (placeholder — no user reason)");
        const response = await axios.post(
            `${baseUrl}/web/dataset/call_kw`,
            {
                jsonrpc: '2.0',
                method: 'call',
                params: {
                    model: 'hr.attendance',
                    method: 'create',
                    args: [{
                        employee_id: values.employee_id,
                        check_in: values.check_in,
                        // Use the user-entered reason if they typed one in the
                        // offline late popup; otherwise fall back to the '.'
                        // placeholder so the server-side ValidationError on
                        // empty late_reason doesn't block sync.
                        late_reason: (values.late_reason && String(values.late_reason).trim())
                            ? String(values.late_reason).trim()
                            : '.',
                        ...(values.check_out ? { check_out: values.check_out } : {}),
                    }],
                    kwargs: {},
                },
            },
            { headers, timeout: 15000 }
        );

        if (response.data?.error) {
            const msg = response.data.error?.data?.message || response.data.error?.message || 'Odoo error';
            throw new Error(msg);
        }

        const recordId = response.data?.result;
        console.log('[OfflineSyncService] Created hr.attendance id:', recordId);
        // Remember the local→server mapping so a queued waiver request that
        // referenced the local attendance id can resolve it on its own sync.
        try {
            const mapRaw = await AsyncStorage.getItem('@sync:localToServer');
            const map = mapRaw ? JSON.parse(mapRaw) : {};
            map[String(item.id)] = recordId;
            await AsyncStorage.setItem('@sync:localToServer', JSON.stringify(map));
        } catch (_) { /* ignore */ }
        logSyncHistory(baseUrl, headers, { model: 'hr.attendance', operation: 'create', values, syncedRecordId: recordId }).catch(() => {});
        return recordId;
    }

    // hr.leave.request cancel — calls action_cancel on a real Odoo record.
    if (item.model === 'hr.leave.request' && item.operation === 'cancel') {
        const targetId = values.id;
        if (!targetId) throw new Error('Missing leave request id for cancel');
        const cancelResp = await axios.post(
            `${baseUrl}/web/dataset/call_kw`,
            {
                jsonrpc: '2.0',
                method: 'call',
                params: {
                    model: 'hr.leave.request',
                    method: 'action_cancel',
                    args: [[targetId]],
                    kwargs: {},
                },
            },
            { headers, timeout: 15000 }
        );
        if (cancelResp.data?.error) {
            const msg = cancelResp.data.error?.data?.message || cancelResp.data.error?.message || 'Odoo error';
            throw new Error(msg);
        }
        console.log('[OfflineSyncService] Cancelled hr.leave.request id:', targetId);
        logSyncHistory(baseUrl, headers, { model: 'hr.leave.request', operation: 'cancel', values, syncedRecordId: targetId }).catch(() => {});
        return targetId;
    }

    // hr.leave.request create — create + auto-submit (mirrors online flow)
    if (item.model === 'hr.leave.request' && item.operation === 'create') {
        const createResp = await axios.post(
            `${baseUrl}/web/dataset/call_kw`,
            {
                jsonrpc: '2.0',
                method: 'call',
                params: {
                    model: 'hr.leave.request',
                    method: 'create',
                    args: [values],
                    kwargs: {},
                },
            },
            { headers, timeout: 15000 }
        );
        if (createResp.data?.error) {
            const msg = createResp.data.error?.data?.message || createResp.data.error?.message || 'Odoo error';
            throw new Error(msg);
        }
        const recordId = createResp.data?.result;
        // Auto-submit (draft → pending) — same as online path
        try {
            await axios.post(
                `${baseUrl}/web/dataset/call_kw`,
                {
                    jsonrpc: '2.0',
                    method: 'call',
                    params: {
                        model: 'hr.leave.request',
                        method: 'action_submit',
                        args: [[recordId]],
                        kwargs: {},
                    },
                },
                { headers, timeout: 15000 }
            );
        } catch (e) {
            console.log('[OfflineSyncService] leave action_submit failed (non-fatal):', e?.message);
        }
        console.log('[OfflineSyncService] Created hr.leave.request id:', recordId);
        logSyncHistory(baseUrl, headers, { model: 'hr.leave.request', operation: 'create', values, syncedRecordId: recordId }).catch(() => {});
        return recordId;
    }

    // hr.late.waiver.request create — create + auto-submit
    if (item.model === 'hr.late.waiver.request' && item.operation === 'create') {
        // If this waiver was queued against an offline-only attendance, resolve
        // the local→server id mapping written when the attendance create synced.
        let resolvedValues = { ...values };
        if (resolvedValues._attendanceLocalId) {
            try {
                const mapRaw = await AsyncStorage.getItem('@sync:localToServer');
                const map = mapRaw ? JSON.parse(mapRaw) : {};
                const serverId = map[String(resolvedValues._attendanceLocalId)];
                if (!serverId) {
                    throw new Error('Cannot sync waiver: linked offline attendance has not synced yet');
                }
                resolvedValues.attendance_id = serverId;
                delete resolvedValues._attendanceLocalId;
            } catch (e) {
                throw new Error('Waiver resolve failed: ' + (e?.message || 'unknown'));
            }
        }
        const createResp = await axios.post(
            `${baseUrl}/web/dataset/call_kw`,
            {
                jsonrpc: '2.0',
                method: 'call',
                params: {
                    model: 'hr.late.waiver.request',
                    method: 'create',
                    args: [resolvedValues],
                    kwargs: {},
                },
            },
            { headers, timeout: 15000 }
        );
        if (createResp.data?.error) {
            const msg = createResp.data.error?.data?.message || createResp.data.error?.message || 'Odoo error';
            throw new Error(msg);
        }
        const recordId = createResp.data?.result;
        try {
            await axios.post(
                `${baseUrl}/web/dataset/call_kw`,
                {
                    jsonrpc: '2.0',
                    method: 'call',
                    params: {
                        model: 'hr.late.waiver.request',
                        method: 'action_submit',
                        args: [[recordId]],
                        kwargs: {},
                    },
                },
                { headers, timeout: 15000 }
            );
        } catch (e) {
            console.log('[OfflineSyncService] waiver action_submit failed (non-fatal):', e?.message);
        }
        console.log('[OfflineSyncService] Created hr.late.waiver.request id:', recordId);
        logSyncHistory(baseUrl, headers, { model: 'hr.late.waiver.request', operation: 'create', values, syncedRecordId: recordId }).catch(() => {});
        return recordId;
    }

    // TODO(offline-visits-removal): delete this block in the follow-up cleanup
    // PR — kept only to drain any legacy customer.visit queue entries that
    // were created before offline mode was removed from visits. No new
    // entries are enqueued by the app any more.
    //
    // customer.visit create — same flow as the online createCustomerVisitOdoo.
    if (item.model === 'customer.visit' && item.operation === 'create') {
        // Strip the denormalized helper fields we stuffed in for offline cache row rendering.
        const cleanVals = { ...values };
        delete cleanVals._customerName;
        delete cleanVals._employeeName;
        delete cleanVals._offlineRef;
        // Save the OFF<NNNNN> label so we can keep showing it even after sync.
        const offlineLabel = cleanVals.offline_label;
        delete cleanVals.offline_label;
        const createResp = await axios.post(
            `${baseUrl}/web/dataset/call_kw`,
            {
                jsonrpc: '2.0',
                method: 'call',
                params: {
                    model: 'customer.visit',
                    method: 'create',
                    args: [cleanVals],
                    kwargs: {},
                },
            },
            { headers, timeout: 30000 }
        );
        if (createResp.data?.error) {
            const msg = createResp.data.error?.data?.message || createResp.data.error?.message || 'Odoo error';
            throw new Error(msg);
        }
        const newId = Array.isArray(createResp.data?.result) ? createResp.data.result[0] : createResp.data.result;
        console.log('[OfflineSyncService] Created customer.visit id:', newId, 'offline_label:', offlineLabel);
        // Persist localId → serverId for any dependent records that might reference it.
        try {
            const mapRaw = await AsyncStorage.getItem('@sync:localToServer');
            const map = mapRaw ? JSON.parse(mapRaw) : {};
            map[String(item.id)] = newId;
            await AsyncStorage.setItem('@sync:localToServer', JSON.stringify(map));
        } catch (_) { /* ignore */ }
        // Persist OFF<NNNNN> label keyed by server id so the list keeps
        // showing it next to the real Odoo CV/YYYY/NNNNN reference after sync.
        if (offlineLabel) {
            try {
                const labelRaw = await AsyncStorage.getItem('@cache:offlineLabels:customerVisit');
                const labelMap = labelRaw ? JSON.parse(labelRaw) : {};
                labelMap[String(newId)] = offlineLabel;
                await AsyncStorage.setItem('@cache:offlineLabels:customerVisit', JSON.stringify(labelMap));
            } catch (_) { /* ignore */ }
        }
        logSyncHistory(baseUrl, headers, { model: 'customer.visit', operation: 'create', values: cleanVals, syncedRecordId: newId }).catch(() => {});
        return newId;
    }

    // TODO(offline-visits-removal): delete this block in the follow-up cleanup
    // PR — kept only to drain any legacy queued Done/Draft transitions on
    // offline-created visits. The app no longer enqueues these.
    //
    // customer.visit method — used for offline action_done / action_reset_to_draft.
    if (item.model === 'customer.visit' && item.operation === 'method') {
        // values shape: { id: <number or 'offline_<localId>'>, method: 'action_done' | 'action_reset_to_draft' }
        let targetId = values.id;
        if (typeof targetId === 'string' && targetId.startsWith('offline_')) {
            const localId = targetId.replace(/^offline_/, '');
            try {
                const mapRaw = await AsyncStorage.getItem('@sync:localToServer');
                const map = mapRaw ? JSON.parse(mapRaw) : {};
                const resolved = map[String(localId)];
                if (!resolved) throw new Error('parent visit not synced yet');
                targetId = resolved;
            } catch (e) {
                throw new Error('customer.visit method resolve failed: ' + e?.message);
            }
        }
        const methodResp = await axios.post(
            `${baseUrl}/web/dataset/call_kw`,
            {
                jsonrpc: '2.0',
                method: 'call',
                params: {
                    model: 'customer.visit',
                    method: values.method,
                    args: [[targetId]],
                    kwargs: {},
                },
            },
            { headers, timeout: 15000 }
        );
        if (methodResp.data?.error) {
            const msg = methodResp.data.error?.data?.message || methodResp.data.error?.message || 'Odoo error';
            throw new Error(msg);
        }
        console.log('[OfflineSyncService] customer.visit.' + values.method + ' on id=' + targetId);
        return targetId;
    }

    // vehicle.tracking create — fresh trip created while offline.
    if (item.model === 'vehicle.tracking' && item.operation === 'create') {
        const cleanVals = { ...values };
        ['_vehicleName', '_driverName', '_sourceName', '_destinationName'].forEach(k => delete cleanVals[k]);
        const offlineLabel = cleanVals.offline_label;
        delete cleanVals.offline_label;
        const createResp = await axios.post(
            `${baseUrl}/web/dataset/call_kw`,
            {
                jsonrpc: '2.0', method: 'call',
                params: {
                    model: 'vehicle.tracking',
                    method: 'create',
                    args: [cleanVals],
                    kwargs: {},
                },
            },
            { headers, timeout: 30000 }
        );
        if (createResp.data?.error) {
            const msg = createResp.data.error?.data?.message || createResp.data.error?.message || 'Odoo error';
            throw new Error(msg);
        }
        const newId = Array.isArray(createResp.data?.result) ? createResp.data.result[0] : createResp.data.result;
        console.log('[OfflineSyncService] Created vehicle.tracking id:', newId, 'offline_label:', offlineLabel);
        try {
            const mapRaw = await AsyncStorage.getItem('@sync:localToServer');
            const map = mapRaw ? JSON.parse(mapRaw) : {};
            map[String(item.id)] = newId;
            await AsyncStorage.setItem('@sync:localToServer', JSON.stringify(map));
        } catch (_) {}
        if (offlineLabel) {
            try {
                const labelRaw = await AsyncStorage.getItem('@cache:offlineLabels:vehicleTracking');
                const labelMap = labelRaw ? JSON.parse(labelRaw) : {};
                labelMap[String(newId)] = offlineLabel;
                await AsyncStorage.setItem('@cache:offlineLabels:vehicleTracking', JSON.stringify(labelMap));
            } catch (_) {}
        }
        logSyncHistory(baseUrl, headers, { model: 'vehicle.tracking', operation: 'create', values: cleanVals, syncedRecordId: newId }).catch(() => {});
        return newId;
    }

    // vehicle.tracking method — for offline action_validate.
    if (item.model === 'vehicle.tracking' && item.operation === 'method') {
        let targetId = values.id;
        if (typeof targetId === 'string' && targetId.startsWith('offline_')) {
            const localId = targetId.replace(/^offline_/, '');
            try {
                const mapRaw = await AsyncStorage.getItem('@sync:localToServer');
                const map = mapRaw ? JSON.parse(mapRaw) : {};
                const resolved = map[String(localId)];
                if (!resolved) throw new Error('parent vehicle.tracking not synced yet');
                targetId = resolved;
            } catch (e) {
                throw new Error('vehicle.tracking method resolve failed: ' + e?.message);
            }
        }
        const methodResp = await axios.post(
            `${baseUrl}/web/dataset/call_kw`,
            {
                jsonrpc: '2.0', method: 'call',
                params: {
                    model: 'vehicle.tracking',
                    method: values.method,
                    args: [[targetId]],
                    kwargs: {},
                },
            },
            { headers, timeout: 15000 }
        );
        if (methodResp.data?.error) {
            const msg = methodResp.data.error?.data?.message || methodResp.data.error?.message || 'Odoo error';
            throw new Error(msg);
        }
        console.log('[OfflineSyncService] vehicle.tracking.' + values.method + ' on id=' + targetId);
        return targetId;
    }

    // cash.collection create — vehicle maintenance record (model is misnamed cash.collection).
    if (item.model === 'cash.collection' && item.operation === 'create') {
        const cleanVals = { ...values };
        ['_vehicleName', '_driverName', '_maintenanceTypeName', '_handoverToPartnerName'].forEach(k => delete cleanVals[k]);
        const offlineLabel = cleanVals.offline_label;
        delete cleanVals.offline_label;
        const createResp = await axios.post(
            `${baseUrl}/web/dataset/call_kw`,
            {
                jsonrpc: '2.0', method: 'call',
                params: {
                    model: 'cash.collection',
                    method: 'create',
                    args: [cleanVals],
                    kwargs: {},
                },
            },
            { headers, timeout: 30000 }
        );
        if (createResp.data?.error) {
            const msg = createResp.data.error?.data?.message || createResp.data.error?.message || 'Odoo error';
            throw new Error(msg);
        }
        const newId = Array.isArray(createResp.data?.result) ? createResp.data.result[0] : createResp.data.result;
        console.log('[OfflineSyncService] Created cash.collection id:', newId, 'offline_label:', offlineLabel);
        try {
            const mapRaw = await AsyncStorage.getItem('@sync:localToServer');
            const map = mapRaw ? JSON.parse(mapRaw) : {};
            map[String(item.id)] = newId;
            await AsyncStorage.setItem('@sync:localToServer', JSON.stringify(map));
        } catch (_) {}
        if (offlineLabel) {
            try {
                const labelRaw = await AsyncStorage.getItem('@cache:offlineLabels:vehicleMaintenance');
                const labelMap = labelRaw ? JSON.parse(labelRaw) : {};
                labelMap[String(newId)] = offlineLabel;
                await AsyncStorage.setItem('@cache:offlineLabels:vehicleMaintenance', JSON.stringify(labelMap));
            } catch (_) {}
        }
        logSyncHistory(baseUrl, headers, { model: 'cash.collection', operation: 'create', values: cleanVals, syncedRecordId: newId }).catch(() => {});
        return newId;
    }

    // cash.collection method — for offline action_validate.
    if (item.model === 'cash.collection' && item.operation === 'method') {
        let targetId = values.id;
        if (typeof targetId === 'string' && targetId.startsWith('offline_')) {
            const localId = targetId.replace(/^offline_/, '');
            try {
                const mapRaw = await AsyncStorage.getItem('@sync:localToServer');
                const map = mapRaw ? JSON.parse(mapRaw) : {};
                const resolved = map[String(localId)];
                if (!resolved) throw new Error('parent cash.collection not synced yet');
                targetId = resolved;
            } catch (e) {
                throw new Error('cash.collection method resolve failed: ' + e?.message);
            }
        }
        const methodResp = await axios.post(
            `${baseUrl}/web/dataset/call_kw`,
            {
                jsonrpc: '2.0', method: 'call',
                params: {
                    model: 'cash.collection',
                    method: values.method,
                    args: [[targetId]],
                    kwargs: {},
                },
            },
            { headers, timeout: 15000 }
        );
        if (methodResp.data?.error) {
            const msg = methodResp.data.error?.data?.message || methodResp.data.error?.message || 'Odoo error';
            throw new Error(msg);
        }
        console.log('[OfflineSyncService] cash.collection.' + values.method + ' on id=' + targetId);
        return targetId;
    }

    // Banner create
    if (item.model === 'app.banner' && item.operation === 'create') {
        const response = await axios.post(
            `${baseUrl}/web/dataset/call_kw`,
            {
                jsonrpc: '2.0',
                method: 'call',
                params: {
                    model: 'app.banner',
                    method: 'create',
                    args: [{
                        name: values.name || `banner_${Date.now()}`,
                        image: values.image,
                    }],
                    kwargs: {},
                },
            },
            { headers, timeout: 30000 }
        );
        if (response.data?.error) {
            throw new Error(response.data.error?.data?.message || 'Banner create failed');
        }
        const recordId = response.data?.result;
        console.log('[OfflineSyncService] Created app.banner id:', recordId);
        logSyncHistory(baseUrl, headers, { model: 'app.banner', operation: 'create', values, syncedRecordId: recordId }).catch(() => {});
        return recordId;
    }

    // Banner delete
    if (item.model === 'app.banner' && item.operation === 'delete') {
        const bannerId = values.id;
        if (!bannerId) throw new Error('Banner delete: no id');
        const response = await axios.post(
            `${baseUrl}/web/dataset/call_kw`,
            {
                jsonrpc: '2.0',
                method: 'call',
                params: {
                    model: 'app.banner',
                    method: 'unlink',
                    args: [[bannerId]],
                    kwargs: {},
                },
            },
            { headers, timeout: 15000 }
        );
        if (response.data?.error) {
            throw new Error(response.data.error?.data?.message || 'Banner delete failed');
        }
        console.log('[OfflineSyncService] Deleted app.banner id:', bannerId);
        logSyncHistory(baseUrl, headers, { model: 'app.banner', operation: 'delete', values, syncedRecordId: bannerId }).catch(() => {});
        return bannerId;
    }

    // Product create (sale_ok/purchase_ok and category already in values)
    if (item.model === 'product.product' && item.operation === 'create') {
        // Resolve any offline_<id> category refs to the real ids we got from
        // earlier queue items. If an offline category ref is still unresolved,
        // this throws and keeps the item in the queue for retry.
        const resolvedValues = await resolveOfflineCategoryRefs(values);
        const response = await axios.post(
            `${baseUrl}/web/dataset/call_kw`,
            {
                jsonrpc: '2.0',
                method: 'call',
                params: {
                    model: 'product.product',
                    method: 'create',
                    args: [resolvedValues],
                    kwargs: {},
                },
            },
            { headers, timeout: 30000 }
        );
        if (response.data?.error) {
            throw new Error(response.data.error?.data?.message || 'Product create failed');
        }
        const recordId = response.data?.result;
        console.log('[OfflineSyncService] Created product.product id:', recordId);
        await replaceOfflineProductInCache(`offline_${item.id}`, recordId);
        logSyncHistory(baseUrl, headers, { model: 'product.product', operation: 'create', values: resolvedValues, syncedRecordId: recordId }).catch(() => {});
        return recordId;
    }

    // POS category create (with product.category fallback)
    if ((item.model === 'pos.category' || item.model === 'product.category') && item.operation === 'create') {
        // Idempotency: if we already synced this queue item but failed to
        // removeById (e.g. app killed between the two), the mapping is still
        // persisted — return that real id instead of creating a duplicate.
        const offlineId = `offline_${item.id}`;
        const existingMap = await readOfflineIdMap();
        if (existingMap[offlineId] !== undefined) {
            console.log('[OfflineSyncService] category already synced, reusing id:', existingMap[offlineId]);
            return existingMap[offlineId];
        }

        let model = item.model;
        let response = await axios.post(
            `${baseUrl}/web/dataset/call_kw`,
            {
                jsonrpc: '2.0',
                method: 'call',
                params: { model, method: 'create', args: [values], kwargs: {} },
            },
            { headers, timeout: 15000 }
        );
        // If pos.category doesn't exist, fall back to product.category
        if (response.data?.error && model === 'pos.category') {
            console.log('[OfflineSyncService] pos.category unavailable, trying product.category');
            model = 'product.category';
            response = await axios.post(
                `${baseUrl}/web/dataset/call_kw`,
                {
                    jsonrpc: '2.0',
                    method: 'call',
                    params: { model, method: 'create', args: [values], kwargs: {} },
                },
                { headers, timeout: 15000 }
            );
        }
        if (response.data?.error) {
            throw new Error(response.data.error?.data?.message || 'Category create failed');
        }
        const recordId = response.data?.result;
        console.log('[OfflineSyncService] Created', model, 'id:', recordId);
        await saveOfflineIdMapping(offlineId, recordId);
        await replaceOfflineCategoryInCache(offlineId, recordId);
        logSyncHistory(baseUrl, headers, { model, operation: 'create', values, syncedRecordId: recordId }).catch(() => {});
        return recordId;
    }

    // Easy purchase create — mirrors easy.sales but for easy.purchase model.
    if (item.model === 'easy.purchase' && item.operation === 'create') {
        const offlineId = `offline_${item.id}`;
        const existingMap = await readOfflineIdMap();
        if (existingMap[offlineId] !== undefined) return existingMap[offlineId];
        const { _confirmAfterCreate, partnerId, warehouseId, warehouseCompanyId, paymentMethodId, vendorRef, orderLines } = values;
        const vals = { partner_id: partnerId };
        if (warehouseId) vals.warehouse_id = warehouseId;
        if (paymentMethodId) vals.payment_method_id = paymentMethodId;
        if (vendorRef) vals.reference = vendorRef;
        if (orderLines && orderLines.length > 0) {
            vals.line_ids = orderLines.map((l) => [0, 0, {
                product_id: l.product_id, quantity: l.qty || l.quantity || 1,
                price_unit: l.price_unit || l.price || 0,
                ...(l.discount ? { discount: l.discount } : {}),
            }]);
        }
        const createKwargs = {};
        if (warehouseCompanyId) {
            try { const cr = await axios.post(`${baseUrl}/web/dataset/call_kw`, { jsonrpc: '2.0', method: 'call', params: { model: 'res.company', method: 'search_read', args: [[]], kwargs: { fields: ['id'], limit: 100 } } }, { headers }); const allIds = (cr.data?.result || []).map((c) => c.id); createKwargs.context = { allowed_company_ids: [warehouseCompanyId, ...allIds.filter((id) => id !== warehouseCompanyId)] }; } catch (_) { createKwargs.context = { allowed_company_ids: [warehouseCompanyId] }; }
        }
        const response = await axios.post(`${baseUrl}/web/dataset/call_kw`, { jsonrpc: '2.0', method: 'call', params: { model: 'easy.purchase', method: 'create', args: [vals], kwargs: createKwargs } }, { headers, timeout: 30000 });
        if (response.data?.error) throw new Error(response.data.error?.data?.message || 'Easy purchase create failed');
        const recordId = response.data?.result;
        console.log('[OfflineSyncService] Created easy.purchase id:', recordId);
        await saveOfflineIdMapping(offlineId, recordId);
        // Read back the Odoo-assigned sequence name so the swapped cache row
        // shows e.g. "EP0010 / draft" instead of the stale "NEW (offline)".
        let realName = null;
        let realState = null;
        let realAmount = null;
        try {
            const readResp = await axios.post(`${baseUrl}/web/dataset/call_kw`, {
                jsonrpc: '2.0', method: 'call',
                params: {
                    model: 'easy.purchase', method: 'read', args: [[recordId]],
                    kwargs: { fields: ['name', 'state', 'amount_total'] },
                },
            }, { headers, timeout: 10000 });
            const row = readResp.data?.result?.[0] || {};
            if (row.name && row.name !== '/') realName = row.name;
            realState = row.state || null;
            realAmount = row.amount_total ?? null;
            console.log('[OfflineSyncService] easy.purchase readback ok, name=', realName, 'state=', realState);
        } catch (e) { console.warn('[OfflineSyncService] easy.purchase readback failed:', e?.message); }
        try {
            const raw = await AsyncStorage.getItem('@cache:easyPurchases');
            if (raw) {
                const list = JSON.parse(raw);
                let ch = false;
                const next = list.map((o) => {
                    if (String(o.id) === offlineId) {
                        ch = true;
                        return {
                            ...o,
                            id: recordId,
                            name: realName || o.name,
                            state: realState || o.state,
                            amount_total: realAmount ?? o.amount_total,
                            offline: false,
                        };
                    }
                    return o;
                });
                if (ch) await AsyncStorage.setItem('@cache:easyPurchases', JSON.stringify(next));
            }
        } catch (_) {}
        try { const rawD = await AsyncStorage.getItem(`@cache:easyPurchaseDetail:${offlineId}`); if (rawD) { const prev = JSON.parse(rawD); await AsyncStorage.setItem(`@cache:easyPurchaseDetail:${recordId}`, JSON.stringify({ ...prev, id: recordId, name: realName || prev.name, state: realState || prev.state, amount_total: realAmount ?? prev.amount_total, offline: false })); await AsyncStorage.removeItem(`@cache:easyPurchaseDetail:${offlineId}`); } } catch (_) {}
        if (_confirmAfterCreate) {
            try { await axios.post(`${baseUrl}/web/dataset/call_kw`, { jsonrpc: '2.0', method: 'call', params: { model: 'easy.purchase', method: 'action_confirm', args: [[recordId]], kwargs: {} } }, { headers, timeout: 30000 }); console.log('[OfflineSyncService] Confirmed easy.purchase id:', recordId); } catch (e) { console.warn('[OfflineSyncService] easy.purchase confirm chain error:', e?.message); }
        }
        logSyncHistory(baseUrl, headers, { model: 'easy.purchase', operation: 'create', values: { partnerId }, syncedRecordId: recordId }).catch(() => {});
        return recordId;
    }

    // Easy purchase confirm
    if (item.model === 'easy.purchase' && item.operation === 'action_confirm') {
        const { _recordId, companyId } = values;
        let realId = _recordId;
        if (typeof realId === 'string' && realId.startsWith('offline_')) { const map = await readOfflineIdMap(); if (map[realId] === undefined) throw new Error(`Record ${realId} not yet synced`); realId = map[realId]; }
        await axios.post(`${baseUrl}/web/dataset/call_kw`, { jsonrpc: '2.0', method: 'call', params: { model: 'easy.purchase', method: 'action_confirm', args: [[Number(realId)]], kwargs: {} } }, { headers, timeout: 30000 });
        console.log('[OfflineSyncService] Confirmed easy.purchase id:', realId);
        logSyncHistory(baseUrl, headers, { model: 'easy.purchase', operation: 'action_confirm', values: { id: realId }, syncedRecordId: realId }).catch(() => {});
        return realId;
    }

    // Easy sales create — uses hardcoded field names from the easy_sales module:
    //   line_ids (one2many → easy.sales.line), quantity, price_unit,
    //   quick_payment_method_id, reference, warehouse_id.
    if (item.model === 'easy.sales' && item.operation === 'create') {
        const offlineId = `offline_${item.id}`;
        const existingMap = await readOfflineIdMap();
        if (existingMap[offlineId] !== undefined) {
            console.log('[OfflineSyncService] easy.sales already synced, reusing id:', existingMap[offlineId]);
            return existingMap[offlineId];
        }
        const { _confirmAfterCreate, partnerId, warehouseId, warehouseCompanyId, paymentMethodId, customerRef, orderLines } = values;

        // Build vals directly (no fields_get discovery needed)
        const vals = { partner_id: partnerId };
        if (warehouseId) vals.warehouse_id = warehouseId;
        if (paymentMethodId) vals.quick_payment_method_id = paymentMethodId;
        if (customerRef) vals.reference = customerRef;
        if (orderLines && orderLines.length > 0) {
            vals.line_ids = orderLines.map((l) => [0, 0, {
                product_id: l.product_id,
                quantity: l.qty || l.quantity || 1,
                price_unit: l.price_unit || l.price || 0,
                ...(l.discount ? { discount: l.discount } : {}),
            }]);
        }

        // Multi-company context
        const createKwargs = {};
        if (warehouseCompanyId) {
            try {
                const compResp = await axios.post(`${baseUrl}/web/dataset/call_kw`, {
                    jsonrpc: '2.0', method: 'call',
                    params: { model: 'res.company', method: 'search_read', args: [[]], kwargs: { fields: ['id'], limit: 100 } },
                }, { headers });
                const allIds = (compResp.data?.result || []).map((c) => c.id);
                createKwargs.context = { allowed_company_ids: [warehouseCompanyId, ...allIds.filter((id) => id !== warehouseCompanyId)] };
            } catch (_) { createKwargs.context = { allowed_company_ids: [warehouseCompanyId] }; }
        }

        console.log('[OfflineSyncService] easy.sales create → vals keys:', Object.keys(vals).join(','), 'partner:', partnerId, 'lines:', (orderLines || []).length);
        let response = await axios.post(`${baseUrl}/web/dataset/call_kw`, {
            jsonrpc: '2.0', method: 'call',
            params: { model: 'easy.sales', method: 'create', args: [vals], kwargs: createKwargs },
        }, { headers, timeout: 30000 });

        // If Odoo rejects with a session-expired error, re-authenticate via
        // saved credentials and retry once. Without this, a stale cookie
        // (session idle-timed-out while the phone was offline) would cause
        // every sync attempt to fail silently until poison-pilled.
        if (response.data?.error && _looksLikeSessionExpired(response.data.error)) {
            console.warn('[OfflineSyncService] easy.sales create got session error — re-authenticating and retrying');
            const freshHeaders = await _reauthenticateForSync();
            if (freshHeaders) {
                response = await axios.post(`${baseUrl}/web/dataset/call_kw`, {
                    jsonrpc: '2.0', method: 'call',
                    params: { model: 'easy.sales', method: 'create', args: [vals], kwargs: createKwargs },
                }, { headers: freshHeaders, timeout: 30000 });
            }
        }

        if (response.data?.error) {
            // Verbose logging + write the error to a UI-visible cache so the
            // Easy Sales list can surface a toast. Previously the error only
            // went to console.warn which is invisible on a real device.
            const errObj = response.data.error || {};
            const msg = errObj?.data?.message || errObj?.message || 'Easy sales create failed';
            console.error('[OfflineSyncService] easy.sales create REJECTED:', msg, 'full error:', JSON.stringify(errObj).substring(0, 600));
            try {
                await AsyncStorage.setItem('@lastSyncError:easySales', JSON.stringify({
                    message: msg,
                    at: new Date().toISOString(),
                    offlineId,
                }));
            } catch (_) {}
            throw new Error(msg);
        }
        const recordId = response.data?.result;
        console.log('[OfflineSyncService] Created easy.sales id:', recordId);
        // Successful sync — clear any stale error banner.
        try { await AsyncStorage.removeItem('@lastSyncError:easySales'); } catch (_) {}
        await saveOfflineIdMapping(offlineId, recordId);

        // Read back the Odoo-assigned sequence name + initial state so the
        // swapped cache row shows e.g. "ES0010 / draft" instead of the stale
        // "NEW (offline)". Without this step, the placeholder keeps its
        // fake name until a full refetch overwrites the cache — and that
        // refetch can race with sync and lose the row entirely.
        let realName = null;
        let realState = null;
        let realAmount = null;
        try {
            const readResp = await axios.post(`${baseUrl}/web/dataset/call_kw`, {
                jsonrpc: '2.0', method: 'call',
                params: {
                    model: 'easy.sales', method: 'read', args: [[recordId]],
                    kwargs: { fields: ['name', 'state', 'amount_total'] },
                },
            }, { headers, timeout: 10000 });
            const row = readResp.data?.result?.[0] || {};
            if (row.name && row.name !== '/') realName = row.name;
            realState = row.state || null;
            realAmount = row.amount_total ?? null;
            console.log('[OfflineSyncService] easy.sales readback ok, name=', realName, 'state=', realState);
        } catch (e) { console.warn('[OfflineSyncService] easy.sales readback failed:', e?.message); }

        // Swap placeholder in caches — now with the real Odoo name/state.
        try {
            const raw = await AsyncStorage.getItem('@cache:easySales');
            if (raw) {
                const list = JSON.parse(raw);
                let changed = false;
                const next = list.map((o) => {
                    if (String(o.id) === offlineId) {
                        changed = true;
                        return {
                            ...o,
                            id: recordId,
                            name: realName || o.name,
                            state: realState || o.state,
                            amount_total: realAmount ?? o.amount_total,
                            offline: false,
                        };
                    }
                    return o;
                });
                if (changed) await AsyncStorage.setItem('@cache:easySales', JSON.stringify(next));
            }
        } catch (_) {}
        try {
            const rawD = await AsyncStorage.getItem(`@cache:easySaleDetail:${offlineId}`);
            if (rawD) {
                const prev = JSON.parse(rawD);
                await AsyncStorage.setItem(`@cache:easySaleDetail:${recordId}`, JSON.stringify({ ...prev, id: recordId, offline: false }));
                await AsyncStorage.removeItem(`@cache:easySaleDetail:${offlineId}`);
            }
        } catch (_) {}

        if (_confirmAfterCreate) {
            try {
                await axios.post(`${baseUrl}/web/dataset/call_kw`, {
                    jsonrpc: '2.0', method: 'call',
                    params: { model: 'easy.sales', method: 'action_confirm', args: [[recordId]], kwargs: {} },
                }, { headers, timeout: 30000 });
                console.log('[OfflineSyncService] Confirmed easy.sales id:', recordId);
            } catch (e) { console.warn('[OfflineSyncService] easy.sales confirm chain error:', e?.message); }
        }

        logSyncHistory(baseUrl, headers, { model: 'easy.sales', operation: 'create', values: { partnerId }, syncedRecordId: recordId }).catch(() => {});
        return recordId;
    }

    // Easy sales confirm (action_confirm on an already-synced record)
    if (item.model === 'easy.sales' && item.operation === 'action_confirm') {
        const { _recordId, companyId } = values;
        let realRecordId = _recordId;
        if (typeof realRecordId === 'string' && realRecordId.startsWith('offline_')) {
            const map = await readOfflineIdMap();
            if (map[realRecordId] === undefined) throw new Error(`Record ${realRecordId} not yet synced`);
            realRecordId = map[realRecordId];
        }
        await axios.post(`${baseUrl}/web/dataset/call_kw`, {
            jsonrpc: '2.0', method: 'call',
            params: { model: 'easy.sales', method: 'action_confirm', args: [[Number(realRecordId)]], kwargs: {} },
        }, { headers, timeout: 30000 });
        console.log('[OfflineSyncService] Confirmed easy.sales id:', realRecordId);
        logSyncHistory(baseUrl, headers, { model: 'easy.sales', operation: 'action_confirm', values: { id: realRecordId }, syncedRecordId: realRecordId }).catch(() => {});
        return realRecordId;
    }

    // Sale order create (quotation). Supports optional _confirmAfterCreate,
    // _cancelAfterCreate, and _invoiceAfterCreate flags which chain
    // action_confirm / action_cancel / _create_invoices after the order is
    // created. _cancelAfterCreate wins over confirm if both are set.
    // _invoiceAfterCreate runs after confirm (invoices need confirmed orders).
    if (item.model === 'sale.order' && item.operation === 'create') {
        const offlineId = `offline_${item.id}`;
        const existingMap = await readOfflineIdMap();
        if (existingMap[offlineId] !== undefined) {
            console.log('[OfflineSyncService] sale.order already synced, reusing id:', existingMap[offlineId]);
            return existingMap[offlineId];
        }
        const { _confirmAfterCreate, _cancelAfterCreate, _invoiceAfterCreate, ...rest } = values;
        console.log('[OfflineSyncService] sale.order create → vals keys:', Object.keys(rest).join(','));
        let createResp = await axios.post(
            `${baseUrl}/web/dataset/call_kw`,
            {
                jsonrpc: '2.0', method: 'call',
                params: { model: 'sale.order', method: 'create', args: [rest], kwargs: {} },
            },
            { headers, timeout: 30000 }
        );
        // Session-expired retry: if the stored cookie was idle-timed-out
        // while the device was offline, re-auth via saved credentials and
        // retry once. Without this, the second offline order silently fails.
        if (createResp.data?.error && _looksLikeSessionExpired(createResp.data.error)) {
            console.warn('[OfflineSyncService] sale.order create got session error — re-authenticating and retrying');
            const freshHeaders = await _reauthenticateForSync();
            if (freshHeaders) {
                createResp = await axios.post(
                    `${baseUrl}/web/dataset/call_kw`,
                    {
                        jsonrpc: '2.0', method: 'call',
                        params: { model: 'sale.order', method: 'create', args: [rest], kwargs: {} },
                    },
                    { headers: freshHeaders, timeout: 30000 }
                );
            }
        }
        if (createResp.data?.error) {
            const errObj = createResp.data.error || {};
            const msg = errObj?.data?.message || errObj?.message || 'Sale order create failed';
            console.error('[OfflineSyncService] sale.order create REJECTED:', msg, 'full error:', JSON.stringify(errObj).substring(0, 600));
            try {
                await AsyncStorage.setItem('@lastSyncError:saleOrders', JSON.stringify({
                    message: msg,
                    at: new Date().toISOString(),
                    offlineId,
                }));
            } catch (_) {}
            throw new Error(msg);
        }
        const recordId = createResp.data?.result;
        console.log('[OfflineSyncService] Created sale.order id:', recordId);
        try { await AsyncStorage.removeItem('@lastSyncError:saleOrders'); } catch (_) {}
        await saveOfflineIdMapping(offlineId, recordId);

        // Fetch real order name from Odoo — this becomes the row's `ref`.
        // The user-facing display name (`item.name`) stays as the A00001
        // label assigned at create time so the printed invoice is stable.
        let realName = '';
        try {
            const nameResp = await axios.post(`${baseUrl}/web/dataset/call_kw`, {
                jsonrpc: '2.0', method: 'call',
                params: { model: 'sale.order', method: 'read', args: [[recordId]], kwargs: { fields: ['name'] } },
            }, { headers, timeout: 10000 });
            const fetched = nameResp.data?.result?.[0]?.name;
            if (fetched && fetched !== '/') realName = fetched;
        } catch (_) {}
        console.log('[OfflineSyncService] sale.order real Odoo ref:', realName || '(unassigned)');

        // Carry the A-number across the offline→real id swap. A-map is
        // scoped per Odoo DB. The offline-assigned A-number is sacred —
        // user already printed/saw it. Always overwrite any earlier
        // auto-assigned label on the real id, so a race with the list
        // fetch (which may auto-assign first) cannot strand the offline
        // label as orphaned. Also prune any other entry pointing to the
        // same offline label to avoid duplicates.
        try {
            const dbName = (await AsyncStorage.getItem('odoo_db')) || '';
            const aKey = dbName ? `a_map:${dbName}` : 'a_map';
            const aMapRaw = await AsyncStorage.getItem(aKey);
            if (aMapRaw) {
                const aMap = JSON.parse(aMapRaw);
                const offlineLabel = aMap[offlineId];
                if (offlineLabel) {
                    const prior = aMap[String(recordId)];
                    // Drop any other id that was auto-assigned the same
                    // label (the offline A-number wins; the auto-assigned
                    // one will be replaced on the next refetch).
                    for (const [k, v] of Object.entries(aMap)) {
                        if (k !== offlineId && k !== String(recordId) && v === offlineLabel) {
                            delete aMap[k];
                        }
                    }
                    aMap[String(recordId)] = offlineLabel;
                    await AsyncStorage.setItem(aKey, JSON.stringify(aMap));
                    console.log(
                        '[OfflineSyncService] Sealed A-number', offlineLabel,
                        '→ recordId', recordId,
                        prior && prior !== offlineLabel ? `(replaced auto-assigned ${prior})` : '',
                        '(db=', dbName + ')'
                    );
                }
            }
        } catch (_) {}

        // Swap offline placeholder in cached list/detail with the real Odoo
        // id. `name` flips from the OFF placeholder to Odoo's real sequence
        // name; `offline_label` (the OFF) is preserved via spread so the
        // list renderer can show it as a Ref sub-line under the bold name.
        try {
            const raw = await AsyncStorage.getItem('@cache:saleOrders');
            if (raw) {
                const list = JSON.parse(raw);
                let changed = false;
                const next = list.map((o) => {
                    if (String(o.id) === offlineId) {
                        changed = true;
                        return { ...o, id: recordId, name: realName || o.name, offline: false };
                    }
                    return o;
                });
                if (changed) await AsyncStorage.setItem('@cache:saleOrders', JSON.stringify(next));
            }
        } catch (_) {}
        try {
            const rawD = await AsyncStorage.getItem(`@cache:saleOrderDetail:${offlineId}`);
            if (rawD) {
                const prev = JSON.parse(rawD);
                await AsyncStorage.setItem(`@cache:saleOrderDetail:${recordId}`, JSON.stringify({ ...prev, id: recordId, name: realName || prev.name, offline: false }));
                await AsyncStorage.removeItem(`@cache:saleOrderDetail:${offlineId}`);
            }
        } catch (_) {}

        // Chain action_cancel if the user cancelled while offline.
        if (_cancelAfterCreate) {
            try {
                const cancelResp = await axios.post(
                    `${baseUrl}/web/dataset/call_kw`,
                    {
                        jsonrpc: '2.0', method: 'call',
                        params: { model: 'sale.order', method: 'action_cancel', args: [[recordId]], kwargs: {} },
                    },
                    { headers, timeout: 30000 }
                );
                if (cancelResp.data?.error) {
                    console.warn('[OfflineSyncService] sale.order cancel failed:', cancelResp.data.error?.data?.message);
                } else {
                    console.log('[OfflineSyncService] Cancelled sale.order id:', recordId);
                }
            } catch (e) { console.warn('[OfflineSyncService] cancel chain error:', e?.message); }
            logSyncHistory(baseUrl, headers, { model: 'sale.order', operation: 'create', values: rest, syncedRecordId: recordId }).catch(() => {});
            return recordId;
        }

        // Chain action_confirm if requested.
        if (_confirmAfterCreate) {
            try {
                // Get all company IDs for context
                let confirmCompanyIds = [1];
                try {
                    const ccResp = await axios.post(`${baseUrl}/web/dataset/call_kw`, { jsonrpc: '2.0', method: 'call', params: { model: 'res.company', method: 'search_read', args: [[]], kwargs: { fields: ['id'], limit: 100 } } }, { headers });
                    confirmCompanyIds = (ccResp.data?.result || []).map((c) => c.id);
                } catch (_) {}

                const confirmResp = await axios.post(
                    `${baseUrl}/web/dataset/call_kw`,
                    {
                        jsonrpc: '2.0', method: 'call',
                        params: { model: 'sale.order', method: 'action_confirm', args: [[recordId]], kwargs: { context: { allowed_company_ids: confirmCompanyIds } } },
                    },
                    { headers, timeout: 30000 }
                );
                if (confirmResp.data?.error) {
                    console.warn('[OfflineSyncService] sale.order confirm failed:', confirmResp.data.error?.data?.message);
                    // Retry once without context
                    try {
                        const retryResp = await axios.post(`${baseUrl}/web/dataset/call_kw`, { jsonrpc: '2.0', method: 'call', params: { model: 'sale.order', method: 'action_confirm', args: [[recordId]], kwargs: {} } }, { headers, timeout: 30000 });
                        if (!retryResp.data?.error) console.log('[OfflineSyncService] Confirmed sale.order on retry:', recordId);
                    } catch (_) {}
                } else {
                    console.log('[OfflineSyncService] Confirmed sale.order id:', recordId);
                }
            } catch (e) { console.warn('[OfflineSyncService] confirm chain error:', e?.message); }
        }

        // Chain invoice creation if requested (runs after confirm since
        // Odoo only invoices confirmed orders). Calls _create_invoices on
        // the sale.order, then swaps the placeholder "offline_inv" in cache
        // with the real invoice id.
        if (_invoiceAfterCreate) {
            try {
                const invResp = await axios.post(
                    `${baseUrl}/web/dataset/call_kw`,
                    {
                        jsonrpc: '2.0', method: 'call',
                        params: { model: 'sale.order', method: '_create_invoices', args: [[recordId]], kwargs: {} },
                    },
                    { headers, timeout: 30000 }
                );
                if (invResp.data?.error) {
                    console.warn('[OfflineSyncService] sale.order invoice create failed:', invResp.data.error?.data?.message);
                } else {
                    const invResult = invResp.data?.result;
                    // _create_invoices returns an account.move recordset repr.
                    // Fetch the real invoice ids linked to this SO for the cache patch.
                    try {
                        const readResp = await axios.post(`${baseUrl}/web/dataset/call_kw`, {
                            jsonrpc: '2.0', method: 'call',
                            params: { model: 'sale.order', method: 'read', args: [[recordId]], kwargs: { fields: ['invoice_ids', 'invoice_status'] } },
                        }, { headers, timeout: 10000 });
                        const row = readResp.data?.result?.[0];
                        const realInvoiceIds = row?.invoice_ids || [];
                        console.log('[OfflineSyncService] Invoiced sale.order id:', recordId, 'invoice_ids:', realInvoiceIds);
                        // Patch cache: swap offline_inv with real ids in list + detail.
                        const patch = { invoice_status: row?.invoice_status || 'invoiced', invoice_ids: realInvoiceIds.length ? realInvoiceIds : ['offline_inv'] };
                        try {
                            const rawList = await AsyncStorage.getItem('@cache:saleOrders');
                            if (rawList) {
                                const list = JSON.parse(rawList);
                                const idx = list.findIndex((o) => o.id === recordId || String(o.id) === offlineId);
                                if (idx >= 0) { list[idx] = { ...list[idx], ...patch }; await AsyncStorage.setItem('@cache:saleOrders', JSON.stringify(list)); }
                            }
                        } catch (_) {}
                        try {
                            const detailKey = `@cache:saleOrderDetail:${recordId}`;
                            const rawD = await AsyncStorage.getItem(detailKey);
                            if (rawD) {
                                const prev = JSON.parse(rawD);
                                await AsyncStorage.setItem(detailKey, JSON.stringify({ ...prev, ...patch }));
                            }
                        } catch (_) {}
                    } catch (e) { console.warn('[OfflineSyncService] invoice read-back failed:', e?.message); }
                }
            } catch (e) { console.warn('[OfflineSyncService] invoice chain error:', e?.message); }
        }

        logSyncHistory(baseUrl, headers, { model: 'sale.order', operation: 'create', values: rest, syncedRecordId: recordId }).catch(() => {});
        return recordId;
    }

    // Sale order confirm (action_confirm on an already-synced order)
    if (item.model === 'sale.order' && item.operation === 'action_confirm') {
        const { _recordId } = values;
        let realRecordId = _recordId;
        if (typeof realRecordId === 'string' && realRecordId.startsWith('offline_')) {
            const map = await readOfflineIdMap();
            if (map[realRecordId] === undefined) throw new Error(`Record ${realRecordId} not yet synced`);
            realRecordId = map[realRecordId];
        }
        const response = await axios.post(
            `${baseUrl}/web/dataset/call_kw`,
            {
                jsonrpc: '2.0', method: 'call',
                params: { model: 'sale.order', method: 'action_confirm', args: [[Number(realRecordId)]], kwargs: {} },
            },
            { headers, timeout: 30000 }
        );
        if (response.data?.error) {
            throw new Error(response.data.error?.data?.message || 'Sale order confirm failed');
        }
        console.log('[OfflineSyncService] Confirmed sale.order id:', realRecordId);
        logSyncHistory(baseUrl, headers, { model: 'sale.order', operation: 'action_confirm', values: { id: realRecordId }, syncedRecordId: realRecordId }).catch(() => {});
        return realRecordId;
    }

    // Sale order cancel (action_cancel on an already-synced order)
    if (item.model === 'sale.order' && item.operation === 'action_cancel') {
        const { _recordId } = values;
        let realRecordId = _recordId;
        if (typeof realRecordId === 'string' && realRecordId.startsWith('offline_')) {
            const map = await readOfflineIdMap();
            if (map[realRecordId] === undefined) throw new Error(`Record ${realRecordId} not yet synced`);
            realRecordId = map[realRecordId];
        }
        const response = await axios.post(
            `${baseUrl}/web/dataset/call_kw`,
            {
                jsonrpc: '2.0', method: 'call',
                params: { model: 'sale.order', method: 'action_cancel', args: [[Number(realRecordId)]], kwargs: {} },
            },
            { headers, timeout: 30000 }
        );
        if (response.data?.error) {
            throw new Error(response.data.error?.data?.message || 'Sale order cancel failed');
        }
        console.log('[OfflineSyncService] Cancelled sale.order id:', realRecordId);
        logSyncHistory(baseUrl, headers, { model: 'sale.order', operation: 'action_cancel', values: { id: realRecordId }, syncedRecordId: realRecordId }).catch(() => {});
        return realRecordId;
    }

    // Sale order invoice create (runs _create_invoices on an already-synced
    // order). Queued when the user tapped Create Invoice offline on a real
    // Odoo order — we materialize the invoice on reconnect without another tap.
    if (item.model === 'sale.order' && item.operation === 'action_invoice_create') {
        const { _recordId } = values;
        let realRecordId = _recordId;
        if (typeof realRecordId === 'string' && realRecordId.startsWith('offline_')) {
            const map = await readOfflineIdMap();
            if (map[realRecordId] === undefined) throw new Error(`Record ${realRecordId} not yet synced`);
            realRecordId = map[realRecordId];
        }
        const response = await axios.post(
            `${baseUrl}/web/dataset/call_kw`,
            {
                jsonrpc: '2.0', method: 'call',
                params: { model: 'sale.order', method: '_create_invoices', args: [[Number(realRecordId)]], kwargs: {} },
            },
            { headers, timeout: 30000 }
        );
        if (response.data?.error) {
            throw new Error(response.data.error?.data?.message || 'Invoice create failed');
        }
        // Read back real invoice_ids and patch the cache so the UI switches
        // from the "offline_inv" placeholder to the real invoice.
        try {
            const readResp = await axios.post(`${baseUrl}/web/dataset/call_kw`, {
                jsonrpc: '2.0', method: 'call',
                params: { model: 'sale.order', method: 'read', args: [[Number(realRecordId)]], kwargs: { fields: ['invoice_ids', 'invoice_status'] } },
            }, { headers, timeout: 10000 });
            const row = readResp.data?.result?.[0];
            const realInvoiceIds = row?.invoice_ids || [];
            console.log('[OfflineSyncService] Invoiced sale.order id:', realRecordId, 'invoice_ids:', realInvoiceIds);
            const patch = { invoice_status: row?.invoice_status || 'invoiced', invoice_ids: realInvoiceIds.length ? realInvoiceIds : ['offline_inv'] };
            try {
                const rawList = await AsyncStorage.getItem('@cache:saleOrders');
                if (rawList) {
                    const list = JSON.parse(rawList);
                    const idx = list.findIndex((o) => o.id === Number(realRecordId) || String(o.id) === String(realRecordId));
                    if (idx >= 0) { list[idx] = { ...list[idx], ...patch }; await AsyncStorage.setItem('@cache:saleOrders', JSON.stringify(list)); }
                }
            } catch (_) {}
            try {
                const detailKey = `@cache:saleOrderDetail:${realRecordId}`;
                const rawD = await AsyncStorage.getItem(detailKey);
                if (rawD) {
                    const prev = JSON.parse(rawD);
                    await AsyncStorage.setItem(detailKey, JSON.stringify({ ...prev, ...patch }));
                }
            } catch (_) {}
        } catch (e) { console.warn('[OfflineSyncService] invoice read-back failed:', e?.message); }
        logSyncHistory(baseUrl, headers, { model: 'sale.order', operation: 'action_invoice_create', values: { id: realRecordId }, syncedRecordId: realRecordId }).catch(() => {});
        return realRecordId;
    }

    // Register Payment (account.payment) create — mirrors the online
    // createPaymentWithSignatureOdoo: resolve partner's company, pick a
    // matching journal in that company, create the payment with signatures
    // and GPS, then post it. Finally swap the offline placeholder in the
    // cached payments list with the real record.
    if (item.model === 'account.payment' && item.operation === 'create') {
        console.log('[PaySync] ⇢ Processing create, queue item id:', item.id);
        const offlineId = `offline_${item.id}`;
        const existingMap = await readOfflineIdMap();
        if (existingMap[offlineId] !== undefined) {
            console.log('[PaySync]   already synced, reusing Odoo id:', existingMap[offlineId]);
            return existingMap[offlineId];
        }
        const { partnerId, amount, paymentType, journalId, companyId, ref, customerSignature,
                employeeSignature, latitude, longitude, locationName, _postAfterCreate } = values;

        const rpc = async (model, method, args, kwargs = {}) => {
            const resp = await axios.post(
                `${baseUrl}/web/dataset/call_kw`,
                { jsonrpc: '2.0', method: 'call', params: { model, method, args, kwargs } },
                { headers, withCredentials: true, timeout: 15000 }
            );
            if (resp.data?.error) throw new Error(resp.data.error?.data?.message || 'Odoo RPC error');
            return resp.data.result;
        };

        // Company / journal resolution — mirrors the online flow in
        // createPaymentWithSignatureOdoo so offline syncs produce the same
        // Odoo record the online path would have. User picks win; otherwise
        // partner + journal company_ids are cross-checked with full fallback.
        let targetCompanyId = companyId || null;
        let resolvedJournalId = journalId;

        if (partnerId) {
            let partners = null;
            let journals = null;
            try {
                [partners, journals] = await Promise.all([
                    rpc('res.partner', 'search_read', [[['id', '=', partnerId]]], { fields: ['id', 'company_id'], limit: 1 }),
                    journalId
                        ? rpc('account.journal', 'search_read', [[['id', '=', journalId]]], { fields: ['id', 'company_id', 'type'], limit: 1 })
                        : Promise.resolve(null),
                ]);
            } catch (e) { console.warn('[PaySync]   partner/journal lookup failed:', e?.message); }

            const partnerCompanyId = partners?.[0]?.company_id ? partners[0].company_id[0] : null;
            console.log('[PaySync]   partner company_id:', partnerCompanyId);

            if (journalId && journals) {
                const journalCompanyId = journals?.[0]?.company_id ? journals[0].company_id[0] : null;
                const journalType = journals?.[0]?.type || 'bank';
                console.log('[PaySync]   journal company_id:', journalCompanyId, 'type:', journalType);

                if (partnerCompanyId && journalCompanyId && partnerCompanyId !== journalCompanyId) {
                    // Mismatch — find a journal of same type in partner's company.
                    console.log('[PaySync]   company mismatch, partner:', partnerCompanyId, 'journal:', journalCompanyId);
                    try {
                        const matching = await rpc('account.journal', 'search_read', [
                            [['type', '=', journalType], ['company_id', '=', partnerCompanyId]]
                        ], { fields: ['id', 'name', 'type', 'company_id'], limit: 5 });
                        if (matching?.length) {
                            resolvedJournalId = matching[0].id;
                            targetCompanyId = partnerCompanyId;
                            console.log('[PaySync]   resolved journal to', matching[0].name, 'id:', resolvedJournalId);
                        } else {
                            // No same-type journal — fall back to any cash/bank journal in partner's company.
                            const fallback = await rpc('account.journal', 'search_read', [
                                [['type', 'in', ['cash', 'bank']], ['company_id', '=', partnerCompanyId]]
                            ], { fields: ['id', 'name', 'type', 'company_id'], limit: 5 });
                            if (fallback?.length) {
                                resolvedJournalId = fallback[0].id;
                                targetCompanyId = partnerCompanyId;
                                console.log('[PaySync]   fallback journal:', fallback[0].name, 'id:', resolvedJournalId);
                            } else {
                                // Last resort: clear partner's company restriction so the payment can go through.
                                console.log('[PaySync]   no journal in partner company, clearing partner company restriction');
                                targetCompanyId = journalCompanyId;
                                try {
                                    await rpc('res.partner', 'write', [[partnerId], { company_id: false }]);
                                    console.log('[PaySync]   cleared partner company');
                                } catch (writeErr) {
                                    console.warn('[PaySync]   could not clear partner company:', writeErr?.message);
                                }
                            }
                        }
                    } catch (e) { console.warn('[PaySync]   journal resolution threw:', e?.message); }
                } else {
                    // No mismatch — use partner's company when present, else journal's.
                    targetCompanyId = partnerCompanyId || journalCompanyId || targetCompanyId;
                }
            } else if (!targetCompanyId) {
                targetCompanyId = partnerCompanyId;
            }
        }

        // If we still don't have a journal, pick any cash/bank in the target company.
        if (!resolvedJournalId && targetCompanyId) {
            try {
                const matching = await rpc('account.journal', 'search_read', [[['type', 'in', ['bank', 'cash']], ['company_id', '=', targetCompanyId]]], { fields: ['id'], limit: 1 });
                if (matching?.length) resolvedJournalId = matching[0].id;
            } catch (_) {}
        }

        // Vals — mirror the online path exactly. `memo` (not `ref`) is the
        // Odoo account.payment field, and amount must be positive.
        const vals = {
            amount: Math.abs(parseFloat(amount) || 0),
            payment_type: paymentType || 'inbound',
            partner_type: paymentType === 'outbound' ? 'supplier' : 'customer',
        };
        if (partnerId) vals.partner_id = partnerId;
        if (resolvedJournalId) vals.journal_id = resolvedJournalId;
        if (targetCompanyId) vals.company_id = targetCompanyId;
        if (ref) vals.memo = ref;
        if (customerSignature) {
            const m = String(customerSignature).match(/^data:image\/[^;]+;base64,(.+)$/);
            vals.customer_signature = m ? m[1] : customerSignature;
        }
        if (employeeSignature) {
            const m = String(employeeSignature).match(/^data:image\/[^;]+;base64,(.+)$/);
            vals.employee_signature = m ? m[1] : employeeSignature;
        }
        if (latitude !== null && latitude !== undefined) vals.latitude = latitude;
        if (longitude !== null && longitude !== undefined) vals.longitude = longitude;
        if (locationName) vals.location_name = locationName;

        const createKwargs = targetCompanyId ? { context: { allowed_company_ids: [targetCompanyId] } } : {};
        console.log('[PaySync]   → creating in Odoo with vals keys:', Object.keys(vals).join(','), 'companyId:', targetCompanyId);
        const createResp = await axios.post(
            `${baseUrl}/web/dataset/call_kw`,
            { jsonrpc: '2.0', method: 'call', params: { model: 'account.payment', method: 'create', args: [vals], kwargs: createKwargs } },
            { headers, withCredentials: true, timeout: 30000 }
        );
        if (createResp.data?.error) {
            const msg = createResp.data.error?.data?.message || 'account.payment create failed';
            console.error('[PaySync]   ✗ Odoo rejected create:', msg, 'full error:', JSON.stringify(createResp.data.error));
            throw new Error(msg);
        }
        const paymentId = createResp.data?.result;
        console.log('[PaySync]   ✓ created, Odoo id:', paymentId);
        await saveOfflineIdMapping(offlineId, paymentId);

        // Post the payment so it shows "Posted" in Odoo.
        if (_postAfterCreate) {
            try {
                await axios.post(
                    `${baseUrl}/web/dataset/call_kw`,
                    { jsonrpc: '2.0', method: 'call', params: { model: 'account.payment', method: 'action_post', args: [[paymentId]], kwargs: targetCompanyId ? { context: { allowed_company_ids: [targetCompanyId] } } : {} } },
                    { headers, withCredentials: true, timeout: 15000 }
                );
                console.log('[OfflineSyncService] Posted account.payment id:', paymentId);
            } catch (postErr) {
                console.warn('[OfflineSyncService] action_post failed:', postErr?.message);
            }
        }

        // Read back name + state. Odoo assigns account.payment.name ONLY
        // after the state leaves draft (sequence fires on post). Treat '/'
        // and empty as "not yet assigned" and retry once to catch delayed
        // commits. Fall through to display_name, then to a fallback.
        try {
            const doRead = () => axios.post(`${baseUrl}/web/dataset/call_kw`, {
                jsonrpc: '2.0', method: 'call',
                params: { model: 'account.payment', method: 'read', args: [[paymentId]], kwargs: { fields: ['name', 'display_name', 'state', 'journal_id', 'company_id'] } },
            }, { headers, timeout: 10000 });
            let row = (await doRead()).data?.result?.[0] || {};
            const pickName = (r) => {
                if (r?.name && r.name !== '/') return r.name;
                if (r?.display_name && r.display_name !== '/') return r.display_name;
                return null;
            };
            let realName = pickName(row);
            if (!realName) {
                await new Promise((r) => setTimeout(r, 800));
                const retry = (await doRead()).data?.result?.[0] || {};
                row = { ...row, ...retry };
                realName = pickName(retry);
            }
            // Odoo hasn't assigned a sequence name yet (record is draft and
            // account.payment.name fires only on post). Predict the next PAY
            // name from the highest existing PAY… across both caches, so the
            // user sees an Odoo-style number right after sync — matches the
            // Easy Sales / Easy Purchase experience. When the user later
            // validates, action_post's real read-back overrides this.
            if (!realName) {
                try {
                    const names = [];
                    for (const k of ['@cache:accountPayments:inbound', '@cache:accountPayments:outbound', '@cache:accountPayments']) {
                        const r = await AsyncStorage.getItem(k);
                        if (!r) continue;
                        const list = JSON.parse(r) || [];
                        list.forEach((p) => { if (p?.name) names.push(String(p.name)); });
                    }
                    let best = null;
                    names.forEach((n) => {
                        const m = n.match(/^(.*?)(\d{2,})\s*$/);
                        if (m) {
                            const num = parseInt(m[2], 10);
                            if (!best || num > best.num) best = { prefix: m[1], num, width: m[2].length };
                        }
                    });
                    if (best) {
                        realName = `${best.prefix}${String(best.num + 1).padStart(best.width, '0')}`;
                        console.log('[PaySync] Odoo name still "/", predicted next:', realName);
                    }
                } catch (_) {}
            }
            for (const cacheKey of ['@cache:accountPayments:inbound', '@cache:accountPayments:outbound', '@cache:accountPayments']) {
            const rawList = await AsyncStorage.getItem(cacheKey);
            if (rawList) {
                const list = JSON.parse(rawList);
                const next = list.map((p) => {
                    if (String(p.id) === offlineId) {
                        return {
                            ...p,
                            id: paymentId,
                            // Prefer Odoo-assigned name; if still unassigned,
                            // keep the offline predicted/placeholder name.
                            name: realName || p.name,
                            state: row?.state || p.state || 'draft',
                            journal_name: row?.journal_id ? row.journal_id[1] : p.journal_name,
                            company_name: row?.company_id ? row.company_id[1] : p.company_name,
                            offline: false,
                        };
                    }
                    return p;
                });
                await AsyncStorage.setItem(cacheKey, JSON.stringify(next));
            }
            }
        } catch (e) { console.warn('[OfflineSyncService] payment read-back failed:', e?.message); }

        logSyncHistory(baseUrl, headers, { model: 'account.payment', operation: 'create', values: { partnerId, amount, paymentType }, syncedRecordId: paymentId }).catch(() => {});
        return paymentId;
    }

    // Payment action handlers — action_post / action_draft / action_cancel
    // for account.payment records. All three share the same shape: resolve
    // the real id (in case the payment was created offline too), run the
    // action method, fall back to alternative method names if needed, then
    // read back state and patch the cached payments list so the UI reflects
    // Odoo truth after sync.
    if (item.model === 'account.payment'
        && (item.operation === 'action_post' || item.operation === 'action_draft' || item.operation === 'action_cancel')) {
        console.log('[PaySync] ⇢ Processing', item.operation, 'queue item id:', item.id, 'values:', JSON.stringify(item.values));
        const { _recordId } = item.values || {};
        let realRecordId = _recordId;
        if (typeof realRecordId === 'string' && realRecordId.startsWith('offline_')) {
            const map = await readOfflineIdMap();
            console.log('[PaySync]   resolving offline id', realRecordId, '→', map[realRecordId]);
            if (map[realRecordId] === undefined) throw new Error(`Payment ${realRecordId} not yet synced`);
            realRecordId = map[realRecordId];
        }
        const numId = Number(realRecordId);
        console.log('[PaySync]   target Odoo payment id:', numId);

        const methodsByOp = {
            action_post:   ['action_post', 'action_validate', 'mark_as_paid'],
            action_draft:  ['action_draft', 'button_draft'],
            action_cancel: ['action_cancel'],
        };
        const candidates = methodsByOp[item.operation];

        // Helper to read current state — we accept the call only when state
        // actually moves (or when cancel sets it to a cancelled-like value).
        // Includes display_name so callers can pick the real Odoo sequence
        // name once it's been assigned.
        const readState = async () => {
            const r = await axios.post(
                `${baseUrl}/web/dataset/call_kw`,
                { jsonrpc: '2.0', method: 'call', params: { model: 'account.payment', method: 'read', args: [[numId]], kwargs: { fields: ['state', 'name', 'display_name'] } } },
                { headers, timeout: 10000 }
            );
            return r.data?.result?.[0];
        };
        // Treat '/' and empty as "name not yet assigned by Odoo sequence".
        const pickName = (r) => {
            if (r?.name && r.name !== '/') return r.name;
            if (r?.display_name && r.display_name !== '/') return r.display_name;
            return null;
        };

        const before = await readState().catch(() => null);
        console.log('[PaySync]   state BEFORE:', before?.state, 'name:', before?.name);
        let lastErr = null;
        let finalRow = before;
        for (const method of candidates) {
            try {
                console.log('[PaySync]   → calling', method, 'on', numId);
                const resp = await axios.post(
                    `${baseUrl}/web/dataset/call_kw`,
                    { jsonrpc: '2.0', method: 'call', params: { model: 'account.payment', method, args: [[numId]], kwargs: {} } },
                    { headers, timeout: 30000 }
                );
                if (resp.data?.error) {
                    lastErr = resp.data.error?.data?.message || resp.data.error?.message;
                    console.warn('[PaySync]   ✗', method, 'returned error:', lastErr);
                    continue;
                }
                console.log('[PaySync]   ✓', method, 'returned:', JSON.stringify(resp.data?.result));
                const after = await readState();
                const newState = after?.state;
                const prevState = before?.state;
                console.log('[PaySync]   state AFTER:', newState, 'name:', after?.name);
                const transitioned =
                    (item.operation === 'action_post' && newState && newState !== prevState) ||
                    (item.operation === 'action_draft' && newState === 'draft') ||
                    (item.operation === 'action_cancel' && (newState === 'cancelled' || newState === 'canceled' || newState === 'rejected'));
                if (transitioned) { console.log('[PaySync]   ★ accepted transition'); finalRow = after; break; }
                console.log('[PaySync]   ⤫ no transition, trying next method');
            } catch (e) {
                lastErr = e?.message;
                console.warn('[PaySync]   ✗', method, 'threw:', lastErr);
            }
        }
        if (finalRow === before && lastErr) {
            console.error('[PaySync]   ✗✗ all methods failed, last error:', lastErr);
            throw new Error(`${item.operation} failed: ${lastErr}`);
        }

        // If action_post fired but the sequence hasn't committed yet (name
        // still '/'), wait briefly and re-read so the cache gets PAY0000N.
        if (item.operation === 'action_post' && finalRow && !pickName(finalRow)) {
            try {
                await new Promise((r) => setTimeout(r, 800));
                const retry = await readState();
                if (retry) finalRow = { ...finalRow, ...retry };
            } catch (_) {}
        }
        // Only use a real Odoo-assigned sequence name. If Odoo still hasn't
        // handed one out (happens briefly on first post), keep whatever the
        // cache already has — e.g. the offline-predicted PAY0000N — so we
        // don't clobber a good label with a synthetic 'P<id>' fallback.
        const realName = pickName(finalRow);

        // Patch the cached list so any screen auto-refresh picks up the real state + name.
        try {
            for (const cacheKey of ['@cache:accountPayments:inbound', '@cache:accountPayments:outbound', '@cache:accountPayments']) {
              const raw = await AsyncStorage.getItem(cacheKey);
              if (raw) {
                const list = JSON.parse(raw);
                const next = list.map((p) => {
                    if (p.id === numId || String(p.id) === String(numId)) {
                        return {
                            ...p,
                            state: finalRow?.state || p.state,
                            name: realName || p.name,  // keep predicted name if Odoo hasn't assigned one yet
                        };
                    }
                    return p;
                });
                await AsyncStorage.setItem(cacheKey, JSON.stringify(next));
              }
            }
        } catch (_) {}

        logSyncHistory(baseUrl, headers, { model: 'account.payment', operation: item.operation, values: { id: numId }, syncedRecordId: numId }).catch(() => {});
        return numId;
    }

    // Contact (res.partner) create
    if (item.model === 'res.partner' && item.operation === 'create') {
        const offlineId = `offline_${item.id}`;
        const existingMap = await readOfflineIdMap();
        if (existingMap[offlineId] !== undefined) {
            console.log('[OfflineSyncService] contact already synced, reusing id:', existingMap[offlineId]);
            return existingMap[offlineId];
        }
        const response = await axios.post(
            `${baseUrl}/web/dataset/call_kw`,
            {
                jsonrpc: '2.0', method: 'call',
                params: { model: 'res.partner', method: 'create', args: [values], kwargs: {} },
            },
            { headers, timeout: 30000 }
        );
        if (response.data?.error) {
            throw new Error(response.data.error?.data?.message || 'Contact create failed');
        }
        const recordId = response.data?.result;
        console.log('[OfflineSyncService] Created res.partner id:', recordId);
        await saveOfflineIdMapping(offlineId, recordId);
        // Swap offline placeholder in the cached contact list with the real id.
        try {
            const raw = await AsyncStorage.getItem('@cache:contacts');
            if (raw) {
                const list = JSON.parse(raw);
                let changed = false;
                const next = list.map((c) => {
                    if (String(c.id) === offlineId) { changed = true; return { ...c, id: recordId, offline: false }; }
                    return c;
                });
                if (changed) await AsyncStorage.setItem('@cache:contacts', JSON.stringify(next));
            }
        } catch (_) {}
        logSyncHistory(baseUrl, headers, { model: 'res.partner', operation: 'create', values, syncedRecordId: recordId }).catch(() => {});
        return recordId;
    }

    // Contact (res.partner) write
    if (item.model === 'res.partner' && item.operation === 'write') {
        const { _recordId, ...rest } = values;
        let realRecordId = _recordId;
        if (typeof realRecordId === 'string' && realRecordId.startsWith('offline_')) {
            const map = await readOfflineIdMap();
            if (map[realRecordId] === undefined) throw new Error(`Record ${realRecordId} not yet synced`);
            realRecordId = map[realRecordId];
        }
        const response = await axios.post(
            `${baseUrl}/web/dataset/call_kw`,
            {
                jsonrpc: '2.0', method: 'call',
                params: { model: 'res.partner', method: 'write', args: [[Number(realRecordId)], rest], kwargs: {} },
            },
            { headers, timeout: 30000 }
        );
        if (response.data?.error) {
            throw new Error(response.data.error?.data?.message || 'Contact write failed');
        }
        console.log('[OfflineSyncService] Updated res.partner id:', realRecordId);
        logSyncHistory(baseUrl, headers, { model: 'res.partner', operation: 'write', values: rest, syncedRecordId: realRecordId }).catch(() => {});
        return realRecordId;
    }

    // Product write (edit)
    if (item.model === 'product.product' && item.operation === 'write') {
        const { _recordId, ...rest } = values;
        // Resolve if the record itself was offline-created but is now synced.
        let realRecordId = _recordId;
        if (typeof realRecordId === 'string' && realRecordId.startsWith('offline_')) {
            const map = await readOfflineIdMap();
            if (map[realRecordId] === undefined) {
                throw new Error(`Record ${realRecordId} not yet synced`);
            }
            realRecordId = map[realRecordId];
        }
        // Any category refs inside the edit values may also be offline_<id>.
        const resolvedValues = await resolveOfflineCategoryRefs(rest);
        const response = await axios.post(
            `${baseUrl}/web/dataset/call_kw`,
            {
                jsonrpc: '2.0',
                method: 'call',
                params: {
                    model: 'product.product',
                    method: 'write',
                    args: [[Number(realRecordId)], resolvedValues],
                    kwargs: {},
                },
            },
            { headers, timeout: 30000 }
        );
        if (response.data?.error) {
            throw new Error(response.data.error?.data?.message || 'Product write failed');
        }
        console.log('[OfflineSyncService] Updated product.product id:', realRecordId);
        logSyncHistory(baseUrl, headers, { model: 'product.product', operation: 'write', values: resolvedValues, syncedRecordId: realRecordId }).catch(() => {});
        return realRecordId;
    }

    // Category write (edit) — same fallback shape as create handler
    if ((item.model === 'pos.category' || item.model === 'product.category') && item.operation === 'write') {
        const { _recordId, ...rest } = values;
        let realRecordId = _recordId;
        if (typeof realRecordId === 'string' && realRecordId.startsWith('offline_')) {
            const map = await readOfflineIdMap();
            if (map[realRecordId] === undefined) {
                throw new Error(`Record ${realRecordId} not yet synced`);
            }
            realRecordId = map[realRecordId];
        }
        let model = item.model;
        let response = await axios.post(
            `${baseUrl}/web/dataset/call_kw`,
            {
                jsonrpc: '2.0', method: 'call',
                params: { model, method: 'write', args: [[Number(realRecordId)], rest], kwargs: {} },
            },
            { headers, timeout: 15000 }
        );
        if (response.data?.error && model === 'pos.category') {
            console.log('[OfflineSyncService] pos.category unavailable on write, trying product.category');
            model = 'product.category';
            response = await axios.post(
                `${baseUrl}/web/dataset/call_kw`,
                {
                    jsonrpc: '2.0', method: 'call',
                    params: { model, method: 'write', args: [[Number(realRecordId)], rest], kwargs: {} },
                },
                { headers, timeout: 15000 }
            );
        }
        if (response.data?.error) {
            throw new Error(response.data.error?.data?.message || 'Category write failed');
        }
        console.log('[OfflineSyncService] Updated', model, 'id:', realRecordId);
        logSyncHistory(baseUrl, headers, { model, operation: 'write', values: rest, syncedRecordId: realRecordId }).catch(() => {});
        return realRecordId;
    }

    // Fallback: try the offline_sync submit endpoint for non-attendance models
    const { submitOfflineRecord } = require('@api/services/offlineSyncApi');
    return await submitOfflineRecord({
        model: item.model,
        operation: item.operation,
        values: item.values,
    });
};

const flushOnce = async () => {
    if (flushing) { console.log('[OfflineSyncService] flush skipped — already in progress'); return { skipped: true }; }
    flushing = true;
    let synced = 0;
    let failed = 0;
    try {
        const items = await offlineQueue.getAll();
        console.log('[OfflineSyncService] flush started, queue has', items.length, 'items');
        if (items.length > 0) {
            console.log('[OfflineSyncService] queue contents:',
                items.map((it) => `${it.model}/${it.operation}(id=${it.id})`).join(', '));
        }
        if (items.length === 0) return { synced: 0, failed: 0, total: 0 };

        const online = await networkStatus.isOnline();
        if (!online) { console.log('[OfflineSyncService] flush aborted — offline'); return { synced: 0, failed: 0, total: items.length, offline: true }; }

        for (const item of items) {
            // Auto-remove poison pills (failed 5+ times)
            if ((item.retryCount || 0) >= 5) {
                console.warn('[OfflineSyncService] removing poison-pill:', item.id, item.model, 'lastError:', item.lastError);
                await offlineQueue.removeById(item.id);
                failed += 1;
                continue;
            }
            try {
                console.log('[OfflineSyncService] syncing item:', item.id, item.model, item.operation, 'retry:', item.retryCount || 0);
                await syncItemDirectly(item);
                await offlineQueue.removeById(item.id);
                synced += 1;
                console.log('[OfflineSyncService] SUCCESS:', item.id, item.model);
            } catch (e) {
                console.error('[OfflineSyncService] FAILED:', item.id, item.model, e?.message);
                await offlineQueue.markFailed(item.id, e?.message || 'sync failed');
                failed += 1;
            }
        }
        console.log('[OfflineSyncService] flush done: synced=', synced, 'failed=', failed);

        // Re-check: if items remain after flush, schedule another pass in 3s
        const remaining = await offlineQueue.getPendingCount();
        if (remaining > 0) {
            console.log('[OfflineSyncService] still', remaining, 'items in queue — scheduling retry');
            setTimeout(() => {
                flushOnce().catch((e) => console.warn('[OfflineSyncService] retry flush failed:', e?.message));
            }, 3000);
        }

        return { synced, failed, total: items.length };
    } finally {
        flushing = false;
        _notifyFlushIdle();
    }
};

/**
 * Manually trigger a flush.
 */
export const flush = async () => flushOnce();

/**
 * Force-flush used by the manual "Sync" button. Waits for any in-flight
 * flush to finish, resets retry counters so poison-pilled items (retryCount
 * >= 5) get another chance, then runs flushOnce to completion and loops once
 * more if items remain (covers chained creates → posts where round 1 drains
 * creates and round 2 drains the follow-up actions).
 */
export const forceFlush = async ({ maxRounds = 3 } = {}) => {
    console.log('[OfflineSyncService] forceFlush requested');
    // 1) Wait for any running flush to settle so we don't get "skipped".
    if (flushing) {
        console.log('[OfflineSyncService] forceFlush waiting for in-flight flush to finish');
        await new Promise((resolve) => {
            _flushIdleWaiters.push(resolve);
            // Safety timeout — don't hang forever.
            setTimeout(resolve, 10000);
        });
    }
    // 2) Reset retry counters so previously-failed items don't get dropped
    //    as poison pills on this pass.
    try {
        const reset = await offlineQueue.resetRetryCounts();
        console.log('[OfflineSyncService] forceFlush reset retry on', reset, 'items');
    } catch (e) { console.warn('[OfflineSyncService] retry reset failed:', e?.message); }
    // 3) Drain the queue. Loop a few rounds so chained operations (create
    //    then action_post that was queued with an offline_ id) can resolve
    //    via the offline-id map in successive passes.
    let total = { synced: 0, failed: 0 };
    for (let round = 0; round < maxRounds; round += 1) {
        const res = await flushOnce();
        console.log('[OfflineSyncService] forceFlush round', round + 1, '→', JSON.stringify(res));
        if (res?.skipped) {
            // Another flush beat us to it — wait for it to finish, then check.
            await new Promise((resolve) => {
                _flushIdleWaiters.push(resolve);
                setTimeout(resolve, 10000);
            });
        } else {
            total.synced += res?.synced || 0;
            total.failed += res?.failed || 0;
        }
        const remaining = await offlineQueue.getPendingCount();
        console.log('[OfflineSyncService] forceFlush after round', round + 1, 'remaining=', remaining);
        if (remaining === 0) break;
        // Small pause so ID map writes from the previous round settle.
        await new Promise((r) => setTimeout(r, 400));
    }
    const remaining = await offlineQueue.getPendingCount();
    return { ...total, remaining };
};

/**
 * Start the auto-flush service. Called once from App.js on boot.
 */
export const start = () => {
    if (started) return;
    started = true;

    // Flush on boot for leftover items from previous sessions.
    flushOnce().then((res) => {
        if (res && res.synced > 0) console.log('[OfflineSyncService] boot flush synced:', res.synced);
    }).catch((e) => console.warn('[OfflineSyncService] boot flush failed:', e?.message));

    // Auto-flush on offline→online transitions.
    unsubscribe = networkStatus.subscribe((online) => {
        console.log('[OfflineSyncService] connectivity changed:', online ? 'ONLINE' : 'OFFLINE');
        if (online) {
            if (retryTimer) clearTimeout(retryTimer);
            retryTimer = setTimeout(() => {
                console.log('[OfflineSyncService] auto-flush triggered by connectivity change');
                flushOnce().then((res) => {
                    console.log('[OfflineSyncService] auto-flush result:', JSON.stringify(res));
                }).catch((e) => console.warn('[OfflineSyncService] auto-flush failed:', e?.message));
            }, 500);
        }
    });

    // Flush when the app returns to foreground — covers the case where the
    // user backgrounded the app offline and reopened it on Wi-Fi.
    appStateSub = AppState.addEventListener('change', (next) => {
        if (next !== 'active') return;
        (async () => {
            try {
                const count = await offlineQueue.getPendingCount();
                if (count === 0) return;
                const online = await networkStatus.isOnline();
                if (!online) return;
                const res = await flushOnce();
                if (res && res.synced > 0) console.log('[OfflineSyncService] foreground flush synced:', res.synced);
            } catch (e) { console.warn('[OfflineSyncService] foreground flush failed:', e?.message); }
        })();
    });

    // Periodic retry every 30 seconds while online — catches items that failed
    // on the first attempt (e.g. Odoo was restarting while device had internet).
    setInterval(async () => {
        try {
            const count = await offlineQueue.getPendingCount();
            if (count > 0) {
                const online = await networkStatus.isOnline();
                if (online) {
                    const res = await flushOnce();
                    if (res && res.synced > 0) console.log('[OfflineSyncService] periodic flush synced:', res.synced);
                }
            }
        } catch (_) {}
    }, 30000);
};

/**
 * Stop the service.
 */
export const stop = () => {
    if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
    }
    if (appStateSub) {
        appStateSub.remove();
        appStateSub = null;
    }
    if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
    }
    started = false;
};

export default { start, stop, flush };
