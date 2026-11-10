export const GLOBAL_API = 'https://api.clockify.me/api'
export const REGIONAL_APIS = ['use2', 'euc1', 'euw2', 'apse2'].map(
  (prefix) => `https://${prefix}.clockify.me/api`,
)

const PAGE_SIZE = 200
const MAX_PAGES = 50

export class ClockifyError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export type ClockifyUser = {
  id: string
  name: string | null
  email: string
  activeWorkspace: string
  defaultWorkspace: string
  settings?: { timeZone?: string; myStartOfDay?: string } | null
}

export type Workspace = { id: string; name: string }
export type Project = { id: string; name: string; archived: boolean }
export type Task = { id: string; name: string; status?: string }
export type Tag = { id: string; name: string; archived: boolean }

export type TimeEntry = {
  id: string
  description: string | null
  projectId: string | null
  timeInterval: { start: string; end: string | null }
}

export type NewTimeEntry = {
  start: string
  end: string
  description: string
  projectId?: string
  taskId?: string
  tagIds?: string[]
  billable?: boolean
}

type Query = Record<string, string | number | boolean | undefined>

async function toError(response: Response) {
  let detail = ''
  try {
    detail = (JSON.parse(await response.text()) as { message?: string }).message ?? ''
  } catch {}
  if (response.status === 401) {
    return new ClockifyError(
      401,
      'Clockify rechazó la API key: no es válida o fue revocada. Corre «npm run login» de nuevo.',
    )
  }
  if (response.status === 429) {
    return new ClockifyError(
      429,
      'Clockify limitó las llamadas (en el plan gratuito son 30 por hora por workspace). Espera un rato y corre el mismo comando otra vez: lo que ya se registró no se repite.',
    )
  }
  return new ClockifyError(response.status, `Clockify respondió ${response.status}${detail ? `: ${detail}` : '.'}`)
}

export function createClient(apiKey: string, baseUrl: string) {
  async function request<T>(method: string, path: string, query: Query = {}, body?: unknown) {
    const url = new URL(`${baseUrl}/v1${path}`)
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    let response: Response
    try {
      response = await fetch(url, {
        method,
        headers: {
          'X-Api-Key': apiKey,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch (error) {
      throw new ClockifyError(0, `No pude conectar con Clockify (${(error as Error).message}).`)
    }
    if (!response.ok) throw await toError(response)
    return {
      data: (await response.json()) as T,
      lastPage: response.headers.get('Last-Page'),
    }
  }

  async function paginate<T>(path: string, query: Query = {}) {
    const items: T[] = []
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { data, lastPage } = await request<T[]>('GET', path, { ...query, page, 'page-size': PAGE_SIZE })
      items.push(...data)
      if (!data.length || lastPage === 'true' || (lastPage === null && data.length < PAGE_SIZE)) break
    }
    return items
  }

  return {
    async getUser() {
      return (await request<ClockifyUser>('GET', '/user')).data
    },
    async getWorkspaces() {
      return (await request<Workspace[]>('GET', '/workspaces')).data
    },
    async listProjects(workspaceId: string) {
      const projects = await paginate<Project>(`/workspaces/${workspaceId}/projects`, { archived: false })
      return projects.filter((project) => !project.archived)
    },
    findTasks(workspaceId: string, projectId: string, name: string) {
      return paginate<Task>(`/workspaces/${workspaceId}/projects/${projectId}/tasks`, { name })
    },
    async listTags(workspaceId: string) {
      const tags = await paginate<Tag>(`/workspaces/${workspaceId}/tags`, { archived: false })
      return tags.filter((tag) => !tag.archived)
    },
    listTimeEntries(workspaceId: string, userId: string, start: string, end: string) {
      return paginate<TimeEntry>(`/workspaces/${workspaceId}/user/${userId}/time-entries`, { start, end })
    },
    async createTimeEntry(workspaceId: string, entry: NewTimeEntry) {
      return (await request<TimeEntry>('POST', `/workspaces/${workspaceId}/time-entries`, {}, entry)).data
    },
  }
}

export type Client = ReturnType<typeof createClient>
