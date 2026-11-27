// The input layer: the keyboard and the mouse, read as the pilot's axes. The arrow keys stand in
// for the mouse, so the game is playable with either hand, and the pointer is captured so dragging
// the mouse turns the aircraft without the cursor leaving the window.
//
// Flaps are a selection rather than an axis, so they are read as a notch count that the game holds
// between presses: F takes a notch out, V puts one back.

export function createInput(canvas) {
  const keys = new Set();
  const state = {
    mouseDX: 0,
    mouseDY: 0,
    pointerLocked: false,
    /** Set by the game when it wants the mouse turned into control input. */
    capturing: false,
    clicked: false,
    /** The flap selection, in notches: 0 up, 2 full. */
    flaps: 0,
  };

  const onKeyDown = (e) => {
    // Space and the arrows would scroll the page and Tab would move focus out of the canvas; the
    // game owns all of them while it has focus. Tab is the afterburner, so it cannot be allowed to
    // walk the focus ring or the pilot loses the controls mid-pass.
    if ([' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.key)) e.preventDefault();
    // The flap keys are one-shot, handled here so a held key does not run away.
    if (!e.repeat) {
      if (e.code === 'KeyF') state.flaps = Math.min(2, state.flaps + 1);
      if (e.code === 'KeyV') state.flaps = Math.max(0, state.flaps - 1);
      if (e.code === 'KeyG') state.flaps = 0;
    }
    keys.add(e.code);
  };
  const onKeyUp = (e) => keys.delete(e.code);
  const onBlur = () => keys.clear();

  const onMouseMove = (e) => {
    if (!state.capturing) return;
    state.mouseDX += e.movementX || 0;
    state.mouseDY += e.movementY || 0;
  };

  const onClick = () => {
    state.clicked = true;
    if (!state.capturing) return;
    if (canvas.requestPointerLock && !document.pointerLockElement) {
      const p = canvas.requestPointerLock();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
  };

  const onPointerLockChange = () => {
    state.pointerLocked = document.pointerLockElement === canvas;
  };

  window.addEventListener('keydown', onKeyDown, { passive: false });
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  window.addEventListener('mousemove', onMouseMove);
  document.addEventListener('pointerlockchange', onPointerLockChange);
  canvas.addEventListener('click', onClick);

  /** Reads the current axes and clears the mouse's accumulated delta. */
  function read(controls) {
    const pitchUp = keys.has('KeyS') || keys.has('ArrowDown') || keys.has('KeyI');
    const pitchDown = keys.has('KeyW') || keys.has('ArrowUp') || keys.has('KeyK');
    const rollLeft = keys.has('KeyA') || keys.has('ArrowLeft') || keys.has('KeyJ');
    const rollRight = keys.has('KeyD') || keys.has('ArrowRight') || keys.has('KeyL');
    const yawLeft = keys.has('KeyQ');
    const yawRight = keys.has('KeyE');

    controls.pitch = (pitchDown ? -1 : 0) + (pitchUp ? 1 : 0);
    controls.roll = (rollRight ? 1 : 0) + (rollLeft ? -1 : 0);
    controls.yaw = (yawRight ? 1 : 0) + (yawLeft ? -1 : 0);
    controls.brake = keys.has('Space');
    controls.flaps = state.flaps;

    controls.throttle = 0;
    if (keys.has('ShiftLeft') || keys.has('ShiftRight')) controls.throttle += 1;
    if (keys.has('ControlLeft') || keys.has('ControlRight')) controls.throttle -= 1;

    // Afterburner on Tab (and on B, which some layouts reach more easily). Held, not toggled: the
    // charge is short enough that holding it down for a corner is exactly the wrong move, and a
    // toggle would let the pilot forget it is lit.
    controls.boost = keys.has('Tab') || keys.has('KeyB');
    // The gun fires from a held trigger; the rate limit lives in the weapon, not here. X is the
    // primary and Z is the backup, because on some layouts X sits under the same finger as the
    // throttle and cannot be held comfortably.
    controls.fire = keys.has('KeyX') || keys.has('KeyZ');

    controls.mouseDeltaX = state.mouseDX;
    controls.mouseDeltaY = state.mouseDY;
    // The mouse's travel is spent: the next step starts from zero again.
    state.mouseDX = 0;
    state.mouseDY = 0;

    return controls;
  }

  /** One-shot press checks for the keys that are actions rather than axes. */
  function consumePressed(code) {
    if (keys.has(code)) {
      keys.delete(code);
      return true;
    }
    return false;
  }

  return {
    read,
    consumePressed,
    keys,
    state,
    /** Sets or clears key codes directly. Only tests and the screenshot harness use this. */
    setKeys(codes, down = true) {
      for (const code of codes) {
        if (down) keys.add(code);
        else keys.delete(code);
      }
    },
    setCapturing(on) { state.capturing = on; },
    setFlaps(n) { state.flaps = Math.max(0, Math.min(2, n)); },
    getFlaps: () => state.flaps,
    consumeClick() {
      const was = state.clicked;
      state.clicked = false;
      return was;
    },
    dispose() {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('pointerlockchange', onPointerLockChange);
      canvas.removeEventListener('click', onClick);
    },
  };
}

/** What the keys do, for the title card and the pause overlay. */
export const KEY_HELP = [
  ['W / S', 'nose down / up'],
  ['A / D', 'roll left / right'],
  ['Q / E', 'rudder left / right'],
  ['Shift / Ctrl', 'throttle up / down'],
  ['Tab', 'afterburner'],
  ['X', 'guns'],
  ['T', 'autopilot: hold / course / approach'],
  ['F / V', 'flaps out / in'],
  ['G', 'flaps up'],
  ['Space', 'wheel brakes'],
  ['Mouse', 'steer (click to capture)'],
  ['C', 'chase / cockpit view'],
  ['R', 'restart the round'],
  ['P', 'pause'],
];
