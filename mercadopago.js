/**
 * Cloud Functions: createMpPreference + mpWebhook
 * ---------------------------------------------------------------
 * createMpPreference: recibe {servicioId, localidad, lat, lng, monto,
 *   referencia, cliente} desde la app. Antes de crear el pago, VUELVE A
 *   CALCULAR el precio acá en el servidor (usando las zonas guardadas en
 *   Firestore) y lo compara con "monto". Si no coinciden, rechaza el pago
 *   — así nadie puede pagar un monto distinto al real manipulando el
 *   navegador. Devuelve la URL (init_point) a la que hay que redirigir al
 *   cliente para que pague.
 *
 * mpWebhook: Mercado Pago llama a esta URL sola cuando el estado de un pago
 *   cambia (aprobado, rechazado, etc). Actualiza el estado de la solicitud
 *   en Firestore.
 *
 * Requiere:
 *   - Un Access Token de producción de tu cuenta de Mercado Pago
 *     (Mercado Pago > Tu negocio > Configuración > Credenciales).
 *
 * Despliegue:
 *   firebase deploy --only functions:createMpPreference,functions:mpWebhook
 */

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

const MP_ACCESS_TOKEN = defineSecret("MP_ACCESS_TOKEN");

// TODO: cambia esto por la URL real de tu sitio (GitHub Pages).
const SITE_URL = "https://rguille.github.io/barometrica-velazquez/";

// ---- Misma lógica de zonas que usa la app, pero corrida acá en el servidor ----
function puntoEnPoligono(lat, lng, puntos) {
  let dentro = false;
  for (let i = 0, j = puntos.length - 1; i < puntos.length; j = i++) {
    const [latI, lngI] = puntos[i];
    const [latJ, lngJ] = puntos[j];
    const cruza = (lngI > lng) !== (lngJ > lng) &&
      lat < ((latJ - latI) * (lng - lngI)) / (lngJ - lngI) + latI;
    if (cruza) dentro = !dentro;
  }
  return dentro;
}
function normalizarTexto(s) {
  return (s || "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
function encontrarZona(zonas, { lat, lng, localidad }) {
  if (lat != null && lng != null) {
    const porMapa = zonas.find((z) => z.puntos && z.puntos.length >= 3 && puntoEnPoligono(lat, lng, z.puntos));
    if (porMapa) return porMapa;
  }
  if (localidad) {
    const norm = normalizarTexto(localidad);
    const porLocalidad = zonas.find((z) => z.localidades && z.localidades.some((l) => normalizarTexto(l) === norm));
    if (porLocalidad) return porLocalidad;
  }
  return null;
}
async function calcularPrecioReal(servicioId, cliente) {
  const zonesDoc = await db.collection("appdata").doc("zones").get();
  const zonas = zonesDoc.exists ? zonesDoc.data().value || [] : [];
  const zona = encontrarZona(zonas, { lat: cliente.lat, lng: cliente.lng, localidad: cliente.localidad });
  if (!zona || !zona.precios || zona.precios[servicioId] == null) return null;
  return Number(zona.precios[servicioId]);
}

exports.createMpPreference = onRequest(
  { secrets: [MP_ACCESS_TOKEN], cors: true },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Método no permitido" });
      return;
    }
    try {
      const { titulo, monto, referencia } = req.body || {};
      if (!titulo || !monto || !referencia) {
        res.status(400).json({ error: "Faltan datos obligatorios" });
        return;
      }

      // IMPORTANTE: la localidad/ubicación y el servicio NO se toman de lo que
      // manda el navegador en este pedido — eso se podría manipular. Se usan
      // los datos que ya habían quedado guardados cuando se creó la
      // solicitud (antes de llegar a la pantalla de pago), buscando la
      // transacción y el cliente por su id ("referencia") en Firestore.
      const txnDoc = await db.collection("appdata").doc("transactions").get();
      const txns = txnDoc.exists ? txnDoc.data().value || [] : [];
      const txn = txns.find((t) => t.id === referencia);
      if (!txn) {
        res.status(404).json({ error: "No encontramos esa solicitud." });
        return;
      }

      const clientsDoc = await db.collection("appdata").doc("clients").get();
      const clientes = clientsDoc.exists ? clientsDoc.data().value || [] : [];
      const clienteGuardado = clientes.find((c) => c.id === txn.clientId);
      if (!clienteGuardado) {
        res.status(404).json({ error: "No encontramos los datos del cliente." });
        return;
      }

      const precioReal = await calcularPrecioReal(txn.serviceId, clienteGuardado);
      if (precioReal == null) {
        res.status(400).json({ error: "No hay un precio de zona cargado para esa ubicación/localidad." });
        return;
      }
      if (Number(monto) !== precioReal) {
        console.warn(`Monto recibido (${monto}) no coincide con el precio real (${precioReal}) para referencia ${referencia}.`);
        res.status(400).json({ error: "El monto no coincide con el precio de la zona. Volvé a intentarlo." });
        return;
      }

      const body = {
        items: [
          {
            title: titulo,
            quantity: 1,
            currency_id: "UYU",
            unit_price: precioReal,
          },
        ],
        payer: clienteGuardado ? { name: `${clienteGuardado.nombre || ""} ${clienteGuardado.apellidos || ""}`.trim() } : undefined,
        external_reference: referencia,
        back_urls: {
          success: `${SITE_URL}?status=approved`,
          pending: `${SITE_URL}?status=pending`,
          failure: `${SITE_URL}?status=failure`,
        },
        auto_return: "approved",
        // El aviso de pagos (webhook) se configura UNA vez en el panel de
        // Mercado Pago (ver GUIA-MERCADOPAGO.md), no hace falta mandarlo acá.
      };

      const response = await fetch("https://api.mercadopago.com/checkout/preferences", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${MP_ACCESS_TOKEN.value()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      const data = await response.json();
      if (!response.ok) {
        console.error("Error creando preferencia de Mercado Pago:", data);
        res.status(502).json({ error: data });
        return;
      }

      // Guarda la referencia en Firestore para poder cruzarla cuando llegue el webhook.
      await db.collection("appdata").doc("mercadopago_preferences").set(
        { [data.id]: { referencia, monto: precioReal, creado: new Date().toISOString() } },
        { merge: true }
      );

      res.status(200).json({ init_point: data.init_point, preference_id: data.id });
    } catch (err) {
      console.error("Error inesperado en createMpPreference:", err);
      res.status(500).json({ error: String(err) });
    }
  }
);

exports.mpWebhook = onRequest({ secrets: [MP_ACCESS_TOKEN] }, async (req, res) => {
  try {
    const paymentId = req.query["data.id"] || req.query.id || (req.body && req.body.data && req.body.data.id);
    if (!paymentId) {
      res.status(200).send("ok"); // Mercado Pago solo necesita un 200, no reintenta.
      return;
    }

    const paymentRes = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN.value()}` },
    });
    const payment = await paymentRes.json();
    const referencia = payment.external_reference;
    const status = payment.status; // approved | pending | rejected | ...

    if (referencia) {
      // Busca la transacción por id (guardada como "referencia" = txn.id) y
      // actualiza su estado de pago dentro del arreglo guardado en Firestore.
      const txnDoc = await db.collection("appdata").doc("transactions").get();
      if (txnDoc.exists) {
        const txns = txnDoc.data().value || [];
        const idx = txns.findIndex((t) => t.id === referencia);
        if (idx !== -1) {
          txns[idx].pagoEstado = status === "approved" ? "pagado" : status === "pending" ? "pendiente_mp" : "rechazado";
          txns[idx].mpPaymentId = paymentId;
          await db.collection("appdata").doc("transactions").set({ value: txns, updatedAt: new Date().toISOString() });
        }
      }
    }

    res.status(200).send("ok");
  } catch (err) {
    console.error("Error en mpWebhook:", err);
    res.status(200).send("ok"); // Igual respondemos 200 para que MP no reintente en loop.
  }
});
