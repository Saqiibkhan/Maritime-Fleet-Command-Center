import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
  Polyline,
  Rectangle,
  Tooltip,
} from 'react-leaflet';
import L from 'leaflet';
import {
  Anchor,
  ShieldAlert,
  Navigation,
  BatteryCharging,
  History,
  Bot,
  Radio,
  Check,
  X,
  Fuel,
  Package,
  Wind,
  Ship,
} from 'lucide-react';

const SOCKET_URL = process.env.REACT_APP_SOCKET_URL || 'http://localhost:4000';
const socket = io(SOCKET_URL, { reconnectionAttempts: 5 });

const STATUS_COLORS = {
  normal: '#10b981',
  warning: '#f59e0b',
  distress: '#ef4444',
  maintenance: '#6b7280',
};

const createShipIcon = (status, name) => {
  const color = STATUS_COLORS[status] || '#3b82f6';
  return L.divIcon({
    className: 'custom-ship-icon',
    html: `
      <div style="
        background-color: ${color};
        width: 16px;
        height: 16px;
        border-radius: 50% 50% 50% 50% / 60% 60% 40% 40%;
        border: 2px solid white;
        box-shadow: 0 0 8px ${color};
        transform: rotate(${status === 'normal' ? '0' : '0'});
      "></div>
      <div class="ship-label" style="
        position: absolute;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        font-size: 9px;
        color: white;
        white-space: nowrap;
        text-shadow: 1px 1px 1px rgba(0,0,0,0.8);
        font-weight: 600;
      ">${name}</div>
    `,
    iconSize: [50, 40],
    iconAnchor: [25, 20],
  });
};

const ROUTE_COLORS = {
  fast: '#ef4444',
  safe: '#10b981',
  eco: '#3b82f6',
};

function App() {
  const [ships, setShips] = useState([]);
  const [eventLog, setEventLog] = useState([]);
  const [selectedShip, setSelectedShip] = useState(null);

  const [routeOptions, setRouteOptions] = useState(null);
  const [aiSuggestions, setAiSuggestions] = useState([]);
  const [activeAidRequest, setActiveAidRequest] = useState(null);

  const [historyBuffer, setHistoryBuffer] = useState([]);
  const [isPlayback, setIsPlayback] = useState(false);
  const [playbackIndex, setPlaybackIndex] = useState(0);
  const [showPlaybackBar, setShowPlaybackBar] = useState(false);

  const mapRef = useRef(null);
  const playbackSliderRef = useRef(null);

  useEffect(() => {
    socket.on('connect', () => {
      console.log('Connected to fleet command backend');
    });

    socket.on('fleetStateUpdate', ({ ships: updatedShips, eventLog: updatedLog }) => {
      if (!isPlayback) {
        setShips(updatedShips);
        setEventLog(updatedLog);
      }
    });

    socket.on('newEvent', (event) => {
      setEventLog((prev) => [...prev, event]);
    });

    socket.on('routeOptionsGenerated', ({ shipId, routes }) => {
      setRouteOptions({ shipId, routes });
    });

    socket.on('aidRequestBroadcast', (aidReq) => {
      setActiveAidRequest(aidReq);
    });

    return () => {
      socket.off('connect');
      socket.off('fleetStateUpdate');
      socket.off('newEvent');
      socket.off('routeOptionsGenerated');
      socket.off('aidRequestBroadcast');
    };
  }, [isPlayback]);

  const fetchPlaybackHistory = async () => {
    try {
      const res = await fetch(`${SOCKET_URL}/api/history`);
      const data = await res.json();
      setHistoryBuffer(data.ringBuffer || []);
      if (data.ringBuffer && data.ringBuffer.length > 0) {
        setPlaybackIndex(data.ringBuffer.length - 1);
        setShowPlaybackBar(true);
        setIsPlayback(true);
      }
    } catch (err) {
      console.error('Failed to fetch history:', err);
    }
  };

  const fetchAiAdvisor = async () => {
    try {
      const res = await fetch(`${SOCKET_URL}/api/ai-advisor`);
      const data = await res.json();
      setAiSuggestions(data.suggestions || []);
    } catch (err) {
      console.error('Failed to fetch AI suggestions:', err);
    }
  };

  const handleScrub = (e) => {
    const idx = parseInt(e.target.value, 10);
    setPlaybackIndex(idx);
    if (historyBuffer[idx]) {
      setShips(historyBuffer[idx].ships);
      setEventLog(historyBuffer[idx].events || []);
    }
  };

  const handlePlayPause = () => {
    if (isPlayback && historyBuffer.length > 0 && playbackIndex < historyBuffer.length - 1) {
      const timer = setInterval(() => {
        setPlaybackIndex((prev) => {
          if (prev >= historyBuffer.length - 1) {
            clearInterval(timer);
            return prev;
          }
          const next = prev + 1;
          if (historyBuffer[next]) {
            setShips(historyBuffer[next].ships);
            setEventLog(historyBuffer[next].events || []);
          }
          return next;
        });
      }, 1000);
    }
  };

  const displayShips = isPlayback && historyBuffer[playbackIndex]
    ? historyBuffer[playbackIndex].ships
    : ships;

  const distressedShips = displayShips.filter((s) => s.status === 'distress' || s.status === 'warning');

  return (
    <div className="flex h-screen w-screen bg-slate-950 text-slate-100 font-sans overflow-hidden">
      {/* Left Sidebar */}
      <div className="w-96 border-r border-slate-800 bg-slate-900/90 flex flex-col z-10 overflow-hidden">
        {/* Header */}
        <div className="p-4 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Anchor className="text-blue-400 h-6 w-6" />
            <h1 className="text-lg font-bold tracking-wide">Maritime Command</h1>
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <div className={`w-2 h-2 rounded-full ${socket.connected ? 'bg-green-400 animate-pulse' : 'bg-red-400'}`}></div>
            <span>{socket.connected ? 'Online' : 'Connecting...'}</span>
          </div>
        </div>

        {/* Fleet Summary */}
        <div className="px-4 py-3 border-b border-slate-800 bg-slate-950/60">
          <div className="grid grid-cols-4 gap-2 text-center">
            <div>
              <div className="text-2xl font-bold text-blue-400">{displayShips.length}</div>
              <div className="text-[10px] text-slate-500 uppercase">Vessels</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-emerald-400">
                {displayShips.filter((s) => s.status === 'normal').length}
              </div>
              <div className="text-[10px] text-slate-500 uppercase">Nominal</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-amber-400">
                {displayShips.filter((s) => s.status === 'warning').length}
              </div>
              <div className="text-[10px] text-slate-500 uppercase">Caution</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-red-400">
                {displayShips.filter((s) => s.status === 'distress').length}
              </div>
              <div className="text-[10px] text-slate-500 uppercase">Distress</div>
            </div>
          </div>
        </div>

        {/* Fleet List */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
            Fleet Manifest ({displayShips.length} vessels)
          </h2>
          {displayShips.map((ship) => {
            const isSelected = selectedShip?.shipId === ship.shipId;
            return (
              <div
                key={ship.shipId}
                onClick={() => setSelectedShip(ship)}
                className={`
                  p-3 rounded-lg border transition-all cursor-pointer
                  ${isSelected
                    ? 'border-blue-500 bg-blue-950/30 ring-1 ring-blue-500/50'
                    : 'border-slate-800 bg-slate-800/40 hover:bg-slate-800/80'}
                `}
              >
                <div className="flex justify-between items-start">
                  <div className="flex items-center gap-2">
                    <div
                      className="w-3 h-3 rounded-full"
                      style={{ backgroundColor: STATUS_COLORS[ship.status] || '#3b82f6' }}
                    ></div>
                    <div>
                      <span className="font-semibold text-sm">{ship.name}</span>
                      <span className="text-xs text-slate-400 ml-2">({ship.shipId})</span>
                    </div>
                  </div>
                  <span
                    className={`px-2 py-0.5 text-[10px] font-bold rounded uppercase
                      ${ship.status === 'distress'
                        ? 'bg-red-900/60 text-red-300 border border-red-700'
                        : ship.status === 'warning'
                        ? 'bg-amber-900/60 text-amber-300 border border-amber-700'
                        : 'bg-emerald-900/60 text-emerald-300 border border-emerald-700'}
                    `}
                  >
                    {ship.status}
                  </span>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-slate-300">
                  <div><Fuel className="w-3 h-3 inline mr-1" />Fuel: <span className="font-mono">{ship.fuel} L</span></div>
                  <div><Wind className="w-3 h-3 inline mr-1" />{ship.speed} kn</div>
                  <div><Package className="w-3 h-3 inline mr-1" />{ship.cargo.split(' ').slice(0, 2).join(' ')}</div>
                  <div><Ship className="w-3 h-3 inline mr-1" />{ship.destination}</div>
                </div>
                {ship.heading !== undefined && (
                  <div className="mt-1 text-xs text-slate-400">
                    HDG: {ship.heading}° • Pos: [{ship.position[0].toFixed(2)}, {ship.position[1].toFixed(2)}]
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Events Feed */}
        <div className="h-56 border-t border-slate-800 bg-slate-950/60 p-3 overflow-y-auto text-xs">
          <div className="flex items-center justify-between mb-2">
            <span className="font-semibold text-slate-400 flex items-center gap-1">
              <Radio className="w-3 h-3 text-red-400" /> Event Stream
            </span>
            <span className="text-[10px] text-slate-500">{eventLog.length} events</span>
          </div>
          <div className="space-y-1.5">
            {eventLog.slice().reverse().map((ev) => (
              <div
                key={ev.id}
                className={`
                  p-2 rounded border text-slate-300
                  ${ev.severity === 'critical'
                    ? 'bg-red-950/40 border-red-800/50'
                    : ev.severity === 'high'
                    ? 'bg-amber-950/40 border-amber-800/50'
                    : 'bg-slate-900/40 border-slate-800'}
                `}
              >
                <span className="text-[10px] text-slate-500">{ev.timestamp}</span>
                <p className="mt-0.5 font-medium">{ev.message}</p>
                <span
                  className={`text-[9px] px-1.5 py-0.25 rounded uppercase
                    ${ev.severity === 'critical'
                      ? 'bg-red-900/40 text-red-300'
                      : ev.severity === 'high'
                      ? 'bg-amber-900/40 text-amber-300'
                      : 'bg-slate-700 text-slate-400'}
                  `}
                >
                  {ev.severity}
                </span>
              </div>
            ))}
            {eventLog.length === 0 && (
              <div className="text-slate-500 text-center py-4">No events yet</div>
            )}
          </div>
        </div>
      </div>

      {/* Main Map Area */}
      <div className="flex-1 flex flex-col relative">
        {/* Top Toolbar */}
        <div className="absolute top-4 left-4 right-4 z-[1000] flex justify-between items-center pointer-events-none">
          <div className="flex gap-2 pointer-events-auto">
            <button
              onClick={fetchPlaybackHistory}
              className={`
                px-3 py-1.5 rounded-md text-xs font-semibold flex items-center gap-1.5 border shadow-lg transition
                ${isPlayback
                  ? 'bg-amber-600 border-amber-500 text-white'
                  : 'bg-slate-800 border-slate-700 hover:bg-slate-700'}
              `}
            >
              <History className="w-4 h-4" />
              Historical Timeline Scrubbing
            </button>
            <button
              onClick={fetchAiAdvisor}
              className="px-3 py-1.5 rounded-md bg-indigo-600 border border-indigo-500 text-xs font-semibold flex items-center gap-1.5 shadow-lg hover:bg-indigo-500 transition"
            >
              <Bot className="w-4 h-4" />
              AI Fleet Advisor
            </button>
            {distressedShips.length > 0 && (
              <div className="px-3 py-1.5 rounded-md bg-red-950/40 border border-red-700/50 text-xs font-semibold flex items-center gap-1.5 animate-pulse">
                <ShieldAlert className="w-4 h-4 text-red-400" />
                {distressedShips.length} {distressedShips.length === 1 ? 'vessel' : 'vessels'} need attention
              </div>
            )}
          </div>
        </div>

        {/* Map */}
        <div className="flex-1 w-full h-full">
          <MapContainer
            center={[26.0, 54.5]}
            zoom={7}
            className="w-full h-full bg-slate-950"
            ref={mapRef}
            whenCreated={(mapInstance) => {
              mapRef.current = mapInstance;
            }}
          >
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />

            {/* Ship Markers */}
            {displayShips.map((ship) => (
              <Marker
                key={ship.shipId}
                position={ship.position}
                icon={createShipIcon(ship.status, ship.name)}
                eventHandlers={{
                  click: () => setSelectedShip(ship),
                }}
              >
                <Popup className="text-slate-900">
                  <div className="text-xs min-w-[140px]">
                    <strong className="text-sm text-slate-800">{ship.name}</strong>
                    <span className="text-slate-500"> ({ship.shipId})</span>
                    <hr className="my-1 border-slate-300" />
                    <div className="grid grid-cols-2 gap-0.5">
                      <span>Speed:</span>
                      <span className="font-mono">{ship.speed} kn</span>
                      <span>Heading:</span>
                      <span className="font-mono">{ship.heading}°</span>
                      <span>Fuel:</span>
                      <span className="font-mono">{ship.fuel} L</span>
                      <span>Destination:</span>
                      <span className="font-mono">{ship.destination}</span>
                      <span>Cargo:</span>
                      <span className="font-mono">{ship.cargo}</span>
                      <span>Status:</span>
                      <span className="font-mono capitalize">{ship.status}</span>
                    </div>
                  </div>
                </Popup>
                <Tooltip direction="top" offset={[0, -10]} opacity={0.8} className="text-xs">
                  {ship.name} ({ship.status})
                </Tooltip>
              </Marker>
            ))}

            {/* Route Polylines for active selection */}
            {routeOptions &&
              routeOptions.routes.map((route) => (
                <Polyline
                  key={route.id}
                  positions={route.path}
                  pathOptions={{
                    color: ROUTE_COLORS[route.id] || '#3b82f6',
                    weight: 3,
                    dashArray: route.id === 'eco' ? '6, 6' : '2, 6',
                    opacity: 0.8,
                  }}
                >
                  <Tooltip direction="center" className="text-xs font-semibold">
                    {route.name} • ETA {route.etaMinutes} min • {route.fuelCost} L
                  </Tooltip>
                </Polyline>
              ))}

            {/* Geofenced Zones */}
            <Rectangle
              bounds={[[25.5, 54.0], [26.8, 56.2]]}
              pathOptions={{ color: '#ef4444', weight: 1, fillColor: '#ef4444', fillOpacity: 0.15 }}
            />
            <Rectangle
              bounds={[[24.5, 53.0], [25.3, 54.1]]}
              pathOptions={{ color: '#f59e0b', weight: 1, fillColor: '#f59e0b', fillOpacity: 0.12 }}
            />
            <Tooltip direction="center" className="text-xs text-amber-300" permanent>
              Restricted Zone
            </Tooltip>
          </MapContainer>
        </div>

        {/* Selected Ship Detail Panel */}
        {selectedShip && !isPlayback && (
          <div className="absolute bottom-6 right-6 z-[1000] w-80 bg-slate-900/95 border border-slate-700 rounded-xl p-4 shadow-2xl backdrop-blur-md">
            <div className="flex justify-between items-start border-b border-slate-800 pb-2">
              <div>
                <h3 className="font-bold text-sm text-slate-100 flex items-center gap-2">
                  <Ship className="w-4 h-4 text-blue-400" />
                  {selectedShip.name} — Operational Details
                </h3>
                <span className="text-xs text-slate-400">ID: {selectedShip.shipId}</span>
              </div>
              <button
                onClick={() => setSelectedShip(null)}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
              <div>
                <span className="text-slate-500">Cargo:</span>
                <span className="ml-1 font-medium">{selectedShip.cargo}</span>
              </div>
              <div>
                <span className="text-slate-500">Speed:</span>
                <span className="ml-1 font-mono">{selectedShip.speed} kn</span>
              </div>
              <div>
                <span className="text-slate-500">Heading:</span>
                <span className="ml-1 font-mono">{selectedShip.heading}°</span>
              </div>
              <div>
                <span className="text-slate-500">Fuel:</span>
                <span className="ml-1 font-mono text-blue-400">{selectedShip.fuel} L</span>
              </div>
              <div>
                <span className="text-slate-500">Destination:</span>
                <span className="ml-1 font-medium">{selectedShip.destination}</span>
              </div>
              <div>
                <span className="text-slate-500">Status:</span>
                <span className="ml-1 capitalize font-mono">{selectedShip.status}</span>
              </div>
            </div>

            <div className="mt-4 pt-3 border-t border-slate-800 flex flex-col gap-2">
              <button
                onClick={() =>
                  socket.emit('requestRouteOptions', { shipId: selectedShip.shipId })
                }
                className="w-full py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-xs font-semibold flex items-center justify-center gap-1 transition"
              >
                <Navigation className="w-3.5 h-3.5" />
                Request Multi-Route Reroute Options
              </button>
              <button
                onClick={() =>
                  socket.emit('requestShipAid', {
                    requesterId: selectedShip.shipId,
                    aidType: 'Fuel Transfer',
                    aidPayload: `${selectedShip.fuel} L needed`,
                  })
                }
                className="w-full py-1.5 bg-amber-600 hover:bg-amber-500 rounded text-xs font-semibold flex items-center justify-center gap-1 transition"
              >
                <BatteryCharging className="w-3.5 h-3.5" />
                Request Ship-to-Ship Assistance
              </button>
            </div>
          </div>
        )}

        {/* Route Options Panel */}
        {routeOptions && (
          <div className="absolute top-16 left-4 z-[1000] w-96 bg-slate-900/95 border border-blue-500/50 rounded-xl p-4 shadow-2xl backdrop-blur-md">
            <div className="flex justify-between items-center mb-3">
              <h3 className="font-bold text-sm flex items-center gap-1 text-blue-400">
                <Navigation className="w-4 h-4" />
                Route Options — {routeOptions.shipId}
              </h3>
              <button
                onClick={() => setRouteOptions(null)}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-2">
              {routeOptions.routes.map((r) => (
                <div
                  key={r.id}
                  className="p-2.5 rounded bg-slate-800/60 border border-slate-700 text-xs flex justify-between items-center"
                >
                  <div className="flex-1">
                    <div className="font-semibold text-slate-200 flex items-center gap-1">
                      <div
                        className="w-3 h-3 rounded-full"
                        style={{ backgroundColor: ROUTE_COLORS[r.id] || '#3b82f6' }}
                      />
                      {r.name}
                    </div>
                    <div className="text-[10px] text-slate-400 mt-0.5">
                      ETA: {r.etaMinutes} min • Fuel: {r.fuelCost} L • Risk: {r.riskLevel}
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      socket.emit('applyRoute', {
                        shipId: routeOptions.shipId,
                        routeId: r.id,
                      });
                      setRouteOptions(null);
                    }}
                    className="ml-2 px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded text-[10px] font-bold transition"
                  >
                    Apply
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Aid Request Overlay */}
        {activeAidRequest && (
          <div className="absolute top-16 right-4 z-[1000] w-80 bg-slate-900 border border-amber-500/50 rounded-xl p-4 shadow-2xl backdrop-blur-md">
            <div className="flex items-center gap-2 text-amber-400 font-bold text-sm mb-2">
              <ShieldAlert className="w-5 h-5" />
              Ship-to-Ship Assistance Request
            </div>
            <p className="text-xs text-slate-300 mb-3">
              <strong>{activeAidRequest.requesterName}</strong> ({activeAidRequest.requesterId})
              needs <strong>{activeAidRequest.type}</strong>.
            </p>
            <div className="text-xs text-slate-400 mb-3 space-y-1">
              <div>
                Designated responder: <strong>{activeAidRequest.providerName}</strong> ({activeAidRequest.providerId})
              </div>
              <div>Distance: {activeAidRequest.distanceKm} km</div>
              <div className="text-sky-400">{activeAidRequest.details}</div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  socket.emit('respondAidRequest', {
                    requestId: activeAidRequest.id,
                    accepted: true,
                  });
                  setActiveAidRequest(null);
                }}
                className="flex-1 py-1.5 bg-emerald-600 hover:bg-emerald-500 rounded text-xs font-bold flex items-center justify-center gap-1 transition"
              >
                <Check className="w-3.5 h-3.5" /> Accept
              </button>
              <button
                onClick={() => {
                  socket.emit('respondAidRequest', {
                    requestId: activeAidRequest.id,
                    accepted: false,
                  });
                  setActiveAidRequest(null);
                }}
                className="flex-1 py-1.5 bg-red-600 hover:bg-red-500 rounded text-xs font-bold flex items-center justify-center gap-1 transition"
              >
                <X className="w-3.5 h-3.5" /> Decline
              </button>
            </div>
          </div>
        )}

        {/* AI Advisor Panel */}
        {aiSuggestions.length > 0 && (
          <div className="absolute bottom-6 left-4 z-[1000] w-96 bg-slate-900/95 border border-indigo-500/50 rounded-xl p-4 shadow-2xl backdrop-blur-md">
            <div className="flex justify-between items-center mb-2">
              <h3 className="font-bold text-sm flex items-center gap-1 text-indigo-400">
                <Bot className="w-4 h-4" />
                Proactive AI Fleet Advisor
              </h3>
              <button
                onClick={() => setAiSuggestions([])}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-2 max-h-60 overflow-y-auto">
              {aiSuggestions.map((rec) => (
                <div
                  key={rec.id}
                  className="p-3 rounded bg-indigo-950/30 border border-indigo-800/50 text-xs"
                >
                  <div className="font-semibold text-indigo-200 flex items-center gap-1">
                    <Navigation className="w-3 h-3" />
                    {rec.suggestedAction}
                  </div>
                  <p className="text-[11px] text-slate-300 mt-1.5">{rec.reasoning}</p>
                  {rec.targetName && (
                    <div className="mt-1.5 text-[10px] text-slate-500">
                      Target: {rec.targetName} ({rec.targetShip}) • Priority: {rec.priority}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Timeline Playback Controls */}
      {showPlaybackBar && historyBuffer.length > 0 && (
        <div className="absolute bottom-0 left-0 right-0 z-[1000] bg-slate-900/95 border-t border-slate-700 backdrop-blur-md">
          <div className="px-4 py-3">
            <div className="flex justify-between items-center mb-2">
              <div className="flex items-center gap-3">
                <button
                  onClick={() => {
                    setIsPlayback(false);
                    setShowPlaybackBar(false);
                  }}
                  className="px-3 py-1 bg-slate-800 hover:bg-slate-700 rounded text-xs font-semibold transition"
                >
                  Exit Playback
                </button>
                <button
                  onClick={handlePlayPause}
                  className="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded text-xs font-semibold transition"
                >
                  Auto-Play
                </button>
              </div>
              <div className="text-xs text-slate-400 font-mono">
                {historyBuffer[playbackIndex]?.timestamp
                  ? new Date(historyBuffer[playbackIndex].timestamp).toLocaleString()
                  : '—'}
              </div>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-[10px] text-slate-500 w-24">1 hour ago</span>
              <input
                type="range"
                ref={playbackSliderRef}
                min="0"
                max={historyBuffer.length - 1}
                value={playbackIndex}
                onChange={handleScrub}
                className="flex-1 accent-blue-500 cursor-pointer"
              />
              <span className="text-[10px] text-slate-500 w-24 text-right">Live</span>
            </div>
            <div className="mt-1 text-[10px] text-slate-500 text-center">
              Scrub to inspect historical fleet positions and events. Live updates pause during playback.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
