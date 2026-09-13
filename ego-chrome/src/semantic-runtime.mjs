import { createRuntime as createLowTokenRuntime } from './low-token-runtime.mjs'
import { createSemanticLocator, serializeMatcher } from './semantic-locators.mjs'

export function createRuntime(rpc, options = {}) {
  const base = createLowTokenRuntime(rpc, options)

  function getByRole(role, locatorOptions = {}) {
    if (typeof role !== 'string' || !role.trim()) throw new TypeError('page.getByRole requires a role')
    return createSemanticLocator(base.page, {
      kind: 'role',
      role: role.trim().toLowerCase(),
      matcher: serializeMatcher(locatorOptions.name, locatorOptions.exact),
      includeHidden: locatorOptions.includeHidden === true,
    })
  }

  function getByLabel(label, locatorOptions = {}) {
    return createSemanticLocator(base.page, {
      kind: 'label',
      matcher: serializeMatcher(label, locatorOptions.exact),
      includeHidden: locatorOptions.includeHidden === true,
    })
  }

  return {
    ...base,
    page: {
      ...base.page,
      getByRole,
      getByLabel,
    },
  }
}
