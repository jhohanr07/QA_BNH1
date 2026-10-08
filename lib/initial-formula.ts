// Evalúa las fórmulas de la hoja "CATEGORIA" tal cual están escritas, por ejemplo:
//   REDONDEAR.MAS(( Precio/1,03)* 0.25; -2)
//   CEILING(((Precio / 1.03) - Inicial) * PMT(0.029, Cuotas, -1), 10)
// Solo admite números, "Precio", "Inicial", "Cuotas", PMT, + - * / y paréntesis (no ejecuta código).

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

function toNum(s: string): number {
  return Number(s.trim().replace(",", "."));
}

/**
 * Reemplaza cada PMT(tasa, nper, va) por su valor numérico (igual que Google Sheets):
 *   PMT = -va * r / (1 - (1 + r)^-n)     (con va = -1 da la cuota por cada $1 financiado)
 * "nper" puede ser la palabra Cuotas. Devuelve null si algún PMT no se puede interpretar.
 */
function replacePmt(expr: string, cuotas: number): string | null {
  let failed = false;

  const out = expr.replace(
    /(?:pmt|pago)\s*\(\s*([^,;()]+?)\s*[,;]\s*([^,;()]+?)\s*[,;]\s*([^,;()]+?)\s*\)/gi,
    (_m, rateS: string, nS: string, pvS: string) => {
      const rate = toNum(rateS);
      const n = /^cuotas$/i.test(nS.trim()) ? cuotas : toNum(nS);
      const pv = toNum(pvS);

      if (![rate, n, pv].every(Number.isFinite) || n <= 0) {
        failed = true;
        return "0";
      }

      const pmt =
        rate === 0 ? -pv / n : (-pv * rate) / (1 - Math.pow(1 + rate, -n));

      if (!Number.isFinite(pmt)) {
        failed = true;
        return "0";
      }
      return `(${pmt.toFixed(12)})`;
    }
  );

  return failed ? null : out;
}

/**
 * Evalúa la fórmula de la cuota mensual de la hoja "CATEGORIA", tal cual, por ejemplo:
 *   CEILING(((Precio / 1.03) - Inicial) * 1.20 / Cuotas, 10)
 *   CEILING(((Precio / 1.03) - Inicial) * PMT(0.029, Cuotas, -1), 10)
 * "Precio", "Inicial" y "Cuotas" se reemplazan por sus valores. El último argumento es el
 * múltiplo al que se redondea hacia arriba. También acepta TECHO / MULTIPLO.SUPERIOR y ";"
 * como separador. Devuelve null si no se puede interpretar.
 */
export function evaluateInstallmentFormula(
  formula: string | null | undefined,
  vars: { precio: number; inicial: number; cuotas: number }
): number | null {
  if (!formula) return null;
  const { precio, inicial, cuotas } = vars;
  if (![precio, inicial, cuotas].every(Number.isFinite) || cuotas <= 0) {
    return null;
  }

  const call =
    /^\s*=?\s*(?:ceiling|techo|multiplo\.superior)\s*\(([\s\S]*)\)\s*$/i.exec(
      formula
    );
  if (!call) return null;

  const inner = call[1];

  let exprPart: string;
  let stepPart: string;
  const semi = inner.lastIndexOf(";");
  if (semi !== -1) {
    exprPart = inner.slice(0, semi);
    stepPart = inner.slice(semi + 1);
  } else {
    const m = /^([\s\S]*),\s*(\d+(?:[.,]\d+)?)\s*$/.exec(inner);
    if (!m) return null;
    exprPart = m[1];
    stepPart = m[2];
  }

  const step = toNum(stepPart);
  if (!Number.isFinite(step) || step <= 0) return null;

  // 1) PMT primero (antes de tocar comas decimales y variables)
  const withoutPmt = replacePmt(exprPart, cuotas);
  if (withoutPmt === null) return null;

  // 2) Variables y coma decimal
  const withVars = withoutPmt
    .replace(/precio/gi, `(${precio})`)
    .replace(/inicial/gi, `(${inicial})`)
    .replace(/cuotas/gi, `(${cuotas})`)
    .replace(/(\d),(\d)/g, "$1.$2");

  const value = parseNumberOrExpression(withVars);
  if (value === null || value <= 0) return null;

  // CEILING(valor; paso): redondeo hacia arriba al múltiplo de "paso"
  return Math.ceil(value / step - 1e-9) * step;
}