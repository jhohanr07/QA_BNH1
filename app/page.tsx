"use client";

import Image from "next/image";
import React, { useEffect, useMemo, useState } from "react";
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
  type ReglaInicial,
} from "@/lib/apps-script-api";
import { evaluateInitialFormula } from "@/lib/initial-formula";

// Categorías, inicial mínima/sugerida y AIRR objetivo por plazo (columnas L:N)
// salen de la hoja "CATEGORIA". Solo estos valores no están en la hoja:
const VAT_RATE = 0.16;
const MIN_INITIAL_RATE_DEFAULT = 0.2;
const SUGGESTED_INITIAL_RATE_DEFAULT = 0.25;
const ACCESS_PASSWORD = "BNH2026";

// Categorías (nombre normalizado) que no permiten pagar el I.V.A. por separado
const CATEGORIES_WITHOUT_SEPARATE_VAT = ["teair"];

// Paso de redondeo de la inicial solo cuando la hoja no trae una fórmula utilizable
const INITIAL_STEP = 500;

// El precio del equipo YA incluye el 3 % de IGTF:
// base imponible = precio / 1,03  ->  I.V.A. = (precio / 1,03) x 16 %
const CONTADO_DIVISOR = 1.03;
const IGTF_RATE = CONTADO_DIVISOR - 1;

type PlazoAirr = { meses: number; tasa: number };

type CategoryConfig = {
  nombre: string;
  minInitialRate: number;
  minDigits: number | null;
  minFormula: string | null;
  suggestedInitialRate: number;
  suggestedDigits: number | null;
  suggestedFormula: string | null;
  // Plazos disponibles con su AIRR objetivo anual (hoja CATEGORIA, columnas L:N)
  terms: PlazoAirr[];
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

function roundUpToNearest5(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.ceil(value / 5) * 5;
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

// Acepta 0.25 o 25 (por si la hoja entrega el porcentaje como 25)
function normalizeRate(value: number) {
  return value > 1 ? value / 100 : value;
}

/* ------------------------------------------------------------------ */
/*  Cálculo por TIR (AIRR) — igual que la versión vieja                */
/* ------------------------------------------------------------------ */

function calculateIRR(cashFlows: number[]): number | null {
  if (cashFlows.length < 2) return null;

  const hasPositive = cashFlows.some((v) => v > 0);
  const hasNegative = cashFlows.some((v) => v < 0);

  if (!hasPositive || !hasNegative) return null;

  const npv = (rate: number) =>
    cashFlows.reduce((acc, cf, i) => acc + cf / Math.pow(1 + rate, i), 0);

  let low = -0.9999;
  let high = 10;

  const npvLow = npv(low);
  let npvHigh = npv(high);

  if (!Number.isFinite(npvLow) || !Number.isFinite(npvHigh)) return null;

  let attempts = 0;

  while (npvLow * npvHigh > 0 && attempts < 60) {
    high *= 2;
    npvHigh = npv(high);

    if (!Number.isFinite(npvHigh)) return null;

    attempts++;
  }

  if (npvLow * npvHigh > 0) return null;

  let npvLowCurrent = npvLow;

  for (let i = 0; i < 250; i++) {
    const mid = (low + high) / 2;
    const npvMid = npv(mid);

    if (!Number.isFinite(npvMid)) return null;

    if (Math.abs(npvMid) < 1e-10) return mid;

    if (npvLowCurrent * npvMid < 0) {
      high = mid;
    } else {
      low = mid;
      npvLowCurrent = npvMid;
    }
  }

  return (low + high) / 2;
}

function monthlyIrrToAnnual(irr: number | null) {
  if (irr === null || !Number.isFinite(irr)) return null;
  return Math.pow(1 + irr, 12) - 1;
}

function buildCashFlows(params: {
  commercialPrice: number;
  initialAmount: number;
  installments: number;
  monthlyPayment: number;
  ivaFinancing: PaymentMode;
  ivaAmount: number;
}) {
  const {
    commercialPrice,
    initialAmount,
    installments,
    monthlyPayment,
    ivaFinancing,
    ivaAmount,
  } = params;

  const flow0 = -commercialPrice + initialAmount;

  if (ivaFinancing === "si") {
    return [
      flow0,
      ...Array.from({ length: installments }, () => monthlyPayment),
    ];
  }

  return [
    flow0,
    ivaAmount,
    ...Array.from({ length: installments }, () => monthlyPayment),
  ];
}

function findMinimumMonthlyPayment(params: {
  commercialPrice: number;
  initialAmount: number;
  installments: number;
  targetAnnualRate: number;
  ivaFinancing: PaymentMode;
  ivaAmount: number;
}) {
  const {
    commercialPrice,
    initialAmount,
    installments,
    targetAnnualRate,
    ivaFinancing,
    ivaAmount,
  } = params;

  const financedAmount = commercialPrice - initialAmount;

  const emptyResult = {
    rawMonthlyPayment: 0,
    roundedMonthlyPayment: 0,
    monthlyIrr: null as number | null,
    annualIrr: null as number | null,
  };

  if (
    !Number.isFinite(financedAmount) ||
    financedAmount <= 0 ||
    !Number.isInteger(installments) ||
    installments <= 0
  ) {
    return emptyResult;
  }

  const getAnnualIrrFromPayment = (payment: number) => {
    const cashFlows = buildCashFlows({
      commercialPrice,
      initialAmount,
      installments,
      monthlyPayment: payment,
      ivaFinancing,
      ivaAmount,
    });

    const irr = calculateIRR(cashFlows);
    const annual = monthlyIrrToAnnual(irr);

    return { irr, annual };
  };

  let low = 0;
  let high = Math.max(financedAmount * 2, 1000);

  let highResult = getAnnualIrrFromPayment(high);

  let attempts = 0;

  while (
    (highResult.annual === null || highResult.annual < targetAnnualRate) &&
    attempts < 100
  ) {
    high *= 2;
    highResult = getAnnualIrrFromPayment(high);
    attempts++;
  }

  if (highResult.annual === null || highResult.annual < targetAnnualRate) {
    return emptyResult;
  }

  for (let i = 0; i < 250; i++) {
    const mid = (low + high) / 2;
    const result = getAnnualIrrFromPayment(mid);

    if (result.annual === null) {
      low = mid;
      continue;
    }

    if (result.annual >= targetAnnualRate) {
      high = mid;
    } else {
      low = mid;
    }
  }

  const rawMonthlyPayment = high;

  let roundedMonthlyPayment = roundUpToNearest5(rawMonthlyPayment);

  let finalResult = getAnnualIrrFromPayment(roundedMonthlyPayment);

  while (finalResult.annual !== null && finalResult.annual < targetAnnualRate) {
    roundedMonthlyPayment += 5;
    finalResult = getAnnualIrrFromPayment(roundedMonthlyPayment);
  }

  return {
    rawMonthlyPayment,
    roundedMonthlyPayment,
    monthlyIrr: finalResult.irr,
    annualIrr: finalResult.annual,
  };
}

/* ------------------------------------------------------------------ */

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
                Ingrese la clave para acceder a la calculadora de
                financiamiento
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

  // Interruptor "Ajustar": usa el "IVA ajustado" de PRECIO EQUIPOS (solo Contado)
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

  // Al elegir el equipo se llenan la categoría y los precios (crédito y contado).
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

    // AIRR objetivo por plazo (columnas L:N). Los plazos sin valor
    // ("Sin calculo") no vienen en la lista y por eso no están disponibles.
    const terms: PlazoAirr[] = (found.airr ?? [])
      .filter(
        (t) =>
          Number.isInteger(t.meses) &&
          t.meses > 0 &&
          Number.isFinite(t.tasa) &&
          t.tasa > 0
      )
      .map((t) => ({ meses: t.meses, tasa: normalizeRate(t.tasa) }))
      .sort((a, b) => a.meses - b.meses);

    return {
      nombre: found.nombre,
      minInitialRate: min.rate,
      minDigits: min.digits,
      minFormula: min.formula,
      suggestedInitialRate: suggested.rate,
      suggestedDigits: suggested.digits,
      suggestedFormula: suggested.formula,
      terms,
      canPayVATSeparately: !CATEGORIES_WITHOUT_SEPARATE_VAT.includes(
        normalizeText(found.nombre)
      ),
    };
  }, [categorias, category]);

  const activeTerms = useMemo<PlazoAirr[]>(
    () => categoryConfig?.terms ?? [],
    [categoryConfig]
  );

  const numericBase = Number(basePrice);
  const numericInitial = Number(initialAmount);
  const numericInstallments = Number(installments);
  const numericContado = Number(contadoPriceInput);

  // Precio de crédito (YA incluye el 3 % de IGTF)
  const safeBaseForRules =
    Number.isFinite(numericBase) && numericBase > 0 ? numericBase : 0;

  // Base imponible = precio / 1,03 (igual que la "base imponible" de la versión vieja)
  const baseImponible = safeBaseForRules / CONTADO_DIVISOR;

  // Inicial mínima y sugerida: fórmula de la hoja CATEGORIA sobre la base imponible
  const minInitialAmount = useMemo(() => {
    if (!categoryConfig || baseImponible <= 0) return 0;
    return (
      // La fórmula de la hoja ya divide entre 1,03: se le pasa el PRECIO
      evaluateInitialFormula(categoryConfig.minFormula, safeBaseForRules) ??
      roundUpByRule(
        baseImponible * categoryConfig.minInitialRate,
        categoryConfig.minDigits
      )
    );
  }, [categoryConfig, baseImponible, safeBaseForRules]);

  const suggestedInitialAmount = useMemo(() => {
    if (!categoryConfig || baseImponible <= 0) return 0;
    return (
      // La fórmula de la hoja ya divide entre 1,03: se le pasa el PRECIO
      evaluateInitialFormula(categoryConfig.suggestedFormula, safeBaseForRules) ??
      roundUpByRule(
        baseImponible * categoryConfig.suggestedInitialRate,
        categoryConfig.suggestedDigits
      )
    );
  }, [categoryConfig, baseImponible, safeBaseForRules]);

  // La inicial que se autocompleta es la mínima (igual que la versión vieja)
  const autoInitialAmount = Math.ceil(minInitialAmount);

  // I.V.A. normal: (precio / 1,03) x 16 %  (el precio ya incluye el IGTF)
  const vatAmount = baseImponible * VAT_RATE;

  // --- Contado: I.V.A. = (monto / 1,03) x 16 % ---
  const contadoMonto =
    Number.isFinite(numericContado) && numericContado > 0 ? numericContado : 0;
  const contadoIvaNormal = (contadoMonto / CONTADO_DIVISOR) * VAT_RATE;

  // --- "Ajustar": solo afecta la sección Contado ---
  const equipoSeleccionado = equipos.find((e) => e.id === selectedEquipoId);
  const ivaAjustadoLista = equipoSeleccionado?.ivaAjustado ?? 0;
  const ivaAjustadoDisponible = ivaAjustadoLista > 0;
  const usaAjuste = ajustarIva && ivaAjustadoDisponible;

  // I.V.A. que usa el crédito (independiente del interruptor "Ajustar"):
  // el I.V.A. ajustado de la lista si existe; si no, el I.V.A. normal.
  const ivaCredito =
    safeBaseForRules > 0
      ? ivaAjustadoDisponible
        ? ivaAjustadoLista
        : vatAmount
      : 0;

  const creditoIva = ivaCredito;
  const creditoTotal = safeBaseForRules + creditoIva;

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
      !activeTerms.some((t) => String(t.meses) === installments)
    ) {
      setInstallments("");
    }
  }, [categoryConfig, activeTerms, installments]);

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
      baseImponible > 0 &&
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
      baseImponible > 0 &&
      Number.isFinite(numericInitial) &&
      numericInitial >= baseImponible
    ) {
      errors.push("No válido: la inicial debe ser menor a la base imponible.");
    }

    if (
      installments !== "" &&
      Number.isInteger(numericInstallments) &&
      !activeTerms.some((t) => t.meses === numericInstallments)
    ) {
      errors.push("No válido: este plazo no está disponible para la categoría.");
    }

    if (!categoryConfig.canPayVATSeparately && ivaFinancing === "no") {
      errors.push("No válido: esta categoría no permite pagar el I.V.A. por separado.");
    }

    return errors;
  }, [
    categoryConfig,
    activeTerms,
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
    baseImponible,
  ]);

  const calculations = useMemo(() => {
    const safeInitial =
      Number.isFinite(numericInitial) && numericInitial >= 0
        ? numericInitial
        : 0;

    const safeInstallments =
      Number.isInteger(numericInstallments) && numericInstallments > 0
        ? numericInstallments
        : 0;

    // I.V.A. que se paga aparte solo cuando NO se financia
    const ivaSeparate = ivaFinancing === "no" ? ivaCredito : 0;

    const empty = {
      roundedMonthlyPayment: 0,
      totalToPay: safeInitial,
      ivaToPayField: ivaSeparate,
      financedAmount: 0,
      monthlyIrr: null as number | null,
      annualIrr: null as number | null,
    };

    if (!categoryConfig || baseImponible <= 0 || safeInstallments <= 0) {
      return empty;
    }

    const term = activeTerms.find((t) => t.meses === safeInstallments);
    if (!term) return empty;

    // Precio comercial = (base imponible + I.V.A.) x 1,03 (IGTF), como la versión vieja
    const commercialPrice = (baseImponible + ivaCredito) * (1 + IGTF_RATE);

    if (commercialPrice - safeInitial <= 0) return empty;

    const search = findMinimumMonthlyPayment({
      commercialPrice,
      initialAmount: safeInitial,
      installments: safeInstallments,
      targetAnnualRate: term.tasa,
      ivaFinancing,
      ivaAmount: ivaCredito,
    });

    const totalToPay =
      safeInitial + ivaSeparate + search.roundedMonthlyPayment * safeInstallments;

    return {
      roundedMonthlyPayment: search.roundedMonthlyPayment,
      totalToPay,
      ivaToPayField: ivaSeparate,
      financedAmount: Math.max(commercialPrice - safeInitial - ivaSeparate, 0),
      monthlyIrr: search.monthlyIrr,
      annualIrr: search.annualIrr,
    };
  }, [
    baseImponible,
    numericInitial,
    numericInstallments,
    ivaCredito,
    ivaFinancing,
    categoryConfig,
    activeTerms,
  ]);

  const selectedTerm = activeTerms.find((t) => t.meses === numericInstallments);

  const isValid =
    !!categoryConfig &&
    !!selectedTerm &&
    Number.isFinite(numericBase) &&
    numericBase > 0 &&
    Number.isFinite(numericInitial) &&
    numericInitial >= minInitialAmount &&
    Number.isInteger(numericInstallments) &&
    numericInstallments > 0 &&
    validations.length === 0 &&
    calculations.roundedMonthlyPayment > 0 &&
    calculations.annualIrr !== null &&
    calculations.annualIrr >= selectedTerm.tasa;

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
                    <SelectTrigger
                      className="rounded-xl"
                      style={{ fontFamily: "Verdana, sans-serif" }}
                    >
                      <SelectValue placeholder="Seleccione un vendedor" />
                    </SelectTrigger>

                    <SelectContent style={{ fontFamily: "Verdana, sans-serif" }}>
                      {vendedores.map((nombre) => (
                        <SelectItem
                          key={nombre}
                          value={nombre}
                          style={{ fontFamily: "Verdana, sans-serif" }}
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
                  disabled={equiposLoading || equipos.length === 0}
                >
                  <SelectTrigger
                    className="rounded-xl"
                    style={{ fontFamily: "Verdana, sans-serif" }}
                  >
                    <SelectValue
                      placeholder={
                        equiposLoading
                          ? "Cargando equipos..."
                          : "Seleccione un equipo"
                      }
                    />
                  </SelectTrigger>

                  <SelectContent style={{ fontFamily: "Verdana, sans-serif" }}>
                    {equipos.map((equipo) => {
                      const sinPrecio =
                        equipo.precioCredito <= 0 && equipo.precioContado <= 0;

                      return (
                        <SelectItem
                          key={equipo.id}
                          value={equipo.id}
                          disabled={sinPrecio}
                          style={{ fontFamily: "Verdana, sans-serif" }}
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
                    style={{ fontFamily: "Verdana, sans-serif" }}
                  >
                    <SelectValue
                      placeholder={
                        categoriasLoading
                          ? "Cargando categorías..."
                          : "Se completa al elegir el equipo"
                      }
                    />
                  </SelectTrigger>

                  <SelectContent style={{ fontFamily: "Verdana, sans-serif" }}>
                    {categorias.map((cat) => (
                      <SelectItem
                        key={cat.nombre}
                        value={cat.nombre}
                        style={{ fontFamily: "Verdana, sans-serif" }}
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
                  step="0.01"
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
                  <SelectTrigger
                    className="rounded-xl"
                    style={{ fontFamily: "Verdana, sans-serif" }}
                  >
                    <SelectValue placeholder="Seleccione" />
                  </SelectTrigger>

                  <SelectContent style={{ fontFamily: "Verdana, sans-serif" }}>
                    <SelectItem
                      value="si"
                      style={{ fontFamily: "Verdana, sans-serif" }}
                    >
                      Sí
                    </SelectItem>

                    <SelectItem
                      value="no"
                      disabled={!categoryConfig?.canPayVATSeparately}
                      style={{ fontFamily: "Verdana, sans-serif" }}
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
                  disabled={!categoryConfig || activeTerms.length === 0}
                >
                  <SelectTrigger
                    className="rounded-xl"
                    style={{ fontFamily: "Verdana, sans-serif" }}
                  >
                    <SelectValue placeholder="Seleccione el plazo" />
                  </SelectTrigger>

                  <SelectContent style={{ fontFamily: "Verdana, sans-serif" }}>
                    {activeTerms.map((term) => (
                      <SelectItem
                        key={term.meses}
                        value={String(term.meses)}
                        style={{ fontFamily: "Verdana, sans-serif" }}
                      >
                        {term.meses} cuotas
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <p className="mt-2 text-xs text-gray-500">
                  {categoryConfig
                    ? activeTerms.length > 0
                      ? `Plazos disponibles: ${activeTerms
                          .map((t) => t.meses)
                          .join(", ")} cuotas`
                      : "No hay plazos disponibles para esta categoría (sin AIRR en la hoja CATEGORIA)"
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
              {/* Interruptor: afecta solo el I.V.A. de la sección Contado */}
              <div className="mb-4 flex items-center justify-between gap-3 rounded-2xl border border-gray-200 bg-white px-4 py-3">
                <div>
                  <p className="text-sm font-semibold text-gray-800">
                    Aplicar Ajuste
                  </p>
                  <p className="text-xs text-gray-500"></p>
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
                      ? "El I.V.A. normal."
                      : "Seleccione un equipo de la lista para aplicar su I.V.A. ; mientras tanto se usa el I.V.A. normal."}
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
                    value={formatCurrency(calculations.totalToPay)}
                  />
                </div>

                <TotalBox
                  title="Total crédito a pagar"
                  total={calculations.totalToPay}
                />
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
