"use client";

import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Loader2, Mail } from "lucide-react";
import {
  fetchCategorias,
  fetchEquipos,
  fetchVendedores,
  saveQuoteAndSendEmail,
  type CategoriaFinanciamiento,
  type Equipo,
  type PlazoCategoria,
  type ReglaInicial,
} from "@/lib/apps-script-api";
import { evaluateInitialFormula } from "@/lib/initial-formula";

// Las categorías, la inicial mínima/sugerida y el AIRR objetivo por plazo salen de la
// hoja "CATEGORIA" del Google Sheet. Solo estos valores no están en la hoja:
const VAT_RATE = 0.16;
const MIN_INITIAL_RATE_DEFAULT = 0.2;
const SUGGESTED_INITIAL_RATE_DEFAULT = 0.25;
// OJO: esta clave queda visible en el navegador. Para algo realmente privado,
// valídala en el servidor (route handler + cookie httpOnly o middleware).
const ACCESS_PASSWORD = "BNH2026";

// IGTF: ya viene incluido en el precio de crédito sobre la base; si el I.V.A. se
// financia, también se financia el IGTF sobre el I.V.A.
const IGTF_RATE = 0.03;

// Control interno: muestra en pantalla el AIRR resultante de la cuota redondeada.
// Dejar en false en producción (con true además se avisa por console.warn si queda bajo el objetivo).
const SHOW_AIRR_CONTROL: boolean = false;

// Categorías (nombre normalizado) que no permiten pagar el I.V.A. por separado
const CATEGORIES_WITHOUT_SEPARATE_VAT = ["teair"];

// false = el I.V.A. del cálculo de la cuota es (precio/1,03) x 16 %, igual que la versión vieja.
// true  = usa el "IVA ajustado" de la columna G también para calcular la cuota.
const USAR_IVA_AJUSTADO_EN_CUOTA = false;

// Paso de redondeo de la inicial solo cuando la hoja no trae una fórmula utilizable
const INITIAL_STEP = 500;

// El precio incluye 3 %; el I.V.A. = (precio / 1,03) x 16 % (contado y crédito)
const CONTADO_DIVISOR = 1.03;

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type CategoryConfig = {
  nombre: string;
  minInitialRate: number;
  minDigits: number | null;
  minFormula: string | null;
  suggestedInitialRate: number;
  suggestedDigits: number | null;
  suggestedFormula: string | null;
  terms: PlazoCategoria[];
  canPayVATSeparately: boolean;
};

type PaymentMode = "si" | "no";

function formatCurrency(value: number) {
  if (!Number.isFinite(value)) return "$0.00";

  return new Intl.NumberFormat("es-VE", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

// Redondea la cuota hacia arriba al múltiplo de 5; el epsilon evita que el ruido
// de punto flotante (ej. 100.0000000001) suba la cuota $5 de más.
function roundUpToNearest5(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.ceil(value / 5 - 1e-9) * 5;
}

function roundUpToMultiple(value: number, step: number) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.ceil(value / step) * step;
}

function formatNumberInput(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "";
  return value.toFixed(2);
}

function normalizeText(value: string) {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

// Redondea hacia arriba igual que REDONDEAR.MAS(valor; digitos) de la hoja.
// Sin dígitos definidos se usa el múltiplo de $500 de siempre.
function roundUpByRule(value: number, digits: number | null) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (digits === null) return roundUpToMultiple(value, INITIAL_STEP);
  const step = digits < 0 ? Math.pow(10, -digits) : 1;
  return Math.ceil(value / step) * step;
}

function toRule(rule: ReglaInicial | null, fallbackRate: number) {
  return {
    rate: rule?.pct ?? fallbackRate,
    digits: rule?.digitos ?? null,
    formula: rule?.formula ?? null,
  };
}

// TIR (por mes) de un flujo de caja; el flujo[0] es negativo (mes 0).
function calculateIRR(flows: number[]): number {
  const npv = (r: number) =>
    flows.reduce((acc, cf, t) => acc + cf / Math.pow(1 + r, t), 0);
  let lo = -0.99,
    hi = 1;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (npv(mid) > 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export default function Page() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [password, setPassword] = useState("");
  const [accessError, setAccessError] = useState("");

  const handleLogin = () => {
    if (password === ACCESS_PASSWORD) {
      setIsAuthenticated(true);
      setAccessError("");
    } else {
      setAccessError("Clave incorrecta.");
    }
  };

  if (!isAuthenticated) {
    return (
      <div
        className="min-h-screen bg-[#f3f5f7] px-6 py-10"
        style={{ fontFamily: "Verdana, sans-serif" }}
      >
        <div className="mx-auto flex max-w-md flex-col items-center justify-center">
          <div className="mb-8 rounded-3xl bg-white px-8 py-6 shadow-sm ring-1 ring-gray-200">
            <Image
              src="/logo-bnh.jpeg"
              alt="BNH Medical"
              width={360}
              height={180}
              className="h-auto w-[280px] md:w-[340px]"
              priority
            />
          </div>

          <Card className="w-full rounded-3xl border-0 bg-white shadow-lg ring-1 ring-gray-200">
            <CardHeader className="pb-2 text-center">
              <CardTitle className="text-3xl font-bold text-gray-900">
                Acceso privado
              </CardTitle>

              <p className="mt-2 text-sm text-gray-600">
                Ingrese la clave para acceder a la calculadora de financiamiento
              </p>
            </CardHeader>

            <CardContent className="space-y-5 pt-4">
              <div className="space-y-3">
                <Label className="block text-base font-medium text-gray-800">
                  Clave de acceso
                </Label>

                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleLogin();
                  }}
                  placeholder="Ingrese su clave"
                  className="h-12 rounded-xl"
                />
              </div>

              {accessError && (
                <Alert className="border-red-200 bg-red-50">
                  <AlertDescription>{accessError}</AlertDescription>
                </Alert>
              )}

              <Button
                onClick={handleLogin}
                className="h-12 w-full rounded-xl bg-[#0d6f91] text-base font-semibold hover:bg-[#0a607d]"
              >
                Ingresar
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return <CalculadoraFinanciamientoBNH />;
}

function CalculadoraFinanciamientoBNH() {
  const [category, setCategory] = useState("");
  const [basePrice, setBasePrice] = useState("");
  const [contadoPriceInput, setContadoPriceInput] = useState("");
  const [initialAmount, setInitialAmount] = useState("");
  const [ivaFinancing, setIvaFinancing] = useState<PaymentMode>("si");
  const [installments, setInstallments] = useState("");

  // Interruptor "Ajustar": usa el "IVA ajustado" (columna G de PRECIO EQUIPOS)
  const [ajustarIva, setAjustarIva] = useState(false);

  // --- Categorías y condiciones (hoja CATEGORIA) ---
  const [categorias, setCategorias] = useState<CategoriaFinanciamiento[]>([]);
  const [categoriasLoading, setCategoriasLoading] = useState(false);
  const [categoriasError, setCategoriasError] = useState("");

  useEffect(() => {
    let active = true;

    async function loadCategorias() {
      setCategoriasLoading(true);
      setCategoriasError("");

      try {
        const data = await fetchCategorias();
        if (active) setCategorias(data);
      } catch (err) {
        if (active) {
          setCategoriasError(
            err instanceof Error
              ? err.message
              : "No se pudieron cargar las categorías."
          );
        }
      } finally {
        if (active) setCategoriasLoading(false);
      }
    }

    loadCategorias();

    return () => {
      active = false;
    };
  }, []);

  // --- Base de datos de equipos (hoja PRECIO EQUIPOS vía Apps Script) ---
  const [equipos, setEquipos] = useState<Equipo[]>([]);
  const [selectedEquipoId, setSelectedEquipoId] = useState("");
  const [equiposLoading, setEquiposLoading] = useState(false);
  const [equiposError, setEquiposError] = useState("");

  useEffect(() => {
    let active = true;

    async function loadEquipos() {
      setEquiposLoading(true);
      setEquiposError("");

      try {
        const data = await fetchEquipos();
        if (active) setEquipos(data);
      } catch (err) {
        if (active) {
          setEquiposError(
            err instanceof Error
              ? err.message
              : "No se pudo cargar la base de datos de equipos."
          );
        }
      } finally {
        if (active) setEquiposLoading(false);
      }
    }

    loadEquipos();

    return () => {
      active = false;
    };
  }, []);

  // --- Lista de vendedores (hoja VENDEDORES); si falla, se permite escribir el nombre ---
  const [vendedores, setVendedores] = useState<string[]>([]);
  const [vendedoresLoading, setVendedoresLoading] = useState(false);

  useEffect(() => {
    let active = true;

    async function loadVendedores() {
      setVendedoresLoading(true);

      try {
        const data = await fetchVendedores();
        if (active) setVendedores(data);
      } catch {
        if (active) setVendedores([]);
      } finally {
        if (active) setVendedoresLoading(false);
      }
    }

    loadVendedores();

    return () => {
      active = false;
    };
  }, []);

  // Al elegir el equipo se llenan de inmediato la categoría y los precios
  // (crédito y contado) según la hoja PRECIO EQUIPOS.
  // La categoría NO es editable: solo se define desde el equipo.
  const handleEquipoChange = (equipoId: string) => {
    setSelectedEquipoId(equipoId);
    setEquiposError("");

    const equipo = equipos.find((e) => e.id === equipoId);
    if (!equipo) return;

    const matched = categorias.find(
      (c) => normalizeText(c.nombre) === normalizeText(equipo.categoria)
    );

    if (matched) {
      setCategory(matched.nombre);
    } else {
      setCategory("");
      setEquiposError(
        `La categoría "${equipo.categoria}" del equipo no existe en la hoja CATEGORIA.`
      );
    }

    setBasePrice(formatNumberInput(equipo.precioCredito));
    setContadoPriceInput(formatNumberInput(equipo.precioContado));
  };

  // --- Datos del prospecto (lead) y vendedor, para la cotización ---
  const [leadName, setLeadName] = useState("");
  const [leadPhone, setLeadPhone] = useState("");
  const [leadEmail, setLeadEmail] = useState("");
  const [vendedorName, setVendedorName] = useState("");

  const [sendingQuote, setSendingQuote] = useState(false);
  const [sendQuoteError, setSendQuoteError] = useState("");
  const [sendQuoteSuccess, setSendQuoteSuccess] = useState("");

  const categoryConfig = useMemo<CategoryConfig | null>(() => {
    const found = categorias.find((c) => c.nombre === category);
    if (!found) return null;

    const min = toRule(found.inicialMinima, MIN_INITIAL_RATE_DEFAULT);
    const suggested = toRule(
      found.inicialSugerida,
      SUGGESTED_INITIAL_RATE_DEFAULT
    );

    return {
      nombre: found.nombre,
      minInitialRate: min.rate,
      minDigits: min.digits,
      minFormula: min.formula,
      suggestedInitialRate: suggested.rate,
      suggestedDigits: suggested.digits,
      suggestedFormula: suggested.formula,
      terms: found.plazos,
      canPayVATSeparately: !CATEGORIES_WITHOUT_SEPARATE_VAT.includes(
        normalizeText(found.nombre)
      ),
    };
  }, [categorias, category]);

  const numericBase = Number(basePrice);
  const numericInitial = Number(initialAmount);
  const numericInstallments = Number(installments);
  const numericContado = Number(contadoPriceInput);

  const safeBaseForRules =
    Number.isFinite(numericBase) && numericBase > 0 ? numericBase : 0;

  // Inicial mínima y sugerida: se calculan con la fórmula de la hoja CATEGORIA tal cual
  // (ej. REDONDEAR.MAS(( Precio/1,03)* 0.25; -2)). Si la celda no trae una fórmula
  // interpretable se usa el porcentaje detectado.
  const minInitialAmount = useMemo(() => {
    if (!categoryConfig || safeBaseForRules <= 0) return 0;
    return (
      evaluateInitialFormula(categoryConfig.minFormula, safeBaseForRules) ??
      roundUpByRule(
        safeBaseForRules * categoryConfig.minInitialRate,
        categoryConfig.minDigits
      )
    );
  }, [categoryConfig, safeBaseForRules]);

  const suggestedInitialAmount = useMemo(() => {
    if (!categoryConfig || safeBaseForRules <= 0) return 0;
    return (
      evaluateInitialFormula(
        categoryConfig.suggestedFormula,
        safeBaseForRules
      ) ??
      roundUpByRule(
        safeBaseForRules * categoryConfig.suggestedInitialRate,
        categoryConfig.suggestedDigits
      )
    );
  }, [categoryConfig, safeBaseForRules]);

  // La inicial que se autocompleta es siempre la sugerida (nunca menor a la mínima)
  const autoInitialAmount = Math.ceil(
    Math.max(suggestedInitialAmount, minInitialAmount)
  );

  // I.V.A. del crédito: (precio / 1,03) x 16 %
  const vatAmount = (safeBaseForRules / CONTADO_DIVISOR) * VAT_RATE;

  // --- Contado: I.V.A. = (monto / 1,03) x 16 % ---
  const contadoMonto =
    Number.isFinite(numericContado) && numericContado > 0 ? numericContado : 0;
  const contadoIvaNormal = (contadoMonto / CONTADO_DIVISOR) * VAT_RATE;

  // --- "Ajustar": solo cambia el I.V.A. mostrado; se toma de la columna G de la lista ---
  const equipoSeleccionado = equipos.find((e) => e.id === selectedEquipoId);
  const ivaAjustadoLista = equipoSeleccionado?.ivaAjustado ?? 0;
  const ivaAjustadoDisponible = ivaAjustadoLista > 0;
  const usaAjuste = ajustarIva && ivaAjustadoDisponible;

  const creditoIva =
    safeBaseForRules > 0 ? (usaAjuste ? ivaAjustadoLista : vatAmount) : 0;
  const creditoTotal = safeBaseForRules + creditoIva;

  // I.V.A. que se usa en el cálculo del crédito (independiente del interruptor "Ajustar"):
  // el I.V.A. ajustado de la lista (columna G) si existe; si no, el I.V.A. normal.
  //  - Financiamiento del I.V.A. = Sí  -> se suma al monto financiado (y "I.V.A. a pagar en Bs" = 0)
  //  - Financiamiento del I.V.A. = No  -> se paga aparte: "I.V.A. a pagar en Bs" = I.V.A. ajustado
  const ivaCredito =
  safeBaseForRules > 0
    ? USAR_IVA_AJUSTADO_EN_CUOTA && ivaAjustadoDisponible
      ? ivaAjustadoLista
      : vatAmount
    : 0;

  const contadoIva =
    contadoMonto > 0 ? (usaAjuste ? ivaAjustadoLista : contadoIvaNormal) : 0;
  const contadoTotal = contadoMonto + contadoIva;

  useEffect(() => {
    if (!categoryConfig) {
      setIvaFinancing("si");
      return;
    }

    if (!categoryConfig.canPayVATSeparately) {
      setIvaFinancing("si");
    }
  }, [categoryConfig]);

  // Si el plazo elegido no existe en la categoría, se limpia
  useEffect(() => {
    if (
      categoryConfig &&
      installments !== "" &&
      !categoryConfig.terms.some((t) => String(t.meses) === installments)
    ) {
      setInstallments("");
    }
  }, [categoryConfig, installments]);

  useEffect(() => {
    if (categoryConfig && Number.isFinite(numericBase) && numericBase > 0) {
      setInitialAmount(String(autoInitialAmount));
    } else if (!basePrice) {
      setInitialAmount("");
    }
  }, [categoryConfig, numericBase, autoInitialAmount, basePrice]);

  const validations = useMemo(() => {
    const errors: string[] = [];

    if (!categoryConfig) return errors;

    if (basePrice !== "" && (!Number.isFinite(numericBase) || numericBase <= 0)) {
      errors.push("No válido: el precio de crédito debe ser mayor a cero.");
    }

    if (
      contadoPriceInput !== "" &&
      (!Number.isFinite(numericContado) || numericContado < 0)
    ) {
      errors.push("No válido: el precio de contado debe ser un valor numérico válido.");
    }

    if (
      initialAmount !== "" &&
      (!Number.isFinite(numericInitial) || numericInitial < 0)
    ) {
      errors.push("No válido: el monto inicial debe ser un valor numérico válido.");
    }

    if (
      installments !== "" &&
      (!Number.isInteger(numericInstallments) || numericInstallments <= 0)
    ) {
      errors.push("No válido: la cantidad de cuotas debe ser un entero mayor a cero.");
    }

    if (
      initialAmount !== "" &&
      Number.isFinite(numericInitial) &&
      numericInitial >= 0 &&
      !Number.isInteger(numericInitial)
    ) {
      errors.push("No válido: la inicial debe ser un número entero (ej. 5000, 5500, 6000).");
    }

    if (
      Number.isFinite(numericBase) &&
      numericBase > 0 &&
      Number.isFinite(numericInitial) &&
      numericInitial < minInitialAmount
    ) {
      errors.push(
        `No válido: la inicial no puede ser menor a la inicial mínima (${formatCurrency(
          minInitialAmount
        )}). Por favor cambie el monto.`
      );
    }

    if (
      Number.isFinite(numericBase) &&
      numericBase > 0 &&
      Number.isFinite(numericInitial) &&
      numericInitial >= numericBase
    ) {
      errors.push("No válido: la inicial debe ser menor a la base imponible.");
    }

    if (
      installments !== "" &&
      Number.isInteger(numericInstallments) &&
      !categoryConfig.terms.some((t) => t.meses === numericInstallments)
    ) {
      errors.push("No válido: este plazo no está disponible para la categoría.");
    }

    if (!categoryConfig.canPayVATSeparately && ivaFinancing === "no") {
      errors.push("No válido: esta categoría no permite pagar el I.V.A. por separado.");
    }

    return errors;
  }, [
    categoryConfig,
    basePrice,
    contadoPriceInput,
    initialAmount,
    installments,
    ivaFinancing,
    numericBase,
    numericContado,
    numericInitial,
    numericInstallments,
    minInitialAmount,
  ]);

  const calculations = useMemo(() => {
    const safeBase = safeBaseForRules;

    const safeInitial =
      Number.isFinite(numericInitial) && numericInitial >= 0
        ? numericInitial
        : 0;

    const safeInstallments =
      Number.isInteger(numericInstallments) && numericInstallments > 0
        ? numericInstallments
        : 0;

    // I.V.A. financiado (Sí): se suma al monto financiado y "I.V.A. a pagar en Bs" queda en 0.
    // I.V.A. no financiado (No): se paga aparte y trae el I.V.A. ajustado.
    const ivaFinanced = ivaFinancing === "si" ? ivaCredito : 0;
    const ivaSeparate = ivaFinancing === "no" ? ivaCredito : 0;

    const empty = {
      roundedMonthlyPayment: 0,
      totalToPay: safeInitial,
      ivaToPayField: ivaSeparate,
      financedAmount: 0,
      airrResultante: null as number | null,
      airrObjetivo: null as number | null,
    };

    if (!categoryConfig || safeBase <= 0 || safeInstallments <= 0) {
      return empty;
    }

    const term = categoryConfig.terms.find((t) => t.meses === safeInstallments);
    if (!term) return empty;
    if (safeBase - safeInitial <= 0) return empty;

    // 1) Tasa mensual a partir del AIRR objetivo de la hoja (exponente siempre 1/12)
    const r = Math.pow(1 + term.airr, 1 / 12) - 1;

    // Valor presente de $1 pagado cada mes durante n meses = VA(r; n; -1)
    const va =
      r > 0
        ? (1 - Math.pow(1 + r, -safeInstallments)) / r
        : safeInstallments;

    // 2) Lo que la empresa adelanta en el mes 0 (igual que la versión vieja):
    //    el IGTF del 3 % siempre se calcula también sobre el I.V.A.,
    //    se financie o no el I.V.A.
    const igtfSobreIva = ivaCredito * IGTF_RATE;
    const montoMes0 = safeBase - safeInitial + ivaCredito + igtfSobreIva;

    // 3) Cuota sin redondear según cómo se paga el IVA
    const rawPayment =
      ivaFinancing === "si"
        ? montoMes0 / va // PAGO(r; n; -monto)
        : (montoMes0 - ivaCredito / (1 + r)) / (va / (1 + r)); // IVA en mes 1, cuotas meses 2..n+1

    const roundedMonthlyPayment = roundUpToNearest5(rawPayment);

    // Monto financiado que se muestra en pantalla (con "No", el I.V.A. y su IGTF van aparte)
    const igtfFinanciado = ivaFinancing === "si" ? igtfSobreIva : 0;
    const financedAmount =
      safeBase - safeInitial + ivaFinanced + igtfFinanciado;

    // 4) Control: AIRR resultante con la cuota ya redondeada
    let airrResultante: number | null = null;
    if (roundedMonthlyPayment > 0) {
      const cuotas = Array(safeInstallments).fill(roundedMonthlyPayment);
      const flows =
        ivaFinancing === "si"
          ? [-montoMes0, ...cuotas]
          : [-montoMes0, ivaCredito, ...cuotas];
      airrResultante = Math.pow(1 + calculateIRR(flows), 12) - 1;
    }

    const totalToPay =
      safeInitial + ivaSeparate + roundedMonthlyPayment * safeInstallments;

    return {
      roundedMonthlyPayment,
      totalToPay,
      ivaToPayField: ivaSeparate,
      financedAmount,
      airrResultante,
      airrObjetivo: term.airr as number | null,
    };
  }, [
    safeBaseForRules,
    numericInitial,
    numericInstallments,
    ivaCredito,
    ivaFinancing,
    categoryConfig,
  ]);

  // Control de prueba: avisa si el AIRR resultante queda por debajo del objetivo
  useEffect(() => {
    if (!SHOW_AIRR_CONTROL) return;
    const { airrResultante, airrObjetivo } = calculations;
    if (airrResultante !== null && airrObjetivo !== null) {
      console.log(
        `AIRR objetivo ${(airrObjetivo * 100).toFixed(2)}% | resultante ${(
          airrResultante * 100
        ).toFixed(2)}%`
      );
      if (airrResultante < airrObjetivo - 1e-6) {
        console.warn(
          "El AIRR resultante quedó por debajo del objetivo: revisar el cálculo."
        );
      }
    }
  }, [calculations]);

  const isValid =
    !!categoryConfig &&
    Number.isFinite(numericBase) &&
    numericBase > 0 &&
    Number.isFinite(numericInitial) &&
    numericInitial >= minInitialAmount &&
    Number.isInteger(numericInstallments) &&
    numericInstallments > 0 &&
    categoryConfig.terms.some((t) => t.meses === numericInstallments) &&
    validations.length === 0 &&
    Number.isInteger(numericInitial) &&
    calculations.roundedMonthlyPayment > 0;

  const handleReset = () => {
    setCategory("");
    setBasePrice("");
    setContadoPriceInput("");
    setInitialAmount("");
    setIvaFinancing("si");
    setInstallments("");
    setAjustarIva(false);
    setSelectedEquipoId("");
    setEquiposError("");
    setSendQuoteError("");
    setSendQuoteSuccess("");
  };

  const handleSendQuote = async () => {
    setSendQuoteError("");
    setSendQuoteSuccess("");

    if (!isValid) {
      setSendQuoteError(
        "Complete correctamente los datos de la operación antes de enviar la cotización."
      );
      return;
    }

    if (!leadName.trim() || !leadEmail.trim() || !vendedorName.trim()) {
      setSendQuoteError(
        "Complete el nombre del lead, su email y el vendedor antes de enviar."
      );
      return;
    }

    if (!EMAIL_REGEX.test(leadEmail.trim())) {
      setSendQuoteError("El email del lead no tiene un formato válido.");
      return;
    }

    setSendingQuote(true);

    try {
      const result = await saveQuoteAndSendEmail({
        leadName: leadName.trim(),
        leadPhone: leadPhone.trim(),
        leadEmail: leadEmail.trim(),
        vendedorName: vendedorName.trim(),
        equipo: equipoSeleccionado?.nombre ?? "",
        categoria: categoryConfig?.nombre ?? "",
        basePrice: numericBase,
        initialAmount: numericInitial,
        installments: numericInstallments,
        monthlyPayment: calculations.roundedMonthlyPayment,
        totalToPay: calculations.totalToPay,
        ivaFinancing,
        ivaToPay: calculations.ivaToPayField,
        creditoIva,
        creditoTotal,
        ...(contadoMonto > 0
          ? { contadoPrecio: contadoMonto, contadoIva, contadoTotal }
          : {}),
        ajustado: usaAjuste,
        logoUrl: `${window.location.origin}/logo-bnh.jpeg`,
      });

      const numeroTxt = result.numero ? ` (N° ${result.numero})` : "";

      setSendQuoteSuccess(
        result.warning
          ? `Cotización${numeroTxt} guardada y enviada al lead con el PDF adjunto. ${result.warning}`
          : `Cotización${numeroTxt} guardada en el Funel de Venta y enviada por correo con el PDF adjunto.`
      );
    } catch (err) {
      setSendQuoteError(
        err instanceof Error
          ? err.message
          : "No se pudo enviar la cotización. Intente nuevamente."
      );
    } finally {
      setSendingQuote(false);
    }
  };

  const selectFont = { fontFamily: "Verdana, sans-serif" };
  const catalogLoading = equiposLoading || categoriasLoading;

  return (
    <div
      className="min-h-screen bg-[#f3f5f7] px-4 py-6 md:px-6 md:py-8"
      style={{ fontFamily: "Verdana, sans-serif" }}
    >
      <div className="mx-auto max-w-7xl">
        <div className="mb-6 bg-transparent md:mb-8">
          <div className="flex flex-col items-center gap-5 text-center md:flex-row md:items-center md:text-left">
            <div className="rounded-3xl bg-white px-6 py-4 shadow-sm ring-1 ring-gray-200">
              <Image
                src="/logo-bnh.jpeg"
                alt="BNH Medical"
                width={240}
                height={120}
                className="h-auto w-[190px] md:w-[220px]"
                priority
              />
            </div>

            <div>
              <h1 className="text-3xl font-bold tracking-tight text-gray-900 md:text-4xl">
                Calculadora de Financiamiento
              </h1>

              <p className="mt-2 text-sm text-gray-600 md:text-base">
                Simulación comercial para planes de financiamiento
              </p>

              <div className="mt-4 inline-flex rounded-full bg-[#0d6f91]/10 px-4 py-2 text-sm font-medium text-[#0d6f91]">
                BNH Medical · Herramienta interna
              </div>
            </div>
          </div>
        </div>

        <Card className="mb-6 rounded-3xl border-0 shadow-sm ring-1 ring-gray-200 md:mb-8">
          <CardHeader>
            <CardTitle className="text-2xl text-gray-900">
              Datos del prospecto y vendedor
            </CardTitle>
          </CardHeader>

          <CardContent>
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <Label className="mb-2 block">Nombre del lead</Label>
                <Input
                  type="text"
                  value={leadName}
                  onChange={(e) => setLeadName(e.target.value)}
                  placeholder="Ej. Dr. Juan Rodríguez"
                  className="rounded-xl"
                />
              </div>

              <div>
                <Label className="mb-2 block">Teléfono</Label>
                <Input
                  type="tel"
                  value={leadPhone}
                  onChange={(e) => setLeadPhone(e.target.value)}
                  placeholder="Ej. 0414-1234567"
                  className="rounded-xl"
                />
              </div>

              <div>
                <Label className="mb-2 block">Email</Label>
                <Input
                  type="email"
                  value={leadEmail}
                  onChange={(e) => setLeadEmail(e.target.value)}
                  placeholder="Ej. doctor@clinica.com"
                  className="rounded-xl"
                />
              </div>

              <div>
                <Label className="mb-2 block">Vendedor</Label>

                {vendedores.length > 0 ? (
                  <Select value={vendedorName} onValueChange={setVendedorName}>
                    <SelectTrigger className="rounded-xl" style={selectFont}>
                      <SelectValue placeholder="Seleccione un vendedor" />
                    </SelectTrigger>

                    <SelectContent style={selectFont}>
                      {vendedores.map((nombre) => (
                        <SelectItem
                          key={nombre}
                          value={nombre}
                          style={selectFont}
                        >
                          {nombre}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    type="text"
                    value={vendedorName}
                    onChange={(e) => setVendedorName(e.target.value)}
                    placeholder={
                      vendedoresLoading
                        ? "Cargando vendedores..."
                        : "Ej. María Pérez"
                    }
                    className="rounded-xl"
                  />
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card className="rounded-3xl border-0 shadow-sm ring-1 ring-gray-200">
            <CardHeader>
              <CardTitle className="text-2xl text-gray-900">
                Datos de la operación
              </CardTitle>
            </CardHeader>

            <CardContent className="space-y-5">
              <div>
                <Label className="mb-2 block">Equipo</Label>

                <Select
                  value={selectedEquipoId}
                  onValueChange={handleEquipoChange}
                  disabled={
                    catalogLoading ||
                    equipos.length === 0 ||
                    categorias.length === 0
                  }
                >
                  <SelectTrigger className="rounded-xl" style={selectFont}>
                    <SelectValue
                      placeholder={
                        catalogLoading
                          ? "Cargando equipos..."
                          : "Seleccione un equipo"
                      }
                    />
                  </SelectTrigger>

                  <SelectContent style={selectFont}>
                    {equipos.map((equipo) => {
                      const sinPrecio =
                        equipo.precioCredito <= 0 && equipo.precioContado <= 0;

                      return (
                        <SelectItem
                          key={equipo.id}
                          value={equipo.id}
                          disabled={sinPrecio}
                          style={selectFont}
                        >
                          {equipo.nombre}
                          {sinPrecio ? " — sin precio" : ""}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>

                {equiposError ? (
                  <p className="mt-2 text-xs text-red-600">{equiposError}</p>
                ) : (
                  <p className="mt-2 text-xs text-gray-500">
                    Al seleccionar un equipo se completan automáticamente la
                    categoría y los precios de crédito y de contado; puede
                    ajustar los precios manualmente.
                  </p>
                )}
              </div>

              <div>
                <Label className="mb-2 block">Categoría</Label>

                {/* Solo lectura: la categoría se define al elegir el equipo */}
                <Select value={category} onValueChange={() => {}} disabled>
                  <SelectTrigger
                    className="rounded-xl bg-gray-100 disabled:cursor-default disabled:opacity-100"
                    style={selectFont}
                  >
                    <SelectValue
                      placeholder={
                        categoriasLoading
                          ? "Cargando categorías..."
                          : "Se completa al elegir el equipo"
                      }
                    />
                  </SelectTrigger>

                  <SelectContent style={selectFont}>
                    {categorias.map((cat) => (
                      <SelectItem
                        key={cat.nombre}
                        value={cat.nombre}
                        style={selectFont}
                      >
                        {cat.nombre}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {categoriasError && (
                  <p className="mt-2 text-xs text-red-600">{categoriasError}</p>
                )}
              </div>

              <div>
                <Label className="mb-2 block">Precio</Label>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={basePrice}
                  onChange={(e) => setBasePrice(e.target.value)}
                  placeholder="Ej. 10000"
                  className="rounded-xl"
                />
              </div>

              <div>
                <Label className="mb-2 block">Monto inicial</Label>

                <Input
                  type="number"
                  min={minInitialAmount || 0}
                  step={100}
                  value={initialAmount}
                  onChange={(e) => setInitialAmount(e.target.value)}
                  placeholder="Ej. 5000"
                  className="rounded-xl"
                />

                {categoryConfig ? (
                  <div className="mt-2 space-y-1 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-gray-700">
                    <p>
                      Inicial mínima{" "}
                      {Math.round(categoryConfig.minInitialRate * 100)}%:{" "}
                      <span className="font-semibold">
                        {formatCurrency(minInitialAmount)}
                      </span>
                    </p>
                    <p>
                      Inicial sugerida{" "}
                      {Math.round(categoryConfig.suggestedInitialRate * 100)}%:{" "}
                      <span className="font-semibold">
                        {formatCurrency(suggestedInitialAmount)}
                      </span>
                    </p>
                  </div>
                ) : (
                  <p className="mt-2 text-xs text-gray-500">
                    Seleccione un equipo para ver la inicial mínima y sugerida
                  </p>
                )}
              </div>

              <div>
                <Label className="mb-2 block">Financiamiento del I.V.A.</Label>

                <Select
                  value={ivaFinancing}
                  onValueChange={(value: PaymentMode) => setIvaFinancing(value)}
                >
                  <SelectTrigger className="rounded-xl" style={selectFont}>
                    <SelectValue placeholder="Seleccione" />
                  </SelectTrigger>

                  <SelectContent style={selectFont}>
                    <SelectItem value="si" style={selectFont}>
                      Sí
                    </SelectItem>

                    <SelectItem
                      value="no"
                      disabled={!categoryConfig?.canPayVATSeparately}
                      style={selectFont}
                    >
                      No
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label className="mb-2 block">Cantidad de cuotas</Label>

                <Select
                  value={installments}
                  onValueChange={setInstallments}
                  disabled={!categoryConfig || categoryConfig.terms.length === 0}
                >
                  <SelectTrigger className="rounded-xl" style={selectFont}>
                    <SelectValue placeholder="Seleccione el plazo" />
                  </SelectTrigger>

                  <SelectContent style={selectFont}>
                    {(categoryConfig?.terms ?? []).map((term) => (
                      <SelectItem
                        key={term.meses}
                        value={String(term.meses)}
                        style={selectFont}
                      >
                        {term.meses} cuotas
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <p className="mt-2 text-xs text-gray-500">
                  {categoryConfig
                    ? `Plazos disponibles: ${categoryConfig.terms
                        .map((t) => t.meses)
                        .join(", ")} cuotas`
                    : "Seleccione un equipo para ver los plazos disponibles"}
                </p>
              </div>

              {validations.length > 0 && (
                <Alert className="border-red-200 bg-red-50">
                  <AlertDescription>
                    <div className="space-y-1">
                      {validations.map((message, index) => (
                        <div key={index}>{message}</div>
                      ))}
                    </div>
                  </AlertDescription>
                </Alert>
              )}

              <Button
                variant="outline"
                onClick={handleReset}
                className="rounded-xl border-gray-300"
              >
                Restablecer
              </Button>
            </CardContent>
          </Card>

          <Card className="rounded-3xl border-0 shadow-sm ring-1 ring-gray-200">
            <CardHeader>
              <CardTitle className="text-2xl text-gray-900">
                Resultados
              </CardTitle>
            </CardHeader>

            <CardContent>
              {/* Interruptor global: afecta el I.V.A. de los cuadros "Base + I.V.A." */}
              <div className="mb-4 flex items-center justify-between gap-3 rounded-2xl border border-gray-200 bg-white px-4 py-3">
                <div>
                  <p className="text-sm font-semibold text-gray-800">
                    Aplicar Ajuste
                  </p>
                  <p className="text-xs text-gray-500">
                    Usa el I.V.A. ajustado del equipo seleccionado
                  </p>
                </div>

                <button
                  type="button"
                  role="switch"
                  aria-checked={ajustarIva}
                  aria-label="Ajustar I.V.A."
                  onClick={() => setAjustarIva((v) => !v)}
                  className="flex items-center"
                >
                  <span
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                      ajustarIva ? "bg-[#0d6f91]" : "bg-gray-300"
                    }`}
                  >
                    <span
                      className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                        ajustarIva ? "translate-x-5" : "translate-x-0.5"
                      }`}
                    />
                  </span>
                </button>
              </div>

              {ajustarIva && !ivaAjustadoDisponible && (
                <Alert className="mb-4 border-amber-200 bg-amber-50">
                  <AlertDescription>
                    {selectedEquipoId
                      ? "Este equipo no tiene I.V.A. ajustado; se usa el I.V.A. normal."
                      : "Seleccione un equipo de la lista para aplicar su I.V.A. ajustado; mientras tanto se usa el I.V.A. normal."}
                  </AlertDescription>
                </Alert>
              )}

              {/* ===== CONTADO ===== */}
              <div className="mb-6 rounded-3xl border border-gray-200 bg-gray-50 p-5">
                <h3 className="mb-4 text-xl font-bold text-gray-900">
                  Precio de Contado
                </h3>

                <div className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
                  <Item
                    label="Precio de contado"
                    value={formatCurrency(contadoMonto)}
                  />

                  <Item label="I.V.A." value={formatCurrency(contadoIva)} />
                </div>

                <TotalBox title="Total a pagar" total={contadoTotal} />
              </div>

              {/* ===== CRÉDITO ===== */}
              <div className="rounded-3xl border border-gray-200 bg-gray-50 p-5">
                <h3 className="mb-4 text-xl font-bold text-gray-900">
                  Precio a Crédito
                </h3>

                <div className="mb-4 rounded-3xl bg-[#0b0b0b] p-8 text-white shadow-lg">
                  <p className="text-base font-medium text-gray-300">
                    Cuota mensual
                  </p>

                  <p className="mt-3 text-5xl font-extrabold tracking-tight md:text-6xl">
                    {isValid
                      ? formatCurrency(calculations.roundedMonthlyPayment)
                      : "$0.00"}
                  </p>

                  <p className="mt-4 text-sm font-medium text-gray-300">
                    Total de pagos:{" "}
                    <span className="font-bold text-white">
                      {isValid ? numericInstallments : 0}
                    </span>
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-4 text-sm">
                  <Item
                    label="Cantidad de cuotas"
                    value={String(isValid ? numericInstallments : 0)}
                  />

                  <Item
                    label="Monto de inicial"
                    value={formatCurrency(numericInitial || 0)}
                  />

                  <Item
                    label="Monto financiado"
                    value={formatCurrency(
                      isValid ? calculations.financedAmount : 0
                    )}
                  />

                  <Item
                    label="I.V.A. a pagar en Bs"
                    value={formatCurrency(calculations.ivaToPayField)}
                  />

                  <Item
                    label="Total a pagar"
                    value={formatCurrency(isValid ? calculations.totalToPay : 0)}
                  />
                </div>

                <TotalBox
                  title="Total crédito a pagar"
                  total={isValid ? calculations.totalToPay : 0}
                />

                {SHOW_AIRR_CONTROL &&
                  isValid &&
                  calculations.airrResultante !== null &&
                  calculations.airrObjetivo !== null && (
                    <p className="mt-3 text-xs text-gray-400">
                      Control interno · AIRR objetivo{" "}
                      {(calculations.airrObjetivo * 100).toFixed(2)}% · AIRR
                      resultante{" "}
                      {(calculations.airrResultante * 100).toFixed(2)}%
                    </p>
                  )}
              </div>

              <Button
                onClick={handleSendQuote}
                disabled={sendingQuote}
                className="mt-6 h-12 w-full rounded-xl bg-[#0d6f91] text-base font-semibold hover:bg-[#0a607d]"
              >
                {sendingQuote ? (
                  <>
                    <Loader2 className="mr-2 size-4 animate-spin" />
                    Enviando...
                  </>
                ) : (
                  <>
                    <Mail className="mr-2 size-4" />
                    Enviar cotización por correo
                  </>
                )}
              </Button>

              <p className="mt-2 text-xs text-gray-500">
                Se generará el PDF de la cotización y se enviará por correo al
                lead (y al vendedor, si su correo está registrado en la hoja
                &quot;VENDEDORES&quot;); quedará guardada en el Funel de Venta.
              </p>

              {sendQuoteError && (
                <Alert className="mt-4 border-red-200 bg-red-50">
                  <AlertDescription>{sendQuoteError}</AlertDescription>
                </Alert>
              )}

              {sendQuoteSuccess && (
                <Alert className="mt-4 border-green-200 bg-green-50">
                  <AlertDescription>{sendQuoteSuccess}</AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <p className="text-gray-500">{label}</p>

      <p className="mt-1 font-semibold text-gray-900">{value}</p>
    </div>
  );
}

function TotalBox({ title, total }: { title: string; total: number }) {
  return (
    <div className="mt-4 rounded-2xl border border-[#0d6f91]/30 bg-[#0d6f91]/10 p-4">
      <p className="text-sm font-medium text-[#0d6f91]">{title}</p>

      <p className="mt-1 text-3xl font-extrabold tracking-tight text-gray-900">
        {formatCurrency(total)}
      </p>
    </div>
  );
}
