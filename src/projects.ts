import { createClient } from './clockify.ts'
import { requireSession } from './session.ts'

export async function listProjects() {
  const session = await requireSession()
  const projects = await createClient(session.apiKey, session.baseUrl).listProjects(session.workspace.id)
  console.log(`Proyectos activos en ${session.workspace.name}:\n`)
  for (const project of projects) {
    const marker = project.id === session.defaultProject?.id ? '  (por defecto)' : ''
    console.log(`  ${project.name}${marker}`)
  }
  if (!projects.length) console.log('  (ninguno)')
}
