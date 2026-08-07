import { resolveRequestByToken, unsubscribeByToken } from "@/collect/public";
import { escapeHtml } from "@/messaging/templates";
import { DEFAULT_LOCALE, isLocale, type Locale } from "@/i18n/config";

/**
 * Opt-out: /u/{token}.
 *
 * Two verbs on purpose. GET is the human clicking the link in the footer; POST
 * is RFC 8058 one-click unsubscribe, which mail clients fire from their own UI
 * on the strength of the List-Unsubscribe headers the message carries.
 *
 * Both take effect immediately and neither asks for confirmation. An opt-out
 * that needs a second click is an opt-out that gets abandoned, and İYS/KVKK
 * both expect the request to be honoured, not negotiated.
 *
 * The page is rendered here rather than as a React route because it must work
 * for a stranger with no session, no locale cookie and no reason to load the
 * application shell.
 */

const COPY: Record<Locale, { title: string; done: string; unknown: string }> = {
  tr: {
    title: "E-posta tercihleri",
    done: "Abonelikten çıkarıldınız. Bu işletmeden artık görüş talebi e-postası almayacaksınız.",
    unknown: "Bu bağlantı geçerli değil. Bağlantının süresi dolmuş olabilir.",
  },
  en: {
    title: "Email preferences",
    done: "You are unsubscribed. This business will not email you review requests again.",
    unknown: "This link is not valid. It may have expired.",
  },
};

function page(locale: Locale, message: string, status: number): Response {
  const copy = COPY[locale];

  const html = `<!doctype html>
<html lang="${locale}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>${escapeHtml(copy.title)}</title>
  </head>
  <body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f6f7fb;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#10193a;">
    <main style="max-width:420px;margin:24px;padding:32px;background:#fff;border-radius:12px;text-align:center;">
      <h1 style="margin:0 0 12px;font-size:18px;">${escapeHtml(copy.title)}</h1>
      <p style="margin:0;font-size:15px;line-height:1.6;color:#3a4260;">${escapeHtml(message)}</p>
    </main>
  </body>
</html>`;

  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

async function localeFor(token: string): Promise<Locale> {
  const request = await resolveRequestByToken(token);
  const candidate = request?.campaign.locale ?? undefined;
  return isLocale(candidate) ? candidate : DEFAULT_LOCALE;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  const locale = await localeFor(token);
  const result = await unsubscribeByToken(token);

  return result.ok ? page(locale, COPY[locale].done, 200) : page(locale, COPY[locale].unknown, 404);
}

/** One-click unsubscribe. Mail clients expect a bare 200 and read no body. */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  const result = await unsubscribeByToken(token);
  return new Response(null, { status: result.ok ? 200 : 404 });
}
