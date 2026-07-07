// radar-worker.js - ZLA Rain-Wall Intercept Kinematics Engine
// Runs in background thread to avoid blocking main UI render.

self.onmessage = async function(e) {
  const { action, lat, lon } = e.data;
  
  if (action === 'track') {
    try {
      const result = await processRadarForecast(lat, lon);
      self.postMessage({ success: true, result });
    } catch (err) {
      self.postMessage({ success: false, error: err.message });
    }
  }
};

// Convert Latitude/Longitude to Web Mercator Tile coordinates at a specific zoom level
function latLonToTile(lat, lon, zoom) {
  const latRad = (lat * Math.PI) / 180;
  const n = Math.pow(2, zoom);
  const x = ((lon + 180) / 360) * n;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return { x, y };
}

// Stitches 9 tiles around user, downsamples, and runs block-matching tracking
async function processRadarForecast(lat, lon) {
  // 1. Get latest RainViewer timestamps
  const configRes = await fetch('https://api.rainviewer.com/public/weather-maps.json');
  if (!configRes.ok) throw new Error(`RainViewer API config failed: ${configRes.status}`);
  const config = await configRes.json();
  const radarFrames = config.radar || [];
  if (radarFrames.length < 3) throw new Error('Insufficient radar frames available.');

  // Select last 3 historical/current frames (T-20 min, T-10 min, T-0 min)
  const frames = radarFrames.slice(-3);
  const timestamps = frames.map(f => f.time);

  // 2. Compute tile coordinates at zoom level 8
  const zoom = 8;
  const tileCoords = latLonToTile(lat, lon, zoom);
  const cx = Math.floor(tileCoords.x);
  const cy = Math.floor(tileCoords.y);

  // User position within the 3x3 stitched grid (each tile is 256x256)
  const uXStitched = 256 + (tileCoords.x - cx) * 256;
  const uYStitched = 256 + (tileCoords.y - cy) * 256;

  // Stitched size = 768x768. Downsample by 4 to 192x192
  const dsFactor = 4;
  const dsWidth = 192;
  const dsHeight = 192;
  const userX = uXStitched / dsFactor;
  const userY = uYStitched / dsFactor;

  // 3. Prepare canvas for fetching and downsampling
  const canvas = new OffscreenCanvas(dsWidth, dsHeight);
  const ctx = canvas.getContext('2d');

  // Quantized rain intensity grids for 3 frames (192 x 192)
  const grids = [];

  for (let fIdx = 0; fIdx < 3; fIdx++) {
    ctx.clearRect(0, 0, dsWidth, dsHeight);
    const ts = timestamps[fIdx];

    // Load and draw 3x3 tiles surrounding user location
    const tilePromises = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const tx = cx + dx;
        const ty = cy + dy;
        const url = `https://tilecache.rainviewer.com/v2/radar/${ts}/256/${zoom}/${tx}/${ty}/2/1_1.png`;
        const canvasX = (dx + 1) * 256 / dsFactor;
        const canvasY = (dy + 1) * 256 / dsFactor;

        tilePromises.push(
          fetch(url)
            .then(res => {
              if (res.status === 404) return null; // Standard clear skies (empty tile)
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              return res.blob();
            })
            .then(blob => {
              if (!blob) return null;
              return createImageBitmap(blob);
            })
            .then(img => {
              if (img) {
                ctx.drawImage(img, canvasX, canvasY, 256 / dsFactor, 256 / dsFactor);
                img.close(); // Immediate bitmap cleanup
              }
            })
            .catch(() => {
              // Ignore single tile fetch failures (treat as clear sky)
            })
        );
      }
    }
    await Promise.all(tilePromises);

    // Extract image data and quantize
    const imgData = ctx.getImageData(0, 0, dsWidth, dsHeight);
    const pixels = imgData.data;
    const grid = new Uint8Array(dsWidth * dsHeight);

    for (let i = 0; i < grid.length; i++) {
      const r = pixels[i * 4];
      const g = pixels[i * 4 + 1];
      const b = pixels[i * 4 + 2];
      const a = pixels[i * 4 + 3];

      if (a < 35) {
        grid[i] = 0; // Clear
      } else {
        // High red channel typically represents heavy rain/thunderstorms
        if (r > 160 && g < 100) {
          grid[i] = 2; // Heavy rain
        } else {
          grid[i] = 1; // Light/moderate rain
        }
      }
    }
    grids.push(grid);
  }

  // 4. Kinematic Estimation - 2D Cross-Correlation Block Matching
  // Calculate average shift vector of rain pixels across frame intervals (10-min spacing)
  const searchRange = 12; // Search +/-12 pixels (~13 miles)
  
  function findBestOffset(gridA, gridB) {
    let minSAD = Infinity;
    let bestDx = 0;
    let bestDy = 0;
    let activePixels = 0;

    // Count active pixels to verify motion detection relevance
    for (let i = 0; i < gridA.length; i++) {
      if (gridA[i] > 0) activePixels++;
    }
    if (activePixels < 5) return { dx: 0, dy: 0, active: false };

    for (let dy = -searchRange; dy <= searchRange; dy++) {
      for (let dx = -searchRange; dx <= searchRange; dx++) {
        let sad = 0;
        let overlap = 0;

        for (let y = 0; y < dsHeight; y++) {
          const targetY = y + dy;
          if (targetY < 0 || targetY >= dsHeight) continue;

          for (let x = 0; x < dsWidth; x++) {
            const targetX = x + dx;
            if (targetX < 0 || targetX >= dsWidth) continue;

            const valA = gridA[y * dsWidth + x];
            const valB = gridB[targetY * dsWidth + targetX];
            sad += Math.abs(valA - valB);
            overlap++;
          }
        }
        
        // Normalize SAD by overlap size
        if (overlap > 0) {
          const normSAD = sad / overlap;
          if (normSAD < minSAD) {
            minSAD = normSAD;
            bestDx = dx;
            bestDy = dy;
          }
        }
      }
    }
    return { dx: bestDx, dy: bestDy, active: true };
  }

  const shift12 = findBestOffset(grids[0], grids[1]);
  const shift23 = findBestOffset(grids[1], grids[2]);

  // Average translation vector (pixels per 10 minutes)
  let vx = 0;
  let vy = 0;
  if (shift12.active || shift23.active) {
    vx = (shift12.dx + shift23.dx) / 2;
    vy = (shift12.dy + shift23.dy) / 2;
  }

  // 5. Intercept Logic: Raycast opposite the motion vector from user location
  let rainImminent = false;
  let etaMinutes = null;
  let intensity = 0;

  // Only scan if there is active motion detected, or if rain is already overhead
  const currentOverhead = grids[2][Math.floor(userY) * dsWidth + Math.floor(userX)] || 0;
  
  if (currentOverhead > 0) {
    rainImminent = true;
    etaMinutes = 0;
    intensity = currentOverhead;
  } else if (vx !== 0 || vy !== 0) {
    // Scan ray backwards along incoming rain velocity vector
    const speed = Math.sqrt(vx * vx + vy * vy); // Pixels per 10 minutes
    const stepSize = 0.5; // Walk half-pixel increments
    
    // Trajectory vector heading toward user
    const dirX = -vx / speed;
    const dirY = -vy / speed;

    // Scan up to 48 pixels away (~50 miles)
    for (let dist = 1; dist < 48; dist += stepSize) {
      const scanX = Math.round(userX + dirX * dist);
      const scanY = Math.round(userY + dirY * dist);

      if (scanX < 0 || scanX >= dsWidth || scanY < 0 || scanY >= dsHeight) break;

      const val = grids[2][scanY * dsWidth + scanX];
      if (val > 0) {
        rainImminent = true;
        // speed is pixels per 10 minutes. Convert dist to minutes
        etaMinutes = Math.round((dist / speed) * 10);
        intensity = val;
        break;
      }
    }
  }

  // Aggressive garbage collection: remove references
  grids[0] = null;
  grids[1] = null;
  grids[2] = null;
  ctx.clearRect(0, 0, dsWidth, dsHeight);

  // Send kinematic forecast data telemetry to the edge database
  const payload = {
    timestamp: Date.now(),
    tracking_vector_x: vx,
    tracking_vector_y: vy,
    computed_eta_minutes: etaMinutes,
    grid_ref_lat: lat,
    grid_ref_lon: lon,
    intensity: intensity,
    overhead: currentOverhead > 0 ? 1 : 0
  };

  fetch('/telemetry?app=wazeecha', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).catch(err => console.error('[radar-worker] telemetry POST failed:', err));

  return {
    rainImminent,
    etaMinutes,
    intensity,
    vector: { vx, vy },
    overhead: currentOverhead > 0
  };
}
