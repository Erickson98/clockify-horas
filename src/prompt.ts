import { execFile } from 'node:child_process'
import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { normalize } from './text.ts'

export async function ask(question: string) {
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    return (await rl.question(question)).trim()
  } finally {
    rl.close()
  }
}

export async function confirm(question: string) {
  const answer = normalize(await ask(`${question} (s/N) `))
  return answer === 's' || answer === 'si'
}

export function askSecret(question: string) {
  if (!stdin.isTTY) return ask(question)
  return new Promise<string>((resolve, reject) => {
    let value = ''
    const finish = () => {
      stdin.off('data', onData)
      stdin.setRawMode(false)
      stdin.pause()
      stdout.write('\n')
    }
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          finish()
          resolve(value.trim())
          return
        }
        if (char === '\u0003') {
          finish()
          reject(new Error('Cancelado.'))
          return
        }
        if (char === '\u007f' || char === '\b') {
          if (value) {
            value = value.slice(0, -1)
            stdout.write('\b \b')
          }
        } else if (char >= ' ') {
          value += char
          stdout.write('*')
        }
      }
    }
    stdout.write(question)
    stdin.setEncoding('utf8')
    stdin.setRawMode(true)
    stdin.resume()
    stdin.on('data', onData)
  })
}

export async function choose(title: string, options: string[], fallback: number | null) {
  console.log(`\n${title}`)
  options.forEach((option, index) => console.log(`  ${String(index + 1).padStart(2)}. ${option}`))
  if (fallback === null) console.log('   0. Ninguno')
  const hint = fallback === null ? 'Enter = ninguno' : `Enter = ${fallback + 1}`
  for (;;) {
    const answer = await ask(`Número (${hint}): `)
    if (answer === '') return fallback
    const number = Number(answer)
    if (fallback === null && number === 0) return null
    if (Number.isInteger(number) && number >= 1 && number <= options.length) return number - 1
    console.log('Ese número no está en la lista.')
  }
}

export function openInBrowser(url: string) {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
  return new Promise<boolean>((resolve) => execFile(command, [url], (error) => resolve(!error)))
}
