import { forwardRef } from "react";
import { cn } from "@/lib/utils";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "destructive";
  size?: "sm" | "md" | "lg";
}

// Base: frosted glass surface (maps to design's default .btn)
const base =
  "inline-flex items-center justify-center gap-[6px] rounded-md font-normal whitespace-nowrap " +
  "h-9 px-[14px] text-13 " +
  "border border-border bg-white/[.62] text-foreground " +
  "backdrop-blur-[14px] backdrop-saturate-[130%] shadow-soft " +
  "transition-[background-color,transform,filter] duration-[120ms] " +
  "hover:bg-white/[.88] " +
  "outline-none focus-visible:border-primary focus-visible:[box-shadow:var(--shadow-focus-ring)] " +
  "disabled:opacity-50 disabled:pointer-events-none [&_svg]:size-[15px] [&_svg]:shrink-0";

const sizes: Record<string, string> = {
  sm: "h-[30px] px-[10px] text-xs",
  md: "",
  lg: "h-11 px-4 text-sm",
};

const variants: Record<string, string> = {
  // Gradient indigo pill with accent glow shadow
  primary:
    "text-white bg-gradient-to-b from-primary to-primary-deep " +
    "border-primary/60 shadow-accent " +
    "hover:brightness-105 active:brightness-95",

  // Default glass surface — base classes cover this entirely
  secondary: "",

  // Transparent / no blur
  ghost:
    "bg-transparent border-transparent shadow-none [backdrop-filter:none] " +
    "text-muted-foreground hover:bg-white/[.55] hover:text-foreground",

  // Gradient red with red glow shadow
  destructive:
    "text-white bg-gradient-to-b from-down to-down/70 " +
    "border-down/60 " +
    "shadow-[0_1px_0_rgba(255,255,255,.25)_inset,0_6px_18px_-8px_rgba(226,82,57,.55),0_2px_4px_rgba(15,20,40,.08)] " +
    "hover:brightness-105 active:brightness-95",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", type = "button", className, children, ...props },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(base, sizes[size], variants[variant], className)}
      {...props}
    >
      {children}
    </button>
  );
});
