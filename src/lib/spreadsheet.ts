export type FormulaContext = Record<string, number | string | null | undefined>;

type Token =
  | { type: "number"; value: number }
  | { type: "identifier"; value: string }
  | { type: "operator"; value: "+" | "-" | "*" | "/" }
  | { type: "paren"; value: "(" | ")" }
  | { type: "comma"; value: "," };

export function evaluateSpreadsheetFormula(
  input: string,
  context: FormulaContext = {},
) {
  const expression = input.trim().startsWith("=") ? input.trim().slice(1) : input;
  const parser = new FormulaParser(tokenizeFormula(expression), context);
  const result = normalizeFloatingPoint(parser.parse());
  if (!Number.isFinite(result)) {
    throw new Error("Formula result is not a finite number");
  }
  return result;
}

function normalizeFloatingPoint(value: number) {
  const rounded = Number(value.toPrecision(15));
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function isFormulaValue(value: string) {
  return value.trim().startsWith("=");
}

export function formatFormulaResult(value: number) {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(6).replace(/\.?0+$/, "");
}

export function resolveSpreadsheetInputValue(
  input: string,
  context: FormulaContext = {},
  allowFormula = true,
) {
  if (!allowFormula || !isFormulaValue(input)) return input;
  return formatFormulaResult(evaluateSpreadsheetFormula(input, context));
}

function tokenizeFormula(expression: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < expression.length) {
    const char = expression[index];
    if (/\s/.test(char)) {
      index++;
      continue;
    }

    if (char === ",") {
      tokens.push({ type: "comma", value: "," });
      index++;
      continue;
    }

    if (char === "(" || char === ")") {
      tokens.push({ type: "paren", value: char });
      index++;
      continue;
    }

    if (char === "+" || char === "-" || char === "*" || char === "/") {
      tokens.push({ type: "operator", value: char });
      index++;
      continue;
    }

    if (isDigit(char) || char === ".") {
      const start = index;
      index++;
      while (index < expression.length) {
        const next = expression[index];
        if (!isDigit(next) && next !== ".") break;
        index++;
      }
      const rawNumber = expression.slice(start, index);
      const value = Number(rawNumber);
      if (!Number.isFinite(value)) {
        throw new Error(`Invalid number "${rawNumber}"`);
      }
      tokens.push({ type: "number", value });
      continue;
    }

    if (isIdentifierStart(char)) {
      const start = index;
      index++;
      while (index < expression.length && isIdentifierPart(expression[index])) {
        index++;
      }
      tokens.push({
        type: "identifier",
        value: expression.slice(start, index),
      });
      continue;
    }

    throw new Error(`Unsupported formula character "${char}"`);
  }

  return tokens;
}

function isDigit(value: string) {
  return value >= "0" && value <= "9";
}

function isIdentifierStart(value: string) {
  return /[A-Za-z_]/.test(value);
}

function isIdentifierPart(value: string) {
  return /[A-Za-z0-9_.]/.test(value);
}

class FormulaParser {
  private index = 0;
  private readonly normalizedContext = new Map<string, number>();
  private readonly tokens: Token[];

  constructor(tokens: Token[], context: FormulaContext) {
    this.tokens = tokens;
    for (const [key, value] of Object.entries(context)) {
      const numeric = numericValue(value);
      if (numeric !== null) this.normalizedContext.set(key.toLowerCase(), numeric);
    }
  }

  parse() {
    if (this.tokens.length === 0) throw new Error("Formula is empty");
    const result = this.expression();
    if (this.peek()) throw new Error("Unexpected formula token");
    return result;
  }

  private expression(): number {
    let value = this.term();

    while (this.matchOperator("+") || this.matchOperator("-")) {
      const operator = this.previous().value;
      const next = this.term();
      value = operator === "+" ? value + next : value - next;
    }

    return value;
  }

  private term(): number {
    let value = this.factor();

    while (this.matchOperator("*") || this.matchOperator("/")) {
      const operator = this.previous().value;
      const next = this.factor();
      if (operator === "/" && next === 0) throw new Error("Division by zero");
      value = operator === "*" ? value * next : value / next;
    }

    return value;
  }

  private factor(): number {
    if (this.matchOperator("+")) return this.factor();
    if (this.matchOperator("-")) return -this.factor();

    const token = this.advance();
    if (!token) throw new Error("Unexpected end of formula");

    if (token.type === "number") return token.value;

    if (token.type === "identifier") {
      if (this.matchParen("(")) return this.callFunction(token.value);
      return this.reference(token.value);
    }

    if (token.type === "paren" && token.value === "(") {
      const value = this.expression();
      this.consumeParen(")");
      return value;
    }

    throw new Error("Unexpected formula token");
  }

  private callFunction(name: string) {
    const args: number[] = [];
    if (!this.matchParen(")")) {
      do {
        args.push(this.expression());
      } while (this.matchComma());
      this.consumeParen(")");
    }

    const normalizedName = name.toLowerCase();
    if (normalizedName === "sum") return args.reduce((sum, value) => sum + value, 0);
    if (normalizedName === "avg" || normalizedName === "average") {
      if (args.length === 0) throw new Error(`${name} requires values`);
      return args.reduce((sum, value) => sum + value, 0) / args.length;
    }
    if (normalizedName === "min") {
      if (args.length === 0) throw new Error("min requires values");
      return Math.min(...args);
    }
    if (normalizedName === "max") {
      if (args.length === 0) throw new Error("max requires values");
      return Math.max(...args);
    }
    if (normalizedName === "round") {
      if (args.length === 0) throw new Error("round requires a value");
      const places = args[1] ?? 0;
      const multiplier = 10 ** places;
      return Math.round(args[0] * multiplier) / multiplier;
    }

    throw new Error(`Unknown function "${name}"`);
  }

  private reference(name: string) {
    const value = this.normalizedContext.get(name.toLowerCase());
    if (value === undefined) throw new Error(`Unknown reference "${name}"`);
    return value;
  }

  private matchOperator(value: "+" | "-" | "*" | "/") {
    const token = this.peek();
    if (token?.type !== "operator" || token.value !== value) return false;
    this.index++;
    return true;
  }

  private matchParen(value: "(" | ")") {
    const token = this.peek();
    if (token?.type !== "paren" || token.value !== value) return false;
    this.index++;
    return true;
  }

  private matchComma() {
    const token = this.peek();
    if (token?.type !== "comma") return false;
    this.index++;
    return true;
  }

  private consumeParen(value: "(" | ")") {
    if (!this.matchParen(value)) throw new Error(`Expected "${value}"`);
  }

  private advance() {
    const token = this.peek();
    if (token) this.index++;
    return token;
  }

  private peek() {
    return this.tokens[this.index];
  }

  private previous() {
    return this.tokens[this.index - 1] as Extract<
      Token,
      { type: "operator" }
    >;
  }
}

function numericValue(value: number | string | null | undefined) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[$,%\s]/g, "");
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}
