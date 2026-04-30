import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createComment, updateThreadStatus, updateCommentContent, deleteComment } from '../ado-api/comments'
import { AdoClient } from '../ado-api/client'

const threadResult = (threadId: number, commentId: number) => ({
    id: threadId,
    comments: [{
        id: commentId,
        author: { displayName: 'Build Service' },
        publishedDate: '2024-01-15T12:00:00Z',
    }],
})

describe('createComment', () => {
    let client: AdoClient

    beforeEach(() => {
        client = new AdoClient({ collectionUri: 'https://dev.azure.com/org', project: 'P', token: 'tok', authType: 'Bearer' })
    })

    it('creates a new generic comment thread', async () => {
        vi.spyOn(client, 'post').mockResolvedValue(threadResult(10, 1))

        const result = await createComment(client, 'MyRepo', 42, { comment: 'Good change' })

        expect(result).toEqual({
            threadId: 10,
            commentId: 1,
            author: 'Build Service',
            publishedDate: '2024-01-15T12:00:00Z',
        })
    })

    it('creates an inline comment with thread context', async () => {
        const postSpy = vi.spyOn(client, 'post').mockResolvedValue(threadResult(11, 2))

        await createComment(client, 'MyRepo', 42, {
            comment: 'Inline note',
            filePath: 'src/index.ts',
            startLine: 5,
            iterationId: 1,
        })

        const body = postSpy.mock.calls[0][1] as Record<string, unknown>
        expect(body['threadContext']).toBeDefined()
        expect((body['threadContext'] as any).filePath).toBe('/src/index.ts')
    })

    it('normalizes file path to start with /', async () => {
        const postSpy = vi.spyOn(client, 'post').mockResolvedValue(threadResult(12, 3))

        await createComment(client, 'MyRepo', 42, {
            comment: 'Note',
            filePath: 'src/file.ts',
            startLine: 10,
        })

        const body = postSpy.mock.calls[0][1] as Record<string, unknown>
        expect((body['threadContext'] as any).filePath).toBe('/src/file.ts')
    })

    it('normalizes Windows backslash paths', async () => {
        const postSpy = vi.spyOn(client, 'post').mockResolvedValue(threadResult(13, 4))

        await createComment(client, 'MyRepo', 42, {
            comment: 'Note',
            filePath: 'src\\file.ts',
            startLine: 1,
        })

        const body = postSpy.mock.calls[0][1] as Record<string, unknown>
        expect((body['threadContext'] as any).filePath).toBe('/src/file.ts')
    })

    it('replies to existing thread when threadId is provided', async () => {
        const postSpy = vi.spyOn(client, 'post').mockResolvedValue({
            id: 99,
            author: { displayName: 'Build Service' },
            publishedDate: '2024-01-15T12:00:00Z',
        })

        const result = await createComment(client, 'MyRepo', 42, {
            comment: 'Reply',
            threadId: 10,
        })

        expect(result.threadId).toBe(10)
        expect(result.commentId).toBe(99)
        const url = postSpy.mock.calls[0][0] as string
        expect(url).toContain('/threads/10/comments')
    })

    it('falls back to generic comment when inline comment fails', async () => {
        vi.spyOn(client, 'post')
            .mockRejectedValueOnce(new Error('Inline failed'))
            .mockResolvedValueOnce(threadResult(14, 5))

        const result = await createComment(client, 'MyRepo', 42, {
            comment: 'Note',
            filePath: 'src/file.ts',
            startLine: 5,
        })

        expect(result.threadId).toBe(14)
    })
})

describe('updateThreadStatus', () => {
    let client: AdoClient

    beforeEach(() => {
        client = new AdoClient({ collectionUri: 'https://dev.azure.com/org', project: 'P', token: 'tok', authType: 'Bearer' })
    })

    it('patches thread with mapped api status', async () => {
        const patchSpy = vi.spyOn(client, 'patch').mockResolvedValue({})

        await updateThreadStatus(client, 'MyRepo', 42, 101, 'Fixed')

        expect(patchSpy).toHaveBeenCalledWith(
            expect.stringContaining('/threads/101'),
            { status: 'fixed' }
        )
    })

    it('uses fixed as fallback for unknown status', async () => {
        const patchSpy = vi.spyOn(client, 'patch').mockResolvedValue({})

        await updateThreadStatus(client, 'MyRepo', 42, 101, 'UnknownStatus')

        expect(patchSpy).toHaveBeenCalledWith(expect.any(String), { status: 'fixed' })
    })

    it('swallows errors silently', async () => {
        vi.spyOn(client, 'patch').mockRejectedValue(new Error('Network error'))

        await expect(updateThreadStatus(client, 'MyRepo', 42, 101, 'Fixed')).resolves.toBeUndefined()
    })
})

describe('updateCommentContent', () => {
    let client: AdoClient

    beforeEach(() => {
        client = new AdoClient({ collectionUri: 'https://dev.azure.com/org', project: 'P', token: 'tok', authType: 'Bearer' })
    })

    it('patches comment with new content', async () => {
        const patchSpy = vi.spyOn(client, 'patch').mockResolvedValue({})

        await updateCommentContent(client, 'MyRepo', 42, 101, 1, 'Updated content')

        expect(patchSpy).toHaveBeenCalledWith(
            expect.stringContaining('/threads/101/comments/1'),
            { content: 'Updated content' }
        )
    })

    it('swallows errors silently', async () => {
        vi.spyOn(client, 'patch').mockRejectedValue(new Error('API error'))

        await expect(updateCommentContent(client, 'MyRepo', 42, 101, 1, 'text')).resolves.toBeUndefined()
    })
})

describe('deleteComment', () => {
    let client: AdoClient

    beforeEach(() => {
        client = new AdoClient({ collectionUri: 'https://dev.azure.com/org', project: 'P', token: 'tok', authType: 'Bearer' })
    })

    it('calls delete on correct URL', async () => {
        const deleteSpy = vi.spyOn(client, 'delete').mockResolvedValue()

        await deleteComment(client, 'MyRepo', 42, 101, 1)

        expect(deleteSpy).toHaveBeenCalledWith(expect.stringContaining('/threads/101/comments/1'))
    })

    it('swallows errors silently', async () => {
        vi.spyOn(client, 'delete').mockRejectedValue(new Error('Not found'))

        await expect(deleteComment(client, 'MyRepo', 42, 101, 1)).resolves.toBeUndefined()
    })
})
