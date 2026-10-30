import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_REPORT_DIR = join(homedir(), '.dsh', 'plugin-data', 'dsh-weknora-archive', 'reports');

const read = (name) => readFileSync(join(PACKAGE_ROOT, 'visualizer', name), 'utf8');

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/** JSON safely embeddable in a <script> block and in a JS string literal. */
const jsonForHtml = (value) => JSON.stringify(value)
  .replace(/</g, '\\u003c')
  .replace(/>/g, '\\u003e')
  .replace(/\u2028/g, '\\u2028')
  .replace(/\u2029/g, '\\u2029');

function summaryHtml(manifest) {
  const labels = { completed: '已入库', parsing: '解析中', failed: '失败', discovered: '待归档', skipped: '已跳过' };
  return Object.entries(labels).map(([key, label]) => `<div class="metric ${key}"><strong data-count="${key}">${manifest.summary?.[key] ?? 0}</strong><span>${label}</span></div>`).join('');
}

function documentRows(manifest) {
  return (manifest.documents ?? []).map((doc) => `<tr data-status="${esc(doc.status)}"><td><span class="dot"></span>${esc(doc.title)}</td><td>${esc(doc.project)}</td><td>${esc(doc.status)}</td></tr>`).join('');
}

/**
 * Render one SELF-CONTAINED report: three.js, scene and app are inlined into a
 * single inline module (three loads via blob module URL — works on file:// in
 * Chrome/Firefox/Safari). No CDN, no fetch, no keys, no transcript text.
 */
export function renderReport(manifest, { motion = true } = {}) {
  const threeSource = read('vendor/three.module.min.js');
  // '</' escaping inside a JS string literal is a no-op for semantics ("\/" === "/")
  // and makes the payload immune to premature </script> termination.
  const threeJson = JSON.stringify(threeSource).replace(/<\//g, '<\\/');
  const styles = read('styles.css');
  const sceneSource = read('scene.js');
  const appSource = read('app.js');
  const data = jsonForHtml(manifest);
  const csp = "default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src data:; connect-src 'none'";
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Knowledge Ingest · ${esc(String(manifest.id ?? '').slice(0, 8))}</title>
<style>${styles}</style>
</head>
<body>
<header><div><span class="eyebrow">WEKNORA / LOCAL ARCHIVE</span><h1>知识<span>入库</span>星图</h1><p>每一份经验，都有迹可循。</p></div><div class="run"><span>ARCHIVE RUN</span><code>${esc(String(manifest.id ?? '').slice(0, 8))}</code><time>${esc(manifest.finishedAt ?? manifest.startedAt ?? '')}</time></div></header>
<main><section class="observatory"><div id="scene" role="img" aria-label="知识文档汇聚成知识库的三维动画"></div><div class="scene-label"><span>01 / INGESTION FIELD</span><strong id="scene-caption">${motion ? '知识正在汇聚' : '静态知识图谱'}</strong></div><div class="legend"><span class="completed">● 已入库</span><span class="parsing">● 解析中</span><span class="failed">● 失败</span></div><div id="fallback" hidden>当前环境未启用 WebGL 或模块加载失败，已切换为静态报告。归档结果不受影响。</div></section>
<aside><span class="eyebrow">02 / VERIFIED MANIFEST</span><h2>真实入库记录</h2><p class="intro">动画仅呈现归档清单，不会触发上传或改变解析状态。</p><div class="metrics">${summaryHtml(manifest)}</div><details><summary>查看文档明细 <span>${(manifest.documents ?? []).length}</span></summary><div class="table-wrap"><table><thead><tr><th>文档</th><th>项目</th><th>状态</th></tr></thead><tbody>${documentRows(manifest)}</tbody></table></div></details><div class="note">数据仅存于此本地报告。未包含会话正文、API 地址或密钥。</div></aside></main>
<footer><span>LOCAL ONLY · THREE.JS</span><span>解析中 ≠ 已入库 · 以服务端最终状态为准</span></footer>
<script id="archive-data" type="application/json">${data}</script>
<script>window.__ARCHIVE_OPTIONS__=${jsonForHtml({ motion })};
window.__ingestFallback__ = function (err) {
  var box = document.getElementById('fallback');
  var holder = document.getElementById('scene');
  var caption = document.getElementById('scene-caption');
  if (box) box.hidden = false;
  if (holder) holder.style.display = 'none';
  if (caption) caption.textContent = '静态知识图谱';
  if (window.console) console.warn('dsh-weknora-archive visualizer fallback:', err);
};
</script>
<script type="module">
const THREE_SRC = ${threeJson};
try {
  const blob = new Blob([THREE_SRC], { type: 'text/javascript' });
  const THREE = await import(URL.createObjectURL(blob));
  ${sceneSource}
  ${appSource}
} catch (err) {
  window.__ingestFallback__(err);
}
</script>
</body>
</html>
`;
}

/**
 * Write the report plus its atomic manifest snapshot. Returns the HTML path.
 * The manifest snapshot next to it is what the visualize tool re-renders.
 */
export function writeReport(manifest, { directory = DEFAULT_REPORT_DIR, motion = true } = {}) {
  if (!isAbsolute(directory)) throw new Error('Report directory must be an absolute path.');
  mkdirSync(directory, { recursive: true });
  const filename = `ingest-${manifest.id}.html`;
  const path = join(directory, filename);
  const temporary = join(directory, `.${filename}.${process.pid}.tmp`);
  writeFileSync(temporary, renderReport(manifest, { motion }));
  renameSync(temporary, path);
  return path;
}
