import { expect, test } from 'vitest'

import { redactArgv } from './argv-redaction'

const SECRET = 'fixture-secret'
const R = '[REDACTED]'

// Each way a process can pass a credential on its command line keeps the flag or name and
// loses only the value, so a busy proof still shows what the holder is.
test.each([
  { shape: '--api-key X', argv: ['node', 'server.js', '--api-key', SECRET], masked: ['node', 'server.js', '--api-key', R] },
  { shape: '--token=X', argv: ['python', 'app.py', `--token=${SECRET}`], masked: ['python', 'app.py', `--token=${R}`] },
  { shape: '--secret X before other flags', argv: ['app', '--secret', SECRET, '--port', '8642'], masked: ['app', '--secret', R, '--port', '8642'] },
  { shape: '--password X', argv: ['mysqlsh', '--password', SECRET], masked: ['mysqlsh', '--password', R] },
  { shape: '--client-secret=X', argv: ['app', `--client-secret=${SECRET}`], masked: ['app', `--client-secret=${R}`] },
  { shape: '--clientSecret X', argv: ['app', '--clientSecret', SECRET], masked: ['app', '--clientSecret', R] },
  { shape: '-token X', argv: ['server', '-token', SECRET], masked: ['server', '-token', R] },
  { shape: '--token2 X', argv: ['app', '--token2', SECRET], masked: ['app', '--token2', R] },
  { shape: '/p:Password=X', argv: ['msbuild.exe', `/p:Password=${SECRET}`], masked: ['msbuild.exe', `/p:Password=${R}`] },
  { shape: 'Bearer X', argv: ['client', 'Bearer', SECRET], masked: ['client', 'Bearer', R] },
  {
    shape: 'Authorization: Bearer X',
    argv: ['curl', '-H', `Authorization: Bearer ${SECRET}`, 'https://api.example.test'],
    masked: ['curl', '-H', `Authorization: ${R}`, 'https://api.example.test']
  },
  { shape: 'Authorization: then its value', argv: ['client', 'Authorization:', `Bearer ${SECRET}`], masked: ['client', 'Authorization:', R] },
  { shape: '-HAuthorization: Bearer X', argv: ['curl', `-HAuthorization: Bearer ${SECRET}`], masked: ['curl', `-HAuthorization: Bearer ${R}`] },
  { shape: '--header=X-Api-Key: X', argv: ['app', `--header=X-Api-Key: ${SECRET}`], masked: ['app', `--header=X-Api-Key: ${R}`] },
  {
    shape: '*_KEY=X, *_TOKEN=X, PGPASSWORD=X, API_KEY_2=X',
    argv: ['env', `OPENAI_API_KEY=${SECRET}`, `GITHUB_TOKEN=${SECRET}`, `PGPASSWORD=${SECRET}`, `API_KEY_2=${SECRET}`, 'python'],
    masked: ['env', `OPENAI_API_KEY=${R}`, `GITHUB_TOKEN=${R}`, `PGPASSWORD=${R}`, `API_KEY_2=${R}`, 'python']
  },
  {
    shape: '--env=*_KEY=X',
    argv: ['docker', 'run', `--env=OPENAI_API_KEY=${SECRET}`, 'image'],
    masked: ['docker', 'run', `--env=OPENAI_API_KEY=${R}`, 'image']
  },
  {
    shape: 'secret query and fragment parameters',
    argv: ['app', `https://api.example.test/v1?mode=a&access_token=${SECRET}&page=2#sig=${SECRET}`],
    masked: ['app', `https://api.example.test/v1?mode=a&access_token=${R}&page=2#sig=${R}`]
  },
  {
    shape: 'URL userinfo',
    argv: ['app', `postgres://app:${SECRET}@db.example.test:5432/main`],
    masked: ['app', `postgres://${R}@db.example.test:5432/main`]
  },
  {
    shape: 'a JSON field',
    argv: ['app', '--config', `{"token":"${SECRET}","mode":"fast"}`],
    masked: ['app', '--config', `{"token":${R}`]
  },
  {
    shape: 'a subscripted assignment in code',
    argv: ['python', '-c', `import os; os.environ["API_KEY"]="${SECRET}"; run()`],
    masked: ['python', '-c', `import os; os.environ["API_KEY"]=${R}`]
  },
  {
    shape: 'an assignment inside a shell string',
    argv: ['sh', '-c', `cd /srv && OPENAI_API_KEY=${SECRET} python app.py --port 8642`],
    masked: ['sh', '-c', `cd /srv && OPENAI_API_KEY=${R}`]
  },
  {
    shape: 'a flag inside a shell string',
    argv: ['cmd.exe', '/c', `python app.py --token ${SECRET} --port 8642`],
    masked: ['cmd.exe', '/c', `python app.py --token ${R}`]
  },
  { shape: 'a secret flag taken as a value', argv: ['app', '--token', '--password', SECRET], masked: ['app', '--token', R, R] }
])('masks $shape', ({ argv, masked }) => {
  expect(redactArgv(argv)).toEqual(masked)
})

// Argv that nothing marks as secret is returned as it is.
test.each([
  { shape: 'an engine gateway', argv: ['/Users/me/.hermes/versions/4321d42c674c/venv/bin/python', '-m', 'hermes_cli.main', 'gateway', 'run', '--replace'] },
  { shape: 'a Windows engine server', argv: ['C:\\Users\\me\\AppData\\Local\\hermes\\venv\\Scripts\\python.exe', '-m', 'hermes_cli.main', 'serve', '--port', '8642'] },
  { shape: 'an inline Node script', argv: ['/usr/local/bin/node', '-e', 'console.log(JSON.stringify({pid:process.pid})); setInterval(()=>{},1000)'] },
  { shape: 'names that only contain a secret word', argv: ['app', '--max-tokens', '4096', '--token-file', '/run/token', '--password-stdin', '--tokenizer', 'bpe'] },
  { shape: 'a negated switch', argv: ['app', '--no-auth', '--port', '8642'] },
  { shape: 'a URL without secret parameters', argv: ['app', 'https://example.test/search?q=token&page=2'] },
  { shape: 'prose that mentions secrets', argv: ['git', 'commit', '-m', 'rotate the token key'] },
  { shape: 'a secret flag with no value', argv: ['app', '--token'] },
  { shape: 'no arguments', argv: [] }
])('keeps $shape', ({ argv }) => {
  expect(redactArgv(argv)).toEqual(argv)
})
