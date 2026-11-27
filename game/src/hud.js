// The instrument panel and the on-screen readouts. Everything is drawn on a 2D canvas laid over
// the WebGL view, so the HUD is crisp at any window size and needs no font to load.
//
// The panel is styled as a glass cockpit: speed on the left tape, altitude on the right, a heading
// ribbon across the top, and the attitude indicator in the middle with a bank scale. The campaign
// adds three things to it: the round's name and score at the top left, a flap and wind block at the
// bottom, and a gate pip row that grows as the later rounds add gates.

const FONT = 'ui-monospace, "SF Mono", "Roboto Mono", Menlo, Consolas, monospace';

export function createHud(canvas) {
  const ctx = canvas.getContext('2d');
  let width = 0, height = 0, dpr = 1;

  function resize(cssWidth, cssHeight) {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    width = cssWidth;
    height = cssHeight;
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function clear() {
    ctx.clearRect(0, 0, width, height);
  }

  function panel(x, y, w, h, alpha = 0.5) {
    ctx.fillStyle = `rgba(8, 14, 22, ${alpha})`;
    roundRect(x, y, w, h, 8);
    ctx.fill();
    ctx.strokeStyle = 'rgba(150, 200, 220, 0.28)';
    ctx.lineWidth = 1;
    roundRect(x, y, w, h, 8);
    ctx.stroke();
  }

  function text(value, x, y, size, align = 'left', color = 'rgba(226, 240, 248, 0.95)', weight = 500) {
    ctx.fillStyle = color;
    ctx.font = `${weight} ${size}px ${FONT}`;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.fillText(value, x, y);
  }

  /**
   * Draws the whole instrument panel for one frame.
   * `d` holds: speed (knots), altitude (feet), heading (degrees), climb (ft/min), throttle 0-1,
   * fuel 0-1, health 0-1, flaps 0-2, pitch and bank (radians), gate distance and bearing,
   * gatesPassed, gatesTotal, timeLeft (seconds), score, roundName, roundIndex, wind {from,speed},
   * message (a line to show, or null), stall (bool) and warnings (array of strings).
   */
  function draw(d) {
    clear();

    const cx = width / 2;
    const cy = height / 2;

    const scale = Math.min(1, Math.min(width / 1280, height / 720));
    const cockpit = !!d.cockpit;
    const r = Math.min(84, height * 0.105) * (cockpit ? 0.82 : 1);
    const dialY = height - Math.min(118, height * 0.152) * (cockpit ? 1.12 : 1);

    drawHeadingRibbon(cx, Math.min(56, height * 0.075), width, d);

    // In the cockpit view the 3D panel already carries the airspeed, attitude and altimeter dials,
    // so the flat copies are dropped rather than drawn on top of them: two sets of dials in the
    // same screen space only make the panel unreadable.
    if (!cockpit) {
      drawAttitude(cx, dialY, r, d);
      drawSpeedTape(cx - r - 68, dialY, d, scale);
      drawAltitudeTape(cx + r + 68, dialY, d, scale);
    }

    // In the cockpit the 3D panel is the instrument panel, so the flat HUD's blocks move to the
    // screen's corners and shrink: two sets of dials in the same place would fight each other.
    if (cockpit) {
      drawCompactEngineBlock(16, 86, d, scale * 0.92);
      drawCompactStatus(width - 156 * scale * 0.92 - 16, 86, d, scale * 0.92);
      drawCompactCombat(width - 156 * scale * 0.92 - 16, 86 + 98 * scale * 0.92, d, scale * 0.92);
    } else {
      drawEngineBlock(20, height - 146, d, scale);
      drawStatusBar(width - 190, height - 122, d, scale);
      drawCombatBlock(width - 190, height - 122 - 92 * scale, d, scale);
    }
    drawRoundStrip(20, cockpit ? 132 : 20, d, scale);
    drawAutopilotStrip(20, cockpit ? 190 : 78, d, scale);
    drawSalvageMarker(cx, cy, d, scale);
    drawThreatWarning(cx, cy, d, scale);
    drawAceBracket(d);
    drawDamageVignette(d);

    drawGateIndicator(cx, dialY - r - (cockpit ? 30 : 44), d, scale * (cockpit ? 0.9 : 1));
    drawCrosshair(cx, cy * (cockpit ? 0.86 : 0.72), d);
    // The marker sits on the reticle the rounds actually converge on, which is the crosshair, not
    // the screen's centre in the cockpit view where the panel takes the bottom half.
    drawHitMarker(cx, cy * (cockpit ? 0.86 : 0.72), d, scale);

    if (d.stall) {
      text('STALL', cx, dialY - r - (cockpit ? 12 : 24), 20, 'center', 'rgba(255, 96, 72, 0.96)', 700);
    }
    if (d.message) {
      const w = Math.min(width * 0.62, 660);
      panel(cx - w / 2, height * 0.125, w, 38, 0.58);
      text(d.message, cx, height * 0.125 + 19, 13.5, 'center', 'rgba(255, 236, 196, 0.98)', 600);
    }
  }

  /** A tighter engine block for the cockpit view: same numbers, a third of the footprint. */
  function drawCompactEngineBlock(x, y, d, scale = 1) {
    const w = 148 * scale, h = 92 * scale;
    panel(x, y, w, h, 0.52);
    text('THROTTLE', x + 10, y + 13, 8.5, 'left', 'rgba(160, 205, 220, 0.85)', 600);
    text(`${Math.round(d.throttle * 100)}%`, x + w - 10, y + 13, 9.5, 'right', 'rgba(214, 250, 240, 1)', 700);
    bar(x + 10, y + 21, w - 20, 6, d.throttle, 'rgba(120, 230, 190, 0.95)');

    const flaps = Math.round((d.flaps ?? 0) * 2) / 2;
    text('FLAPS', x + 10, y + 38, 8.5, 'left', 'rgba(160, 205, 220, 0.85)', 600);
    text(flaps <= 0 ? 'UP' : flaps >= 2 ? 'FULL' : 'HALF', x + w - 10, y + 38, 9.5, 'right',
      flaps > 0 ? 'rgba(255, 226, 170, 1)' : 'rgba(150, 190, 210, 0.8)', 700);
    if (d.wind) {
      text('WIND', x + 10, y + 55, 8.5, 'left', 'rgba(160, 205, 220, 0.85)', 600);
      text(`${compassPoint(d.wind.from)} ${Math.round(d.wind.speed)}`, x + w - 10, y + 55, 9.5, 'right',
        Math.abs(d.wind.speed) > 10 ? 'rgba(255, 200, 150, 1)' : 'rgba(200, 240, 250, 1)', 700);
    }
    text('FUEL', x + 10, y + 74, 8.5, 'left', 'rgba(160, 205, 220, 0.85)', 600);
    bar(x + 40, y + 70, 58, 7, d.fuel,
      d.fuel < 0.18 ? 'rgba(255, 110, 80, 0.95)' : 'rgba(255, 206, 120, 0.95)');
    text('AIRFRAME', x + 10, y + 88, 8.5, 'left', 'rgba(160, 205, 220, 0.85)', 600);
    bar(x + 66, y + 84, 58, 7, d.health,
      d.health < 0.35 ? 'rgba(255, 90, 70, 0.95)' : 'rgba(120, 210, 235, 0.95)');
  }

  /** A tighter clock and gate block for the cockpit view. */
  function drawCompactStatus(x, y, d, scale = 1) {
    const w = 140 * scale, h = 92 * scale;
    panel(x, y, w, h, 0.52);
    const t = Math.max(0, d.timeLeft);
    text('TIME', x + 10, y + 13, 8.5, 'left', 'rgba(160, 205, 220, 0.85)', 600);
    text(`${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`, x + w - 10, y + 13, 12,
      'right', t < 30 ? 'rgba(255, 130, 100, 1)' : 'rgba(214, 250, 240, 1)', 700);
    text('GATES', x + 10, y + 32, 8.5, 'left', 'rgba(160, 205, 220, 0.85)', 600);
    text(`${d.gatesPassed}/${d.gatesTotal}`, x + w - 10, y + 32, 12, 'right', 'rgba(120, 240, 190, 1)', 700);
    const gap = 2;
    const pipW = (w - 20 - gap * (d.gatesTotal - 1)) / Math.max(1, d.gatesTotal);
    for (let i = 0; i < d.gatesTotal; i += 1) {
      ctx.fillStyle = i < d.gatesPassed ? 'rgba(120, 240, 190, 0.95)' : 'rgba(120, 160, 180, 0.3)';
      ctx.fillRect(x + 10 + i * (pipW + gap), y + 42, pipW, 8);
    }
    text('SCORE', x + 10, y + 80, 8.5, 'left', 'rgba(160, 205, 220, 0.85)', 600);
    text(String(Math.round(d.score ?? 0)), x + w - 10, y + 80, 14, 'right', 'rgba(255, 236, 176, 0.98)', 700);
  }

  /**
   * The autopilot strip: the mode, what it is doing, and the bank of credits the salvage is going
   * into. It only draws while something is worth saying — an empty panel on a clean screen is noise.
   */
  function drawAutopilotStrip(x, y, d, scale = 1) {
    const mode = d.autopilot ?? 'off';
    const credits = Math.round(d.credits ?? 0);
    if (mode === 'off' && !credits) return;

    const w = 244 * scale, h = mode === 'off' ? 22 * scale : 40 * scale;
    panel(x, y, w, h, 0.46);

    if (mode !== 'off') {
      const label = mode === 'hold' ? 'HOLD' : mode === 'course' ? 'COURSE' : 'APPROACH';
      text('AUTOPILOT', x + 12, y + 12, 8.5, 'left', 'rgba(150, 195, 215, 0.85)', 600);
      text(label, x + 92, y + 12, 9.5, 'left', 'rgba(140, 235, 200, 0.98)', 700);
      text(d.autopilotPhase ?? '', x + 12, y + 27, 9, 'left', 'rgba(200, 235, 245, 0.85)', 500);
      // A small dot that pulses, so an engaged autopilot is obvious at a glance.
      const pulse = 0.55 + 0.45 * Math.sin((d.timeLeft ?? 0) * 2.4);
      ctx.fillStyle = `rgba(120, 240, 190, ${pulse})`;
      ctx.beginPath();
      ctx.arc(x + w - 12, y + 12, 3.2, 0, Math.PI * 2);
      ctx.fill();
    }

    text('SALVAGE', x + 12, y + h - 8, 8.5, 'left', 'rgba(150, 195, 215, 0.85)', 600);
    text(`${Math.round(d.credits ?? 0)} cr`, x + w - 12, y + h - 8, 10, 'right',
      'rgba(255, 226, 150, 0.98)', 700);
    if (d.picked) {
      text(`+${d.picked} this sortie`, x + 78, y + h - 8, 8.5, 'left',
        'rgba(180, 220, 235, 0.75)', 500);
    }
  }

  /**
   * The salvage marker: a small chevron in the frame's edge pointing at the nearest can, with its
   * kind and range. A can that is off-screen with no marker is a can the pilot will never find.
   */
  function drawSalvageMarker(cx, cy, d, scale = 1) {
    const p = d.nearestPickup;
    if (!p) return;
    const rel = p.bearing - Math.PI / 2;
    const r = Math.min(width, height) * 0.30;
    const px = cx + Math.cos(rel) * r;
    const py = cy + Math.sin(rel) * r * 0.62;

    const color = p.kind === 'fuel' ? 'rgba(255, 194, 77, 0.9)'
      : p.kind === 'repair' ? 'rgba(110, 240, 184, 0.9)'
      : p.kind === 'boost' ? 'rgba(143, 208, 255, 0.9)'
      : 'rgba(255, 226, 122, 0.9)';

    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(rel + Math.PI / 2);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, -5.5);
    ctx.lineTo(5, 4);
    ctx.lineTo(-5, 4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    const label = p.kind === 'fuel' ? 'FUEL' : p.kind === 'repair' ? 'REPAIR'
      : p.kind === 'boost' ? 'BOOST' : 'SALVAGE';
    const dist = p.distance > 1000 ? `${(p.distance / 1000).toFixed(1)} km` : `${Math.round(p.distance)} m`;
    text(`${label} ${dist}`, px, py + 16, 9, 'center', color, 600);
  }

  /** The attitude indicator: sky and ground rotating with the aircraft, with a bank scale. */
  function drawAttitude(cx, cy, r, d) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();

    const pitch = d.pitch;
    const bank = d.bank;
    ctx.translate(cx, cy);
    ctx.rotate(bank);
    const offset = Math.tan(Math.max(-1.2, Math.min(1.2, pitch))) * r * 1.5;

    ctx.fillStyle = 'rgba(52, 116, 176, 0.85)';
    ctx.fillRect(-r * 2, -r * 3 + offset, r * 4, r * 3);
    ctx.fillStyle = 'rgba(112, 84, 52, 0.85)';
    ctx.fillRect(-r * 2, offset, r * 4, r * 3);
    ctx.strokeStyle = 'rgba(240, 250, 255, 0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-r * 2, offset);
    ctx.lineTo(r * 2, offset);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(240, 250, 255, 0.55)';
    ctx.lineWidth = 1.2;
    for (let deg = -30; deg <= 30; deg += 10) {
      if (deg === 0) continue;
      const y = offset - Math.tan((deg * Math.PI) / 180) * r * 1.5;
      const half = deg % 20 === 0 ? r * 0.34 : r * 0.2;
      ctx.beginPath();
      ctx.moveTo(-half, y);
      ctx.lineTo(half, y);
      ctx.stroke();
    }
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = 'rgba(150, 200, 220, 0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255, 214, 90, 0.95)';
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.42, cy);
    ctx.lineTo(cx - r * 0.14, cy);
    ctx.lineTo(cx - r * 0.06, cy + r * 0.07);
    ctx.moveTo(cx + r * 0.42, cy);
    ctx.lineTo(cx + r * 0.14, cy);
    ctx.lineTo(cx + r * 0.06, cy + r * 0.07);
    ctx.stroke();

    for (let deg = -60; deg <= 60; deg += 10) {
      const a = -Math.PI / 2 + (deg * Math.PI) / 180;
      const len = deg % 30 === 0 ? r * 0.13 : r * 0.075;
      ctx.beginPath();
      ctx.strokeStyle = deg === 0 ? 'rgba(255, 214, 90, 0.9)' : 'rgba(180, 220, 235, 0.6)';
      ctx.lineWidth = deg === 0 ? 2.5 : 1.4;
      ctx.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      ctx.lineTo(cx + Math.cos(a) * (r - len), cy + Math.sin(a) * (r - len));
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Airspeed on the left, as a tape with a moving readout box. */
  function drawSpeedTape(x, cy, d, scale = 1) {
    const w = 64 * scale, h = 196 * scale;
    panel(x - w / 2, cy - h / 2, w, h, 0.42);
    const knotsPerPixel = 2.9 / scale;
    const span = h * knotsPerPixel;
    const top = d.speed + span / 2;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x - w / 2, cy - h / 2, w, h);
    ctx.clip();
    for (let k = Math.floor((top - span) / 10) * 10; k <= top + 10; k += 10) {
      const y = cy + (top - k) / knotsPerPixel;
      if (y < cy - h / 2 - 6 || y > cy + h / 2 + 6) continue;
      const major = k % 50 === 0;
      ctx.strokeStyle = major ? 'rgba(200, 230, 245, 0.75)' : 'rgba(160, 200, 220, 0.35)';
      ctx.lineWidth = major ? 1.6 : 1;
      ctx.beginPath();
      ctx.moveTo(x + w / 2 - 6, y);
      ctx.lineTo(x + w / 2 - (major ? 19 : 12), y);
      ctx.stroke();
      if (major) text(String(k), x + w / 2 - 23, y, 9.5, 'right', 'rgba(190, 220, 235, 0.65)');
    }
    // Red stall band, drawn from the bottom of the tape up to the stall speed.
    const stallY = cy + (top - stallKnots(d.flaps)) / knotsPerPixel;
    ctx.fillStyle = 'rgba(255, 72, 52, 0.20)';
    const from = Math.max(cy - h / 2, stallY);
    if (from < cy + h / 2) ctx.fillRect(x - w / 2, from, w, (cy + h / 2) - from);
    ctx.restore();

    ctx.fillStyle = 'rgba(12, 26, 38, 0.94)';
    ctx.strokeStyle = 'rgba(120, 230, 200, 0.9)';
    ctx.lineWidth = 2;
    roundRect(x - w / 2 + 5, cy - 18, w - 10, 36, 6);
    ctx.fill();
    ctx.stroke();
    text(String(Math.round(d.speed)).padStart(3, ' '), x, cy + 1, 20 * scale, 'center', 'rgba(214, 250, 240, 1)', 700);
    text('KTS', x, cy - 26 - 8, 9 * scale, 'center', 'rgba(160, 210, 225, 0.8)', 600);
  }

  /** Altitude on the right, with the vertical-speed needle beside it. */
  function drawAltitudeTape(x, cy, d, scale = 1) {
    const w = 74 * scale, h = 196 * scale;
    panel(x - w / 2, cy - h / 2, w, h, 0.42);
    const feetPerPixel = 30 / scale;
    const span = h * feetPerPixel;
    const top = d.altitude + span / 2;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x - w / 2, cy - h / 2, w, h);
    ctx.clip();
    for (let f = Math.floor((top - span) / 200) * 200; f <= top + 200; f += 200) {
      const y = cy + (top - f) / feetPerPixel;
      if (y < cy - h / 2 - 6 || y > cy + h / 2 + 6) continue;
      const major = f % 1000 === 0;
      ctx.strokeStyle = major ? 'rgba(200, 230, 245, 0.75)' : 'rgba(160, 200, 220, 0.35)';
      ctx.lineWidth = major ? 1.6 : 1;
      ctx.beginPath();
      ctx.moveTo(x - w / 2 + 6, y);
      ctx.lineTo(x - w / 2 + (major ? 19 : 12), y);
      ctx.stroke();
      if (major) text(String(f), x - w / 2 + 23, y, 9.5, 'left', 'rgba(190, 220, 235, 0.65)');
    }
    ctx.restore();

    ctx.fillStyle = 'rgba(12, 26, 38, 0.94)';
    ctx.strokeStyle = 'rgba(120, 230, 200, 0.9)';
    ctx.lineWidth = 2;
    roundRect(x - w / 2 + 5, cy - 18, w - 10, 36, 6);
    ctx.fill();
    ctx.stroke();
    text(String(Math.round(d.altitude)), x, cy + 1, 16 * scale, 'center', 'rgba(214, 250, 240, 1)', 700);
    text('FT', x, cy - 26 - 8, 9 * scale, 'center', 'rgba(160, 210, 225, 0.8)', 600);

    const vs = Math.max(-2000, Math.min(2000, d.climb));
    const needleY = cy - (vs / 2000) * (h / 2 - 18);
    ctx.strokeStyle = vs > 40 ? 'rgba(120, 240, 170, 0.9)' : vs < -40 ? 'rgba(255, 150, 110, 0.9)' : 'rgba(180, 210, 225, 0.6)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(x + w / 2 + 4, cy);
    ctx.lineTo(x + w / 2 + 4, needleY);
    ctx.stroke();
    text(`${vs > 0 ? '+' : ''}${Math.round(vs / 10) * 10}`, x + w / 2 + 8, needleY, 10, 'left',
      vs > 40 ? 'rgba(120, 240, 170, 0.9)' : vs < -40 ? 'rgba(255, 150, 110, 0.9)' : 'rgba(180, 210, 225, 0.6)');
  }

  /** The heading ribbon across the top of the view. */
  function drawHeadingRibbon(cx, y, totalWidth, d) {
    const w = Math.min(400, totalWidth * 0.46);
    const h = 38;
    panel(cx - w / 2, y - h / 2, w, h, 0.42);

    const degPerPixel = 0.46;
    const span = w * degPerPixel;
    const heading = ((d.heading % 360) + 360) % 360;
    const left = heading - span / 2;

    ctx.save();
    ctx.beginPath();
    ctx.rect(cx - w / 2, y - h / 2, w, h);
    ctx.clip();
    for (let a = Math.floor(left / 5) * 5; a <= left + span + 5; a += 5) {
      const x = cx + (a - heading) / degPerPixel;
      const norm = ((a % 360) + 360) % 360;
      const major = norm % 30 === 0;
      ctx.strokeStyle = major ? 'rgba(205, 235, 248, 0.8)' : 'rgba(160, 200, 220, 0.35)';
      ctx.lineWidth = major ? 1.7 : 1;
      ctx.beginPath();
      ctx.moveTo(x, y + h / 2 - 6);
      ctx.lineTo(x, y + h / 2 - (major ? 16 : 10));
      ctx.stroke();
      if (major) {
        const label = norm === 0 ? 'N' : norm === 90 ? 'E' : norm === 180 ? 'S' : norm === 270 ? 'W'
          : String(norm / 10).padStart(2, '0');
        text(label, x, y - 1, norm % 90 === 0 ? 11.5 : 9.5, 'center',
          norm % 90 === 0 ? 'rgba(255, 236, 176, 0.95)' : 'rgba(200, 228, 240, 0.8)', norm % 90 === 0 ? 700 : 500);
      }
    }
    ctx.restore();

    ctx.fillStyle = 'rgba(255, 214, 90, 0.95)';
    ctx.beginPath();
    ctx.moveTo(cx, y + h / 2 - 2);
    ctx.lineTo(cx - 6, y + h / 2 + 7);
    ctx.lineTo(cx + 6, y + h / 2 + 7);
    ctx.closePath();
    ctx.fill();
    text(`${String(Math.round(heading)).padStart(3, '0')}°`, cx, y + h / 2 + 17, 12.5, 'center', 'rgba(255, 236, 176, 0.98)', 700);
  }

  /** Throttle, afterburner, flaps, fuel, airframe and the wind, bottom left. */
  function drawEngineBlock(x, y, d, scale = 1) {
    const w = 186 * scale, h = 140 * scale;
    panel(x, y, w, h, 0.5);

    // Throttle, with the lever's own readout.
    text('THROTTLE', x + 12, y + 15, 9.5, 'left', 'rgba(160, 205, 220, 0.85)', 600);
    text(`${Math.round(d.throttle * 100)}%`, x + w - 12, y + 15, 10.5, 'right', 'rgba(214, 250, 240, 1)', 700);
    bar(x + 12, y + 23, w - 24, 7, d.throttle, 'rgba(120, 230, 190, 0.95)');

    // The afterburner: charge left, and the spool state, because a boost that is lit but not yet
    // spooled produces no thrust and the pilot needs to see the difference.
    const boost = Math.max(0, Math.min(1, d.boost ?? 0));
    const spool = Math.max(0, Math.min(1, d.boostSpool ?? 0));
    const lit = spool > 0.12;
    text('BOOST', x + 12, y + 38, 9.5, 'left', 'rgba(160, 205, 220, 0.85)', 600);
    text(lit ? (boost < 0.15 ? 'DRY' : spool > 0.8 ? 'LIT' : 'SPOOL') : (boost < 0.99 ? 'RECHRG' : 'READY'),
      x + w - 12, y + 38, 10, 'right',
      lit ? 'rgba(255, 170, 96, 1)' : boost > 0.99 ? 'rgba(150, 240, 210, 1)' : 'rgba(160, 200, 220, 0.85)', 700);
    bar(x + 12, y + 46, w - 24, 7, boost,
      boost < 0.15 ? 'rgba(255, 110, 80, 0.95)' : lit ? 'rgba(255, 160, 70, 0.98)' : 'rgba(110, 190, 235, 0.95)');
    // A spool tick rides the bar's right edge so the wind-up is visible, not just inferred.
    if (lit && spool < 0.98) {
      const sx = x + 12 + (w - 24) * spool;
      ctx.fillStyle = 'rgba(255, 238, 200, 0.9)';
      ctx.fillRect(sx, y + 44, 1.6, 11);
    }

    // Flaps, as two notches rather than a bar: it is a selection, not a level.
    text('FLAPS', x + 12, y + 70, 9.5, 'left', 'rgba(160, 205, 220, 0.85)', 600);
    const flaps = Math.round((d.flaps ?? 0) * 2) / 2;
    for (let i = 0; i < 2; i += 1) {
      const on = flaps >= i + 1;
      ctx.fillStyle = on ? 'rgba(255, 206, 120, 0.95)' : 'rgba(120, 160, 180, 0.25)';
      ctx.fillRect(x + 62 + i * 22, y + 65, 16, 9);
    }
    text(flaps <= 0 ? 'UP' : flaps >= 2 ? 'FULL' : 'HALF', x + w - 12, y + 70, 10, 'right',
      flaps > 0 ? 'rgba(255, 226, 170, 1)' : 'rgba(150, 190, 210, 0.8)', 700);

    // Wind: the direction it blows from, and its speed. This is the round's weather, not a guess.
    if (d.wind) {
      const from = ((d.wind.from % 360) + 360) % 360;
      const label = compassPoint(from);
      text('WIND', x + 12, y + 92, 9.5, 'left', 'rgba(160, 205, 220, 0.85)', 600);
      // A small arrow, pointing the way the wind blows TOWARD, which is what the pilot cares about.
      const a = ((from + 180) * Math.PI) / 180;
      const ax = x + 62, ay = y + 92;
      ctx.save();
      ctx.strokeStyle = Math.abs(d.wind.speed) > 10 ? 'rgba(255, 170, 120, 0.95)' : 'rgba(180, 220, 235, 0.85)';
      ctx.fillStyle = ctx.strokeStyle;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(ax - Math.sin(a) * 7, ay + Math.cos(a) * 7);
      ctx.lineTo(ax + Math.sin(a) * 7, ay - Math.cos(a) * 7);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(ax + Math.sin(a) * 7, ay - Math.cos(a) * 7, 2.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      text(`${label} ${Math.round(d.wind.speed)} m/s`, x + w - 12, y + 92, 10.5, 'right',
        Math.abs(d.wind.speed) > 10 ? 'rgba(255, 200, 150, 1)' : 'rgba(200, 240, 250, 1)', 700);
    }

    // Fuel and airframe, side by side, at the block's foot.
    text('FUEL', x + 12, y + 114, 9.5, 'left', 'rgba(160, 205, 220, 0.85)', 600);
    bar(x + 12, y + 122, 68, 8, d.fuel,
      d.fuel < 0.18 ? 'rgba(255, 110, 80, 0.95)' : 'rgba(255, 206, 120, 0.95)');
    text(`${Math.round(d.fuel * 100)}%`, x + 12 + 68, y + 114, 10, 'left',
      d.fuel < 0.18 ? 'rgba(255, 140, 110, 1)' : 'rgba(255, 226, 170, 1)', 700);

    text('AIRFRAME', x + 101, y + 114, 9.5, 'left', 'rgba(160, 205, 220, 0.85)', 600);
    bar(x + 101, y + 122, 68, 8, d.health,
      d.health < 0.35 ? 'rgba(255, 90, 70, 0.95)' : 'rgba(120, 210, 235, 0.95)');
    text(`${Math.round(d.health * 100)}%`, x + 101 + 68, y + 114, 10, 'left',
      d.health < 0.35 ? 'rgba(255, 140, 110, 1)' : 'rgba(200, 240, 250, 1)', 700);
  }

  /** Clock, gate count and live score, bottom right. */
  function drawStatusBar(x, y, d, scale = 1) {
    const w = 170 * scale, h = 116 * scale;
    panel(x, y, w, h, 0.5);
    text('TIME LEFT', x + 12, y + 16, 9.5, 'left', 'rgba(160, 205, 220, 0.85)', 600);
    const t = Math.max(0, d.timeLeft);
    const mm = Math.floor(t / 60);
    const ss = Math.floor(t % 60);
    text(`${mm}:${String(ss).padStart(2, '0')}`, x + 12, y + 38, 23, 'left',
      t < 30 ? 'rgba(255, 130, 100, 1)' : 'rgba(214, 250, 240, 1)', 700);

    text('GATES', x + 12, y + 62, 9.5, 'left', 'rgba(160, 205, 220, 0.85)', 600);
    text(`${d.gatesPassed}/${d.gatesTotal}`, x + w - 12, y + 62, 18, 'right', 'rgba(120, 240, 190, 1)', 700);

    // A pip per gate. Ten pips still fit at this scale, which is why the storm round has ten.
    const gap = 2;
    const pipW = (w - 24 - gap * (d.gatesTotal - 1)) / Math.max(1, d.gatesTotal);
    for (let i = 0; i < d.gatesTotal; i += 1) {
      const filled = i < d.gatesPassed;
      ctx.fillStyle = filled ? 'rgba(120, 240, 190, 0.95)' : 'rgba(120, 160, 180, 0.3)';
      ctx.fillRect(x + 12 + i * (pipW + gap), y + 74, pipW, 10);
    }

    text('SCORE', x + 12, y + 100, 9.5, 'left', 'rgba(160, 205, 220, 0.85)', 600);
    text(String(Math.round(d.score ?? 0)), x + w - 12, y + 100, 16, 'right', 'rgba(255, 236, 176, 0.98)', 700);
  }

  /**
   * The combat strip: what is still shooting, and what the pilot has killed.
   *
   * Sits above the status bar on the right. It is deliberately separate from the flight
   * instruments, because the two answer different questions and mixing them into one block makes
   * both harder to read at a glance.
   */
  function drawCombatBlock(x, y, d, scale = 1) {
    const w = 170 * scale, h = 84 * scale;
    panel(x, y, w, h, 0.5);

    const air = d.threats ?? null;
    const alive = air ? air.turretsAlive + air.dronesAlive : 0;
    const total = air ? air.turretsTotal + air.dronesTotal : 0;

    text('THREATS', x + 12, y + 14, 9.5, 'left', 'rgba(160, 205, 220, 0.85)', 600);
    text(total ? `${alive}/${total}` : '—', x + w - 12, y + 14, 11,
      'right', alive > 0 ? 'rgba(255, 148, 108, 0.98)' : 'rgba(130, 235, 195, 0.95)', 700);

    // One pip per emplacement, red while it is alive and dark grey once it has been strafed, so
    // the pilot can count what is left without reading a number.
    if (total > 0 && total <= 14) {
      const gap = 2.5;
      const pipW = Math.min(11, (w - 24 - gap * (total - 1)) / total);
      const slots = [
        ...(air.turretSlots ?? []).map((on) => (on ? 'rgba(255, 132, 96, 0.95)' : 'rgba(120, 160, 180, 0.24)')),
        ...(air.droneSlots ?? []).map((on) => (on ? 'rgba(255, 190, 90, 0.95)' : 'rgba(120, 160, 180, 0.24)')),
      ];
      for (let i = 0; i < slots.length; i += 1) {
        ctx.fillStyle = slots[i];
        ctx.fillRect(x + 12 + i * (pipW + gap), y + 22, pipW, 7);
      }
    }

    text('KILLS', x + 12, y + 38, 9.5, 'left', 'rgba(160, 205, 220, 0.85)', 600);
    text(String(d.kills ?? 0), x + w - 12, y + 38, 13, 'right',
      (d.kills ?? 0) > 0 ? 'rgba(255, 226, 150, 1)' : 'rgba(150, 190, 210, 0.75)', 700);

    // The gun: cold while it is not being asked to fire, hot while it is, and — the part that
    // makes it a readout rather than a label — a rate bar that stutters with the actual cadence,
    // so the pilot can see the gun is cycling and not jammed.
    text('GUNS', x + 12, y + 52, 9.5, 'left', 'rgba(160, 205, 220, 0.85)', 600);
    const firing = !!d.firing;
    text(firing ? 'FIRING' : 'SAFE', x + w - 12, y + 52, 9.5, 'right',
      firing ? 'rgba(255, 224, 130, 1)' : 'rgba(150, 190, 210, 0.75)', 700);
    if (firing) {
      // A two-pixel bar under the row, lit for the fraction of the cycle the gun is actually
      // throwing rounds. It is the closest a canvas HUD gets to the mechanical feel of a trigger.
      const cycle = (d.time ?? 0) % 0.075;
      const lit = 1 - cycle / 0.075;
      ctx.fillStyle = `rgba(255, 214, 120, ${0.35 + 0.55 * lit})`;
      ctx.fillRect(x + 12, y + 58, (w - 24) * lit, 2);
    }

    // The mission requirement. This line is what tells the pilot the guns are the job rather than
    // the scenery: without it a round that needs two towers down looks identical to one that does
    // not, and the only way to find out is to land and be refused.
    if (d.objective?.required) {
      const o = d.objective;
      text('OBJECTIVE', x + 12, y + 68, 9.5, 'left', 'rgba(160, 205, 220, 0.85)', 600);
      text(o.met ? 'MET' : `${o.done}/${o.need}`, x + w - 12, y + 68, 10.5, 'right',
        o.met ? 'rgba(130, 235, 195, 0.98)' : 'rgba(255, 176, 110, 0.98)', 700);
    }

    // The rocket pod. The ring around the reticle is the seeker settling; the row here is the
    // magazine. Both are needed: a pilot who can see the lock but not the count fires the last
    // round at nothing, and one who can see the count but not the lock never fires at all.
    if (d.ordnance) {
      const o = d.ordnance;
      const label = o.empty ? 'EMPTY' : o.locked ? 'LOCKED' : o.hasTarget ? 'SEEKING' : 'SAFE';
      const colour = o.empty ? 'rgba(150, 190, 210, 0.55)'
        : o.locked ? 'rgba(255, 120, 96, 1)'
          : o.hasTarget ? 'rgba(255, 214, 120, 1)' : 'rgba(150, 190, 210, 0.75)';
      text('ROCKETS', x + 12, y + 82, 9.5, 'left', 'rgba(160, 205, 220, 0.85)', 600);
      text(label, x + w - 12, y + 82, 9.5, 'right', colour, 700);

      // One pip per round the pod was built with: live ones in the seeker's colour, spent ones
      // hollow. The total is the pod's own complement, so the row does not shrink as rounds go.
      const total = Math.max(1, Math.min(8, d.ordnance.count ?? 4));
      const pips = Math.max(0, Math.min(total, o.remaining ?? 0));
      const pipGap = 3;
      const pipW = Math.min(9, (w - 24 - pipGap * (total - 1)) / total);
      for (let i = 0; i < total; i += 1) {
        ctx.fillStyle = i < pips ? colour : 'rgba(120, 160, 180, 0.22)';
        ctx.fillRect(x + 12 + i * (pipW + pipGap), y + 88, pipW, 4);
      }
    }
  }

  /** Which way and how far to the next gate: an arrow around the compass rose. */
  function drawGateIndicator(cx, cy, d, scale = 1) {
    if (!d.gate) return;
    const r = 24 * scale;
    ctx.save();
    ctx.strokeStyle = 'rgba(150, 200, 220, 0.35)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();

    const rel = d.gate.bearing - (d.heading * Math.PI) / 180;
    const a = rel - Math.PI / 2;
    const ahead = rel > -0.25 && rel < 0.25;
    ctx.fillStyle = ahead ? 'rgba(255, 214, 90, 1)' : 'rgba(120, 240, 190, 0.95)';
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * (r - 4), cy + Math.sin(a) * (r - 4));
    ctx.lineTo(cx + Math.cos(a + 2.5) * (r * 0.46), cy + Math.sin(a + 2.5) * (r * 0.46));
    ctx.lineTo(cx + Math.cos(a - 2.5) * (r * 0.46), cy + Math.sin(a - 2.5) * (r * 0.46));
    ctx.closePath();
    ctx.fill();

    const km = d.gate.distance >= 1000
      ? `${(d.gate.distance / 1000).toFixed(2)} km`
      : `${Math.round(d.gate.distance)} m`;
    text(km, cx, cy + r + 15, 12.5, 'center', 'rgba(206, 240, 250, 0.92)', 600);
    text('NEXT GATE', cx, cy + r + 29, 8.5, 'center', 'rgba(150, 195, 215, 0.75)', 600);
    ctx.restore();
  }

  /** The round's name and objective, top left, with its progress through the campaign. */
  function drawRoundStrip(x, y, d, scale = 1) {
    const w = 244 * scale, h = 50 * scale;
    panel(x, y, w, h, 0.48);
    text(`ROUND ${(d.roundIndex ?? 0) + 1} OF ${d.roundTotal ?? 5}`, x + 12, y + 14, 8.5, 'left',
      'rgba(150, 195, 215, 0.8)', 600);
    text(d.roundName ?? 'RIDGE RUNNER', x + 12, y + 29, 13.5, 'left', 'rgba(226, 244, 252, 0.96)', 700);
    text(d.missionLine ?? '', x + 12, y + 42, 9.5, 'left', 'rgba(160, 205, 225, 0.82)', 500);

    // A small campaign progress bar: one notch per round, filled as they are scored.
    const notchW = 9, gap = 3;
    const totalW = notchW * (d.roundTotal ?? 5) + gap * ((d.roundTotal ?? 5) - 1);
    for (let i = 0; i < (d.roundTotal ?? 5); i += 1) {
      const bx = x + w - 12 - totalW + i * (notchW + gap);
      const state = i < (d.roundIndex ?? 0) ? 'done' : i === (d.roundIndex ?? 0) ? 'now' : 'locked';
      ctx.fillStyle = state === 'done' ? 'rgba(120, 240, 190, 0.9)'
        : state === 'now' ? 'rgba(255, 214, 90, 0.95)' : 'rgba(120, 160, 180, 0.28)';
      ctx.fillRect(bx, y + 10, notchW, 6);
    }
  }

  /** A one-line combat readout for the cockpit view, under the status block. */
  function drawCompactCombat(x, y, d, scale = 1) {
    const w = 140 * scale, h = 48 * scale;
    panel(x, y, w, h, 0.52);
    const air = d.threats ?? null;
    const alive = air ? air.turretsAlive + air.dronesAlive : 0;
    text('THREAT', x + 10, y + 12, 8.5, 'left', 'rgba(160, 205, 220, 0.85)', 600);
    text(air && (air.turretsTotal + air.dronesTotal) > 0 ? String(alive) : '—', x + w - 10, y + 12, 11,
      'right', alive > 0 ? 'rgba(255, 148, 108, 0.98)' : 'rgba(130, 235, 195, 0.95)', 700);
    text('KILLS', x + 10, y + 25, 8.5, 'left', 'rgba(160, 205, 220, 0.85)', 600);
    text(String(d.kills ?? 0), x + w - 10, y + 25, 10, 'right',
      (d.kills ?? 0) > 0 ? 'rgba(255, 226, 150, 1)' : 'rgba(150, 190, 210, 0.75)', 700);
    // The cockpit block is the chase block compressed, so the objective line rides along: the
    // requirement must not vanish just because the pilot changed camera.
    if (d.objective?.required) {
      const o = d.objective;
      text('OBJ', x + 10, y + 39, 8.5, 'left', 'rgba(160, 205, 220, 0.85)', 600);
      text(o.met ? 'MET' : `${o.done}/${o.need}`, x + w - 10, y + 39, 9.5,
        'right', o.met ? 'rgba(130, 235, 195, 0.98)' : 'rgba(255, 176, 110, 0.98)', 700);
    }
  }

  /**
   * The threat warning: a chevron at the edge of the view pointing at the nearest live gun, plus
   * its range. Without it a flak site behind the aircraft is invisible until it opens fire, which
   * is a death the pilot cannot learn from.
   */
  function drawThreatWarning(cx, cy, d, scale = 1) {
    const air = d.threats;
    if (!air || !air.nearest) return;
    const near = air.nearest;
    // Only warn inside the range where it can actually hurt, not for every gun on the map.
    if (near.distance > 1500) return;
    const hot = near.distance < 900;
    // The bearing is relative to north, so the aircraft's own heading has to come out of it before
    // it means anything on a screen that is always drawn nose-up.
    const rel = (d.threatBearing ?? 0) - (d.heading * Math.PI) / 180;
    const a = rel - Math.PI / 2;
    const r = Math.min(width, height) * 0.34;
    const px = cx + Math.cos(a) * r;
    const py = cy + Math.sin(a) * r * 0.72;

    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(a + Math.PI / 2);
    ctx.fillStyle = hot ? 'rgba(255, 88, 64, 0.92)' : 'rgba(255, 168, 90, 0.8)';
    ctx.beginPath();
    ctx.moveTo(0, 9);
    ctx.lineTo(-7, -5);
    ctx.lineTo(0, -1);
    ctx.lineTo(7, -5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    text(near.kind === 'drone' ? 'INTERCEPTOR' : 'FLAK', px, py + 20, 8.5, 'center',
      hot ? 'rgba(255, 130, 100, 0.95)' : 'rgba(255, 190, 140, 0.85)', 700);
    text(`${(near.distance / 1000).toFixed(1)} km`, px, py + 31, 9, 'center',
      'rgba(255, 210, 170, 0.8)', 600);
  }

  /**
   * A bracket on the flight leader, when it is on screen.
   *
   * The livery says "this one is different" only once the pilot is close enough to read the shape.
   * A bracket says it from a kilometre out, which is the range at which the choice — press the
   * leader or clear the wingmen first — is actually made. Drawn in the world's perspective rather
   * than as a fixed reticle, so it tracks the machine it belongs to.
   */
  function drawAceBracket(d) {
    const ace = d.aceMark;
    if (!ace || !ace.onScreen) return;
    const x = ace.x;
    const y = ace.y;
    // The bracket's size follows the range: a distant leader gets a small mark, a close one a
    // large one, so the cue does not read as a fixed piece of the cockpit.
    const s = Math.max(9, Math.min(34, ace.scale));
    const arm = s * 0.45;
    const hot = ace.distance < 700;

    ctx.save();
    ctx.strokeStyle = hot ? 'rgba(255, 92, 60, 0.96)' : 'rgba(255, 148, 90, 0.9)';
    ctx.lineWidth = 1.6;
    // Four corner brackets, not a closed box: a closed box reads as a target the game has already
    // selected, and this is a warning, not a lock.
    for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      ctx.beginPath();
      ctx.moveTo(x + dx * s, y + dy * s - dy * arm);
      ctx.lineTo(x + dx * s, y + dy * s);
      ctx.lineTo(x + dx * s - dx * arm, y + dy * s);
      ctx.stroke();
    }
    ctx.restore();

    text('LEADER', x, y - s - 8, 8.5, 'center', hot ? 'rgba(255, 120, 88, 0.98)' : 'rgba(255, 176, 128, 0.9)', 700);
    text(`${(ace.distance / 1000).toFixed(1)} km`, x, y + s + 14, 8.5, 'center', 'rgba(255, 200, 160, 0.78)', 600);
  }

  /**
   * A red rim when the airframe is being hit, and a permanent thin one when it is badly damaged.
   * The vignette is the only feedback for damage that does not require reading a number.
   */
  function drawDamageVignette(d) {
    const flash = Math.max(0, Math.min(1, d.hitFlash ?? 0));
    const hurt = Math.max(0, Math.min(1, 1 - (d.health ?? 1) / 0.45));
    const strength = Math.max(flash, hurt * 0.5);
    if (strength <= 0.01) return;

    const g = ctx.createRadialGradient(
      width / 2, height / 2, Math.min(width, height) * 0.28,
      width / 2, height / 2, Math.max(width, height) * 0.72,
    );
    g.addColorStop(0, 'rgba(190, 30, 20, 0)');
    g.addColorStop(0.62, `rgba(190, 34, 22, ${0.16 * strength})`);
    g.addColorStop(1, `rgba(150, 18, 10, ${0.72 * strength})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, width, height);
  }

  /** The fixed reticle at the view's centre. */
  function drawCrosshair(cx, cy, d = null) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 232, 150, 0.5)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(cx, cy, 5, 0, Math.PI * 2);
    ctx.moveTo(cx - 16, cy); ctx.lineTo(cx - 8, cy);
    ctx.moveTo(cx + 8, cy); ctx.lineTo(cx + 16, cy);
    ctx.stroke();

    // The seeker's ring. A sweep that fills as the cone is held, then snaps solid when the solution
    // is there. Without this the pod is a key that sometimes works: the pilot has no way to know the
    // nose is nearly on the target, and the launch either fires or does not.
    //
    // The base circle is drawn whenever the pod has rounds, so the reticle reads as a weapon sight
    // rather than three ticks — a ring that only appears late is a ring the pilot never learns.
    const o = d?.ordnance;
    if (o && !o.empty) {
      const r = 26;
      const start = -Math.PI / 2;
      const progress = Math.max(0, Math.min(1, o.progress ?? 0));

      ctx.lineWidth = 1.1;
      ctx.strokeStyle = 'rgba(150, 200, 220, 0.28)';
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();

      if (o.locked || o.hasTarget) {
        // Solid and thick once solved, a filling arc while the seeker settles.
        const sweep = o.locked ? Math.PI * 2 : Math.PI * 2 * progress;
        ctx.lineWidth = o.locked ? 3.2 : 2.2;
        ctx.strokeStyle = o.locked ? 'rgba(255, 84, 58, 0.98)' : 'rgba(255, 198, 92, 0.92)';
        if (o.locked) {
          // A locked ring gets a soft halo so it reads at a glance in a turn.
          ctx.shadowColor = 'rgba(255, 80, 50, 0.95)';
          ctx.shadowBlur = 10;
        }
        ctx.beginPath();
        ctx.arc(cx, cy, r, start, start + sweep);
        ctx.stroke();
        ctx.shadowBlur = 0;

        // Four tick marks at the cardinal points, so a locked ring reads as a sight and not as a
        // gate hoop that happens to be nearby.
        if (o.locked) {
          ctx.lineWidth = 2.4;
          ctx.strokeStyle = 'rgba(255, 84, 58, 0.98)';
          for (let k = 0; k < 4; k += 1) {
            const a = start + (k * Math.PI) / 2;
            const ix = cx + Math.cos(a) * (r - 5);
            const iy = cy + Math.sin(a) * (r - 5);
            const ox = cx + Math.cos(a) * (r + 6);
            const oy = cy + Math.sin(a) * (r + 6);
            ctx.beginPath();
            ctx.moveTo(ix, iy);
            ctx.lineTo(ox, oy);
            ctx.stroke();
          }
        }

        // The word, under the ring, plus the range once solved. The colour matches the arc so the
        // readout and the shape say the same thing at the same instant.
        ctx.textAlign = 'center';
        ctx.font = '700 10px ui-monospace, Menlo, Consolas, monospace';
        if (o.locked) {
          ctx.fillStyle = 'rgba(255, 120, 96, 0.98)';
          ctx.fillText('LOCK', cx, cy + r + 14);
          ctx.font = '600 9px ui-monospace, Menlo, Consolas, monospace';
          ctx.fillStyle = 'rgba(255, 160, 140, 0.92)';
          ctx.fillText(`${(o.range ?? 0).toFixed(0)} m`, cx, cy + r + 26);
        } else if (o.hasTarget) {
          ctx.fillStyle = 'rgba(255, 205, 110, 0.9)';
          ctx.fillText(`${Math.round(progress * 100)}%`, cx, cy + r + 14);
        }
      }
    }
    ctx.restore();
  }

  /**
   * The hit marker: four ticks around the reticle that snap outward on impact, plus a floating
   * damage number above it.
   *
   * The guns fire two rounds at a time at 13 rounds a second, so a burst can put a dozen hits into
   * a turret before it falls. Without this the only evidence a burst is working is the target
   * eventually exploding, which arrives too late to correct the aim that missed. The marker is
   * timed off the impact rather than held for a frame, so a fast burst reads as a strobe and a
   * single round reads as one clear tick.
   */
  function drawHitMarker(cx, cy, d, scale = 1) {
    const mark = d.hitMark;
    if (!mark) return;
    const age = (d.time ?? 0) - mark.at;
    // A kill stays up a little longer than a plain hit, because the last round of a burst is the
    // one worth seeing.
    const life = mark.killed ? 0.55 : 0.22;
    if (age < 0 || age > life) return;
    const k = Math.min(1, age / life);

    // The ticks start on the reticle and fly out, fading as they go.
    const r0 = 6 + k * 9;
    const r1 = r0 + 7 * (1 - k * 0.45);
    const alpha = (1 - k) * (mark.killed ? 1 : 0.9);
    ctx.save();
    ctx.strokeStyle = mark.killed
      ? `rgba(255, 130, 70, ${alpha})`
      : `rgba(255, 246, 210, ${alpha})`;
    ctx.lineWidth = mark.killed ? 2.4 : 1.8;
    for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      ctx.beginPath();
      ctx.moveTo(cx + dx * r0 * 0.72, cy + dy * r0 * 0.72);
      ctx.lineTo(cx + dx * r1 * 0.72, cy + dy * r1 * 0.72);
      ctx.stroke();
    }
    ctx.restore();

    // The number rises and fades. Damage per round is small, so it is shown as a running figure
    // only when it matters — on the round that killed — and as a bare tick otherwise.
    if (mark.killed) {
      const rise = 18 + k * 22;
      const label = mark.ace ? 'LEADER DOWN' : mark.kind === 'turret' ? 'GUN DOWN' : 'DOWN';
      text(label, cx, cy - rise, 12 * scale, 'center',
        `rgba(255, 176, 110, ${(1 - k) * 0.98})`, 700);
    } else {
      const rise = 12 + k * 16;
      text(`-${mark.damage}`, cx + 14, cy - rise, 10 * scale, 'left',
        `rgba(255, 244, 206, ${(1 - k) * 0.85})`, 600);
    }
  }

  function bar(x, y, w, h, value, colour) {
    ctx.fillStyle = 'rgba(120, 160, 180, 0.25)';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = colour;
    ctx.fillRect(x, y, w * Math.max(0, Math.min(1, value)), h);
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  return { draw, resize, clear, width: () => width, height: () => height };
}

/** The stall speed in knots, given the flap setting, for the tape's red band. */
function stallKnots(flaps = 0) {
  const stall = 27 * (1 - 0.11 * flaps);
  return stall / 0.514444;
}

/** The 16-point compass label for a meteorological bearing. */
function compassPoint(from) {
  const names = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
    'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return names[Math.round((((from % 360) + 360) % 360) / 22.5) % 16];
}
