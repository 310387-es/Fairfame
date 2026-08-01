import { Button } from "@/components/ui/button";

/**
 * Placeholder landing page for the Phase 0 scaffold.
 * Replaced by the authenticated app shell in T9.
 */
export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-6 px-6 py-16">
      <div className="space-y-3">
        <p className="text-sm font-medium tracking-widest text-muted-foreground uppercase">
          Phase 0 · Foundations
        </p>
        <h1 className="text-4xl font-semibold tracking-tight text-balance">Revira</h1>
        <p className="text-lg text-pretty text-muted-foreground">
          Review and customer-voice management for local businesses. The scaffold is up — tenancy,
          auth, connectors, and the Inbox slice come next.
        </p>
      </div>
      <div className="flex gap-3">
        <Button disabled>Sign in</Button>
        <Button variant="outline" disabled>
          Create organization
        </Button>
      </div>
    </main>
  );
}
