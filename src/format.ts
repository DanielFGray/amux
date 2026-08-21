/**
 * Small tmux-style format language for mux chrome.
 *
 * A token is `#{name}`. Conditionals use `#{?name,when-true,when-false}`;
 * branches may contain tokens and other conditionals. Values are supplied by
 * the caller so this module stays independent of the workspace model.
 */
export type FormatValue = string | number | boolean | null | undefined;
export type FormatValues = Readonly<Record<string, FormatValue>>;

export function formatText(source: string, values: FormatValues): string {
  return render(source, values, 0);
}

function render(source: string, values: FormatValues, depth: number): string {
  if (depth > 32) return "";
  let result = "";
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf("#{", cursor);
    if (start < 0) return result + source.slice(cursor);
    result += source.slice(cursor, start);
    const end = expressionEnd(source, start + 2);
    if (end < 0) return result + source.slice(start);
    result += evaluate(source.slice(start + 2, end), values, depth + 1);
    cursor = end + 1;
  }
  return result;
}

function expressionEnd(source: string, start: number): number {
  let nested = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === "#" && source[i + 1] === "{") {
      nested++;
      i++;
    } else if (source[i] === "}") {
      if (nested === 0) return i;
      nested--;
    }
  }
  return -1;
}

function evaluate(expression: string, values: FormatValues, depth: number): string {
  if (expression.startsWith("?")) {
    const [condition = "", yes = "", no = ""] = splitArguments(expression.slice(1));
    return truthy(values[condition.trim()])
      ? render(yes, values, depth)
      : render(no, values, depth);
  }

  // tmux's common single-letter modifiers are useful for paths and labels.
  const separator = expression.indexOf(":");
  const modifier = separator > 0 ? expression.slice(0, separator) : "";
  const name = separator > 0 ? expression.slice(separator + 1) : expression;
  const value = values[name];
  if (value === null || value === undefined || value === false) return "";
  const text = String(value);
  if (modifier === "q") return quote(text);
  if (modifier === "b") return text.slice(text.lastIndexOf("/") + 1);
  if (modifier === "t") return text.slice(0, text.lastIndexOf("/") + 1).replace(/\/$/, "");
  if (modifier.startsWith("=")) {
    const width = Number(modifier.slice(1));
    return Number.isInteger(width) && width > 0 ? text.slice(0, width) : text;
  }
  return separator > 0 && !["q", "b", "t"].includes(modifier) && !modifier.startsWith("=")
    ? ""
    : text;
}

function splitArguments(source: string): string[] {
  const result: string[] = [];
  let start = 0;
  let nested = 0;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "#" && source[i + 1] === "{") {
      nested++;
      i++;
    } else if (source[i] === "}") {
      nested = Math.max(0, nested - 1);
    } else if (source[i] === "," && nested === 0) {
      result.push(source.slice(start, i));
      start = i + 1;
    }
  }
  result.push(source.slice(start));
  return result;
}

function truthy(value: FormatValue): boolean {
  return value !== undefined && value !== null && value !== false && value !== "" && value !== 0;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
