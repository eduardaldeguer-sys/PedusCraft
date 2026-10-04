// Input system: keyboard/mouse state with pressed/held/released tracking, pointer lock, wheel, visibility.
export class Input {
  constructor(canvasEl) {
    this.keys = new Map();       // code -> 'held'
    this.justPressed = new Set();
    this.justReleased = new Set();
    this.mouseDX = 0; this.mouseDY = 0;
    this.mouseButtons = [false, false, false];
    this.mouseJustDown = [false, false, false];
    this.mouseJustUp = [false, false, false];
    this.wheelDelta = 0;
    this.pointerLocked = false;
    this.canvas = canvasEl;

    this._blockedKeys = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab']);

    window.addEventListener('keydown', (e) => {
      if (this._blockedKeys.has(e.code)) e.preventDefault();
      if (e.repeat) return;
      if (!this.keys.has(e.code)) { this.keys.set(e.code, true); this.justPressed.add(e.code); }
    });
    window.addEventListener('keyup', (e) => {
      if (this.keys.has(e.code)) { this.keys.delete(e.code); this.justReleased.add(e.code); }
    });
    window.addEventListener('blur', () => { keysClear(this); });

    canvasEl.addEventListener('mousedown', (e) => {
      if (!this.pointerLocked && e.button === 0) { this.requestLock(); return; }
      if (!this.mouseButtons[e.button]) { this.mouseButtons[e.button] = true; this.mouseJustDown[e.button] = true; }
    });
    window.addEventListener('mouseup', (e) => {
      if (this.mouseButtons[e.button]) { this.mouseButtons[e.button] = false; this.mouseJustUp[e.button] = true; }
    });
    document.addEventListener('mousemove', (e) => {
      if (this.pointerLocked) { this.mouseDX += e.movementX; this.mouseDY += e.movementY; }
    });
    canvasEl.addEventListener('wheel', (e) => {
      if (this.pointerLocked) { e.preventDefault(); this.wheelDelta += Math.sign(e.deltaY); }
    }, { passive: false });
    canvasEl.addEventListener('contextmenu', (e) => e.preventDefault());

    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === canvasEl;
      if (!this.pointerLocked) keysClear(this);
      if (this.onLockChange) this.onLockChange(this.pointerLocked);
    });

    // Gamepad polling snapshot
    this.gamepad = { axes: [0,0,0,0], buttons: [] };
  }

  requestLock() { this.canvas.requestPointerLock && this.canvas.requestPointerLock(); }
  exitLock() { document.exitPointerLock && document.exitPointerLock(); }

  isDown(code) { return this.keys.has(code); }
  wasPressed(code) { return this.justPressed.has(code); }
  wasReleased(code) { return this.justReleased.has(code); }

  endFrame() {
    this.justPressed.clear();
    this.justReleased.clear();
    this.mouseDX = 0; this.mouseDY = 0;
    this.mouseJustDown = [false, false, false];
    this.mouseJustUp = [false, false, false];
    this.wheelDelta = 0;
  }

  pollGamepad() {
    const gps = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const gp of gps) {
      if (!gp) continue;
      this.gamepad.axes = Array.from(gp.axes);
      this.gamepad.buttons = gp.buttons.map(b => b.pressed);
      return true;
    }
    return false;
  }
}

function keysClear(input) {
  input.keys.clear();
  input.mouseButtons = [false, false, false];
}
