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

export const metadata: Metadata = {
  title: "Revira",
  description: "Review and customer-voice management for local businesses.",
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
