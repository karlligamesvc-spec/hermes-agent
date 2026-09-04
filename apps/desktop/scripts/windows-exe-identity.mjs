const APEX_WINDOWS_IDENTITY = Object.freeze({
  ProductName: 'APEX',
  FileDescription: 'APEX',
  CompanyName: 'ApexNodes HK'
})

function packageVersionToPeVersion(packageVersion) {
  if (typeof packageVersion !== 'string') {
    throw new TypeError('desktop package version must be a string')
  }

  const match = packageVersion.match(/^(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?(?:[-+].*)?$/)
  if (!match) {
    throw new Error(`desktop package version is not valid semver: ${packageVersion}`)
  }

  return `${match[1]}.${match[2]}.${match[3]}.${match[4] || '0'}`
}

function windowsExeIdentity(packageVersion) {
  const peVersion = packageVersionToPeVersion(packageVersion)
  return {
    ...APEX_WINDOWS_IDENTITY,
    FileVersion: peVersion,
    ProductVersion: peVersion,
    LegalCopyright: 'Copyright (c) 2026 ApexNodes HK'
  }
}

function assertWindowsExeIdentity(actual, packageVersion) {
  const expected = windowsExeIdentity(packageVersion)
  const fields = [
    'ProductName',
    'FileDescription',
    'CompanyName',
    'FileVersion',
    'ProductVersion'
  ]
  const mismatches = fields.flatMap(field => {
    const actualValue = String(actual?.[field] ?? '').trim()
    return actualValue === expected[field]
      ? []
      : [`${field}: expected ${JSON.stringify(expected[field])}, got ${JSON.stringify(actualValue)}`]
  })

  if (mismatches.length > 0) {
    throw new Error(`APEX Windows executable identity mismatch:\n${mismatches.join('\n')}`)
  }

  return expected
}

export {
  APEX_WINDOWS_IDENTITY,
  assertWindowsExeIdentity,
  packageVersionToPeVersion,
  windowsExeIdentity
}
