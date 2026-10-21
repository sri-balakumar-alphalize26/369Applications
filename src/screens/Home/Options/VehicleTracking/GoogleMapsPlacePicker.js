import React, { useState, useRef } from 'react';
import { View, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { WebView } from 'react-native-webview';
import { useNavigation } from '@react-navigation/native';
import { SafeAreaView } from '@components/containers';
import { NavigationHeader } from '@components/Header';
import Text from '@components/Text';
import { COLORS, FONT_FAMILY } from '@constants/theme';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { parseGoogleMapsUrl } from '@utils/googleMapsUrl';
import { getAddressFromCoords } from '@utils/addressFromCoords';

// Trip destination picker that shows the Google Maps WEBSITE inside the app —
// Google's own search and places, no API key. The driver searches and taps a
// place as in Google Maps; we watch the page address (it holds the place name
// and coordinates, see googleMapsUrl.js) and show the place in the bottom bar.
// "Use this place" hands {name, latitude, longitude} back to
// VehicleTrackingForm via the `onPicked` route param — same contract as
// DestinationMapPicker, which stays available as the "Use our map" fallback.

// Google Maps changes the address without reloading the page, so report it
// from inside the page whenever it changes.
//
// The WebView re-runs injectedJavaScript every time Google's page reports a
// load (many times per visit), so each script below installs itself only once
// per page; otherwise its timers and listeners pile up.
const WATCH_URL_JS = `
  (function () {
    if (window.__rnPickerWatch) return;
    window.__rnPickerWatch = true;
    var last = '';
    function check() {
      if (location.href !== last) {
        last = location.href;
        window.ReactNativeWebView && window.ReactNativeWebView.postMessage(last);
      }
    }
    check();
    setInterval(check, 700);
  })();
  true;
`;

// Trim Google's page down to search + map. Matched by Google's stable
// "ml-" class names or by visible English text (the obfuscated classes change
// often). If Google changes its page, these simply stop matching — search,
// map and place pages keep working.
const TIDY_PAGE_JS = `
  (function () {
    if (window.__rnPickerTidy) return;
    window.__rnPickerTidy = true;
    // "Google Maps | Open app" bar at the top, and the 45px gap Google leaves
    // for it above the map.
    var style = document.createElement('style');
    style.textContent = '.ml-persistent-promo-banner{display:none!important}'
      + '#app.ml-app-container{top:0!important;bottom:0!important;height:auto!important}'
      + '.rn-map-full{height:100%!important;max-height:none!important;bottom:0!important}'
      // Search box: hide the side-menu button (left) and the account icon (right).
      + '.ml-searchbox-visibility-container button[aria-label="Menu"],'
      + '.ml-searchbox-visibility-container [aria-label="Sign in"]{display:none!important}';
    (document.head || document.documentElement).appendChild(style);
    setTimeout(function () { window.dispatchEvent(new Event('resize')); }, 300);

    function textOf(el) { return (el.innerText || el.textContent || '').trim(); }

    function tidy() {
      // "Open the Google Maps app?" popup -> press "Keep using web".
      var buttons = document.querySelectorAll('button, [role="button"]');
      for (var i = 0; i < buttons.length; i++) {
        if (textOf(buttons[i]) === 'Keep using web') { buttons[i].click(); break; }
      }
      // Start panel (Directions / Public transport / Nearby places /
      // Map details / Feedback) — hide the whole panel it lives in.
      var labels = document.querySelectorAll('label');
      for (var j = 0; j < labels.length; j++) {
        if (textOf(labels[j]) !== 'Map details') continue;
        var panel = labels[j].closest('[role="toolbar"]');
        if (panel && panel.style.display !== 'none') {
          panel.style.display = 'none';
          growMap();
        }
      }
    }

    // On phones Google shrinks the map to leave room for that panel (a
    // bottom sheet) — stretch the map (the largest block in the page) back
    // to full height.
    function growMap() {
      var app = document.getElementById('app');
      if (!app) return;
      var big = null, area = 0;
      for (var i = 0; i < app.children.length; i++) {
        var r = app.children[i].getBoundingClientRect();
        if (r.width * r.height > area) { area = r.width * r.height; big = app.children[i]; }
      }
      if (big && !big.classList.contains('rn-map-full')) {
        big.classList.add('rn-map-full');
        setTimeout(function () { window.dispatchEvent(new Event('resize')); }, 100);
      }
    }
    tidy();
    setInterval(tidy, 500);
  })();
  true;
`;

// Inside the app Google can serve its lighter map made of image tiles (seen
// on the tablet). There a quick tap on a place does nothing — only a
// long-press drops a pin. So a quick single tap on the map is replayed as a
// long-press at the same spot, which makes Google pin and open that place.
// Double-tap zoom, pinch and drags are left alone, and so is a tap Google
// already handled itself (the address turned into a place).
const TAP_TO_PIN_JS = `
  (function () {
    if (window.__rnPickerTapToPin) return;
    window.__rnPickerTapToPin = true;
    var start = null, pending = null;

    // The tapped element when it sits on the tile map (the #app block that
    // holds the image tiles), not on a button or a panel over it.
    function mapElementAt(x, y) {
      var el = document.elementFromPoint(x, y);
      if (!el || el.closest('button, a, input, textarea, [role="button"], [role="link"]')) return null;
      var app = document.getElementById('app');
      var block = el;
      while (block && block.parentElement !== app) block = block.parentElement;
      return block && block.querySelector('img[src^="blob:"]') ? el : null;
    }

    function longPress(el, x, y) {
      var id = 4242;
      function pointer(type) {
        return new PointerEvent(type, {
          bubbles: true, cancelable: true, composed: true, pointerId: id, pointerType: 'touch',
          isPrimary: true, clientX: x, clientY: y, screenX: x, screenY: y,
          button: 0, buttons: type === 'pointerup' ? 0 : 1,
        });
      }
      function touch(type) {
        var t = new Touch({ identifier: id, target: el, clientX: x, clientY: y, screenX: x, screenY: y, pageX: x, pageY: y });
        var list = type === 'touchend' ? [] : [t];
        return new TouchEvent(type, {
          bubbles: true, cancelable: true, composed: true, touches: list, targetTouches: list, changedTouches: [t],
        });
      }
      el.dispatchEvent(pointer('pointerdown'));
      el.dispatchEvent(touch('touchstart'));
      setTimeout(function () {
        el.dispatchEvent(pointer('pointerup'));
        el.dispatchEvent(touch('touchend'));
      }, 700);
    }

    // On window (capture), which runs before the map's own handlers can stop
    // the event from reaching document.
    // Only real input (isTrusted) — never our own replayed press. pointerType
    // isn't checked: some devices report '' instead of 'touch' for a finger.
    window.addEventListener('pointerdown', function (e) {
      if (!e.isTrusted) return;
      // A second finger or a second tap (double-tap zoom) cancels the pin,
      // and that second tap doesn't start one of its own.
      var secondTap = !!pending;
      if (pending) { clearTimeout(pending); pending = null; }
      start = e.isPrimary && !secondTap ? { x: e.clientX, y: e.clientY, t: Date.now(), href: location.href } : null;
    }, true);

    window.addEventListener('pointercancel', function (e) {
      if (e.isTrusted) start = null;
    }, true);

    window.addEventListener('pointerup', function (e) {
      if (!e.isTrusted || !start) return;
      var s = start;
      start = null;
      var moved = Math.abs(e.clientX - s.x) + Math.abs(e.clientY - s.y);
      if (moved > 12 || Date.now() - s.t > 400) return;
      var el = mapElementAt(s.x, s.y);
      if (!el) return;
      pending = setTimeout(function () {
        pending = null;
        if (location.href !== s.href && /\\/maps\\/place\\//.test(location.href)) return;
        longPress(el, s.x, s.y);
      }, 350);
    }, true);
  })();
  true;
`;

// A normal mobile Chrome identity, so Google serves its full mobile site.
const MOBILE_CHROME_UA =
  'Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/124.0.0.0 Mobile Safari/537.36';

// Always open the plain map (centred on the current destination or the
// driver), so Google shows an empty "Find a place" box — never the old
// destination's page, which would hide the search when changing it.
const buildStartUrl = (lat, lng) => {
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    return `https://www.google.com/maps/@${lat},${lng},15z`;
  }
  return 'https://www.google.com/maps';
};

const GoogleMapsPlacePicker = ({ route }) => {
  const navigation = useNavigation();
  const params = route?.params || {};
  const { initialLatitude, initialLongitude, initialName, onPicked } = params;

  const startUrlRef = useRef(buildStartUrl(Number(initialLatitude), Number(initialLongitude)));
  const currentName = (initialName || '').trim();

  const [place, setPlace] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);

  const handleUrl = (url) => {
    const parsed = parseGoogleMapsUrl(url);
    if (!parsed?.isPlace) return;
    console.log('[gmaps-picker] place:', parsed.name, parsed.latitude, parsed.longitude);
    setPlace(parsed);
  };

  const openOurMap = () => navigation.replace('DestinationMapPicker', params);

  // Keep the driver inside the page: block "Open app" / intent:// links.
  const handleShouldStart = (req) => {
    const url = req?.url || '';
    if (/^https?:\/\//i.test(url) || url.startsWith('about:')) return true;
    console.log('[gmaps-picker] blocked link:', url.slice(0, 80));
    return false;
  };

  const handleUse = async () => {
    if (!place || saving) return;
    setSaving(true);
    let name = place.name;
    if (!name) name = await getAddressFromCoords(place.latitude, place.longitude);
    if (!name) name = `${place.latitude.toFixed(5)}, ${place.longitude.toFixed(5)}`;
    console.log('[gmaps-picker] confirm destination:', name, place.latitude, place.longitude);
    if (typeof onPicked === 'function') {
      onPicked({ name, latitude: place.latitude, longitude: place.longitude });
    }
    navigation.goBack();
  };

  return (
    <SafeAreaView>
      <NavigationHeader
        title="Select Destination"
        onBackPress={() => navigation.goBack()}
        logo={false}
        headerRight={(
          <TouchableOpacity onPress={openOurMap} style={styles.ourMapBtn}>
            <MaterialCommunityIcons name="map-outline" size={16} color="#fff" />
            <Text style={styles.ourMapText}>Use our map</Text>
          </TouchableOpacity>
        )}
      />

      <View style={styles.mapWrap}>
        {loadFailed ? (
          <View style={styles.errorBox}>
            <MaterialCommunityIcons name="alert-circle-outline" size={40} color={COLORS.gray} />
            <Text style={styles.errorText}>Google Maps didn't load.</Text>
            <TouchableOpacity style={styles.errorBtn} onPress={openOurMap}>
              <Text style={styles.errorBtnText}>Use our map</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <WebView
            source={{ uri: startUrlRef.current }}
            // Fresh session each time — otherwise Google reopens the last
            // place viewed and hides the search box when changing destination.
            incognito
            userAgent={MOBILE_CHROME_UA}
            onLoadStart={() => console.log('[gmaps-picker] open:', startUrlRef.current)}
            injectedJavaScript={WATCH_URL_JS + TIDY_PAGE_JS + TAP_TO_PIN_JS}
            onMessage={(e) => handleUrl(e.nativeEvent.data)}
            onNavigationStateChange={(nav) => handleUrl(nav?.url)}
            onShouldStartLoadWithRequest={handleShouldStart}
            setSupportMultipleWindows={false}
            geolocationEnabled
            javaScriptEnabled
            domStorageEnabled
            startInLoadingState
            renderLoading={() => (
              <View style={styles.loading}>
                <ActivityIndicator size="large" color={COLORS.primaryThemeColor} />
              </View>
            )}
            onError={(e) => {
              console.log('[gmaps-picker] WebView ERROR:', e?.nativeEvent?.description);
              setLoadFailed(true);
            }}
            style={StyleSheet.absoluteFill}
          />
        )}
      </View>

      {/* Chosen place + confirm */}
      <View style={styles.footer}>
        <View style={styles.selectedRow}>
          <MaterialCommunityIcons
            name={place ? 'map-marker-check' : 'map-marker-question-outline'}
            size={20}
            color={COLORS.primaryThemeColor}
          />
          <View style={styles.selectedTextWrap}>
            <Text style={styles.selectedText} numberOfLines={2}>
              {place
                ? (place.name || 'Dropped pin')
                : (currentName ? `Now: ${currentName}` : 'Search and tap a place in Google Maps')}
            </Text>
            {!!place && (
              <Text style={styles.coordsText}>
                {place.latitude.toFixed(5)}, {place.longitude.toFixed(5)}
              </Text>
            )}
            {!place && !!currentName && (
              <Text style={styles.coordsText}>Search and tap a new place to change it</Text>
            )}
          </View>
        </View>
        <TouchableOpacity
          style={[styles.confirmBtn, !place && styles.confirmBtnDisabled]}
          onPress={handleUse}
          disabled={!place || saving}
        >
          {saving
            ? <ActivityIndicator color="#fff" />
            : <Text style={styles.confirmBtnText}>Use this place</Text>}
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  ourMapBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.6)',
  },
  ourMapText: { color: '#fff', marginLeft: 4, fontSize: 12, fontFamily: FONT_FAMILY.urbanistSemiBold },
  mapWrap: { flex: 1, backgroundColor: '#e9e9e9' },
  loading: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: '#e9e9e9' },
  errorBox: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  errorText: { marginTop: 10, fontSize: 15, fontFamily: FONT_FAMILY.urbanistMedium, color: '#333' },
  errorBtn: {
    marginTop: 16,
    backgroundColor: COLORS.primaryThemeColor,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 24,
  },
  errorBtnText: { color: '#fff', fontSize: 14, fontFamily: FONT_FAMILY.urbanistSemiBold },
  footer: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 16,
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderTopColor: '#EEE',
  },
  selectedRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  selectedTextWrap: { flex: 1, marginLeft: 8 },
  selectedText: { fontSize: 14, fontFamily: FONT_FAMILY.urbanistMedium, color: '#222' },
  coordsText: { fontSize: 11, fontFamily: FONT_FAMILY.urbanistRegular, color: COLORS.gray, marginTop: 2 },
  confirmBtn: {
    backgroundColor: COLORS.primaryThemeColor,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  confirmBtnDisabled: { backgroundColor: '#B7C2CE' },
  confirmBtnText: { color: '#fff', fontSize: 15, fontFamily: FONT_FAMILY.urbanistSemiBold },
});

export default GoogleMapsPlacePicker;
