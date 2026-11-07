import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { Store, type StoredSession } from '../../../store'
import type { SyncEvent } from '../../../sync/syncEngine'
import type { CliSocketWithData } from '../../socketTypes'
import { registerSessionHandlers } from './sessionHandlers'

class FakeSocket {
    readonly roomEvents: Array<{ room: string; event: string; data: unknown }> = []
    private readonly handlers = new Map<string, (data: unknown, ack?: (response: unknown) => void) => void>()

    on(event: string, handler: (data: unknown, ack?: (response: unknown) => void) => void): this {
        this.handlers.set(event, handler)
        return this
    }

    to(room: string): { emit: (event: string, data: unknown) => void } {
        return {
            emit: (event: string, data: unknown) => {
                this.roomEvents.push({ room, event, data })
            }
        }
    }

    trigger(event: string, data: unknown, ack?: (response: unknown) => void): void {
        this.handlers.get(event)?.(data, ack)
    }
}

function redundantGoalStatusContent(message: string): unknown {
    return {
        role: 'agent',
        content: {
            id: `event-${message}`,
            type: 'event',
            data: { type: 'message', message }
        }
    }
}

describe('cli session handlers', () => {
    it('drops redundant goal status events before persistence and broadcast', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('goal-status-session', {}, null, 'default')
        const socket = new FakeSocket()
        const webEvents: SyncEvent[] = []

        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: () => ({ ok: true, value: session as StoredSession }),
            emitAccessError: () => {
                throw new Error('unexpected access error')
            },
            onWebappEvent: (event) => {
                webEvents.push(event)
            }
        })

        socket.trigger('message', {
            sid: session.id,
            message: redundantGoalStatusContent('Goal active · 8016 tokens')
        })

        expect(store.messages.getMessages(session.id)).toHaveLength(0)
        expect(socket.roomEvents).toHaveLength(0)
        expect(webEvents).toHaveLength(0)
    })

    it('update-metadata broadcasts the merged value, not the pre-merge payload', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'broadcast-merged',
            {
                path: '/tmp/project',
                host: 'example',
                cursorSessionId: 'broadcast-survives'
            },
            null,
            'default'
        )
        const socket = new FakeSocket()

        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: () => ({ ok: true, value: session as StoredSession }),
            emitAccessError: () => {
                throw new Error('unexpected access error')
            }
        })

        let ackResponse: unknown = null
        socket.trigger(
            'update-metadata',
            {
                sid: session.id,
                expectedVersion: session.metadataVersion,
                metadata: {
                    lifecycleState: 'archived',
                    archivedBy: 'cli',
                    archiveReason: 'Session crashed'
                }
            },
            (response) => {
                ackResponse = response
            }
        )

        // Ack: success and the version bumps; the persisted value carries the
        // merged metadata so other CLIs can update their cache to the truth.
        const ack = ackResponse as { result: string; version: number; metadata: unknown }
        expect(ack.result).toBe('success')
        const ackMetadata = ack.metadata as Record<string, unknown>
        expect(ackMetadata.cursorSessionId).toBe('broadcast-survives')
        expect(ackMetadata.path).toBe('/tmp/project')

        // Broadcast: the room event must carry the same merged value.
        const broadcast = socket.roomEvents.find((event) => event.event === 'update')
        expect(broadcast).toBeDefined()
        const broadcastBody = (broadcast?.data as { body: { metadata: { value: Record<string, unknown> } } }).body
        expect(broadcastBody.metadata.value.cursorSessionId).toBe('broadcast-survives')
        expect(broadcastBody.metadata.value.path).toBe('/tmp/project')
        expect(broadcastBody.metadata.value.lifecycleState).toBe('archived')
    })
})

describe('OMP task snapshots through CLI session messages', () => {
    let clock: { mockRestore(): void }

    beforeEach(() => {
        clock = spyOn(Date, 'now').mockReturnValue(Date.now())
    })

    afterEach(() => {
        clock.mockRestore()
    })

    function createHarness() {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('omp-todos', {}, null, 'default')
        const socket = new FakeSocket()
        const webEvents: SyncEvent[] = []
        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: () => ({ ok: true, value: session as StoredSession }),
            emitAccessError: () => { throw new Error('unexpected access error') },
            onWebappEvent: event => { webEvents.push(event) }
        })
        return {
            store,
            webEvents,
            send: (data: unknown, role = 'agent') => socket.trigger('message', {
                sid: session.id,
                message: { role, content: { type: 'codex', data } }
            }),
            sendContent: (content: unknown) => socket.trigger('message', {
                sid: session.id,
                message: { role: 'agent', content }
            }),
            todos: () => store.sessions.getSession(session.id)?.todos
        }
    }

    function snapshot(status: string) {
        return {
            op: 'init',
            storage: 'session',
            phases: [{ name: 'Implementation', tasks: [{ id: 'task-1', content: 'Ship Tasks', status }] }]
        }
    }

    function result(output: unknown, name: string | undefined = 'todo') {
        return { type: 'tool-call-result', callId: 'todo-call', name, output }
    }

    it('persists full snapshots, current statuses and explicit clears in arrival order', () => {
        const h = createHarness()
        try {
            h.send(result(snapshot('pending')))
            expect(h.todos()).toEqual([{ id: 'task-1', content: 'Ship Tasks', priority: 'medium', status: 'pending' }])

            for (const [op, status, expected] of [
                ['start', 'in_progress', 'in_progress'],
                ['block', 'blocked', 'pending'],
                ['done', 'completed', 'completed'],
                ['drop', 'abandoned', 'completed']
            ]) {
                h.send(result({ content: [{ type: 'text', text: 'Updated' }], details: { ...snapshot(status), op } }))
                expect(h.todos()).toEqual([{ id: 'task-1', content: 'Ship Tasks', priority: 'medium', status: expected }])
            }

            h.send(result({ op: 'rm', phases: [], storage: 'session' }))
            expect(h.todos()).toEqual([])
            h.send(result(JSON.stringify(snapshot('pending'))))
            expect(h.todos()).toHaveLength(1)
            h.send(result({ details: { op: 'rm', storage: 'memory', phases: [{ name: 'Implementation', tasks: [] }] } }))
            expect(h.todos()).toEqual([])
            expect(h.webEvents.filter(event => event.type === 'session-updated')).toHaveLength(8)
        } finally {
            h.store.close()
        }
    })

    it('keeps valid Tasks for malformed snapshots, incremental inputs, errors and unrelated results', () => {
        const h = createHarness()
        try {
            h.send(result(snapshot('in_progress')))
            const expected = h.todos()
            const clear = { op: 'rm', storage: 'session', phases: [] }
            for (const data of [
                result({}),
                result('{not json'),
                result({ op: 'unknown', phases: [] }),
                result({ op: 'init', phases: [null] }),
                result({ op: 'init', phases: [{ name: 'Broken', tasks: 'invalid' }] }),
                result({ op: 'init', phases: [{ name: 'Broken', tasks: [{ content: 'Bad', status: 'unknown' }] }] }),
                result({ op: 'init', phases: [{ name: 'Broken', tasks: [{ status: 'pending' }] }] }),
                result({ op: 'init', phases: [...snapshot('pending').phases, { name: 'Broken' }] }),
                result({ details: null, phases: [] }),
                result({ ...clear, isError: true }),
                { ...result(clear), is_error: true },
                result(clear, 'Read'),
                { type: 'tool-call-result', callId: 'anonymous', output: clear },
                { type: 'tool-call', callId: 'incremental', name: 'todo', input: clear },
                { type: 'tool-call', callId: 'incremental', name: 'todo', input: { op: 'done', task: 'Ship Tasks' } }
            ]) {
                h.send(data)
                expect(h.todos()).toEqual(expected)
            }
            h.send(result(clear), 'user')
            expect(h.todos()).toEqual(expected)
            expect(h.webEvents.filter(event => event.type === 'session-updated')).toHaveLength(1)
        } finally {
            h.store.close()
        }
    })

    it('preserves TodoWrite and ACP plan updates alongside OMP results', () => {
        const h = createHarness()
        try {
            h.send({ type: 'tool-call', name: 'TodoWrite', input: { todos: [{ content: 'Claude task', status: 'pending' }] } })
            expect(h.todos()).toEqual([{ id: '', content: 'Claude task', status: 'pending', priority: 'medium' }])
            h.sendContent({
                type: 'output',
                data: {
                    type: 'assistant',
                    message: { content: [{ type: 'tool_use', name: 'TodoWrite', input: { todos: [] } }] }
                }
            })
            expect(h.todos()).toEqual([])
            h.send({ type: 'plan', entries: [{ content: 'ACP task', status: 'in_progress', priority: 'high' }] })
            expect(h.todos()).toEqual([{ id: 'plan-1', content: 'ACP task', status: 'in_progress', priority: 'high' }])
            h.send(result({ details: snapshot('completed') }))
            expect(h.todos()).toEqual([{ id: 'task-1', content: 'Ship Tasks', status: 'completed', priority: 'medium' }])
            h.send({ type: 'plan', entries: [] })
            expect(h.todos()).toEqual([])
        } finally {
            h.store.close()
        }
    })
})
