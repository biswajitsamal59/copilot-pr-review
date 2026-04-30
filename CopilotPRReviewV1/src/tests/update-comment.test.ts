import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
    parseArgs: vi.fn(),
    loadAdoEnv: vi.fn(),
    updateThreadStatus: vi.fn(),
    updateCommentContent: vi.fn(),
}))

vi.mock('../utils/args', () => ({
    parseArgs: mocks.parseArgs,
    loadAdoEnv: mocks.loadAdoEnv,
}))

vi.mock('../ado-api/comments', () => ({
    updateThreadStatus: mocks.updateThreadStatus,
    updateCommentContent: mocks.updateCommentContent,
}))

vi.mock('../ado-api/client', () => ({
    AdoClient: vi.fn().mockImplementation(() => ({})),
}))

async function runScript() {
    vi.resetModules()
    await import('../scripts/update-comment')
    await new Promise(resolve => setTimeout(resolve, 0))
}

const validEnv = {
    token: 'tok',
    authType: 'Bearer' as const,
    collectionUri: 'https://dev.azure.com/org',
    project: 'MyProject',
    repository: 'MyRepo',
    prId: '42',
}

describe('update-comment script', () => {
    beforeEach(() => {
        vi.resetAllMocks()
        // update-comment always exits 0 via .finally() — mock to avoid actual exit
        vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
        vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        vi.spyOn(console, 'log').mockImplementation(() => undefined)
    })

    it('warns and exits 0 without calling APIs when --thread-id is missing', async () => {
        mocks.parseArgs.mockReturnValue({})

        await runScript()

        expect(mocks.updateThreadStatus).not.toHaveBeenCalled()
        expect(process.exit).toHaveBeenCalledWith(0)
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('--thread-id is required'))
    })

    it('returns early without calling APIs when env vars are missing', async () => {
        mocks.parseArgs.mockReturnValue({ threadId: '101' })
        mocks.loadAdoEnv.mockReturnValue(null)

        await runScript()

        expect(mocks.updateThreadStatus).not.toHaveBeenCalled()
        expect(process.exit).toHaveBeenCalledWith(0)
    })

    it('calls updateThreadStatus with correct args on happy path', async () => {
        mocks.parseArgs.mockReturnValue({ threadId: '101', status: 'Fixed' })
        mocks.loadAdoEnv.mockReturnValue(validEnv)
        mocks.updateThreadStatus.mockResolvedValue(undefined)

        await runScript()

        expect(mocks.updateThreadStatus).toHaveBeenCalledWith(
            expect.anything(),
            'MyRepo',
            42,
            101,
            'Fixed'
        )
        expect(process.exit).toHaveBeenCalledWith(0)
    })

    it('defaults status to Fixed when not provided', async () => {
        mocks.parseArgs.mockReturnValue({ threadId: '101' })
        mocks.loadAdoEnv.mockReturnValue(validEnv)
        mocks.updateThreadStatus.mockResolvedValue(undefined)

        await runScript()

        expect(mocks.updateThreadStatus).toHaveBeenCalledWith(
            expect.anything(),
            expect.any(String),
            expect.any(Number),
            101,
            'Fixed'
        )
    })

    it('also calls updateCommentContent when --content and --comment-id are provided', async () => {
        mocks.parseArgs.mockReturnValue({
            threadId: '101',
            status: 'Active',
            commentId: '5',
            content: 'Updated text',
        })
        mocks.loadAdoEnv.mockReturnValue(validEnv)
        mocks.updateThreadStatus.mockResolvedValue(undefined)
        mocks.updateCommentContent.mockResolvedValue(undefined)

        await runScript()

        expect(mocks.updateCommentContent).toHaveBeenCalledWith(
            expect.anything(),
            'MyRepo',
            42,
            101,
            5,
            'Updated text'
        )
    })

    it('does not call updateCommentContent when --comment-id is missing', async () => {
        mocks.parseArgs.mockReturnValue({ threadId: '101', content: 'text' })
        mocks.loadAdoEnv.mockReturnValue(validEnv)
        mocks.updateThreadStatus.mockResolvedValue(undefined)

        await runScript()

        expect(mocks.updateCommentContent).not.toHaveBeenCalled()
    })

    it('exits 0 (silently) even when updateThreadStatus throws', async () => {
        mocks.parseArgs.mockReturnValue({ threadId: '101' })
        mocks.loadAdoEnv.mockReturnValue(validEnv)
        mocks.updateThreadStatus.mockRejectedValue(new Error('network error'))

        await runScript()

        expect(process.exit).toHaveBeenCalledWith(0)
    })
})
