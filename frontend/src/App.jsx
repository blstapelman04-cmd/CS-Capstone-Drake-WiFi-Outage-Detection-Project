import { useState, useEffect, useRef } from 'react'
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";
 
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});
 
const DRAKE_CENTER = [41.6025, -93.653];
 
const buildings = [
  { name: "Old Main", lat: 41.603, lng: -93.6528, category: "academic", description: "Historic centerpiece of Drake's campus, built in 1882." },
  { name: "Cowles Library", lat: 41.6022, lng: -93.6517, category: "academic", description: "Drake's main library and research hub." },
  { name: "Olmsted Center", lat: 41.601, lng: -93.6538, category: "student life", description: "Student union with dining, meeting rooms, and services." },
  { name: "Harmon Fine Arts Center", lat: 41.6038, lng: -93.6512, category: "academic", description: "Home to Drake's art, theatre, and music programs." },
  { name: "Sheslow Auditorium", lat: 41.6033, lng: -93.6522, category: "academic", description: "Landmark performance hall inside Old Main." },
  { name: "Drake Stadium", lat: 41.5993, lng: -93.6558, category: "athletics", description: "Host of the renowned Drake Relays track & field event." },
  { name: "Knapp Center (Shivers)", lat: 41.6003, lng: -93.6545, category: "athletics", description: "Basketball arena and recreation facility." },
  { name: "Meredith Hall", lat: 41.6042, lng: -93.6535, category: "academic", description: "Houses the College of Business and Public Administration." },
  { name: "Hubbell Dining Hall", lat: 41.6015, lng: -93.652, category: "student life", description: "Main residential dining facility on campus." },
  { name: "Aliber Hall", lat: 41.6028, lng: -93.6542, category: "academic", description: "Home to Drake Law School." },
];
 
const categoryColors = {
  academic: "#004B8D",
  athletics: "#C8102E",
  "student life": "#F5A623",
};

const corner1 = L.latLng(41.596, -93.662); // Bottom-left
const corner2 = L.latLng(41.607, -93.645); // Top-right
const campusBounds = L.latLngBounds(corner1, corner2);
 
function makeIcon(color) {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="28" height="38" viewBox="0 0 28 38">
      <path d="M14 0C6.27 0 0 6.27 0 14c0 9.625 14 24 14 24S28 23.625 28 14C28 6.27 21.73 0 14 0z"
        fill="${color}" stroke="white" stroke-width="2"/>
      <circle cx="14" cy="14" r="6" fill="white"/>
    </svg>`;
  return L.divIcon({ html: svg, className: "", iconSize: [28, 38], iconAnchor: [14, 38], popupAnchor: [0, -38] });
}
 
function App() {
  const mapRef = useRef(null);
  const mapInstanceRef = useRef(null);
 
  useEffect(() => {
    if (mapInstanceRef.current) return;
 
    const map = L.map(mapRef.current, { center: DRAKE_CENTER, zoom: 16, maxBounds: campusBounds, maxBoundsViscosity: 1.0, minZoom: 16});
 
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap contributors",
      maxZoom: 19,
    }).addTo(map);
 
    const layers = {
      academic: L.layerGroup().addTo(map),
      athletics: L.layerGroup().addTo(map),
      "student life": L.layerGroup().addTo(map),
    };
 
    buildings.forEach((b) => {
      const color = categoryColors[b.category];
      L.marker([b.lat, b.lng], { icon: makeIcon(color) })
        .bindPopup(`
          <div style="font-family: Georgia, serif; min-width: 160px;">
            <div style="background:${color}; color:white; margin:-8px -12px 8px; padding:8px 12px; border-radius:4px 4px 0 0; font-weight:bold; font-size:14px;">${b.name}</div>
            <span style="display:inline-block; background:${color}22; color:${color}; font-size:11px; font-weight:600; padding:2px 7px; border-radius:20px; margin-bottom:6px; text-transform:uppercase; letter-spacing:.5px;">${b.category}</span>
            <p style="margin:0; font-size:13px; color:#333; line-height:1.4;">${b.description}</p>
          </div>
        `)
        .addTo(layers[b.category]);
    });
 
    L.control.layers(null, {
      "🎓 Academic": layers.academic,
      "🏟️ Athletics": layers.athletics,
      "🍽️ Student Life": layers["student life"],
    }).addTo(map);
 
    mapInstanceRef.current = map;
 
    return () => {
      map.remove();
      mapInstanceRef.current = null;
    };
  }, []);
 
  return (
    <div style={{ fontFamily: "Georgia, serif", height: "100vh", display: "flex", flexDirection: "column" }}>
      <div style={{ background: "#004B8D", color: "white", padding: "16px 24px", display: "flex", alignItems: "center", gap: "14px", flexShrink: 0 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: "22px", letterSpacing: "0.5px" }}>Drake University</h1>
          <p style={{ margin: "2px 0 0", fontSize: "13px", opacity: 0.8 }}>Interactive Campus Map · Des Moines, Iowa</p>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: "16px", fontSize: "12px" }}>
          {Object.entries(categoryColors).map(([cat, color]) => (
            <span key={cat} style={{ display: "flex", alignItems: "center", gap: "5px" }}>
              <span style={{ width: 12, height: 12, borderRadius: "50%", background: color, display: "inline-block" }} />
              {cat.charAt(0).toUpperCase() + cat.slice(1)}
            </span>
          ))}
        </div>
      </div>
      <div ref={mapRef} style={{ flex: 1, width: "100%" }} />
    </div>
  );
}
 
export default App