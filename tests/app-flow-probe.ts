// Drives the REAL app (main.ts) through the reported bug path: start-screen
// preview for user A -> type user B -> take off -> crash/quit -> menu -> retry.
// Installs THREE dispose instrumentation before main.ts loads.
import * as THREE from 'three';

const disposed = { geos: new Set<string>(), mats: new Set<string>(), texs: new Set<string>() };
const wrap = <T extends { uuid: string; dispose: () => unknown }>(proto: T, bucket: Set<string>) => {
  const orig = proto.dispose;
  proto.dispose = function (this: T) {
    bucket.add(this.uuid);
    return orig.call(this);
  };
};
wrap(THREE.BufferGeometry.prototype as any, disposed.geos);
wrap(THREE.Material.prototype as any, disposed.mats);
wrap(THREE.Texture.prototype as any, disposed.texs);

const log: string[] = [];
const emit = (line: string) => {
  log.push(line);
  console.log(line);
  const el = document.createElement('pre');
  el.textContent = line;
  el.style.margin = '0';
  el.style.font = '11px monospace';
  document.body.appendChild(el);
};
const checks: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  checks.push({ name, ok, detail });
  emit(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

// Deterministic contribution payloads; the app asks /api/contributions/<user>.
function makeDays(kind: 'amber' | 'coral') {
  const days = [];
  const start = Date.UTC(2025, 10, 18);
  for (let i = 0; i < 365; i++) {
    const d = new Date(start + i * 86400000);
    let count = 0;
    if (kind === 'amber') {
      const h = Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1;
      if (h > 0.45) count = Math.floor(h * 8);
      if (h > 0.97) count += 24;
    } else {
      const h = Math.abs(Math.sin(i * 78.233 + 3.1) * 96321.11) % 1;
      if (h > 0.12) count = Math.floor(h * 22) + 1;
      if (i % 31 === 0) count = 55;
    }
    days.push({ date: d.toISOString().slice(0, 10), count, weekday: d.getUTCDay() });
  }
  return days;
}

const DATA: Record<string, unknown[]> = {
  'preview-user': makeDays('amber'),
  'next-user': makeDays('coral'),
};

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const m = url.match(/\/api\/contributions\/([^?]+)/);
  if (m) {
    const user = decodeURIComponent(m[1]);
    const days = DATA[user] ?? DATA['preview-user'];
    return new Response(JSON.stringify(days), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'X-Demo-Data': '1' },
    });
  }
  if (url.includes('/api/config')) {
    return new Response(JSON.stringify({ defaultUser: 'preview-user', demo: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (url.includes('/api/leaderboard')) return new Response('[]', { status: 200 });
  if (url.includes('/api/stars')) return new Response(JSON.stringify({ stars: 5, starred: false }), { status: 200 });
  if (url.includes('/api/score')) return new Response(JSON.stringify({ rank: 1, rating: 5000, improved: false }), { status: 200 });
  if (url.includes('googletagmanager') || url.includes('fonts.googleapis')) return new Response('', { status: 204 });
  return realFetch(input as any, init);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Yield to the game loop. Timer ticks advance both the probe and the game's
// requestAnimationFrame loop under headless virtual time.
const frames = async (n = 4) => {
  for (let i = 0; i < n; i++) await sleep(16);
};

// Headless Chrome's virtual time barely fires requestAnimationFrame, so the
// game loop would barely tick. Route rAF through timers instead; time still
// advances via performance.now(), so the loop behaves like a 60 fps run.
let rafId = 0;
const rafTimers = new Map<number, ReturnType<typeof setTimeout>>();
window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
  const id = ++rafId;
  rafTimers.set(
    id,
    setTimeout(() => {
      rafTimers.delete(id);
      cb(performance.now());
    }, 16)
  );
  return id;
}) as typeof window.requestAnimationFrame;
window.cancelAnimationFrame = ((id: number) => {
  const t = rafTimers.get(id);
  if (t) {
    clearTimeout(t);
    rafTimers.delete(id);
  }
}) as typeof window.cancelAnimationFrame;

interface Snapshot {
  geos: Set<string>;
  mats: Set<string>;
  texs: Set<string>;
}
async function snapshotAssets(): Promise<Snapshot & { meshes: number }> {
  const mod = await import('../src/game/assets.ts');
  const assets = await mod.loadAssets();
  const geos = new Set<string>();
  const mats = new Set<string>();
  const texs = new Set<string>();
  let meshes = 0;
  const roots = [assets.plane, ...assets.cityBuildings, ...assets.trees, assets.bush, assets.acUnit].filter(Boolean) as THREE.Object3D[];
  for (const root of roots) {
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      meshes++;
      if (mesh.geometry) geos.add(mesh.geometry.uuid);
      const material = mesh.material as THREE.Material | THREE.Material[];
      for (const m of Array.isArray(material) ? material : [material]) {
        if (!m) continue;
        mats.add(m.uuid);
        for (const v of Object.values(m as unknown as Record<string, unknown>)) {
          const t = v as THREE.Texture;
          if (t && t.isTexture) texs.add(t.uuid);
        }
      }
    });
  }
  return { geos, mats, texs, meshes };
}

async function main() {
  const assets = await snapshotAssets();
  emit(`cached model graph: ${assets.meshes} meshes, ${assets.geos.size} geos, ${assets.mats.size} mats, ${assets.texs.size} texs`);

  // boot the app
  await import('../src/main.ts');

  const startInput = async () => {
    for (let i = 0; i < 200; i++) {
      const input = document.querySelector<HTMLInputElement>('#username-input');
      if (input) return input;
      await sleep(50);
    }
    throw new Error('start screen never appeared');
  };
  const inputA = await startInput();
  await frames(20);
  check('start screen preview mounted', inputA.value.length > 0, `prefilled "${inputA.value}"`);
  emit(`disposed counts at start: geos=${disposed.geos.size} mats=${disposed.mats.size} texs=${disposed.texs.size}`);

  // switch the preview to another user and take off. This is the reported
  // path: stopPreview() destroys the old city, then a new one is built.
  const inputB = document.querySelector<HTMLInputElement>('#username-input')!;
  inputB.value = 'next-user';
  document.querySelector<HTMLButtonElement>('#takeoff-btn')!.click();
  await frames(30);
  await sleep(600);
  await frames(10);

  const sharedGeosDisposed = [...assets.geos].filter((id) => disposed.geos.has(id));
  const sharedMatsDisposed = [...assets.mats].filter((id) => disposed.mats.has(id));
  const sharedTexsDisposed = [...assets.texs].filter((id) => disposed.texs.has(id));
  check('preview -> take-off disposes no shared geometry', sharedGeosDisposed.length === 0, `${sharedGeosDisposed.length}/${assets.geos.size}`);
  check('preview -> take-off disposes no shared material', sharedMatsDisposed.length === 0, `${sharedMatsDisposed.length}/${assets.mats.size}`);
  check('preview -> take-off disposes no shared texture', sharedTexsDisposed.length === 0, `${sharedTexsDisposed.length}/${assets.texs.size}`);
  check('game started', document.body.classList.contains('playing') || !!document.querySelector('canvas'), 'game loop running');

  // pause -> quit to menu -> retry same user
  const waitFor = async <T extends Element>(selector: string, tries = 120): Promise<T | null> => {
    for (let i = 0; i < tries; i++) {
      const el = document.querySelector<T>(selector);
      if (el) return el;
      await sleep(100);
      await frames(2);
    }
    return null;
  };
  const waitForPlaying = async (want = true, tries = 150): Promise<boolean> => {
    for (let i = 0; i < tries; i++) {
      if (document.body.classList.contains('playing') === want) return true;
      await sleep(100);
      await frames(2);
    }
    return false;
  };
  check('game loop is running before pause', await waitForPlaying(true));

  // Fly straight: the plane will run into a busy weekday building, which is the
  // real "run ends" path. If it survives (win) the same end screen appears.
  // Crash cinematics run ~1.6 s, so allow generous virtual time. If neither
  // shows up, fall back to pause -> quit to menu, which is the other return path.
  const endBtn = await (async () => {
    for (let i = 0; i < 400; i++) {
      const btn = document.querySelector<HTMLButtonElement>('#menu-btn') ?? document.querySelector<HTMLButtonElement>('#quit-btn');
      if (btn) return btn;
      await sleep(50);
    }
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape' }));
    for (let i = 0; i < 100; i++) {
      const btn = document.querySelector<HTMLButtonElement>('#quit-btn');
      if (btn) return btn;
      await sleep(50);
    }
    return null;
  })();
  const onEndScreen = !!document.querySelector('#menu-btn');
  const onPauseScreen = !!document.querySelector('#quit-btn');
  check(
    'run ends (crash/win) or pauses to reach menu',
    !!endBtn,
    onEndScreen ? 'crash/win screen' : onPauseScreen ? 'pause screen' : 'neither'
  );
  endBtn?.click();
  await frames(10);
  const backInput = await waitFor<HTMLInputElement>('#username-input', 150);
  await frames(10);
  check('returned to menu with a fresh preview', !!backInput);

  const afterMenu = {
    geos: [...assets.geos].filter((id) => disposed.geos.has(id)).length,
    mats: [...assets.mats].filter((id) => disposed.mats.has(id)).length,
    texs: [...assets.texs].filter((id) => disposed.texs.has(id)).length,
  };
  check('menu shows preview with shared models available', afterMenu.geos === 0 && afterMenu.mats === 0, `geos=${afterMenu.geos} mats=${afterMenu.mats} texs=${afterMenu.texs}`);

  // retry the same user
  const retryInput = document.querySelector<HTMLInputElement>('#username-input')!;
  retryInput.value = 'next-user';
  document.querySelector<HTMLButtonElement>('#takeoff-btn')!.click();
  await frames(30);
  await sleep(400);
  await frames(10);

  const afterRetry = {
    geos: [...assets.geos].filter((id) => disposed.geos.has(id)).length,
    mats: [...assets.mats].filter((id) => disposed.mats.has(id)).length,
    texs: [...assets.texs].filter((id) => disposed.texs.has(id)).length,
  };
  check(
    'same-user retry keeps every shared resource',
    afterRetry.geos === 0 && afterRetry.mats === 0 && afterRetry.texs === 0,
    `geos=${afterRetry.geos} mats=${afterRetry.mats} texs=${afterRetry.texs}`
  );

  // the renderer must still be able to draw the shared models: build and
  // render a fresh city and confirm the cached pages are untouched
  const { buildWorld } = await import('../src/game/world.ts');
  const { loadAssets } = await import('../src/game/assets.ts');
  const freshAssets = await loadAssets();
  const freshWorld = buildWorld(DATA['next-user'] as any, freshAssets);
  let cachedMeshes = 0;
  freshWorld.scene.traverse((o) => {
    if (o.userData?.noDispose) cachedMeshes++;
  });
  freshWorld.dispose();
  check('a fresh city still has cached-model meshes', cachedMeshes > 0, `${cachedMeshes} meshes`);
  check(
    'building + disposing a fresh city spares shared models',
    [...assets.geos].filter((id) => disposed.geos.has(id)).length === 0,
    `geos=${[...assets.geos].filter((id) => disposed.geos.has(id)).length}`
  );
  check('cached asset instance is reused (not reloaded)', freshAssets === (await loadAssets()), 'loadAssets() returns the same object');

  const ok = checks.every((c) => c.ok);
  (window as any).__probeResult = { ok, checks, log };
  const summary = document.createElement('h3');
  summary.textContent = ok ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED';
  summary.style.color = ok ? '#1a7f37' : '#cf222e';
  document.body.prepend(summary);
}

main().catch((err) => {
  console.error(err);
  emit('ERROR ' + (err && (err as Error).stack ? (err as Error).stack : String(err)));
  (window as any).__probeResult = { ok: false, error: String(err) };
});
