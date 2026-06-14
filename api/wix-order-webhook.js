// api/wix-order-webhook.js
//
// Receives a Wix Automation "Order Placed" webhook payload (shape:
// { data: { orderNumber, lineItems, shippingInfo, contact, priceSummary, ... } }),
// maps it to a Delhivery shipment payload, and calls Delhivery's
// Order Creation / Manifestation API to create the shipment.
//
// ENV VARS REQUIRED (set in Vercel project settings):
//   DELHIVERY_API_TOKEN          - Delhivery API token (Bearer auth)
//   DELHIVERY_PICKUP_NAME_MUMBAI - Mumbai pickup location name (default: "Mumbai Residence")
//   DELHIVERY_PICKUP_NAME_PUNE   - Pune pickup location name (default: "Pune Residence")
//   DELHIVERY_SELLER_NAME        - Seller name as registered with Delhivery
//   DELHIVERY_SELLER_GST         - Seller GST TIN (mandatory in Delhivery API)
//   DELHIVERY_HSN_CODE           - HSN code for products (e.g. "4901" for books)
//   DELHIVERY_BASE_URL           - https://track.delhivery.com (production)
//   WIX_WEBHOOK_SECRET           - shared secret to validate inbound calls,
//                                  configured as a query param in the Wix Automation webhook URL

const DEFAULT_WEIGHT_GRAMS = 180; // fallback for unmapped SKUs

// Per-SKU weight in grams
const SKU_WEIGHTS = {
  "DA-S8DP-6A1T": 450, // 12 Shiva Jyotirlings [Hard Cover]
  "amargranth-003": 450, // 51 Shaktipeeths [Hardcover]
  "amargranth-004": 900, // 12 Jyotirlings + 51 Shaktipeeths Combo Set [Hardcover]
  "amargranth-005": 200, // 12 Shiva Jyotirlings [Hindi] [Paperback]
  "amargranth-007": 300, // Rivers of Bharat [Paperback]
  "amargranth-008": 450, // Chronicles of Lord Parashurama [Hardcover]
  "amargranth-010": 200, // Shiva's Tears: Rudraksha
};

// SKUs that require shipping from "Mumbai Residence" pickup location.
// Any order containing one of these uses Mumbai Residence; otherwise Pune Residence.
const MUMBAI_PICKUP_SKUS = new Set(["amargranth-003", "amargranth-004"]);

// Default dimensions: 28x26cm for all books except the Rivers of Bharat
// book (44x28cm). Height is 1cm for single-SKU orders, 3cm for multi-SKU orders.
const RIVERS_SKU = "amargranth-007";

function poundsToGrams(lb) {
  return Math.round(lb * 453.592);
}

// Normalize whatever payload shape Wix sends into a common internal shape.
function normalizeOrder(body) {
  // Shape A (observed in practice): Wix Automation "Order Placed" trigger payload
  // { data: { orderNumber, lineItems: [...], shippingInfo: { logistics: { shippingDestination: {...} } }, ... } }
  const d = body?.data;
  if (d?.orderNumber && Array.isArray(d?.lineItems)) {
    const dest = d.shippingInfo?.logistics?.shippingDestination;
    const address = dest?.address || d.billingInfo?.address || d.contact?.address || {};
    const contactDetails = dest?.contactDetails || d.billingInfo?.contactDetails || {};

    return {
      number: d.orderNumber,
      address: {
        addressLine: address.addressLine || address.addressLine1 || "",
        city: (address.city || "").trim(),
        subdivisionFullname: address.subdivisionFullname || "",
        subdivision: address.subdivision || "",
        postalCode: address.postalCode || "",
        countryFullname: address.countryFullname || "India",
      },
      contact: {
        firstName: (contactDetails.firstName || d.contact?.name?.first || "").trim(),
        lastName: (contactDetails.lastName || d.contact?.name?.last || "").trim(),
        phone: contactDetails.phone || d.contact?.phone || "",
      },
      email: d.buyerEmail || d.contact?.email || "",
      lineItems: d.lineItems.map((li) => ({
        name: li.itemName || "Item",
        sku: li.sku || "",
        qty: li.quantity || 1,
        weight: undefined, // not provided in this payload shape
        shippable: li.shippable !== false, // default true if unspecified
      })),
      total: d.priceSummary?.total?.value ?? d.priceSummary?.total?.amount ?? "0",
      paymentStatus: d.paymentStatus,
    };
  }

  // Shape B: raw eCommerce Order entity (wix.ecom.v1.order.approved webhook, or direct order object)
  const order =
    body?.actionEvent?.body?.order ||
    body?.createdEvent?.entity ||
    (body?.number && body?.recipientInfo ? body : null);

  if (order) {
    const recipient = order.recipientInfo || {};
    const address = recipient.address || {};
    const contact = recipient.contactDetails || {};

    return {
      number: order.number,
      address: {
        addressLine: address.addressLine || address.addressLine1 || "",
        city: (address.city || "").trim(),
        subdivisionFullname: address.subdivisionFullname || "",
        subdivision: address.subdivision || "",
        postalCode: address.postalCode || "",
        countryFullname: address.countryFullname || "India",
      },
      contact: {
        firstName: (contact.firstName || "").trim(),
        lastName: (contact.lastName || "").trim(),
        phone: contact.phone || "",
      },
      email: order.buyerInfo?.email || "",
      lineItems: (order.lineItems || []).map((li) => ({
        name: li.productName?.original || "Item",
        sku: li.physicalProperties?.sku || "",
        qty: li.quantity || 1,
        weight: li.physicalProperties?.weight,
        shippable: li.physicalProperties?.shippable !== false,
      })),
      total: order.priceSummary?.total?.amount ?? "0",
      paymentStatus: order.paymentStatus,
    };
  }

  return null;
}

function buildDelhiveryPayload(order) {
  const address = order.address || {};
  const contact = order.contact || {};
  const lineItems = order.lineItems || [];

  const productsDesc = lineItems.map((li) => li.name).join(", ");

  // Weight: sum of per-SKU weights (falls back to DEFAULT_WEIGHT_GRAMS for unmapped SKUs)
  let totalWeightGrams = 0;
  for (const li of lineItems) {
    const qty = li.qty || 1;
    const weightLb = li.weight;
    if (typeof weightLb === "number" && weightLb > 0) {
      totalWeightGrams += poundsToGrams(weightLb) * qty;
    } else {
      const perItemWeight = SKU_WEIGHTS[li.sku] ?? DEFAULT_WEIGHT_GRAMS;
      totalWeightGrams += perItemWeight * qty;
    }
  }

  // Dimensions: 44x28cm if order contains the Rivers of Bharat book, else 28x26cm.
  // Height: 3cm for multi-SKU orders, 1cm for single-SKU orders.
  const hasRiversBook = lineItems.some((li) => li.sku === RIVERS_SKU);
  const isMultiSku = lineItems.length > 1;
  const length = hasRiversBook ? 44 : 28;
  const breadth = hasRiversBook ? 28 : 26;
  const height = isMultiSku ? 3 : 1;

  // Pickup location: Mumbai Residence if order contains the Shaktipeeths hardcover
  // (amargranth-003) or the combo set (amargranth-004), else Pune Residence.
  const needsMumbaiPickup = lineItems.some((li) => MUMBAI_PICKUP_SKUS.has(li.sku));
  const pickupLocationName = needsMumbaiPickup
    ? (process.env.DELHIVERY_PICKUP_NAME_MUMBAI || "Mumbai Residence")
    : (process.env.DELHIVERY_PICKUP_NAME_PUNE || "Pune Residence");

  const totalAmount = parseFloat(order.total || "0");
  const paymentStatus = order.paymentStatus; // PAID, UNPAID, PARTIALLY_PAID, etc.
  const paymentMode = paymentStatus === "PAID" ? "Prepaid" : "COD";
  const codAmount = paymentMode === "COD" ? totalAmount : 0;

  const hsnCode = process.env.DELHIVERY_HSN_CODE || "4901";

  const shipment = {
    name: `${contact.firstName || ""} ${contact.lastName || ""}`.trim(),
    add: address.addressLine || "",
    pin: address.postalCode || "",
    city: address.city || "",
    state: address.subdivisionFullname || address.subdivision || "",
    country: address.countryFullname || "India",
    phone: contact.phone || "",
    order: String(order.number),
    payment_mode: paymentMode,
    cod_amount: codAmount ? String(codAmount) : "",
    total_amount: String(totalAmount),
    products_desc: productsDesc,
    quantity: String(lineItems.reduce((sum, li) => sum + (li.qty || 1), 0)),
    weight: String(totalWeightGrams),
    seller_gst_tin: process.env.DELHIVERY_SELLER_GST || "",
    seller_name: process.env.DELHIVERY_SELLER_NAME || "",
    hsn_code: hsnCode,
    shipment_length: String(length),
    shipment_width: String(breadth),
    shipment_height: String(height),
    shipping_mode: "Surface",
  };

  return {
    pickup_location: {
      name: pickupLocationName,
    },
    shipments: [shipment],
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Shared-secret check
  const expectedSecret = process.env.WIX_WEBHOOK_SECRET;
  if (expectedSecret) {
    const provided = req.query?.secret;
    if (provided !== expectedSecret) {
      return res.status(200).json({
        debug: true,
        error: "Unauthorized",
        reason: "secret_mismatch",
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

    const order = normalizeOrder(body);

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
    const hasShippable = (order.lineItems || []).some((li) => li.shippable);
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
