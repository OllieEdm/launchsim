// app.js — UI, render loop, camera and telemetry for LaunchSim.
// Drives the pure model in physics.js.
(function () {
  'use strict';

  const P = window.Physics;
  const SIM_DT = 0.05; // fixed physics step (s)
  const MAX_STEPS_PER_FRAME = 6000; // cap so high time-warp can't lock the tab
  const MAX_TRAIL = 9000;

  // Dynamic-pressure ("max Q") fire effect tuning.
  const Q_MIN = 3000; // Pa — below this there is no visible heating
  const Q_REF = 25000; // Pa — dynamic pressure that reads as "fully ablaze"
  const MAXQ_FLOOR = 5000; // Pa — minimum peak to announce a max-Q event
  const MAXQ_BANNER_MS = 3200; // how long the MAX Q callout stays up
  const MAX_PARTICLES = 500;

  // --- Slider definitions ---------------------------------------------------
  const SLIDERS = [
    { key: 'thrust', label: 'Thrust', min: 50000, max: 800000, step: 5000,
      fmt: (v) => (v / 1000).toFixed(0) + ' kN' },
    { key: 'isp', label: 'Specific impulse (Isp)', min: 200, max: 450, step: 5,
      fmt: (v) => v.toFixed(0) + ' s' },
    { key: 'dryMass', label: 'Dry mass', min: 500, max: 6000, step: 100,
      fmt: (v) => (v / 1000).toFixed(1) + ' t' },
    { key: 'propMass', label: 'Propellant mass', min: 4000, max: 40000, step: 500,
      fmt: (v) => (v / 1000).toFixed(1) + ' t' },
    { key: 'dragCdA', label: 'Drag (Cd·A)', min: 0, max: 4, step: 0.05,
      fmt: (v) => v.toFixed(2) + ' m²' },
    { key: 'pitchStart', label: 'Pitch-over start', min: 0, max: 40, step: 1,
      fmt: (v) => v.toFixed(0) + ' s' },
    { key: 'pitchKick', label: 'Pitch kick', min: 0, max: 20, step: 0.5,
      fmt: (v) => v.toFixed(1) + '°' },
    { key: 'targetAlt', label: 'Target orbit altitude', min: 80000, max: 500000, step: 5000,
      fmt: (v) => (v / 1000).toFixed(0) + ' km' },
  ];

  // --- DOM ------------------------------------------------------------------
  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  const statusEl = document.getElementById('status');
  const badgeEl = document.getElementById('orbitBadge');
  const readoutsEl = document.getElementById('readouts');
  const launchBtn = document.getElementById('launchBtn');
  const pauseBtn = document.getElementById('pauseBtn');
  const resetBtn = document.getElementById('resetBtn');
  const defaultsBtn = document.getElementById('defaultsBtn');
  const warpInput = document.getElementById('warp');
  const warpVal = document.getElementById('warpVal');

  // --- State ----------------------------------------------------------------
  let params = P.defaultParams();
  let state = P.initState(params);
  let trail = [];
  let running = false;
  let paused = false;
  let ended = false; // mission concluded (orbit or impact); loop still draws
  let lastNow = 0;
  let acc = 0;
  let stars = [];
  let cam = freshCamera(state); // { cx, cy, span }

  // Max-Q / aero-heating effect state.
  let q = 0; // current dynamic pressure (Pa)
  let maxQ = 0; // peak dynamic pressure so far (Pa)
  let maxQPassed = false; // have we announced the max-Q event?
  let maxQBannerUntil = -1; // real-time ms until which the MAX Q banner shows
  let particles = []; // screen-space fire particles

  // --- Slider UI ------------------------------------------------------------
  const slidersEl = document.getElementById('sliders');
  const sliderEls = {};
  SLIDERS.forEach((cfg) => {
    const row = document.createElement('div');
    row.className = 'slider-row';
    const label = document.createElement('label');
    const name = document.createElement('span');
    name.textContent = cfg.label;
    const val = document.createElement('span');
    val.className = 'val';
    label.append(name, val);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = cfg.min;
    input.max = cfg.max;
    input.step = cfg.step;
    input.value = params[cfg.key];
    val.textContent = cfg.fmt(params[cfg.key]);
    input.addEventListener('input', () => {
      params[cfg.key] = parseFloat(input.value);
      val.textContent = cfg.fmt(params[cfg.key]);
      if (!running) {
        // Live-preview the pad state (e.g. target-altitude ring) before launch.
        state = P.initState(params);
        render();
      }
    });
    row.append(label, input);
    slidersEl.append(row);
    sliderEls[cfg.key] = { input, val, cfg };
  });

  function syncSlidersFromParams() {
    SLIDERS.forEach((cfg) => {
      sliderEls[cfg.key].input.value = params[cfg.key];
      sliderEls[cfg.key].val.textContent = cfg.fmt(params[cfg.key]);
    });
  }

  // --- Telemetry readouts ---------------------------------------------------
  const READOUTS = [
    'Phase', 'Mission time', 'Altitude', 'Speed', 'Vertical speed',
    'Horizontal speed', 'Downrange', 'Acceleration', 'Dyn. pressure', 'Mass',
    'Fuel', 'Apoapsis', 'Periapsis',
  ];
  const readoutEls = {};
  READOUTS.forEach((name) => {
    const dt = document.createElement('dt');
    dt.textContent = name;
    const dd = document.createElement('dd');
    dd.textContent = '—';
    readoutsEl.append(dt, dd);
    readoutEls[name] = dd;
  });

  // --- Formatting helpers ---------------------------------------------------
  function fmtDist(m) {
    if (!isFinite(m)) return '∞';
    if (Math.abs(m) >= 1000) return (m / 1000).toFixed(1) + ' km';
    return m.toFixed(0) + ' m';
  }
  function fmtSpeed(v) { return v.toFixed(0) + ' m/s'; }
  function fmtTime(s) {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return m + ':' + String(sec).padStart(2, '0');
  }

  // --- Camera ---------------------------------------------------------------
  function freshCamera(s) {
    const alt = P.altitude(s);
    return { cx: s.x, cy: s.y, span: Math.min(alt * 3 + 6000, 2.4 * P.R) };
  }
  function lerp(a, b, t) { return a + (b - a) * t; }

  function updateCamera() {
    const alt = P.altitude(state);
    // Frame the rocket and nearby ground while low; pull back to show the
    // whole planet once very high.
    const targetSpan = Math.min(alt * 3 + 6000, 2.4 * P.R);
    cam.span = lerp(cam.span, targetSpan, 0.06);
    cam.cx = lerp(cam.cx, state.x, 0.12);
    cam.cy = lerp(cam.cy, state.y, 0.12);
  }

  function scalePx() {
    return Math.min(canvas.width, canvas.height) / cam.span;
  }
  function toScreen(wx, wy) {
    const s = scalePx();
    return [canvas.width / 2 + (wx - cam.cx) * s, canvas.height / 2 - (wy - cam.cy) * s];
  }

  // --- Rendering ------------------------------------------------------------
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(canvas.clientWidth * dpr);
    canvas.height = Math.floor(canvas.clientHeight * dpr);
    seedStars();
    render();
  }
  function seedStars() {
    stars = [];
    const n = Math.floor((canvas.width * canvas.height) / 9000);
    for (let i = 0; i < n; i++) {
      stars.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        r: Math.random() * 1.2 + 0.2,
        a: Math.random() * 0.6 + 0.2,
      });
    }
  }

  function render() {
    const W = canvas.width;
    const Hc = canvas.height;
    ctx.fillStyle = '#05070f';
    ctx.fillRect(0, 0, W, Hc);

    // Stars
    ctx.fillStyle = '#fff';
    for (const st of stars) {
      ctx.globalAlpha = st.a;
      ctx.beginPath();
      ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    const s = scalePx();
    const [pcx, pcy] = toScreen(0, 0); // planet center on screen
    const Rpx = P.R * s;

    // Atmosphere halo
    const atmoPx = (P.R + P.W.ATMO_TOP) * s;
    if (atmoPx > 0) {
      const grad = ctx.createRadialGradient(pcx, pcy, Math.max(0, Rpx), pcx, pcy, atmoPx);
      grad.addColorStop(0, 'rgba(90,160,255,0.35)');
      grad.addColorStop(1, 'rgba(90,160,255,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(pcx, pcy, atmoPx, 0, Math.PI * 2);
      ctx.fill();
    }

    // Planet
    ctx.beginPath();
    ctx.arc(pcx, pcy, Math.max(1, Rpx), 0, Math.PI * 2);
    ctx.fillStyle = '#16314f';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#2f6aa0';
    ctx.stroke();

    // Target-altitude ring (dashed guide)
    const tgtPx = (P.R + params.targetAlt) * s;
    ctx.setLineDash([6, 8]);
    ctx.strokeStyle = 'rgba(120,200,160,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(pcx, pcy, tgtPx, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Trajectory trail
    if (trail.length > 1) {
      ctx.beginPath();
      for (let i = 0; i < trail.length; i++) {
        const [tx, ty] = toScreen(trail[i].x, trail[i].y);
        if (i === 0) ctx.moveTo(tx, ty);
        else ctx.lineTo(tx, ty);
      }
      ctx.strokeStyle = '#ff7a45';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Aero-heating fire (behind the rocket), then the rocket on top.
    drawFire();
    drawRocket(s);
  }

  function drawRocket(s) {
    const [rx, ry] = toScreen(state.x, state.y);
    const speed = Math.hypot(state.vx, state.vy);
    const r = Math.hypot(state.x, state.y) || 1;
    // Pointing direction (world): velocity if moving, else radially up.
    let dx = speed > 1 ? state.vx / speed : state.x / r;
    let dy = speed > 1 ? state.vy / speed : state.y / r;
    const ang = Math.atan2(dx, -dy); // screen rotation (y flipped)

    ctx.save();
    ctx.translate(rx, ry);
    ctx.rotate(ang);

    // Flame
    if (state.thrusting) {
      const flick = 6 + Math.random() * 6;
      ctx.beginPath();
      ctx.moveTo(-4, 7);
      ctx.lineTo(0, 7 + flick);
      ctx.lineTo(4, 7);
      ctx.closePath();
      ctx.fillStyle = '#ffd23f';
      ctx.fill();
    }
    // Body (triangle pointing "up" in local frame)
    ctx.beginPath();
    ctx.moveTo(0, -10);
    ctx.lineTo(6, 7);
    ctx.lineTo(-6, 7);
    ctx.closePath();
    ctx.fillStyle = '#e6ecff';
    ctx.fill();
    ctx.restore();
  }

  // --- Max-Q fire effect ----------------------------------------------------
  // 0..1 heating intensity from the current dynamic pressure.
  function qIntensity() {
    return Math.max(0, Math.min(1, (q - Q_MIN) / (Q_REF - Q_MIN)));
  }

  // Screen-space "backward" unit vector (opposite the rocket's heading).
  function backwardScreenDir() {
    const speed = Math.hypot(state.vx, state.vy);
    const r = Math.hypot(state.x, state.y) || 1;
    const dx = speed > 1 ? state.vx / speed : state.x / r;
    const dy = speed > 1 ? state.vy / speed : state.y / r;
    return [-dx, dy]; // world->screen flips y, then negate to point aft
  }

  function spawnFireParticles(n, intensity) {
    const [rx, ry] = toScreen(state.x, state.y);
    const [bx, by] = backwardScreenDir();
    const base = Math.atan2(by, bx);
    for (let i = 0; i < n; i++) {
      const ang = base + (Math.random() - 0.5) * 0.9; // aft, with spread
      const spd = (35 + Math.random() * 95) * (0.5 + intensity);
      const life = 0.35 + Math.random() * 0.55;
      particles.push({
        x: rx + (Math.random() - 0.5) * 6,
        y: ry + (Math.random() - 0.5) * 6,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd,
        life,
        max: life,
        size: 1.8 + Math.random() * 2.6 * (0.5 + intensity),
        hue: 52 - Math.random() * 46, // yellow -> deep orange/red
      });
    }
    if (particles.length > MAX_PARTICLES) {
      particles.splice(0, particles.length - MAX_PARTICLES);
    }
  }

  function spawnFireBurst(n) {
    spawnFireParticles(n, 1);
  }

  function updateEffects(dt) {
    const intensity = qIntensity();
    // Emit while flying fast through the atmosphere.
    if (running && !paused && intensity > 0 && P.altitude(state) < P.W.ATMO_TOP) {
      const count = Math.round(intensity * 7 * Math.min(3, dt * 60));
      if (count > 0) spawnFireParticles(count, intensity);
    }
    // Advect and fade.
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.94;
      p.vy *= 0.94;
      p.life -= dt;
      if (p.life <= 0) particles.splice(i, 1);
    }
  }

  function drawFire() {
    const intensity = qIntensity();
    const [rx, ry] = toScreen(state.x, state.y);
    ctx.globalCompositeOperation = 'lighter';

    // Heat halo around the rocket, brightening with dynamic pressure.
    if (intensity > 0.02) {
      const rad = 14 + intensity * 30;
      const g = ctx.createRadialGradient(rx, ry, 0, rx, ry, rad);
      const grn = Math.round(190 - 130 * intensity);
      g.addColorStop(0, 'rgba(255,' + grn + ',60,' + (0.55 * intensity).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(255,70,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(rx, ry, rad, 0, Math.PI * 2);
      ctx.fill();
    }

    // Fire particles.
    for (const p of particles) {
      const a = Math.max(0, p.life / p.max);
      ctx.fillStyle = 'hsla(' + p.hue.toFixed(0) + ',100%,58%,' + (a * 0.9).toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * (0.4 + a * 0.6), 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalCompositeOperation = 'source-over';
  }

  // --- Telemetry ------------------------------------------------------------
  function updateTelemetry() {
    const r = Math.hypot(state.x, state.y) || 1;
    const alt = r - P.R;
    const speed = Math.hypot(state.vx, state.vy);
    const vr = (state.x * state.vx + state.y * state.vy) / r; // climb rate
    const vt = (state.x * state.vy - state.y * state.vx) / r; // horizontal
    const downrange = P.R * Math.atan2(state.x, state.y);
    const oe = P.orbitalElements(state);

    readoutEls['Phase'].textContent = state.phase || '—';
    readoutEls['Mission time'].textContent = fmtTime(state.t);
    readoutEls['Altitude'].textContent = fmtDist(alt);
    readoutEls['Speed'].textContent = fmtSpeed(speed);
    readoutEls['Vertical speed'].textContent = fmtSpeed(vr);
    readoutEls['Horizontal speed'].textContent = fmtSpeed(vt);
    readoutEls['Downrange'].textContent = fmtDist(downrange);
    readoutEls['Acceleration'].textContent = (state.accel / P.G0).toFixed(2) + ' g';
    const qNow = P.dynamicPressure(state);
    readoutEls['Dyn. pressure'].textContent =
      (qNow / 1000).toFixed(1) + ' kPa' + (maxQ > MAXQ_FLOOR ? ' (max ' + (maxQ / 1000).toFixed(0) + ')' : '');
    readoutEls['Mass'].textContent = (state.mass / 1000).toFixed(2) + ' t';
    const fuelPct = params.propMass > 0 ? (state.fuel / params.propMass) * 100 : 0;
    readoutEls['Fuel'].textContent = fuelPct.toFixed(0) + ' %';
    readoutEls['Apoapsis'].textContent = oe.apoapsisAlt > 0 ? fmtDist(oe.apoapsisAlt) : '—';
    readoutEls['Periapsis'].textContent = fmtDist(oe.periapsisAlt);
  }

  // --- Simulation loop ------------------------------------------------------
  function pushTrail() {
    trail.push({ x: state.x, y: state.y });
    if (trail.length > MAX_TRAIL) trail.shift();
  }

  function checkEnd() {
    if (state.landed) {
      ended = true;
      running = false;
      statusEl.textContent = state.t < 2 ? 'On the pad' : '💥 Crashed — try more thrust or a gentler pitch';
      pauseBtn.disabled = true;
      launchBtn.disabled = false;
      return true;
    }
    if (P.inOrbit(state) && !badgeEl.classList.contains('shown')) {
      ended = true;
      badgeEl.classList.remove('hidden');
      badgeEl.classList.add('shown');
      statusEl.textContent = '🛰️ Orbit achieved — coasting';
    }
    return false;
  }

  function frame(now) {
    const dtReal = Math.min(0.1, (now - lastNow) / 1000);
    lastNow = now;
    const warp = parseFloat(warpInput.value);

    if (running && !paused) {
      acc += dtReal * warp;
      let steps = 0;
      while (acc >= SIM_DT && steps < MAX_STEPS_PER_FRAME) {
        state = P.step(state, params, SIM_DT);
        pushTrail();
        trackMaxQ(now);
        acc -= SIM_DT;
        steps++;
        if (checkEnd() && !ended) break;
        if (state.landed) break;
      }
      // Status line: the MAX Q callout takes priority while it is up.
      if (running && now < maxQBannerUntil) {
        statusEl.textContent = '🔥 MAX Q · ' + (maxQ / 1000).toFixed(0) + ' kPa';
      } else if (!ended && running) {
        statusEl.textContent = state.phase;
      }
    }

    updateCamera();
    updateEffects(dtReal);
    render();
    updateTelemetry();
    requestAnimationFrame(frame);
  }

  // Track dynamic pressure, detect the max-Q peak, and fire off the callout.
  function trackMaxQ(now) {
    q = P.dynamicPressure(state);
    if (q > maxQ) {
      maxQ = q;
    } else if (!maxQPassed && maxQ > MAXQ_FLOOR && q < maxQ * 0.97 &&
               P.altitude(state) < P.W.ATMO_TOP) {
      maxQPassed = true;
      maxQBannerUntil = now + MAXQ_BANNER_MS;
      spawnFireBurst(60); // guarantee a visible flare even at high time warp
    }
  }

  // --- Controls -------------------------------------------------------------
  function launch() {
    state = P.initState(params);
    trail = [];
    acc = 0;
    running = true;
    paused = false;
    ended = false;
    cam = freshCamera(state);
    resetEffects();
    badgeEl.classList.add('hidden');
    badgeEl.classList.remove('shown');
    launchBtn.disabled = true;
    pauseBtn.disabled = false;
    pauseBtn.textContent = 'Pause';
    statusEl.textContent = 'Liftoff!';
  }

  function reset() {
    running = false;
    paused = false;
    ended = false;
    state = P.initState(params);
    trail = [];
    cam = freshCamera(state);
    resetEffects();
    badgeEl.classList.add('hidden');
    badgeEl.classList.remove('shown');
    launchBtn.disabled = false;
    pauseBtn.disabled = true;
    pauseBtn.textContent = 'Pause';
    statusEl.textContent = 'Ready for launch';
  }

  function resetEffects() {
    q = 0;
    maxQ = 0;
    maxQPassed = false;
    maxQBannerUntil = -1;
    particles = [];
  }

  launchBtn.addEventListener('click', launch);
  resetBtn.addEventListener('click', reset);
  pauseBtn.addEventListener('click', () => {
    if (!running) return;
    paused = !paused;
    pauseBtn.textContent = paused ? 'Resume' : 'Pause';
    if (paused) statusEl.textContent = '⏸ Paused';
  });
  defaultsBtn.addEventListener('click', () => {
    params = P.defaultParams();
    syncSlidersFromParams();
    reset();
  });
  warpInput.addEventListener('input', () => {
    warpVal.textContent = parseInt(warpInput.value, 10) + '×';
  });

  window.addEventListener('resize', resize);

  // --- Boot -----------------------------------------------------------------
  resize();
  updateTelemetry();
  requestAnimationFrame(frame);
})();
