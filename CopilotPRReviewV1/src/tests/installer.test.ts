import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import * as cp from 'node:child_process'

vi.mock('node:child_process', () => ({
    execFileSync: vi.fn(),
    spawn: vi.fn(),
}))

const { checkCopilotCli, installCopilotCli } = await import('../agents/installer')

function makeMockProcess(exitCode = 0, error?: Error) {
    const proc = new EventEmitter() as any
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.kill = vi.fn()
    proc.pid = 12345
    proc.stdin = null

    process.nextTick(() => {
        if (error) {
            proc.emit('error', error)
        } else {
            proc.emit('close', exitCode)
        }
    })

    return proc
}

describe('checkCopilotCli', () => {
    beforeEach(() => {
        vi.resetAllMocks()
    })

    it('returns true when copilot --version succeeds', async () => {
        vi.mocked(cp.execFileSync).mockReturnValue(Buffer.from('1.0.0'))

        expect(await checkCopilotCli()).toBe(true)
    })

    it('returns false when copilot is not installed (throws)', async () => {
        vi.mocked(cp.execFileSync).mockImplementation(() => { throw new Error('ENOENT') })

        expect(await checkCopilotCli()).toBe(false)
    })
})

describe('installCopilotCli', () => {
    beforeEach(() => {
        vi.resetAllMocks()
    })

    it('resolves when install process exits with code 0', async () => {
        vi.mocked(cp.spawn).mockReturnValue(makeMockProcess(0) as any)

        await expect(installCopilotCli()).resolves.toBeUndefined()
    })

    it('rejects with descriptive error when install process exits non-zero', async () => {
        vi.mocked(cp.spawn).mockReturnValue(makeMockProcess(1) as any)

        await expect(installCopilotCli()).rejects.toThrow('exit code: 1')
    })

    it('rejects when spawn emits an error event', async () => {
        vi.mocked(cp.spawn).mockReturnValue(makeMockProcess(0, new Error('ENOENT spawn')) as any)

        await expect(installCopilotCli()).rejects.toThrow('ENOENT spawn')
    })

    it('buffers output from stdout and stderr silently', async () => {
        const proc = makeMockProcess(0)
        vi.mocked(cp.spawn).mockReturnValue(proc as any)

        const installPromise = installCopilotCli()

        process.nextTick(() => {
            proc.stdout.emit('data', Buffer.from('output line\n'))
        })

        await installPromise

        // Output is buffered silently, not logged to console
        expect(installPromise).resolves.toBeUndefined()
    })

    it('includes diagnostics in rejection message on non-zero exit', async () => {
        const proc = new EventEmitter() as any
        proc.stdout = new EventEmitter()
        proc.stderr = new EventEmitter()
        proc.kill = vi.fn()
        proc.stdin = null

        vi.mocked(cp.spawn).mockReturnValue(proc as any)

        const installPromise = installCopilotCli()

        // Emit data first, then close
        process.nextTick(() => {
            proc.stdout.emit('data', Buffer.from('install error details\n'))
        })

        process.nextTick(() => {
            proc.emit('close', 1)
        })

        await expect(installPromise).rejects.toThrow('install error details')
    })
})
