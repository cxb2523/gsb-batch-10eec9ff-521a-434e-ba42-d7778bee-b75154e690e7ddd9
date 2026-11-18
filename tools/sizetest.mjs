// Unit tests for the renderer's size math. Pure functions only — no GL context needed, so this
// runs under plain Node and can gate the rebuild/skip decisions the resize path relies on.
//   node tools/sizetest.mjs
import { QUALITY, outputSize, internalSize } from '../src/render/renderer.js';

let failed = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!cond) failed++;
};
const even = (n) => n % 2 === 0;

// outputSize follows CSS * DPR, clamped to 2px.
{
  const a = outputSize(1000, 500, 1);
  check('output size at dpr 1', a.outW === 1000 && a.outH === 500, JSON.stringify(a));
  const b = outputSize(1000, 500, 1.5);
  check('output size scales with DPR', b.outW === 1500 && b.outH === 750, JSON.stringify(b));
  const c = outputSize(0, 0, 2);
  check('output size clamps to 2px', c.outW === 2 && c.outH === 2, JSON.stringify(c));
}

// internalSize = output * quality scale, rounded to even pixels, never below 2.
{
  const low = internalSize(1920, 1080, 1, QUALITY.low);
  check('low internal size', low.w === Math.round(1920 * 0.66 / 2) * 2 && low.h === Math.round(1080 * 0.66 / 2) * 2,
    `${low.w}x${low.h}`);
  check('internal sizes are even', even(low.w) && even(low.h));
  const med = internalSize(1920, 1080, 1, QUALITY.medium);
  check('medium internal size', med.w === 1536 && med.h === 864, `${med.w}x${med.h}`);
  const high = internalSize(1920, 1080, 1, QUALITY.high);
  check('high internal size matches output at scale 1', high.w === 1920 && high.h === 1080);
  const tiny = internalSize(3, 3, 1, QUALITY.low);
  check('tiny sizes never fall below 2px', tiny.w >= 2 && tiny.h >= 2 && even(tiny.w) && even(tiny.h),
    `${tiny.w}x${tiny.h}`);
}

// DPR changes move the internal size even while the CSS size is fixed.
{
  const d1 = internalSize(800, 600, 1, QUALITY.high);
  const d2 = internalSize(800, 600, 1.5, QUALITY.high);
  check('DPR change moves internal size', d1.w !== d2.w && d1.h !== d2.h, `${d1.w} vs ${d2.w}`);
}

// The setSize skip rule is "same internal w/h". Different (css, dpr) pairs that round to the
// same internal pixels must compare equal so the renderer does not rebuild pointlessly.
{
  // At high (scale 1, even-rounded) a 1px CSS difference is swallowed by the even rounding.
  const a = internalSize(801, 601, 1, QUALITY.high);
  const b = internalSize(802, 602, 1, QUALITY.high);
  check('near-identical inputs can collapse to the same internal size', a.w === b.w && a.h === b.h,
    `${a.w}x${a.h} vs ${b.w}x${b.h}`);
  // A DPR swap can also land on the same pixels: 1200 CSS @1 == 800 CSS @1.5 at scale 1.
  const c = internalSize(1200, 900, 1, QUALITY.high);
  const d = internalSize(800, 600, 1.5, QUALITY.high);
  check('different css/dpr pairs can share an internal size', c.w === d.w && c.h === d.h,
    `${c.w}x${c.h} vs ${d.w}x${d.h}`);
}

// Conversely, quality tiers at the same window produce distinct internal sizes (and when two
// tiers ever share a size, setQuality's force flag must still rebuild — covered by the browser
// harness in tools/qualitytest.mjs).
{
  const sizes = ['low', 'medium', 'high', 'film'].map((t) => {
    const s = internalSize(1280, 720, 1, QUALITY[t]);
    return `${t}:${s.w}x${s.h}`;
  });
  check('tiers resolve at the expected scales', sizes.join(' ') ===
    'low:844x476 medium:1024x576 high:1280x720 film:1280x720', sizes.join(' '));
  check('high and film share internal pixels (force-rebuild case)',
    internalSize(1280, 720, 1, QUALITY.high).w === internalSize(1280, 720, 1, QUALITY.film).w);
}

// Every derived buffer size stays integral and >= 2 for the smallest realistic window.
{
  const { w, h } = internalSize(320, 240, 1, QUALITY.low);
  const ok = [w, h, w / 2, h / 2, w / 4, h / 4, w * QUALITY.low.fxScale, h * QUALITY.low.fxScale]
    .every((n) => Number.isFinite(n) && n >= 2);
  check('derived half/quarter/FX targets stay >= 2px at small windows', ok, `${w}x${h}`);
}

console.log(failed ? `\n${failed} FAILURE(S)` : '\nall size tests passed');
process.exit(failed ? 1 : 0);
