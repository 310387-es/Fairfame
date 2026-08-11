"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * A block that arrives as the reader reaches it.
 *
 * **The un-revealed state is applied on mount, not in the server markup**, and
 * that ordering is the whole design. `.reveal` is `opacity: 0`; if the server
 * sent it, a visitor whose JavaScript failed — or a crawler that does not run
 * observers — would be looking at a blank page, and a marketing page that is
 * invisible without a bundle is worse than one that does not animate. Rendering
 * plain and *then* hiding costs one frame and cannot fail closed.
 *
 * `once`: the observer disconnects on the first intersection. Re-hiding a
 * section the reader has already read, because they scrolled back up, is the
 * behaviour that makes this pattern annoying rather than quiet.
 */
export function Reveal({ children, className }: { children: React.ReactNode; className?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [armed, setArmed] = useState(false);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const element = host.current;
    if (!element) return;

    setArmed(true);

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        setShown(true);
        observer.disconnect();
      },
      { threshold: 0.12 },
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={host} className={cn(armed && "reveal", shown && "is-in", className)}>
      {children}
    </div>
  );
}
