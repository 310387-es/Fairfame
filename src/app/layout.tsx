import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getLocale } from "next-intl/server";
import { ToastProvider } from "@/components/ui/toast";
import "./globals.css";

// `--font-sans` / `--font-mono` are the names `globals.css` maps into the
// Tailwind theme, so the CSS variables must use exactly these names.
const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

/**
 * The icons are declared here rather than by Next's `icon.svg` / `apple-icon.png`
 * file convention, and the two cannot both be used: **file-based metadata wins
 * over this object**, so leaving the old convention files in place would have
 * served the retired monogram while every reference below pointed at the
 * Fairfame seal — a mismatch nothing would fail on.
 *
 * The artwork is copied verbatim out of `brand/` into `public/`
 * (`tests/lib/brand-assets.test.ts` fails when a copy drifts). One source of
 * truth, and the manifest points at the same files.
 */
export const metadata: Metadata = {
  title: "Fairfame",
  // Says what the product does, not who it is for. It was "for local
  // businesses", which described the first customers rather than the product:
  // a chain, a franchise and a single café have the same problem, and naming
  // one of them in the meta description tells the other two to look elsewhere.
  description:
    "Review and customer-voice management: every review and message in one inbox, and a weekly plan of what to do about them.",
  icons: {
    // SVG first for anything modern; the 32px PNG is the fallback for a browser
    // that will not take one, and Safari asks for the touch icon by name.
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/icon-32.png", sizes: "32x32", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Drives both the messages and the `lang` attribute, so assistive technology
  // and the browser agree with what is actually rendered.
  const locale = await getLocale();

  return (
    <html
      lang={locale}
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-background text-foreground">
        {/*
          Charts are drawn by Recharts, which measures its container before it
          draws and so renders nothing at all until hydration. With scripts off
          that leaves an empty box, so the text equivalent every chart already
          carries for screen readers is promoted to a visible table instead.

          Only a stylesheet goes in here — never markup. A browser with
          scripting enabled parses `<noscript>` content as raw text, so any
          element React streams inside it is invisible to `getElementById`,
          which is exactly what broke `$RS` when the table itself lived here.
          Unlayered, so it outranks the `@layer components` rule it overrides.
        */}
        <noscript>
          <style>
            {
              ".chart-fallback{position:static;width:100%;height:auto;margin:0;overflow:visible;clip-path:none;white-space:normal}"
            }
          </style>
        </noscript>

        {/* The toast viewport lives at the root rather than in the app shell:
            the sign-in and sign-up forms are outside `(app)` and fail in
            exactly the same ways, and a feedback system with a hole in it at
            the first screen a customer sees is not one (W1.5). */}
        <NextIntlClientProvider>
          <ToastProvider>{children}</ToastProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
