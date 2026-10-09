/**
 * BNH Medical — Calculadora de Financiamiento
 * ------------------------------------------------------------------
 * Backend en Google Apps Script, vinculado al Google Sheet que actúa
 * como base de datos de la calculadora.
 *
 *     QAQAQAQAQAQAQAQAQAQAQQQQQQAQAAQA 
 *
 *     proyecto Next.js (Vercel).
 */

var SHEET_PRECIOS = "PRECIO EQUIPOS";
var SHEET_CATEGORIA = "CATEGORIA";
var SHEET_FUNEL = "FUNEL DE VENTA";
var SHEET_VENDEDORES = "VENDEDORES";

// Color de marca reutilizado en el correo y en el PDF (mismo tono que
// el botón "Enviar cotización" del frontend).
var BRAND_COLOR = "#0d6f91";
var DARK_COLOR = "#123047";

// Datos fijos del emisor, tal como aparecen en la plantilla de cotización.
var EMISOR = {
  nombre: "BNH Equipos y Suministros Médicos, S.A.",
  rif: "J-50348768-2",
  direccionLineas: [
    "Calle B, Edif. Conjunto Ciudad Center, Torre F, Piso 1, Ofic. 12-F",
    "Urb. Industrial Boleíta Norte, Caracas, Miranda. Zona Postal 1071",
  ],
  web: "bnhmedical.com",
  instagram: "@bnhmedical",
};

var FUNEL_HEADERS = [
  "N° Cotización",
  "Fecha",
  "Vendedor",
  "Lead",
  "Telefono",
  "Email",
  "Equipo",
  "Categoria",
  "Base Imponible",
  "Monto Inicial",
  "Cuotas",
  "Cuota Mensual",
  "Total a Pagar",
  "IVA Financiado",
  "IVA a Pagar",
  "Precio Contado",
  "IVA Contado",
  "Total Contado",
  "IVA Credito",
  "Total Credito (Base + IVA)",
  "IVA Ajustado",
];

function doGet(e) {
  try {
    var action = e.parameter.action;

    if (action === "getEquipos") {
      return jsonResponse_({ success: true, equipos: getEquipos_() });
    }

    if (action === "getCategorias") {
      return jsonResponse_({ success: true, categorias: getCategorias_() });
    }

    if (action === "getVendedores") {
      return jsonResponse_({ success: true, vendedores: getVendedores_() });
    }

    return jsonResponse_({ success: false, error: "Acción no reconocida." });
  } catch (err) {
    return jsonResponse_({ success: false, error: String(err) });
  }
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);

    if (body.action === "saveQuote") {
      return jsonResponse_(saveQuoteAndNotify_(body));
    }

    return jsonResponse_({ success: false, error: "Acción no reconocida." });
  } catch (err) {
    return jsonResponse_({ success: false, error: String(err) });
  }
}

/** Lee toda la hoja de precios en una sola lectura por lotes (sin acceso celda a celda). */
function getEquipos_() {
  var sheet = getSheet_(SHEET_PRECIOS);
  var values = sheet.getDataRange().getValues();

  if (values.length < 2) return [];

  var headers = values[0].map(function (h) {
    return normalizeName_(h);
  });

  var idxId = headers.indexOf("id");
  var idxNombre = headers.indexOf("nombre");
  var idxCategoria = headers.indexOf("categoria");
  var idxCredito = headers.indexOf("credito");
  if (idxCredito === -1) idxCredito = headers.indexOf("precio"); // compatibilidad con la hoja anterior
  var idxContado = headers.indexOf("contado");
  var idxBaseAj = headers.indexOf("base ajustada");
  var idxIvaAj = headers.indexOf("iva ajustado");

  if (idxNombre === -1 || idxCredito === -1) {
    throw new Error(
      'La hoja "' + SHEET_PRECIOS + '" debe tener columnas "Nombre" y "Credito".'
    );
  }

  var rows = values.slice(1);
  var equipos = [];

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (!row[idxNombre]) continue;

    equipos.push({
      // La columna ID de la hoja se repite (MX, N7, ...): el id único es el N° de fila.
      id: "r" + (i + 2),
      codigo: idxId !== -1 ? String(row[idxId] || "") : "",
      nombre: String(row[idxNombre]),
      categoria: idxCategoria !== -1 ? String(row[idxCategoria]).trim() : "",
      precioCredito: toNumber_(row[idxCredito]),
      precioContado: idxContado !== -1 ? toNumber_(row[idxContado]) : 0,
      baseAjustada: idxBaseAj !== -1 ? toNumber_(row[idxBaseAj]) : 0,
      ivaAjustado: idxIvaAj !== -1 ? toNumber_(row[idxIvaAj]) : 0,
    });
  }

  return equipos;
}

/**
 * Lee la hoja "CATEGORIA" y devuelve una entrada por categoría (columna A,
 * valores únicos) con sus condiciones de financiamiento ya interpretadas.
 */
function getCategorias_() {
  var sheet = getSheet_(SHEET_CATEGORIA);
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];

  // Fila de encabezados = primera fila (de las 10 primeras) que tenga una celda "Categoria".
  var hr = -1;
  for (var r = 0; r < Math.min(values.length, 10) && hr === -1; r++) {
    for (var k = 0; k < values[r].length; k++) {
      if (normalizeName_(values[r][k]) === "categoria") { hr = r; break; }
    }
  }
  if (hr === -1) hr = 0;

  var headers = values[hr].map(function (h) { return String(h).trim(); });
  var norm = headers.map(normalizeName_);

  var idxCat = norm.indexOf("categoria");
  if (idxCat === -1) idxCat = 0;
  var idxMin = norm.indexOf("inicial minima");
  var idxSug = norm.indexOf("inicial sugerida");

   // Bloque AIRR (L:N): la palabra "AIRR" puede estar en la fila de encabezados o en la de arriba.
  var groupRow = hr > 0 ? values[hr - 1] : [];
  var airrCol = norm.indexOf("airr");
  if (airrCol === -1) {
    for (var gc = 0; gc < groupRow.length; gc++) {
      if (normalizeName_(groupRow[gc]) === "airr") { airrCol = gc; break; }
    }
  }
  // Desde AIRR en adelante son datos auxiliares, no plazos con fórmula.
  var endCol = airrCol !== -1 ? airrCol : headers.length;

  var airrCols = [];
  if (airrCol !== -1) {
    for (var ac = airrCol; ac < headers.length; ac++) {
      var am = parseTermHeader_(norm[ac]);
      if (am !== null) airrCols.push({ col: ac, meses: am });
    }
  }

  var mode = "ambos";
  var termCols = [];
  var usados = {};
  for (var c = 0; c < endCol; c++) {
    var g = normalizeName_(groupRow[c]);
    if (g) {
      if (/\bno\b/.test(g)) mode = "no";
      else if (/\bsi\b/.test(g)) mode = "si";
      else mode = "ambos";
    }
    if (c === idxCat || c === idxMin || c === idxSug) continue;
    var meses = parseTermHeader_(norm[c]);
    if (meses === null) continue;
    var key = meses + "|" + mode;
    if (usados[key]) continue;
    usados[key] = true;
    termCols.push({ col: c, meses: meses, mode: mode });
  }

    if (termCols.length === 0 && airrCols.length === 0) {
    throw new Error(
      'La hoja "' + SHEET_CATEGORIA + '" no tiene columnas de plazo reconocibles. Encabezados leídos: ' +
      headers.join(" | ")
    );
  }

  var byKey = {};
  var order = [];

  for (var i = hr + 1; i < values.length; i++) {
    var row = values[i];
    var nombre = String(row[idxCat] || "").trim();
    if (!nombre) continue;

    var ck = normalizeName_(nombre);
    if (!byKey[ck]) {
      byKey[ck] = { nombre: nombre, inicialMinima: null, inicialSugerida: null, plazosSi: [], plazosNo: [], airr: []  };
      order.push(ck);
    }
    var cat = byKey[ck];

    if (!cat.inicialMinima && idxMin !== -1) cat.inicialMinima = parseInitialRule_(row[idxMin]);
    if (!cat.inicialSugerida && idxSug !== -1) cat.inicialSugerida = parseInitialRule_(row[idxSug]);

    for (var t = 0; t < termCols.length; t++) {
      var tc = termCols[t];
      var resolved = resolveCellRefs_(row[tc.col], values);
      var rate = parseTermRate_(resolved, tc.meses);
      if (!rate) continue;

      var plazo = { meses: tc.meses, formula: rate.formula, factor: rate.factor, tasaMensual: rate.tasaMensual };
      if (tc.mode === "si" || tc.mode === "ambos") cat.plazosSi.push(plazo);
      if (tc.mode === "no" || tc.mode === "ambos") cat.plazosNo.push(plazo);
    }
    for (var a = 0; a < airrCols.length; a++) {
      var tasa = parseAirr_(row[airrCols[a].col]);
      if (tasa === null) continue; // "Sin calculo" o vacío = plazo no disponible
      var mesesA = airrCols[a].meses;
      var yaEsta = cat.airr.some(function (p) { return p.meses === mesesA; });
      if (!yaEsta) cat.airr.push({ meses: mesesA, tasa: tasa });
    }
  }

  return order.map(function (k) {
    var cat = byKey[k];
    cat.plazosSi.sort(function (a, b) { return a.meses - b.meses; });
    cat.plazosNo.sort(function (a, b) { return a.meses - b.meses; });
    cat.airr.sort(function (a, b) { return a.meses - b.meses; });
    return cat;
  });
}

/** Convierte "L" -> 11, "AA" -> 26 (índice base 0). */
function colLetterToIndex_(letters) {
  var n = 0;
  for (var i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n - 1;
}

/**
 * Reemplaza referencias de celda ($L3, $L$2, M3...) por su valor numérico.
 * Si alguna apunta a algo no numérico ("Sin calculo", vacío), devuelve "Sin calculo".
 */
function resolveCellRefs_(cell, values) {
  if (typeof cell !== "string") return cell;
  var ok = true;
  var out = cell.replace(/(^|[^A-Za-z0-9_.])\$?([A-Z]{1,3})\$?(\d+)(?![\d(A-Za-z_])/g,
    function (m, pre, col, rowN) {
      var v = (values[Number(rowN) - 1] || [])[colLetterToIndex_(col)];
      if (typeof v === "number" && isFinite(v)) return pre + "(" + v + ")";
      ok = false;
      return m;
    });
  return ok ? out : "Sin calculo";
}

/**
 * Número de meses a partir del encabezado (ya normalizado) de una columna de plazo.
 * Acepta "12", "12 cuotas", "12 meses", "cuotas 12", "plazo 12", "12m".
 * Devuelve null si el encabezado no es de plazo.
 */
function parseTermHeader_(normHeader) {
  var h = String(normHeader || "").trim();
  if (!h) return null;

  var m = h.match(/^(\d{1,3})\s*(?:cuotas?|meses|mes|m|plazo)?$/) ||
          h.match(/^(?:cuotas?|meses|mes|plazo)\s*(?:de\s*)?(\d{1,3})$/);
  if (!m) return null;

  var n = Number(m[1]);
  return n > 0 ? n : null;
}

/**
 * Regla de inicial. Devuelve el texto de la fórmula tal cual (el front la evalúa:
 * "REDONDEAR.MAS(( Precio/1,03)* 0.25; -2)") y, como respaldo/etiqueta, el
 * porcentaje y el redondeo. También acepta un número (0.20 / 20%).
 */
function parseInitialRule_(cell) {
  if (cell === "" || cell === null || cell === undefined) return null;

  if (typeof cell === "number") {
    if (cell <= 0) return null;
    return { pct: cell > 1 ? cell / 100 : cell, digitos: null, formula: null };
  }

  var text = String(cell);

  // Porcentaje: el último factor "* 0.25" de la fórmula (o "20%")
  var pct = null;
  var re = /\*\s*(\d+(?:[.,]\d+)?)(?![.,\d])/g;
  var m;
  while ((m = re.exec(text)) !== null) {
    var v = parseFloat(m[1].replace(",", "."));
    if (isFinite(v) && v > 0 && v <= 1) pct = v;
  }
  if (pct === null) {
    var mp = text.match(/(\d+(?:[.,]\d+)?)\s*%/);
    if (mp) pct = parseFloat(mp[1].replace(",", ".")) / 100;
  }

  // Redondeo: el entero que cierra la función, ej. "; -2)"
  var d = text.match(/[;]\s*(-?\d+)\s*\)\s*$/) || text.match(/,\s*(-?\d+)\s*\)\s*$/);

  var hasFormula = /redondear|roundup/i.test(text);
  if (pct === null && !hasFormula) return null;

  return {
    pct: pct,
    digitos: d ? Number(d[1]) : null,
    formula: hasFormula ? text.trim() : null,
  };
}

/**
 * Interpreta la celda de un plazo. Devuelve { formula, factor, tasaMensual } o null si
 * el plazo no está disponible ("Sin calculo" / vacío / no interpretable).
 *
 *  - Fórmula de cuota (formato actual):
 *      "CEILING(((Precio / 1.03) - Inicial) *1.20 / Cuotas, 10)"
 *    -> { formula: <texto tal cual>, factor: 1.20, tasaMensual: null }
 *    (el front evalúa la fórmula; "factor" es solo respaldo y etiqueta).
 *  - Formato anterior: "=(1.30 ^ (1 / 18))" -> { formula: null, factor: 1.30, tasaMensual: 1.30^(1/18) - 1 }
 */
function parseTermRate_(cell, meses) {
  if (cell === "" || cell === null || cell === undefined) return null;

  if (typeof cell !== "number") {
    var raw = String(cell).trim();
    if (!raw || /sin\s*c[aá]lculo/i.test(raw)) return null;

    if (/^=?\s*(ceiling|techo|multiplo\.superior)\s*\(/i.test(raw)) {
      return { formula: raw.replace(/^=\s*/, ""), factor: extractMultiplier_(raw), tasaMensual: null };
    }
  }

  var factor = null;

  if (typeof cell === "number") {
    if (cell > 0 && cell < 1) factor = 1 + cell;       // 0.30 -> 1.30
    else if (cell > 1 && cell < 3) factor = cell;      // 1.30
  } else {
    var text = String(cell);

    var m = text.match(/\(\s*(\d+(?:[.,]\d+)?)\s*\^/);
    if (m) {
      factor = parseFloat(m[1].replace(",", "."));
    } else {
      var mm = text.match(/(\d+(?:[.,]\d+)?)\s*%\s*mensual/i);
      if (mm) {
        var monthly = parseFloat(mm[1].replace(",", ".")) / 100;
        factor = Math.pow(1 + monthly, meses);
      }
    }
  }

  if (!factor || !isFinite(factor) || factor <= 1 || factor >= 3) return null;
  return { formula: null, factor: factor, tasaMensual: Math.pow(factor, 1 / meses) - 1 };
}

/** Primer multiplicador entre 1 y 3 que sigue a un "*" en la fórmula (ej. "*1.20" -> 1.2). */
function extractMultiplier_(text) {
  var re = /\*\s*(\d+(?:[.,]\d+)?)/g;
  var m;
  while ((m = re.exec(text)) !== null) {
    var v = parseFloat(m[1].replace(",", "."));
    if (isFinite(v) && v > 1 && v < 3) return v;
  }
  return null;
}
/** AIRR de una celda: 0.25, 25 o "25%" -> 0.25. "Sin calculo"/vacío -> null. */
function parseAirr_(cell) {
  if (typeof cell === "number") {
    if (!isFinite(cell) || cell <= 0) return null;
    return cell > 1 ? cell / 100 : cell;
  }
  var m = String(cell || "").match(/^\s*(\d+(?:[.,]\d+)?)\s*%?\s*$/);
  if (!m) return null;
  var v = parseFloat(m[1].replace(",", "."));
  if (!isFinite(v) || v <= 0) return null;
  return v > 1 ? v / 100 : v;
}

/** Número desde una celda (acepta números y textos como "$12.855,00"). */
function toNumber_(v) {
  if (typeof v === "number") return isFinite(v) ? v : 0;
  var t = String(v || "").replace(/[^0-9,.\-]/g, "");
  if (!t) return 0;
  if (t.indexOf(",") !== -1) t = t.replace(/\./g, "").replace(",", "."); // formato 12.855,00
  var n = Number(t);
  return isFinite(n) ? n : 0;
}

/** Devuelve solo los nombres de la hoja "VENDEDORES" (los correos no se exponen). */
function getVendedores_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_VENDEDORES);
  if (!sheet) return [];

  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];

  var headers = values[0].map(function (h) {
    return String(h).trim().toLowerCase();
  });
  var idxNombre = headers.indexOf("nombre");
  if (idxNombre === -1) return [];

  var nombres = [];
  for (var i = 1; i < values.length; i++) {
    var nombre = String(values[i][idxNombre] || "").trim();
    if (nombre) nombres.push(nombre);
  }
  return nombres;
}

/** Guarda la cotización en "FUNEL DE VENTA", genera el PDF y envía el correo. */
function saveQuoteAndNotify_(data) {
  var required = ["leadName", "leadEmail", "vendedorName"];
  for (var i = 0; i < required.length; i++) {
    if (!data[required[i]]) {
      return { success: false, error: "Falta el campo obligatorio: " + required[i] };
    }
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(data.leadEmail).trim())) {
    return { success: false, error: "El email del lead no es válido." };
  }

  var fields = ["leadName", "leadPhone", "leadEmail", "vendedorName", "equipo", "categoria"];
  for (var j = 0; j < fields.length; j++) {
    if (String(data[fields[j]] || "").length > 200) {
      return { success: false, error: "El campo " + fields[j] + " es demasiado largo." };
    }
  }

  var sheet = getSheet_(SHEET_FUNEL);
  var numero;

  // Evita filas mezcladas y números de cotización repetidos si dos
  // vendedores guardan al mismo tiempo.
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    ensureFunnelHeaders_(sheet);
    numero = generateQuoteNumber_(sheet); // correlativo = fila que ocupará la nueva cotización
    appendQuoteRow_(sheet, data, numero);
  } finally {
    lock.releaseLock();
  }

  var vendedorEmail = findVendedorEmail_(data.vendedorName);

  var pdfBlob = null;
  var pdfWarning = "";
  try {
    pdfBlob = buildQuotePdfBlob_(data, numero);
  } catch (pdfErr) {
    pdfWarning = "No se pudo adjuntar el PDF de la cotización: " + pdfErr;
  }

  sendQuoteEmail_(data, vendedorEmail, pdfBlob);

  var warnings = [];
  if (!vendedorEmail) {
    warnings.push(
      'No se encontró el correo del vendedor "' +
        data.vendedorName +
        '" en la hoja "' +
        SHEET_VENDEDORES +
        '". Se envió el correo solo al lead.'
    );
  }
  if (pdfWarning) warnings.push(pdfWarning);

  return {
    success: true,
    numero: numero,
    warning: warnings.length ? warnings.join(" ") : undefined,
  };
}

function generateQuoteNumber_(sheet) {
  var correlativo = sheet.getLastRow(); // encabezado = fila 1, así que esto ya es 1-based
  var tz = Session.getScriptTimeZone();
  var fecha = Utilities.formatDate(new Date(), tz, "yyyyMMdd");
  return "COT-" + fecha + "-" + ("000" + correlativo).slice(-3);
}

function appendQuoteRow_(sheet, data, numero) {
  sheet.appendRow([
    numero,
    new Date(),
    data.vendedorName || "",
    data.leadName || "",
    data.leadPhone || "",
    data.leadEmail || "",
    data.equipo || "",
    data.categoria || "",
    Number(data.basePrice) || 0,
    Number(data.initialAmount) || 0,
    Number(data.installments) || 0,
    Number(data.monthlyPayment) || 0,
    Number(data.totalToPay) || 0,
    data.ivaFinancing === "no" ? "No" : "Sí",
    Number(data.ivaToPay) || 0,
    hasContado_(data) ? Number(data.contadoPrecio) || 0 : "",
    hasContado_(data) ? Number(data.contadoIva) || 0 : "",
    hasContado_(data) ? Number(data.contadoTotal) || 0 : "",
    Number(data.creditoIva) || 0,
    Number(data.creditoTotal) || 0,
    data.ajustado ? "Sí" : "No",
  ]);
}

function ensureFunnelHeaders_(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(FUNEL_HEADERS);
    return;
  }

  // Hoja ya existente con los encabezados anteriores: agrega los nuevos al final.
  var current = sheet.getLastColumn();
  if (current < FUNEL_HEADERS.length) {
    sheet
      .getRange(1, current + 1, 1, FUNEL_HEADERS.length - current)
      .setValues([FUNEL_HEADERS.slice(current)]);
  }
}

/** Busca en la hoja "VENDEDORES" el correo asociado a un nombre (sin distinguir mayúsculas/acentos/espacios dobles). */
function findVendedorEmail_(nombreVendedor) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_VENDEDORES);
  if (!sheet) return "";

  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return "";

  var headers = values[0].map(normalizeName_);
  var idxNombre = headers.indexOf("nombre");
  var idxEmail = headers.indexOf("email");
  if (idxEmail === -1) idxEmail = headers.indexOf("e-mail");
  if (idxEmail === -1) idxEmail = headers.indexOf("correo");
  if (idxNombre === -1 || idxEmail === -1) return "";

  var clean = function (s) { return normalizeName_(s).replace(/\s+/g, " "); };
  var target = clean(nombreVendedor);

  for (var i = 1; i < values.length; i++) {
    if (clean(values[i][idxNombre]) === target) {
      var mail = String(values[i][idxEmail] || "").replace(/\s+/g, "");
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail) ? mail : "";
    }
  }
  return "";
}

function normalizeName_(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/* ------------------------------------------------------------------ */
/* Correo                                                              */
/* ------------------------------------------------------------------ */

function sendQuoteEmail_(data, vendedorEmail, pdfBlob) {
  var subject = "Propuesta de financiamiento BNH Medical" + (data.equipo ? " - " + data.equipo : "");
  var html = buildQuoteEmailHtml_(data);

  var options = { htmlBody: html };
  if (vendedorEmail) options.cc = vendedorEmail;
  if (pdfBlob) options.attachments = [pdfBlob];

  MailApp.sendEmail(data.leadEmail, subject, "", options);
}

/**
 * Cuerpo del correo. Estructura:
 *  - Equipo / Categoría
 *  - De contado: precio, impuesto a pagar en Bs., total a pagar precio contado
 *  - Crédito: inicial, cantidad de cuotas, cuota mensual,
 *             cuota especial de I.V.A. en Bs., total a pagar financiado
 */
function buildQuoteEmailHtml_(data) {
  // Solo se acepta un logo por https (evita inyectar URLs arbitrarias en el correo)
  var logo = /^https:\/\/[^\s"'<>]+$/.test(String(data.logoUrl || ""))
    ? '<img src="' + escapeHtml_(data.logoUrl) + '" alt="BNH Medical" style="height:60px; margin-bottom:12px;">'
    : "";

  return (
    '<div style="font-family: Verdana, sans-serif; color:#111;">' +
    logo +
    '<h2 style="color:' + BRAND_COLOR + ';">Propuesta de Financiamiento — BNH Medical</h2>' +
    "<p>Estimado(a) <strong>" + escapeHtml_(data.leadName) + "</strong>,</p>" +
    "<p>Adjuntamos la cotización en PDF con el detalle completo de la propuesta. Aquí un resumen:</p>" +
    '<table style="border-collapse:collapse; width:100%; max-width:480px;">' +
    row_("Equipo", escapeHtml_(data.equipo)) +
    row_("Categoría", escapeHtml_(data.categoria)) +
    contadoEmailRows_(data) +
    row_("Monto inicial", formatMoney_(data.initialAmount)) +
    row_("Cantidad de cuotas", String(Number(data.installments) || 0)) +
    row_("Cuota mensual", "<strong>" + formatMoney_(data.monthlyPayment) + "</strong>", true) +
    row_("Cuota especial de I.V.A. en Bs.", formatMoney_(data.ivaToPay)) +
    row_("Total a pagar financiado", "<strong>" + formatMoney_(data.totalToPay) + "</strong>") +
    "</table>" +
    '<p style="margin-top:16px;">Vendedor a cargo: <strong>' + escapeHtml_(data.vendedorName) + "</strong></p>" +
    '<p style="color:#888; font-size:12px;">Esta propuesta es una simulación comercial y puede variar según las condiciones finales de la operación.</p>' +
    "</div>"
  );
}

// Etiquetas del I.V.A. usadas en el PDF.
function ivaCreditoLabel_(data) {
  return data.ajustado ? "I.V.A. (ajustado)" : "I.V.A. (16%)";
}

function ivaContadoLabel_(data) {
  return data.ajustado ? "I.V.A. (ajustado)" : "I.V.A. (16%)";
}

function contadoEmailRows_(data) {
  if (!hasContado_(data)) return "";
  return (
    '<tr><td colspan="2" style="padding:8px 0 2px; font-weight:bold; color:' + BRAND_COLOR + ';">De contado</td></tr>' +
    row_("Precio de contado", formatMoney_(data.contadoPrecio)) +
    row_("Impuesto a pagar en Bs.", formatMoney_(data.contadoIva)) +
    row_("Total a pagar precio contado", "<strong>" + formatMoney_(data.contadoTotal) + "</strong>") +
    '<tr><td colspan="2" style="padding:12px 0 2px; font-weight:bold; color:' + BRAND_COLOR + ';">Crédito</td></tr>'
  );
}

function row_(label, value, highlight) {
  var border = highlight ? "border-top:2px solid " + BRAND_COLOR + ";" : "";
  return (
    '<tr><td style="padding:6px 0; ' + border + '">' + label + "</td>" +
    '<td style="padding:6px 0; text-align:right; ' + border + '">' + value + "</td></tr>"
  );
}

/* ------------------------------------------------------------------ */
/* PDF de la cotización ("Cotización de Servicios")                    */
/* ------------------------------------------------------------------ */

/**
 * Genera el PDF de la cotización con DocumentApp y lo devuelve como Blob.
 * No incluye RIF ni dirección del cliente (a propósito): solo nombre,
 * teléfono y correo. Está compactado para que quede en una sola hoja.
 */
function buildQuotePdfBlob_(data, numero) {
  var tz = Session.getScriptTimeZone();
  var fecha = Utilities.formatDate(new Date(), tz, "dd/MM/yyyy");

  var doc = DocumentApp.create("Cotizacion " + numero);
  var docId = doc.getId();

  try {
    var body = doc.getBody();
    body.setMarginTop(24).setMarginBottom(24).setMarginLeft(40).setMarginRight(40);

    appendLogo_(body, data.logoUrl);

    var title = body.appendParagraph("Cotización de Servicios");
    title.setFontSize(20).setBold(true).setForegroundColor(DARK_COLOR);
    title.setSpacingBefore(2).setSpacingAfter(0);

    var subtitle = body.appendParagraph(EMISOR.nombre);
    subtitle.setFontSize(10).setForegroundColor("#666666").setSpacingBefore(0).setSpacingAfter(8);

    appendClientIssuerTable_(body, data);

    var meta = body.appendParagraph("N° de cotización: " + numero + "      Fecha: " + fecha);
    meta.setFontSize(10).setForegroundColor("#333333").setSpacingBefore(8).setSpacingAfter(8);

    appendProductTable_(body, data);
    appendSummary_(body, data);
    appendFinancingDetail_(body, data);
    appendConditions_(body);
    appendFooter_(body);

    // Quita el párrafo vacío inicial que crea Docs por defecto (ahorra espacio).
    try {
      var first = body.getChild(0);
      if (
        body.getNumChildren() > 1 &&
        first.getType() === DocumentApp.ElementType.PARAGRAPH &&
        first.asParagraph().getText() === "" &&
        first.asParagraph().getNumChildren() === 0
      ) {
        first.removeFromParent();
      }
    } catch (trimErr) {
      // No es crítico si no se puede quitar.
    }

    doc.saveAndClose();

    var pdfBlob = DriveApp.getFileById(docId).getAs("application/pdf");
    pdfBlob.setName("Cotizacion-" + numero + ".pdf");
    return pdfBlob;
  } finally {
    // El documento temporal solo se usa para exportar el PDF; se descarta.
    try {
      DriveApp.getFileById(docId).setTrashed(true);
    } catch (cleanupErr) {
      // Si falla el borrado no debe interrumpir el envío de la cotización.
    }
  }
}

function appendLogo_(body, logoUrl) {
  if (!/^https:\/\/[^\s"'<>]+$/.test(String(logoUrl || ""))) return;

  try {
    var imgBlob = UrlFetchApp.fetch(logoUrl).getBlob();
    var img = body.appendImage(imgBlob);
    var ratio = img.getHeight() / img.getWidth();
    img.setWidth(110);
    img.setHeight(Math.round(110 * ratio));
  } catch (err) {
    // Si no se puede descargar el logo, el PDF se genera sin imagen.
  }
}

function appendClientIssuerTable_(body, data) {
  var table = body.appendTable([["", ""]]);
  table.setBorderWidth(0);

  var row = table.getRow(0);
  fillInfoCell_(row.getCell(0), "Datos del Cliente", [
    data.leadName || "-",
    "Teléfono: " + (data.leadPhone || "-"),
    "Correo: " + (data.leadEmail || "-"),
  ]);
  fillInfoCell_(
    row.getCell(1),
    "Datos del Emisor",
    [EMISOR.nombre, "RIF: " + EMISOR.rif].concat(EMISOR.direccionLineas)
  );
}

function fillInfoCell_(cell, heading, lines) {
  cell.setWidth(250);

  var headingP = cell.getChild(0).asParagraph();
  headingP.setText(heading);
  headingP.setBold(true).setForegroundColor(BRAND_COLOR).setFontSize(11);

  for (var i = 0; i < lines.length; i++) {
    var p = cell.appendParagraph(lines[i]);
    p.setFontSize(9.5).setForegroundColor("#333333");
  }
}

function appendProductTable_(body, data) {
  var rows = [
    ["Producto", "Cantidad", "Precio", "Subtotal"],
    [
      data.equipo || "Equipo cotizado",
      "1",
      formatMoney_(data.basePrice),
      formatMoney_(data.basePrice),
    ],
  ];

  var table = body.appendTable(rows);
  table.setBorderColor("#cccccc").setBorderWidth(1);

  var headerRow = table.getRow(0);
  for (var c = 0; c < headerRow.getNumCells(); c++) {
    var cell = headerRow.getCell(c);
    cell.setBackgroundColor(BRAND_COLOR);
    var p = cell.getChild(0).asParagraph();
    p.setBold(true).setForegroundColor("#ffffff").setFontSize(10);
  }

  var dataRow = table.getRow(1);
  for (var d = 0; d < dataRow.getNumCells(); d++) {
    dataRow.getCell(d).getChild(0).asParagraph().setFontSize(10);
  }
}

function hasContado_(data) {
  return (
    data.contadoTotal !== undefined &&
    data.contadoTotal !== null &&
    data.contadoTotal !== ""
  );
}

/**
 * Resumen del PDF: solo el bloque "DE CONTADO" (sin texto de cálculo en el I.V.A.).
 * Si la cotización no trae datos de contado, se muestra el bloque "CRÉDITO"
 * para que el resumen nunca quede vacío.
 */
function appendSummary_(body, data) {
  var sp = body.appendParagraph("");
  sp.setSpacingBefore(0).setSpacingAfter(0).setFontSize(4);

  var cells;
  if (hasContado_(data)) {
    cells = [
      ["DE CONTADO", ""],
      ["Precio de contado (base)", formatMoney_(data.contadoPrecio)],
      [ivaContadoLabel_(data), formatMoney_(data.contadoIva)],
      ["TOTAL DE CONTADO", formatMoney_(data.contadoTotal)],
    ];
  } else {
    cells = [
      ["CRÉDITO", ""],
      ["Base imponible", formatMoney_(data.basePrice)],
      [ivaCreditoLabel_(data), formatMoney_(data.creditoIva)],
      ["TOTAL (base + I.V.A.)", formatMoney_(data.creditoTotal)],
    ];
  }

  var table = body.appendTable(cells);
  table.setBorderWidth(0);
  table.setColumnWidth(0, 330);
  table.setColumnWidth(1, 150);

  var lastRow = table.getNumRows() - 1;
  for (var i = 0; i <= lastRow; i++) {
    var tr = table.getRow(i);
    for (var c = 0; c < 2; c++) {
      var cell = tr.getCell(c);
      cell.setPaddingTop(2).setPaddingBottom(2);

      var p = cell.getChild(0).asParagraph();
      p.setSpacingBefore(0).setSpacingAfter(0);
      p.setAlignment(
        c === 1 ? DocumentApp.HorizontalAlignment.RIGHT : DocumentApp.HorizontalAlignment.LEFT
      );

      if (i === 0) {
        p.setBold(true).setFontSize(12).setForegroundColor(BRAND_COLOR);
      } else if (i === lastRow) {
        p.setBold(true).setFontSize(11).setForegroundColor(BRAND_COLOR);
      } else {
        p.setBold(false).setFontSize(10).setForegroundColor("#333333");
      }
    }
  }
}

function appendFinancingDetail_(body, data) {
  var title = body.appendParagraph("Detalle de Financiamiento");
  title.setBold(true).setFontSize(12).setForegroundColor(BRAND_COLOR);
  title.setSpacingBefore(12).setSpacingAfter(4);

  var rows = [
    ["Categoría", data.categoria || "-"],
    ["Monto inicial", formatMoney_(data.initialAmount)],
    ["Cantidad de cuotas", String(Number(data.installments) || 0)],
    ["Cuota mensual", formatMoney_(data.monthlyPayment)],
    ["Total a pagar financiado", formatMoney_(data.totalToPay)],
  ];

  var table = body.appendTable(rows);
  table.setBorderWidth(0);

  for (var r = 0; r < table.getNumRows(); r++) {
    var row = table.getRow(r);
    for (var c = 0; c < 2; c++) {
      row.getCell(c).setPaddingTop(1).setPaddingBottom(1);
    }
    var labelP = row.getCell(0).getChild(0).asParagraph();
    labelP.setFontSize(10).setForegroundColor("#333333").setSpacingBefore(0).setSpacingAfter(0);
    var valueP = row.getCell(1).getChild(0).asParagraph();
    valueP.setFontSize(10).setBold(true).setSpacingBefore(0).setSpacingAfter(0);
  }
}

function appendConditions_(body) {
  var title = body.appendParagraph("CONDICIONES");
  title.setBold(true).setFontSize(11).setForegroundColor(BRAND_COLOR);
  title.setSpacingBefore(12).setSpacingAfter(3);

  var lines = [
    "Vigencia de la cotización: 7 días naturales.",
    "Incluye: Garantía, instalación y capacitación (según equipo).",
    
  ];

  for (var i = 0; i < lines.length; i++) {
    var p = body.appendParagraph("• " + lines[i]);
    p.setFontSize(9.5).setForegroundColor("#333333").setSpacingBefore(0).setSpacingAfter(1);
  }
}

function appendFooter_(body) {
  var footer = body.appendParagraph(
    EMISOR.web + "   ·   " + EMISOR.instagram + "   ·   " + EMISOR.direccionLineas.join(", ")
  );
  footer.setFontSize(8.5).setForegroundColor("#888888").setSpacingBefore(12).setSpacingAfter(0);
}

function formatMoney_(n) {
  var value = Number(n) || 0;
  return "$" + value.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */

function escapeHtml_(str) {
  return String(str || "").replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

function getSheet_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('No se encontró la hoja "' + name + '".');
  return sheet;
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}
