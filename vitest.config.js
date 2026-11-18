import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'url';

export default defineConfig({
    resolve: {
        alias: {
            // src/processor.js imports the bare specifier 'libadlmidi-wasm',
            // which the production bundler (bundle.js) swaps for a profile
            // build. In Node tests without an Emscripten-built WASM artifact,
            // resolve it to the in-JS mock that models the C API.
            'libadlmidi-wasm': fileURLToPath(
                new URL('./tests/node/helpers/mock-wasm.js', import.meta.url)
            ),
        },
    },
    test: {
        // Default to Node tests only
        include: ['tests/node/**/*.test.js'],

        // Longer timeout for WASM operations
        testTimeout: 30000,

        // Run tests sequentially to avoid WASM conflicts
        isolate: false
    }
});
