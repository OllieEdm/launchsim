// physics.js — 2D rocket flight model with a gravity-turn ascent and an
// automatic orbital insertion (ascent -> coast -> circularize at apoapsis).
// Pure functions so the same code drives the browser UI and any sanity check.
//
// Coordinate frame: planet center at the origin. The rocket starts on the
// surface at (0, R). +y is "up" at the pad, +x is the downrange direction.

(function (global) {
  'use strict';

  // --- World constants (Earth-like) ---
  const R = 6.371e6; // planet radius (m)
  const G0 = 9.81; // standard gravity, also used for Isp (m/s^2)
  const MU = G0 * R * R; // gravitational parameter, so g = MU / r^2
  const RHO0 = 1.225; // sea-level air density (kg/m^3)
  const H = 8500; // atmospheric scale height (m)
  const ATMO_TOP = 100e3; // nominal top of atmosphere, for display (m)
  const ORBIT_MARGIN = 70e3; // periapsis must clear this to count as orbit (m)
  const TURN_END = 120e3; // altitude by which the gravity turn is fully horizontal (m)

  const W = { R, G0, MU, RHO0, H, ATMO_TOP, ORBIT_MARGIN, TURN_END };

  // Flight phases (returned on each state for UI labelling).
  const PHASE = {
    PAD: 'On pad',
    LIFTOFF: 'Vertical ascent',
    GRAVITY_TURN: 'Gravity turn',
    COAST: 'Coasting to apoapsis',
    CIRCULARIZE: 'Circularizing',
    ORBIT: 'In orbit',
    COAST_BALLISTIC: 'Ballistic coast',
  };

  function defaultParams() {
    return {
      thrust: 350000, // N
      isp: 350, // specific impulse (s)
      dryMass: 1500, // kg (everything except propellant)
      propMass: 26000, // kg of propellant
      dragCdA: 0.6, // drag coefficient x reference area (m^2)
      pitchStart: 12, // s after launch to begin the gravity turn
      pitchKick: 4, // degrees off vertical at the start of the turn
      targetAlt: 200000, // target orbit altitude (m)
    };
  }

  function initState(p) {
    return {
      x: 0,
      y: R,
      vx: 0,
      vy: 0,
      mass: p.dryMass + p.propMass,
      fuel: p.propMass,
      t: 0,
      thrusting: false,
      landed: false,
      accel: 0,
      phase: PHASE.PAD,
    };
  }

  function altitude(s) {
    return Math.hypot(s.x, s.y) - R;
  }

  // Air density at the rocket's current altitude (kg/m^3).
  function density(s) {
    const alt = altitude(s);
    return alt < 0 ? RHO0 : RHO0 * Math.exp(-alt / H);
  }

  // Dynamic pressure q = 1/2 rho v^2 (Pa). Peaks during ascent ("max Q").
  function dynamicPressure(s) {
    const v2 = s.vx * s.vx + s.vy * s.vy;
    return 0.5 * density(s) * v2;
  }

  // Keplerian orbit summary relative to the planet.
  function orbitalElements(s) {
    const r = Math.hypot(s.x, s.y);
    const v2 = s.vx * s.vx + s.vy * s.vy;
    const energy = v2 / 2 - MU / r;
    const h = s.x * s.vy - s.y * s.vx; // specific angular momentum (z)
    const e = Math.sqrt(Math.max(0, 1 + (2 * energy * h * h) / (MU * MU)));
    if (energy >= 0) {
      // Hyperbolic / escape: apoapsis is unbounded.
      return { a: Infinity, e, apoapsisAlt: Infinity, periapsisAlt: r - R, energy };
    }
    const a = -MU / (2 * energy);
    return {
      a,
      e,
      apoapsisAlt: a * (1 + e) - R,
      periapsisAlt: a * (1 - e) - R,
      energy,
    };
  }

  // Decide thrust on/off and steering direction for the current state.
  // Returns { burn, dirx, diry, phase }. Stateless: derived from orbit geometry.
  function guidance(s, p) {
    const r = Math.hypot(s.x, s.y) || 1e-9;
    const alt = r - R;
    const ux = s.x / r; // radial "up"
    const uy = s.y / r;
    const speed = Math.hypot(s.vx, s.vy);
    const vr = (s.x * s.vx + s.y * s.vy) / r; // radial (climb) velocity

    if (s.fuel <= 0 || p.thrust <= 0) {
      const oe = orbitalElements(s);
      const orbiting = oe.energy < 0 && oe.periapsisAlt > ORBIT_MARGIN;
      return { burn: false, dirx: ux, diry: uy, phase: orbiting ? PHASE.ORBIT : PHASE.COAST_BALLISTIC };
    }

    // Vertical hold off the pad until the turn begins.
    if (s.t < p.pitchStart || speed < 1e-3) {
      return { burn: true, dirx: ux, diry: uy, phase: PHASE.LIFTOFF };
    }

    const oe = orbitalElements(s);

    // Ascent: gravity turn with a smooth pitch ramp from `pitchKick` off
    // vertical at low altitude to fully horizontal by TURN_END. Run until the
    // apoapsis reaches the target altitude.
    if (oe.apoapsisAlt < p.targetAlt) {
      const f = Math.min(1, Math.max(0, alt / TURN_END));
      const ang = ((p.pitchKick + f * (90 - p.pitchKick)) * Math.PI) / 180;
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      // tangent (downrange) = (uy, -ux); dir = up*cos + tangent*sin.
      return { burn: true, dirx: ux * ca + uy * sa, diry: uy * ca - ux * sa, phase: PHASE.GRAVITY_TURN };
    }

    // Circularization: near/after apoapsis, burn prograde to raise periapsis.
    if (oe.periapsisAlt < p.targetAlt && (vr <= 0 || alt >= p.targetAlt - 5000)) {
      return { burn: true, dirx: s.vx / speed, diry: s.vy / speed, phase: PHASE.CIRCULARIZE };
    }

    // Coast to apoapsis (engine off) with the target apoapsis already set.
    const orbiting = oe.energy < 0 && oe.periapsisAlt > ORBIT_MARGIN;
    return { burn: false, dirx: ux, diry: uy, phase: orbiting ? PHASE.ORBIT : PHASE.COAST };
  }

  // Advance the state by dt seconds. Pure: returns a new state object.
  function step(s, p, dt) {
    if (s.landed) return s;

    const r = Math.hypot(s.x, s.y) || 1e-9;
    const alt = r - R;
    const ux = s.x / r;
    const uy = s.y / r;

    // Gravity toward the planet center.
    const g = MU / (r * r);
    const gx = -g * ux;
    const gy = -g * uy;

    // Atmospheric drag, opposing the velocity vector.
    const speed = Math.hypot(s.vx, s.vy);
    const rho = alt < 0 ? RHO0 : RHO0 * Math.exp(-alt / H);
    let dax = 0;
    let day = 0;
    if (speed > 1e-6) {
      const dragAcc = (0.5 * rho * speed * speed * p.dragCdA) / s.mass;
      dax = -dragAcc * (s.vx / speed);
      day = -dragAcc * (s.vy / speed);
    }

    // Thrust + propellant burn, per the guidance law.
    const cmd = guidance(s, p);
    let tax = 0;
    let tay = 0;
    let fuel = s.fuel;
    let mass = s.mass;
    if (cmd.burn) {
      const thrustAcc = p.thrust / s.mass;
      tax = thrustAcc * cmd.dirx;
      tay = thrustAcc * cmd.diry;
      const mdot = p.thrust / (p.isp * G0); // rocket equation via Isp
      const burned = Math.min(s.fuel, mdot * dt);
      fuel = s.fuel - burned;
      mass = s.mass - burned;
    }

    // Semi-implicit (symplectic) Euler.
    const ax = gx + dax + tax;
    const ay = gy + day + tay;
    const vx = s.vx + ax * dt;
    const vy = s.vy + ay * dt;
    const x = s.x + vx * dt;
    const y = s.y + vy * dt;

    const next = {
      x,
      y,
      vx,
      vy,
      mass,
      fuel,
      t: s.t + dt,
      thrusting: cmd.burn,
      landed: false,
      accel: Math.hypot(ax, ay),
      phase: cmd.phase,
    };

    // Ground contact: stop cleanly at the surface.
    if (Math.hypot(x, y) <= R) {
      const rr = Math.hypot(x, y) || 1e-9;
      next.x = (x / rr) * R;
      next.y = (y / rr) * R;
      next.vx = 0;
      next.vy = 0;
      next.landed = true;
      next.thrusting = false;
      next.phase = s.t < 2 ? PHASE.PAD : 'Impact';
    }
    return next;
  }

  function inOrbit(s) {
    const oe = orbitalElements(s);
    return !s.thrusting && oe.energy < 0 && oe.periapsisAlt > ORBIT_MARGIN;
  }

  const Physics = {
    W,
    R,
    G0,
    MU,
    PHASE,
    defaultParams,
    initState,
    step,
    guidance,
    altitude,
    density,
    dynamicPressure,
    orbitalElements,
    inOrbit,
  };

  global.Physics = Physics;
  if (typeof module !== 'undefined' && module.exports) module.exports = Physics;
})(typeof window !== 'undefined' ? window : globalThis);
