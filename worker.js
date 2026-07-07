export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/weather')) {
      const lat = url.searchParams.get('lat') || '44.3936';
      const lon = url.searchParams.get('lon') || '-89.8173';
      const OMETEO_URL = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,apparent_temperature,wind_speed_10m,wind_direction_10m,precipitation_probability,precipitation,weather_code,uv_index,relative_humidity_2m,pressure_msl&daily=sunrise,sunset,uv_index_max,precipitation_probability_max,wind_gusts_10m_max,weather_code,precipitation_sum,temperature_2m_max,temperature_2m_min&forecast_days=7&timezone=America%2FChicago&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch`;
      
      const cacheKey = `waz_wx_${lat}_${lon}`;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 4000);
        
        const res = await fetch(OMETEO_URL, {
            signal: controller.signal,
            cf: { cacheTtl: 600, cacheEverything: true }
        });
        clearTimeout(timeout);
        
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.text();
        
        if (env.CRON_STATE) {
          ctx.waitUntil(env.CRON_STATE.put(cacheKey, data, { expirationTtl: 1800 }));
        }
        
        return new Response(data, {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=300'
          }
        });
      } catch (err) {
        if (env.CRON_STATE) {
          const cached = await env.CRON_STATE.get(cacheKey);
          if (cached) {
            return new Response(cached, {
              headers: {
                'Content-Type': 'application/json',
                'X-WaZ-Fallback': 'true',
                'Cache-Control': 'no-cache'
              }
            });
          }
        }
        return new Response(JSON.stringify({ error: 'API Timeout and no cache available' }), {
          status: 504,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    if (url.pathname.startsWith('/api/aqi')) {
      const lat = url.searchParams.get('lat') || '44.3936';
      const lon = url.searchParams.get('lon') || '-89.8173';
      const AQI_URL = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=us_aqi,uv_index`;
      const cacheKey = `waz_aqi_${lat}_${lon}`;
      
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 4000);
        
        const res = await fetch(AQI_URL, {
            signal: controller.signal,
            cf: { cacheTtl: 3600, cacheEverything: true }
        });
        clearTimeout(timeout);
        
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.text();
        
        if (env.CRON_STATE) {
          ctx.waitUntil(env.CRON_STATE.put(cacheKey, data, { expirationTtl: 14400 }));
        }
        
        return new Response(data, {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=1800'
          }
        });
      } catch (err) {
        if (env.CRON_STATE) {
          const cached = await env.CRON_STATE.get(cacheKey);
          if (cached) {
            return new Response(cached, {
              headers: {
                'Content-Type': 'application/json',
                'X-WaZ-Fallback': 'true',
                'Cache-Control': 'no-cache'
              }
            });
          }
        }
        return new Response(JSON.stringify({ error: 'API Timeout' }), {
          status: 504,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    if (url.pathname.startsWith('/telemetry')) {
      return new Response(JSON.stringify({ status: 'telemetry_received' }), { headers: { 'Content-Type': 'application/json' } });
    }

    return env.ASSETS.fetch(request);
  }
};
