/**
 * Masks the secret-looking values in a process argv that Desktop records for diagnosis, such as
 * the busy proof's engine holders, which can be any process on the machine. The shape stays:
 * the same arguments in the same order, every flag and name, and every value nothing marks as
 * secret.
 *
 * A value is secret when a flag, variable, header or query name says so (`--api-key X`,
 * `--token=X`, `OPENAI_API_KEY=X`, `Authorization: Bearer X`, `?access_token=X`), when it follows
 * an auth scheme (`Bearer X`), or when it is a URL's userinfo. Inside one argument everything
 * after a secret name is masked, because a shell string cannot be split reliably. A bare
 * positional token that nothing names is not recognized.
 */

const REDACTED = '[REDACTED]'

// The last word of a name that makes its value secret: SECRET_WORDS only as the whole word
// (`--key`, `MYSQL_PWD`, but not `--hotkey`), SECRET_ENDINGS also at its end (`PGPASSWORD`).
const SECRET_WORDS = new Set(['auth', 'authorization', 'cookie', 'credential', 'credentials', 'key', 'pass', 'pwd', 'secrets', 'sig', 'signature'])
const SECRET_ENDINGS = ['accesskey', 'apikey', 'passphrase', 'passwd', 'password', 'privatekey', 'secret', 'secretkey', 'token']

// `Basic` only as a header writes it; a lowercase `basic` is usually an option value.
const SCHEME = /^(?:Bearer|bearer|Basic)$/
// `--no-auth` switches something off; it takes no value.
const NEGATED = /^no[-_]/i
const WHOLE_FLAG = /^(?:--?|\/)([A-Za-z][\w.-]*)$/
// The whole userinfo, because a token often sits in the user part (`https://<token>@host`).
const URL_USERINFO = /(\b[A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/?#@]+@/g
const URL_PARAMETER = /([?&#;])([^=&#;\s"'?]+)=([^&#;\s"']+)/g
// A name where one can start inside an argument (its start, or after a space, quote, bracket or
// separator), then an optional closing quote or bracket (`"token":`, `["API_KEY"]=`) and what
// separates it from its value.
const NAME = /(?<=^|[\s"'`(){}[\];|,=:])(--?|\/)?([A-Za-z_][\w.-]*)(["']?\]?)(\s*[=:]\s*|\s+)/g

function isSecretName(name: string): boolean {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/)
  // A numbered secret (`API_KEY_2`, `--token2`) still ends in its secret word.
  const last = words.filter(word => /[a-z]/.test(word)).at(-1)?.replace(/\d+$/, '') ?? ''

  return SECRET_WORDS.has(last) || SECRET_ENDINGS.some(ending => last.endsWith(ending))
}

function startsSecretValue(dash: string | undefined, name: string, separator: string): boolean {
  const assigns = /[=:]/.test(separator)

  // Without a dash, a word before a space is prose or a positional; only an auth scheme counts.
  if (!dash) {return assigns ? isSecretName(name) : SCHEME.test(name)}

  return isSecretName(name) && (assigns || !NEGATED.test(name))
}

function redactArgument(arg: string): { text: string; secretFollows: boolean } {
  const text = arg
    .replace(URL_USERINFO, `$1${REDACTED}@`)
    .replace(URL_PARAMETER, (parameter, separator, name) => (isSecretName(name) ? `${separator}${name}=${REDACTED}` : parameter))

  const flag = WHOLE_FLAG.exec(text)

  if (flag ? isSecretName(flag[1]) && !NEGATED.test(flag[1]) : SCHEME.test(text)) {
    return { text, secretFollows: true }
  }

  for (const match of text.matchAll(NAME)) {
    const [marker, dash, name, , separator] = match

    if (!startsSecretValue(dash, name, separator)) {continue}

    const end = match.index + marker.length

    // `Authorization:` or `--token=` ends the argument, so its value is the next one.
    return end === text.length ? { text, secretFollows: true } : { text: text.slice(0, end) + REDACTED, secretFollows: false }
  }

  return { text, secretFollows: false }
}

/** The argv with each secret-looking value replaced by `[REDACTED]`; see the module comment. */
export function redactArgv(argv: readonly string[]): string[] {
  let valueIsSecret = false

  return argv.map(arg => {
    const { text, secretFollows } = redactArgument(arg)
    const shown = valueIsSecret ? REDACTED : text
    valueIsSecret = secretFollows

    return shown
  })
}
