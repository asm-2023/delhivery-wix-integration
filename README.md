# Wix → Delhivery Order Integration

Automatically pushes paid/approved Wix orders to Delhivery for shipment creation.

## How it works

1. A Wix Automation triggers on **"Order Approved"** (or "Order Paid").
2. It sends a webhook (POST) to this Vercel function's URL.
3. The function maps the Wix order to Delhivery's `cmu/create.json` shipment format.
4. It calls Delhivery's Order Creation API with your API token.
5. Returns the Delhivery response (waybill number, etc.) — visible in Vercel logs.

## Setup Steps

### 1. Deploy this project to Vercel

This will give you a URL like:
`https://wix-delhivery-integration.vercel.app/api/wix-order-webhook`

### 2. Set environment variables in Vercel project settings

| Variable | Value | Notes |
|---|---|---|
| `DELHIVERY_API_TOKEN` | your token | Used as `Authorization: Token <value>` |
| `DELHIVERY_BASE_URL` | `https://track.delhivery.com` | Production |
| `DELHIVERY_PICKUP_NAME` | `Mumbai Residence` | Must match Delhivery warehouse name EXACTLY (case-sensitive) |
| `DELHIVERY_SELLER_NAME` | Amar Shiv Media Private Limited | As registered with Delhivery |
| `DELHIVERY_SELLER_GST` | `27AAYCA1613L1ZA` | Mandatory field for Delhivery |
| `DELHIVERY_HSN_CODE` | `4901` | HSN code for printed books — confirm with your CA |
| `WIX_WEBHOOK_SECRET` | (your choice, random string) | Optional, recommended |

### 3. Create a Wix Automation

In your Wix dashboard:
- Go to **Automations** → **Create New Automation**
- Trigger: **Store → Order Approved** (or "New Order Placed" depending on what's available)
- Action: **Send a webhook (HTTP request)**
- URL: `https://<your-vercel-url>/api/wix-order-webhook?secret=<WIX_WEBHOOK_SECRET>`
- Method: POST
- Body: include the order data (Wix automations typically pass the trigger payload automatically)

### 4. Test

Manually trigger a test order, then check:
- Vercel function logs (Dashboard → Project → Logs)
- Delhivery dashboard for the new shipment/waybill

## Notes & Caveats

- **Weight**: Wix item weights are in lb; this function converts to grams. If a
  product has no weight set, it defaults to 180g. Update `DEFAULT_WEIGHT_GRAMS`
  in `api/wix-order-webhook.js` or set weights on all Wix products for accuracy.
- **Payment mode**: Orders with `paymentStatus: PAID` are sent as `Prepaid`.
  Anything else is sent as `COD` with `cod_amount` = order total. Adjust if
  you don't offer COD on Wix.
- **HSN code**: Currently a single global HSN code is applied to all shipments.
  If your catalog has mixed HSN codes, this needs per-SKU mapping.
- **Idempotency**: Delhivery requires unique Order IDs (we use the Wix order
  number). If the same order is sent twice, Delhivery may reject the duplicate —
  this is expected/safe.
- **Only physical/shippable orders** are sent. Digital-only orders are skipped.
