import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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
        // refreshPathAfterInstall calls execFileSync(powershell...) on Windows
        // after a successful install — return a benign empty string so the
        // PATH-merge runs cleanly without console-noise warnings.
        vi.mocked(cp.execFileSync).mockReturnValue('' as any)
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

describe('PATH refresh after install', () => {
    const originalPath = process.env['PATH']
    const originalPlatform = process.platform

    beforeEach(() => {
        vi.resetAllMocks()
    })

    afterEach(() => {
        process.env['PATH'] = originalPath
        Object.defineProperty(process, 'platform', { value: originalPlatform })
    })

    it('on Windows, merges new registry PATH entries without clobbering existing PATH', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32' })
        process.env['PATH'] = 'C:\\existing;C:\\Windows'
        const registryReturn = 'C:\\Windows;C:\\Program Files\\GitHub Copilot CLI'
        vi.mocked(cp.execFileSync).mockReturnValue(registryReturn as any)
        vi.mocked(cp.spawn).mockReturnValue(makeMockProcess(0) as any)

        await installCopilotCli()

        expect(process.env['PATH']).toContain('C:\\existing')
        expect(process.env['PATH']).toContain('C:\\Program Files\\GitHub Copilot CLI')
        // C:\Windows already existed — must not be duplicated
        const occurrences = process.env['PATH']!.split(';').filter(p => p.toLowerCase() === 'c:\\windows').length
        expect(occurrences).toBe(1)
    })

    it('on Windows, leaves PATH unchanged when registry has no new entries', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32' })
        process.env['PATH'] = 'C:\\Windows;C:\\existing'
        vi.mocked(cp.execFileSync).mockReturnValue('C:\\Windows;C:\\existing' as any)
        vi.mocked(cp.spawn).mockReturnValue(makeMockProcess(0) as any)

        await installCopilotCli()

        expect(process.env['PATH']).toBe('C:\\Windows;C:\\existing')
    })

    it('on Windows, swallows powershell failure and keeps PATH unchanged', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32' })
        process.env['PATH'] = 'C:\\Windows'
        vi.mocked(cp.execFileSync).mockImplementation(() => { throw new Error('powershell missing') })
        vi.mocked(cp.spawn).mockReturnValue(makeMockProcess(0) as any)

        await expect(installCopilotCli()).resolves.toBeUndefined()
        expect(process.env['PATH']).toBe('C:\\Windows')
    })

    it('on non-Windows, prepends ~/.local/bin to PATH', async () => {
        Object.defineProperty(process, 'platform', { value: 'linux' })
        process.env['HOME'] = '/home/agent'
        const originalAgentPath = '/usr/bin:/bin'
        process.env['PATH'] = originalAgentPath
        vi.mocked(cp.spawn).mockReturnValue(makeMockProcess(0) as any)

        await installCopilotCli()

        // path.join + path.delimiter resolve per the host OS, so just assert
        // that ~/.local/bin (in some form) was prepended to the original PATH.
        expect(process.env['PATH']).toContain('.local')
        expect(process.env['PATH']).toContain('bin')
        expect(process.env['PATH']!.endsWith(originalAgentPath)).toBe(true)
    })
})
