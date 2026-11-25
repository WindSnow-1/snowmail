/* SnowMail 21st.dev + ReactBits Shared UI Utilities:
   Always-Moving Sculpted Cobalt Silk Ribbons, Synced Mode 1 Glass Opacity,
   Specular Rim Tracking, Zero-Shift Elastic Slider, Sender Monograms & Health Pill */
(function () {
  const OPACITY_KEY = 'snowmail_glass_opacity';
  const DEFAULT_OPACITY = 42;
  const opacityListeners = new Set();
  let currentOpacity = readStoredOpacity();
  let syncChannel = null;

  try {
    if (typeof BroadcastChannel !== 'undefined') {
      syncChannel = new BroadcastChannel('snowmail_glass_sync');
      syncChannel.onmessage = function (ev) {
        if (ev && typeof ev.data === 'number') {
          setGlassOpacity(ev.data, { save: false, broadcast: false });
        }
      };
    }
  } catch {
    syncChannel = null;
  }

  function clampOpacity(val) {
    const n = Number(val);
    if (!Number.isFinite(n)) return DEFAULT_OPACITY;
    return Math.max(10, Math.min(95, Math.round(n)));
  }

  function readStoredOpacity() {
    try {
      const raw = localStorage.getItem(OPACITY_KEY);
      if (raw === null) return DEFAULT_OPACITY;
      return clampOpacity(raw);
    } catch {
      return DEFAULT_OPACITY;
    }
  }

  function applyOpacityVars(pct) {
    const root = document.documentElement;
    if (!root) return;
    const base = pct / 100;
    const rail = Math.min(0.97, base + 0.08);
    const reader = Math.max(0.08, base * 0.9);
    const card = Math.min(0.96, base + 0.1);
    root.style.setProperty('--glass-alpha', base.toFixed(2));
    root.style.setProperty('--rail-alpha', rail.toFixed(2));
    root.style.setProperty('--reader-alpha', reader.toFixed(2));
    root.style.setProperty('--card-alpha', card.toFixed(2));
  }

  function setGlassOpacity(pct, opts) {
    const options = opts || {};
    const clamped = clampOpacity(pct);
    currentOpacity = clamped;
    applyOpacityVars(clamped);

    if (options.save !== false) {
      try {
        localStorage.setItem(OPACITY_KEY, String(clamped));
      } catch {
      }
    }
    if (options.broadcast !== false && syncChannel) {
      try {
        syncChannel.postMessage(clamped);
      } catch {
      }
    }
    opacityListeners.forEach(fn => {
      try {
        fn(clamped, options.source || null);
      } catch {
      }
    });
    return clamped;
  }

  applyOpacityVars(currentOpacity);

  window.addEventListener('storage', event => {
    if (event.key === OPACITY_KEY && event.newValue !== null) {
      setGlassOpacity(Number(event.newValue), { save: false, broadcast: false });
    }
  });

  function extractVerificationCode(subject, bodyText) {
    const combined = `${subject || ''}\n${bodyText || ''}`;
    if (!combined.trim()) return '';

    const keywordRegex = /(?:验证码|校验码|动态码|确认码|安全码|인증번호|確認コード|verification\s*code|security\s*code|login\s*code|one[-\s]*time\s*code|passcode|otp|pin|code)[^\dA-Za-z]{0,18}(?<!\d)(\d{4,8})(?!\d)/i;
    const directMatch = combined.match(keywordRegex);
    if (directMatch) return directMatch[1];

    const reverseRegex = /(?<!\d)(\d{4,8})(?!\d)[^\n.。!！]{0,20}(?:验证码|校验码|确认码|verification\s*code|security\s*code|login\s*code|otp)/i;
    const reverseMatch = combined.match(reverseRegex);
    if (reverseMatch) return reverseMatch[1];

    const hasCodeContext = /(验证码|校验码|动态码|确认码|verify|verification|otp|passcode|sign[\s-]*in|登录|注册)/i.test(combined);
    if (hasCodeContext) {
      const standalone = combined.replace(/https?:\/\/\S+/g, ' ').replace(/\b20[2-3]\d\b/g, ' ');
      const sixDigit = standalone.match(/(?<!\d)(\d{6})(?!\d)/);
      if (sixDigit) return sixDigit[1];
    }
    return '';
  }

  function senderInitials(sender) {
    const raw = String(sender || '').trim();
    if (!raw) return 'SM';
    const namePart = raw.split('<')[0].replace(/["']/g, '').trim() || raw.split('@')[0];
    const clean = namePart.replace(/[^A-Za-z0-9\u4e00-\u9fa5]+/g, ' ').trim();
    if (!clean) return 'SM';
    if (/[\u4e00-\u9fa5]/.test(clean)) {
      return clean.slice(0, 1);
    }
    const parts = clean.split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return clean.slice(0, 2).toUpperCase();
  }

  function formatUptime(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds) || 0));
    const days = Math.floor(s / 86400);
    const hours = Math.floor((s % 86400) / 3600);
    const mins = Math.floor((s % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${mins}m`;
    if (mins > 0) return `${mins}m`;
    return `${s}s`;
  }

  // Always-Moving Double-Edged 21st.dev Cobalt Silk Ribbons Shader
  function mountCobaltShader(canvas) {
    if (!canvas || !canvas.getContext) return;
    const ctx = canvas.getContext('2d');
    const isWindowMode = canvas.dataset.mode === 'window';
    const startTime = performance.now();
    let rafId = 0;

    const ribbons = isWindowMode
      ? [
          { base: 0.22, width: 0.14, speed: 0.55, amp: 0.13, alpha: 0.42, hue: [0, 52, 245] },
          { base: 0.48, width: 0.17, speed: -0.42, amp: 0.16, alpha: 0.56, hue: [0, 62, 255] },
          { base: 0.74, width: 0.15, speed: 0.48, amp: 0.14, alpha: 0.46, hue: [32, 98, 255] },
          { base: 0.60, width: 0.09, speed: 0.72, amp: 0.11, alpha: 0.34, hue: [76, 138, 255] },
        ]
      : [
          { base: 0.28, width: 0.15, speed: 0.46, amp: 0.12, alpha: 0.38, hue: [0, 48, 235] },
          { base: 0.56, width: 0.18, speed: -0.38, amp: 0.14, alpha: 0.52, hue: [0, 60, 255] },
          { base: 0.80, width: 0.15, speed: 0.44, amp: 0.12, alpha: 0.42, hue: [28, 92, 255] },
        ];

    function resize() {
      const rect = canvas.getBoundingClientRect();
      const wCss = rect.width || window.innerWidth || 1280;
      const hCss = rect.height || window.innerHeight || 800;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.floor(wCss * dpr));
      canvas.height = Math.max(1, Math.floor(hCss * dpr));
      drawFrame(performance.now());
    }

    function drawFrame(now) {
      const t = (now - startTime) * 0.001;
      const w = canvas.width;
      const h = canvas.height;

      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = isWindowMode ? '#05060B' : '#06070B';
      ctx.fillRect(0, 0, w, h);

      const amb = ctx.createRadialGradient(w * 0.82, h * 0.16, 0, w * 0.82, h * 0.16, w * 0.56);
      amb.addColorStop(0, 'rgba(0, 44, 210, 0.20)');
      amb.addColorStop(1, 'rgba(5, 6, 11, 0)');
      ctx.fillStyle = amb;
      ctx.fillRect(0, 0, w, h);

      ctx.globalCompositeOperation = 'screen';
      for (let i = 0; i < ribbons.length; i++) {
        const rb = ribbons[i];
        const p = t * rb.speed + i * 1.7;

        const topX = w * (rb.base + Math.sin(p) * rb.amp);
        const ctrl1X = w * (rb.base - 0.08 + Math.cos(p * 1.15) * (rb.amp * 1.25));
        const ctrl2X = w * (rb.base + 0.10 + Math.sin(p * 0.85 + 1.2) * (rb.amp * 1.25));
        const botX = w * (rb.base + 0.04 + Math.cos(p * 0.9 + 2.1) * rb.amp);
        const halfW = w * (rb.width * (0.88 + 0.18 * Math.sin(t * 0.8 + i)));
        const r = rb.hue[0];
        const g = rb.hue[1];
        const b = rb.hue[2];

        const grad = ctx.createLinearGradient(ctrl1X - halfW, h * 0.25, ctrl2X + halfW, h * 0.75);
        grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0)`);
        grad.addColorStop(0.28, `rgba(${r}, ${g}, ${b}, ${(rb.alpha * 0.55).toFixed(3)})`);
        grad.addColorStop(0.5, `rgba(${Math.min(255, r + 36)}, ${Math.min(255, g + 45)}, 255, ${rb.alpha.toFixed(3)})`);
        grad.addColorStop(0.72, `rgba(${r}, ${g}, ${b}, ${(rb.alpha * 0.55).toFixed(3)})`);
        grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);

        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.moveTo(topX - halfW, -h * 0.06);
        ctx.bezierCurveTo(ctrl1X - halfW, h * 0.34, ctrl2X - halfW, h * 0.68, botX - halfW, h * 1.06);
        ctx.lineTo(botX + halfW, h * 1.06);
        ctx.bezierCurveTo(ctrl2X + halfW, h * 0.68, ctrl1X + halfW, h * 0.34, topX + halfW, -h * 0.06);
        ctx.closePath();
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    function loop(now) {
      if (!document.hidden) {
        drawFrame(now);
      }
      rafId = requestAnimationFrame(loop);
    }

    window.addEventListener('resize', resize);
    resize();
    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }

  function mountSpecularTracking() {
    const selector = '.specular-btn, body.mode1-glass .btn-primary, body.mode1-glass .btn-secondary, body.mode1-glass .icon-btn';
    let px = 0;
    let py = 0;
    let queued = false;

    function flush() {
      queued = false;
      const nodes = document.querySelectorAll(selector);
      for (let i = 0; i < nodes.length; i++) {
        const btn = nodes[i];
        const rect = btn.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        const dx = Math.max(rect.left - px, 0, px - rect.right);
        const dy = Math.max(rect.top - py, 0, py - rect.bottom);
        const dist = Math.hypot(dx, dy);
        if (dist < 200) {
          const x = ((px - rect.left) / rect.width) * 100;
          const y = ((py - rect.top) / rect.height) * 100;
          btn.style.setProperty('--mx', `${x.toFixed(1)}%`);
          btn.style.setProperty('--my', `${y.toFixed(1)}%`);
          btn.style.setProperty('--pool-o', dist === 0 ? '0.14' : '0.07');
        }
      }
    }

    document.addEventListener('pointermove', event => {
      px = event.clientX;
      py = event.clientY;
      if (!queued) {
        queued = true;
        requestAnimationFrame(flush);
      }
    }, { passive: true });
  }

  function rubber(d, limit) {
    return 2 * (1 / (1 + Math.exp(-d / limit)) - 0.5) * limit;
  }

  function stepSpring(pos, target, vel, k, damp, dt) {
    const force = (target - pos) * k;
    const nextVel = (vel + force * dt) * Math.exp(-damp * dt);
    return [pos + nextVel * dt, nextVel];
  }

  function mountOpacityControl(anchorEl, opts) {
    if (!anchorEl) return;
    const options = opts || {};
    const instanceId = Symbol('opacity-ctrl');

    const posClass = options.placement === 'down'
      ? ' place-down'
      : options.placement === 'rail'
        ? ' place-rail'
        : '';

    anchorEl.innerHTML = `
      <div class="sm-opacity-popover${posClass}" role="dialog" aria-label="调节视窗透明度">
        <div class="sm-es-row">
          <span class="sm-es-icon" aria-hidden="true">◌</span>
          <div class="sm-es-wrap">
            <div class="sm-es-track">
              <div class="sm-es-fill"></div>
            </div>
          </div>
          <span class="sm-es-val">${currentOpacity}%</span>
        </div>
        <div class="sm-es-presets">
          <button type="button" class="specular-btn sm-es-preset" data-preset="12">12%</button>
          <button type="button" class="specular-btn sm-es-preset" data-preset="28">28%</button>
          <button type="button" class="specular-btn sm-es-preset" data-preset="42">42%</button>
          <button type="button" class="specular-btn sm-es-preset" data-preset="75">75%</button>
        </div>
      </div>
      <button type="button" class="specular-btn sm-opacity-pill" title="点击调节视窗透明度 · 滚轮可直接微调" aria-expanded="false">
        <span class="sm-opacity-glyph" aria-hidden="true">◐</span>
        <span class="sm-opacity-readout">${currentOpacity}%</span>
      </button>
    `;

    const popover = anchorEl.querySelector('.sm-opacity-popover');
    const pillBtn = anchorEl.querySelector('.sm-opacity-pill');
    const pillReadout = anchorEl.querySelector('.sm-opacity-readout');
    const esRow = anchorEl.querySelector('.sm-es-row');
    const esIcon = anchorEl.querySelector('.sm-es-icon');
    const esWrap = anchorEl.querySelector('.sm-es-wrap');
    const esTrack = anchorEl.querySelector('.sm-es-track');
    const esFill = anchorEl.querySelector('.sm-es-fill');
    const esVal = anchorEl.querySelector('.sm-es-val');
    const presets = anchorEl.querySelectorAll('.sm-es-preset');

    const spring = {
      val: currentOpacity,
      targetVal: currentOpacity,
      velVal: 0,
      stretch: 0,
      targetStretch: 0,
      velStretch: 0,
      active: 0,
      targetActive: 0,
      velActive: 0,
      dragging: false,
      raf: 0,
      lastTime: 0,
    };

    let open = false;

    function syncVisuals(valNum) {
      const norm = (valNum - 10) / 85;
      const pct = Math.max(0, Math.min(100, norm * 100));
      esFill.style.width = `${pct.toFixed(1)}%`;
      esTrack.style.height = `${(4 + spring.active * 4).toFixed(1)}px`;

      const s = spring.stretch;
      const scaleX = 1 + Math.abs(s) / 140;
      const scaleY = 1 - Math.min(0.22, Math.abs(s) / 120);
      esWrap.style.transformOrigin = s < 0 ? '100% 50%' : '0% 50%';
      esWrap.style.transform = `scaleX(${scaleX.toFixed(3)}) scaleY(${scaleY.toFixed(3)})`;
      esIcon.style.transform = `translateX(${Math.min(0, s * 0.45).toFixed(1)}px)`;

      const rounded = clampOpacity(valNum);
      pillReadout.textContent = `${rounded}%`;
      esVal.textContent = `${rounded}%`;
      presets.forEach(btn => {
        const p = Number(btn.dataset.preset);
        btn.classList.toggle('is-current', Math.abs(p - rounded) <= 3);
      });
    }

    function wakeSpring() {
      if (spring.raf) return;
      spring.lastTime = performance.now();
      spring.raf = requestAnimationFrame(tickSpring);
    }

    function tickSpring(now) {
      const dt = Math.min(0.032, Math.max(0.001, (now - spring.lastTime) / 1000));
      spring.lastTime = now;

      [spring.val, spring.velVal] = stepSpring(spring.val, spring.targetVal, spring.velVal, 220, 22, dt);
      [spring.stretch, spring.velStretch] = stepSpring(spring.stretch, spring.targetStretch, spring.velStretch, 270, 15, dt);
      [spring.active, spring.velActive] = stepSpring(spring.active, spring.targetActive, spring.velActive, 190, 20, dt);

      syncVisuals(spring.val);
      const rounded = clampOpacity(spring.val);
      if (rounded !== currentOpacity) {
        setGlassOpacity(rounded, { source: instanceId });
      }

      const settled =
        !spring.dragging &&
        Math.abs(spring.targetVal - spring.val) < 0.08 &&
        Math.abs(spring.velVal) < 0.2 &&
        Math.abs(spring.targetStretch - spring.stretch) < 0.08 &&
        Math.abs(spring.velStretch) < 0.2 &&
        Math.abs(spring.targetActive - spring.active) < 0.01;

      if (settled) {
        spring.val = spring.targetVal;
        spring.stretch = 0;
        spring.active = spring.targetActive;
        syncVisuals(spring.val);
        setGlassOpacity(spring.val, { source: instanceId });
        spring.raf = 0;
        return;
      }
      spring.raf = requestAnimationFrame(tickSpring);
    }

    function setOpen(next) {
      open = Boolean(next);
      popover.classList.toggle('is-open', open);
      pillBtn.classList.toggle('is-open', open);
      pillBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    function pointerToElastic(clientX) {
      const rect = esWrap.getBoundingClientRect();
      const raw = (clientX - rect.left) / Math.max(1, rect.width);
      if (raw < 0) {
        spring.targetStretch = rubber(clientX - rect.left, 24);
        spring.targetVal = 10;
      } else if (raw > 1) {
        spring.targetStretch = rubber(clientX - rect.right, 24);
        spring.targetVal = 95;
      } else {
        spring.targetStretch = 0;
        spring.targetVal = 10 + raw * 85;
      }
      wakeSpring();
    }

    pillBtn.addEventListener('click', event => {
      event.stopPropagation();
      setOpen(!open);
    });

    pillBtn.addEventListener('wheel', event => {
      event.preventDefault();
      spring.targetVal = clampOpacity(spring.targetVal - Math.sign(event.deltaY) * 5);
      wakeSpring();
    }, { passive: false });

    esRow.addEventListener('pointerenter', () => {
      spring.targetActive = 1;
      wakeSpring();
    });
    esRow.addEventListener('pointerleave', () => {
      if (!spring.dragging) {
        spring.targetActive = 0;
        wakeSpring();
      }
    });
    esRow.addEventListener('pointerdown', event => {
      spring.dragging = true;
      spring.targetActive = 1;
      esRow.setPointerCapture(event.pointerId);
      pointerToElastic(event.clientX);
    });
    esRow.addEventListener('pointermove', event => {
      if (!spring.dragging) return;
      pointerToElastic(event.clientX);
    });
    function releaseDrag() {
      if (!spring.dragging) return;
      spring.dragging = false;
      spring.targetStretch = 0;
      spring.targetActive = 0;
      wakeSpring();
    }
    esRow.addEventListener('pointerup', releaseDrag);
    esRow.addEventListener('pointercancel', releaseDrag);
    esRow.addEventListener('wheel', event => {
      event.preventDefault();
      spring.targetVal = clampOpacity(spring.targetVal - Math.sign(event.deltaY) * 5);
      spring.targetActive = 1;
      wakeSpring();
      clearTimeout(esRow._wt);
      esRow._wt = setTimeout(() => {
        if (!spring.dragging) {
          spring.targetActive = 0;
          wakeSpring();
        }
      }, 480);
    }, { passive: false });

    presets.forEach(btn => {
      btn.addEventListener('click', event => {
        event.stopPropagation();
        const target = Number(btn.dataset.preset);
        spring.velStretch = target > spring.val ? 72 : -72;
        spring.targetVal = target;
        wakeSpring();
      });
    });

    document.addEventListener('pointerdown', event => {
      if (open && !anchorEl.contains(event.target)) {
        setOpen(false);
      }
    });

    document.addEventListener('keydown', event => {
      if (open && event.key === 'Escape') {
        setOpen(false);
      }
    });

    opacityListeners.add((nextPct, source) => {
      if (source === instanceId) return;
      spring.targetVal = nextPct;
      spring.val = nextPct;
      syncVisuals(nextPct);
    });

    syncVisuals(currentOpacity);
  }

  async function mountHealthPill(pillEl) {
    if (!pillEl) return;
    async function refreshHealth() {
      try {
        const res = await fetch('/api/health', { cache: 'no-store' });
        if (!res.ok) throw new Error('offline');
        const data = await res.json();
        const upText = formatUptime(data.uptime);
        pillEl.innerHTML = `
          <span style="display:inline-flex;align-items:center;gap:8px;color:#F5F6FA;">
            <span class="lime-dot pulse"></span>
            <span>服务在线</span>
          </span>
          <span class="sep">·</span>
          <span>已连续运行 ${upText}</span>
          <span class="sep health-extra">·</span>
          <span class="health-extra" style="color:rgba(245,246,250,0.42)">Catch-All Ready</span>
        `;
      } catch {
        pillEl.innerHTML = `
          <span style="display:inline-flex;align-items:center;gap:8px;color:#FCA5A5;">
            <span class="lime-dot" style="background:#F87171"></span>
            <span>正在连接服务...</span>
          </span>
        `;
      }
    }
    await refreshHealth();
    setInterval(() => {
      if (!document.hidden) refreshHealth();
    }, 30000);
  }

  document.addEventListener('DOMContentLoaded', () => {
    const shader = document.getElementById('cobalt-waves');
    if (shader) mountCobaltShader(shader);
    const pill = document.getElementById('health-pill');
    if (pill) mountHealthPill(pill);
    mountSpecularTracking();

    const adminOpacity = document.getElementById('admin-opacity-slot');
    if (adminOpacity) mountOpacityControl(adminOpacity, { placement: 'rail' });
    const mobOpacity = document.getElementById('mob-opacity-slot');
    if (mobOpacity) mountOpacityControl(mobOpacity, { placement: 'down' });
    const publicOpacity = document.getElementById('public-opacity-slot');
    if (publicOpacity) mountOpacityControl(publicOpacity, { placement: 'down' });
  });

  window.SnowMailUI = {
    extractVerificationCode,
    senderInitials,
    formatUptime,
    mountCobaltShader,
    mountHealthPill,
    mountOpacityControl,
    setGlassOpacity,
    getGlassOpacity: () => currentOpacity,
  };
})();
