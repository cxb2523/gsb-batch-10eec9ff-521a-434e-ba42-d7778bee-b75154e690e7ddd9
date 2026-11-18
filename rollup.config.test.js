// Test-only rollup config: bundles src/three-render-objects.js with all non-three deps
// inlined, so headless pages can load it through a small import map.
import resolve from '@rollup/plugin-node-resolve';
import commonJs from '@rollup/plugin-commonjs';
import babel from '@rollup/plugin-babel';
import postCss from 'rollup-plugin-postcss';

export default {
  external: [/^three(\/|$)/],
  input: 'src/three-render-objects.js',
  output: {
    format: 'es',
    file: 'test/build/three-render-objects.bundle.mjs'
  },
  plugins: [
    postCss(),
    resolve(),
    commonJs(),
    babel({ babelHelpers: 'bundled', exclude: 'node_modules/**' })
  ]
};
