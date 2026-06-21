// physics.test.js — unit tests for the LaunchSim flight model.
// Run with:  node --test        (or  npm test)
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('./physics.js');

const { R, G0, MU } = P;

// --- helpers ---------------------------------------------------------------

// Build a bare state object (defaults that the tests can override).
function makeState(over = {}) {
  return Object.assign(
    { x: 0, y: R, vx: 0, vy: 0, mass: 1000, fuel: 0, t: 0, thrusting: false, landed: false },
    over
  );
}

// Fly a full mission and return a summary.
function fly(params, { maxT = 9000, dt = 0.05 } = {}) {
  let s = P.initState(params);
  let sawNaN = false;
  let orbitT = null;
  for (let i = 0; i < maxT / dt; i++) {
    s = P.step(s, params, dt);
    if ([s.x, s.y, s.vx, s.vy, s.mass].some((v) => Number.isNaN(v))) {
      sawNaN = true;
      break;
    }
    if (orbitT === null && P.inOrbit(s)) orbitT = s.t;
    if (s.landed) break;
    if (orbitT !== null && s.t > orbitT + 100) break;
  }
  return { s, sawNaN, orbitT, oe: P.orbitalElements(s) };
}

// --- constants -------------------------------------------------------------

test('gravitational parameter is consistent with surface gravity', () => {
  assert.equal(MU, G0 * R * R);
  // Surface gravity recovered from MU / r^2.
  assert.ok(Math.abs(MU / (R * R) - G0) < 1e-9);
});

// --- initState -------------------------------------------------------------

test('initState places the rocket on the pad, fueled and at rest', () => {
  const p = P.defaultParams();
  const s = P.initState(p);
  assert.equal(s.x, 0);
  assert.equal(s.y, R);
  assert.equal(s.vx, 0);
  assert.equal(s.vy, 0);
  assert.equal(s.fuel, p.propMass);
  assert.equal(s.mass, p.dryMass + p.propMass);
  assert.equal(P.altitude(s), 0);
  assert.equal(s.landed, false);
});

// --- orbitalElements -------------------------------------------------------

test('a circular orbit has ~zero eccentricity and matching apo/periapsis', () => {
  const alt = 200e3;
  const r = R + alt;
  const vCirc = Math.sqrt(MU / r);
  const s = makeState({ x: 0, y: r, vx: vCirc, vy: 0 }); // tangential velocity
  const oe = P.orbitalElements(s);
  assert.ok(oe.e < 1e-9, `e=${oe.e}`);
  assert.ok(Math.abs(oe.apoapsisAlt - alt) < 1, `apo=${oe.apoapsisAlt}`);
  assert.ok(Math.abs(oe.periapsisAlt - alt) < 1, `peri=${oe.periapsisAlt}`);
  assert.ok(oe.energy < 0);
});

test('an elliptical orbit reports apoapsis above periapsis', () => {
  const r = R + 200e3;
  const v = 1.15 * Math.sqrt(MU / r); // faster than circular -> raises apoapsis
  const s = makeState({ x: 0, y: r, vx: v, vy: 0 });
  const oe = P.orbitalElements(s);
  assert.ok(oe.e > 0 && oe.e < 1, `e=${oe.e}`);
  assert.ok(oe.apoapsisAlt > oe.periapsisAlt);
  // Periapsis stays at the burn point (we sped up at periapsis).
  assert.ok(Math.abs(oe.periapsisAlt - 200e3) < 1000);
});

test('escape velocity yields non-negative energy and infinite apoapsis', () => {
  const r = R + 200e3;
  const vEsc = Math.sqrt(2 * MU / r);
  const s = makeState({ x: 0, y: r, vx: vEsc * 1.01, vy: 0 });
  const oe = P.orbitalElements(s);
  assert.ok(oe.energy >= 0);
  assert.equal(oe.apoapsisAlt, Infinity);
});

// --- step purity & burn ----------------------------------------------------

test('step does not mutate the input state', () => {
  const p = P.defaultParams();
  const s = P.initState(p);
  const snapshot = JSON.stringify(s);
  P.step(s, p, 0.05);
  assert.equal(JSON.stringify(s), snapshot);
});

test('burning consumes propellant at the rocket-equation rate', () => {
  const p = P.defaultParams();
  const s = P.initState(p); // on the pad, vertical thrust
  const dt = 0.05;
  const next = P.step(s, p, dt);
  const mdot = p.thrust / (p.isp * G0);
  const expectedBurn = mdot * dt;
  assert.ok(next.thrusting);
  assert.ok(Math.abs((s.fuel - next.fuel) - expectedBurn) < 1e-9);
  assert.ok(Math.abs((s.mass - next.mass) - expectedBurn) < 1e-9);
});

test('no thrust once fuel is exhausted', () => {
  const p = P.defaultParams();
  const s = makeState({ x: 0, y: R + 50e3, vx: 2000, vy: 1000, fuel: 0, mass: p.dryMass });
  const next = P.step(s, p, 0.05);
  assert.equal(next.thrusting, false);
  assert.equal(next.fuel, 0);
  assert.equal(next.mass, p.dryMass); // mass unchanged with no burn
});

// --- vertical liftoff ------------------------------------------------------

test('a fueled rocket gains altitude off the pad', () => {
  const p = P.defaultParams();
  let s = P.initState(p);
  for (let i = 0; i < 40; i++) s = P.step(s, p, 0.05); // ~2 s of flight
  assert.ok(P.altitude(s) > 0, `alt=${P.altitude(s)}`);
  assert.ok(s.vy > 0); // climbing
});

// --- ground impact ---------------------------------------------------------

test('hitting the surface clamps to the ground and zeroes velocity', () => {
  const p = P.defaultParams();
  const s = makeState({ x: 0, y: R + 1, vx: 0, vy: -100, fuel: 0 });
  const next = P.step(s, p, 0.05);
  assert.equal(next.landed, true);
  assert.ok(Math.abs(Math.hypot(next.x, next.y) - R) < 1e-6); // on the surface
  assert.equal(next.vx, 0);
  assert.equal(next.vy, 0);
});

test('a landed state is frozen (further steps are no-ops)', () => {
  const p = P.defaultParams();
  const s = makeState({ x: 0, y: R, landed: true });
  const next = P.step(s, p, 0.05);
  assert.equal(next, s);
});

// --- guidance --------------------------------------------------------------

test('guidance holds vertical before pitch-over, thrust on', () => {
  const p = P.defaultParams();
  const s = P.initState(p);
  const cmd = P.guidance(s, p);
  assert.equal(cmd.burn, true);
  // Direction is radially "up" (parallel to position vector).
  assert.ok(Math.abs(cmd.dirx - s.x / R) < 1e-12);
  assert.ok(Math.abs(cmd.diry - s.y / R) < 1e-12);
});

test('guidance cuts thrust with empty tanks', () => {
  const p = P.defaultParams();
  const s = makeState({ x: 0, y: R + 100e3, vx: 5000, vy: 0, fuel: 0 });
  assert.equal(P.guidance(s, p).burn, false);
});

// --- energy behaviour of the integrator ------------------------------------

test('coasting orbit (no thrust, no drag) stays bounded in altitude', () => {
  const p = Object.assign(P.defaultParams(), { thrust: 0, dragCdA: 0 });
  const r = R + 300e3;
  const vCirc = Math.sqrt(MU / r);
  let s = makeState({ x: 0, y: r, vx: vCirc, vy: 0, fuel: 0 });
  let minAlt = Infinity;
  let maxAlt = -Infinity;
  for (let i = 0; i < 40000; i++) {
    // ~2000 s, well over an orbit
    s = P.step(s, p, 0.05);
    const alt = P.altitude(s);
    minAlt = Math.min(minAlt, alt);
    maxAlt = Math.max(maxAlt, alt);
  }
  // Symplectic Euler keeps a near-circular orbit near-circular.
  assert.ok(maxAlt - minAlt < 5e3, `altitude band = ${(maxAlt - minAlt).toFixed(0)} m`);
});

// --- dynamic pressure (max Q) ----------------------------------------------

test('dynamic pressure is zero at rest and follows 1/2 rho v^2 at sea level', () => {
  assert.equal(P.dynamicPressure(makeState({ x: 0, y: R, vx: 0, vy: 0 })), 0);
  const v = 100;
  const q = P.dynamicPressure(makeState({ x: 0, y: R, vx: v, vy: 0 }));
  assert.ok(Math.abs(q - 0.5 * P.W.RHO0 * v * v) < 1e-6, `q=${q}`);
});

test('air density falls off with altitude', () => {
  const lo = P.density(makeState({ x: 0, y: R }));
  const hi = P.density(makeState({ x: 0, y: R + 50e3 }));
  assert.ok(hi < lo);
  assert.ok(Math.abs(lo - P.W.RHO0) < 1e-9); // sea level
});

test('default flight has a max-Q peak inside the atmosphere', () => {
  const p = P.defaultParams();
  let s = P.initState(p);
  let maxQ = 0;
  let maxQAlt = 0;
  for (let i = 0; i < 200000; i++) {
    s = P.step(s, p, 0.05);
    const q = P.dynamicPressure(s);
    if (q > maxQ) { maxQ = q; maxQAlt = P.altitude(s); }
    if (s.landed || P.altitude(s) > P.W.ATMO_TOP) break;
  }
  assert.ok(maxQ > 5000, `maxQ=${maxQ} Pa`); // a real aerodynamic peak
  assert.ok(maxQAlt > 0 && maxQAlt < P.W.ATMO_TOP, `maxQ alt=${maxQAlt}`);
});

// --- end-to-end missions ---------------------------------------------------

test('default rocket reaches a stable orbit with no NaNs', () => {
  const r = fly(P.defaultParams());
  assert.equal(r.sawNaN, false);
  assert.notEqual(r.orbitT, null, 'never achieved orbit');
  assert.ok(r.oe.energy < 0, 'orbit is not bound');
  assert.ok(r.oe.periapsisAlt > P.W.ORBIT_MARGIN, `periapsis=${r.oe.periapsisAlt}`);
});

test('an underpowered rocket fails to reach orbit and crashes', () => {
  const p = Object.assign(P.defaultParams(), { thrust: 80000 });
  const r = fly(p);
  assert.equal(r.sawNaN, false);
  assert.equal(r.orbitT, null);
  assert.equal(r.s.landed, true);
});

test('excessive drag prevents reaching orbit', () => {
  const p = Object.assign(P.defaultParams(), { dragCdA: 4 });
  const r = fly(p);
  assert.equal(r.orbitT, null);
});

test('a higher target altitude still reaches orbit, higher up', () => {
  const p = Object.assign(P.defaultParams(), { targetAlt: 350e3 });
  const r = fly(p);
  assert.notEqual(r.orbitT, null);
  assert.ok(r.oe.periapsisAlt > 200e3, `periapsis=${r.oe.periapsisAlt}`);
});
