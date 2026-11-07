import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, parse, relative } from 'node:path'

const ioMock = vi.hoisted(() => vi.fn())
const listOpencodeModelsForCwdMock = vi.hoisted(() => vi.fn())

vi.mock('socket.io-client', () => ({
    io: ioMock
}))

vi.mock('@/api/auth', () => ({
    getAuthToken: () => 'cli-token'
}))

vi.mock('../modules/common/opencodeModels', () => ({
    listOpencodeModelsForCwd: listOpencodeModelsForCwdMock
}))

import { ApiMachineClient } from './apiMachine'
import type { Machine } from './types'

function makeMachine(id: string): Machine {
    return {
        id,
        namespace: 'default',
        seq: 1,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadata: null,
        metadataVersion: 0,
        runnerState: null,
        runnerStateVersion: 0
    }
}

async function callListOpencodeModels(client: ApiMachineClient, machineId: string, cwd: string): Promise<unknown> {
    // Reach into the private rpc handler manager to dispatch a request.
    // Mirrors how the on-socket 'rpc-request' listener invokes handleRequest.
    const manager = (client as unknown as { rpcHandlerManager: { handleRequest: (req: { method: string; params: string }) => Promise<string> } }).rpcHandlerManager
    const raw = await manager.handleRequest({
        method: `${machineId}:listOpencodeModelsForCwd`,
        params: JSON.stringify({ cwd })
    })
    return JSON.parse(raw) as unknown
}

async function callCreateDirectory(client: ApiMachineClient, machineId: string, parentPath: string, name: string): Promise<unknown> {
    const manager = (client as unknown as { rpcHandlerManager: { handleRequest: (req: { method: string; params: string }) => Promise<string> } }).rpcHandlerManager
    const raw = await manager.handleRequest({
        method: `${machineId}:create-directory`,
        params: JSON.stringify({ parentPath, name })
    })
    return JSON.parse(raw) as unknown
}

async function callListDirectory(client: ApiMachineClient, machineId: string, path: string): Promise<{
    success: boolean
    error?: string
    entries?: { name: string }[]
}> {
    // Dispatch through the private manager to exercise the same RPC boundary as Socket.IO.
    const rpcClient = client as unknown as { rpcHandlerManager: { handleRequest: (req: { method: string; params: string }) => Promise<string> } }
    return JSON.parse(await rpcClient.rpcHandlerManager.handleRequest({
        method: `${machineId}:list-directory`,
        params: JSON.stringify({ path })
    }))
}

describe('ApiMachineClient workspace root browsing', () => {
    it('browses a filesystem root and an existing descendant', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'hapi-root-browse-'))
        const root = parse(realpathSync.native(workspace)).root
        const machine = makeMachine('machine-filesystem-root')
        const client = new ApiMachineClient('cli-token', machine, [root])
        writeFileSync(join(workspace, 'visible.txt'), 'workspace file')

        try {
            expect((await callListDirectory(client, machine.id, root)).success).toBe(true)
            const result = await callListDirectory(client, machine.id, workspace)
            expect(result.success).toBe(true)
            expect(result.entries?.map((entry) => entry.name)).toContain('visible.txt')
        } finally {
            client.shutdown()
            rmSync(workspace, { recursive: true, force: true })
        }
    })

    it.skipIf(process.platform !== 'win32')('treats a bare drive as a root for browsing and missing ancestors', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'hapi-drive-root-'))
        const root = parse(realpathSync.native(workspace)).root
        const drive = root.slice(0, 2)
        const otherDrive = drive.toUpperCase() === 'Z:' ? 'Y:' : 'Z:'
        const machine = makeMachine('machine-bare-drive')
        const client = new ApiMachineClient('cli-token', machine, [drive])
        writeFileSync(join(workspace, 'visible.txt'), 'workspace file')

        try {
            expect((await callListDirectory(client, machine.id, drive)).success).toBe(true)
            expect((await callListDirectory(client, machine.id, root)).success).toBe(true)
            const result = await callListDirectory(client, machine.id, workspace)
            expect(result.success).toBe(true)
            expect(result.entries?.map((entry) => entry.name)).toContain('visible.txt')
            const missing = await callListDirectory(client, machine.id, join(root, `${basename(workspace)}-missing`, 'child'))
            expect(missing.success).toBe(false)
            expect(missing.error).toMatch(/ENOENT|cannot find/i)
            expect(await callListDirectory(client, machine.id, `${otherDrive}\\${basename(workspace)}-missing`)).toEqual({
                success: false,
                error: 'Path is outside workspace roots'
            })
        } finally {
            client.shutdown()
            rmSync(workspace, { recursive: true, force: true })
        }
    })

    it.skipIf(process.platform !== 'win32')('preserves drive-relative directory semantics', async () => {
        const workspace = mkdtempSync(join(process.cwd(), '.hapi-drive-relative-'))
        const driveRelativePath = `${parse(workspace).root.slice(0, 2)}${relative(process.cwd(), workspace)}`
        const machine = makeMachine('machine-drive-relative')
        const client = new ApiMachineClient('cli-token', machine, [workspace])
        writeFileSync(join(workspace, 'relative.txt'), 'drive-relative file')

        try {
            const result = await callListDirectory(client, machine.id, driveRelativePath)
            expect(result.success).toBe(true)
            expect(result.entries?.map((entry) => entry.name)).toEqual(['relative.txt'])
        } finally {
            client.shutdown()
            rmSync(workspace, { recursive: true, force: true })
        }
    })

    it('rejects sibling paths, traversal, and existing or missing paths through an escaping symlink', async () => {
        const fixture = mkdtempSync(join(tmpdir(), 'hapi-root-boundary-'))
        const workspace = join(fixture, 'workspace')
        const sibling = join(fixture, 'workspace-other')
        mkdirSync(workspace)
        mkdirSync(sibling)
        symlinkSync(sibling, join(workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
        const machine = makeMachine('machine-root-boundary')
        const client = new ApiMachineClient('cli-token', machine, [workspace])

        try {
            for (const path of [sibling, join(workspace, '..'), join(workspace, 'escape'), join(workspace, 'escape', 'missing', 'child')]) {
                expect(await callListDirectory(client, machine.id, path)).toEqual({
                    success: false,
                    error: 'Path is outside workspace roots'
                })
            }
            const missing = await callListDirectory(client, machine.id, join(workspace, 'missing', 'child'))
            expect(missing.success).toBe(false)
            expect(missing.error).toMatch(/ENOENT|cannot find/i)
            expect(await callCreateDirectory(client, machine.id, join(workspace, 'escape'), 'blocked')).toEqual({
                success: false,
                error: 'Path is outside workspace roots'
            })
        } finally {
            client.shutdown()
            rmSync(fixture, { recursive: true, force: true })
        }
    })
})

describe('ApiMachineClient create-directory handler', () => {
    it('creates one directory inside a workspace root', async () => {
        const workspaceRoot = mkdtempSync(join(tmpdir(), 'hapi-create-dir-'))
        const machine = makeMachine('machine-create')
        const client = new ApiMachineClient('cli-token', machine, [workspaceRoot])

        try {
            const result = await callCreateDirectory(client, machine.id, workspaceRoot, 'new-project')
            expect(result).toEqual({ success: true, path: join(realpathSync(workspaceRoot), 'new-project') })
            expect(realpathSync(join(workspaceRoot, 'new-project'))).toBe(join(realpathSync(workspaceRoot), 'new-project'))
        } finally {
            client.shutdown()
            rmSync(workspaceRoot, { recursive: true, force: true })
        }
    })

    it('rejects path separators in the directory name', async () => {
        const workspaceRoot = mkdtempSync(join(tmpdir(), 'hapi-create-dir-'))
        const machine = makeMachine('machine-create-invalid')
        const client = new ApiMachineClient('cli-token', machine, [workspaceRoot])

        try {
            expect(await callCreateDirectory(client, machine.id, workspaceRoot, '../escape')).toEqual({
                success: false,
                error: 'Directory name must be a single path segment'
            })
        } finally {
            client.shutdown()
            rmSync(workspaceRoot, { recursive: true, force: true })
        }
    })
})

describe('ApiMachineClient listOpencodeModelsForCwd handler', () => {
    let workspaceRoot: string

    beforeEach(() => {
        ioMock.mockReset()
        listOpencodeModelsForCwdMock.mockReset()
        workspaceRoot = mkdtempSync(join(tmpdir(), 'hapi-machine-ws-'))
    })

    afterEach(() => {
        rmSync(workspaceRoot, { recursive: true, force: true })
    })

    it('rejects cwd outside the workspace root with the standard error shape', async () => {
        const machine = makeMachine('machine-1')
        const client = new ApiMachineClient('cli-token', machine, [workspaceRoot])

        const outsideCwd = mkdtempSync(join(tmpdir(), 'hapi-outside-'))
        try {
            const result = await callListOpencodeModels(client, machine.id, outsideCwd)
            expect(result).toEqual({ success: false, error: 'Path is outside workspace roots' })
            expect(listOpencodeModelsForCwdMock).not.toHaveBeenCalled()
        } finally {
            rmSync(outsideCwd, { recursive: true, force: true })
            client.shutdown()
        }
    })

    it('rejects empty cwd with cwd-required error', async () => {
        const machine = makeMachine('machine-2')
        const client = new ApiMachineClient('cli-token', machine, [workspaceRoot])

        try {
            const result = await callListOpencodeModels(client, machine.id, '')
            expect(result).toEqual({ success: false, error: 'cwd is required' })
            expect(listOpencodeModelsForCwdMock).not.toHaveBeenCalled()
        } finally {
            client.shutdown()
        }
    })

    it('forwards a workspace-internal cwd to listOpencodeModelsForCwd', async () => {
        const machine = makeMachine('machine-3')
        const client = new ApiMachineClient('cli-token', machine, [workspaceRoot])

        const innerDir = join(workspaceRoot, 'inner-project')
        mkdirSync(innerDir)

        listOpencodeModelsForCwdMock.mockResolvedValueOnce({
            success: true,
            availableModels: [{ modelId: 'a/b' }],
            currentModelId: 'a/b'
        })

        try {
            const result = await callListOpencodeModels(client, machine.id, innerDir)
            expect(result).toEqual({
                success: true,
                availableModels: [{ modelId: 'a/b' }],
                currentModelId: 'a/b'
            })
            expect(listOpencodeModelsForCwdMock).toHaveBeenCalledTimes(1)
            // The handler should pass the resolved (realpath'd) cwd to the lower layer.
            expect(listOpencodeModelsForCwdMock).toHaveBeenCalledWith(expect.stringContaining('inner-project'))
        } finally {
            client.shutdown()
        }
    })

    it('accepts cwd inside any configured workspace root', async () => {
        const machine = makeMachine('machine-4')
        const secondWorkspaceRoot = mkdtempSync(join(tmpdir(), 'hapi-machine-ws-2-'))
        const client = new ApiMachineClient('cli-token', machine, [workspaceRoot, secondWorkspaceRoot])

        listOpencodeModelsForCwdMock.mockResolvedValueOnce({
            success: true,
            availableModels: [{ modelId: 'x/y' }],
            currentModelId: 'x/y'
        })

        try {
            const result = await callListOpencodeModels(client, machine.id, secondWorkspaceRoot)
            expect(result).toEqual({
                success: true,
                availableModels: [{ modelId: 'x/y' }],
                currentModelId: 'x/y'
            })
            // The handler realpaths the cwd (security: prevents symlink escape),
            // so on macOS /var/folders/... resolves to /private/var/folders/...
            expect(listOpencodeModelsForCwdMock).toHaveBeenCalledWith(realpathSync(secondWorkspaceRoot))
        } finally {
            rmSync(secondWorkspaceRoot, { recursive: true, force: true })
            client.shutdown()
        }
    })
})

describe('ApiMachineClient keepAlive lifecycle', () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('clears priming timeout on shutdown before first machine-alive emit', () => {
        const machine = makeMachine('machine-keepalive')
        const client = new ApiMachineClient('cli-token', machine)
        const emit = vi.fn()
        ;(client as unknown as { socket: { emit: typeof emit; close: () => void } }).socket = {
            emit,
            close: vi.fn(),
        } as never

        const priv = client as unknown as {
            startKeepAlive: () => void
            keepAliveInterval: NodeJS.Timeout | null
            keepAliveStartTimeout: ReturnType<typeof setTimeout> | null
        }

        priv.startKeepAlive()
        client.shutdown()
        vi.advanceTimersByTime(100)

        expect(emit).not.toHaveBeenCalled()
        expect(priv.keepAliveInterval).toBeNull()
        expect(priv.keepAliveStartTimeout).toBeNull()
    })

    it('clears running keepAlive interval on shutdown', () => {
        const machine = makeMachine('machine-keepalive-2')
        const client = new ApiMachineClient('cli-token', machine)
        const emit = vi.fn()
        ;(client as unknown as { socket: { emit: typeof emit; close: () => void } }).socket = {
            emit,
            close: vi.fn(),
        } as never

        const priv = client as unknown as {
            startKeepAlive: () => void
            keepAliveInterval: NodeJS.Timeout | null
        }

        priv.startKeepAlive()
        vi.advanceTimersByTime(50)
        expect(emit).toHaveBeenCalledTimes(1)

        client.shutdown()
        vi.advanceTimersByTime(20_000)

        expect(emit).toHaveBeenCalledTimes(1)
        expect(priv.keepAliveInterval).toBeNull()
    })
})
