/**
 * test-autentique-coordinates.ts
 *
 * Manual test script: converts docs/sample-contract.md to a PDF, detects
 * [[ROLE]] marker positions, submits to Autentique, and prints the document
 * URL so you can verify widget placement in the Autentique UI.
 *
 * TODO: delete this file once the signing flow is covered by integration tests.
 *
 * Usage:
 *   deno run --allow-net --allow-read scripts/test-autentique-coordinates.ts
 */

import { PDFDocument, rgb, StandardFonts } from "https://esm.sh/pdf-lib@1.17.1";
import { detectSignaturePositions } from "../supabase/functions/documents/signatures/detect.ts";
import {
  getDocumentStatus,
  submitDocument,
} from "../supabase/functions/_shared/autentique.ts";

// ─── Config ───────────────────────────────────────────────────────────────────

const AUTENTIQUE_API_KEY =
  "8f95519947b6f60d6cc8b92b9c870c32b5bcd24460a2256e635c7c0f27d01e0d";

const SIGNER_PHONES: Record<string, { name: string; whatsapp: string }> = {
  LOCADOR: { name: "Tiago Proença", whatsapp: "+5516996011105" },
  LOCATARIO: { name: "Locatário Teste", whatsapp: "+5516996421297" },
};

/** Only these roles are submitted — witnesses use the same numbers and cause merging. */
const SUBMIT_ROLES = new Set(["LOCADOR", "LOCATARIO"]);

// ─── Markdown → PDF ───────────────────────────────────────────────────────────
//
// Converts the sample contract markdown to a single A4 PDF page.
// [[ROLE]] markers are rendered as invisible text (white) so they don't appear
// to human readers but are still present in the content stream for detection.

async function buildContractPdf(markdownPath: string): Promise<Uint8Array> {
  const markdown = await Deno.readTextFile(markdownPath);

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const page = doc.addPage([595, 842]); // A4
  const { height } = page.getSize();
  const black = rgb(0, 0, 0);
  const gray = rgb(0.35, 0.35, 0.35);

  let y = height - 40;
  const margin = 50;
  const lineHeight = 16;

  for (const rawLine of markdown.split("\n")) {
    if (y < 60) break;

    // Markdown headings → bold
    const headingMatch = rawLine.match(/^#+\s+(.*)/);
    if (headingMatch) {
      y -= 6;
      page.drawText(headingMatch[1], {
        x: margin,
        y,
        size: 12,
        font: bold,
        color: black,
      });
      y -= lineHeight + 4;
      continue;
    }

    // Blockquote → gray
    const bqMatch = rawLine.match(/^>\s+(.*)/);
    if (bqMatch) {
      page.drawText(bqMatch[1], {
        x: margin + 10,
        y,
        size: 9,
        font,
        color: gray,
      });
      y -= lineHeight;
      continue;
    }

    // [[ROLE]] marker — render as-is (detected by the content-stream parser)
    const markerMatch = rawLine.match(/^\[\[([A-Z0-9_]+)\]\]/);
    if (markerMatch) {
      page.drawText(`[[${markerMatch[1]}]]`, {
        x: margin,
        y,
        size: 10,
        font,
        color: black,
      });
      y -= lineHeight + 10;
      continue;
    }

    // Empty line
    if (rawLine.trim() === "") {
      y -= lineHeight / 2;
      continue;
    }

    // Regular text — strip markdown bold markers
    const text = rawLine.replace(/\*\*/g, "").slice(0, 90);
    page.drawText(text, { x: margin, y, size: 10, font, color: black });
    y -= lineHeight;
  }

  return doc.save();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const pdfBytes = await buildContractPdf("docs/sample-contract-tokens.md");
console.log(`PDF: ${pdfBytes.length} bytes\n`);

// Detect [[ROLE]] marker positions
const detectResult = await detectSignaturePositions(pdfBytes);

if (!detectResult.ok) {
  console.error("Detection failed:", detectResult.error);
  Deno.exit(1);
}

console.log("Detected positions:");
for (const pos of detectResult.positions) {
  console.log(
    `  ${pos.role.padEnd(14)} page=${pos.page}  x=${
      pos.x.toFixed(1).padStart(6)
    }  y=${pos.y.toFixed(1).padStart(6)}`,
  );
}
console.log();

// Build signers — only LOCADOR and LOCATARIO
const signers = detectResult.positions
  .filter((pos) => SUBMIT_ROLES.has(pos.role))
  .map((pos) => {
    const person = SIGNER_PHONES[pos.role];
    if (!person) throw new Error(`No phone configured for role ${pos.role}`);
    return { ...person, role: pos.role, x: pos.x, y: pos.y, page: pos.page };
  });

// Print JSON for review and wait for confirmation
const signersJson = signers.map((s) => ({
  name: s.name,
  phone: s.whatsapp,
  delivery_method: "DELIVERY_METHOD_WHATSAPP",
  action: "SIGN",
  positions: [{
    x: String(s.x),
    y: String(s.y),
    z: s.page,
    element: "SIGNATURE",
  }],
}));
console.log("Signers JSON (review before submitting):");
console.log(JSON.stringify(signersJson, null, 2));
console.log("\nPress Enter to submit, or Ctrl+C to abort…");
const buf = new Uint8Array(1);
await Deno.stdin.read(buf);

// Submit
const pdfBase64 = btoa(String.fromCharCode(...pdfBytes));
console.log("Submitting to Autentique…");

let documentId: string;
try {
  const result = await submitDocument(AUTENTIQUE_API_KEY, {
    pdfBase64,
    signers,
    reminderFrequency: "WEEKLY",
  });
  documentId = result.documentId;
} catch (err) {
  console.error("Submission failed:", err);
  Deno.exit(1);
}

console.log(`\nDocument ID : ${documentId}`);
console.log(
  `Autentique  : https://app.autentique.com.br/dashboard/documentos/${documentId}`,
);

// Status
console.log("\nStatus…");
try {
  const status = await getDocumentStatus(AUTENTIQUE_API_KEY, documentId);
  console.log(`Overall: ${status.status}`);
  for (const s of status.signers) {
    console.log(`  ${(s.name ?? "—").padEnd(22)} ${s.signed_at ?? "pending"}`);
  }
} catch (err) {
  console.error("Status check failed:", err);
}
