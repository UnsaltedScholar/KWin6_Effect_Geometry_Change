"use strict";

class GeometryChangeEffect {
  constructor() {
    effect.configChanged.connect(this.loadConfig.bind(this));
    effect.animationEnded.connect(this.onAnimationEnded.bind(this));

    const manage = this.manage.bind(this);
    effects.windowAdded.connect(manage);
    effects.stackingOrder.forEach(manage);

    this.loadConfig();
  }

  loadConfig() {
    this.duration = animationTime(effect.readConfig("Duration", 200));

    this.skewFactor = parseFloat(effect.readConfig("SkewFactor", 0.05));

    this.scaleInfluence = parseFloat(effect.readConfig("ScaleInfluence", 0.25));
  }

  manage(window) {
    window.geometryChangeData = {
      animationIds: {},
      grabbed: false,
    };

    window.windowFrameGeometryChanged.connect(
      this.onWindowFrameGeometryChanged.bind(this)
    );
  }

  cancelAnimations(window) {
    const g = window.geometryChangeData;
    if (!g) return;

    const ids = Object.keys(g.animationIds).map(Number);
    if (ids.length > 0) {
      try { cancel(ids); } catch (e) { }
    }

    g.animationIds = {};

    if (g.grabbed) {
      try { effect.ungrab(window, Effect.WindowAddedGrabRole); } catch (e) { }
      g.grabbed = false;
    }
  }

  onAnimationEnded(window, id) {
    if (!window || !window.geometryChangeData) return;

    const g = window.geometryChangeData;
    delete g.animationIds[String(id)];

    if (Object.keys(g.animationIds).length === 0) {
      if (g.grabbed) {
        try { effect.ungrab(window, Effect.WindowAddedGrabRole); } catch (e) { }
        g.grabbed = false;
      }

      try { window.setData(Effect.WindowForceBlurRole, null); } catch (e) { }
    }
  }

  onWindowFrameGeometryChanged(window, oldGeometry) {
    if (!window || !window.visible || window.minimized) return;

    const g = window.geometryChangeData;
    if (!g) return;

    const geom = window.geometry;

    const dx = geom.x - oldGeometry.x;
    const dy = geom.y - oldGeometry.y;
    const dw = geom.width - oldGeometry.width;
    const dh = geom.height - oldGeometry.height;

    if (dx === 0 && dy === 0 && dw === 0 && dh === 0) return;

    // Clean previous animations
    this.cancelAnimations(window);

    // Grab window (prevents compositor conflicts)
    try {
      g.grabbed = effect.grab(window, Effect.WindowAddedGrabRole);
    } catch (e) {
      g.grabbed = false;
    }

    let fromTx = -dx - dw / 2;
    let fromTy = -dy - dh / 2;

    const moveThreshold = 2;

    if (Math.abs(dx) < moveThreshold && Math.abs(dy) < moveThreshold) {
      // small directional kick based on resize
      const kickX = Math.sign(dw) * Math.min(Math.abs(dw) * 0.15, 30);
      const kickY = Math.sign(dh) * Math.min(Math.abs(dh) * 0.15, 30);

      fromTx += kickX;
      fromTy += kickY;
    }

    const widthRatio = oldGeometry.width / geom.width;
    const heightRatio = oldGeometry.height / geom.height;

    const biasX = dx !== 0 ? Math.sign(dx) * this.skewFactor : 0;
    const biasY = dy !== 0 ? Math.sign(dy) * this.skewFactor : 0;
    
    const normScaleX = dw / Math.max(oldGeometry.width, 1);
    const normScaleY = dh / Math.max(oldGeometry.height, 1);

    const scaleWobbleX = normScaleX * this.scaleInfluence * 0.2;
    const scaleWobbleY = normScaleY * this.scaleInfluence * 0.2;

    function clamp(v) {
      return Math.max(0.85, Math.min(1.15, v));
    }

    const scaleFromX = clamp(
      widthRatio * (1 + biasX * 0.1 + scaleWobbleX)
    );

    const scaleFromY = clamp(
      heightRatio * (1 + biasY * 0.1 + scaleWobbleY)
    );

    const result = animate({
      window: window,
      duration: this.duration,
      curve: QEasingCurve.OutBack, 
      animations: [
        {
          type: Effect.Translation,
          from: { value1: fromTx, value2: fromTy },
          to: { value1: 0, value2: 0 },
        },
        {
          type: Effect.Scale,
          from: { value1: scaleFromX, value2: scaleFromY },
          to: { value1: 1, value2: 1 },
        },
      ],
    });

    let ids = [];
    if (Array.isArray(result)) ids = result;
    else if (result !== null && result !== undefined) ids = [result];

    for (const id of ids) {
      g.animationIds[String(id)] = true;
    }

    if (ids.length > 0) {
      window.setData(Effect.WindowForceBlurRole, true);
    }
  }
}

new GeometryChangeEffect();
