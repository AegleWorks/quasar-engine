/**
 * Quasar Document Engine — Design Tokens
 *
 * Provides token types and normalization utilities for design token resolution.
 * Completely independent of @miliastry/core.
 */

export interface DocumentTokens {
  palette?: Record<string, string>
  variables?: Record<string, string>
}

export type TokenResolverFn = (name: string) => string | undefined
export type TokenSource = DocumentTokens | TokenResolverFn

/**
 * Normalizes a TokenSource into a TokenResolverFn.
 *
 * For DocumentTokens, checks palette[name] ?? variables[name], handling both
 * with and without leading `$`.
 * If source is already a function, passes it through.
 */
export function toTokenResolver(source?: TokenSource): TokenResolverFn | undefined {
  if (!source) return undefined
  if (typeof source === 'function') return source

  return (name: string): string | undefined => {
    const bare = name.startsWith('$') ? name.slice(1) : name
    const dollar = '$' + bare
    const palette = source.palette
    const variables = source.variables

    return (
      palette?.[name] ??
      palette?.[bare] ??
      palette?.[dollar] ??
      variables?.[name] ??
      variables?.[bare] ??
      variables?.[dollar]
    )
  }
}

/**
 * Resolves a token value if val starts with `$`.
 * Strips `$` and looks up in resolver. If found, returns resolved value; otherwise returns val.
 */
export function resolveTokenValue(val: string, resolver?: TokenResolverFn): string {
  if (!resolver || !val.startsWith('$')) {
    return val
  }
  const tokenName = val.slice(1)
  const resolved = resolver(tokenName) ?? resolver(val)
  return resolved !== undefined ? resolved : val
}
