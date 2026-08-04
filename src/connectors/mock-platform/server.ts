import { createServer, type Server } from "node:http";
import { createGoogleMock, type GoogleMock, type GoogleMockOptions } from "./google.ts";
import { createMetaMock, type MetaMock, type MetaMockOptions } from "./meta.ts";

/**
 * The fake platform, on a real socket.
 *
 * Deliberately `node:http` and no framework: the whole thing is a router over
 * four endpoints, and a dependency would be a larger commitment than the code
 * it replaced. It is also why this can be started inside a test without any
 * setup beyond calling it.
 *
 * Google is mounted under three prefixes because the real API is three services
 * on three hostnames, and the connector holds three base URLs to match. Meta
 * gets one, because Instagram and WhatsApp genuinely *are* one API — the same
 * host serves an Instagram account's media and a WhatsApp number's messages,
 * and both connectors already point at it through the same option.
 *
 * Serving all of it from one port keeps the wiring to one address while leaving
 * every connector's own shape untouched.
 */

export type MockPlatformOptions = {
  port?: number;
  google?: GoogleMockOptions;
  meta?: MetaMockOptions;
};

export type MockPlatform = {
  /** e.g. `http://127.0.0.1:53219` */
  url: string;
  /** Base URLs to hand the Google connector. */
  googleBaseUrls: {
    accountManagementBaseUrl: string;
    businessInformationBaseUrl: string;
    reviewsBaseUrl: string;
  };
  google: GoogleMock;
  /** One base URL for both Instagram and WhatsApp — as it is in life. */
  metaBaseUrl: string;
  meta: MetaMock;
  /** Requests served, newest last — for asserting what the connector actually did. */
  requests: { method: string; url: string; status: number }[];
  close: () => Promise<void>;
};

async function readBody(request: {
  on: (event: string, handler: (chunk?: Buffer) => void) => void;
}): Promise<string> {
  const chunks: Buffer[] = [];
  return new Promise((resolve) => {
    request.on("data", (chunk) => chunk && chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

export async function startMockPlatform(options: MockPlatformOptions = {}): Promise<MockPlatform> {
  const google = createGoogleMock(options.google);
  const meta = createMetaMock(options.meta);
  const requests: MockPlatform["requests"] = [];

  const server: Server = createServer((incoming, outgoing) => {
    void (async () => {
      const url = incoming.url ?? "/";
      const body = await readBody(incoming);

      // The prefix picks the platform, and is then stripped: each connector
      // still believes it is talking to its own API root.
      const call = {
        method: incoming.method ?? "GET",
        headers: incoming.headers as Record<string, string | undefined>,
        body,
      };

      const result = url.startsWith("/meta")
        ? meta.handle({ ...call, url: url.replace(/^\/meta/, "") })
        : google.handle({
            ...call,
            url: url.replace(/^\/(account-management|business-information|reviews)/, ""),
          });

      requests.push({ method: incoming.method ?? "GET", url, status: result.status });

      outgoing.writeHead(result.status, result.headers);
      outgoing.end(result.body);
    })();
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Mock platform failed to bind a port.");
  }

  const url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    googleBaseUrls: {
      accountManagementBaseUrl: `${url}/account-management`,
      businessInformationBaseUrl: `${url}/business-information`,
      reviewsBaseUrl: `${url}/reviews`,
    },
    google,
    metaBaseUrl: `${url}/meta`,
    meta,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
