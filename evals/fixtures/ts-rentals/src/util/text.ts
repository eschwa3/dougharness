export function padRight(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

export function titleCase(text: string): string {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

/** "1 day", "3 days". */
export function pluralise(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** Replaces {name} placeholders. A placeholder with no value is left as written. */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in values ? values[key] : whole));
}
