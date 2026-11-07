import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import type { Session, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createAuthMiddleware } from '../middleware/auth'
import { createGitRoutes } from './git'

const JWT_SECRET = new TextEncoder().encode('generated-media-route-test')

async function authHeaders(namespace: string): Promise<{ authorization: string }> {
    const token = await new SignJWT({ uid: 1, ns: namespace })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(JWT_SECRET)
    return { authorization: `Bearer ${token}` }
}

function buildApp(engine: Partial<SyncEngine>): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', 'default')
        await next()
    })
    app.route('/api', createGitRoutes(() => engine as SyncEngine))
    return app
}

function buildAuthenticatedApp(engine: Partial<SyncEngine>): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    app.use('*', createAuthMiddleware(JWT_SECRET))
    app.route('/api', createGitRoutes(() => engine as SyncEngine))
    return app
}

describe('session file route', () => {
    it('forwards an optimistic file write to the session RPC', async () => {
        const session = { id: 'session-1', namespace: 'default', active: true } as unknown as Session
        const calls: unknown[][] = []
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            writeSessionFile: async (...args: unknown[]) => {
                calls.push(args)
                return { success: true, hash: 'b'.repeat(64) }
            }
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request('/api/sessions/session-1/file', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                path: 'README.md',
                content: Buffer.from('# updated').toString('base64'),
                expectedHash: 'a'.repeat(64)
            })
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ success: true, hash: 'b'.repeat(64) })
        expect(calls).toEqual([[
            'session-1',
            'README.md',
            Buffer.from('# updated').toString('base64'),
            'a'.repeat(64)
        ]])
    })

    it('rejects a write without a content hash', async () => {
        const session = { id: 'session-1', namespace: 'default', active: true } as unknown as Session
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session })
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request('/api/sessions/session-1/file', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: 'README.md', content: 'dGVzdA==' })
        })

        expect(response.status).toBe(400)
    })
})

describe('session file search route', () => {
    // Use the same bundled ripgrep as the CLI when it is not installed on PATH.
    const ripgrep = Bun.which('rg') ?? fileURLToPath(new URL(
        `../../../../cli/tools/unpacked/${process.platform === 'win32' ? 'rg.exe' : 'rg'}`,
        import.meta.url
    ))

    async function searchFiles(sessionPath: string, query: string, fileNames: string[]) {
        const workspace = mkdtempSync(join(tmpdir(), 'hapi-file-search-'))
        const session = {
            id: 'session-search', namespace: 'default', active: true, metadata: { path: sessionPath }
        } as unknown as Session
        const engine: Partial<SyncEngine> = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: session.id, session }),
            runRipgrep: async (sessionId, args, cwd) => {
                expect(sessionId).toBe(session.id)
                expect(cwd).toBe(sessionPath)
                // The fixture stands in for the remote session filesystem, but glob
                // matching and file enumeration are performed by the real CLI tool.
                const result = spawnSync(ripgrep, [...args, '--path-separator', '/'], {
                    cwd: workspace,
                    encoding: 'utf8',
                    windowsHide: true
                })
                if (result.error) throw result.error
                return { success: result.status === 0 || result.status === 1, stdout: result.stdout, stderr: result.stderr }
            }
        }

        try {
            for (const name of fileNames) {
                const parts = name.split('/')
                mkdirSync(join(workspace, ...parts.slice(0, -1)), { recursive: true })
                writeFileSync(join(workspace, ...parts), 'search fixture')
            }
            const response = await buildApp(engine).request(
                `/api/sessions/${session.id}/files?${new URLSearchParams({ query })}`
            )
            expect(response.status).toBe(200)
            return await response.json()
        } finally {
            rmSync(workspace, { recursive: true, force: true })
        }
    }

    for (const sessionPath of ['C:\\work\\project', 'c:/work/project', '\\\\server\\share\\project', '//server/share/project']) {
        it(`finds files using a backslash query for Windows session ${sessionPath}`, async () => {
            expect(await searchFiles(sessionPath, 'src\\needle', ['src/needle.ts', 'src/other.ts'])).toEqual({
                success: true,
                files: [{ fileName: 'needle.ts', filePath: 'src', fullPath: 'src/needle.ts', fileType: 'file' }]
            })
        })
    }

    for (const sessionPath of ['/work/project', 'C:relative']) {
        it(`preserves glob escapes rather than treating ${sessionPath} as an absolute Windows path`, async () => {
            expect(await searchFiles(sessionPath, String.raw`src/\[literal\].ts`, ['src/[literal].ts', 'src/l.ts'])).toEqual({
                success: true,
                files: [{ fileName: '[literal].ts', filePath: 'src', fullPath: 'src/[literal].ts', fileType: 'file' }]
            })
        })
    }

    it.skipIf(process.platform === 'win32')('preserves a query matching a legal POSIX filename containing a backslash', async () => {
        expect(await searchFiles('/work/project', String.raw`notes\\draft`, ['notes\\draft.txt', 'notes/draft.txt'])).toEqual({
            success: true,
            files: [{ fileName: 'notes\\draft.txt', filePath: '', fullPath: 'notes\\draft.txt', fileType: 'file' }]
        })
    })
})

describe('generated images route', () => {
    it('serves generated images with an immutable cache header instead of no-store', async () => {
        const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        const session = { id: 'session-1', namespace: 'default', active: true } as unknown as Session
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            readGeneratedImage: async () => ({
                success: true,
                content: pngBytes.toString('base64'),
                mimeType: 'image/png',
                fileName: 'shot.png'
            })
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request('/api/sessions/session-1/generated-images/img-1')

        expect(response.status).toBe(200)
        const cacheControl = response.headers.get('cache-control') ?? ''
        // Generated images are content-addressed by an immutable random id, so they must be
        // cacheable; `no-store` forces a full RPC round-trip on every remount (issue #927).
        expect(cacheControl).toContain('immutable')
        expect(cacheControl).not.toContain('no-store')
        expect(response.headers.get('etag')).toBe('"img-1"')
    })

    it('returns 304 without an RPC round-trip when If-None-Match matches', async () => {
        const session = { id: 'session-1', namespace: 'default', active: true } as unknown as Session
        let rpcCalls = 0
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            readGeneratedImage: async () => {
                rpcCalls += 1
                return { success: true, content: '', mimeType: 'image/png', fileName: 'shot.png' }
            }
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request('/api/sessions/session-1/generated-images/img-1', {
            headers: { 'if-none-match': '"img-1"' }
        })

        expect(response.status).toBe(304)
        // The whole point: a cache hit must not touch the CLI over the socket.
        expect(rpcCalls).toBe(0)
    })

    it('serves registered MP4 bytes with their video MIME type', async () => {
        const mp4Bytes = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])
        const session = { id: 'session-1', namespace: 'default', active: true } as unknown as Session
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            readGeneratedImage: async () => ({
                success: true,
                content: mp4Bytes.toString('base64'),
                mimeType: 'video/mp4',
                fileName: 'recording.mp4'
            })
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request('/api/sessions/session-1/generated-images/video-1')

        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('video/mp4')
        expect(Buffer.from(await response.arrayBuffer())).toEqual(mp4Bytes)
    })

    it('requires JWT auth and enforces namespace-scoped session access', async () => {
        const engine = {
            resolveSessionAccess: (_sessionId: string, namespace: string) => namespace === 'owner'
                ? {
                    ok: true as const,
                    sessionId: 'session-1',
                    session: { id: 'session-1', namespace: 'owner', active: true } as unknown as Session
                }
                : { ok: false as const, reason: 'access-denied' as const }
        } as unknown as Partial<SyncEngine>
        const app = buildAuthenticatedApp(engine)

        const missingAuth = await app.request('/api/sessions/session-1/generated-images/img-1')
        const wrongNamespace = await app.request('/api/sessions/session-1/generated-images/img-1', {
            headers: await authHeaders('other')
        })

        expect(missingAuth.status).toBe(401)
        expect(wrongNamespace.status).toBe(403)
    })
})
