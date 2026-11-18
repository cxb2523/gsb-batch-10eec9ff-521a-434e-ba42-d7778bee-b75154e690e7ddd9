import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      // Test against package sources so tests never depend on a prior build.
      '@vue-player/core': resolve(__dirname, 'packages/core/src/index.ts'),
      '@vue-player/vue': resolve(__dirname, 'packages/vue/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
  },
})
