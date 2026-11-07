import { isObject } from '@hapi/protocol'
import { unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'
import { TodoItemSchema, TodosSchema } from '@hapi/protocol/schemas'
import type { TodoItem } from '@hapi/protocol/types'

export { TodoItemSchema, TodosSchema }
export type { TodoItem }

function extractTodosFromClaudeOutput(content: Record<string, unknown>): TodoItem[] | null {
    if (content.type !== 'output') return null

    const data = isObject(content.data) ? content.data : null
    if (!data || data.type !== 'assistant') return null

    const message = isObject(data.message) ? data.message : null
    if (!message) return null

    const modelContent = message.content
    if (!Array.isArray(modelContent)) return null

    for (const block of modelContent) {
        if (!isObject(block) || block.type !== 'tool_use') continue
        const name = typeof block.name === 'string' ? block.name : null
        if (name !== 'TodoWrite') continue
        const input = 'input' in block ? (block as Record<string, unknown>).input : null
        if (!isObject(input)) continue

        const todosCandidate = input.todos
        const parsed = TodosSchema.safeParse(todosCandidate)
        if (parsed.success) {
            return parsed.data
        }
    }

    return null
}

function extractTodosFromCodexMessage(content: Record<string, unknown>): TodoItem[] | null {
    if (content.type !== 'codex') return null

    const data = isObject(content.data) ? content.data : null
    if (!data || data.type !== 'tool-call') return null

    const name = typeof data.name === 'string' ? data.name : null
    if (name !== 'TodoWrite') return null

    const input = 'input' in data ? (data as Record<string, unknown>).input : null
    if (!isObject(input)) return null

    const todosCandidate = input.todos
    const parsed = TodosSchema.safeParse(todosCandidate)
    return parsed.success ? parsed.data : null
}

function extractTodosFromAcpMessage(content: Record<string, unknown>): TodoItem[] | null {
    if (content.type !== 'codex') return null

    const data = isObject(content.data) ? content.data : null
    if (!data || data.type !== 'plan') return null

    const entries = data.entries
    if (!Array.isArray(entries)) return null

    const todos: TodoItem[] = []
    entries.forEach((entry, index) => {
        if (!isObject(entry)) return
        const contentValue = typeof entry.content === 'string' ? entry.content : null
        const priorityValue = typeof entry.priority === 'string' ? entry.priority : null
        const statusValue = typeof entry.status === 'string' ? entry.status : null
        if (!contentValue || !priorityValue || !statusValue) return
        if (priorityValue !== 'high' && priorityValue !== 'medium' && priorityValue !== 'low') return
        if (statusValue !== 'pending' && statusValue !== 'in_progress' && statusValue !== 'completed') return

        const idValue = typeof entry.id === 'string' ? entry.id : `plan-${index + 1}`

        todos.push({
            content: contentValue,
            priority: priorityValue,
            status: statusValue,
            id: idValue
        })
    })

    const parsed = TodosSchema.safeParse(todos)
    return parsed.success ? parsed.data : null
}

function extractTodosFromOmpResult(content: Record<string, unknown>): TodoItem[] | null {
    if (content.type !== 'codex') return null

    const data = isObject(content.data) ? content.data : null
    // Only completed results are authoritative. `todo` inputs are incremental ops,
    // and a phases-shaped value from another tool must not replace the task list.
    if (!data || data.type !== 'tool-call-result' || data.name !== 'todo' || data.is_error === true) return null

    let output = data.output
    if (typeof output === 'string') {
        try {
            output = JSON.parse(output)
        } catch {
            return null
        }
    }
    if (!isObject(output) || output.isError === true) return null
    const snapshot = isObject(output.details) ? output.details : output
    if (typeof snapshot.op !== 'string'
        || !['init', 'start', 'done', 'rm', 'drop', 'block', 'unblock', 'append', 'view'].includes(snapshot.op)
        || !Array.isArray(snapshot.phases)) return null

    const todos: TodoItem[] = []
    for (const phase of snapshot.phases) {
        if (!isObject(phase) || typeof phase.name !== 'string' || !Array.isArray(phase.tasks)) return null
        for (const task of phase.tasks) {
            if (!isObject(task) || typeof task.content !== 'string' || !task.content.trim()) return null
            let status: TodoItem['status']
            switch (task.status) {
                case 'pending':
                case 'blocked':
                    status = 'pending'
                    break
                case 'in_progress':
                    status = 'in_progress'
                    break
                case 'completed':
                case 'abandoned':
                    status = 'completed'
                    break
                default:
                    return null
            }
            todos.push({
                content: task.content,
                status,
                priority: 'medium',
                id: typeof task.id === 'string' ? task.id : `plan-${todos.length + 1}`
            })
        }
    }
    // An explicitly empty snapshot clears tasks; malformed snapshots above do not.
    return todos
}

export function extractTodoWriteTodosFromMessageContent(messageContent: unknown): TodoItem[] | null {
    const record = unwrapRoleWrappedRecordEnvelope(messageContent)
    if (!record) return null

    if (record.role !== 'agent' && record.role !== 'assistant') return null

    if (!isObject(record.content) || typeof record.content.type !== 'string') return null

    return extractTodosFromClaudeOutput(record.content)
        ?? extractTodosFromCodexMessage(record.content)
        ?? extractTodosFromAcpMessage(record.content)
        ?? extractTodosFromOmpResult(record.content)
}
