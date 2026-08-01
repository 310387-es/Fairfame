export function PageHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <header className="mb-6 space-y-1">
      <h1 className="text-2xl font-semibold tracking-tight text-balance">{title}</h1>
      {subtitle ? <p className="text-pretty text-muted-foreground">{subtitle}</p> : null}
    </header>
  );
}
