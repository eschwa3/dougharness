/** Lower-cases the input and joins its alphanumeric runs with single hyphens. */
export function slug(input: string): string {
  return input
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join("-");
}
