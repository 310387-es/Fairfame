import { describe, expect, it } from "vitest";
import { parseRecipientCsv } from "@/collect/csv";

/**
 * Reading a customer list out of a CSV (W2.2).
 *
 * The failure this replaces is specific: the 200-address textarea split on
 * commas, so a real export — `Ayşe Yılmaz,ayse@example.com` — came back with
 * every row marked invalid, and the owner was told their whole customer list
 * was malformed.
 *
 * The tests are mostly about **not silently mangling** things. A parser that
 * drops a row is worse than one that refuses it, because the owner believes
 * they asked somebody they did not.
 */

describe("headers", () => {
  it("finds the columns by name rather than by position", () => {
    // Every export orders them differently. Assuming "email is second" reads
    // names as addresses for half the world's POS systems.
    const { recipients, hadHeader } = parseRecipientCsv(
      ["email,name", "ayse@example.com,Ayşe Yılmaz"].join("\n"),
    );

    expect(hadHeader).toBe(true);
    expect(recipients).toEqual([{ email: "ayse@example.com", name: "Ayşe Yılmaz", phone: null }]);
  });

  it("reads the same file with the columns the other way round", () => {
    const { recipients } = parseRecipientCsv(
      ["Name,Email", "Ayşe Yılmaz,ayse@example.com"].join("\n"),
    );

    expect(recipients).toEqual([{ email: "ayse@example.com", name: "Ayşe Yılmaz", phone: null }]);
  });

  it("understands Turkish headers, since the launch market exports in Turkish", () => {
    const { recipients } = parseRecipientCsv(
      ["Ad Soyad;E-posta;Telefon", "Mehmet Demir;mehmet@example.com;0532 111 22 33"].join("\n"),
    );

    expect(recipients).toEqual([
      { email: "mehmet@example.com", name: "Mehmet Demir", phone: "0532 111 22 33" },
    ]);
  });

  it("does not eat the first row when the header is unrecognisable", () => {
    // The alternative is worse than it sounds: a file whose header we do not
    // recognise would have its *first customer* consumed as a header, and that
    // person would never be asked with nothing on screen to say why. Here the
    // unreadable row is reported as invalid — visible, and not a recipient.
    const { recipients, invalid, hadHeader } = parseRecipientCsv(
      ["kolon1,kolon2", "Ayşe,ayse@example.com"].join("\n"),
    );

    expect(hadHeader).toBe(false);
    expect(recipients).toEqual([{ email: "ayse@example.com", name: "Ayşe", phone: null }]);
    expect(invalid).toEqual(["kolon1,kolon2"]);
  });
});

describe("without a header", () => {
  it("classifies each field by its shape", () => {
    const { recipients } = parseRecipientCsv("Ayşe Yılmaz,ayse@example.com,905321112233");

    expect(recipients).toEqual([
      { email: "ayse@example.com", name: "Ayşe Yılmaz", phone: "905321112233" },
    ]);
  });

  it("reads a bare list of addresses, which is what people usually paste", () => {
    const { recipients } = parseRecipientCsv("bir@example.com\niki@example.com");

    expect(recipients.map((entry) => entry.email)).toEqual(["bir@example.com", "iki@example.com"]);
  });
});

describe("quoting", () => {
  it("keeps a comma that is inside a quoted field", () => {
    // "Yılmaz, Ayşe" is one name. Splitting it would produce a row with an
    // extra column and shift every later field by one.
    const { recipients } = parseRecipientCsv(
      ["name,email", '"Yılmaz, Ayşe",ayse@example.com'].join("\n"),
    );

    expect(recipients[0]?.name).toBe("Yılmaz, Ayşe");
    expect(recipients[0]?.email).toBe("ayse@example.com");
  });

  it("reads a doubled quote as a literal one", () => {
    const { recipients } = parseRecipientCsv(
      ["name,email", '"Ayşe ""Ayşi"" Yılmaz",ayse@example.com'].join("\n"),
    );

    expect(recipients[0]?.name).toBe('Ayşe "Ayşi" Yılmaz');
  });
});

describe("what it refuses", () => {
  it("reports a row with no address rather than dropping it", () => {
    const { recipients, invalid } = parseRecipientCsv(
      ["email,name", "ayse@example.com,Ayşe", "not-an-address,Mehmet"].join("\n"),
    );

    expect(recipients).toHaveLength(1);
    expect(invalid).toEqual(["not-an-address,Mehmet"]);
  });

  it("asks the same person once", () => {
    const { recipients } = parseRecipientCsv(
      ["email", "ayse@example.com", "AYSE@example.com"].join("\n"),
    );

    expect(recipients).toHaveLength(1);
  });

  it("has nothing to say about an empty file", () => {
    expect(parseRecipientCsv("   \n\n")).toEqual({
      recipients: [],
      invalid: [],
      hadHeader: false,
    });
  });
});

describe("the phone column", () => {
  it("is read, but is never an address a send can start from", () => {
    /**
     * A number in a CSV belongs to somebody who has not consented to be
     * messaged on it, and `checkSendAllowed` is keyed on a contact we already
     * hold. So the column is carried so an import can *fill in* a number on a
     * contact — never so a send can begin with one. The recipient shape a send
     * takes is `{email}` or `{contactId}`, and this produces neither by itself.
     */
    const { recipients } = parseRecipientCsv("Ayşe,ayse@example.com,+90 532 111 22 33");

    expect(recipients[0]?.phone).toBe("+90 532 111 22 33");
    expect(recipients[0]).not.toHaveProperty("contactId");
  });

  it("ignores something in the phone column that is not a number", () => {
    const { recipients } = parseRecipientCsv(["email,phone", "ayse@example.com,yok"].join("\n"));

    expect(recipients[0]?.phone).toBeNull();
  });
});
