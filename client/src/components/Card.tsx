import { cn } from "@/lib/utils";

interface CardProps {
  className?: string;
  children: React.ReactNode;
}

export function Card({ className, children }: CardProps) {
  return (
    <div className={cn(
      "relative rounded-lg border border-border bg-card p-6",
      // Glass surface
      "backdrop-blur-[22px] backdrop-saturate-[140%]",
      "shadow-card",
      // Inner top-edge highlight
      "before:content-[''] before:absolute before:inset-x-0 before:top-0 before:h-px",
      "before:rounded-t-lg before:pointer-events-none",
      "before:bg-gradient-to-r before:from-transparent before:via-white/85 before:to-transparent",
      className
    )}>
      {children}
    </div>
  );
}

export function CardHeader({ className, children }: CardProps) {
  return <div className={cn("mb-4", className)}>{children}</div>;
}

export function CardTitle({ className, children }: CardProps) {
  return <h3 className={cn("tp-card-title", className)}>{children}</h3>;
}
