// app.js — report bootstrap. Runs inside the same inline module as three.js
// and scene.js; `THREE` and `mountIngestionScene` are module-scope bindings.
const manifest = JSON.parse(document.getElementById('archive-data').textContent);
const options = window.__ARCHIVE_OPTIONS__ ?? {};
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const motion = options.motion !== false && !reducedMotion;

for (const el of document.querySelectorAll('.metric strong[data-count]')) {
  const target = Number(manifest.summary?.[el.dataset.count] ?? 0);
  if (!motion) { el.textContent = String(target); continue; }
  const t0 = performance.now();
  const duration = 900;
  (function tick(now) {
    const p = Math.min(1, (now - t0) / duration);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = String(Math.round(target * eased));
    if (p < 1) requestAnimationFrame(tick);
  })(t0);
}

const caption = document.getElementById('scene-caption');
if (caption) {
  const failed = manifest.summary?.failed ?? 0;
  const parsing = manifest.summary?.parsing ?? 0;
  caption.textContent = failed > 0
    ? `${failed} 份待处理 · 其余已入库`
    : parsing > 0
      ? `${parsing} 份解析中 · 请稍后刷新核对`
      : '全部知识已入库';
}

const holder = document.getElementById('scene');
if (holder) mountIngestionScene(THREE, holder, manifest, { motion });
