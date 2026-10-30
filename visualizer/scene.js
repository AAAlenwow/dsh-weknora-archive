// scene.js — Three.js ingestion field.
// Runs inside the generated report's single inline module; `THREE` is provided
// by the caller after a successful blob-module import. No network, no CDN.
function mountIngestionScene(THREE, container, manifest, options) {
  const motion = (options ?? {}).motion !== false;
  const width = container.clientWidth || 640;
  const height = container.clientHeight || 420;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(width, height);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 120);
  camera.position.set(0, 0.6, 9.5);

  const core = new THREE.Group();
  scene.add(core);
  const wire = new THREE.Mesh(
    new THREE.IcosahedronGeometry(1.35, 1),
    new THREE.MeshBasicMaterial({ color: 0xffb347, wireframe: true, transparent: true, opacity: 0.85 }),
  );
  const inner = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.55, 2),
    new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.22 }),
  );
  core.add(wire, inner);

  const COLOR = { completed: 0xffb347, parsing: 0x6fd6ff, failed: 0xff5c5c, discovered: 0x8b93a7 };
  const docs = Array.isArray(manifest.documents) ? manifest.documents : [];
  const MAX_N = 360;
  const items = docs.length > MAX_N ? docs.slice(0, MAX_N) : docs;
  const N = Math.max(items.length, 1);
  const pos = new Float32Array(N * 3);
  const col = new Float32Array(N * 3);
  const start = new Float32Array(N * 3);
  const target = new Float32Array(N * 3);
  const phase = new Float32Array(N);
  const stagger = new Float32Array(N);
  const bad = new Uint8Array(N);

  const golden = Math.PI * (3 - Math.sqrt(5));
  const tmp = new THREE.Color();
  items.forEach((doc, i) => {
    const y = 1 - (i / (N - 1 || 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    target[i * 3] = Math.cos(theta) * r * 2.3;
    target[i * 3 + 1] = y * 2.3;
    target[i * 3 + 2] = Math.sin(theta) * r * 2.3;
    const angle = Math.random() * Math.PI * 2;
    const radius = 4.5 + Math.random() * 3.5;
    start[i * 3] = Math.cos(angle) * radius;
    start[i * 3 + 1] = (Math.random() - 0.5) * 3;
    start[i * 3 + 2] = Math.sin(angle) * radius;
    const status = String(doc.status ?? 'parsing');
    if (status === 'failed' || status === 'discovered') bad[i] = 1;
    tmp.setHex(COLOR[status] ?? COLOR.parsing);
    col[i * 3] = tmp.r; col[i * 3 + 1] = tmp.g; col[i * 3 + 2] = tmp.b;
    phase[i] = Math.random() * Math.PI * 2;
    stagger[i] = (i % 24) / 24 * 0.9;
  });

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const points = new THREE.Points(geo, new THREE.PointsMaterial({
    size: 0.16, vertexColors: true, transparent: true, opacity: 0.95, sizeAttenuation: true,
  }));
  scene.add(points);
  const FAILED_CLUSTER = { x: 0, y: -3.4, z: 0 };

  let disposed = false;
  const clock = new THREE.Clock();
  function frame() {
    if (disposed) return;
    const t = clock.getElapsedTime();
    for (let i = 0; i < N; i++) {
      const local = Math.max(0, Math.min(1, (t - 0.2 - stagger[i]) / 0.9));
      const eased = 1 - Math.pow(1 - local, 3);
      let tx = target[i * 3], ty = target[i * 3 + 1], tz = target[i * 3 + 2];
      if (bad[i]) {
        tx = FAILED_CLUSTER.x + Math.sin(i) * 1.2;
        ty = FAILED_CLUSTER.y;
        tz = FAILED_CLUSTER.z + Math.cos(i) * 1.2;
      }
      const ox = motion ? Math.sin(t * 1.1 + phase[i]) * 0.12 * eased : 0;
      const oy = motion ? Math.cos(t * 0.9 + phase[i]) * 0.12 * eased : 0;
      pos[i * 3] = start[i * 3] + (tx - start[i * 3]) * eased + ox;
      pos[i * 3 + 1] = start[i * 3 + 1] + (ty - start[i * 3 + 1]) * eased + oy;
      pos[i * 3 + 2] = start[i * 3 + 2] + (tz - start[i * 3 + 2]) * eased;
    }
    geo.attributes.position.needsUpdate = true;
    if (motion) {
      core.rotation.y = t * 0.25;
      wire.rotation.x = t * 0.12;
    }
    renderer.render(scene, camera);
    if (motion) requestAnimationFrame(frame);
  }
  if (!motion) {
    for (let i = 0; i < N; i++) {
      pos[i * 3] = target[i * 3];
      pos[i * 3 + 1] = target[i * 3 + 1];
      pos[i * 3 + 2] = target[i * 3 + 2];
    }
    geo.attributes.position.needsUpdate = true;
  }
  frame();

  const ro = new ResizeObserver(() => {
    const w = container.clientWidth || width;
    const h = container.clientHeight || height;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  });
  ro.observe(container);
  return {
    dispose() {
      disposed = true;
      ro.disconnect();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
