# Barcode Scanning and Labels

> **Status:** camera scanning and label printing are verified only in desktop browsers so far (v0.1.0). Reports from
> real phones and label printers are welcome.

## Where you can scan

A scan box (and a camera button next to it) is available in:

- the **POS** (`/sales/new`): scan a serial to add it to the sale,
- **Serial Lookup** (`/serials`),
- the **purchase serial box** (`/purchases/new`),
- the **stock count** (`/stock/count`).

## USB and Bluetooth scanners

They work out of the box. A barcode scanner behaves like a keyboard: it types the code into the focused box and
presses Enter. Configure the scanner to send Enter (CR) after each code; most do by default.

## Camera scanning

Tap the camera button next to a scan box.

- **Formats:** Code 128, Code 39, EAN-13, EAN-8, UPC-A, ITF, QR and Data Matrix.
- **How it decodes:** with the browser's built-in `BarcodeDetector` when available; otherwise a small decoder
  (ZXing) is downloaded from your own ssERP server only when you tap the button.
- **Privacy:** decoding happens on the device. Camera images are not uploaded.
- **HTTPS required:** browsers allow the camera only on `https://` addresses or `localhost`. On a phone, open your
  Vercel or HTTPS address (or use a USB scanner). Over plain `http://` on the local network the camera will not
  start.
- **Permission denied?** Allow the camera for the site in the browser's site settings and reload.
- The app's `Permissions-Policy` header allows the camera for this site only, and denies microphone, location,
  payment and USB.

## Printing serial labels

Open **`/serials/labels`** (permission `serials.view`), or use the **Print labels** button on a purchase invoice, on
a unit page or on Serial Lookup.

### Which units

| Selection | URL |
| --- | --- |
| All units of one purchase invoice | `/serials/labels?purchase=<purchase id>` |
| Specific units | `/serials/labels?ids=<unit id>,<unit id>` |
| Every unit in stock | `/serials/labels` |
| Every unit in stock of one product | `/serials/labels?sku=<SKU>` |

At most **500 labels** per print job; the page says when a selection was cut.

### Layouts

| Layout | Use | Parameter |
| --- | --- | --- |
| A4 sheet, 3 x 8 | 24 labels per A4 page, 63.5 x 34 mm each | `layout=a4` (default) |
| 50 x 25 mm | One label per page on a label printer | `layout=50x25` |
| 58 mm thermal roll | One label per page, 58 x 40 mm | `layout=58` |

Add `barcode=1` to print a **Code 128** barcode under the QR code.

### What is on a label

- product name (shortened with an ellipsis when too long; Bengali text is never cut mid-character),
- the serial number,
- the shop name,
- a **QR code containing the serial only**,
- optionally a Code 128 barcode of the serial.

Prices and costs are never printed: the label code has no access to them.

### Printing tips

- In the print dialog set **scale to 100 %** and margins to "default" (the page sets its own `@page` size).
- For label printers, choose the matching paper size in the printer driver (50 x 25 mm or 58 mm roll).
- Print one test page on plain paper first and hold it against your label sheet.
- Scan a printed QR code with Serial Lookup's camera button to check it reads.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| Camera button does nothing on a phone | Use HTTPS (or `localhost`); check site camera permission |
| Scanner types the code but nothing happens | Make sure the scanner sends Enter after the code |
| Wrong characters from a USB scanner | Set the scanner's keyboard layout to match the computer (often US) |
| Labels misaligned | Scale 100 %, correct paper size in the driver, no "fit to page" |
| Barcode too dense on small labels | Use the QR code only (no `barcode=1`) |

Last verified against v0.1.0 (desktop browsers only).
