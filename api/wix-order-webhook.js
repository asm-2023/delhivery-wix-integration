// api/wix-order-webhook.js
//
// Receives a Wix "Order Approved" webhook (wix.ecom.v1.order.approved),
// maps the order to a Delhivery shipment payload, and calls Delhivery's
// Order Creation / Manifestation API to create the shipment.
//
// ENV VARS REQUIRED (set in Vercel project settings):
//   DELHIVERY_API_TOKEN     - Delhivery API token (Bearer auth)
//   DELHIVERY_PICKUP_NAME   - Registered pickup location name (e.g. "Mumbai Residence")
//   DELHIVERY_SELLER_NAME   - Seller name as registered with Delhivery
//   DELHIVERY_SELLER_GST    - Seller GST TIN (mandatory in Delhivery API)
//   DELHIVERY_HSN_CODE      - HSN code for products (e.g. "4901" for books)
//   DELHIVERY_BASE_URL      - https://track.delhivery.com (production)
//   WIX_WEBHOOK_SECRET      - (optional) shared secret to validate inbound calls,
//                             configured as a query param in the Wix Automation webhook URL
//
// NOTE ON AUTH:
// Wix Automations "Send a webhook" action does not sign requests by default.
// We recommend adding a query param `?secret=...` to the webhook URL configured
// in the Wix Automation, and checking it here.

const DEFAULT_WEIGHT_GRAMS = 180; // fallback if Wix doesn't provide item weight

function poundsToGrams(lb) {
  return Math.round(lb * 453.592);
}

function extractOrderFromPayload(body) {
  // Order Approved webhook shape:
  // { entityFqdn: "wix.ecom.v1.order", slug: "approved", actionEvent: { body: { order: {...} } } }
  if (body?.actionEvent?.body?.order) return body.actionEvent.body.order;
  // Order Created webhook shape:
  // { createdEvent: { entity: {...} } }
  if (body?.createdEvent?.entity) return body.createdEvent.entity;
  // Allow direct order object for manual testing
  if (body?.number && body?.recipientInfo) return body;
  return null;
}

function buildDelhiveryPayload(order) {
  const recipient = order.recipientInfo || {};
  const address = recipient.address || {};
  const contact = recipient.contactDetails || {};

  const lineItems = order.lineItems || [];

  // Combine product names for products_desc
  const productsDesc = lineItems
    .map((li) => li.productName?.original || "Item")
    .join(", ");

  // Total weight: sum of (weight_in_lb * qty), converted to grams
  let totalWeightGrams = 0;
  for (const li of lineItems) {
    const qty = li.quantity || 1;
    const weightLb = li.physicalProperties?.weight;
    if (typeof weightLb === "number" && weightLb > 0) {
      totalWeightGrams += poundsToGrams(weightLb) * qty;
    } else {
      totalWeightGrams += DEFAULT_WEIGHT_GRAMS * qty;
    }
  }

  const totalAmount = parseFloat(order.priceSummary?.total?.amount || "0");
  const paymentStatus = order.paymentStatus; // PAID, UNPAID, PARTIALLY_PAID, etc.
  const paymentMode = paymentStatus === "PAID" ? "Prepaid" : "COD";
  const codAmount = paymentMode === "COD" ? totalAmount : 0;

  // HSN codes: one per line item, repeated for quantity if needed
  const hsnCode = process.env.DELHIVERY_HSN_CODE || "4901";

  const shipment = {
    name: `${contact.firstName || ""} ${contact.lastName || ""}`.trim(),
    add: address.addressLine || address.addressLine1 || "",
    pin: address.postalCode || "",
    city: (address.city || "").trim(),
    state: address.subdivisionFullname || address.subdivision || "",
    country: address.countryFullname || "India",
    phone: contact.phone || "",
    order: String(order.number),
    payment_mode: paymentMode,
    cod_amount: codAmount ? String(codAmount) : "",
    total_amount: String(totalAmount),
    products_desc: productsDesc,
    quantity: String(lineItems.reduce((sum, li) => sum + (li.quantity || 1), 0)),
    weight: String(totalWeightGrams),
    seller_gst_tin: process.env.DELHIVERY_SELLER_GST || "",
    seller_name: process.env.DELHIVERY_SELLER_NAME || "",
    hsn_code: hsnCode,
    shipment_width: "",
    shipment_height: "",
    shipping_mode: "Surface",
  };

  const payload = {
    pickup_location: {
      name: process.env.DELHIVERY_PICKUP_NAME || "",
    },
    shipments: [shipment],
  };

  return payload;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Optional shared-secret check
  const expectedSecret = process.env.WIX_WEBHOOK_SECRET;
  if (expectedSecret) {
    const provided = req.query?.secret;
    if (provided !== expectedSecret) {
      return res.status(200).json({
        debug: true,
        error: "Unauthorized",
        reason: "secret_mismatch",
        providedSecret: provided ?? null,
        expectedSecretIsSet: true,
        queryKeys: Object.keys(req.query || {}),
      });
    }
  }

  try {
    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        // leave as string; will be reported in debug below
      }
    }
    if (Buffer.isBuffer(body)) {
      try {
        body = JSON.parse(body.toString("utf8"));
      } catch {
        body = body.toString("utf8");
      }
    }

    // TEMP DEBUG: forward raw payload + headers to webhook.site for inspection
    try {
      await fetch("https://webhook.site/6dceb8fd-62be-48fa-a3ea-e3d74bd1c952", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          headers: req.headers,
          query: req.query,
          parsedBody: body,
          rawBodyType: typeof req.body,
        }),
      });
    } catch (e) {
      // ignore debug forwarding errors
    }

    const order = extractOrderFromPayload(body);

    if (!order) {
      return res.status(200).json({
        debug: true,
        error: "Could not find order in payload",
        bodyType: typeof body,
        bodyKeys: body && typeof body === "object" ? Object.keys(body) : null,
        bodyPreview: typeof body === "string" ? body.slice(0, 2000) : JSON.stringify(body)?.slice(0, 2000),
        contentType: req.headers["content-type"] || null,
      });
    }

    // Only push physical/shippable orders
    const hasShippable = (order.lineItems || []).some(
      (li) => li.physicalProperties?.shippable
    );
    if (!hasShippable) {
      return res.status(200).json({
        skipped: true,
        reason: "No shippable line items",
        orderNumber: order.number,
      });
    }

    const delhiveryPayload = buildDelhiveryPayload(order);

    const baseUrl = process.env.DELHIVERY_BASE_URL || "https://track.delhivery.com";
    const url = `${baseUrl}/api/cmu/create.json`;

    // Delhivery expects: format=json&data=<json-encoded-payload> as form-encoded body
    const formBody = new URLSearchParams();
    formBody.set("format", "json");
    formBody.set("data", JSON.stringify(delhiveryPayload));

    const delhiveryResp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Token ${process.env.DELHIVERY_API_TOKEN}`,
      },
      body: formBody.toString(),
    });

    const delhiveryText = await delhiveryResp.text();
    let delhiveryJson;
    try {
      delhiveryJson = JSON.parse(delhiveryText);
    } catch {
      delhiveryJson = { raw: delhiveryText };
    }

    if (!delhiveryResp.ok) {
      console.error("Delhivery API error", delhiveryResp.status, delhiveryJson);
      return res.status(200).json({
        debug: true,
        error: "Delhivery API error",
        status: delhiveryResp.status,
        details: delhiveryJson,
        sentPayload: delhiveryPayload,
      });
    }

    return res.status(200).json({
      success: true,
      orderNumber: order.number,
      delhiveryResponse: delhiveryJson,
      sentPayload: delhiveryPayload,
    });
  } catch (err) {
    console.error("Webhook handler error", err);
    return res.status(200).json({ debug: true, error: String(err), stack: err?.stack });
  }
}
