import React, { useEffect } from 'react';
import { LogBox } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import Toast from 'react-native-toast-message';
import CustomToast from '@components/Toast/CustomToast';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { GestureHandlerRootView } from 'react-native-gesture-handler'; // Import GestureHandlerRootView
import StackNavigator from '@navigation/StackNavigator';
import { Provider } from 'react-native-paper';
import OfflineSyncService from '@services/OfflineSyncService';
import CacheWarmer from '@services/CacheWarmer';
import offlineQueue from '@utils/offlineQueue';
import { Asset } from 'expo-asset';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { hydrateOfficeTimezone } from '@utils/officeTime';
import { installOdooSessionGuard } from '@utils/odooSession';

// Re-login + retry when the stored Odoo session has expired (Odoo answers
// call_kw with a bare 404 on multi-database servers). Covers every axios call.
installOdooSessionGuard();

// One-time migration of legacy un-namespaced sale-order maps into the
// per-DB A-map for the currently-active Odoo DB. Runs once per DB.
const _migrateSToAMap = async () => {
  try {
    const db = (await AsyncStorage.getItem('odoo_db')) || '';
    if (!db) return;
    const sentinelKey = `@a_map_migrated:${db}`;
    if ((await AsyncStorage.getItem(sentinelKey)) === '1') return;
    const dbAMapKey = `a_map:${db}`;
    const dbAMapRaw = await AsyncStorage.getItem(dbAMapKey);
    const dbAMap = dbAMapRaw ? JSON.parse(dbAMapRaw) : {};
    let added = 0;
    // Convert legacy "S10003"-style labels to "A0000N" so the user-facing
    // head text is always A-prefixed. The numeric tail is preserved (drop
    // the 10000 offset that the old S-counter started from).
    const _convertSToA = (label) => {
      const m = String(label || '').match(/^S(\d+)$/i);
      if (!m) return label; // already A-prefixed (or unrecognised) — leave alone
      const n = parseInt(m[1], 10);
      const localN = n > 10000 ? n - 10000 : n;
      return `A${String(localN).padStart(5, '0')}`;
    };
    const sMapRaw = await AsyncStorage.getItem('inv_map_s');
    if (sMapRaw) {
      const sMap = JSON.parse(sMapRaw);
      for (const [id, label] of Object.entries(sMap || {})) {
        if (!dbAMap[id]) { dbAMap[id] = _convertSToA(label); added += 1; }
      }
    }
    const flatARaw = await AsyncStorage.getItem('a_map');
    if (flatARaw) {
      const flatA = JSON.parse(flatARaw);
      for (const [id, label] of Object.entries(flatA || {})) {
        if (!dbAMap[id]) { dbAMap[id] = _convertSToA(label); added += 1; }
      }
    }
    // Heal any S-prefixed entries that already made it into the per-DB map
    // from a previous boot of this code.
    for (const [id, label] of Object.entries(dbAMap)) {
      const fixed = _convertSToA(label);
      if (fixed !== label) { dbAMap[id] = fixed; added += 1; }
    }
    if (added > 0) {
      await AsyncStorage.setItem(dbAMapKey, JSON.stringify(dbAMap));
      console.log('[App] Migrated', added, 'legacy S/A entries into', dbAMapKey);
    }
    await AsyncStorage.setItem(sentinelKey, '1');
  } catch (e) { console.warn('[App] S→A migration failed:', e?.message); }
};

// Boot-time guard against cross-DB cache leaks. AsyncStorage cache keys are
// not namespaced per Odoo database, so without this check the user would
// keep seeing the previous DB's products / contacts / payments after
// switching tenants — even when the login flow's same check missed (cookie
// still valid, fresh build, app reopen, etc.). The stamp is updated by both
// this helper and the login screen.
const _wipeCachesIfDbChanged = async () => {
  try {
    const currentDb = await AsyncStorage.getItem('odoo_db');
    const stampedDb = await AsyncStorage.getItem('@cache:_dbStamp');
    if (currentDb && stampedDb && currentDb !== stampedDb) {
      const allKeys = await AsyncStorage.getAllKeys();
      // Wipe everything that holds DB-content. Note: per-DB-namespaced keys
      // (a_map:<db>, @a_counter:<db>, saved_credentials map keyed per-DB)
      // survive — they are intentionally segregated and remembered across
      // DB switches.
      // Wipe stale @cache:* (DB-content), the legacy un-namespaced product
      // cache, sync queue, etc. Per-DB-scoped keys (`@cache:db:<db>:*`,
      // `a_map:<db>`, `@a_counter:<db>`) survive — they belong to the OTHER
      // tenant and remain valid when the user switches back.
      const stale = allKeys.filter((k) =>
        // Legacy global @cache:* — but skip per-DB-scoped @cache:db:<db>:*.
        (k.startsWith('@cache:') && !k.startsWith('@cache:db:') && k !== '@cache:_dbStamp') ||
        k.startsWith('cart_') ||
        k.startsWith('@offline_queue') ||
        k.startsWith('@offline_id_map') ||
        k.startsWith('@lastSyncError:') ||
        // Legacy un-namespaced sale-order S/A maps from older builds:
        k === 'inv_map_s' || k === 'inv_counter_s' || k === 'inv_reset_s10003' ||
        k === 'a_map' || k === '@a_counter'
      );
      if (stale.length > 0) await AsyncStorage.multiRemove(stale);
      console.log('[App] DB mismatch on boot (', stampedDb, '→', currentDb, '), cleared', stale.length, 'stale entries');
    }
    // Also wipe LEGACY un-namespaced product caches at every boot, even
    // when the DB hasn't changed — they were leaking across tenants for
    // users on older app versions and can be safely re-fetched.
    try {
      const allKeys2 = await AsyncStorage.getAllKeys();
      const legacyProducts = allKeys2.filter((k) =>
        (k === '@cache:products' || k.startsWith('@cache:products:cat:'))
        && !k.startsWith('@cache:db:')
      );
      if (legacyProducts.length > 0) {
        await AsyncStorage.multiRemove(legacyProducts);
        console.log('[App] Cleared', legacyProducts.length, 'legacy un-namespaced product keys');
      }
    } catch (_) {}
    if (currentDb) await AsyncStorage.setItem('@cache:_dbStamp', currentDb);
  } catch (e) { console.warn('[App] DB stamp check failed:', e?.message); }
};
export default function App() {

  LogBox.ignoreLogs(["new NativeEventEmitter"]);
  LogBox.ignoreAllLogs();

  LogBox.ignoreLogs([
    "Non-serializable values were found in the navigation state",
  ]);

  // Start the offline sync background flusher once on app boot. It listens
  // for connectivity changes and auto-flushes the on-device queue to Odoo
  // when the device comes back online.
  useEffect(() => {
    // Seed the office timezone from cache the moment the app boots, BEFORE the
    // user can navigate to any attendance screen. Without this, the office tz
    // cache is empty until the late config loads async, and times briefly
    // render in the device timezone, then repaint in office time. Hydrating
    // here populates it from the persisted value so office time shows first.
    hydrateOfficeTimezone().catch(() => { /* ignore — getLateConfig refreshes it */ });

    // One-time cleanup: remove any broken queue items from older code versions
    // (e.g. items with operation='checkout' that Odoo rejects).
    offlineQueue.getAll().then(async (items) => {
      for (const item of items) {
        if (item.operation !== 'create' && item.operation !== 'method') {
          await offlineQueue.removeById(item.id);
          console.log('[App] Cleaned invalid queue item:', item.id, item.operation);
        }
        if ((item.retryCount || 0) >= 3) {
          await offlineQueue.removeById(item.id);
          console.log('[App] Cleaned failed queue item:', item.id);
        }
      }
    }).catch(() => {});

    // Wipe stale per-DB caches BEFORE starting the sync + warmer so neither
    // service refills/reads against the wrong DB. The helper is non-blocking
    // for first-time installs (no stamp → no-op).
    _wipeCachesIfDbChanged()
      .then(_migrateSToAMap)
      .finally(() => {
      OfflineSyncService.start();
      // Pull-side background worker: warms every list cache on boot (if logged
      // in + online) and again on every offline → online transition, so the
      // user doesn't have to visit each screen to populate offline data.
      CacheWarmer.start();
    });

    // Pre-cache the 369 logo so the confirmation popups (StyledAlertModal,
    // LogoutModal) can render it offline. In Expo Go / dev client, required
    // images are normally served over Metro — if the device goes offline
    // before the image has been rendered once, the <Image> stays blank.
    // Downloading via expo-asset copies the bundled file to the on-device
    // cache so subsequent renders resolve from disk.
    Asset.fromModule(require('@assets/images/logo/logo.png'))
      .downloadAsync()
      .catch(() => { /* ignore — nothing we can do if preload fails */ });

    return () => {
      OfflineSyncService.stop();
      CacheWarmer.stop();
    };
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Provider>
      <NavigationContainer>
        <SafeAreaProvider>
          <BottomSheetModalProvider>
            <StackNavigator />
          </BottomSheetModalProvider>
          <Toast config={CustomToast} />
        </SafeAreaProvider>
      </NavigationContainer>
      </Provider>
    </GestureHandlerRootView>
  );
}
