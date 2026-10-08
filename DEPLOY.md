# Guía de puesta en marcha: Google Sheet → GitHub → Vercel

Orden recomendado: primero el backend (Sheet + Apps Script), luego GitHub, luego Vercel.

## Parte 1. Google Sheet + Apps Script

1. Crea un Google Sheet nuevo (ej. "BNH - Calculadora").
2. Renombra la primera pestaña a `PRECIO EQUIPOS` con estos encabezados en la fila 1:
   `ID | Nombre | Categoria | Precio`
   - `Categoria`: usa la clave (`dp`, `mx`, `consonaN5N7`, `consonaN8N9`, `alta`, `congresoMX`, `congresoConsona`) o el nombre visible exacto (ej. `Alta Gama`).
   - `Precio`: base imponible en USD, solo número (ej. 8500).
3. Crea la pestaña `VENDEDORES` con `Nombre | Email`. Sus nombres alimentan el desplegable "Vendedor" y su email recibe copia de la propuesta. Si la hoja no existe o está vacía, el campo vuelve a ser texto libre.
4. No crees `FUNEL DE VENTA`: se crea sola con la primera cotización.
5. Extensiones → Apps Script. Borra lo que haya y pega `apps-script/Code.gs`. Guarda.
6. Implementar → Nueva implementación → engranaje → **Aplicación web**.
   - Ejecutar como: **Yo**
   - Quién tiene acceso: **Cualquier usuario**
7. Autoriza permisos (Google avisará "app no verificada": Configuración avanzada → Ir al proyecto). Ahora se piden también **Documentos** y **Drive**, porque cada cotización genera un PDF.
8. Copia la URL que termina en `/exec`.
9. Prueba: pega esa URL en el navegador añadiendo `?action=getEquipos`. Debe mostrar JSON con tus equipos.

## Parte 2. Probar en local (opcional pero recomendado)

```bash
npm install
cp .env.example .env.local      # en Windows: copy .env.example .env.local
# edita .env.local y pega tu URL /exec
npm run dev
```
Abre http://localhost:3000, clave de acceso `BNH2026`, elige un equipo y envía una cotización de prueba a tu propio correo. Debe llegarte con el PDF "Cotización de Servicios" adjunto (el logo en el PDF solo se ve una vez esté publicado en Vercel).

## Parte 3. Subir a GitHub

1. Crea un repositorio vacío en github.com (sin README).
2. En la carpeta del proyecto:

```bash
git init
git add .
git commit -m "Integración con Google Sheets, funel de venta y envío por correo"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/calculadora-bnh.git
git push -u origin main
```
Si ya existe el repo NeliMarcano/calculadora-bnh, clónalo, copia estos archivos encima y haz `git add . && git commit && git push`.

Verifica que `.env.local` NO aparezca en GitHub (está ignorado) y que `.env.example` SÍ.

## Parte 4. Desplegar en Vercel

1. vercel.com → Add New → Project → importa el repositorio.
2. Framework: Next.js (detectado solo). No cambies build/output.
3. Antes de Deploy, abre **Environment Variables** y agrega:
   - Name: `NEXT_PUBLIC_APPS_SCRIPT_URL`
   - Value: tu URL `/exec`
   - Entornos: Production, Preview y Development.
4. Deploy. Si ya tenías el proyecto en Vercel, agrega la variable en Settings → Environment Variables y haz **Redeploy** (las variables `NEXT_PUBLIC_` se incorporan al compilar).
5. Abre calculadora-bnh.vercel.app y haz una cotización de prueba completa.

## Solución de problemas

| Síntoma | Causa probable |
|---|---|
| "Falta configurar NEXT_PUBLIC_APPS_SCRIPT_URL" | Variable no cargada o falta Redeploy |
| Lista de equipos vacía / error al cargar | Acceso del Web App no está en "Cualquier usuario", o falta la hoja `PRECIO EQUIPOS` |
| Cambié Code.gs y no cambia nada | Implementar → Administrar implementaciones → editar → Nueva versión |
| El correo no llega | Revisa spam; cuota diaria de MailApp; email del lead válido |
| Desplegable de vendedor aparece como texto | Falta la pestaña `VENDEDORES` o no tiene datos; después de editar `Code.gs` crea una nueva versión |
| El logo no aparece en el correo | Solo se ve en producción (Vercel): en localhost la imagen no es pública |
| Aviso "no se encontró el correo del vendedor" | El nombre no coincide con la hoja `VENDEDORES` |
| Al elegir equipo no cambia la categoría | El valor de `Categoria` no coincide con una clave ni con un nombre visible |
| El correo llega sin el PDF adjunto | Revisa el aviso que devuelve la pantalla al enviar; suele ser que faltó autorizar Documentos/Drive al desplegar |
| El logo no aparece en el PDF | Igual que en el correo: solo funciona con el sitio publicado en Vercel |
