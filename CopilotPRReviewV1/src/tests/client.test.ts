import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AdoClient } from '../ado-api/client'

function makeResponse(body: unknown, status = 200): Response {
    const text = typeof body === 'string' ? body : JSON.stringify(body)
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => text,
        headers: { get: () => null },
    } as unknown as Response
}

describe('AdoClient', () => {
    const bearerClient = new AdoClient({
        collectionUri: 'https://dev.azure.com/myorg/',
        project: 'MyProject',
        token: 'my-token',
        authType: 'Bearer',
    })

    const basicClient = new AdoClient({
        collectionUri: 'https://dev.azure.com/myorg',
        project: 'MyProject',
        token: 'my-pat',
        authType: 'Basic',
    })

    beforeEach(() => {
        vi.restoreAllMocks()
    })

    it('constructs Bearer Authorization header correctly', async () => {
        const fetchStub = vi.spyOn(global, 'fetch').mockResolvedValue(makeResponse({ value: [] }))

        await bearerClient.get('/some-path')

        const headers = (fetchStub.mock.calls[0][1] as RequestInit).headers as Record<string, string>
        expect(headers['Authorization']).toBe('Bearer my-token')
    })

    it('constructs Basic Authorization header with base64-encoded :token', async () => {
        const fetchStub = vi.spyOn(global, 'fetch').mockResolvedValue(makeResponse({ value: [] }))

        await basicClient.get('/some-path')

        const headers = (fetchStub.mock.calls[0][1] as RequestInit).headers as Record<string, string>
        const expected = `Basic ${Buffer.from(':my-pat').toString('base64')}`
        expect(headers['Authorization']).toBe(expected)
    })

    it('appends api-version query param to URLs that lack it', async () => {
        const fetchStub = vi.spyOn(global, 'fetch').mockResolvedValue(makeResponse({}))

        await bearerClient.get('git/repositories/MyRepo/pullrequests/1')

        const url = fetchStub.mock.calls[0][0] as string
        expect(url).toContain('api-version=7.1')
    })

    it('does not duplicate api-version when already present', async () => {
        const fetchStub = vi.spyOn(global, 'fetch').mockResolvedValue(makeResponse({}))

        await bearerClient.get('git/repositories/MyRepo/pullrequests/1?api-version=6.0')

        const url = fetchStub.mock.calls[0][0] as string
        expect(url.split('api-version').length).toBe(2) // only one occurrence
    })

    it('parses JSON response body on success', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(makeResponse({ pullRequestId: 42 }))

        const result = await bearerClient.get<{ pullRequestId: number }>('some-path')
        expect(result.pullRequestId).toBe(42)
    })

    it('returns raw text when accept is not application/json', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(makeResponse('raw text content'))

        const result = await bearerClient.getRawText('https://raw.example.com/file.txt')
        expect(result).toBe('raw text content')
    })

    it('throws descriptive error on 401', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(makeResponse({ message: 'Unauthorized' }, 401))

        await expect(bearerClient.get('/path')).rejects.toThrow('Authentication failed')
    })

    it('throws descriptive error on 404', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(makeResponse({ message: 'Not found' }, 404))

        await expect(bearerClient.get('/path')).rejects.toThrow('Resource not found')
    })

    it('throws generic error for other 4xx/5xx codes', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(makeResponse({ message: 'Server error' }, 500))

        await expect(bearerClient.get('/path')).rejects.toThrow('HTTP 500')
    })

    it('sends POST with JSON body and Content-Type header', async () => {
        const fetchStub = vi.spyOn(global, 'fetch').mockResolvedValue(makeResponse({ id: 1, comments: [{ id: 1, author: { displayName: 'A' }, publishedDate: '' }] }))

        await bearerClient.post('/threads', { status: 1 })

        const init = fetchStub.mock.calls[0][1] as RequestInit
        expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
        expect(init.body).toBe(JSON.stringify({ status: 1 }))
    })

    it('sends PATCH with JSON body', async () => {
        const fetchStub = vi.spyOn(global, 'fetch').mockResolvedValue(makeResponse({}))

        await bearerClient.patch('/threads/1', { status: 'fixed' })

        const init = fetchStub.mock.calls[0][1] as RequestInit
        expect(init.method).toBe('PATCH')
    })

    it('sends DELETE request', async () => {
        const fetchStub = vi.spyOn(global, 'fetch').mockResolvedValue(makeResponse(''))

        await bearerClient.delete('/threads/1/comments/1')

        expect(fetchStub.mock.calls[0][1]).toMatchObject({ method: 'DELETE' })
    })

    it('handles empty response body for non-JSON accepts', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(makeResponse(''))

        const result = await bearerClient.get<string>('some-path')
        expect(result).toBe('')
    })

    it('getCollectionUri strips trailing slash', () => {
        expect(bearerClient.getCollectionUri()).toBe('https://dev.azure.com/myorg')
    })

    it('getProject returns project name', () => {
        expect(bearerClient.getProject()).toBe('MyProject')
    })

    it('uses absolute URL as-is when path starts with http', async () => {
        const fetchStub = vi.spyOn(global, 'fetch').mockResolvedValue(makeResponse('content'))

        await bearerClient.getRawText('https://absolute.example.com/file')

        expect(fetchStub.mock.calls[0][0] as string).toContain('absolute.example.com')
    })
})
