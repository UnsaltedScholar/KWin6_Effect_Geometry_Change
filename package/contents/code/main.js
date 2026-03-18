"use strict";

class GeometryChangeEffect {
  constructor() {
    effect.configChanged.connect(this.loadConfig.bind(this));
    effect.animationEnded.connect(this._onAnimationEnded.bind(this));

    const manageFn = this.manage.bind(this);
    effects.windowAdded.connect(manageFn);
    effects.stackingOrder.forEach(manageFn);

    effects.windowDeleted.connect((w) => {
      if (w && w.geometryChangeData) {
        if (w.geometryChangeData.grabbedByGeometryChange) {
          try { effect.ungrab(w, Effect.WindowAddedGrabRole); } catch (e) { /* ignore */ }
        }
        w.geometryChangeData = null;
      }
    });

    this.userResizing = false;
    this.loadConfig();
  }

  loadConfig() {
    const duration = effect.readConfig("Duration", 250);
    this.duration = animationTime(duration);

    // wobble tuning (tweak these if you want stronger/weaker wobble)
    this.wobbleEnabled = true;
    this.wobbleDuration = animationTime(effect.readConfig("WobbleDuration", 550)); // ms
    this.wobbleMoveFactor = parseFloat(effect.readConfig("WobbleMoveFactor", 0.12)); // fraction of move
    this.wobbleSizeFactor = parseFloat(effect.readConfig("WobbleSizeFactor", 0.02)); // relative scale change

    this.excludedWindowClasses = effect.readConfig("ExcludedWindowClasses", "krunner,yakuake")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);
  }

  manage(window) {
    window.geometryChangeData = {
      createdTime: Date.now(),
      animationIds: {},
      mainAnimationIds: {}, // ids for the initial translation+scale
      maximizedStateAboutToChange: false,
      grabbedByGeometryChange: false,
      lastDelta: { x: 0, y: 0, w: 0, h: 0 },
      wobbleStartedForChange: false,
    };

    window.windowFrameGeometryChanged.connect(this.onWindowFrameGeometryChanged.bind(this));
    window.windowMaximizedStateAboutToChange.connect(this.onWindowMaximizedStateAboutToChange.bind(this));
    window.windowStartUserMovedResized.connect(this.onWindowStartUserMovedResized.bind(this));
    window.windowFinishUserMovedResized.connect(this.onWindowFinishUserMovedResized.bind(this));
  }

  _onAnimationEnded(window, animationId) {
    if (!window || !window.geometryChangeData) return;
    const g = window.geometryChangeData;
    if (!g.animationIds) return;

    const key = String(animationId);
    // remove from global set
    if (g.animationIds[key]) {
      delete g.animationIds[key];
    }

    // if it was one of the main animations, remove from that set too
    if (g.mainAnimationIds && g.mainAnimationIds[key]) {
      delete g.mainAnimationIds[key];
    }

    // If all main animations finished and we haven't yet started the wobble for this geometry change, start it
    if (this.wobbleEnabled &&
        g.mainAnimationIds &&
        Object.keys(g.mainAnimationIds).length === 0 &&
        !g.wobbleStartedForChange) {
      // start wobble only if there was a meaningful delta
      const d = g.lastDelta;
      const moved = (Math.abs(d.x) > 0 || Math.abs(d.y) > 0 || Math.abs(d.w) > 0 || Math.abs(d.h) > 0);
      if (moved && window.managed && window.visible && window.onCurrentDesktop && !window.minimized) {
        this._startWobble(window, d);
        g.wobbleStartedForChange = true;
      }
    }

    // when our set is empty, restore blur role and ungrab
    if (Object.keys(g.animationIds).length === 0) {
      g.animationIds = {};
      g.mainAnimationIds = {};
      g.wobbleStartedForChange = false;
      window.setData(Effect.WindowForceBlurRole, null);

      if (g.grabbedByGeometryChange) {
        try {
          effect.ungrab(window, Effect.WindowAddedGrabRole);
        } catch (e) { /* ignore */ }
        g.grabbedByGeometryChange = false;
      }
    }
  }

  // helper: start a short elastic translation+scale that decays (imitates wobble)
  _startWobble(window, delta) {
    if (!window || !window.geometryChangeData) return;

    // small amplitude proportional to movement + slight contribution from resize
    const ampX = delta.x * this.wobbleMoveFactor + delta.w * (this.wobbleMoveFactor * 0.4);
    const ampY = delta.y * this.wobbleMoveFactor + delta.h * (this.wobbleMoveFactor * 0.4);

    // if amplitude is tiny, skip
    if (Math.abs(ampX) < 1 && Math.abs(ampY) < 1) return;

    // small scale bounce (slight overshoot)
    const fromScaleX = 1 + (Math.abs(delta.w) / Math.max(window.width, 1)) * this.wobbleSizeFactor;
    const fromScaleY = 1 + (Math.abs(delta.h) / Math.max(window.height, 1)) * this.wobbleSizeFactor;

    const animations = [
      {
        type: Effect.Translation,
        from: { value1: ampX, value2: ampY },
        to: { value1: 0, value2: 0 },
      },
      {
        type: Effect.Scale,
        from: { value1: fromScaleX, value2: fromScaleY },
        to: { value1: 1, value2: 1 },
      },
    ];

    const result = animate({
      window: window,
      duration: this.wobbleDuration,
      curve: QEasingCurve.OutElastic,
      animations: animations,
    });

    let ids = [];
    if (Array.isArray(result)) {
      ids = result;
    } else if (result !== undefined && result !== null) {
      ids = [result];
    }

    for (let i = 0; i < ids.length; ++i) {
      const idKey = String(ids[i]);
      window.geometryChangeData.animationIds[idKey] = true;
      // wobble ids are not mainAnimationIds; they are just normal animationIds so ungrab waits for them
    }

    if (ids.length > 0) {
      window.setData(Effect.WindowForceBlurRole, true);
    }
  }

  isWindowClassExluded(windowClass) {
    if (!windowClass) return false;
    return windowClass.split(" ").some(part => this.excludedWindowClasses.includes(part));
  }

  onWindowFrameGeometryChanged(window, oldGeometry) {
    if (!window || !window.geometryChangeData) return;

    const windowTypeSupportsAnimation = window.normalWindow || window.dialog || window.modal;
    const isUserMoveResize = window.move || window.resize || this.userResizing;
    const maximizationChange = window.geometryChangeData.maximizedStateAboutToChange;
    window.geometryChangeData.maximizedStateAboutToChange = false;

    if (
      !window.managed ||
      !window.visible ||
      !window.onCurrentDesktop ||
      window.minimized ||
      !windowTypeSupportsAnimation ||
      (isUserMoveResize && !maximizationChange) ||
      this.isWindowClassExluded(window.windowClass)
    ) {
      return;
    }

    const now = Date.now();
    const windowAgeMs = now - window.geometryChangeData.createdTime;
    if (windowAgeMs < 0) {
      window.geometryChangeData.createdTime = now;
    } else if (windowAgeMs < 10) {
      return;
    }

    const newGeometry = window.geometry;
    const xDelta = newGeometry.x - oldGeometry.x;
    const yDelta = newGeometry.y - oldGeometry.y;
    const widthDelta = newGeometry.width - oldGeometry.width;
    const heightDelta = newGeometry.height - oldGeometry.height;

    if (xDelta === 0 && yDelta === 0 && widthDelta === 0 && heightDelta === 0) {
      return;
    }

    // store delta for later wobble
    window.geometryChangeData.lastDelta = { x: xDelta, y: yDelta, w: widthDelta, h: heightDelta };
    window.geometryChangeData.wobbleStartedForChange = false;

    const prevIds = Object.keys(window.geometryChangeData.animationIds || {}).map(id => {
      const n = Number(id);
      return Number.isFinite(n) ? n : id;
    });

    if (prevIds.length > 0) {
      try {
        cancel(prevIds);
      } catch (e) {
        print("GeometryChangeEffect: cancel() threw:", e);
      }
      if (window.geometryChangeData.grabbedByGeometryChange) {
        try { effect.ungrab(window, Effect.WindowAddedGrabRole); } catch (e) { /* ignore */ }
        window.geometryChangeData.grabbedByGeometryChange = false;
      }
      window.geometryChangeData.animationIds = {};
      window.geometryChangeData.mainAnimationIds = {};
    }

    const widthRatio = oldGeometry.width / newGeometry.width;
    const heightRatio = oldGeometry.height / newGeometry.height;

    const animations = [
      {
        type: Effect.Translation,
        from: {
          value1: -xDelta - widthDelta / 2,
          value2: -yDelta - heightDelta / 2,
        },
        to: {
          value1: 0,
          value2: 0,
        },
      },
      {
        type: Effect.Scale,
        from: {
          value1: widthRatio,
          value2: heightRatio,
        },
        to: {
          value1: 1,
          value2: 1,
        },
      },
    ];

    // Try to grab cooperatively so other effects can detect "I'm animating this window".
    try {
      const grabbed = effect.grab(window, Effect.WindowAddedGrabRole);
      if (grabbed) {
        window.geometryChangeData.grabbedByGeometryChange = true;
      } else {
        window.geometryChangeData.grabbedByGeometryChange = false;
      }
    } catch (e) {
      window.geometryChangeData.grabbedByGeometryChange = false;
    }

    const result = animate({
      window: window,
      duration: this.duration,
      curve: QEasingCurve.OutExpo,
      animations: animations,
    });

    let ids = [];
    if (Array.isArray(result)) {
      ids = result;
    } else if (result !== undefined && result !== null) {
      ids = [result];
    }

    // mark these as main animation ids (we'll start wobble when these all finish)
    for (let i = 0; i < ids.length; ++i) {
      const idKey = String(ids[i]);
      window.geometryChangeData.animationIds[idKey] = true;
      window.geometryChangeData.mainAnimationIds[idKey] = true;
    }
    if (ids.length > 0) {
      window.setData(Effect.WindowForceBlurRole, true);
    } else {
      // if animation couldn't start, ungrab immediately
      if (window.geometryChangeData.grabbedByGeometryChange) {
        try { effect.ungrab(window, Effect.WindowAddedGrabRole); } catch (e) { /* ignore */ }
        window.geometryChangeData.grabbedByGeometryChange = false;
      }
    }
  }

  onWindowMaximizedStateAboutToChange(window, horizontal, vertical) {
    if (!window || !window.geometryChangeData) return;
    window.geometryChangeData.maximizedStateAboutToChange = true;
  }

  onWindowStartUserMovedResized(window) {
    this.userResizing = true;
  }

  onWindowFinishUserMovedResized(window) {
    this.userResizing = false;
  }
}

new GeometryChangeEffect();
