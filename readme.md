# 🚀 LaunchSim

A simple **2D rocket launch simulator** that runs entirely in your browser — no
backend, no build step, no dependencies. Tune a rocket, hit **Launch**, and watch it
fly a gravity-turn ascent and insert itself into orbit, with live telemetry.

## Run it

Either:

- **Double-click `index.html`** — it just opens, or
- Serve it (avoids any browser file:// quirks):
  ```bash
  python3 -m http.server 8000
  ```
  then open <http://localhost:8000>.

## How it works

The rocket flies in a 2D plane around an Earth-like planet (central gravity
`g = μ/r²`, exponential-atmosphere drag, propellant burned via the rocket equation).
Guidance is automatic in three phases:

1. **Vertical ascent** off the pad until the pitch-over time.
2. **Gravity turn** — the rocket smoothly tips from vertical toward horizontal as it
   climbs, burning until its **apoapsis** reaches your target altitude.
3. **Coast & circularize** — the engine cuts off, the rocket coasts up to apoapsis,
   then re-lights prograde to raise the **periapsis** and circularize the orbit.

When the periapsis clears the atmosphere, you get **ORBIT ACHIEVED**.

## Controls

| Slider | What it does |
| --- | --- |
| **Thrust** | Engine force. Must beat liftoff weight (TWR > 1) to leave the pad. |
| **Specific impulse (Isp)** | Engine efficiency — higher Isp = more Δv per kg of fuel. |
| **Dry mass** | Everything that isn't propellant. |
| **Propellant mass** | Fuel on board — sets your total Δv and burn time. |
| **Drag (Cd·A)** | Aerodynamic drag area. Crank it up to see drag losses bite. |
| **Pitch-over start** | When (seconds after liftoff) the gravity turn begins. |
| **Pitch kick** | How sharply the rocket tips off vertical at the start of the turn. |
| **Target orbit altitude** | Where the guidance aims to circularize (the dashed ring). |
| **Time warp** | Speeds up the simulation (the flight takes ~6 min of sim time). |

Buttons: **Launch**, **Pause/Resume**, **Reset**, and **Restore default rocket**.

The default rocket reaches a ~160 × 680 km orbit. Try cutting thrust or fuel to fall
short, or maxing thrust to overshoot into a wildly elliptical orbit.

## Files

- `index.html` — layout (controls, flight view, telemetry).
- `styles.css` — styling.
- `physics.js` — the flight model: world constants, the integrator (`step`), the
  guidance law, and orbital-element math. Pure functions, no DOM.
- `app.js` — sliders, the render loop, the auto-zooming camera, and telemetry.
