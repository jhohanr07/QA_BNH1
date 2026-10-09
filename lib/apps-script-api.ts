// Cliente para el backend de Google Apps Script que actúa como base de datos
// (Google Sheets) de la calculadora de financiamiento.
//
// Requiere la variable de entorno NEXT_PUBLIC_APPS_SCRIPT_URL apuntando a la
// URL de implementación (Web App) del script en apps-script/Code.gs.
// Ver apps-script/README.md para el paso a paso de despliegue.

export type Equipo = {
  id: string;
  codigo: string;
  nombre: string;
  categoria: string;
  // Precio de venta a crédito y de contado (hoja "PRECIO EQUIPOS")
  precioCredito: number;
  precioContado: number;
  // Columnas "Base ajustada" e "IVA ajustado": se usan al activar "Ajustar"
  baseAjustada: number;
  ivaAjustado: number;
};

export type PlazoAirr = {
  meses: number;
  // AIRR anual objetivo como fracción (0.25 = 25%)
  tasa: number;
};

export type PlazoCategoria = {
  meses: number;
  // Fórmula de la cuota tal cual está en la hoja, ej.
  // "CEILING(((Precio / 1.03) - Inicial) *1.20 / Cuotas, 10)". null = formato anterior (tasa).
  formula: string | null;
  // Multiplicador del plazo (ej. 1.20); respaldo si la fórmula no se puede evaluar
  factor: number | null;
  // Solo formato anterior "=(1.30 ^ (1 / 18))": factor^(1/meses) - 1. null con la fórmula nueva.
  tasaMensual: number | null;
};

export type ReglaInicial = {
  // Texto de la fórmula de la hoja, ej. "REDONDEAR.MAS(( Precio/1,03)* 0.25; -2)"
  formula: string | null;
  // Porcentaje detectado (solo respaldo y etiqueta)
  pct: number | null;
  // Dígitos del REDONDEAR.MAS de la hoja (ej. -2 = a centenas). null = sin redondeo definido.
  digitos: number | null;
};

export type CategoriaFinanciamiento = {
  nombre: string;
  inicialMinima: ReglaInicial | null;
  inicialSugerida: ReglaInicial | null;
  plazosSi: PlazoCategoria[]; // I.V.A. financiado = Sí (columnas D:F)
  plazosNo: PlazoCategoria[]; // I.V.A. financiado = No (columnas G:I)
  // Plazos disponibles con su AIRR (hoja CATEGORIA, columnas L:N)
  airr?: PlazoAirr[];
};

export type QuotePayload = {
  leadName: string;
  leadPhone: string;
  leadEmail: string;
  vendedorName: string;
  equipo: string;
  categoria: string;
  basePrice: number;
  initialAmount: number;
  installments: number;
  monthlyPayment: number;
  totalToPay: number;
  ivaFinancing: "si" | "no";
  ivaToPay: number;
  // Crédito: I.V.A. mostrado y total (base + I.V.A.)
  creditoIva: number;
  creditoTotal: number;
  // Escenario "De contado" (opcional; si no llega, el PDF sale solo con crédito)
  contadoPrecio?: number;
  contadoIva?: number;
  contadoTotal?: number;
  // true si se activó "Ajustar" (I.V.A. tomado de la columna "IVA ajustado")
  ajustado: boolean;
  logoUrl?: string;
};

type ApiResponse<T> = {
  success: boolean;
  error?: string;
  warning?: string;
} & T;

function getAppsScriptUrl(): string {
  const url = process.env.NEXT_PUBLIC_APPS_SCRIPT_URL;

  if (!url) {
    throw new Error(
      "Falta configurar NEXT_PUBLIC_APPS_SCRIPT_URL con la URL del Web App de Google Apps Script."
    );
  }

  return url;
}

/**
 * Obtiene el catálogo de equipos (nombre, categoría y precio) desde la hoja
 * "PRECIO EQUIPOS" del Google Sheet configurado como base de datos.
 */
export async function fetchEquipos(): Promise<Equipo[]> {
  const baseUrl = getAppsScriptUrl();

  const response = await fetch(`${baseUrl}?action=getEquipos`, {
    method: "GET",
  });

  if (!response.ok) {
    throw new Error("No se pudo consultar la base de datos de equipos.");
  }

  const data = (await response.json()) as ApiResponse<{ equipos: Equipo[] }>;

  if (!data.success) {
    throw new Error(data.error || "Error desconocido al consultar los equipos.");
  }

  return data.equipos ?? [];
}

/**
 * Obtiene las categorías y sus condiciones (inicial mínima/sugerida y AIRR por
 * plazo) desde la hoja "CATEGORIA". La columna A alimenta el desplegable.
 */
export async function fetchCategorias(): Promise<CategoriaFinanciamiento[]> {
  const baseUrl = getAppsScriptUrl();

  let response: Response;
  try {
    response = await fetch(`${baseUrl}?action=getCategorias`, {
      method: "GET",
      cache: "no-store",
    });
  } catch {
    throw new Error(
      "No se pudo conectar con el Apps Script al consultar las categorías (revise la URL y el acceso de la implementación)."
    );
  }

  if (!response.ok) {
    throw new Error(
      `No se pudo consultar las categorías (HTTP ${response.status}).`
    );
  }

  let data: ApiResponse<{ categorias: CategoriaFinanciamiento[] }>;
  try {
    data = (await response.json()) as ApiResponse<{
      categorias: CategoriaFinanciamiento[];
    }>;
  } catch {
    throw new Error(
      "El Apps Script no devolvió JSON al consultar las categorías (¿implementación sin actualizar o sin acceso público?)."
    );
  }

  if (!data.success) {
    throw new Error(
      data.error || "Error desconocido al consultar las categorías."
    );
  }

  return data.categorias ?? [];
}

/**
 * Obtiene la lista de vendedores (solo nombres) desde la hoja "VENDEDORES".
 * Los correos nunca se exponen al navegador: el backend los busca por nombre.
 */
export async function fetchVendedores(): Promise<string[]> {
  const baseUrl = getAppsScriptUrl();

  const response = await fetch(`${baseUrl}?action=getVendedores`, {
    method: "GET",
  });

  if (!response.ok) {
    throw new Error("No se pudo consultar la lista de vendedores.");
  }

  const data = (await response.json()) as ApiResponse<{ vendedores: string[] }>;

  if (!data.success) {
    throw new Error(data.error || "Error desconocido al consultar los vendedores.");
  }

  return data.vendedores ?? [];
}

/**
 * Guarda la cotización en la hoja "FUNEL DE VENTA" y dispara el envío del
 * correo con la propuesta al lead/doctor (y, si se ubica en la hoja
 * "VENDEDORES", en copia al vendedor).
 */
export async function saveQuoteAndSendEmail(
  payload: QuotePayload
): Promise<{ warning?: string; numero?: string }> {
  const baseUrl = getAppsScriptUrl();

  const response = await fetch(baseUrl, {
    method: "POST",
    // text/plain evita el preflight OPTIONS, que los Web Apps de Apps
    // Script no manejan de forma nativa.
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ action: "saveQuote", ...payload }),
  });

  if (!response.ok) {
    throw new Error("No se pudo enviar la cotización.");
  }

  const data = (await response.json()) as ApiResponse<{ numero?: string }>;

  if (!data.success) {
    throw new Error(data.error || "Error desconocido al guardar/enviar la cotización.");
  }

  return { warning: data.warning, numero: data.numero };
}
