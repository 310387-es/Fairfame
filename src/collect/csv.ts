import { recipientSchema, type Recipient } from "./input.ts";

/**
 * Reading a customer list out of a CSV (W2.2).
 *
 * The 200-address textarea it replaces accepted a pasted block of addresses,
 * which is fine until somebody exports from their POS or their old booking
 * system — and then every row is `Ayşe Yılmaz,ayse@example.com,905321112233`
 * and `parseRecipientList` marks all two hundred of them invalid, because it
 * splits on commas and a name is not an email address.
 *
 * **Columns are found by their header, not by position.** Every export in the
 * world orders them differently, and a parser that assumed "email is the second
 * column" would silently read names as addresses for anyone whose export puts
 * them the other way round. A file with no recognisable header is treated as
 * headerless and each field is classified by shape, which is the only honest
 * fallback: if we cannot be told which column is which, the data has to say so
 * itself.
 *
 * Deliberately not a dependency. RFC 4180 is quoted fields, doubled quotes and
 * embedded newlines, and that is genuinely all of it; the whole grammar is the
 * loop below, and it is smaller than the argument for adding a package.
 */

/** What a header cell has to say for us to believe the column. */
const HEADERS = {
  email: ["email", "e-mail", "e-posta", "eposta", "mail", "adres", "email address"],
  name: ["name", "isim", "ad", "ad soyad", "full name", "adı", "müşteri", "customer"],
  phone: ["phone", "telefon", "gsm", "cep", "mobile", "number", "numara", "tel"],
} as const;

export type CsvRecipient = Recipient & { phone: string | null };

export type CsvParseResult = {
  recipients: CsvRecipient[];
  /** Rows we could not read an address out of, verbatim, so they can be shown. */
  invalid: string[];
  /** True when a header row was recognised and consumed. */
  hadHeader: boolean;
};

/** One line of RFC 4180, honouring quotes and doubled quotes inside them. */
function splitRow(row: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < row.length; index += 1) {
    const char = row[index];

    if (quoted) {
      if (char === '"') {
        // A doubled quote inside a quoted field is a literal quote.
        if (row[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') quoted = true;
    else if (char === "," || char === ";" || char === "\t") {
      fields.push(field);
      field = "";
    } else field += char;
  }

  fields.push(field);
  return fields.map((value) => value.trim());
}

function classifyHeader(cells: string[]): { email: number; name: number; phone: number } | null {
  const found = { email: -1, name: -1, phone: -1 };

  cells.forEach((cell, index) => {
    const normalized = cell.toLocaleLowerCase("tr").replace(/^﻿/, "").trim();
    for (const [key, aliases] of Object.entries(HEADERS)) {
      if (found[key as keyof typeof found] === -1 && aliases.includes(normalized as never)) {
        found[key as keyof typeof found] = index;
      }
    }
  });

  // A header is only a header if it names something we can address somebody by.
  // Otherwise it is the first row of data and must not be eaten.
  return found.email >= 0 || found.phone >= 0 ? found : null;
}

/** Anything with an `@` and no spaces is an address; that is the whole test. */
function looksLikeEmail(value: string): boolean {
  return value.includes("@") && !/\s/.test(value);
}

/** Turkish mobiles with or without +90, spaces and dashes. Digits are the signal. */
function looksLikePhone(value: string): boolean {
  const digits = value.replace(/[\s()+-]/g, "");
  return /^\d{10,15}$/.test(digits);
}

export type CsvParseOptions = {
  /**
   * Accept a row that has a phone number and no email (W5-13).
   *
   * Off by default, which is right for the caller this was written for: a
   * review request is sent by email, so a row with no address is a row nobody
   * can be asked, and reporting it as invalid is the honest answer.
   *
   * The **contact import** is the opposite case. `contacts` requires an email
   * *or* a phone — its own check constraint says so — and a POS export is
   * frequently phone-only, because that is what a till captures. Dropping those
   * rows silently discarded half of a Turkish café's customer list, which is
   * exactly what happened the first time this feature was pointed at a real
   * file.
   *
   * A flag rather than a second parser: the column detection is the hard part
   * and there must be one implementation of what a column called "e-posta"
   * means.
   */
  allowPhoneOnly?: boolean;
};

export function parseRecipientCsv(raw: string, options: CsvParseOptions = {}): CsvParseResult {
  const rows = raw
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter((row) => row !== "");

  const recipients: CsvRecipient[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();

  if (rows.length === 0) return { recipients, invalid, hadHeader: false };

  const header = classifyHeader(splitRow(rows[0] ?? ""));
  const body = header ? rows.slice(1) : rows;

  for (const row of body) {
    const cells = splitRow(row);

    // With a header, the columns are known. Without one, each cell is judged by
    // its shape — which is why a headerless file still works and a file whose
    // header we did not recognise is not silently mangled.
    const email = header
      ? (cells[header.email] ?? "")
      : (cells.find((cell) => looksLikeEmail(cell)) ?? "");
    const phone = header
      ? (cells[header.phone] ?? "")
      : (cells.find((cell) => looksLikePhone(cell)) ?? "");
    const name = header
      ? (cells[header.name] ?? "")
      : (cells.find((cell) => !looksLikeEmail(cell) && !looksLikePhone(cell)) ?? "");

    const parsed = recipientSchema.safeParse({ email, name: name || null });
    const usablePhone = phone && looksLikePhone(phone) ? phone : null;

    if (!parsed.success) {
      // A phone number with no address is a real contact and not a real
      // recipient — see `allowPhoneOnly`.
      if (options.allowPhoneOnly && usablePhone) {
        const phoneKey = `tel:${usablePhone}`;
        if (seen.has(phoneKey)) continue;
        seen.add(phoneKey);
        recipients.push({ email: "", name: name || null, phone: usablePhone });
        continue;
      }

      // Reported rather than dropped: silently ignoring a row means an owner
      // believes they asked somebody they did not.
      invalid.push(row);
      continue;
    }

    const key = parsed.data.email.toLocaleLowerCase("en");
    // Asking the same person twice in one send is never intended.
    if (seen.has(key)) continue;
    seen.add(key);

    recipients.push({
      ...parsed.data,
      email: key,
      // Carried but not yet used to address anybody: a phone number from a CSV
      // belongs to somebody who has not consented to be messaged on it, and
      // `checkSendAllowed` is keyed on a contact we already hold. It is here so
      // the import can *fill in* a number on a contact, never so a send can
      // start from one.
      phone: usablePhone,
    });
  }

  return { recipients, invalid, hadHeader: header !== null };
}
