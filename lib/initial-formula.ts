// Evalúa la fórmula de la hoja "CATEGORIA" tal cual está escrita, por ejemplo:
//   REDONDEAR.MAS(( Precio/1,03)* 0.25; -2)
// Solo admite números, "Precio", + - * / y paréntesis (no ejecuta código).

function parseNumberOrExpression(expr: string): number | null {
  const src = expr.replace(/\s+/g, "");
  if (!/^[0-9.+\-*/()]+$/.test(src)) return null;

  let pos = 0;

  const peek = () => src[pos];

  function parseExpr(): number | null {
    let left = parseTerm();
    if (left === null) return null;
    while (peek() === "+" || peek() === "-") {
      const op = src[pos++];
      const right = parseTerm();
      if (right === null) return null;
      left = op === "+" ? left + right : left - right;
    }
    return left;
  }

  function parseTerm(): number | null {
    let left = parseFactor();
    if (left === null) return null;
    while (peek() === "*" || peek() === "/") {
      const op = src[pos++];
      const right = parseFactor();
      if (right === null) return null;
      if (op === "/" && right === 0) return null;
      left = op === "*" ? left * right : left / right;
    }
    return left;
  }

  function parseFactor(): number | null {
    if (peek() === "-") {
      pos++;
      const v = parseFactor();
      return v === null ? null : -v;
    }
    if (peek() === "(") {
      pos++;
      const v = parseExpr();
      if (v === null || peek() !== ")") return null;
      pos++;
      return v;
    }
    const m = /^\d+(\.\d+)?|^\.\d+/.exec(src.slice(pos));
    if (!m) return null;
    pos += m[0].length;
    return Number(m[0]);
  }

  const result = parseExpr();
  return result !== null && pos === src.length && Number.isFinite(result)
    ? result
    : null;
}

/** Devuelve el valor de la fórmula para ese precio, o null si no se puede interpretar. */
export function evaluateInitialFormula(
  formula: string | null | undefined,
  precio: number
): number | null {
  if (!formula || !Number.isFinite(precio)) return null;

  const call = /^\s*=?\s*(?:redondear\.mas|roundup)\s*\(([\s\S]*)\)\s*$/i.exec(
    formula
  );
  if (!call) return null;

  const inner = call[1];

  // Separador de argumentos: ";" (o una coma final seguida del entero de redondeo)
  let exprPart: string;
  let digitsPart: string;
  const semi = inner.lastIndexOf(";");
  if (semi !== -1) {
    exprPart = inner.slice(0, semi);
    digitsPart = inner.slice(semi + 1);
  } else {
    const m = /^([\s\S]*),\s*(-?\d+)\s*$/.exec(inner);
    if (!m) return null;
    exprPart = m[1];
    digitsPart = m[2];
  }

  if (!/^\s*-?\d+\s*$/.test(digitsPart)) return null;
  const digits = Number(digitsPart);

  // "Precio" -> valor; coma decimal (1,03) -> punto
  const withPrice = exprPart
    .replace(/precio/gi, `(${precio})`)
    .replace(/(\d),(\d)/g, "$1.$2");

  const value = parseNumberOrExpression(withPrice);
  if (value === null || value < 0) return null;

  // REDONDEAR.MAS: redondeo hacia arriba a "digits" decimales (-2 = centenas)
  const factor = Math.pow(10, digits);
  return Math.ceil(value * factor - 1e-9) / factor;
}

/**
 * Evalúa la fórmula de cuota mensual de la hoja "CATEGORIA", tal cual está escrita.
 * Ejemplos soportados:
 *   CEILING(PMT((1+0.3)^(1/12)-1, 12, -(Precio-Inicial)), 5)
 *   CEILING(((Precio / 1.03) - Inicial) *1.20 / Cuotas, 10)
 * Variables: Precio, Inicial, Cuotas, IVA. Funciones: CEILING/TECHO/MULTIPLO.SUPERIOR,
 * PMT/PAGO, ROUNDUP/REDONDEAR.MAS. Operadores: + - * / ^ % y paréntesis.
 * Separador de argumentos: "," o ";" (con ";" la coma es decimal).
 * No ejecuta código: solo un parser aritmético propio. Devuelve null si no se puede interpretar.
 */
export type InstallmentVars = {
  precio: number;
  inicial: number;
  cuotas: number;
  iva?: number;
};

/** ¿La fórmula menciona la variable IVA? (entonces la fórmula decide cómo se suma) */
export function formulaUsesIva(formula: string | null | undefined): boolean {
  return !!formula && /\biva\b/i.test(formula);
}

/** ¿La fórmula divide el precio entre 1,03 (base neta)? */
export function formulaUsesNetBase(formula: string | null | undefined): boolean {
  return !!formula && /\/\s*\(?\s*1[.,]03\b/.test(formula);
}

class FormulaError extends Error {}

export function evaluateInstallmentFormula(
  formula: string | null | undefined,
  vars: InstallmentVars
): number | null {
  if (!formula) return null;
  const { precio, inicial, cuotas } = vars;
  const iva = vars.iva ?? 0;
  if (![precio, inicial, cuotas, iva].every(Number.isFinite) || cuotas <= 0) {
    return null;
  }

  let src = formula.trim().replace(/^=\s*/, "");
  if (src.includes(";")) {
    src = src.replace(/(\d),(\d)/g, "$1.$2").replace(/;/g, ",");
  }

  let pos = 0;
  const skip = () => {
    while (pos < src.length && /\s/.test(src[pos])) pos++;
  };
  const peek = () => {
    skip();
    return src[pos];
  };
  const eat = (ch: string) => {
    if (peek() !== ch) throw new FormulaError(`se esperaba "${ch}"`);
    pos++;
  };

  const variables: Record<string, number> = {
    precio,
    inicial,
    cuotas,
    iva,
  };

  function pmt(args: number[]): number {
    const [rate, nper, pv, fv = 0, type = 0] = args;
    if (args.length < 3 || nper <= 0) throw new FormulaError("PMT inválido");
    if (rate === 0) return -(pv + fv) / nper;
    const g = Math.pow(1 + rate, nper);
    return -((pv * g + fv) * rate) / ((1 + rate * type) * (g - 1));
  }

  const functions: Record<string, (a: number[]) => number> = {
    ceiling: (a) => {
      const [x, step] = a;
      if (!(step > 0)) throw new FormulaError("paso inválido");
      return Math.ceil(x / step - 1e-9) * step;
    },
    roundup: (a) => {
      const [x, digits] = a;
      const f = Math.pow(10, digits);
      return Math.ceil(x * f - 1e-9) / f;
    },
    pmt,
  };
  functions["techo"] = functions.ceiling;
  functions["multiplo.superior"] = functions.ceiling;
  functions["redondear.mas"] = functions.roundup;
  functions["pago"] = pmt;

  function parseExpr(): number {
    let left = parseTerm();
    for (;;) {
      const c = peek();
      if (c !== "+" && c !== "-") return left;
      pos++;
      const right = parseTerm();
      left = c === "+" ? left + right : left - right;
    }
  }

  function parseTerm(): number {
    let left = parseUnary();
    for (;;) {
      const c = peek();
      if (c !== "*" && c !== "/") return left;
      pos++;
      const right = parseUnary();
      if (c === "/" && right === 0) throw new FormulaError("división por cero");
      left = c === "*" ? left * right : left / right;
    }
  }

  function parseUnary(): number {
    const c = peek();
    if (c === "-") {
      pos++;
      return -parseUnary();
    }
    if (c === "+") {
      pos++;
      return parseUnary();
    }
    return parsePower();
  }

  function parsePower(): number {
    let base = parsePostfix();
    while (peek() === "^") {
      pos++;
      base = Math.pow(base, parsePostfix());
    }
    return base;
  }

  function parsePostfix(): number {
    let v = parsePrimary();
    while (peek() === "%") {
      pos++;
      v = v / 100;
    }
    return v;
  }

  function parsePrimary(): number {
    const c = peek();
    if (c === "(") {
      pos++;
      const v = parseExpr();
      eat(")");
      return v;
    }

    const rest = src.slice(pos);
    const num = /^(\d+(\.\d+)?|\.\d+)/.exec(rest);
    if (num) {
      pos += num[0].length;
      return Number(num[0]);
    }

    const id = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(rest);
    if (!id) throw new FormulaError("token inesperado");
    pos += id[0].length;
    const name = id[0].toLowerCase();

    if (peek() === "(") {
      const fn = functions[name];
      if (!fn) throw new FormulaError(`función no soportada: ${name}`);
      pos++;
      const args: number[] = [];
      if (peek() !== ")") {
        for (;;) {
          args.push(parseExpr());
          if (peek() === ",") {
            pos++;
            continue;
          }
          break;
        }
      }
      eat(")");
      return fn(args);
    }

    if (name in variables) return variables[name];
    throw new FormulaError(`variable desconocida: ${name}`);
  }

  try {
    const value = parseExpr();
    skip();
    if (pos !== src.length) return null;
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}
