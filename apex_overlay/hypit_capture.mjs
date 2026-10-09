// Keep script arguments after `--` untouched when supplying the managed browser.
export async function managedCaptureArgs(args, resolveBrowser) {
  if (args[0] !== 'capture') return { args }
  const separator = args.indexOf('--')
  const options = separator < 0 ? args : args.slice(0, separator)
  if (options.some(arg => ['--help', '-h', '--browser', '--channel', '--browser-version',
    '--browser-cache', '--browser-download-base-url'].some(flag => arg === flag || arg.startsWith(flag + '=')))) {
    return { args }
  }
  if (args[1] === 'install-browser') return { installed: await resolveBrowser() }
  if (!['screenshot', 'run'].includes(args[1])) return { args }
  const browser = await resolveBrowser()
  return { args: [...options, '--browser', browser, ...(separator < 0 ? [] : args.slice(separator))] }
}
