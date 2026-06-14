// api/debug-test.js
//
// TEMPORARY DEBUG ENDPOINT.
// Visit this URL in a browser (GET request):
//   https://delhivery-wix-integration.vercel.app/api/debug-test?secret=<WIX_WEBHOOK_SECRET>
//
// It runs a real captured Wix order payload (order 16268) through the same
// normalizeOrder -> buildDelhiveryPayload -> Delhivery API pipeline as the
// main webhook, and returns the full result as JSON - including env var
// presence, the payload sent to Delhivery, and Delhivery's actual response.
//
// DELETE THIS FILE once debugging is complete.

const DEFAULT_WEIGHT_GRAMS = 180;

function poundsToGrams(lb) {
  return Math.round(lb * 453.592);
}

function normalizeOrder(body) {
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
        weight: undefined,
        shippable: li.shippable !== false,
      })),
      total: d.priceSummary?.total?.value ?? d.priceSummary?.total?.amount ?? "0",
      paymentStatus: d.paymentStatus,
    };
  }
  return null;
}

function buildDelhiveryPayload(order) {
  const address = order.address || {};
  const contact = order.contact || {};
  const lineItems = order.lineItems || [];

  const productsDesc = lineItems.map((li) => li.name).join(", ");

  let totalWeightGrams = 0;
  for (const li of lineItems) {
    const qty = li.qty || 1;
    const weightLb = li.weight;
    if (typeof weightLb === "number" && weightLb > 0) {
      totalWeightGrams += poundsToGrams(weightLb) * qty;
    } else {
      totalWeightGrams += DEFAULT_WEIGHT_GRAMS * qty;
    }
  }

  const totalAmount = parseFloat(order.total || "0");
  const paymentStatus = order.paymentStatus;
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
    order: "TESTDEBUG-" + String(order.number) + "-" + Date.now(),
    payment_mode: paymentMode,
    cod_amount: codAmount ? String(codAmount) : "",
    total_amount: String(totalAmount),
    products_desc: productsDesc,
    quantity: String(lineItems.reduce((sum, li) => sum + (li.qty || 1), 0)),
    weight: String(totalWeightGrams),
    seller_gst_tin: process.env.DELHIVERY_SELLER_GST || "",
    seller_name: process.env.DELHIVERY_SELLER_NAME || "",
    hsn_code: hsnCode,
    shipment_width: "",
    shipment_height: "",
    shipping_mode: "Surface",
  };

  return {
    pickup_location: {
      name: process.env.DELHIVERY_PICKUP_NAME || "",
    },
    shipments: [shipment],
  };
}

// Real captured Wix "Order Placed" payload for order 16268
const SAMPLE_PAYLOAD = {
  data: {
    orderNumber: "16268",
    lineItems: [
      {
        quantity: 1,
        sku: "DA-S8DP-6A1T",
        shippable: true,
        itemName: "A Children's Guide to the 12 Shiva Jyotirlings [Best Seller] [Hard Cover]",
      },
    ],
    paymentStatus: "PAID",
    shippingInfo: {
      logistics: {
        shippingDestination: {
          address: {
            city: "Hyderabad ",
            countryFullname: "India",
            subdivisionFullname: "Telangana",
            addressLine: "F 1202, trendset jayabheri elevate, kondapur",
            country: "IN",
            postalCode: "500084",
            subdivision: "IN-TG",
          },
          contactDetails: { firstName: "Amulya ", lastName: "Potluri ", phone: "8978101016" },
        },
      },
    },
    buyerEmail: "amulya.potluri@gmail.com",
    priceSummary: { total: { value: "495.00", currency: "INR" } },
  },
};

export default async function handler(req, res) {
  // Shared-secret check
  const expectedSecret = process.env.WIX_WEBHOOK_SECRET;
  if (expectedSecret) {
    const provided = req.query?.secret;
    if (provided !== expectedSecret) {
      return res.status(200).json({ error: "Unauthorized - add ?secret=... matching WIX_WEBHOOK_SECRET" });
    }
  }

  const envCheck = {
    DELHIVERY_API_TOKEN: process.env.DELHIVERY_API_TOKEN ? `set (len ${process.env.DELHIVERY_API_TOKEN.length})` : "MISSING",
    DELHIVERY_BASE_URL: process.env.DELHIVERY_BASE_URL || "(not set, defaults to track.delhivery.com)",
    DELHIVERY_PICKUP_NAME: process.env.DELHIVERY_PICKUP_NAME || "MISSING",
    DELHIVERY_SELLER_NAME: process.env.DELHIVERY_SELLER_NAME || "MISSING",
    DELHIVERY_SELLER_GST: process.env.DELHIVERY_SELLER_GST || "MISSING",
    DELHIVERY_HSN_CODE: process.env.DELHIVERY_HSN_CODE || "(not set, defaults to 4901)",
    WIX_WEBHOOK_SECRET: process.env.WIX_WEBHOOK_SECRET ? "set" : "MISSING",
  };

  const order = normalizeOrder(SAMPLE_PAYLOAD);
  const delhiveryPayload = buildDelhiveryPayload(order);

  const baseUrl = process.env.DELHIVERY_BASE_URL || "https://track.delhivery.com";
  const url = `${baseUrl}/api/cmu/create.json`;

  const formBody = new URLSearchParams();
  formBody.set("format", "json");
  formBody.set("data", JSON.stringify(delhiveryPayload));

  let delhiveryStatus, delhiveryJson, fetchError;
  try {
    const delhiveryResp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Token ${process.env.DELHIVERY_API_TOKEN}`,
      },
      body: formBody.toString(),
    });
    delhiveryStatus = delhiveryResp.status;
    const text = await delhiveryResp.text();
    try {
      delhiveryJson = JSON.parse(text);
    } catch {
      delhiveryJson = { raw: text };
    }
  } catch (e) {
    fetchError = String(e);
  }

  return res.status(200).json({
    envCheck,
    normalizedOrder: order,
    delhiveryPayloadSent: delhiveryPayload,
    delhiveryUrl: url,
    delhiveryStatus,
    delhiveryResponse: delhiveryJson,
    fetchError,
  });
}
