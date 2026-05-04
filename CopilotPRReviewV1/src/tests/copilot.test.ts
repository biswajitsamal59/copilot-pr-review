import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import * as cp from 'node:child_process'
import * as fs from 'node:fs'

vi.mock('node:child_process', () => ({
    spawn: vi.fn(),
}))

vi.mock('node:fs', () => ({
    default: { readFileSync: vi.fn() },
    readFileSync: vi.fn(),
}))

const { runCopilotCli } = await import('../agents/copilot')

function makeMockProcess(exitCode = 0, error?: Error) {
    const proc = new EventEmitter() as any
    proc.kill = vi.fn()
    proc.stdin = null

    process.nextTick(() => {
        if (error) proc.emit('error', error)
        else proc.emit('close', exitCode)
    })

    return proc
}

describe('runCopilotCli', () => {
    beforeEach(() => {
        vi.resetAllMocks()
    })

    it('resolves when copilot exits with code 0', async () => {
        vi.mocked(fs.readFileSync).mockReturnValue('prompt text' as any)
        vi.mocked(cp.spawn).mockReturnValue(makeMockProcess(0) as any)

        await expect(runCopilotCli('/tmp/prompt.txt', undefined, '/workdir', 60000)).resolves.toBeUndefined()
    })

    it('rejects when copilot exits with non-zero code', async () => {
        vi.mocked(fs.readFileSync).mockReturnValue('prompt text' as any)
        vi.mocked(cp.spawn).mockReturnValue(makeMockProcess(1) as any)

        await expect(runCopilotCli('/tmp/prompt.txt', undefined, '/workdir', 60000)).rejects.toThrow('code: 1')
    })

    it('rejects when spawn emits an error event', async () => {
        vi.mocked(fs.readFileSync).mockReturnValue('prompt text' as any)
        vi.mocked(cp.spawn).mockReturnValue(makeMockProcess(0, new Error('spawn ENOENT')) as any)

        await expect(runCopilotCli('/tmp/prompt.txt', undefined, '/workdir', 60000)).rejects.toThrow('spawn ENOENT')
    })

    it('passes prompt content as the -p argument', async () => {
        vi.mocked(fs.readFileSync).mockReturnValue('my prompt' as any)
        vi.mocked(cp.spawn).mockReturnValue(makeMockProcess(0) as any)

        await runCopilotCli('/tmp/prompt.txt', undefined, '/workdir', 60000)

        const args = vi.mocked(cp.spawn).mock.calls[0][1] as string[]
        const pIndex = args.indexOf('-p')
        expect(pIndex).toBeGreaterThanOrEqual(0)
        expect(args[pIndex + 1]).toBe('my prompt')
    })

    it('appends --model flag when model is specified', async () => {
        vi.mocked(fs.readFileSync).mockReturnValue('prompt' as any)
        vi.mocked(cp.spawn).mockReturnValue(makeMockProcess(0) as any)

        await runCopilotCli('/tmp/prompt.txt', 'gpt-4o', '/workdir', 60000)

        const args = vi.mocked(cp.spawn).mock.calls[0][1] as string[]
        expect(args).toContain('--model')
        expect(args[args.indexOf('--model') + 1]).toBe('gpt-4o')
    })

    it('does not include --model when model is undefined', async () => {
        vi.mocked(fs.readFileSync).mockReturnValue('prompt' as any)
        vi.mocked(cp.spawn).mockReturnValue(makeMockProcess(0) as any)

        await runCopilotCli('/tmp/prompt.txt', undefined, '/workdir', 60000)

        const args = vi.mocked(cp.spawn).mock.calls[0][1] as string[]
        expect(args).not.toContain('--model')
    })

    it('kills the process and rejects on timeout', async () => {
        vi.useFakeTimers()
        vi.mocked(fs.readFileSync).mockReturnValue('prompt' as any)

        const proc = new EventEmitter() as any
        proc.kill = vi.fn()
        proc.stdin = null
        vi.mocked(cp.spawn).mockReturnValue(proc as any)

        const runPromise = runCopilotCli('/tmp/prompt.txt', undefined, '/workdir', 5000)
        // Attach a no-op catch immediately so Node doesn't flag an unhandled rejection
        // while we advance time before the assertion below.
        runPromise.catch(() => undefined)

        vi.advanceTimersByTime(5001)
        await vi.runAllTimersAsync()

        await expect(runPromise).rejects.toThrow('timed out')
        expect(proc.kill).toHaveBeenCalledWith('SIGTERM')

        vi.useRealTimers()
    })

    it('spawns with shell: false and correct cwd', async () => {
        vi.mocked(fs.readFileSync).mockReturnValue('prompt' as any)
        vi.mocked(cp.spawn).mockReturnValue(makeMockProcess(0) as any)

        await runCopilotCli('/tmp/prompt.txt', undefined, '/my/workdir', 60000)

        const spawnOpts = vi.mocked(cp.spawn).mock.calls[0][2] as any
        expect(spawnOpts.shell).toBe(false)
        expect(spawnOpts.cwd).toBe('/my/workdir')
    })

    it('includes --deny-tool shell(git push) in args', async () => {
        vi.mocked(fs.readFileSync).mockReturnValue('prompt' as any)
        vi.mocked(cp.spawn).mockReturnValue(makeMockProcess(0) as any)

        await runCopilotCli('/tmp/prompt.txt', undefined, '/workdir', 60000)

        const args = vi.mocked(cp.spawn).mock.calls[0][1] as string[]
        const denyIndex = args.indexOf('--deny-tool')
        expect(denyIndex).toBeGreaterThanOrEqual(0)
        expect(args[denyIndex + 1]).toContain('git push')
    })
})
