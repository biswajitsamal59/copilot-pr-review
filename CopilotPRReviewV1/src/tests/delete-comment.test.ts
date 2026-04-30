import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
    parseArgs: vi.fn(),
    loadAdoEnv: vi.fn(),
    deleteComment: vi.fn(),
}))

vi.mock('../utils/args', () => ({
    parseArgs: mocks.parseArgs,
    loadAdoEnv: mocks.loadAdoEnv,
}))

vi.mock('../ado-api/comments', () => ({
    deleteComment: mocks.deleteComment,
}))

vi.mock('../ado-api/client', () => ({
    AdoClient: vi.fn().mockImplementation(() => ({})),
}))

async function runScript() {
    vi.resetModules()
    await import('../scripts/delete-comment')
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

describe('delete-comment script', () => {
    beforeEach(() => {
        vi.resetAllMocks()
        // delete-comment always exits 0 via .finally() — mock to avoid actual exit
        vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
        vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        vi.spyOn(console, 'log').mockImplementation(() => undefined)
    })

    it('warns and exits 0 when --thread-id is missing', async () => {
        mocks.parseArgs.mockReturnValue({ commentId: '1' })

        await runScript()

        expect(mocks.deleteComment).not.toHaveBeenCalled()
        expect(process.exit).toHaveBeenCalledWith(0)
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('--thread-id and --comment-id are required'))
    })

    it('warns and exits 0 when --comment-id is missing', async () => {
        mocks.parseArgs.mockReturnValue({ threadId: '101' })

        await runScript()

        expect(mocks.deleteComment).not.toHaveBeenCalled()
        expect(process.exit).toHaveBeenCalledWith(0)
    })

    it('returns early without calling API when env vars are missing', async () => {
        mocks.parseArgs.mockReturnValue({ threadId: '101', commentId: '5' })
        mocks.loadAdoEnv.mockReturnValue(null)

        await runScript()

        expect(mocks.deleteComment).not.toHaveBeenCalled()
        expect(process.exit).toHaveBeenCalledWith(0)
    })

    it('calls deleteComment with correct args on happy path', async () => {
        mocks.parseArgs.mockReturnValue({ threadId: '101', commentId: '5' })
        mocks.loadAdoEnv.mockReturnValue(validEnv)
        mocks.deleteComment.mockResolvedValue(undefined)

        await runScript()

        expect(mocks.deleteComment).toHaveBeenCalledWith(
            expect.anything(),
            'MyRepo',
            42,
            101,
            5
        )
        expect(process.exit).toHaveBeenCalledWith(0)
    })

    it('exits 0 (silently) even when deleteComment throws', async () => {
        mocks.parseArgs.mockReturnValue({ threadId: '101', commentId: '5' })
        mocks.loadAdoEnv.mockReturnValue(validEnv)
        mocks.deleteComment.mockRejectedValue(new Error('not found'))

        await runScript()

        expect(process.exit).toHaveBeenCalledWith(0)
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('not found'))
    })

    it('parses threadId and commentId as integers', async () => {
        mocks.parseArgs.mockReturnValue({ threadId: '200', commentId: '10' })
        mocks.loadAdoEnv.mockReturnValue(validEnv)
        mocks.deleteComment.mockResolvedValue(undefined)

        await runScript()

        const [, , , threadId, commentId] = mocks.deleteComment.mock.calls[0]
        expect(threadId).toBe(200)
        expect(commentId).toBe(10)
    })
})
