import { defineConfig } from 'vitest/config'

export default defineConfig({
    test: {
        environment: 'node',
        include: ['src/tests/**/*.test.ts'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'lcov', 'html'],
            include: ['src/**/*.ts'],
            // pr-context.ts orchestrates all the other modules, so excluded it from coverage
            exclude: ['src/tests/**', 'src/index.ts', 'src/context/pr-context.ts'],
        },
    },
})
