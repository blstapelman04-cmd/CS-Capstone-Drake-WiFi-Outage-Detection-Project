import { useState, useEffect, useRef } from 'react'
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";
import { supabase } from './supabase'

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

const DRAKE_CENTER = [41.6025, -93.653];
const corner1 = L.latLng(41.596, -93.662);
const corner2 = L.latLng(41.608, -93.645);
const campusBounds = L.latLngBounds(corner1, corner2);

const TILE_URLS = {
  dark:  'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
};

const STATUS_COLOR = {
  online:   '#1d9e75',
  offline:  '#e24b4a',
  degraded: '#ba7517',
  unknown:  '#6b7280',
};

const THEME = {
  dark: {
    bg: '#0f1117', bgPanel: '#12151f', border: '#1e2330', borderSubtle: '#1a1e2e',
    textPrimary: '#f1f5f9', textBody: '#dde3ee', textMuted: '#8ea0b8', textEmpty: '#5a6a80',
    tabActiveBg: '#e2e8f0', tabActiveClr: '#0f1117', tabInactBdr: '#2a3045',
    listActiveBg: '#1a2035', dotGlow: true,
  },
  light: {
    bg: '#f4f4f2', bgPanel: '#ffffff', border: '#ddddd8', borderSubtle: '#ebebea',
    textPrimary: '#111111', textBody: '#222222', textMuted: '#4a4a4a', textEmpty: '#777777',
    tabActiveBg: '#1a1a1a', tabActiveClr: '#ffffff', tabInactBdr: '#bbbbbb',
    listActiveBg: '#f0efed', dotGlow: false,
  },
};

// Minutes of silence before a device is considered stale/offline
const STALE_MINUTES = 15;
// Hours of history to average uptime over
const UPTIME_WINDOW_HOURS = 6;

// Derive wifi status from the most recent report.
// If the device is stale (hasn't reported recently), we can't know the
// wifi status — return 'unknown' rather than 'offline', since the issue
// is with the device connection, not necessarily the wifi itself.
function deriveStatus(report, isStale) {
  if (isStale || !report) return 'unknown';
  const pcts = [report.eduroam_pct, report.du_entertainment_pct, report.du_guest_pct];
  if (pcts.every(p => p === 0 || p == null)) return 'offline';
  if (pcts.some(p => p != null && p < 80)) return 'degraded';
  return 'online';
}

// Best available avg ping across the three networks (lowest non-null value)
function bestPing(report) {
  if (!report) return null;
  const vals = [report.eduroam_avg, report.du_entertainment_avg, report.du_guest_avg]
    .filter(v => v != null && v > 0);
  if (!vals.length) return null;
  return Math.round(Math.min(...vals));
}

function pingClass(ping) {
  if (!ping) return 'bad';
  if (ping <= 30) return 'good';
  if (ping <= 80) return 'warn';
  return 'bad';
}

function valColor(cls) {
  if (cls === 'good') return '#1d9e75';
  if (cls === 'bad')  return '#e24b4a';
  if (cls === 'warn') return '#ba7517';
  return null;
}

function pctClass(pct) {
  if (pct == null) return 'bad';
  if (pct >= 95) return 'good';
  if (pct >= 75) return 'warn';
  return 'bad';
}

function makeIcon(status, isSelected) {
  const color = STATUS_COLOR[status];
  if (isSelected) {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="44" height="58" viewBox="-2 -2 44 58" style="overflow:visible">
        <path d="M20 0C8.95 0 0 8.95 0 20c0 13.75 20 34 20 34S40 33.75 40 20C40 8.95 31.05 0 20 0z"
          fill="${color}" stroke="white" stroke-width="2.5"/>
        <circle cx="20" cy="20" r="8" fill="white" opacity="0.95"/>
      </svg>`;
    return L.divIcon({ html: svg, className: '', iconSize: [44, 58], iconAnchor: [22, 58], popupAnchor: [0, -60] });
  }
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="42" viewBox="-2 -2 32 42" style="overflow:visible">
      <path d="M14 0C6.27 0 0 6.27 0 14c0 9.625 14 24 14 24S28 23.625 28 14C28 6.27 21.73 0 14 0z"
        fill="${color}" stroke="white" stroke-width="2"/>
      <circle cx="14" cy="14" r="5.5" fill="white" opacity="0.9"/>
    </svg>`;
  return L.divIcon({ html: svg, className: '', iconSize: [32, 42], iconAnchor: [16, 42], popupAnchor: [0, -44] });
}

// ── Data fetching ────────────────────────────────────────────────────────────

async function fetchLocations() {
  // 1. All devices
  const { data: devices, error: devErr } = await supabase
    .from('devices')
    .select('id, name, latitude, longitude, last_seen_at')
    .order('name');

  if (devErr) throw devErr;

  const deviceIds  = devices.map(d => d.id);
  const windowStart = new Date(Date.now() - UPTIME_WINDOW_HOURS * 60 * 60 * 1000).toISOString();

  // 2. All reports within the uptime window (for averaging)
  const { data: windowReports, error: repErr } = await supabase
    .from('wifi_ping_reports')
    .select('device_id, server_timestamp, eduroam_avg, du_entertainment_avg, du_guest_avg, eduroam_pct, du_entertainment_pct, du_guest_pct')
    .in('device_id', deviceIds)
    .gte('server_timestamp', windowStart)
    .order('server_timestamp', { ascending: false });

  if (repErr) throw repErr;

  // 3. For devices with NO reports in the window, fetch their single latest
  //    report ever so we can show a real "last seen" timestamp
  const devicesInWindow = new Set(windowReports.map(r => r.device_id));
  const devicesOutside  = deviceIds.filter(id => !devicesInWindow.has(id));

  let fallbackLatest = {}; // device_id → single latest report
  if (devicesOutside.length > 0) {
    // Supabase doesn't support DISTINCT ON, so fetch one row per device
    // by querying each individually — typically a very small set
    const fallbackPromises = devicesOutside.map(id =>
      supabase
        .from('wifi_ping_reports')
        .select('device_id, server_timestamp')
        .eq('device_id', id)
        .order('server_timestamp', { ascending: false })
        .limit(1)
        .single()
    );
    const fallbackResults = await Promise.all(fallbackPromises);
    for (const { data } of fallbackResults) {
      if (data) fallbackLatest[data.device_id] = data;
    }
  }

  // Group window reports by device
  const reportsByDevice = {};
  for (const r of windowReports) {
    if (!reportsByDevice[r.device_id]) reportsByDevice[r.device_id] = [];
    reportsByDevice[r.device_id].push(r);
  }

  function avg(arr) {
    const vals = arr.filter(v => v != null);
    if (!vals.length) return null;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  }

  const now = Date.now();

  return devices.map(d => {
    const deviceReports = reportsByDevice[d.id] || [];
    const latestInWindow = deviceReports[0] || null;

    // True last report: either from the window or the fallback query
    const trueLatest = latestInWindow || fallbackLatest[d.id] || null;
    const lastTs  = trueLatest ? new Date(trueLatest.server_timestamp).getTime() : null;
    const ageMs   = lastTs ? now - lastTs : Infinity;
    const isStale = ageMs > STALE_MINUTES * 60 * 1000;

    // Human-readable staleness: show minutes if <2h, hours otherwise
    let staleLabel = null;
    if (isStale && lastTs) {
      const mins  = Math.round(ageMs / 60000);
      const hours = Math.round(ageMs / 3600000);
      staleLabel = mins < 120 ? `${mins} min ago` : `${hours} hours ago`;
    }
    // No record at all in the database
    const neverReported = trueLatest === null;

    // 6-hour averaged uptimes and pings (null if no window data)
    const avgUptime = {
      eduroam:          avg(deviceReports.map(r => r.eduroam_pct)),
      du_entertainment: avg(deviceReports.map(r => r.du_entertainment_pct)),
      du_guest:         avg(deviceReports.map(r => r.du_guest_pct)),
    };
    const avgPing = {
      eduroam:          avg(deviceReports.map(r => r.eduroam_avg          != null ? Math.abs(r.eduroam_avg)          : null)),
      du_entertainment: avg(deviceReports.map(r => r.du_entertainment_avg != null ? Math.abs(r.du_entertainment_avg) : null)),
      du_guest:         avg(deviceReports.map(r => r.du_guest_avg         != null ? Math.abs(r.du_guest_avg)         : null)),
    };

    const status = deriveStatus(latestInWindow, isStale);
    const ping   = bestPing(latestInWindow);

    return {
      id:            d.id,
      name:          d.name,
      lat:           d.latitude,
      lng:           d.longitude > 0 ? -d.longitude : d.longitude,
      lastSeen:      d.last_seen_at,
      status,
      ping,
      isStale,
      staleLabel,
      neverReported,
      lastReportTs:  trueLatest?.server_timestamp || null,
      reportCount:   deviceReports.length,
      report:        latestInWindow,
      avgUptime,
      avgPing,
    };
  });
}

// ── Global style reset ───────────────────────────────────────────────────────
// Injected into <head> so we don't need a separate CSS file
const GLOBAL_STYLES = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body, #root { height: 100%; width: 100%; overflow: hidden; }
  html { height: -webkit-fill-available; }
  body { min-height: -webkit-fill-available; }
`;

// ── Component ────────────────────────────────────────────────────────────────

export default function App() {
  const mapRef         = useRef(null);
  const mapInstanceRef = useRef(null);
  const tileLayerRef   = useRef(null);
  const markersRef     = useRef({});
  const panelRef       = useRef(null); // tracks bottom panel for invalidateSize

  const [isDark,     setIsDark]     = useState(() => {
    const saved = localStorage.getItem('drakeMapDarkMode');
    return saved !== null ? saved === 'true' : true;
  });
  const [isMobile,   setIsMobile]   = useState(() => window.innerWidth < 768);
  const [selected,   setSelected]   = useState(() => {
    const saved = sessionStorage.getItem('drakeMapSelected');
    return saved ? Number(saved) : null;
  });
  const [filter,     setFilter]     = useState('all');
  const [clock,      setClock]      = useState('');
  const [locations,  setLocations]  = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState(null);

  const t = isDark ? THEME.dark : THEME.light;

  // Inject global CSS reset once on mount
  useEffect(() => {
    const style = document.createElement('style');
    style.textContent = GLOBAL_STYLES;
    document.head.appendChild(style);
    return () => document.head.removeChild(style);
  }, []);

  // When panel height changes on mobile, tell Leaflet to recalculate the map size
  // so the visible map area matches the actual rendered area
  useEffect(() => {
    if (!mapInstanceRef.current) return;
    const timer = setTimeout(() => {
      mapInstanceRef.current.invalidateSize({ animate: false });
    }, 320); // slightly after the CSS transition finishes (300ms)
    return () => clearTimeout(timer);
  }, [selected, isMobile]);

  // Track mobile breakpoint
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  // Persist selected device across refreshes (clears when tab closes)
  useEffect(() => {
    if (selected !== null) sessionStorage.setItem('drakeMapSelected', String(selected));
    else sessionStorage.removeItem('drakeMapSelected');
  }, [selected]);

  // Clock
  useEffect(() => {
    const tick = () => setClock(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  // Fetch data then refresh every 60 seconds
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const locs = await fetchLocations();
        if (!cancelled) { setLocations(locs); setError(null); }
      } catch (e) {
        if (!cancelled) setError(e.message || 'Failed to load data');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    const id = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Init map (once)
  useEffect(() => {
    if (mapInstanceRef.current) return;
    const map = L.map(mapRef.current, {
      center: DRAKE_CENTER, zoom: 16,
      maxBounds: campusBounds, maxBoundsViscosity: 1.0, minZoom: 15,
    });
    tileLayerRef.current = L.tileLayer(TILE_URLS[isDark ? 'dark' : 'light'], {
      attribution: '© OpenStreetMap © CARTO', maxZoom: 19,
    }).addTo(map);
    mapInstanceRef.current = map;
    return () => { map.remove(); mapInstanceRef.current = null; };
  }, []);

  // Swap tiles on theme change
  useEffect(() => {
    if (!tileLayerRef.current) return;
    tileLayerRef.current.setUrl(isDark ? TILE_URLS.dark : TILE_URLS.light);
  }, [isDark]);

  // Sync markers whenever locations data changes
  useEffect(() => {
    if (!mapInstanceRef.current) return;
    const map = mapInstanceRef.current;

    // Remove markers that are no longer in the data
    const currentIds = new Set(locations.map(l => l.id));
    Object.keys(markersRef.current).forEach(id => {
      if (!currentIds.has(Number(id))) {
        markersRef.current[id].remove();
        delete markersRef.current[id];
      }
    });

    // Add or update markers
    locations.forEach(loc => {
      const isSelected = selected === loc.id;
      if (markersRef.current[loc.id]) {
        markersRef.current[loc.id].setIcon(makeIcon(loc.status, isSelected));
      } else {
        const marker = L.marker([loc.lat, loc.lng], { icon: makeIcon(loc.status, false) });
        marker.on('click', () => setSelected(prev => prev === loc.id ? null : loc.id));
        marker.addTo(map);
        markersRef.current[loc.id] = marker;
      }
    });
  }, [locations]);

  // Update selected marker ring without rebuilding all markers
  useEffect(() => {
    locations.forEach(loc => {
      const marker = markersRef.current[loc.id];
      if (marker) marker.setIcon(makeIcon(loc.status, selected === loc.id));
    });
  }, [selected]);

  const selectedLoc = locations.find(l => l.id === selected) || null;
  const counts = {
    online:   locations.filter(l => l.status === 'online').length,
    offline:  locations.filter(l => l.status === 'offline').length,
    degraded: locations.filter(l => l.status === 'degraded').length,
    unknown:  locations.filter(l => l.status === 'unknown').length,
  };
  const filtered = filter === 'all' ? locations : locations.filter(l => l.status === filter);

  // Per-network breakdown for the detail panel
  const NETWORKS = [
    { label: 'eduroam',         pctKey: 'eduroam',          avgKey: 'eduroam' },
    { label: 'DUEntertainment', pctKey: 'du_entertainment', avgKey: 'du_entertainment' },
    { label: 'DUGuest',         pctKey: 'du_guest',         avgKey: 'du_guest' },
  ];

  function formatTimestamp(ts) {
    if (!ts) return null;
    const d = new Date(ts);
    const date = d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return { date, time };
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100svh', fontFamily: "'DM Mono', 'Courier New', monospace", background: t.bg, color: t.textPrimary, overflow: 'hidden', transition: 'background 0.25s, color 0.25s' }}>

      {/* ── Top bar ── */}
      {isMobile ? (
        <div style={{ background: t.bg, borderBottom: `1px solid ${t.border}`, flexShrink: 0, padding: '8px 12px', transition: 'background 0.25s' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.1em', color: t.textPrimary, textTransform: 'uppercase' }}>
                Drake WiFi Monitor
              </div>
              <div style={{ fontSize: 10, color: t.textMuted, letterSpacing: '0.07em' }}>
                Campus Network Status
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ fontSize: 11, color: t.textMuted, fontVariantNumeric: 'tabular-nums' }}>{clock}</div>
              <button
                onClick={() => setIsDark(d => { const next = !d; localStorage.setItem('drakeMapDarkMode', String(next)); return next; })}
                style={{ background: 'none', border: `1px solid ${t.border}`, borderRadius: 4, padding: '3px 8px', cursor: 'pointer', color: t.textMuted, fontSize: 13, fontFamily: 'inherit' }}
              >
                {isDark ? '☀️' : '🌙'}
              </button>
            </div>
          </div>
          {!loading && !error && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {[['online', counts.online], ['degraded', counts.degraded], ['offline', counts.offline], ['unknown', counts.unknown]].map(([s, n]) => (
                <span key={s} style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', padding: '2px 8px', borderRadius: 2, background: STATUS_COLOR[s] + '22', color: STATUS_COLOR[s], border: `1px solid ${STATUS_COLOR[s]}55`, textTransform: 'uppercase' }}>
                  {n} {s}
                </span>
              ))}
            </div>
          )}
          {loading && <span style={{ fontSize: 11, color: t.textMuted }}>Loading…</span>}
          {error   && <span style={{ fontSize: 11, color: STATUS_COLOR.offline }}>⚠ {error}</span>}
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 20px', background: t.bg, borderBottom: `1px solid ${t.border}`, flexShrink: 0, transition: 'background 0.25s' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: '0.12em', color: t.textPrimary, textTransform: 'uppercase' }}>
                Drake University · WiFi Monitor
              </div>
              <div style={{ fontSize: 11, color: t.textMuted, letterSpacing: '0.08em' }}>
                Campus Network Status · Des Moines, Iowa
              </div>
            </div>
            {!loading && !error && (
              <div style={{ display: 'flex', gap: 8 }}>
                {[['online', counts.online], ['degraded', counts.degraded], ['offline', counts.offline], ['unknown', counts.unknown]].map(([s, n]) => (
                  <span key={s} style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', padding: '3px 10px', borderRadius: 2, background: STATUS_COLOR[s] + '22', color: STATUS_COLOR[s], border: `1px solid ${STATUS_COLOR[s]}55`, textTransform: 'uppercase' }}>
                    {n} {s}
                  </span>
                ))}
              </div>
            )}
            {loading && <span style={{ fontSize: 11, color: t.textMuted, letterSpacing: '0.1em' }}>Loading…</span>}
            {error   && <span style={{ fontSize: 11, color: STATUS_COLOR.offline, letterSpacing: '0.1em' }}>⚠ {error}</span>}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ fontSize: 12, color: t.textMuted, letterSpacing: '0.1em', fontVariantNumeric: 'tabular-nums' }}>{clock}</div>
            <button
              onClick={() => setIsDark(d => { const next = !d; localStorage.setItem('drakeMapDarkMode', String(next)); return next; })}
              style={{ display: 'flex', alignItems: 'center', gap: 7, background: 'none', border: `1px solid ${t.border}`, borderRadius: 4, padding: '4px 10px', cursor: 'pointer', color: t.textMuted, fontSize: 11, fontFamily: 'inherit', letterSpacing: '0.08em', transition: 'all 0.2s' }}
            >
              <span style={{ fontSize: 14 }}>{isDark ? '☀️' : '🌙'}</span>
              <span style={{ textTransform: 'uppercase', fontWeight: 700 }}>{isDark ? 'Light' : 'Dark'}</span>
            </button>
          </div>
        </div>
      )}

      {/* ── Body ── */}
      <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', flex: 1, overflow: 'hidden' }}>

        {/* Map */}
        <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
          <div
            ref={mapRef}
            style={{
              width: '100%',
              height: '100%',
              filter: isDark ? 'brightness(1.8) contrast(.8)' : 'contrast(1) saturate(0.95)',
            }}
          />
        </div>

        {/* ── Side/bottom panel ── */}
        <div
          ref={panelRef}
          style={{
            ...(isMobile
              ? {
                  width: '100%',
                  // Collapsed: show ~4 list items. Expanded: show detail + list.
                  height: selected ? '52vh' : '38vw',
                  maxHeight: '65vh',
                  flexDirection: 'column',
                  borderTop: `1px solid ${t.border}`,
                  borderLeft: 'none',
                  // Safe area inset for Safari home bar
                  paddingBottom: 'env(safe-area-inset-bottom)',
                }
              : { width: 260, flexDirection: 'column', borderLeft: `1px solid ${t.border}` }
            ),
            display: 'flex',
            background: t.bgPanel,
            overflow: 'hidden',
            flexShrink: 0,
            transition: 'background 0.25s, height 0.3s ease',
          }}
        >
          {/* Detail box — only shown when something is selected */}
          {selectedLoc && (
            <div style={{ padding: isMobile ? '10px 14px' : '14px 16px', borderBottom: `1px solid ${t.border}`, flexShrink: 0, overflowY: 'auto', maxHeight: isMobile ? '30vh' : '55vh' }}>
              <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.18em', color: t.textMuted, textTransform: 'uppercase', marginBottom: 8 }}>
                Location Detail
              </div>

              <div style={{ fontSize: 13, fontWeight: 700, color: t.textPrimary, marginBottom: 4, letterSpacing: '0.04em' }}>
                {selectedLoc.name}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', borderBottom: `1px solid ${t.borderSubtle}`, marginBottom: 8 }}>
                <span style={{ fontSize: 11, color: t.textMuted }}>Status</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: STATUS_COLOR[selectedLoc.status] }}>{selectedLoc.status}</span>
              </div>

              {selectedLoc.isStale && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', marginBottom: 8, borderRadius: 3, background: STATUS_COLOR.unknown + '18', border: `1px solid ${STATUS_COLOR.unknown}44` }}>
                  <span style={{ fontSize: 12 }}>⚠</span>
                  <span style={{ fontSize: 11, color: STATUS_COLOR.unknown, fontWeight: 700 }}>
                    {selectedLoc.neverReported ? 'No reports in the past 7 days' : `Last report ${selectedLoc.staleLabel} — wifi status unknown`}
                  </span>
                </div>
              )}

              {/* Network rows — compact (one line) on mobile, two rows on desktop */}
              {NETWORKS.map(({ label, pctKey, avgKey }) => {
                const pct   = selectedLoc.avgUptime?.[pctKey] ?? null;
                const avgMs = selectedLoc.avgPing?.[avgKey]   ?? null;
                return (
                  <div key={label} style={{ marginBottom: isMobile ? 5 : 10 }}>
                    <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', color: t.textMuted, textTransform: 'uppercase', marginBottom: 3, paddingBottom: 2, borderBottom: `1px solid ${t.border}` }}>
                      {label}
                    </div>
                    {isMobile ? (
                      // Compact: uptime and ping on one line
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '3px 0' }}>
                        <span style={{ fontSize: 11, color: t.textMuted }}>Uptime</span>
                        <span style={{ fontSize: 12, fontWeight: 700, color: valColor(pctClass(pct)) || t.textPrimary }}>
                          {pct != null ? pct.toFixed(1) + '%' : '—'}
                        </span>
                        <span style={{ fontSize: 11, color: t.textMuted, marginLeft: 10 }}>Ping</span>
                        <span style={{ fontSize: 12, fontWeight: 700, color: valColor(pingClass(avgMs)) || t.textPrimary }}>
                          {avgMs != null ? avgMs.toFixed(0) + ' ms' : '—'}
                        </span>
                      </div>
                    ) : (
                      <>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', borderBottom: `1px solid ${t.borderSubtle}` }}>
                          <span style={{ fontSize: 11, color: t.textMuted }}>Uptime (6h)</span>
                          <span style={{ fontSize: 12, fontWeight: 700, color: valColor(pctClass(pct)) || t.textPrimary }}>{pct != null ? pct.toFixed(1) + '%' : '—'}</span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', borderBottom: `1px solid ${t.borderSubtle}` }}>
                          <span style={{ fontSize: 11, color: t.textMuted }}>Avg Ping (6h)</span>
                          <span style={{ fontSize: 12, fontWeight: 700, color: valColor(pingClass(avgMs)) || t.textPrimary }}>{avgMs != null ? avgMs.toFixed(0) + ' ms' : '—'}</span>
                        </div>
                      </>
                    )}
                  </div>
                );
              })}

              {!isMobile && (() => {
                const ts = formatTimestamp(selectedLoc.lastReportTs);
                return (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '5px 0', marginTop: 2 }}>
                    <span style={{ fontSize: 11, color: t.textMuted }}>Last Report</span>
                    {ts ? (
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: 11, color: t.textMuted }}>{ts.date}</div>
                        <div style={{ fontSize: 11, color: t.textMuted }}>{ts.time}</div>
                      </div>
                    ) : (
                      <span style={{ fontSize: 11, color: STATUS_COLOR.unknown }}>No reports (7 days)</span>
                    )}
                  </div>
                );
              })()}
            </div>
          )}

          {/* Empty state hint when nothing selected — mobile only */}
          {!selectedLoc && isMobile && (
            <div style={{ padding: '10px 14px', borderBottom: `1px solid ${t.border}`, flexShrink: 0 }}>
              <div style={{ fontSize: 12, color: t.textEmpty, lineHeight: 1.6 }}>Tap a marker or location to see details.</div>
            </div>
          )}

          {/* Empty state — desktop */}
          {!selectedLoc && !isMobile && (
            <div style={{ padding: '14px 16px', borderBottom: `1px solid ${t.border}`, flexShrink: 0 }}>
              <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.18em', color: t.textMuted, textTransform: 'uppercase', marginBottom: 10 }}>Location Detail</div>
              <div style={{ fontSize: 12, color: t.textEmpty, lineHeight: 1.7 }}>Select a marker on the map or a location in the list below.</div>
            </div>
          )}

          {/* Filter tabs */}
          <div style={{ display: 'flex', gap: 5, padding: '6px 12px', borderBottom: `1px solid ${t.border}`, background: t.bg, flexShrink: 0, flexWrap: 'wrap', transition: 'background 0.25s' }}>
            {['all', 'online', 'degraded', 'offline', 'unknown'].map(f => {
              const active = filter === f;
              return (
                <button key={f} onClick={() => setFilter(f)} style={{ fontSize: 10, padding: '3px 8px', borderRadius: 2, border: `1px solid ${active ? t.tabActiveBg : t.tabInactBdr}`, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', transition: 'all 0.15s', background: active ? t.tabActiveBg : 'transparent', color: active ? t.tabActiveClr : t.textMuted }}>
                  {f}
                </button>
              );
            })}
          </div>

          {/* List — tighter padding on mobile so more items fit */}
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {filtered.map(loc => (
              <div
                key={loc.id}
                onClick={() => setSelected(prev => prev === loc.id ? null : loc.id)}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: isMobile ? '6px 12px' : '9px 14px', borderBottom: `1px solid ${t.borderSubtle}`, cursor: 'pointer', transition: 'background 0.1s', background: selected === loc.id ? t.listActiveBg : 'transparent' }}
              >
                <div style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: STATUS_COLOR[loc.status], boxShadow: t.dotGlow ? `0 0 5px ${STATUS_COLOR[loc.status]}99` : 'none' }} />
                <span style={{ flex: 1, fontSize: 12, color: t.textBody, letterSpacing: '0.03em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {loc.name}
                </span>
                <span style={{ fontSize: 10, color: t.textMuted, fontVariantNumeric: 'tabular-nums' }}>
                  {loc.ping != null ? loc.ping + 'ms' : '—'}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
