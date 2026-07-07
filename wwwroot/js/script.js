window.wazLayer = function(overlay, product) {
  var iframe = document.getElementById('windy-iframe');
  if (!iframe) return;
  var base = 'https://embed.windy.com/embed.html?type=map&location=coordinates&metricRain=in&metricTemp=\u00b0F&metricWind=mph&zoom=9&level=surface&lat=44.3936&lon=-89.8173&play=true&message=true&marker=true&detailLat=44.3936&detailLon=-89.8173';
  iframe.src = base + '&overlay=' + overlay + (product ? '&product=' + product : '');
  document.querySelectorAll('.rlb').forEach(function(b){ b.classList.remove('active'); });
  var ab = document.getElementById('rlb-' + overlay);
  if (ab) ab.classList.add('active');
  document.getElementById('waz-radar-time').textContent = overlay.charAt(0).toUpperCase() + overlay.slice(1) + ' layer active';
};

var LAT = 44.3936, LON = -89.8173;
var WX_URL, USGS_URL, NWS_URL, AQI_URL;
var wxCache = null, usgsCache = null;
var countdownInterval = null, rainArrivalTime = null;
var radarWorker = null;

function updateUrls(lat, lon) {
  LAT = lat;
  LON = lon;
  WX_URL = `/api/weather?lat=${LAT}&lon=${LON}`;
  AQI_URL = `/api/aqi?lat=${LAT}&lon=${LON}`;
  USGS_URL = 'https://waterservices.usgs.gov/nwis/iv/?sites=05395000&parameterCd=00060,00065&format=json&period=P7D';
  NWS_URL  = 'https://api.weather.gov/alerts/active?point='+LAT+','+LON;
}
updateUrls(LAT, LON);

function el(id){ return document.getElementById(id); }
function setText(id, v){ var e=el(id); if(e) e.textContent=v; }

/* Utilities */
function degToCardinal(d){ return ['N','NE','E','SE','S','SW','W','NW'][Math.round(d/45)%8]||'--'; }
function relTime(ts){ var d=Date.now()-ts; if(d<60000) return 'just now'; if(d<3600000) return Math.floor(d/60000)+'m ago'; return Math.floor(d/3600000)+'h ago'; }
function wCode(c){
  if(c<=1)  return {emoji:'☀️', label:'Clear'};
  if(c<=3)  return {emoji:'⛅', label:'Partly Cloudy'};
  if(c<=48) return {emoji:'🌫️', label:'Foggy'};
  if(c<=67) return {emoji:'🌧️', label:'Rain'};
  if(c<=77) return {emoji:'❄️', label:'Snow'};
  if(c<=82) return {emoji:'🌦️', label:'Showers'};
  if(c<=99) return {emoji:'⛈️', label:'Thunderstorm'};
  return {emoji:'🌡️', label:'Unknown'};
}
function dayName(dateStr, i){
  if(i===0) return 'Today';
  if(i===1) return 'Tmrw';
  return new Date(dateStr+'T12:00:00').toLocaleDateString([],{weekday:'short'});
}

function tickClock(){ setText('waz-clock', new Date().toLocaleTimeString('en-US',{hour12:false})); }
setInterval(tickClock, 1000); tickClock();

var container = el('wazeecha-telemetry');
var dots = document.querySelectorAll('.waz-dot');
function updateDots(){
  if(!container) return;
  var idx = Math.round(container.scrollLeft / window.innerWidth);
  dots.forEach(function(d,i){ d.classList.toggle('active', i===idx); });
}
if(container) container.addEventListener('scroll', updateDots, {passive:true});

// Massive Pour Verdict Logic
function updatePourVerdict() {
  if(!wxCache) return;
  try {
    var h = wxCache.hourly || {};
    var now = new Date();
    var times = h.time || [];
    var curHr = 0;
    for(var i=0; i<times.length; i++){ if(new Date(times[i]) <= now) curHr = i; else break; }
    
    var t = (h.temperature_2m && h.temperature_2m[curHr]!=null) ? h.temperature_2m[curHr] : null;
    var wind = (h.wind_speed_10m && h.wind_speed_10m[curHr]!=null) ? h.wind_speed_10m[curHr] : null;
    var prob = (h.precipitation_probability && h.precipitation_probability[curHr]!=null) ? h.precipitation_probability[curHr] : 0;
    
    setText('pour-val-temp', t !== null ? Math.round(t)+'°' : '--');
    setText('pour-val-wind', wind !== null ? Math.round(wind)+' mph' : '--');
    setText('pour-val-rain', prob + '%');

    var verdict = "GO";
    var color = "#39FF14"; // Green
    var sub = "Conditions Optimal";

    if (t !== null && wind !== null) {
      if (t < 40 || t > 95 || wind > 25 || prob > 60) {
        verdict = "NO GO";
        color = "#ef4444"; // Red
        sub = "Hazardous conditions detected";
      } else if (t < 45 || t > 85 || wind > 15 || prob > 30) {
        verdict = "MARGINAL";
        color = "#f97316"; // Orange
        sub = "Proceed with caution";
      }
    }

    var mainEl = el('pour-verdict-main');
    var subEl = el('pour-verdict-sub');
    var block = el('pour-verdict-block');

    if(mainEl) {
      mainEl.textContent = verdict;
      mainEl.style.color = color;
    }
    if(subEl) {
      subEl.textContent = sub;
    }
    if (block) {
      block.style.borderColor = color;
    }
  } catch (err) {
    console.error('Error updating pour verdict:', err);
  }
}

function startCountdown(targetMs){
  rainArrivalTime = targetMs;
  if(countdownInterval) clearInterval(countdownInterval);
  function tick(){
    var rem = rainArrivalTime - Date.now();
    if(rem <= 0){
      setText('waz-countdown-main', '🌧 Rain Now');
      setText('waz-countdown-sub', 'Check the radar for current coverage');
      clearInterval(countdownInterval);
      return;
    }
    var h = Math.floor(rem/3600000);
    var m = Math.floor((rem%3600000)/60000);
    var s = Math.floor((rem%60000)/1000);
    var parts = [];
    if(h>0) parts.push(h+'h');
    parts.push(('0'+m).slice(-2)+'m');
    parts.push(('0'+s).slice(-2)+'s');
    setText('waz-countdown-main', parts.join(' '));
  }
  tick();
  countdownInterval = setInterval(tick, 1000);
}

function renderRainIntel(wx){
  wxCache = wx;
  try {
    var h = wx.hourly || {}, d = wx.daily || {};
    var now = new Date();
    var times = h.time || [];
    var curHr = 0;
    for(var i=0;i<times.length;i++){ if(new Date(times[i])<=now) curHr=i; else break; }

    var feelsLike = (h.apparent_temperature && h.apparent_temperature[curHr]!=null) ? Math.round(h.apparent_temperature[curHr]) : null;
    var windSpd   = (h.wind_speed_10m && h.wind_speed_10m[curHr]!=null) ? Math.round(h.wind_speed_10m[curHr]) : null;
    var windDir   = (h.wind_direction_10m && h.wind_direction_10m[curHr]!=null) ? degToCardinal(h.wind_direction_10m[curHr]) : '--';
    var uvMax     = (d.uv_index_max && d.uv_index_max[0]!=null) ? d.uv_index_max[0] : null;
    var sunrise   = (d.sunrise && d.sunrise[0]) ? new Date(d.sunrise[0]).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}) : '--';
    var sunset    = (d.sunset  && d.sunset[0])  ? new Date(d.sunset[0]).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}) : '--';
    var rainProb  = h.precipitation_probability || [];
    var rainAmt   = h.precipitation || [];

    setText('waz-feels', feelsLike!==null ? feelsLike+'°' : '--°');
    setText('waz-wind',  windSpd!==null   ? windSpd+' mph' : '-- mph');
    setText('waz-wind-dir', windDir);
    if(uvMax!==null){ setText('waz-uv', uvMax.toFixed(1)); }
    setText('waz-sunrise', sunrise); setText('waz-sunset', sunset);
    setText('waz-updated', relTime(Date.now()));

    var todayTotal = (d.precipitation_sum && d.precipitation_sum[0]!=null) ? d.precipitation_sum[0].toFixed(2) : '--';
    var todayMaxPct = (d.precipitation_probability_max && d.precipitation_probability_max[0]!=null) ? d.precipitation_probability_max[0] : '--';
    var tomorrowPct = (d.precipitation_probability_max && d.precipitation_probability_max[1]!=null) ? d.precipitation_probability_max[1] : '--';
    setText('waz-today-total', todayTotal !== '--' ? todayTotal+'"' : '--"');
    setText('waz-today-max-pct', todayMaxPct !== '--' ? todayMaxPct+'%' : '--%');
    el('waz-today-max-pct') && (el('waz-today-max-pct').style.color = todayMaxPct>=60?'#ef4444':todayMaxPct>=30?'#f97316':'#60a5fa');
    setText('waz-tomorrow-rain', tomorrowPct !== '--' ? tomorrowPct+'%' : '--%');
    el('waz-tomorrow-rain') && (el('waz-tomorrow-rain').style.color = tomorrowPct>=60?'#ef4444':tomorrowPct>=30?'#f97316':'#a78bfa');

    var maxProb=0;
    var firstRainHr = -1;
    var barHTML='';
    for(var ri=0;ri<12;ri++){
      var hi=curHr+ri;
      if(hi>=rainProb.length) break;
      var prob=rainProb[hi]||0;
      var amt=rainAmt[hi]||0;
      var hasRain = (prob >= 20 || amt > 0.01);
      if(hasRain && firstRainHr===-1) firstRainHr=ri;
      if(prob>maxProb) maxProb=prob;
      var barH=Math.max(2,Math.round((prob/100)*44));
      var col=prob>=70?'#ef4444':prob>=40?'#f97316':prob>=20?'#3b82f6':'rgba(255,255,255,0.1)';
      var t=new Date(h.time[hi]);
      var tLbl=t.toLocaleTimeString([],{hour:'numeric'}).replace(' ','').toLowerCase();
      barHTML+='<div class="ri-bar-col">'+
        '<div class="ri-bar-pct">'+(prob>0?prob+'%':'')+'</div>'+
        '<div class="ri-bar-fill" style="height:'+barH+'px;background:'+col+';"></div>'+
        '<div class="ri-bar-lbl">'+tLbl+'</div></div>';
    }
    var barsEl=el('waz-rain-bars'); if(barsEl) barsEl.innerHTML=barHTML;
    var totalAmt=rainAmt.slice(curHr,curHr+12).reduce(function(a,v){return a+(v||0);},0);
    var summaryEl=el('waz-rain-summary');
    if(summaryEl){ summaryEl.textContent=maxProb>0?'Max '+maxProb+'% · '+totalAmt.toFixed(2)+'"':'No rain'; summaryEl.style.color=maxProb>=70?'#ef4444':maxProb>=40?'#f97316':maxProb>0?'#60a5fa':'#39FF14'; }

    var nextEl=el('waz-rain-next');
    if(firstRainHr===-1){
      setText('waz-countdown-main','☀️ No Rain');
      setText('waz-countdown-sub','No rain in the next 12 hours');
      if(nextEl) nextEl.innerHTML='✅ <span>No rain</span> in the next 12 hours';
      if(countdownInterval){ clearInterval(countdownInterval); countdownInterval=null; }
    } else if(firstRainHr===0){
      setText('waz-countdown-main','🌧 Rain Now');
      setText('waz-countdown-sub','Active precipitation detected');
      if(nextEl) nextEl.innerHTML='⚠️ <span>Rain right now</span> — swipe to radar';
    } else {
      var arrivalTime = new Date(h.time[curHr+firstRainHr]);
      var arrStr = arrivalTime.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});
      setText('waz-countdown-sub','Arriving around '+arrStr+' · '+maxProb+'% chance');
      if(nextEl) nextEl.innerHTML='🌧 Rain arriving around <span>'+arrStr+'</span>';
      startCountdown(arrivalTime.getTime());
    }

    updatePourVerdict();
  } catch(err){ console.warn('[WaZv5] renderRainIntel:', err); }
}

function renderForecast(wx, aqiData){
  try {
    var d = wx.daily || {};
    var daysEl = el('waz-fc-days');
    if(!daysEl || !d.time) return;
    var weekTotal=0;
    daysEl.innerHTML = d.time.slice(0,7).map(function(t,i){
      var wc   = d.weather_code && d.weather_code[i]!=null ? d.weather_code[i] : 0;
      var tmax = d.temperature_2m_max && d.temperature_2m_max[i]!=null ? Math.round(d.temperature_2m_max[i]) : '--';
      var tmin = d.temperature_2m_min && d.temperature_2m_min[i]!=null ? Math.round(d.temperature_2m_min[i]) : '--';
      var pct  = d.precipitation_probability_max && d.precipitation_probability_max[i]!=null ? d.precipitation_probability_max[i] : 0;
      var sum  = d.precipitation_sum && d.precipitation_sum[i]!=null ? d.precipitation_sum[i] : 0;
      weekTotal += sum;
      var info = wCode(wc);
      var barPct = Math.min(100, pct);
      var rainColor = pct>=70?'#ef4444':pct>=40?'#f97316':'#3b82f6';
      return '<div class="fc-day">'+
        '<div class="fc-day-name">'+dayName(t,i)+'</div>'+
        '<div class="fc-day-icon">'+info.emoji+'</div>'+
        '<div class="fc-day-desc">'+info.label+'</div>'+
        '<div class="fc-day-temp">'+tmax+'° / '+tmin+'°</div>'+
        '<div class="fc-day-rain-wrap">'+
          '<div class="fc-day-rain-pct">'+pct+'%</div>'+
          '<div class="fc-day-rain-bar-bg"><div class="fc-day-rain-bar-fill" style="width:'+barPct+'%;background:'+rainColor+';"></div></div>'+
        '</div>'+
      '</div>';
    }).join('');
    var todaySum = d.precipitation_sum && d.precipitation_sum[0]!=null ? d.precipitation_sum[0].toFixed(2) : '--';
    setText('waz-precip-today', todaySum !== '--' ? todaySum+'"' : '--"');
    setText('waz-precip-week', weekTotal.toFixed(2)+'"');
  } catch(err){ console.warn('[WaZv5] renderForecast:', err); }

  try {
    if(aqiData && aqiData.current){
      var aqi = aqiData.current.us_aqi || 0;
      var status = aqi>150?'Unhealthy':aqi>100?'USG':aqi>50?'Moderate':'Good';
      var aqiColor = aqi>150?'#ef4444':aqi>100?'#f97316':aqi>50?'#eab308':'#39FF14';
      setText('waz-aqi-val', aqi);
      setText('waz-aqi-status', status);
      el('waz-aqi-val') && (el('waz-aqi-val').style.color=aqiColor);
    }
  } catch(e){}
}

function renderRiver(data){
  usgsCache = data;
  try {
    var series=(data.value&&data.value.timeSeries)||[];
    var cfsVals=[],ftVals=[],chartLabels=[],chartData=[];
    series.forEach(function(s){
      var code=(s.variable&&s.variable.variableCode&&s.variable.variableCode[0])?s.variable.variableCode[0].value:'';
      var vals=(s.values&&s.values[0]&&s.values[0].value)?s.values[0].value:[];
      if(code==='00060'){ cfsVals=vals; var recent=vals.slice(-48); recent.forEach(function(v){ chartLabels.push(new Date(v.dateTime).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})); chartData.push(parseFloat(v.value)); }); }
      if(code==='00065') ftVals=vals;
    });
    var cfs  = cfsVals.length?parseFloat(cfsVals[cfsVals.length-1].value):null;
    var cfsPrev=cfsVals.length>1?parseFloat(cfsVals[cfsVals.length-2].value):cfs;
    var ft   = ftVals.length?parseFloat(ftVals[ftVals.length-1].value):null;
    var vel  = (cfs!==null&&ft!==null&&ft>0)?(cfs/(ft*150)).toFixed(2):null;
    if(cfs!==null){ setText('waz-cfs',cfs.toLocaleString()+' CFS'); var trend=cfs>cfsPrev?'↑':cfs<cfsPrev?'↓':'→'; setText('waz-trend',trend); el('waz-trend').style.color=cfs>cfsPrev?'#ef4444':cfs<cfsPrev?'#34d399':'#9ca3af'; }
    if(ft!==null)  setText('waz-gauge', ft.toFixed(2)+' ft');
    if(vel!==null) setText('waz-vel',   vel+' ft/s');
    if(ft!==null){
      var floodMinor=12,floodAction=10;
      var pct=Math.min(100,Math.max(0,(ft/floodMinor)*100));
      var fc=ft>=floodMinor?'#ef4444':ft>=floodAction?'#f97316':'#3b82f6';
      var sl=ft>=floodMinor?'Flood Stage':ft>=floodAction?'Action Stage':'Normal';
      var wrap=el('waz-flood-wrap'); if(wrap) wrap.style.display='block';
      var fill=el('waz-flood-fill'); if(fill){fill.style.width=pct+'%';fill.style.background=fc;}
      setText('waz-flood-label',sl+' · '+ft.toFixed(2)+' ft');
    }
    var canvas=el('waz-hydro-chart');
    if(canvas&&window.Chart&&chartData.length){
      var ex=Chart.getChart(canvas); if(ex) ex.destroy();
      new Chart(canvas,{type:'line',data:{labels:chartLabels,datasets:[{data:chartData,borderColor:'#3b82f6',backgroundColor:'rgba(59,130,246,.1)',borderWidth:2,pointRadius:0,tension:0.4,fill:true}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{display:false},y:{ticks:{color:'#9ca3af',font:{size:10}},grid:{color:'rgba(255,255,255,.05)'}}}}});
    }
  } catch(err){ console.warn('[WaZv5] renderRiver:',err); }
}

function renderAlerts(features,ts){
  var list=el('waz-alerts-list'); if(!list) return;
  if(!features||!features.length){
    list.innerHTML='<div class="no-alerts"><div class="no-alerts-icon">✅</div><div class="no-alerts-title">All Clear</div><div class="no-alerts-sub">No active alerts for Wood County</div></div>';
  } else {
    list.innerHTML=features.slice(0,6).map(function(f){
      var p=f.properties||{};
      return '<div class="alert-item"><div class="alert-event">'+(p.event||'Alert')+'</div>'+
        '<div class="alert-headline">'+(p.headline||'')+'</div>'+
        '<div class="alert-meta"><span class="alert-tag">'+(p.severity||'')+'</span>'+(p.certainty?'<span class="alert-tag">'+p.certainty+'</span>':'')+'</div></div>';
    }).join('');
  }
  if(ts) setText('waz-alerts-stamp','Updated '+relTime(ts));
}

function initRadarWorker() {
  if (typeof Worker !== 'undefined' && !radarWorker) {
    radarWorker = new Worker('radar-worker.js');
    radarWorker.onmessage = function(e) {
      var data = e.data;
      var hud = el('rain-countdown-hud');
      if (!hud) return;
      
      if (data.success && data.result) {
        hud.style.display = 'block';
        var res = data.result;
        var mainEl = el('zla-radar-hud-main');
        var subEl = el('zla-radar-hud-sub');
        
        if (res.rainImminent) {
          if (res.etaMinutes === 0) {
            mainEl.textContent = '🌧 Rain Intercept Now';
            mainEl.style.color = res.intensity === 2 ? '#ef4444' : '#f97316';
            subEl.textContent = 'Precipitation detected overhead. Check the live radar map below.';
          } else {
            mainEl.textContent = '🌧 Rain in ' + res.etaMinutes + ' min';
            mainEl.style.color = '#f97316';
            subEl.textContent = 'Kinematic vector estimates intercept in ' + res.etaMinutes + ' minutes.';
          }
        } else {
          mainEl.textContent = '☀️ No Rain Intercept';
          mainEl.style.color = '#39FF14';
          subEl.textContent = 'Radar clear within 50 miles along trajectory.';
        }
      }
    };
  }
}

function triggerRadarWorker() {
  initRadarWorker();
  if (radarWorker) {
    radarWorker.postMessage({ action: 'track', lat: LAT, lon: LON });
  }
}

function fetchAll(){
  triggerRadarWorker();
  
  var isOffline = !navigator.onLine;
  var banner = el('offline-banner');
  if(isOffline) {
    if(banner) banner.style.display = 'block';
  } else {
    if(banner) banner.style.display = 'none';
  }

  fetch(WX_URL).then(r=>r.json()).then(data => {
    localStorage.setItem('wazv5_wx',JSON.stringify({ts:Date.now(),data:data}));
    fetch(AQI_URL).then(r=>r.json()).then(aqi => {
      localStorage.setItem('wazv5_aqi',JSON.stringify({ts:Date.now(),data:aqi}));
      renderRainIntel(data); renderForecast(data,aqi);
    }).catch(()=>{ renderRainIntel(data); renderForecast(data,null); });
  }).catch(e=>{
    console.warn('[WaZv5] wx fetch fail, using cache');
    if(banner) {
      banner.style.display = 'block';
      var wxRaw = localStorage.getItem('wazv5_wx');
      if(wxRaw) {
        var parsed = JSON.parse(wxRaw);
        var minOld = Math.round((Date.now() - parsed.ts) / 60000);
        banner.textContent = `OFFLINE: DATA ${minOld} MINS OLD`;
        renderRainIntel(parsed.data);
        
        var aqiRaw = localStorage.getItem('wazv5_aqi');
        renderForecast(parsed.data, aqiRaw ? JSON.parse(aqiRaw).data : null);
      }
    }
  });

  fetch(USGS_URL).then(r=>r.json()).then(data=>{
    localStorage.setItem('wazv5_usgs',JSON.stringify({ts:Date.now(),data:data}));
    renderRiver(data);
  }).catch(()=>{
    var c = localStorage.getItem('wazv5_usgs');
    if(c) renderRiver(JSON.parse(c).data);
  });

  fetch(NWS_URL).then(r=>r.json()).then(data=>{
    renderAlerts(data.features,Date.now());
  }).catch(()=>{ renderAlerts([],null); });
}

function initWazv5(){
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(function(pos) {
      var newLat = pos.coords.latitude;
      var newLon = pos.coords.longitude;
      updateUrls(newLat, newLon);
      fetchAll();
    }, function() { fetchAll(); }, { timeout: 4000 });
  } else {
    fetchAll();
  }
}

document.addEventListener('DOMContentLoaded',initWazv5);

// PWA Service Worker Registration
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then(registration => {
      console.log('SW registered: ', registration);
    }).catch(registrationError => {
      console.log('SW registration failed: ', registrationError);
    });
  });
}
