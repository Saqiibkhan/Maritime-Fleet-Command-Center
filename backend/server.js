const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

const PORT = process.env.PORT || 4000;
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'none') ? process.env.OPENAI_API_KEY : '';
const SIM_INTERVAL_MS = 3000;
const SNAPSHOT_INTERVAL_TICKS = 10;
const MAX_SNAPSHOTS = 120;
const TIME_MULTIPLIER = 100;
const FUEL_CONSUMPTION_L_PER_KM = 10;
const LOW_FUEL_THRESHOLD = 1500;
const DISTRESS_FUEL_THRESHOLD = 500;
const ZONE_PROXIMITY_DEGREES = 0.3;
const KNOTS_TO_KMH = 1.852;
const DEG_TO_KM = 111.32;

const ships = [
  { shipId: 'MV-1', name: 'Alpha', position: [25.27, 55.29], speed: 18, heading: 120, destination: 'SOH-1', fuel: 6200, cargo: 'containers', status: 'normal', eta: null },
  { shipId: 'MV-2', name: 'Bravura', position: [26.1, 54.2], speed: 15, heading: 90, destination: 'DMM-1', fuel: 4800, cargo: 'crude oil', status: 'normal', eta: null },
  { shipId: 'MV-3', name: 'Corsair', position: [24.8, 53.1], speed: 20, heading: 45, destination: 'KWT-1', fuel: 3100, cargo: 'liquefied gas', status: 'normal', eta: null },
  { shipId: 'MV-4', name: 'Dolphin', position: [25.9, 56.1], speed: 10, heading: 110, destination: 'SOH-1', fuel: 5800, cargo: 'bulk grain', status: 'normal', eta: null },
  { shipId: 'MV-5', name: 'Emerald', position: [27.5, 51.2], speed: 12, heading: 165, destination: 'DOH-1', fuel: 8200, cargo: 'crude oil', status: 'normal', eta: null },
  { shipId: 'MV-6', name: 'Falcon', position: [25.4, 54.53], speed: 22, heading: 280, destination: 'DOH-1', fuel: 4100, cargo: 'containers', status: 'normal', eta: null },
  { shipId: 'MV-7', name: 'Gharial', position: [26.5, 53.5], speed: 14, heading: 270, destination: 'KWT-1', fuel: 750, cargo: 'crude oil', status: 'normal', eta: null },
  { shipId: 'MV-8', name: 'Halcyon', position: [24.93, 56.94], speed: 19, heading: 250, destination: 'DMM-1', fuel: 5200, cargo: 'automobiles', status: 'normal', eta: null },
];

const ports = {
  'SOH-1': [26.12, 53.94],
  'DMM-1': [26.22, 50.63],
  'DOH-1': [25.27, 55.30],
  'KWT-1': [29.37, 47.97],
};

const activeZones = [
  { id: 'zone-1', name: 'Strait Risk Area', bounds: [[25.5, 54.0], [26.8, 56.2]], type: 'restricted', weatherSeverity: 'moderate' },
  { id: 'zone-2', name: 'Storm Watch Sector', bounds: [[24.5, 53.0], [25.3, 54.1]], type: 'weather', weatherSeverity: 'severe' },
];

const weatherCells = [
  { id: 'weather-1', center: [25.8, 54.5], radiusNm: 8, severity: 'severe', wind: 35, waves: 3.5 },
  { id: 'weather-2', center: [26.0, 55.2], radiusNm: 6, severity: 'moderate', wind: 22, waves: 2.0 },
];

const eventLog = [];
const pendingAidRequests = [];
const ringBuffer = [];
let simulationStep = 0;
const predictedAlertedShips = new Set();

function calculateDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return (R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function distanceNm(lat1, lon1, lat2, lon2) {
  return calculateDistanceKm(lat1, lon1, lat2, lon2) / KNOTS_TO_KMH;
}

function findPort(portId) {
  const coords = ports[portId];
  if (!coords) return null;
  return { id: portId, position: coords, name: portId };
}

function computeEta(ship) {
  const port = findPort(ship.destination);
  if (!port) return null;
  const distKm = calculateDistanceKm(ship.position[0], ship.position[1], port.position[0], port.position[1]);
  const etaMinutes = Math.round((distKm / (ship.speed * KNOTS_TO_KMH)) * 60);
  return { port: port.name, etaMinutes, distanceKm: Math.round(distKm) };
}

function computeFuelRangeKm(fuel) {
  return fuel / FUEL_CONSUMPTION_L_PER_KM;
}

function stepShipPosition(ship) {
  const port = findPort(ship.destination);
  if (!port) {
    ship.position = [
      ship.position[0] + (Math.random() - 0.5) * 0.01,
      ship.position[1] + (Math.random() - 0.5) * 0.01,
    ];
    return;
  }

  const simTickSeconds = (SIM_INTERVAL_MS / 1000) * TIME_MULTIPLIER;
  const stepKm = (ship.speed * KNOTS_TO_KMH * simTickSeconds) / 3600;

  const dx = port.position[1] - ship.position[1];
  const dy = port.position[0] - ship.position[0];
  const targetHeading = (Math.atan2(dx, dy) * 180) / Math.PI;
  ship.heading = (targetHeading + 360) % 360;

  const distRemainingKm = calculateDistanceKm(
    ship.position[0], ship.position[1],
    port.position[0], port.position[1]
  );

  if (distRemainingKm < stepKm || distRemainingKm < 0.02) {
    ship.position = [port.position[0], port.position[1]];
    ship.destination = 'ARRIVED';
    ship.eta = { port: port.name, etaMinutes: 0, distanceKm: 0 };
    ship.status = ship.fuel <= DISTRESS_FUEL_THRESHOLD ? 'distress' : 'normal';
    addEvent('SHIP_ARRIVED', 'info', `${ship.name} (${ship.shipId}) has arrived at ${port.name}`);
  } else {
    const ratio = stepKm / distRemainingKm;
    ship.position[0] += dy * ratio;
    ship.position[1] += dx * ratio;
  }

  const fuelBurn = Math.round(stepKm * FUEL_CONSUMPTION_L_PER_KM);
  ship.fuel = Math.max(0, ship.fuel - fuelBurn);

  ship.eta = computeEta(ship);
}

function addEvent(type, severity, message) {
  const event = {
    id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    timestamp: new Date().toLocaleTimeString(),
    type,
    severity,
    message,
  };
  eventLog.push(event);
  if (eventLog.length > 500) eventLog.shift();
  io.emit('newEvent', event);
  return event;
}

function isInZone(ship, zone) {
  return (
    ship.position[0] >= zone.bounds[0][0] &&
    ship.position[0] <= zone.bounds[1][0] &&
    ship.position[1] >= zone.bounds[0][1] &&
    ship.position[1] <= zone.bounds[1][1]
  );
}

function getProjectedPosition(ship, ticksAhead) {
  const simTickSeconds = (SIM_INTERVAL_MS / 1000) * TIME_MULTIPLIER;
  const stepKm = (ship.speed * KNOTS_TO_KMH * simTickSeconds) / 3600;
  const projectionDistanceKm = stepKm * ticksAhead;

  const port = findPort(ship.destination);
  if (!port) return ship.position;

  const dx = port.position[1] - ship.position[1];
  const dy = port.position[0] - ship.position[0];
  const distance = calculateDistanceKm(ship.position[0], ship.position[1], port.position[0], port.position[1]);

  if (distance === 0) return ship.position;

  const ratio = projectionDistanceKm / distance;
  return [
    ship.position[0] + dy * ratio,
    ship.position[1] + dx * ratio,
  ];
}

function checkPredictiveAlerts() {
  ships.forEach((ship) => {
    const port = findPort(ship.destination);
    if (!port || ship.destination === 'ARRIVED') return;

    const distToPortKm = calculateDistanceKm(
      ship.position[0], ship.position[1],
      port.position[0], port.position[1]
    );
    const fuelRangeKm = computeFuelRangeKm(ship.fuel);

    if (distToPortKm > fuelRangeKm && ship.status !== 'distress') {
      ship.status = 'distress';
      addEvent(
        'PREDICTIVE_FUEL_DEPLETION',
        'critical',
        `${ship.name} (${ship.shipId}) projected to run out of fuel ${Math.round(distToPortKm - fuelRangeKm)} km short of ${port.name}. Declaring distress.`
      );
    }

    if (ship.fuel < LOW_FUEL_THRESHOLD && ship.status === 'normal') {
      addEvent(
        'LOW_FUEL_WARNING',
        'medium',
        `${ship.name} (${ship.shipId}) fuel running low: ${ship.fuel}L remaining. Range: ${fuelRangeKm.toFixed(0)} km vs ${distToPortKm.toFixed(0)} km to ${port.name}.`
      );
    }

    const projected = getProjectedPosition(ship, 60);

    activeZones.forEach((zone) => {
      const inProjected =
        projected[0] >= zone.bounds[0][0] && projected[0] <= zone.bounds[1][0] &&
        projected[1] >= zone.bounds[0][1] && projected[1] <= zone.bounds[1][1];

      const inCurrent = isInZone(ship, zone);
      const alertKey = `${ship.shipId}-${zone.id}`;

      if (inProjected && !inCurrent && ship.status !== 'warning' && ship.status !== 'distress' && !predictedAlertedShips.has(alertKey)) {
        predictedAlertedShips.add(alertKey);
        addEvent(
          'PREDICTIVE_ZONE_ENTRY',
          'high',
          `${ship.name} (${ship.shipId}) will enter restricted zone ${zone.name} in approximately 3 minutes.`
        );
      }

      if (inCurrent && isInZone(ship, zone)) {
        predictedAlertedShips.delete(alertKey);
      }
    });

    activeZones.forEach((zone) => {
      if (isInZone(ship, zone) && ship.status !== 'warning' && ship.status !== 'distress') {
        ship.status = 'warning';
        addEvent(
          'ZONE_ENTRY_ALERT',
          'high',
          `${ship.name} (${ship.shipId}) has entered ${zone.type === 'restricted' ? 'restricted' : 'weather-affected'} zone: ${zone.name}`
        );
      }
    });

    weatherCells.forEach((cell) => {
      const dist = distanceNm(ship.position[0], ship.position[1], cell.center[0], cell.center[1]);
      if (dist < cell.radiusNm && ship.status !== 'distress' && ship.status !== 'warning') {
        ship.status = 'warning';
        addEvent(
          'WEATHER_WARNING',
          'high',
          `${ship.name} (${ship.shipId}) entering ${cell.severity} weather cell. Wind: ${cell.wind} knots, Waves: ${cell.waves}m.`
        );
      }
    });
  });
}

function recordSnapshot() {
  ringBuffer.push({
    timestamp: new Date().toISOString(),
    step: simulationStep,
    ships: JSON.parse(JSON.stringify(ships)),
    events: JSON.parse(JSON.stringify(eventLog.slice(-20))),
    zones: JSON.parse(JSON.stringify(activeZones)),
  });
  if (ringBuffer.length > MAX_SNAPSHOTS) {
    ringBuffer.shift();
  }
}

function generateRouteOptions(shipId) {
  const ship = ships.find((s) => s.shipId === shipId);
  if (!ship || ship.destination === 'ARRIVED') return null;

  const port = findPort(ship.destination);
  if (!port) return null;

  const distKm = calculateDistanceKm(ship.position[0], ship.position[1], port.position[0], port.position[1]);

  const directPath = [ship.position, port.position];

  const waypointSafe = [[(ship.position[0] + port.position[0]) / 2, ship.position[1] - 0.8]];
  const safePath = [ship.position, ...waypointSafe, port.position];
  const safeDist = distKm + 45;

  const waypointEco = [[(ship.position[0] + port.position[0]) / 2 - 0.2, (ship.position[1] + port.position[1]) / 2 + 0.2]];
  const ecoPath = [ship.position, ...waypointEco, port.position];
  const ecoDist = distKm + 20;

  return [
    {
      id: 'fast',
      name: 'Direct Channel (Fastest)',
      etaMinutes: Math.round((distKm / (ship.speed * KNOTS_TO_KMH)) * 60),
      fuelCost: Math.round(distKm * FUEL_CONSUMPTION_L_PER_KM),
      riskLevel: 'High (Storm/SWELL zones)',
      path: directPath,
    },
    {
      id: 'safe',
      name: 'Coastal Buffer (Safer)',
      etaMinutes: Math.round((safeDist / (ship.speed * KNOTS_TO_KMH)) * 60),
      fuelCost: Math.round(safeDist * FUEL_CONSUMPTION_L_PER_KM),
      riskLevel: 'Low (Avoids weather cells)',
      path: safePath,
    },
    {
      id: 'eco',
      name: 'Eco-Economic Route',
      etaMinutes: Math.round((ecoDist / (ship.speed * KNOTS_TO_KMH)) * 60 * 1.15),
      fuelCost: Math.round(ecoDist * FUEL_CONSUMPTION_L_PER_KM * 0.85),
      riskLevel: 'Low (Reduced speed, lower burn)',
      path: ecoPath,
    },
  ];
}

function generateAiSuggestions() {
  const suggestions = [];

  const distressedShips = ships.filter(
    (s) => s.status === 'distress' || (s.fuel < LOW_FUEL_THRESHOLD && s.destination !== 'ARRIVED')
  );

  distressedShips.forEach((s) => {
    const candidates = ships
      .filter((o) => o.shipId !== s.shipId && o.fuel > 4000 && o.destination !== 'ARRIVED' && o.status !== 'distress')
      .sort((a, b) => distanceNm(s.position[0], s.position[1], a.position[0], a.position[1]) - distanceNm(s.position[0], s.position[1], b.position[0], b.position[1]));

    if (candidates.length > 0) {
      const provider = candidates[0];
      const dist = distanceNm(s.position[0], s.position[1], provider.position[0], provider.position[1]);
      suggestions.push({
        id: `rec-${s.shipId}-${Date.now()}`,
        targetShip: s.shipId,
        targetName: s.name,
        suggestedAction: 'Dispatch Ship-to-Ship Fuel Transfer',
        assistingShip: provider.shipId,
        assistingName: provider.name,
        priority: 'Critical',
        reasoning: `${s.name} (${s.shipId}) has critical fuel (${s.fuel}L). ${provider.name} (${provider.shipId}) is ${dist.toFixed(1)} NM away with surplus reserves (${provider.fuel}L). Recommend immediate fuel transfer of 1500L.`,
      });
    }
  });

  ships.filter((s) => s.speed > 16 && s.fuel > 3000 && s.destination !== 'ARRIVED' && s.status === 'normal').slice(0, 2).forEach((s) => {
    suggestions.push({
      id: `rec-eco-${s.shipId}-${Date.now()}`,
      targetShip: s.shipId,
      targetName: s.name,
      suggestedAction: 'Recommend Eco-Speed Course Adjustment',
      assistingShip: 'N/A',
      assistingName: 'N/A',
      priority: 'Advisory',
      reasoning: `${s.name} (${s.shipId}) transiting at ${s.speed} knots. Reducing to ${Math.max(10, s.speed - 5)} knots conserves ~${Math.round(s.fuel * 0.12)}L without missing ETA window.`,
    });
  });

  ships.filter((s) => {
    if (s.destination === 'ARRIVED' || s.status === 'distress') return false;
    return activeZones.some((zone) => isInZone(s, zone) ||
      (s.position[0] + ZONE_PROXIMITY_DEGREES >= zone.bounds[0][0] &&
       s.position[0] + ZONE_PROXIMITY_DEGREES <= zone.bounds[1][0] &&
       s.position[1] + ZONE_PROXIMITY_DEGREES >= zone.bounds[0][1] &&
       s.position[1] + ZONE_PROXIMITY_DEGREES <= zone.bounds[1][1]));
  }).forEach((s) => {
    suggestions.push({
      id: `rec-zone-${s.shipId}-${Date.now()}`,
      targetShip: s.shipId,
      targetName: s.name,
      suggestedAction: 'Reroute from Restricted Zone',
      assistingShip: 'N/A',
      assistingName: 'N/A',
      priority: 'Medium',
      reasoning: `${s.name} (${s.shipId}) on trajectory to enter restricted/storm zone. Suggest rerouting via safer coastal buffer path.`,
    });
  });

  if (suggestions.length === 0) {
    suggestions.push({
      id: 'rec-all-clear',
      targetShip: 'N/A',
      targetName: 'N/A',
      suggestedAction: 'All Vessels Nominal',
      assistingShip: 'N/A',
      assistingName: 'N/A',
      priority: 'Info',
      reasoning: 'No immediate threats detected. All vessels are on course with adequate fuel reserves.',
    });
  }

  return suggestions;
}

function handleAidRequest(requesterId, aidType, aidPayload) {
  const requester = ships.find((s) => s.shipId === requesterId);
  if (!requester) return;

  const candidates = ships
    .filter((s) => s.shipId !== requesterId && s.fuel > 3000 && s.destination !== 'ARRIVED')
    .sort((a, b) => distanceNm(requester.position[0], requester.position[1], a.position[0], a.position[1]) - distanceNm(requester.position[0], requester.position[1], b.position[0], b.position[1]));

  if (candidates.length === 0) {
    addEvent('AID_REQUEST_DENIED', 'warning', `${requester.name} aid request could not be fulfilled — no nearby vessels available`);
    return;
  }

  const provider = candidates[0];
  const dist = distanceNm(requester.position[0], requester.position[1], provider.position[0], provider.position[1]);

  const aidRequest = {
    id: `aid-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
    requesterId: requester.shipId,
    requesterName: requester.name,
    providerId: provider.shipId,
    providerName: provider.name,
    type: aidType,
    distanceKm: dist.toFixed(1),
    details: `${aidType}: ${aidPayload || 'Assistance requested'}`,
    status: 'pending',
    fuelAvailable: provider.fuel,
  };

  pendingAidRequests.push(aidRequest);
  io.emit('aidRequestBroadcast', aidRequest);

  addEvent(
    'AID_REQUEST',
    'high',
    `${requester.name} (${requester.shipId}) requested ${aidType}. Nearest responder: ${provider.name} (${provider.shipId}) — ${dist.toFixed(1)} NM away.`
  );

  return aidRequest;
}

function respondAidRequest(requestId, accepted) {
  const index = pendingAidRequests.findIndex((r) => r.id === requestId);
  if (index === -1) return false;

  const req = pendingAidRequests[index];
  req.status = accepted ? 'accepted' : 'declined';

  if (accepted) {
    const reqShip = ships.find((s) => s.shipId === req.requesterId);
    const provShip = ships.find((s) => s.shipId === req.providerId);

    if (reqShip && provShip) {
      if (req.type === 'Fuel Transfer') {
        const transferAmount = Math.min(1500, Math.floor(provShip.fuel / 3));
        reqShip.fuel += transferAmount;
        provShip.fuel -= transferAmount;
        reqShip.status = reqShip.fuel > DISTRESS_FUEL_THRESHOLD ? 'normal' : 'distress';
        reqShip.details = `Received ${transferAmount}L fuel`;
      } else if (req.type === 'Medical Aid') {
        reqShip.status = 'normal';
        reqShip.details = 'Medical team dispatched';
      } else if (req.type === 'Escort') {
        reqShip.details = `${provShip.name} providing escort`;
      }
    }

    addEvent(
      'AID_RESPONSE', 'info',
      `${req.providerName} (${req.providerId}) ACCEPTED ${req.type} from ${req.requesterName} (${req.requesterId}).`
    );
  } else {
    addEvent(
      'AID_RESPONSE', 'warning',
      `${req.providerName} (${req.providerId}) DECLINED ${req.type} from ${req.requesterName} (${req.requesterId}).`
    );
  }

  pendingAidRequests.splice(index, 1);
  return true;
}

function applyRoute(shipId, routeId) {
  const ship = ships.find((s) => s.shipId === shipId);
  if (!ship) return;

  const routes = generateRouteOptions(shipId);
  if (!routes) return;

  const route = routes.find((r) => r.id === routeId);
  if (!route) return;

  ship.routeHistory = ship.routeHistory || [];
  ship.routeHistory.push({ route: route.name, timestamp: new Date().toISOString() });
  ship.eta = { port: ship.destination, etaMinutes: route.etaMinutes, distanceKm: Math.round(route.fuelCost / FUEL_CONSUMPTION_L_PER_KM) };

  addEvent('ROUTE_CHANGED', 'info', `Command applied ${route.name} to ${ship.name} (${shipId}). ETA: ${route.etaMinutes} min, fuel: ${route.fuelCost}L.`);
}

setInterval(() => {
  simulationStep++;

  ships.forEach((ship) => {
    if (ship.destination === 'ARRIVED') return;
    stepShipPosition(ship);
  });

  checkPredictiveAlerts();

  io.emit('fleetStateUpdate', { ships: JSON.parse(JSON.stringify(ships)), eventLog: JSON.parse(JSON.stringify(eventLog)) });

  if (simulationStep % SNAPSHOT_INTERVAL_TICKS === 0) {
    recordSnapshot();
  }
}, SIM_INTERVAL_MS);

app.get('/api/history', (req, res) => {
  res.json({ ringBuffer, snapshotCount: ringBuffer.length });
});

app.get('/api/ships', (req, res) => {
  res.json({ ships });
});

app.get('/api/zones', (req, res) => {
  res.json({ zones: activeZones, weatherCells });
});

app.get('/api/ai-advisor', (req, res) => {
  const suggestions = generateAiSuggestions();
  res.json({
    suggestions,
    source: OPENAI_API_KEY ? 'ai-enhanced' : 'heuristics (no API key configured — set OPENAI_API_KEY for enhanced AI)',
  });
});

app.get('/api/route-options/:shipId', (req, res) => {
  const routes = generateRouteOptions(req.params.shipId);
  if (!routes) {
    res.status(404).json({ error: 'Ship not found or already arrived' });
    return;
  }
  res.json({ shipId: req.params.shipId, routes });
});

io.on('connection', (socket) => {
  socket.emit('fleetStateUpdate', { ships: JSON.parse(JSON.stringify(ships)), eventLog: JSON.parse(JSON.stringify(eventLog)) });
  socket.emit('ringBufferUpdate', { ringBuffer: JSON.parse(JSON.stringify(ringBuffer)) });

  socket.on('requestRouteOptions', ({ shipId }) => {
    const routes = generateRouteOptions(shipId);
    if (routes) socket.emit('routeOptionsGenerated', { shipId, routes });
  });

  socket.on('applyRoute', ({ shipId, routeId }) => {
    applyRoute(shipId, routeId);
  });

  socket.on('requestShipAid', ({ requesterId, aidType, aidPayload }) => {
    handleAidRequest(requesterId, aidType || 'Fuel Transfer', aidPayload);
  });

  socket.on('respondAidRequest', ({ requestId, accepted }) => {
    respondAidRequest(requestId, accepted);
  });

  socket.on('refreshAdvisor', () => {
    socket.emit('aiAdvisorUpdate', { suggestions: generateAiSuggestions() });
  });
});

server.listen(PORT, () => {
  console.log(`=== Maritime Fleet Command Backend v2.0 ===`);
  console.log(`WebSocket + REST API running on port ${PORT}`);
  console.log(`Simulation interval: ${SIM_INTERVAL_MS}ms (time multiplier: ${TIME_MULTIPLIER}x)`);
  console.log(`Snapshot: every ${SNAPSHOT_INTERVAL_TICKS} ticks (${SIM_INTERVAL_MS * SNAPSHOT_INTERVAL_TICKS / 1000}s) — ring buffer: ${MAX_SNAPSHOTS} snapshots (${MAX_SNAPSHOTS * SNAPSHOT_INTERVAL_TICKS * SIM_INTERVAL_MS / 1000 / 3600}h)`);
  console.log(`Fuel model: ${FUEL_CONSUMPTION_L_PER_KM} L/km | OpenAI key: ${OPENAI_API_KEY ? 'configured' : 'none (heuristics)'} | Vessels: ${ships.length} | Zones: ${activeZones.length}`);
  console.log(`===========================================`);
});
